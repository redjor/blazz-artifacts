import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret } from '../src/crypto.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { seedArtifact, setup } from './harness.ts';

// Live preview in the admin panel and quick look (design 14): the admin origin, and no other, may frame signed paths.

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

test('aperçu admin : les chemins signés acceptent le cadre du contenu et de l’admin, rien d’autre', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'page', visibility: 'public', kind: 'html', files: { 'index.html': '<p>x</p>' } });
  await seedArtifact(h, { slug: 'contrat', visibility: 'public', kind: 'pdf', entry: 'c.pdf', files: { 'c.pdf': '%PDF-1.4' } });
  for (const slug of ['page', 'contrat']) {
    const signed = (await h.content.request(`/a/${slug}`, { headers: { 'user-agent': BROWSER } })).headers.get('location')!;
    const res = await h.content.request(signed, { headers: { 'user-agent': BROWSER } });
    assert.equal(res.status, 200, slug);
    const csp = res.headers.get('content-security-policy')!;
    assert.match(csp, /frame-ancestors 'self' https:\/\/hub\.test(;|$)/, slug);
    assert.equal((csp.match(/frame-ancestors/g) ?? []).length, 1, slug);
  }
  const frame = await h.content.request('/a/page', { headers: { 'user-agent': BROWSER, 'sec-fetch-dest': 'document' } });
  assert.match(frame.headers.get('content-security-policy')!, /frame-ancestors 'none'/, 'the frame page itself is never framed');
  const missing = await h.content.request('/a/inconnu', { headers: { 'user-agent': BROWSER } });
  assert.equal(missing.headers.get('x-frame-options'), 'DENY');
});

test('aperçu admin : la CSP de l’admin n’ouvre les cadres qu’à l’origine du contenu', async () => {
  const h = await setup({ adminPasswordHash: await hashSecret('mot-de-passe-solide') });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const csp = (await admin.request('/api/session')).headers.get('content-security-policy')!;
  assert.match(csp, /(^|; )frame-src https:\/\/artifacts\.test(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/, 'the admin is never framed');
});
