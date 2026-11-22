import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256, verifySecret } from '../src/crypto.ts';
import { newId } from '../src/ids.ts';
import { activateVersion, insertArtifactWithVersion, type Kind } from '../src/repo.ts';
import { versionDir } from '../src/storage.ts';
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

test('rerender maintains published and working readers with their own kind and theme, without publishing', async () => {
  const dir = await tempDataDir();
  const db = openDb(join(dir, 'hub.sqlite'));
  const theme = (color: string) => JSON.stringify({ id: 'snapshot', name: 'Client', clientName: 'Client', logoDataUrl: '', primaryColor: color, accentColor: '#123456', font: 'serif', width: 'standard', preset: 'report', header: '', footer: '' });
  const version = (artifactId: string, kind: Kind, text: string, snapshot: string | null = null) => {
    const id = newId(); const folder = versionDir(dir, artifactId, id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'index.html'), kind === 'html' ? text : 'OLD READER');
    if (kind !== 'html') writeFileSync(join(folder, kind === 'json' ? 'source.json' : 'source.md'), text);
    return { id, entry_path: 'index.html', original_name: kind === 'json' ? 'document.json' : kind === 'html' ? 'page.html' : 'document.md', size_bytes: 1, file_count: kind === 'html' ? 1 : 2, theme_snapshot: snapshot };
  };
  const create = (slug: string, kind: Kind, text: string, snapshot: string | null = null) => {
    const id = newId(); const v = version(id, kind, text, snapshot);
    insertArtifactWithVersion(db, { id, slug, title: slug, kind, visibility: 'public', code_hash: null }, v);
    return { id, v };
  };
  const mixed = create('mixed', 'markdown', '# Published Markdown', theme('#234567'));
  const html = version(mixed.id, 'html', '<p>Pending HTML unchanged</p>');
  activateVersion(db, mixed.id, html, 'html', undefined, undefined, true);
  const pair = create('pair', 'markdown', '# Published branded document', theme('#345678'));
  const draft = version(pair.id, 'markdown', '# Pending branded document', theme('#456789'));
  activateVersion(db, pair.id, draft, 'markdown', undefined, undefined, true);
  const same = create('same', 'json', '{"ready":true}');
  const beforeArtifacts = db.prepare('SELECT * FROM artifacts ORDER BY id').all();
  const beforeVersions = db.prepare('SELECT * FROM versions ORDER BY id').all();
  const out = execFileSync(process.execPath, ['src/scripts/rerender-documents.ts'], { env: { ...process.env, DATA_DIR: dir, HUB_LOCALE: 'en' } }).toString();
  assert.match(out, /4 page\(s\) re-rendered/);
  const page = (artifactId: string, versionId: string) => readFileSync(join(versionDir(dir, artifactId, versionId), 'index.html'), 'utf8');
  assert.match(page(mixed.id, mixed.v.id), /Published Markdown/);
  assert.match(page(mixed.id, mixed.v.id), /--client-primary:#234567/);
  assert.equal(page(mixed.id, html.id), '<p>Pending HTML unchanged</p>');
  assert.match(page(pair.id, pair.v.id), /--client-primary:#345678/);
  assert.doesNotMatch(page(pair.id, pair.v.id), /Pending branded document|--client-primary:#456789/);
  assert.match(page(pair.id, draft.id), /Pending branded document/);
  assert.match(page(pair.id, draft.id), /--client-primary:#456789/);
  assert.match(page(same.id, same.v.id), /ready/);
  assert.deepEqual(db.prepare('SELECT * FROM artifacts ORDER BY id').all(), beforeArtifacts);
  assert.deepEqual(db.prepare('SELECT * FROM versions ORDER BY id').all(), beforeVersions);
  db.close();
});
