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

// One PluralRules per locale: building one costs far more than select(), and tn() runs for every card.
const pluralRules = new Map<Locale, Intl.PluralRules>();

/** CLDR plural category reduced to the two forms the dictionaries carry. */
export function pluralForm(locale: Locale, n: number): 'one' | 'other' {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(n) === 'one' ? 'one' : 'other';
}
