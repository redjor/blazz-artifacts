import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { getArtifactBySlug, upsertProject } from '../src/repo.ts';
import { tempDataDir } from './helpers.ts';
import { setCookies, setup } from './harness.ts';

// Artifact descriptions (design 12).

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';
const SLACK = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

async function adminSetup() {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), linkPreviews: true });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const headers = { cookie: setCookies(res), origin: ORIGIN, 'x-csrf-token': csrfToken };
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    admin.request(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const publish = async (name: string, data: string, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', new File([data], name));
    return admin.request('/api/artifacts', { method: 'POST', headers, body: form });
  };
  return { ...h, call, publish };
}

const meta = (html: string, prop: string) => new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`).exec(html)?.[1];

test('description : à la publication, modifiée, effacée, bornée', async () => {
  const h = await adminSetup();
  const res = await h.publish('accueil.html', '<p>Accueil</p>', { description: '  Écran d’accueil de la borne.  ' });
  assert.equal(res.status, 201);
  const art = (await res.json()) as { id: string; description: string | null };
  assert.equal(art.description, 'Écran d’accueil de la borne.', 'trimmed');

  const patched = await (await h.call(`/artifacts/${art.id}`, { method: 'PATCH', body: { description: 'Version tactile.' } })).json();
  assert.equal(patched.description, 'Version tactile.');
  assert.equal((await (await h.call(`/artifacts/${art.id}`)).json()).description, 'Version tactile.');
  const cleared = await (await h.call(`/artifacts/${art.id}`, { method: 'PATCH', body: { description: '  ' } })).json();
  assert.equal(cleared.description, null, 'blank clears');

  const long = await h.call(`/artifacts/${art.id}`, { method: 'PATCH', body: { description: 'x'.repeat(1001) } });
  assert.equal(long.status, 400);
  assert.equal(((await long.json()) as { code: string }).code, 'description_too_long');
  assert.equal((await h.call(`/artifacts/${art.id}`, { method: 'PATCH', body: { description: 42 } })).status, 400);
  const bad = await h.publish('b.html', '<p>b</p>', { description: 'y'.repeat(1001) });
  assert.equal(bad.status, 400);

  const before = getArtifactBySlug(h.db, 'accueil')!;
  await h.call(`/artifacts/${art.id}`, { method: 'PATCH', body: { description: 'Sans effet sur l’accès' } });
  assert.equal(getArtifactBySlug(h.db, 'accueil')!.access_epoch, before.access_epoch, 'no epoch bump');
});

test('description : trouvée par la recherche', async () => {
  const h = await adminSetup();
  const art = (await (await h.publish('a.html', '<p>Accueil</p>')).json()) as { id: string };
  await h.call(`/artifacts/${art.id}`, { method: 'PATCH', body: { description: 'Parcours de réservation' } });
  const found = (await (await h.call('/search?q=reservation')).json()) as { results: { id: string }[] };
  assert.deepEqual(found.results.map((r) => r.id), [art.id]);
});

test('description : sous le titre des cartes de la page dossier, et dans les aperçus de lien', async () => {
  const h = await adminSetup();
  await h.publish('accueil.html', '<p>Premier paragraphe</p>', { project: 'borne', visibility: 'public', description: 'Écran <d’accueil>' });
  await h.publish('nu.html', '<p>Texte de la page</p>', { project: 'borne', visibility: 'public' });
  for (const slug of ['accueil','nu']) {
    const a = getArtifactBySlug(h.db,slug)!;
    assert.equal((await h.call(`/artifacts/${a.id}/publish`, {method:'POST',body:{versionId:a.current_version_id}})).status,200);
  }
  upsertProject(h.db, 'borne', { visibility: 'public' });

  const page = await (await h.content.request('/d/borne', { headers: { 'user-agent': BROWSER } })).text();
  assert.match(page, /<span class="card-desc">Écran &lt;d’accueil&gt;<\/span>/);
  assert.equal((page.match(/class="card-desc"/g) ?? []).length, 1, 'no empty paragraph without a description');

  const og = await (await h.content.request('/a/accueil', { headers: { 'user-agent': SLACK } })).text();
  assert.equal(meta(og, 'og:description'), 'Écran &lt;d’accueil&gt;');
  const plain = await (await h.content.request('/a/nu', { headers: { 'user-agent': SLACK } })).text();
  assert.equal(meta(plain, 'og:description'), 'Texte de la page', 'without a description: the excerpt');
});

test('description : migration en place, vue et index de recherche compris, idempotente', async () => {
  const file = join(await tempDataDir(), 'hub.sqlite');
  const db = openDb(file);
  db.exec(`
    INSERT INTO artifacts (id, slug, title, kind, visibility, created_at, updated_at) VALUES ('A1', 'ancien', 'Ancien', 'html', 'private', 'now', 'now');
    DROP VIEW live_artifacts;
    ALTER TABLE artifacts DROP COLUMN description;
    CREATE VIEW live_artifacts AS SELECT * FROM artifacts WHERE deleted_at IS NULL;
    DROP TABLE search_index;
    CREATE VIRTUAL TABLE search_index USING fts5(artifact_id UNINDEXED, title, slug, tags, body, tokenize = 'unicode61 remove_diacritics 2');
    INSERT INTO search_index (artifact_id, title, slug, tags, body) VALUES ('A1', 'Ancien', 'ancien', '', '');
  `);
  db.close();

  const migrated = openDb(file);
  assert.equal(getArtifactBySlug(migrated, 'ancien')!.description, null, 'the view exposes the new column');
  const ftsCols = (migrated.prepare('PRAGMA table_info(search_index)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(ftsCols, ['artifact_id', 'title', 'slug', 'tags', 'body', 'description']);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM search_index').get()!.n, 0, 'rebuilt empty: indexed again at startup');
  migrated.close();
  const again = openDb(file);
  assert.equal(getArtifactBySlug(again, 'ancien')!.slug, 'ancien');
  again.close();
});
