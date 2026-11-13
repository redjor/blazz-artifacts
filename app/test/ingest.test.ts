import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectKind, ingestFile, IngestRejected } from '../src/ingest/ingest.ts';
import { renderMarkdown } from '../src/ingest/markdown.ts';
import { makeZip, tempDataDir } from './helpers.ts';

const limits = { maxFiles: 10, maxBytes: 1e6 };

async function upload(name: string, data: string | Buffer) {
  const dir = await tempDataDir();
  const tmpPath = join(dir, 'tmp', 'u');
  await writeFile(tmpPath, data);
  return { dir, file: { tmpPath, originalName: name, size: Buffer.byteLength(data) }, dest: join(dir, 'files', 'a', 'v') };
}

test('detectKind', () => {
  assert.equal(detectKind('a.HTML'), 'html');
  assert.equal(detectKind('a.htm'), 'html');
  assert.equal(detectKind('notes.markdown'), 'markdown');
  assert.equal(detectKind('x.pdf'), 'pdf');
  assert.equal(detectKind('d.json'), 'json');
  assert.equal(detectKind('site.zip'), 'site');
  assert.equal(detectKind('evil.exe'), null);
});

test('renderMarkdown : GFM et coloration', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] fait\n\n```js\nconst x = 1;\n```\n\nhttps://example.com');
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /<a href="https:\/\/example.com" rel="noopener noreferrer" target="_blank">/);
});

test('renderMarkdown retire le contenu actif', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[x](javascript:alert(1))\n\n<iframe src="https://e.com"></iframe>');
  assert.doesNotMatch(html, /<script|onerror|href="javascript:|<iframe/i);
});

test('ingestFile HTML', async () => {
  const { file, dest } = await upload('page.html', '<p>hi</p>');
  const r = await ingestFile(file, dest, limits);
  assert.deepEqual(r, { kind: 'html', entryPath: 'index.html', sizeBytes: 9, fileCount: 1 });
  assert.equal(await readFile(join(dest, 'index.html'), 'utf8'), '<p>hi</p>');
});

test('ingestFile Markdown garde l’original et produit index.html', async () => {
  const { file, dest } = await upload('Notes.md', '# Titre <b>x</b>');
  const r = await ingestFile(file, dest, limits);
  assert.equal(r.kind, 'markdown');
  assert.equal(await readFile(join(dest, 'source.md'), 'utf8'), '# Titre <b>x</b>');
  const page = await readFile(join(dest, 'index.html'), 'utf8');
  assert.match(page, /<h1 class="doc-title">Titre <b>x<\/b><\/h1>/);
  assert.match(page, /<title>Titre x<\/title>/);
  assert.match(page, /href="source.md"/);
});

test('ingestFile JSON échappe le contenu', async () => {
  const { file, dest } = await upload('d.json', '{"a":"<script>"}');
  await ingestFile(file, dest, limits);
  const page = await readFile(join(dest, 'index.html'), 'utf8');
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /<script>/);
});

test('ingestFile refuse un JSON invalide et nettoie', async () => {
  const { file, dest } = await upload('d.json', '{nope');
  await assert.rejects(ingestFile(file, dest, limits), IngestRejected);
  assert.equal(existsSync(dest), false);
});

test('ingestFile refuse un faux PDF', async () => {
  const { file, dest } = await upload('x.pdf', 'not a pdf');
  await assert.rejects(ingestFile(file, dest, limits), /PDF/);
});

test('ingestFile ZIP', async () => {
  const { file, dest } = await upload('s.zip', makeZip([{ name: 'index.html', data: 'x' }, { name: 'a.js', data: 'y' }]));
  const r = await ingestFile(file, dest, limits);
  assert.deepEqual(r, { kind: 'site', entryPath: 'index.html', sizeBytes: 2, fileCount: 2 });
});

test('ingestFile refuse un format inconnu', async () => {
  const { file, dest } = await upload('a.exe', 'MZ');
  await assert.rejects(ingestFile(file, dest, limits), /Unsupported format/);
});

test('Markdown et JSON au-delà de 5 Mo sont refusés', async () => {
  const dir = await tempDataDir();
  for (const name of ['gros.md', 'gros.json']) {
    const tmpPath = join(dir, 'tmp', name);
    await writeFile(tmpPath, 'x');
    const file = { tmpPath, originalName: name, size: 5 * 1024 * 1024 + 1 };
    await assert.rejects(ingestFile(file, join(dir, 'files', 'a', name), limits), (e: unknown) => e instanceof IngestRejected && e.code === 'text_too_large' && /5 MB max/.test(e.message));
  }
});
