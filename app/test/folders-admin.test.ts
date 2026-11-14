import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret } from '../src/crypto.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { getProject, listFolderLinks, setVersionThumb, upsertProject } from '../src/repo.ts';
import { thumbPath, thumbsDir } from '../src/storage.ts';
import { seedArtifact, setCookies, setup } from './harness.ts';

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';
const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15';
const PAGE = { 'index.html': '<p>x</p>' };

async function adminSetup() {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD) });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions), now: h.clock.now });
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const cookie = setCookies(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await admin.request(`/api${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const priv = await seedArtifact(h, { slug: 'privee', visibility: 'private', project: 'client', files: PAGE, kind: 'html', title: 'Privée' });
  const pub = await seedArtifact(h, { slug: 'publique', visibility: 'public', project: 'client', files: PAGE, kind: 'html', title: 'Publique' });
  const other = await seedArtifact(h, { slug: 'ailleurs', visibility: 'private', project: 'interne', files: PAGE, kind: 'html' });
  return { ...h, admin, call, cookie, csrfToken, priv, pub, other };
}

const visit = (h: Awaited<ReturnType<typeof adminSetup>>, path: string, cookie = '') =>
  h.content.request(path, { headers: { 'user-agent': UA, 'x-forwarded-for': '203.0.113.5', ...(cookie ? { cookie } : {}) } });

test('GET /api/projects : visibilité du dossier, nombre d’artifacts et de privés, dossiers vides inclus', async () => {
  const h = await adminSetup();
  upsertProject(h.db, 'vide', { title: 'Vide' });
  const { body } = await h.call('GET', '/projects');
  // Champs historiques ; latestUpdatedAt, recent, url et activeLinkUrl sont vérifiés par le test suivant.
  assert.deepEqual(body.map(({ name, count, privateCount, visibility, title }: Record<string, unknown>) => ({ name, count, privateCount, visibility, title })), [
    { name: 'client', count: 2, privateCount: 1, visibility: 'private', title: null },
    { name: 'interne', count: 1, privateCount: 1, visibility: 'private', title: null },
    { name: 'vide', count: 0, privateCount: 0, visibility: 'private', title: 'Vide' },
  ]);
});

test('GET /api/projects : dernière activité, 4 plus récents (miniature), adresse et lien actif pour la carte du dossier', async () => {
  const h = await adminSetup();
  const at = (id: string, iso: string) => h.db.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').run(iso, id);
  at(h.priv.id, '2026-01-01T00:00:00.000Z');
  at(h.pub.id, '2026-01-02T00:00:00.000Z');
  at(h.other.id, '2026-01-03T00:00:00.000Z');
  const more = [];
  for (const [i, slug] of ['c3', 'c4', 'c5'].entries()) {
    const a = await seedArtifact(h, { slug, visibility: 'private', project: 'client', files: PAGE, kind: i === 0 ? 'markdown' : 'html' });
    at(a.id, `2026-01-0${i + 4}T00:00:00.000Z`);
    more.push(a);
  }
  const loose = await seedArtifact(h, { slug: 'libre', visibility: 'public', files: PAGE, kind: 'pdf' });
  at(loose.id, '2026-02-01T00:00:00.000Z');
  setVersionThumb(h.db, more[2].id, more[2].current_version_id!, { thumb_type: 'png', thumb_at: new Date(h.clock.now()).toISOString() });
  // Fiche plus ancienne que ses artifacts : la dernière activité est celle de l'artifact le plus récent.
  upsertProject(h.db, 'client', { visibility: 'public' });
  h.db.prepare('UPDATE projects SET updated_at = ? WHERE name = ?').run('2025-12-01T00:00:00.000Z', 'client');
  // Fiche plus récente que ses artifacts : la dernière activité est celle de la fiche.
  assert.equal((await h.call('PATCH', '/projects/interne', { visibility: 'link' })).status, 200);
  const link = await h.call('POST', '/projects/interne/links', { label: null, expiresAt: null });
  assert.equal(link.status, 201);
  upsertProject(h.db, 'vide', {});

  const { status, body } = await h.call('GET', '/projects');
  assert.equal(status, 200);
  const by = (name: string | null) => body.find((p: { name: string | null }) => p.name === name);

  const client = by('client');
  assert.equal(client.latestUpdatedAt, '2026-01-06T00:00:00.000Z');
  assert.deepEqual(client.recent.map((r: { id: string }) => r.id), [more[2].id, more[1].id, more[0].id, h.pub.id]);
  assert.deepEqual(client.recent[2], { id: more[0].id, kind: 'markdown', thumbnailUrl: null });
  assert.match(client.recent[0].thumbnailUrl, new RegExp(`^/api/artifacts/${more[2].id}/thumbnail\\?v=`));
  assert.equal(client.url, 'https://artifacts.test/d/client');
  assert.equal(client.activeLinkUrl, null);

  const interne = by('interne');
  const sheet = getProject(h.db, 'interne')!;
  assert.equal(interne.latestUpdatedAt, sheet.updated_at);
  assert.ok(interne.latestUpdatedAt > '2026-01-03T00:00:00.000Z');
  assert.deepEqual(interne.recent, [{ id: h.other.id, kind: 'html', thumbnailUrl: null }]);
  assert.equal(interne.activeLinkUrl, link.body.url);
  assert.equal(interne.activeLinkUrl, (await h.call('GET', '/projects/interne')).body.activeLinkUrl);

  const vide = by('vide');
  assert.deepEqual(vide.recent, []);
  assert.equal(vide.latestUpdatedAt, getProject(h.db, 'vide')!.updated_at);

  const none = by(null);
  assert.equal(none.count, 1);
  assert.equal(none.latestUpdatedAt, '2026-02-01T00:00:00.000Z');
  assert.deepEqual(none.recent, [{ id: loose.id, kind: 'pdf', thumbnailUrl: null }]);
  assert.equal(none.url, null);
  assert.equal(none.activeLinkUrl, null);
});

test('GET /api/projects/:name : détail sans fiche (privé), ordre, liens ; inconnu ou invalide → 404', async () => {
  const h = await adminSetup();
  const { status, body } = await h.call('GET', '/projects/client');
  assert.equal(status, 200);
  assert.equal(body.name, 'client');
  assert.equal(body.visibility, 'private');
  assert.equal(body.hasCode, false);
  assert.equal(body.url, 'https://artifacts.test/d/client');
  assert.equal(body.count, 2);
  assert.equal(body.privateCount, 1);
  assert.deepEqual(body.links, []);
  assert.deepEqual(body.artifacts.map((a: { slug: string; visibility: string }) => [a.slug, a.visibility]).sort(), [['privee', 'private'], ['publique', 'public']]);
  assert.equal((await h.call('GET', '/projects/inconnu')).status, 404);
  assert.equal((await h.call('GET', '/projects/Pas%20Valide')).status, 404);
});

test('PATCH /api/projects/:name : titre et description sans révoquer ; visibilité et code incrémentent l’époque', async () => {
  const h = await adminSetup();
  let r = await h.call('PATCH', '/projects/client', { title: '  Client Acme ', description: 'Maquettes du T4' });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'Client Acme');
  assert.equal(r.body.description, 'Maquettes du T4');
  assert.equal(getProject(h.db, 'client')!.access_epoch, 1);
  r = await h.call('PATCH', '/projects/client', { visibility: 'public' });
  assert.equal(r.body.visibility, 'public');
  assert.equal(getProject(h.db, 'client')!.access_epoch, 2);
  assert.equal((await h.call('PATCH', '/projects/client', { visibility: 'code' })).status, 400, 'code requis');
  assert.equal((await h.call('PATCH', '/projects/client', { visibility: 'code', code: 'court' })).status, 400);
  r = await h.call('PATCH', '/projects/client', { visibility: 'code', code: 'sesame-long' });
  assert.equal(r.body.hasCode, true);
  assert.equal(getProject(h.db, 'client')!.access_epoch, 3);
  await h.call('PATCH', '/projects/client', { code: 'autre-code' });
  assert.equal(getProject(h.db, 'client')!.access_epoch, 4, 'nouveau code');
  r = await h.call('PATCH', '/projects/client', { visibility: 'link' });
  assert.equal(r.body.hasCode, false, 'code effacé hors visibilité code');
  assert.equal((await h.call('PATCH', '/projects/client', { code: 'sesame-long' })).status, 400, 'code hors visibilité code');
  for (const bad of [{ title: 'x'.repeat(121) }, { description: 'x'.repeat(1001) }, { visibility: 'secret' }, { title: 3 }]) {
    assert.equal((await h.call('PATCH', '/projects/client', bad)).status, 400, JSON.stringify(bad));
  }
  r = await h.call('PATCH', '/projects/client', { title: '', description: null });
  assert.equal(r.body.title, null);
  assert.equal(r.body.description, null);
  assert.equal((await h.call('PATCH', '/projects/Mauvais%20Nom', { title: 'x' })).status, 400);
  assert.equal((await h.call('PATCH', '/projects/inexistant', { title: 'x' })).status, 404, 'ni fiche ni artifact : 404 comme les autres routes');
  assert.equal(getProject(h.db, 'inexistant'), undefined);
});

test('PATCH name : renomme le projet, ses artifacts, sa fiche et ses liens ; nom pris → 409', async () => {
  const h = await adminSetup();
  const share = await h.call('POST', '/projects/client/share', {});
  assert.equal((await h.call('PATCH', '/projects/client', { name: 'interne' })).status, 409);
  assert.equal((await h.call('PATCH', '/projects/client', { name: '!!!' })).status, 400);
  const r = await h.call('PATCH', '/projects/client', { name: 'Client 2026' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'client-2026');
  assert.equal(r.body.url, 'https://artifacts.test/d/client-2026');
  assert.equal(r.body.count, 2);
  assert.deepEqual(r.body.links.map((l: { id: string }) => l.id), [share.body.link.id]);
  assert.equal((await h.call('GET', '/projects/client')).status, 404);
  assert.equal((await h.call('GET', `/artifacts/${h.priv.id}`)).body.project, 'client-2026');
  // Rename d'un projet sans fiche : seuls les artifacts bougent.
  assert.equal((await h.call('PATCH', '/projects/interne', { name: 'interne-2' })).body.count, 1);
});

test('POST share : passe en « lien » (nouvelle époque), crée un lien de 7 jours qui ouvre le dossier', async () => {
  const h = await adminSetup();
  const r = await h.call('POST', '/projects/client/share', {});
  assert.equal(r.status, 201);
  assert.equal(r.body.project.visibility, 'link');
  assert.equal(getProject(h.db, 'client')!.access_epoch, 2);
  assert.match(r.body.link.url, /^https:\/\/artifacts\.test\/share\/[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(r.body.link.expiresAt), h.clock.now() + 168 * 3600_000);
  assert.equal(r.body.project.activeLinkUrl, r.body.link.url);
  const exchange = await visit(h, new URL(r.body.link.url).pathname);
  assert.equal(exchange.headers.get('location'), '/d/client');
  assert.equal((await visit(h, '/d/client', setCookies(exchange))).status, 200);
  // Second partage : pas de nouvelle époque, second lien.
  const again = await h.call('POST', '/projects/client/share', { hours: 2, label: 'Relecture' });
  assert.equal(getProject(h.db, 'client')!.access_epoch, 2);
  assert.equal(again.body.link.label, 'Relecture');
  assert.equal(listFolderLinks(h.db, 'client').length, 2);
  assert.equal((await h.call('POST', '/projects/client/share', { hours: 0 })).status, 400);
});

test('liens de dossier : création, révocation, isolés des liens d’artifact', async () => {
  const h = await adminSetup();
  await h.call('PATCH', '/projects/client', { visibility: 'link' });
  const created = await h.call('POST', '/projects/client/links', { label: 'Client', expiresAt: new Date(h.clock.now() + 3600_000).toISOString() });
  assert.equal(created.status, 201);
  assert.equal(created.body.active, true);
  assert.equal((await h.call('POST', '/projects/client/links', { expiresAt: new Date(h.clock.now() - 1).toISOString() })).status, 400);
  const artLink = await h.call('POST', `/artifacts/${h.pub.id}/links`, {});
  assert.equal((await h.call('DELETE', `/projects/client/links/${artLink.body.id}`)).status, 404, 'lien d’artifact via la route dossier');
  assert.equal((await h.call('DELETE', `/artifacts/${h.pub.id}/links/${created.body.id}`)).status, 404, 'lien de dossier via la route artifact');
  assert.equal((await h.call('DELETE', `/projects/interne/links/${created.body.id}`)).status, 404, 'autre dossier');
  assert.equal((await h.call('DELETE', `/projects/client/links/${created.body.id}`)).status, 200);
  const detail = await h.call('GET', '/projects/client');
  assert.equal(detail.body.links[0].active, false);
  assert.equal(detail.body.activeLinkUrl, null);
  assert.deepEqual((await h.call('GET', `/artifacts/${h.pub.id}`)).body.links.map((l: { id: string }) => l.id), [artLink.body.id]);
});

test('POST revoke-all : invalide les cookies de dossier', async () => {
  const h = await adminSetup();
  const share = await h.call('POST', '/projects/client/share', {});
  const cookie = setCookies(await visit(h, new URL(share.body.link.url).pathname));
  assert.equal((await visit(h, '/d/client', cookie)).status, 200);
  const r = await h.call('POST', '/projects/client/revoke-all');
  assert.equal(r.status, 200);
  assert.equal((await visit(h, '/d/client', cookie)).status, 404);
  assert.equal((await h.call('POST', '/projects/inconnu/revoke-all')).status, 404);
});

test('POST revoke-all sans fiche : la fiche est créée (nouveau sel) et son époque incrémentée', async () => {
  const h = await adminSetup();
  assert.equal(getProject(h.db, 'interne'), undefined);
  const preview = new URL((await h.call('GET', '/projects/interne/preview')).body.url);
  assert.equal((await visit(h, preview.pathname + preview.search)).status, 200);
  const before = getProject(h.db, 'interne')!;
  assert.equal((await h.call('POST', '/projects/interne/revoke-all')).status, 200);
  assert.equal(getProject(h.db, 'interne')!.access_epoch, before.access_epoch + 1);
  assert.equal((await visit(h, preview.pathname + preview.search)).status, 404, 'aperçu déjà émis coupé');
  const h2 = await adminSetup();
  assert.equal((await h2.call('POST', '/projects/interne/revoke-all')).status, 200);
  const created = getProject(h2.db, 'interne')!;
  assert.equal(created.access_epoch, 2);
  assert.match(created.salt, /^[A-Za-z0-9_-]{22}$/);
});

test('PUT order : ordre complet exigé, appliqué à la page et au détail', async () => {
  const h = await adminSetup();
  assert.equal((await h.call('PUT', '/projects/client/order', { ids: [h.priv.id] })).status, 409, 'liste incomplète');
  assert.equal((await h.call('PUT', '/projects/client/order', { ids: [h.priv.id, h.other.id] })).status, 409, 'artifact étranger');
  assert.equal((await h.call('PUT', '/projects/client/order', { ids: 'x' })).status, 400);
  const r = await h.call('PUT', '/projects/client/order', { ids: [h.pub.id, h.priv.id] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.artifacts.map((a: { slug: string }) => a.slug), ['publique', 'privee']);
  const r2 = await h.call('PUT', '/projects/client/order', { ids: [h.priv.id, h.pub.id] });
  assert.deepEqual(r2.body.artifacts.map((a: { slug: string }) => a.slug), ['privee', 'publique']);
  await h.call('PATCH', '/projects/client', { visibility: 'public' });
  const html = await (await visit(h, '/d/client')).text();
  assert.ok(html.indexOf('/a/privee') < html.indexOf('/a/publique'));
});

test('GET stats : vues du dossier, ouvertures par lien', async () => {
  const h = await adminSetup();
  const share = await h.call('POST', '/projects/client/share', { label: 'Client' });
  const cookie = setCookies(await visit(h, new URL(share.body.link.url).pathname));
  await visit(h, '/d/client', cookie);
  const stats = await h.call('GET', '/projects/client/stats?days=7');
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body.total, { views: 1, uniques: 1 });
  assert.equal(stats.body.days.length, 7);
  assert.deepEqual(stats.body.links.map((l: { label: string; openCount: number }) => [l.label, l.openCount]), [['Client', 1]]);
  assert.equal((await h.call('GET', '/projects/client/stats?days=0')).status, 400);
});

test('DELETE /api/projects/:name : supprime la fiche et ses liens, jamais les artifacts', async () => {
  const h = await adminSetup();
  await h.call('POST', '/projects/client/share', {});
  assert.equal((await h.call('DELETE', '/projects/client')).status, 200);
  assert.equal(getProject(h.db, 'client'), undefined);
  assert.deepEqual(listFolderLinks(h.db, 'client'), []);
  assert.equal((await h.call('GET', `/artifacts/${h.priv.id}`)).body.project, 'client');
  assert.equal((await visit(h, '/d/client')).status, 404);
  assert.equal((await h.call('DELETE', '/projects/client')).status, 404);
});

test('DTO artifact : indicateur « partagé via le dossier »', async () => {
  const h = await adminSetup();
  assert.equal((await h.call('GET', `/artifacts/${h.priv.id}`)).body.folderVisibility, 'private');
  await h.call('PATCH', '/projects/client', { visibility: 'public' });
  const list = (await h.call('GET', '/artifacts')).body as { slug: string; folderVisibility: string | null }[];
  assert.equal(list.find((a) => a.slug === 'privee')!.folderVisibility, 'public');
  assert.equal(list.find((a) => a.slug === 'ailleurs')!.folderVisibility, 'private');
});

test('routes dossier : CSRF exigé pour les mutations avec cookie', async () => {
  const h = await adminSetup();
  const res = await h.admin.request('/api/projects/client', { method: 'PATCH', headers: { cookie: h.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: '{"visibility":"public"}' });
  assert.equal(res.status, 403);
  assert.equal(getProject(h.db, 'client'), undefined);
});

test('aperçu admin de la page du dossier : URL signée, valable même privé, jamais comptée, périmée par l’époque', async () => {
  const h = await adminSetup();
  await mkdir(thumbsDir(h.cfg.dataDir, h.priv.id), { recursive: true });
  await writeFile(thumbPath(h.cfg.dataDir, h.priv.id, h.priv.current_version_id!, 'png'), 'png');
  setVersionThumb(h.db, h.priv.id, h.priv.current_version_id!, { thumb_type: 'png', thumb_at: new Date(h.clock.now()).toISOString() });
  const r = await h.call('GET', '/projects/client/preview');
  assert.equal(r.status, 200);
  const url = new URL(r.body.url);
  assert.equal(url.origin, 'https://artifacts.test');
  assert.equal(url.pathname, '/d/client');
  const page = await visit(h, url.pathname + url.search);
  assert.equal(page.status, 200, 'dossier sans fiche (privé) : aperçu quand même');
  const html = await page.text();
  assert.match(html, /Preview/);
  // Les cartes de l'aperçu mènent directement aux chemins signés (aucun accès de dossier requis).
  const href = /href="(\/a\/privee\/~[^"]+)"/.exec(html)![1];
  assert.equal((await visit(h, href.replace(/&amp;/g, '&'))).status, 200);
  const thumb = /<img src="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&');
  assert.equal((await visit(h, thumb)).status, 200, 'miniature de l’aperçu servie même pour un dossier privé');
  assert.equal((await visit(h, thumb.replace(/\?.*$/, ''))).status, 404, 'sans la signature d’aperçu : refusée');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM folder_visit_days').get()!.n, 0, 'aperçu jamais compté');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM visit_days').get()!.n, 0);
  const forged = url.search.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await visit(h, `/d/client${forged}`)).status, 404);
  assert.equal((await visit(h, `/d/interne${url.search}`)).status, 404, 'aperçu d’un autre dossier');
  await h.call('POST', '/projects/client/revoke-all');
  await h.call('PATCH', '/projects/client', { title: 'x' });
  await h.call('POST', '/projects/client/revoke-all');
  assert.equal((await visit(h, url.pathname + url.search)).status, 404, 'nouvelle époque : aperçu périmé');
  h.clock.advance(3601_000);
  const fresh = new URL((await h.call('GET', '/projects/client/preview')).body.url);
  h.clock.advance(3601_000);
  assert.equal((await visit(h, fresh.pathname + fresh.search)).status, 404, 'expiré après 1 h');
  assert.equal((await h.call('GET', '/projects/inconnu/preview')).status, 404);
});

test('POST /api/projects : crée un dossier vide et privé (nom normalisé, sel neuf) ; nom pris → 409 ; invalide → 400', async () => {
  const h = await adminSetup();
  const r = await h.call('POST', '/projects', { name: '  Été 2026 Client ', title: ' Maquettes ', description: 'Pour le client' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'ete-2026-client');
  assert.equal(r.body.title, 'Maquettes');
  assert.equal(r.body.description, 'Pour le client');
  assert.equal(r.body.visibility, 'private');
  assert.equal(r.body.hasSheet, true);
  assert.equal(r.body.count, 0);
  assert.equal(r.body.url, 'https://artifacts.test/d/ete-2026-client');
  const sheet = getProject(h.db, 'ete-2026-client')!;
  assert.equal(sheet.visibility, 'private');
  assert.equal(sheet.access_epoch, 1);
  assert.ok(sheet.salt.length > 0, 'sel neuf');
  assert.equal((await visit(h, '/d/ete-2026-client')).status, 404, 'privé par défaut');
  // Sans titre ni description.
  const bare = await h.call('POST', '/projects', { name: 'nu' });
  assert.equal(bare.status, 201);
  assert.equal(bare.body.title, null);
  assert.notEqual(getProject(h.db, 'nu')!.salt, sheet.salt);
  // Déjà une fiche, ou déjà des artifacts sans fiche : 409, rien n'est modifié.
  assert.equal((await h.call('POST', '/projects', { name: 'Ete 2026 client', title: 'Autre' })).status, 409);
  assert.equal(getProject(h.db, 'ete-2026-client')!.title, 'Maquettes');
  assert.equal((await h.call('POST', '/projects', { name: 'client' })).status, 409);
  assert.equal(getProject(h.db, 'client'), undefined, 'aucune fiche créée sur un projet existant');
  for (const bad of [{}, { name: '' }, { name: '!!!' }, { name: 3 }, { name: 'ok-1', title: 'x'.repeat(121) }, { name: 'ok-2', description: 'x'.repeat(1001) }]) {
    assert.equal((await h.call('POST', '/projects', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(getProject(h.db, 'ok-1'), undefined);
  const list = (await h.call('GET', '/projects')).body as { name: string; count: number }[];
  assert.deepEqual(list.find((f) => f.name === 'ete-2026-client'), {
    name: 'ete-2026-client', count: 0, privateCount: 0, visibility: 'private', title: 'Maquettes', parent: null, position: null,
    latestUpdatedAt: getProject(h.db, 'ete-2026-client')!.updated_at, recent: [], url: 'https://artifacts.test/d/ete-2026-client', activeLinkUrl: null,
  });
});

test('POST /api/projects : CSRF exigé avec cookie', async () => {
  const h = await adminSetup();
  const res = await h.admin.request('/api/projects', { method: 'POST', headers: { cookie: h.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(res.status, 403);
  assert.equal(getProject(h.db, 'x'), undefined);
});

test('DELETE d’un dossier vide : il disparaît de la liste ; avec des artifacts, seule la fiche part', async () => {
  const h = await adminSetup();
  await h.call('POST', '/projects', { name: 'vide' });
  await h.call('PATCH', '/projects/client', { title: 'Client' });
  assert.equal((await h.call('DELETE', '/projects/vide')).status, 200);
  assert.equal((await h.call('DELETE', '/projects/client')).status, 200);
  const names = ((await h.call('GET', '/projects')).body as { name: string }[]).map((f) => f.name);
  assert.deepEqual(names, ['client', 'interne'], 'client reste (artifacts), sans fiche');
  assert.equal((await h.call('GET', '/projects/vide')).status, 404);
  assert.equal((await h.call('GET', '/projects/client')).body.hasSheet, false);
});

test('PATCH artifact project : déplacer vers un dossier vide existant garde la fiche et n’incrémente aucune époque', async () => {
  const h = await adminSetup();
  await h.call('POST', '/projects', { name: 'vide', title: 'Vide' });
  const before = getProject(h.db, 'vide')!;
  const epoch = h.db.prepare('SELECT access_epoch FROM artifacts WHERE id = ?').get(h.priv.id)!.access_epoch;
  const r = await h.call('PATCH', `/artifacts/${h.priv.id}`, { project: 'vide' });
  assert.equal(r.status, 200);
  assert.equal(r.body.project, 'vide');
  assert.equal(r.body.folderVisibility, 'private');
  assert.equal(h.db.prepare('SELECT access_epoch FROM artifacts WHERE id = ?').get(h.priv.id)!.access_epoch, epoch, 'époque de l’artifact inchangée');
  const after = getProject(h.db, 'vide')!;
  assert.deepEqual({ ...after }, { ...before }, 'fiche intacte (époque, sel, visibilité)');
  const folder = (await h.call('GET', '/projects/vide')).body;
  assert.equal(folder.count, 1);
  assert.deepEqual(folder.artifacts.map((a: { slug: string }) => a.slug), ['privee']);
});
