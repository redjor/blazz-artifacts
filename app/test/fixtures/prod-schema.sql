CREATE TABLE artifacts (
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
  memory_storage INTEGER NOT NULL DEFAULT 0
, project TEXT, pinned_at TEXT);
CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  entry_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
, kind TEXT, number INTEGER, thumb_type TEXT, thumb_at TEXT);
CREATE INDEX versions_artifact ON versions(artifact_id);
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT NOT NULL,
  label TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
, open_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX share_links_artifact ON share_links(artifact_id);
CREATE TABLE artifact_tags (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (artifact_id, tag)
);
CREATE INDEX artifact_tags_tag ON artifact_tags(tag);
CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_project ON artifacts(project);
CREATE UNIQUE INDEX versions_artifact_number ON versions(artifact_id, number);
CREATE TABLE visit_days (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0,
        uniques INTEGER NOT NULL DEFAULT 0,
        last_at TEXT,
        PRIMARY KEY (artifact_id, day)
      );
CREATE TABLE visit_seen (
        day TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        visitor_hash TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        views INTEGER NOT NULL DEFAULT 1, ip_hash TEXT,
        PRIMARY KEY (day, artifact_id, visitor_hash)
      );
CREATE INDEX visit_seen_artifact ON visit_seen(artifact_id);
CREATE INDEX visit_seen_ip ON visit_seen(day, artifact_id, ip_hash);
