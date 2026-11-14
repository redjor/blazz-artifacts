# 03 — Sub-folders

Extends [02 — Shareable folders](02-shareable-folders.md), which listed sub-folders as out of scope.

## Goal

Share a tree: a visitor who can see a folder can browse its sub-folders and open their artifacts. Sorting folders in the
admin comes with it.

## Decisions

- **A folder may have one parent folder.** Stored as `projects.parent_name`. Depth is limited to **4 levels** (a root
  folder is level 1).
- **Access is always inherited.** Access to a folder opens its whole sub-tree. A sub-folder can still be shared on its own
  with its own settings. There is no way for a sub-folder to opt out of inheritance.
- **URLs stay flat:** `/d/<folder>` whatever the depth. Folder names stay unique across the hub. Moving a folder in the
  tree never breaks its URL or its share links, and `/d/<folder>/a/<slug>` stays unambiguous.
- **Deleting a folder moves its direct sub-folders up** to its own parent (or to the root). Artifacts are never deleted,
  as before.

## Access rule

**Effective access** to folder F: at least one folder in the chain {F, parent of F, …, root} passes the existing
`hasFolderAccess` check, each with its own grant cookie and its own access epoch. At most 4 folders are checked.

- Making a parent private, changing its code or using "Cut all access" on it cuts the inherited access of the whole
  sub-tree. Access granted by the sub-folder itself stays valid.
- A `private` sub-folder under a shared parent is visible through the parent, as a private artifact is visible through a
  shared folder.
- `/d/<F>/a/<slug>` requires the artifact to be **directly** in F. An artifact of a grandchild is reached through the
  grandchild's URL; the parent URL returns 404 for it.
- Moving a folder out of a shared parent, or deleting that parent, removes the inherited access immediately for new
  openings. The accepted limit of 02 still applies: a signed path already issued stays valid up to one hour.

### Combined rule for artifacts

The combined rule of 02 becomes: a visitor may open an artifact if **either**

1. the artifact's own access allows it, or
2. they enter through `/d/<F>/a/<slug>`, the artifact belongs to F **now**, and the visitor has **effective** access to F.

### Thumbnails

The folder page signs thumbnail URLs with the **granting folder** (the folder of the chain whose access was used): its
name, salt and access epoch, plus the displayed folder. On every request the content server re-checks that the granting
folder is still not private, that the displayed folder still descends from it (or is it), and that the artifact is still
directly in the displayed folder.

## What a visitor sees

### Folder page `/d/<F>`

- Same page as 02: title, description, counts, grid.
- **Direct sub-folders come before artifacts**, in their own section.
- Sub-folder card: folder pictogram, title, short description, counts ("N artifacts · M sub-folders"), last update date.
  Links to `/d/<child>`. Every child is shown, since access is always inherited. An empty sub-folder is shown with an
  "Empty" mention.
- Sub-folder order: the admin's order (`projects.position`), then title.
- Counts are direct only, never recursive.

### Breadcrumb

- Shown at the top of folder pages, server-rendered HTML and CSS, no JavaScript.
- It **starts at the highest ancestor the visitor has effective access to**. An ancestor without effective access never
  appears: its name and title do not leak. Example: a visitor who entered through a link to `lot-3`, without access to
  `client-a`, sees only `lot-3`.
- The last item is the current folder and is not a link.
- Artifact pages are unchanged: no chrome, opaque origin.

### Unlock page

A visitor without access to `/d/<child>` gets the unlock form of the requested folder only. The page never offers the
parent's code, which would reveal the parent.

## Admin

### API

- `POST /projects` accepts an optional `parent`.
- `PATCH /projects/:name` accepts `parent` (`null` = root). Moving a folder uses this route.
- A `parent` is refused with a distinct 400 error when: it does not exist, it is the folder itself, it is a descendant of
  the folder (cycle), or the moved sub-tree would go deeper than 4 levels.
- `GET /projects` returns `parent` and `childCount` for each folder; the client builds the tree. No new listing route.
- `PUT /projects/:name/order` keeps ordering artifacts. A new `PUT /projects/:name/children-order` orders direct
  sub-folders (`projects.position`).
- `DELETE /projects/:name` moves direct children to the deleted folder's parent in the same transaction and returns how
  many were moved.

### Dashboard

- Root: top-level folders only, then artifacts without a folder.
- Inside a folder: admin breadcrumb (every ancestor, no access filtering), sub-folder cards, then artifacts.
- The `#project=<name>` hash is unchanged; the name is unique.
- "New folder" creates the folder inside the current folder by default.
- "Move to…" in the folder panel opens a tree picker that excludes the folder itself and its descendants. No drag and drop
  in v1.
- The artifact folder picker shows the tree, indented.
- An admin UI to order sub-folders is deferred: the API route `PUT /projects/:name/children-order` exists, but without
  a UI sub-folders show in title order.

### Safeguards

Extends the confirmations of 02:

- Moving a folder under a shared parent states how many sub-folders and artifacts become visible through that parent.
- Sharing a folder that has descendants counts the whole sub-tree in the confirmation.
- Moving a folder out of a shared parent warns that inherited access is cut for that parent's visitors.
- Deleting states "N sub-folders move up into <parent>".
- Renaming keeps the existing warning about the broken `/d/` URL; children follow through `ON UPDATE CASCADE`.
- Cards show "shared via <ancestor>" when access comes from a parent.

### CLI

Unchanged: `--project <name>` targets a unique name. A folder created on the fly by the CLI goes to the root.

## Statistics

Unchanged tables. A view of `/d/<F>` counts for F only, even when access comes from an ancestor. Opening a sub-folder from
its parent's page does not count as a view of the parent. No recursive totals in v1.

## Data and migration

In `migrateFolders` (`app/src/db.ts`), idempotent like the existing steps:

- `ALTER TABLE projects ADD COLUMN parent_name TEXT REFERENCES projects(name) ON UPDATE CASCADE` when missing (SQLite
  accepts a foreign key on `ADD COLUMN` with a NULL default).
- `ALTER TABLE projects ADD COLUMN position INTEGER` when missing.
- `CREATE INDEX IF NOT EXISTS projects_parent ON projects(parent_name)`.
- No `ON DELETE` action: `deleteProject` moves children up inside its transaction; the foreign key is a safety net.
  `PRAGMA foreign_keys = ON` is already set when the database opens.

An existing database has every folder at the root, so its behaviour is unchanged.

A folder without a `projects` row (02: "created on the fly") has no parent. Giving it a parent or children creates its
row first.

## Code layout

- `app/src/folder-tree.ts` (new, no HTTP dependency): `ancestors(db, name)`, `children(db, name)`,
  `subtreeHeight(db, name)`, `canReparent(db, name, parent)` returning `ok`, `missing`, `self`, `cycle` or `depth`.
- `app/src/content/folder-grant.ts`: `effectiveFolderAccess(db, project, grants, nowS)` walks the chain and returns the
  granting folder or `null`. Used by folder pages, folder artifact redirects, thumbnails and the breadcrumb.
- `app/src/repo.ts`: `parent_name` and `position` in create, update, rename and delete.
- Folder page rendering: sub-folder section and filtered breadcrumb.
- `app/web/src`: dashboard tree navigation, "Move to…" picker, indented folder picker, new confirmations.

## Tests

- `folder-tree.test.ts`: self-parent, cycle, depth 4 accepted and 5 refused, moving a sub-tree that would become too
  deep, rename with children (cascade).
- `folders.test.ts`: inherited access for public, code and link; parent made private cuts the sub-tree; parent epoch
  bump; child moved out of the parent loses access; `/d/<parent>/a/<slug>` of a grandchild artifact is 404; breadcrumb
  hides an ancestor without access; unlock page never mentions the parent; thumbnail refused after a move.
- `folders-admin.test.ts`: 400 errors on `PATCH parent`, children moved up on delete, sub-tree counts in confirmations.
- `folders-db.test.ts`: migration of an existing database.

## Out of scope

Drag and drop of folders, recursive statistics and counts, downloading a sub-tree as a ZIP, sub-folders that opt out of
inheritance, a `--parent` CLI option, nested URLs, ordering sub-folders in the admin UI.
