// Trash (design 04): permanent deletion and the periodic purge. Moving to and restoring from the trash are
// plain row updates (repo.ts); deleting for good also removes the files.
import type { Db } from './db.ts';
import { deleteArtifact, trashedBefore } from './repo.ts';
import { removeArtifactFiles } from './storage.ts';

/** Deletes an artifact for good: its row (versions, links, tags and statistics follow by cascade), then its files. */
export async function deleteForGood(db: Db, dataDir: string, id: string): Promise<void> {
  deleteArtifact(db, id);
  await removeArtifactFiles(dataDir, id);
}

/** Purges the artifacts that have been in the trash for more than `days` days. Returns how many were deleted. */
export async function purgeTrash(db: Db, dataDir: string, days: number, nowMs: number): Promise<number> {
  const ids = trashedBefore(db, new Date(nowMs - days * 86_400_000).toISOString());
  for (const id of ids) await deleteForGood(db, dataDir, id);
  return ids.length;
}
