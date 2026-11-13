import { readFileSync } from 'node:fs';
import type { Env, Hono } from 'hono';

const ICON = readFileSync(new URL('./favicon.png', import.meta.url));

// Same icon on both servers. /favicon.ico is the path browsers request on their own,
// so HTML artifacts without their own icon get it too.
export function registerFavicon<E extends Env>(app: Hono<E>): void {
  for (const path of ['/favicon.ico', '/favicon.png']) {
    app.get(path, () => new Response(ICON, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } }));
  }
}
