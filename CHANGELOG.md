# Changelog

## Unreleased

- Visitor bar: artifacts open under a slim top bar (folder path when opened from a folder, title, version, Original
  download for Markdown, JSON and PDF, Open alone); folder pages get the same bar with the theme switch. The artifact
  is framed on its signed path; scripts, link previews and `ARTIFACT_BAR=0` keep the direct redirect.
- Command palette: `Ctrl/Cmd+K` finds an artifact (title, tags, folder or content), a folder or an action
  (publish, new folder, trash, view, language, shortcuts, sign out) and opens it with Enter.
- Sub-folders can be ordered in the folder panel's "Order" tab (drag, or Move then arrows), like its artifacts; the
  order applies in the gallery and on the visitor page.
- Full-text search: the gallery search also finds artifacts by their content (Markdown, JSON, HTML pages, every page
  of a ZIP site), ignoring accents and case, and shows where the words matched. SQLite FTS5, no new dependency;
  existing artifacts are indexed at startup.
- Link previews: public artifacts, active share links and publicly reachable folders show a card (title, excerpt,
  thumbnail) when pasted into Slack, Teams, iMessage, WhatsApp, Discord or LinkedIn. People, scripts and search
  engines get the usual responses; `LINK_PREVIEWS=0` turns it off.
- Development: `npm run dev` restarts the API and content servers when the server code changes (Vite stays up), so
  the hot-reloaded admin UI never calls an older API. The gallery also loads when only the trash fails to load.
- Bulk actions: select artifacts (check on hover, “Select” in the card menu, `X`, `Ctrl/Cmd+A`) and move, tag,
  change the visibility, pin or trash them in one all-or-nothing request (`POST /api/artifacts/bulk`). Moving into a
  shared folder and making artifacts public ask one confirmation; a bulk trash has one undo for the whole batch.
- Restoring from the trash puts an artifact back in its folder even when the trash had emptied that folder; a folder
  deleted meanwhile still sends it back without a folder.
- Trash: deleting an artifact moves it to the trash for 30 days (`TRASH_DAYS`), with an undo; it is gone for
  visitors at once and keeps its address until it is restored or purged. `/trash` lists, restores and empties.
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
