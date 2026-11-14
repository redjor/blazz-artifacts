import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { encodeFolderGrant, folderCookieName } from '../src/content/folder-grant.ts';
import { encrypt, hashSecret, randomToken, sha256 } from '../src/crypto.ts';
import { newId } from '../src/ids.ts';
import { setParent } from '../src/folder-tree.ts';
import { bumpProjectEpoch, getArtifactBySlug, getProject, insertLink, setVersionThumb, upsertProject } from '../src/repo.ts';
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
  assert.equal((await get(h, '/d/lot', c)).status, 200, 'positive control before the bump');
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
  assert.ok(!html.includes('/d/client'), 'no link to the parent');
  assert.ok(!html.includes('unlock-folder/client'), 'no unlock form of the parent');
  assert.ok(!html.includes('Client Acme'), 'no parent title');
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

test('folder page lists direct sub-folders before artifacts', async () => {
  const h = await tree();
  upsertProject(h.db, 'lot', { title: 'Lot <3>', description: 'Livraison' });
  upsertProject(h.db, 'vide', {});
  setParent(h.db, 'vide', 'client');
  const html = await (await get(h, '/d/client', grant(h, 'client'))).text();
  assert.match(html, /href="\/d\/lot"/);
  assert.match(html, /Lot &lt;3&gt;/);
  assert.match(html, /href="\/d\/vide"/);
  assert.ok(!html.includes('href="/d/detail"'), 'grandchild not listed on the root page');
  assert.ok(html.indexOf('href="/d/lot"') < html.indexOf('href="/d/client/a/art-client"'), 'folders first');
  assert.doesNotMatch(html, /<script/i);
});

test('breadcrumb starts at the highest accessible ancestor', async () => {
  const h = await tree();
  const full = await (await get(h, '/d/detail', grant(h, 'client'))).text();
  assert.match(full, /<nav class="crumbs"[^>]*>.*href="\/d\/client".*href="\/d\/lot"/s);
  upsertProject(h.db, 'lot', { visibility: 'code', code_hash: await hashSecret('lot-code') });
  const partial = await (await get(h, '/d/detail', grant(h, 'lot'))).text();
  assert.match(partial, /href="\/d\/lot"/);
  assert.ok(!partial.includes('/d/client') && !partial.includes('Client Acme'), 'inaccessible ancestor hidden');
  const own = await (async () => {
    upsertProject(h.db, 'detail', { visibility: 'public' });
    return (await get(h, '/d/detail')).text();
  })();
  assert.doesNotMatch(own, /class="crumbs"/, 'no breadcrumb without accessible ancestor');
});

/** Valid link grant for `name` backed by a real link row. */
function linkGrant(h: Harness, name: string): string {
  const token = randomToken();
  const link = insertLink(h.db, { id: newId(), project_name: name, token_hash: sha256(token), token_enc: encrypt(h.keys.linkEnc, token), label: null, expires_at: null });
  const p = getProject(h.db, name)!;
  const value = encodeFolderGrant(h.keys.folderGrant, { p: name, s: p.salt, e: p.access_epoch, l: link.id, x: Math.floor(h.clock.now() / 1000) + 600 });
  return `${folderCookieName(name)}=${value}`;
}

async function withThumb(h: Harness, cookie: string) {
  const art = getArtifactBySlug(h.db, 'art-detail')!;
  const v = art.current_version_id!;
  await mkdir(thumbsDir(h.cfg.dataDir, art.id), { recursive: true });
  await writeFile(thumbPath(h.cfg.dataDir, art.id, v, 'png'), PNG);
  setVersionThumb(h.db, art.id, v, { thumb_type: 'png', thumb_at: new Date(h.clock.now()).toISOString() });
  const html = await (await get(h, '/d/detail', cookie)).text();
  const m = /src="(\/d\/detail\/thumb\/[^"]+)"/.exec(html);
  assert.ok(m, 'thumbnail URL on the page');
  return { url: m[1].replaceAll('&amp;', '&'), art, v };
}

test('inherited access for a link parent and a public parent', async () => {
  const h = await tree();
  upsertProject(h.db, 'client', { visibility: 'link', code_hash: null });
  assert.equal((await get(h, '/d/detail')).status, 404, 'no grant');
  assert.equal((await get(h, '/d/detail', linkGrant(h, 'client'))).status, 200);
  upsertProject(h.db, 'client', { visibility: 'public' });
  assert.equal((await get(h, '/d/detail')).status, 200);
});

test('access never flows upwards or sideways', async () => {
  const h = await tree();
  await seedArtifact(h, { slug: 'art-lot-b', visibility: 'private', project: 'lot-b', files: PAGE, kind: 'html', title: 'b' });
  upsertProject(h.db, 'lot-b', {});
  setParent(h.db, 'lot-b', 'client');
  upsertProject(h.db, 'lot', { visibility: 'code', code_hash: await hashSecret('lot-code') });
  const g = grant(h, 'lot');
  assert.equal((await get(h, '/d/lot', g)).status, 200, 'control');
  assert.equal((await get(h, '/d/client', g)).status, 401, 'parent stays locked');
  assert.equal((await get(h, '/d/lot-b', g)).status, 404, 'sibling stays closed');
});

test('thumbnails are re-checked: parent made private, or epoch bumped', async () => {
  const h = await tree();
  const { url } = await withThumb(h, grant(h, 'client'));
  assert.equal((await get(h, url)).status, 200, 'control');
  upsertProject(h.db, 'client', { visibility: 'private', code_hash: null }, true);
  assert.equal((await get(h, url)).status, 404, 'granting folder now private');

  const h2 = await tree();
  const t2 = await withThumb(h2, grant(h2, 'client'));
  assert.equal((await get(h2, t2.url)).status, 200, 'control');
  bumpProjectEpoch(h2.db, 'client');
  assert.equal((await get(h2, t2.url)).status, 404, 'epoch bumped');
});

test('a thumbnail URL cannot be replayed on another folder', async () => {
  const h = await tree();
  const { url, art, v } = await withThumb(h, grant(h, 'client'));
  const q = url.slice(url.indexOf('?'));
  assert.equal((await get(h, `/d/lot/thumb/${art.id}/${v}${q}`)).status, 404);
  assert.equal((await get(h, url)).status, 200, 'original still works');
});

test('g naming a non-ancestor is refused', async () => {
  const h = await tree();
  await seedArtifact(h, { slug: 'art-other', visibility: 'public', project: 'other', files: PAGE, kind: 'html', title: 'o' });
  upsertProject(h.db, 'other', { visibility: 'public' });
  const { url } = await withThumb(h, grant(h, 'client'));
  assert.equal((await get(h, url.replace('g=client', 'g=other'))).status, 404);
});
