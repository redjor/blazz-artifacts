import { useId, useState } from 'react';
import { MAX_TAGS, normalizeLabel } from './format.ts';
import { t } from './i18n/index.ts';
import { CloseIcon } from './icons.tsx';

const field = 'w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm hover:border-line-strong';

export function ProjectInput({ value, onChange, projects }: { value: string; onChange: (v: string) => void; projects: string[] }) {
  const listId = useId();
  const invalid = value.trim() !== '' && normalizeLabel(value) === null;
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-muted">{t('labels.folder')}</span>
      <input list={listId} value={value} maxLength={64} onChange={(e) => onChange(e.target.value)} placeholder={t('common.namePlaceholder')} autoComplete="off" className={field} />
      <datalist id={listId}>{projects.map((p) => <option key={p} value={p} />)}</datalist>
      {invalid && <span className="text-xs text-danger">{t('labels.invalid')}</span>}
    </label>
  );
}

export function TagsInput({ value, onChange, suggestions }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[] }) {
  const listId = useId();
  const [text, setText] = useState('');

  const commit = (raw: string) => {
    const next = [...value];
    for (const part of raw.split(',')) {
      const tag = normalizeLabel(part);
      if (tag && !next.includes(tag) && next.length < MAX_TAGS) next.push(tag);
    }
    onChange(next.sort());
    setText('');
  };

  return (
    <div className="space-y-1 text-sm">
      <label className="block text-muted" htmlFor={`${listId}-in`}>{t('gallery.tags')}</label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 hover:border-line-strong has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-ring">
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2 pr-1 text-xs">
            {tag}
            <button type="button" aria-label={t('labels.remove', { tag })} onClick={() => onChange(value.filter((x) => x !== tag))} className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-ink"><CloseIcon className="size-3" /></button>
          </span>
        ))}
        <input id={`${listId}-in`} list={listId} value={text} autoComplete="off" placeholder={value.length ? '' : t('labels.addTag')}
          onChange={(e) => (e.target.value.includes(',') ? commit(e.target.value) : setText(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (text.trim()) commit(text);
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => text.trim() && commit(text)}
          className="min-w-24 flex-1 bg-transparent px-1 py-0.5 outline-none focus-visible:outline-none" />
        <datalist id={listId}>{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
      </div>
      <span className="block text-xs text-muted">{t('labels.hint', { n: value.length, max: MAX_TAGS })}</span>
    </div>
  );
}
