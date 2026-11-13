import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { setup } from './harness.ts';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function assertIcon(res: Response) {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer()).subarray(0, 8)], PNG_MAGIC);
}

test('serveur de contenu : favicon servi sans session, sur les deux chemins', async () => {
  const h = await setup();
  for (const path of ['/favicon.ico', '/favicon.png']) await assertIcon(await h.content.request(path));
});

test('serveur admin : favicon servi sans session, même sans interface compilée', async () => {
  const h = await setup();
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  for (const path of ['/favicon.ico', '/favicon.png']) await assertIcon(await admin.request(path));
});
