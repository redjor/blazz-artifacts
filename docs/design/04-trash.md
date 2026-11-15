# 04 — Trash

## Goal

Deleting an artifact is permanent today: one `confirm`, then the row, its versions, links, statistics and files are gone.
The trash turns a deletion into a reversible step for 30 days, so a wrong click or a hasty clean-up costs nothing.

## Decisions

- **Artifacts only.** Folders are not trashed: an empty folder only holds a title, a description and links, and a
  folder with artifacts cannot be deleted. Deleting artifacts one by one (or in bulk later) is what the trash protects.
- **Trashed means gone for visitors, at once.** A trashed artifact answers like a deleted one everywhere on the content
  server: `/a/<slug>`, share links, folder pages, thumbnails. Its access epoch is bumped when it is trashed, so signed
  paths already handed out stop working immediately instead of within the hour.
- **Restore puts it back as it was.** Same slug, folder, visibility, code, tags, pin, versions, statistics and share
  links that have not expired. Restoring is a deliberate act of the owner, so links that worked before the deletion
  work again. A folder that only existed through its artifacts (no sheet) and that the trash emptied comes back with
  them; a folder deleted meanwhile has detached its trashed artifacts, which come back without a folder.
- **The slug stays reserved** while the artifact is in the trash, since restoring must not break its URL. Publishing to
  that slug answers `409 slug_in_trash` ("this address belongs to an artifact in the trash: restore it or delete it
  for good").
- **30 days, then purged.** `TRASH_DAYS` (default 30) sets the delay; `0` restores the old behaviour (immediate
  deletion, no trash). The purge runs at startup and every hour with the existing maintenance tasks.
- **No confirmation on delete.** The confirmation is replaced by an undo: "“Title” moved to the trash · Undo". Permanent
  deletion (from the trash) keeps a confirmation.

## What a visitor sees

Nothing new: a trashed artifact is a 404 like any missing one. A folder page lists only live artifacts, and its counts
and mosaic ignore the trash.

## Admin

### API

- `DELETE /artifacts/:id` moves to the trash (sets `deleted_at`, bumps the epoch) and answers `{ ok, trashed: true }`;
  the UI keeps the id to undo. With `TRASH_DAYS=0`, deletes for good as before (`trashed: false`).
- `POST /artifacts/:id/restore` brings it back. If its folder was deleted meanwhile, it is restored without a folder.
- `GET /trash` answers `{ days, items }`: `TRASH_DAYS`, and the trashed artifacts, newest deletion first, with
  `deletedAt` and `purgeAt`.
- `DELETE /trash/:id` deletes one for good; `DELETE /trash` empties the trash.
- Every other route ignores trashed artifacts: `GET /artifacts` (and `?slug=`), tags and their counts, folder
  summaries (count, private count, latest activity, mosaic), folder detail.

### Dashboard

- Route `/trash`, reached from a "Trash (n)" link at the bottom of the root page (hidden when the trash is empty).
- Rows: kind icon, title, folder, "Deleted 3 days ago · deleted for good on Dec 14". Actions: Restore, Delete for good.
  Header action: Empty the trash (confirmation with the count).
- Deleting from the artifact panel shows the undo toast (Undo, or Ctrl/Cmd+Z outside a text field); Undo calls
  restore and puts focus back on the card. Without a trash (`days` 0), the old confirmation stays.

### CLI

Unchanged. Updating a slug that is in the trash fails with the `slug_in_trash` message.

## Data and migration

- `artifacts.deleted_at TEXT NULL` (ISO date), indexed. Added in place like the previous migrations.
- Reads go through a `live_artifacts` view (`WHERE deleted_at IS NULL`); only the trash functions in `repo.ts` read the
  `artifacts` table directly. This keeps a forgotten filter from leaking a trashed artifact to a visitor.
- The purge deletes rows whose `deleted_at` is older than `TRASH_DAYS`, then their files (`removeArtifactFiles`), as
  the current delete does. Cascades remove versions, links, tags and statistics.
- Deleting a folder sheet that no live artifact keeps alive sets `project` to null on its trashed artifacts, so that a
  restore never brings a deleted folder back.

## Tests

- Content: a trashed artifact is a 404 on `/a/<slug>`, its share links and its signed paths (epoch bumped); it is absent
  from folder pages, counts and thumbnails.
- Admin: trash, list, restore (folder kept, or none when the folder is gone), purge after `TRASH_DAYS`, empty,
  `slug_in_trash` on create and on CLI-style update, `TRASH_DAYS=0` deletes at once.
- Every admin list and count excludes trashed artifacts.

## Out of scope

Trashing folders, a trash for versions (version retention is unchanged), restoring a purged artifact, per-artifact
retention.
