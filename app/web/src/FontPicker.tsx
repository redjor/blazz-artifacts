import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api.ts';
import { t } from './i18n/index.ts';
import type { GoogleFontFamily, ThemeFont } from './types.ts';

const field = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-base hover:border-line-strong';
const normalize = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Native keyboard selection; font binaries are fetched only on preview/save. */
export function FontPicker({ value, onChange }: { value: ThemeFont; onChange: (font: ThemeFont) => void }) {
  const id = useId();
  const select = useRef<HTMLSelectElement>(null);
  const [catalog, setCatalog] = useState<GoogleFontFamily[]>([]);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    api.themeFonts().then(({ fonts }) => {
      if (live) { setCatalog(fonts); setState('ready'); }
    }, () => { if (live) setState('error'); });
    return () => { live = false; };
  }, [attempt]);
  const needle = normalize(query.trim());
  const filtered = catalog.filter(font => normalize(font.family).includes(needle));
  const selectedFamily = value.startsWith('google:') ? value.slice(7) : null;
  const retainSelection = selectedFamily && !filtered.some(font => font.family === selectedFamily);
  return <div className="space-y-2">
    <label htmlFor={`${id}-font`} className="block text-sm">{t('themes.font')}</label>
    <label htmlFor={`${id}-search`} className="sr-only">{t('themes.fontSearch')}</label>
    <input id={`${id}-search`} name="fontSearch" type="search" autoComplete="off" spellCheck={false}
      className={field} value={query} placeholder={t('themes.fontSearch')}
      aria-controls={`${id}-font`} onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); select.current?.focus(); } }} />
    <select ref={select} id={`${id}-font`} name="font" size={7} className={`${field} min-h-48`} value={value}
      aria-describedby={`${id}-help ${id}-status`} onChange={(e) => onChange(e.target.value as ThemeFont)}>
      <optgroup label={t('themes.fontStandard')}>
        <option value="sans">Figtree — {t('themes.sans')}</option>
        <option value="serif">Georgia — {t('themes.serif')}</option>
        <option value="mono">{t('themes.mono')}</option>
      </optgroup>
      {retainSelection && <optgroup label={t('themes.fontSelected')}><option value={value}>{selectedFamily}</option></optgroup>}
      {filtered.length > 0 && <optgroup label="Google Fonts">
        {filtered.map(font => <option key={font.family} value={`google:${font.family}`}>{font.family}</option>)}
      </optgroup>}
    </select>
    <p id={`${id}-status`} role="status" className="text-xs text-muted">
      {state === 'loading' ? t('common.loading') : state === 'error' ? t('themes.fontLoadFailed') : t('themes.fontCount', { count: filtered.length, total: catalog.length })}
    </p>
    {state === 'error' && <button type="button" className="rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2" onClick={() => { setState('loading'); setAttempt(n => n + 1); }}>{t('common.retry')}</button>}
    <p id={`${id}-help`} className="text-xs text-muted">{t('themes.fontHint')}</p>
  </div>;
}
