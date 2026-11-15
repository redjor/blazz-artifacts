import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { loadConfig } from '../src/config.ts';
import { encrypt, hashSecret, randomToken, sha256 } from '../src/crypto.ts';
import { newId } from '../src/ids.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { deleteProject, insertLink, setTags, upsertProject } from '../src/repo.ts';
import { purgeTrash } from '../src/trash.ts';
import { seedArtifact, setCookies, setup } from './harness.ts';

// Trash (design 04).

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';
const PAGE = { 'index.html': '<h1>page</h1>' };
const DAY = 86_400_000;

async function trashSetup(trashDays = 30) {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), trashDays });
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
  const publish = (slug: string) => {
    const form = new FormData();
    form.set('slug', slug);
    form.set('file', new File(['# doc'], 'doc.md'));
    return admin.request('/api/artifacts', { method: 'POST', headers, body: form });
  };
  return { ...h, admin, call, publish };
}

test('corbeille : invisible pour les visiteurs tout de suite (slug, chemin signé, lien, page de dossier)', async () => {
  const h = await trashSetup();
  const art = await seedArtifact(h, { slug: 'doc', visibility: 'public', project: 'client', files: PAGE, kind: 'html', title: 'Doc à jeter' });
  await seedArtifact(h, { slug: 'autre', visibility: 'public', project: 'client', files: PAGE, kind: 'html', title: 'Doc gardé' });
  upsertProject(h.db, 'client', { visibility: 'public' });
  const first = await h.content.request('/a/doc');
  assert.equal(first.status, 302);
  const signed = first.headers.get('location')!;
  assert.equal((await h.content.request(signed)).status, 200);
  assert.match(await (await h.content.request('/d/client')).text(), /Doc à jeter/);

  assert.equal((await h.call(`/artifacts/${art.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await h.content.request('/a/doc')).status, 404);
  assert.equal((await h.content.request(signed)).status, 404, 'signed path already handed out');
  assert.equal((await h.content.request('/d/client/a/doc')).status, 404);
  const page = await (await h.content.request('/d/client')).text();
  assert.doesNotMatch(page, /Doc à jeter/);
  assert.match(page, /Doc gardé/);
});

test('corbeille : un lien de partage ne répond plus, puis refonctionne après restauration', async () => {
  const h = await trashSetup();
  const art = await seedArtifact(h, { slug: 'lien', visibility: 'link', files: PAGE, kind: 'html' });
  const token = randomToken();
  insertLink(h.db, { id: newId(), artifact_id: art.id, token_hash: sha256(token), token_enc: encrypt(h.keys.linkEnc, token), label: null, expires_at: null });
  assert.equal((await h.content.request(`/share/${token}`)).status, 302);
  await h.call(`/artifacts/${art.id}`, { method: 'DELETE' });
  assert.equal((await h.content.request(`/share/${token}`)).status, 404);
  assert.equal((await h.call(`/artifacts/${art.id}/restore`, { method: 'POST' })).status, 200);
  assert.equal((await h.content.request(`/share/${token}`)).status, 302);
});

test('corbeille : absent des listes, des tags et des compteurs ; listé avec sa date de purge', async () => {
  const h = await trashSetup();
  const art = await seedArtifact(h, { slug: 'doc', visibility: 'private', project: 'client', files: PAGE, kind: 'html' });
  setTags(h.db, art.id, ['rapport']);
  const res = await h.call(`/artifacts/${art.id}`, { method: 'DELETE' });
  assert.deepEqual(await res.json(), { ok: true, trashed: true });

  assert.deepEqual(await (await h.call('/artifacts')).json(), []);
  assert.deepEqual(await (await h.call('/artifacts?slug=doc')).json(), []);
  assert.equal((await h.call(`/artifacts/${art.id}`)).status, 404);
  assert.deepEqual(await (await h.call('/tags')).json(), []);
  const client = ((await (await h.call('/projects')).json()) as { name: string; count: number; privateCount: number }[]).find((f) => f.name === 'client');
  assert.equal(client, undefined, 'a folder held only by trashed artifacts disappears');

  const trash = (await (await h.call('/trash')).json()) as { days: number; items: { id: string; deletedAt: string; purgeAt: string; project: string }[] };
  assert.equal(trash.days, 30);
  assert.equal(trash.items.length, 1);
  assert.equal(trash.items[0].id, art.id);
  assert.equal(trash.items[0].project, 'client');
  assert.equal(Date.parse(trash.items[0].purgeAt) - Date.parse(trash.items[0].deletedAt), 30 * DAY);
});

test('corbeille : le slug reste réservé (slug_in_trash à la création, au renommage, et à la vérification)', async () => {
  const h = await trashSetup();
  const art = await seedArtifact(h, { slug: 'doc', visibility: 'private', files: PAGE, kind: 'html' });
  const other = await seedArtifact(h, { slug: 'autre', visibility: 'private', files: PAGE, kind: 'html' });
  await h.call(`/artifacts/${art.id}`, { method: 'DELETE' });

  const created = await h.publish('doc');
  assert.equal(created.status, 409);
  assert.equal(((await created.json()) as { code: string }).code, 'slug_in_trash');
  const renamed = await h.call(`/artifacts/${other.id}`, { method: 'PATCH', body: { slug: 'doc' } });
  assert.equal(renamed.status, 409);
  assert.equal(((await renamed.json()) as { code: string }).code, 'slug_in_trash');
  assert.deepEqual(await (await h.call('/slugs/doc')).json(), { slug: 'doc', valid: true, available: false, inTrash: true });
  assert.deepEqual(await (await h.call('/slugs/libre')).json(), { slug: 'libre', valid: true, available: true, inTrash: false });
});

test('restauration : même slug et même dossier ; sans dossier si le dossier a disparu', async () => {
  const h = await trashSetup();
  const kept = await seedArtifact(h, { slug: 'garde', visibility: 'public', project: 'client', files: PAGE, kind: 'html' });
  const lost = await seedArtifact(h, { slug: 'perdu', visibility: 'public', project: 'ephemere', files: PAGE, kind: 'html' });
  upsertProject(h.db, 'client', { title: 'Client' });
  upsertProject(h.db, 'ephemere', { title: 'Éphémère' });
  await h.call(`/artifacts/${kept.id}`, { method: 'DELETE' });
  await h.call(`/artifacts/${lost.id}`, { method: 'DELETE' });
  deleteProject(h.db, 'ephemere');

  const a = (await (await h.call(`/artifacts/${kept.id}/restore`, { method: 'POST' })).json()) as { slug: string; project: string | null };
  assert.equal(a.slug, 'garde');
  assert.equal(a.project, 'client');
  const b = (await (await h.call(`/artifacts/${lost.id}/restore`, { method: 'POST' })).json()) as { project: string | null };
  assert.equal(b.project, null);
  assert.equal((await h.content.request('/a/garde')).status, 302);
  assert.equal((await h.call(`/artifacts/${kept.id}/restore`, { method: 'POST' })).status, 404, 'not in the trash any more');
  assert.deepEqual(((await (await h.call('/trash')).json()) as { items: unknown[] }).items, []);
});

test('restauration : un dossier sans fiche vidé par la corbeille revient avec l’artéfact', async () => {
  const h = await trashSetup();
  const art = await seedArtifact(h, { slug: 'seul', visibility: 'private', project: 'implicite', files: PAGE, kind: 'html' });
  await h.call(`/artifacts/${art.id}`, { method: 'DELETE' });
  const folders = (await (await h.call('/projects')).json()) as { name: string | null }[];
  assert.ok(!folders.some((f) => f.name === 'implicite'), 'the folder is gone while its only artifact is in the trash');
  const back = (await (await h.call(`/artifacts/${art.id}/restore`, { method: 'POST' })).json()) as { project: string | null };
  assert.equal(back.project, 'implicite');
});

test('suppression définitive : une par une ou toute la corbeille, fichiers compris', async () => {
  const h = await trashSetup();
  const one = await seedArtifact(h, { slug: 'un', visibility: 'private', files: PAGE, kind: 'html' });
  const two = await seedArtifact(h, { slug: 'deux', visibility: 'private', files: PAGE, kind: 'html' });
  const three = await seedArtifact(h, { slug: 'trois', visibility: 'private', files: PAGE, kind: 'html' });
  for (const a of [one, two, three]) await h.call(`/artifacts/${a.id}`, { method: 'DELETE' });
  assert.ok(existsSync(join(h.cfg.dataDir, 'files', one.id)), 'files stay while in the trash');

  assert.equal((await h.call(`/trash/${one.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!existsSync(join(h.cfg.dataDir, 'files', one.id)));
  assert.equal((await h.call(`/trash/${one.id}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual(await (await h.call('/trash', { method: 'DELETE' })).json(), { ok: true, deleted: 2 });
  assert.ok(!existsSync(join(h.cfg.dataDir, 'files', two.id)));
  assert.equal((await h.publish('trois')).status, 201, 'the slug is free again');
  assert.equal((await h.call(`/trash/${(await seedArtifact(h, { slug: 'vivant', visibility: 'private', files: PAGE })).id}`, { method: 'DELETE' })).status, 404, 'a live artifact is not deleted from the trash route');
});

test('purge : seulement après TRASH_DAYS jours', async () => {
  const h = await trashSetup();
  const art = await seedArtifact(h, { slug: 'doc', visibility: 'private', files: PAGE, kind: 'html' });
  await h.call(`/artifacts/${art.id}`, { method: 'DELETE' });
  assert.equal(await purgeTrash(h.db, h.cfg.dataDir, 30, Date.now() + 29 * DAY), 0);
  assert.ok(existsSync(join(h.cfg.dataDir, 'files', art.id)));
  assert.equal(await purgeTrash(h.db, h.cfg.dataDir, 30, Date.now() + 31 * DAY), 1);
  assert.ok(!existsSync(join(h.cfg.dataDir, 'files', art.id)));
  assert.deepEqual(((await (await h.call('/trash')).json()) as { items: unknown[] }).items, []);
});

test('TRASH_DAYS=0 : suppression immédiate, sans corbeille', async () => {
  const h = await trashSetup(0);
  const art = await seedArtifact(h, { slug: 'doc', visibility: 'private', files: PAGE, kind: 'html' });
  assert.deepEqual(await (await h.call(`/artifacts/${art.id}`, { method: 'DELETE' })).json(), { ok: true, trashed: false });
  assert.ok(!existsSync(join(h.cfg.dataDir, 'files', art.id)));
  assert.deepEqual(await (await h.call('/trash')).json(), { days: 0, items: [] });
  assert.equal((await h.publish('doc')).status, 201);
});

test('config : TRASH_DAYS vaut 30 par défaut, 0 est accepté, le reste est refusé', () => {
  const base = { HUB_SECRET: Buffer.alloc(48, 1).toString('base64'), PUBLIC_HUB_URL: 'https://hub.example.com', PUBLIC_CONTENT_URL: 'https://artifacts.example.com' };
  assert.equal(loadConfig(base).trashDays, 30);
  assert.equal(loadConfig({ ...base, TRASH_DAYS: '0' }).trashDays, 0);
  assert.equal(loadConfig({ ...base, TRASH_DAYS: '7' }).trashDays, 7);
  for (const bad of ['-1', '1.5', 'x', '9999']) assert.throws(() => loadConfig({ ...base, TRASH_DAYS: bad }), /TRASH_DAYS/);
});
