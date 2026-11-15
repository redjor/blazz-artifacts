// Runs Blazz Artifacts locally to preview changes.
//
//   npm run dev            API + content + Vite admin UI (hot reload)
//   npm run dev -- --reset start from an empty database (demo data re-created)
//   npm run dev -- --no-web without Vite: the built UI is served by the API
//
// Data lives in .dev-data/ (git-ignored). HUB_LOCALE=fr|auto changes the visitor pages' language.
//
// Vite hot-reloads the admin UI; the API and content servers (dev/api.ts) run under `node --watch` and restart when
// the server code changes. Without it, a new UI could call a route the still-running older API does not know.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomToken } from '../src/crypto.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const withWeb = !args.has('--no-web');
const DATA = resolve(process.env.DATA_DIR || join(ROOT, '.dev-data'));
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 13000;
const WEB_PORT = Number(process.env.WEB_PORT) || 5173;

// Once, here: the API restarts would otherwise wipe the data each time.
if (args.has('--reset')) rmSync(DATA, { recursive: true, force: true });

const api = spawn(process.execPath, ['--watch', '--watch-preserve-output', join(ROOT, 'dev/api.ts'), ...(withWeb ? [] : ['--no-web'])], {
  cwd: ROOT,
  stdio: 'inherit',
  // One API token for the whole session, whatever the restarts.
  env: { ...process.env, BLAZZ_DEV_TOKEN: process.env.BLAZZ_DEV_TOKEN || randomToken() },
});

let vite: ReturnType<typeof spawn> | null = null;
if (withWeb) {
  vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ADMIN_PORT: String(ADMIN_PORT), WEB_PORT: String(WEB_PORT) },
  });
  vite.on('exit', (code) => {
    if (code) console.error(`Vite stopped (code ${code}). Port ${WEB_PORT} already in use? Set WEB_PORT=… to change it.`);
  });
}

const stop = () => {
  vite?.kill();
  api.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => {
  vite?.kill();
  process.exit(code ?? 0);
});
