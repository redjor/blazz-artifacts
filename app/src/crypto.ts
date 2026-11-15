import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual,
} from 'node:crypto';

/**
 * One key per use (distinct HKDF context): a value signed for one use is never valid for another.
 * folderGrant signs folder access cookies, folderThumb the folder page's thumbnail URLs,
 * folderPreview the admin-issued folder page previews.
 */
export interface Keys { grant: Buffer; pathSig: Buffer; linkEnc: Buffer; folderGrant: Buffer; folderThumb: Buffer; folderPreview: Buffer; ogImage: Buffer }

export function deriveKeys(secret: Buffer): Keys {
  const key = (info: string) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
  return {
    grant: key('artifact-hub/grant'),
    pathSig: key('artifact-hub/path-sig'),
    linkEnc: key('artifact-hub/link-enc'),
    folderGrant: key('artifact-hub/folder-grant'),
    folderThumb: key('artifact-hub/folder-thumb'),
    folderPreview: key('artifact-hub/folder-preview'),
    ogImage: key('artifact-hub/og-image'),
  };
}

export function hmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MAXMEM = 64 * 1024 * 1024;

function scryptAsync(pw: string, salt: Buffer, len: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, len, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashSecret(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 32, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export async function verifySecret(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length === 0) return false;
  const key = await scryptAsync(pw, Buffer.from(salt, 'base64url'), expected.length, Number(n), Number(r), Number(p));
  return timingSafeEqual(key, expected);
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(key: Buffer, blob: string): string {
  const [iv, tag, ct] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
