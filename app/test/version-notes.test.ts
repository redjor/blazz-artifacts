import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { tempDataDir } from './helpers.ts';
import { setCookies, setup } from './harness.ts';

// Version notes (design 16): one line saying what changed, set at upload or later, shown in the history and the bar.

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

async function adminSetup() {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), artifactBar: true });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const headers = { cookie: setCookies(res), origin: ORIGIN, 'x-csrf-token': csrfToken };
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    admin.request(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const upload = (method: 'POST' | 'PUT', path: string, name: string, data: string, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', new File([data], name));
    return admin.request(`/api${path}`, { method, headers, body: form });
  };
  return { ...h, call, upload };
}

interface Version { id: string; number: number; message: string | null; current: boolean }

test('note de version : à la publication, à la nouvelle version, modifiée puis effacée', async () => {
  const h = await adminSetup();
  const art = (await (await h.upload('POST', '/artifacts', 'accueil.html', '<p>1</p>', { message: '  Premier jet  ' })).json()) as { id: string; version: { message: string | null } };
  assert.equal(art.version.message, 'Premier jet');
  const v2 = await h.upload('PUT', `/artifacts/${art.id}/content`, 'accueil.html', '<p>2</p>', { message: 'Header revu' });
  assert.equal(v2.status, 200);
  assert.equal(((await v2.json()) as { version: { message: string } }).version.message, 'Header revu');
  await h.upload('PUT', `/artifacts/${art.id}/content`, 'accueil.html', '<p>3</p>');

  let versions = (await (await h.call(`/artifacts/${art.id}/versions`)).json()) as Version[];
  assert.deepEqual(versions.map((v) => [v.number, v.message]), [[3, null], [2, 'Header revu'], [1, 'Premier jet']]);

  const first = versions.find((v) => v.number === 1)!;
  const edited = await h.call(`/artifacts/${art.id}/versions/${first.id}`, { method: 'PATCH', body: { message: 'Maquette initiale' } });
  assert.equal(edited.status, 200);
  assert.equal(((await edited.json()) as Version).message, 'Maquette initiale');
  await h.call(`/artifacts/${art.id}/versions/${first.id}`, { method: 'PATCH', body: { message: '' } });
  versions = (await (await h.call(`/artifacts/${art.id}/versions`)).json()) as Version[];
  assert.equal(versions.find((v) => v.number === 1)!.message, null, 'blank clears');
});

test('note de version : bornée, texte seulement, version de cet artéfact seulement', async () => {
  const h = await adminSetup();
  const a = (await (await h.upload('POST', '/artifacts', 'a.html', '<p>a</p>')).json()) as { id: string; version: { id: string } };
  const b = (await (await h.upload('POST', '/artifacts', 'b.html', '<p>b</p>')).json()) as { id: string; version: { id: string } };
  const long = await h.upload('PUT', `/artifacts/${a.id}/content`, 'a.html', '<p>2</p>', { message: 'x'.repeat(201) });
  assert.equal(long.status, 400);
  assert.equal(((await long.json()) as { code: string }).code, 'version_message_too_long');
  assert.equal((await h.call(`/artifacts/${a.id}/versions/${a.version.id}`, { method: 'PATCH', body: { message: 3 } })).status, 400);
  await h.call(`/artifacts/${a.id}/versions/${a.version.id}`, { method: 'PATCH', body: { message: 'Gardée' } });
  for (const body of [{}, { note: 'x' }]) {
    assert.equal((await h.call(`/artifacts/${a.id}/versions/${a.version.id}`, { method: 'PATCH', body })).status, 400, JSON.stringify(body));
  }
  const kept = (await (await h.call(`/artifacts/${a.id}/versions`)).json()) as Version[];
  assert.equal(kept[0].message, 'Gardée', 'a body without the field never erases the note');
  assert.equal((await h.call(`/artifacts/${a.id}/versions/${b.version.id}`, { method: 'PATCH', body: { message: 'x' } })).status, 404, 'another artifact’s version');
});

test('note de version : dans l’infobulle de la version, sur la barre visiteur', async () => {
  const h = await adminSetup();
  const a = (await (await h.upload('POST', '/artifacts', 'page.html', '<p>a</p>', { visibility: 'public', message: 'Bouton <Réserver>' })).json()) as { slug: string };
  const html = await (await h.content.request(`/a/${a.slug}`, { headers: { 'user-agent': BROWSER, 'sec-fetch-dest': 'document' } })).text();
  assert.match(html, /<span class="bar-version" title="Version 1: Bouton &lt;Réserver&gt;">v1<\/span>/);
});

test('note de version : colonne ajoutée en place, idempotente', async () => {
  const file = join(await tempDataDir(), 'hub.sqlite');
  const db = openDb(file);
  db.exec('ALTER TABLE versions DROP COLUMN message');
  db.close();
  const again = openDb(file);
  assert.ok((again.prepare('PRAGMA table_info(versions)').all() as { name: string }[]).some((c) => c.name === 'message'));
  again.close();
  openDb(file).close();
});
