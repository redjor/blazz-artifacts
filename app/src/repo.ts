import { randomToken } from './crypto.ts';
import { tx, type Db } from './db.ts';

export type Kind = 'html' | 'markdown' | 'pdf' | 'json' | 'site';
export type Visibility = 'private' | 'code' | 'link' | 'public';
export const VISIBILITIES: readonly Visibility[] = ['private', 'code', 'link', 'public'];

export interface Artifact {
  id: string; slug: string; title: string; kind: Kind; visibility: Visibility;
  code_hash: string | null; access_epoch: number; current_version_id: string | null;
  created_at: string; updated_at: string; memory_storage: number;
  project: string | null; pinned_at: string | null;
  /** Position in the folder (admin-chosen order); null: not placed yet. */
  project_position: number | null;
  /** Moved to the trash at this date (design 04); null for every artifact read through `live_artifacts`. */
  deleted_at: string | null;
}
export interface Version {
  id: string; artifact_id: string; entry_path: string; original_name: string;
  size_bytes: number; file_count: number; created_at: string;
  kind: Kind | null; number: number;
  /** Thumbnail sent by the publish CLI (null if none). */
  thumb_type: 'webp' | 'png' | 'jpeg' | null; thumb_at: string | null;
}
/** Exactly one target: an artifact or a folder (CHECK constraint in the database). */
export interface ShareLink {
  id: string; artifact_id: string | null; project_name: string | null; token_hash: string; token_enc: string; label: string | null;
  expires_at: string | null; revoked_at: string | null; last_used_at: string | null; created_at: string; open_count: number;
}
export interface Session { id_hash: string; csrf_token: string; expires_at: string; created_at: string }

export type NewArtifact = Pick<Artifact, 'id' | 'slug' | 'title' | 'kind' | 'visibility' | 'code_hash'> & { memory_storage?: number; project?: string | null; tags?: string[] };
export type NewVersion = Pick<Version, 'id' | 'entry_path' | 'original_name' | 'size_bytes' | 'file_count'>;

const nowIso = () => new Date().toISOString();

export function getArtifact(db: Db, id: string): Artifact | undefined {
  return db.prepare('SELECT * FROM live_artifacts WHERE id = ?').get(id) as Artifact | undefined;
}

export function getArtifactBySlug(db: Db, slug: string): Artifact | undefined {
  return db.prepare('SELECT * FROM live_artifacts WHERE slug = ?').get(slug) as Artifact | undefined;
}

export interface ArtifactFilter {
  /** undefined: all; null: no folder; string: exactly this folder. */
  project?: string | null;
  /** Logical AND: the artifact must carry all these tags. */
  tags?: string[];
}

export function listArtifacts(db: Db, filter: ArtifactFilter = {}): Artifact[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.project === null) where.push('project IS NULL');
  else if (filter.project !== undefined) {
    where.push('project = ?');
    params.push(filter.project);
  }
  for (const tag of filter.tags ?? []) {
    where.push('EXISTS (SELECT 1 FROM artifact_tags t WHERE t.artifact_id = live_artifacts.id AND t.tag = ?)');
    params.push(tag);
  }
  const sql = `SELECT * FROM live_artifacts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
  return db.prepare(sql).all(...params) as unknown as Artifact[];
}

export function getTags(db: Db, artifactId: string): string[] {
  return (db.prepare('SELECT tag FROM artifact_tags WHERE artifact_id = ? ORDER BY tag').all(artifactId) as { tag: string }[]).map((r) => r.tag);
}

/** Replaces the whole tag set (call inside a transaction when atomicity matters). */
export function setTags(db: Db, artifactId: string, tags: string[]): void {
  db.prepare('DELETE FROM artifact_tags WHERE artifact_id = ?').run(artifactId);
  const ins = db.prepare('INSERT OR IGNORE INTO artifact_tags (artifact_id, tag) VALUES (?, ?)');
  for (const t of tags) ins.run(artifactId, t);
}

export interface LabelCount { name: string; count: number }

/** Folders with counts; `name: null` groups artifacts without a folder (present only if there are some). */
export function listProjects(db: Db): { name: string | null; count: number }[] {
  const named = db
    .prepare('SELECT project AS name, COUNT(*) AS count FROM live_artifacts WHERE project IS NOT NULL GROUP BY project ORDER BY project')
    .all()
    .map((r) => ({ name: r.name as string, count: Number(r.count) }));
  const none = (db.prepare('SELECT COUNT(*) AS n FROM live_artifacts WHERE project IS NULL').get() as { n: number }).n;
  return none > 0 ? [...named, { name: null, count: none }] : named;
}

export function listTagCounts(db: Db): LabelCount[] {
  return db
    .prepare('SELECT t.tag AS name, COUNT(*) AS count FROM artifact_tags t JOIN live_artifacts a ON a.id = t.artifact_id GROUP BY t.tag ORDER BY count DESC, t.tag ASC')
    .all()
    .map((r) => ({ name: r.name as string, count: Number(r.count) }));
}

// Call inside a transaction: the number is max+1, never reused (the highest version is never pruned).
function insertVersion(db: Db, artifactId: string, v: NewVersion, kind: Kind, at: string): void {
  db.prepare(
    `INSERT INTO versions (id, artifact_id, entry_path, original_name, size_bytes, file_count, created_at, kind, number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM versions WHERE artifact_id = ?))`,
  ).run(v.id, artifactId, v.entry_path, v.original_name, v.size_bytes, v.file_count, at, kind, artifactId);
}

export function insertArtifactWithVersion(db: Db, a: NewArtifact, v: NewVersion): Artifact {
  const at = nowIso();
  tx(db, () => {
    db.prepare(
      'INSERT INTO artifacts (id, slug, title, kind, visibility, code_hash, memory_storage, project, current_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    ).run(a.id, a.slug, a.title, a.kind, a.visibility, a.code_hash, a.memory_storage ?? 0, a.project ?? null, at, at);
    setTags(db, a.id, a.tags ?? []);
    insertVersion(db, a.id, v, a.kind, at);
    db.prepare('UPDATE artifacts SET current_version_id = ? WHERE id = ?').run(v.id, a.id);
  });
  return getArtifact(db, a.id)!;
}

export function activateVersion(db: Db, artifactId: string, v: NewVersion, kind: Kind): void {
  const at = nowIso();
  tx(db, () => {
    insertVersion(db, artifactId, v, kind, at);
    db.prepare('UPDATE artifacts SET current_version_id = ?, kind = ?, updated_at = ? WHERE id = ?').run(v.id, kind, at, artifactId);
  });
}

/**
 * Makes `versionId` current (same URL); 'current' if it already is (nothing changes); undefined if it is gone or not the artifact's.
 * Check and switch in one transaction. Does not bump access_epoch.
 */
export function restoreVersion(db: Db, artifactId: string, versionId: string): Version | 'current' | undefined {
  return tx(db, () => {
    const v = getVersion(db, versionId);
    if (!v || v.artifact_id !== artifactId) return undefined;
    if (getArtifact(db, artifactId)?.current_version_id === v.id) return 'current';
    db.prepare('UPDATE artifacts SET current_version_id = ?, kind = COALESCE(?, kind), updated_at = ? WHERE id = ?').run(v.id, v.kind, nowIso(), artifactId);
    return v;
  });
}

/** Folder sheet (shareable project). A project without a sheet is private. */
export interface Project {
  name: string; title: string | null; description: string | null; visibility: Visibility; code_hash: string | null;
  access_epoch: number; created_at: string; updated_at: string;
  /** Random, set when the sheet is created; bound to the folder's cookies, signed thumbnails and previews. */
  salt: string;
  /** Parent folder (design 03); null: at the root. */
  parent_name: string | null;
  /** Order among siblings (admin-chosen); null: not placed. */
  position: number | null;
}

export function getProject(db: Db, name: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
}

export type ProjectPatch = Partial<Pick<Project, 'title' | 'description' | 'visibility' | 'code_hash'>>;

/** Creates the sheet on the fly then applies `patch`; `bump` increments the folder access epoch (folder cookies invalidated). */
export function upsertProject(db: Db, name: string, patch: ProjectPatch, bump = false): Project {
  const at = nowIso();
  db.prepare('INSERT OR IGNORE INTO projects (name, created_at, updated_at, salt) VALUES (?, ?, ?, ?)').run(name, at, at, randomToken(16));
  const sets: string[] = ['updated_at = ?'];
  const values: (string | null)[] = [at];
  for (const key of ['title', 'description', 'visibility', 'code_hash'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(patch[key] as string | null);
    }
  }
  if (bump) sets.push('access_epoch = access_epoch + 1');
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE name = ?`).run(...values, name);
  return getProject(db, name)!;
}

export function bumpProjectEpoch(db: Db, name: string): void {
  db.prepare('UPDATE projects SET access_epoch = access_epoch + 1, updated_at = ? WHERE name = ?').run(nowIso(), name);
}

/**
 * Renames a project: all its artifacts, its sheet, links and statistics (ON UPDATE CASCADE). The old folder URL
 * stops answering. Call inside a transaction (with the check that `to` is free).
 */
export function renameProject(db: Db, from: string, to: string): void {
  db.prepare('UPDATE artifacts SET project = ? WHERE project = ?').run(to, from);
  db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE name = ?').run(to, nowIso(), from);
}

/** A project exists if it has a sheet or at least one artifact. */
export function projectExists(db: Db, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM projects WHERE name = ? UNION ALL SELECT 1 FROM live_artifacts WHERE project = ? LIMIT 1').get(name, name);
}

/**
 * Deletes the sheet (and so its folder links and statistics); artifacts stay in their project. Direct sub-folders move
 * to the deleted sheet's parent (or the root) first. When no live artifact keeps the folder alive, the folder is gone:
 * its trashed artifacts are detached so that restoring one does not bring it back. Opens its own transaction.
 */
export function deleteProject(db: Db, name: string): boolean {
  return tx(db, () => {
    const sheet = getProject(db, name);
    if (!sheet) return false;
    db.prepare('UPDATE projects SET parent_name = ?, position = NULL, updated_at = ? WHERE parent_name = ?').run(sheet.parent_name, nowIso(), name);
    const deleted = Number(db.prepare('DELETE FROM projects WHERE name = ?').run(name).changes) > 0;
    if (!projectExists(db, name)) db.prepare('UPDATE artifacts SET project = NULL, project_position = NULL WHERE project = ? AND deleted_at IS NOT NULL').run(name);
    return deleted;
  });
}

/** Folder artifacts in page order: newcomers (not placed) first, newest to oldest, then the chosen order. */
export function listFolderArtifacts(db: Db, name: string): Artifact[] {
  return db
    .prepare('SELECT * FROM live_artifacts WHERE project = ? ORDER BY project_position IS NOT NULL, project_position, updated_at DESC, id')
    .all(name) as unknown as Artifact[];
}

/** The `limit` most recently modified artifacts of a project (`null`: no project), newest first. */
export function recentProjectArtifacts(db: Db, project: string | null, limit: number): Artifact[] {
  return db
    .prepare(`SELECT * FROM live_artifacts WHERE ${project === null ? 'project IS NULL' : 'project = ?'} ORDER BY updated_at DESC, id LIMIT ?`)
    .all(...(project === null ? [limit] : [project, limit])) as unknown as Artifact[];
}

/** Sets the order: `ids` must be exactly the folder's artifacts (otherwise false, nothing changes). */
export function setProjectOrder(db: Db, name: string, ids: string[]): boolean {
  return tx(db, () => {
    const current = new Set(listFolderArtifacts(db, name).map((a) => a.id));
    if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some((id) => !current.has(id))) return false;
    const set = db.prepare('UPDATE artifacts SET project_position = ? WHERE id = ?');
    ids.forEach((id, i) => set.run(i, id));
    return true;
  });
}

export interface FolderSummary { name: string | null; count: number; privateCount: number; visibility: Visibility; title: string | null; parent: string | null; position: number | null }

/** Projects (with or without a sheet, empty folders included) with folder visibility and private artifact count; `name: null` last. */
export function listFolders(db: Db): FolderSummary[] {
  const rows = db.prepare(`
    SELECT n.name AS name, p.visibility AS visibility, p.title AS title, p.parent_name AS parent, p.position AS position,
      (SELECT COUNT(*) FROM live_artifacts a WHERE a.project = n.name) AS count,
      (SELECT COUNT(*) FROM live_artifacts a WHERE a.project = n.name AND a.visibility = 'private') AS private_count
    FROM (SELECT project AS name FROM live_artifacts WHERE project IS NOT NULL UNION SELECT name FROM projects) n
    LEFT JOIN projects p ON p.name = n.name
    ORDER BY n.name`).all();
  const named: FolderSummary[] = rows.map((r) => ({
    name: r.name as string, count: Number(r.count), privateCount: Number(r.private_count),
    visibility: (r.visibility as Visibility | null) ?? 'private', title: (r.title as string | null) ?? null,
    parent: (r.parent as string | null) ?? null, position: r.position === null || r.position === undefined ? null : Number(r.position),
  }));
  const none = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(visibility = 'private'), 0) AS p FROM live_artifacts WHERE project IS NULL").get() as { n: number; p: number };
  return Number(none.n) > 0 ? [...named, { name: null, count: Number(none.n), privateCount: Number(none.p), visibility: 'private', title: null, parent: null, position: null }] : named;
}

export type ArtifactPatch = Partial<Pick<Artifact, 'title' | 'slug' | 'visibility' | 'code_hash' | 'memory_storage' | 'project'>>;
const PATCHABLE = ['title', 'slug', 'visibility', 'code_hash', 'memory_storage', 'project'] as const;

export function updateArtifact(db: Db, id: string, patch: ArtifactPatch, bump: boolean): Artifact {
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [nowIso()];
  // Changing project drops the position in the old folder (expressions evaluated on the old row).
  if (patch.project !== undefined) {
    sets.push('project_position = CASE WHEN project IS ? THEN project_position ELSE NULL END');
    values.push(patch.project);
  }
  for (const key of PATCHABLE) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(patch[key] as string | number | null);
    }
  }
  if (bump) sets.push('access_epoch = access_epoch + 1');
  db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  return getArtifact(db, id)!;
}

/** Pins (current date, kept if already pinned) or unpins; touches neither updated_at nor the access epoch. */
export function setPinned(db: Db, id: string, pinned: boolean): Artifact {
  if (pinned) db.prepare('UPDATE artifacts SET pinned_at = COALESCE(pinned_at, ?) WHERE id = ?').run(nowIso(), id);
  else db.prepare('UPDATE artifacts SET pinned_at = NULL WHERE id = ?').run(id);
  return getArtifact(db, id)!;
}

export function bumpEpoch(db: Db, id: string): void {
  db.prepare('UPDATE artifacts SET access_epoch = access_epoch + 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
}

/** Deletes for good (row, then versions, links, tags and statistics by cascade). Files: removeArtifactFiles. */
export function deleteArtifact(db: Db, id: string): void {
  db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  db.prepare('DELETE FROM search_index WHERE artifact_id = ?').run(id); // no foreign key on a virtual table
}

// Trash (design 04). The only functions that read the `artifacts` table rather than `live_artifacts`.

export type TrashedArtifact = Artifact & { deleted_at: string };

/** Moves to the trash: gone for visitors at once (epoch bumped: signed paths already issued stop working). */
export function trashArtifact(db: Db, id: string): boolean {
  return Number(db.prepare('UPDATE artifacts SET deleted_at = ?, access_epoch = access_epoch + 1 WHERE id = ? AND deleted_at IS NULL').run(nowIso(), id).changes) > 0;
}

export function getTrashedArtifact(db: Db, id: string): TrashedArtifact | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NOT NULL').get(id) as TrashedArtifact | undefined;
}

/** Trashed artifacts, most recent deletion first. */
export function listTrash(db: Db): TrashedArtifact[] {
  return db.prepare('SELECT * FROM artifacts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id').all() as unknown as TrashedArtifact[];
}

/** Trashed artifacts deleted before `cutoffIso` (due for the purge). */
export function trashedBefore(db: Db, cutoffIso: string): string[] {
  return (db.prepare('SELECT id FROM artifacts WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoffIso) as { id: string }[]).map((r) => r.id);
}

/** Who holds a slug, trash included (a trashed artifact keeps its slug so that restoring it keeps its URL). */
export function slugHolder(db: Db, slug: string): { id: string; trashed: boolean } | undefined {
  const r = db.prepare('SELECT id, deleted_at FROM artifacts WHERE slug = ?').get(slug) as { id: string; deleted_at: string | null } | undefined;
  return r && { id: r.id, trashed: r.deleted_at !== null };
}

/**
 * Brings a trashed artifact back as it was, in its folder. A folder emptied by the trash comes back with it (undoing a
 * batch must not scatter it); a folder deleted since has already detached its trashed artifacts (deleteProject), so
 * they come back without a folder. Undefined if it is not in the trash. No transaction of its own: bulk restore runs
 * it inside one.
 */
export function restoreArtifact(db: Db, id: string): Artifact | undefined {
  const changed = Number(db.prepare('UPDATE artifacts SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes) > 0;
  return changed ? getArtifact(db, id) : undefined;
}

export function getVersion(db: Db, id: string): Version | undefined {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as Version | undefined;
}

export function listVersions(db: Db, artifactId: string): Version[] {
  return db
    .prepare('SELECT * FROM versions WHERE artifact_id = ? ORDER BY number DESC, created_at DESC, id DESC')
    .all(artifactId) as unknown as Version[];
}

export type ThumbState = Pick<Version, 'thumb_type' | 'thumb_at'>;

/**
 * Records a version's thumbnail (inside a transaction: the version must still exist and belong to the artifact).
 * Returns the previous state (to roll back), or undefined if the version is gone. `null` clears.
 */
export function setVersionThumb(db: Db, artifactId: string, versionId: string, next: ThumbState): ThumbState | undefined {
  return tx(db, () => {
    const v = getVersion(db, versionId);
    if (!v || v.artifact_id !== artifactId) return undefined;
    db.prepare('UPDATE versions SET thumb_type = ?, thumb_at = ? WHERE id = ?').run(next.thumb_type, next.thumb_at, versionId);
    return { thumb_type: v.thumb_type, thumb_at: v.thumb_at };
  });
}

export function deleteVersionRow(db: Db, id: string): void {
  db.prepare('DELETE FROM versions WHERE id = ?').run(id);
}

/** Target: `artifact_id` or `project_name` (exactly one of them). */
export type NewLink = Pick<ShareLink, 'id' | 'token_hash' | 'token_enc' | 'label' | 'expires_at'> &
  ({ artifact_id: string; project_name?: undefined } | { project_name: string; artifact_id?: undefined });

export function insertLink(db: Db, l: NewLink): ShareLink {
  db.prepare(
    'INSERT INTO share_links (id, artifact_id, project_name, token_hash, token_enc, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(l.id, l.artifact_id ?? null, l.project_name ?? null, l.token_hash, l.token_enc, l.label, l.expires_at, nowIso());
  return getLink(db, l.id)!;
}

export function listFolderLinks(db: Db, name: string): ShareLink[] {
  return db
    .prepare('SELECT * FROM share_links WHERE project_name = ? ORDER BY created_at DESC, rowid DESC')
    .all(name) as unknown as ShareLink[];
}

export function revokeFolderLink(db: Db, name: string, linkId: string): boolean {
  const res = db
    .prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND project_name = ? AND revoked_at IS NULL')
    .run(nowIso(), linkId, name);
  return Number(res.changes) > 0;
}

export function getLink(db: Db, id: string): ShareLink | undefined {
  return db.prepare('SELECT * FROM share_links WHERE id = ?').get(id) as ShareLink | undefined;
}

export function getLinkByHash(db: Db, hash: string): ShareLink | undefined {
  return db.prepare('SELECT * FROM share_links WHERE token_hash = ?').get(hash) as ShareLink | undefined;
}

export function listLinks(db: Db, artifactId: string): ShareLink[] {
  return db
    .prepare('SELECT * FROM share_links WHERE artifact_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(artifactId) as unknown as ShareLink[];
}

export function revokeLink(db: Db, artifactId: string, linkId: string): boolean {
  const res = db
    .prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND artifact_id = ? AND revoked_at IS NULL')
    .run(nowIso(), linkId, artifactId);
  return Number(res.changes) > 0;
}

export function insertSession(db: Db, s: Omit<Session, 'created_at'>): void {
  db.prepare('INSERT INTO admin_sessions (id_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(s.id_hash, s.csrf_token, s.expires_at, nowIso());
}

export function getSession(db: Db, idHash: string): Session | undefined {
  return db
    .prepare('SELECT * FROM admin_sessions WHERE id_hash = ? AND expires_at > ?')
    .get(idHash, nowIso()) as Session | undefined;
}

export function deleteSession(db: Db, idHash: string): void {
  db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(idHash);
}

export function purgeExpiredSessions(db: Db): void {
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(nowIso());
}
