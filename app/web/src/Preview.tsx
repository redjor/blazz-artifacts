import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, openPreview } from './api.ts';
import { formatDate, kindLabel, visibilityLabel } from './format.ts';
import { t } from './i18n/index.ts';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, EyeIcon, OpenIcon, SlidersIcon, VISIBILITY_ICON } from './icons.tsx';
import { isEditable, useLayer } from './layers.ts';
import type { ArtifactDto, Kind, VersionDto } from './types.ts';

// Live preview in the artifact panel and quick look (design 14). The artifact is framed on a signed admin preview
// path of the content origin (the admin CSP allows that origin in frame-src, the content server lets the admin origin
// frame signed paths). On top of the server's CSP sandbox, the iframe gets its own sandbox: no same origin, no top
// navigation, no modal dialogs over the admin. Chrome refuses PDFs in a sandboxed frame: a PDF has no script anyway.
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
/** By the kind of the version shown (an older version may be of another kind than the artifact today). */
const sandboxFor = (kind: Kind, minimal = false) => (kind === 'pdf' ? undefined : minimal ? 'allow-scripts' : SANDBOX);

/** Pages that lay themselves out; readers and PDFs follow the frame. */
const sized = (kind: Kind) => kind === 'html' || kind === 'site';

/** Signed preview address of the current version (valid an hour); null while loading, 'failed' on error. */
function usePreviewUrl(id: string, versionId: string | null | undefined): string | null | 'failed' {
  const [state, setState] = useState<{ key: string; url: string | null | 'failed' }>({ key: '', url: null });
  const key = `${id}/${versionId ?? ''}`;
  useEffect(() => {
    if (!versionId) return;
    let live = true;
    api.preview(id).then((r) => live && setState({ key, url: r.url }), () => live && setState({ key, url: 'failed' }));
    return () => {
      live = false;
    };
  }, [id, versionId, key]);
  return state.key === key ? state.url : null;
}

/** The artifact itself at the top of the panel, scaled down, not interactive: a click opens the quick look. */
export function LivePreview({ a, onQuickLook }: { a: ArtifactDto; onQuickLook: () => void }) {
  const url = usePreviewUrl(a.id, a.version?.id);
  if (!a.version) return null;
  return (
    <div className="relative aspect-[8/5] w-full overflow-hidden rounded-xl border border-line bg-white">
      {url && url !== 'failed' && (
        // Inert: an artifact that focuses itself on load must not pull focus into this picture of it. Scripts only.
        <iframe key={url} src={url} title={t('preview.frameTitle', { title: a.title })} tabIndex={-1} aria-hidden="true" inert loading="lazy" sandbox={sandboxFor(a.kind, true)}
          className={`pointer-events-none absolute top-0 left-0 border-0 ${sized(a.kind) ? 'h-[200%] w-[200%] origin-top-left scale-50' : 'size-full'}`} />
      )}
      {url === 'failed' && <p className="grid size-full place-items-center bg-surface-2 text-sm text-muted">{t('preview.failed')}</p>}
      <button type="button" onClick={onQuickLook} aria-label={t('preview.quickLookLabel', { title: a.title })} aria-keyshortcuts="Space"
        className="group absolute inset-0 flex items-end justify-end p-3 outline-offset-[-3px]">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1.5 text-xs font-medium text-white shadow-sm ring-1 ring-white/15 transition-colors group-hover:bg-black/80">
          <EyeIcon className="size-3.5" />{t('preview.quickLook')}
        </span>
      </button>
    </div>
  );
}

type Screen = 'desktop' | 'tablet' | 'mobile';
const SCREENS: Screen[] = ['desktop', 'tablet', 'mobile'];
const SCREEN_CLASS: Record<Screen, string> = {
  desktop: 'size-full',
  tablet: 'h-full max-h-[1180px] w-[820px] max-w-full rounded-2xl border border-line shadow-lg',
  mobile: 'h-full max-h-[844px] w-[390px] max-w-full rounded-[1.75rem] border border-line shadow-lg',
};

/**
 * Full-window look at an artifact without leaving the gallery: ←/→ through the gallery's order, Space or Esc to close,
 * screen sizes for HTML pages and sites, then “Open in a tab” or “Manage”.
 */
export function QuickLook({ id, order, items, onNavigate, onClose, onManage, onError, restoreFocus }: {
  id: string; order: string[]; items: ArtifactDto[];
  onNavigate: (id: string) => void; onClose: () => void; onManage: (id: string) => void; onError: (m: string) => void;
  /** Where focus goes back on close (default: where it was when the quick look opened). */
  restoreFocus?: () => HTMLElement | null;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<Screen>('desktop');
  const a = items.find((x) => x.id === id);
  const url = usePreviewUrl(id, a?.version?.id);
  useLayer({ el: layer, modal: true, onEscape: onClose, restoreFocus });

  const index = order.indexOf(id);
  const go = (delta: number) => {
    const next = index < 0 ? undefined : order[index + delta];
    if (next) onNavigate(next);
  };
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        go(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === ' ') {
        // On one of its own controls, Space activates that control (the Close button included).
        if ((e.target as HTMLElement | null)?.closest?.('button, a, select, input, textarea, [role="radio"]')) return;
        e.preventDefault();
        onClose();
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!a) return null;
  const VisIcon = VISIBILITY_ICON[a.visibility];
  const btn = 'tip grid size-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent';
  const shownScreen = sized(a.kind) ? screen : 'desktop';
  return createPortal(
    <div ref={layer} className="fixed inset-0 z-50">
      <div aria-hidden="true" className="drawer-scrim absolute inset-0 bg-[var(--scrim)]" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={t('preview.dialogLabel', { title: a.title })}
        className="enter-pop absolute inset-0 flex flex-col overflow-hidden bg-surface sm:inset-4 sm:rounded-2xl sm:shadow-[0_24px_60px_-20px_oklch(0.2_0.02_70/0.45),0_0_0_1px_var(--line)]">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2 sm:px-4">
          <div className="flex items-center gap-0.5">
            <button type="button" className={btn} disabled={index <= 0} onClick={() => go(-1)} aria-label={t('preview.prev')} data-tip={t('preview.prev')} aria-keyshortcuts="ArrowLeft"><ChevronLeftIcon /></button>
            <button type="button" className={btn} disabled={index < 0 || index >= order.length - 1} onClick={() => go(1)} aria-label={t('preview.next')} data-tip={t('preview.next')} aria-keyshortcuts="ArrowRight"><ChevronRightIcon /></button>
            {index >= 0 && <span className="ml-1 text-[13px] text-muted tabular-nums">{index + 1} / {order.length}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-medium">{a.title}</h2>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              {kindLabel(a.kind)}{a.version && <span className="tabular-nums">· v{a.version.number}</span>}
              <span aria-hidden="true">·</span><VisIcon className="size-3.5" />{visibilityLabel(a.visibility)}
            </p>
          </div>
          {sized(a.kind) && (
            <div role="radiogroup" aria-label={t('preview.screen')} className="hidden items-center gap-0.5 rounded-full bg-surface-2 p-0.5 md:flex">
              {SCREENS.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={screen === s} onClick={() => setScreen(s)}
                  className={`rounded-full px-3 py-1 text-xs ${screen === s ? 'bg-surface font-medium text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
                  {t(`preview.screen.${s}`)}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-0.5">
            <button type="button" className={btn} onClick={() => openPreview(a.id).catch((e) => onError((e as Error).message))} aria-label={t('preview.openTab')} data-tip={t('preview.openTab')}><OpenIcon /></button>
            <button type="button" className={btn} onClick={() => onManage(a.id)} aria-label={t('common.manage')} data-tip={t('common.manage')}><SlidersIcon /></button>
            <button type="button" className={`${btn} tip-end`} onClick={onClose} aria-label={t('common.close')} data-tip={t('preview.closeTip')} data-autofocus><CloseIcon /></button>
          </div>
        </header>
        <div className={`grid min-h-0 flex-1 place-items-center overflow-auto ${shownScreen === 'desktop' ? '' : 'bg-surface-2 p-4 sm:p-6'}`}>
          {url === 'failed' ? <p className="text-sm text-muted">{t('preview.failed')}</p>
            : !url ? <p className="text-sm text-muted">{t('common.loading')}</p>
              : <iframe key={url} src={url} title={t('preview.frameTitle', { title: a.title })} sandbox={sandboxFor(a.kind)} className={`block border-0 bg-white ${SCREEN_CLASS[shownScreen]}`} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Pinned preview address of one kept version (valid an hour); null while loading, 'failed' on error. */
function useVersionUrl(artifactId: string, versionId: string): string | null | 'failed' {
  const [state, setState] = useState<{ key: string; url: string | null | 'failed' }>({ key: '', url: null });
  const key = `${artifactId}/${versionId}`;
  useEffect(() => {
    let live = true;
    api.versionPreview(artifactId, versionId).then((r) => live && setState({ key, url: r.url }), () => live && setState({ key, url: 'failed' }));
    return () => {
      live = false;
    };
  }, [artifactId, versionId, key]);
  return state.key === key ? state.url : null;
}

function ComparePane({ a, v, versions, screen, onPick, side }: {
  a: ArtifactDto; v: VersionDto; versions: VersionDto[]; screen: Screen; onPick: (versionId: string) => void; side: 'left' | 'right';
}) {
  const url = useVersionUrl(a.id, v.id);
  const pickId = useId();
  return (
    <section className="flex min-h-0 min-w-0 flex-col" aria-label={t(side === 'left' ? 'compare.left' : 'compare.right')}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2 text-sm">
        <label className="sr-only" htmlFor={pickId}>{t(side === 'left' ? 'compare.left' : 'compare.right')}</label>
        <select id={pickId} value={v.id} onChange={(e) => onPick(e.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm font-medium tabular-nums hover:border-line-strong">
          {versions.map((x) => <option key={x.id} value={x.id}>{`v${x.number}${x.current ? ` · ${t('history.current')}` : ''}`}</option>)}
        </select>
        <span className="text-xs text-muted">{formatDate(v.createdAt)}</span>
        {v.message && <span className="min-w-0 flex-1 truncate text-xs" title={v.message}>{v.message}</span>}
      </div>
      <div className={`grid min-h-0 flex-1 place-items-center overflow-auto ${screen === 'desktop' ? '' : 'bg-surface-2 p-3'}`}>
        {url === 'failed' ? <p className="text-sm text-muted">{t('preview.failed')}</p>
          : !url ? <p className="text-sm text-muted">{t('common.loading')}</p>
            : <iframe key={url} src={url} title={t('compare.frameTitle', { n: v.number })} sandbox={sandboxFor(v.kind)} className={`block border-0 bg-white ${SCREEN_CLASS[sized(v.kind) ? screen : 'desktop']}`} />}
      </div>
    </section>
  );
}

/**
 * Two kept versions side by side (design 16), stacked on narrow screens. Each side picks its version; screen sizes for
 * HTML pages and sites. The frames cannot scroll together: each is a sandboxed page of its own.
 */
export function VersionCompare({ a, versions, left: initialLeft, right: initialRight, onClose }: {
  a: ArtifactDto; versions: VersionDto[]; left: string; right: string; onClose: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(initialLeft);
  const [right, setRight] = useState(initialRight);
  const [screen, setScreen] = useState<Screen>('desktop');
  useLayer({ el: layer, modal: true, onEscape: onClose });
  const l = versions.find((v) => v.id === left) ?? versions[versions.length - 1];
  const r = versions.find((v) => v.id === right) ?? versions[0];
  // Sizes when either side lays itself out; each side applies them only to such a version.
  const sizable = sized(l.kind) || sized(r.kind);
  const shown = sizable ? screen : 'desktop';
  const btn = 'tip grid size-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink';
  return createPortal(
    <div ref={layer} className="fixed inset-0 z-50">
      <div aria-hidden="true" className="drawer-scrim absolute inset-0 bg-[var(--scrim)]" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={t('compare.title', { title: a.title })}
        className="enter-pop absolute inset-0 flex flex-col overflow-hidden bg-surface sm:inset-4 sm:rounded-2xl sm:shadow-[0_24px_60px_-20px_oklch(0.2_0.02_70/0.45),0_0_0_1px_var(--line)]">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2 sm:px-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-medium">{t('compare.title', { title: a.title })}</h2>
            <p className="text-xs text-muted">{t('compare.hint')}</p>
          </div>
          {sizable && (
            <div role="radiogroup" aria-label={t('preview.screen')} className="hidden items-center gap-0.5 rounded-full bg-surface-2 p-0.5 md:flex">
              {SCREENS.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={screen === s} onClick={() => setScreen(s)}
                  className={`rounded-full px-3 py-1 text-xs ${screen === s ? 'bg-surface font-medium text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
                  {t(`preview.screen.${s}`)}
                </button>
              ))}
            </div>
          )}
          <button type="button" className={`${btn} tip-end`} onClick={onClose} aria-label={t('common.close')} data-tip={t('common.closeTip')} data-autofocus><CloseIcon /></button>
        </header>
        <div className="grid min-h-0 flex-1 grid-rows-2 divide-y divide-line md:grid-cols-2 md:grid-rows-1 md:divide-x md:divide-y-0">
          <ComparePane a={a} v={l} versions={versions} screen={shown} onPick={setLeft} side="left" />
          <ComparePane a={a} v={r} versions={versions} screen={shown} onPick={setRight} side="right" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
