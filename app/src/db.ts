import { DatabaseSync } from 'node:sqlite';
import { randomToken } from './crypto.ts';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('html','markdown','pdf','json','site')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','code','link','public')),
  code_hash TEXT,
  access_epoch INTEGER NOT NULL DEFAULT 1,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  memory_storage INTEGER NOT NULL DEFAULT 0,
  pinned_at TEXT
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  entry_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_artifact ON versions(artifact_id);
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT NOT NULL,
  label TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS share_links_artifact ON share_links(artifact_id);
CREATE TABLE IF NOT EXISTS artifact_tags (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (artifact_id, tag)
);
CREATE INDEX IF NOT EXISTS artifact_tags_tag ON artifact_tags(tag);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  // synchronous=NORMAL: safe with WAL (at worst the last transaction is lost on power loss), fewer fsyncs per write.
  // secure_delete: deleted rows (purged visit fingerprints) are overwritten, not left in free pages.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // In-place migration of databases created before the simulated storage option.
  const cols = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'memory_storage')) {
    db.exec('ALTER TABLE artifacts ADD COLUMN memory_storage INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'project')) {
    db.exec('ALTER TABLE artifacts ADD COLUMN project TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project)');
  migrateVersions(db);
  migratePins(db);
  migrateVisits(db);
  migrateThumbs(db);
  migrateFolders(db);
  migrateTrash(db);
  migrateSearch(db);
  return db;
}

// Trash (design 04): `deleted_at` marks a trashed artifact. Every read goes through `live_artifacts`, so a
// forgotten filter cannot show a trashed artifact; only the trash functions in repo.ts read `artifacts` itself.
// Runs last: the view must see every column added by the migrations above.
function migrateTrash(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'deleted_at')) db.exec('ALTER TABLE artifacts ADD COLUMN deleted_at TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS artifacts_deleted ON artifacts(deleted_at);
    CREATE VIEW IF NOT EXISTS live_artifacts AS SELECT * FROM artifacts WHERE deleted_at IS NULL;
  `);
}

// Full-text search (design 07): one row per artifact, trashed ones included (results join live_artifacts). Filled by
// the API (src/search.ts) and, for artifacts without a row, at startup.
function migrateSearch(db: Db): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
    artifact_id UNINDEXED, title, slug, tags, body, tokenize = 'unicode61 remove_diacritics 2'
  )`);
}

// Shareable folders: one sheet per project, order in the folder, folder share links, folder visits.
// share_links: artifact_id becomes nullable and an “exactly one target” constraint appears. SQLite cannot
// change a NOT NULL or add a CHECK in place: the table is rebuilt (create, copy with rowids, drop,
// rename, recreate indexes), all in one transaction. Idempotent: rebuilds only when project_name is missing.
function migrateFolders(db: Db): void {
  tx(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','code','link','public')),
        code_hash TEXT,
        access_epoch INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS folder_visit_days (
        project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE ON UPDATE CASCADE,
        day TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        uniques INTEGER NOT NULL DEFAULT 0,
        last_at TEXT,
        PRIMARY KEY (project_name, day)
      );
      CREATE TABLE IF NOT EXISTS folder_visit_seen (
        day TEXT NOT NULL,
        project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE ON UPDATE CASCADE,
        visitor_hash TEXT NOT NULL,
        ip_hash TEXT,
        last_seen INTEGER NOT NULL,
        views INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (day, project_name, visitor_hash)
      );
      CREATE INDEX IF NOT EXISTS folder_visit_seen_ip ON folder_visit_seen(day, project_name, ip_hash);
    `);
    // Salt per sheet, bound to the folder's cookies and signatures: a sheet deleted then re-created (or a name
    // reused after a rename) restarts at epoch 1 without ever reviving an old access.
    const projectCols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    if (!projectCols.some((c) => c.name === 'salt')) db.exec('ALTER TABLE projects ADD COLUMN salt TEXT');
    // Sub-folders (design 03): one optional parent, sibling order. A foreign key on ADD COLUMN is allowed with a NULL
    // default; ON UPDATE CASCADE makes children follow a rename. No ON DELETE: deleteProject re-parents children first.
    if (!projectCols.some((c) => c.name === 'parent_name')) db.exec('ALTER TABLE projects ADD COLUMN parent_name TEXT REFERENCES projects(name) ON UPDATE CASCADE');
    if (!projectCols.some((c) => c.name === 'position')) db.exec('ALTER TABLE projects ADD COLUMN position INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS projects_parent ON projects(parent_name)');
    const setSalt = db.prepare('UPDATE projects SET salt = ? WHERE name = ?');
    for (const { name } of db.prepare('SELECT name FROM projects WHERE salt IS NULL').all() as { name: string }[]) setSalt.run(randomToken(16), name);
    const artCols = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
    if (!artCols.some((c) => c.name === 'project_position')) db.exec('ALTER TABLE artifacts ADD COLUMN project_position INTEGER');
    const linkCols = db.prepare('PRAGMA table_info(share_links)').all() as { name: string }[];
    if (!linkCols.some((c) => c.name === 'project_name')) {
      // Checked BEFORE the copy: an orphan link (database once written without foreign keys) would fail the INSERT midway.
      const orphans = db.prepare('PRAGMA foreign_key_check(share_links)').all();
      if (orphans.length) {
        throw new Error(`share_links migration aborted: ${orphans.length} orphan link(s) (artifact_id without artifact). Delete these share_links rows and restart; the database was not modified.`);
      }
      db.exec(`
        CREATE TABLE share_links_new (
          id TEXT PRIMARY KEY,
          artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
          project_name TEXT REFERENCES projects(name) ON DELETE CASCADE ON UPDATE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          token_enc TEXT NOT NULL,
          label TEXT,
          expires_at TEXT,
          revoked_at TEXT,
          last_used_at TEXT,
          created_at TEXT NOT NULL,
          open_count INTEGER NOT NULL DEFAULT 0,
          CHECK ((artifact_id IS NULL) <> (project_name IS NULL))
        );
        INSERT INTO share_links_new (rowid, id, artifact_id, project_name, token_hash, token_enc, label, expires_at, revoked_at, last_used_at, created_at, open_count)
          SELECT rowid, id, artifact_id, NULL, token_hash, token_enc, label, expires_at, revoked_at, last_used_at, created_at, open_count FROM share_links;
        DROP TABLE share_links;
        ALTER TABLE share_links_new RENAME TO share_links;
      `);
      const broken = db.prepare('PRAGMA foreign_key_check(share_links)').all();
      if (broken.length) throw new Error(`migration share_links : ${broken.length} lien(s) orphelin(s)`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS share_links_artifact ON share_links(artifact_id);
      CREATE INDEX IF NOT EXISTS share_links_project ON share_links(project_name);
    `);
  });
}

// History: `kind` and `number` per version. Idempotent; only touches rows not filled yet.
function migrateVersions(db: Db): void {
  tx(db, () => {
    const cols = db.prepare('PRAGMA table_info(versions)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'kind')) db.exec('ALTER TABLE versions ADD COLUMN kind TEXT');
    if (!cols.some((c) => c.name === 'number')) db.exec('ALTER TABLE versions ADD COLUMN number INTEGER');
    // Kind taken from the version itself (the artifact's kind may have changed between versions), else the artifact's.
    db.exec(`UPDATE versions SET kind = CASE
      WHEN entry_path = 'document.pdf' THEN 'pdf'
      WHEN lower(original_name) LIKE '%.zip' THEN 'site'
      WHEN lower(original_name) LIKE '%.json' THEN 'json'
      WHEN lower(original_name) LIKE '%.md' OR lower(original_name) LIKE '%.markdown' THEN 'markdown'
      WHEN (lower(original_name) LIKE '%.html' OR lower(original_name) LIKE '%.htm') AND file_count = 1 THEN 'html'
      WHEN file_count > 2 THEN 'site'
      ELSE (SELECT a.kind FROM artifacts a WHERE a.id = versions.artifact_id)
    END WHERE kind IS NULL`);
    const pending = db.prepare('SELECT DISTINCT artifact_id FROM versions WHERE number IS NULL').all() as { artifact_id: string }[];
    const rows = db.prepare('SELECT id FROM versions WHERE artifact_id = ? AND number IS NULL ORDER BY created_at ASC, id ASC');
    const max = db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM versions WHERE artifact_id = ?');
    const set = db.prepare('UPDATE versions SET number = ? WHERE id = ?');
    for (const { artifact_id } of pending) {
      let n = Number((max.get(artifact_id) as { n: number }).n);
      for (const r of rows.all(artifact_id) as { id: string }[]) set.run(++n, r.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS versions_artifact_number ON versions(artifact_id, number)');
  });
}

// Pins: pin date, NULL when not pinned. Idempotent.
function migratePins(db: Db): void {
  tx(db, () => {
    const cols = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'pinned_at')) db.exec('ALTER TABLE artifacts ADD COLUMN pinned_at TEXT');
  });
}

// Visit statistics: daily aggregates, daily fingerprints (purged after 2 days), opens per link. Idempotent.
function migrateVisits(db: Db): void {
  tx(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS visit_days (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        uniques INTEGER NOT NULL DEFAULT 0,
        last_at TEXT,
        PRIMARY KEY (artifact_id, day)
      );
      CREATE TABLE IF NOT EXISTS visit_seen (
        day TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        visitor_hash TEXT NOT NULL,
        ip_hash TEXT,
        last_seen INTEGER NOT NULL,
        views INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (day, artifact_id, visitor_hash)
      );
      CREATE INDEX IF NOT EXISTS visit_seen_artifact ON visit_seen(artifact_id);
    `);
    const seenCols = db.prepare('PRAGMA table_info(visit_seen)').all() as { name: string }[];
    if (!seenCols.some((c) => c.name === 'ip_hash')) db.exec('ALTER TABLE visit_seen ADD COLUMN ip_hash TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS visit_seen_ip ON visit_seen(day, artifact_id, ip_hash)');
    const cols = db.prepare('PRAGMA table_info(share_links)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'open_count')) db.exec('ALTER TABLE share_links ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0');
  });
}

// Thumbnails per version: stored file format (webp|png|jpeg) and upload date (for the URL and ETag). Idempotent.
function migrateThumbs(db: Db): void {
  tx(db, () => {
    const cols = db.prepare('PRAGMA table_info(versions)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'thumb_type')) db.exec('ALTER TABLE versions ADD COLUMN thumb_type TEXT');
    if (!cols.some((c) => c.name === 'thumb_at')) db.exec('ALTER TABLE versions ADD COLUMN thumb_at TEXT');
  });
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
