import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret, sha256 } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { newId } from '../src/ids.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { activateVersion, getVersion, insertArtifactWithVersion } from '../src/repo.ts';
import { ensureDataDirs, pruneVersions, thumbPath, versionDir } from '../src/storage.ts';
import { sniffImage, THUMB_MAX_BYTES } from '../src/thumbs.ts';
import { setCookies, setup } from './harness.ts';
import { tempDataDir } from './helpers.ts';

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';
const TOKEN = 'T'.repeat(43);

// Seuls les octets magiques comptent : le serveur ne décode jamais l'image.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function thumbSetup() {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), apiTokenHash: sha256(TOKEN) });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = setCookies(res);
  const authed = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, 'x-csrf-token': csrfToken, ...extra });
  const form = new FormData();
  form.set('file', new File(['<p>un</p>'], 'a.html'));
  form.set('slug', 'vignette');
  const art = (await (await admin.request('/api/artifacts', { method: 'POST', headers: authed(), body: form })).json()) as { id: string; version: { id: string } };
  const put = (body: BodyInit, type: string, versionId = art.version.id, id = art.id, headers: Record<string, string> = authed({ 'content-type': type })) =>
    admin.request(`/api/artifacts/${id}/versions/${versionId}/thumbnail`, { method: 'PUT', headers, body });
  const get = (path: string, headers: Record<string, string> = {}) => admin.request(path, { headers: { cookie, ...headers } });
  const replace = async (name: string, data: string) => {
    const f = new FormData();
    f.set('file', new File([data], name));
    return (await (await admin.request(`/api/artifacts/${art.id}/content`, { method: 'PUT', headers: authed(), body: f })).json()) as { version: { id: string } };
  };
  return { ...h, admin, art, authed, put, get, replace, cookie };
}

const files = async (dir: string) => (existsSync(dir) ? (await readdir(dir, { recursive: true })).sort() : []);

test('sniffImage : webp, png, jpeg reconnus ; svg, gif et octets tronqués refusés', () => {
  assert.equal(sniffImage(WEBP), 'webp');
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(JPEG), 'jpeg');
  assert.equal(sniffImage(SVG), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WAVE')), null);
  assert.equal(sniffImage(PNG.subarray(0, 4)), null);
  assert.equal(THUMB_MAX_BYTES, 2 * 1024 * 1024);
});

test('ensureDataDirs crée thumbs/ à côté de files/, jamais dedans', async () => {
  const dir = await tempDataDir();
  await ensureDataDirs(dir);
  assert.ok((await stat(join(dir, 'thumbs'))).isDirectory());
  const p = thumbPath(dir, 'A', 'V', 'webp');
  assert.equal(p, join(dir, 'thumbs', 'A', 'V.webp'));
  assert.equal(thumbPath(dir, 'A', 'V', 'jpeg'), join(dir, 'thumbs', 'A', 'V.jpg'));
  assert.ok(!p.startsWith(join(dir, 'files')));
});

test('PUT puis GET : image servie telle quelle depuis l’origine admin, cache privé, ETag', async () => {
  const t = await thumbSetup();
  const res = await t.put(WEBP, 'image/webp');
  assert.equal(res.status, 200);
  const { thumbnailUrl } = (await res.json()) as { thumbnailUrl: string };
  assert.match(thumbnailUrl, new RegExp(`^/api/artifacts/${t.art.id}/versions/${t.art.version.id}/thumbnail\\?v=`));
  assert.deepEqual(await readFile(thumbPath(t.cfg.dataDir, t.art.id, t.art.version.id, 'webp')), WEBP);

  const list = (await (await t.get('/api/artifacts')).json()) as { id: string; thumbnailUrl: string | null }[];
  const url = list.find((a) => a.id === t.art.id)!.thumbnailUrl!;
  assert.match(url, new RegExp(`^/api/artifacts/${t.art.id}/thumbnail\\?v=${t.art.version.id}\\.[0-9a-z]+$`));

  const img = await t.get(url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.equal(img.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy')!, /^default-src 'self'/);
  const etag = img.headers.get('etag')!;
  assert.equal(etag, `"${url.split('?v=')[1]}"`);
  assert.ok(etag.includes(t.art.version.id));
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), WEBP);
  assert.equal((await t.get(url, { 'if-none-match': etag })).status, 304);

  // Version précise (historique).
  const byVersion = await t.get(`/api/artifacts/${t.art.id}/versions/${t.art.version.id}/thumbnail`);
  assert.equal(byVersion.status, 200);
  assert.equal(byVersion.headers.get('content-type'), 'image/webp');
});

test('PUT remplace : nouveau format, ancien fichier supprimé, nouvelle URL', async () => {
  const t = await thumbSetup();
  const first = ((await (await t.put(WEBP, 'image/webp')).json()) as { thumbnailUrl: string }).thumbnailUrl;
  await new Promise((r) => setTimeout(r, 5));
  const res = await t.put(JPEG, 'image/jpeg; charset=binary');
  assert.equal(res.status, 200);
  const second = ((await res.json()) as { thumbnailUrl: string }).thumbnailUrl;
  assert.notEqual(second, first);
  assert.equal(existsSync(thumbPath(t.cfg.dataDir, t.art.id, t.art.version.id, 'webp')), false);
  const img = await t.get(`/api/artifacts/${t.art.id}/thumbnail`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);
  assert.deepEqual(await files(join(t.cfg.dataDir, 'thumbs')), [t.art.id, join(t.art.id, `${t.art.version.id}.jpg`)]);
});

test('415 : SVG, type non pris en charge, octets qui ne correspondent pas au type annoncé ; rien d’écrit', async () => {
  const t = await thumbSetup();
  for (const [body, type] of [[SVG, 'image/svg+xml'], [SVG, 'image/png'], [JPEG, 'image/png'], [PNG, 'image/webp'], [PNG, 'application/octet-stream'], [PNG, '']] as const) {
    const res = await t.put(body, type);
    assert.equal(res.status, 415, `${type}`);
    const err = (await res.json()) as { code: string; error: string };
    assert.equal(err.code, 'thumb_unsupported');
    assert.match(err.error, /WebP, PNG or JPEG/);
  }
  assert.deepEqual(await files(join(t.cfg.dataDir, 'thumbs')), []);
  assert.deepEqual(await files(join(t.cfg.dataDir, 'tmp')), []);
  assert.equal((await t.get(`/api/artifacts/${t.art.id}/thumbnail`)).status, 404);
});

test('413 : au-delà de 2 Mio, coupé pendant le flux (avec ou sans Content-Length), rien d’écrit', async () => {
  const t = await thumbSetup();
  const big = Buffer.concat([PNG, Buffer.alloc(THUMB_MAX_BYTES)]);
  assert.equal((await t.put(big, 'image/png')).status, 413);
  const declared = await t.put(PNG, 'image/png', undefined, undefined, t.authed({ 'content-type': 'image/png', 'content-length': String(THUMB_MAX_BYTES + 1) }));
  assert.equal(declared.status, 413);
  // Flux sans longueur annoncée, envoyé par morceaux.
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent === 0) ctrl.enqueue(new Uint8Array(PNG));
      else if (sent > THUMB_MAX_BYTES + 512 * 1024) return ctrl.close();
      else ctrl.enqueue(new Uint8Array(256 * 1024));
      sent += sent === 0 ? PNG.length : 256 * 1024;
    },
  });
  const res = await t.admin.request(`/api/artifacts/${t.art.id}/versions/${t.art.version.id}/thumbnail`, {
    method: 'PUT', headers: t.authed({ 'content-type': 'image/png' }), body: stream, duplex: 'half',
  } as RequestInit);
  assert.equal(res.status, 413);
  assert.deepEqual(await files(join(t.cfg.dataDir, 'thumbs')), []);
  assert.deepEqual(await files(join(t.cfg.dataDir, 'tmp')), []);
  // Exactement 2 Mio : accepté.
  assert.equal((await t.put(Buffer.concat([PNG, Buffer.alloc(THUMB_MAX_BYTES - PNG.length)]), 'image/png')).status, 200);
});

test('404 : artifact inconnu, version d’un autre artifact, aucune miniature', async () => {
  const t = await thumbSetup();
  assert.equal((await t.put(PNG, 'image/png', t.art.version.id, 'inconnu')).status, 404);
  assert.equal((await t.put(PNG, 'image/png', 'inconnue')).status, 404);
  const other = seedOther(t);
  assert.equal((await t.put(PNG, 'image/png', other.current_version_id!)).status, 404);
  assert.equal((await t.get(`/api/artifacts/${t.art.id}/thumbnail`)).status, 404);
  assert.equal((await t.get(`/api/artifacts/${t.art.id}/versions/${other.current_version_id}/thumbnail`)).status, 404);
  assert.equal((await t.get('/api/artifacts/inconnu/thumbnail')).status, 404);
  const dto = (await (await t.get(`/api/artifacts/${t.art.id}`)).json()) as { thumbnailUrl: string | null };
  assert.equal(dto.thumbnailUrl, null);
  assert.deepEqual(await files(join(t.cfg.dataDir, 'thumbs')), []);
});

function seedOther(t: Awaited<ReturnType<typeof thumbSetup>>) {
  return insertArtifactWithVersion(t.db, { id: newId(), slug: 'autre', title: 'Autre', kind: 'html', visibility: 'private', code_hash: null },
    { id: newId(), entry_path: 'index.html', original_name: 'b.html', size_bytes: 1, file_count: 1 });
}

test('authentification : CSRF exigé avec le cookie, jeton Bearer accepté, lecture sans session refusée', async () => {
  const t = await thumbSetup();
  const noCsrf = await t.put(PNG, 'image/png', undefined, undefined, { cookie: t.cookie, origin: ORIGIN, 'content-type': 'image/png' });
  assert.equal(noCsrf.status, 403);
  const viaToken = await t.put(PNG, 'image/png', undefined, undefined, { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/png' });
  assert.equal(viaToken.status, 200);
  assert.equal((await t.admin.request(`/api/artifacts/${t.art.id}/thumbnail`)).status, 401);
});

test('nouvelle version : la carte n’a plus de miniature ; l’historique garde celle de l’ancienne version', async () => {
  const t = await thumbSetup();
  await t.put(WEBP, 'image/webp');
  const v2 = await t.replace('b.html', '<p>deux</p>');
  const dto = (await (await t.get(`/api/artifacts/${t.art.id}`)).json()) as { thumbnailUrl: string | null; version: { id: string } };
  assert.equal(dto.thumbnailUrl, null);
  assert.equal(dto.version.id, v2.version.id);
  const versions = (await (await t.get(`/api/artifacts/${t.art.id}/versions`)).json()) as { id: string; thumbnailUrl: string | null }[];
  assert.equal(versions.find((v) => v.id === v2.version.id)!.thumbnailUrl, null);
  assert.match(versions.find((v) => v.id === t.art.version.id)!.thumbnailUrl!, new RegExp(`/versions/${t.art.version.id}/thumbnail\\?v=`));
});

test('le serveur de contenu ne sert jamais les miniatures', async () => {
  const t = await thumbSetup();
  await t.put(PNG, 'image/png');
  const art = getVersion(t.db, t.art.version.id)!;
  assert.ok(!thumbPath(t.cfg.dataDir, t.art.id, art.id, 'png').startsWith(versionDir(t.cfg.dataDir, t.art.id, art.id)));
  for (const path of [`/thumbs/${t.art.id}/${art.id}.png`, `/a/vignette/../../thumbs/${t.art.id}/${art.id}.png`, `/api/artifacts/${t.art.id}/thumbnail`]) {
    const res = await t.content.request(path, { headers: { cookie: t.cookie } });
    assert.notEqual(res.headers.get('content-type'), 'image/png', path);
  }
});

test('DELETE de l’artifact supprime ses miniatures', async () => {
  const t = await thumbSetup();
  await t.put(PNG, 'image/png');
  assert.equal((await t.admin.request(`/api/artifacts/${t.art.id}`, { method: 'DELETE', headers: t.authed() })).status, 200);
  assert.equal(existsSync(join(t.cfg.dataDir, 'thumbs', t.art.id)), false);
});

test('élagage : la miniature d’une version élaguée est supprimée, celles des versions gardées restent', async () => {
  const dataDir = await tempDataDir();
  await ensureDataDirs(dataDir);
  const db = openDb(':memory:');
  const art = insertArtifactWithVersion(db, { id: newId(), slug: 's', title: 's', kind: 'site', visibility: 'private', code_hash: null },
    { id: newId(), entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 });
  const ids = [art.current_version_id!];
  for (let i = 0; i < 11; i++) {
    const id = newId();
    activateVersion(db, art.id, { id, entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 }, 'site');
    ids.push(id);
  }
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(dataDir, 'thumbs', art.id), { recursive: true });
  for (const id of ids) await writeFile(thumbPath(dataDir, art.id, id, 'webp'), WEBP);
  await pruneVersions(db, dataDir, art.id);
  assert.equal(existsSync(thumbPath(dataDir, art.id, ids[0], 'webp')), false);
  assert.equal(existsSync(thumbPath(dataDir, art.id, ids[1], 'webp')), false);
  for (const id of ids.slice(2)) assert.equal(existsSync(thumbPath(dataDir, art.id, id, 'webp')), true);
});

test('migration : colonnes de miniature ajoutées à une base existante, idempotente, données intactes', async () => {
  const dir = await tempDataDir();
  const file = join(dir, 'prev.db');
  const prev = new DatabaseSync(file);
  prev.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('html','markdown','pdf','json','site')),
    visibility TEXT NOT NULL CHECK (visibility IN ('private','code','link','public')),
    code_hash TEXT, access_epoch INTEGER NOT NULL DEFAULT 1, current_version_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, memory_storage INTEGER NOT NULL DEFAULT 0, project TEXT, pinned_at TEXT);
  CREATE TABLE versions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    entry_path TEXT NOT NULL, original_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, created_at TEXT NOT NULL,
    kind TEXT, number INTEGER);
  INSERT INTO artifacts VALUES ('a1','s','S','html','public',NULL,1,'v1','2026-01-01','2026-01-01',0,NULL,NULL);
  INSERT INTO versions VALUES ('v1','a1','index.html','a.html',1,1,'2026-01-01','html',1);`);
  prev.close();
  const db1 = openDb(file);
  const v = getVersion(db1, 'v1')!;
  assert.equal(v.thumb_type, null);
  assert.equal(v.thumb_at, null);
  assert.equal(v.number, 1);
  db1.close();
  const db2 = openDb(file);
  const cols = (db2.prepare('PRAGMA table_info(versions)').all() as { name: string }[]).filter((c) => c.name.startsWith('thumb_'));
  assert.deepEqual(cols.map((c) => c.name).sort(), ['thumb_at', 'thumb_type']);
  db2.close();
});

test('PUT concurrents de formats différents : la base et le disque restent cohérents', async () => {
  const t = await thumbSetup();
  const bodies = [WEBP, PNG, JPEG, PNG, WEBP, JPEG, PNG, WEBP];
  const types = { webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg' } as const;
  const kinds = bodies.map((b) => (b === WEBP ? 'webp' : b === PNG ? 'png' : 'jpeg'));
  const res = await Promise.all(bodies.map((b, i) => t.put(b, types[kinds[i]])));
  assert.deepEqual(res.map((r) => r.status), bodies.map(() => 200));
  const v = getVersion(t.db, t.art.version.id)!;
  // Une seule image sur disque, celle que la base annonce, et elle est servie.
  assert.deepEqual(await files(join(t.cfg.dataDir, 'thumbs', t.art.id)), [thumbPath(t.cfg.dataDir, t.art.id, v.id, v.thumb_type!).split('/').pop()]);
  const img = await t.get(`/api/artifacts/${t.art.id}/thumbnail`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), types[v.thumb_type!]);
  assert.deepEqual(await files(join(t.cfg.dataDir, 'tmp')), []);
});

test('restauration : thumbnailUrl passe à la miniature de la version restaurée', async () => {
  const t = await thumbSetup();
  await t.put(WEBP, 'image/webp');
  const v1 = t.art.version.id;
  const v2 = (await t.replace('b.html', '<p>deux</p>')).version.id;
  await t.put(PNG, 'image/png', v2);
  const before = (await (await t.get(`/api/artifacts/${t.art.id}`)).json()) as { thumbnailUrl: string };
  assert.match(before.thumbnailUrl, new RegExp(`\\?v=${v2}\\.`));
  const res = await t.admin.request(`/api/artifacts/${t.art.id}/versions/${v1}/restore`, { method: 'POST', headers: t.authed() });
  assert.equal(res.status, 200);
  const dto = (await res.json()) as { thumbnailUrl: string };
  assert.match(dto.thumbnailUrl, new RegExp(`\\?v=${v1}\\.`));
  const img = await t.get(dto.thumbnailUrl);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), WEBP);
});
