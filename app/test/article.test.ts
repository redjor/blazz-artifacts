import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { newId } from '../src/ids.ts';
import { renderArticle } from '../src/ingest/page.ts';
import { insertArtifactWithVersion } from '../src/repo.ts';
import { versionDir } from '../src/storage.ts';
import { tempDataDir } from './helpers.ts';

test('renderArticle : le premier h1 devient le titre centré, sans doublon', () => {
  const page = renderArticle({ fallbackTitle: 'notes', body: '<h1>Rapport <em>Q3</em></h1>\n<p>Texte</p>' });
  assert.match(page, /<header class="doc-head"><h1 class="doc-title">Rapport <em>Q3<\/em><\/h1><\/header>/);
  assert.equal(page.match(/<h1/g)?.length, 1);
  assert.match(page, /<title>Rapport Q3<\/title>/);
  assert.match(page, /<article class="prose">\s*<p>Texte<\/p>/);
});

test('renderArticle : sans h1 en tête, le titre de repli est utilisé et échappé', () => {
  const page = renderArticle({ fallbackTitle: 'Notes <script>', body: '<p>a</p><h1>Plus loin</h1>' });
  assert.match(page, /<h1 class="doc-title">Notes &lt;script&gt;<\/h1>/);
  assert.match(page, /<title>Notes &lt;script&gt;<\/title>/);
  assert.match(page, /<article class="prose"><p>a<\/p><h1>Plus loin<\/h1>/);
});

test('renderArticle : bascule clair/sombre sans JavaScript, lien vers l’original', () => {
  const page = renderArticle({ fallbackTitle: 't', body: '<p>x</p>', originalHref: 'source.md', originalLabel: 'Markdown original' });
  assert.doesNotMatch(page, /<script/i);
  assert.match(page, /<input type="checkbox" id="theme-toggle"/);
  assert.match(page, /<label for="theme-toggle"/);
  assert.match(page, /html:has\(#theme-toggle:checked\)/);
  assert.match(page, /href="source.md" download>Markdown original<\/a>/);
  assert.ok(page.indexOf('<!doctype html>') === 0);
});

test('rerender-documents régénère les pages Markdown et JSON existantes', async () => {
  const dir = await tempDataDir();
  const db = openDb(join(dir, 'hub.sqlite'));
  const mk = async (kind: 'markdown' | 'json', title: string, source: string, name: string) => {
    const id = newId();
    const vid = newId();
    const vdir = versionDir(dir, id, vid);
    await mkdir(vdir, { recursive: true });
    await writeFile(join(vdir, name), source);
    await writeFile(join(vdir, 'index.html'), '<p>ancien rendu</p>');
    insertArtifactWithVersion(
      db,
      { id, slug: `${kind}-x`, title, kind, visibility: 'private', code_hash: null },
      { id: vid, entry_path: 'index.html', original_name: name, size_bytes: source.length, file_count: 2 },
    );
    return vdir;
  };
  const mdDir = await mk('markdown', 'Mon titre', 'Intro sans titre', 'source.md');
  const jsonDir = await mk('json', 'Données', '{"a":1}', 'source.json');
  db.close();

  const out = execFileSync(process.execPath, ['src/scripts/rerender-documents.ts'], { env: { ...process.env, DATA_DIR: dir } }).toString();
  assert.match(out, /2 page\(s\) re-rendered/);
  const md = await readFile(join(mdDir, 'index.html'), 'utf8');
  assert.match(md, /<h1 class="doc-title">Mon titre<\/h1>/);
  assert.match(md, /<p>Intro sans titre<\/p>/);
  const js = await readFile(join(jsonDir, 'index.html'), 'utf8');
  assert.match(js, /<h1 class="doc-title">Données<\/h1>/);
  assert.match(js, /&quot;a&quot;: 1/);
});

test('frenchSpacing : insécables avant la ponctuation haute, jamais dans le code', async () => {
  const { frenchSpacing } = await import('../src/ingest/page.ts');
  const out = frenchSpacing('<p>Durée : 32 min ! « Oui » ?</p><p><code>a : b</code></p><pre><code>x ; y</code></pre>');
  assert.equal(out, '<p>Durée : 32 min ! « Oui » ?</p><p><code>a : b</code></p><pre><code>x ; y</code></pre>');
  assert.equal(frenchSpacing('<svg><style>a { b: c }</style><text>c : d</text></svg>'), '<svg><style>a { b: c }</style><text>c : d</text></svg>');
});

test('sommaire : ancres sur les h2 et popover sans JavaScript', () => {
  const page = renderArticle({
    fallbackTitle: 't',
    body: '<p>a</p><h2>Les idées</h2><p>b</p><h2>Pièges &amp; <em>oral</em></h2><h2>Les idées</h2><h3>Pas moi</h3>',
  });
  assert.match(page, /<h2 id="les-idees">Les idées<\/h2>/);
  assert.match(page, /<h2 id="pieges-oral">Pièges &amp; <em>oral<\/em><\/h2>/);
  assert.match(page, /<h2 id="les-idees-2">Les idées<\/h2>/);
  assert.match(page, /<button type="button" class="toc-btn" popovertarget="toc"/);
  assert.match(page, /<nav id="toc" popover class="toc"/);
  assert.match(page, /<a href="#les-idees">Les idées<\/a>/);
  assert.match(page, /<a href="#pieges-oral">Pièges &amp; oral<\/a>/);
  assert.doesNotMatch(page, /href="#pas-moi"/);
  assert.doesNotMatch(page, /<script/i);
});

test('sommaire absent quand il y a moins de deux h2', () => {
  const page = renderArticle({ fallbackTitle: 't', body: '<h2>Seule</h2><p>x</p>' });
  assert.doesNotMatch(page, /popovertarget/);
  assert.match(page, /<h2 id="seule">Seule<\/h2>/);
});
