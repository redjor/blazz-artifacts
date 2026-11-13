import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveKeys } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { newId } from '../src/ids.ts';
import { insertArtifactWithVersion, insertLink, revokeLink, updateArtifact } from '../src/repo.ts';
import { checkPathSig, checkPinnedPathSig, signPath, signPinnedPath } from '../src/content/signing.ts';
import { decodeGrant, encodeGrant, isGrantValid } from '../src/content/grant.ts';
import { codeLimiterOptions, RateLimiter } from '../src/ratelimit.ts';

const keys = deriveKeys(Buffer.alloc(32, 3));
const now = 1_800_000_000;

test('signature de chemin : valide, périmée, falsifiée', () => {
  const art = { id: newId(), current_version_id: newId(), access_epoch: 2 };
  const sig = signPath(keys.pathSig, { artifactId: art.id, versionId: art.current_version_id, epoch: 2 }, now);
  assert.match(sig, /^~[0-9A-Z]{26}\.2\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(checkPathSig(keys.pathSig, art, sig, now + 10), 'valid');
  assert.equal(checkPathSig(keys.pathSig, art, sig, now + 3601), 'stale');
  assert.equal(checkPathSig(keys.pathSig, { ...art, access_epoch: 3 }, sig, now), 'stale');
  assert.equal(checkPathSig(keys.pathSig, { ...art, current_version_id: newId() }, sig, now), 'stale');
  assert.equal(checkPathSig(keys.pathSig, { ...art, id: newId() }, sig, now), 'forged');
  assert.equal(checkPathSig(keys.pathSig, art, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'), now), 'forged');
  assert.equal(checkPathSig(keys.pathSig, art, '~garbage', now), 'forged');
});

test('grant : encodage signé', () => {
  const g = encodeGrant(keys.grant, { a: 'x', e: 1, l: null, x: now });
  assert.deepEqual(decodeGrant(keys.grant, g), { a: 'x', e: 1, l: null, x: now });
  assert.equal(decodeGrant(keys.grant, g + 'x'), null);
  assert.equal(decodeGrant(keys.pathSig, g), null);
  assert.equal(decodeGrant(keys.grant, undefined), null);
});

test('grant : règles de validité', () => {
  const db = openDb(':memory:');
  const art = insertArtifactWithVersion(
    db,
    { id: newId(), slug: 's', title: 's', kind: 'html', visibility: 'link', code_hash: null },
    { id: newId(), entry_path: 'index.html', original_name: 'a', size_bytes: 1, file_count: 1 },
  );
  const link = insertLink(db, { id: newId(), artifact_id: art.id, token_hash: 'h', token_enc: 'e', label: null, expires_at: new Date((now + 100) * 1000).toISOString() });
  const claims = { a: art.id, e: art.access_epoch, l: link.id, x: now + 50 };
  assert.equal(isGrantValid(db, art, claims, now), true);
  assert.equal(isGrantValid(db, art, { ...claims, x: now }, now), false, 'expiré');
  assert.equal(isGrantValid(db, art, { ...claims, e: 99 }, now), false, 'epoch');
  assert.equal(isGrantValid(db, art, { ...claims, a: 'other' }, now), false, 'autre artifact');
  assert.equal(isGrantValid(db, art, { ...claims, l: null }, now), false, 'lien requis');
  assert.equal(isGrantValid(db, art, claims, now + 200), false, 'lien expiré');
  revokeLink(db, art.id, link.id);
  assert.equal(isGrantValid(db, art, claims, now), false, 'lien révoqué');
  const priv = updateArtifact(db, art.id, { visibility: 'private' }, false);
  assert.equal(isGrantValid(db, priv, { ...claims, e: priv.access_epoch }, now), false, 'privé');
});

test('rate limiter : par client puis verrou global', () => {
  let t = 0;
  const rl = new RateLimiter(codeLimiterOptions, () => t);
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.isBlocked('a', 'ip1'), false);
    rl.recordFailure('a', 'ip1');
  }
  assert.equal(rl.isBlocked('a', 'ip1'), true);
  assert.equal(rl.isBlocked('a', 'ip2'), false);
  t += 15 * 60_000;
  assert.equal(rl.isBlocked('a', 'ip1'), false);
});

test('rate limiter : le verrou global tient 20 essais par heure, pas par cycle de verrou', () => {
  let t = 0;
  const rl = new RateLimiter(codeLimiterOptions, () => t);
  for (let i = 0; i < 19; i++) rl.recordFailure('a', `rot${i}`);
  assert.equal(rl.isBlocked('a', 'fresh'), false, '19 échecs : pas encore bloqué');
  rl.recordFailure('a', 'rot19');
  assert.equal(rl.isBlocked('a', 'fresh'), true, 'verrou global au 20e échec');
  assert.equal(rl.isBlocked('b', 'fresh'), false, 'autre artifact');
  t += 15 * 60_000 + 1;
  assert.equal(rl.isBlocked('a', 'fresh'), true, 'toujours bloqué après le verrou de 15 min');
  t += 44 * 60_000;
  assert.equal(rl.isBlocked('a', 'fresh'), true, 'les échecs sont encore dans la fenêtre de 60 min');
  t += 60_000;
  assert.equal(rl.isBlocked('a', 'fresh'), false, 'fenêtre écoulée');
});

test('RateLimiter.forgive retire la dernière tentative sans toucher aux verrous', () => {
  let t = 0;
  const rl = new RateLimiter(codeLimiterOptions, () => t);
  for (let i = 0; i < 5; i++) rl.recordFailure('s', 'ip');
  assert.equal(rl.isBlocked('s', 'ip'), true);
  rl.forgive('s', 'ip');
  assert.equal(rl.isBlocked('s', 'ip'), false);
  rl.forgive('s', 'inconnu');
  rl.forgive('autre', 'ip');
});

test('signature épinglée : forme distincte, sert une version précise, ne se confond pas avec la normale', () => {
  const art = { id: newId(), current_version_id: newId(), access_epoch: 2 };
  const old = newId();
  const pin = signPinnedPath(keys.pathSig, { artifactId: art.id, versionId: old, epoch: 2 }, now);
  assert.match(pin, /^~p[0-9A-Z]{26}\.2\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(checkPinnedPathSig(keys.pathSig, art, pin, now + 10), { result: 'valid', versionId: old });
  assert.equal(checkPinnedPathSig(keys.pathSig, art, pin, now + 3601).result, 'stale');
  assert.equal(checkPinnedPathSig(keys.pathSig, { ...art, access_epoch: 3 }, pin, now).result, 'stale');
  assert.equal(checkPinnedPathSig(keys.pathSig, { ...art, id: newId() }, pin, now).result, 'forged');
  // Un jeton normal (même version, même mac) ne devient pas épinglé en ajoutant `p`, ni l'inverse.
  const normal = signPath(keys.pathSig, { artifactId: art.id, versionId: old, epoch: 2 }, now);
  assert.equal(checkPinnedPathSig(keys.pathSig, art, `~p${normal.slice(1)}`, now).result, 'forged');
  assert.equal(checkPathSig(keys.pathSig, art, `~${pin.slice(2)}`, now), 'forged');
  assert.equal(checkPathSig(keys.pathSig, art, pin, now), 'forged');
  assert.equal(checkPinnedPathSig(keys.pathSig, art, normal, now).result, 'forged');
});
