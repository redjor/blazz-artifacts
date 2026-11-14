import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.ts';
import { sha256, verifySecret, type Keys } from '../crypto.ts';
import type { Db } from '../db.ts';
import { registerFavicon } from '../favicon.ts';
import { clientIp } from '../http.ts';
import { pickLocale, tr, type Locale } from '../i18n.ts';
import type { RateLimiter } from '../ratelimit.ts';
import {
  getArtifact, getArtifactBySlug, getLinkByHash, getProject, getVersion, listFolderArtifacts, type Artifact, type Project, type ShareLink, type Version,
} from '../repo.ts';
import { thumbPath, versionDir } from '../storage.ts';
import { THUMB_MIME } from '../thumbs.ts';
import { createVisitRecorder, isBot } from '../visits.ts';
import { checkFolderPreview, checkFolderThumb, decodeFolderGrant, encodeFolderGrant, effectiveFolderAccess, folderCookieName, signFolderThumb } from './folder-grant.ts';
import { ancestors, children } from '../folder-tree.ts';
import { renderFolderPage } from './folder-page.ts';
import { decodeGrant, encodeGrant, GRANT_TTL_S, grantCookieName, isGrantValid } from './grant.ts';
import { PDF_CSP, SANDBOX_SCRIPTS, SANDBOX_STATIC } from './headers.ts';
import { injectShim } from './shim.ts';
import { contentTypeFor } from './mime.ts';
import { folderUnlockPage, notFoundPage, unlockPage } from './pages.ts';
import { artifactUrl, encodePath, parseArtifactPath, sanitizeRest } from './paths.ts';
import { checkPathSig, checkPinnedPathSig, isPinnedSig, signPath } from './signing.ts';

const SHIM_MAX_BYTES = 2 * 1024 * 1024;

export interface ContentDeps { db: Db; cfg: Config; keys: Keys; codeLimiter: RateLimiter; now?: () => number }

// Public content server. Imports no admin route, by construction.
export function createContentApp(deps: ContentDeps): Hono {
  const { db, cfg, keys, codeLimiter } = deps;
  const nowMs = () => (deps.now ?? Date.now)();
  const nowS = () => Math.floor(nowMs() / 1000);
  const app = new Hono();
  const visits = createVisitRecorder(db, cfg.hubSecret);
  // Language of the visitor pages: HUB_LOCALE, or the visitor's Accept-Language with HUB_LOCALE=auto.
  const loc = (c: Context): Locale => pickLocale(cfg.locale, c.req.header('accept-language'));

  // A person opening the page: navigation GET (not HEAD, not fetch/script), a browser (not a bot or link preview).
  const isHumanNavigation = (c: Context) => {
    const dest = c.req.header('sec-fetch-dest');
    return c.req.method === 'GET' && (dest === undefined || dest === 'document') && !isBot(c.req.header('user-agent'));
  };

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('X-Frame-Options', 'DENY');
    // Only served files (200) set their own cache; nothing else may ever be cached.
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store');
    if (!c.res.headers.has('Content-Security-Policy')) c.res.headers.set('Content-Security-Policy', SANDBOX_STATIC);
  });

  registerFavicon(app);

  const notFound = (c: Context) => c.html(notFoundPage(loc(c)), 404);

  function setGrant(c: Context, art: Artifact, linkId: string | null, expS: number) {
    const now = nowS();
    setCookie(c, grantCookieName(art.id), encodeGrant(keys.grant, { a: art.id, e: art.access_epoch, l: linkId, x: expS }), {
      httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.max(expS - now, 0),
    });
  }

  async function serveFile(c: Context, art: Artifact, version: Version | undefined, rest: string) {
    if (!version || version.artifact_id !== art.id) return notFound(c);
    const kind = version.kind ?? art.kind;
    const rel = rest || version.entry_path;
    const root = resolve(versionDir(cfg.dataDir, art.id, version.id));
    const full = resolve(root, rel);
    if (!full.startsWith(root + sep)) return notFound(c);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return notFound(c);
    const { type, attachment } = contentTypeFor(rel);
    const csp = type === 'application/pdf' ? PDF_CSP : kind === 'markdown' || kind === 'json' ? SANDBOX_STATIC : SANDBOX_SCRIPTS;
    const headers = new Headers({
      'Content-Type': type,
      'Content-Length': String(info.size),
      'Cache-Control': 'private, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Content-Security-Policy': csp,
    });
    if (attachment) headers.set('Content-Disposition', 'attachment');
    // Simulated storage: only HTML pages of an html/site artifact, up to 2 MiB.
    if (art.memory_storage === 1 && (kind === 'html' || kind === 'site') && type.startsWith('text/html') && info.size <= SHIM_MAX_BYTES) {
      const body = Buffer.from(injectShim(await readFile(full, 'utf8')), 'utf8');
      headers.set('Content-Length', String(body.length));
      return new Response(body, { status: 200, headers });
    }
    return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, { status: 200, headers });
  }

  // CORS on redirects too: a module import from an open page survives expiry.
  function redirect(c: Context, to: string) {
    c.header('Access-Control-Allow-Origin', '*');
    return c.redirect(to, 302);
  }

  app.get('/a/*', async (c) => {
    const parsed = parseArtifactPath(new URL(c.req.url).pathname);
    if (!parsed) return notFound(c);
    const art = getArtifactBySlug(db, parsed.slug);
    if (!art?.current_version_id) return notFound(c);

    if (parsed.sig) {
      if (isPinnedSig(parsed.sig)) {
        const pin = checkPinnedPathSig(keys.pathSig, art, parsed.sig, nowS());
        if (pin.result === 'forged') return notFound(c);
        if (pin.result === 'stale') return redirect(c, artifactUrl(art.slug, parsed.rest));
        return serveFile(c, art, getVersion(db, pin.versionId), parsed.rest);
      }
      const check = checkPathSig(keys.pathSig, art, parsed.sig, nowS());
      if (check === 'forged') return notFound(c);
      if (check === 'stale') return redirect(c, artifactUrl(art.slug, parsed.rest));
      return serveFile(c, art, getVersion(db, art.current_version_id), parsed.rest);
    }

    if (art.visibility === 'private') return notFound(c);
    if (art.visibility !== 'public') {
      const claims = decodeGrant(keys.grant, getCookie(c, grantCookieName(art.id)));
      if (!isGrantValid(db, art, claims, nowS())) {
        if (art.visibility === 'code') return c.html(unlockPage({ slug: art.slug, title: art.title, next: parsed.rest }, loc(c)), 401);
        return notFound(c);
      }
    }
    const version = getVersion(db, art.current_version_id);
    if (!version) return notFound(c);
    // A view = entry through the unsigned path. Signed paths (admin previews, files, inner pages) never come here.
    if ((parsed.rest === '' || parsed.rest === version.entry_path) && isHumanNavigation(c)) {
      visits.view(art.id, clientIp(c), c.req.header('user-agent') ?? '', nowMs());
    }
    const sig = signPath(keys.pathSig, { artifactId: art.id, versionId: version.id, epoch: art.access_epoch }, nowS());
    return redirect(c, `/a/${art.slug}/${sig}/${encodePath(parsed.rest || version.entry_path)}`);
  });

  app.post('/unlock/:slug', bodyLimit({ maxSize: 4096, onError: (c) => c.text(tr(loc(c), 'request.tooLarge'), 413) }), async (c) => {
    const art = getArtifactBySlug(db, c.req.param('slug'));
    if (!art?.current_version_id || art.visibility !== 'code' || !art.code_hash) return notFound(c);
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      return c.text(tr(loc(c), 'request.invalid'), 400);
    }
    const code = typeof form.code === 'string' ? form.code : '';
    const next = sanitizeRest(typeof form.next === 'string' ? form.next : '');
    const scope = `code:${art.id}`;
    const client = clientIp(c);
    if (codeLimiter.isBlocked(scope, client)) {
      return c.html(unlockPage({ slug: art.slug, title: art.title, next, error: tr(loc(c), 'unlock.tooMany') }, loc(c)), 429);
    }
    // Attempt reserved before the asynchronous check, otherwise parallel requests bypass the limit.
    codeLimiter.recordFailure(scope, client);
    if (!(await verifySecret(code, art.code_hash))) {
      return c.html(unlockPage({ slug: art.slug, title: art.title, next, error: tr(loc(c), 'unlock.wrong') }, loc(c)), 401);
    }
    codeLimiter.forgive(scope, client);
    setGrant(c, art, null, nowS() + GRANT_TTL_S);
    return c.redirect(artifactUrl(art.slug, next), 303);
  });

  app.get('/share/:token', (c) => {
    const token = c.req.param('token');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return notFound(c);
    const link = getLinkByHash(db, sha256(token));
    const now = nowS();
    if (!link || link.revoked_at || (link.expires_at && Date.parse(link.expires_at) <= now * 1000)) return notFound(c);
    if (link.project_name !== null) return shareFolder(c, link, link.project_name, now);
    if (link.artifact_id === null) return notFound(c);
    const art = getArtifact(db, link.artifact_id);
    if (!art?.current_version_id || art.visibility !== 'link') return notFound(c);
    if (isHumanNavigation(c)) visits.linkOpen(link.id, nowMs());
    const linkExp = link.expires_at ? Math.floor(Date.parse(link.expires_at) / 1000) : Infinity;
    setGrant(c, art, link.id, Math.min(now + GRANT_TTL_S, linkExp));
    return c.redirect(artifactUrl(art.slug), 302);
  });

  // ——— Folders: /d/<project>. Folder access opens its artifacts through /d/<project>/a/<slug> only;
  // it never changes an artifact's own access (/a/<slug> stays governed by its visibility).

  const PROJECT_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
  const folderOf = (name: string): Project | undefined => (PROJECT_RE.test(name) ? getProject(db, name) : undefined);
  const chainOf = (p: Project): Project[] => [p, ...ancestors(db, p.name)];
  /** Granting folder (the folder itself or an ancestor), or null. */
  const folderAccess = (c: Context, project: Project | undefined): Project | null =>
    project
      ? effectiveFolderAccess(db, chainOf(project), (n) => decodeFolderGrant(keys.folderGrant, getCookie(c, folderCookieName(n))), nowS())
      : null;
  // Without access: unlock form for a “code” folder, 404 for everything else (private, link, missing).
  const denyFolder = (c: Context, project: Project | undefined) =>
    project?.visibility === 'code' && project.code_hash
      ? c.html(folderUnlockPage({ name: project.name, title: project.title?.trim() || project.name }, loc(c)), 401)
      : notFound(c);

  function setFolderGrant(c: Context, project: Project, linkId: string | null, expS: number) {
    const claims = { p: project.name, s: project.salt, e: project.access_epoch, l: linkId, x: expS };
    setCookie(c, folderCookieName(project.name), encodeFolderGrant(keys.folderGrant, claims), {
      httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.max(expS - nowS(), 0),
    });
  }

  function shareFolder(c: Context, link: ShareLink, name: string, now: number) {
    const project = getProject(db, name);
    if (!project || project.visibility !== 'link') return notFound(c);
    if (isHumanNavigation(c)) visits.linkOpen(link.id, nowMs());
    const linkExp = link.expires_at ? Math.floor(Date.parse(link.expires_at) / 1000) : Infinity;
    setFolderGrant(c, project, link.id, Math.min(now + GRANT_TTL_S, linkExp));
    return c.redirect(`/d/${project.name}`, 302);
  }

  const folderPage = (c: Context) => {
    const name = c.req.param('project') ?? '';
    const previewSig = c.req.query('preview');
    // Admin preview: signed (sheet created by the API before signing), whatever the visibility, no cookie, not counted.
    if (previewSig !== undefined) {
      const sheet = folderOf(name);
      if (!sheet || !checkFolderPreview(keys.folderPreview, sheet, previewSig, nowS())) return notFound(c);
      return c.html(renderFolder(sheet, previewSig, loc(c), null));
    }
    const project = folderOf(name);
    const granting = folderAccess(c, project);
    if (!granting) return denyFolder(c, project);
    if (isHumanNavigation(c)) visits.folderView(project!.name, clientIp(c), c.req.header('user-agent') ?? '', nowMs());
    return c.html(renderFolder(project!, null, loc(c), granting));
  };

  /** `preview`: admin preview signature (cards to signed paths, thumbnails allowed by this signature). */
  function renderFolder(p: Project, preview: string | null, locale: Locale, granting: Project | null): string {
    const now = nowS();
    const cards = listFolderArtifacts(db, p.name).flatMap((a) => {
      const v = a.current_version_id ? getVersion(db, a.current_version_id) : undefined;
      if (!v) return [];
      const g = granting ?? p;
      const thumbQuery = preview
        ? `p=${preview}`
        : `${g.name === p.name ? '' : `g=${g.name}&`}s=${signFolderThumb(keys.folderThumb, g, p.name, a.id, v.id, now)}`;
      const thumbUrl = v.thumb_type ? `/d/${p.name}/thumb/${a.id}/${v.id}?${thumbQuery}` : null;
      // Preview: direct signed path (like an artifact admin preview); otherwise entry through the folder, which re-checks everything.
      const href = preview
        ? `/a/${a.slug}/${signPath(keys.pathSig, { artifactId: a.id, versionId: v.id, epoch: a.access_epoch }, now)}/${encodePath(v.entry_path)}`
        : `/d/${p.name}/a/${encodePath(a.slug)}`;
      return [{ href, title: a.title, kind: v.kind ?? a.kind, updatedAt: a.updated_at, versionNumber: v.number, thumbUrl }];
    });
    const folders = children(db, p.name).map((ch) => ({
      href: preview ? null : `/d/${ch.name}`,
      title: ch.title?.trim() || ch.name,
      description: ch.description,
      count: listFolderArtifacts(db, ch.name).length,
      childCount: children(db, ch.name).length,
      updatedAt: ch.updated_at,
    }));
    // Ancestors from the granting folder down to the parent; nothing above it (design 03: no leak).
    const chain = chainOf(p);
    const top = granting ? chain.findIndex((x) => x.name === granting.name) : 0;
    const breadcrumb = preview ? [] : chain.slice(1, top + 1).reverse().map((a) => ({ href: `/d/${a.name}`, title: a.title?.trim() || a.name }));
    return renderFolderPage({
      name: p.name, title: p.title, description: p.description, cards, nowMs: nowMs(), folders, breadcrumb,
      preview: preview ? { visibility: p.visibility } : null,
    }, locale);
  }
  app.get('/d/:project', folderPage);
  app.get('/d/:project/', folderPage);

  // Artifact entry through the folder: folder access, then current membership, then the usual signed path.
  app.get('/d/:project/a/:slug', (c) => {
    const project = folderOf(c.req.param('project'));
    if (!folderAccess(c, project)) return denyFolder(c, project);
    const art = getArtifactBySlug(db, c.req.param('slug'));
    if (!art?.current_version_id || art.project !== project!.name) return notFound(c);
    const version = getVersion(db, art.current_version_id);
    if (!version) return notFound(c);
    // Counts as a view of the artifact; the signed redirect that follows never counts.
    if (isHumanNavigation(c)) visits.view(art.id, clientIp(c), c.req.header('user-agent') ?? '', nowMs());
    const sig = signPath(keys.pathSig, { artifactId: art.id, versionId: version.id, epoch: art.access_epoch }, nowS());
    return redirect(c, `/a/${art.slug}/${sig}/${encodePath(version.entry_path)}`);
  });

  // Card thumbnail: folder access (cookie, public) or a signed URL issued by the page, AND current membership,
  // AND current version. The only content server route serving a thumbnail.
  app.get('/d/:project/thumb/:artifactId/:versionId', async (c) => {
    const project = folderOf(c.req.param('project'));
    if (!project) return notFound(c);
    const artifactId = c.req.param('artifactId');
    const versionId = c.req.param('versionId');
    const g = c.req.query('g');
    const granting = g === undefined ? project : chainOf(project).find((x) => x.name === g);
    const allowed =
      checkFolderPreview(keys.folderPreview, project, c.req.query('p'), nowS()) ||
      (!!granting && checkFolderThumb(keys.folderThumb, granting, project.name, artifactId, versionId, c.req.query('s'), nowS())) ||
      !!folderAccess(c, project);
    if (!allowed) return notFound(c);
    const art = getArtifact(db, artifactId);
    if (!art || art.project !== project.name || art.current_version_id !== versionId) return notFound(c);
    const v = getVersion(db, versionId);
    if (!v?.thumb_type || v.artifact_id !== art.id) return notFound(c);
    let data: Buffer;
    try {
      data = await readFile(thumbPath(cfg.dataDir, art.id, v.id, v.thumb_type));
    } catch {
      return notFound(c);
    }
    return c.body(new Uint8Array(data), 200, { 'Content-Type': THUMB_MIME[v.thumb_type], 'Cache-Control': 'private, max-age=3600' });
  });

  app.post('/unlock-folder/:project', bodyLimit({ maxSize: 4096, onError: (c) => c.text(tr(loc(c), 'request.tooLarge'), 413) }), async (c) => {
    const project = folderOf(c.req.param('project'));
    if (!project || project.visibility !== 'code' || !project.code_hash) return notFound(c);
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      return c.text(tr(loc(c), 'request.invalid'), 400);
    }
    const code = typeof form.code === 'string' ? form.code : '';
    const title = project.title?.trim() || project.name;
    // Same policy as artifacts, distinct scope: 5 attempts / 15 min per IP, 20 / h for the folder.
    const scope = `folder-code:${project.name}`;
    const client = clientIp(c);
    if (codeLimiter.isBlocked(scope, client)) {
      return c.html(folderUnlockPage({ name: project.name, title, error: tr(loc(c), 'unlock.tooMany') }, loc(c)), 429);
    }
    // Attempt reserved before the asynchronous check, otherwise parallel requests bypass the limit.
    codeLimiter.recordFailure(scope, client);
    if (!(await verifySecret(code, project.code_hash))) {
      return c.html(folderUnlockPage({ name: project.name, title, error: tr(loc(c), 'unlock.wrong') }, loc(c)), 401);
    }
    codeLimiter.forgive(scope, client);
    setFolderGrant(c, project, null, nowS() + GRANT_TTL_S);
    return c.redirect(`/d/${project.name}`, 303);
  });

  app.notFound(notFound);
  app.onError((err, c) => {
    console.error('[content]', err);
    return c.text(tr(loc(c), 'error.internal'), 500);
  });
  return app;
}
