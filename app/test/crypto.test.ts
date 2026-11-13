import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decrypt, deriveKeys, encrypt, hashSecret, hmac, randomToken, safeEqual, sha256, verifySecret } from '../src/crypto.ts';

const keys = deriveKeys(Buffer.alloc(32, 9));

test('deriveKeys produit trois clés distinctes de 32 octets', () => {
  assert.equal(keys.grant.length, 32);
  assert.notDeepEqual(keys.grant, keys.pathSig);
  assert.notDeepEqual(keys.pathSig, keys.linkEnc);
});

test('hmac est stable et fait 43 caractères', () => {
  assert.equal(hmac(keys.grant, 'x'), hmac(keys.grant, 'x'));
  assert.equal(hmac(keys.grant, 'x').length, 43);
  assert.notEqual(hmac(keys.grant, 'x'), hmac(keys.pathSig, 'x'));
});

test('safeEqual compare sans fuite de longueur', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('hashSecret et verifySecret', async () => {
  const stored = await hashSecret('correct horse');
  assert.match(stored, /^scrypt:16384:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(await verifySecret('correct horse', stored), true);
  assert.equal(await verifySecret('wrong', stored), false);
  assert.equal(await verifySecret('x', 'garbage'), false);
});

test('encrypt/decrypt fait un aller-retour et détecte la falsification', () => {
  const blob = encrypt(keys.linkEnc, 'secret-token');
  assert.equal(decrypt(keys.linkEnc, blob), 'secret-token');
  const [iv, tag, ct] = blob.split('.');
  const tampered = [iv, tag, ct.slice(0, -2) + (ct.endsWith('A') ? 'BB' : 'AA')].join('.');
  assert.throws(() => decrypt(keys.linkEnc, tampered));
});

test('randomToken et sha256', () => {
  assert.equal(randomToken().length, 43);
  assert.notEqual(randomToken(), randomToken());
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
