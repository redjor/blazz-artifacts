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
