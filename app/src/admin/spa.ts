import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Context } from 'hono';
import { contentTypeFor } from '../content/mime.ts';

// Serves the built SPA; any unknown route outside /api returns index.html.
export async function serveSpa(c: Context, webDist: string): Promise<Response> {
  const root = resolve(webDist);
  const requested = resolve(root, `.${decodeURIComponent(new URL(c.req.url).pathname)}`);
  const inside = requested.startsWith(root + sep);
  const isFile = inside && (await stat(requested).catch(() => null))?.isFile();
  const file = isFile ? requested : resolve(root, 'index.html');
  const body = await readFile(file).catch(() => null);
  if (!body) return c.text('Admin UI not built (npm run build:web)', 404);
  const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  return new Response(body, { headers: { 'Content-Type': contentTypeFor(file).type, 'Cache-Control': cache } });
}
