import { hmac, safeEqual } from '../crypto.ts';
import type { Artifact } from '../repo.ts';

export const PATH_SIG_TTL_S = 3600;

interface SigFields { artifactId: string; versionId: string; epoch: number }

const payload = (f: SigFields, exp: number) => `${f.artifactId}|${f.versionId}|${f.epoch}|${exp}`;

export function signPath(key: Buffer, f: SigFields, nowS: number, ttlS = PATH_SIG_TTL_S): string {
  const exp = nowS + ttlS;
  return `~${f.versionId}.${f.epoch}.${exp}.${hmac(key, payload(f, exp))}`;
}

// Common body: <versionId>.<epoch>.<exp>.<mac>. The normal form is `~` + body, the pinned one `~p` + body.
const SIG_BODY = '([0-9A-HJKMNP-TV-Z]{26})\\.(\\d{1,9})\\.(\\d{1,12})\\.([A-Za-z0-9_-]{43})$';
const SIG_RE = new RegExp(`^~${SIG_BODY}`);

export function checkPathSig(
  key: Buffer,
  art: Pick<Artifact, 'id' | 'current_version_id' | 'access_epoch'>,
  sig: string,
  nowS: number,
): 'valid' | 'stale' | 'forged' {
  const m = SIG_RE.exec(sig);
  if (!m) return 'forged';
  const [, versionId, epochS, expS, mac] = m;
  const epoch = Number(epochS);
  const exp = Number(expS);
  if (!safeEqual(mac, hmac(key, payload({ artifactId: art.id, versionId, epoch }, exp)))) return 'forged';
  if (versionId !== art.current_version_id || epoch !== art.access_epoch || exp <= nowS) return 'stale';
  return 'valid';
}

// “Pinned” path: serves exactly one given version (admin preview of an old version).
// Two independent protections: the shape (`~p`: lowercase `p` is not in the id alphabet, so
// neither regex accepts the other form) and the HMAC payload prefixed `pin|` (an artifact id starts
// with an uppercase ULID character, so a normal payload can never equal a pinned one).
const pinnedPayload = (f: SigFields, exp: number) => `pin|${payload(f, exp)}`;

export function signPinnedPath(key: Buffer, f: SigFields, nowS: number, ttlS = PATH_SIG_TTL_S): string {
  const exp = nowS + ttlS;
  return `~p${f.versionId}.${f.epoch}.${exp}.${hmac(key, pinnedPayload(f, exp))}`;
}

const PINNED_RE = new RegExp(`^~p${SIG_BODY}`);

export const isPinnedSig = (sig: string) => sig.startsWith('~p');

export function checkPinnedPathSig(
  key: Buffer,
  art: Pick<Artifact, 'id' | 'access_epoch'>,
  sig: string,
  nowS: number,
): { result: 'valid' | 'stale'; versionId: string } | { result: 'forged' } {
  const m = PINNED_RE.exec(sig);
  if (!m) return { result: 'forged' };
  const [, versionId, epochS, expS, mac] = m;
  const epoch = Number(epochS);
  const exp = Number(expS);
  if (!safeEqual(mac, hmac(key, pinnedPayload({ artifactId: art.id, versionId, epoch }, exp)))) return { result: 'forged' };
  return { result: epoch !== art.access_epoch || exp <= nowS ? 'stale' : 'valid', versionId };
}
