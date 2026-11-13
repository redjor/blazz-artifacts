import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256, verifySecret } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { tempDataDir } from './helpers.ts';

test('hash-password lit stdin et produit un hash vérifiable', async () => {
  const out = execFileSync(process.execPath, ['src/scripts/hash-password.ts'], { input: 'un-mot-de-passe-long\n' }).toString().trim();
  assert.match(out, /^scrypt:/);
  assert.equal(await verifySecret('un-mot-de-passe-long', out), true);
});

test('hash-password refuse un mot de passe de 11 caractères', () => {
  const res = spawnSync(process.execPath, ['src/scripts/hash-password.ts'], { input: 'a'.repeat(11), encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /12 characters minimum/);
  assert.equal(res.stdout, '');
});

test('hash-password accepte exactement 12 caractères', () => {
  const res = spawnSync(process.execPath, ['src/scripts/hash-password.ts'], { input: 'a'.repeat(12), encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.startsWith('scrypt:'));
});

test('backup-db produit une copie cohérente', async () => {
  const dir = await tempDataDir();
  const db = openDb(join(dir, 'hub.sqlite'));
  db.exec("INSERT INTO admin_sessions VALUES ('x','y','2999-01-01','2026-01-01')");
  execFileSync(process.execPath, ['src/scripts/backup-db.ts'], { env: { ...process.env, DATA_DIR: dir } });
  execFileSync(process.execPath, ['src/scripts/backup-db.ts'], { env: { ...process.env, DATA_DIR: dir } });
  const copy = join(dir, 'backup', 'hub.sqlite');
  assert.ok(existsSync(copy));
  assert.equal(existsSync(`${copy}.tmp`), false);
  const restored = openDb(copy);
  assert.equal((restored.prepare('SELECT count(*) AS n FROM admin_sessions').get() as { n: number }).n, 1);
});

test('new-api-token imprime token et hash cohérents', () => {
  const out = execFileSync(process.execPath, ['src/scripts/new-api-token.ts']).toString().trim().split('\n');
  assert.equal(out.length, 2);
  const [token, hash] = out.map((l, i) => l.replace(i === 0 ? /^token=/ : /^hash=/, ''));
  assert.ok(out[0].startsWith('token=') && out[1].startsWith('hash='));
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(sha256(token), hash);
});
