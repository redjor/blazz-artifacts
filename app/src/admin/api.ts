import { googleFontCatalog, prepareGoogleFont } from '../google-fonts.ts';
import { themeDto } from '../themes.ts';
import { renderThemeThumbnail, thumbnailTheme } from '../theme-thumbnail.ts';
import { join } from 'node:path';
import { bodyLimit } from 'hono/body-limit';
import { deleteTheme, getTheme, listThemes, parseTheme, parseThemeId, resolveTheme, saveTheme } from '../themes.ts';
import { readFile, rm } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import type { Config } from '../config.ts';
import { encodePath } from '../content/paths.ts';
import { signFolderPreview } from '../content/folder-grant.ts';
import { signPath, signPinnedPath } from '../content/signing.ts';
import { decrypt, encrypt, hashSecret, randomToken, sha256, type Keys } from '../crypto.ts';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import type { ErrorCode } from '../errors.ts';
import { ancestors, canReparent, children, setChildrenOrder, setParent } from '../folder-tree.ts';
import { staticLocale } from '../i18n.ts';
import { newId } from '../ids.ts';
import { ingestFile, renderSourcePage, stripExtension, type UploadedFile } from '../ingest/ingest.ts';
import {
  activateVersion, bumpEpoch, bumpProjectEpoch, deleteArtifact, deleteProject, getArtifact, getArtifactBySlug, getProject, getTrashedArtifact, getVersion, insertArtifactWithVersion,
  listFolderArtifacts, listFolderLinks, listFolders, listVersions, projectExists, recentProjectArtifacts, renameProject, restoreVersion, revokeFolderLink, setVersionMessage, setProjectOrder,
  setVersionThumb, getTags, insertLink, listArtifacts, listLinks, listTagCounts, listTrash, restoreArtifact, revokeLink, setPinned, setTags, slugHolder, trashArtifact,
  updateArtifact, upsertProject, VISIBILITIES, type Artifact, type ArtifactPatch, type TrashedArtifact, type Project, type ProjectPatch, type ShareLink, type Version, type Visibility,
} from '../repo.ts';
import { MAX_TAGS, normalizeLabel, normalizeTags } from '../labels.ts';
import { tx } from '../db.ts';
import { isValidSlug, slugify } from '../slug.ts';
import { pruneVersions, removeArtifactFiles, thumbPath, THUMB_TYPES, tmpRoot, versionDir } from '../storage.ts';
import { createKeyedLock, placeThumb, receiveThumb, THUMB_MIME } from '../thumbs.ts';
import { indexArtifact, indexFields, indexMissing, searchArtifacts } from '../search.ts';
import { deleteForGood } from '../trash.ts';
import { receiveUpload } from '../upload.ts';
import { folderVisitStats, viewTotals, visitStats } from '../visits.ts';
import type { AdminEnv } from './auth.ts';
import { createPreviewCache } from '../preview.ts';

export interface ApiDeps { db: Db; cfg: Config; keys: Keys; now?: () => number }

/** Bulk actions (design 05): at most this many artifacts per request. */
const BULK_MAX = 500;
const BULK_OPS = ['move', 'addTags', 'removeTags', 'visibility', 'pin', 'unpin', 'trash', 'restore'] as const;
type BulkOp = (typeof BULK_OPS)[number];

function parseVisibility(v: unknown): Visibility {
  if (typeof v === 'string' && (VISIBILITIES as readonly string[]).includes(v)) return v as Visibility;
  throw new HttpError(400, 'invalid_visibility');
}

function parseTitle(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < 1 || t.length > 120) throw new HttpError(400, 'invalid_title');
  return t;
}

function parseLabel(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
}

// Share link duration in hours: 1 h to 1 year.
function parseHours(v: unknown): number {
  if (v === undefined) return 168;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 8760) throw new HttpError(400, 'invalid_hours');
  return v;
}

// Statistics window in days: 1 to 365, 30 by default.
function parseDays(v: string | undefined): number {
  if (v === undefined) return 30;
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'invalid_days');
  return n;
}

function parseCode(v: unknown): string {
  if (typeof v !== 'string' || v.length < 6 || v.length > 128) throw new HttpError(400, 'invalid_code');
  return v;
}

function parseProject(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_project');
  if (v.trim() === '') return null;
  const p = normalizeLabel(v);
  if (!p) throw new HttpError(400, 'invalid_project');
  return p;
}

/** Folder and artifact descriptions (design 12): plain text, at most this many characters. */
const DESCRIPTION_MAX = 1000;
/** Version note (design 16): one line. */
const VERSION_MESSAGE_MAX = 200;

/** Version note: optional plain text, trimmed, line breaks folded; empty or null clears. */
function parseVersionMessage(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_version_message');
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > VERSION_MESSAGE_MAX) throw new HttpError(400, 'version_message_too_long', { max: VERSION_MESSAGE_MAX });
  return t || null;
}

// Folder title, folder and artifact descriptions: optional; empty or null clears.
function parseOptionalText(v: unknown, max: number, what: 'title' | 'description'): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, what === 'title' ? 'invalid_folder_title' : 'invalid_description');
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, what === 'title' ? 'folder_title_too_long' : 'description_too_long', { max });
  return t || null;
}

// Folder name in the URL: already a normalised label, otherwise the folder does not exist.
const isFolderName = (name: string) => normalizeLabel(name) === name;

function parseExpiresAt(v: unknown, nowMs: number): string | null {
  if (v === undefined || v === null) return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || t <= nowMs) throw new HttpError(400, 'expiry_in_past');
  return new Date(t).toISOString();
}

function parseTags(list: unknown): string[] {
  if (!Array.isArray(list) || list.some((t) => typeof t !== 'string')) throw new HttpError(400, 'invalid_tags_type');
  const tags = normalizeTags(list as string[]);
  if (!tags) throw new HttpError(400, 'invalid_tags');
  return tags;
}

export function createApiRoutes(deps: ApiDeps): Hono<AdminEnv> {
  const { db, cfg, keys } = deps;
  const nowMs = () => (deps.now ?? Date.now)();
  const limits = { maxFiles: cfg.zipMaxFiles, maxBytes: cfg.zipMaxBytes };
  const api = new Hono<AdminEnv>();
  const previewOf = createPreviewCache(cfg.dataDir);
  // Full-text search (design 07): artifacts published before it existed are indexed once.
  indexMissing(db, cfg.dataDir);
  const thumbLock = createKeyedLock();

  const mustGet = (id: string): Artifact => {
    const art = getArtifact(db, id);
    if (!art) throw new HttpError(404, 'artifact_not_found');
    return art;
  };

  // A slug held by another artifact, in the trash included (restoring it must keep its URL).
  const slugConflict = (slug: string, selfId?: string): HttpError | null => {
    const holder = slugHolder(db, slug);
    if (!holder || holder.id === selfId) return null;
    return new HttpError(409, holder.trashed ? 'slug_in_trash' : 'slug_taken');
  };
  const assertSlugFree = (slug: string, selfId?: string) => {
    if (!isValidSlug(slug)) throw new HttpError(400, 'invalid_slug');
    const conflict = slugConflict(slug, selfId);
    if (conflict) throw conflict;
  };

  const isActive = (l: ShareLink) => !l.revoked_at && (!l.expires_at || Date.parse(l.expires_at) > nowMs());

  // Secret changed: the token can no longer be read, but the link can still be revoked.
  const linkUrl = (l: ShareLink): string | null => {
    try {
      return `${cfg.publicContentUrl}/share/${decrypt(keys.linkEnc, l.token_enc)}`;
    } catch {
      return null;
    }
  };
  const linkDto = (l: ShareLink) => ({
    id: l.id, label: l.label, url: linkUrl(l),
    expiresAt: l.expires_at, revokedAt: l.revoked_at, lastUsedAt: l.last_used_at, createdAt: l.created_at,
    active: isActive(l), openCount: l.open_count,
  });

  // Most recent link still usable (not revoked, not expired, readable); only “link” artifacts serve /share/.
  const activeLinkUrl = (art: Artifact): string | null => {
    if (art.visibility !== 'link') return null;
    for (const l of listLinks(db, art.id)) {
      if (l.revoked_at || (l.expires_at && Date.parse(l.expires_at) <= nowMs())) continue;
      const url = linkUrl(l);
      if (url) return url;
    }
    return null;
  };

  // Thumbnail cache token: version + upload date (a regenerated thumbnail changes URL and ETag).
  const thumbStamp = (v: Version) => `${v.id}.${Date.parse(v.thumb_at ?? '').toString(36)}`;
  const enc = encodeURIComponent;
  const thumbnailUrl = (artifactId: string, v: Version | undefined, pinned = false) =>
    v && (v.thumb_type || thumbnailTheme(v)) ? `/api/artifacts/${enc(artifactId)}${pinned ? `/versions/${enc(v.id)}` : ''}/thumbnail?v=${v.thumb_type ? thumbStamp(v) : `${v.id}.theme1`}` : null;

  const artifactDto = (art: Artifact) => {
    const v = art.current_version_id ? getVersion(db, art.current_version_id) : undefined;
    return {
      id: art.id, slug: art.slug, title: art.title, description: art.description, kind: art.kind, visibility: art.visibility,
      hasCode: !!art.code_hash, memoryStorage: art.memory_storage === 1, createdAt: art.created_at, updatedAt: art.updated_at,
      project: art.project, themeId: art.theme_id, effectiveThemeId: resolveTheme(db, art.theme_id, art.project)?.id ?? null, tags: getTags(db, art.id),
      // Visibility of the project's folder (“shared through the folder” when not private); null without a project.
      folderVisibility: art.project === null ? null : (getProject(db, art.project)?.visibility ?? 'private'),
      url: `${cfg.publicContentUrl}/a/${art.slug}`, activeLinkUrl: activeLinkUrl(art),
      pinned: art.pinned_at !== null, pinnedAt: art.pinned_at, views: viewTotals(db, art.id, nowMs()),
      version: v ? { id: v.id, number: v.number, message: v.message, originalName: v.original_name, sizeBytes: v.size_bytes, fileCount: v.file_count, createdAt: v.created_at } : null,
      preview: previewOf(art.id, art.kind, v),
      thumbnailUrl: thumbnailUrl(art.id, v),
    };
  };

  // Image served as is from the admin origin (img-src 'self'); never by the content server.
  const serveThumb = async (c: Context, art: Artifact, v: Version | undefined) => {
    if (!v || v.artifact_id !== art.id) throw new HttpError(404, 'no_thumbnail');
    if (!v.thumb_type) {
      const theme = thumbnailTheme(v);
      if (!theme) throw new HttpError(404, 'no_thumbnail');
      const etag = `"${v.id}.theme1"`;
      const headers = { 'Cache-Control': 'private, max-age=86400', ETag: etag, 'Content-Type': 'image/svg+xml' };
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
      return c.body(renderThemeThumbnail(theme, previewOf(art.id, 'markdown', v), stripExtension(v.original_name)), 200, headers);
    }
    const etag = `"${thumbStamp(v)}"`;
    const headers = { 'Cache-Control': 'private, max-age=86400', ETag: etag };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    let data: Buffer;
    try {
      data = await readFile(thumbPath(cfg.dataDir, art.id, v.id, v.thumb_type));
    } catch {
      throw new HttpError(404, 'no_thumbnail');
    }
    return c.body(new Uint8Array(data), 200, { ...headers, 'Content-Type': THUMB_MIME[v.thumb_type] });
  };


  const newLink = (artifactId: string, label: string | null, expiresAt: string | null): ShareLink => {
    const token = randomToken();
    return insertLink(db, { id: newId(), artifact_id: artifactId, token_hash: sha256(token), token_enc: encrypt(keys.linkEnc, token), label, expires_at: expiresAt });
  };
  const newFolderLink = (name: string, label: string | null, expiresAt: string | null): ShareLink => {
    const token = randomToken();
    return insertLink(db, { id: newId(), project_name: name, token_hash: sha256(token), token_enc: encrypt(keys.linkEnc, token), label, expires_at: expiresAt });
  };

  async function withUpload<T>(c: Context, fn: (fields: Record<string, string>, file: UploadedFile) => Promise<T>): Promise<T> {
    const up = await receiveUpload(c.req.raw, tmpRoot(cfg.dataDir), cfg.maxUploadBytes);
    try {
      if (!up.file) throw new HttpError(400, 'file_missing');
      return await fn(up.fields, up.file);
    } finally {
      if (up.file) await rm(up.file.tmpPath, { force: true });
    }
  }

  api.get('/artifacts', (c) => {
    const slug = c.req.query('slug');
    let list: Artifact[];
    if (slug === undefined) {
      const project = c.req.query('project');
      list = listArtifacts(db, {
        project: project === undefined ? undefined : project === '' ? null : parseProject(project),
        tags: parseTags(c.req.queries('tag') ?? []),
      });
    } else {
      list = [getArtifactBySlug(db, slug)].filter((a): a is Artifact => !!a);
    }
    return c.json(list.map(artifactDto));
  });

  api.get('/tags', (c) => c.json(listTagCounts(db)));

  type PreviewBinding = { artifactId: string; versionId: string; themeId: string | null; snapshot: string; title: string };
  const readThemeBody = async (c: Context): Promise<Record<string, unknown>> => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_theme');
    return body as Record<string, unknown>;
  };
  const themePreviews = new Map<string, { html: string; expires: number; binding?: PreviewBinding }>();
  const previewResponse = (html: string, binding?: PreviewBinding) => {
    for (const [id, item] of themePreviews) if (item.expires <= nowMs()) themePreviews.delete(id);
    while (themePreviews.size >= 20) themePreviews.delete(themePreviews.keys().next().value!);
    const id = randomToken(24);
    themePreviews.set(id, { html, expires: nowMs() + 600000, binding });
    return { url: `/api/themes/preview/${id}`, previewToken: id };
  };
  api.use('/themes/*', bodyLimit({ maxSize: 750000, onError: () => { throw new HttpError(413, 'payload_too_large'); } }));
  api.use('/themes', bodyLimit({ maxSize: 750000, onError: () => { throw new HttpError(413, 'payload_too_large'); } }));
  const prepareTheme = async (body: unknown) => { const theme = parseTheme(body); return { ...theme, fontData: await prepareGoogleFont(theme.font, cfg.dataDir) }; };
  api.get('/themes/fonts', c => c.json(googleFontCatalog));
  api.get('/themes', c => c.json(listThemes(db).map(themeDto)));
  api.post('/themes', async c => c.json(themeDto(saveTheme(db, { ...await prepareTheme(await readThemeBody(c)), id: newId() })), 201));
  api.put('/themes/:id', async c => {
    const id = c.req.param('id');
    if (!getTheme(db, id)) throw new HttpError(404, 'theme_not_found');
    return c.json(themeDto(saveTheme(db, { ...await prepareTheme(await readThemeBody(c)), id })));
  });
  api.delete('/themes/:id', c => { deleteTheme(db, c.req.param('id')); return c.json({ ok: true }); });
  api.post('/themes/preview', async c => {
    const theme = { ...await prepareTheme(await readThemeBody(c)), id: 'preview' };
    return c.json(previewResponse(renderSourcePage('markdown', '# Project overview\n\nA clear introduction to your document.\n\n## Objectives\n\n- Consistent client branding\n- Readable reports and documentation\n\n## Progress\n\n| Milestone | Status |\n| --- | --- |\n| Discovery | Complete |\n| Delivery | In progress |\n\n> A shared direction for the next stage.\n\nVisit [the project](https://example.com).', theme.name, staticLocale(cfg.locale), theme)));
  });
  api.get('/themes/preview/:token', c => {
    const item = themePreviews.get(c.req.param('token'));
    if (!item || item.expires <= nowMs()) throw new HttpError(404, 'no_content');
    c.header('Cache-Control', 'no-store');
    return c.html(item.html);
  });
  const themeActionLimit = bodyLimit({ maxSize: 4096, onError: () => { throw new HttpError(413, 'payload_too_large'); } });
  api.use('/artifacts/:id/theme-preview', themeActionLimit);
  api.use('/artifacts/:id/apply-theme', themeActionLimit);
  api.post('/artifacts/:id/theme-preview', async c => {
    const art = mustGet(c.req.param('id'));
    if (art.kind !== 'markdown') throw new HttpError(400, 'theme_markdown_only');
    const body = await readThemeBody(c);
    const themeId = parseThemeId(db, body.themeId);
    const theme = resolveTheme(db, themeId, art.project);
    const v = art.current_version_id ? getVersion(db, art.current_version_id) : null;
    if (!v) throw new HttpError(404, 'no_content');
    const source = await readFile(join(versionDir(cfg.dataDir, art.id, v.id), 'source.md'), 'utf8');
    return c.json(previewResponse(renderSourcePage('markdown', source, art.title, staticLocale(cfg.locale), theme), { artifactId: art.id, versionId: v.id, themeId, snapshot: JSON.stringify(theme), title: art.title }));
  });
  api.post('/artifacts/:id/apply-theme', async c => {
    const art = mustGet(c.req.param('id'));
    if (art.kind !== 'markdown') throw new HttpError(400, 'theme_markdown_only');
    const body = await readThemeBody(c);
    if (typeof body.versionId !== 'string' || body.versionId !== art.current_version_id) throw new HttpError(409, 'version_changed');
    const themeId = parseThemeId(db, body.themeId);
    const theme = resolveTheme(db, themeId, art.project);
    if (typeof body.previewToken !== 'string') throw new HttpError(409, 'version_changed');
    const preview = themePreviews.get(body.previewToken);
    const binding = preview?.binding;
    if (!preview || preview.expires <= nowMs() || !binding || binding.artifactId !== art.id || binding.versionId !== body.versionId || binding.themeId !== themeId || binding.snapshot !== JSON.stringify(theme) || binding.title !== art.title) throw new HttpError(409, 'version_changed');
    const v = getVersion(db, body.versionId)!;
    const versionId = newId(), dir = versionDir(cfg.dataDir, art.id, versionId);
    try {
      const r = await ingestFile({ tmpPath: join(versionDir(cfg.dataDir, art.id, v.id), 'source.md'), originalName: v.original_name, size: v.size_bytes }, dir, limits, staticLocale(cfg.locale), theme, art.title);
      const current = mustGet(art.id);
      if (current.current_version_id !== v.id || current.title !== art.title || JSON.stringify(resolveTheme(db, themeId, current.project)) !== binding.snapshot) throw new HttpError(409, 'version_changed');
      // No await between the compare and activation: both are synchronous SQLite writes.
      activateVersion(db, art.id, { id: versionId, entry_path: r.entryPath, original_name: v.original_name, size_bytes: r.sizeBytes, file_count: r.fileCount, theme_snapshot: theme ? JSON.stringify(theme) : null }, 'markdown', getTheme(db, themeId ?? '') ? themeId : null, () => indexArtifact(db, cfg.dataDir, mustGet(art.id)));
      themePreviews.delete(body.previewToken);
    } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
    await pruneVersions(db, cfg.dataDir, art.id);
    return c.json(artifactDto(mustGet(art.id)));
  });


  api.post('/artifacts', (c) =>
    withUpload(c, async (fields, file) => {
      const title = parseTitle(fields.title?.trim() || stripExtension(file.originalName));
      const slug = fields.slug?.trim() || slugify(file.originalName);
      assertSlugFree(slug);
      const visibility = parseVisibility(fields.visibility || 'private');
      const project = parseProject(fields.project);
      const tags = parseTags((fields.tags ?? '').split(',').filter((t) => t.trim() !== ''));
      const description = fields.description === undefined ? null : parseOptionalText(fields.description, DESCRIPTION_MAX, 'description');
      const message = parseVersionMessage(fields.message);
      const codeHash = visibility === 'code' ? await hashSecret(parseCode(fields.code)) : null;
      const id = newId();
      const versionId = newId();
      const dir = versionDir(cfg.dataDir, id, versionId);
      const theme = resolveTheme(db, null, project);
      const r = await ingestFile(file, dir, limits, staticLocale(cfg.locale), theme);
      try {
        const art = insertArtifactWithVersion(
          db,
          { id, slug, title, description, kind: r.kind, visibility, code_hash: codeHash, memory_storage: ['true', '1'].includes(fields.memoryStorage ?? '') ? 1 : 0, project, tags },
          { id: versionId, entry_path: r.entryPath, original_name: file.originalName, size_bytes: r.sizeBytes, file_count: r.fileCount, message, theme_snapshot: r.kind === 'markdown' && theme ? JSON.stringify(theme) : null },
        );
        indexArtifact(db, cfg.dataDir, art);
        return c.json(artifactDto(art), 201);
      } catch (e) {
        await removeArtifactFiles(cfg.dataDir, id);
        if (String(e).includes('UNIQUE')) throw slugConflict(slug) ?? new HttpError(409, 'slug_taken');
        throw e;
      }
    }),
  );

  api.get('/artifacts/:id', (c) => {
    const art = mustGet(c.req.param('id'));
    return c.json({ ...artifactDto(art), links: listLinks(db, art.id).map(linkDto) });
  });

  api.patch('/artifacts/:id', async (c) => {
    const art = mustGet(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new HttpError(400, 'invalid_boolean', { field: 'pinned' });
    const pinned = body.pinned as boolean | undefined;
    // Pinning alone is not a modification: neither updated_at nor the epoch.
    if (pinned !== undefined && Object.entries(body).every(([k, v]) => k === 'pinned' || v === undefined)) {
      return c.json(artifactDto(setPinned(db, art.id, pinned)));
    }
    const patch: ArtifactPatch = {};
    if (body.themeId !== undefined) patch.theme_id = parseThemeId(db, body.themeId);
    let bump = false;
    if (body.title !== undefined) patch.title = parseTitle(body.title);
    if (body.description !== undefined) patch.description = parseOptionalText(body.description, DESCRIPTION_MAX, 'description');
    if (typeof body.slug === 'string' && body.slug !== art.slug) {
      assertSlugFree(body.slug, art.id);
      patch.slug = body.slug;
    }
    if (body.memoryStorage !== undefined) {
      if (typeof body.memoryStorage !== 'boolean') throw new HttpError(400, 'invalid_boolean', { field: 'memoryStorage' });
      patch.memory_storage = body.memoryStorage ? 1 : 0;
    }
    if (body.project !== undefined) patch.project = parseProject(body.project);
    const tags = body.tags !== undefined ? parseTags(body.tags) : undefined;
    const visibility = body.visibility !== undefined ? parseVisibility(body.visibility) : art.visibility;
    if (visibility !== art.visibility) bump = true;
    if (typeof body.code === 'string' && body.code !== '') {
      if (visibility !== 'code') throw new HttpError(400, 'code_needs_code_visibility');
      patch.code_hash = await hashSecret(parseCode(body.code));
      bump = true;
    }
    if (visibility === 'code' && !patch.code_hash && !art.code_hash) throw new HttpError(400, 'code_required');
    if (visibility !== 'code') patch.code_hash = null;
    patch.visibility = visibility;
    try {
      const updated = tx(db, () => {
        const a = updateArtifact(db, art.id, patch, bump);
        if (tags) setTags(db, art.id, tags);
        const result = pinned === undefined ? a : setPinned(db, art.id, pinned);
        indexFields(db, cfg.dataDir, result);
        return result;
      });
      return c.json(artifactDto(updated));
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw (patch.slug && slugConflict(patch.slug, art.id)) || new HttpError(409, 'slug_taken');
      throw e;
    }
  });

  api.put('/artifacts/:id/content', (c) =>
    withUpload(c, async (fields, file) => {
      const art = mustGet(c.req.param('id'));
      const message = parseVersionMessage(fields.message);
      const versionId = newId();
      const theme = resolveTheme(db, art.theme_id, art.project);
      const r = await ingestFile(file, versionDir(cfg.dataDir, art.id, versionId), limits, staticLocale(cfg.locale), theme);
      activateVersion(db, art.id, { id: versionId, entry_path: r.entryPath, original_name: file.originalName, size_bytes: r.sizeBytes, file_count: r.fileCount, message, theme_snapshot: r.kind === 'markdown' && theme ? JSON.stringify(theme) : null }, r.kind);
      indexArtifact(db, cfg.dataDir, mustGet(art.id));
      await pruneVersions(db, cfg.dataDir, art.id);
      return c.json(artifactDto(mustGet(art.id)));
    }),
  );

  api.post('/artifacts/:id/revoke-all', (c) => {
    const art = mustGet(c.req.param('id'));
    bumpEpoch(db, art.id);
    return c.json(artifactDto(mustGet(art.id)));
  });

  // To the trash (design 04), or for good when the trash is off (TRASH_DAYS=0).
  api.delete('/artifacts/:id', async (c) => {
    const art = mustGet(c.req.param('id'));
    if (cfg.trashDays === 0) {
      await deleteForGood(db, cfg.dataDir, art.id);
      return c.json({ ok: true, trashed: false });
    }
    trashArtifact(db, art.id);
    return c.json({ ok: true, trashed: true });
  });

  const mustGetTrashed = (id: string): TrashedArtifact => {
    const art = getTrashedArtifact(db, id);
    if (!art) throw new HttpError(404, 'artifact_not_found');
    return art;
  };
  const trashDto = (art: TrashedArtifact) => ({
    id: art.id, slug: art.slug, title: art.title, kind: art.kind, visibility: art.visibility, project: art.project,
    deletedAt: art.deleted_at,
    purgeAt: cfg.trashDays > 0 ? new Date(Date.parse(art.deleted_at) + cfg.trashDays * 86_400_000).toISOString() : null,
  });

  api.get('/trash', (c) => c.json({ days: cfg.trashDays, items: listTrash(db).map(trashDto) }));

  api.post('/artifacts/:id/restore', (c) => {
    const art = restoreArtifact(db, mustGetTrashed(c.req.param('id')).id);
    if (!art) throw new HttpError(404, 'artifact_not_found');
    return c.json(artifactDto(art));
  });

  api.delete('/trash/:id', async (c) => {
    await deleteForGood(db, cfg.dataDir, mustGetTrashed(c.req.param('id')).id);
    return c.json({ ok: true });
  });

  api.delete('/trash', async (c) => {
    const items = listTrash(db);
    for (const art of items) await deleteForGood(db, cfg.dataDir, art.id);
    return c.json({ ok: true, deleted: items.length });
  });

  // Bulk actions (design 05): one operation on many artifacts in one transaction, all or nothing. Each operation
  // does what its single route does (epoch, pin date, updated_at); artifacts it would not change are left untouched.
  api.post('/artifacts/bulk', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > BULK_MAX || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      throw new HttpError(400, 'invalid_bulk_ids', { max: BULK_MAX });
    }
    const op = body.op;
    if (!(BULK_OPS as readonly unknown[]).includes(op)) throw new HttpError(400, 'invalid_bulk_op');
    // Values are checked before the transaction.
    let project: string | null = null;
    if (op === 'move') {
      if (body.value === undefined) throw new HttpError(400, 'invalid_project');
      project = parseProject(body.value);
    }
    let tags: string[] = [];
    if (op === 'addTags' || op === 'removeTags') {
      tags = parseTags(body.value);
      if (tags.length === 0) throw new HttpError(400, 'invalid_tags');
    }
    let visibility: Visibility = 'private';
    if (op === 'visibility') {
      visibility = parseVisibility(body.value);
      if (visibility === 'code') throw new HttpError(400, 'bulk_no_code');
    }
    const dropTags = new Set(tags);
    const forGood = op === 'trash' && cfg.trashDays === 0;
    const touch = (id: string) => updateArtifact(db, id, {}, false);

    tx(db, () => {
      const arts = (ids as string[]).map((id) => (op === 'restore' ? getTrashedArtifact(db, id) : getArtifact(db, id)));
      if (arts.some((a) => !a)) throw new HttpError(404, 'artifact_not_found');
      for (const art of arts as Artifact[]) {
        switch (op as BulkOp) {
          case 'move':
            if (art.project !== project) updateArtifact(db, art.id, { project }, false);
            break;
          case 'addTags':
          case 'removeTags': {
            const current = getTags(db, art.id);
            const next = op === 'addTags' ? normalizeTags([...current, ...tags]) : current.filter((t) => !dropTags.has(t));
            if (!next) throw new HttpError(400, 'too_many_tags', { title: art.title, max: MAX_TAGS });
            if (next.join() === current.join()) break;
            setTags(db, art.id, next);
            indexFields(db, cfg.dataDir, touch(art.id));
            break;
          }
          case 'visibility':
            if (art.visibility !== visibility) updateArtifact(db, art.id, { visibility, code_hash: null }, true);
            break;
          case 'pin':
          case 'unpin':
            setPinned(db, art.id, op === 'pin');
            break;
          case 'trash':
            if (forGood) deleteArtifact(db, art.id);
            else trashArtifact(db, art.id);
            break;
          case 'restore':
            restoreArtifact(db, art.id);
            break;
        }
      }
    });
    // Files go once the rows are gone (as deleteForGood does), outside the transaction.
    if (forGood) for (const id of ids as string[]) await removeArtifactFiles(cfg.dataDir, id);
    return c.json({ ok: true, count: ids.length, ...(op === 'trash' ? { trashed: !forGood } : {}) });
  });

  api.post('/artifacts/:id/links', async (c) => {
    const art = mustGet(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; expiresAt?: unknown };
    const label = parseLabel(body.label);
    let expiresAt: string | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      const t = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
      if (!Number.isFinite(t) || t <= nowMs()) throw new HttpError(400, 'expiry_in_past');
      expiresAt = new Date(t).toISOString();
    }
    return c.json(linkDto(newLink(art.id, label, expiresAt)), 201);
  });

  // One-step sharing: switches to “link” visibility if needed (new epoch, like any visibility change) and creates a link.
  api.post('/artifacts/:id/share', async (c) => {
    const art = mustGet(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { hours?: unknown; label?: unknown };
    const hours = parseHours(body.hours);
    const label = parseLabel(body.label);
    const expiresAt = new Date(nowMs() + hours * 3600_000).toISOString();
    const link = tx(db, () => {
      // Re-read inside the transaction: a concurrent visibility change alone decides the bump.
      if (mustGet(art.id).visibility !== 'link') updateArtifact(db, art.id, { visibility: 'link', code_hash: null }, true);
      return newLink(art.id, label, expiresAt);
    });
    return c.json({ artifact: artifactDto(mustGet(art.id)), link: linkDto(link) }, 201);
  });

  api.delete('/artifacts/:id/links/:linkId', (c) => {
    const art = mustGet(c.req.param('id'));
    if (!revokeLink(db, art.id, c.req.param('linkId'))) throw new HttpError(404, 'link_not_found');
    return c.json({ ok: true });
  });

  api.get('/artifacts/:id/preview', (c) => {
    const art = mustGet(c.req.param('id'));
    const version = art.current_version_id ? getVersion(db, art.current_version_id) : undefined;
    if (!version) throw new HttpError(404, 'no_content');
    const sig = signPath(keys.pathSig, { artifactId: art.id, versionId: version.id, epoch: art.access_epoch }, Math.floor(nowMs() / 1000));
    return c.json({ url: `${cfg.publicContentUrl}/a/${art.slug}/${sig}/${encodePath(version.entry_path)}` });
  });

  api.get('/artifacts/:id/stats', (c) => {
    const art = mustGet(c.req.param('id'));
    const stats = visitStats(db, art.id, parseDays(c.req.query('days')), nowMs());
    const links = listLinks(db, art.id).map((l) => ({ id: l.id, label: l.label, openCount: l.open_count, lastUsedAt: l.last_used_at, active: isActive(l) }));
    return c.json({ ...stats, links });
  });

  const versionDto = (art: Artifact, v: Version) => ({
    id: v.id, number: v.number, kind: v.kind ?? art.kind, message: v.message, originalName: v.original_name, sizeBytes: v.size_bytes,
    fileCount: v.file_count, createdAt: v.created_at, current: v.id === art.current_version_id,
    thumbnailUrl: thumbnailUrl(art.id, v, true),
  });

  api.get('/artifacts/:id/versions', (c) => {
    const art = mustGet(c.req.param('id'));
    return c.json(listVersions(db, art.id).map((v) => versionDto(art, v)));
  });

  // Version note written or corrected afterwards (design 16); never a modification of the artifact itself.
  api.patch('/artifacts/:id/versions/:versionId', async (c) => {
    const art = mustGet(c.req.param('id'));
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    // A body without the field is a mistake, not a way to erase the note: null or blank clears it.
    if (!body || typeof body !== 'object' || !('message' in body)) throw new HttpError(400, 'invalid_version_message');
    const message = parseVersionMessage(body.message);
    if (!setVersionMessage(db, art.id, c.req.param('versionId'), message)) throw new HttpError(404, 'version_not_found');
    return c.json(versionDto(art, getVersion(db, c.req.param('versionId'))!));
  });

  api.get('/artifacts/:id/versions/:versionId/preview', (c) => {
    const art = mustGet(c.req.param('id'));
    const version = getVersion(db, c.req.param('versionId'));
    if (!version || version.artifact_id !== art.id) throw new HttpError(404, 'version_not_found');
    const sig = signPinnedPath(keys.pathSig, { artifactId: art.id, versionId: version.id, epoch: art.access_epoch }, Math.floor(nowMs() / 1000));
    return c.json({ url: `${cfg.publicContentUrl}/a/${art.slug}/${sig}/${encodePath(version.entry_path)}` });
  });

  api.get('/artifacts/:id/thumbnail', (c) => {
    const art = mustGet(c.req.param('id'));
    return serveThumb(c, art, art.current_version_id ? getVersion(db, art.current_version_id) : undefined);
  });

  api.get('/artifacts/:id/versions/:versionId/thumbnail', (c) => {
    const art = mustGet(c.req.param('id'));
    return serveThumb(c, art, getVersion(db, c.req.param('versionId')));
  });

  // Body = the raw image (image/webp|png|jpeg), 2 MiB max; replaces this version's existing thumbnail.
  api.put('/artifacts/:id/versions/:versionId/thumbnail', async (c) => {
    const art = mustGet(c.req.param('id'));
    const version = getVersion(db, c.req.param('versionId'));
    if (!version || version.artifact_id !== art.id) throw new HttpError(404, 'version_not_found');
    // Received under a temporary name (data/tmp, same volume), outside the lock: the stream may be slow.
    const { tmpPath, type } = await receiveThumb(c.req.raw, tmpRoot(cfg.dataDir));
    try {
      // Database first, then rename: the previous image stays valid until the database switches.
      const stamp = await thumbLock(version.id, async () => {
        const previous = setVersionThumb(db, art.id, version.id, { thumb_type: type, thumb_at: new Date(nowMs()).toISOString() });
        if (previous === undefined) throw new HttpError(404, 'version_not_found'); // pruned meanwhile
        try {
          await placeThumb(cfg.dataDir, art.id, version.id, tmpPath, type);
        } catch (e) {
          setVersionThumb(db, art.id, version.id, previous); // rename failed: the database goes back to the previous image
          throw e;
        }
        for (const other of THUMB_TYPES) if (other !== type) await rm(thumbPath(cfg.dataDir, art.id, version.id, other), { force: true });
        const now = getVersion(db, version.id);
        if (!now) {
          // Pruned between the switch and the rename: no orphan file.
          await rm(thumbPath(cfg.dataDir, art.id, version.id, type), { force: true });
          throw new HttpError(404, 'version_not_found');
        }
        return thumbStamp(now);
      });
      return c.json({ thumbnailUrl: `/api/artifacts/${enc(art.id)}/versions/${enc(version.id)}/thumbnail?v=${stamp}` });
    } finally {
      await rm(tmpPath, { force: true });
    }
  });

  api.post('/artifacts/:id/versions/:versionId/restore', async (c) => {
    const art = mustGet(c.req.param('id'));
    const versionId = c.req.param('versionId');
    const restored = restoreVersion(db, art.id, versionId);
    if (!restored) throw new HttpError(404, 'version_not_found');
    if (restored === 'current') throw new HttpError(409, 'already_current');
    indexArtifact(db, cfg.dataDir, mustGet(art.id));
    await pruneVersions(db, cfg.dataDir, art.id);
    return c.json(artifactDto(mustGet(art.id)));
  });

  // ——— Folders: a project gets a sheet (created on the fly) and a shareable page /d/<project>.

  /** Existing folder name (sheet or artifacts), otherwise 404. */
  const mustFolder = (name: string): string => {
    if (!isFolderName(name) || !projectExists(db, name)) throw new HttpError(404, 'folder_not_found');
    return name;
  };
  /** `parent` field: undefined (absent), null (root) or a valid folder name. */
  const parseParent = (v: unknown): string | null | undefined => {
    if (v === undefined || v === null) return v;
    if (typeof v !== 'string' || !isFolderName(v)) throw new HttpError(400, 'invalid_parent');
    return v;
  };
  /** Moves `name` under `parent` after the tree checks. Call inside tx. */
  const reparent = (name: string, parent: string | null) => {
    const check = canReparent(db, name, parent);
    if (check !== 'ok') throw new HttpError(400, `parent_${check}` as ErrorCode);
    setParent(db, name, parent);
  };
  const folderSheet = (name: string): Project =>
    getProject(db, name) ?? { name, title: null, description: null, visibility: 'private', code_hash: null, access_epoch: 1, created_at: '', updated_at: '', salt: '', parent_name: null, position: null, theme_id: null };

  const folderActiveLinkUrl = (p: Project): string | null => {
    if (p.visibility !== 'link') return null;
    for (const l of listFolderLinks(db, p.name)) {
      if (!isActive(l)) continue;
      const url = linkUrl(l);
      if (url) return url;
    }
    return null;
  };

  const folderDto = (name: string) => {
    const p = folderSheet(name);
    const arts = listFolderArtifacts(db, name);
    return {
      name, themeId: p.theme_id, effectiveThemeId: resolveTheme(db, null, name)?.id ?? null, title: p.title, description: p.description, visibility: p.visibility, hasCode: !!p.code_hash, hasSheet: !!p.created_at,
      createdAt: p.created_at || null, updatedAt: p.updated_at || null,
      url: `${cfg.publicContentUrl}/d/${name}`, activeLinkUrl: folderActiveLinkUrl(p),
      count: arts.length, privateCount: arts.filter((a) => a.visibility === 'private').length,
      artifacts: arts.map((a) => {
        const v = a.current_version_id ? getVersion(db, a.current_version_id) : undefined;
        return {
          id: a.id, slug: a.slug, title: a.title, kind: a.kind, visibility: a.visibility, position: a.project_position, updatedAt: a.updated_at,
          versionNumber: v?.number ?? null, thumbnailUrl: thumbnailUrl(a.id, v),
        };
      }),
      links: listFolderLinks(db, name).map(linkDto),
      parent: p.parent_name ?? null,
      ancestors: ancestors(db, name).reverse().map((a) => ({ name: a.name, title: a.title })),
      children: children(db, name).map((ch) => ({ name: ch.name, title: ch.title, visibility: ch.visibility, count: listFolderArtifacts(db, ch.name).length })),
    };
  };

  /**
   * Folder list for the gallery: latest activity (sheet or most recent artifact) and the 4 most recent artifacts
   * (admin thumbnail) for the card mosaic, address and active link for “Copy link”. `name: null`: no folder.
   */
  api.get('/projects', (c) =>
    c.json(listFolders(db).map((f) => {
      const recent = recentProjectArtifacts(db, f.name, 4);
      const sheet = f.name === null ? undefined : getProject(db, f.name);
      const latest = [sheet?.updated_at, recent[0]?.updated_at].filter((x): x is string => !!x).sort().at(-1) ?? null;
      return {
        ...f, themeId: sheet?.theme_id ?? null, effectiveThemeId: resolveTheme(db, null, f.name)?.id ?? null, latestUpdatedAt: latest,
        childCount: f.name === null ? 0 : children(db, f.name).length,
        recent: recent.map((a) => {
          const v = a.current_version_id ? getVersion(db, a.current_version_id) : undefined;
          return { id: a.id, kind: a.kind, title: a.title, thumbnailUrl: thumbnailUrl(a.id, v) };
        }),
        url: f.name === null ? null : `${cfg.publicContentUrl}/d/${f.name}`,
        activeLinkUrl: f.name === null ? null : folderActiveLinkUrl(folderSheet(f.name)),
      };
    })));

  // Explicit (empty) folder creation: private sheet, fresh salt. Name taken by a sheet or by artifacts → 409.
  api.post('/projects', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? normalizeLabel(body.name) : null;
    if (!name) throw new HttpError(400, 'invalid_folder_name');
    const patch: ProjectPatch = {};
    if (body.themeId !== undefined) patch.theme_id = parseThemeId(db, body.themeId);
    if (body.title !== undefined) patch.title = parseOptionalText(body.title, 120, 'title');
    if (body.description !== undefined) patch.description = parseOptionalText(body.description, DESCRIPTION_MAX, 'description');
    const parent = parseParent(body.parent);
    tx(db, () => {
      if (projectExists(db, name)) throw new HttpError(409, 'folder_exists');
      upsertProject(db, name, patch);
      if (parent) reparent(name, parent);
    });
    return c.json(folderDto(name), 201);
  });

  api.get('/projects/:name', (c) => c.json(folderDto(mustFolder(c.req.param('name')))));

  // Preview of the visitor page, whatever the folder visibility (signed URL, 1 h).
  api.get('/projects/:name/preview', (c) => {
    const name = mustFolder(c.req.param('name'));
    // The signature binds the sheet's salt: the sheet is created if needed (private by default, nothing is exposed).
    const sig = signFolderPreview(keys.folderPreview, upsertProject(db, name, {}), Math.floor(nowMs() / 1000));
    return c.json({ url: `${cfg.publicContentUrl}/d/${name}?preview=${sig}` });
  });

  api.patch('/projects/:name', async (c) => {
    const name = c.req.param('name');
    if (!isFolderName(name)) throw new HttpError(400, 'invalid_project');
    mustFolder(name); // fiche ou au moins un artifact, comme les autres routes
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const current = folderSheet(name);
    const parent = parseParent(body.parent);
    const patch: ProjectPatch = {};
    if (body.themeId !== undefined) patch.theme_id = parseThemeId(db, body.themeId);
    let bump = false;
    if (body.title !== undefined) patch.title = parseOptionalText(body.title, 120, 'title');
    if (body.description !== undefined) patch.description = parseOptionalText(body.description, DESCRIPTION_MAX, 'description');
    const visibility = body.visibility !== undefined ? parseVisibility(body.visibility) : current.visibility;
    if (visibility !== current.visibility) bump = true;
    if (typeof body.code === 'string' && body.code !== '') {
      if (visibility !== 'code') throw new HttpError(400, 'code_needs_code_visibility');
      patch.code_hash = await hashSecret(parseCode(body.code));
      bump = true;
    }
    if (visibility === 'code' && !patch.code_hash && !current.code_hash) throw new HttpError(400, 'code_required');
    if (visibility !== 'code') patch.code_hash = null;
    patch.visibility = visibility;
    let target = name;
    if (body.name !== undefined) {
      const next = typeof body.name === 'string' ? normalizeLabel(body.name) : null;
      if (!next) throw new HttpError(400, 'invalid_folder_name');
      target = next;
    }
    tx(db, () => {
      if (target !== name) {
        if (!projectExists(db, name)) throw new HttpError(404, 'folder_not_found');
        if (projectExists(db, target)) throw new HttpError(409, 'project_exists');
        renameProject(db, name, target);
      }
      // Renaming alone does not create a sheet; any other field creates one on the fly.
      const onlyRename = Object.keys(body).every((k) => k === 'name');
      if (!onlyRename || getProject(db, target)) upsertProject(db, target, patch, bump);
      // Skip a no-op reparent: setParent resets the sibling position.
      if (parent !== undefined && parent !== (getProject(db, target)?.parent_name ?? null)) reparent(target, parent);
    });
    return c.json(folderDto(target));
  });

  // One-step sharing: switches the folder to “link” if needed (new epoch) and creates a link.
  api.post('/projects/:name/share', async (c) => {
    const name = mustFolder(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { hours?: unknown; label?: unknown };
    const hours = parseHours(body.hours);
    const label = parseLabel(body.label);
    const expiresAt = new Date(nowMs() + hours * 3600_000).toISOString();
    const link = tx(db, () => {
      if (folderSheet(name).visibility !== 'link') upsertProject(db, name, { visibility: 'link', code_hash: null }, true);
      return newFolderLink(name, label, expiresAt);
    });
    return c.json({ project: folderDto(name), link: linkDto(link) }, 201);
  });

  api.post('/projects/:name/revoke-all', (c) => {
    const name = mustFolder(c.req.param('name'));
    // Without a sheet, one is created (new salt) then its epoch bumped: previews or cookies already issued are cut.
    tx(db, () => {
      upsertProject(db, name, {});
      bumpProjectEpoch(db, name);
    });
    return c.json(folderDto(name));
  });

  api.put('/projects/:name/order', async (c) => {
    const name = mustFolder(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) throw new HttpError(400, 'invalid_ids');
    if (!setProjectOrder(db, name, body.ids as string[])) throw new HttpError(409, 'folder_changed');
    return c.json(folderDto(name));
  });

  api.post('/projects/:name/links', async (c) => {
    const name = mustFolder(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; expiresAt?: unknown };
    const label = parseLabel(body.label);
    const expiresAt = parseExpiresAt(body.expiresAt, nowMs());
    const link = tx(db, () => {
      upsertProject(db, name, {});
      return newFolderLink(name, label, expiresAt);
    });
    return c.json(linkDto(link), 201);
  });

  api.delete('/projects/:name/links/:linkId', (c) => {
    const name = mustFolder(c.req.param('name'));
    if (!revokeFolderLink(db, name, c.req.param('linkId'))) throw new HttpError(404, 'link_not_found');
    return c.json({ ok: true });
  });

  api.get('/projects/:name/stats', (c) => {
    const name = mustFolder(c.req.param('name'));
    const stats = folderVisitStats(db, name, parseDays(c.req.query('days')), nowMs());
    const links = listFolderLinks(db, name).map((l) => ({ id: l.id, label: l.label, openCount: l.open_count, lastUsedAt: l.last_used_at, active: isActive(l) }));
    return c.json({ ...stats, links });
  });

  api.put('/projects/:name/children-order', async (c) => {
    const name = mustFolder(c.req.param('name'));
    const body = (await c.req.json().catch(() => ({}))) as { names?: unknown };
    if (!Array.isArray(body.names) || body.names.some((n) => typeof n !== 'string')) throw new HttpError(400, 'invalid_names');
    if (!setChildrenOrder(db, name, body.names as string[])) throw new HttpError(409, 'folder_changed');
    return c.json(folderDto(name));
  });

  // Deletes the sheet (folder links and statistics included); artifacts stay in their project; direct sub-folders move up.
  api.delete('/projects/:name', (c) => {
    const name = c.req.param('name');
    if (!isFolderName(name)) throw new HttpError(404, 'folder_not_found');
    const movedChildren = children(db, name).length;
    if (!deleteProject(db, name)) throw new HttpError(404, 'folder_not_found');
    return c.json({ ok: true, movedChildren });
  });

  // Full-text search (design 07): title, slug, tags and text of live artifacts; snippet from the text.
  api.get('/search', (c) => c.json({ results: searchArtifacts(db, c.req.query('q') ?? '') }));

  api.get('/slugs/:slug', (c) => {
    const slug = c.req.param('slug');
    const valid = isValidSlug(slug);
    const holder = valid ? slugHolder(db, slug) : undefined;
    return c.json({ slug, valid, available: valid && !holder, inTrash: !!holder?.trashed });
  });

  return api;
}
