import { hmac, safeEqual } from '../crypto.ts';
import type { Db } from '../db.ts';
import { getLink, type Artifact } from '../repo.ts';

export interface GrantClaims { a: string; e: number; l: string | null; x: number }
export const GRANT_TTL_S = 12 * 3600;

export const grantCookieName = (artifactId: string) => `__Host-grant_${artifactId}`;

export function encodeGrant(key: Buffer, c: GrantClaims): string {
  const body = Buffer.from(JSON.stringify(c)).toString('base64url');
  return `${body}.${hmac(key, body)}`;
}

export function decodeGrant(key: Buffer, value: string | undefined): GrantClaims | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], hmac(key, parts[0]))) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const ok = typeof c.a === 'string' && typeof c.e === 'number' && typeof c.x === 'number' && (c.l === null || typeof c.l === 'string');
    return ok ? { a: c.a, e: c.e, l: c.l, x: c.x } : null;
  } catch {
    return null;
  }
}

export function isGrantValid(db: Db, art: Artifact, c: GrantClaims | null, nowS: number): boolean {
  if (!c || c.a !== art.id || c.e !== art.access_epoch || c.x <= nowS) return false;
  if (art.visibility === 'code') return c.l === null;
  if (art.visibility !== 'link' || !c.l) return false;
  const link = getLink(db, c.l);
  return (
    !!link &&
    link.artifact_id === art.id &&
    !link.revoked_at &&
    (!link.expires_at || Date.parse(link.expires_at) > nowS * 1000)
  );
}
