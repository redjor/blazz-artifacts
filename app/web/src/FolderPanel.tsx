import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, copyDeferred, copyText, openFolderPreview } from './api.ts';
import { ThumbImage, useThumbnail } from './ArtifactCard.tsx';
import { EMPTY_LINK, field, ghost, iconButton, LinkCreateForm, linkExpiresAt, LinkRow, primary, RevivedLinksNote, Section, type LinkForm } from './ArtifactPanel.tsx';
import { Audience } from './Audience.tsx';
import { formatDate, kindLabel, modifiedText, normalizeLabel, visibilityLabel } from './format.ts';
import { childrenOf, folderPath, moveTargets, sharedVia, subtreeExposure, type TreeFolder } from './folderTree.ts';
import { t, tn, type MessageKey } from './i18n/index.ts';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CloseIcon, CopyIcon, FolderIcon, GripIcon, KIND_ICON, OpenIcon, ShareIcon, VISIBILITY_ICON } from './icons.tsx';
import { useLayer } from './layers.ts';
import type { FolderArtifact, FolderDetail, FolderSummary, Visibility } from './types.ts';
import { VisibilityPicker } from './VisibilityPicker.tsx';

export type TabId = 'info' | 'access' | 'order';
const TABS: { id: TabId; label: MessageKey }[] = [
  { id: 'info', label: 'tab.info' },
  { id: 'access', label: 'tab.access' },
  { id: 'order', label: 'tab.order' },
];

interface InfoDraft { title: string; description: string; name: string }
interface AccessDraft { visibility: Visibility; code: string }

const infoOf = (f: FolderDetail): InfoDraft => ({ title: f.title ?? '', description: f.description ?? '', name: f.name });

/** Safeguard: number of private artifacts that would become visible through the folder when switching to `next`. */
export function confirmExposure(f: Pick<FolderDetail, 'name' | 'visibility' | 'privateCount'>, next: Visibility, tree: TreeFolder[] = []): boolean {
  if (next === 'private' || f.visibility !== 'private') return true;
  const sub = subtreeExposure(tree, f.name);
  const privateCount = Math.max(f.privateCount, sub.privateArtifacts);
  if (privateCount === 0 && sub.folders === 0) return true;
  const extra = sub.folders > 0 ? tn('exposure.subtree', sub.folders) : '';
  return window.confirm(tn('exposure.confirm', privateCount, { name: f.name, how: t(`exposure.${next}`) }) + extra);
}

/** Delete confirmation suffix: the sub-folders of `name` move up one level (empty when there are none). */
export function deleteChildrenNote(tree: TreeFolder[], name: string, parent: string | null): string {
  const kids = childrenOf(tree, name).length;
  if (kids === 0) return '';
  const p = tree.find((x) => x.name === parent);
  return tn('confirm.deleteChildren', kids, { target: p ? `“${p.title ?? p.name}”` : t('move.root') });
}

function RowThumb({ a }: { a: FolderArtifact }) {
  const [thumb, onError] = useThumbnail(a.thumbnailUrl);
  if (thumb) return <ThumbImage src={thumb} onError={onError} className="aspect-[8/5] w-16 shrink-0 rounded-md" />;
  const Icon = KIND_ICON[a.kind];
  return <span aria-hidden="true" className={`tile kind-${a.kind} grid aspect-[8/5] w-16 shrink-0 place-items-center rounded-md`}><Icon className="size-4" /></span>;
}

/**
 * Order of the visitor page: drag a row, or “Move” then ↑/↓ (Enter or Escape to finish or cancel).
 * Each confirmed change is saved right away.
 */
function OrderList({ folder, onSave }: { folder: FolderDetail; onSave: (ids: string[]) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [moving, setMoving] = useState<{ id: string; from: string[] } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const handles = useRef<Record<string, HTMLButtonElement | null>>({});
  const byId = new Map(folder.artifacts.map((a) => [a.id, a]));
  const ids = (draft ?? folder.artifacts.map((a) => a.id)).filter((id) => byId.has(id));
  const hintId = useId();

  // The folder changed (reload): the draft restarts from the saved order.
  const key = folder.artifacts.map((a) => a.id).join();
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    if (!moving && !dragId) setDraft(null);
  }

  const moveTo = (id: string, to: number) => {
    const list = ids.filter((x) => x !== id);
    const clamped = Math.max(0, Math.min(to, list.length));
    list.splice(clamped, 0, id);
    setDraft(list);
    return { list, position: clamped + 1 };
  };
  const commit = async (list: string[]) => {
    const same = list.join() === folder.artifacts.map((a) => a.id).join();
    if (same || (await onSave(list))) setDraft(same ? null : list);
    else setDraft(null);
  };

  const startMove = (id: string) => {
    setMoving({ id, from: ids });
    setAnnounce(t('order.start', { title: byId.get(id)?.title ?? '', pos: ids.indexOf(id) + 1, total: ids.length }));
  };
  const endMove = (keep: boolean) => {
    if (!moving) return;
    const { id, from } = moving;
    setMoving(null);
    if (keep) {
      setAnnounce(t('order.placed', { title: byId.get(id)?.title ?? '', pos: ids.indexOf(id) + 1 }));
      void commit(ids);
    } else {
      setDraft(from);
      setAnnounce(t('order.cancelled'));
    }
    handles.current[id]?.focus();
  };
  const step = (id: string, delta: number) => {
    const { list, position } = moveTo(id, ids.indexOf(id) + delta);
    setAnnounce(t('order.position', { pos: position, total: list.length }));
    // The node is reordered: focus stays on its handle.
    requestAnimationFrame(() => handles.current[id]?.focus());
  };

  const onHandleKey = (e: KeyboardEvent, id: string) => {
    if (moving?.id !== id) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(id, e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // the layer (panel) does not close
      endMove(false);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      endMove(true);
    }
  };

  // Native drag and drop; events do not bubble up to the gallery's file drop.
  const onDragStart = (e: DragEvent, id: string) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDragId(id);
  };
  const onDragOver = (e: DragEvent, overId: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (overId !== dragId) moveTo(dragId, ids.indexOf(overId));
  };
  const onDragEnd = (e: DragEvent) => {
    e.stopPropagation();
    if (!dragId) return;
    const title = byId.get(dragId)?.title;
    setAnnounce(t('order.placed', { title: title ?? '', pos: ids.indexOf(dragId) + 1 }));
    setDragId(null);
    void commit(ids);
  };

  if (ids.length === 0) return <p className="text-sm text-muted">{t('order.empty')}</p>;

  return (
    <div className="space-y-3">
      <p id={hintId} className="text-sm text-muted">
        {t('order.hint')}
      </p>
      <p className="sr-only" aria-live="assertive">{announce}</p>
      <ol className="space-y-2" onDragOver={(e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); } }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        {ids.map((id, i) => {
          const a = byId.get(id)!;
          const VisIcon = VISIBILITY_ICON[a.visibility];
          const isMoving = moving?.id === id;
          return (
            <li key={id} draggable={!moving} onDragStart={(e) => onDragStart(e, id)} onDragOver={(e) => onDragOver(e, id)} onDragEnd={onDragEnd}
              data-dragging={dragId === id || undefined}
              className={`flex items-center gap-3 rounded-xl border bg-surface p-2.5 pr-3 text-sm transition-[border-color,opacity] data-dragging:opacity-50 ${isMoving ? 'border-ink' : 'border-line'}`}>
              <button ref={(el) => { handles.current[id] = el; }} type="button" aria-pressed={isMoving} aria-describedby={hintId}
                aria-label={isMoving ? t('order.finish', { title: a.title }) : t('order.move', { title: a.title, pos: i + 1, total: ids.length })}
                onClick={() => (isMoving ? endMove(true) : startMove(id))} onKeyDown={(e) => onHandleKey(e, id)}
                className={`grid size-9 shrink-0 cursor-grab place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink aria-pressed:bg-ink aria-pressed:text-canvas ${dragId ? 'cursor-grabbing' : ''}`}>
                {isMoving ? <CheckIcon className="size-4" /> : <GripIcon className="size-4" />}
              </button>
              <span className="w-5 shrink-0 text-right text-[13px] text-muted tabular-nums" aria-hidden="true">{i + 1}</span>
              <RowThumb a={a} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{a.title}</span>
                <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                  <span>{kindLabel(a.kind)}{a.versionNumber ? ` · v${a.versionNumber}` : ''}</span>
                  <span aria-hidden="true">·</span>
                  <span className={`inline-flex items-center gap-1 ${a.visibility === 'private' ? 'text-warn' : ''}`}><VisIcon className="size-3" />{visibilityLabel(a.visibility)}</span>
                </span>
              </span>
              {isMoving && (
                <span className="flex shrink-0 gap-0.5">
                  <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => step(id, -1)} disabled={i === 0} className={iconButton}><ArrowUpIcon className="size-4" /></button>
                  <button type="button" tabIndex={-1} aria-hidden="true" onClick={() => step(id, 1)} disabled={i === ids.length - 1} className={iconButton}><ArrowDownIcon className="size-4" /></button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * “Folder” panel of a project: same drawer as artifacts. Title, description, visibility, links, audience,
 * card order, visitor page preview. The folder sheet is created on the first change.
 */
export function FolderDrawer({ name, summary, folders, initialTab = 'info', onClose, onChanged, onNotice, onRenamed, fallbackFocus }: {
  name: string; summary: FolderSummary | undefined; folders: TreeFolder[]; fallbackFocus?: () => HTMLElement | null;
  /** “Share” on the folder page opens straight on the access tab. */
  initialTab?: TabId;
  onClose: () => void; onChanged: () => unknown; onNotice: (m: string) => void; onRenamed: (name: string) => void;
}) {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [closing, setClosing] = useState(false);
  const [folder, setFolder] = useState<FolderDetail | null>(null);
  const [info, setInfo] = useState<InfoDraft | null>(null);
  const [access, setAccess] = useState<AccessDraft | null>(null);
  const [linkForm, setLinkForm] = useState<LinkForm>(EMPTY_LINK);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const current = useRef(name);
  const titleId = useId();
  const baseId = useId();

  const refresh = useCallback(async () => {
    const f = await api.folder(current.current);
    setFolder(f);
    return f;
  }, []);

  useEffect(() => {
    current.current = name;
    let live = true;
    api.folder(name).then((f) => live && setFolder(f), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [name]);

  const infoValues = info ?? (folder ? infoOf(folder) : { title: '', description: '', name });
  const infoDirty = !!(info && folder) && (info.title.trim() !== (folder.title ?? '') || info.description.trim() !== (folder.description ?? '') || normalizeLabel(info.name) !== folder.name);
  const accessValues = access ?? { visibility: folder?.visibility ?? summary?.visibility ?? 'private', code: '' };
  const accessDirty = !!(access && folder) && (access.visibility !== folder.visibility || (access.visibility === 'code' && access.code.length > 0));
  const dirty: Record<TabId, boolean> = { info: infoDirty, access: accessDirty || linkForm.label.trim() !== '', order: false };
  const anyDirty = dirty.info || dirty.access;

  const requestClose = (force = false) => {
    if (closing || (!force && anyDirty && !window.confirm(t('common.discardConfirm')))) return;
    setClosing(true);
  };
  useLayer({ el: layer, modal: true, onEscape: () => requestClose(), fallbackFocus });
  // Loading → content: the temporary “Close” button goes away, focus moves to the open tab.
  const loadedFolder = !!folder;
  const hadFolder = useRef(loadedFolder);
  useEffect(() => {
    if (loadedFolder && !hadFolder.current && !layer.current?.contains(document.activeElement)) tabRefs.current[tab]?.focus({ preventScroll: true });
    hadFolder.current = loadedFolder;
  }, [loadedFolder, tab]);
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(onClose, 450);
    return () => clearTimeout(t);
  }, [closing, onClose]);

  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((tb) => tb.id === tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length].id;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const act = async (key: string, fn: () => Promise<unknown>, ok: string | null, after?: (res: unknown) => void) => {
    setError(null);
    setPending(key);
    try {
      const res = await fn();
      if (res && typeof res === 'object' && 'artifacts' in res) setFolder(res as FolderDetail);
      after?.(res);
      onChanged();
      if (ok) onNotice(ok);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setPending(null);
    }
  };

  const shell = (body: ReactNode) => createPortal(
    <div ref={layer} className="fixed inset-0 z-40">
      <div aria-hidden="true" data-closing={closing || undefined} className="drawer-scrim absolute inset-0 bg-[var(--scrim)]" onClick={() => requestClose()} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-closing={closing || undefined}
        onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) onClose(); }}
        className="drawer-panel absolute inset-0 flex flex-col bg-surface outline-none sm:inset-y-2 sm:right-2 sm:left-auto sm:w-[min(42rem,calc(100vw-4rem))] sm:rounded-2xl sm:shadow-[0_24px_60px_-20px_oklch(0.2_0.02_70/0.45),0_0_0_1px_var(--line)]">
        {body}
      </div>
    </div>,
    document.body,
  );

  if (!folder) {
    return shell(
      <div className="grid flex-1 place-items-center gap-3 p-6 text-sm">
        <h2 id={titleId} className="sr-only">{t('folder.drawerTitle', { name })}</h2>
        {error ? <p role="alert" className="text-danger">{error}</p> : <p className="text-muted">{t('common.loading')}</p>}
        <button type="button" onClick={() => requestClose(true)} className={ghost}>{t('common.close')}</button>
      </div>,
    );
  }

  const f = folder;
  const VisIcon = VISIBILITY_ICON[f.visibility];
  const priv = f.visibility === 'private';
  const displayTitle = f.title ?? f.name;

  /** Share for 7 days: private-artifact safeguard, confirmation when visitors lose access, link created and copied. */
  const share = async () => {
    if (!confirmExposure(f, 'link', folders)) return;
    if ((f.visibility === 'public' || f.visibility === 'code') && !window.confirm(t('confirm.folderToLink'))) return;
    setError(null);
    const req = api.shareFolder(f.name, { hours: 168 });
    const copied = copyDeferred(req.then((r) => {
      if (!r.link.url) throw new Error(t('common.unreadableLink'));
      return r.link.url;
    })).then(() => true, () => false);
    try {
      setFolder((await req).project);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    onNotice((await copied) ? t('notice.folderLinkCopied7') : t('notice.link7NoCopy'));
    onChanged();
    await refresh().catch(() => {});
  };

  const copyLink = async () => {
    const copy = (url: string, ok: string) => copyText(url).then(() => onNotice(ok), () => onNotice(t('common.copyFailed')));
    if (priv) return onNotice(t('folder.privateHint'));
    if (f.visibility === 'public') return copy(f.url, t('notice.folderAddressCopied'));
    if (f.visibility === 'code') return copy(f.url, t('notice.addressCopiedCode'));
    if (f.activeLinkUrl) return copy(f.activeLinkUrl, t('notice.folderLinkCopied'));
    if (window.confirm(t('confirm.noActiveFolderLink'))) await share();
  };

  const saveInfo = (e: FormEvent) => {
    e.preventDefault();
    if (!info) return;
    const nextName = normalizeLabel(info.name);
    if (!nextName) return setError(t('folder.invalidName'));
    const renamed = nextName !== f.name;
    if (renamed && !window.confirm(t('confirm.renameFolder', { old: f.name, name: nextName, n: f.count }))) return;
    void act('info', () => api.updateFolder(f.name, { title: info.title.trim() || null, description: info.description.trim() || null, ...(renamed ? { name: nextName } : {}) }),
      renamed ? t('notice.folderRenamed') : t('notice.folderSaved'), () => {
        setInfo(null);
        if (renamed) {
          current.current = nextName;
          onRenamed(nextName);
        }
      });
  };

  const saveAccess = (e: FormEvent) => {
    e.preventDefault();
    if (!access || !confirmExposure(f, access.visibility, folders)) return;
    void act('access', () => api.updateFolder(f.name, { visibility: access.visibility, ...(access.visibility === 'code' && access.code ? { code: access.code } : {}) }),
      t('notice.folderAccessUpdated'), () => setAccess(null));
  };

  const createLink = (e: FormEvent) => {
    e.preventDefault();
    let copied = true;
    void act('link', async () => {
      const link = await api.createFolderLink(f.name, { label: linkForm.label.trim() || null, expiresAt: linkExpiresAt(linkForm) });
      await copyText(link.url ?? '').catch(() => {
        copied = false;
      });
    }, null, () => {
      setLinkForm((x) => ({ ...x, label: '' }));
      onNotice(copied ? t('common.linkCreatedCopied') : t('common.linkCreated'));
    });
  };

  const labelOf = (x: TreeFolder) => x.title ?? x.name;
  const via = sharedVia(folders, f.name);
  /** The folder (itself or an ancestor) whose access opens `name`; null when nothing above is shared. */
  const opener = (name: string | null): TreeFolder | null => {
    const x = folders.find((o) => o.name === name);
    return x ? (x.visibility !== 'private' ? x : sharedVia(folders, x.name)) : null;
  };

  const move = async (parent: string | null) => {
    if (parent === f.parent) return;
    const into = opener(parent);
    const from = opener(f.parent);
    if (into?.name !== from?.name) {
      const sub = subtreeExposure(folders, f.name);
      // Leaving the access of `from` (to the top level or to another shared tree): its visitors lose access.
      if (from && !window.confirm(t('move.confirmOut', { name: f.name, parent: labelOf(from) }))) return;
      if (into && !window.confirm(tn('move.confirmIn', sub.artifacts, { name: f.name, parent: labelOf(into) }) + (sub.folders > 0 ? tn('exposure.subtree', sub.folders) : ''))) return;
    }
    await act('move', () => api.updateFolder(f.name, { parent }), null);
  };

  const removeSheet = async () => {
    const empty = f.count === 0;
    const extra = deleteChildrenNote(folders, f.name, f.parent);
    if (!window.confirm((empty
      ? t('confirm.deleteEmptyFolder', { title: f.name, name: f.name })
      : t('confirm.deleteFolderSheet', { name: f.name })) + extra)) return;
    try {
      await api.deleteFolder(f.name);
      await Promise.resolve(onChanged()).catch(() => {});
      onNotice(empty ? t('notice.folderDeleted') : t('notice.folderSheetDeleted'));
      // A folder without artifacts no longer exists without its sheet: the panel closes.
      if (empty) return requestClose(true);
      setInfo(null);
      setAccess(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const codeInvalid = accessValues.visibility === 'code' && (f.hasCode && f.visibility === 'code' ? accessValues.code.length > 0 && accessValues.code.length < 6 : accessValues.code.length < 6);
  const cutsAccess = accessDirty && accessValues.visibility !== f.visibility && f.visibility !== 'private';
  const nameChanged = normalizeLabel(infoValues.name) !== f.name;
  const nameInvalid = infoValues.name.trim() !== '' && normalizeLabel(infoValues.name) === null;

  return shell(
    <>
      <header className="shrink-0 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-7 sm:pt-4">
        <div className="-mx-2 flex items-center justify-end">
          <button type="button" onClick={() => requestClose()} aria-label={t('common.close')} data-tip={t('common.closeTip')} className={`${iconButton} tip-end`}><CloseIcon /></button>
        </div>
        <h2 id={titleId} className="mt-1 font-serif text-[1.75rem] leading-[1.15] font-normal tracking-[-0.015em] text-balance break-words">{displayTitle}</h2>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
          <span className="inline-flex items-center gap-1.5"><FolderIcon className="size-3.5" /><span className="font-mono">/d/{f.name}</span></span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5"><VisIcon className="size-3.5" />{visibilityLabel(f.visibility)}</span>
          {priv && via && <span>{t('tree.sharedVia', { title: labelOf(via) })}</span>}
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{tn('folder.count', f.count)}{f.privateCount > 0 && tn('folder.private', f.privateCount)}</span>
          {f.updatedAt && (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={f.updatedAt} title={formatDate(f.updatedAt)}>{modifiedText(f.updatedAt)}</time>
            </>
          )}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={primary} onClick={() => openFolderPreview(f.name).catch((e) => setError((e as Error).message))}>
            <OpenIcon className="size-4" />{t('folder.preview')}
          </button>
          <button type="button" className={`${ghost} ${priv ? 'tip' : ''}`} aria-disabled={priv || undefined} data-tip={priv ? t('folder.privateHint') : undefined}
            aria-describedby={priv ? `${baseId}-copy-hint` : undefined} onClick={() => { if (!priv) void copyLink(); }}>
            <CopyIcon className="size-4" />{t('common.copyLink')}
          </button>
          {priv && <span id={`${baseId}-copy-hint`} className="sr-only">{t('folder.privateHint')}</span>}
          <button type="button" className={ghost} onClick={() => void share()}><ShareIcon className="size-4" />{t('common.share7')}</button>
        </div>
      </header>

      <div role="tablist" aria-label={t('common.sections')} onKeyDown={onTabKey} className="no-scrollbar mt-5 flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 sm:px-5">
        {TABS.map((tb) => {
          const on = tab === tb.id;
          return (
            <button key={tb.id} ref={(el) => { tabRefs.current[tb.id] = el; }} type="button" role="tab" id={`${baseId}-tab-${tb.id}`} aria-selected={on} aria-controls={`${baseId}-panel-${tb.id}`}
              tabIndex={on ? 0 : -1} data-autofocus={on || undefined} onClick={() => setTab(tb.id)}
              className={`relative -mb-px inline-flex h-11 shrink-0 focus-visible:-outline-offset-2 items-center gap-2 rounded-t-lg px-2.5 text-sm whitespace-nowrap after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full ${on ? 'text-ink after:bg-ink' : 'text-muted hover:text-ink'}`}>
              {t(tb.label)}
              {tb.id === 'order' && <span className="text-[13px] text-muted tabular-nums">{f.count}</span>}
              {dirty[tb.id] && <span className="size-1.5 rounded-full bg-ring"><span className="sr-only">{t('common.unsaved')}</span></span>}
            </button>
          );
        })}
      </div>

      {error && <p role="alert" className="mx-5 mt-4 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger sm:mx-7">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        <div role="tabpanel" id={`${baseId}-panel-info`} aria-labelledby={`${baseId}-tab-info`} hidden={tab !== 'info'} className="space-y-6 px-5 py-6 sm:px-7">
          <Section>
            <form onSubmit={saveInfo} className="space-y-4">
              <label className="block space-y-1 text-sm">
                <span className="text-muted">{t('folder.pageTitle')}</span>
                <input className={field} value={infoValues.title} maxLength={120} placeholder={f.name} onChange={(e) => setInfo({ ...infoValues, title: e.target.value })} />
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-muted">{t('common.description')} <span className="text-xs">{t('folder.descriptionHint')}</span></span>
                <textarea className={`${field} min-h-24 resize-y leading-relaxed`} value={infoValues.description} maxLength={1000} rows={3}
                  onChange={(e) => setInfo({ ...infoValues, description: e.target.value })} />
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-muted">{t('folder.name')}</span>
                <span className="flex items-center rounded-lg border border-line hover:border-line-strong has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-ring">
                  <span className="pl-3 font-mono text-sm text-muted" aria-hidden="true">/d/</span>
                  <input className="min-w-0 flex-1 bg-transparent py-2 pr-3 font-mono text-sm outline-none focus-visible:outline-none" value={infoValues.name} maxLength={32} required
                    onChange={(e) => setInfo({ ...infoValues, name: e.target.value })} aria-invalid={nameInvalid || undefined}
                    aria-describedby={nameChanged ? `${baseId}-name-warn` : undefined} />
                </span>
                {nameChanged && (
                  <span id={`${baseId}-name-warn`} className={`block text-xs ${nameInvalid ? 'text-danger' : 'text-warn'}`}>
                    {nameInvalid ? t('common.charset') : t('folder.renameWarn', { n: f.count, name: f.name })}
                  </span>
                )}
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-muted">{t('move.label')}</span>
                <select className={field} value={f.parent ?? ''} disabled={pending === 'move'} onChange={(e) => void move(e.target.value === '' ? null : e.target.value)}>
                  {moveTargets(folders, f.name).map(({ folder, depth }) => (
                    <option key={folder?.name ?? ''} value={folder?.name ?? ''}>
                      {folder ? `${'\u00a0\u00a0'.repeat(depth)}${folderPath(folders, folder.name)}` : t('move.root')}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                <button className={primary} disabled={!infoDirty || nameInvalid || pending === 'info'}>{pending === 'info' ? t('common.saving') : t('common.save')}</button>
                {infoDirty && <button type="button" className={ghost} onClick={() => setInfo(null)}>{t('common.discardEdits')}</button>}
              </div>
            </form>
          </Section>
          {f.hasSheet && (
            <Section title={t('common.dangerZone')} description={f.count === 0 ? t('folder.dangerEmpty') : t('folder.dangerFull')}>
              <button type="button" onClick={() => void removeSheet()} className="rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger hover:bg-danger/10">{f.count === 0 ? t('folder.delete') : t('folder.deleteSheet')}</button>
            </Section>
          )}
        </div>

        <div role="tabpanel" id={`${baseId}-panel-access`} aria-labelledby={`${baseId}-tab-access`} hidden={tab !== 'access'} className="space-y-6 px-5 py-6 sm:px-7">
          <Section>
            <p className="text-sm text-muted">
              {t('folder.accessIntro')}
              {f.privateCount > 0 && (priv ? tn('folder.privateWould', f.privateCount) : tn('folder.privateAre', f.privateCount))}
            </p>
            <form onSubmit={saveAccess} className="space-y-3">
              <VisibilityPicker value={accessValues.visibility} onChange={(visibility) => setAccess({ ...accessValues, visibility })} />
              {accessValues.visibility === 'code' && (
                <label className="block space-y-1 text-sm">
                  <span className="text-muted">{f.hasCode && f.visibility === 'code' ? t('common.newCode') : t('common.secretCode')}</span>
                  <input className={field} autoComplete="off" value={accessValues.code} onChange={(e) => setAccess({ ...accessValues, code: e.target.value })} />
                </label>
              )}
              {cutsAccess && <p className="text-xs text-warn">{t('folder.cutsAccess')}</p>}
              {accessValues.visibility === 'link' && f.visibility !== 'link' && (
                <RevivedLinksNote links={f.links} pending={pending === 'revoke-old'}
                  onRevoke={() => void act('revoke-old', async () => {
                    for (const l of f.links.filter((x) => x.active)) await api.revokeFolderLink(f.name, l.id);
                  }, t('notice.folderOldLinksRevoked'))} />
              )}
              <div className="flex flex-wrap gap-2">
                <button className={primary} disabled={!accessDirty || codeInvalid || pending === 'access'}>{pending === 'access' ? t('common.applying') : t('common.apply')}</button>
                {accessDirty && <button type="button" className={ghost} onClick={() => setAccess(null)}>{t('common.cancel')}</button>}
              </div>
            </form>
          </Section>

          <Section title={t('common.shareLinks')}
            description={f.visibility === 'link' ? t('folder.linksLink') : t('folder.linksOther')}>
            {f.visibility !== 'link' ? (
              <button type="button" className={ghost} onClick={() => void share()}><ShareIcon className="size-4" />{t('common.share7')}</button>
            ) : (
              <>
                <LinkCreateForm form={linkForm} onChange={setLinkForm} onSubmit={createLink} pending={pending === 'link'} />
                <ul className="space-y-2">
                  {f.links.map((l) => <LinkRow key={l.id} l={l} current={l.url !== null && l.url === f.activeLinkUrl} onCopy={() => copyText(l.url!).then(() => onNotice(t('common.linkCopied')), () => onNotice(t('common.copyFailed')))} onRevoke={() => void act('revoke', () => api.revokeFolderLink(f.name, l.id), t('common.linkRevoked'))} />)}
                  {f.links.length === 0 && <li className="text-sm text-muted">{t('common.noLinksYet')}</li>}
                </ul>
              </>
            )}
          </Section>

          <Section title={t('common.audience')} description={t('folder.audience')}>
            {tab === 'access' && <Audience key={f.name} id={f.name} visibility={f.visibility} load={(days) => api.folderStats(f.name, days)}
              emptyText={priv ? t('folder.audienceEmptyPrivate') : t('folder.audienceEmpty')} />}
          </Section>

          <Section title={t('common.cutAccessTitle')} description={t('folder.cutDescription')}>
            <button type="button" className={ghost}
              onClick={() => window.confirm(t('confirm.folderRevokeAll')) && void act('revoke-all', () => api.revokeAllFolder(f.name), t('notice.folderAccessCut'))}>
              {t('common.cutAll')}
            </button>
          </Section>
        </div>

        <div role="tabpanel" id={`${baseId}-panel-order`} aria-labelledby={`${baseId}-tab-order`} hidden={tab !== 'order'} className="px-5 py-6 sm:px-7">
          <OrderList folder={f} onSave={(ids) => act('order', () => api.orderFolder(f.name, ids), t('notice.orderSaved'))} />
        </div>
      </div>
    </>,
  );
}
