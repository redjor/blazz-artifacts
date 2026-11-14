import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api, copyText, openPreview } from './api.ts';
import { ThumbImage, useThumbnail } from './ArtifactCard.tsx';
import { Audience } from './Audience.tsx';
import { formatBytes, formatCount, formatDate, formatViews, kindLabel, modifiedText, normalizeLabel, visibilityLabel } from './format.ts';
import { t, tn, type MessageKey } from './i18n/index.ts';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, CopyIcon, FolderIcon, KIND_ICON, OpenIcon, PinIcon, ShareIcon, VISIBILITY_ICON } from './icons.tsx';
import { ProjectInput, TagsInput } from './Labels.tsx';
import { isEditable, useLayer } from './layers.ts';
import type { ArtifactDetail, ArtifactDto, LinkDto, VersionDto, Visibility } from './types.ts';
import { VisibilityPicker } from './VisibilityPicker.tsx';

type TabId = 'info' | 'access' | 'history';
const TABS: { id: TabId; label: MessageKey }[] = [
  { id: 'info', label: 'tab.info' },
  { id: 'access', label: 'tab.access' },
  { id: 'history', label: 'tab.history' },
];

export type Expiry = '24h' | '7d' | 'custom' | 'none';
interface InfoDraft { title: string; slug: string; project: string; tags: string[] }
interface AccessDraft { visibility: Visibility; code: string }
export interface LinkForm { label: string; expiry: Expiry; customDate: string }
export const EMPTY_LINK: LinkForm = { label: '', expiry: '7d', customDate: '' };


export const field = 'w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm hover:border-line-strong';
export const primary = 'inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-3.5 py-2 text-sm font-medium text-canvas disabled:opacity-40';
export const ghost = 'inline-flex items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2 aria-disabled:cursor-default aria-disabled:text-muted aria-disabled:hover:bg-transparent';
export const iconButton = 'tip grid size-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent aria-pressed:text-ink';

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);
const infoOf = (a: ArtifactDto): InfoDraft => ({ title: a.title, slug: a.slug, project: a.project ?? '', tags: a.tags });

export function Section({ title, children, description }: { title?: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-line pt-6 first:border-t-0 first:pt-0">
      {title && (
        <div>
          <h3 className="text-[15px] font-medium">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

const HISTORY_SHORT = 10;
const THUMB_TYPES = ['image/webp', 'image/png', 'image/jpeg'];
const THUMB_MAX = 2 * 1024 * 1024;

/** Thumbnail of a version; the kind pictogram if it has none (rows stay aligned). */
function VersionThumb({ v }: { v: VersionDto }) {
  const [thumb, onError] = useThumbnail(v.thumbnailUrl);
  if (thumb) return <ThumbImage src={thumb} onError={onError} className="aspect-[8/5] w-16 shrink-0 rounded-md" />;
  const Icon = KIND_ICON[v.kind];
  return <span aria-hidden="true" className={`tile kind-${v.kind} grid aspect-[8/5] w-16 shrink-0 place-items-center rounded-md`}><Icon className="size-4" /></span>;
}

/** Large thumbnail at the top of “Details”, with manual image upload. */
function ThumbnailSection({ view, pending, onPick }: { view: ArtifactDto; pending: boolean; onPick: (file: File) => void }) {
  const [thumb, onError] = useThumbnail(view.thumbnailUrl);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  if (!view.version) return null;
  return (
    <Section>
      {thumb && <ThumbImage src={thumb} onError={onError} className="aspect-[8/5] w-full rounded-xl" />}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p id={hintId} className="min-w-0 flex-1 text-sm text-muted">
          {thumb ? t('thumb.shown') : t('thumb.none')}
        </p>
        <button type="button" className={ghost} disabled={pending} aria-describedby={hintId} onClick={() => input.current?.click()}>
          {pending ? t('common.uploading') : thumb ? t('thumb.replace') : t('thumb.add')}
        </button>
      </div>
      <input ref={input} type="file" className="hidden" accept={THUMB_TYPES.join(',')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onPick(file);
        }} />
    </Section>
  );
}

function History({ art, onRestore, onError }: { art: ArtifactDetail; onRestore: (v: VersionDto) => void; onError: (m: string) => void }) {
  const [versions, setVersions] = useState<VersionDto[] | null>(null);
  const [all, setAll] = useState(false);
  // thumbnailUrl: a manual thumbnail upload does not change updatedAt, but the history must show it.
  const { id, updatedAt, thumbnailUrl } = art;

  useEffect(() => {
    let live = true;
    api.versions(id).then((v) => live && setVersions(v), (e) => onError((e as Error).message));
    return () => {
      live = false;
    };
  }, [id, updatedAt, thumbnailUrl, onError]);

  if (!versions) return <p className="text-sm text-muted">{t('history.loading')}</p>;
  const shown = all ? versions : versions.slice(0, HISTORY_SHORT);
  const withThumbs = versions.some((v) => v.thumbnailUrl);
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {shown.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3 text-sm">
            {withThumbs && <VersionThumb v={v} />}
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular-nums">v{v.number}</span>
                {v.current && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ok">{t('history.current')}</span>}
                <span className="truncate text-muted">{v.originalName}</span>
              </span>
              <span className="block text-xs text-muted">{formatDate(v.createdAt)} · {kindLabel(v.kind)} · {formatBytes(v.sizeBytes)}</span>
            </span>
            <button type="button" className={ghost} onClick={() => openPreview(id, v.id).catch((e) => onError((e as Error).message))}>{t('history.preview')}</button>
            {!v.current && <button type="button" className={ghost} onClick={() => onRestore(v)}>{t('history.restore')}</button>}
          </li>
        ))}
      </ul>
      {versions.length > HISTORY_SHORT && (
        <button type="button" className={ghost} onClick={() => setAll(!all)}>{all ? t('history.showLess') : t('history.showAll', { n: versions.length })}</button>
      )}
      <p className="text-xs text-muted">{t('history.retention')}</p>
    </div>
  );
}

/** Expiry date of a new link from the form (null: no expiry). */
export function linkExpiresAt(f: LinkForm): string | null {
  if (f.expiry === 'none') return null;
  if (f.expiry === 'custom') return f.customDate ? new Date(f.customDate).toISOString() : null;
  return new Date(Date.now() + (f.expiry === '24h' ? 24 : 24 * 7) * 3600_000).toISOString();
}

/** “New link” form: label, expiry, specific date. */
export function LinkCreateForm({ form, onChange, onSubmit, pending }: { form: LinkForm; onChange: (f: LinkForm) => void; onSubmit: (e: FormEvent) => void; pending: boolean }) {
  return (
    <form onSubmit={onSubmit} className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
      <input className={field} placeholder={t('link.labelPlaceholder')} aria-label={t('link.labelAria')} value={form.label} maxLength={80} onChange={(e) => onChange({ ...form, label: e.target.value })} />
      <select className={`${field} bg-surface`} value={form.expiry} onChange={(e) => onChange({ ...form, expiry: e.target.value as Expiry })} aria-label={t('link.expiry')}>
        <option value="24h">{t('link.24h')}</option>
        <option value="7d">{t('link.7d')}</option>
        <option value="custom">{t('link.custom')}</option>
        <option value="none">{t('link.none')}</option>
      </select>
      <button className={primary} disabled={(form.expiry === 'custom' && !form.customDate) || pending}>{t('common.create')}</button>
      {form.expiry === 'custom' && (
        <input type="datetime-local" className={`${field} bg-surface sm:col-span-3`} value={form.customDate} onChange={(e) => onChange({ ...form, customDate: e.target.value })} aria-label={t('link.expiryDate')} />
      )}
    </form>
  );
}

/**
 * Back to “Link” visibility: links created earlier and never revoked become usable again.
 * Short note and bulk revocation, before applying.
 */
export function RevivedLinksNote({ links, pending, onRevoke }: { links: LinkDto[]; pending: boolean; onRevoke: () => void }) {
  const n = links.filter((l) => l.active).length;
  if (n === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-surface-2 px-3.5 py-3 text-sm">
      <p className="min-w-0 flex-1">
        {tn('common.revivedLinks', n)}
      </p>
      <button type="button" className={`${ghost} bg-surface`} disabled={pending} onClick={onRevoke}>{pending ? t('common.revoking') : t('common.revokeOld')}</button>
    </div>
  );
}

export interface LinkActions {
  copy: (a: ArtifactDto) => Promise<void>;
  share: (a: ArtifactDto) => Promise<boolean>;
  togglePin: (a: ArtifactDto) => Promise<void>;
}

/**
 * Side panel of an artifact (full screen on mobile): header with actions, three tabs, ↑/↓ navigation
 * in the gallery's current order. Each tab keeps its draft: saving one does not clear the other.
 */
export function ArtifactDrawer({ id, summary, order, projects, paths, tagNames, links, dirtyRef, onNavigate, onClose, onChanged, onNotice, restoreFocus }: {
  id: string; summary: ArtifactDto | undefined; order: string[]; projects: string[]; paths?: Record<string, string>; tagNames: string[]; links: LinkActions;
  /** Read by the gallery to confirm before a hash navigation. */
  dirtyRef: RefObject<boolean>;
  onNavigate: (id: string) => void; onClose: () => void; onChanged: () => unknown; onNotice: (m: string) => void;
  restoreFocus: () => HTMLElement | null;
}) {
  const [tab, setTab] = useState<TabId>('info');
  const [closing, setClosing] = useState(false);
  const [art, setArt] = useState<ArtifactDetail | null>(null);
  const [shownId, setShownId] = useState(id);
  const [info, setInfo] = useState<InfoDraft | null>(null);
  const [access, setAccess] = useState<AccessDraft | null>(null);
  const [linkForm, setLinkForm] = useState<LinkForm>(EMPTY_LINK);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [historySeen, setHistorySeen] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const tablist = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const replaceInput = useRef<HTMLInputElement>(null);
  const currentId = useRef(id);
  const titleId = useId();
  const baseId = useId();

  // Another artifact: drafts and errors start over (the open tab stays).
  if (shownId !== id) {
    setShownId(id);
    setArt(null);
    setInfo(null);
    setAccess(null);
    setLinkForm(EMPTY_LINK);
    setError(null);
    setPending(null);
  }
  if (tab === 'history' && !historySeen) setHistorySeen(true);

  const view: ArtifactDto | null = art ?? summary ?? null;

  const refresh = useCallback(async () => {
    const a = await api.get(id);
    if (currentId.current === id) setArt(a);
    return a;
  }, [id]);

  useEffect(() => {
    currentId.current = id;
    let live = true;
    api.get(id).then((a) => live && setArt(a), (e) => live && setError((e as Error).message));
    // Focus was on an element gone with the previous artifact: move it to the open tab.
    if (panel.current && !panel.current.contains(document.activeElement)) tabRefs.current[tab]?.focus({ preventScroll: true });
    return () => {
      live = false;
    };
    // Only an artifact change matters here (not a tab change).
  }, [id]);

  const infoValues = info ?? (view ? infoOf(view) : { title: '', slug: '', project: '', tags: [] });
  const infoDirty = !!(info && view) && (info.title !== view.title || info.slug !== view.slug || normalizeLabel(info.project) !== view.project || !sameTags(info.tags, view.tags));
  const accessValues = access ?? { visibility: view?.visibility ?? 'private', code: '' };
  const accessDirty = !!(access && view) && (access.visibility !== view.visibility || (access.visibility === 'code' && access.code.length > 0));
  const linkDirty = linkForm.label.trim() !== '';
  const dirty: Record<TabId, boolean> = { info: infoDirty, access: accessDirty || linkDirty, history: false };
  const anyDirty = dirty.info || dirty.access;
  useEffect(() => {
    dirtyRef.current = anyDirty;
  });
  useEffect(() => () => {
    dirtyRef.current = false;
  }, [dirtyRef]);

  // Loading → content: the temporary “Close” button goes away, focus stays inside the panel.
  const hasView = !!(art ?? summary);
  const hadView = useRef(hasView);
  useEffect(() => {
    if (hasView && !hadView.current) tabRefs.current[tab]?.focus({ preventScroll: true });
    hadView.current = hasView;
  }, [hasView, tab]);

  const confirmDiscard = () => !anyDirty || window.confirm(t('common.discardConfirm'));
  const requestClose = (force = false) => {
    if (closing || (!force && !confirmDiscard())) return;
    setClosing(true);
  };
  useLayer({ el: layer, modal: true, onEscape: () => requestClose(), restoreFocus });

  // Safety net when the exit animation does not run (background tab, animations disabled).
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(onClose, 450);
    return () => clearTimeout(t);
  }, [closing, onClose]);

  const index = order.indexOf(id);
  const go = (delta: number) => {
    const next = index < 0 ? undefined : order[index + delta];
    if (!next || !confirmDiscard()) return;
    onNavigate(next);
  };

  // ↑/↓ change artifact only from the header, the tabs or the panel itself, never inside a tab's content.
  const onPanelKey = (e: KeyboardEvent) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isEditable(e.target)) return;
    const t = e.target as Node;
    if (t !== panel.current && !header.current?.contains(t) && !tablist.current?.contains(t)) return;
    e.preventDefault();
    go(e.key === 'ArrowDown' ? 1 : -1);
  };

  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((tb) => tb.id === tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length].id;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  /** Runs an action; when it returns the updated artifact, the header follows without waiting for the full reload. */
  const act = async (key: string, fn: () => Promise<ArtifactDto | unknown>, ok: string | null, after?: () => void) => {
    setError(null);
    setPending(key);
    try {
      const res = await fn();
      if (currentId.current !== id) return;
      if (res && typeof res === 'object' && 'slug' in res) setArt((prev) => (prev ? { ...prev, ...(res as ArtifactDto) } : prev));
      after?.();
      onChanged();
      if (ok) onNotice(ok);
      await refresh();
    } catch (e) {
      if (currentId.current === id) setError((e as Error).message);
    } finally {
      if (currentId.current === id) setPending(null);
    }
  };

  const viaLinks = async (fn: () => Promise<unknown>) => {
    setError(null);
    await fn();
    if (currentId.current === id) await refresh().catch((e) => setError((e as Error).message));
  };

  if (!view) {
    return createPortal(
      <div ref={layer} className="fixed inset-0 z-40">
        <div className="drawer-scrim absolute inset-0 bg-[var(--scrim)]" onClick={() => requestClose(true)} />
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} data-closing={closing || undefined} onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) onClose(); }}
          className="drawer-panel absolute inset-0 grid place-items-center bg-surface p-6 text-sm sm:inset-y-2 sm:right-2 sm:left-auto sm:w-[min(42rem,calc(100vw-4rem))] sm:rounded-2xl">
          <h2 id={titleId} className="sr-only">{t('drawer.artifact')}</h2>
          {error ? <p role="alert" className="text-danger">{error}</p> : <p className="text-muted">{t('common.loading')}</p>}
          <button type="button" onClick={() => requestClose(true)} className={ghost}>{t('common.close')}</button>
        </div>
      </div>,
      document.body,
    );
  }

  const KindIcon = KIND_ICON[view.kind];
  const VisIcon = VISIBILITY_ICON[view.visibility];
  const priv = view.visibility === 'private';

  const saveInfo = (e: FormEvent) => {
    e.preventDefault();
    if (!info) return;
    if (info.slug !== view.slug && !window.confirm(t('confirm.slugChange', { slug: view.slug }))) return;
    void act('info', () => api.update(view.id, { title: info.title, slug: info.slug, project: normalizeLabel(info.project), tags: info.tags }), t('notice.infoSaved'), () => setInfo(null));
  };

  const saveAccess = (e: FormEvent) => {
    e.preventDefault();
    if (!access) return;
    void act('access', () => api.update(view.id, { visibility: access.visibility, ...(access.visibility === 'code' && access.code ? { code: access.code } : {}) }), t('notice.accessUpdated'), () => setAccess(null));
  };

  const expiresAt = () => linkExpiresAt(linkForm);

  const createLink = (e: FormEvent) => {
    e.preventDefault();
    let copied = true;
    void act('link', async () => {
      const link = await api.createLink(view.id, { label: linkForm.label.trim() || null, expiresAt: expiresAt() });
      await copyText(link.url ?? '').catch(() => {
        copied = false;
      });
    }, null, () => {
      setLinkForm((f) => ({ ...f, label: '' }));
      onNotice(copied ? t('common.linkCreatedCopied') : t('common.linkCreated'));
    });
  };

  const uploadThumb = (file: File) => {
    if (!view.version) return;
    if (!THUMB_TYPES.includes(file.type)) return setError(t('thumb.badType'));
    if (file.size > THUMB_MAX) return setError(t('thumb.tooLarge'));
    const versionId = view.version.id;
    void act('thumb', () => api.putThumbnail(view.id, versionId, file), t('notice.thumbSaved'));
  };

  const restore = (v: VersionDto) => {
    if (!window.confirm(t('confirm.restore', { n: v.number }))) return;
    void act('restore', () => api.restore(view.id, v.id), t('notice.restored', { n: v.number }));
  };

  const remove = async () => {
    if (!window.confirm(t('confirm.deleteArtifact', { title: view.title }))) return;
    try {
      await api.remove(view.id);
      // Gallery reloaded before closing: focus can then go to a neighbouring card that exists.
      await Promise.resolve(onChanged()).catch(() => {});
      onNotice(t('notice.artifactDeleted'));
      requestClose(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const projectInvalid = !!info && info.project.trim() !== '' && normalizeLabel(info.project) === null;
  const codeInvalid = accessValues.visibility === 'code' && (view.hasCode && view.visibility === 'code' ? accessValues.code.length > 0 && accessValues.code.length < 6 : accessValues.code.length < 6);
  const cutsAccess = accessDirty && accessValues.visibility !== view.visibility && view.visibility !== 'private';
  const detail = art;

  return createPortal(
    <div ref={layer} className="fixed inset-0 z-40">
      <div aria-hidden="true" data-closing={closing || undefined} className="drawer-scrim absolute inset-0 bg-[var(--scrim)]" onClick={() => requestClose()} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-closing={closing || undefined} onKeyDown={onPanelKey}
        onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) onClose(); }}
        className="drawer-panel absolute inset-0 flex flex-col bg-surface outline-none sm:inset-y-2 sm:right-2 sm:left-auto sm:w-[min(42rem,calc(100vw-4rem))] sm:rounded-2xl sm:shadow-[0_24px_60px_-20px_oklch(0.2_0.02_70/0.45),0_0_0_1px_var(--line)]">
        <header ref={header} className="shrink-0 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-7 sm:pt-4">
          <div className="-mx-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-0.5">
              <button type="button" onClick={() => go(-1)} disabled={index <= 0} aria-label={t('drawer.prev')} data-tip={t('drawer.prevTip')} aria-keyshortcuts="ArrowUp" className={iconButton}><ChevronUpIcon /></button>
              <button type="button" onClick={() => go(1)} disabled={index < 0 || index >= order.length - 1} aria-label={t('drawer.next')} data-tip={t('drawer.nextTip')} aria-keyshortcuts="ArrowDown" className={iconButton}><ChevronDownIcon /></button>
              {index >= 0 && (
                <span className="ml-1.5 text-[13px] text-muted tabular-nums"><span className="sr-only">{t('drawer.positionSr')}</span>{index + 1}<span aria-hidden="true"> / </span><span className="sr-only">{t('drawer.of')}</span>{order.length}</span>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              <button type="button" aria-pressed={view.pinned} onClick={() => void viaLinks(() => links.togglePin(view))}
                aria-label={t('drawer.pinLabel')} data-tip={view.pinned ? t('card.unpin') : t('card.pin')} className={`${iconButton} tip-end aria-pressed:bg-surface-2`}>
                <PinIcon />
              </button>
              <button type="button" onClick={() => requestClose()} aria-label={t('common.close')} data-tip={t('common.closeTip')} className={`${iconButton} tip-end`}><CloseIcon /></button>
            </div>
          </div>

          <h2 id={titleId} className="mt-3 font-serif text-[1.75rem] leading-[1.15] font-normal tracking-[-0.015em] text-balance break-words">{view.title}</h2>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
            <span className="inline-flex items-center gap-1.5"><KindIcon className="size-3.5" />{kindLabel(view.kind)}{view.version && <span className="tabular-nums"> · v{view.version.number}</span>}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5"><VisIcon className="size-3.5" />{visibilityLabel(view.visibility)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={view.updatedAt} title={formatDate(view.updatedAt)}>{modifiedText(view.updatedAt)}</time>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums" title={t('drawer.last30', { n: formatCount(view.views.last30) })}>{view.views.total > 0 ? formatViews(view.views.total) : t('drawer.noViews')}</span>
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={primary} onClick={() => openPreview(view.id).catch((e) => setError((e as Error).message))}>
              <OpenIcon className="size-4" />{t('common.open')}
            </button>
            <button type="button" className={`${ghost} ${priv ? 'tip' : ''}`} aria-disabled={priv || undefined} data-tip={priv ? t('card.privateHint') : undefined}
              aria-describedby={priv ? `${baseId}-copy-hint` : undefined}
              onClick={() => { if (!priv) void viaLinks(() => links.copy(detail ?? view)); }}>
              <CopyIcon className="size-4" />{t('common.copyLink')}
            </button>
            {priv && <span id={`${baseId}-copy-hint`} className="sr-only">{t('card.privateHint')}</span>}
            <button type="button" className={ghost} onClick={() => void viaLinks(() => links.share(view))}>
              <ShareIcon className="size-4" />{t('common.share7')}
            </button>
          </div>
        </header>

        <div ref={tablist} role="tablist" aria-label={t('common.sections')} onKeyDown={onTabKey} className="no-scrollbar mt-5 flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 sm:px-5">
          {TABS.map((tb) => {
            const on = tab === tb.id;
            return (
              <button key={tb.id} ref={(el) => { tabRefs.current[tb.id] = el; }} type="button" role="tab" id={`${baseId}-tab-${tb.id}`} aria-selected={on} aria-controls={`${baseId}-panel-${tb.id}`}
                tabIndex={on ? 0 : -1} data-autofocus={on || undefined} onClick={() => setTab(tb.id)}
                className={`relative -mb-px inline-flex h-11 shrink-0 focus-visible:-outline-offset-2 items-center gap-2 rounded-t-lg px-2.5 text-sm whitespace-nowrap after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full ${on ? 'text-ink after:bg-ink' : 'text-muted hover:text-ink'}`}>
                {t(tb.label)}
                {dirty[tb.id] && <span className="size-1.5 rounded-full bg-ring"><span className="sr-only">{t('common.unsaved')}</span></span>}
              </button>
            );
          })}
        </div>

        {error && <p role="alert" className="mx-5 mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger sm:mx-7">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {/* Details */}
          <div role="tabpanel" id={`${baseId}-panel-info`} aria-labelledby={`${baseId}-tab-info`} hidden={tab !== 'info'} className="space-y-6 px-5 py-6 sm:px-7">
            <ThumbnailSection view={view} pending={pending === 'thumb'} onPick={uploadThumb} />
            <Section>
              <form onSubmit={saveInfo} className="space-y-4">
                <label className="block space-y-1 text-sm">
                  <span className="text-muted">{t('common.title')}</span>
                  <input className={field} value={infoValues.title} maxLength={120} required onChange={(e) => setInfo({ ...infoValues, title: e.target.value })} />
                </label>
                <label className="block space-y-1 text-sm">
                  <span className="text-muted">{t('field.address')}</span>
                  <span className="flex items-center rounded-lg border border-line hover:border-line-strong has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-ring">
                    <span className="pl-3 font-mono text-sm text-muted" aria-hidden="true">/a/</span>
                    <input className="min-w-0 flex-1 bg-transparent py-2 pr-3 font-mono text-sm outline-none focus-visible:outline-none" value={infoValues.slug} maxLength={48} required
                      onChange={(e) => setInfo({ ...infoValues, slug: e.target.value.toLowerCase() })} aria-describedby={infoValues.slug !== view.slug ? `${baseId}-slug-warn` : undefined} />
                  </span>
                  {infoValues.slug !== view.slug && (
                    <span id={`${baseId}-slug-warn`} className="block text-xs text-warn">{t('info.slugWarn', { slug: view.slug })}</span>
                  )}
                </label>
                <ProjectInput value={infoValues.project} onChange={(project) => setInfo({ ...infoValues, project })} projects={projects} paths={paths} />
                <TagsInput value={infoValues.tags} onChange={(tags) => setInfo({ ...infoValues, tags })} suggestions={tagNames} />
                <div className="flex flex-wrap gap-2">
                  <button className={primary} disabled={!infoDirty || projectInvalid || pending === 'info'}>{pending === 'info' ? t('common.saving') : t('common.save')}</button>
                  {infoDirty && <button type="button" className={ghost} onClick={() => setInfo(null)}>{t('common.discardEdits')}</button>}
                </div>
              </form>
            </Section>

            <Section title={t('content.title')} description={t('content.description')}>
              {view.version && (
                <p className="text-sm">
                  <span className="break-all">{view.version.originalName}</span>
                  <span className="text-muted"> · {formatBytes(view.version.sizeBytes)} · {tn('content.files', view.version.fileCount)}</span>
                </p>
              )}
              {(view.kind === 'html' || view.kind === 'site') && (
                <label className="flex items-start gap-2.5 text-sm">
                  <input type="checkbox" checked={view.memoryStorage} className="mt-1"
                    onChange={(e) => void act('memory', () => api.update(view.id, { memoryStorage: e.target.checked }), t('notice.optionSaved'))} />
                  <span>
                    {t('common.memoryStorage')}
                    <span className="block text-xs text-muted">{t('common.memoryStorageHint')}</span>
                  </span>
                </label>
              )}
              <button type="button" className={ghost} disabled={pending === 'replace'} onClick={() => replaceInput.current?.click()}>
                {pending === 'replace' ? t('common.uploading') : t('content.replace')}
              </button>
              <input ref={replaceInput} type="file" className="hidden" accept=".html,.htm,.md,.markdown,.pdf,.json,.zip"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  const form = new FormData();
                  form.set('file', file);
                  void act('replace', () => api.replace(view.id, form), t('notice.contentReplaced'));
                }} />
            </Section>

            <Section title={t('common.dangerZone')}>
              <button type="button" onClick={() => void remove()} className="rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger hover:bg-danger/10">{t('artifact.delete')}</button>
            </Section>
          </div>

          {/* Access & sharing */}
          <div role="tabpanel" id={`${baseId}-panel-access`} aria-labelledby={`${baseId}-tab-access`} hidden={tab !== 'access'} className="space-y-6 px-5 py-6 sm:px-7">
            {view.project && view.folderVisibility && view.folderVisibility !== 'private' && (
              <p className="flex gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-sm">
                <FolderIcon className="mt-0.5 size-4 text-muted" />
                <span>{t('artifact.viaFolder', { folder: view.project, visibility: visibilityLabel(view.folderVisibility).toLowerCase() })}</span>
              </p>
            )}
            <Section>
              <form onSubmit={saveAccess} className="space-y-3">
                <VisibilityPicker value={accessValues.visibility} onChange={(visibility) => setAccess({ ...accessValues, visibility })} />
                {accessValues.visibility === 'code' && (
                  <label className="block space-y-1 text-sm">
                    <span className="text-muted">{view.hasCode && view.visibility === 'code' ? t('common.newCode') : t('common.secretCode')}</span>
                    <input className={field} autoComplete="off" value={accessValues.code} onChange={(e) => setAccess({ ...accessValues, code: e.target.value })} />
                  </label>
                )}
                {cutsAccess && <p className="text-xs text-warn">{t('artifact.cutsAccess')}</p>}
                {accessValues.visibility === 'link' && view.visibility !== 'link' && detail && (
                  <RevivedLinksNote links={detail.links} pending={pending === 'revoke-old'}
                    onRevoke={() => void act('revoke-old', async () => {
                      for (const l of detail.links.filter((x) => x.active)) await api.revokeLink(view.id, l.id);
                    }, t('common.oldLinksRevoked'))} />
                )}
                <div className="flex flex-wrap gap-2">
                  <button className={primary} disabled={!accessDirty || codeInvalid || pending === 'access'}>{pending === 'access' ? t('common.applying') : t('common.apply')}</button>
                  {accessDirty && <button type="button" className={ghost} onClick={() => setAccess(null)}>{t('common.cancel')}</button>}
                </div>
              </form>
            </Section>

            <Section title={t('common.shareLinks')}
              description={view.visibility === 'link' ? t('artifact.linksLink') : t('artifact.linksOther')}>
              {view.visibility !== 'link' ? (
                <button type="button" className={ghost} onClick={() => void viaLinks(() => links.share(view))}><ShareIcon className="size-4" />{t('common.share7')}</button>
              ) : (
                <>
                  <LinkCreateForm form={linkForm} onChange={setLinkForm} onSubmit={createLink} pending={pending === 'link'} />
                  {!detail ? (
                    <p className="text-sm text-muted">{t('links.loading')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.links.map((l) => <LinkRow key={l.id} l={l} current={l.url !== null && l.url === detail.activeLinkUrl} onCopy={() => copyText(l.url!).then(() => onNotice(t('common.linkCopied')), () => onNotice(t('common.copyFailed')))} onRevoke={() => void act('revoke', () => api.revokeLink(view.id, l.id), t('common.linkRevoked'))} />)}
                      {detail.links.length === 0 && <li className="text-sm text-muted">{t('common.noLinksYet')}</li>}
                    </ul>
                  )}
                </>
              )}
            </Section>

            <Section title={t('common.audience')} description={t('artifact.audience')}>
              {tab === 'access' && <Audience key={view.id} id={view.id} visibility={view.visibility} />}
            </Section>

            <Section title={t('common.cutAccessTitle')} description={t('artifact.cutDescription')}>
              <button type="button" className={ghost}
                onClick={() => window.confirm(t('confirm.revokeAll')) && void act('revoke-all', () => api.revokeAll(view.id), t('notice.accessCut'))}>
                {t('common.cutAll')}
              </button>
            </Section>
          </div>

          {/* History */}
          <div role="tabpanel" id={`${baseId}-panel-history`} aria-labelledby={`${baseId}-tab-history`} hidden={tab !== 'history'} className="px-5 py-6 sm:px-7">
            {historySeen && detail ? <History art={detail} onRestore={restore} onError={setError} /> : <p className="text-sm text-muted">{t('history.loading')}</p>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Links older than open counting have a last-used date but no counted open.
function openedText(l: LinkDto): string {
  if (l.openCount > 0) return `${tn('link.opens', l.openCount)}${l.lastUsedAt ? t('link.lastOpen', { date: formatDate(l.lastUsedAt) }) : ''}`;
  return l.lastUsedAt ? t('link.usedOn', { date: formatDate(l.lastUsedAt) }) : t('link.neverOpened');
}

export function LinkRow({ l, current, onCopy, onRevoke }: { l: LinkDto; current: boolean; onCopy: () => void; onRevoke: () => void }) {
  return (
    <li className={`flex flex-wrap items-center gap-2 rounded-xl border p-3 text-sm ${l.active ? 'border-line' : 'border-line/60 text-muted'}`}>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{l.label ?? t('link.unlabeled')}</span>
          {current && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ok">{t('link.current')}</span>}
        </span>
        <span className="block text-xs text-muted">
          {l.revokedAt ? t('link.revoked') : !l.active ? t('link.expired') : l.expiresAt ? t('link.expiresOn', { date: formatDate(l.expiresAt) }) : t('link.none')}
        </span>
        <span className="block text-xs text-muted tabular-nums">{openedText(l)}</span>
      </span>
      {l.active && (
        <>
          {l.url === null ? (
            <span className="text-xs text-warn">{t('link.unreadable')}</span>
          ) : (
            <button type="button" className={ghost} onClick={onCopy}>{t('common.copy')}</button>
          )}
          <button type="button" className={ghost} onClick={onRevoke}>{t('link.revoke')}</button>
        </>
      )}
    </li>
  );
}
