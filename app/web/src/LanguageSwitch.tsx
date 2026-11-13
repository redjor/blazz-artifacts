import { getLocale, setLocale, t, useLocale } from './i18n/index.ts';

/** Two-language toggle: shows the other language's code, announces the current one. */
export function LanguageSwitch({ className = '' }: { className?: string }) {
  useLocale();
  return (
    <button type="button" onClick={() => setLocale(getLocale() === 'fr' ? 'en' : 'fr')} aria-label={t('lang.switch')} data-tip={t('lang.targetName')}
      className={`tip tip-end relative grid h-10 min-w-10 place-items-center rounded-full px-2 text-[13px] font-medium tracking-wide text-muted hover:bg-surface-2 hover:text-ink ${className}`}>
      <span lang={t('lang.targetCode')}>{t('lang.targetShort')}</span>
    </button>
  );
}
