import type { ReactNode } from 'react';
import { FolderLink } from './FolderLink.tsx';
import { t } from './i18n/index.ts';

/**
 * Folder page path, in the top bar: every ancestor as a link (no access filtering here), then `current`
 * (the open folder, usually its actions menu). On mobile, intermediate ancestors collapse into “…”.
 */
export function FolderBreadcrumb({ trail, current, onOpen }: {
  trail: { name: string | null; title: string }[]; current: ReactNode; onOpen: (name: string | null) => void;
}) {
  return (
    <nav aria-label={t('tree.breadcrumb')} className="min-w-0">
      <ol className="flex min-w-0 items-center text-[15px]">
        {trail.map((item, i) => (
          <li key={item.name ?? '~root'} className={`flex min-w-0 items-center ${i > 0 ? 'max-sm:hidden' : 'shrink-0'}`}>
            <FolderLink name={item.name} onOpen={() => onOpen(item.name)} title={item.title}
              className="block max-w-[12rem] truncate rounded-md px-1.5 py-1 text-ink hover:bg-surface-2">{item.title}</FolderLink>
            <span aria-hidden="true" className="shrink-0 px-1 text-muted">/</span>
          </li>
        ))}
        {trail.length > 1 && (
          <li aria-hidden="true" className="flex shrink-0 items-center text-muted sm:hidden">
            <span className="px-1.5">…</span><span className="px-1">/</span>
          </li>
        )}
        <li aria-current="page" className="flex min-w-0 items-center">{current}</li>
      </ol>
    </nav>
  );
}
