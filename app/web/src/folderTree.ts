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

/** Folder whose access opens `name` to visitors: itself when shared, else its highest shared ancestor; null if none. */
export function openerOf(folders: TreeFolder[], name: string): TreeFolder | null {
  const self = folders.find((x) => x.name === name);
  if (!self) return null;
  return self.visibility !== 'private' ? self : sharedVia(folders, name);
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

/** Nearest ancestor of a vanished folder that still exists (null: the root), read from the folder list before the change. */
export function survivingParent(before: { name: string | null; parent: string | null }[], after: { name: string | null }[], name: string): string | null {
  const parentOf = new Map(before.map((f) => [f.name, f.parent]));
  const alive = new Set(after.map((f) => f.name));
  let parent = parentOf.get(name) ?? null;
  // Bounded walk: the tree is at most a few levels deep, and a malformed list must not loop.
  for (let i = 0; i < before.length && parent !== null && !alive.has(parent); i++) parent = parentOf.get(parent) ?? null;
  return parent !== null && alive.has(parent) ? parent : null;
}
