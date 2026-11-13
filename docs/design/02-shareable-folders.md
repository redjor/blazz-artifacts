# 02 — Shareable folders

## Decisions

- **The project becomes the folder.** No new concept: an existing folder label gets a shareable page. An artifact belongs to
  at most one folder.
- **Folder access opens its whole content.** Whoever can see the folder can open every artifact in it at the time of the
  visit, whatever the artifact's own visibility. Removing an artifact from the folder cuts that access.

## What a visitor sees

- `https://<content-host>/d/<folder>`, the folder name being already a normalised label (`[a-z0-9-]`, 32 characters max).
- A server-rendered page **without JavaScript** (same script-less sandbox as Markdown readers): title, short description,
  artifact count, a grid of cards (thumbnail or kind pictogram, title, kind, relative date, version), the admin's order or
  newest first, a pure-CSS light/dark toggle.
- A card goes through `/d/<folder>/a/<slug>`: folder access check, membership check, then the artifact's usual signed path.
  Artifacts are shown as they are, without extra chrome (they stay isolated in their opaque origin).

## Access modes

Same four modes as artifacts, with parallel rules: `private` (default, 404 like a missing folder), `code` (unlock form,
same attempt limits), `link` (share links of the folder), `public`. A dedicated signed cookie (`__Host-fgrant_<folder>`,
own derived key, 12 h max capped by the link), and a folder access epoch bumped by visibility or code changes and
"Cut all access". Folder links reuse the share-link table and screens.

Accepted limit, as for artifacts: a signed path already issued stays valid up to one hour after a folder revocation or the
removal of an artifact; new openings are refused immediately.

## Combined access rule

A visitor may open an artifact if **either**:

1. the artifact's own access allows it (unchanged rules), or
2. they enter through `/d/<folder>/a/<slug>`, the artifact belongs to that folder **now**, and folder access is valid.

Folder access never changes the artifact itself: `/a/<slug>` of a private artifact stays 404.

## Thumbnails on folder pages

Served by the content server **only** through `/d/<folder>/thumb/<artifactId>/<versionId>`, with folder access (or a
page-issued signature tied to the folder epoch) and current membership. Outside folders, the content server never serves a
thumbnail.

## Data

A `projects` table (name, title, description, visibility, code hash, access epoch, timestamps), created on the fly when a
folder is described, shared or explicitly created; a folder without a row is private. `artifacts.project_position` for the
order. `share_links` targets exactly one of an artifact or a folder. Renaming a folder moves its row, links and stats, and
breaks the old `/d/` URL (the UI warns). Deleting a folder sheet never deletes artifacts.

## Admin safeguards

Sharing a folder that contains private artifacts, or moving a non-public artifact into a shared folder, asks for an
explicit confirmation stating how many artifacts become visible. Cards show a folder indicator when their folder is shared.

## Statistics

Folder page views follow the artifact rules; opening an artifact from a folder counts as a view of that artifact (the signed
redirect never counts); folder links count their openings.

## Out of scope

Sub-folders, an artifact in several folders, downloading a folder as a ZIP, visitor comments.
