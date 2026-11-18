import { useId } from 'react';
import { visibilityHint, visibilityLabel } from './format.ts';
import { t } from './i18n/index.ts';
import { VISIBILITY_ICON } from './icons.tsx';
import type { Visibility } from './types.ts';

const ORDER: Visibility[] = ['private', 'code', 'link', 'public'];

/**
 * Visibility choice: drawn check and strong border, not colour alone. A draft (publish dialog, folder panel) is a native
 * radio group: arrows move the choice. `immediate` (design 13: the choice is applied at once) uses toggle buttons
 * instead, so arrows never apply anything: Tab to an option, then Enter or Space. `compact`: one column of short rows
 * without hints (the share popover).
 */
export function VisibilityPicker({ value, onChange, compact = false, disabled = false, immediate = false }: {
  value: Visibility; onChange: (v: Visibility) => void; compact?: boolean; disabled?: boolean; immediate?: boolean;
}) {
  const name = useId();
  const legendId = useId();
  const row = (v: Visibility) => {
    const on = value === v;
    const Icon = VISIBILITY_ICON[v];
    const box = `relative flex w-full cursor-pointer text-left text-sm disabled:cursor-default has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-[:disabled]:cursor-default ${compact ? 'items-center gap-2.5 rounded-lg px-2.5 py-2' : 'gap-3 rounded-xl border p-3'} ${on ? (compact ? 'bg-surface-2' : 'border-ink bg-surface-2') : (compact ? 'hover:bg-surface-2' : 'border-line hover:border-line-strong')}`;
    const content = (
      <>
        <Icon className={`size-4 ${compact ? '' : 'mt-0.5'} ${on ? 'text-ink' : 'text-muted'}`} />
        <span className="min-w-0 flex-1">
          <span className={`block ${on || !compact ? 'font-medium' : ''}`}>{visibilityLabel(v)}</span>
          {!compact && <span className="block text-xs text-muted">{visibilityHint(v)}</span>}
        </span>
        <span aria-hidden="true" className={`grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] ${compact ? '' : 'mt-0.5'} ${on ? 'border-ink' : 'border-line-strong'}`}>
          {on && <span className="size-2 rounded-full bg-ink" />}
        </span>
      </>
    );
    if (immediate) {
      return (
        // aria-disabled, not disabled: the pressed button keeps focus while the change is saved.
        <button key={v} type="button" aria-pressed={on} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onChange(v); }}
          className={`${box} aria-disabled:cursor-default aria-disabled:opacity-60`}>
          {content}
        </button>
      );
    }
    return (
      <label key={v} className={box}>
        <input type="radio" name={name} value={v} checked={on} onChange={() => onChange(v)} className="sr-only" />
        {content}
      </label>
    );
  };
  const grid = compact ? 'grid gap-1' : 'grid gap-2 sm:grid-cols-2';
  const legend = compact ? 'mb-1.5 px-1 text-xs font-medium text-muted' : 'mb-1 text-sm text-muted';
  if (immediate) {
    return (
      <div role="group" aria-labelledby={legendId}>
        <p id={legendId} className={legend}>{t('common.visibility')}</p>
        <div className={grid}>{ORDER.map(row)}</div>
      </div>
    );
  }
  return (
    <fieldset disabled={disabled} className={grid}>
      <legend className={legend}>{t('common.visibility')}</legend>
      {ORDER.map(row)}
    </fieldset>
  );
}
