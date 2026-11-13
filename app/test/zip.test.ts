import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractZip, ZipRejected } from '../src/ingest/zip.ts';
import { makeZip, tempDataDir, type ZipSpec } from './helpers.ts';

const limits = { maxFiles: 10, maxBytes: 1024 * 1024 * 5 };

async function run(entries: ZipSpec[], lim = limits) {
  const dir = await tempDataDir();
  const zipPath = join(dir, 'tmp', 'in.zip');
  await writeFile(zipPath, makeZip(entries));
  const dest = join(dir, 'out');
  return { dest, promise: extractZip(zipPath, dest, lim) };
}

test('extrait un site simple', async () => {
  const { dest, promise } = await run([
    { name: 'index.html', data: '<h1>ok</h1>' },
    { name: 'assets/app.js', data: 'console.log(1)' },
  ]);
  assert.deepEqual(await promise, { fileCount: 2, totalBytes: 25 });
  assert.equal(await readFile(join(dest, 'assets/app.js'), 'utf8'), 'console.log(1)');
});

test('déballe un dossier racine unique et ignore __MACOSX', async () => {
  const { dest, promise } = await run([
    { name: 'dist/', data: '' },
    { name: 'dist/index.html', data: 'x' },
    { name: 'dist/a.css', data: 'y' },
    { name: '__MACOSX/dist/._index.html', data: 'junk' },
  ]);
  await promise;
  assert.ok(existsSync(join(dest, 'index.html')));
  assert.ok(!existsSync(join(dest, 'dist')));
});

const rejects = async (entries: ZipSpec[], codes: string | string[], pattern: RegExp, lim = limits) => {
  const { promise } = await run(entries, lim);
  const allowed = ([] as string[]).concat(codes);
  await assert.rejects(promise, (err: unknown) => err instanceof ZipRejected && allowed.includes(err.code) && pattern.test(err.message));
};

test('refuse la traversée de chemin', () => rejects([{ name: 'index.html' }, { name: 'a/../../evil.txt' }], ['zip_invalid', 'zip_traversal'], /Invalid|traversal/));
test('refuse un chemin absolu', () => rejects([{ name: 'index.html' }, { name: '/etc/passwd' }], ['zip_invalid', 'zip_absolute_path'], /Invalid|Absolute/));
test('refuse un lien symbolique', () => rejects([{ name: 'index.html' }, { name: 'link', data: '/etc/passwd', mode: 0o120777 }], 'zip_symlink', /Symbolic link refused/));
test('refuse un taux de compression suspect', () => rejects([{ name: 'index.html' }, { name: 'bomb.bin', data: Buffer.alloc(2 * 1024 * 1024) }], 'zip_ratio', /compression/));
test('refuse trop de fichiers', () => rejects([{ name: 'index.html' }, { name: 'a' }, { name: 'b' }], 'zip_too_many_files', /Too many files \(max 2\)/, { maxFiles: 2, maxBytes: 1e6 }));
test('refuse une taille décompressée cumulée excessive', () =>
  rejects([{ name: 'index.html', data: 'x'.repeat(600), store: true }, { name: 'b.txt', data: 'y'.repeat(600), store: true }], 'zip_too_large', /too large/, { maxFiles: 10, maxBytes: 1000 }));
test('exige index.html à la racine', () => rejects([{ name: 'page.html', data: 'x' }], 'zip_no_index', /index\.html/));
test('refuse un segment réservé ~', () => rejects([{ name: 'index.html' }, { name: '~x/a.js' }], 'zip_reserved_name', /Reserved name/));
