export interface ArtifactPath { slug: string; sig: string | null; rest: string }

const badSegment = (s: string) => s === '' || s === '.' || s === '..' || /[\\/\0]/.test(s);

export function sanitizeRest(rest: string): string {
  const segments = rest.split('/');
  return segments.some(badSegment) ? '' : rest;
}

export function parseArtifactPath(pathname: string): ArtifactPath | null {
  const raw = pathname.split('/');
  if (raw[1] !== 'a' || !raw[2]) return null;
  let segments: string[];
  try {
    segments = raw.slice(2).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  const slug = segments[0];
  let rest = segments.slice(1);
  let sig: string | null = null;
  if (rest[0]?.startsWith('~')) {
    sig = rest[0];
    rest = rest.slice(1);
  }
  const trailingSlash = rest.length > 0 && rest[rest.length - 1] === '';
  if (trailingSlash) rest = rest.slice(0, -1);
  if (rest.some(badSegment)) return null;
  let restPath = rest.join('/');
  if (trailingSlash && restPath) restPath += '/index.html';
  return { slug, sig, rest: restPath };
}

export const encodePath = (rest: string) => rest.split('/').map(encodeURIComponent).join('/');

export const artifactUrl = (slug: string, rest = '') => `/a/${slug}${rest ? `/${encodePath(rest)}` : ''}`;
