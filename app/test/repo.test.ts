import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { newId } from '../src/ids.ts';
import {
  activateVersion, bumpEpoch, deleteArtifact, getArtifact, getArtifactBySlug, getLinkByHash, getSession,
  getTags, insertArtifactWithVersion, insertLink, insertSession, listArtifacts, listLinks, listProjects, listTagCounts, listVersions, restoreVersion, revokeLink, setTags,
  setPinned, updateArtifact, type Kind,
} from '../src/repo.ts';
import { pruneVersionRows, pruneVersions, versionDir } from '../src/storage.ts';
import { tempDataDir } from './helpers.ts';

function seed(db: ReturnType<typeof openDb>, slug = 'demo') {
  return insertArtifactWithVersion(
    db,
    { id: newId(), slug, title: 'Démo', kind: 'html', visibility: 'private', code_hash: null },
    { id: newId(), entry_path: 'index.html', original_name: 'demo.html', size_bytes: 10, file_count: 1 },
  );
}

test('insertArtifactWithVersion active la version', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  assert.equal(art.access_epoch, 1);
  assert.ok(art.current_version_id);
  assert.equal(getArtifactBySlug(db, 'demo')?.id, art.id);
  assert.equal(listArtifacts(db).length, 1);
});

test('le slug est unique', () => {
  const db = openDb(':memory:');
  seed(db);
  assert.throws(() => seed(db), /UNIQUE/);
});

test('updateArtifact et bumpEpoch', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  const up = updateArtifact(db, art.id, { title: 'Nouveau', visibility: 'public' }, true);
  assert.equal(up.title, 'Nouveau');
  assert.equal(up.visibility, 'public');
  assert.equal(up.access_epoch, 2);
  bumpEpoch(db, art.id);
  assert.equal(getArtifact(db, art.id)?.access_epoch, 3);
});

test('activateVersion bascule current_version_id et kind', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  const v2 = newId();
  activateVersion(db, art.id, { id: v2, entry_path: 'index.html', original_name: 's.zip', size_bytes: 5, file_count: 3 }, 'site');
  const after = getArtifact(db, art.id)!;
  assert.equal(after.current_version_id, v2);
  assert.equal(after.kind, 'site');
  assert.equal(listVersions(db, art.id).length, 2);
});

test('liens : insertion, recherche par hash, révocation', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  const link = insertLink(db, { id: newId(), artifact_id: art.id, token_hash: 'h1', token_enc: 'e1', label: null, expires_at: null });
  assert.equal(getLinkByHash(db, 'h1')?.id, link.id);
  assert.equal(revokeLink(db, art.id, link.id), true);
  assert.ok(listLinks(db, art.id)[0].revoked_at);
  assert.equal(revokeLink(db, 'other', link.id), false);
});

test('sessions expirées ignorées', () => {
  const db = openDb(':memory:');
  insertSession(db, { id_hash: 'live', csrf_token: 'c', expires_at: new Date(Date.now() + 60_000).toISOString() });
  insertSession(db, { id_hash: 'dead', csrf_token: 'c', expires_at: new Date(Date.now() - 1).toISOString() });
  assert.ok(getSession(db, 'live'));
  assert.equal(getSession(db, 'dead'), undefined);
});

test('deleteArtifact supprime en cascade', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  insertLink(db, { id: newId(), artifact_id: art.id, token_hash: 'h', token_enc: 'e', label: null, expires_at: null });
  deleteArtifact(db, art.id);
  assert.equal(getArtifact(db, art.id), undefined);
  assert.equal(listVersions(db, art.id).length, 0);
  assert.equal(listLinks(db, art.id).length, 0);
});

// Ajoute `n` versions (numéros suivants) de ce type, avec fichiers sur disque ; renvoie leurs ids.
async function addVersions(db: ReturnType<typeof openDb>, dataDir: string, artId: string, kind: Kind, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newId();
    activateVersion(db, artId, { id, entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 }, kind);
    await mkdir(versionDir(dataDir, artId, id), { recursive: true });
    await writeFile(join(versionDir(dataDir, artId, id), 'index.html'), 'x');
    ids.push(id);
  }
  return ids;
}
const numbers = (db: ReturnType<typeof openDb>, artId: string) => listVersions(db, artId).map((v) => v.number).reverse();
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('numéros de version : par artifact, croissants, assignés à la création', () => {
  const db = openDb(':memory:');
  const a = seed(db, 'a');
  const b = seed(db, 'b');
  activateVersion(db, a.id, { id: newId(), entry_path: 'i', original_name: 'x', size_bytes: 1, file_count: 1 }, 'site');
  assert.deepEqual(numbers(db, a.id), [1, 2]);
  assert.deepEqual(numbers(db, b.id), [1]);
  assert.deepEqual(listVersions(db, a.id).map((v) => v.kind), ['site', 'html']);
});

test('rétention : 15 versions html sont toutes conservées', async () => {
  const dataDir = await tempDataDir();
  const db = openDb(':memory:');
  const art = seed(db);
  await addVersions(db, dataDir, art.id, 'html', 14);
  await pruneVersions(db, dataDir, art.id);
  assert.deepEqual(numbers(db, art.id), range(1, 15));
});

test('rétention : markdown conservé pour toujours', async () => {
  const dataDir = await tempDataDir();
  const db = openDb(':memory:');
  const art = seed(db);
  await addVersions(db, dataDir, art.id, 'markdown', 14);
  await pruneVersions(db, dataDir, art.id);
  assert.equal(listVersions(db, art.id).length, 15);
});

test('rétention : 15 versions site → 10 conservées dont la courante, fichiers supprimés', async () => {
  const dataDir = await tempDataDir();
  const db = openDb(':memory:');
  const art = insertArtifactWithVersion(db, { id: newId(), slug: 's', title: 's', kind: 'site', visibility: 'private', code_hash: null },
    { id: newId(), entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 });
  const ids = [art.current_version_id!, ...(await addVersions(db, dataDir, art.id, 'site', 14))];
  await pruneVersions(db, dataDir, art.id);
  assert.deepEqual(numbers(db, art.id), range(6, 15));
  assert.equal(getArtifact(db, art.id)!.current_version_id, ids[14]);
  assert.equal(existsSync(versionDir(dataDir, art.id, ids[0])), false);
  assert.equal(existsSync(versionDir(dataDir, art.id, ids[14])), true);
});

test('rétention : historique mixte, seuls les types élagués sont limités', async () => {
  const dataDir = await tempDataDir();
  const db = openDb(':memory:');
  const art = seed(db); // v1 html
  await addVersions(db, dataDir, art.id, 'site', 12); // v2..v13
  await addVersions(db, dataDir, art.id, 'markdown', 2); // v14, v15
  await addVersions(db, dataDir, art.id, 'pdf', 1); // v16 courante
  await pruneVersions(db, dataDir, art.id);
  // 12 site + la pdf courante (compte dans les 10) : la courante + les 9 site les plus récents (v5..v13) ; html/markdown intacts.
  assert.deepEqual(numbers(db, art.id), [1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

test('rétention : la version courante restaurée sur un ancien numéro n’est jamais élaguée', async () => {
  const dataDir = await tempDataDir();
  const db = openDb(':memory:');
  const art = insertArtifactWithVersion(db, { id: newId(), slug: 's', title: 's', kind: 'site', visibility: 'private', code_hash: null },
    { id: newId(), entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 });
  const first = art.current_version_id!;
  await mkdir(versionDir(dataDir, art.id, first), { recursive: true });
  await addVersions(db, dataDir, art.id, 'site', 14);
  assert.ok(restoreVersion(db, art.id, first));
  await pruneVersions(db, dataDir, art.id);
  const nums = numbers(db, art.id);
  assert.equal(nums.length, 10);
  assert.ok(nums.includes(1), 'v1 courante conservée');
  assert.deepEqual(nums.slice(1), range(7, 15));
  assert.equal(existsSync(versionDir(dataDir, art.id, first)), true);
  // Le numéro suivant n'est jamais réutilisé.
  activateVersion(db, art.id, { id: newId(), entry_path: 'i', original_name: 'x', size_bytes: 1, file_count: 1 }, 'site');
  assert.equal(Math.max(...numbers(db, art.id)), 16);
});

test('restoreVersion : kind et version courante, refuse une version étrangère, pas de bump d’epoch', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  const v1 = art.current_version_id!;
  activateVersion(db, art.id, { id: newId(), entry_path: 'i', original_name: 'x', size_bytes: 1, file_count: 1 }, 'site');
  const other = seed(db, 'other');
  assert.equal(restoreVersion(db, art.id, other.current_version_id!), undefined);
  assert.ok(restoreVersion(db, art.id, v1));
  const after = getArtifact(db, art.id)!;
  assert.equal(after.current_version_id, v1);
  assert.equal(after.kind, 'html');
  assert.equal(after.access_epoch, art.access_epoch);
});

test('migration : versions reçoivent kind et number, idempotent, base avec 3 versions', async () => {
  const dir = await tempDataDir();
  const file = join(dir, 'prev.db');
  const prev = new DatabaseSync(file);
  prev.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('html','markdown','pdf','json','site')),
    visibility TEXT NOT NULL CHECK (visibility IN ('private','code','link','public')),
    code_hash TEXT, access_epoch INTEGER NOT NULL DEFAULT 1, current_version_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, memory_storage INTEGER NOT NULL DEFAULT 0, project TEXT);
  CREATE TABLE versions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    entry_path TEXT NOT NULL, original_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, created_at TEXT NOT NULL);
  INSERT INTO artifacts VALUES ('a1','s','S','site','public',NULL,1,'v3','2026-01-01','2026-01-03',0,NULL);
  INSERT INTO versions VALUES ('v2','a1','index.html','b',1,1,'2026-01-02');
  INSERT INTO versions VALUES ('v3','a1','index.html','c',1,1,'2026-01-03');
  INSERT INTO versions VALUES ('v1','a1','index.html','a',1,1,'2026-01-01');`);
  prev.close();
  const check = (db: ReturnType<typeof openDb>) => {
    const rows = db.prepare('SELECT id, number, kind FROM versions ORDER BY number').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ id: 'v1', number: 1, kind: 'site' }, { id: 'v2', number: 2, kind: 'site' }, { id: 'v3', number: 3, kind: 'site' }]);
  };
  const db1 = openDb(file);
  check(db1);
  assert.throws(() => db1.prepare("INSERT INTO versions (id, artifact_id, entry_path, original_name, size_bytes, file_count, created_at, kind, number) VALUES ('d','a1','i','x',1,1,'2026','site',2)").run(), /UNIQUE/);
  activateVersion(db1, 'a1', { id: newId(), entry_path: 'i', original_name: 'x', size_bytes: 1, file_count: 1 }, 'html');
  db1.close();
  const db2 = openDb(file);
  assert.deepEqual(numbers(db2, 'a1'), [1, 2, 3, 4]);
  assert.equal(db2.prepare('PRAGMA table_info(versions)').all().filter((c) => ['kind', 'number'].includes((c as { name: string }).name)).length, 2);
  db2.close();
});

test('migration : ajoute memory_storage à une ancienne base, sans effet au second passage', async () => {
  const dir = await tempDataDir();
  const file = join(dir, 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('html','markdown','pdf','json','site')),
    visibility TEXT NOT NULL CHECK (visibility IN ('private','code','link','public')),
    code_hash TEXT, access_epoch INTEGER NOT NULL DEFAULT 1, current_version_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.exec("INSERT INTO artifacts (id, slug, title, kind, visibility, created_at, updated_at) VALUES ('a1','vieux','Vieux','html','public','2026-01-01','2026-01-01')");
  old.close();
  const db = openDb(file);
  assert.equal(getArtifact(db, 'a1')?.memory_storage, 0);
  db.close();
  const again = openDb(file);
  assert.equal(getArtifact(again, 'a1')?.memory_storage, 0);
  const cols = (again.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]).filter((c) => c.name === 'memory_storage');
  assert.equal(cols.length, 1);
});

test('updateArtifact accepte memory_storage', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  assert.equal(art.memory_storage, 0);
  assert.equal(updateArtifact(db, art.id, { memory_storage: 1 }, false).memory_storage, 1);
});

const OLD_SCHEMA = `
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('html','markdown','pdf','json','site')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private','code','link','public')),
  code_hash TEXT, access_epoch INTEGER NOT NULL DEFAULT 1, current_version_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, memory_storage INTEGER NOT NULL DEFAULT 0
);
INSERT INTO artifacts (id, slug, title, kind, visibility, created_at, updated_at, memory_storage)
VALUES ('old1', 'ancien', 'Ancien', 'html', 'public', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1);
`;

test('migration : base antérieure aux projets et tags, idempotente', async () => {
  const dir = await tempDataDir();
  const file = join(dir, 'old.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(OLD_SCHEMA);
  legacy.close();

  const check = (db: ReturnType<typeof openDb>) => {
    const a = getArtifact(db, 'old1')!;
    assert.equal(a.slug, 'ancien');
    assert.equal(a.memory_storage, 1);
    assert.equal(a.project, null);
    assert.deepEqual(getTags(db, 'old1'), []);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'artifact_tags'").get() as { n: number }).n, 1);
  };
  const db1 = openDb(file);
  check(db1);
  setTags(db1, 'old1', ['x']);
  updateArtifact(db1, 'old1', { project: 'p' }, false);
  db1.close();
  const db2 = openDb(file);
  assert.equal(getArtifact(db2, 'old1')!.project, 'p');
  assert.deepEqual(getTags(db2, 'old1'), ['x']);
  assert.equal(db2.prepare('PRAGMA table_info(artifacts)').all().filter((c) => (c as { name: string }).name === 'project').length, 1);
  db2.close();
});

test('projets, tags, filtres, compteurs et cascade', () => {
  const db = openDb(':memory:');
  const mk = (slug: string, project: string | null, tags: string[]) =>
    insertArtifactWithVersion(db, { id: newId(), slug, title: slug, kind: 'html', visibility: 'private', code_hash: null, project, tags },
      { id: newId(), entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 });
  const a = mk('a', 'acme', ['x', 'y']);
  mk('b', 'acme', ['x']);
  mk('c', 'beta', ['y']);
  mk('d', null, []);
  assert.deepEqual(getTags(db, a.id), ['x', 'y']);
  assert.deepEqual(listArtifacts(db, { project: 'acme' }).map((r) => r.slug).sort(), ['a', 'b']);
  assert.deepEqual(listArtifacts(db, { project: null }).map((r) => r.slug), ['d']);
  assert.deepEqual(listArtifacts(db, { tags: ['x', 'y'] }).map((r) => r.slug), ['a']);
  assert.deepEqual(listArtifacts(db, { project: 'beta', tags: ['x'] }), []);
  assert.deepEqual(listProjects(db), [{ name: 'acme', count: 2 }, { name: 'beta', count: 1 }, { name: null, count: 1 }]);
  assert.deepEqual(listTagCounts(db), [{ name: 'x', count: 2 }, { name: 'y', count: 2 }]);
  setTags(db, a.id, ['z']);
  assert.deepEqual(getTags(db, a.id), ['z']);
  deleteArtifact(db, a.id);
  assert.deepEqual(listTagCounts(db), [{ name: 'x', count: 1 }, { name: 'y', count: 1 }]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM artifact_tags WHERE artifact_id = ?').get(a.id) as { n: number }).n, 0);
});

test('rétention/restauration : la décision et les suppressions sont atomiques, la courante ne devient jamais orpheline', async () => {
  const dataDir = await tempDataDir();
  const db = openDb(':memory:');
  const art = insertArtifactWithVersion(db, { id: newId(), slug: 's', title: 's', kind: 'site', visibility: 'private', code_hash: null },
    { id: newId(), entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 });
  const v1 = art.current_version_id!;
  await mkdir(versionDir(dataDir, art.id, v1), { recursive: true });
  const ids = [v1, ...(await addVersions(db, dataDir, art.id, 'site', 11))]; // v1..v12, v12 courante
  // v2 serait élaguée (hors des 10 plus récentes) : on la restaure juste avant la décision.
  assert.ok(restoreVersion(db, art.id, ids[1]));
  const dirs = pruneVersionRows(db, dataDir, art.id);
  assert.equal(dirs.includes(versionDir(dataDir, art.id, ids[1])), false, 'la courante restaurée survit');
  assert.equal(getArtifact(db, art.id)!.current_version_id, ids[1]);
  assert.ok(listVersions(db, art.id).some((v) => v.id === ids[1]));
  // Les lignes sont déjà supprimées, les dossiers pas encore : restaurer une version élaguée est refusé.
  const gone = ids.find((id) => dirs.includes(versionDir(dataDir, art.id, id)))!;
  assert.equal(restoreVersion(db, art.id, gone), undefined);
  assert.equal(getArtifact(db, art.id)!.current_version_id, ids[1]);
  assert.equal(existsSync(versionDir(dataDir, art.id, gone)), true, 'dossier supprimé seulement après commit');
  await pruneVersions(db, dataDir, art.id);
  assert.equal(existsSync(versionDir(dataDir, art.id, ids[1])), true);
});

test('migration : kind déduit de chaque version quand le kind de l’artifact a changé', async () => {
  const dir = await tempDataDir();
  const file = join(dir, 'kinds.db');
  const prev = new DatabaseSync(file);
  prev.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('html','markdown','pdf','json','site')),
    visibility TEXT NOT NULL CHECK (visibility IN ('private','code','link','public')),
    code_hash TEXT, access_epoch INTEGER NOT NULL DEFAULT 1, current_version_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, memory_storage INTEGER NOT NULL DEFAULT 0, project TEXT);
  CREATE TABLE versions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    entry_path TEXT NOT NULL, original_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, created_at TEXT NOT NULL);
  INSERT INTO artifacts VALUES ('a1','s','S','markdown','public',NULL,1,'v6','2026-01-01','2026-01-06',0,NULL);
  INSERT INTO versions VALUES ('v1','a1','index.html','a.html',1,1,'2026-01-01');
  INSERT INTO versions VALUES ('v2','a1','index.html','Site.ZIP',1,5,'2026-01-02');
  INSERT INTO versions VALUES ('v3','a1','document.pdf','d.pdf',1,1,'2026-01-03');
  INSERT INTO versions VALUES ('v4','a1','index.html','d.json',1,2,'2026-01-04');
  INSERT INTO versions VALUES ('v5','a1','index.html','n.md',1,2,'2026-01-05');
  INSERT INTO versions VALUES ('v6','a1','index.html','weird',1,2,'2026-01-06');`);
  prev.close();
  const db = openDb(file);
  const kinds = db.prepare('SELECT number, kind FROM versions ORDER BY number').all().map((r) => `${r.number}:${r.kind}`);
  assert.deepEqual(kinds, ['1:html', '2:site', '3:pdf', '4:json', '5:markdown', '6:markdown']);
  db.close();
});

test('migration : ajoute pinned_at à une base antérieure aux épingles, idempotente', async () => {
  const dir = await tempDataDir();
  const file = join(dir, 'old-pins.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(OLD_SCHEMA);
  legacy.close();
  const db1 = openDb(file);
  assert.equal(getArtifact(db1, 'old1')!.pinned_at, null);
  setPinned(db1, 'old1', true);
  db1.close();
  const db2 = openDb(file);
  assert.ok(getArtifact(db2, 'old1')!.pinned_at);
  assert.equal(db2.prepare('PRAGMA table_info(artifacts)').all().filter((c) => (c as { name: string }).name === 'pinned_at').length, 1);
  db2.close();
});

test('setPinned : pose et retire pinned_at sans toucher updated_at ni l’époque', () => {
  const db = openDb(':memory:');
  const art = seed(db);
  const pinned = setPinned(db, art.id, true);
  assert.ok(pinned.pinned_at);
  assert.equal(pinned.updated_at, art.updated_at);
  assert.equal(pinned.access_epoch, art.access_epoch);
  assert.equal(setPinned(db, art.id, false).pinned_at, null);
});
