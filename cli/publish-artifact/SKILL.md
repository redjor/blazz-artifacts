---
name: publish-artifact
description: Publishes a file, a folder of HTML mockups, a report or a generated page to the user's self-hosted Blazz Artifacts hub and returns the URL. Use when the user asks to publish, push or share a file or a mockup, or mentions the hub or an artifact ("publish this", "push it to the hub", "share this mockup", "artifact").
---

# Publish to Blazz Artifacts

## Requirements

- `python3` 3.10 or newer (macOS's `/usr/bin/python3` 3.9 is not enough: the script stops with a message; use Homebrew's or another recent Python).
- `curl`.
- This machine can reach the hub's admin URL (for example over a VPN or a tailnet when the admin origin is private).
- The hub URL is in `ARTIFACT_HUB_URL` (alias `BLAZZ_ARTIFACTS_URL`) or on the first line of `~/.config/artifact-hub/url`.
- The API token is in the macOS Keychain (`security add-generic-password -s artifact-hub -a api-token -w`) or in `ARTIFACT_HUB_TOKEN` (alias `BLAZZ_ARTIFACTS_TOKEN`). Never print it or pass it as an argument.

## Command

Call the script by its absolute path, from the user's current directory (never `cd` into the skill folder: relative paths given by the user must stay valid):

```
python3 <skill-folder>/publish.py <file-or-folder> [options]
```

| Option | Effect |
|---|---|
| `--slug S` | URL `/a/S` (default: file or folder name). An existing slug updates that artifact. |
| `--title T` | Displayed title |
| `--description D` | One or two sentences shown under the title (folder pages, link previews, gallery search), 1000 characters max; `--description ''` clears it on update |
| `--visibility private\|code\|link\|public` | Default `private` on creation; unchanged otherwise |
| `--code CODE` | Access code (6 characters min.), for `--visibility code` |
| `--link-hours N` | With `link` visibility: creates a share link valid N hours |
| `--link-label L` | Link label |
| `--memory-storage` / `--no-memory-storage` | Simulates `localStorage`/`sessionStorage` (mockups) |
| `--project P` | The artifact's folder (one at most). `--project ""` removes it on update |
| `--tag T` | Tag, repeatable. On update, replaces all tags, and only when at least one `--tag` is given |
| `--rename-slug NEW` | Update only: changes the slug after the content update. The old URL stops working |
| `--list-projects` | Lists folders: artifact count, folder visibility, private artifact count; then exits (no path needed) |
| `--share-folder P` | Shares folder P (page `/d/P` listing all its artifacts). Default: 7-day link (`--link-hours N`, `--link-label L`). With `--visibility public`, `code --code …` or `private` (unshares). `--title T` sets the page title. Exits, no upload |
| `--create-folder NAME` | Creates an empty **private** folder (normalised name: lowercase, hyphens). Optional `--title T` and `--description D`. Prints `folder:`, `visibility:`, `url:`. Name already taken (folder or artifacts filed under it): error, exit code 1. Exits, no upload |
| `--folder-stats P` | Visits of folder P's page: views, uniques, last 7 days, opens per link. Exits, no upload |
| `--include-dotfiles` | Keeps hidden files and folders of a folder (skipped by default: `.env`, `.vscode`…). `.git`, `.DS_Store`, `__MACOSX`, `node_modules` and symbolic links are always skipped |
| `--list-versions` | Lists the artifact's versions (path or `--slug`): number, date, kind, original name, size, `* current` marker. Exits, no upload |
| `--restore N` | Makes version N current (same URL), with a path or `--slug`. Integer > 0; exits, no upload |
| `--stats` | Artifact visits (path or `--slug`): all-time views and unique visitors, last visit, views/uniques for the last 7 days (UTC), opens per share link. Exits, no upload |
| `--no-thumbnail` | No thumbnail after the upload (by default a capture is made automatically) |
| `--thumbnail-only` | Recaptures the thumbnail of the current version (path or `--slug`) without uploading content, then exits. Useful for artifacts published before thumbnails or whose capture failed |
| `--dry-run` | Shows what would be sent, without network calls |

Accepted files: `.html .htm .md .markdown .pdf .json .zip`. A folder is zipped (`index.html` required at its root).

## Thumbnails

Automatic: after each creation or update, the script captures the page's first viewport on this machine (1280×800, reduced to a 960×600 WebP) and sends it to the hub, which shows it on the gallery card. The server never renders anything. Browser used: `agent-browser` when installed (a `publish-thumb-<pid>` session private to the run, closed afterwards), else Google Chrome, Chromium, Edge or Brave in headless mode. PDFs have no thumbnail (the card keeps its pictogram).

The thumbnail has a 60 s total budget (preview, capture, conversion, upload). A failed capture never fails the publish: a `Warning: thumbnail not generated (…)` line is printed and the artifact is published. Then run `--thumbnail-only --slug S`. `thumbnail: ok` in the summary confirms the upload.

## Folders

A folder can be shared: a page `https://<content>/d/<folder>` (no JavaScript) lists all its artifacts, with thumbnails. **Anyone who can see the folder can open each of its artifacts, even private ones**, as long as they are in the folder; their own `/a/<slug>` URL keeps its visibility. Removing an artifact from the folder cuts access through the folder immediately (an already open tab stays valid for up to 1 h). `--share-folder` prints a warning when private artifacts become visible this way.

A folder is born when an artifact is published with `--project`, or explicitly, empty, with `--create-folder` (same as “New folder” in the hub). It stays private until `--share-folder`.

## Decision rules

- `private` visibility by default. Ask for confirmation before `public`, and before any sharing wider than what the user asked for.
- For a multi-page mockup, pass the folder, not a single file.
- If the pages use `localStorage` or `sessionStorage` (check with `grep -rE "localStorage|sessionStorage" <folder>`), add `--memory-storage`. The data only lasts for the tab's lifetime; do not enable it for sensitive data.
- To share with someone: `--visibility link --link-hours N` (24 or 48 is a reasonable default), or `--visibility code --code …`.
- When the user names a project or a client, pass `--project`. Run `--list-projects` first and reuse an existing name instead of inventing a variant (`acme` vs `client-acme`); ask when ambiguous. Folders and tags are normalised (lowercase, hyphens) and stay internal: they do not appear in public URLs, except the name of a folder shared as a page (`/d/<folder>`).
- “Create a folder X”: `--list-projects` first (do not duplicate a close name), then `--create-folder X [--title …]`. Do not share it right away unless explicitly asked. Report the normalised name and remind that it is private.
- “Share the folder X”: `--list-projects` to find the exact name, then `--share-folder X` (7-day link). Before sharing a folder that holds private artifacts (`private` column of `--list-projects`), tell the user and ask for confirmation; `public` only on explicit request. Report the `share:` URL (or `url:` outside link mode) and the expiry.
- `--rename-slug` breaks the old URL: tell the user and only use it on request.
- Replacing content = publishing again with the same slug: a new version is created (`version: v<n>` in the summary), the URL does not change. To go back: `--list-versions --slug S` then `--restore N --slug S`.
- Retention: Markdown and HTML versions are kept without limit; other kinds (ZIP site, PDF, JSON) keep the 10 most recent (the current version is never deleted). Warn the user before republishing a large site over a version they might want back beyond 10 uploads.
- Options that are not given do not change an existing artifact.
- “How many views?”, “was the link opened?”: `--stats --slug S`. A view = a person who opens the artifact (not previews from the hub, not bots and messaging link previews, not repeated reloads within half an hour). “Uniques” is a sum of distinct visitors per day: a visitor who comes back another day counts again. No IP is stored: do not promise to know *who* opened it.
- The script refuses (exit code 2, before any upload): an invalid slug, `--code` without `code` visibility, `--visibility code` without `--code` when the artifact has no code yet, an invalid folder, tag or new slug, or a new slug already taken (`--rename-slug`). `--link-hours` is ignored with a warning when the visibility is not `link`.
- When the upload succeeds but the share link fails, the summary is printed then the script exits with an error: create the link from the admin UI.
- Check the output: the number of skipped files (hidden, links) is shown before the upload.

## What to report to the user

For a folder: its URL or share link and the expiry, its visibility, the artifact count and how many are private (visible through the folder).

For an artifact: URL, version number (`version: v<n>`), folder and tags, visibility, share link and its expiry if any, and whether it was a creation, an update or a restore (in that case the restored version becomes the published one). Mention a thumbnail warning if there is one (without presenting it as a failed publish).

## On failure

- `HTTP 401`: token missing, wrong or disabled (`API_TOKEN_HASH` empty on the server).
- `HTTP 413` or “too large”: reduce the upload (100 MiB limit in the script, `MAX_UPLOAD_MB` on the server).
- Timeout or connection refused: the hub's admin URL is not reachable from this machine (VPN or tailnet disconnected?).
- `HTTP 409`: slug already used by another artifact; pick another one.
- Thumbnail not generated with “no browser found”: install Google Chrome (or `agent-browser`), then `--thumbnail-only --slug S`.
