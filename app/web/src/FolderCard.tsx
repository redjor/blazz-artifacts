import { useState, type DragEvent } from 'react';
import { CARD_DRAG_TYPE, ThumbImage, useThumbnail } from './ArtifactCard.tsx';
import { formatDate, relativeDate, visibilityLabel, visibilityShort } from './format.ts';
import { t, tn } from './i18n/index.ts';
import { CopyIcon, FolderFilledIcon, KIND_ICON, MoreIcon, OpenIcon, ShareIcon, SlidersIcon, TrashIcon, VISIBILITY_ICON } from './icons.tsx';
import { Popover } from './Popover.tsx';
import type { FolderSummary } from './types.ts';

/** Named folder (cards never show the “no folder” entry). */
export type NamedFolder = FolderSummary & { name: string };

export interface FolderActions {
  onOpen: () => void; onManage: () => void; onCopy: () => void; onShare: () => void; onDelete: () => void;
  /** An artifact card dropped on the folder moves into it (keyboard alternative: “Move to…”). */
  onDropCard: (id: string) => void;
}

/** Roving tab key of a folder in the gallery (“~” belongs neither to folder names nor to identifiers). */
export const folderKey = (name: string) => `~f:${name}`;
export const folderOfKey = (key: string): string | null => (key.startsWith('~f:') ? key.slice(3) : null);

const plural = (n: number) => tn('folder.count', n);

/** Drop target for an artifact card: “over” state and handlers to spread on the element. */
export function useCardDrop(onDropCard: ((id: string) => void) | undefined) {
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => !!onDropCard && e.dataTransfer.types.includes(CARD_DRAG_TYPE);
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => { if (!accepts(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); },
      onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setOver(false); },
      onDrop: (e: DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(CARD_DRAG_TYPE);
        if (id) onDropCard!(id);
      },
    },
  };
}

const menuItem = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2 aria-disabled:cursor-default aria-disabled:hover:bg-transparent';

export function FolderMenu({ f, onOpen, onManage, onCopy, onShare, onDelete, onOpenChange, triggerClass, tabIndex }: Omit<FolderActions, 'onDropCard'> & {
  f: NamedFolder; onOpenChange?: (o: boolean) => void; triggerClass: string; tabIndex?: number;
}) {
  const priv = f.visibility === 'private';
  const full = f.count > 0;
  const label = f.title ?? f.name;
  const hintId = `folder-hint-${f.name}`;
  return (
    <Popover label={t('folder.actions', { title: label })} trigger={<MoreIcon />} triggerClass={triggerClass} panelClass="w-64 p-1.5" tabIndex={tabIndex} onOpenChange={onOpenChange}>
      {(close) => (
        <>
          <button type="button" className={menuItem} onClick={() => { close(); onOpen(); }}><OpenIcon className="size-4 text-muted" />{t('common.open')}</button>
          <button type="button" className={menuItem} aria-disabled={priv || undefined} aria-describedby={priv ? `${hintId}-copy` : undefined}
            onClick={() => { if (priv) return; close(); onCopy(); }}>
            <CopyIcon className={`size-4 ${priv ? 'text-line-strong' : 'text-muted'}`} />
            <span className="min-w-0">
              <span className={`block ${priv ? 'text-muted' : ''}`}>{t('common.copyLink')}</span>
              {priv && <span id={`${hintId}-copy`} className="block text-xs text-muted">{t('folder.privateHint')}</span>}
            </span>
          </button>
          <button type="button" className={menuItem} onClick={() => { close(); onShare(); }}><ShareIcon className="size-4 text-muted" />{t('common.share7')}</button>
          <div className="mx-2.5 my-1 h-px bg-line" role="separator" />
          <button type="button" className={menuItem} onClick={() => { close(); onManage(); }}><SlidersIcon className="size-4 text-muted" />{t('common.manage')}</button>
          <button type="button" className={`${menuItem} ${full ? '' : 'text-danger'}`} aria-disabled={full || undefined} aria-describedby={full ? `${hintId}-delete` : undefined}
            title={full ? t('folder.emptyFirst') : undefined} onClick={() => { if (full) return; close(); onDelete(); }}>
            <TrashIcon className={`size-4 ${full ? 'text-line-strong' : ''}`} />
            <span className="min-w-0">
              <span className={`block ${full ? 'text-muted' : ''}`}>{t('folder.delete')}</span>
              {full && <span id={`${hintId}-delete`} className="block text-xs text-muted">{t('folder.emptyFirst')}</span>}
            </span>
          </button>
        </>
      )}
    </Popover>
  );
}

/** Mosaic slot: thumbnail, else the kind's tinted tile; without an artifact, a dashed placeholder. */
function Slot({ item }: { item: FolderSummary['recent'][number] | undefined }) {
  const [thumb, onError] = useThumbnail(item?.thumbnailUrl ?? null);
  if (!item) return <span className="block rounded-[10px] border border-dashed border-line-strong" />;
  if (thumb) return <ThumbImage src={thumb} onError={onError} className="size-full min-h-0 rounded-[10px]" />;
  const Icon = KIND_ICON[item.kind];
  return <span className={`tile kind-${item.kind} grid min-h-0 place-items-center rounded-[10px]`}><Icon className="size-6 sm:size-7" /></span>;
}

/** Relative date, artifact count and shared visibility (icon + text, never for a private folder). */
function FolderMeta({ f, sharedViaTitle, className = '' }: { f: NamedFolder; sharedViaTitle?: string; className?: string }) {
  const Vis = VISIBILITY_ICON[f.visibility];
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-muted ${className}`}>
      {f.latestUpdatedAt && (
        <>
          <time dateTime={f.latestUpdatedAt} title={t('folder.lastActivity', { date: formatDate(f.latestUpdatedAt) })} className="shrink-0">{relativeDate(f.latestUpdatedAt)}</time>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span className="shrink-0 tabular-nums">{f.count === 0 && f.childCount === 0 ? t('folder.empty') : f.count === 0 ? tn('tree.subfolders', f.childCount) : <>{plural(f.count)}{f.childCount > 0 && <> · {tn('tree.subfolders', f.childCount)}</>}</>}</span>
      {f.visibility === 'private' && sharedViaTitle && (
        <>
          <span aria-hidden="true">·</span>
          <span className="truncate">{t('tree.sharedVia', { title: sharedViaTitle })}</span>
        </>
      )}
      {f.visibility !== 'private' && (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex min-w-0 items-center gap-1" title={t('folder.sharedTitle', { visibility: visibilityLabel(f.visibility) })}>
            <Vis className="size-3.5" /><span className="truncate">{visibilityShort(f.visibility)}</span>
          </span>
        </>
      )}
    </span>
  );
}

const openLabel = (f: NamedFolder) =>
  t('folder.openLabel', {
    title: f.title ?? f.name,
    count: f.count === 0 && f.childCount === 0 ? t('folder.emptyLower') : [f.count > 0 ? plural(f.count) : '', f.childCount > 0 ? tn('tree.subfolders', f.childCount) : ''].filter(Boolean).join(', '),
    shared: f.visibility !== 'private' ? t('folder.sharedPart', { visibility: visibilityLabel(f.visibility).toLowerCase() }) : '',
  });

export function FolderCard({ f, sharedViaTitle, tabbable, onFocusCard, ...actions }: FolderActions & { f: NamedFolder; sharedViaTitle?: string; tabbable: boolean; onFocusCard: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { over, handlers } = useCardDrop(actions.onDropCard);
  const slots = [0, 1, 2, 3].map((i) => f.recent[i]);
  return (
    <li className={`group relative min-w-0 ${menuOpen ? 'z-20' : ''}`} {...handlers}>
      <button type="button" data-static data-card={folderKey(f.name)} tabIndex={tabbable ? 0 : -1} onFocus={onFocusCard} onClick={actions.onOpen}
        aria-label={openLabel(f)} aria-keyshortcuts="E"
        className={`card block w-full overflow-hidden rounded-2xl border text-left transition-[border-color,background-color] ${over ? 'drop-over border-ring' : 'border-line bg-surface hover:border-line-strong'}`}>
        <span aria-hidden="true" className="folder-mosaic grid aspect-[2/1] grid-cols-2 grid-rows-2 gap-2 p-3 sm:gap-2.5 sm:p-3.5">
          {slots.map((item, i) => <Slot key={item?.id ?? `empty-${i}`} item={item} />)}
        </span>
        <span className="flex items-center gap-3 border-t border-line px-4 pt-3 pb-3.5 sm:px-5">
          <FolderFilledIcon className="folder-glyph size-7" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] leading-6">{f.title ?? f.name}</span>
            <FolderMeta f={f} sharedViaTitle={sharedViaTitle} className="mt-0.5" />
          </span>
        </span>
      </button>
      <div className={`absolute top-3 right-3 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${menuOpen ? 'opacity-100' : 'opacity-0'}`}>
        <FolderMenu f={f} {...actions} onOpenChange={setMenuOpen} tabIndex={tabbable ? 0 : -1}
          triggerClass="grid size-8 place-items-center rounded-lg bg-black/65 text-white shadow-sm ring-1 ring-white/15 hover:bg-black/80" />
      </div>
    </li>
  );
}

export function FolderRow({ f, sharedViaTitle, tabbable, onFocusCard, ...actions }: FolderActions & { f: NamedFolder; sharedViaTitle?: string; tabbable: boolean; onFocusCard: () => void }) {
  const { over, handlers } = useCardDrop(actions.onDropCard);
  return (
    <li className={`flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4 ${over ? 'drop-over' : ''}`} {...handlers}>
      <button type="button" data-static data-card={folderKey(f.name)} tabIndex={tabbable ? 0 : -1} onFocus={onFocusCard} onClick={actions.onOpen}
        aria-label={openLabel(f)} aria-keyshortcuts="E" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left sm:gap-4">
        <span className="folder-mosaic grid size-10 shrink-0 place-items-center rounded-lg"><FolderFilledIcon className="folder-glyph size-6" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{f.title ?? f.name}</span>
          <FolderMeta f={f} sharedViaTitle={sharedViaTitle} />
        </span>
        {f.title && <span className="hidden shrink-0 font-mono text-xs text-muted lg:block">/d/{f.name}</span>}
      </button>
      <div className="hidden shrink-0 gap-1 text-sm sm:flex">
        <button type="button" tabIndex={tabbable ? 0 : -1} onClick={actions.onManage} className="rounded-lg px-2.5 py-1.5 hover:bg-surface-2">{t('common.manage')}</button>
      </div>
      <div className="shrink-0">
        <FolderMenu f={f} {...actions} tabIndex={tabbable ? 0 : -1} triggerClass="grid size-9 place-items-center rounded-lg hover:bg-surface-2" />
      </div>
    </li>
  );
}
