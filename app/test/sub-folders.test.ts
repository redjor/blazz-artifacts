import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeFolderGrant, folderCookieName } from '../src/content/folder-grant.ts';
import { hashSecret } from '../src/crypto.ts';
import { setParent } from '../src/folder-tree.ts';
import { bumpProjectEpoch, getArtifactBySlug, getProject, setVersionThumb, upsertProject } from '../src/repo.ts';
import { thumbPath, thumbsDir } from '../src/storage.ts';
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

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('sub-folder thumbnails: signed by the granting ancestor, refused after a move', async () => {
  const h = await tree();
  const art = getArtifactBySlug(h.db, 'art-detail')!;
  const v = art.current_version_id!;
  await mkdir(thumbsDir(h.cfg.dataDir, art.id), { recursive: true });
  await writeFile(thumbPath(h.cfg.dataDir, art.id, v, 'png'), PNG);
  setVersionThumb(h.db, art.id, v, { thumb_type: 'png', thumb_at: new Date(h.clock.now()).toISOString() });
  const html = await (await get(h, '/d/detail', grant(h, 'client'))).text();
  const m = /src="(\/d\/detail\/thumb\/[^"]+)"/.exec(html);
  assert.ok(m, 'thumbnail URL on the page');
  const url = m[1].replaceAll('&amp;', '&');
  assert.match(url, /[?&]g=client&s=/);
  assert.equal((await get(h, url)).status, 200, 'signed URL works without cookie');
  assert.equal((await get(h, url.replace('g=client', 'g=lot'))).status, 404, 'wrong granting folder');
  setParent(h.db, 'lot', null);
  assert.equal((await get(h, url)).status, 404, 'no longer under the granting folder');
});
