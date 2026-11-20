// Several admin origins (PUBLIC_HUB_ALT_URLS): the same admin reachable through a private network name and a public
// hostname behind an identity proxy. Every listed origin is trusted for mutations and may frame signed paths; no
// other origin is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { loadConfig } from '../src/config.ts';
import { hashSecret } from '../src/crypto.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { seedArtifact, setup } from './harness.ts';

const base = {
  HUB_SECRET: Buffer.alloc(48, 1).toString('base64'),
  PUBLIC_HUB_URL: 'https://hub.example.com',
  PUBLIC_CONTENT_URL: 'https://artifacts.example.com',
};

test('PUBLIC_HUB_ALT_URLS: empty by default', () => {
  assert.deepEqual(loadConfig(base).hubAltUrls, []);
});

test('PUBLIC_HUB_ALT_URLS: comma-separated origins, trimmed, normalised', () => {
  const cfg = loadConfig({ ...base, PUBLIC_HUB_ALT_URLS: ' https://admin.example.org/ , https://hub.internal.example ' });
  assert.deepEqual(cfg.hubAltUrls, ['https://admin.example.org', 'https://hub.internal.example']);
});

test('PUBLIC_HUB_ALT_URLS: https only, like PUBLIC_HUB_URL', () => {
  assert.throws(() => loadConfig({ ...base, PUBLIC_HUB_ALT_URLS: 'http://admin.example.org' }), /PUBLIC_HUB_ALT_URLS must be an https URL/);
});

test('PUBLIC_HUB_ALT_URLS: the content origin is refused', () => {
  assert.throws(() => loadConfig({ ...base, PUBLIC_HUB_ALT_URLS: 'https://artifacts.example.com' }), /PUBLIC_CONTENT_URL/);
});

async function adminWith(alt: string[]) {
  const h = await setup({ adminPasswordHash: await hashSecret('pw-solide'), hubAltUrls: alt });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const login = (origin: string) =>
    admin.request('/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-solide' }) });
  return { h, login };
}

test('mutations: the primary and every alternate origin are accepted', async () => {
  const { login } = await adminWith(['https://hub-alt.test']);
  assert.equal((await login('https://hub.test')).status, 200);
  assert.equal((await login('https://hub-alt.test')).status, 200);
});

test('mutations: any other origin is refused, the content origin included', async () => {
  const { login } = await adminWith(['https://hub-alt.test']);
  for (const origin of ['https://evil.test', 'https://artifacts.test', 'https://hub-alt.test.evil.test', 'null']) {
    const res = await login(origin);
    assert.equal(res.status, 403, origin);
    assert.equal(((await res.json()) as { code: string }).code, 'origin_refused');
  }
});

test('signed paths may be framed by every admin origin, and no other', async () => {
  const { h } = await adminWith(['https://hub-alt.test']);
  await seedArtifact(h, { slug: 'doc', visibility: 'public', kind: 'pdf', entry: 'document.pdf', files: { 'document.pdf': '%PDF-1.4' } });
  const first = await h.content.request('/a/doc');
  const res = await h.content.request(first.headers.get('location')!);
  assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self' https://hub.test https://hub-alt.test");
});
