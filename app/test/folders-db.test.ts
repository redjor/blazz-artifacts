import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createContentApp } from '../src/content/server.ts';
import { deriveKeys, encrypt, sha256 } from '../src/crypto.ts';
import { openDb, type Db } from '../src/db.ts';
import { newId } from '../src/ids.ts';
import { codeLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import {
  deleteArtifact, deleteProject, getLink, getProject, insertLink, listFolderLinks, listFolders, listLinks, listProjects, revokeFolderLink, revokeLink,
  upsertProject, renameProject, setProjectOrder, listFolderArtifacts, updateArtifact, insertArtifactWithVersion, recentProjectArtifacts,
} from '../src/repo.ts';
import { tempDataDir, testConfig } from './helpers.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { versionDir } from '../src/storage.ts';

// Schéma exact de la base en production avant les dossiers (dump .schema d'une base créée et migrée par le code actuel).
const PROD_SCHEMA = readFileSync(join(import.meta.dirname, 'fixtures/prod-schema.sql'), 'utf8');
const SECRET = Buffer.alloc(32, 7);
// Identifiants au format ULID (les chemins signés les exigent).
const A1 = '01J000000000000000000000A1';
const V1 = '01J000000000000000000000V1';

async function prodDb(): Promise<{ file: string; dataDir: string; tokens: string[] }> {
  const dataDir = await tempDataDir();
  const file = join(dataDir, 'hub.sqlite');
  const keys = deriveKeys(SECRET);
  const raw = new DatabaseSync(file);
  raw.exec(PROD_SCHEMA);
  raw.exec(`
    INSERT INTO artifacts (id, slug, title, kind, visibility, code_hash, access_epoch, current_version_id, created_at, updated_at, memory_storage, project, pinned_at)
      VALUES ('${A1}', 'lien', 'Lien', 'html', 'link', NULL, 3, '${V1}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 'client', NULL),
             ('A2', 'autre', 'Autre', 'html', 'private', NULL, 1, 'V2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, NULL, NULL);
    INSERT INTO versions (id, artifact_id, entry_path, original_name, size_bytes, file_count, created_at, kind, number)
      VALUES ('${V1}', '${A1}', 'index.html', 'a.html', 1, 1, '2026-01-01T00:00:00.000Z', 'html', 1),
             ('V2', 'A2', 'index.html', 'b.html', 1, 1, '2026-01-01T00:00:00.000Z', 'html', 1);
  `);
  const tokens = ['a', 'b', 'c'].map((c) => c.repeat(43));
  const ins = raw.prepare(`INSERT INTO share_links (id, artifact_id, token_hash, token_enc, label, expires_at, revoked_at, last_used_at, created_at, open_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Même date de création : l'ordre des liens repose sur le rowid, qui doit survivre à la migration.
  ins.run('L1', A1, sha256(tokens[0]), encrypt(keys.linkEnc, tokens[0]), 'Client', '2099-01-01T00:00:00.000Z', null, '2026-02-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 7);
  ins.run('L2', A1, sha256(tokens[1]), encrypt(keys.linkEnc, tokens[1]), null, null, '2026-01-05T00:00:00.000Z', null, '2026-01-02T00:00:00.000Z', 0);
  ins.run('L3', 'A2', sha256(tokens[2]), encrypt(keys.linkEnc, tokens[2]), 'x', null, null, null, '2026-01-03T00:00:00.000Z', 2);
  raw.close();
  await mkdir(versionDir(dataDir, A1, V1), { recursive: true });
  await writeFile(join(versionDir(dataDir, A1, V1), 'index.html'), '<p>lien</p>');
  return { file, dataDir, tokens };
}

const columns = (db: Db, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
const snapshot = (db: Db) =>
  db.prepare('SELECT rowid, id, artifact_id, token_hash, token_enc, label, expires_at, revoked_at, last_used_at, created_at, open_count FROM share_links ORDER BY rowid').all().map((r) => ({ ...r }));

test('migration dossiers sur le schéma de production : share_links reconstruite, liens intacts, idempotente', async () => {
  const { file } = await prodDb();
  const before = new DatabaseSync(file);
  const rows = before.prepare('SELECT rowid, id, artifact_id, token_hash, token_enc, label, expires_at, revoked_at, last_used_at, created_at, open_count FROM share_links ORDER BY rowid').all().map((r) => ({ ...r }));
  before.close();

  const db = openDb(file);
  assert.deepEqual(snapshot(db), rows, 'ids, rowids, jetons, compteurs et dates préservés');
  const cols = columns(db, 'share_links');
  assert.equal(cols.find((c) => c.name === 'artifact_id')!.notnull, 0, 'artifact_id nullable');
  assert.ok(cols.some((c) => c.name === 'project_name'));
  assert.ok(columns(db, 'artifacts').some((c) => c.name === 'project_position'));
  assert.deepEqual(columns(db, 'projects').map((c) => c.name),
    ['name', 'title', 'description', 'visibility', 'code_hash', 'access_epoch', 'created_at', 'updated_at', 'salt', 'parent_name', 'position', 'theme_id']);
  assert.ok(listFolders(db).every((f) => f.parent === null));
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'share_links'").all() as { name: string }[]).map((r) => r.name);
  for (const name of ['share_links_artifact', 'share_links_project']) assert.ok(indexes.includes(name), name);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(listLinks(db, A1).map((l) => l.id), ['L2', 'L1'], 'ordre created_at DESC, rowid DESC inchangé');

  // Exactement une cible.
  assert.throws(() => db.prepare("INSERT INTO share_links (id, token_hash, token_enc, created_at) VALUES ('X', 'h1', 'e', 'now')").run(), /CHECK/);
  upsertProject(db, 'client', {});
  assert.throws(() => db.prepare(`INSERT INTO share_links (id, artifact_id, project_name, token_hash, token_enc, created_at) VALUES ('Y', '${A1}', 'client', 'h2', 'e', 'now')`).run(), /CHECK/);
  // Clés étrangères toujours actives : artifact ou dossier inconnu refusé, suppression en cascade.
  assert.throws(() => db.prepare("INSERT INTO share_links (id, artifact_id, token_hash, token_enc, created_at) VALUES ('Z', 'inconnu', 'h3', 'e', 'now')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO share_links (id, project_name, token_hash, token_enc, created_at) VALUES ('W', 'inconnu', 'h4', 'e', 'now')").run(), /FOREIGN KEY/);
  deleteArtifact(db, 'A2');
  assert.equal(getLink(db, 'L3'), undefined, 'cascade à la suppression de l’artifact');
  db.close();

  const again = openDb(file);
  assert.deepEqual(snapshot(again), rows.filter((r) => r.id !== 'L3'), 'seconde ouverture : rien ne change');
  assert.equal(again.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'share_links%' AND type = 'table'").get()!.n, 1);
  again.close();
});

test('après migration, les liens d’artifact existants fonctionnent : échange, compteur, révocation', async () => {
  const { file, dataDir, tokens } = await prodDb();
  const db = openDb(file);
  const cfg = testConfig(dataDir);
  const content = createContentApp({ db, cfg, keys: deriveKeys(SECRET), codeLimiter: new RateLimiter(codeLimiterOptions) });
  const ua = { 'user-agent': 'Mozilla/5.0 Safari/605', 'x-forwarded-for': '203.0.113.9' };
  const share = await content.request(`/share/${tokens[0]}`, { headers: ua });
  assert.equal(share.status, 302);
  assert.equal(share.headers.get('location'), '/a/lien');
  const cookie = share.headers.getSetCookie().map((l) => l.split(';')[0]).join('; ');
  const entry = await content.request('/a/lien', { headers: { ...ua, cookie } });
  assert.equal(entry.status, 302);
  assert.equal((await content.request(entry.headers.get('location')!)).status, 200);
  assert.equal(getLink(db, 'L1')!.open_count, 8);
  assert.equal((await content.request(`/share/${tokens[1]}`)).status, 404, 'lien déjà révoqué avant migration');
  assert.equal(revokeLink(db, A1, 'L1'), true);
  assert.equal((await content.request(`/share/${tokens[0]}`)).status, 404);
  db.close();
});

test('migration : base neuve, puis réouverture sans effet', async () => {
  const file = join(await tempDataDir(), 'neuve.sqlite');
  openDb(file).close();
  const db = openDb(file);
  assert.ok(columns(db, 'share_links').some((c) => c.name === 'project_name'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

function seed(db: Db, slug: string, project: string | null, visibility: 'private' | 'public' = 'private') {
  return insertArtifactWithVersion(db, { id: newId(), slug, title: slug, kind: 'html', visibility, code_hash: null, project },
    { id: newId(), entry_path: 'index.html', original_name: 'a.html', size_bytes: 1, file_count: 1 });
}

test('projets : fiche créée à la volée, liste avec visibilité et privés, dossiers vides conservés', () => {
  const db = openDb(':memory:');
  seed(db, 'a', 'client');
  seed(db, 'b', 'client', 'public');
  seed(db, 'c', null);
  assert.equal(getProject(db, 'client'), undefined, 'sans fiche : privé implicite');
  assert.deepEqual(listProjects(db), [{ name: 'client', count: 2 }, { name: null, count: 1 }], 'liste historique inchangée');
  assert.deepEqual(listFolders(db).map((p) => ({ ...p })), [
    { name: 'client', count: 2, privateCount: 1, visibility: 'private', title: null, parent: null, position: null },
    { name: null, count: 1, privateCount: 1, visibility: 'private', title: null, parent: null, position: null },
  ]);
  const p = upsertProject(db, 'client', { title: 'Client', visibility: 'link' });
  assert.equal(p.visibility, 'link');
  assert.equal(p.access_epoch, 1);
  upsertProject(db, 'vide', { description: 'Rien encore' });
  const list = listFolders(db);
  assert.deepEqual(list.map((x) => [x.name, x.count, x.visibility, x.title]), [['client', 2, 'link', 'Client'], ['vide', 0, 'private', null], [null, 1, 'private', null]]);
});

test('projets : artifacts les plus récents d’un projet (ou sans projet), limités, du plus récent au plus ancien', () => {
  const db = openDb(':memory:');
  const at = (id: string, iso: string) => db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(iso, id);
  const xs = ['a', 'b', 'c', 'd', 'e'].map((s, i) => {
    const a = seed(db, s, 'client');
    at(a.id, `2026-01-0${i + 1}T00:00:00.000Z`);
    return a;
  });
  const loose = seed(db, 'z', null);
  seed(db, 'y', 'autre');
  assert.deepEqual(recentProjectArtifacts(db, 'client', 4).map((a) => a.slug), ['e', 'd', 'c', 'b']);
  assert.deepEqual(recentProjectArtifacts(db, 'client', 10).map((a) => a.id), [...xs].reverse().map((a) => a.id));
  assert.deepEqual(recentProjectArtifacts(db, null, 4).map((a) => a.id), [loose.id]);
  assert.deepEqual(recentProjectArtifacts(db, 'vide', 4), []);
});

test('projets : epoch, ordre, renommage (liens suivis), suppression de la fiche seule', () => {
  const db = openDb(':memory:');
  const a = seed(db, 'a', 'client');
  const b = seed(db, 'b', 'client');
  const c = seed(db, 'c', 'client');
  seed(db, 'x', 'autre');
  upsertProject(db, 'client', { visibility: 'public' });
  assert.equal(upsertProject(db, 'client', { visibility: 'link' }, true).access_epoch, 2);
  setProjectOrder(db, 'client', [b.id, c.id, a.id]);
  assert.deepEqual(listFolderArtifacts(db, 'client').map((x) => x.slug), ['b', 'c', 'a']);
  // Un artifact sorti du dossier perd sa place ; un nouvel arrivant (sans place) passe en tête.
  updateArtifact(db, c.id, { project: 'autre' }, false);
  assert.equal(listFolderArtifacts(db, 'autre').find((x) => x.id === c.id)!.project_position, null);
  seed(db, 'd', 'client');
  assert.deepEqual(listFolderArtifacts(db, 'client').map((x) => x.slug), ['d', 'b', 'a']);

  const link = insertLink(db, { id: newId(), project_name: 'client', token_hash: 'h', token_enc: 'e', label: null, expires_at: null });
  assert.equal(link.artifact_id, null);
  assert.deepEqual(listFolderLinks(db, 'client').map((l) => l.id), [link.id]);
  assert.deepEqual(listLinks(db, a.id), [], 'un lien de dossier n’apparaît jamais comme lien d’artifact');
  assert.equal(revokeLink(db, a.id, link.id), false, 'révocation par la mauvaise cible refusée');

  renameProject(db, 'client', 'client-2026');
  assert.equal(getProject(db, 'client'), undefined);
  assert.equal(getProject(db, 'client-2026')!.visibility, 'link');
  assert.equal(getLink(db, link.id)!.project_name, 'client-2026');
  assert.deepEqual(listFolderArtifacts(db, 'client-2026').map((x) => x.slug), ['d', 'b', 'a']);
  assert.equal(revokeFolderLink(db, 'client-2026', link.id), true);

  deleteProject(db, 'client-2026');
  assert.equal(getProject(db, 'client-2026'), undefined);
  assert.equal(getLink(db, link.id), undefined, 'liens du dossier supprimés avec la fiche');
  assert.equal(listFolderArtifacts(db, 'client-2026').length, 3, 'les artifacts restent');
});

test('migration : sel ajouté aux fiches existantes (aléatoire, distinct), idempotent', async () => {
  const file = join(await tempDataDir(), 'fiches.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec(PROD_SCHEMA);
  // Fiches créées par la première version des dossiers (sans sel).
  raw.exec(`CREATE TABLE projects (name TEXT PRIMARY KEY, title TEXT, description TEXT,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','code','link','public')), code_hash TEXT,
    access_epoch INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO projects (name, created_at, updated_at) VALUES ('a', 'x', 'x'), ('b', 'x', 'x');`);
  raw.close();
  const db = openDb(file);
  const salts = (db.prepare('SELECT salt FROM projects ORDER BY name').all() as { salt: string }[]).map((r) => r.salt);
  assert.equal(salts.length, 2);
  for (const salt of salts) assert.match(salt, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(salts[0], salts[1]);
  db.close();
  const again = openDb(file);
  assert.deepEqual((again.prepare('SELECT salt FROM projects ORDER BY name').all() as { salt: string }[]).map((r) => r.salt), salts, 'réouverture : sels inchangés');
  again.close();
});

test('migration : lien orphelin détecté avant la copie, message clair, base inchangée', async () => {
  const file = join(await tempDataDir(), 'orphelin.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec(PROD_SCHEMA);
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec("INSERT INTO share_links (id, artifact_id, token_hash, token_enc, created_at) VALUES ('L9', 'artifact-disparu', 'h', 'e', 'now')");
  raw.close();
  assert.throws(() => openDb(file), /share_links.*1 orphan link\(s\)/);
  const check = new DatabaseSync(file);
  assert.equal((check.prepare('PRAGMA table_info(share_links)').all() as { name: string }[]).some((c) => c.name === 'project_name'), false, 'aucune reconstruction partielle');
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM share_links WHERE id = 'L9'").get()!.n, 1);
  check.close();
});

test('fiche : sel aléatoire à la création, conservé par les mises à jour, nouveau après suppression', () => {
  const db = openDb(':memory:');
  const a = upsertProject(db, 'x', {});
  assert.match(a.salt, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(upsertProject(db, 'x', { title: 't' }, true).salt, a.salt);
  deleteProject(db, 'x');
  assert.notEqual(upsertProject(db, 'x', {}).salt, a.salt);
});

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
