import { useEffect, useRef } from 'react';
import { deletedText, formatDay } from './format.ts';
import { t, tn } from './i18n/index.ts';
import { KIND_ICON, TrashIcon } from './icons.tsx';
import type { TrashItemDto } from './types.ts';

/**
 * The /trash page (design 04): deleted artifacts, newest deletion first, each restorable or deletable for good
 * until the purge. After an action, focus stays in the list (same row position) or returns to the heading.
 */
export function TrashView({ items, days, folderTitle, pending, onRestore, onDelete, onEmpty }: {
  items: TrashItemDto[]; days: number; folderTitle: (name: string) => string;
  /** Id of the row being restored or deleted (its buttons are disabled meanwhile); "all" while emptying. */
  pending: string | null;
  onRestore: (item: TrashItemDto) => void; onDelete: (item: TrashItemDto) => void; onEmpty: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const focusAfter = useRef<number | null>(null);
  const act = (i: number, fn: () => void) => {
    focusAfter.current = i;
    fn();
  };
  useEffect(() => {
    if (focusAfter.current === null) return;
    const rows = list.current?.querySelectorAll<HTMLButtonElement>('[data-restore]') ?? [];
    const i = Math.min(focusAfter.current, rows.length - 1);
    focusAfter.current = null;
    (i >= 0 ? rows[i] : heading.current)?.focus();
  }, [items]);

  return (
    <>
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-3">
        <h1 ref={heading} tabIndex={-1} className="min-w-0 grow basis-0 truncate font-serif text-[2rem] leading-tight font-semibold tracking-[-0.02em] outline-none sm:text-[2.25rem]">
          {t('trash.title')}
        </h1>
        {items.length > 0 && (
          <button type="button" disabled={pending !== null} onClick={() => act(0, onEmpty)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-sm font-medium hover:bg-surface-3 disabled:opacity-50">
            <TrashIcon className="size-4 text-muted" />{t('trash.emptyAll')}
          </button>
        )}
      </div>
      {days > 0 && <p className="mt-2 text-sm text-muted">{tn('trash.hint', days)}</p>}

      <section aria-label={t('trash.list')} className="mt-8 sm:mt-10">
        {items.length === 0 ? (
          <p className="px-6 py-16 text-center text-base text-muted sm:py-20">{t('trash.empty')}</p>
        ) : (
          <ul ref={list} className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {items.map((a, i) => {
              const Icon = KIND_ICON[a.kind];
              const busy = pending === a.id || pending === 'all';
              return (
                <li key={a.id} className="flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
                  <span aria-hidden="true" className={`band kind-${a.kind} grid size-10 shrink-0 place-items-center rounded-lg`}><Icon className="glyph size-5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px]">{a.title}</span>
                    <span className="block text-[13px] leading-5 text-muted sm:truncate">
                      {deletedText(a.deletedAt)}
                      {a.project && ` · ${t('trash.inFolder', { folder: folderTitle(a.project) })}`}
                      {a.purgeAt && ` · ${t('trash.purgeOn', { date: formatDay(a.purgeAt) })}`}
                    </span>
                  </span>
                  <div className="flex shrink-0 gap-1 text-sm">
                    <button type="button" data-restore disabled={busy} onClick={() => act(i, () => onRestore(a))} aria-label={t('trash.restoreLabel', { title: a.title })}
                      className="rounded-lg px-2.5 py-1.5 hover:bg-surface-2 disabled:opacity-50">{t('trash.restore')}</button>
                    <button type="button" disabled={busy} onClick={() => act(i, () => onDelete(a))} aria-label={t('trash.deleteLabel', { title: a.title })}
                      className="inline-flex items-center rounded-lg px-2.5 py-1.5 text-danger hover:bg-danger/10 disabled:opacity-50">
                      <TrashIcon className="size-4 sm:hidden" /><span className="max-sm:hidden">{t('trash.delete')}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
