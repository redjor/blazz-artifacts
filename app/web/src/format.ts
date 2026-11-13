import { getLocale, t, tn } from './i18n/index.ts';
import type { Kind, Visibility } from './types.ts';

export const kindLabel = (k: Kind) => t(`kind.${k}`);
export const visibilityLabel = (v: Visibility) => t(`visibility.${v}`);
/** Short labels for indicators and the filter. */
export const visibilityShort = (v: Visibility) => t(`visibilityShort.${v}`);
export const visibilityHint = (v: Visibility) => t(`visibilityHint.${v}`);

export const VISIBILITY_ORDER: Visibility[] = ['private', 'code', 'link', 'public'];

// "Create" tiles: one publishable kind per tile, with its accepted extensions.
export const KIND_FILTERS: { kind: Kind; accept: string }[] = [
  { kind: 'markdown', accept: '.md,.markdown' },
  { kind: 'html', accept: '.html,.htm' },
  { kind: 'site', accept: '.zip' },
  { kind: 'pdf', accept: '.pdf' },
  { kind: 'json', accept: '.json' },
];
export const kindTileLabel = (k: Kind) => t(`kindTile.${k}`);

export const ACCEPT_ALL = '.html,.htm,.md,.markdown,.pdf,.json,.zip';

// Formatters follow the active locale; cached per locale.
const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();
function fmt<T extends Intl.DateTimeFormat | Intl.NumberFormat>(name: string, make: (locale: string) => T): T {
  const key = `${getLocale()}:${name}`;
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make(getLocale());
    cache.set(key, f);
  }
  return f;
}
const dateTime = () => fmt('dateTime', (l) => new Intl.DateTimeFormat(l, { dateStyle: 'medium', timeStyle: 'short' }));
const day = () => fmt('day', (l) => new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short' }));
const dayYear = () => fmt('dayYear', (l) => new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short', year: 'numeric' }));
const utcDay = () => fmt('utcDay', (l) => new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short', timeZone: 'UTC' }));
const utcDayLong = () => fmt('utcDayLong', (l) => new Intl.DateTimeFormat(l, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }));
const compact = () => fmt('compact', (l) => new Intl.NumberFormat(l, { notation: 'compact', maximumFractionDigits: 1 }));
const whole = () => fmt('whole', (l) => new Intl.NumberFormat(l));
const oneDecimal = () => fmt('oneDecimal', (l) => new Intl.NumberFormat(l, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

export const formatDate = (iso: string) => dateTime().format(new Date(iso));

export const formatDay = (iso: string) => dayYear().format(new Date(iso));

/** Relative date and whether it is an absolute day ("Oct 28") rather than a relative phrase. */
function relative(iso: string, now: Date): { text: string; absolute: boolean } {
  const d = new Date(iso);
  const min = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return { text: t('time.justNow'), absolute: false };
  if (min < 60) return { text: t('time.minutesAgo', { n: min }), absolute: false };
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return { text: t('time.hoursAgo', { n: Math.floor(min / 60) }), absolute: false };
  if (days === 1) return { text: t('time.yesterday'), absolute: false };
  return { text: (d.getFullYear() === now.getFullYear() ? day() : dayYear()).format(d), absolute: true };
}

/** "just now", "10 min ago", "3 h ago", "yesterday", "Oct 28" ("Oct 28, 2025" outside the current year). */
export const relativeDate = (iso: string, now = new Date()): string => relative(iso, now).text;

/** "Modified yesterday" / "Modified on Oct 28". */
export function modifiedText(iso: string, now = new Date()): string {
  const r = relative(iso, now);
  return r.absolute ? t('common.modifiedOn', { date: r.text }) : t('common.modified', { when: r.text });
}

/** "1 view", "124 views", "1.2K views". */
export function formatViews(n: number): string {
  return tn('views', n, { n: n < 1000 ? whole().format(n) : compact().format(n) });
}

export const formatCount = (n: number) => whole().format(n);

/** UTC day "YYYY-MM-DD" → "Nov 3" (never shifted by the local time zone). */
export const formatUtcDay = (d: string) => utcDay().format(new Date(`${d}T00:00:00Z`));
export const formatUtcDayLong = (d: string) => utcDayLong().format(new Date(`${d}T00:00:00Z`));

export function formatBytes(n: number): string {
  if (n < 1024) return t('bytes.b', { n });
  if (n < 1024 * 1024) return t('bytes.kb', { n: oneDecimal().format(n / 1024) });
  return t('bytes.mb', { n: oneDecimal().format(n / 1024 / 1024) });
}

export const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '') || name;

/** Locale-aware, case-insensitive, numeric comparison of titles. */
export const compareText = (a: string, b: string) => a.localeCompare(b, getLocale(), { sensitivity: 'base', numeric: true });

const RESERVED = new Set(['share', 'assets', 'api', 'admin', 'hub', 'unlock']);

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).replace(/-+$/, '');
  return base && !RESERVED.has(base) ? base : 'artifact';
}

// Folders (projects) and tags: same rules as the server (src/labels.ts); the server stays the authority.
export const MAX_TAGS = 20;

export function normalizeLabel(input: string): string | null {
  const s = input
    .trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32).replace(/-+$/, '');
  return s || null;
}
