import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret } from '../src/crypto.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { getArtifact, getTags, getTrashedArtifact, setPinned, setTags } from '../src/repo.ts';
import { seedArtifact, setCookies, setup } from './harness.ts';

// Bulk actions (design 05).

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';
const PAGE = { 'index.html': '<h1>page</h1>' };

async function bulkSetup(trashDays = 30) {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), trashDays });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const headers = { cookie: setCookies(res), origin: ORIGIN, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
  const bulk = (body: unknown) => admin.request('/api/artifacts/bulk', { method: 'POST', headers, body: JSON.stringify(body) });
  const seed = (slug: string, o: { visibility?: 'private' | 'code' | 'link' | 'public'; project?: string; code?: string } = {}) =>
    seedArtifact(h, { slug, visibility: o.visibility ?? 'private', project: o.project, code: o.code, files: PAGE, kind: 'html', title: `Titre ${slug}` });
  return { ...h, bulk, seed };
}

const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

test('actions groupées : déplacer plusieurs artéfacts, puis les sortir du dossier', async () => {
  const h = await bulkSetup();
  const a = await h.seed('a');
  const b = await h.seed('b', { project: 'ancien' });
  const res = await h.bulk({ ids: [a.id, b.id], op: 'move', value: 'client' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 2 });
  assert.equal(getArtifact(h.db, a.id)!.project, 'client');
  assert.equal(getArtifact(h.db, b.id)!.project, 'client');

  assert.equal((await h.bulk({ ids: [a.id, b.id], op: 'move', value: null })).status, 200);
  assert.equal(getArtifact(h.db, a.id)!.project, null);
  assert.equal(getArtifact(h.db, b.id)!.project, null);
});

test('actions groupées : ajouter et retirer des tags, sans toucher aux autres tags', async () => {
  const h = await bulkSetup();
  const a = await h.seed('a');
  const b = await h.seed('b');
  setTags(h.db, b.id, ['garde']);
  assert.equal((await h.bulk({ ids: [a.id, b.id], op: 'addTags', value: ['Rapport', 'q3'] })).status, 200);
  assert.deepEqual(getTags(h.db, a.id), ['q3', 'rapport']);
  assert.deepEqual(getTags(h.db, b.id), ['garde', 'q3', 'rapport']);

  assert.equal((await h.bulk({ ids: [a.id, b.id], op: 'removeTags', value: ['q3'] })).status, 200);
  assert.deepEqual(getTags(h.db, a.id), ['rapport']);
  assert.deepEqual(getTags(h.db, b.id), ['garde', 'rapport']);
});

test('actions groupées : tout ou rien quand un artéfact dépasserait 20 tags', async () => {
  const h = await bulkSetup();
  const a = await h.seed('a');
  const full = await h.seed('plein');
  setTags(h.db, full.id, Array.from({ length: 20 }, (_, i) => `t${i}`));
  const res = await h.bulk({ ids: [a.id, full.id], op: 'addTags', value: ['nouveau'] });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string; error: string };
  assert.equal(body.code, 'too_many_tags');
  assert.match(body.error, /Titre plein/);
  assert.deepEqual(getTags(h.db, a.id), [], 'the first artifact did not change either');
});

test('actions groupées : la visibilité change l’époque des seuls artéfacts modifiés ; pas de code en masse', async () => {
  const h = await bulkSetup();
  const priv = await h.seed('prive');
  const pub = await h.seed('public', { visibility: 'public' });
  const coded = await h.seed('code', { visibility: 'code', code: 'secret-123' });
  const epoch = (id: string) => getArtifact(h.db, id)!.access_epoch;
  const before = { priv: epoch(priv.id), pub: epoch(pub.id), coded: epoch(coded.id) };

  assert.equal((await h.bulk({ ids: [priv.id, pub.id, coded.id], op: 'visibility', value: 'public' })).status, 200);
  for (const id of [priv.id, pub.id, coded.id]) assert.equal(getArtifact(h.db, id)!.visibility, 'public');
  assert.equal(epoch(priv.id), before.priv + 1);
  assert.equal(epoch(pub.id), before.pub, 'already public: untouched');
  assert.equal(epoch(coded.id), before.coded + 1);
  assert.equal(getArtifact(h.db, coded.id)!.code_hash, null, 'the code goes with the code visibility');

  const res = await h.bulk({ ids: [priv.id], op: 'visibility', value: 'code' });
  assert.equal(res.status, 400);
  assert.equal(await codeOf(res), 'bulk_no_code');
  assert.equal(await codeOf(await h.bulk({ ids: [priv.id], op: 'visibility', value: 'partout' })), 'invalid_visibility');
});

test('actions groupées : épingler garde la date des artéfacts déjà épinglés et ne modifie rien d’autre', async () => {
  const h = await bulkSetup();
  const a = await h.seed('a');
  const b = await h.seed('b');
  const pinnedAt = setPinned(h.db, b.id, true).pinned_at;
  const updatedAt = getArtifact(h.db, a.id)!.updated_at;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await h.bulk({ ids: [a.id, b.id], op: 'pin' })).status, 200);
  assert.ok(getArtifact(h.db, a.id)!.pinned_at);
  assert.equal(getArtifact(h.db, b.id)!.pinned_at, pinnedAt);
  assert.equal(getArtifact(h.db, a.id)!.updated_at, updatedAt);
  assert.equal((await h.bulk({ ids: [a.id, b.id], op: 'unpin' })).status, 200);
  assert.equal(getArtifact(h.db, a.id)!.pinned_at, null);
  assert.equal(getArtifact(h.db, b.id)!.pinned_at, null);
});

test('actions groupées : corbeille puis restauration du lot, dossier sans fiche compris', async () => {
  const h = await bulkSetup();
  const a = await h.seed('a', { visibility: 'public', project: 'sans-fiche' });
  const b = await h.seed('b', { visibility: 'public', project: 'sans-fiche' });
  const epochA = a.access_epoch;
  assert.equal((await h.content.request('/a/a')).status, 302);

  const res = await h.bulk({ ids: [a.id, b.id], op: 'trash' });
  assert.deepEqual(await res.json(), { ok: true, count: 2, trashed: true });
  assert.equal((await h.content.request('/a/a')).status, 404);
  assert.equal(getTrashedArtifact(h.db, a.id)!.access_epoch, epochA + 1);
  assert.equal(getTrashedArtifact(h.db, b.id)!.project, 'sans-fiche');

  assert.equal((await h.bulk({ ids: [a.id, b.id], op: 'restore' })).status, 200);
  assert.equal(getArtifact(h.db, a.id)!.project, 'sans-fiche', 'the folder emptied by the trash comes back with the batch');
  assert.equal(getArtifact(h.db, b.id)!.project, 'sans-fiche');
  assert.equal((await h.content.request('/a/a')).status, 302);
});

test('actions groupées : tout ou rien sur un identifiant inconnu ou hors de la corbeille', async () => {
  const h = await bulkSetup();
  const a = await h.seed('a');
  const res = await h.bulk({ ids: [a.id, 'inconnu'], op: 'move', value: 'client' });
  assert.equal(res.status, 404);
  assert.equal(await codeOf(res), 'artifact_not_found');
  assert.equal(getArtifact(h.db, a.id)!.project, null);
  assert.equal((await h.bulk({ ids: [a.id], op: 'restore' })).status, 404, 'a live artifact is not restored');
  const trash = await h.bulk({ ids: [a.id, 'inconnu'], op: 'trash' });
  assert.equal(trash.status, 404);
  assert.ok(getArtifact(h.db, a.id), 'still live');
});

test('actions groupées : limites et paramètres refusés', async () => {
  const h = await bulkSetup();
  const a = await h.seed('a');
  const many = Array.from({ length: 501 }, (_, i) => `id-${i}`);
  for (const ids of [[], many, [a.id, a.id], [42], 'a', undefined]) {
    const res = await h.bulk({ ids, op: 'pin' });
    assert.equal(res.status, 400, JSON.stringify(ids)?.slice(0, 40));
    assert.equal(await codeOf(res), 'invalid_bulk_ids');
  }
  assert.equal(await codeOf(await h.bulk({ ids: [a.id], op: 'supprimer' })), 'invalid_bulk_op');
  assert.equal(await codeOf(await h.bulk({ ids: [a.id], op: 'move' })), 'invalid_project');
  assert.equal(await codeOf(await h.bulk({ ids: [a.id], op: 'addTags', value: [] })), 'invalid_tags');
  assert.equal(await codeOf(await h.bulk({ ids: [a.id], op: 'addTags', value: ['***'] })), 'invalid_tags');
  assert.equal(await codeOf(await h.bulk({ ids: [a.id], op: 'removeTags', value: 'q3' })), 'invalid_tags_type');
});

test('actions groupées : sans corbeille (TRASH_DAYS=0), suppression définitive du lot, fichiers compris', async () => {
  const h = await bulkSetup(0);
  const a = await h.seed('a');
  const b = await h.seed('b');
  assert.deepEqual(await (await h.bulk({ ids: [a.id, b.id], op: 'trash' })).json(), { ok: true, count: 2, trashed: false });
  assert.equal(getArtifact(h.db, a.id), undefined);
  assert.equal(getTrashedArtifact(h.db, a.id), undefined);
  assert.ok(!existsSync(join(h.cfg.dataDir, 'files', a.id)));
  assert.ok(!existsSync(join(h.cfg.dataDir, 'files', b.id)));
});
