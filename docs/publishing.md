# Publishing

## From the admin UI

Drag a file anywhere on the gallery (or press `N`): HTML, Markdown, PDF, JSON or a ZIP site with `index.html` at its root.
Pick a title, slug, folder, tags and visibility. Re-publishing on an existing slug from the artifact drawer
("Replace file…") creates a new version at the same URL.

## API token

```bash
docker run --rm --network none blazz-artifacts:local node src/scripts/new-api-token.ts
# token=…  → for the CLI          hash=…  → API_TOKEN_HASH in .env, then recreate the app container
```

The token is high-entropy, stored only as SHA-256 on the server. It authenticates `Authorization: Bearer <token>` API
calls without cookies; it cannot sign in or out of the admin UI.

## Publish CLI

`cli/publish-artifact/publish.py` needs Python 3.10+ (stdlib only) and `curl`. The token never appears in process
arguments or in the output: curl reads its configuration on stdin.

Configuration (see [configuration.md](configuration.md#publish-cli)):

```bash
mkdir -p ~/.config/artifact-hub && echo 'https://admin.example.com' > ~/.config/artifact-hub/url
security add-generic-password -s artifact-hub -a api-token -w      # macOS Keychain, prompted without echo
# or: export ARTIFACT_HUB_URL=… ARTIFACT_HUB_TOKEN=…  (aliases: BLAZZ_ARTIFACTS_URL, BLAZZ_ARTIFACTS_TOKEN)
```

Examples:

```bash
python3 publish.py report.md                                        # private, slug "report"
python3 publish.py ./mockups --visibility link --link-hours 48 --memory-storage
python3 publish.py page.html --slug demo --project client-acme --tag v2 --tag mockup --description "Booking flow, step 1"
python3 publish.py --list-projects
python3 publish.py --create-folder client-acme --title "Client Acme"
python3 publish.py --share-folder client-acme                       # 7-day link to the folder page
python3 publish.py --list-versions --slug demo && python3 publish.py --restore 2 --slug demo
python3 publish.py --stats --slug demo
python3 publish.py --thumbnail-only --slug demo
python3 publish.py ./site --dry-run
```

Sub-folders are created and moved in the admin UI. `--project <name>` targets a folder at any level, and folders created by the CLI go to the root.

A folder argument is zipped (hidden files and symbolic links skipped unless `--include-dotfiles`; `.git`, `.DS_Store`,
`__MACOSX`, `node_modules` always skipped). Exit codes: 0 success, 1 failure, 2 usage error (nothing sent).
Run `python3 publish.py --help` for every option; [SKILL.md](../cli/publish-artifact/SKILL.md) documents them all.

### Thumbnails

After each upload the CLI asks for a signed preview of the exact version it sent, opens it in a local headless browser
(first viewport 1280×800, light theme, 1.5 s to settle), reduces it to 960×600 WebP and uploads it. Browser: `agent-browser`
when on `PATH` (a per-run session closed afterwards), else Google Chrome, Chromium, Microsoft Edge or Brave from the
macOS application folders with a throwaway profile. Conversion: `cwebp` or `magick` (WebP), else `sips` (JPEG), else the raw
PNG. Total budget 60 s; a failure prints one warning and never fails the publish. PDFs have no thumbnail.
`--no-thumbnail` skips it, `--thumbnail-only --slug S` recaptures it.

## Claude Code skill

The `cli/publish-artifact/` folder is a Claude Code skill: copy or symlink it into `~/.claude/skills/publish-artifact`.
Claude then publishes when you ask to "publish", "share this mockup" or "push it to the hub", following the decision rules
in `SKILL.md` (private by default, confirmation before public or wider sharing, reuse existing folder names, report URL,
version and expiry).

## Simulated browser storage

Mockups that call `localStorage` or `sessionStorage` crash in the sandbox. The "Simulate browser storage" option
(`--memory-storage`) injects a small script into the HTML pages of `html` and `site` artifacts (up to 2 MiB per page)
that replaces both objects when the browser refuses them. Data lives for the tab's lifetime in `window.name`, so it
survives navigation between the site's pages; any page opened later in the same tab can read it. Do not use it for
sensitive data.

## Drafts and approval

Uploads now save a working version. Visitors keep seeing the last approved version,
through the same artifact and folder links. New artifacts are invisible until approved.
In the artifact panel, preview the working version, then choose **Publish this version**.
History also allows publishing an older version directly. Restore only changes the
working version. Publication preserves the artifact's visibility: publishing a private
artifact does not make it public. Titles, descriptions and access settings remain
artifact-wide and apply immediately; the approval step applies to file content.
Existing artifacts retain their current published version when upgrading.

For automation, pass `--publish` to approve the uploaded version, or call
`POST /api/artifacts/:id/publish` with `{"versionId":"..."}` after review.
Without `--publish`, the CLI saves a draft. The API returns `publishedVersionId` and
`publishedVersionNumber`, separately from the working `version`.

## React components

Drop a `.jsx` or `.tsx` file with a default component export, or use the CLI/MCP.
These are stored as HTML artifacts with the original source and transformed module.
The server transforms source with esbuild; it does not execute it or read imported
files. React 19.2.0, ReactDOM and npm imports load through esm.sh in the visitor's
browser; Tailwind's browser runtime supplies utility classes. Internet access is
required. Pin npm versions in imports when reproducibility matters.
Local imports, CSS files, Node built-ins and full projects should be built locally
and uploaded as ZIP sites. Components retain the opaque-origin content sandbox.

## QR codes and embedding

After publication, open **Share → QR code and embed**. Download SVG or PNG QR codes
for the current public/code URL or active share link. Codes are generated locally,
without sending your URL to a QR service. A code-protected link still asks for its code;
an expiring or revoked share link also stops working when scanned.

Public artifacts additionally offer **Copy iframe code**. The stable `/embed/:slug/`
URL serves only the approved version and re-checks public visibility on every request.
Private, code-protected and share-link artifacts cannot be embedded. Changing visibility
removes access on the next load; it cannot remove content already loaded by a browser.

See [API keys and MCP](api-keys-mcp.md) for named credentials and client configuration.
