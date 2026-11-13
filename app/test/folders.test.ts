import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeGrant, grantCookieName } from '../src/content/grant.ts';
import { decodeFolderGrant, encodeFolderGrant, folderCookieName, signFolderPreview } from '../src/content/folder-grant.ts';
import { decodeGrant } from '../src/content/grant.ts';
import { deriveKeys, encrypt, hashSecret, randomToken, sha256 } from '../src/crypto.ts';
import { newId } from '../src/ids.ts';
import {
  deleteProject, getLink, getProject, insertLink, renameProject, revokeFolderLink, setVersionThumb, updateArtifact, upsertProject, bumpProjectEpoch, type Visibility,
} from '../src/repo.ts';
import { thumbPath, thumbsDir } from '../src/storage.ts';
import { seedArtifact, setCookies, setup, type Harness } from './harness.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const PAGE = { 'index.html': '<p>contenu</p>' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function get(h: Harness, path: string, o: { cookie?: string; ip?: string; ua?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? '203.0.113.7' };
  if (o.ua !== null) headers['user-agent'] = o.ua ?? UA;
  if (o.cookie) headers.cookie = o.cookie;
  return h.content.request(path, { method: o.method ?? 'GET', headers });
}

/** Dossier « client » : un artifact privé, un public ; un autre projet « interne » avec un artifact privé. */
async function folder(visibility: Visibility, o: { code?: string; title?: string; description?: string } = {}) {
  const h = await setup();
  const priv = await seedArtifact(h, { slug: 'maquette-privee', visibility: 'private', project: 'client', files: PAGE, kind: 'html', title: 'Maquette privée' });
  const pub = await seedArtifact(h, { slug: 'rapport-public', visibility: 'public', project: 'client', files: PAGE, kind: 'html', title: 'Rapport public' });
  const other = await seedArtifact(h, { slug: 'secret-interne', visibility: 'private', project: 'interne', files: PAGE, kind: 'html', title: 'Secret interne' });
  upsertProject(h.db, 'interne', { visibility: 'public', title: 'Interne' });
  upsertProject(h.db, 'client', { visibility, title: o.title, description: o.description, code_hash: o.code ? await hashSecret(o.code) : null });
  return { h, priv, pub, other };
}

function folderLink(h: Harness, project: string, expiresAt: string | null = null) {
  const token = randomToken();
  const link = insertLink(h.db, { id: newId(), project_name: project, token_hash: sha256(token), token_enc: encrypt(h.keys.linkEnc, token), label: null, expires_at: expiresAt });
  return { token, link };
}

const views = (h: Harness, table: 'visit_days' | 'folder_visit_days', key: string) =>
  Number((h.db.prepare(`SELECT COALESCE(SUM(views), 0) AS n FROM ${table} WHERE ${table === 'visit_days' ? 'artifact_id' : 'project_name'} = ?`).get(key) as { n: number }).n);

test('dossier privé, sans fiche ou inconnu : 404 partout, comme un dossier inexistant', async () => {
  const { h } = await folder('private');
  for (const path of ['/d/client', '/d/client/', '/d/client/a/rapport-public', '/d/sans-fiche', '/d/inconnu', '/d/Client', '/d/client/../../a/maquette-privee', '/d/x%2Fy']) {
    const res = await get(h, path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('content-security-policy')!, /^sandbox /);
  }
});

test('dossier public : page sans scripts, contenu du dossier seulement, tout échappé', async () => {
  const { h } = await folder('public', { title: 'Client <b>Acme</b>', description: 'Maquettes "v2" & <script>alert(1)</script>' });
  updateArtifact(h.db, (await seedArtifact(h, { slug: 'xss', visibility: 'private', project: 'client', files: PAGE, kind: 'html' })).id, { title: '<img src=x onerror=alert(1)>' }, false);
  const res = await get(h, '/d/client');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=UTF-8');
  const csp = res.headers.get('content-security-policy')!;
  assert.match(csp, /^sandbox /);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Client &lt;b&gt;Acme&lt;\/b&gt;/);
  assert.match(html, /Maquettes &quot;v2&quot; &amp; &lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /href="\/d\/client\/a\/maquette-privee"/);
  assert.match(html, /href="\/d\/client\/a\/rapport-public"/);
  assert.match(html, /3 artifacts/);
  for (const leak of ['secret-interne', 'Secret interne', 'Interne']) assert.ok(!html.includes(leak), leak);
  // Bascule de thème en CSS pur.
  assert.match(html, /id="theme-toggle"/);
  assert.equal((await get(h, '/d/client/')).status, 200);
});

test('ordre de la page : choisi par l’admin, sinon les plus récents en premier', async () => {
  const { h, priv, pub } = await folder('public');
  const order = (html: string) => [...html.matchAll(/href="\/d\/client\/a\/([a-z-]+)"/g)].map((m) => m[1]);
  h.db.prepare("UPDATE artifacts SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(priv.id);
  assert.deepEqual(order(await (await get(h, '/d/client')).text()), ['rapport-public', 'maquette-privee']);
  h.db.prepare('UPDATE artifacts SET project_position = ? WHERE id = ?').run(0, priv.id);
  h.db.prepare('UPDATE artifacts SET project_position = ? WHERE id = ?').run(1, pub.id);
  assert.deepEqual(order(await (await get(h, '/d/client')).text()), ['maquette-privee', 'rapport-public']);
});

test('accès combiné : un artifact privé s’ouvre via le dossier, jamais via /a/<slug>', async () => {
  const { h, priv } = await folder('public');
  const entry = await get(h, '/d/client/a/maquette-privee');
  assert.equal(entry.status, 302);
  const location = entry.headers.get('location')!;
  assert.match(location, new RegExp(`^/a/maquette-privee/~${priv.current_version_id}\\.1\\.\\d+\\.[A-Za-z0-9_-]{43}/index\\.html$`));
  const served = await get(h, location);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), '<p>contenu</p>');
  assert.equal((await get(h, '/a/maquette-privee')).status, 404, 'la visibilité propre de l’artifact ne change pas');
  assert.equal(getProject(h.db, 'client')!.visibility, 'public');
});

test('accès combiné : appartenance vérifiée maintenant, aucune traversée vers un autre projet', async () => {
  const { h, priv, other } = await folder('public');
  assert.equal((await get(h, '/d/client/a/secret-interne')).status, 404, 'artifact d’un autre projet');
  assert.equal((await get(h, '/d/client/a/inconnu')).status, 404);
  assert.equal((await get(h, '/d/client/a/maquette-privee/../../secret-interne')).status, 404);
  assert.equal((await get(h, '/d/client/a/..%2F..%2Finterne%2Fa%2Fsecret-interne')).status, 404);
  assert.equal((await get(h, `/d/client/a/${other.id}`)).status, 404);
  updateArtifact(h.db, priv.id, { project: 'interne' }, false);
  assert.equal((await get(h, '/d/client/a/maquette-privee')).status, 404, 'retiré du dossier : refusé immédiatement');
  updateArtifact(h.db, priv.id, { project: null }, false);
  assert.equal((await get(h, '/d/client/a/maquette-privee')).status, 404);
});

test('code : formulaire, échec, succès, cookie de dossier dédié, puis accès au contenu', async () => {
  const { h } = await folder('code', { code: 'sesame-dossier', title: 'Dossier <client>' });
  const form = await get(h, '/d/client');
  assert.equal(form.status, 401);
  const html = await form.text();
  assert.match(html, /action="\/unlock-folder\/client"/);
  assert.match(html, /Dossier &lt;client&gt;/);
  assert.equal((await get(h, '/d/client/a/maquette-privee')).status, 401, 'entrée d’artifact : même formulaire');
  const post = (code: string, ip = '1.2.3.4') =>
    h.content.request('/unlock-folder/client', { method: 'POST', body: new URLSearchParams({ code }), headers: { 'x-forwarded-for': ip } });
  assert.equal((await post('mauvais')).status, 401);
  const ok = await post('sesame-dossier');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/d/client');
  const line = ok.headers.getSetCookie()[0];
  assert.match(line, /^__Host-fgrant_client=[^;]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const cookie = setCookies(ok);
  assert.equal((await get(h, '/d/client', { cookie })).status, 200);
  assert.equal((await get(h, '/d/client/a/maquette-privee', { cookie })).status, 302);
  assert.equal((await get(h, '/a/maquette-privee', { cookie })).status, 404, 'le cookie de dossier n’ouvre pas /a/<slug>');
  // Un dossier non « code » refuse le formulaire.
  assert.equal((await h.content.request('/unlock-folder/interne', { method: 'POST', body: new URLSearchParams({ code: 'x' }) })).status, 404);
  assert.equal((await h.content.request('/unlock-folder/inconnu', { method: 'POST', body: new URLSearchParams({ code: 'x' }) })).status, 404);
});

test('code : limites partagées avec les artifacts (5 par IP, 20 par heure et par dossier, réservées avant vérification)', async () => {
  const { h } = await folder('code', { code: 'sesame-dossier' });
  const post = (code: string, ip: string) =>
    h.content.request('/unlock-folder/client', { method: 'POST', body: new URLSearchParams({ code }), headers: { 'x-forwarded-for': ip } });
  const statuses = (await Promise.all(Array.from({ length: 12 }, () => post('faux', '9.9.9.9')))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 7);
  assert.equal((await post('sesame-dossier', '9.9.9.9')).status, 429);
  for (let i = 0; i < 15; i++) assert.equal((await post('faux', `10.0.0.${i}`)).status, 401);
  assert.equal((await post('sesame-dossier', '10.0.1.1')).status, 429, 'verrou global du dossier');
  h.clock.advance(61 * 60_000);
  assert.equal((await post('sesame-dossier', '10.0.1.2')).status, 303);
});

test('code : changer le code ou couper les accès (epoch du dossier) invalide les cookies', async () => {
  const { h } = await folder('code', { code: 'sesame-dossier' });
  const ok = await h.content.request('/unlock-folder/client', { method: 'POST', body: new URLSearchParams({ code: 'sesame-dossier' }) });
  const cookie = setCookies(ok);
  assert.equal((await get(h, '/d/client', { cookie })).status, 200);
  bumpProjectEpoch(h.db, 'client');
  assert.equal((await get(h, '/d/client', { cookie })).status, 401);
  assert.equal((await get(h, '/d/client/a/rapport-public', { cookie })).status, 401);
});

test('lien de dossier : échange, accès, révocation, expiration ; le lien n’ouvre rien hors du dossier', async () => {
  const { h, pub } = await folder('link');
  assert.equal((await get(h, '/d/client')).status, 404, 'sans accès : 404');
  const { token, link } = folderLink(h, 'client', new Date(h.clock.now() + 2 * 3600_000).toISOString());
  const share = await get(h, `/share/${token}`);
  assert.equal(share.status, 302);
  assert.equal(share.headers.get('location'), '/d/client');
  const line = share.headers.getSetCookie()[0];
  assert.match(line, /^__Host-fgrant_client=[^;]+; Max-Age=7200; Path=\/; HttpOnly; Secure; SameSite=Lax/, 'plafonné par l’expiration du lien');
  assert.equal(getLink(h.db, link.id)!.open_count, 1);
  const cookie = setCookies(share);
  assert.equal((await get(h, '/d/client', { cookie })).status, 200);
  assert.equal((await get(h, '/d/client/a/maquette-privee', { cookie })).status, 302);
  assert.equal((await get(h, '/d/interne', { cookie: cookie.replace('fgrant_client', 'fgrant_interne') })).status, 200, 'interne est public de toute façon');
  updateArtifact(h.db, pub.id, { visibility: 'link' }, true);
  assert.equal((await get(h, '/a/rapport-public', { cookie })).status, 404, 'un lien de dossier ne donne pas l’accès « lien » de l’artifact');

  revokeFolderLink(h.db, 'client', link.id);
  assert.equal((await get(h, '/d/client', { cookie })).status, 404, 'révoqué : refus immédiat');
  assert.equal((await get(h, '/d/client/a/maquette-privee', { cookie })).status, 404);
  assert.equal((await get(h, `/share/${token}`)).status, 404);

  const second = folderLink(h, 'client', new Date(h.clock.now() + 3600_000).toISOString());
  const cookie2 = setCookies(await get(h, `/share/${second.token}`));
  assert.equal((await get(h, '/d/client', { cookie: cookie2 })).status, 200);
  h.clock.advance(3601_000);
  assert.equal((await get(h, '/d/client', { cookie: cookie2 })).status, 404, 'lien expiré');
  assert.equal((await get(h, `/share/${second.token}`)).status, 404);
});

test('lien de dossier : refusé si le dossier n’est plus en visibilité « lien » ; couper les accès invalide le cookie', async () => {
  const { h } = await folder('link');
  const { token } = folderLink(h, 'client');
  const cookie = setCookies(await get(h, `/share/${token}`));
  assert.equal((await get(h, '/d/client', { cookie })).status, 200);
  bumpProjectEpoch(h.db, 'client');
  assert.equal((await get(h, '/d/client', { cookie })).status, 404);
  upsertProject(h.db, 'client', { visibility: 'private' }, true);
  assert.equal((await get(h, `/share/${token}`)).status, 404);
});

test('cookies : un accès de dossier n’est jamais accepté comme accès d’artifact, ni l’inverse', async () => {
  const keys = deriveKeys(Buffer.alloc(32, 7));
  assert.notDeepEqual(keys.folderGrant, keys.grant);
  const now = Math.floor(Date.now() / 1000);
  const f = encodeFolderGrant(keys.folderGrant, { p: 'client', s: 'sel', e: 1, l: null, x: now + 600 });
  const a = encodeGrant(keys.grant, { a: 'client', e: 1, l: null, x: now + 600 });
  assert.equal(decodeGrant(keys.grant, f), null, 'grant de dossier lu comme grant d’artifact');
  assert.equal(decodeFolderGrant(keys.folderGrant, a), null, 'grant d’artifact lu comme grant de dossier');
  assert.deepEqual(decodeFolderGrant(keys.folderGrant, f), { p: 'client', s: 'sel', e: 1, l: null, x: now + 600 });

  // De bout en bout : artifact « code » et dossier « code », chacun déverrouillé, cookies échangés.
  const { h } = await folder('code', { code: 'sesame-dossier' });
  const art = await seedArtifact(h, { slug: 'art-code', visibility: 'code', code: 'sesame-art', project: 'client', files: PAGE, kind: 'html' });
  const folderCookie = (await h.content.request('/unlock-folder/client', { method: 'POST', body: new URLSearchParams({ code: 'sesame-dossier' }) })).headers.getSetCookie()[0].split(';')[0];
  const artCookie = (await h.content.request('/unlock/art-code', { method: 'POST', body: new URLSearchParams({ code: 'sesame-art' }) })).headers.getSetCookie()[0].split(';')[0];
  const folderValue = folderCookie.split('=').slice(1).join('=');
  const artValue = artCookie.split('=').slice(1).join('=');
  assert.equal((await get(h, '/a/art-code', { cookie: `${grantCookieName(art.id)}=${folderValue}` })).status, 401, 'valeur de dossier sous le nom d’artifact');
  assert.equal((await get(h, '/d/client', { cookie: `${folderCookieName('client')}=${artValue}` })).status, 401, 'valeur d’artifact sous le nom de dossier');
  assert.equal((await get(h, '/a/art-code', { cookie: artCookie })).status, 302);
  assert.equal((await get(h, '/d/client', { cookie: folderCookie })).status, 200);
  // Un grant de dossier pour un autre dossier ne vaut rien ici.
  const forOther = encodeFolderGrant(h.keys.folderGrant, { p: 'interne', s: getProject(h.db, 'interne')!.salt, e: 1, l: null, x: Math.floor(h.clock.now() / 1000) + 600 });
  assert.equal((await get(h, '/d/client', { cookie: `${folderCookieName('client')}=${forOther}` })).status, 401);
});

test('lien d’artifact : n’ouvre jamais le dossier', async () => {
  const { h } = await folder('link');
  const art = await seedArtifact(h, { slug: 'partage', visibility: 'link', project: 'client', files: PAGE, kind: 'html' });
  const token = randomToken();
  insertLink(h.db, { id: newId(), artifact_id: art.id, token_hash: sha256(token), token_enc: encrypt(h.keys.linkEnc, token), label: null, expires_at: null });
  const share = await get(h, `/share/${token}`);
  assert.equal(share.headers.get('location'), '/a/partage');
  assert.equal((await get(h, '/d/client', { cookie: setCookies(share) })).status, 404);
});

async function withThumb(h: Harness, art: { id: string; current_version_id: string | null }) {
  const v = art.current_version_id!;
  await mkdir(thumbsDir(h.cfg.dataDir, art.id), { recursive: true });
  await writeFile(thumbPath(h.cfg.dataDir, art.id, v, 'png'), PNG);
  setVersionThumb(h.db, art.id, v, { thumb_type: 'png', thumb_at: new Date(h.clock.now()).toISOString() });
  return v;
}

test('miniatures : servies par le dossier avec accès et appartenance, dimensions et alt vide sur la page', async () => {
  const { h, priv } = await folder('public');
  const v = await withThumb(h, priv);
  const html = await (await get(h, '/d/client')).text();
  const src = new RegExp(`<img src="(/d/client/thumb/${priv.id}/${v}\\?s=[^"]+)" width="960" height="600" alt=""`).exec(html);
  assert.ok(src, 'miniature présente avec dimensions et alt vide');
  const res = await get(h, src[1].replace(/&amp;/g, '&'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control')!, /^private/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  // Sans signature, l'accès au dossier (public ici) suffit aussi.
  assert.equal((await get(h, `/d/client/thumb/${priv.id}/${v}`)).status, 200);
});

test('miniatures : jamais sans accès au dossier, jamais hors appartenance, jamais hors dossier', async () => {
  const { h, priv, other } = await folder('link');
  const v = await withThumb(h, priv);
  const vo = await withThumb(h, other);
  assert.equal((await get(h, `/d/client/thumb/${priv.id}/${v}`)).status, 404, 'dossier « lien » sans cookie');
  const { token, link } = folderLink(h, 'client');
  const cookie = setCookies(await get(h, `/share/${token}`));
  assert.equal((await get(h, `/d/client/thumb/${priv.id}/${v}`, { cookie })).status, 200);
  const signed = /<img src="([^"]+)"/.exec(await (await get(h, '/d/client', { cookie })).text())![1].replace(/&amp;/g, '&');
  assert.equal((await get(h, signed)).status, 200, 'URL signée de la page : servie sans cookie (document sandboxé)');
  assert.equal((await get(h, signed.replace(/s=[^&]+/, (s) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A')))).status, 404, 'signature falsifiée');
  assert.equal((await get(h, signed.replace(priv.id, other.id).replace(v, vo))).status, 404, 'signature d’une autre miniature');
  assert.equal((await get(h, `/d/client/thumb/${other.id}/${vo}`, { cookie })).status, 404, 'artifact d’un autre projet');
  assert.equal((await get(h, `/d/interne/thumb/${priv.id}/${v}`)).status, 404, 'via un autre dossier public');
  assert.equal((await get(h, `/d/client/thumb/${priv.id}/${newId()}`, { cookie })).status, 404, 'version inconnue');
  assert.equal((await get(h, `/d/client/thumb/${priv.id}/${vo}`, { cookie })).status, 404, 'version d’un autre artifact');
  // Retiré du dossier : refus immédiat, cookie ou signature.
  updateArtifact(h.db, priv.id, { project: 'interne' }, false);
  assert.equal((await get(h, `/d/client/thumb/${priv.id}/${v}`, { cookie })).status, 404);
  assert.equal((await get(h, signed)).status, 404);
  updateArtifact(h.db, priv.id, { project: 'client' }, false);
  // Couper les accès : la signature (qui porte l'époque) et le cookie tombent.
  bumpProjectEpoch(h.db, 'client');
  assert.equal((await get(h, signed)).status, 404);
  assert.equal((await get(h, `/d/client/thumb/${priv.id}/${v}`, { cookie })).status, 404);
  revokeFolderLink(h.db, 'client', link.id);
  // Hors dossier : aucune route de miniature sur le serveur de contenu.
  for (const path of [`/thumbs/${priv.id}/${v}.png`, `/a/maquette-privee/thumb`, `/d/thumb/${priv.id}/${v}`]) {
    assert.notEqual((await get(h, path)).headers.get('content-type'), 'image/png', path);
  }
});

test('visites : la page du dossier compte pour le dossier, l’entrée /d/…/a/<slug> pour l’artifact, une seule fois', async () => {
  const { h, priv } = await folder('public');
  assert.equal((await get(h, '/d/client')).status, 200);
  await get(h, '/d/client'); // dédoublonné (30 min)
  await get(h, '/d/client', { ua: 'Googlebot/2.1' });
  await get(h, '/d/client', { ua: null });
  await get(h, '/d/client', { method: 'HEAD' });
  assert.equal(views(h, 'folder_visit_days', 'client'), 1);
  const entry = await get(h, '/d/client/a/maquette-privee');
  await get(h, entry.headers.get('location')!);
  assert.equal(views(h, 'visit_days', priv.id), 1, 'la redirection signée ne compte pas en plus');
  await get(h, '/d/client/a/maquette-privee', { ua: 'curl/8' });
  assert.equal(views(h, 'visit_days', priv.id), 1);
  h.clock.advance(31 * 60_000);
  await get(h, '/d/client');
  assert.equal(views(h, 'folder_visit_days', 'client'), 2);
  // Aucune IP ni User-Agent stockés.
  const dump = JSON.stringify(h.db.prepare('SELECT * FROM folder_visit_seen').all()) + JSON.stringify(h.db.prepare('SELECT * FROM folder_visit_days').all());
  assert.ok(!dump.includes('203.0.113.7') && !dump.includes('Safari'));
  // Formulaire de code et 404 : jamais comptés.
  const { h: h2 } = await folder('code', { code: 'sesame-dossier' });
  await get(h2, '/d/client');
  assert.equal(views(h2, 'folder_visit_days', 'client'), 0);
});

/** Dossier « code » déverrouillé : cookie, URL signée de miniature et aperçu admin, tous émis pour la fiche actuelle. */
async function issuedCredentials() {
  const { h, priv } = await folder('code', { code: 'sesame-dossier' });
  const v = await withThumb(h, priv);
  const cookie = setCookies(await h.content.request('/unlock-folder/client', { method: 'POST', body: new URLSearchParams({ code: 'sesame-dossier' }) }));
  const thumb = /<img src="([^"]+)"/.exec(await (await get(h, '/d/client', { cookie })).text())![1].replace(/&amp;/g, '&');
  const preview = `/d/client?preview=${signFolderPreview(h.keys.folderPreview, getProject(h.db, 'client')!, Math.floor(h.clock.now() / 1000))}`;
  for (const [path, c] of [['/d/client', cookie], [thumb, ''], [preview, '']]) assert.equal((await get(h, path, { cookie: c })).status, 200, path);
  return { h, priv, v, cookie, thumb, preview };
}

async function assertAllRejected(t: Awaited<ReturnType<typeof issuedCredentials>>) {
  const { h, cookie, thumb, preview } = t;
  assert.equal((await get(h, '/d/client', { cookie })).status, 401, 'ancien cookie de code : formulaire, pas d’accès');
  assert.equal((await get(h, '/d/client/a/maquette-privee', { cookie })).status, 401);
  assert.equal((await get(h, thumb)).status, 404, 'ancienne signature de miniature');
  assert.equal((await get(h, preview)).status, 404, 'ancien aperçu');
}

test('fiche supprimée puis recréée sous le même nom : anciens cookie, miniature signée et aperçu refusés (même époque)', async () => {
  const t = await issuedCredentials();
  const oldSalt = getProject(t.h.db, 'client')!.salt;
  deleteProject(t.h.db, 'client');
  const again = upsertProject(t.h.db, 'client', { visibility: 'code', code_hash: await hashSecret('sesame-dossier') });
  assert.equal(again.access_epoch, 1, 'même époque qu’avant : seul le sel distingue les deux fiches');
  assert.notEqual(again.salt, oldSalt);
  await assertAllRejected(t);
  // Le parcours normal fonctionne sur la nouvelle fiche.
  const fresh = setCookies(await t.h.content.request('/unlock-folder/client', { method: 'POST', body: new URLSearchParams({ code: 'sesame-dossier' }) }));
  assert.equal((await get(t.h, '/d/client', { cookie: fresh })).status, 200);
});

test('projet renommé puis nom réutilisé : anciens cookie, miniature signée et aperçu refusés', async () => {
  const t = await issuedCredentials();
  renameProject(t.h.db, 'client', 'client-ancien');
  upsertProject(t.h.db, 'client', { visibility: 'code', code_hash: await hashSecret('sesame-dossier') });
  updateArtifact(t.h.db, t.priv.id, { project: 'client' }, false); // même artifact, même version : seule la fiche a changé
  await assertAllRejected(t);
});
