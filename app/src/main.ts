import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createAdminApp } from './admin/server.ts';
import { loadConfig } from './config.ts';
import { createContentApp } from './content/server.ts';
import { deriveKeys } from './crypto.ts';
import { openDb } from './db.ts';
import { codeLimiterOptions, loginLimiterOptions, RateLimiter } from './ratelimit.ts';
import { purgeExpiredSessions } from './repo.ts';
import { ensureDataDirs, repairModes, tmpRoot } from './storage.ts';
import { purgeVisitSeen } from './visits.ts';

const cfg = loadConfig();
await rm(tmpRoot(cfg.dataDir), { recursive: true, force: true });
await ensureDataDirs(cfg.dataDir);
const db = openDb(join(cfg.dataDir, 'hub.sqlite'));
const keys = deriveKeys(cfg.hubSecret);
// Visit fingerprints: purged at startup then every hour (only daily aggregates remain).
const purgeVisits = () => {
  try {
    purgeVisitSeen(db, Date.now());
  } catch (err) {
    console.error('[maintenance] visit purge:', err instanceof Error ? err.message : 'unknown error');
  }
};
purgeVisits();
const loginLimiter = new RateLimiter(loginLimiterOptions);
const codeLimiter = new RateLimiter(codeLimiterOptions);

if (!cfg.adminPasswordHash) console.warn('ADMIN_PASSWORD_HASH is empty: admin sign-in is impossible.');

const admin = createAdminApp({ db, cfg, keys, loginLimiter, webDist: resolve(import.meta.dirname, '../web/dist') });
const content = createContentApp({ db, cfg, keys, codeLimiter });

serve({ fetch: admin.fetch, hostname: cfg.adminBind, port: Number(process.env.ADMIN_PORT) || 3000 }, (i) => console.log(`admin   ${i.address}:${i.port}`));
serve({ fetch: content.fetch, hostname: cfg.contentBind, port: Number(process.env.CONTENT_PORT) || 3001 }, (i) => console.log(`content ${i.address}:${i.port}`));

// Repairs files published before mode normalisation (0644 / 0755), after the ports are open:
// a non-root backup must be able to read everything, but the service does not wait for this walk.
void (async () => {
  for (const sub of ['files', 'thumbs']) {
    try {
      const r = await repairModes(join(cfg.dataDir, sub));
      if (r.changed || r.failed) console.log(`[modes] ${sub}/: ${r.checked} checked, ${r.changed} fixed, ${r.failed} failed`);
    } catch (err) {
      console.error(`[modes] ${sub}/:`, err instanceof Error ? err.message : 'unknown error');
    }
  }
})();

setInterval(() => {
  try {
    purgeExpiredSessions(db);
    loginLimiter.sweep();
    codeLimiter.sweep();
  } catch (err) {
    console.error('[maintenance]', err);
  }
  purgeVisits();
}, 3600_000).unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    db.close();
    process.exit(0);
  });
}
