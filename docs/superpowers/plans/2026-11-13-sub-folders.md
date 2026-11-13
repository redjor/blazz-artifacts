# Sub-folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a folder have a parent folder, with access always inherited down the tree, flat `/d/<folder>` URLs, a filtered
breadcrumb on visitor pages and tree navigation in the admin.

**Architecture:** One nullable `projects.parent_name` column (foreign key, `ON UPDATE CASCADE`) plus `projects.position`
for sibling order. A new pure module `app/src/folder-tree.ts` answers tree questions (ancestors, children, depth, move
checks). The content server replaces its single-folder access check with a walk up the chain that returns the *granting
folder*; thumbnails, breadcrumb and artifact entry use it. The admin API gains a `parent` field; the React admin builds the
tree client side from `GET /api/projects` with a pure helper module `app/web/src/folderTree.ts`.

**Tech Stack:** Node ≥ 22.18 running TypeScript directly, Hono, `node:sqlite`, `node --test`, React 19 + Vite + Tailwind 4.

**Spec:** `docs/design/03-sub-folders.md` (read it first; also `docs/design/02-shareable-folders.md`).

## Global Constraints

- Maximum depth: **4 levels** (a root folder is level 1). Constant `MAX_FOLDER_DEPTH = 4`, server and client.
- URLs stay flat: `/d/<folder>`; folder names stay unique hub-wide (`[a-z0-9-]`, 32 chars max, existing `PROJECT_RE`).
- Access is always inherited: effective access to F = any folder of {F, parent, …, root} passes `hasFolderAccess`.
- `/d/<F>/a/<slug>` requires `artifact.project === F` exactly.
- A breadcrumb on visitor pages never shows an ancestor the visitor has no effective access to.
- The unlock page of a folder never mentions its parent.
- Deleting a folder sheet moves its direct children to its own parent (or root). Artifacts are never deleted.
- Visitor pages stay script-less (CSP sandbox without `allow-scripts`). Every interpolated string goes through `escapeHtml`.
- Statistics tables are unchanged; a view of `/d/<F>` counts for F only.
- Admin UI strings exist in both `app/web/src/i18n/en.ts` and `fr.ts` (test `i18n-web.test.ts` enforces equal key sets);
  visitor strings in both locales of `app/src/i18n.ts`.
- Code comments and docs in English. Existing tests are written in French; new test names may be French or English, keep
  one language per file.
- `tx()` in `app/src/db.ts` is **not** re-entrant (`BEGIN IMMEDIATE`): never call a function that opens `tx` from inside
  another `tx`.

All commands run from `app/`:
- One file: `node --test --test-concurrency=1 test/<file>.test.ts`
- Everything: `npm test && npm run typecheck && npm run build:web`

---

## File map

| File | Change |
|---|---|
| `app/src/db.ts` | `migrateFolders`: add `parent_name`, `position`, index |
| `app/src/repo.ts` | `Project` gains `parent_name`, `position`; `listFolders` returns `parent`, `position`; `deleteProject` re-parents children |
| `app/src/folder-tree.ts` | **new**: `MAX_FOLDER_DEPTH`, `ancestors`, `children`, `subtreeHeight`, `folderLevel`, `canReparent`, `setParent`, `setChildrenOrder` |
| `app/src/content/folder-grant.ts` | `effectiveFolderAccess`; thumbnail signature bound to granting folder + displayed folder |
| `app/src/content/server.ts` | folder routes use effective access; thumbnails `g=`; renderFolder passes sub-folders and breadcrumb |
| `app/src/content/folder-page.ts` | sub-folder section, breadcrumb, folder glyph |
| `app/src/i18n.ts` | visitor strings for sub-folders and breadcrumb |
| `app/src/admin/api.ts` | `parent` on POST/PATCH, tree fields on GET, children re-parenting count on DELETE, `children-order` route |
| `app/web/src/types.ts`, `api.ts` | new fields and calls |
| `app/web/src/folderTree.ts` | **new**, pure: tree helpers for the UI |
| `app/web/src/FolderBreadcrumb.tsx` | **new**: admin breadcrumb |
| `app/web/src/Dashboard.tsx`, `NewFolderDialog.tsx`, `FolderCard.tsx`, `FolderPanel.tsx`, `Labels.tsx` | tree UI |
| `app/web/src/i18n/en.ts`, `fr.ts` | admin strings |
| tests | `folders-db.test.ts`, new `folder-tree.test.ts`, new `sub-folders.test.ts`, `folders-admin.test.ts`, new `folder-tree-web.test.ts` |
| `docs/architecture.md`, `docs/security.md`, `CHANGELOG.md` | describe sub-folders |

---

### Task 1: Schema, migration and repo fields

**Files:**
- Modify: `app/src/db.ts` (inside `migrateFolders`, right after the `salt` column block, ~line 119)
- Modify: `app/src/repo.ts` (`Project` ~line 140, `deleteProject` ~line 189, `FolderSummary`/`listFolders` ~line 218)
- Modify: `app/src/admin/api.ts:450-451` (`folderSheet` default object must satisfy the new `Project` type)
- Test: `app/test/folders-db.test.ts`

**Interfaces:**
- Produces: `Project.parent_name: string | null`, `Project.position: number | null`;
  `FolderSummary.parent: string | null`, `FolderSummary.position: number | null`;
  `deleteProject(db, name): boolean` now moves direct children to the deleted sheet's parent in its own transaction (do not
  call it inside `tx`).

- [ ] **Step 1: Write the failing tests** (append to `app/test/folders-db.test.ts`; `openDb`, `upsertProject`, `getProject`,
  `deleteProject`, `renameProject`, `listFolders` are already imported there)

```ts
test('sub-folders: parent_name and position columns, rename cascades to children', () => {
  const db = openDb(':memory:');
  const cols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('parent_name'));
  assert.ok(cols.includes('position'));
  upsertProject(db, 'client', {});
  upsertProject(db, 'lot', {});
  db.prepare('UPDATE projects SET parent_name = ? WHERE name = ?').run('client', 'lot');
  db.exec('BEGIN');
  renameProject(db, 'client', 'acme');
  db.exec('COMMIT');
  assert.equal(getProject(db, 'lot')!.parent_name, 'acme');
  assert.equal(listFolders(db).find((f) => f.name === 'lot')!.parent, 'acme');
});

test('sub-folders: deleting a sheet moves its children to its own parent', () => {
  const db = openDb(':memory:');
  for (const n of ['a', 'b', 'c', 'd']) upsertProject(db, n, {});
  db.prepare('UPDATE projects SET parent_name = ? WHERE name = ?').run('a', 'b');
  db.prepare('UPDATE projects SET parent_name = ?, position = 3 WHERE name = ?').run('b', 'c');
  db.prepare('UPDATE projects SET parent_name = ? WHERE name = ?').run('b', 'd');
  assert.equal(deleteProject(db, 'b'), true);
  assert.equal(getProject(db, 'c')!.parent_name, 'a');
  assert.equal(getProject(db, 'c')!.position, null);
  assert.equal(getProject(db, 'd')!.parent_name, 'a');
  assert.equal(deleteProject(db, 'a'), true);
  assert.equal(getProject(db, 'c')!.parent_name, null);
});
```

Also extend the existing production-schema migration test in this file (the one built on `prodDb()` / `PROD_SCHEMA`):
after the database is opened with `openDb`, add

```ts
const cols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name);
assert.ok(cols.includes('parent_name') && cols.includes('position'));
assert.ok(listFolders(db).every((f) => f.parent === null));
```

(use the variable that holds the migrated `Db` in that test).

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --test-concurrency=1 test/folders-db.test.ts`
Expected: FAIL (`parent_name` missing from `table_info`).

- [ ] **Step 3: Migration** — in `app/src/db.ts`, after
  `if (!projectCols.some((c) => c.name === 'salt')) db.exec('ALTER TABLE projects ADD COLUMN salt TEXT');` add:

```ts
    // Sub-folders (design 03): one optional parent, sibling order. A foreign key on ADD COLUMN is allowed with a NULL
    // default; ON UPDATE CASCADE makes children follow a rename. No ON DELETE: deleteProject re-parents children first.
    if (!projectCols.some((c) => c.name === 'parent_name')) db.exec('ALTER TABLE projects ADD COLUMN parent_name TEXT REFERENCES projects(name) ON UPDATE CASCADE');
    if (!projectCols.some((c) => c.name === 'position')) db.exec('ALTER TABLE projects ADD COLUMN position INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS projects_parent ON projects(parent_name)');
```

- [ ] **Step 4: Repo** — in `app/src/repo.ts`:

`Project` interface, add after `salt: string;`:

```ts
  /** Parent folder (design 03); null: at the root. */
  parent_name: string | null;
  /** Order among siblings (admin-chosen); null: not placed. */
  position: number | null;
```

Replace `deleteProject`:

```ts
/**
 * Deletes the sheet (and so its folder links and statistics); artifacts stay in their project. Direct sub-folders move
 * to the deleted sheet's parent (or the root) first. Opens its own transaction.
 */
export function deleteProject(db: Db, name: string): boolean {
  return tx(db, () => {
    const sheet = getProject(db, name);
    if (!sheet) return false;
    db.prepare('UPDATE projects SET parent_name = ?, position = NULL, updated_at = ? WHERE parent_name = ?').run(sheet.parent_name, nowIso(), name);
    return Number(db.prepare('DELETE FROM projects WHERE name = ?').run(name).changes) > 0;
  });
}
```

`FolderSummary`: add `parent: string | null; position: number | null;`. In `listFolders`, select
`p.parent_name AS parent, p.position AS position` and map them:
`parent: (r.parent as string | null) ?? null, position: r.position === null || r.position === undefined ? null : Number(r.position),`;
the `name: null` entry gets `parent: null, position: null`.

- [ ] **Step 5: Keep the type check green** — `app/src/admin/api.ts:451`, add `parent_name: null, position: null` to the
  default object in `folderSheet`. Then run `npm run typecheck` and fix any other object literal typed `Project` the same way.

- [ ] **Step 6: Run tests**

Run: `node --test --test-concurrency=1 test/folders-db.test.ts && npm run typecheck`
Expected: PASS. Then `npm test` (whole suite) PASS: the API `DELETE /projects/:name` route calls `deleteProject` outside any
`tx`, so the new inner transaction is safe; if a test calls it inside `tx`, it fails with "cannot start a transaction
within a transaction" — fix the caller, not `deleteProject`.

- [ ] **Step 7: Commit**

```bash
git add app/src/db.ts app/src/repo.ts app/src/admin/api.ts app/test/folders-db.test.ts
git commit -m "feat(folders): parent and position columns for sub-folders"
```

---

### Task 2: Tree module

**Files:**
- Create: `app/src/folder-tree.ts`
- Test: `app/test/folder-tree.test.ts`

**Interfaces:**
- Consumes: `Project`, `getProject`, `upsertProject`, `projectExists` from `repo.ts`.
- Produces (exact):
  - `MAX_FOLDER_DEPTH = 4`
  - `ancestors(db: Db, name: string): Project[]` — nearest first, without the folder itself
  - `children(db: Db, name: string): Project[]` — direct sub-folders, sibling order
  - `folderLevel(db: Db, name: string): number` — 1 for a root folder
  - `subtreeHeight(db: Db, name: string): number` — 1 for a folder without children
  - `type ReparentCheck = 'ok' | 'missing' | 'self' | 'cycle' | 'depth'`
  - `canReparent(db: Db, name: string, parent: string | null): ReparentCheck`
  - `setParent(db: Db, name: string, parent: string | null): void` — creates the sheets if needed; call inside `tx` after `canReparent`
  - `setChildrenOrder(db: Db, parent: string, names: string[]): boolean` — exact set of direct children or false

- [ ] **Step 1: Write the failing tests** — create `app/test/folder-tree.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, tx } from '../src/db.ts';
import { ancestors, canReparent, children, folderLevel, MAX_FOLDER_DEPTH, setChildrenOrder, setParent, subtreeHeight } from '../src/folder-tree.ts';
import { getProject, renameProject, upsertProject } from '../src/repo.ts';

/** a > b > c > d (4 levels), e at the root. */
function tree() {
  const db = openDb(':memory:');
  for (const n of ['a', 'b', 'c', 'd', 'e']) upsertProject(db, n, {});
  setParent(db, 'b', 'a');
  setParent(db, 'c', 'b');
  setParent(db, 'd', 'c');
  return db;
}

test('ancestors nearest first, levels and heights', () => {
  const db = tree();
  assert.deepEqual(ancestors(db, 'd').map((p) => p.name), ['c', 'b', 'a']);
  assert.deepEqual(ancestors(db, 'a'), []);
  assert.equal(folderLevel(db, 'd'), 4);
  assert.equal(subtreeHeight(db, 'a'), 4);
  assert.equal(subtreeHeight(db, 'd'), 1);
  assert.equal(subtreeHeight(db, 'sans-fiche'), 1);
  assert.equal(MAX_FOLDER_DEPTH, 4);
});

test('canReparent: self, missing, cycle, depth, ok', () => {
  const db = tree();
  assert.equal(canReparent(db, 'a', 'a'), 'self');
  assert.equal(canReparent(db, 'a', 'nope'), 'missing');
  assert.equal(canReparent(db, 'a', 'd'), 'cycle');
  assert.equal(canReparent(db, 'b', 'c'), 'cycle');
  assert.equal(canReparent(db, 'e', 'd'), 'depth');   // e would be level 5
  assert.equal(canReparent(db, 'e', 'c'), 'ok');      // level 4
  assert.equal(canReparent(db, 'b', 'e'), 'ok');      // b's sub-tree (3 levels) under e (level 1) → 4 levels
  assert.equal(canReparent(db, 'c', 'e'), 'ok');      // c, d under e → levels 2, 3
  assert.equal(canReparent(db, 'd', null), 'ok');
});

test('setParent creates sheets, children follow a rename, sibling order', () => {
  const db = tree();
  setParent(db, 'nouveau', 'a');
  assert.equal(getProject(db, 'nouveau')!.parent_name, 'a');
  assert.deepEqual(children(db, 'a').map((p) => p.name), ['b', 'nouveau']);
  assert.equal(setChildrenOrder(db, 'a', ['nouveau', 'b']), true);
  assert.deepEqual(children(db, 'a').map((p) => p.name), ['nouveau', 'b']);
  assert.equal(setChildrenOrder(db, 'a', ['b']), false);
  assert.equal(setChildrenOrder(db, 'a', ['b', 'b']), false);
  tx(db, () => renameProject(db, 'a', 'z'));
  assert.deepEqual(children(db, 'z').map((p) => p.name), ['nouveau', 'b']);
  setParent(db, 'b', null);
  assert.equal(getProject(db, 'b')!.parent_name, null);
  assert.equal(getProject(db, 'b')!.position, null);
});

test('ancestors stops on a corrupt cycle', () => {
  const db = tree();
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE projects SET parent_name = ? WHERE name = ?').run('d', 'a');
  assert.ok(ancestors(db, 'd').length <= MAX_FOLDER_DEPTH);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test --test-concurrency=1 test/folder-tree.test.ts`
Expected: FAIL, module `../src/folder-tree.ts` not found.

- [ ] **Step 3: Implement** — create `app/src/folder-tree.ts`:

```ts
// Folder tree (design 03): one optional parent per sheet, depth limited to MAX_FOLDER_DEPTH levels.
// Pure database helpers, no HTTP. Walks are bounded so a corrupt cycle can never loop.
import { tx, type Db } from './db.ts';
import { getProject, projectExists, upsertProject, type Project } from './repo.ts';

export const MAX_FOLDER_DEPTH = 4;

const nowIso = () => new Date().toISOString();

/** Ancestors of `name`, nearest first, without `name` itself. */
export function ancestors(db: Db, name: string): Project[] {
  const out: Project[] = [];
  const seen = new Set([name]);
  let next = getProject(db, name)?.parent_name ?? null;
  while (next && !seen.has(next) && out.length < MAX_FOLDER_DEPTH) {
    const p = getProject(db, next);
    if (!p) break;
    out.push(p);
    seen.add(next);
    next = p.parent_name;
  }
  return out;
}

/** Direct sub-folders: admin order first, then title (or name). */
export function children(db: Db, name: string): Project[] {
  return db
    .prepare(`SELECT * FROM projects WHERE parent_name = ?
      ORDER BY position IS NULL, position, lower(COALESCE(NULLIF(trim(title), ''), name)), name`)
    .all(name) as unknown as Project[];
}

/** 1 for a root folder. */
export function folderLevel(db: Db, name: string): number {
  return ancestors(db, name).length + 1;
}

/** Number of levels of the sub-tree rooted at `name` (1 without children). */
export function subtreeHeight(db: Db, name: string, guard = MAX_FOLDER_DEPTH + 1): number {
  if (guard <= 1) return 1;
  let max = 0;
  for (const c of children(db, name)) max = Math.max(max, subtreeHeight(db, c.name, guard - 1));
  return 1 + max;
}

export type ReparentCheck = 'ok' | 'missing' | 'self' | 'cycle' | 'depth';

/** Whether `name` may move under `parent` (null: the root). */
export function canReparent(db: Db, name: string, parent: string | null): ReparentCheck {
  if (parent === null) return 'ok';
  if (parent === name) return 'self';
  if (!projectExists(db, parent)) return 'missing';
  if (ancestors(db, parent).some((p) => p.name === name)) return 'cycle';
  if (folderLevel(db, parent) + subtreeHeight(db, name) > MAX_FOLDER_DEPTH) return 'depth';
  return 'ok';
}

/** Moves `name` under `parent`; creates missing sheets (private). Call inside `tx`, after `canReparent`. */
export function setParent(db: Db, name: string, parent: string | null): void {
  if (parent !== null) upsertProject(db, parent, {});
  upsertProject(db, name, {});
  db.prepare('UPDATE projects SET parent_name = ?, position = NULL, updated_at = ? WHERE name = ?').run(parent, nowIso(), name);
}

/** Sibling order: `names` must be exactly the direct children of `parent` (otherwise false, nothing changes). */
export function setChildrenOrder(db: Db, parent: string, names: string[]): boolean {
  return tx(db, () => {
    const current = new Set(children(db, parent).map((p) => p.name));
    if (names.length !== current.size || new Set(names).size !== names.length || names.some((n) => !current.has(n))) return false;
    const set = db.prepare('UPDATE projects SET position = ? WHERE name = ?');
    names.forEach((n, i) => set.run(i, n));
    return true;
  });
}
```

Note: `setParent` is called outside `tx` in the test (fine: each statement auto-commits). In the API it is called inside `tx`
— it never opens one itself.

- [ ] **Step 4: Run tests**

Run: `node --test --test-concurrency=1 test/folder-tree.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/folder-tree.ts app/test/folder-tree.test.ts
git commit -m "feat(folders): folder tree helpers with depth and cycle checks"
```

---

### Task 3: Inherited access on the content server

**Files:**
- Modify: `app/src/content/folder-grant.ts` (add `effectiveFolderAccess` after `hasFolderAccess`)
- Modify: `app/src/content/server.ts:188-260` (folder section)
- Test: create `app/test/sub-folders.test.ts`

**Interfaces:**
- Consumes: `ancestors`, `setParent` (Task 2); `hasFolderAccess`, `decodeFolderGrant`, `folderCookieName`.
- Produces: `effectiveFolderAccess(db: Db, chain: Project[], grantOf: (name: string) => FolderGrantClaims | null, nowS: number): Project | null`
  — `chain` is the folder then its ancestors, nearest first; returns the **highest** (root-side) folder that grants access,
  or null. In `server.ts`, `folderAccess(c, project)` now returns `Project | null` (the granting folder) and a local
  `chainOf(p: Project): Project[]` exists.

- [ ] **Step 1: Write the failing tests** — create `app/test/sub-folders.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFolderGrant, folderCookieName } from '../src/content/folder-grant.ts';
import { hashSecret } from '../src/crypto.ts';
import { setParent } from '../src/folder-tree.ts';
import { bumpProjectEpoch, getProject, upsertProject } from '../src/repo.ts';
import { seedArtifact, setup, type Harness } from './harness.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const PAGE = { 'index.html': '<p>x</p>' };

const get = (h: Harness, path: string, cookie = '') =>
  h.content.request(path, { headers: { 'user-agent': UA, 'x-forwarded-for': '203.0.113.9', ...(cookie ? { cookie } : {}) } });

/** Valid code grant for `name` (what /unlock-folder sets). */
function grant(h: Harness, name: string): string {
  const p = getProject(h.db, name)!;
  const value = encodeFolderGrant(h.keys.folderGrant, { p: name, s: p.salt, e: p.access_epoch, l: null, x: Math.floor(h.clock.now() / 1000) + 600 });
  return `${folderCookieName(name)}=${value}`;
}

/** client (code "acme-2026") > lot (private) > detail (private); one private artifact in each. */
async function tree() {
  const h = await setup();
  for (const [slug, project] of [['art-client', 'client'], ['art-lot', 'lot'], ['art-detail', 'detail']] as const) {
    await seedArtifact(h, { slug, visibility: 'private', project, files: PAGE, kind: 'html', title: slug });
  }
  upsertProject(h.db, 'client', { visibility: 'code', code_hash: await hashSecret('acme-2026'), title: 'Client Acme' });
  setParent(h.db, 'lot', 'client');
  setParent(h.db, 'detail', 'lot');
  return h;
}

test('parent access opens the whole sub-tree', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  assert.equal((await get(h, '/d/lot')).status, 404);
  assert.equal((await get(h, '/d/lot', c)).status, 200);
  assert.equal((await get(h, '/d/detail', c)).status, 200);
  assert.equal((await get(h, '/d/detail/a/art-detail', c)).status, 302);
});

test('folder entry only for direct members', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  assert.equal((await get(h, '/d/client/a/art-lot', c)).status, 404);
  assert.equal((await get(h, '/d/lot/a/art-detail', c)).status, 404);
  assert.equal((await get(h, '/d/lot/a/art-lot', c)).status, 302);
});

test('cutting the parent cuts the sub-tree, own access survives', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  bumpProjectEpoch(h.db, 'client');
  assert.equal((await get(h, '/d/lot', c)).status, 404);
  upsertProject(h.db, 'detail', { visibility: 'public' });
  upsertProject(h.db, 'client', { visibility: 'private', code_hash: null }, true);
  assert.equal((await get(h, '/d/lot')).status, 404);
  assert.equal((await get(h, '/d/detail')).status, 200, 'own public access');
});

test('moving a folder out of its parent removes inherited access', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  setParent(h.db, 'lot', null);
  assert.equal((await get(h, '/d/lot', c)).status, 404);
  assert.equal((await get(h, '/d/detail', c)).status, 404);
});

test('unlock page of a sub-folder never mentions its parent', async () => {
  const h = await tree();
  upsertProject(h.db, 'lot', { visibility: 'code', code_hash: await hashSecret('lot-code'), title: 'Lot 3' });
  const res = await get(h, '/d/lot');
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.ok(!html.includes('client') && !html.includes('Client Acme'));
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test --test-concurrency=1 test/sub-folders.test.ts`
Expected: FAIL — `/d/lot` with the parent cookie answers 404 (no inheritance yet). The unlock test may already pass.

- [ ] **Step 3: `effectiveFolderAccess`** — in `app/src/content/folder-grant.ts`, after `hasFolderAccess`:

```ts
/**
 * Inherited folder access (design 03). `chain`: the folder then its ancestors, nearest first. Returns the highest
 * (root-side) folder whose own access is valid for this visitor, or null. Each folder is checked with its own grant.
 */
export function effectiveFolderAccess(
  db: Db, chain: Project[], grantOf: (name: string) => FolderGrantClaims | null, nowS: number,
): Project | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (hasFolderAccess(db, chain[i], grantOf(chain[i].name), nowS)) return chain[i];
  }
  return null;
}
```

- [ ] **Step 4: Use it in `server.ts`** — import `effectiveFolderAccess` (folder-grant) and `ancestors`, `children`
  (`../folder-tree.ts`). Replace the `folderAccess` constant (~line 190):

```ts
  const chainOf = (p: Project): Project[] => [p, ...ancestors(db, p.name)];
  /** Granting folder (the folder itself or an ancestor), or null. */
  const folderAccess = (c: Context, project: Project | undefined): Project | null =>
    project
      ? effectiveFolderAccess(db, chainOf(project), (n) => decodeFolderGrant(keys.folderGrant, getCookie(c, folderCookieName(n))), nowS())
      : null;
```

Existing call sites use it as a boolean (`if (!folderAccess(...))`, `|| folderAccess(c, project)`) and keep working.
`denyFolder` is unchanged: it shows the requested folder's own form only.

- [ ] **Step 5: Run tests**

Run: `node --test --test-concurrency=1 test/sub-folders.test.ts test/folders.test.ts && npm run typecheck`
Expected: PASS (existing folder tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add app/src/content/folder-grant.ts app/src/content/server.ts app/test/sub-folders.test.ts
git commit -m "feat(folders): inherited folder access on the content server"
```

---

### Task 4: Thumbnails bound to the granting folder

**Files:**
- Modify: `app/src/content/folder-grant.ts:53-71` (`thumbPayload`, `signFolderThumb`, `checkFolderThumb`)
- Modify: `app/src/content/server.ts` (`folderPage`, `renderFolder`, thumbnail route)
- Test: `app/test/sub-folders.test.ts`

**Interfaces:**
- Consumes: `folderAccess` returning `Project | null`, `chainOf` (Task 3).
- Produces:
  - `signFolderThumb(key: Buffer, granting: Project, folder: string, artifactId: string, versionId: string, nowS: number): string`
  - `checkFolderThumb(key: Buffer, granting: Project, folder: string, artifactId: string, versionId: string, sig: string | undefined, nowS: number): boolean`
  - `renderFolder(p: Project, preview: string | null, locale: Locale, granting: Project | null): string` in `server.ts`
  - Thumbnail URL: `/d/<folder>/thumb/<artifactId>/<versionId>?s=<sig>` when granting is the folder itself,
    `?g=<granting>&s=<sig>` otherwise.

- [ ] **Step 1: Write the failing test** — append to `app/test/sub-folders.test.ts` (add imports: `mkdir`, `writeFile` from
  `node:fs/promises`; `getArtifactBySlug`, `setVersionThumb` from `../src/repo.ts`; `thumbPath`, `thumbsDir` from `../src/storage.ts`):

```ts
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('sub-folder thumbnails: signed by the granting ancestor, refused after a move', async () => {
  const h = await tree();
  const art = getArtifactBySlug(h.db, 'art-detail')!;
  const v = art.current_version_id!;
  await mkdir(thumbsDir(h.cfg.dataDir, art.id), { recursive: true });
  await writeFile(thumbPath(h.cfg.dataDir, art.id, v, 'png'), PNG);
  setVersionThumb(h.db, v, 'png');
  const html = await (await get(h, '/d/detail', grant(h, 'client'))).text();
  const m = /src="(\/d\/detail\/thumb\/[^"]+)"/.exec(html);
  assert.ok(m, 'thumbnail URL on the page');
  const url = m[1].replaceAll('&amp;', '&');
  assert.match(url, /[?&]g=client&s=/);
  assert.equal((await get(h, url)).status, 200, 'signed URL works without cookie');
  assert.equal((await get(h, url.replace('g=client', 'g=lot'))).status, 404, 'wrong granting folder');
  setParent(h.db, 'lot', null);
  assert.equal((await get(h, url)).status, 404, 'no longer under the granting folder');
});
```

Check the exact signatures of `thumbsDir`, `thumbPath` and `setVersionThumb` against their use in
`app/test/folders.test.ts` (search `setVersionThumb(`) and copy that call shape if it differs.

- [ ] **Step 2: Run to see it fail**

Run: `node --test --test-concurrency=1 test/sub-folders.test.ts`
Expected: FAIL (no `g=` in the URL).

- [ ] **Step 3: Signature** — in `folder-grant.ts` replace the thumbnail block:

```ts
// Thumbnail URL issued by the folder page (the sandboxed document has an opaque origin: its image requests carry no
// SameSite cookies). Bound to the granting folder (the page's folder or the ancestor that opened it, design 03), its
// epoch and the displayed folder; expires in 1 h. Membership, descent and visibility are re-checked on every request.
export const FOLDER_THUMB_TTL_S = 3600;
const thumbPayload = (g: Pick<Project, 'name' | 'salt' | 'access_epoch'>, folder: string, artifactId: string, versionId: string, exp: number) =>
  `thumb|${g.name}|${g.salt}|${g.access_epoch}|${folder}|${artifactId}|${versionId}|${exp}`;

export function signFolderThumb(key: Buffer, granting: Project, folder: string, artifactId: string, versionId: string, nowS: number): string {
  const exp = nowS + FOLDER_THUMB_TTL_S;
  return `${exp}.${hmac(key, thumbPayload(granting, folder, artifactId, versionId, exp))}`;
}

export function checkFolderThumb(
  key: Buffer, granting: Project, folder: string, artifactId: string, versionId: string, sig: string | undefined, nowS: number,
): boolean {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(sig ?? '');
  if (!m) return false;
  const exp = Number(m[1]);
  if (!granting.salt || !safeEqual(m[2], hmac(key, thumbPayload(granting, folder, artifactId, versionId, exp)))) return false;
  return exp > nowS && granting.visibility !== 'private';
}
```

- [ ] **Step 4: Server** — in `server.ts`:

`folderPage`: replace the last three lines with

```ts
    const project = folderOf(name);
    const granting = folderAccess(c, project);
    if (!granting) return denyFolder(c, project);
    if (isHumanNavigation(c)) visits.folderView(project!.name, clientIp(c), c.req.header('user-agent') ?? '', nowMs());
    return c.html(renderFolder(project!, null, loc(c), granting));
```

and the preview branch calls `renderFolder(sheet, previewSig, loc(c), null)`.

`renderFolder(p, preview, locale, granting: Project | null)`: build the thumbnail query with

```ts
      const g = granting ?? p;
      const thumbQuery = preview
        ? `p=${preview}`
        : `${g.name === p.name ? '' : `g=${g.name}&`}s=${signFolderThumb(keys.folderThumb, g, p.name, a.id, v.id, now)}`;
```

Thumbnail route: replace the `allowed` computation with

```ts
    const g = c.req.query('g');
    const granting = g === undefined ? project : chainOf(project).find((x) => x.name === g);
    const allowed =
      checkFolderPreview(keys.folderPreview, project, c.req.query('p'), nowS()) ||
      (!!granting && checkFolderThumb(keys.folderThumb, granting, project.name, artifactId, versionId, c.req.query('s'), nowS())) ||
      !!folderAccess(c, project);
```

`chainOf(project).find` re-checks that the granting folder is still the folder or one of its ancestors.

- [ ] **Step 5: Run tests**

Run: `node --test --test-concurrency=1 test/sub-folders.test.ts test/folders.test.ts test/thumbs.test.ts && npm run typecheck`
Expected: PASS. If an existing test calls `signFolderThumb`/`checkFolderThumb` with the old signature, update it to pass
`(key, project, project.name, …)`.

- [ ] **Step 6: Commit**

```bash
git add app/src/content/folder-grant.ts app/src/content/server.ts app/test/sub-folders.test.ts
git commit -m "feat(folders): sub-folder thumbnails signed by the granting folder"
```

---

### Task 5: Visitor page — sub-folder cards and breadcrumb

**Files:**
- Modify: `app/src/content/folder-page.ts` (`FolderPageInput`, new `folderCard`, `crumbs`, CSS, `renderFolderPage`)
- Modify: `app/src/content/server.ts` (`renderFolder`)
- Modify: `app/src/i18n.ts` (en and fr)
- Test: `app/test/sub-folders.test.ts`

**Interfaces:**
- Consumes: `children`, `chainOf`, granting folder (Tasks 2–4).
- Produces:
  - `interface FolderSubCard { href: string | null; title: string; description: string | null; count: number; childCount: number; updatedAt: string }`
  - `FolderPageInput.folders: FolderSubCard[]`, `FolderPageInput.breadcrumb: { href: string; title: string }[]` (root side
    first, current folder excluded)

- [ ] **Step 1: Write the failing tests** — append to `app/test/sub-folders.test.ts`:

```ts
test('folder page lists direct sub-folders before artifacts', async () => {
  const h = await tree();
  upsertProject(h.db, 'lot', { title: 'Lot <3>', description: 'Livraison' });
  upsertProject(h.db, 'vide', {});
  setParent(h.db, 'vide', 'client');
  const html = await (await get(h, '/d/client', grant(h, 'client'))).text();
  assert.match(html, /href="\/d\/lot"/);
  assert.match(html, /Lot &lt;3&gt;/);
  assert.match(html, /href="\/d\/vide"/);
  assert.ok(!html.includes('href="/d/detail"'), 'grandchild not listed on the root page');
  assert.ok(html.indexOf('href="/d/lot"') < html.indexOf('href="/d/client/a/art-client"'), 'folders first');
  assert.doesNotMatch(html, /<script/i);
});

test('breadcrumb starts at the highest accessible ancestor', async () => {
  const h = await tree();
  const full = await (await get(h, '/d/detail', grant(h, 'client'))).text();
  assert.match(full, /<nav class="crumbs"[^>]*>.*href="\/d\/client".*href="\/d\/lot"/s);
  upsertProject(h.db, 'lot', { visibility: 'code', code_hash: await hashSecret('lot-code') });
  const partial = await (await get(h, '/d/detail', grant(h, 'lot'))).text();
  assert.match(partial, /href="\/d\/lot"/);
  assert.ok(!partial.includes('/d/client') && !partial.includes('Client Acme'), 'inaccessible ancestor hidden');
  const own = await (async () => {
    upsertProject(h.db, 'detail', { visibility: 'public' });
    return (await get(h, '/d/detail')).text();
  })();
  assert.doesNotMatch(own, /class="crumbs"/, 'no breadcrumb without accessible ancestor');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test --test-concurrency=1 test/sub-folders.test.ts`
Expected: FAIL (no `href="/d/lot"`).

- [ ] **Step 3: i18n** — in `app/src/i18n.ts`, add to `en` next to the `folder.*` keys:

```ts
  'folder.folders': 'Folders',
  'folder.subCount.one': '{n} folder',
  'folder.subCount.other': '{n} folders',
  'folder.emptyChild': 'Empty',
  'folder.breadcrumb': 'Folder path',
```

and to `fr`:

```ts
  'folder.folders': 'Dossiers',
  'folder.subCount.one': '{n} dossier',
  'folder.subCount.other': '{n} dossiers',
  'folder.emptyChild': 'Vide',
  'folder.breadcrumb': 'Chemin du dossier',
```

- [ ] **Step 4: Page** — in `app/src/content/folder-page.ts`:

Add the types next to `FolderCard`:

```ts
/** Direct sub-folder card (design 03). `href: null` in the admin preview (other folders are not previewable from here). */
export interface FolderSubCard { href: string | null; title: string; description: string | null; count: number; childCount: number; updatedAt: string }
```

Extend `FolderPageInput` with `folders: FolderSubCard[]; breadcrumb: { href: string; title: string }[];`.

Add a folder glyph next to `SUN`:

```ts
const FOLDER = '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>';
```

Add the renderers after `card`:

```ts
function folderCard(f: FolderSubCard, nowMs: number, locale: Locale): string {
  const counts = f.count + f.childCount === 0
    ? tr(locale, 'folder.emptyChild')
    : [f.childCount ? tr(locale, 'folder.subCount', { n: f.childCount }) : '', f.count ? tr(locale, 'folder.count', { n: f.count }) : '']
        .filter(Boolean).join(' · ');
  const desc = f.description?.trim() ? `<span class="sub">${typography(locale, escapeHtml(f.description.trim()))}</span>` : '';
  const inner = `<span class="frame k-folder">${svg(FOLDER, 64, 'glyph')}</span>
<span class="name">${typography(locale, escapeHtml(f.title))}</span>${desc}
<span class="meta"><span>${counts}</span><span><time datetime="${escapeHtml(f.updatedAt)}">${folderRelativeDate(f.updatedAt, nowMs, locale)}</time></span></span>`;
  return f.href
    ? `<li><a class="card" href="${escapeHtml(f.href)}">${inner}</a></li>`
    : `<li><span class="card">${inner}</span></li>`;
}

function crumbs(items: { href: string; title: string }[], current: string, locale: Locale): string {
  if (items.length === 0) return '';
  const links = items.map((i) => `<a href="${escapeHtml(i.href)}">${escapeHtml(i.title)}</a>`).join('<span aria-hidden="true">/</span>');
  return `<nav class="crumbs" aria-label="${tr(locale, 'folder.breadcrumb')}">${links}<span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(current)}</span></nav>`;
}
```

Check how `tr` pluralises (`folder.count` is called with `{ n }` and resolves `.one`/`.other`); use the same call shape for
`folder.subCount`.

In `renderFolderPage`:
- `const body`: empty only when `n === 0 && o.folders.length === 0`; otherwise
  ```ts
  const folders = o.folders.length
    ? `<section aria-label="${tr(locale, 'folder.folders')}"><ul class="grid folders" role="list">${o.folders.map((f) => folderCard(f, o.nowMs, locale)).join('\n')}</ul></section>`
    : '';
  const arts = n ? `<ul class="grid" role="list">${o.cards.map((c) => card(c, o.nowMs, locale)).join('\n')}</ul>` : '';
  const body = n === 0 && o.folders.length === 0 ? `<p class="empty">${tr(locale, 'folder.empty')}</p>` : folders + arts;
  ```
- Insert `${crumbs(o.breadcrumb, title, locale)}` as the first child of `<header class="head">`.
- CSS (append inside `CSS`, matching the existing tokens; reuse the colour variable used by `.count`):
  ```css
  .crumbs{display:flex;flex-wrap:wrap;gap:6px;font-size:14px;margin:0 0 12px;color:var(--muted)}
  .crumbs a{color:inherit}
  .crumbs [aria-current]{color:var(--fg)}
  .grid.folders{margin-bottom:44px}
  .sub{display:block;font-size:14px;color:var(--muted)}
  ```
  Open the existing `CSS` constant first and replace `--muted`/`--fg` with the variable names it actually defines; add a
  `.k-folder` band rule copied from an existing `.k-*` rule with a neutral tint.

- [ ] **Step 5: Server** — in `renderFolder`, before `return renderFolderPage(...)`:

```ts
    const folders = children(db, p.name).map((ch) => ({
      href: preview ? null : `/d/${ch.name}`,
      title: ch.title?.trim() || ch.name,
      description: ch.description,
      count: listFolderArtifacts(db, ch.name).length,
      childCount: children(db, ch.name).length,
      updatedAt: ch.updated_at,
    }));
    // Ancestors from the granting folder down to the parent; nothing above it (design 03: no leak).
    const chain = chainOf(p);
    const top = granting ? chain.findIndex((x) => x.name === granting.name) : 0;
    const breadcrumb = preview ? [] : chain.slice(1, top + 1).reverse().map((a) => ({ href: `/d/${a.name}`, title: a.title?.trim() || a.name }));
```

and pass `folders, breadcrumb` to `renderFolderPage`. Update every other `renderFolderPage(` caller to pass `folders: [], breadcrumb: []`: the `input` object in
`app/test/locale.test.ts` (~line 70).

- [ ] **Step 6: Run tests**

Run: `node --test --test-concurrency=1 test/sub-folders.test.ts test/folders.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/content/folder-page.ts app/src/content/server.ts app/src/i18n.ts app/test/sub-folders.test.ts
git commit -m "feat(folders): sub-folder cards and filtered breadcrumb on folder pages"
```

---

### Task 6: Admin API

**Files:**
- Modify: `app/src/admin/api.ts` (`folderDto` ~463, `GET /projects` ~486, `POST /projects` ~503, `PATCH` ~527, `DELETE` ~624, new route)
- Test: `app/test/folders-admin.test.ts`

**Interfaces:**
- Consumes: `ancestors`, `children`, `canReparent`, `setParent`, `setChildrenOrder` (Task 2); `deleteProject` (Task 1).
- Produces (JSON):
  - `GET /api/projects` items gain `parent: string | null`, `position: number | null`, `childCount: number`.
  - `GET /api/projects/:name` (`folderDto`) gains `parent: string | null`, `ancestors: { name: string; title: string | null }[]`
    (root first), `children: { name: string; title: string | null; visibility: Visibility; count: number }[]`.
  - `POST /api/projects` body accepts `parent?: string | null`.
  - `PATCH /api/projects/:name` body accepts `parent?: string | null`.
  - Errors 400: `invalid_parent`, `parent_missing`, `parent_self`, `parent_cycle`, `parent_depth`.
  - `DELETE /api/projects/:name` → `{ ok: true, movedChildren: number }`.
  - `PUT /api/projects/:name/children-order` body `{ names: string[] }` → `folderDto`; 400 `invalid_names`, 409 `folder_changed`.

- [ ] **Step 1: Write the failing tests** — append to `app/test/folders-admin.test.ts`:

```ts
test('sub-folders API: create under a parent, move, refuse cycles and depth', async () => {
  const h = await adminSetup();
  assert.equal((await h.call('POST', '/projects', { name: 'lot', parent: 'client' })).status, 201);
  let r = await h.call('GET', '/projects/client');
  assert.deepEqual(r.body.children.map((c: { name: string }) => c.name), ['lot']);
  r = await h.call('GET', '/projects/lot');
  assert.equal(r.body.parent, 'client');
  assert.deepEqual(r.body.ancestors, [{ name: 'client', title: null }]);
  const list = (await h.call('GET', '/projects')).body as { name: string; parent: string | null; childCount: number }[];
  assert.equal(list.find((f) => f.name === 'lot')!.parent, 'client');
  assert.equal(list.find((f) => f.name === 'client')!.childCount, 1);

  assert.equal((await h.call('PATCH', '/projects/client', { parent: 'lot' })).body.code, 'parent_cycle');
  assert.equal((await h.call('PATCH', '/projects/client', { parent: 'client' })).body.code, 'parent_self');
  assert.equal((await h.call('PATCH', '/projects/client', { parent: 'nope' })).body.code, 'parent_missing');
  assert.equal((await h.call('PATCH', '/projects/client', { parent: 'Not Valid!' })).status, 400);
  for (const [n, p] of [['l3', 'lot'], ['l4', 'l3']]) assert.equal((await h.call('POST', '/projects', { name: n, parent: p })).status, 201);
  const deep = await h.call('POST', '/projects', { name: 'l5', parent: 'l4' });
  assert.equal(deep.status, 400);
  assert.equal(deep.body.code, 'parent_depth');
  assert.equal(getProject(h.db, 'l5'), undefined, 'nothing created on error');

  r = await h.call('PATCH', '/projects/lot', { parent: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.parent, null);
});

test('sub-folders API: delete moves children up, children order', async () => {
  const h = await adminSetup();
  await h.call('POST', '/projects', { name: 'lot', parent: 'client' });
  await h.call('POST', '/projects', { name: 'a1', parent: 'lot' });
  await h.call('POST', '/projects', { name: 'a2', parent: 'lot' });
  const order = await h.call('PUT', '/projects/lot/children-order', { names: ['a2', 'a1'] });
  assert.deepEqual(order.body.children.map((c: { name: string }) => c.name), ['a2', 'a1']);
  assert.equal((await h.call('PUT', '/projects/lot/children-order', { names: ['a1'] })).status, 409);
  assert.equal((await h.call('PUT', '/projects/lot/children-order', { names: 'a1' })).status, 400);
  const del = await h.call('DELETE', '/projects/lot');
  assert.deepEqual(del.body, { ok: true, movedChildren: 2 });
  assert.equal(getProject(h.db, 'a1')!.parent_name, 'client');
});
```

API errors are `{ code, error, params? }` (`errorBody` in `app/src/http.ts`): tests read `body.code`.

- [ ] **Step 2: Run to see it fail**

Run: `node --test --test-concurrency=1 test/folders-admin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `app/src/admin/api.ts`, import from `../folder-tree.ts`:
  `ancestors, canReparent, children, setChildrenOrder, setParent` (and `type ErrorCode` from `../errors.ts` if not imported yet). Add near `mustFolder`:

```ts
  /** `parent` field: undefined (absent), null (root) or a valid folder name. */
  const parseParent = (v: unknown): string | null | undefined => {
    if (v === undefined || v === null) return v;
    if (typeof v !== 'string' || !isFolderName(v)) throw new HttpError(400, 'invalid_parent');
    return v;
  };
  /** Moves `name` under `parent` after the tree checks. Call inside tx. */
  const reparent = (name: string, parent: string | null) => {
    const check = canReparent(db, name, parent);
    if (check !== 'ok') throw new HttpError(400, `parent_${check}` as ErrorCode);
    setParent(db, name, parent);
  };
```

`folderDto`: add

```ts
      parent: p.parent_name ?? null,
      ancestors: ancestors(db, name).reverse().map((a) => ({ name: a.name, title: a.title })),
      children: children(db, name).map((ch) => ({ name: ch.name, title: ch.title, visibility: ch.visibility, count: listFolderArtifacts(db, ch.name).length })),
```

`GET /projects`: in the returned object add `childCount: f.name === null ? 0 : children(db, f.name).length,` (`parent` and
`position` already come from `listFolders`).

`POST /projects`: `const parent = parseParent(body.parent);` before the `tx`; inside the `tx`, after `upsertProject(db, name, patch);`
add `if (parent) reparent(name, parent);`.

`PATCH /projects/:name`: `const parent = parseParent(body.parent);` with the other parsing; inside the `tx`, after the
`upsertProject` line, add `if (parent !== undefined) reparent(target, parent);`. The `onlyRename` check already treats a
body with `parent` as not rename-only, so the sheet is created.

`DELETE /projects/:name`:

```ts
  // Deletes the sheet (folder links and statistics included); artifacts stay in their project; direct sub-folders move up.
  api.delete('/projects/:name', (c) => {
    const name = c.req.param('name');
    if (!isFolderName(name)) throw new HttpError(404, 'folder_not_found');
    const movedChildren = children(db, name).length;
    if (!deleteProject(db, name)) throw new HttpError(404, 'folder_not_found');
    return c.json({ ok: true, movedChildren });
  });
```

New route after `PUT /projects/:name/order`:

```ts
  api.put('/projects/:name/children-order', async (c) => {
    const name = mustFolder(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { names?: unknown };
    if (!Array.isArray(body.names) || body.names.some((n) => typeof n !== 'string')) throw new HttpError(400, 'invalid_names');
    if (!setChildrenOrder(db, name, body.names as string[])) throw new HttpError(409, 'folder_changed');
    return c.json(folderDto(name));
  });
```

New error codes (mandatory: `HttpError` only accepts keys of `ERRORS` in `app/src/errors.ts`, and `i18n-web.test.ts` checks
every code has a translation): add `invalid_parent`, `parent_missing`, `parent_self`, `parent_cycle`, `parent_depth`, `invalid_names` there and their messages in
`web/src/i18n/en.ts` and `fr.ts` following the existing pattern (en: "Unknown parent folder", "A folder cannot contain
itself", "A folder cannot move into one of its sub-folders", "Folders are limited to 4 levels", "Invalid folder parent",
"Invalid folder list"; fr: "Dossier parent inconnu", "Un dossier ne peut pas se contenir lui-même", "Un dossier ne peut pas
aller dans l’un de ses sous-dossiers", "Les dossiers sont limités à 4 niveaux", "Dossier parent invalide", "Liste de dossiers invalide").

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/admin/api.ts app/src/errors.ts app/web/src/i18n app/test/folders-admin.test.ts
git commit -m "feat(folders): parent field, children order and re-parenting delete in the admin API"
```

---

### Task 7: Client tree helpers, types and API calls

**Files:**
- Create: `app/web/src/folderTree.ts`
- Modify: `app/web/src/types.ts` (`FolderSummary`, `FolderDetail`), `app/web/src/api.ts`
- Test: create `app/test/folder-tree-web.test.ts`

**Interfaces:**
- Consumes: JSON fields from Task 6.
- Produces (exact):
  - `MAX_FOLDER_DEPTH = 4`
  - `interface TreeFolder { name: string; parent: string | null; title: string | null; visibility: Visibility; count: number; privateCount: number; position: number | null }`
  - `childrenOf(folders: TreeFolder[], parent: string | null): TreeFolder[]`
  - `ancestorsOf(folders: TreeFolder[], name: string): TreeFolder[]` — root first
  - `descendantsOf(folders: TreeFolder[], name: string): TreeFolder[]`
  - `subtreeExposure(folders: TreeFolder[], name: string): { folders: number; artifacts: number; privateArtifacts: number }` — descendants' folders; artifacts of the folder and its descendants
  - `sharedVia(folders: TreeFolder[], name: string): TreeFolder | null` — highest non-private ancestor
  - `treeOptions(folders: TreeFolder[]): { folder: TreeFolder; depth: number }[]` — depth-first, depth 0 for roots
  - `moveTargets(folders: TreeFolder[], name: string): { folder: TreeFolder | null; depth: number }[]` — `null` = root first, then every allowed parent in tree order
  - `folderPath(folders: TreeFolder[], name: string): string` — titles (or names) joined with ` / `
  - `api.createFolder(body: { name: string; title?: string; description?: string; parent?: string | null })`,
    `api.updateFolder(name, patch)` accepts `parent?: string | null`, `api.orderFolderChildren(name: string, names: string[])`,
    `api.deleteFolder(name)` returns `{ ok: true; movedChildren: number }`

- [ ] **Step 1: Write the failing tests** — create `app/test/folder-tree-web.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ancestorsOf, childrenOf, descendantsOf, folderPath, moveTargets, sharedVia, subtreeExposure, treeOptions, type TreeFolder } from '../web/src/folderTree.ts';

const f = (name: string, parent: string | null, o: Partial<TreeFolder> = {}): TreeFolder =>
  ({ name, parent, title: null, visibility: 'private', count: 0, privateCount: 0, position: null, ...o });

// a > b > c > d ; a > b2 ; e
const FOLDERS = [
  f('a', null, { visibility: 'link', count: 1 }), f('b', 'a', { count: 2, privateCount: 1, title: 'Bravo' }), f('c', 'b', { count: 3, privateCount: 3 }),
  f('d', 'c'), f('b2', 'a', { position: 0 }), f('e', null),
];

test('tree navigation', () => {
  assert.deepEqual(childrenOf(FOLDERS, null).map((x) => x.name), ['a', 'e']);
  assert.deepEqual(childrenOf(FOLDERS, 'a').map((x) => x.name), ['b2', 'b'], 'position first, then title');
  assert.deepEqual(ancestorsOf(FOLDERS, 'd').map((x) => x.name), ['a', 'b', 'c']);
  assert.deepEqual(descendantsOf(FOLDERS, 'b').map((x) => x.name).sort(), ['c', 'd']);
  assert.equal(folderPath(FOLDERS, 'c'), 'a / Bravo / c');
  assert.deepEqual(treeOptions(FOLDERS).map((o) => `${o.depth}:${o.folder.name}`), ['0:a', '1:b2', '1:b', '2:c', '3:d', '0:e']);
});

test('exposure and shared-via', () => {
  assert.deepEqual(subtreeExposure(FOLDERS, 'b'), { folders: 2, artifacts: 5, privateArtifacts: 4 });
  assert.equal(sharedVia(FOLDERS, 'd')!.name, 'a');
  assert.equal(sharedVia(FOLDERS, 'e'), null);
  assert.equal(sharedVia(FOLDERS, 'a'), null, 'own visibility is not "via"');
});

test('move targets exclude self, descendants and too-deep parents', () => {
  const names = (n: string) => moveTargets(FOLDERS, n).map((o) => o.folder?.name ?? '(root)');
  assert.deepEqual(names('b'), ['(root)', 'a', 'e'], 'b has 3 levels: only level-1 parents fit');
  assert.deepEqual(names('e'), ['(root)', 'a', 'b2', 'b', 'c']);
  assert.ok(!names('e').includes('d'), 'level 4 cannot take children');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test --test-concurrency=1 test/folder-tree-web.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — create `app/web/src/folderTree.ts`:

```ts
// Folder tree helpers for the admin UI (design 03). Pure functions over GET /api/projects; the server re-checks every move.
import type { Visibility } from './types.ts';

export const MAX_FOLDER_DEPTH = 4;

export interface TreeFolder {
  name: string; parent: string | null; title: string | null; visibility: Visibility;
  count: number; privateCount: number; position: number | null;
}

const label = (x: TreeFolder) => (x.title?.trim() || x.name);
const bySibling = (x: TreeFolder, y: TreeFolder) =>
  (x.position === null ? 1 : 0) - (y.position === null ? 1 : 0) ||
  (x.position ?? 0) - (y.position ?? 0) ||
  label(x).localeCompare(label(y)) || x.name.localeCompare(y.name);

export function childrenOf(folders: TreeFolder[], parent: string | null): TreeFolder[] {
  return folders.filter((x) => x.parent === parent).sort(bySibling);
}

/** Root first, without the folder itself. Bounded against corrupt cycles. */
export function ancestorsOf(folders: TreeFolder[], name: string): TreeFolder[] {
  const byName = new Map(folders.map((x) => [x.name, x]));
  const out: TreeFolder[] = [];
  let next = byName.get(name)?.parent ?? null;
  while (next && out.length < MAX_FOLDER_DEPTH) {
    const p = byName.get(next);
    if (!p || p.name === name || out.includes(p)) break;
    out.unshift(p);
    next = p.parent;
  }
  return out;
}

export function descendantsOf(folders: TreeFolder[], name: string): TreeFolder[] {
  const out: TreeFolder[] = [];
  const walk = (n: string, depth: number) => {
    if (depth > MAX_FOLDER_DEPTH) return;
    for (const c of childrenOf(folders, n)) { out.push(c); walk(c.name, depth + 1); }
  };
  walk(name, 1);
  return out;
}

const height = (folders: TreeFolder[], name: string): number => {
  const below = descendantsOf(folders, name);
  const level = ancestorsOf(folders, name).length;
  return 1 + below.reduce((m, d) => Math.max(m, ancestorsOf(folders, d.name).length - level), 0);
};

export function subtreeExposure(folders: TreeFolder[], name: string): { folders: number; artifacts: number; privateArtifacts: number } {
  const self = folders.find((x) => x.name === name);
  const all = [...(self ? [self] : []), ...descendantsOf(folders, name)];
  return {
    folders: all.length - (self ? 1 : 0),
    artifacts: all.reduce((s, x) => s + x.count, 0),
    privateArtifacts: all.reduce((s, x) => s + x.privateCount, 0),
  };
}

/** Highest ancestor shared in any way (its access opens this folder); null if none. */
export function sharedVia(folders: TreeFolder[], name: string): TreeFolder | null {
  return ancestorsOf(folders, name).find((a) => a.visibility !== 'private') ?? null;
}

export function treeOptions(folders: TreeFolder[]): { folder: TreeFolder; depth: number }[] {
  const out: { folder: TreeFolder; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    if (depth >= MAX_FOLDER_DEPTH) return;
    for (const c of childrenOf(folders, parent)) { out.push({ folder: c, depth }); walk(c.name, depth + 1); }
  };
  walk(null, 0);
  return out;
}

/** Root (`folder: null`) then every folder `name` may move under. */
export function moveTargets(folders: TreeFolder[], name: string): { folder: TreeFolder | null; depth: number }[] {
  const banned = new Set([name, ...descendantsOf(folders, name).map((d) => d.name)]);
  const h = height(folders, name);
  return [
    { folder: null, depth: 0 },
    ...treeOptions(folders).filter((o) => !banned.has(o.folder.name) && o.depth + 1 + h <= MAX_FOLDER_DEPTH),
  ];
}

export function folderPath(folders: TreeFolder[], name: string): string {
  const self = folders.find((x) => x.name === name);
  return [...ancestorsOf(folders, name), ...(self ? [self] : [])].map(label).join(' / ');
}
```

Check the expected value `['0:a', '1:b2', '1:b', '2:c', '3:d', '0:e']` against `bySibling` (b2 has position 0, b has
none → b2 first). If a test expectation and the spec disagree, the spec wins; fix the test.

- [ ] **Step 4: Types and API** — `app/web/src/types.ts`:
  - `FolderSummary`: add `parent: string | null; position: number | null; childCount: number;`
  - `FolderDetail`: add `parent: string | null; ancestors: { name: string; title: string | null }[]; children: { name: string; title: string | null; visibility: Visibility; count: number }[];`

  `app/web/src/api.ts`:
  - `createFolder: (body: { name: string; title?: string; description?: string; parent?: string | null }) => …`
  - add `parent?: string | null` to the `updateFolder` patch type (line ~82; keep the existing name of that method)
  - `orderFolderChildren: (name: string, names: string[]) => request<FolderDetail>('PUT', \`/projects/${seg(name)}/children-order\`, { names }),`
  - `deleteFolder: (name: string) => request<{ ok: true; movedChildren: number }>('DELETE', \`/projects/${seg(name)}\`),`

- [ ] **Step 5: Run tests**

Run: `node --test --test-concurrency=1 test/folder-tree-web.test.ts && npm run typecheck && npm run build:web`
Expected: PASS. A `NamedFolder` (Dashboard) is a `FolderSummary` with a string name, so it satisfies `TreeFolder`.

- [ ] **Step 6: Commit**

```bash
git add app/web/src/folderTree.ts app/web/src/types.ts app/web/src/api.ts app/test/folder-tree-web.test.ts
git commit -m "feat(web): folder tree helpers and API fields"
```

---

### Task 8: Dashboard tree navigation

**Files:**
- Create: `app/web/src/FolderBreadcrumb.tsx`
- Modify: `app/web/src/Dashboard.tsx` (folder cards ~210-230, header where `currentFolder` is shown, `NewFolderDialog`
  usage ~798, `deleteFolder` ~438), `app/web/src/NewFolderDialog.tsx`, `app/web/src/FolderCard.tsx`, `app/web/src/Labels.tsx`
- Modify: `app/web/src/i18n/en.ts`, `fr.ts`

**Interfaces:**
- Consumes: `childrenOf`, `ancestorsOf`, `folderPath`, `treeOptions` (Task 7); `FolderSummary.childCount`.
- Produces: `FolderBreadcrumb({ trail, onOpen }: { trail: { name: string | null; title: string }[]; onOpen: (name: string | null) => void })`;
  `NewFolderDialog` prop `parent: string | null`.

- [ ] **Step 1: i18n** — add to `en.ts`:

```ts
  'tree.root': 'All',
  'tree.breadcrumb': 'Folder path',
  'tree.subfolders.one': '{n} folder',
  'tree.subfolders.other': '{n} folders',
  'newFolder.inside': 'Created inside “{title}”.',
```

and to `fr.ts`:

```ts
  'tree.root': 'Tout',
  'tree.breadcrumb': 'Chemin du dossier',
  'tree.subfolders.one': '{n} dossier',
  'tree.subfolders.other': '{n} dossiers',
  'newFolder.inside': 'Créé dans « {title} ».',
```

(Check how plural keys are declared in these files: `folder.count` uses `.one`/`.other` and `tn('folder.count', n)`.)

- [ ] **Step 2: Breadcrumb component** — create `app/web/src/FolderBreadcrumb.tsx`:

```tsx
import { t } from './i18n/index.ts';

/** Admin folder path: every ancestor (no access filtering here), the last item is the current folder. */
export function FolderBreadcrumb({ trail, onOpen }: {
  trail: { name: string | null; title: string }[]; onOpen: (name: string | null) => void;
}) {
  return (
    <nav aria-label={t('tree.breadcrumb')} className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
      {trail.map((item, i) => {
        const last = i === trail.length - 1;
        return (
          <span key={item.name ?? '~root'} className="flex items-center gap-1.5">
            {last
              ? <span aria-current="page" className="text-fg">{item.title}</span>
              : <button type="button" className="hover:text-fg" onClick={() => onOpen(item.name)}>{item.title}</button>}
            {!last && <span aria-hidden="true">/</span>}
          </span>
        );
      })}
    </nav>
  );
}
```

Use the colour utility names the project already uses for muted and main text (look at `FolderPanel.tsx`: `text-muted` is
used; check the main text class, e.g. `text-fg` or `text-ink`, and use that).

- [ ] **Step 3: Folder cards per level** — in `Dashboard.tsx` replace the `folderCards` computation (~line 224):

```ts
  // Root: top-level folders (a search lists every matching folder, whatever its level). Inside a folder: its sub-folders.
  const inFolder = project !== null && project !== NONE ? project : null;
  const folderCards = filtersActive ? [] : atRoot
    ? namedFolders.filter((f) => (q ? f.name.includes(q) || !!f.title?.toLowerCase().includes(q) : f.parent === null)).sort(FOLDER_COMPARE[sort])
    : inFolder ? childrenOf(namedFolders, inFolder) : [];
```

Then find where `folderCards` is rendered (search `folderCards.map`); if it is wrapped in an `atRoot &&` condition, drop
that condition so sub-folder cards also render inside a folder, before the artifacts. Keyboard order (`order`) already
starts with `folderCards`, so nothing else changes there.

- [ ] **Step 4: Breadcrumb in the header** — find the header block that shows `currentFolder` (search `currentFolder &&` /
  `FolderVisIcon`). When `currentFolder` is set, render above its title:

```tsx
<FolderBreadcrumb
  trail={[
    { name: null, title: t('tree.root') },
    ...ancestorsOf(namedFolders, currentFolder.name).map((a) => ({ name: a.name, title: a.title ?? a.name })),
    { name: currentFolder.name, title: currentFolder.title ?? currentFolder.name },
  ]}
  onOpen={(name) => setProject(name)}
/>
```

Use the function the dashboard already uses to open a folder (search `setProject(`; it writes the hash). `currentFolder` is
a `FolderSummary` with a non-null name here; narrow it if TypeScript asks.

- [ ] **Step 5: Folder card shows sub-folder count** — in `FolderCard.tsx`, where `tn('folder.count', …)` renders, append
  `{f.childCount > 0 && <> · {tn('tree.subfolders', f.childCount)}</>}` (adapt to how the line is built). The card's "empty"
  state must consider `f.count === 0 && f.childCount === 0`.

- [ ] **Step 6: New folder in the current folder** — `NewFolderDialog.tsx`: add prop `parent: string | null` and
  `parentTitle?: string`; send `...(parent && { parent })` in `api.createFolder`; when `parent` is set and the name is valid
  and free, show `t('newFolder.inside', { title: parentTitle ?? parent })` instead of `t('newFolder.private')`. In
  `Dashboard.tsx` (~798) pass `parent={inFolder}` and `parentTitle={currentFolder?.title ?? undefined}`.

- [ ] **Step 7: Delete keeps its rule, mentions children** — `deleteFolder` (~438) keeps refusing a folder that still has
  artifacts (`folder.emptyFirst`). After `api.deleteFolder`, reload as today; children reappear under the parent on reload.

- [ ] **Step 8: Folder picker shows paths** — `Labels.tsx:15` renders `<datalist>` options from `projects: string[]`. Add an
  optional prop `paths?: Record<string, string>` and render `<option key={p} value={p} label={paths?.[p] ?? p} />`. In
  `Dashboard.tsx`, build `const folderPaths = Object.fromEntries(namedFolders.map((f) => [f.name, folderPath(namedFolders, f.name)]))`
  and order `projectNames` with `treeOptions(namedFolders).map((o) => o.folder.name)` instead of the flat list; pass
  `folderPaths` down to every component that renders `Labels` with folders (follow the `projects={projectNames}` props:
  `PublishDialog`, `ArtifactDrawer` → `ArtifactPanel` → `Labels`).

- [ ] **Step 9: Verify**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: PASS.

Then manual check with the dev server (`npm run dev`, http://localhost:5173, password `blazz-artifacts-dev`):
1. Create folder `parent-demo`, open it, create `child-demo` inside it: the dialog says "Created inside…", the child card
   shows in `parent-demo`, not at the root.
2. Breadcrumb `All / parent-demo / child-demo` navigates back.
3. The root card of `parent-demo` shows "1 folder".
4. Publish dialog folder field suggests `parent-demo / child-demo`.

- [ ] **Step 10: Commit**

```bash
git add app/web/src
git commit -m "feat(web): navigate folders as a tree in the dashboard"
```

---

### Task 9: Folder panel — move, confirmations, shared via

**Files:**
- Modify: `app/web/src/FolderPanel.tsx` (`confirmExposure` line 27, delete confirmation ~373, header/visibility section)
- Modify: `app/web/src/Dashboard.tsx` (pass the folder list to the panel)
- Modify: `app/web/src/i18n/en.ts`, `fr.ts`

**Interfaces:**
- Consumes: `moveTargets`, `subtreeExposure`, `sharedVia`, `folderPath` (Task 7); `api.updateFolder(name, { parent })`, `api.deleteFolder`.
- Produces: `confirmExposure(f, next, tree?: TreeFolder[])`; `FolderPanel` prop `folders: TreeFolder[]`.

- [ ] **Step 1: i18n** — add to `en.ts`:

```ts
  'move.label': 'Move to',
  'move.root': 'Top level',
  'move.confirmIn.one': '“{name}” and its content will be visible to visitors of “{parent}” ({n} artifact). Continue?',
  'move.confirmIn.other': '“{name}” and its content will be visible to visitors of “{parent}” ({n} artifacts). Continue?',
  'move.confirmOut': 'Visitors of “{parent}” will lose access to “{name}”. Continue?',
  'tree.sharedVia': 'Shared through “{title}”',
  'exposure.subtree.one': '\n\nIncludes {n} sub-folder and its content.',
  'exposure.subtree.other': '\n\nIncludes {n} sub-folders and their content.',
  'confirm.deleteChildren.one': '\n\n{n} sub-folder moves up into {target}.',
  'confirm.deleteChildren.other': '\n\n{n} sub-folders move up into {target}.',
```

and to `fr.ts`:

```ts
  'move.label': 'Déplacer vers',
  'move.root': 'Premier niveau',
  'move.confirmIn.one': '« {name} » et son contenu seront visibles des visiteurs de « {parent} » ({n} artéfact). Continuer ?',
  'move.confirmIn.other': '« {name} » et son contenu seront visibles des visiteurs de « {parent} » ({n} artéfacts). Continuer ?',
  'move.confirmOut': 'Les visiteurs de « {parent} » perdront l’accès à « {name} ». Continuer ?',
  'tree.sharedVia': 'Partagé via « {title} »',
  'exposure.subtree.one': '\n\nCela inclut {n} sous-dossier et son contenu.',
  'exposure.subtree.other': '\n\nCela inclut {n} sous-dossiers et leur contenu.',
  'confirm.deleteChildren.one': '\n\n{n} sous-dossier remonte dans {target}.',
  'confirm.deleteChildren.other': '\n\n{n} sous-dossiers remontent dans {target}.',
```

For `{target}`: the parent's title in quotes, or `t('move.root')` lower-cased context — pass the already formatted string.

- [ ] **Step 2: Exposure over the sub-tree** — replace `confirmExposure` in `FolderPanel.tsx`:

```ts
export function confirmExposure(f: Pick<FolderDetail, 'name' | 'visibility' | 'privateCount'>, next: Visibility, tree: TreeFolder[] = []): boolean {
  if (next === 'private' || f.visibility !== 'private') return true;
  const sub = subtreeExposure(tree, f.name);
  const privateCount = Math.max(f.privateCount, sub.privateArtifacts);
  if (privateCount === 0 && sub.folders === 0) return true;
  const extra = sub.folders > 0 ? tn('exposure.subtree', sub.folders) : '';
  return window.confirm(tn('exposure.confirm', privateCount, { name: f.name, how: t(`exposure.${next}`) }) + extra);
}
```

Update its callers (search `confirmExposure(`) to pass the folder list.

- [ ] **Step 3: Move control** — in `FolderPanel`, add a prop `folders: TreeFolder[]` (Dashboard passes `namedFolders`).
  In the panel's settings area, add:

```tsx
<label className="flex flex-col gap-1 text-sm">
  <span>{t('move.label')}</span>
  <select
    className="rounded-lg border border-line bg-transparent px-3 py-2"
    value={f.parent ?? ''}
    onChange={(e) => void move(e.target.value === '' ? null : e.target.value)}
  >
    {moveTargets(folders, f.name).map(({ folder, depth }) => (
      <option key={folder?.name ?? ''} value={folder?.name ?? ''}>
        {folder ? `${' '.repeat(depth)}${folder.title ?? folder.name}` : t('move.root')}
      </option>
    ))}
  </select>
</label>
```

and the handler, next to the other async actions of the panel (reuse its existing busy/error/reload pattern):

```ts
  async function move(parent: string | null) {
    if (parent === (f.parent ?? null)) return;
    const target = parent ? folders.find((x) => x.name === parent) : undefined;
    const via = target ? (target.visibility !== 'private' ? target : sharedVia(folders, target.name)) : null;
    const before = f.parent ? (folders.find((x) => x.name === f.parent)!.visibility !== 'private' ? folders.find((x) => x.name === f.parent)! : sharedVia(folders, f.parent)) : null;
    const exposed = subtreeExposure(folders, f.name).artifacts;
    if (via && !window.confirm(tn('move.confirmIn', exposed, { name: f.name, parent: via.title ?? via.name }))) return;
    if (!via && before && !window.confirm(t('move.confirmOut', { name: f.name, parent: before.title ?? before.name }))) return;
    await api.updateFolder(f.name, { parent });
    await onChanged();
  }
```

Replace `api.updateFolder` and `onChanged` with the names the panel actually uses for saving a folder and refreshing the
dashboard (look at how visibility changes are saved in this file).

- [ ] **Step 4: Shared via** — in the panel header, when `f.visibility === 'private'` and `sharedVia(folders, f.name)` is not
  null, show `t('tree.sharedVia', { title })` next to the visibility. Do the same on `FolderCard.tsx` where
  `folder.sharedTitle` is used (pass the folder list or a precomputed `sharedViaTitle` prop from Dashboard).

- [ ] **Step 5: Delete confirmation** — at `FolderPanel.tsx:~373`, append to the existing confirmation text:

```ts
const kids = childrenOf(folders, f.name).length;
const parentTitle = f.parent ? (folders.find((x) => x.name === f.parent)?.title ?? f.parent) : null;
const extra = kids > 0 ? tn('confirm.deleteChildren', kids, { target: parentTitle ? `“${parentTitle}”` : t('move.root') }) : '';
```

and pass `message + extra` to `window.confirm`.

- [ ] **Step 6: Verify**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: PASS.

Manual check (`npm run dev`):
1. Make `parent-demo` public. Open `child-demo` (private, one private artifact): the panel says "Shared through
   “parent-demo”".
2. Move `child-demo` to "Top level": confirmation "Visitors of … will lose access". Move it back under `parent-demo`:
   confirmation with the artifact count.
3. The "Move to" list never offers `child-demo` itself or its descendants, nor a level-4 folder.
4. Open `http://localhost:13001/d/parent-demo` in a private window: sub-folder card, then click it: breadcrumb
   `parent-demo / child-demo`, artifact opens.
5. Delete the `parent-demo` sheet: confirmation says the sub-folder moves up; `child-demo` is now at the root.

- [ ] **Step 7: Commit**

```bash
git add app/web/src
git commit -m "feat(web): move folders, sub-tree confirmations and shared-via hints"
```

---

### Task 10: Documentation and final verification

**Files:**
- Modify: `docs/architecture.md`, `docs/security.md`, `docs/publishing.md` (only where folders are described), `CHANGELOG.md`

- [ ] **Step 1: Docs** — in each file, find the folder section (search "folder") and add, in the same voice:
  - architecture: `projects.parent_name` / `position`, `folder-tree.ts`, effective access returns the granting folder.
  - security: inherited access rule, breadcrumb filtering, thumbnail signature bound to granting + displayed folder,
    the 1-hour limit after a move.
  - publishing: sub-folders are created in the admin; `--project` targets a name at any level; new CLI folders go to the root.
  - `CHANGELOG.md`: under the unreleased section, "Sub-folders: folders can be nested up to 4 levels; access to a folder
    opens its sub-folders."

- [ ] **Step 2: Full verification**

Run: `npm test && npm run typecheck && npm run build:web && python3 -m unittest discover -s ../cli/publish-artifact`
Expected: all PASS, with the test count higher than before this plan.

- [ ] **Step 3: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "docs: sub-folders"
```

---

## Spec coverage check

| Spec section | Task |
|---|---|
| One parent, depth 4 | 1, 2 |
| Access always inherited; cut by parent private/code/epoch; private child via parent | 3 |
| `/d/<F>/a/<slug>` direct members only | 3 |
| Move out / delete parent cuts access, 1 h limit | 3 (tests), 10 (docs) |
| Thumbnails bound to granting folder | 4 |
| Sub-folder cards, order, empty, direct counts | 5 |
| Breadcrumb from highest accessible ancestor | 5 |
| Unlock page never mentions parent | 3 (test) |
| API: POST/PATCH parent, 400 errors, GET fields, children-order, DELETE moves up | 6 |
| Dashboard tree, breadcrumb, new folder in current, indented picker | 8 |
| Move to…, confirmations, shared via, delete message | 9 |
| CLI unchanged | 10 (docs only) |
| Statistics unchanged | no code change (verified by existing visit tests) |
| Migration | 1 |
