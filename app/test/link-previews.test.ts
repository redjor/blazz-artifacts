import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { encrypt, randomToken, sha256 } from '../src/crypto.ts';
import { newId } from '../src/ids.ts';
import {
  activateVersion, bumpEpoch, getLink, insertLink, revokeLink, setVersionThumb, trashArtifact, upsertProject, type Artifact,
} from '../src/repo.ts';
import { thumbPath, thumbsDir } from '../src/storage.ts';
import { isLinkPreview, viewTotals } from '../src/visits.ts';
import { seedArtifact, setup, type Harness } from './harness.ts';

// Link previews (design 06).

const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const DOC = {
  'index.html': '<h1>Rapport</h1><p>Premier paragraphe</p>',
  'source.md': '# Rapport\n\nPremier paragraphe avec <b>&</b> "guillemets".\n',
};

const get = (h: Harness, path: string, ua = SLACK, method = 'GET') =>
  h.content.request(path, { method, headers: { 'user-agent': ua, 'x-forwarded-for': '203.0.113.7' } });

async function withThumb(h: Harness, art: Artifact) {
  await mkdir(thumbsDir(h.cfg.dataDir, art.id), { recursive: true });
  await writeFile(thumbPath(h.cfg.dataDir, art.id, art.current_version_id!, 'png'), 'png-bytes');
  setVersionThumb(h.db, art.id, art.current_version_id!, { thumb_type: 'png', thumb_at: new Date(h.clock.now()).toISOString() });
}

const meta = (html: string, prop: string) => new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`).exec(html)?.[1];

function shareToken(h: Harness, target: { artifact_id: string } | { project_name: string }) {
  const token = randomToken();
  const link = insertLink(h.db, { id: newId(), token_hash: sha256(token), token_enc: encrypt(h.keys.linkEnc, token), label: null, expires_at: null, ...target });
  return { token, link };
}

test('aperçu de lien : un artéfact public donne une page Open Graph aux services d’aperçu, la redirection aux autres', async () => {
  const h = await setup({ linkPreviews: true });
  const art = await seedArtifact(h, { slug: 'rapport', visibility: 'public', kind: 'markdown', files: DOC, title: 'Rapport <Q3> & "client"' });
  await withThumb(h, art);

  const res = await get(h, '/a/rapport');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  const html = await res.text();
  assert.doesNotMatch(html, /<script/i);
  assert.equal(meta(html, 'og:title'), 'Rapport &lt;Q3&gt; &amp; &quot;client&quot;');
  assert.equal(meta(html, 'og:description'), 'Premier paragraphe avec &amp; &quot;guillemets&quot;.');
  assert.equal(meta(html, 'og:url'), 'https://artifacts.test/a/rapport');
  assert.equal(meta(html, 'twitter:card'), 'summary_large_image');
  const image = new URL(meta(html, 'og:image')!.replace(/&amp;/g, '&'));
  assert.equal(image.origin, 'https://artifacts.test');
  const img = await get(h, image.pathname + image.search);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(await img.text(), 'png-bytes');

  for (const ua of [BROWSER, 'curl/8.7.1', 'Googlebot/2.1 (+http://www.google.com/bot.html)']) {
    assert.equal((await get(h, '/a/rapport', ua)).status, 302, ua);
  }
  assert.equal((await get(h, '/a/rapport', SLACK, 'HEAD')).status, 302, 'HEAD keeps the redirect');
  assert.equal(viewTotals(h.db, art.id, h.clock.now()).total, 1, 'only the browser counted');
});

test('aperçu de lien : sans miniature, carte simple ; un PDF est décrit par son type', async () => {
  const h = await setup({ linkPreviews: true });
  await seedArtifact(h, { slug: 'doc', visibility: 'public', kind: 'pdf', entry: 'doc.pdf', files: { 'doc.pdf': '%PDF-1.4' }, title: 'Contrat' });
  const html = await (await get(h, '/a/doc')).text();
  assert.equal(meta(html, 'og:image'), undefined);
  assert.equal(meta(html, 'twitter:card'), 'summary');
  assert.equal(meta(html, 'og:description'), 'PDF');
});

test('aperçu de lien : lien de partage actif, sans ouverture comptée ni cookie ; révoqué, rien', async () => {
  const h = await setup({ linkPreviews: true });
  const art = await seedArtifact(h, { slug: 'maquette', visibility: 'link', kind: 'markdown', files: DOC, title: 'Maquette' });
  const { token, link } = shareToken(h, { artifact_id: art.id });
  const res = await get(h, `/share/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(meta(await res.text(), 'og:title'), 'Maquette');
  assert.equal(getLink(h.db, link.id)!.open_count, 0);
  assert.equal((await get(h, `/share/${token}`, BROWSER)).status, 302, 'people still get the link');
  assert.equal((await get(h, '/a/maquette')).status, 404, 'the bare address of a link artifact stays closed');
  revokeLink(h.db, art.id, link.id);
  assert.equal((await get(h, `/share/${token}`)).status, 404);
});

test('aperçu de lien : rien pour un artéfact privé, page de code pour un artéfact protégé', async () => {
  const h = await setup({ linkPreviews: true });
  await seedArtifact(h, { slug: 'secret', visibility: 'private', kind: 'markdown', files: DOC });
  await seedArtifact(h, { slug: 'code', visibility: 'code', code: 'code-secret', kind: 'markdown', files: DOC });
  assert.equal((await get(h, '/a/secret')).status, 404);
  const unlock = await get(h, '/a/code');
  assert.equal(unlock.status, 401);
  assert.equal(meta(await unlock.text(), 'og:title'), undefined);
});

test('aperçu de lien : dossier public, artéfact par le dossier, lien de dossier ; dossier privé fermé', async () => {
  const h = await setup({ linkPreviews: true });
  const first = await seedArtifact(h, { slug: 'a1', visibility: 'private', project: 'client', kind: 'markdown', files: DOC, title: 'Premier' });
  const second = await seedArtifact(h, { slug: 'a2', visibility: 'private', project: 'client', kind: 'markdown', files: DOC, title: 'Second' });
  await withThumb(h, second);
  upsertProject(h.db, 'client', { visibility: 'public', title: 'Client & co', description: 'Maquettes du trimestre' });

  const page = await (await get(h, '/d/client')).text();
  assert.equal(meta(page, 'og:title'), 'Client &amp; co');
  assert.equal(meta(page, 'og:description'), 'Maquettes du trimestre');
  assert.match(meta(page, 'og:image') ?? '', new RegExp(`/og/${second.id}/`), 'first artifact with a thumbnail');
  const viaFolder = await get(h, '/d/client/a/a1');
  assert.equal(viaFolder.status, 200);
  assert.equal(meta(await viaFolder.text(), 'og:title'), 'Premier', 'folder access opens its artifacts');
  assert.equal(viewTotals(h.db, first.id, h.clock.now()).total, 0);

  await seedArtifact(h, { slug: 'b1', visibility: 'public', project: 'interne', kind: 'markdown', files: DOC });
  assert.equal((await get(h, '/d/interne')).status, 404, 'a folder without a sheet is private');
  upsertProject(h.db, 'equipe', { visibility: 'link' });
  await seedArtifact(h, { slug: 'e1', visibility: 'private', project: 'equipe', kind: 'markdown', files: DOC });
  assert.equal((await get(h, '/d/equipe')).status, 404, 'a link folder needs its link');
  const { token } = shareToken(h, { project_name: 'equipe' });
  const shared = await get(h, `/share/${token}`);
  assert.equal(shared.status, 200);
  assert.equal(meta(await shared.text(), 'og:description'), '1 artifact');
});

test('aperçu de lien : l’image signée meurt avec la version, l’époque, la corbeille ou l’expiration', async () => {
  const h = await setup({ linkPreviews: true });
  const imageOf = async (slug: string) => {
    const url = new URL(meta(await (await get(h, `/a/${slug}`)).text(), 'og:image')!.replace(/&amp;/g, '&'));
    return url.pathname + url.search;
  };
  const art = await seedArtifact(h, { slug: 'img', visibility: 'public', kind: 'markdown', files: DOC });
  await withThumb(h, art);

  const forged = (await imageOf('img')).replace(/\.[A-Za-z0-9_-]{43}$/, `.${'A'.repeat(43)}`);
  assert.equal((await get(h, forged)).status, 404);
  const expiring = await imageOf('img');
  h.clock.advance(25 * 3600_000);
  assert.equal((await get(h, expiring)).status, 404, 'expired after a day');

  const cut = await imageOf('img');
  bumpEpoch(h.db, art.id);
  assert.equal((await get(h, cut)).status, 404, 'cut access');

  const replaced = await imageOf('img');
  activateVersion(h.db, art.id, { id: newId(), entry_path: 'index.html', original_name: 'x', size_bytes: 1, file_count: 1 }, 'markdown');
  assert.equal((await get(h, replaced)).status, 404, 'new version');

  const other = await seedArtifact(h, { slug: 'jete', visibility: 'public', kind: 'markdown', files: DOC });
  await withThumb(h, other);
  const trashed = await imageOf('jete');
  trashArtifact(h.db, other.id);
  assert.equal((await get(h, trashed)).status, 404, 'trashed');
});

test('aperçu de lien : LINK_PREVIEWS=0 garde la redirection et ferme les images', async () => {
  const h = await setup({ linkPreviews: false });
  const art = await seedArtifact(h, { slug: 'off', visibility: 'public', kind: 'markdown', files: DOC });
  await withThumb(h, art);
  assert.equal((await get(h, '/a/off')).status, 302);
  assert.equal((await get(h, `/og/${art.id}/${art.current_version_id}?s=1.${'A'.repeat(43)}`)).status, 404);

  const base = { HUB_SECRET: Buffer.alloc(48, 1).toString('base64'), PUBLIC_HUB_URL: 'https://hub.example.com', PUBLIC_CONTENT_URL: 'https://artifacts.example.com' };
  assert.equal(loadConfig(base).linkPreviews, true);
  assert.equal(loadConfig({ ...base, LINK_PREVIEWS: '0' }).linkPreviews, false);
  assert.equal(loadConfig({ ...base, LINK_PREVIEWS: 'true' }).linkPreviews, true);
  assert.throws(() => loadConfig({ ...base, LINK_PREVIEWS: 'peut-être' }), /LINK_PREVIEWS/);
});

test('aperçu de lien : la liste des services d’aperçu exclut navigateurs, moteurs et scripts', () => {
  for (const ua of [
    SLACK, 'facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'Twitterbot/1.0', 'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'TelegramBot (like TwitterBot)', 'WhatsApp/2.23.20.0 A',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5', 'Mattermost-Bot/1.1',
  ]) assert.ok(isLinkPreview(ua), ua);
  for (const ua of [BROWSER, 'curl/8.7.1', 'Wget/1.21', 'python-requests/2.32', 'Googlebot/2.1', 'Mozilla/5.0 (compatible; bingbot/2.0)', '', undefined]) {
    assert.ok(!isLinkPreview(ua), String(ua));
  }
});
