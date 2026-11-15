import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FONT_FILES } from '../src/fonts.ts';
import { seedArtifact, setup } from './harness.ts';

// Figtree, self-hosted for the visitor pages.

test('polices : les fichiers Figtree sont servis à toute origine, rien d’autre', async () => {
  const h = await setup();
  for (const name of Object.keys(FONT_FILES)) {
    const res = await h.content.request(`/_fonts/${name}`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'sandboxed pages fetch fonts with Origin: null');
    assert.equal(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4)), 'wOF2');
  }
  for (const bad of ['OFL.txt', 'inconnu.woff2', '..%2Ffonts.ts', '%2E%2E%2Fconfig.ts']) {
    assert.equal((await h.content.request(`/_fonts/${bad}`)).status, 404, bad);
  }
});

test('polices : les pages visiteurs déclarent Figtree depuis le serveur de contenu', async () => {
  const h = await setup({ artifactBar: true });
  await seedArtifact(h, { slug: 'page', visibility: 'public', kind: 'html', files: { 'index.html': '<p>x</p>' } });
  const frame = await (await h.content.request('/a/page', { headers: { 'sec-fetch-dest': 'document', 'user-agent': 'Mozilla/5.0' } })).text();
  assert.match(frame, /@font-face\{font-family:Figtree;[^}]*src:url\(\/_fonts\/figtree-latin-wght-normal\.woff2\)/);
  assert.doesNotMatch(frame, /fonts\.googleapis|fonts\.gstatic/);
  const missing = await (await h.content.request('/a/inconnu')).text();
  assert.match(missing, /font-family:Figtree/);
});
