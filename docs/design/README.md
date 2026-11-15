# Design notes

The original design documents, translated and condensed. The mechanisms themselves are described in
[../architecture.md](../architecture.md) and [../security.md](../security.md); these notes keep the goals,
the decisions and their reasons.

- [01 — Core hub](01-core.md): publishing, isolation of untrusted content, access model, versions, thumbnails, statistics.
- [02 — Shareable folders](02-shareable-folders.md): folders as shareable pages with combined access rules.
- [03 — Sub-folders](03-sub-folders.md): folder trees with inherited access, flat URLs and a filtered breadcrumb.
- [04 — Trash](04-trash.md): deleted artifacts restorable for 30 days, gone for visitors at once.
- [05 — Bulk actions](05-bulk-actions.md): select artifacts and move, tag, change visibility, pin or trash them at once.
- [06 — Link previews](06-link-previews.md): Open Graph cards for link-preview services, never for people or scripts.
- [07 — Full-text search](07-full-text-search.md): search artifacts by their content with SQLite FTS5, snippets in the gallery.
- [08 — Command palette](08-command-palette.md): `Ctrl/Cmd+K` to reach an artifact, a folder or an action.
- [09 — Sub-folder order](09-sub-folder-order.md): order sub-folders in the folder panel, like its artifacts.
