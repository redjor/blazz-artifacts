import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomToken, sha256, encrypt } from '../src/crypto.ts';
import { newId } from '../src/ids.ts';
import { parseArtifactPath } from '../src/content/paths.ts';
import { signPath, signPinnedPath } from '../src/content/signing.ts';
import { activateVersion, bumpEpoch, getArtifact, insertLink, revokeLink, updateArtifact } from '../src/repo.ts';
import { versionDir } from '../src/storage.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seedArtifact, setCookies, setup } from './harness.ts';

const SITE = { 'index.html': '<script type="module" src="app.js"></script>', 'app.js': 'export {}', 'logo.svg': '<svg/>', 'docs/index.html': 'docs', 'data.bin': 'x' };

async function follow(h: Awaited<ReturnType<typeof setup>>, path: string, cookie = '') {
  const first = await h.content.request(path, { headers: { cookie } });
  assert.equal(first.status, 302, `redirection attendue pour ${path}`);
  const location = first.headers.get('location')!;
  return { location, res: await h.content.request(location) };
}

test('public : redirige vers un chemin signé puis sert avec CORS et sandbox', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'site', visibility: 'public', files: SITE });
  const { location, res } = await follow(h, '/a/site');
  assert.match(location, /^\/a\/site\/~[0-9A-Z]{26}\.1\.\d+\.[A-Za-z0-9_-]{43}\/index\.html$/);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cross-origin-resource-policy'), null);
  const csp = res.headers.get('content-security-policy')!;
  assert.match(csp, /^sandbox allow-scripts /);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const asset = await h.content.request(location.replace('index.html', 'app.js'));
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

test('SVG et fichiers inconnus restent sandboxés', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'site', visibility: 'public', files: SITE });
  const { location } = await follow(h, '/a/site');
  const svg = await h.content.request(location.replace('index.html', 'logo.svg'));
  assert.match(svg.headers.get('content-security-policy')!, /^sandbox /);
  const bin = await h.content.request(location.replace('index.html', 'data.bin'));
  assert.equal(bin.headers.get('content-type'), 'application/octet-stream');
  assert.equal(bin.headers.get('content-disposition'), 'attachment');
});

test('PDF servi sans sandbox', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'doc', visibility: 'public', kind: 'pdf', entry: 'document.pdf', files: { 'document.pdf': '%PDF-1.4' } });
  const { res } = await follow(h, '/a/doc');
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
});

test('Markdown : sandbox sans scripts', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'md', visibility: 'public', kind: 'markdown', files: { 'index.html': '<h1>x</h1>', 'source.md': '# x' } });
  const { res } = await follow(h, '/a/md');
  assert.doesNotMatch(res.headers.get('content-security-policy')!, /allow-scripts/);
  const original = await h.content.request((await follow(h, '/a/md/source.md')).location);
  assert.equal(original.headers.get('content-type'), 'text/plain; charset=utf-8');
});

test('privé : 404 partout sans signature', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'secret', visibility: 'private', files: SITE });
  assert.equal((await h.content.request('/a/secret')).status, 404);
  assert.equal((await h.content.request('/a/secret/app.js')).status, 404);
  assert.equal((await h.content.request('/a/nope')).status, 404);
});

test('signatures falsifiées, périmées, anciennes', async () => {
  const h = await setup();
  const art = await seedArtifact(h, { slug: 'site', visibility: 'public', files: SITE });
  const { location } = await follow(h, '/a/site/docs/');
  assert.match(location, /\/docs\/index\.html$/);
  const forged = location.replace(/[A-Za-z0-9_-](\/docs)/, (m, rest) => (m[0] === 'A' ? 'B' : 'A') + rest);
  assert.equal((await h.content.request(forged)).status, 404);
  h.clock.advance(3601_000);
  const expired = await h.content.request(location);
  assert.equal(expired.status, 302);
  assert.equal(expired.headers.get('location'), '/a/site/docs/index.html');
  assert.equal(expired.headers.get('access-control-allow-origin'), '*');
  bumpEpoch(h.db, art.id);
  assert.equal((await h.content.request(location)).status, 302);
});

test('traversée et chemins invalides', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'site', visibility: 'public', files: SITE });
  const { location } = await follow(h, '/a/site');
  const base = location.replace('/index.html', '');
  // L'analyseur d'URL normalise déjà `..` et `%2e%2e` : on exige seulement qu'aucun fichier ne soit servi.
  for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
    assert.notEqual((await h.content.request(base + p)).status, 200, p);
  }
  for (const p of ['/a%2Fb', '/a%5Cb', '/missing.js']) {
    assert.equal((await h.content.request(base + p)).status, 404, p);
  }
  assert.equal(parseArtifactPath('/a/site/~x/..%2F..%2Fetc'), null);
  assert.equal(parseArtifactPath('/a/site/%2e%2e'), null);
});

test('code : formulaire, échec, succès, puis accès', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const form = await h.content.request('/a/c/docs/index.html');
  assert.equal(form.status, 401);
  const html = await form.text();
  assert.match(html, /action="\/unlock\/c"/);
  assert.match(html, /value="docs\/index.html"/);
  const post = (code: string) =>
    h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code, next: 'docs/index.html' }), headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal((await post('faux')).status, 401);
  const ok = await post('sesame');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/a/c/docs/index.html');
  const cookie = setCookies(ok);
  assert.match(ok.headers.getSetCookie()[0], /^__Host-grant_[0-9A-Z]{26}=.*; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await follow(h, '/a/c', cookie)).res.status, 200);
});

test('code : rate limit par IP', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const post = (code: string) =>
    h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code }), headers: { 'x-forwarded-for': '9.9.9.9' } });
  for (let i = 0; i < 5; i++) assert.equal((await post('faux')).status, 401);
  assert.equal((await post('sesame')).status, 429);
});

test('code : seule la dernière entrée de X-Forwarded-For compte (anti-usurpation)', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const post = (code: string, xff: string) =>
    h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code }), headers: { 'x-forwarded-for': xff } });
  for (let i = 0; i < 5; i++) assert.equal((await post('faux', 'evil, 9.9.9.9')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await post('faux', 'other, 9.9.9.9')).status, 429);
  assert.equal((await post('sesame', 'third, 9.9.9.9')).status, 429);
});

test('changer le code coupe les grants existants', async () => {
  const h = await setup();
  const art = await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const ok = await h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code: 'sesame' }) });
  const cookie = setCookies(ok);
  updateArtifact(h.db, art.id, { code_hash: art.code_hash }, true);
  assert.equal((await h.content.request('/a/c', { headers: { cookie } })).status, 401);
});

test('lien : échange du jeton, révocation, expiration', async () => {
  const h = await setup();
  const art = await seedArtifact(h, { slug: 'l', visibility: 'link', files: SITE });
  assert.equal((await h.content.request('/a/l')).status, 404);
  const token = randomToken();
  const link = insertLink(h.db, { id: newId(), artifact_id: art.id, token_hash: sha256(token), token_enc: encrypt(h.keys.linkEnc, token), label: null, expires_at: new Date(h.clock.now() + 3600_000).toISOString() });
  const share = await h.content.request(`/share/${token}`);
  assert.equal(share.status, 302);
  assert.equal(share.headers.get('location'), '/a/l');
  const cookie = setCookies(share);
  assert.equal((await follow(h, '/a/l', cookie)).res.status, 200);
  revokeLink(h.db, art.id, link.id);
  assert.equal((await h.content.request('/a/l', { headers: { cookie } })).status, 404);
  assert.equal((await h.content.request(`/share/${token}`)).status, 404);
  assert.equal((await h.content.request('/share/inconnu')).status, 404);
});

test('aucune route admin sur le serveur de contenu', async () => {
  const h = await setup();
  for (const p of ['/api/session', '/api/artifacts', '/', '/index.html', '/assets/index.js']) {
    const res = await h.content.request(p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers.get('content-security-policy')!, /^sandbox /);
  }
});

test('code : 20 requêtes parallèles ne dépassent pas le budget de 5 essais', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const post = (code: string) =>
    h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code }), headers: { 'x-forwarded-for': '5.5.5.5' } });
  const statuses = (await Promise.all(Array.from({ length: 20 }, () => post('faux')))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 15);
});

test('code : un succès restitue sa tentative', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const post = (code: string) =>
    h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code }), headers: { 'x-forwarded-for': '6.6.6.6' } });
  for (let i = 0; i < 4; i++) assert.equal((await post('faux')).status, 401);
  assert.equal((await post('sesame')).status, 303);
  // Les 4 échecs restent comptés, la tentative réussie est restituée : il reste exactement 1 essai.
  assert.equal((await post('faux')).status, 401);
  assert.equal((await post('faux')).status, 429);
});

test('code : des IP en rotation ne dépassent pas 20 essais par heure sur un artefact', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const post = (code: string, ip: string) =>
    h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code }), headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 20; i++) assert.equal((await post('faux', `10.0.0.${i}`)).status, 401);
  assert.equal((await post('sesame', '10.0.1.1')).status, 429);
  h.clock.advance(16 * 60_000);
  assert.equal((await post('sesame', '10.0.1.2')).status, 429, 'toujours bloqué après le verrou de 15 min');
  h.clock.advance(45 * 60_000);
  assert.equal((await post('sesame', '10.0.1.3')).status, 303, 'fenêtre d’une heure écoulée');
});

test('redirections, pages de code, 404 : Cache-Control no-store ; redirection signée avec CORS', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'pub', visibility: 'public', files: SITE });
  await seedArtifact(h, { slug: 'c', visibility: 'code', code: 'sesame', files: SITE });
  const redirect = await h.content.request('/a/pub');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('cache-control'), 'no-store');
  assert.equal(redirect.headers.get('access-control-allow-origin'), '*');
  assert.equal((await h.content.request('/a/c')).headers.get('cache-control'), 'no-store');
  assert.equal((await h.content.request('/a/inconnu')).headers.get('cache-control'), 'no-store');
  const unlocked = await h.content.request('/unlock/c', { method: 'POST', body: new URLSearchParams({ code: 'sesame' }) });
  assert.equal(unlocked.headers.get('cache-control'), 'no-store');
  const served = await h.content.request(redirect.headers.get('location')!);
  assert.equal(served.headers.get('cache-control'), 'private, max-age=3600');
});

const PAGE = '<!doctype html><html><head><title>t</title></head><body><script>run()</script></body></html>';

test('stockage simulé : shim injecté avant le premier script, en-têtes inchangés', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'mem', visibility: 'public', memoryStorage: true, files: { 'index.html': PAGE, 'app.js': 'localStorage.x', 'doc.pdf': '%PDF' } });
  const { location, res } = await follow(h, '/a/mem');
  const buf = Buffer.from(await res.arrayBuffer());
  const body = buf.toString('utf8');
  assert.ok(body.includes('__hubStore'));
  assert.ok(body.indexOf('__hubStore') < body.indexOf('run()'));
  assert.ok(body.startsWith('<!doctype html><html><head><script>'));
  assert.equal(res.headers.get('content-length'), String(buf.length));
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  await seedArtifact(h, { slug: 'plain', visibility: 'public', files: { 'index.html': PAGE } });
  assert.equal(res.headers.get('content-security-policy'), (await follow(h, '/a/plain')).res.headers.get('content-security-policy'));
  assert.match(res.headers.get('content-security-policy')!, /^sandbox allow-scripts /);
  assert.doesNotMatch(res.headers.get('content-security-policy')!, /allow-same-origin/);
  const js = await h.content.request(location.replace('index.html', 'app.js'));
  assert.equal(await js.text(), 'localStorage.x');
  const pdf = await h.content.request(location.replace('index.html', 'doc.pdf'));
  assert.equal(await pdf.text(), '%PDF');
});

test('stockage simulé : octets multi-octets, Content-Length exact', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'mem', visibility: 'public', kind: 'html', memoryStorage: true, files: { 'index.html': '<html><head></head>é€😀' } });
  const { res } = await follow(h, '/a/mem');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get('content-length'), String(buf.length));
  assert.ok(buf.toString('utf8').endsWith('é€😀'));
});

test('stockage simulé désactivé : page inchangée', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'nomem', visibility: 'public', files: { 'index.html': PAGE } });
  const { res } = await follow(h, '/a/nomem');
  assert.equal(await res.text(), PAGE);
});

test('stockage simulé : jamais pour Markdown, ni au-delà de 2 Mio', async () => {
  const h = await setup();
  await seedArtifact(h, { slug: 'md', visibility: 'public', kind: 'markdown', memoryStorage: true, files: { 'index.html': PAGE } });
  assert.equal(await (await follow(h, '/a/md')).res.text(), PAGE);
  const big = PAGE + ' '.repeat(2 * 1024 * 1024);
  await seedArtifact(h, { slug: 'big', visibility: 'public', kind: 'html', memoryStorage: true, files: { 'index.html': big } });
  const res = (await follow(h, '/a/big')).res;
  assert.equal((await res.text()).includes('__hubStore'), false);
});

// Artifact site (v1 : old.html + app.js) puis v2 markdown courante, avec chemins signés vers chaque version.
async function twoVersions() {
  const h = await setup();
  const art = await seedArtifact(h, { slug: 'hist', visibility: 'private', files: { 'index.html': '<p>v1</p><a href="page.html">p</a>', 'page.html': 'v1-page' } });
  const v1 = art.current_version_id!;
  const v2 = newId();
  const dir = versionDir(h.cfg.dataDir, art.id, v2);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<p>v2</p>');
  activateVersion(h.db, art.id, { id: v2, entry_path: 'index.html', original_name: 'v2.md', size_bytes: 1, file_count: 1 }, 'markdown');
  const cur = getArtifact(h.db, art.id)!;
  const now = Math.floor(h.clock.now() / 1000);
  const fields = (versionId: string) => ({ artifactId: art.id, versionId, epoch: cur.access_epoch });
  return { h, art: cur, v1, v2, now, pinned: (v: string) => `/a/hist/${signPinnedPath(h.keys.pathSig, fields(v), now)}`, normal: (v: string) => `/a/hist/${signPath(h.keys.pathSig, fields(v), now)}` };
}

test('chemin épinglé : sert l’ancienne version (même sur un artifact privé), CSP selon le type de cette version', async () => {
  const t = await twoVersions();
  const res = await t.h.content.request(`${t.pinned(t.v1)}/index.html`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /v1/);
  // v1 est un site : scripts autorisés dans le bac à sable ; la version courante (markdown) reste sans scripts.
  assert.match(res.headers.get('content-security-policy')!, /^sandbox allow-scripts /);
  const cur = await t.h.content.request(`${t.normal(t.v2)}/index.html`);
  assert.doesNotMatch(cur.headers.get('content-security-policy')!, /allow-scripts/);
  assert.match(await cur.text(), /v2/);
  // Les liens relatifs gardent le préfixe épinglé.
  const sibling = await t.h.content.request(`${t.pinned(t.v1)}/page.html`);
  assert.equal(await sibling.text(), 'v1-page');
});

test('chemin normal vers une ancienne version : 302 vers l’URL non signée (périmé)', async () => {
  const t = await twoVersions();
  const res = await t.h.content.request(`${t.normal(t.v1)}/index.html`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/a/hist/index.html');
});

test('chemin épinglé : falsifié, étranger à l’artifact ou version inconnue → 404 ; expiré/epoch → 302', async () => {
  const t = await twoVersions();
  const good = t.pinned(t.v1);
  const flipped = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
  assert.equal((await t.h.content.request(`${flipped}/index.html`)).status, 404);
  assert.equal((await t.h.content.request(`${good.replace(t.v1, newId())}/index.html`)).status, 404);
  // Signature valide mais version d'un autre artifact : jamais servie.
  const other = await seedArtifact(t.h, { slug: 'autre', visibility: 'public', files: { 'index.html': 'SECRET-AUTRE' } });
  const foreign = signPinnedPath(t.h.keys.pathSig, { artifactId: t.art.id, versionId: other.current_version_id!, epoch: t.art.access_epoch }, t.now);
  const res = await t.h.content.request(`/a/hist/${foreign}/index.html`);
  assert.equal(res.status, 404);
  const gone = signPinnedPath(t.h.keys.pathSig, { artifactId: t.art.id, versionId: newId(), epoch: t.art.access_epoch }, t.now);
  assert.equal((await t.h.content.request(`/a/hist/${gone}/index.html`)).status, 404);
  bumpEpoch(t.h.db, t.art.id);
  assert.equal((await t.h.content.request(`${good}/index.html`)).status, 302);
  t.h.clock.advance(3601_000);
  assert.equal((await t.h.content.request(`${good}/index.html`)).status, 302);
});

test('un jeton normal ne devient pas épinglé en éditant le préfixe', async () => {
  const t = await twoVersions();
  const normal = t.normal(t.v1); // /a/hist/~<id>.<epoch>.<exp>.<mac>
  for (const edited of [normal.replace('/~', '/~p'), normal.replace('/~', '/~P'), normal.replace('/~', '/~p~')]) {
    assert.equal((await t.h.content.request(`${edited}/index.html`)).status, 404, edited);
  }
});
