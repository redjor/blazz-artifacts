import { useEffect, useId, useRef, useState } from 'react';
import { artifactOpenLabel, formatCount, formatDate, formatDay, formatViews, kindLabel, relativeDate, visibilityLabel, visibilityShort } from './format.ts';
import { t } from './i18n/index.ts';
import { CheckIcon, ChevronDownIcon, CopyIcon, FolderIcon, KIND_ICON, MoreIcon, OpenIcon, PinIcon, PlusIcon, ShareIcon, SlidersIcon, VISIBILITY_ICON } from './icons.tsx';
import { Popover } from './Popover.tsx';
import type { ArtifactDto } from './types.ts';

export interface CardActions {
  onManage: () => void; onPreview: () => void; onCopy: () => void; onShare: () => void; onTogglePin: () => void;
  /** Existing folders (names), targets of “Move to…”. */
  folders: string[];
  onMove: (project: string | null) => void; onNewFolder: () => void;
}

/** Drag type of a card dropped on a folder (lowercase: dataTransfer.types normalises it). */
export const CARD_DRAG_TYPE = 'application/x-blazz-artifact-id';

/** Badge readable on any thumbnail (light, dark, busy): opaque background, ring, shadow. */
const chip = 'bg-black/65 text-white shadow-sm ring-1 ring-white/15';

const menuItem = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2 aria-disabled:cursor-default aria-disabled:hover:bg-transparent';

export function ActionsMenu({ a, onManage, onPreview, onCopy, onShare, onTogglePin, folders, onMove, onNewFolder, onOpenChange, triggerClass, tabIndex }: CardActions & {
  a: ArtifactDto; onOpenChange?: (o: boolean) => void; triggerClass: string; tabIndex?: number;
}) {
  const priv = a.visibility === 'private';
  // “Move to…” expands inside the menu: the button stays in place (focus never lands on a removed node).
  const [moveOpen, setMoveOpen] = useState(false);
  const moveList = useRef<HTMLDivElement>(null);
  const moveId = useId();
  useEffect(() => {
    if (moveOpen) moveList.current?.querySelector<HTMLElement>('button:not([aria-current])')?.focus();
  }, [moveOpen]);
  const target = (close: () => void, project: string | null, label: string) => {
    const current = a.project === project;
    return (
      <button key={project ?? '~none'} type="button" className={`${menuItem} pl-8`} aria-current={current || undefined}
        onClick={() => { if (current) return; close(); onMove(project); }}>
        <CheckIcon className={`-ml-5.5 size-3.5 ${current ? 'text-ink' : 'invisible'}`} />
        <span className={`min-w-0 truncate ${current ? 'font-medium' : ''}`}>{label}</span>
        {current && <span className="sr-only">{t('card.current')}</span>}
      </button>
    );
  };
  return (
    <Popover label={t('card.actions', { title: a.title })} trigger={<MoreIcon />} triggerClass={triggerClass} panelClass="w-64 p-1.5" tabIndex={tabIndex}
      onOpenChange={(o) => { if (!o) setMoveOpen(false); onOpenChange?.(o); }}>
      {(close) => (
        <>
          <button type="button" className={menuItem} onClick={() => { close(); onPreview(); }}><OpenIcon className="size-4 text-muted" />{t('common.open')}</button>
          <button type="button" className={menuItem} aria-disabled={priv || undefined} aria-describedby={priv ? `copy-hint-${a.id}` : undefined}
            onClick={() => { if (priv) return; close(); onCopy(); }}>
            <CopyIcon className={`size-4 ${priv ? 'text-line-strong' : 'text-muted'}`} />
            <span className="min-w-0">
              <span className={`block ${priv ? 'text-muted' : ''}`}>{t('common.copyLink')}</span>
              {priv && <span id={`copy-hint-${a.id}`} className="block text-xs text-muted">{t('card.privateHint')}</span>}
            </span>
          </button>
          <button type="button" className={menuItem} onClick={() => { close(); onShare(); }}><ShareIcon className="size-4 text-muted" />{t('common.share7')}</button>
          <button type="button" className={menuItem} onClick={() => { close(); onTogglePin(); }}>
            <PinIcon className="size-4 text-muted" />{a.pinned ? t('card.unpin') : t('card.pin')}
          </button>
          <button type="button" className={menuItem} aria-expanded={moveOpen} aria-controls={moveOpen ? moveId : undefined} onClick={() => setMoveOpen(!moveOpen)}>
            <FolderIcon className="size-4 text-muted" /><span className="flex-1">{t('card.moveTo')}</span>
            <ChevronDownIcon className={`size-4 text-muted transition-transform ${moveOpen ? 'rotate-180' : ''}`} />
          </button>
          {moveOpen && (
            <div ref={moveList} id={moveId} className="max-h-60 overflow-y-auto">
              {target(close, null, t('common.noFolder'))}
              {folders.map((f) => target(close, f, f))}
              <button type="button" className={`${menuItem} pl-8 text-muted hover:text-ink`} onClick={() => { close(); onNewFolder(); }}>
                <PlusIcon className="-ml-5.5 size-3.5" />{t('card.newFolder')}
              </button>
            </div>
          )}
          <div className="mx-2.5 my-1 h-px bg-line" role="separator" />
          <button type="button" className={menuItem} onClick={() => { close(); onManage(); }}><SlidersIcon className="size-4 text-muted" />{t('common.manage')}</button>
        </>
      )}
    </Popover>
  );
}

/** Quiet line: relative date, visibility (icon + text), views (hidden at zero), folder and tags. */
export function MetaLine({ a, className = '' }: { a: ArtifactDto; className?: string }) {
  const Vis = VISIBILITY_ICON[a.visibility];
  const sharedFolder = a.project && a.folderVisibility && a.folderVisibility !== 'private' ? a.folderVisibility : null;
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-muted ${className}`}>
      <time dateTime={a.updatedAt} title={t('common.modifiedOn', { date: formatDate(a.updatedAt) })} className="shrink-0">{relativeDate(a.updatedAt)}</time>
      <span aria-hidden="true">·</span>
      <span className="inline-flex shrink-0 items-center gap-1"><Vis className="size-3.5" />{visibilityShort(a.visibility)}</span>
      {a.views.total > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums" title={t('card.viewsTitle', { total: formatCount(a.views.total), last30: formatCount(a.views.last30) })}>{formatViews(a.views.total)}</span>
        </>
      )}
      {(a.project || a.tags.length > 0) && (
        <>
          <span aria-hidden="true">·</span>
          {/* Folder shared: the artifact is visible through it whatever its own visibility. */}
          {sharedFolder && (
            <span className="inline-flex shrink-0 items-center" title={t('card.viaFolder', { folder: a.project ?? '', visibility: visibilityLabel(sharedFolder).toLowerCase() })}>
              <FolderIcon className="size-3.5" /><span className="sr-only">{t('card.viaFolderSr')}</span>
            </span>
          )}
          <span className="truncate">
            {a.project}{a.project && a.tags.length > 0 && ' '}{a.tags.map((t) => `#${t}`).join(' ')}
          </span>
        </>
      )}
    </span>
  );
}

/** Thumbnail to show, or null when missing or failing to load (falls back to the excerpt). */
export function useThumbnail(url: string | null): [string | null, () => void] {
  const [failed, setFailed] = useState<string | null>(null);
  return [url && url !== failed ? url : null, () => setFailed(url)];
}

/** Capture made by the publish CLI, served by the admin API (img-src 'self'). Decorative: the title is next to it. */
export function ThumbImage({ src, onError, className = '' }: { src: string; onError: () => void; className?: string }) {
  return (
    <img src={src} alt="" width={960} height={600} loading="lazy" decoding="async" draggable={false} onError={onError}
      className={`thumb-img block object-cover object-top ${className}`} />
  );
}

function Wireframe() {
  return (
    <span className="block space-y-[2.2cqw] pt-[1cqw]">
      <span className="block h-[2.4cqw] w-3/4 rounded-full bg-paper-line" />
      <span className="block h-[9cqw] rounded-[1.4cqw] bg-paper-line/70" />
      <span className="grid grid-cols-2 gap-[2.2cqw]">
        <span className="block h-[7cqw] rounded-[1.4cqw] bg-paper-line/70" />
        <span className="block h-[7cqw] rounded-[1.4cqw] bg-paper-line/70" />
      </span>
    </span>
  );
}

/** Sheet content: the artifact's real excerpt, scaled to the card (cqw units). */
function Sheet({ a }: { a: ArtifactDto }) {
  const p = a.preview;
  const meta = (
    <span className="mt-[2.2cqw] flex items-center gap-[1.2cqw] text-[2.3cqw] leading-none text-paper-muted">
      <span className="rounded-[0.8cqw] bg-paper-line/60 px-[1.2cqw] py-[0.7cqw]">{formatDay(a.updatedAt)}</span>
      <span>{kindLabel(a.kind)}</span>
    </span>
  );

  if (a.kind === 'pdf') {
    const Icon = KIND_ICON.pdf;
    return (
      <span className="flex h-full flex-col items-center pt-[7cqw] text-center">
        <Icon className="glyph size-[11cqw]" />
        <span className="mt-[3cqw] max-w-full truncate px-[2cqw] text-[3cqw] font-medium">{a.version?.originalName ?? a.title}</span>
        <span className="mt-[1.2cqw] text-[2.4cqw] text-paper-muted">{t('card.pdfDocument')}</span>
      </span>
    );
  }

  if ((a.kind === 'site' || a.kind === 'html') && !p?.heading && !p?.text) return <Wireframe />;

  if (a.kind === 'site') {
    return (
      <>
        <span className="mb-[2.6cqw] flex items-center gap-[1cqw]">
          <span className="size-[1.4cqw] rounded-full bg-paper-line" />
          <span className="size-[1.4cqw] rounded-full bg-paper-line" />
          <span className="h-[1.4cqw] w-1/4 rounded-full bg-paper-line/70" />
        </span>
        <span className="line-clamp-2 text-[4.2cqw] font-semibold leading-[1.15] tracking-[-0.01em]">{p?.heading ?? a.title}</span>
        {p?.text && <span className="mt-[1.8cqw] line-clamp-4 text-[2.6cqw] leading-[1.5] text-paper-muted">{p.text}</span>}
      </>
    );
  }

  if (a.kind === 'json') {
    return (
      <>
        <span className="line-clamp-2 font-serif text-[5cqw] leading-[1.12] text-balance">{a.title}</span>
        {meta}
        {p?.text && <span className="block mt-[2.6cqw] overflow-hidden whitespace-pre font-mono text-[2.4cqw] leading-[1.5] text-paper-muted">{p.text}</span>}
      </>
    );
  }

  return (
    <>
      <span className="line-clamp-2 font-serif text-[5.2cqw] leading-[1.12] text-balance">{p?.heading ?? a.title}</span>
      {meta}
      {p?.text && <span className="mt-[3cqw] line-clamp-4 text-[2.75cqw] leading-[1.55]">{p.text}</span>}
    </>
  );
}

export function ArtifactCard({ a, tabbable, onFocusCard, ...actions }: CardActions & { a: ArtifactDto; tabbable: boolean; onFocusCard: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [thumb, onThumbError] = useThumbnail(a.thumbnailUrl);
  return (
    <li className={`group relative min-w-0 ${menuOpen ? 'z-20' : ''}`}>
      <button type="button" data-static data-card={a.id} tabIndex={tabbable ? 0 : -1} onFocus={onFocusCard} onClick={actions.onPreview}
        draggable onDragStart={(e) => { e.dataTransfer.setData(CARD_DRAG_TYPE, a.id); e.dataTransfer.effectAllowed = 'move'; }}
        aria-label={artifactOpenLabel(a)}
        aria-keyshortcuts="E"
        className="card block w-full overflow-hidden rounded-2xl border border-line bg-surface text-left transition-[border-color] hover:border-line-strong">
        <span className="relative block">
          <span aria-hidden="true" className={`band kind-${a.kind} @container relative block aspect-[2/1] overflow-hidden`}>
            <span className="sheet-back absolute top-[8.5%] right-[10.5%] left-[12.5%] h-full" />
            <span className={`sheet sheet-front absolute top-[12%] right-[12%] left-[12%] h-full overflow-hidden ${thumb ? 'sheet-photo' : 'px-[5.5%] pt-[4.5%]'}`}>
              {thumb ? <ThumbImage src={thumb} onError={onThumbError} className="size-full rounded-t-[10px]" /> : <Sheet a={a} />}
            </span>
          </span>
          {a.version && (
            <span className={`absolute top-3 left-3 rounded-full px-2 py-0.5 text-[12px] leading-5 font-medium tabular-nums ${chip}`}>
              <span className="sr-only">{t('card.versionSr')}</span>v{a.version.number}
            </span>
          )}
          {/* Pin left of the ⋯ button (which sits at top-3 right-3, size-8): never overlapping. */}
          {a.pinned && (
            <span aria-hidden="true" title={t('card.pinned')} className={`absolute top-3 right-[3.25rem] grid size-8 place-items-center rounded-lg ${chip}`}>
              <PinIcon className="size-4" />
            </span>
          )}
        </span>
        <span className="block border-t border-line px-4 pt-3 pb-3.5 sm:px-5">
          <span className="block truncate text-[15px] leading-6">{a.title}</span>
          <MetaLine a={a} className="mt-0.5" />
        </span>
      </button>
      <div className={`absolute top-3 right-3 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 ${menuOpen ? 'opacity-100' : 'opacity-0'}`}>
        <ActionsMenu a={a} {...actions} onOpenChange={setMenuOpen} tabIndex={tabbable ? 0 : -1}
          triggerClass={`grid size-8 place-items-center rounded-lg ${chip} hover:bg-black/80`} />
      </div>
    </li>
  );
}
