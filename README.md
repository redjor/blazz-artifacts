# Blazz Artifacts

A small self-hosted hub to publish HTML pages, Markdown documents, PDFs, JSON files and ZIP mini-sites in seconds, and share them on your terms: private, behind a code, through revocable expiring links, or public. Built for the pages AI assistants generate all day (mockups, reports, prototypes), with a publish CLI that doubles as a Claude Code skill.

The admin UI is available in **English** and **French**; visitor pages follow `HUB_LOCALE` (English, French, or the visitor's browser language).

## Screenshots

_To be added before the first public release:_

- Gallery with folders as cards (dark and light)
- Artifact drawer: details, access & sharing, audience chart, history
- Folder drawer: ordering, share links, visitor page preview
- Visitor folder page and Markdown reader (light and dark)
- Code-protected page unlock form
- Mobile gallery (390 px)

## Features

- **Publish** HTML, React JSX/TSX components, Markdown (GFM, syntax highlighting, Mermaid diagrams, sanitised), PDF, JSON (formatted) and ZIP sites (Vite builds work, `<script type="module">` included) by drag and drop or from the CLI.
- **Four visibility modes** per artifact: private, secret code, share link, public. Share links are revocable, can expire, and are counted.
- **Stable URLs with approved versions**: uploads save drafts; explicitly publish the reviewed version while preserving `/a/<slug>`. Preview, compare, restore and publish any kept version.
- **Agent integrations**: built-in HTTP MCP, CLI, named API keys with read/publish/full scopes, expiry and independent revocation. See [setup](docs/api-keys-mcp.md).
- **Share anywhere**: locally generated QR codes (SVG/PNG) and iframe snippets for public, approved artifacts.
- **Client Markdown themes**: reusable logos, colors, typography and layouts, inherited from folders or selected per document. Preview before applying a theme as a new version; existing versions keep their appearance. See [Markdown themes](docs/markdown-themes.md).
- **Folders**: group artifacts, share a folder as a script-free page (`/d/<folder>`) with its own access mode, ordering, description and links.
- **Visitor bar**: every artifact opens under a slim bar with its folder path, title, version, the original file and "Open alone"; folder pages share it (`ARTIFACT_BAR`).
- **Link previews**: public artifacts, share links and shared folders unfurl in Slack, Teams, iMessage or WhatsApp with their title, excerpt and thumbnail; people and scripts are unaffected (`LINK_PREVIEWS`).
- **Trash**: a deleted artifact is gone for visitors at once but can be restored for 30 days (`TRASH_DAYS`), undo included.
- **Gallery**: real thumbnails captured by the CLI at publish time, kind filters, tags, full-text search (content of Markdown, JSON, HTML pages and ZIP sites, accents ignored), pinning, list or grid, keyboard navigation and shortcuts, a `Ctrl/Cmd+K` command palette.
- **Bulk actions**: select artifacts to move, tag, change visibility, pin or trash them at once, with the same safeguards and an undo.
- **Privacy-friendly audience stats**: views and daily unique visitors counted server side, no script injected in artifacts, no tracking cookie, no IP or User-Agent stored.
- **Browser storage simulation** for mockups that use `localStorage`/`sessionStorage` inside the sandbox.
- **Small footprint**: one Node process, SQLite (`node:sqlite`), about 50 MB of RAM at rest; runs happily on a NAS.

## Security model in short

Two HTTP servers in one process, meant to sit on **two different origins**:

- **admin** (`:3000`): React SPA + JSON API, strict CSP, password session with CSRF and Origin checks, optional API token for automation. Keep it private (VPN, tailnet, allow-list).
- **content** (`:3001`): serves artifacts under a CSP `sandbox` without `allow-same-origin`, so every published page runs in an opaque origin and cannot read cookies or other artifacts. Files are reached through short-lived HMAC-signed paths; access grants are signed cookies tied to an access epoch you can bump to cut everything at once.

Read [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md) for the threat model and what is and is not protected.

## Quick start (Docker Compose)

```bash
git clone <this repository> blazz-artifacts && cd blazz-artifacts/deploy
cp .env.example .env && chmod 600 .env
sed -i.bak "s|^HUB_SECRET=.*|HUB_SECRET=$(openssl rand -base64 48)|" .env && rm .env.bak
docker compose build
read -s P; printf %s "$P" | docker run --rm -i --network none blazz-artifacts:local node src/scripts/hash-password.ts
# paste the scrypt:… line into ADMIN_PASSWORD_HASH=, set PUBLIC_HUB_URL and PUBLIC_CONTENT_URL
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d
```

Both ports are bound to `127.0.0.1`: put a reverse proxy in front with two hostnames ([Caddy example](deploy/caddy/Caddyfile.example)), or use the [Tailscale variant](deploy/docker-compose.tailscale.yml) (admin on your tailnet, content public through Funnel). See [docs/deployment.md](docs/deployment.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HUB_SECRET` | required | Base64, at least 32 bytes (`openssl rand -base64 48`). Every signing and encryption key derives from it; changing it invalidates sessions, grants and share links. |
| `PUBLIC_HUB_URL` | required | Public origin of the admin server (https; `http://localhost` allowed for development). Mutations must carry this `Origin`. |
| `PUBLIC_HUB_ALT_URLS` | empty | Other admin origins, comma-separated (for example a tailnet name and a public hostname behind an identity proxy). Trusted like `PUBLIC_HUB_URL`. |
| `PUBLIC_CONTENT_URL` | required | Public origin of the content server, used to build artifact, folder and share URLs. |
| `ADMIN_PASSWORD_HASH` | empty | `scrypt:…` from `src/scripts/hash-password.ts`. Empty: admin sign-in impossible. |
| `API_TOKEN_HASH` | empty | SHA-256 hex from `src/scripts/new-api-token.ts`. Empty: API token disabled. |
| `ARTIFACT_BAR` | `1` | Top bar above artifacts for visitors (the artifact is framed); `0` turns it off. |
| `LINK_PREVIEWS` | `1` | Open Graph cards for link-preview services (Slack, Teams, iMessage…); `0` turns them off. |
| `HUB_LOCALE` | `en` | Language of visitor pages: `en`, `fr`, or `auto` (Accept-Language). |
| `MAX_UPLOAD_MB` | `100` | Upload size limit. |
| `ZIP_MAX_FILES` / `ZIP_MAX_BYTES` | `2000` / `209715200` | ZIP extraction limits. |
| `DATA_DIR` | `/data` | Database, files and thumbnails. |
| `ADMIN_BIND` / `CONTENT_BIND` | `127.0.0.1` | Listen addresses of the two servers. |
| `ADMIN_PORT` / `CONTENT_PORT` | `3000` / `3001` | Listen ports. |

Details in [docs/configuration.md](docs/configuration.md).

## Publish from the command line or Claude Code

`cli/publish-artifact/publish.py` (Python 3.10+, stdlib only, plus `curl`) publishes a file or folder, manages versions, folders and share links, and captures a thumbnail with a local headless browser. The same folder is a [Claude Code skill](cli/publish-artifact/SKILL.md): copy or symlink it into `~/.claude/skills/`.

```bash
export ARTIFACT_HUB_URL=https://admin.example.com      # or BLAZZ_ARTIFACTS_URL
python3 cli/publish-artifact/publish.py ./mockups --visibility link --link-hours 48 --memory-storage
```

The API token is read from `ARTIFACT_HUB_TOKEN` (or `BLAZZ_ARTIFACTS_TOKEN`), else from the macOS Keychain (service `artifact-hub`, account `api-token`). See [docs/publishing.md](docs/publishing.md).

## Documentation

- [Architecture](docs/architecture.md): components, data model, API
- [Security](docs/security.md): sandbox, signed paths, grants, epochs, folders, visit privacy
- [Configuration](docs/configuration.md)
- [Deployment](docs/deployment.md): reverse proxy, Tailscale, backups and restore
- [Publishing](docs/publishing.md): CLI, Claude Code skill, API token
- [Development](docs/development.md)
- [Design notes](docs/design/)

## Development

```bash
cd app
npm ci
npm run dev        # API + content + admin UI with hot reload, demo data, http://localhost:5173
npm test && npm run typecheck && npm run build:web
python3 -m unittest discover -s ../cli/publish-artifact
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md).

## Licence

[MIT](LICENSE). The bundled Figtree font is under the SIL Open Font License 1.1 ([app/src/fonts/OFL.txt](app/src/fonts/OFL.txt)).
