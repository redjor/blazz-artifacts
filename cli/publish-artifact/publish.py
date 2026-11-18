#!/usr/bin/env python3
"""Publishes a file or a folder to Blazz Artifacts (admin API, Bearer token).

Python 3 (stdlib) + curl, plus `security` (macOS Keychain) when the token is not in the environment.
The token never appears in process arguments or in the output: curl reads its configuration from stdin.

Thumbnail: after the upload, the page is captured on this machine (agent-browser, else a headless
Chrome/Chromium/Edge/Brave) and sent to the hub. The server never renders anything. A failed capture
never fails the upload.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

if sys.version_info < (3, 10):  # before any « str | None » annotation
    sys.exit('Error: publish.py needs Python 3.10 or newer (python3 --version).')

MAX_BYTES = 100 * 1024 * 1024
FILE_EXTENSIONS = {'.html', '.htm', '.md', '.markdown', '.pdf', '.json', '.zip'}
RESERVED = {'share', 'assets', 'api', 'admin', 'hub', 'unlock'}
ALWAYS_SKIP_DIRS = {'__MACOSX', '.git', 'node_modules'}
ALWAYS_SKIP_FILES = {'.DS_Store'}
MAX_LABEL = 32
MAX_TAGS = 20
SLUG_RE = re.compile(r'^[a-z0-9](?:-?[a-z0-9])*$')
VISIBILITIES = ('private', 'code', 'link', 'public')
CONNECT_TIMEOUT_S = 10
UPLOAD_TIMEOUT_S = 600


# Thumbnail: first viewport 1280×800 (scale 1), reduced to 960×600 when a converter is available.
THUMB_SESSION_PREFIX = 'publish-thumb'
THUMB_VIEWPORT = (1280, 800)
THUMB_SIZE = (960, 600)
THUMB_SETTLE_MS = 1500
THUMB_MAX_BYTES = 2 * 1024 * 1024
THUMB_BUDGET_S = 60          # total thumbnail budget: preview, capture, conversion, upload
THUMB_CURL_TIMEOUT_S = 30    # curl max-time of the preview and thumbnail upload (content upload keeps 600 s)
CLOSE_TIMEOUT_S = 15
# Equivalent of --hide-scrollbars for agent-browser (CSSOM: not blocked by the page CSP).
HIDE_SCROLLBARS_JS = "document.documentElement.style.setProperty('scrollbar-width', 'none')"
APP_DIRS = (Path('/Applications'), Path.home() / 'Applications')
CHROMIUM_APPS = (
    'Google Chrome.app/Contents/MacOS/Google Chrome',
    'Chromium.app/Contents/MacOS/Chromium',
    'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'Brave Browser.app/Contents/MacOS/Brave Browser',
)


class PublishError(Exception):
    exit_code = 1
    #: HTTP status of the hub response, when the error comes from it.
    status: int | None = None


class UsageError(PublishError):
    exit_code = 2


def validate_slug(slug: str) -> str:
    if len(slug) > 48 or not SLUG_RE.match(slug) or slug in RESERVED:
        raise UsageError(
            f"Invalid slug: {slug!r}. Lowercase letters, digits and hyphens (1 to 48 characters), "
            f"not a reserved word ({', '.join(sorted(RESERVED))}). Pass --slug."
        )
    return slug


def slugify(name: str) -> str:
    """Same rules as the server (src/slug.ts)."""
    base = unicodedata.normalize('NFKD', name)
    base = re.sub('[\u0300-\u036f]', '', base).lower()
    base = re.sub(r'\.[a-z0-9]+$', '', base)
    base = re.sub(r'[^a-z0-9]+', '-', base).strip('-')[:48].rstrip('-')
    return 'artifact' if not base or base in RESERVED else base


def normalize_label(value: str) -> str | None:
    """Same rules as the server (src/labels.ts); None when empty after normalisation."""
    s = unicodedata.normalize('NFKD', value.strip().lower())
    s = re.sub('[\u0300-\u036f]', '', s)
    s = re.sub(r'[\s_]+', '-', s)
    s = re.sub(r'[^a-z0-9-]', '', s)
    s = re.sub(r'-+', '-', s).strip('-')[:MAX_LABEL].rstrip('-')
    return s or None


def parse_project(value: str) -> str | None:
    """'' clears the folder (None); otherwise the normalised label, or a usage error."""
    if value.strip() == '':
        return None
    label = normalize_label(value)
    if label is None:
        raise UsageError(f"Invalid folder: {value!r}. Letters, digits and hyphens ({MAX_LABEL} characters max).")
    return label


def parse_tags(values: list[str]) -> list[str]:
    tags: set[str] = set()
    for raw in values:
        label = normalize_label(raw)
        if label is None:
            raise UsageError(f"Invalid tag: {raw!r}. Letters, digits and hyphens ({MAX_LABEL} characters max).")
        tags.add(label)
    if len(tags) > MAX_TAGS:
        raise UsageError(f"Too many tags ({len(tags)} > {MAX_TAGS}).")
    return sorted(tags)


def env_value(*names: str) -> str:
    """First non-empty variable among `names` (ARTIFACT_HUB_* first, BLAZZ_ARTIFACTS_* as aliases)."""
    for name in names:
        value = os.environ.get(name, '').strip()
        if value:
            return value
    return ''


def hub_url() -> str:
    url = env_value('ARTIFACT_HUB_URL', 'BLAZZ_ARTIFACTS_URL')
    if not url:
        path = Path.home() / '.config' / 'artifact-hub' / 'url'
        try:
            url = path.read_text(encoding='utf-8').splitlines()[0].strip()
        except (OSError, IndexError):
            url = ''
    if not url:
        raise PublishError(
            "Hub URL not found. Set ARTIFACT_HUB_URL (or BLAZZ_ARTIFACTS_URL) or write the URL (https://…) "
            "on the first line of ~/.config/artifact-hub/url."
        )
    if not re.match(r'^https?://', url):
        raise PublishError("The hub URL must start with https://")
    return url.rstrip('/')


def api_token() -> str:
    token = env_value('ARTIFACT_HUB_TOKEN', 'BLAZZ_ARTIFACTS_TOKEN')
    if not token:
        try:
            res = subprocess.run(
                ['security', 'find-generic-password', '-s', 'artifact-hub', '-a', 'api-token', '-w'],
                capture_output=True, text=True, check=False,
            )
            token = res.stdout.strip() if res.returncode == 0 else ''
        except OSError:
            token = ''
    if not token:
        raise PublishError(
            "API token not found. Store it in the macOS Keychain (the value is prompted without echo):\n"
            "  security add-generic-password -s artifact-hub -a api-token -w\n"
            "or set ARTIFACT_HUB_TOKEN (or BLAZZ_ARTIFACTS_TOKEN)."
        )
    return token


def count_files(directory: Path) -> int:
    return sum(len(names) for _, _, names in os.walk(directory))


def build_zip(directory: Path, dest: Path, include_dotfiles: bool = False) -> tuple[int, int, int]:
    """Zips the folder (relative paths); returns (files, zip size, skipped entries)."""
    if not directory.is_dir():
        raise PublishError(f"Folder not found: {directory}")
    files: list[tuple[Path, str]] = []
    skipped = 0
    for root, dirs, names in os.walk(directory):
        kept = []
        for d in sorted(dirs):
            full = Path(root) / d
            if d in ALWAYS_SKIP_DIRS:
                continue
            if full.is_symlink():
                skipped += 1
            elif d.startswith('.') and not include_dotfiles:
                skipped += max(count_files(full), 1)
            else:
                kept.append(d)
        dirs[:] = kept
        for name in sorted(names):
            full = Path(root) / name
            if name in ALWAYS_SKIP_FILES:
                continue
            if full.is_symlink() or (name.startswith('.') and not include_dotfiles):
                skipped += 1
                continue
            files.append((full, full.relative_to(directory).as_posix()))
    if not any(rel == 'index.html' for _, rel in files):
        raise PublishError("A folder must contain index.html at its root.")
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, strict_timestamps=False) as zf:
        for full, rel in files:
            zf.write(full, rel)
    return len(files), dest.stat().st_size, skipped


def _q(value: str) -> str:
    """Quoted value for a curl configuration file."""
    if '\n' in value or '\r' in value:
        raise PublishError('Invalid value (line break).')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def _form_quote(value: str) -> str:
    """Quoted value for curl's -F syntax (protects ; , and \")."""
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def curl_config(token: str, method: str, url: str, *, fields: dict | None = None, file: tuple | None = None, json_body: dict | None = None,
                body_file: tuple | None = None, max_time: int = UPLOAD_TIMEOUT_S) -> str:
    """curl configuration for stdin: the token never appears in argv."""
    lines = [
        'silent', 'show-error', f'connect-timeout = {min(CONNECT_TIMEOUT_S, max_time)}', f'max-time = {max_time}',
        f'header = {_q("Authorization: Bearer " + token)}',
        f'request = {_q(method)}', f'url = {_q(url)}',
        'write-out = "\\n%{http_code}"',
    ]
    for key, value in (fields or {}).items():
        lines.append(f'form-string = {_q(f"{key}={value}")}')
    if file:
        path, filename = file
        lines.append(f'form = {_q("file=@" + _form_quote(str(path)) + ";filename=" + _form_quote(filename))}')
    if json_body is not None:
        lines.append(f'header = {_q("Content-Type: application/json")}')
        lines.append(f'data = {_q(json.dumps(json_body))}')
    if body_file:
        path, content_type = body_file  # raw body (thumbnail), read by curl from the file
        lines.append(f'header = {_q("Content-Type: " + content_type)}')
        lines.append(f'data-binary = {_q("@" + str(path))}')
    return '\n'.join(lines) + '\n'


def call(token: str, method: str, url: str, **kwargs) -> dict | list:
    config = curl_config(token, method, url, **kwargs)
    try:
        res = subprocess.run(['curl', '--config', '-'], input=config, capture_output=True, text=True, check=False)
    except OSError as e:
        raise PublishError(f"curl not found: {e}")
    if res.returncode != 0:
        err = res.stderr.strip().replace(token, '***')
        hint = ' (timed out or unreachable: is the hub reachable from this machine, e.g. VPN or tailnet connected?)' if res.returncode in (6, 7, 28) else ''
        raise PublishError(f"Could not connect to the hub{hint}: {err}")
    body, _, code = res.stdout.rpartition('\n')
    try:
        data = json.loads(body) if body else {}
    except ValueError:
        data = {}
    status = int(code) if code.isdigit() else 0
    if not 200 <= status < 300:
        message = data.get('error') if isinstance(data, dict) else None
        err = PublishError(f"HTTP {status}: {message or 'unexpected server response'}")
        err.status = status
        raise err
    return data


def prepare_upload(path: Path, name: str, tmp: list[Path], include_dotfiles: bool) -> tuple[Path, str, str]:
    """Returns (file to upload, file name, description). `name`: the path name as given."""
    if path.is_dir():
        fd, tmpname = tempfile.mkstemp(suffix='.zip', prefix='blazz-artifacts-')
        os.close(fd)
        zpath = Path(tmpname)
        tmp.append(zpath)
        count, size, skipped = build_zip(path, zpath, include_dotfiles)
        check_size(size)
        note = f' ({skipped} hidden file(s) or symbolic link(s) skipped; --include-dotfiles keeps hidden files)' if skipped else ''
        return zpath, f'{name}.zip', f'zipped folder: {count} file(s), {size} bytes{note}'
    if not path.is_file():
        raise PublishError(f"Path not found: {path}")
    if path.suffix.lower() not in FILE_EXTENSIONS:
        raise PublishError(f"Unsupported extension ({', '.join(sorted(FILE_EXTENSIONS))}).")
    size = path.stat().st_size
    check_size(size)
    return path, name, f'file: {size} bytes'


def check_size(size: int) -> None:
    if size > MAX_BYTES:
        raise PublishError(f"Upload too large ({size // (1024 * 1024)} MiB > 100 MiB). The server also enforces MAX_UPLOAD_MB.")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Publish a file or a folder to Blazz Artifacts.')
    p.add_argument('path', nargs='?')
    p.add_argument('--project', help='Folder (empty: removes the folder on update)')
    p.add_argument('--tag', action='append', default=[], help='Tag (repeatable; replaces the tags on update)')
    p.add_argument('--rename-slug', dest='rename_slug', help='New slug (update only)')
    p.add_argument('--list-projects', dest='list_projects', action='store_true',
                   help='List folders: artifact count, folder visibility, private artifacts; then exit')
    p.add_argument('--share-folder', dest='share_folder', metavar='FOLDER',
                   help='Share a folder (7-day link by default, or --visibility public|code|private) and exit')
    p.add_argument('--create-folder', dest='create_folder', metavar='NAME',
                   help='Create an empty private folder (optional --title, --description) and exit')
    p.add_argument('--description', help='Description shown under the title (artifact, or folder with --create-folder); empty clears on update')
    p.add_argument('--folder-stats', dest='folder_stats', metavar='FOLDER',
                   help='Show folder page visits: totals, last 7 days, opens per link, and exit')
    p.add_argument('--list-versions', dest='list_versions', action='store_true', help='List the artifact versions (path or --slug) and exit')
    p.add_argument('--restore', type=int, metavar='N', help='Restore version N of the artifact (path or --slug) and exit, without uploading')
    p.add_argument('--thumbnail-only', dest='thumbnail_only', action='store_true',
                   help='Recapture the thumbnail of the current version (path or --slug) without uploading content, and exit')
    p.add_argument('--no-thumbnail', dest='no_thumbnail', action='store_true', help='Do not capture a thumbnail after the upload')
    p.add_argument('--stats', action='store_true', help='Show the artifact visits (path or --slug): totals, last 7 days, opens per link, and exit')
    p.add_argument('--slug')
    p.add_argument('--title')
    p.add_argument('--visibility', choices=VISIBILITIES)
    p.add_argument('--code')
    p.add_argument('--link-hours', type=float)
    p.add_argument('--link-label')
    p.add_argument('--memory-storage', dest='memory_storage', action='store_true', default=None)
    p.add_argument('--no-memory-storage', dest='memory_storage', action='store_false')
    p.add_argument('--include-dotfiles', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args(argv)
    if args.code is not None and len(args.code) < 6:
        p.error('--code must be at least 6 characters')
    modes = [name for name, on in (('--list-projects', args.list_projects), ('--list-versions', args.list_versions), ('--restore', args.restore is not None),
                                   ('--stats', args.stats), ('--thumbnail-only', args.thumbnail_only),
                                   ('--share-folder', args.share_folder is not None), ('--folder-stats', args.folder_stats is not None),
                                   ('--create-folder', args.create_folder is not None)) if on]
    if len(modes) > 1:
        p.error(f"{' and '.join(modes)} are mutually exclusive: one mode at a time")
    if args.description is not None and len(args.description.strip()) > 1000:
        p.error('--description: 1000 characters max')
    if args.share_folder is not None or args.folder_stats is not None or args.create_folder is not None:
        # Folder: only these options apply (no path, no artifact option).
        allowed = ({'--visibility', '--code', '--link-hours', '--link-label', '--title'} if args.share_folder is not None
                   else {'--title', '--description'} if args.create_folder is not None else set())
        given = [flag for flag, on in (
            ('--visibility', args.visibility is not None), ('--title', args.title is not None), ('--description', args.description is not None),
            ('--code', args.code is not None),
            ('--project', args.project is not None), ('--tag', bool(args.tag)), ('--rename-slug', args.rename_slug is not None),
            ('--link-hours', args.link_hours is not None), ('--link-label', args.link_label is not None), ('--slug', args.slug is not None),
            ('--memory-storage/--no-memory-storage', args.memory_storage is not None), ('--include-dotfiles', args.include_dotfiles),
            ('--no-thumbnail', args.no_thumbnail), ('path', args.path is not None),
        ) if on and flag not in allowed]
        if given:
            p.error(f"{', '.join(given)} does not apply to {modes[0]}")
        if args.share_folder is not None:
            visibility = args.visibility or 'link'
            if args.code is not None and visibility != 'code':
                p.error('--code only makes sense with --visibility code')
            if (args.link_hours is not None or args.link_label is not None) and visibility != 'link':
                p.error('--link-hours and --link-label only apply to link sharing (--visibility link)')
        if args.create_folder is not None:
            if args.title is not None and len(args.title.strip()) > 120:
                p.error('--title: 120 characters max')
        name = next(n for n in (args.share_folder, args.folder_stats, args.create_folder) if n is not None)
        if normalize_label(name) is None:
            p.error(f'Invalid folder: {name!r}. Letters, digits and hyphens ({MAX_LABEL} characters max).')
    if args.list_versions or args.restore is not None or args.stats or args.thumbnail_only:
        upload_only = [flag for flag, given in (
            ('--visibility', args.visibility is not None), ('--title', args.title is not None), ('--code', args.code is not None),
            ('--description', args.description is not None),
            ('--project', args.project is not None), ('--tag', bool(args.tag)), ('--rename-slug', args.rename_slug is not None),
            ('--link-hours', args.link_hours is not None), ('--link-label', args.link_label is not None),
            ('--memory-storage/--no-memory-storage', args.memory_storage is not None), ('--include-dotfiles', args.include_dotfiles),
            ('--no-thumbnail', args.no_thumbnail),
        ) if given]
        if upload_only:
            p.error(f"{', '.join(upload_only)} does not apply to {modes[0]} (upload options only)")
    if args.restore is not None and args.restore <= 0:
        p.error('--restore must be a strictly positive integer')
    if args.list_versions and args.restore is not None:
        p.error('--list-versions and --restore are mutually exclusive')
    if (args.list_versions or args.restore is not None or args.stats or args.thumbnail_only) and args.path is None and not args.slug:
        p.error(f'{modes[0]} needs the artifact path or --slug')
    if args.path is None and not modes:
        p.error('the file or folder path is required')
    if args.link_hours is not None and args.link_hours <= 0:
        p.error('--link-hours must be positive')
    return args


def list_projects() -> int:
    base = hub_url()
    token = api_token()
    projects = call(token, 'GET', f'{base}/api/projects')
    if not projects:
        print('No folders.')
        return 0
    print('folder\tartifacts\tvisibility\tprivate')
    for p in projects if isinstance(projects, list) else []:
        named = p.get('name') is not None
        folder = p.get('visibility', 'private') if named else '-'
        print(f"{p['name'] if named else '(no folder)'}\t{p['count']}\t{folder}\t{p.get('privateCount', '?')}")
    return 0


def share_folder(args: argparse.Namespace) -> int:
    name = parse_project(args.share_folder)
    visibility = args.visibility or 'link'
    hours = args.link_hours if args.link_hours is not None else 168
    base_path = f'/api/projects/{name}'
    patch = {k: v for k, v in {'title': args.title, 'visibility': visibility, 'code': args.code}.items() if v is not None}
    if args.dry_run:
        try:
            base = hub_url()
        except PublishError:
            base = '<hub URL>'
        print(f'[dry-run] GET {base}{base_path}')
        if visibility == 'link':
            if args.title is not None:
                print(f'[dry-run] PATCH {base_path}', json.dumps({'title': args.title}, ensure_ascii=False))
            print(f'[dry-run] POST {base_path}/share', json.dumps({'hours': hours, 'label': args.link_label}, ensure_ascii=False))
        else:
            print(f'[dry-run] PATCH {base_path}', json.dumps({**patch, **({'code': '***'} if args.code else {})}, ensure_ascii=False))
        return 0
    base, token = hub_url(), api_token()
    folder = call(token, 'GET', f'{base}{base_path}')
    if not isinstance(folder, dict):
        raise PublishError('Unexpected server response.')
    if visibility == 'code' and not args.code and not folder.get('hasCode'):
        raise UsageError('“code” visibility requires --code (6 characters minimum).')
    private = int(folder.get('privateCount') or 0)
    if visibility in ('link', 'public') and private:
        print(f"Warning: {private} private artifact{'s' if private > 1 else ''} "
              f"{'become' if private > 1 else 'becomes'} visible through the folder (their own URL stays private).", file=sys.stderr)
    share = None
    if visibility == 'link':
        if args.title is not None:
            call(token, 'PATCH', f'{base}{base_path}', json_body={'title': args.title})
        res = call(token, 'POST', f'{base}{base_path}/share', json_body={'hours': hours, 'label': args.link_label})
        folder, share = (res.get('project') or folder), res.get('link')
    else:
        folder = call(token, 'PATCH', f'{base}{base_path}', json_body=patch)
    print(f'folder: {name}')
    if folder.get('title'):
        print(f"title: {folder['title']}")
    print(f"visibility: {folder.get('visibility', visibility)}")
    print(f"artifacts: {folder.get('count', '?')} (including {folder.get('privateCount', '?')} private)")
    print(f"url: {folder.get('url')}")
    if share:
        print(f"share: {share.get('url')}")
        print(f"share-expires: {share.get('expiresAt')}")
    return 0


def create_folder(args: argparse.Namespace) -> int:
    """Empty private folder (share it later with --share-folder)."""
    name = parse_project(args.create_folder)
    body = {'name': name, **{k: v.strip() for k, v in (('title', args.title), ('description', args.description)) if v is not None and v.strip()}}
    if args.dry_run:
        try:
            base = hub_url()
        except PublishError:
            base = '<hub URL>'
        print(f'[dry-run] POST {base}/api/projects', json.dumps(body, ensure_ascii=False))
        return 0
    base, token = hub_url(), api_token()
    try:
        folder = call(token, 'POST', f'{base}/api/projects', json_body=body)
    except PublishError as e:
        if e.status == 409:
            raise PublishError(f"The folder “{name}” already exists (folder sheet or artifacts filed under this name). "
                               f"--list-projects lists the folders; --project {name} publishes into it.") from e
        raise
    if not isinstance(folder, dict):
        raise PublishError('Unexpected server response.')
    print(f"folder: {folder.get('name', name)}")
    if folder.get('title'):
        print(f"title: {folder['title']}")
    if folder.get('description'):
        print(f"description: {folder['description']}")
    print(f"visibility: {folder.get('visibility', 'private')}")
    print(f"artifacts: {folder.get('count', 0)}")
    print(f"url: {folder.get('url')}")
    return 0


def print_stats(stats: dict) -> None:
    total = stats.get('total') or {}
    print(f"views: {total.get('views', 0)}")
    print(f"uniques: {total.get('uniques', 0)}")
    print(f"last-visit: {stats.get('lastVisitAt') or '-'}")
    print(f'last-{STATS_DAYS}-days (UTC day, views, uniques):')
    for d in stats.get('days') or []:
        print(f"{d['day']}\t{d['views']}\t{d['uniques']}")
    links = [l for l in stats.get('links') or [] if isinstance(l, dict)]
    if not links:
        print('links: -')
    else:
        print('links (label, opens, state, last open):')
        for l in links:
            print('\t'.join([l.get('label') or '(no label)', str(l.get('openCount', 0)), 'active' if l.get('active') else 'inactive', l.get('lastUsedAt') or '-']))


def folder_stats(args: argparse.Namespace) -> int:
    name = parse_project(args.folder_stats)
    if args.dry_run:
        try:
            base = hub_url()
        except PublishError:
            base = '<hub URL>'
        print(f'[dry-run] GET {base}/api/projects/{name}/stats?days={STATS_DAYS}')
        return 0
    base, token = hub_url(), api_token()
    stats = call(token, 'GET', f'{base}/api/projects/{name}/stats?days={STATS_DAYS}')
    if not isinstance(stats, dict):
        raise PublishError('Unexpected server response.')
    print(f'folder: {name}')
    print_stats(stats)
    return 0


def find_existing(token: str, base: str, slug: str) -> dict:
    found = call(token, 'GET', f'{base}/api/artifacts?slug={urllib.parse.quote(slug, safe="")}')
    existing = next((a for a in found if isinstance(a, dict) and a.get('slug') == slug), None) if isinstance(found, list) else None
    if not existing:
        raise PublishError(f"No artifact with the slug {slug!r}.")
    return existing


def slug_from_args(args: argparse.Namespace) -> str:
    if args.slug:
        return validate_slug(args.slug)
    path = Path(args.path).expanduser()
    name = Path(os.path.abspath(path)).name
    return validate_slug(slugify(name + '.zip' if path.is_dir() else name))


def fetch_versions(token: str, base: str, art: dict) -> list[dict]:
    versions = call(token, 'GET', f"{base}/api/artifacts/{art['id']}/versions")
    return [v for v in versions if isinstance(v, dict)] if isinstance(versions, list) else []


def dry_run_versions(args: argparse.Namespace, slug: str) -> int:
    try:
        base = hub_url()
    except PublishError:
        base = '<hub URL>'
    print(f'[dry-run] GET {base}/api/artifacts?slug={urllib.parse.quote(slug, safe="")}')
    print('[dry-run] GET /api/artifacts/<id>/versions')
    if args.restore is not None:
        print(f'[dry-run] POST /api/artifacts/<id>/versions/<id of v{args.restore}>/restore (no file upload)')
    return 0


def list_versions(args: argparse.Namespace) -> int:
    slug = slug_from_args(args)
    if args.dry_run:
        return dry_run_versions(args, slug)
    base, token = hub_url(), api_token()
    art = find_existing(token, base, slug)
    for v in fetch_versions(token, base, art):
        print('\t'.join([f"v{v['number']}", v['createdAt'], v['kind'], v['originalName'], str(v['sizeBytes']), '* current' if v.get('current') else '']).rstrip())
    return 0


def restore_version(args: argparse.Namespace) -> int:
    slug = slug_from_args(args)
    if args.dry_run:
        return dry_run_versions(args, slug)
    base, token = hub_url(), api_token()
    art = find_existing(token, base, slug)
    target = next((v for v in fetch_versions(token, base, art) if v.get('number') == args.restore), None)
    if not target:
        raise PublishError(f"Version v{args.restore} does not exist (or was pruned) for {slug!r}; --list-versions lists them.")
    res = call(token, 'POST', f"{base}/api/artifacts/{art['id']}/versions/{target['id']}/restore")
    print(f"restored: {res['title']}")
    print(f"slug: {res['slug']}")
    print(f"version: v{(res.get('version') or {}).get('number', args.restore)}")
    print(f"url: {res['url']}")
    return 0


class ThumbnailError(PublishError):
    pass


def find_browser() -> tuple[str, str] | None:
    """agent-browser when on PATH, else the first installed Chromium-based browser (macOS application folders)."""
    ab = shutil.which('agent-browser')
    if ab:
        return 'agent-browser', ab
    for apps in APP_DIRS:
        for rel in CHROMIUM_APPS:
            exe = str(apps / rel)
            if os.access(exe, os.X_OK):
                return 'chromium', exe
    return None


def thumb_session() -> str:
    """agent-browser session private to this run: two concurrent publishes never close each other."""
    return f'{THUMB_SESSION_PREFIX}-{os.getpid()}'


def browser_label() -> str:
    browser = find_browser()
    if not browser:
        return 'no browser found'
    return f'agent-browser (session {thumb_session()})' if browser[0] == 'agent-browser' else Path(browser[1]).name


def capture_commands(browser: tuple[str, str], url: str, png: Path, profile: Path) -> list[list[str]]:
    """Commands capturing the first viewport. The signed preview URL is short-lived; the token never appears in it."""
    kind, exe = browser
    w, h = THUMB_VIEWPORT
    if kind == 'agent-browser':
        s = [exe, '--session', thumb_session()]
        # Light theme forced: the thumbnail does not depend on the machine's appearance at publish time.
        return [[*s, 'set', 'viewport', str(w), str(h), '1'], [*s, 'set', 'media', 'light'], [*s, 'open', url], [*s, 'wait', '--load', 'load'],
                [*s, 'wait', str(THUMB_SETTLE_MS)], [*s, 'eval', HIDE_SCROLLBARS_JS], [*s, 'screenshot', str(png)]]
    # Throwaway profile: never the user's (no cookies, no already-open Chrome).
    return [[exe, '--headless=new', f'--screenshot={png}', f'--window-size={w},{h}', '--hide-scrollbars', '--force-device-scale-factor=1',
             '--virtual-time-budget=2000', '--blink-settings=preferredColorScheme=1', f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check',
             '--disable-extensions', '--mute-audio', url]]


def remaining(deadline: float) -> float:
    """Time left in the thumbnail budget; raises when exhausted."""
    left = deadline - time.monotonic()
    if left <= 0:
        raise ThumbnailError(f'{THUMB_BUDGET_S} s budget exceeded')
    return left


def run_tool(cmd: list[str], label: str, deadline: float) -> None:
    """Runs a local tool within the remaining budget; its output is never shown (it may contain the signed URL)."""
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=remaining(deadline), check=False)
    except subprocess.TimeoutExpired:
        raise ThumbnailError(f'{label}: {THUMB_BUDGET_S} s budget exceeded')
    except OSError as e:
        raise ThumbnailError(f'{label} not found ({e.strerror})')
    if res.returncode != 0:
        raise ThumbnailError(f'{label} failed (code {res.returncode})')


def convert_thumbnail(png: Path, work: Path, deadline: float) -> tuple[Path, str]:
    """960×600 as WebP (cwebp, magick) or JPEG (sips); otherwise the PNG capture as is."""
    w, h = THUMB_SIZE
    webp, jpg = work / 'thumb.webp', work / 'thumb.jpg'
    candidates = []
    if (cwebp := shutil.which('cwebp')):
        candidates.append(([cwebp, '-quiet', '-q', '80', '-resize', str(w), str(h), str(png), '-o', str(webp)], webp, 'image/webp'))
    if (magick := shutil.which('magick')):
        candidates.append(([magick, str(png), '-resize', f'{w}x{h}', '-quality', '80', str(webp)], webp, 'image/webp'))
    if (sips := shutil.which('sips')):
        candidates.append(([sips, '-z', str(h), str(w), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', str(png), '--out', str(jpg)], jpg, 'image/jpeg'))
    for cmd, out, mime in candidates:
        try:
            run_tool(cmd, Path(cmd[0]).name, deadline)
        except ThumbnailError:
            remaining(deadline)  # budget exhausted: stop here
            continue
        if out.is_file() and out.stat().st_size > 0:
            return out, mime
    return png, 'image/png'


def capture_thumbnail(token: str, base: str, art: dict) -> None:
    """Captures the version of `art` on this machine and sends it to the hub. Raises ThumbnailError/PublishError on failure."""
    deadline = time.monotonic() + THUMB_BUDGET_S
    version_id = (art.get('version') or {}).get('id')
    browser = find_browser()
    if not browser:
        raise ThumbnailError('no browser found (agent-browser, Google Chrome, Chromium, Edge or Brave)')
    # Preview pinned to this version: a concurrent publish does not change what is captured.
    curl_time = lambda: max(1, min(THUMB_CURL_TIMEOUT_S, int(remaining(deadline))))  # noqa: E731
    preview = call(token, 'GET', f"{base}/api/artifacts/{art['id']}/versions/{version_id}/preview", max_time=curl_time())
    url = preview.get('url') if isinstance(preview, dict) else None
    if not url:
        raise ThumbnailError('preview unavailable')
    # Chrome may leave locked files in its throwaway profile: incomplete cleanup is not an error.
    with tempfile.TemporaryDirectory(prefix='blazz-artifacts-thumb-', ignore_cleanup_errors=True) as d:
        work = Path(d)
        png = work / 'capture.png'
        try:
            for cmd in capture_commands(browser, url, png, work / 'profile'):
                run_tool(cmd, Path(browser[1]).name, deadline)
        finally:
            if browser[0] == 'agent-browser':  # closes only this run's session, even when the budget is exhausted
                try:
                    subprocess.run([browser[1], '--session', thumb_session(), 'close'], capture_output=True, timeout=CLOSE_TIMEOUT_S, check=False)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        if not png.is_file() or png.stat().st_size == 0:
            raise ThumbnailError('empty capture')
        image, mime = convert_thumbnail(png, work, deadline)
        size = image.stat().st_size
        if size > THUMB_MAX_BYTES:
            raise ThumbnailError(f'image too large ({size // 1024} KiB, limit 2 MiB)')
        call(token, 'PUT', f"{base}/api/artifacts/{art['id']}/versions/{version_id}/thumbnail", body_file=(image, mime), max_time=curl_time())


def publish_thumbnail(token: str, base: str, art: dict) -> None:
    """After a successful upload: never fails, prints at most one warning line."""
    if art.get('kind') == 'pdf' or not (art.get('version') or {}).get('id'):
        return  # PDF: the card keeps its pictogram; without a version id the hub does not support thumbnails
    try:
        capture_thumbnail(token, base, art)
    except Exception as e:  # noqa: BLE001: the thumbnail is a bonus, the upload succeeded
        reason = ' '.join(str(e).replace(token, '***').split()) or type(e).__name__
        print(f"Warning: thumbnail not generated ({reason}); the artifact is published. "
              f"To retry: --thumbnail-only --slug {art.get('slug')}", file=sys.stderr)
        return
    print('thumbnail: ok')


def thumbnail_only(args: argparse.Namespace) -> int:
    slug = slug_from_args(args)
    if args.dry_run:
        try:
            base = hub_url()
        except PublishError:
            base = '<hub URL>'
        print(f'[dry-run] GET {base}/api/artifacts?slug={urllib.parse.quote(slug, safe="")}')
        print(f'[dry-run] GET /api/artifacts/<id>/versions/<id>/preview, capture via {browser_label()}, '
              'then PUT /api/artifacts/<id>/versions/<id>/thumbnail (no content upload)')
        return 0
    base, token = hub_url(), api_token()
    art = find_existing(token, base, slug)
    if art.get('kind') == 'pdf':
        raise PublishError('PDFs have no thumbnail: the card keeps its pictogram.')
    if not (art.get('version') or {}).get('id'):
        raise PublishError('Current version not found (hub without thumbnail support?).')
    capture_thumbnail(token, base, art)
    print('thumbnail: ok')
    print(f"slug: {art['slug']}")
    print(f"version: v{art['version'].get('number', '?')}")
    return 0


STATS_DAYS = 7


def show_stats(args: argparse.Namespace) -> int:
    slug = slug_from_args(args)
    if args.dry_run:
        try:
            base = hub_url()
        except PublishError:
            base = '<hub URL>'
        print(f'[dry-run] GET {base}/api/artifacts?slug={urllib.parse.quote(slug, safe="")}')
        print(f'[dry-run] GET /api/artifacts/<id>/stats?days={STATS_DAYS}')
        return 0
    base, token = hub_url(), api_token()
    art = find_existing(token, base, slug)
    stats = call(token, 'GET', f"{base}/api/artifacts/{art['id']}/stats?days={STATS_DAYS}")
    if not isinstance(stats, dict):
        raise PublishError('Unexpected server response.')
    print(f"stats: {art['title']}")
    print(f"slug: {art['slug']}")
    print_stats(stats)
    return 0


def run(args: argparse.Namespace) -> int:
    if args.thumbnail_only:
        return thumbnail_only(args)
    if args.stats:
        return show_stats(args)
    if args.list_projects:
        return list_projects()
    if args.share_folder is not None:
        return share_folder(args)
    if args.folder_stats is not None:
        return folder_stats(args)
    if args.create_folder is not None:
        return create_folder(args)
    if args.list_versions:
        return list_versions(args)
    if args.restore is not None:
        return restore_version(args)
    path = Path(args.path).expanduser()
    # Name from the path given by the user, without resolving symbolic links.
    base_name = Path(os.path.abspath(path)).name
    is_dir = path.is_dir()
    # A folder becomes “<name>.zip” on the server, as for the default slug.
    slug = validate_slug(args.slug or slugify(base_name + '.zip' if is_dir else base_name))
    title = args.title or (base_name if is_dir else Path(base_name).stem)
    if args.code is not None and args.visibility not in (None, 'code'):
        raise UsageError('--code only makes sense with --visibility code.')
    project = parse_project(args.project) if args.project is not None else None  # None with args.project given = clear
    tags = parse_tags(args.tag) if args.tag else None
    rename = validate_slug(args.rename_slug) if args.rename_slug is not None else None
    description_arg = args.description.strip() if args.description is not None else None
    if rename == slug:
        raise UsageError(f'--rename-slug is the same as the current slug ({slug}).')
    tmp: list[Path] = []
    try:
        upload, filename, description = prepare_upload(path, base_name, tmp, args.include_dotfiles)
        if args.dry_run:
            try:
                base = hub_url()
            except PublishError:
                base = '<hub URL>'
            print(f'[dry-run] {description}')
            print(f'[dry-run] GET {base}/api/artifacts?slug={urllib.parse.quote(slug, safe="")}')
            print('[dry-run] if absent: POST /api/artifacts', json.dumps({
                'file': filename, 'title': title, 'slug': slug, 'visibility': args.visibility or 'private',
                'code': '***' if args.code else None, 'memoryStorage': bool(args.memory_storage),
                'project': project, 'tags': tags or [], 'description': description_arg}, ensure_ascii=False))
            update_patch = {k: v for k, v in {'title': args.title, 'description': description_arg, 'visibility': args.visibility,
                                              'code': '***' if args.code else None,
                                              'memoryStorage': args.memory_storage, 'tags': tags}.items() if v is not None}
            if args.project is not None:
                update_patch['project'] = project
            print('[dry-run] if present: PUT /api/artifacts/<id>/content then PATCH', json.dumps(update_patch, ensure_ascii=False))
            if rename:
                print(f'[dry-run] then slug rename: {slug} -> {rename} (the old URL will stop working)')
            if args.link_hours:
                print(f'[dry-run] {args.link_hours} h share link if the visibility is “link”')
            if not args.no_thumbnail:
                print(f'[dry-run] then thumbnail (except PDF): {THUMB_VIEWPORT[0]}×{THUMB_VIEWPORT[1]} capture via {browser_label()}, '
                      'PUT /api/artifacts/<id>/versions/<id>/thumbnail')
            return 0

        base = hub_url()
        token = api_token()
        found = call(token, 'GET', f'{base}/api/artifacts?slug={urllib.parse.quote(slug, safe="")}')
        # Never a “close” artifact: the returned slug must be exactly the requested one.
        existing = next((a for a in found if isinstance(a, dict) and a.get('slug') == slug), None) if isinstance(found, list) else None
        # All validations before any upload.
        visibility = args.visibility or (existing['visibility'] if existing else 'private')
        if args.code and visibility != 'code':
            raise UsageError(f'--code only makes sense with “code” visibility (resulting visibility: {visibility}).')
        if visibility == 'code' and not args.code and not (existing and existing.get('hasCode')):
            raise UsageError('“code” visibility requires --code (6 characters minimum).')
        if args.link_hours and visibility != 'link':
            print(f'Warning: --link-hours ignored, the visibility is “{visibility}”, not “link”.', file=sys.stderr)

        if rename:
            if not existing:
                raise UsageError('--rename-slug only applies to updating an existing artifact.')
            check = call(token, 'GET', f'{base}/api/slugs/{urllib.parse.quote(rename, safe="")}')
            if not (isinstance(check, dict) and check.get('available')):
                raise UsageError(f'The slug {rename!r} is invalid or already in use.')

        print(description)
        if existing:
            art = call(token, 'PUT', f"{base}/api/artifacts/{existing['id']}/content", file=(upload, filename))
            patch = {k: v for k, v in {'title': args.title, 'description': description_arg, 'visibility': args.visibility, 'code': args.code,
                                        'memoryStorage': args.memory_storage, 'tags': tags}.items() if v is not None}
            if args.project is not None:
                patch['project'] = project
            if patch:
                art = call(token, 'PATCH', f"{base}/api/artifacts/{art['id']}", json_body=patch)
            old_url = art['url']
            if rename:
                try:
                    art = call(token, 'PATCH', f"{base}/api/artifacts/{art['id']}", json_body={'slug': rename})
                except PublishError as e:
                    print(f"Error: the content was updated at the old URL {old_url}, but the rename failed ({e}). "
                          f"Run again with --slug {slug} --rename-slug {rename}.", file=sys.stderr)
                    return 1
            action = 'updated'
        else:
            fields = {'title': title, 'slug': slug, 'visibility': visibility}
            if project:
                fields['project'] = project
            if tags:
                fields['tags'] = ','.join(tags)
            if args.code:
                fields['code'] = args.code
            if description_arg:
                fields['description'] = description_arg
            if args.memory_storage:
                fields['memoryStorage'] = 'true'
            art = call(token, 'POST', f'{base}/api/artifacts', fields=fields, file=(upload, filename))
            action = 'created'

        share_url = expires = link_error = None
        if art['visibility'] == 'link' and args.link_hours:
            expires = (datetime.now(timezone.utc) + timedelta(hours=args.link_hours)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
            try:
                link = call(token, 'POST', f"{base}/api/artifacts/{art['id']}/links",
                            json_body={'expiresAt': expires, 'label': args.link_label})
                share_url = link.get('url')
            except PublishError as e:
                link_error = e

        print(f"{action}: {art['title']}")
        if art.get('description'):
            print(f"description: {art['description']}")
        print(f"slug: {art['slug']}")
        print(f"visibility: {art['visibility']}")
        if art.get('version'):
            print(f"version: v{art['version']['number']}")
        print(f"memory-storage: {'on' if art.get('memoryStorage') else 'off'}")
        print(f"project: {art.get('project') or '-'}")
        print(f"tags: {', '.join(art.get('tags') or []) or '-'}")
        print(f"url: {art['url']}")
        if rename:
            print(f"renamed: {slug} -> {art['slug']} (the old URL {old_url} no longer works)")
        if share_url:
            print(f"share: {share_url}")
            print(f"share-expires: {expires}")
        if not args.no_thumbnail:
            publish_thumbnail(token, base, art)
        if link_error:
            print(f'Error: the share link could not be created ({link_error}).', file=sys.stderr)
            return 1
        return 0
    finally:
        for f in tmp:
            f.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        return run(args)
    except PublishError as e:
        print(f'Error: {e}', file=sys.stderr)
        return e.exit_code


if __name__ == '__main__':
    sys.exit(main())
