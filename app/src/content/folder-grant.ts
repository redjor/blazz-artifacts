import { hmac, safeEqual } from '../crypto.ts';
import type { Db } from '../db.ts';
import { getLink, type Project } from '../repo.ts';

/**
 * Folder access: a cookie distinct from artifact grants (named `__Host-fgrant_<project>`), signed with a dedicated
 * derived key (keys.folderGrant) and marked `t: 'f'`. An artifact grant is never read as a folder grant, nor the reverse.
 */
/** `s`: the sheet's salt (a sheet re-created under the same name has another salt, so old grants are worthless). */
export interface FolderGrantClaims { p: string; s: string; e: number; l: string | null; x: number }

export const folderCookieName = (project: string) => `__Host-fgrant_${project}`;

export function encodeFolderGrant(key: Buffer, c: FolderGrantClaims): string {
  const body = Buffer.from(JSON.stringify({ t: 'f', ...c })).toString('base64url');
  return `${body}.${hmac(key, body)}`;
}

export function decodeFolderGrant(key: Buffer, value: string | undefined): FolderGrantClaims | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], hmac(key, parts[0]))) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const ok = c.t === 'f' && typeof c.p === 'string' && typeof c.s === 'string' && typeof c.e === 'number' && typeof c.x === 'number' && (c.l === null || typeof c.l === 'string');
    return ok ? { p: c.p, s: c.s, e: c.e, l: c.l, x: c.x } : null;
  } catch {
    return null;
  }
}

/** Rules parallel to isGrantValid: same folder, same epoch, not expired; “code” without a link, “link” with a still-active link of THIS folder. */
export function isFolderGrantValid(db: Db, project: Project, c: FolderGrantClaims | null, nowS: number): boolean {
  if (!c || c.p !== project.name || !project.salt || c.s !== project.salt || c.e !== project.access_epoch || c.x <= nowS) return false;
  if (project.visibility === 'code') return c.l === null;
  if (project.visibility !== 'link' || !c.l) return false;
  const link = getLink(db, c.l);
  return (
    !!link &&
    link.project_name === project.name &&
    !link.revoked_at &&
    (!link.expires_at || Date.parse(link.expires_at) > nowS * 1000)
  );
}

/** Folder access: public for everyone, private (or no sheet) for nobody, otherwise a valid grant. */
export function hasFolderAccess(db: Db, project: Project | undefined, c: FolderGrantClaims | null, nowS: number): boolean {
  if (!project || project.visibility === 'private') return false;
  if (project.visibility === 'public') return true;
  return isFolderGrantValid(db, project, c, nowS);
}

/**
 * Inherited folder access (design 03). `chain`: the folder then its ancestors, nearest first. Returns the highest
 * (root-side) folder whose own access is valid for this visitor, or null. Each folder is checked with its own grant.
 */
export function effectiveFolderAccess(
  db: Db, chain: Project[], grantOf: (name: string) => FolderGrantClaims | null, nowS: number,
): Project | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (hasFolderAccess(db, chain[i], grantOf(chain[i].name), nowS)) return chain[i];
  }
  return null;
}

// Thumbnail URL issued by the folder page (the sandboxed document has an opaque origin: its image requests carry no
// SameSite cookies). Bound to the granting folder (the page's folder or the ancestor that opened it, design 03), its
// epoch and the displayed folder; expires in 1 h. Membership, descent and visibility are re-checked on every request.
export const FOLDER_THUMB_TTL_S = 3600;
const thumbPayload = (g: Pick<Project, 'name' | 'salt' | 'access_epoch'>, folder: string, artifactId: string, versionId: string, exp: number) =>
  `thumb|${g.name}|${g.salt}|${g.access_epoch}|${folder}|${artifactId}|${versionId}|${exp}`;

export function signFolderThumb(key: Buffer, granting: Project, folder: string, artifactId: string, versionId: string, nowS: number): string {
  const exp = nowS + FOLDER_THUMB_TTL_S;
  return `${exp}.${hmac(key, thumbPayload(granting, folder, artifactId, versionId, exp))}`;
}

export function checkFolderThumb(
  key: Buffer, granting: Project, folder: string, artifactId: string, versionId: string, sig: string | undefined, nowS: number,
): boolean {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(sig ?? '');
  if (!m) return false;
  const exp = Number(m[1]);
  if (!granting.salt || !safeEqual(m[2], hmac(key, thumbPayload(granting, folder, artifactId, versionId, exp)))) return false;
  return exp > nowS && granting.visibility !== 'private';
}

// Admin preview of the folder page (whatever its visibility): issued by the admin API only, 1 h, bound to the epoch.
// Like an artifact preview, it creates no lasting access: no cookie, cards point to signed paths.
// Requires a sheet (and so a salt): the admin API creates it before signing.
const previewPayload = (p: Pick<Project, 'name' | 'salt' | 'access_epoch'>, exp: number) => `preview|${p.name}|${p.salt}|${p.access_epoch}|${exp}`;

export function signFolderPreview(key: Buffer, project: Pick<Project, 'name' | 'salt' | 'access_epoch'>, nowS: number): string {
  const exp = nowS + FOLDER_THUMB_TTL_S;
  return `${exp}.${hmac(key, previewPayload(project, exp))}`;
}

export function checkFolderPreview(key: Buffer, project: Pick<Project, 'name' | 'salt' | 'access_epoch'>, sig: string | undefined, nowS: number): boolean {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(sig ?? '');
  if (!m || !project.salt) return false;
  const exp = Number(m[1]);
  return safeEqual(m[2], hmac(key, previewPayload(project, exp))) && exp > nowS;
}
