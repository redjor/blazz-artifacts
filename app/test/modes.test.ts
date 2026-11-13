import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ingestFile } from '../src/ingest/ingest.ts';
import { thumbsDir } from '../src/storage.ts';
import { placeThumb } from '../src/thumbs.ts';
import { makeZip, tempDataDir } from './helpers.ts';

// Un fichier source en 0700 (vu sur le NAS) ou un umask restrictif ne doivent jamais produire de fichiers illisibles
// par une sauvegarde non root : fichiers 0644, dossiers 0755, quelle que soit l'origine.
const limits = { maxFiles: 10, maxBytes: 1e6 };
const mode = async (p: string) => (await stat(p)).mode & 0o777;

async function allModes(root: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  out.set('.', await mode(root));
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    const full = join(e.parentPath, e.name);
    out.set(full.slice(root.length + 1), await mode(full));
  }
  return out;
}

async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
}

async function source(name: string, data: string | Buffer, fileMode = 0o700) {
  const dir = await tempDataDir();
  const tmpPath = join(dir, 'tmp', 'u');
  await writeFile(tmpPath, data);
  await chmod(tmpPath, fileMode);
  return { dir, file: { tmpPath, originalName: name, size: Buffer.byteLength(data) }, dest: join(dir, 'files', 'art', 'ver') };
}

for (const [name, data] of [
  ['page.html', '<p>x</p>'],
  ['doc.pdf', '%PDF-1.4 x'],
  ['note.md', '# Titre'],
  ['data.json', '{"a":1}'],
  ['site.zip', makeZip([{ name: 'index.html', data: 'i', mode: 0o100600 }, { name: 'assets/', mode: 0o040700 }, { name: 'assets/app.js', data: 'x', mode: 0o100700 }])],
] as const) {
  test(`droits après ingestion (${name}) : fichiers 0644, dossiers 0755, malgré une source 0700 et un umask 077`, async () => {
    const s = await source(name, data);
    await withUmask(0o077, () => ingestFile(s.file, s.dest, limits));
    const modes = await allModes(s.dest);
    assert.ok(modes.size > 1);
    for (const [rel, m] of modes) {
      const isDir = (await stat(join(s.dest, rel))).isDirectory();
      assert.equal(m.toString(8), (isDir ? 0o755 : 0o644).toString(8), rel);
    }
    assert.equal((await mode(join(s.dir, 'files', 'art'))).toString(8), '755', 'dossier de l’artifact');
  });
}

test('droits des miniatures : 0644 et dossier 0755, malgré un fichier reçu en 0600 et un umask 077', async () => {
  const dataDir = await tempDataDir();
  const tmp = join(dataDir, 'tmp', 't.thumb');
  await writeFile(tmp, 'img');
  await chmod(tmp, 0o600);
  const dest = await withUmask(0o077, async () => {
    await mkdir(join(dataDir, 'thumbs'), { recursive: true });
    return placeThumb(dataDir, 'ART', 'VER', tmp, 'png');
  });
  assert.equal((await mode(dest)).toString(8), '644');
  assert.equal((await mode(thumbsDir(dataDir, 'ART'))).toString(8), '755');
});

test('rattrapage au démarrage : chmod seulement si les droits diffèrent, une erreur n’arrête pas le reste, liens symboliques ignorés', async () => {
  const { symlink, lstat } = await import('node:fs/promises');
  const { repairModes } = await import('../src/storage.ts');
  const root = join(await tempDataDir(), 'files');
  await mkdir(join(root, 'a', 'v1'), { recursive: true });
  await mkdir(join(root, 'b'), { recursive: true });
  await writeFile(join(root, 'a', 'v1', 'index.html'), 'x');
  await writeFile(join(root, 'a', 'v1', 'ok.css'), 'x');
  await writeFile(join(root, 'b', 'page.html'), 'x');
  await writeFile(join(root, 'cible.txt'), 'x');
  await chmod(join(root, 'a', 'v1', 'index.html'), 0o700);
  await chmod(join(root, 'b', 'page.html'), 0o600);
  await chmod(join(root, 'cible.txt'), 0o600);
  await chmod(join(root, 'a', 'v1'), 0o700);
  for (const d of [root, join(root, 'a'), join(root, 'b')]) await chmod(d, 0o755);
  await chmod(join(root, 'a', 'v1', 'ok.css'), 0o644);
  await symlink(join(root, 'cible.txt'), join(root, 'lien'));
  const touched: string[] = [];
  // Erreur simulée sur un fichier : le reste de l'arbre est quand même réparé.
  const report = await repairModes(root, async (path, mode) => {
    touched.push(path.slice(root.length + 1));
    if (path.endsWith('page.html')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await chmod(path, mode);
  });
  assert.deepEqual(touched.sort(), ['a/v1', 'a/v1/index.html', 'b/page.html', 'cible.txt'], 'seulement les droits différents, jamais le lien');
  assert.deepEqual({ changed: report.changed, failed: report.failed }, { changed: 3, failed: 1 });
  assert.equal((await mode(join(root, 'a', 'v1', 'index.html'))).toString(8), '644');
  assert.equal((await mode(join(root, 'a', 'v1'))).toString(8), '755');
  assert.equal((await mode(join(root, 'b', 'page.html'))).toString(8), '600', 'échec isolé');
  assert.ok((await lstat(join(root, 'lien'))).isSymbolicLink());
  const second = await repairModes(root);
  assert.deepEqual({ changed: second.changed, failed: second.failed }, { changed: 1, failed: 0 });
  assert.deepEqual({ changed: (await repairModes(root)).changed }, { changed: 0 }, 'déjà conforme : aucun chmod');
  assert.deepEqual(await repairModes(join(root, 'absent')), { checked: 0, changed: 0, failed: 0 });
});
