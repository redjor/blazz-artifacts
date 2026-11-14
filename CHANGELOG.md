# Changelog

## Unreleased

- Sub-folders: folders can be nested up to 4 levels; access to a folder opens its sub-folders.

## 0.1.0 — initial public release

- Publish HTML pages, Markdown (GFM, highlighting, sanitised), PDF, JSON and ZIP sites; drag and drop or CLI.
- Two servers, two origins: admin (React SPA, strict CSP) and content (CSP sandbox, signed paths, CORS for opaque origins).
- Visibility per artifact: private, secret code, share link (revocable, expiring, counted), public; "Cut all access".
- Versions with stable URLs, preview and restore; retention (Markdown/HTML forever, other kinds 10 most recent).
- Folders: shareable script-free folder pages with their own access mode, links, ordering, description, preview and stats.
- Gallery: thumbnails captured at publish time, kind filters, tags, search, pinning, grid or list, keyboard shortcuts.
- Privacy-friendly audience statistics (no script, no cookie, no IP or User-Agent stored).
- Simulated `localStorage`/`sessionStorage` for mockups.
- API token for automation; publish CLI (Python stdlib + curl) that is also a Claude Code skill.
- English and French: admin UI (saved preference or browser language), visitor pages (`HUB_LOCALE=en|fr|auto`),
  stable API error codes with localised messages.
- Docker image (Node 24, read-only, non-root), generic and Tailscale compose examples, Caddy example, backup script.
