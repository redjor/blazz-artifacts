import { t } from './i18n/index.ts';

/** Admin folder path: every ancestor (no access filtering here), the last item is the current folder. */
export function FolderBreadcrumb({ trail, onOpen }: {
  trail: { name: string | null; title: string }[]; onOpen: (name: string | null) => void;
}) {
  return (
    <nav aria-label={t('tree.breadcrumb')} className="mb-4 sm:mb-5">
      <ol className="flex flex-wrap items-center gap-1 text-[15px]">
        {trail.map((item, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={item.name ?? '~root'} className="flex min-w-0 items-center gap-1">
              {last
                ? <span aria-current="page" className="min-w-0 truncate">{item.title}</span>
                : <button type="button" onClick={() => onOpen(item.name)} className="-mx-1.5 rounded-md px-1.5 py-0.5 text-muted underline decoration-transparent underline-offset-4 hover:text-ink hover:decoration-line-strong">{item.title}</button>}
              {!last && <span aria-hidden="true" className="shrink-0 text-muted">/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
