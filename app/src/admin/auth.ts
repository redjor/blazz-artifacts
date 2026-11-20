import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hubOrigins, type Config } from '../config.ts';
import { randomToken, safeEqual, sha256 } from '../crypto.ts';
import type { Db } from '../db.ts';
import { clientIp, HttpError } from '../http.ts';
import type { RateLimiter } from '../ratelimit.ts';
import { deleteSession, getSession, insertSession, type Session } from '../repo.ts';

export const SESSION_COOKIE = '__Host-hub_session';
const SESSION_TTL_S = 7 * 24 * 3600;
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type AdminEnv = { Variables: { session: Session | null; viaToken: boolean } };

// API token (automation): header authentication, without cookie, Origin or CSRF.
export function tokenMiddleware(cfg: Config, limiter: RateLimiter): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      c.set('viaToken', false);
      return next();
    }
    if (!cfg.apiTokenHash) throw new HttpError(401, 'token_disabled');
    const client = clientIp(c);
    if (limiter.isBlocked('token', client)) throw new HttpError(429, 'too_many_attempts');
    if (!safeEqual(sha256(header.slice(7)), cfg.apiTokenHash)) {
      limiter.recordFailure('token', client);
      throw new HttpError(401, 'token_invalid');
    }
    c.set('viaToken', true);
    await next();
  };
}

export function originGuard(cfg: Config): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (c.get('viaToken')) return next();
    if (MUTATIONS.has(c.req.method) && !hubOrigins(cfg).includes(c.req.header('origin') ?? '')) {
      throw new HttpError(403, 'origin_refused');
    }
    await next();
  };
}

export function sessionMiddleware(db: Db): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    const raw = getCookie(c, SESSION_COOKIE);
    c.set('session', raw ? (getSession(db, sha256(raw)) ?? null) : null);
    await next();
  };
}

export const requireSession: MiddlewareHandler<AdminEnv> = async (c, next) => {
  if (c.get('viaToken')) return next();
  if (!c.get('session')) throw new HttpError(401, 'session_required');
  await next();
};

export const csrfGuard: MiddlewareHandler<AdminEnv> = async (c, next) => {
  if (c.get('viaToken')) return next();
  const session = c.get('session');
  if (MUTATIONS.has(c.req.method) && !(session && safeEqual(c.req.header('x-csrf-token') ?? '', session.csrf_token))) {
    throw new HttpError(403, 'csrf_invalid');
  }
  await next();
};

export function startSession(c: Context, db: Db, nowMs: number): string {
  const raw = randomToken();
  const csrfToken = randomToken();
  insertSession(db, { id_hash: sha256(raw), csrf_token: csrfToken, expires_at: new Date(nowMs + SESSION_TTL_S * 1000).toISOString() });
  setCookie(c, SESSION_COOKIE, raw, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL_S });
  return csrfToken;
}

export function endSession(c: Context<AdminEnv>, db: Db): void {
  const session = c.get('session');
  if (session) deleteSession(db, session.id_hash);
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}
