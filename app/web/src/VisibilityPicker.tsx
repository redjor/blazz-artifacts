import { useId } from 'react';
import { visibilityHint, visibilityLabel } from './format.ts';
import { t } from './i18n/index.ts';
import { VISIBILITY_ICON } from './icons.tsx';
import type { Visibility } from './types.ts';

const ORDER: Visibility[] = ['private', 'code', 'link', 'public'];

/** Native radio group (arrows to change): drawn check and strong border, not colour alone. */
export function VisibilityPicker({ value, onChange }: { value: Visibility; onChange: (v: Visibility) => void }) {
  const name = useId();
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="mb-1 text-sm text-muted">{t('common.visibility')}</legend>
      {ORDER.map((v) => {
        const on = value === v;
        const Icon = VISIBILITY_ICON[v];
        return (
          <label key={v}
            className={`relative flex cursor-pointer gap-3 rounded-xl border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${on ? 'border-ink bg-surface-2' : 'border-line hover:border-line-strong'}`}>
            <input type="radio" name={name} value={v} checked={on} onChange={() => onChange(v)} className="sr-only" />
            <Icon className={`mt-0.5 size-4 ${on ? 'text-ink' : 'text-muted'}`} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{visibilityLabel(v)}</span>
              <span className="block text-xs text-muted">{visibilityHint(v)}</span>
            </span>
            <span aria-hidden="true" className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] ${on ? 'border-ink' : 'border-line-strong'}`}>
              {on && <span className="size-2 rounded-full bg-ink" />}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
