import { useId } from 'react';
import { visibilityHint, visibilityLabel } from './format.ts';
import { t } from './i18n/index.ts';
import { VISIBILITY_ICON } from './icons.tsx';
import type { Visibility } from './types.ts';

const ORDER: Visibility[] = ['private', 'code', 'link', 'public'];

/**
 * Native radio group (arrows to change): drawn check and strong border, not colour alone.
 * `compact`: one column of short rows without hints (the share popover).
 */
export function VisibilityPicker({ value, onChange, compact = false, disabled = false }: {
  value: Visibility; onChange: (v: Visibility) => void; compact?: boolean; disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className={compact ? 'grid gap-1' : 'grid gap-2 sm:grid-cols-2'}>
      <legend className={compact ? 'mb-1.5 px-1 text-xs font-medium text-muted' : 'mb-1 text-sm text-muted'}>{t('common.visibility')}</legend>
      {ORDER.map((v) => {
        const on = value === v;
        const Icon = VISIBILITY_ICON[v];
        return (
          <label key={v}
            className={`relative flex cursor-pointer text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[:disabled]:cursor-default ${compact ? 'items-center gap-2.5 rounded-lg px-2.5 py-2' : 'gap-3 rounded-xl border p-3'} ${on ? (compact ? 'bg-surface-2' : 'border-ink bg-surface-2') : (compact ? 'hover:bg-surface-2' : 'border-line hover:border-line-strong')}`}>
            <input type="radio" name={name} value={v} checked={on} onChange={() => onChange(v)} className="sr-only" />
            <Icon className={`size-4 ${compact ? '' : 'mt-0.5'} ${on ? 'text-ink' : 'text-muted'}`} />
            <span className="min-w-0 flex-1">
              <span className={`block ${on || !compact ? 'font-medium' : ''}`}>{visibilityLabel(v)}</span>
              {!compact && <span className="block text-xs text-muted">{visibilityHint(v)}</span>}
            </span>
            <span aria-hidden="true" className={`grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] ${compact ? '' : 'mt-0.5'} ${on ? 'border-ink' : 'border-line-strong'}`}>
              {on && <span className="size-2 rounded-full bg-ink" />}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
