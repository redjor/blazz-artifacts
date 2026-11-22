import { fontFile } from '../fonts.ts';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config.ts';
import { verifySecret, type Keys } from '../crypto.ts';
import type { Db } from '../db.ts';
import { registerFavicon } from '../favicon.ts';
import { clientIp, errorBody, HttpError } from '../http.ts';
import type { RateLimiter } from '../ratelimit.ts';
import { createKeyRoutes, initializeApiKeys } from './api-keys.ts';
import { registerMcp } from './mcp.ts';
import { createApiRoutes } from './api.ts';
import { csrfGuard, endSession, originGuard, requireSession, sessionMiddleware, startSession, tokenMiddleware, scopeGuard, type AdminEnv } from './auth.ts';
import { serveSpa } from './spa.ts';

/** Strict CSP; frames from the content origin and sandboxed, authenticated theme previews on this origin. */
export const adminCsp = (contentOrigin: string) =>
  `default-src 'self'; img-src 'self' data:; style-src 'self'; frame-src 'self' ${contentOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

export interface AdminDeps { db: Db; cfg: Config; keys: Keys; loginLimiter: RateLimiter; webDist?: string; now?: () => number }

// Admin server: keep it reachable only from a private network (VPN, tailnet, allow-list).
export function createAdminApp(deps: AdminDeps): Hono<AdminEnv> {
  const { db, cfg, loginLimiter } = deps;
  const nowMs = () => (deps.now ?? Date.now)();
  initializeApiKeys(db);
  const app = new Hono<AdminEnv>();
  const csp = adminCsp(new URL(cfg.publicContentUrl).origin);

  app.use('*', async (c, next) => {
    await next();
    const themePreview = /^\/api\/themes\/preview\/[A-Za-z0-9_-]+$/.test(c.req.path);
    c.res.headers.set('Content-Security-Policy', themePreview ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self' data:; sandbox; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" : csp);
    if (/^\/api\/artifacts\/[^/]+(?:\/versions\/[^/]+)?\/thumbnail$/.test(c.req.path) && c.res.headers.get('Content-Type') === 'image/svg+xml') {
      // Generated SVG excerpts embed only validated raster logos and local font bytes.
      c.res.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox; frame-ancestors 'none'; base-uri 'none'");
    }
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'same-origin');
    c.res.headers.set('X-Frame-Options', themePreview ? 'SAMEORIGIN' : 'DENY');
  });

  registerFavicon(app);
  app.get('/_fonts/:file', c => {
    const data = fontFile(c.req.param('file'));
    if (!data) throw new HttpError(404, 'unknown_route');
    return c.body(new Uint8Array(data), 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' });
  });

  app.use('/api/*', tokenMiddleware(cfg, loginLimiter, db, nowMs), originGuard(cfg), sessionMiddleware(db));

  app.get('/api/session', (c) => {
    const session = c.get('session');
    return c.json({ authenticated: !!session, csrfToken: session?.csrf_token ?? null, viaToken: c.get('viaToken') });
  });

  // The API token never gives access to session management.
  const noToken: MiddlewareHandler<AdminEnv> = async (c, next) => {
    if (c.get('viaToken')) throw new HttpError(403, 'token_not_allowed');
    await next();
  };

  app.post('/api/login', noToken, bodyLimit({ maxSize: 4096, onError: (c) => c.json(errorBody('payload_too_large'), 413) }), async (c) => {
    const client = clientIp(c);
    if (loginLimiter.isBlocked('login', client)) throw new HttpError(429, 'too_many_attempts');
    // The failure is counted immediately (before any await) so concurrent requests cannot bypass the limit.
    loginLimiter.recordFailure('login', client);
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!cfg.adminPasswordHash || !(await verifySecret(password, cfg.adminPasswordHash))) {
      throw new HttpError(401, 'wrong_password');
    }
    loginLimiter.forgive('login', client);
    return c.json({ csrfToken: startSession(c, db, nowMs()) });
  });

  app.use('/api/*', requireSession, csrfGuard);

  app.post('/api/logout', noToken, (c) => {
    endSession(c, db);
    return c.json({ ok: true });
  });

  app.route('/api/keys', createKeyRoutes(db, nowMs));
  app.use('/api/*', scopeGuard);
  app.route('/api', createApiRoutes(deps));
  app.all('/api/*', () => {
    throw new HttpError(404, 'unknown_route');
  });

  registerMcp(app, { db, cfg, loginLimiter, now: nowMs });

  if (deps.webDist) {
    const dist = deps.webDist;
    app.get('*', (c) => serveSpa(c, dist));
  }

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.params), err.status);
    console.error('[admin]', err);
    return c.json(errorBody('internal'), 500);
  });
  return app;
}
