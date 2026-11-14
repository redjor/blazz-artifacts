import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFolderGrant, folderCookieName } from '../src/content/folder-grant.ts';
import { hashSecret } from '../src/crypto.ts';
import { setParent } from '../src/folder-tree.ts';
import { bumpProjectEpoch, getProject, upsertProject } from '../src/repo.ts';
import { seedArtifact, setup, type Harness } from './harness.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const PAGE = { 'index.html': '<p>x</p>' };

const get = (h: Harness, path: string, cookie = '') =>
  h.content.request(path, { headers: { 'user-agent': UA, 'x-forwarded-for': '203.0.113.9', ...(cookie ? { cookie } : {}) } });

/** Valid code grant for `name` (what /unlock-folder sets). */
function grant(h: Harness, name: string): string {
  const p = getProject(h.db, name)!;
  const value = encodeFolderGrant(h.keys.folderGrant, { p: name, s: p.salt, e: p.access_epoch, l: null, x: Math.floor(h.clock.now() / 1000) + 600 });
  return `${folderCookieName(name)}=${value}`;
}

/** client (code "acme-2026") > lot (private) > detail (private); one private artifact in each. */
async function tree() {
  const h = await setup();
  for (const [slug, project] of [['art-client', 'client'], ['art-lot', 'lot'], ['art-detail', 'detail']] as const) {
    await seedArtifact(h, { slug, visibility: 'private', project, files: PAGE, kind: 'html', title: slug });
  }
  upsertProject(h.db, 'client', { visibility: 'code', code_hash: await hashSecret('acme-2026'), title: 'Client Acme' });
  setParent(h.db, 'lot', 'client');
  setParent(h.db, 'detail', 'lot');
  return h;
}

test('parent access opens the whole sub-tree', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  assert.equal((await get(h, '/d/lot')).status, 404);
  assert.equal((await get(h, '/d/lot', c)).status, 200);
  assert.equal((await get(h, '/d/detail', c)).status, 200);
  assert.equal((await get(h, '/d/detail/a/art-detail', c)).status, 302);
});

test('folder entry only for direct members', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  assert.equal((await get(h, '/d/client/a/art-lot', c)).status, 404);
  assert.equal((await get(h, '/d/lot/a/art-detail', c)).status, 404);
  assert.equal((await get(h, '/d/lot/a/art-lot', c)).status, 302);
});

test('cutting the parent cuts the sub-tree, own access survives', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  bumpProjectEpoch(h.db, 'client');
  assert.equal((await get(h, '/d/lot', c)).status, 404);
  upsertProject(h.db, 'detail', { visibility: 'public' });
  upsertProject(h.db, 'client', { visibility: 'private', code_hash: null }, true);
  assert.equal((await get(h, '/d/lot')).status, 404);
  assert.equal((await get(h, '/d/detail')).status, 200, 'own public access');
});

test('moving a folder out of its parent removes inherited access', async () => {
  const h = await tree();
  const c = grant(h, 'client');
  setParent(h.db, 'lot', null);
  assert.equal((await get(h, '/d/lot', c)).status, 404);
  assert.equal((await get(h, '/d/detail', c)).status, 404);
});

test('unlock page of a sub-folder never mentions its parent', async () => {
  const h = await tree();
  upsertProject(h.db, 'lot', { visibility: 'code', code_hash: await hashSecret('lot-code'), title: 'Lot 3' });
  const res = await get(h, '/d/lot');
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.ok(!html.includes('client') && !html.includes('Client Acme'));
});
