import { chmod, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tx, type Db } from './db.ts';
import { deleteVersionRow, getArtifact, listVersions } from './repo.ts';

export const tmpRoot = (dataDir: string) => join(dataDir, 'tmp');

export function versionDir(dataDir: string, artifactId: string, versionId: string): string {
  return join(dataDir, 'files', artifactId, versionId);
}

export type ThumbType = 'webp' | 'png' | 'jpeg';
export const THUMB_TYPES: readonly ThumbType[] = ['webp', 'png', 'jpeg'];
const THUMB_EXT: Record<ThumbType, string> = { webp: 'webp', png: 'png', jpeg: 'jpg' };

/** Thumbnails outside files/: the content server (which only serves files/) can never reach them. */
export const thumbsDir = (dataDir: string, artifactId: string) => join(dataDir, 'thumbs', artifactId);

export function thumbPath(dataDir: string, artifactId: string, versionId: string, type: ThumbType): string {
  return join(thumbsDir(dataDir, artifactId), `${versionId}.${THUMB_EXT[type]}`);
}

/** Every possible thumbnail path of a version (only one exists; the others are ignored on deletion). */
export const thumbPaths = (dataDir: string, artifactId: string, versionId: string) =>
  THUMB_TYPES.map((t) => thumbPath(dataDir, artifactId, versionId, t));

export const FILE_MODE = 0o644;
export const DIR_MODE = 0o755;

/**
 * Fixed modes on everything published: files 0644, folders 0755, whatever the uploaded file's mode
 * (a copy keeps the source's) or the process umask. A non-root backup must be able to read everything.
 * Symbolic links are never followed (ZIP extraction refuses them anyway).
 */
export async function normalizeModes(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) return chmod(root, FILE_MODE);
  await chmod(root, DIR_MODE);
  for (const entry of await readdir(root)) await normalizeModes(join(root, entry));
}

export interface ModeRepair { checked: number; changed: number; failed: number }

/**
 * Startup repair: same modes as normalizeModes, but tolerant. chmod only when the mode differs,
 * an error (EACCES…) only stops that entry, symbolic links never followed, missing root = nothing to do.
 */
export async function repairModes(
  root: string,
  setMode: (path: string, mode: number) => Promise<void> = (p, m) => chmod(p, m),
): Promise<ModeRepair> {
  const report: ModeRepair = { checked: 0, changed: 0, failed: 0 };
  const visit = async (path: string, isRoot: boolean): Promise<void> => {
    let info;
    try {
      info = await lstat(path);
    } catch {
      if (!isRoot) report.failed++;
      return;
    }
    if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) return;
    report.checked++;
    const want = info.isDirectory() ? DIR_MODE : FILE_MODE;
    if ((info.mode & 0o777) !== want) {
      try {
        await setMode(path, want);
        report.changed++;
      } catch {
        report.failed++;
      }
    }
    if (!info.isDirectory()) return;
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch {
      report.failed++;
      return;
    }
    for (const entry of entries) await visit(join(path, entry), false);
  };
  await visit(root, true);
  return report;
}

export async function ensureDataDirs(dataDir: string): Promise<void> {
  for (const sub of ['files', 'tmp', 'backup', 'thumbs']) await mkdir(join(dataDir, sub), { recursive: true });
}

export async function removeArtifactFiles(dataDir: string, artifactId: string): Promise<void> {
  await rm(join(dataDir, 'files', artifactId), { recursive: true, force: true });
  await rm(thumbsDir(dataDir, artifactId), { recursive: true, force: true });
}

export const KEEP_FOREVER_KINDS: readonly string[] = ['markdown', 'html'];
export const KEEP_OTHER = 10;

/**
 * Decides and deletes the rows in ONE transaction (current_version_id re-read inside it, so a concurrent
 * restore cannot be contradicted). Returns the paths (version folders and thumbnails) to delete after commit.
 * Retention: markdown/html (and unknown kind) forever; other kinds keep the KEEP_OTHER most
 * recent (by number). The current version is never deleted and counts in KEEP_OTHER only
 * when it is of a pruned kind.
 */
export function pruneVersionRows(db: Db, dataDir: string, artifactId: string): string[] {
  return tx(db, () => {
    const art = getArtifact(db, artifactId);
    if (!art) return [];
    const prunable = listVersions(db, artifactId).filter((v) => v.kind !== null && !KEEP_FOREVER_KINDS.includes(v.kind));
    const protectedIds = new Set([art.current_version_id, art.published_version_id]);
    let slots = KEEP_OTHER - prunable.filter(v => protectedIds.has(v.id)).length;
    const dirs: string[] = [];
    for (const v of prunable) {
      if (protectedIds.has(v.id)) continue;
      if (slots > 0) {
        slots--;
        continue;
      }
      deleteVersionRow(db, v.id);
      dirs.push(versionDir(dataDir, artifactId, v.id), ...thumbPaths(dataDir, artifactId, v.id));
    }
    return dirs;
  });
}

export async function pruneVersions(db: Db, dataDir: string, artifactId: string): Promise<void> {
  for (const dir of pruneVersionRows(db, dataDir, artifactId)) await rm(dir, { recursive: true, force: true });
}
