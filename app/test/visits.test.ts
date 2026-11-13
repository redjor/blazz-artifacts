import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { encrypt, hashSecret, randomToken, sha256 } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { newId } from '../src/ids.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { deleteArtifact, getLink, insertLink, revokeLink, type Artifact } from '../src/repo.ts';
import { BOT_UA, isBot, purgeVisitSeen, utcDay, visitStats } from '../src/visits.ts';
import { seedArtifact, setCookies, setup, type Harness } from './harness.ts';
import { tempDataDir } from './helpers.ts';

const SITE = { 'index.html': '<p>x</p>', 'app.js': 'export {}', 'docs/index.html': 'docs' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IP = '203.0.113.42';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

type Visitor = { ip?: string; ua?: string | null; method?: string; dest?: string; cookie?: string };

function visit(h: Harness, path: string, v: Visitor = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': v.ip ?? IP };
  if (v.ua !== null) headers['user-agent'] = v.ua ?? UA;
  if (v.dest) headers['sec-fetch-dest'] = v.dest;
  if (v.cookie) headers.cookie = v.cookie;
  return h.content.request(path, { method: v.method ?? 'GET', headers });
}

const days = (h: Harness, art: Artifact) =>
  h.db.prepare('SELECT day, views, uniques FROM visit_days WHERE artifact_id = ? ORDER BY day').all(art.id).map((r) => ({ ...r }));
const totalViews = (h: Harness, art: Artifact) =>
  Number((h.db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM visit_days WHERE artifact_id = ?').get(art.id) as { n: number }).n);

async function publicSite(h: Harness, slug = 'site') {
  return seedArtifact(h, { slug, visibility: 'public', files: SITE });
}

test('une vue : accès non signé à l’entrée, quelle que soit la forme de l’URL', async () => {
  const h = await setup();
  const art = await publicSite(h);
  const res = await visit(h, '/a/site');
  assert.equal(res.status, 302);
  assert.equal(totalViews(h, art), 1);
  await visit(h, '/a/site/', { ip: '198.51.100.1' });
  await visit(h, '/a/site/index.html', { ip: '198.51.100.2' });
  assert.deepEqual(days(h, art), [{ day: utcDay(h.clock.now()), views: 3, uniques: 3 }]);
});

test('non comptés : sous-ressources signées, pages internes, HEAD, robots, Sec-Fetch-Dest non document', async () => {
  const h = await setup();
  const art = await publicSite(h);
  const first = await visit(h, '/a/site');
  const signed = first.headers.get('location')!;
  assert.equal(totalViews(h, art), 1);
  // Chemin signé : fichiers et pages internes d'un site.
  assert.equal((await visit(h, signed, { ip: '198.51.100.9' })).status, 200);
  assert.equal((await visit(h, signed.replace('index.html', 'app.js'), { ip: '198.51.100.9' })).status, 200);
  // Chemin non signé vers une page interne ou un fichier (redirection d'un chemin signé périmé, par exemple).
  assert.equal((await visit(h, '/a/site/app.js', { ip: '198.51.100.10' })).status, 302);
  assert.equal((await visit(h, '/a/site/docs/', { ip: '198.51.100.11' })).status, 302);
  // HEAD.
  assert.equal((await visit(h, '/a/site', { ip: '198.51.100.12', method: 'HEAD' })).status, 302);
  // Requête de script ou fetch depuis une autre page.
  for (const dest of ['script', 'empty', 'image', 'iframe']) assert.equal((await visit(h, '/a/site', { ip: '198.51.100.13', dest })).status, 302);
  // Robots, aperçus de liens des messageries, outils en ligne de commande, User-Agent absent.
  const bots = [
    'Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0)', 'facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'TelegramBot (like TwitterBot)', 'WhatsApp/2.23.20.0 A',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5', 'curl/8.7.1', 'Wget/1.21', 'python-requests/2.32', 'Mozilla/5.0 HeadlessChrome/120.0',
    'Mozilla/5.0 (compatible; Yahoo! Slurp)', 'Baiduspider', 'SomeCrawler/1.0', 'LinkedInBot/1.0',
  ];
  for (const ua of bots) {
    assert.ok(isBot(ua), ua);
    assert.equal((await visit(h, '/a/site', { ip: '198.51.100.14', ua })).status, 302);
  }
  assert.ok(isBot(undefined) && isBot(''));
  assert.equal((await visit(h, '/a/site', { ip: '198.51.100.15', ua: null })).status, 302);
  assert.ok(!isBot(UA));
  assert.ok(BOT_UA instanceof RegExp);
  assert.equal(totalViews(h, art), 1);
  // 404 : rien n'est créé.
  assert.equal((await visit(h, '/a/inconnu')).status, 404);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM visit_days').get()!.n, 1);
});

test('privé, code : formulaire, mauvais code et 404 non comptés ; accès après déverrouillage compté', async () => {
  const h = await setup();
  const priv = await seedArtifact(h, { slug: 'secret', visibility: 'private', files: SITE });
  const art = await seedArtifact(h, { slug: 'code', visibility: 'code', files: SITE, code: 'bon-code' });
  assert.equal((await visit(h, '/a/secret')).status, 404);
  assert.equal((await visit(h, '/a/code')).status, 401);
  const bad = await h.content.request('/unlock/code', { method: 'POST', headers: { 'x-forwarded-for': IP, 'user-agent': UA }, body: new URLSearchParams({ code: 'mauvais', next: '' }) });
  assert.equal(bad.status, 401);
  assert.equal(totalViews(h, priv) + totalViews(h, art), 0);
  const ok = await h.content.request('/unlock/code', { method: 'POST', headers: { 'x-forwarded-for': IP, 'user-agent': UA }, body: new URLSearchParams({ code: 'bon-code', next: '' }) });
  assert.equal(ok.status, 303);
  assert.equal(totalViews(h, art), 0, 'le POST lui-même ne compte pas');
  assert.equal((await visit(h, ok.headers.get('location')!, { cookie: setCookies(ok) })).status, 302);
  assert.equal(totalViews(h, art), 1);
});

test('dédoublonnage : un visiteur ajoute au plus une vue par artifact et par 30 minutes', async () => {
  const h = await setup();
  const art = await publicSite(h);
  const other = await publicSite(h, 'autre');
  h.clock.advance(Date.UTC(2026, 10, 12, 10, 0, 0) - h.clock.now());
  await visit(h, '/a/site');
  await visit(h, '/a/site');
  h.clock.advance(29 * 60_000);
  await visit(h, '/a/site');
  assert.equal(totalViews(h, art), 1);
  h.clock.advance(60_000);
  await visit(h, '/a/site');
  assert.equal(totalViews(h, art), 2, '30 minutes après la vue comptée');
  h.clock.advance(10 * 60_000);
  await visit(h, '/a/site');
  assert.equal(totalViews(h, art), 2, 'la fenêtre repart de la dernière vue comptée');
  // Même IP, autre navigateur : autre visiteur. Autre artifact : compté à part.
  await visit(h, '/a/site', { ua: `${UA} Firefox/130.0` });
  await visit(h, '/a/autre');
  assert.equal(totalViews(h, art), 3);
  assert.equal(days(h, art)[0].uniques, 2);
  assert.equal(totalViews(h, other), 1);
});

test('visiteurs uniques par jour (UTC) : la clé du jour change, un visiteur revenu le lendemain recompte', async () => {
  const h = await setup();
  const art = await publicSite(h);
  const start = Date.UTC(2026, 10, 12, 10, 0, 0);
  h.clock.advance(start - h.clock.now());
  await visit(h, '/a/site');
  h.clock.advance(HOUR);
  await visit(h, '/a/site');
  await visit(h, '/a/site', { ip: '198.51.100.1' });
  assert.deepEqual(days(h, art), [{ day: '2026-11-12', views: 3, uniques: 2 }]);
  const seenDay1 = h.db.prepare("SELECT visitor_hash FROM visit_seen WHERE day = '2026-11-12' ORDER BY visitor_hash").all().map((r) => r.visitor_hash);
  h.clock.advance(DAY);
  await visit(h, '/a/site');
  assert.deepEqual(days(h, art), [{ day: '2026-11-12', views: 3, uniques: 2 }, { day: '2026-11-13', views: 1, uniques: 1 }]);
  const seenDay2 = h.db.prepare("SELECT visitor_hash FROM visit_seen WHERE day = '2026-11-13'").all().map((r) => r.visitor_hash);
  assert.equal(seenDay2.length, 1);
  assert.ok(!seenDay1.includes(seenDay2[0]), 'empreinte différente d’un jour à l’autre');
});

test('purge : visit_seen au-delà de 2 jours supprimé, agrégats conservés', async () => {
  const h = await setup();
  const art = await publicSite(h);
  const start = Date.UTC(2026, 10, 10, 12, 0, 0);
  h.clock.advance(start - h.clock.now());
  await visit(h, '/a/site');
  h.clock.advance(DAY);
  await visit(h, '/a/site');
  h.clock.advance(DAY);
  await visit(h, '/a/site');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM visit_seen').get()!.n, 3);
  purgeVisitSeen(h.db, h.clock.now());
  const left = h.db.prepare('SELECT day FROM visit_seen ORDER BY day').all().map((r) => r.day);
  assert.deepEqual(left, ['2026-11-11', '2026-11-12']);
  assert.equal(totalViews(h, art), 3);
  assert.equal(days(h, art).length, 3);
  h.clock.advance(5 * DAY);
  purgeVisitSeen(h.db, h.clock.now());
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM visit_seen').get()!.n, 0);
  assert.equal(totalViews(h, art), 3);
});

test('suppression d’un artifact : statistiques supprimées en cascade', async () => {
  const h = await setup();
  const art = await publicSite(h);
  await visit(h, '/a/site');
  deleteArtifact(h.db, art.id);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM visit_days').get()!.n, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM visit_seen').get()!.n, 0);
});

function seedLink(h: Harness, art: Artifact) {
  const token = randomToken();
  const link = insertLink(h.db, { id: newId(), artifact_id: art.id, token_hash: sha256(token), token_enc: encrypt(h.keys.linkEnc, token), label: 'Client', expires_at: null });
  return { token, link };
}

test('liens de partage : ouvertures comptées (hors robots et HEAD), dernière utilisation, vue comptée à l’arrivée', async () => {
  const h = await setup();
  const art = await seedArtifact(h, { slug: 'lien', visibility: 'link', files: SITE });
  const { token, link } = seedLink(h, art);
  const bot = await visit(h, `/share/${token}`, { ua: 'Slackbot-LinkExpanding 1.0' });
  assert.equal(bot.status, 302, 'l’échange fonctionne toujours pour un robot');
  assert.equal((await visit(h, `/share/${token}`, { method: 'HEAD' })).status, 302);
  assert.equal(getLink(h.db, link.id)!.open_count, 0);
  assert.equal(getLink(h.db, link.id)!.last_used_at, null);
  const res = await visit(h, `/share/${token}`);
  assert.equal(res.status, 302);
  assert.equal(getLink(h.db, link.id)!.open_count, 1);
  assert.ok(getLink(h.db, link.id)!.last_used_at);
  await visit(h, `/share/${token}`, { ip: '198.51.100.1' });
  assert.equal(getLink(h.db, link.id)!.open_count, 2);
  assert.equal(totalViews(h, art), 0, 'l’échange seul n’est pas une vue');
  assert.equal((await visit(h, res.headers.get('location')!, { cookie: setCookies(res) })).status, 302);
  assert.equal(totalViews(h, art), 1);
  revokeLink(h.db, art.id, link.id);
  assert.equal((await visit(h, `/share/${token}`)).status, 404);
  assert.equal(getLink(h.db, link.id)!.open_count, 2);
});

test('aucune IP ni User-Agent stockés, dans aucune table', async () => {
  const h = await setup();
  const art = await seedArtifact(h, { slug: 'lien', visibility: 'link', files: SITE });
  await publicSite(h);
  const { token } = seedLink(h, art);
  const ips = ['203.0.113.42', '2001:db8::77'];
  const uas = [UA, 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'];
  for (const ip of ips) {
    for (const ua of uas) {
      await visit(h, '/a/site', { ip, ua });
      const share = await visit(h, `/share/${token}`, { ip, ua });
      await visit(h, '/a/lien', { ip, ua, cookie: setCookies(share) });
    }
  }
  assert.equal(totalViews(h, art), 4);
  const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name as string);
  assert.ok(tables.includes('visit_seen') && tables.includes('visit_days'));
  const dump = JSON.stringify(tables.map((t) => h.db.prepare(`SELECT * FROM "${t}"`).all()));
  for (const needle of [...ips, ...uas, 'Mozilla', 'Firefox', '203.0.113', '2001:db8', sha256(ips[0]), sha256(uas[0])]) {
    assert.ok(!dump.includes(needle), `trouvé en base : ${needle}`);
  }
});

test('un échec d’écriture ne casse ni ne ralentit la visite ; erreur journalisée une seule fois, sans IP ni UA', async (t) => {
  const h = await setup();
  const art = await seedArtifact(h, { slug: 'lien', visibility: 'link', files: SITE });
  await publicSite(h);
  const { token } = seedLink(h, art);
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  h.db.exec('DROP TABLE visit_days; DROP TABLE visit_seen; ALTER TABLE share_links DROP COLUMN open_count');
  assert.equal((await visit(h, '/a/site')).status, 302);
  assert.equal((await visit(h, '/a/site', { ip: '198.51.100.1' })).status, 302);
  assert.equal((await visit(h, `/share/${token}`)).status, 302);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.ok(!errors[0].includes(IP) && !errors[0].includes('Mozilla'));
});

test('aperçus admin (chemin signé, version épinglée) jamais comptés', async () => {
  const h = await setup({ adminPasswordHash: await hashSecret('mot-de-passe-solide') });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions), now: h.clock.now });
  const art = await publicSite(h);
  const login = await admin.request('/api/login', { method: 'POST', headers: { origin: 'https://hub.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'mot-de-passe-solide' }) });
  const cookie = setCookies(login);
  const preview = (await (await admin.request(`/api/artifacts/${art.id}/preview`, { headers: { cookie } })).json()) as { url: string };
  const path = new URL(preview.url).pathname;
  assert.equal((await visit(h, path)).status, 200);
  const versions = (await (await admin.request(`/api/artifacts/${art.id}/versions`, { headers: { cookie } })).json()) as { id: string }[];
  const pinned = (await (await admin.request(`/api/artifacts/${art.id}/versions/${versions[0].id}/preview`, { headers: { cookie } })).json()) as { url: string };
  assert.equal((await visit(h, new URL(pinned.url).pathname)).status, 200);
  assert.equal(totalViews(h, art), 0);
});

test('API admin : DTO views, statistiques sur N jours, liens avec ouvertures', async () => {
  const h = await setup({ adminPasswordHash: await hashSecret('mot-de-passe-solide') });
  // Horloge dans le futur : la session admin (expiration calculée avec cette horloge) reste valide.
  const start = Date.UTC(2027, 0, 10, 9, 0, 0);
  h.clock.advance(start - h.clock.now());
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions), now: h.clock.now });
  const login = await admin.request('/api/login', { method: 'POST', headers: { origin: 'https://hub.test', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'mot-de-passe-solide' }) });
  const cookie = setCookies(login);
  const get = async (path: string) => {
    const res = await admin.request(`/api${path}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const art = await seedArtifact(h, { slug: 'lien', visibility: 'link', files: SITE });
  const quiet = await publicSite(h, 'calme');

  const empty = await get(`/artifacts/${quiet.id}/stats`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.total, { views: 0, uniques: 0 });
  assert.equal(empty.body.days.length, 30);
  assert.ok(empty.body.days.every((d: { views: number; uniques: number }) => d.views === 0 && d.uniques === 0));
  assert.equal(empty.body.days.at(-1).day, '2027-01-10');
  assert.equal(empty.body.days[0].day, '2026-12-12');
  assert.equal(empty.body.lastVisitAt, null);
  assert.deepEqual(empty.body.links, []);

  const { token, link } = seedLink(h, art);
  const share = await visit(h, `/share/${token}`);
  await visit(h, '/a/lien', { cookie: setCookies(share) });
  await visit(h, '/a/lien', { cookie: setCookies(share), ip: '198.51.100.1' });
  h.clock.advance(40 * DAY);
  const lastAt = new Date(h.clock.now()).toISOString();
  await visit(h, '/a/lien', { cookie: setCookies(await visit(h, `/share/${token}`)) });

  const list = await get('/artifacts');
  const dto = list.body.find((a: { id: string }) => a.id === art.id);
  assert.deepEqual(dto.views, { total: 3, last30: 1 });
  assert.deepEqual(list.body.find((a: { id: string }) => a.id === quiet.id).views, { total: 0, last30: 0 });
  const detail = await get(`/artifacts/${art.id}`);
  assert.deepEqual(detail.body.views, { total: 3, last30: 1 });
  assert.equal(detail.body.links[0].openCount, 2);

  const stats = await get(`/artifacts/${art.id}/stats?days=7`);
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body.total, { views: 3, uniques: 3 });
  assert.equal(stats.body.days.length, 7);
  assert.deepEqual(stats.body.days.at(-1), { day: '2027-02-19', views: 1, uniques: 1 });
  assert.equal(stats.body.days[0].day, '2027-02-13');
  assert.equal(stats.body.lastVisitAt, lastAt);
  assert.deepEqual(stats.body.links, [{ id: link.id, label: 'Client', openCount: 2, lastUsedAt: lastAt, active: true }]);

  const long = await get(`/artifacts/${art.id}/stats?days=365`);
  assert.equal(long.body.days.length, 365);
  assert.deepEqual(long.body.days.filter((d: { views: number }) => d.views > 0), [{ day: '2027-01-10', views: 2, uniques: 2 }, { day: '2027-02-19', views: 1, uniques: 1 }]);
  assert.equal((await get(`/artifacts/${art.id}/stats`)).body.days.length, 30);
  for (const bad of ['0', '366', 'abc', '1.5', '-3']) assert.equal((await get(`/artifacts/${art.id}/stats?days=${bad}`)).status, 400, bad);
  assert.equal((await get('/artifacts/inconnu/stats')).status, 404);
  assert.deepEqual(visitStats(h.db, art.id, 1, h.clock.now()).days, [{ day: '2027-02-19', views: 1, uniques: 1 }]);
});

test('migration idempotente : base existante sans tables de visites ni open_count', async () => {
  const file = join(await tempDataDir(), 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('html','markdown','pdf','json','site')),
    visibility TEXT NOT NULL CHECK (visibility IN ('private','code','link','public')),
    code_hash TEXT, access_epoch INTEGER NOT NULL DEFAULT 1, current_version_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE share_links (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, token_enc TEXT NOT NULL, label TEXT, expires_at TEXT, revoked_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL);
  INSERT INTO artifacts (id, slug, title, kind, visibility, created_at, updated_at) VALUES ('a1','vieux','Vieux','html','link','2026-01-01','2026-01-01');
  INSERT INTO share_links VALUES ('l1','a1','h','e',NULL,NULL,NULL,'2026-01-02','2026-01-01');`);
  old.close();
  const db = openDb(file);
  assert.equal(getLink(db, 'l1')!.open_count, 0);
  assert.equal(getLink(db, 'l1')!.last_used_at, '2026-01-02');
  db.prepare("INSERT INTO visit_days (artifact_id, day, views, uniques) VALUES ('a1', '2026-01-03', 4, 2)").run();
  db.prepare("UPDATE share_links SET open_count = 5").run();
  db.close();
  const again = openDb(file);
  assert.equal(getLink(again, 'l1')!.open_count, 5);
  assert.equal(again.prepare('SELECT views FROM visit_days').get()!.views, 4);
  assert.equal((again.prepare('PRAGMA table_info(share_links)').all() as { name: string }[]).filter((c) => c.name === 'open_count').length, 1);
  again.close();
});

test('plafond anti-abus : au plus 20 visiteurs distincts comptés par IP, artifact et jour', async () => {
  const h = await setup();
  const art = await publicSite(h);
  const other = await publicSite(h, 'autre');
  h.clock.advance(Date.UTC(2026, 10, 12, 10, 0, 0) - h.clock.now());
  for (let i = 0; i < 25; i++) await visit(h, '/a/site', { ua: `${UA} build/${i}` });
  assert.deepEqual(days(h, art), [{ day: '2026-11-12', views: 20, uniques: 20 }]);
  // Un visiteur déjà compté le reste (fenêtre de 30 min) ; une autre IP et un autre artifact ne sont pas touchés.
  h.clock.advance(31 * 60_000);
  await visit(h, '/a/site', { ua: `${UA} build/3` });
  await visit(h, '/a/site', { ua: `${UA} build/24` });
  await visit(h, '/a/site', { ip: '198.51.100.7', ua: `${UA} build/24` });
  await visit(h, '/a/autre', { ua: `${UA} build/24` });
  assert.deepEqual(days(h, art), [{ day: '2026-11-12', views: 22, uniques: 21 }]);
  assert.equal(totalViews(h, other), 1);
  // Le lendemain, nouvelle clé : le plafond repart.
  h.clock.advance(DAY);
  await visit(h, '/a/site', { ua: `${UA} build/24` });
  assert.equal(days(h, art).at(-1)!.views, 1);
  assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM visit_seen').all()).includes(IP));
});

test('vue enregistrée atomiquement : échec du second upsert → empreinte annulée, rien de compté', async (t) => {
  const h = await setup();
  const art = await publicSite(h);
  t.mock.method(console, 'error', () => {});
  h.db.exec("CREATE TRIGGER boom BEFORE INSERT ON visit_days BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.equal((await visit(h, '/a/site')).status, 302);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM visit_seen').get()!.n, 0, 'empreinte annulée');
  h.db.exec('DROP TRIGGER boom');
  assert.equal((await visit(h, '/a/site')).status, 302);
  assert.deepEqual(days(h, art).map((d) => [d.views, d.uniques]), [[1, 1]]);
});

test('base : synchronous=NORMAL et secure_delete actif', async () => {
  const db = openDb(join(await tempDataDir(), 'p.sqlite'));
  assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous, 1);
  assert.equal(db.prepare('PRAGMA secure_delete').get()!.secure_delete, 1);
  purgeVisitSeen(db, Date.now()); // purge + checkpoint WAL sans erreur
  db.close();
});
