import { useEffect, useRef, type RefObject } from 'react';

/**
 * Stack of open layers (dialogs, panel, menus). Escape only closes the top layer.
 * A modal layer makes the rest of the page inert (#root and the modal layers below),
 * locks page scrolling and keeps Tab inside.
 */
interface Layer {
  modal: boolean;
  el: RefObject<HTMLElement | null>;
  onEscape: () => void;
}

const stack: Layer[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert]'));
}

function sync() {
  const modals = stack.filter((l) => l.modal);
  const top = modals.at(-1);
  document.getElementById('root')?.toggleAttribute('inert', !!top);
  for (const l of modals) l.el.current?.toggleAttribute('inert', l !== top);
  document.documentElement.classList.toggle('scroll-locked', !!top);
}

function onKeyDown(e: KeyboardEvent) {
  const top = stack.at(-1);
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;
    e.preventDefault();
    top.onEscape();
    return;
  }
  if (e.key !== 'Tab' || !top.modal || !top.el.current) return;
  // Tab / Shift+Tab loop inside the modal layer (the rest is inert, but the browser would move to its address bar).
  const list = focusables(top.el.current);
  if (list.length === 0) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  const inside = top.el.current.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

/** True when a layer (menu, dialog, panel) is open: gallery shortcuts stay quiet. */
export const hasOpenLayer = () => stack.length > 0;

export function useLayer({ el, modal, onEscape, restoreFocus, fallbackFocus, active = true }: {
  el: RefObject<HTMLElement | null>;
  modal: boolean;
  onEscape: () => void;
  /** Element to refocus on close (default: the one that had focus when it opened). */
  restoreFocus?: () => HTMLElement | null | undefined;
  /** When the element to refocus is gone (e.g. a deleted folder's card). */
  fallbackFocus?: () => HTMLElement | null | undefined;
  active?: boolean;
}) {
  const escape = useRef(onEscape);
  const restore = useRef(restoreFocus);
  const fallback = useRef(fallbackFocus);
  useEffect(() => {
    escape.current = onEscape;
    restore.current = restoreFocus;
    fallback.current = fallbackFocus;
  });

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const layer: Layer = { modal, el, onEscape: () => escape.current() };
    if (stack.length === 0) window.addEventListener('keydown', onKeyDown);
    stack.push(layer);
    sync();
    if (modal && el.current) {
      const target = el.current.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(el.current)[0];
      target?.focus({ preventScroll: true });
    }
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) window.removeEventListener('keydown', onKeyDown);
      sync();
      if (!modal) return;
      const back = restore.current?.() ?? previous;
      if (back?.isConnected) back.focus({ preventScroll: true });
      else fallback.current?.()?.focus({ preventScroll: true });
    };
  }, [active, modal, el]);
}

/** Text field: the user types in it, so shortcuts stay quiet. */
export function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}
