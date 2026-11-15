import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret } from '../src/crypto.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { ftsQuery } from '../src/search.ts';
import { makeZip } from './helpers.ts';
import { seedArtifact, setCookies, setup } from './harness.ts';

// Full-text search (design 07).

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';

interface Result { id: string; snippet: { text: string; hit: boolean }[] | null }

async function searchSetup(trashDays = 30, before?: (h: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), trashDays });
  await before?.(h);
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const headers = { cookie: setCookies(res), origin: ORIGIN, 'x-csrf-token': csrfToken };
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await admin.request(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    assert.ok(r.status < 300, `${init.method ?? 'GET'} ${path}: ${r.status} ${await r.clone().text()}`);
    return r.json() as Promise<any>;
  };
  const upload = async (method: 'POST' | 'PUT', path: string, name: string, data: string | Buffer, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', new File([typeof data === 'string' ? data : new Uint8Array(data)], name));
    const r = await admin.request(`/api${path}`, { method, headers, body: form });
    assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${await r.clone().text()}`);
    return r.json() as Promise<{ id: string }>;
  };
  const publish = (name: string, data: string | Buffer, fields: Record<string, string> = {}) => upload('POST', '/artifacts', name, data, fields);
  const search = async (q: string): Promise<Result[]> => (await call(`/search?q=${encodeURIComponent(q)}`)).results;
  const ids = async (q: string) => (await search(q)).map((r) => r.id).sort();
  return { ...h, call, upload, publish, search, ids };
}

const MD = '# Bilan\n\nLe **churn** du troisième trimestre a baissé grâce aux relances.\n';
const PAGE = '<html><head><title>Tableau</title><script>var secretToken = 1;</script><style>.x{}</style></head><body><p>Tableau des données &amp; indicateurs</p></body></html>';

test('recherche : contenu de chaque type, titre, slug et tag ; accents et casse ignorés', async () => {
  const h = await searchSetup();
  const md = await h.publish('bilan.md', MD, { title: 'Bilan T3', tags: 'finance' });
  const json = await h.publish('client.json', JSON.stringify({ client: 'Acme', statut: 'signé' }), { title: 'Fiche client' });
  const html = await h.publish('tableau.html', PAGE, { title: 'Tableau de bord', slug: 'tableau-bord' });
  const site = await h.publish('site.zip', makeZip([
    { name: 'index.html', data: '<p>Accueil du site</p>' },
    { name: 'docs/annexe.html', data: '<p>Page annexe confidentielle</p>' },
  ]), { title: 'Mini site' });
  const pdf = await h.publish('contrat.pdf', '%PDF-1.4\n%¥±ë\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF', { title: 'Contrat cadre' });

  assert.deepEqual(await h.ids('churn'), [md.id]);
  assert.deepEqual(await h.ids('TROISIEME'), [md.id], 'accents and case ignored');
  assert.deepEqual(await h.ids('tri'), [md.id], 'prefix');
  assert.deepEqual(await h.ids('finance'), [md.id], 'tag');
  assert.deepEqual(await h.ids('acme'), [json.id]);
  assert.deepEqual(await h.ids('donnees indicateurs'), [html.id]);
  assert.deepEqual(await h.ids('secrettoken'), [], 'scripts are not text');
  assert.deepEqual(await h.ids('tableau-bord'), [html.id], 'slug');
  assert.deepEqual(await h.ids('annexe confidentielle'), [site.id], 'every page of a site');
  assert.deepEqual(await h.ids('contrat'), [pdf.id], 'a PDF by its title');
  assert.deepEqual(await h.ids('churn acme'), [], 'every word required');
});

test('recherche : saisie libre sans syntaxe, requêtes trop courtes vides', async () => {
  const h = await searchSetup();
  const md = await h.publish('bilan.md', MD);
  for (const q of ['churn"', '"churn', 'churn*', 'churn -', '(churn)', 'churn:']) {
    assert.deepEqual(await h.ids(q), [md.id], q);
  }
  // Operators are words like any other: required, never an FTS5 syntax error.
  for (const q of ['churn OR', 'NEAR(churn', 'churn AND NOT x', '^churn']) assert.ok(Array.isArray(await h.ids(q)), q);
  for (const q of ['', 'c', ' c ', '--', '""', '**']) assert.deepEqual(await h.ids(q), [], JSON.stringify(q));
  assert.equal(ftsQuery('a'), null);
  assert.equal(ftsQuery('ab "cd'), '"ab"* "cd"*');
});

test('recherche : extrait surligné seulement quand le texte correspond', async () => {
  const h = await searchSetup();
  await h.publish('bilan.md', MD, { title: 'Bilan T3' });
  const [byText] = await h.search('relances');
  assert.ok(byText.snippet);
  assert.deepEqual(byText.snippet.filter((p) => p.hit).map((p) => p.text), ['relances']);
  assert.ok(byText.snippet.map((p) => p.text).join('').length < 200);
  const [md] = await h.search('churn');
  assert.doesNotMatch(md.snippet!.map((p) => p.text).join(''), /[#*]/, 'Markdown syntax is not indexed');
  const [byTitle] = await h.search('T3');
  assert.equal(byTitle.snippet, null);
});

test('recherche : suit titre, tags (seuls et en lot), versions, corbeille et suppression', async () => {
  const h = await searchSetup();
  const a = await h.publish('note.md', '# Note\n\nPremière rédaction.\n', { title: 'Ancien titre' });
  const b = await h.publish('autre.md', '# Autre\n\nRien.\n');

  await h.call(`/artifacts/${a.id}`, { method: 'PATCH', body: { title: 'Nouveau titre', tags: ['urgent'] } });
  assert.deepEqual(await h.ids('ancien'), []);
  assert.deepEqual(await h.ids('nouveau'), [a.id]);
  assert.deepEqual(await h.ids('urgent'), [a.id]);
  assert.deepEqual(await h.ids('premiere redaction'), [a.id], 'the text is kept by a title change');

  await h.call('/artifacts/bulk', { method: 'POST', body: { ids: [a.id, b.id], op: 'addTags', value: ['revue'] } });
  assert.deepEqual(await h.ids('revue'), [a.id, b.id].sort());

  await h.upload('PUT', `/artifacts/${a.id}/content`, 'note.md', '# Note\n\nSeconde version.\n');
  assert.deepEqual(await h.ids('premiere'), [], 'old text gone');
  assert.deepEqual(await h.ids('seconde'), [a.id]);
  const versions = (await h.call(`/artifacts/${a.id}/versions`)) as { id: string; current: boolean }[];
  await h.call(`/artifacts/${a.id}/versions/${versions.find((v) => !v.current)!.id}/restore`, { method: 'POST' });
  assert.deepEqual(await h.ids('premiere'), [a.id], 'restored version');

  await h.call(`/artifacts/${a.id}`, { method: 'DELETE' });
  assert.deepEqual(await h.ids('premiere'), [], 'trashed');
  await h.call(`/artifacts/${a.id}/restore`, { method: 'POST' });
  assert.deepEqual(await h.ids('premiere'), [a.id], 'restored from the trash');

  await h.call(`/artifacts/${a.id}`, { method: 'DELETE' });
  await h.call(`/trash/${a.id}`, { method: 'DELETE' });
  const rows = h.db.prepare('SELECT COUNT(*) AS n FROM search_index WHERE artifact_id = ?').get(a.id) as { n: number };
  assert.equal(Number(rows.n), 0, 'deleted for good');
});

test('recherche : les artéfacts existants sont indexés au démarrage', async () => {
  let id = '';
  const h = await searchSetup(30, async (hub) => {
    id = (await seedArtifact(hub, { slug: 'ancien', visibility: 'private', kind: 'html', files: { 'index.html': '<p>Contenu historique</p>' } })).id;
  });
  assert.deepEqual(await h.ids('historique'), [id]);
});
