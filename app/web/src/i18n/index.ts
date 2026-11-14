import { useSyncExternalStore } from 'react';
import { detectLocale, interpolate, pluralForm, type Locale, type Params } from './core.ts';
import { en, type MessageKey, type Messages } from './en.ts';
import { fr } from './fr.ts';

export type { Locale, MessageKey };

const DICTS: Record<Locale, Messages> = { en, fr };
const STORAGE_KEY = 'blazz-artifacts:locale';

/** Base of a plural pair: `x` when the dictionary has `x.one` and `x.other`. */
export type PluralKey = { [K in MessageKey]: K extends `${infer B}.one` ? B : never }[MessageKey];

function readSaved(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage unavailable (private browsing): the browser language decides
  }
}

let current: Locale = detectLocale(readSaved(), typeof navigator === 'undefined' ? null : navigator.language);
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export const getLocale = (): Locale => current;

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // the choice lasts for this page only
  }
  document.documentElement.lang = next;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Re-renders the caller when the language changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribe, getLocale, getLocale);

export function t(key: MessageKey, params?: Params): string {
  return interpolate(DICTS[current][key], params);
}

// One number format per locale: tn() runs for every card on every render.
const numberFormats = new Map<Locale, Intl.NumberFormat>();
function numberFormat(locale: Locale): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale);
    numberFormats.set(locale, f);
  }
  return f;
}

/** Plural message: `{n}` is `n` formatted for the active locale unless `params.n` is given. */
export function tn(key: PluralKey, n: number, params?: Params): string {
  const msg = DICTS[current][`${key}.${pluralForm(current, n)}` as MessageKey];
  return interpolate(msg, { n: numberFormat(current).format(n), ...params });
}

/** Localised text of an API error code, or null if the code is unknown to this UI. */
export function errorText(code: unknown, params?: Params): string | null {
  if (typeof code !== 'string') return null;
  const key = `error.${code}` as MessageKey;
  return key in DICTS[current] ? interpolate(DICTS[current][key], params) : null;
}
