import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { deriveKeys, encrypt, hashSecret, sha256 } from '../src/crypto.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { getArtifact, getLinkByHash, insertLink } from '../src/repo.ts';
import { newId } from '../src/ids.ts';
import { seedArtifact, setCookies, setup } from './harness.ts';
import { makeZip } from './helpers.ts';

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';

async function adminSetup(over = {}) {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), ...over });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const login = async () => {
    const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(res.status, 200);
    const { csrfToken } = (await res.json()) as { csrfToken: string };
    return { cookie: setCookies(res), csrf: csrfToken };
  };
  return { ...h, admin, login };
}

type Auth = { cookie: string; csrf: string };
const authed = (a: Auth, extra: Record<string, string> = {}) => ({ cookie: a.cookie, origin: ORIGIN, 'x-csrf-token': a.csrf, ...extra });

function uploadForm(name: string, data: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', new File([data], name));
  return form;
}

test('CSP stricte et en-têtes sur le serveur admin', async () => {
  const { admin } = await adminSetup();
  const res = await admin.request('/api/session');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; img-src 'self' data:; style-src 'self'; frame-src 'self' https://artifacts.test; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  assert.deepEqual(await res.json(), { authenticated: false, csrfToken: null, viaToken: false });
});

test('mutation sans Origin, avec Origin du contenu ou sans CSRF : 403 ; sans session : 401', async () => {
  const { admin, login } = await adminSetup();
  assert.equal((await admin.request('/api/artifacts/x/revoke-all', { method: 'POST' })).status, 403);
  assert.equal((await admin.request('/api/artifacts/x/revoke-all', { method: 'POST', headers: { origin: 'https://artifacts.test' } })).status, 403);
  assert.equal((await admin.request('/api/artifacts')).status, 401);
  const auth = await login();
  assert.equal((await admin.request('/api/artifacts/x/revoke-all', { method: 'POST', headers: { cookie: auth.cookie, origin: ORIGIN } })).status, 403);
  assert.equal((await admin.request('/api/artifacts/x/revoke-all', { method: 'POST', headers: authed(auth) })).status, 404);
});

test('cookie de session __Host- strict', async () => {
  const { admin } = await adminSetup();
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const line = res.headers.getSetCookie()[0];
  for (const part of ['__Host-hub_session=', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(line.includes(part), part);
});

test('login : mauvais mot de passe puis rate limit', async () => {
  const { admin } = await adminSetup();
  const attempt = () => admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '5.5.5.5' }, body: JSON.stringify({ password: 'faux' }) });
  for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('login : 10 tentatives concurrentes ne contournent pas la limite', async () => {
  const { admin } = await adminSetup();
  const attempt = () => admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6' }, body: JSON.stringify({ password: 'faux' }) });
  const statuses = (await Promise.all(Array.from({ length: 10 }, attempt))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 5);
});

test('publier, lister, prévisualiser, servir', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const res = await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('Mon Rapport.md', '# Bonjour', { visibility: 'public' }) });
  assert.equal(res.status, 201);
  const art = (await res.json()) as { id: string; slug: string; url: string; kind: string; title: string };
  assert.equal(art.slug, 'mon-rapport');
  assert.equal(art.title, 'Mon Rapport');
  assert.equal(art.kind, 'markdown');
  assert.equal(art.url, 'https://artifacts.test/a/mon-rapport');
  const list = (await (await h.admin.request('/api/artifacts', { headers: { cookie: auth.cookie } })).json()) as unknown[];
  assert.equal(list.length, 1);
  const { url } = (await (await h.admin.request(`/api/artifacts/${art.id}/preview`, { headers: { cookie: auth.cookie } })).json()) as { url: string };
  assert.match(url, /^https:\/\/artifacts\.test\/a\/mon-rapport\/~[^/]+\/index\.html$/);
  const served = await h.content.request(url.replace('https://artifacts.test', ''));
  assert.equal(served.status, 200);
  assert.match(await served.text(), /<h1 class="doc-title">Bonjour<\/h1>/);
});

test('slug déjà pris : 409 ; slug réservé : 400', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const send = (slug: string) => h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { slug }) });
  assert.equal((await send('page')).status, 201);
  assert.equal((await send('page')).status, 409);
  assert.equal((await send('share')).status, 400);
  const check = (await (await h.admin.request('/api/slugs/page', { headers: { cookie: auth.cookie } })).json()) as { available: boolean };
  assert.equal(check.available, false);
});

test('visibilité code exige un code', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const res = await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { visibility: 'code' }) });
  assert.equal(res.status, 400);
});

test('code secret : au moins 6 caractères à la création et à la modification', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const short = await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { visibility: 'code', code: '12345' }) });
  assert.equal(short.status, 400);
  const ok = await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { visibility: 'code', code: '123456' }) });
  assert.equal(ok.status, 201);
  const { id } = (await ok.json()) as { id: string };
  const patch = await h.admin.request(`/api/artifacts/${id}`, { method: 'PATCH', headers: authed(auth, { 'content-type': 'application/json' }), body: JSON.stringify({ visibility: 'code', code: '12345' }) });
  assert.equal(patch.status, 400);
});

test('upload trop volumineux : 413 sans fichier résiduel', async () => {
  const h = await adminSetup({ maxUploadBytes: 100 });
  const auth = await h.login();
  const res = await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x'.repeat(500)) });
  assert.equal(res.status, 413);
  assert.deepEqual(await readdir(join(h.cfg.dataDir, 'tmp')), []);
});

test('liens : création, URL recopiable, révocation', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const created = (await (await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { visibility: 'link' }) })).json()) as { id: string };
  const linkRes = await h.admin.request(`/api/artifacts/${created.id}/links`, { method: 'POST', headers: authed(auth, { 'content-type': 'application/json' }), body: JSON.stringify({ label: 'For the client', expiresAt: new Date(Date.now() + 86400_000).toISOString() }) });
  assert.equal(linkRes.status, 201);
  const link = (await linkRes.json()) as { id: string; url: string; active: boolean };
  assert.equal(link.active, true);
  const token = link.url.split('/share/')[1];
  assert.equal(getLinkByHash(h.db, sha256(token))?.id, link.id);
  const detail = (await (await h.admin.request(`/api/artifacts/${created.id}`, { headers: { cookie: auth.cookie } })).json()) as { links: { url: string }[] };
  assert.equal(detail.links[0].url, link.url);
  assert.equal((await h.content.request(`/share/${token}`)).status, 302);
  assert.equal((await h.admin.request(`/api/artifacts/${created.id}/links/${link.id}`, { method: 'DELETE', headers: authed(auth) })).status, 200);
  assert.equal((await h.content.request(`/share/${token}`)).status, 404);
});

test('PATCH : changer la visibilité met à jour le DTO', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const created = (await (await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { visibility: 'public' }) })).json()) as { id: string };
  const res = await h.admin.request(`/api/artifacts/${created.id}`, { method: 'PATCH', headers: authed(auth, { 'content-type': 'application/json' }), body: JSON.stringify({ visibility: 'code', code: 'sesame' }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { visibility: string; hasCode: boolean };
  assert.equal(body.visibility, 'code');
  assert.equal(body.hasCode, true);
});

// Artefact protégé par code, avec URL de prévisualisation signée et cookie de visiteur déjà obtenus.
async function lockedArtifact() {
  const h = await adminSetup();
  const auth = await h.login();
  const created = (await (await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { slug: 'prot', visibility: 'code', code: 'sesame' }) })).json()) as { id: string };
  const previewUrl = async () => {
    const { url } = (await (await h.admin.request(`/api/artifacts/${created.id}/preview`, { headers: { cookie: auth.cookie } })).json()) as { url: string };
    return url.replace('https://artifacts.test', '');
  };
  const unlock = async () => {
    const res = await h.content.request('/unlock/prot', { method: 'POST', body: new URLSearchParams({ code: 'sesame' }) });
    assert.equal(res.status, 303);
    return setCookies(res);
  };
  const patch = (body: object) => h.admin.request(`/api/artifacts/${created.id}`, { method: 'PATCH', headers: authed(auth, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
  const grantStatus = async (cookie: string) => (await h.content.request('/a/prot', { headers: { cookie } })).status;
  const oldPreview = await previewUrl();
  const oldGrant = await unlock();
  assert.equal((await h.content.request(oldPreview)).status, 200);
  assert.equal(await grantStatus(oldGrant), 302);
  return { h, auth, id: created.id, oldPreview, oldGrant, patch, grantStatus };
}

test('PATCH visibilité : invalide l’ancienne prévisualisation et l’ancien grant', async () => {
  const t = await lockedArtifact();
  assert.equal((await t.patch({ visibility: 'link' })).status, 200);
  assert.equal((await t.h.content.request(t.oldPreview)).status, 302);
  assert.equal(await t.grantStatus(t.oldGrant), 404);
});

test('PATCH nouveau code (code → code) : invalide prévisualisation et grant', async () => {
  const t = await lockedArtifact();
  assert.equal((await t.patch({ visibility: 'code', code: 'autre-code' })).status, 200);
  assert.equal((await t.h.content.request(t.oldPreview)).status, 302);
  assert.equal(await t.grantStatus(t.oldGrant), 401);
});

test('POST revoke-all : invalide prévisualisation et grant', async () => {
  const t = await lockedArtifact();
  assert.equal((await t.h.admin.request(`/api/artifacts/${t.id}/revoke-all`, { method: 'POST', headers: authed(t.auth) })).status, 200);
  assert.equal((await t.h.content.request(t.oldPreview)).status, 302);
  assert.equal(await t.grantStatus(t.oldGrant), 401);
});

test('PATCH titre seul : ne révoque rien', async () => {
  const t = await lockedArtifact();
  assert.equal((await t.patch({ title: 'Nouveau titre' })).status, 200);
  assert.equal((await t.h.content.request(t.oldPreview)).status, 200);
  assert.equal(await t.grantStatus(t.oldGrant), 302);
});

test('PUT content remplace sans changer l’URL ; DELETE supprime les fichiers', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const created = (await (await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'v1', { visibility: 'public' }) })).json()) as { id: string };
  const put = await h.admin.request(`/api/artifacts/${created.id}/content`, { method: 'PUT', headers: authed(auth), body: uploadForm('b.html', 'v2') });
  assert.equal(put.status, 200);
  const first = await h.content.request('/a/a');
  const served = await h.content.request(first.headers.get('location')!);
  assert.equal(await served.text(), 'v2');
  assert.equal((await h.admin.request(`/api/artifacts/${created.id}`, { method: 'DELETE', headers: authed(auth) })).status, 200);
  assert.equal(existsSync(join(h.cfg.dataDir, 'files', created.id)), false);
  assert.equal((await h.content.request('/a/a')).status, 404);
});

test('logout invalide la session', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  assert.equal((await h.admin.request('/api/logout', { method: 'POST', headers: authed(auth) })).status, 200);
  assert.equal((await h.admin.request('/api/artifacts', { headers: { cookie: auth.cookie } })).status, 401);
});

test('lien chiffré avec un autre secret : détail 200, url null, révocation possible', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const created = (await (await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { visibility: 'link' }) })).json()) as { id: string };
  const other = deriveKeys(Buffer.from('un-tout-autre-secret-de-test-0123456789'));
  const link = insertLink(h.db, { id: newId(), artifact_id: created.id, token_hash: sha256('t'), token_enc: encrypt(other.linkEnc, 't'), label: null, expires_at: null });
  const res = await h.admin.request(`/api/artifacts/${created.id}`, { headers: { cookie: auth.cookie } });
  assert.equal(res.status, 200);
  const detail = (await res.json()) as { links: { id: string; url: string | null }[] };
  assert.equal(detail.links[0].url, null);
  assert.equal((await h.admin.request(`/api/artifacts/${created.id}/links/${link.id}`, { method: 'DELETE', headers: authed(auth) })).status, 200);
});

test('login : corps de plus de 4 Ko refusé en 413 JSON', async () => {
  const { admin } = await adminSetup();
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(5000) }) });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { code: 'payload_too_large', error: 'Request too large' });
});

const TOKEN = 'T'.repeat(43);
const bearer = (t = TOKEN, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
const tokenSetup = (over = {}) => adminSetup({ apiTokenHash: sha256(TOKEN), ...over });

test('jeton : création sans Origin ni cookie ni CSRF', async () => {
  const h = await tokenSetup();
  const res = await h.admin.request('/api/artifacts', { method: 'POST', headers: bearer(), body: uploadForm('a.md', '# a') });
  assert.equal(res.status, 201);
  assert.equal(res.headers.getSetCookie().length, 0);
  assert.match(res.headers.get('content-security-policy')!, /^default-src 'self'/);
});

test('jeton : lecture, mutation avec Origin étranger, session', async () => {
  const h = await tokenSetup();
  assert.equal((await h.admin.request('/api/artifacts', { headers: bearer() })).status, 200);
  const res = await h.admin.request('/api/artifacts', { method: 'POST', headers: bearer(TOKEN, { origin: 'https://evil.test' }), body: uploadForm('b.md', '# b') });
  assert.equal(res.status, 201);
  const session = await h.admin.request('/api/session', { headers: bearer() });
  assert.deepEqual(await session.json(), { authenticated: false, csrfToken: null, viaToken: true });
});

test('jeton invalide : 401 même avec une session valide', async () => {
  const h = await tokenSetup();
  const auth = await h.login();
  const res = await h.admin.request('/api/artifacts', { headers: { ...authed(auth), ...bearer('x'.repeat(43)) } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { code: 'token_invalid', error: 'Invalid API token' });
});

test('jeton désactivé : 401', async () => {
  const h = await adminSetup();
  const res = await h.admin.request('/api/artifacts', { headers: bearer() });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { code: 'token_disabled', error: 'API token disabled' });
});

test('jeton invalide : 6e tentative depuis une IP = 429', async () => {
  const h = await tokenSetup();
  const attempt = () => h.admin.request('/api/artifacts', { headers: bearer('y'.repeat(43), { 'x-forwarded-for': '7.7.7.7' }) });
  for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('jeton : inutilisable sur login et logout', async () => {
  const h = await tokenSetup();
  const login = await h.admin.request('/api/login', { method: 'POST', headers: bearer(TOKEN, { 'content-type': 'application/json' }), body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 403);
  assert.equal(login.headers.getSetCookie().length, 0);
  assert.equal((await h.admin.request('/api/logout', { method: 'POST', headers: bearer() })).status, 403);
});

test('sans jeton, le flux cookie exige toujours Origin et CSRF', async () => {
  const h = await tokenSetup();
  assert.equal((await h.admin.request('/api/artifacts', { method: 'POST', body: uploadForm('c.md', '# c') })).status, 403);
});

test('GET /api/artifacts?slug= filtre sur le slug exact', async () => {
  const h = await tokenSetup();
  for (const name of ['un.md', 'un-deux.md']) await h.admin.request('/api/artifacts', { method: 'POST', headers: bearer(), body: uploadForm(name, '# x') });
  const one = (await (await h.admin.request('/api/artifacts?slug=un', { headers: bearer() })).json()) as { slug: string }[];
  assert.deepEqual(one.map((a) => a.slug), ['un']);
  assert.deepEqual(await (await h.admin.request('/api/artifacts?slug=absent', { headers: bearer() })).json(), []);
  assert.equal(((await (await h.admin.request('/api/artifacts', { headers: bearer() })).json()) as unknown[]).length, 2);
});

test('memoryStorage : création, DTO, patch sans bump de l’époque', async () => {
  const h = await tokenSetup();
  const created = await h.admin.request('/api/artifacts', { method: 'POST', headers: bearer(), body: uploadForm('m.html', '<p>x</p>', { memoryStorage: 'true' }) });
  const dto = (await created.json()) as { id: string; memoryStorage: boolean };
  assert.equal(dto.memoryStorage, true);
  const plain = await h.admin.request('/api/artifacts', { method: 'POST', headers: bearer(), body: uploadForm('n.html', '<p>x</p>', { memoryStorage: 'nope' }) });
  assert.equal(((await plain.json()) as { memoryStorage: boolean }).memoryStorage, false);
  const epoch = (id: string) => (h.db.prepare('SELECT access_epoch AS e FROM artifacts WHERE id = ?').get(id) as { e: number }).e;
  const before = epoch(dto.id);
  const patched = await h.admin.request(`/api/artifacts/${dto.id}`, { method: 'PATCH', headers: bearer(TOKEN, { 'content-type': 'application/json' }), body: JSON.stringify({ memoryStorage: false }) });
  assert.equal(((await patched.json()) as { memoryStorage: boolean }).memoryStorage, false);
  assert.equal(epoch(dto.id), before);
  const back = await h.admin.request(`/api/artifacts/${dto.id}`, { method: 'PATCH', headers: bearer(TOKEN, { 'content-type': 'application/json' }), body: JSON.stringify({ title: 'Nouveau' }) });
  assert.equal(((await back.json()) as { memoryStorage: boolean }).memoryStorage, false);
});

test('projet et tags : création, DTO, PATCH, filtres, listes, cascade', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const json = async (path: string, init: RequestInit = {}) => {
    const res = await h.admin.request(path, { ...init, headers: { ...authed(auth), ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const create = (name: string, fields: Record<string, string>) =>
    h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm(name, 'x', fields) });

  const r1 = await create('a.html', { project: ' Client Acme ', tags: 'Maquette, v2 ,maquette' });
  assert.equal(r1.status, 201);
  const a = (await r1.json()) as { id: string; project: string; tags: string[] };
  assert.equal(a.project, 'client-acme');
  assert.deepEqual(a.tags, ['maquette', 'v2']);
  const b = (await (await create('b.html', { project: 'client-acme', tags: 'v2' })).json()) as { id: string };
  const c = (await (await create('c.html', {})).json()) as { id: string; project: null; tags: string[] };
  assert.equal(c.project, null);
  assert.deepEqual(c.tags, []);

  assert.equal((await create('d.html', { project: '!!!' })).status, 400);
  assert.equal((await create('e.html', { tags: 'ok,???' })).status, 400);
  assert.equal((await create('f.html', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`).join(',') })).status, 400);
  assert.equal((await json('/api/artifacts')).body.length, 3);

  const slugs = async (q: string) => (await json(`/api/artifacts${q}`)).body.map((x: { slug: string }) => x.slug).sort();
  assert.deepEqual(await slugs('?project=client-acme'), ['a', 'b']);
  assert.deepEqual(await slugs('?project='), ['c']);
  assert.deepEqual(await slugs('?tag=v2'), ['a', 'b']);
  assert.deepEqual(await slugs('?tag=v2&tag=maquette'), ['a']);
  assert.deepEqual(await slugs('?project=client-acme&tag=maquette'), ['a']);
  assert.deepEqual(await slugs('?slug=a'), ['a']);

  assert.deepEqual((await json('/api/projects')).body.map(({ name, count, privateCount, visibility, title }: Record<string, unknown>) => ({ name, count, privateCount, visibility, title })), [
    { name: 'client-acme', count: 2, privateCount: 2, visibility: 'private', title: null },
    { name: null, count: 1, privateCount: 1, visibility: 'private', title: null },
  ]);
  assert.deepEqual((await json('/api/tags')).body, [{ name: 'v2', count: 2 }, { name: 'maquette', count: 1 }]);

  const epochBefore = h.db.prepare('SELECT access_epoch FROM artifacts WHERE id = ?').get(a.id);
  const patch = (id: string, body: object) => json(`/api/artifacts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const p1 = await patch(a.id, { project: 'Autre', tags: ['Zèbre', 'zebre', 'x'] });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.project, 'autre');
  assert.deepEqual(p1.body.tags, ['x', 'zebre']);
  assert.deepEqual(h.db.prepare('SELECT access_epoch FROM artifacts WHERE id = ?').get(a.id), epochBefore);
  const p2 = await patch(a.id, { title: 'Nouveau' });
  assert.equal(p2.body.project, 'autre');
  assert.deepEqual(p2.body.tags, ['x', 'zebre']);
  assert.equal((await patch(a.id, { project: null })).body.project, null);
  assert.equal((await patch(b.id, { project: '' })).body.project, null);
  assert.equal((await patch(a.id, { project: '***' })).status, 400);
  assert.equal((await patch(a.id, { tags: ['ok', ''] })).status, 400);
  assert.equal((await patch(a.id, { tags: 'x' })).status, 400);
  assert.equal((await json(`/api/artifacts/${a.id}`)).body.tags.length, 2);
  assert.deepEqual((await patch(a.id, { tags: [] })).body.tags, []);

  assert.equal((await json(`/api/artifacts/${a.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM artifact_tags WHERE artifact_id = ?').get(a.id) as { n: number }).n, 0);
});

test('le serveur de contenu n’expose ni projet ni tag', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  const mk = async (slug: string, extra: Record<string, string>) => {
    const res = await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm(`${slug}.html`, '<p>contenu</p>', { project: 'zzprojetsecret', tags: 'zztagsecret', ...extra }) });
    assert.equal(res.status, 201);
  };
  await mk('pub', { visibility: 'public' });
  await mk('cod', { visibility: 'code', code: 'sesame1' });
  const seen: string[] = [];
  const grab = async (res: Response) => {
    seen.push([...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), await res.text());
    return res;
  };
  const redirect = await grab(await h.content.request('/a/pub'));
  assert.equal(redirect.status, 302);
  const location = redirect.headers.get('location')!;
  assert.equal((await grab(await h.content.request(location))).status, 200);
  assert.equal((await grab(await h.content.request('/a/cod'))).status, 401);
  assert.equal((await grab(await h.content.request('/unlock/cod', { method: 'POST', body: new URLSearchParams({ code: 'faux', next: '' }), headers: { 'x-forwarded-for': '9.9.9.9' } }))).status, 401);
  assert.equal((await grab(await h.content.request('/a/inconnu'))).status, 404);
  for (const text of seen) assert.doesNotMatch(text, /zzprojetsecret|zztagsecret/);
});

// Artifact avec v1 (html) puis v2 (zip site) ; helpers JSON.
async function versioned() {
  const h = await adminSetup();
  const auth = await h.login();
  const created = (await (await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', '<p>un</p>', { slug: 'hist', visibility: 'private' }) })).json()) as { id: string; version: { number: number } };
  const put = (name: string, data: string) => h.admin.request(`/api/artifacts/${created.id}/content`, { method: 'PUT', headers: authed(auth), body: uploadForm(name, data) });
  const get = async (path: string) => (await h.admin.request(`/api/artifacts/${created.id}${path}`, { headers: { cookie: auth.cookie } })).json();
  const post = (path: string, otherId = created.id) => h.admin.request(`/api/artifacts/${otherId}${path}`, { method: 'POST', headers: authed(auth) });
  return { h, auth, created, put, get, post };
}

type VersionRow = { id: string; number: number; kind: string; originalName: string; current: boolean };

test('versions : liste, numéros, DTO', async () => {
  const t = await versioned();
  assert.equal(t.created.version.number, 1);
  const up = (await (await t.put('b.md', '# deux')).json()) as { kind: string; version: { number: number } };
  assert.equal(up.version.number, 2);
  assert.equal(up.kind, 'markdown');
  const list = (await t.get('/versions')) as VersionRow[];
  assert.deepEqual(list.map((v) => [v.number, v.kind, v.originalName, v.current]), [[2, 'markdown', 'b.md', true], [1, 'html', 'a.html', false]]);
});

test('versions : aperçu épinglé d’une ancienne version, restauration, même URL publique', async () => {
  const t = await versioned();
  await t.put('b.md', '# deux');
  const [v2, v1] = (await t.get('/versions')) as VersionRow[];
  const { url } = (await t.get(`/versions/${v1.id}/preview`)) as { url: string };
  assert.match(url, /^https:\/\/artifacts\.test\/a\/hist\/~p[0-9A-Z]{26}\.\d+\.\d+\.[A-Za-z0-9_-]{43}\/index\.html$/);
  assert.match(await (await t.h.content.request(url.replace('https://artifacts.test', ''))).text(), /un/);
  const epoch = getArtifact(t.h.db, t.created.id)!.access_epoch;
  const res = await t.post(`/versions/${v1.id}/restore`);
  assert.equal(res.status, 200);
  const dto = (await res.json()) as { kind: string; version: { number: number } };
  assert.equal(dto.kind, 'html');
  assert.equal(dto.version.number, 1);
  assert.equal(getArtifact(t.h.db, t.created.id)!.access_epoch, epoch);
  assert.equal(getArtifact(t.h.db, t.created.id)!.current_version_id, v1.id);
  assert.equal(((await t.get('/versions')) as VersionRow[]).find((v) => v.id === v1.id)!.current, true);
  // Aperçu normal -> v1 ; la v2 est toujours visible via un aperçu épinglé.
  const { url: cur } = (await t.get('/preview')) as { url: string };
  assert.match(await (await t.h.content.request(cur.replace('https://artifacts.test', ''))).text(), /un/);
  const { url: pv2 } = (await t.get(`/versions/${v2.id}/preview`)) as { url: string };
  assert.equal((await t.h.content.request(pv2.replace('https://artifacts.test', ''))).status, 200);
  // Un nouvel upload continue la numérotation.
  assert.equal(((await (await t.put('c.html', '<p>trois</p>')).json()) as { version: { number: number } }).version.number, 3);
});

test('versions : restaurer la version actuelle → 409 ; version étrangère ou inconnue → 404', async () => {
  const t = await versioned();
  const [cur] = (await t.get('/versions')) as VersionRow[];
  const res = await t.post(`/versions/${cur.id}/restore`);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { code: 'already_current', error: 'Already the current version' });
  const other = (await (await t.h.admin.request('/api/artifacts', { method: 'POST', headers: authed(t.auth), body: uploadForm('o.html', 'o', { slug: 'other' }) })).json()) as { id: string };
  const [foreign] = (await (await t.h.admin.request(`/api/artifacts/${other.id}/versions`, { headers: { cookie: t.auth.cookie } })).json()) as VersionRow[];
  assert.equal((await t.post(`/versions/${foreign.id}/restore`)).status, 404);
  assert.equal((await t.post('/versions/inconnue/restore')).status, 404);
  assert.equal((await t.h.admin.request(`/api/artifacts/${t.created.id}/versions/${foreign.id}/preview`, { headers: { cookie: t.auth.cookie } })).status, 404);
  assert.equal((await t.h.admin.request('/api/artifacts/nope/versions', { headers: { cookie: t.auth.cookie } })).status, 404);
});

test('versions : les sites sont élagués à 10, les html jamais', async () => {
  const t = await versioned(); // v1 html
  const zip = (i: number) => new File([new Uint8Array(makeZip([{ name: 'index.html', data: `<p>${i}</p>` }, { name: 'app.js', data: 'x' }]))], `s${i}.zip`);
  const putZip = (i: number) => { const f = new FormData(); f.set('file', zip(i)); return t.h.admin.request(`/api/artifacts/${t.created.id}/content`, { method: 'PUT', headers: authed(t.auth), body: f }); };
  for (let i = 0; i < 12; i++) assert.equal((await putZip(i)).status, 200);
  const list = (await t.get('/versions')) as VersionRow[];
  assert.equal(list.length, 11, 'v1 html + 10 sites');
  assert.equal(list[0].number, 13);
  assert.equal(list.at(-1)!.number, 1);
  assert.deepEqual(list.slice(0, 10).map((v) => v.kind), Array(10).fill('site'));
});

type PreviewDto = { heading: string | null; text: string | null } | null;

async function previewOf(name: string, data: string | Uint8Array<ArrayBuffer>): Promise<PreviewDto> {
  const h = await adminSetup();
  const auth = await h.login();
  const form = new FormData();
  form.set('file', new File([data], name));
  const res = await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: form });
  assert.equal(res.status, 201);
  const list = (await (await h.admin.request('/api/artifacts', { headers: { cookie: auth.cookie } })).json()) as { preview: PreviewDto }[];
  return list[0].preview;
}

test('aperçu : Markdown → premier titre # et premier paragraphe sans syntaxe', async () => {
  const md = '---\ntitle: x\n---\n\n## Avant\n\n# Rapport **annuel**\n\n```js\ncode()\n```\n\nUn *premier* paragraphe avec [un lien](https://x.test) et `du code`,\nsur deux lignes.\n\nSecond paragraphe.\n';
  assert.deepEqual(await previewOf('r.md', md), { heading: 'Rapport annuel', text: 'Un premier paragraphe avec un lien et du code, sur deux lignes.' });
});

test('aperçu : HTML → <title> puis premier <p>, sans script ni balise, entités décodées', async () => {
  const html = '<html><head><title>Ma &amp; page</title><script>alert("x")</script><style>p{}</style></head><body><h1>Autre</h1><p>  </p><p>Bonjour <b>le</b> monde&nbsp;&#233;&#x21;<script>evil()</script></p></body></html>';
  assert.deepEqual(await previewOf('p.html', html), { heading: 'Ma & page', text: 'Bonjour le monde é!' });
});

test('aperçu : HTML sans <title> → premier <h1>', async () => {
  assert.deepEqual(await previewOf('p.html', '<body><h1 class="a">Titre <em>fort</em></h1><p>Texte</p></body>'), { heading: 'Titre fort', text: 'Texte' });
});

test('aperçu : site ZIP → index.html', async () => {
  const zip = makeZip([{ name: 'index.html', data: '<title>Kiosk</title><p>Borne</p>' }, { name: 'app.js', data: 'x' }]);
  assert.deepEqual(await previewOf('s.zip', new Uint8Array(zip)), { heading: 'Kiosk', text: 'Borne' });
});

test('aperçu : JSON → pas de titre, 200 premiers caractères du JSON indenté', async () => {
  const data = { nom: 'hub', items: Array.from({ length: 50 }, (_, i) => ({ i })) };
  const p = await previewOf('d.json', JSON.stringify(data));
  assert.equal(p?.heading, null);
  assert.equal(p?.text, JSON.stringify(data, null, 2).slice(0, 200));
});

test('aperçu : PDF → null', async () => {
  assert.equal(await previewOf('d.pdf', '%PDF-1.4\n%%EOF'), null);
});

test('aperçu : titre ≤ 120 et texte ≤ 280 caractères', async () => {
  const p = await previewOf('long.md', `# ${'T'.repeat(300)}\n\n${'mot '.repeat(400)}`);
  assert.ok(p?.heading && p.heading.length <= 120 && p.heading.endsWith('…'), String(p?.heading?.length));
  assert.ok(p?.text && p.text.length <= 280 && p.text.endsWith('…'), String(p?.text?.length));
});

test('aperçu : seuls les 64 premiers Kio sont lus', async () => {
  const html = `<title>Loin</title>${' '.repeat(70 * 1024)}<p>trop loin</p>`;
  assert.deepEqual(await previewOf('far.html', html), { heading: 'Loin', text: null });
});

test('aperçu : fichier absent → null', async () => {
  const h = await adminSetup();
  const auth = await h.login();
  await seedArtifact(h, { slug: 'vide', visibility: 'private', kind: 'html', files: {} });
  const list = (await (await h.admin.request('/api/artifacts', { headers: { cookie: auth.cookie } })).json()) as { preview: PreviewDto }[];
  assert.equal(list[0].preview, null);
});

// Partage en un geste, lien actif dans le DTO, épingles.
async function shareSetup(visibility: string, extra: Record<string, string> = {}) {
  const h = await adminSetup();
  const auth = await h.login();
  const created = (await (await h.admin.request('/api/artifacts', { method: 'POST', headers: authed(auth), body: uploadForm('a.html', 'x', { slug: 'partage', visibility, ...extra }) })).json()) as { id: string };
  const json = authed(auth, { 'content-type': 'application/json' });
  const share = (body: object = {}) => h.admin.request(`/api/artifacts/${created.id}/share`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const epoch = () => getArtifact(h.db, created.id)!.access_epoch;
  const detail = async () => (await (await h.admin.request(`/api/artifacts/${created.id}`, { headers: { cookie: auth.cookie } })).json()) as ShareArtifact & { links: ShareLinkDto[] };
  const previewUrl = async () => {
    const { url } = (await (await h.admin.request(`/api/artifacts/${created.id}/preview`, { headers: { cookie: auth.cookie } })).json()) as { url: string };
    return url.replace('https://artifacts.test', '');
  };
  const patch = (body: object) => h.admin.request(`/api/artifacts/${created.id}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) });
  return { h, auth, id: created.id, share, epoch, detail, previewUrl, patch };
}
type ShareArtifact = { id: string; visibility: string; hasCode: boolean; activeLinkUrl: string | null; pinned: boolean; pinnedAt: string | null; updatedAt: string };
type ShareLinkDto = { id: string; url: string; label: string | null; expiresAt: string; active: boolean };

test('share : depuis privé → visibilité lien, lien de 7 jours par défaut, DTO avec activeLinkUrl', async () => {
  const t = await shareSetup('private');
  const before = Date.now();
  const res = await t.share({ label: 'For the client' });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { artifact: ShareArtifact; link: ShareLinkDto };
  assert.equal(body.artifact.visibility, 'link');
  assert.equal(body.link.label, 'For the client');
  assert.equal(body.link.active, true);
  const ttl = Date.parse(body.link.expiresAt) - before;
  assert.ok(ttl > 167 * 3600_000 && ttl <= 168 * 3600_000 + 5000, String(ttl));
  assert.equal(body.artifact.activeLinkUrl, body.link.url);
  const token = body.link.url.split('/share/')[1];
  assert.equal((await t.h.content.request(`/share/${token}`)).status, 302);
});

test('share : depuis public → époque incrémentée, ancien chemin signé périmé', async () => {
  const t = await shareSetup('public');
  const oldPreview = await t.previewUrl();
  assert.equal((await t.h.content.request(oldPreview)).status, 200);
  const epoch = t.epoch();
  const res = await t.share({ hours: 24 });
  assert.equal(res.status, 201);
  assert.equal(t.epoch(), epoch + 1);
  assert.equal((await t.h.content.request(oldPreview)).status, 302);
  assert.equal((await t.h.content.request('/a/partage')).status, 404);
});

test('share : depuis code → le code est effacé', async () => {
  const t = await shareSetup('code', { code: 'sesame' });
  const body = (await (await t.share()).json()) as { artifact: ShareArtifact };
  assert.equal(body.artifact.visibility, 'link');
  assert.equal(body.artifact.hasCode, false);
});

test('share : déjà en lien → pas de bump, second lien ajouté et devenu le lien actif', async () => {
  const t = await shareSetup('link');
  const first = (await (await t.share()).json()) as { link: ShareLinkDto };
  const epoch = t.epoch();
  await new Promise((r) => setTimeout(r, 5));
  const second = (await (await t.share({ hours: 1 })).json()) as { artifact: ShareArtifact; link: ShareLinkDto };
  assert.equal(t.epoch(), epoch);
  assert.notEqual(first.link.id, second.link.id);
  const d = await t.detail();
  assert.equal(d.links.length, 2);
  assert.equal(d.activeLinkUrl, second.link.url);
});

test('share : durée hors 1..8760 heures ou non numérique → 400, rien ne change', async () => {
  const t = await shareSetup('public');
  for (const hours of [0, 0.5, 8761, -3, '24', null]) assert.equal((await t.share({ hours })).status, 400, String(hours));
  assert.equal((await t.share({ hours: 1 })).status, 201);
  const t2 = await shareSetup('public');
  assert.equal((await t2.share({ hours: 8760 })).status, 201);
  const t3 = await shareSetup('public');
  const epoch = t3.epoch();
  assert.equal((await t3.share({ hours: 9000 })).status, 400);
  assert.equal(t3.epoch(), epoch);
  assert.equal((await t3.detail()).visibility, 'public');
});

test('share : artifact inconnu → 404', async () => {
  const t = await shareSetup('private');
  const res = await t.h.admin.request('/api/artifacts/nope/share', { method: 'POST', headers: authed(t.auth, { 'content-type': 'application/json' }), body: '{}' });
  assert.equal(res.status, 404);
});

test('activeLinkUrl : lien le plus récent ni révoqué ni expiré, null hors visibilité lien', async () => {
  const t = await shareSetup('link');
  assert.equal((await t.detail()).activeLinkUrl, null);
  const json = authed(t.auth, { 'content-type': 'application/json' });
  const mk = async (expiresAt: string | null) => (await (await t.h.admin.request(`/api/artifacts/${t.id}/links`, { method: 'POST', headers: json, body: JSON.stringify({ expiresAt }) })).json()) as ShareLinkDto;
  const older = await mk(null);
  await new Promise((r) => setTimeout(r, 5));
  const newer = await mk(new Date(Date.now() + 60_000).toISOString());
  assert.equal((await t.detail()).activeLinkUrl, newer.url);
  await t.h.admin.request(`/api/artifacts/${t.id}/links/${newer.id}`, { method: 'DELETE', headers: authed(t.auth) });
  assert.equal((await t.detail()).activeLinkUrl, older.url);
  // Expiré : on recule la date directement en base.
  t.h.db.prepare('UPDATE share_links SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), older.id);
  assert.equal((await t.detail()).activeLinkUrl, null);
  t.h.db.prepare('UPDATE share_links SET expires_at = NULL WHERE id = ?').run(older.id);
  const list = (await (await t.h.admin.request('/api/artifacts', { headers: { cookie: t.auth.cookie } })).json()) as ShareArtifact[];
  assert.equal(list[0].activeLinkUrl, older.url);
  assert.equal((await t.patch({ visibility: 'public' })).status, 200);
  assert.equal((await t.detail()).activeLinkUrl, null);
});

test('PATCH pinned : épingle et désépingle sans bump d’époque ni changement de updatedAt', async () => {
  const t = await shareSetup('code', { code: 'sesame' });
  const before = await t.detail();
  assert.equal(before.pinned, false);
  assert.equal(before.pinnedAt, null);
  const epoch = t.epoch();
  const pinned = (await (await t.patch({ pinned: true })).json()) as ShareArtifact;
  assert.equal(pinned.pinned, true);
  assert.ok(pinned.pinnedAt);
  assert.equal(pinned.updatedAt, before.updatedAt);
  assert.equal(pinned.visibility, 'code');
  assert.equal(pinned.hasCode, true);
  assert.equal(t.epoch(), epoch);
  const unpinned = (await (await t.patch({ pinned: false })).json()) as ShareArtifact;
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.pinnedAt, null);
  assert.equal((await t.patch({ pinned: 'oui' })).status, 400);
  // Combiné à un autre champ : les deux s'appliquent.
  const both = (await (await t.patch({ pinned: true, title: 'Épinglé' })).json()) as ShareArtifact & { title: string };
  assert.equal(both.pinned, true);
  assert.equal(both.title, 'Épinglé');
  assert.equal(t.epoch(), epoch);
});

test('share : sans session → 401 ; session sans CSRF → 403', async () => {
  const t = await shareSetup('private');
  const anon = await t.h.admin.request(`/api/artifacts/${t.id}/share`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);
  const noCsrf = await t.h.admin.request(`/api/artifacts/${t.id}/share`, { method: 'POST', headers: { cookie: t.auth.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  assert.equal(getArtifact(t.h.db, t.id)!.visibility, 'private');
});

test('activeLinkUrl : liens créés au même instant → le dernier inséré gagne (rowid)', async () => {
  const t = await shareSetup('link');
  const at = new Date().toISOString();
  const mk = (token: string) => insertLink(t.h.db, { id: newId(), artifact_id: t.id, token_hash: sha256(token), token_enc: encrypt(t.h.keys.linkEnc, token), label: token, expires_at: null });
  mk('premier');
  mk('second');
  t.h.db.prepare('UPDATE share_links SET created_at = ? WHERE artifact_id = ?').run(at, t.id);
  assert.match((await t.detail()).activeLinkUrl ?? '', /\/share\/second$/);
});
