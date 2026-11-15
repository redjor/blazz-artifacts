// Local API and content servers, started by dev/run.ts under `node --watch`: they restart whenever the server code
// changes, so the hot-reloaded admin UI never talks to an older API. Not meant to be run on its own.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createAdminApp } from '../src/admin/server.ts';
import { loadConfig } from '../src/config.ts';
import { createContentApp } from '../src/content/server.ts';
import { deriveKeys, hashSecret, randomToken, sha256 } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { codeLimiterOptions, loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { listArtifacts } from '../src/repo.ts';
import { ensureDataDirs } from '../src/storage.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const withWeb = !args.has('--no-web');
const DATA = resolve(process.env.DATA_DIR || join(ROOT, '.dev-data'));
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 13000;
const CONTENT_PORT = Number(process.env.CONTENT_PORT) || 13001;
const WEB_PORT = Number(process.env.WEB_PORT) || 5173;
const PASSWORD = process.env.DEV_PASSWORD || 'blazz-artifacts-dev';

mkdirSync(DATA, { recursive: true });

// Secret stable across runs: sessions and share links stay valid.
const secretFile = join(DATA, 'dev-secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomToken(48));
// Chosen by dev/run.ts: the same token across restarts.
const devToken = process.env.BLAZZ_DEV_TOKEN || randomToken();

const cfg = loadConfig({
  ...process.env,
  DATA_DIR: DATA,
  HUB_SECRET: Buffer.from(readFileSync(secretFile, 'utf8')).toString('base64'),
  ADMIN_PASSWORD_HASH: await hashSecret(PASSWORD),
  API_TOKEN_HASH: sha256(devToken),
  PUBLIC_HUB_URL: withWeb ? `http://localhost:${WEB_PORT}` : `http://localhost:${ADMIN_PORT}`,
  PUBLIC_CONTENT_URL: `http://localhost:${CONTENT_PORT}`,
  ADMIN_BIND: '127.0.0.1',
  CONTENT_BIND: '127.0.0.1',
});

await ensureDataDirs(cfg.dataDir);
const db = openDb(join(cfg.dataDir, 'hub.sqlite'));
const keys = deriveKeys(cfg.hubSecret);
const admin = createAdminApp({
  db, cfg, keys, loginLimiter: new RateLimiter(loginLimiterOptions), webDist: join(ROOT, 'web/dist'),
});
const content = createContentApp({ db, cfg, keys, codeLimiter: new RateLimiter(codeLimiterOptions) });

serve({ fetch: admin.fetch, hostname: '127.0.0.1', port: ADMIN_PORT });
serve({ fetch: content.fetch, hostname: '127.0.0.1', port: CONTENT_PORT });

// Demo data on first run.
const SEED: Record<string, { title: string; project?: string; tags?: string[]; visibility?: string; memoryStorage?: boolean }> = {
  'quarterly-report.md': { title: 'Quarterly report', project: 'demo', tags: ['report'], visibility: 'public' },
  'meeting-notes.md': { title: 'Meeting notes', project: 'demo', tags: ['meeting'] },
  'welcome-screen.html': { title: 'Welcome screen', project: 'mockups', visibility: 'link', memoryStorage: true },
  'demo-site.zip': { title: 'Demo site', project: 'mockups', visibility: 'public' },
  'document.pdf': { title: 'PDF document' },
  'sample-data.json': { title: 'Sample data', tags: ['data'] },
};
if (listArtifacts(db).length === 0) {
  const dir = join(ROOT, 'dev/seed');
  for (const name of readdirSync(dir)) {
    const meta = SEED[name];
    if (!meta) continue;
    const form = new FormData();
    form.set('file', new File([readFileSync(join(dir, name))], basename(name)));
    form.set('title', meta.title);
    form.set('visibility', meta.visibility ?? 'private');
    if (meta.project) form.set('project', meta.project);
    if (meta.tags) form.set('tags', meta.tags.join(','));
    if (meta.memoryStorage) form.set('memoryStorage', 'true');
    const res = await admin.request('/api/artifacts', { method: 'POST', headers: { authorization: `Bearer ${devToken}` }, body: form });
    if (res.status !== 201) console.error(`seed ${name}: ${res.status} ${await res.text()}`);
  }
  console.log(`Demo data created (${listArtifacts(db).length} artifacts).`);
}

console.log(`
Blazz Artifacts (local)
  Admin UI    http://localhost:${withWeb ? WEB_PORT : ADMIN_PORT}${withWeb ? '   (hot reload)' : '   (web/dist: npm run build:web)'}
  Content     http://localhost:${CONTENT_PORT}
  Password    ${PASSWORD}
  API token   ${devToken}   (valid for this run)
  Data        ${DATA}
The API restarts when the server code changes. Ctrl+C to stop.`);

const stop = () => {
  db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
