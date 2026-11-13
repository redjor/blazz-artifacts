import { useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { useLayer } from './layers.ts';

export interface PopoverHandle { open: () => void }

/**
 * Button + floating panel anchored below. Closes on outside click, Escape (only the top layer closes,
 * focus returns to the button), focus leaving. On open, focus goes to [data-autofocus], else the first focusable element.
 */
export function Popover({ label, tip, trigger, triggerClass, panelClass, wrapClass = 'relative', align = 'end', tabIndex, onOpenChange, ref, children }: {
  label: string; tip?: string; trigger: ReactNode; triggerClass: string; panelClass: string; align?: 'start' | 'end'; tabIndex?: number;
  /** Positioning container; “relative max-sm:static” anchors the panel on a wider ancestor on mobile. */
  wrapClass?: string;
  onOpenChange?: (open: boolean) => void; ref?: Ref<PopoverHandle>; children: (close: () => void) => ReactNode;
}) {
  const [open, setOpenState] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const notify = useRef(onOpenChange);
  useEffect(() => {
    notify.current = onOpenChange;
  });

  const setOpen = (v: boolean) => {
    setOpenState(v);
    notify.current?.(v);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  useLayer({ el: panel, modal: false, active: open, onEscape: () => close() });

  useEffect(() => {
    if (!open) return;
    const p = panel.current;
    (p?.querySelector<HTMLElement>('[data-autofocus]') ?? p?.querySelector<HTMLElement>('button, input, [tabindex]'))?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setOpenState(false);
        notify.current?.(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <div ref={wrap} className={wrapClass}
      onBlur={(e) => { if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <button ref={button} type="button" aria-label={label} data-tip={tip} aria-expanded={open} aria-controls={open ? id : undefined} tabIndex={tabIndex}
        onClick={() => setOpen(!open)} className={triggerClass}>
        {trigger}
      </button>
      {open && (
        <div ref={panel} id={id} role="group" aria-label={label}
          className={`enter-pop surface-raised absolute top-full z-40 mt-2 rounded-xl bg-surface ${align === 'end' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'} ${panelClass}`}>
          {children(() => close())}
        </div>
      )}
    </div>
  );
}
