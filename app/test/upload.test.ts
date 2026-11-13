import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HttpError } from '../src/http.ts';
import { receiveUpload } from '../src/upload.ts';
import { tempDataDir } from './helpers.ts';

function multipart(fields: Record<string, string>, file?: { name: string; data: Uint8Array<ArrayBuffer> | string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set('file', new File([file.data], file.name));
  return new Request('http://x/upload', { method: 'POST', body: form });
}

test('écrit le fichier sur disque et lit les champs', async () => {
  const dir = await tempDataDir();
  const tmp = join(dir, 'tmp');
  const res = await receiveUpload(multipart({ title: 'T' }, { name: '../../evil/page.html', data: '<p>x</p>' }), tmp, 1000);
  assert.equal(res.fields.title, 'T');
  assert.equal(res.file?.originalName, 'page.html');
  assert.equal(res.file?.size, 8);
  assert.equal(await readFile(res.file!.tmpPath, 'utf8'), '<p>x</p>');
});

test('coupe le flux au-delà de la limite et ne laisse aucun fichier', async () => {
  const dir = await tempDataDir();
  const tmp = join(dir, 'tmp');
  await assert.rejects(
    receiveUpload(multipart({}, { name: 'big.html', data: new Uint8Array(5000) }), tmp, 1000),
    (e: unknown) => e instanceof HttpError && e.status === 413,
  );
  assert.deepEqual(await readdir(tmp), []);
});

test('refuse une requête non multipart', async () => {
  const dir = await tempDataDir();
  const req = new Request('http://x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await assert.rejects(receiveUpload(req, join(dir, 'tmp'), 1000), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test('accepte une requête sans fichier', async () => {
  const dir = await tempDataDir();
  const res = await receiveUpload(multipart({ a: '1' }), join(dir, 'tmp'), 1000);
  assert.equal(res.file, null);
});

test('répertoire temporaire absent : rejette sans bloquer', { timeout: 5000 }, async () => {
  const dir = await tempDataDir();
  await assert.rejects(receiveUpload(multipart({}, { name: 'a.html', data: '<p>x</p>' }), join(dir, 'missing'), 1000));
  assert.deepEqual(await readdir(dir).then((l) => l.filter((n) => n === 'missing')), []);
});

test('multipart sans boundary : 400', { timeout: 5000 }, async () => {
  const dir = await tempDataDir();
  const req = new Request('http://x', { method: 'POST', body: 'abc', headers: { 'content-type': 'multipart/form-data' } });
  await assert.rejects(receiveUpload(req, join(dir, 'tmp'), 1000), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test('multipart tronqué : 400 et aucun fichier', { timeout: 5000 }, async () => {
  const dir = await tempDataDir();
  const tmp = join(dir, 'tmp');
  const body = '--B\r\nContent-Disposition: form-data; name="file"; filename="a.html"\r\nContent-Type: text/html\r\n\r\n<p>partial';
  const req = new Request('http://x', { method: 'POST', body, headers: { 'content-type': 'multipart/form-data; boundary=B' } });
  await assert.rejects(receiveUpload(req, tmp, 1000), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.deepEqual(await readdir(tmp), []);
});

test('fichier très au-delà de la limite : 413, aucun fichier, aucune exception non gérée', { timeout: 5000 }, async () => {
  const dir = await tempDataDir();
  const tmp = join(dir, 'tmp');
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    await assert.rejects(
      receiveUpload(multipart({}, { name: 'big.html', data: new Uint8Array(3 * 1048576) }), tmp, 1024),
      (e: unknown) => e instanceof HttpError && e.status === 413,
    );
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught, []);
  assert.deepEqual(await readdir(tmp), []);
});

test('les noms de fichiers accentués arrivent intacts (UTF-8)', async () => {
  const dir = await tempDataDir();
  const res = await receiveUpload(multipart({}, { name: 'Frais télétravail – été.md', data: '# x' }), join(dir, 'tmp'), 1000);
  assert.equal(res.file?.originalName, 'Frais télétravail – été.md');
});
