// Copy of the server-rendered visitor pages (unlock forms, 404, folder page, Markdown/JSON reader chrome).
// The admin SPA has its own dictionaries in web/src/i18n.

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
/** HUB_LOCALE: a fixed locale, or `auto` to follow the visitor's Accept-Language header. */
export type LocaleSetting = Locale | 'auto';

const en = {
  'notFound.title': 'Not found',
  'notFound.body': 'This content does not exist or is no longer available.',
  'unlock.artifact': 'This content is protected by a code.',
  'unlock.folder': 'This folder is protected by a code.',
  'unlock.code': 'Code',
  'unlock.submit': 'Unlock',
  'unlock.tooMany': 'Too many attempts. Try again in 15 minutes.',
  'unlock.wrong': 'Incorrect code.',
  'request.tooLarge': 'Request too large',
  'request.invalid': 'Invalid request',
  'error.internal': 'Internal error',
  'theme.toggle': 'Toggle light or dark theme',
  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'toc': 'Contents',
  'original': 'Original',
  'original.markdown': 'Original Markdown',
  'original.json': 'Original JSON',
  'kind.html': 'HTML page',
  'kind.markdown': 'Document',
  'kind.pdf': 'PDF',
  'kind.json': 'JSON',
  'kind.site': 'Site',
  'folder.count.one': '{n} artifact',
  'folder.count.other': '{n} artifacts',
  'folder.folders': 'Folders',
  'folder.subCount.one': '{n} folder',
  'folder.subCount.other': '{n} folders',
  'folder.emptyChild': 'Empty',
  'folder.breadcrumb': 'Folder path',
  'folder.empty': 'This folder is empty for now.',
  'folder.previewTitle': 'Preview',
  'folder.previewBody': 'Page as visitors see it. Folder visibility: {visibility}. This link expires within the hour.',
  'visibility.private': 'private',
  'visibility.code': 'secret code',
  'visibility.link': 'link',
  'visibility.public': 'public',
} as const;

export type MessageKey = keyof typeof en;

const fr: Record<MessageKey, string> = {
  'notFound.title': 'Introuvable',
  'notFound.body': 'Ce contenu n’existe pas ou n’est plus disponible.',
  'unlock.artifact': 'Ce contenu est protégé par un code.',
  'unlock.folder': 'Ce dossier est protégé par un code.',
  'unlock.code': 'Code',
  'unlock.submit': 'Accéder',
  'unlock.tooMany': 'Trop de tentatives. Réessaie dans 15 minutes.',
  'unlock.wrong': 'Code incorrect.',
  'request.tooLarge': 'Requête trop volumineuse',
  'request.invalid': 'Requête invalide',
  'error.internal': 'Erreur interne',
  'theme.toggle': 'Inverser le thème clair ou sombre',
  'theme.dark': 'Sombre',
  'theme.light': 'Clair',
  'toc': 'Sommaire',
  'original': 'Original',
  'original.markdown': 'Markdown original',
  'original.json': 'JSON original',
  'kind.html': 'Page HTML',
  'kind.markdown': 'Document',
  'kind.pdf': 'PDF',
  'kind.json': 'JSON',
  'kind.site': 'Site',
  'folder.count.one': '{n} artéfact',
  'folder.count.other': '{n} artéfacts',
  'folder.folders': 'Dossiers',
  'folder.subCount.one': '{n} dossier',
  'folder.subCount.other': '{n} dossiers',
  'folder.emptyChild': 'Vide',
  'folder.breadcrumb': 'Chemin du dossier',
  'folder.empty': 'Ce dossier est vide pour l’instant.',
  'folder.previewTitle': 'Aperçu',
  'folder.previewBody': 'Page telle que la voient les visiteurs. Visibilité du dossier : {visibility}. Ce lien expire dans l’heure.',
  'visibility.private': 'privé',
  'visibility.code': 'code secret',
  'visibility.link': 'lien',
  'visibility.public': 'public',
};

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, fr };

type PluralBase = { [K in MessageKey]: K extends `${infer B}.one` ? B : never }[MessageKey];
type Params = Record<string, string | number>;

const interpolate = (s: string, params?: Params) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));

/** Message in `locale`; for plural keys (`x.one` / `x.other`) pass the base key and `n`. */
export function tr(locale: Locale, key: MessageKey | PluralBase, params?: Params): string {
  const dict = MESSAGES[locale];
  if (key in dict) return interpolate(dict[key as MessageKey], params);
  const n = Number(params?.n ?? 0);
  const form = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other';
  return interpolate(dict[`${key}.${form}` as MessageKey], params);
}

export function parseLocaleSetting(raw: string | undefined): LocaleSetting {
  if (raw === undefined || raw === '') return 'en';
  if (raw === 'auto' || (LOCALES as readonly string[]).includes(raw)) return raw as LocaleSetting;
  throw new Error(`HUB_LOCALE must be one of: ${LOCALES.join(', ')}, auto`);
}

/** Locale of a visitor page: the fixed setting, or with `auto` the best en/fr match of Accept-Language (en otherwise). */
export function pickLocale(setting: LocaleSetting, acceptLanguage: string | undefined): Locale {
  if (setting !== 'auto') return setting;
  let best: Locale = 'en';
  let bestQ = 0;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const [tag, ...attrs] = part.trim().split(';');
    const lang = tag.trim().toLowerCase().split('-')[0];
    if (!(LOCALES as readonly string[]).includes(lang)) continue;
    const qAttr = attrs.map((a) => a.trim()).find((a) => a.startsWith('q='));
    const q = qAttr ? Number(qAttr.slice(2)) : 1;
    if (Number.isFinite(q) && q > bestQ) {
      best = lang as Locale;
      bestQ = q;
    }
  }
  return best;
}

/** Locale of pages rendered once and stored on disk (Markdown/JSON readers): `auto` has no visitor yet, so English. */
export function staticLocale(setting: LocaleSetting): Locale {
  return setting === 'auto' ? 'en' : setting;
}
