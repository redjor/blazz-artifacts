# Changelog

## Unreleased

- Sub-folders: folders can be nested up to 4 levels; access to a folder opens its sub-folders.
- Admin URLs are real paths (`/f/<folder>`, `/unfiled`, `?a=<id>`) and the browser's Back button returns to the
  previous folder or closes the artifact panel. Old `#project=…&a=…` links are redirected.
- Moving a non-public artifact into a shared folder asks for confirmation from every path, including the artifact
  panel's folder field and folders shared through a parent.
- The gallery shows an error with a retry when it cannot load, instead of an empty hub; the artifact panel does the
  same for its links and history.
- Language, sign-out and the `?` shortcuts are available on every page, not only at the root.
- Screen readers hear each artifact card's visibility and the number of search or filter results; sign-in and publish
  errors are announced.

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
