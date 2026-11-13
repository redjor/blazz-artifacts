import { errorText, t } from './i18n/index.ts';
import type { ArtifactDetail, ArtifactDto, FolderDetail, FolderSummary, LabelCount, LinkDto, StatsDto, VersionDto, Visibility } from './types.ts';

let csrf = '';
const seg = encodeURIComponent; // identifiers inside paths
let unauthorizedHandler: (() => void) | null = null;

export const onUnauthorized = (cb: (() => void) | null) => {
  unauthorizedHandler = cb;
};

/** API failure: `code` is the server's stable error code; the message is localised (server message as fallback). */
export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: FormData | Blob | object): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body instanceof Blob) {
    payload = body; // raw body (thumbnail): the declared type is the file's
    headers['Content-Type'] = body.type;
  }
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/session' && path !== '/login') unauthorizedHandler?.();
  if (!res.ok) {
    const code = typeof data?.code === 'string' ? data.code : null;
    const message = errorText(code, data?.params) ?? (typeof data?.error === 'string' ? data.error : t('error.http', { status: res.status }));
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}

export const api = {
  async session() {
    const s = await request<{ authenticated: boolean; csrfToken: string | null }>('GET', '/session');
    csrf = s.csrfToken ?? '';
    return s;
  },
  async login(password: string) {
    csrf = (await request<{ csrfToken: string }>('POST', '/login', { password })).csrfToken;
  },
  logout: () => request<{ ok: true }>('POST', '/logout'),
  list: () => request<ArtifactDto[]>('GET', '/artifacts'),
  projects: () => request<FolderSummary[]>('GET', '/projects'),
  tags: () => request<LabelCount[]>('GET', '/tags'),
  get: (id: string) => request<ArtifactDetail>('GET', `/artifacts/${seg(id)}`),
  create: (form: FormData) => request<ArtifactDto>('POST', '/artifacts', form),
  update: (id: string, patch: { title?: string; slug?: string; visibility?: Visibility; code?: string; memoryStorage?: boolean; project?: string | null; tags?: string[]; pinned?: boolean }) =>
    request<ArtifactDto>('PATCH', `/artifacts/${seg(id)}`, patch),
  replace: (id: string, form: FormData) => request<ArtifactDto>('PUT', `/artifacts/${seg(id)}/content`, form),
  remove: (id: string) => request<{ ok: true }>('DELETE', `/artifacts/${seg(id)}`),
  revokeAll: (id: string) => request<ArtifactDto>('POST', `/artifacts/${seg(id)}/revoke-all`),
  createLink: (id: string, body: { label: string | null; expiresAt: string | null }) =>
    request<LinkDto>('POST', `/artifacts/${seg(id)}/links`, body),
  share: (id: string, body: { hours?: number; label?: string }) =>
    request<{ artifact: ArtifactDto; link: LinkDto }>('POST', `/artifacts/${seg(id)}/share`, body),
  revokeLink: (id: string, linkId: string) => request<{ ok: true }>('DELETE', `/artifacts/${seg(id)}/links/${seg(linkId)}`),
  preview: (id: string) => request<{ url: string }>('GET', `/artifacts/${seg(id)}/preview`),
  stats: (id: string, days = 30) => request<StatsDto>('GET', `/artifacts/${seg(id)}/stats?days=${days}`),
  versions: (id: string) => request<VersionDto[]>('GET', `/artifacts/${seg(id)}/versions`),
  versionPreview: (id: string, versionId: string) => request<{ url: string }>('GET', `/artifacts/${seg(id)}/versions/${seg(versionId)}/preview`),
  putThumbnail: (id: string, versionId: string, image: Blob) =>
    request<{ thumbnailUrl: string }>('PUT', `/artifacts/${seg(id)}/versions/${seg(versionId)}/thumbnail`, image),
  restore: (id: string, versionId: string) => request<ArtifactDto>('POST', `/artifacts/${seg(id)}/versions/${seg(versionId)}/restore`),
  createFolder: (body: { name: string; title?: string; description?: string }) => request<FolderDetail>('POST', '/projects', body),
  folder: (name: string) => request<FolderDetail>('GET', `/projects/${seg(name)}`),
  updateFolder: (name: string, patch: { title?: string | null; description?: string | null; visibility?: Visibility; code?: string; name?: string }) =>
    request<FolderDetail>('PATCH', `/projects/${seg(name)}`, patch),
  shareFolder: (name: string, body: { hours?: number; label?: string }) =>
    request<{ project: FolderDetail; link: LinkDto }>('POST', `/projects/${seg(name)}/share`, body),
  revokeAllFolder: (name: string) => request<FolderDetail>('POST', `/projects/${seg(name)}/revoke-all`),
  orderFolder: (name: string, ids: string[]) => request<FolderDetail>('PUT', `/projects/${seg(name)}/order`, { ids }),
  createFolderLink: (name: string, body: { label: string | null; expiresAt: string | null }) =>
    request<LinkDto>('POST', `/projects/${seg(name)}/links`, body),
  revokeFolderLink: (name: string, linkId: string) => request<{ ok: true }>('DELETE', `/projects/${seg(name)}/links/${seg(linkId)}`),
  folderStats: (name: string, days = 30) => request<StatsDto>('GET', `/projects/${seg(name)}/stats?days=${days}`),
  folderPreview: (name: string) => request<{ url: string }>('GET', `/projects/${seg(name)}/preview`),
  deleteFolder: (name: string) => request<{ ok: true }>('DELETE', `/projects/${seg(name)}`),
  slug: (slug: string) => request<{ slug: string; valid: boolean; available: boolean }>('GET', `/slugs/${encodeURIComponent(slug)}`),
};

// Opens the tab before the network call: otherwise the popup blocker catches it.
export function openPreview(id: string, versionId?: string): Promise<void> {
  return openUrl(versionId ? api.versionPreview(id, versionId) : api.preview(id));
}

/** Preview of a folder's visitor page (signed URL valid one hour, whatever its visibility). */
export const openFolderPreview = (name: string) => openUrl(api.folderPreview(name));

async function openUrl(pending: Promise<{ url: string }>): Promise<void> {
  const win = window.open('', '_blank');
  try {
    const { url } = await pending;
    if (win) {
      win.opener = null;
      win.location.href = url;
    }
  } catch (e) {
    win?.close();
    throw e;
  }
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Copies a text known only after a network call. ClipboardItem accepts a promise:
 * the write is requested during the user gesture (Safari requires it), the content arrives later.
 */
export async function copyDeferred(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
      return;
    } catch {
      // browser without promise support in ClipboardItem: plain write below
    }
  }
  await navigator.clipboard.writeText(await text);
}
