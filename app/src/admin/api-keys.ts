import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { newId } from '../ids.ts';
import { HttpError } from '../http.ts';
import type { AdminEnv } from './auth.ts';

export type ApiScope = 'read' | 'publish' | 'full';
export function initializeApiKeys(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('read','publish','full')),
    token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT, revoked_at TEXT, last_used_at TEXT
  )`);
}
export function authenticateApiKey(db: Db, token: string, now: number): ApiScope | null {
  const key = db.prepare('SELECT id, scope, expires_at, revoked_at FROM api_keys WHERE token_hash=?').get(sha256(token)) as
    { id: string; scope: ApiScope; expires_at: string | null; revoked_at: string | null } | undefined;
  if (!key || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= now)) return null;
  db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(new Date(now).toISOString(), key.id);
  return key.scope;
}
const columns = 'id, name, scope, prefix, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt';
export function createKeyRoutes(db: Db, now: () => number): Hono<AdminEnv> {
  const api = new Hono<AdminEnv>();
  api.use('*', async (c, next) => {
    if (c.get('viaToken')) throw new HttpError(403, 'token_not_allowed');
    c.header('Cache-Control', 'no-store');
    await next();
  });
  api.get('/', c => c.json(db.prepare(`SELECT ${columns} FROM api_keys ORDER BY created_at DESC, id DESC`).all()));
  api.post('/', bodyLimit({ maxSize: 4096 }), async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || !['read','publish','full'].includes(body.scope) || Object.keys(body).some(k => !['name','scope','expiresAt'].includes(k))) {
      return c.json({ error: 'Use a name (1–80 characters) and a read, publish or full scope.' }, 400);
    }
    const at = now();
    const expiry = body.expiresAt === undefined || body.expiresAt === null ? null : typeof body.expiresAt === 'string' && Number.isFinite(Date.parse(body.expiresAt)) ? Date.parse(body.expiresAt) : NaN;
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= at)) return c.json({ error: 'Expiry must be a future date.' }, 400);
    const id = newId(); const token = `bza_${randomToken()}`;
    db.prepare('INSERT INTO api_keys (id,name,scope,token_hash,prefix,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(id, body.name.trim(), body.scope, sha256(token), token.slice(0, 12), new Date(at).toISOString(), expiry === null ? null : new Date(expiry).toISOString());
    const row = db.prepare(`SELECT ${columns} FROM api_keys WHERE id=?`).get(id);
    return c.json({ ...row, token }, 201);
  });
  api.delete('/:id', c => {
    const result = db.prepare('UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(new Date(now()).toISOString(), c.req.param('id'));
    if (!result.changes) return c.json({ error: 'Key not found.' }, 404);
    return c.json({ ok: true });
  });
  return api;
}
