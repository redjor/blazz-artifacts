import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n/index.ts';
import { CloseIcon } from './icons.tsx';
import { useLayer } from './layers.ts';

/** Modal dialog: trapped focus, inert and frozen page, Escape closes, focus returned to the trigger. */
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const layer = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer({ el: layer, modal: true, onEscape: onClose });

  return createPortal(
    <div ref={layer} className="enter-fade fixed inset-0 z-40 flex items-end justify-center overscroll-contain bg-[var(--scrim)] sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}
        className={`enter-rise surface-raised max-h-[92dvh] w-full overflow-y-auto overscroll-contain rounded-t-[24px] bg-surface p-5 sm:rounded-[24px] sm:p-6 ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 id={titleId} className="min-w-0 pt-0.5 font-serif text-2xl leading-tight font-semibold tracking-[-0.015em] text-balance break-words">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="-mt-1 -mr-1 grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"><CloseIcon /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
