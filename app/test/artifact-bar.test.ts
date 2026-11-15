import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRAME_PAGE_CSP } from '../src/content/headers.ts';
import { setParent } from '../src/folder-tree.ts';
import { upsertProject } from '../src/repo.ts';
import { viewTotals } from '../src/visits.ts';
import { seedArtifact, setup, type Harness } from './harness.ts';

// Artifact bar (design 10).

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const DOC = { 'index.html': '<h1>Rapport</h1>', 'source.md': '# Rapport\n' };
const PAGE = { 'index.html': '<p>page</p>' };

const nav = (h: Harness, path: string, o: { dest?: string | null; ua?: string; method?: string } = {}) => {
  const headers: Record<string, string> = { 'user-agent': o.ua ?? BROWSER, 'x-forwarded-for': '203.0.113.8' };
  if (o.dest !== null) headers['sec-fetch-dest'] = o.dest ?? 'document';
  return h.content.request(path, { method: o.method ?? 'GET', headers });
};
const iframeSrc = (html: string) => /<iframe class="artifact" src="([^"]+)"/.exec(html)?.[1];
const links = (html: string) => [...html.matchAll(/<a class="bar-btn" href="([^"]+)"( download="[^"]*")?/g)].map((m) => ({ href: m[1], download: !!m[2] }));

test('barre : une navigation de navigateur reçoit la page cadre, sans script ni bac à sable', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'rapport', visibility: 'public', kind: 'markdown', files: DOC, title: 'Rapport <Q3>' });
  const res = await nav(h, '/a/rapport');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), FRAME_PAGE_CSP);
  assert.equal(res.headers.get('x-frame-options'), 'DENY', 'the frame page itself is never framed');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<h1 class="bar-title" aria-current="page">Rapport &lt;Q3&gt;<\/h1>/);
  assert.match(html, /<span class="bar-version"[^>]*>v1<\/span>/);
  const src = iframeSrc(html)!;
  assert.match(src, /^\/a\/rapport\/~[^/]+\/index\.html$/);
  const [original, alone] = links(html);
  assert.deepEqual(original, { href: src.replace('index.html', 'source.md'), download: true });
  assert.deepEqual(alone, { href: src, download: false });

  const framed = await nav(h, src, { dest: 'iframe' });
  assert.equal(framed.status, 200);
  assert.match(framed.headers.get('content-security-policy')!, /frame-ancestors 'self'/);
  assert.equal(framed.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal((await nav(h, original.href, { dest: 'document' })).status, 200);
});

test('barre : scripts, requêtes de cadre, fichiers explicites et HEAD gardent la redirection', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'page', visibility: 'public', kind: 'html', files: PAGE });
  assert.equal((await nav(h, '/a/page', { dest: null, ua: 'curl/8.7.1' })).status, 302, 'curl');
  assert.equal((await nav(h, '/a/page', { dest: null })).status, 302, 'no fetch metadata');
  for (const dest of ['iframe', 'script', 'empty']) assert.equal((await nav(h, '/a/page', { dest })).status, 302, dest);
  assert.equal((await nav(h, '/a/page/index.html')).status, 302, 'explicit file: raw');
  assert.equal((await nav(h, '/a/page', { method: 'HEAD' })).status, 302);
});

test('barre : Original pour Markdown, JSON et PDF seulement', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'page', visibility: 'public', kind: 'html', files: PAGE });
  await seedArtifact(h, { slug: 'contrat', visibility: 'public', kind: 'pdf', entry: 'contrat.pdf', files: { 'contrat.pdf': '%PDF-1.4' } });
  assert.equal(links(await (await nav(h, '/a/page')).text()).length, 1, 'Open alone only');
  const pdf = links(await (await nav(h, '/a/contrat')).text());
  assert.equal(pdf.length, 2);
  assert.match(pdf[0].href, /\/contrat\.pdf$/);
  assert.ok(pdf[0].download);
});

test('barre : une vue par ouverture, rien pour le chargement du cadre', async () => {
  const h = await setup({ artifactBar: true });
  const art = await seedArtifact(h, { slug: 'vue', visibility: 'public', kind: 'html', files: PAGE });
  const src = iframeSrc(await (await nav(h, '/a/vue')).text())!;
  await nav(h, src, { dest: 'iframe' });
  assert.equal(viewTotals(h.db, art.id, h.clock.now()).total, 1);
});

test('barre : par un dossier, chemin depuis le dossier qui donne l’accès, jamais au-dessus', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'note', visibility: 'private', project: 'lot', kind: 'markdown', files: DOC, title: 'Note privée' });
  upsertProject(h.db, 'client', { visibility: 'public', title: 'Client Acme' });
  upsertProject(h.db, 'lot', { title: 'Lot 1' });
  setParent(h.db, 'lot', 'client');

  const html = await (await nav(h, '/d/lot/a/note')).text();
  assert.match(html, /<nav class="bar-path"[^>]*><a href="\/d\/client">Client Acme<\/a><span class="bar-sep"[^>]*>\/<\/span><a href="\/d\/lot">Lot 1<\/a>/);
  assert.match(html, /Note privée<\/h1>/);
  assert.equal((await nav(h, '/a/note')).status, 404, 'its own address stays private');

  upsertProject(h.db, 'client', { visibility: 'private' });
  upsertProject(h.db, 'lot', { visibility: 'public' });
  const own = await (await nav(h, '/d/lot/a/note')).text();
  assert.match(own, /<a href="\/d\/lot">Lot 1<\/a>/);
  assert.ok(!own.includes('/d/client') && !own.includes('Client Acme'), 'no ancestor above the granting folder');
});

test('barre : réponses inchangées pour un artéfact privé ou protégé, et sans la barre', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'prive', visibility: 'private', kind: 'html', files: PAGE });
  await seedArtifact(h, { slug: 'code', visibility: 'code', code: 'code-secret', kind: 'html', files: PAGE });
  assert.equal((await nav(h, '/a/prive')).status, 404);
  assert.equal((await nav(h, '/a/code')).status, 401);

  const off = await setup({ artifactBar: false });
  await seedArtifact(off, { slug: 'page', visibility: 'public', kind: 'html', files: PAGE });
  assert.equal((await nav(off, '/a/page')).status, 302);
});

test('barre : les services d’aperçu gardent la page Open Graph', async () => {
  const h = await setup({ artifactBar: true, linkPreviews: true });
  await seedArtifact(h, { slug: 'page', visibility: 'public', kind: 'html', files: PAGE, title: 'Aperçu' });
  const html = await (await nav(h, '/a/page', { ua: 'Slackbot-LinkExpanding 1.0' })).text();
  assert.match(html, /og:title/);
  assert.equal(iframeSrc(html), undefined);
});

test('barre : la page de dossier a la barre (chemin, thème) et un seul titre principal', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'x', visibility: 'private', project: 'client', kind: 'html', files: PAGE });
  upsertProject(h.db, 'client', { visibility: 'public', title: 'Client' });
  const html = await (await nav(h, '/d/client')).text();
  assert.match(html, /<header class="bar">/);
  assert.match(html, /<label for="theme-toggle" class="bar-btn theme-btn"/);
  assert.equal((html.match(/<h1/g) ?? []).length, 1);
});
