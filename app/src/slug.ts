export const RESERVED_SLUGS = new Set(['share', 'assets', 'api', 'admin', 'hub', 'unlock']);
const SLUG_RE = /^[a-z0-9](?:-?[a-z0-9])*$/;

export function isValidSlug(s: string): boolean {
  return s.length >= 1 && s.length <= 48 && SLUG_RE.test(s) && !RESERVED_SLUGS.has(s);
}

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return base && !RESERVED_SLUGS.has(base) ? base : 'artifact';
}
