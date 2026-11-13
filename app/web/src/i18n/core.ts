// Pure helpers (no DOM): shared by the SPA and the dictionary tests.
export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
export type Params = Record<string, string | number>;

/** Replaces `{name}` with `params.name`; unknown placeholders are left as they are. */
export function interpolate(s: string, params?: Params): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));
}

/** Saved preference first, then the browser language (fr* → fr), English otherwise. */
export function detectLocale(saved: string | null | undefined, browser: string | null | undefined): Locale {
  if (saved && (LOCALES as readonly string[]).includes(saved)) return saved as Locale;
  return browser?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** CLDR plural category reduced to the two forms the dictionaries carry. */
export const pluralForm = (locale: Locale, n: number): 'one' | 'other' =>
  new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other';
