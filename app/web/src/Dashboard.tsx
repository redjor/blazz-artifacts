import { useBlocker, useMatchRoute, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, copyDeferred, copyText, openPreview } from './api.ts';
import { ActionsMenu, ArtifactCard, CARD_DRAG_TYPE, MetaLine } from './ArtifactCard.tsx';
import { ArtifactDrawer, type LinkActions } from './ArtifactPanel.tsx';
import { FolderCard, FolderMenu, FolderRow, folderKey, folderOfKey, type FolderActions, type NamedFolder } from './FolderCard.tsx';
import { confirmExposure, deleteChildrenNote, FolderDrawer, type TabId } from './FolderPanel.tsx';
import { ACCEPT_ALL, compareText, KIND_FILTERS, kindLabel, kindTileLabel, VISIBILITY_ORDER, visibilityLabel, visibilityShort } from './format.ts';
import { t, tn, type Locale, type MessageKey } from './i18n/index.ts';
import { LanguageSwitch } from './LanguageSwitch.tsx';
import { CheckIcon, ChevronDownIcon, CloseIcon, FilterIcon, FolderPlusIcon, GridIcon, KIND_ICON, KeyboardIcon, ListIcon, LogoutIcon, PinIcon, PlusIcon, SearchIcon, UploadIcon, VISIBILITY_ICON } from './icons.tsx';
import { hasOpenLayer, isEditable } from './layers.ts';
import { Popover, type PopoverHandle } from './Popover.tsx';
import { ancestorsOf, childrenOf, folderPath, sharedVia, treeOptions } from './folderTree.ts';
import { FolderBreadcrumb } from './FolderBreadcrumb.tsx';
import { NewFolderDialog } from './NewFolderDialog.tsx';
import { PublishDialog } from './PublishDialog.tsx';
import type { ArtifactDto, FolderSummary, Kind, LabelCount, Visibility } from './types.ts';

// Current folder: its name, null at the root, “~none” on /unfiled (“~” is not a valid label character).
const NONE = '~none';

const remember = <T extends string>(key: string, allowed: readonly T[], fallback: T) => ({
  read: (): T => {
    try {
      const v = localStorage.getItem(key);
      return allowed.includes(v as T) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  },
  write: (v: T) => {
    try {
      localStorage.setItem(key, v);
    } catch {
      // storage unavailable (private browsing): the choice lasts for the session
    }
  },
});

type View = 'grid' | 'list';
const viewPref = remember<View>('blazz-artifacts:view', ['grid', 'list'], 'grid');

type Sort = 'recent' | 'oldest' | 'title' | 'kind';
const SORTS: Sort[] = ['recent', 'oldest', 'title', 'kind'];
const sortPref = remember<Sort>('blazz-artifacts:sort', SORTS, 'recent');
const KIND_RANK = Object.fromEntries(KIND_FILTERS.map((k, i) => [k.kind, i])) as Record<Kind, number>;
const byRecent = (x: ArtifactDto, y: ArtifactDto) => y.updatedAt.localeCompare(x.updatedAt);
const COMPARE: Record<Sort, (x: ArtifactDto, y: ArtifactDto) => number> = {
  recent: byRecent,
  oldest: (x, y) => x.updatedAt.localeCompare(y.updatedAt),
  title: (x, y) => compareText(x.title, y.title),
  kind: (x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind] || byRecent(x, y),
};
// Pinned first (most recently pinned on top), then the chosen sort.
const byPinned = (x: ArtifactDto, y: ArtifactDto) =>
  x.pinnedAt && y.pinnedAt ? y.pinnedAt.localeCompare(x.pinnedAt) : x.pinnedAt ? -1 : y.pinnedAt ? 1 : 0;
// Folders: same sort, on their latest activity (sheet or most recent artifact) and their title (else their name).
const activity = (f: NamedFolder) => f.latestUpdatedAt ?? '';
const folderTitle = (f: NamedFolder) => f.title ?? f.name;
const folderByRecent = (x: NamedFolder, y: NamedFolder) => activity(y).localeCompare(activity(x)) || x.name.localeCompare(y.name);
const FOLDER_COMPARE: Record<Sort, (x: NamedFolder, y: NamedFolder) => number> = {
  recent: folderByRecent,
  oldest: (x, y) => activity(x).localeCompare(activity(y)) || x.name.localeCompare(y.name),
  title: (x, y) => compareText(folderTitle(x), folderTitle(y)),
  kind: folderByRecent,
};

// Round 36 px tool button (title row tools, top bar account tools).
const toolButton = 'tip tip-end relative grid size-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink aria-expanded:bg-surface-2 aria-expanded:text-ink aria-pressed:bg-surface-2 aria-pressed:text-ink';
// Toolbar menus: on mobile, anchored to the full toolbar width (never off screen).
const TOOL_WRAP = 'relative max-sm:static';
const TOOL_PANEL = 'max-sm:inset-x-0';
const menuItem = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2';
const chip = (on: boolean) =>
  `inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] ${on ? 'bg-ink text-canvas' : 'bg-surface-2 text-ink hover:bg-surface-3'}`;

const SHORTCUTS: { keys: (string | MessageKey)[]; label: MessageKey }[] = [
  { keys: ['/'], label: 'shortcut.search' },
  { keys: ['N'], label: 'shortcut.publish' },
  { keys: ['←', '↑', '→', '↓'], label: 'shortcut.move' },
  { keys: ['key.enter'], label: 'shortcut.open' },
  { keys: ['E'], label: 'shortcut.manage' },
  { keys: ['↑', '↓'], label: 'shortcut.panel' },
  { keys: ['key.esc'], label: 'shortcut.close' },
  { keys: ['?'], label: 'shortcut.help' },
];
const keyLabel = (k: string) => (k.startsWith('key.') ? t(k as MessageKey) : k);

/** Actual grid columns: cards aligned on the first row. */
function columnCount(list: HTMLElement | null): number {
  const items = list ? [...list.children] as HTMLElement[] : [];
  if (items.length === 0) return 1;
  const top = items[0].offsetTop;
  const n = items.findIndex((el) => el.offsetTop !== top);
  return n === -1 ? items.length : n;
}

/** `locale` is only read to re-render on a language change. */
export function Dashboard({ onLogout }: { onLogout: () => void; locale: Locale }) {
  const [items, setItems] = useState<ArtifactDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [projects, setProjects] = useState<FolderSummary[]>([]);
  // Folder drawer; `tab`: “Share” on the folder page opens it on the access tab.
  const [folderOpen, setFolderOpen] = useState<{ name: string; tab?: TabId } | null>(null);
  // “New folder” dialog; `moveId`: artifact to move into it once created (from a card's menu).
  const [newFolder, setNewFolder] = useState<{ moveId: string | null } | null>(null);
  const [tagCounts, setTagCounts] = useState<LabelCount[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [view, setViewState] = useState<View>(viewPref.read);
  const [sort, setSortState] = useState<Sort>(sortPref.read);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const shortcuts = useRef<PopoverHandle>(null);
  const gallery = useRef<HTMLElement>(null);
  const drawerDirty = useRef(false);

  // URL state (see router.tsx): the folder is the path, the open artifact is `?a=`.
  const router = useRouter();
  const matchRoute = useMatchRoute();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const project = params.folder ?? (matchRoute({ to: '/unfiled' }) ? NONE : null);
  const selected = search.a ?? null;
  // Read by callbacks created once (reload, closeDrawer): latest known state.
  const latest = useRef({ project, selected });
  useEffect(() => {
    latest.current = { project, selected };
  });

  /** Navigates to a folder (`NONE`: no folder, null: root) and an artifact panel. A new history entry unless `replace`. */
  const go = useCallback((p: string | null, a: string | null, replace = false) => {
    const query = a ? { a } : {};
    if (p === null) void router.navigate({ to: '/', search: query, replace });
    else if (p === NONE) void router.navigate({ to: '/unfiled', search: query, replace });
    else void router.navigate({ to: '/f/$folder', params: { folder: p }, search: query, replace });
  }, [router]);
  const setProject = (p: string | null, replace = false) => go(p, null, replace);
  // The panel opened with a history entry (Back closes it); opened from a link or a reload, closing replaces the URL.
  const pushedPanel = useRef(false);
  const openArtifact = (id: string) => {
    pushedPanel.current = true;
    go(project, id);
  };
  useEffect(() => {
    if (!selected) pushedPanel.current = false;
  }, [selected]);
  // Browser Back/Forward away from a panel with unsaved changes: the same question as the panel's own close.
  useBlocker({
    shouldBlockFn: ({ current, next, action }) =>
      action !== 'PUSH' && action !== 'REPLACE' && drawerDirty.current && current.search.a !== next.search.a && !window.confirm(t('common.discardConfirm')),
    enableBeforeUnload: false,
  });

  const setView = (v: View) => {
    setViewState(v);
    viewPref.write(v);
  };
  const setSort = (s: Sort) => {
    setSortState(s);
    sortPref.write(s);
  };

  const reload = useCallback(
    () =>
      Promise.all([api.list(), api.projects(), api.tags()])
        .then(([list, ps, ts]) => {
          setItems(list);
          setProjects(ps);
          setTagCounts(ts);
          setActiveTags((cur) => {
            const kept = cur.filter((t) => ts.some((x) => x.name === t));
            return kept.length === cur.length ? cur : kept;
          });
          // Folder or artifact of the URL deleted meanwhile (or unknown): back to the root / panel closed, quietly.
          const { project: p, selected: a } = latest.current;
          const keepP = p === null || p === NONE || ps.some((x) => x.name === p) ? p : null;
          const keepA = a !== null && list.some((x) => x.id === a) ? a : null;
          if (keepP !== p || keepA !== a) go(keepP, keepA, true);
        })
        .catch((e) => setNotice((e as Error).message))
        .finally(() => setLoaded(true)),
    [go],
  );
  // An artifact link (`?a=`) that is not in the loaded list (Back/Forward to a deleted one): panel closed.
  useEffect(() => {
    if (loaded && selected && !items.some((a) => a.id === selected)) go(project, null, true);
  }, [loaded, selected, items, project, go]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), Math.max(2500, notice.length * 60));
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  const q = query.trim().toLowerCase();
  const filtersActive = kind !== null || visibility !== null || activeTags.length > 0;
  // Root (“All”): folders as cards then artifacts without a folder; a search or a filter flattens (all artifacts).
  const atRoot = project === null;
  const flat = atRoot && (q !== '' || filtersActive);
  const visible = items
    .filter(
      (a) =>
        (project === null ? flat || a.project === null : project === NONE ? a.project === null : a.project === project) &&
        activeTags.every((t) => a.tags.includes(t)) &&
        (visibility === null || a.visibility === visibility) &&
        (kind === null || a.kind === kind) &&
        (!q || a.title.toLowerCase().includes(q) || a.slug.includes(q) || a.tags.some((t) => t.includes(q))),
    )
    .sort((x, y) => byPinned(x, y) || COMPARE[sort](x, y));
  const namedFolders = projects.filter((p): p is NamedFolder => p.name !== null);
  // Root: top-level folders (a search lists every matching folder, whatever its level). Inside a folder: its sub-folders.
  const inFolder = project !== null && project !== NONE ? project : null;
  const children = inFolder ? (childrenOf(namedFolders, inFolder) as NamedFolder[]) : [];
  const folderMatches = (f: NamedFolder) => f.name.includes(q) || !!f.title?.toLowerCase().includes(q);
  const folderCards: NamedFolder[] = filtersActive ? [] : atRoot
    ? namedFolders.filter((f) => (q ? folderMatches(f) : f.parent === null)).sort(FOLDER_COMPARE[sort])
    : children.filter((f) => !q || folderMatches(f));
  const artifactOrder = visible.map((a) => a.id);
  const order = [...folderCards.map((f) => folderKey(f.name)), ...artifactOrder];
  // Roving tabindex: a single card reachable with Tab, arrows do the rest.
  const tabbableId = focusId && order.includes(focusId) ? focusId : order[0];

  const projectNames = treeOptions(namedFolders).map((o) => o.folder.name);
  const sharedViaTitleOf = (f: NamedFolder) => { const v = f.visibility === 'private' ? sharedVia(namedFolders, f.name) : null; return v ? (v.title ?? v.name) : undefined; };
  const folderPaths = Object.fromEntries(namedFolders.map((f) => [f.name, folderPath(namedFolders, f.name)]));
  const currentFolder = namedFolders.find((p) => p.name === inFolder) ?? null;
  // Page title (top bar path and title row): the gallery, the open folder, or “no folder”.
  const pageTitle = project === null ? t('app.heading') : currentFolder ? folderTitle(currentFolder) : t('common.noFolder');
  const FolderVisIcon = VISIBILITY_ICON[currentFolder?.visibility ?? 'private'];
  const toggleTag = (t: string) => setActiveTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const filterCount = activeTags.length + (visibility ? 1 : 0) + (kind ? 1 : 0);
  const clearFilters = () => {
    setActiveTags([]);
    setVisibility(null);
    setKind(null);
  };
  // Count per kind in the current folder, before the kind filter: tiles stay comparable.
  const inScope = items.filter((a) => project === null || (project === NONE ? a.project === null : a.project === project));
  const kindCount = (k: Kind) => inScope.filter((a) => a.kind === k).length;

  const pick = (accept: string) => {
    const el = fileInput.current;
    if (!el) return;
    el.accept = accept;
    el.click();
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    searchButton.current?.focus();
  };
  // Sort choices, in the “Display” menu.
  const sortOptions = () => (
    <div role="radiogroup" aria-label={t('gallery.sortGroup')}>
      {SORTS.map((s) => (
        <label key={s} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ring">
          <input type="radio" name="gallery-sort" value={s} checked={sort === s} onChange={() => setSort(s)} className="sr-only" data-autofocus={sort === s || undefined} />
          <CheckIcon className={`size-4 ${sort === s ? 'text-ink' : 'invisible'}`} />
          <span className={sort === s ? 'font-medium' : ''}>{t(`sort.${s}`)}</span>
        </label>
      ))}
      <p className="mx-2.5 mt-1 border-t border-line pt-2 pb-1 text-xs text-muted">{t('gallery.pinnedFirst')}</p>
    </div>
  );

  // Gallery shortcuts: never while typing, with Ctrl/Cmd/Alt, or when a layer is open.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target) || hasOpenLayer()) return;
      if (e.key === '/') {
        e.preventDefault();
        if (searchOpen) searchInput.current?.focus();
        else setSearchOpen(true);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        pick(ACCEPT_ALL);
      } else if (e.key === '?') {
        e.preventDefault();
        shortcuts.current?.open();
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const focusCard = (id: string) => {
    setFocusId(id);
    list.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)?.focus();
  };
  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    const id = target.dataset.card;
    if (!id || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      const folder = folderOfKey(id);
      if (folder) setFolderOpen({ name: folder });
      else openArtifact(id);
      return;
    }
    const i = order.indexOf(id);
    const cols = view === 'grid' ? columnCount(list.current) : 1;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: order.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    if (to >= 0 && to < order.length) focusCard(order[to]);
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) setPending(file);
  };

  const run = (fn: () => Promise<unknown>, ok?: string) => fn().then(() => ok && setNotice(ok)).catch((e) => setNotice((e as Error).message));

  /** Share for 7 days: switch to “link” if needed (confirmation if visitors lose access), create the link, copy it. */
  const share = async (a: ArtifactDto): Promise<boolean> => {
    if ((a.visibility === 'public' || a.visibility === 'code') && !window.confirm(t('confirm.toLink'))) return false;
    const req = api.share(a.id, { hours: 168 });
    const copied = copyDeferred(req.then((r) => {
      if (!r.link.url) throw new Error(t('common.unreadableLink'));
      return r.link.url;
    })).then(() => true, () => false);
    try {
      await req;
    } catch (e) {
      setNotice((e as Error).message);
      return false;
    }
    setNotice((await copied) ? t('notice.link7Copied') : t('notice.link7NoCopy'));
    void reload();
    return true;
  };

  /** Copy link: the address that actually works for a visitor, given the visibility. */
  const copyLink = async (a: ArtifactDto): Promise<void> => {
    const copy = (url: string, ok: string) => copyText(url).then(() => setNotice(ok), () => setNotice(t('common.copyFailed')));
    if (a.visibility === 'private') return setNotice(t('card.privateHint'));
    if (a.visibility === 'public') return copy(a.url, t('common.linkCopied'));
    if (a.visibility === 'code') return copy(a.url, t('notice.linkCopiedCode'));
    if (a.activeLinkUrl) return copy(a.activeLinkUrl, t('notice.shareLinkCopied'));
    if (window.confirm(t('confirm.noActiveLink'))) await share(a);
  };

  const togglePin = async (a: ArtifactDto): Promise<void> => {
    try {
      await api.update(a.id, { pinned: !a.pinned });
      setNotice(a.pinned ? t('notice.unpinned') : t('notice.pinned'));
      await reload();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  /**
   * Moves an artifact (PATCH project). Into a shared folder, a non-public artifact becomes visible there:
   * explicit confirmation, as when sharing a folder that holds private artifacts.
   */
  const move = async (a: ArtifactDto, to: string | null): Promise<void> => {
    if (a.project === to) return;
    const dest = to === null ? undefined : projects.find((p) => p.name === to);
    if (dest && dest.visibility !== 'private' && a.visibility !== 'public' &&
      !window.confirm(t('confirm.moveToShared', { folder: to ?? '', folderVisibility: visibilityLabel(dest.visibility).toLowerCase(), title: a.title, visibility: visibilityLabel(a.visibility).toLowerCase() }))) return;
    lastIndex.current = Math.max(0, order.indexOf(a.id));
    try {
      await api.update(a.id, { project: to });
      setNotice(to ? t('notice.moved', { title: a.title, folder: to }) : t('notice.movedOut', { title: a.title }));
      await reload();
      // The card may leave the current view: focus goes to its neighbour.
      requestAnimationFrame(() => cardFocusTarget(a.id)?.focus());
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const onFolderCreated = async (f: { name: string }) => {
    const moveId = newFolder?.moveId ?? null;
    setNewFolder(null);
    const art = moveId ? items.find((a) => a.id === moveId) : undefined;
    if (art) {
      try {
        await api.update(art.id, { project: f.name });
        setNotice(t('notice.folderCreatedWith', { name: f.name, title: art.title }));
      } catch (e) {
        setNotice(t('notice.folderCreatedError', { name: f.name, error: (e as Error).message }));
      }
    } else setNotice(t('notice.folderCreated', { name: f.name }));
    await reload();
    setProject(f.name);
    if (!art) setFolderOpen({ name: f.name });
  };

  /** Enters a folder from its card: the search (which may have found it) closes, focus goes to the gallery. */
  const enterFolder = (name: string) => {
    setQuery('');
    setSearchOpen(false);
    setProject(name);
    setFocusId(null);
    requestAnimationFrame(() => (list.current?.querySelector<HTMLElement>('[data-card][tabindex="0"]') ?? gallery.current)?.focus());
  };
  /** Back to the root (breadcrumb): focus returns to the card of the folder just left. */
  const leaveFolder = () => {
    const from = project && project !== NONE ? project : null;
    setProject(null);
    if (!from) return;
    setFocusId(folderKey(from));
    requestAnimationFrame(() => cardFocusTarget(folderKey(from))?.focus());
  };

  const shareFolder = async (f: NamedFolder): Promise<void> => {
    if (!confirmExposure(f, 'link', namedFolders)) return;
    if ((f.visibility === 'public' || f.visibility === 'code') && !window.confirm(t('confirm.folderToLink'))) return;
    const req = api.shareFolder(f.name, { hours: 168 });
    const copied = copyDeferred(req.then((r) => {
      if (!r.link.url) throw new Error(t('common.unreadableLink'));
      return r.link.url;
    })).then(() => true, () => false);
    try {
      await req;
    } catch (e) {
      setNotice((e as Error).message);
      return;
    }
    setNotice((await copied) ? t('notice.folderLinkCopied7') : t('notice.link7NoCopyManage'));
    void reload();
  };

  /** Copy a folder's link: same rules as for an artifact (public address, address + code, active link). */
  const copyFolderLink = async (f: NamedFolder): Promise<void> => {
    const copy = (url: string, ok: string) => copyText(url).then(() => setNotice(ok), () => setNotice(t('common.copyFailed')));
    if (f.visibility === 'private' || !f.url) return setNotice(t('folder.privateHint'));
    if (f.visibility === 'public') return copy(f.url, t('notice.folderAddressCopied'));
    if (f.visibility === 'code') return copy(f.url, t('notice.addressCopiedCode'));
    if (f.activeLinkUrl) return copy(f.activeLinkUrl, t('notice.folderLinkCopied'));
    if (window.confirm(t('confirm.noActiveFolderLink'))) await shareFolder(f);
  };

  /** Deletes an empty folder (the menu disables it otherwise; the server only deletes the sheet). */
  const deleteFolder = async (f: NamedFolder): Promise<void> => {
    if (f.count > 0) return setNotice(t('folder.emptyFirst'));
    if (!window.confirm(t('confirm.deleteEmptyFolder', { title: f.title ?? f.name, name: f.name }) + deleteChildrenNote(namedFolders, f.name, f.parent))) return;
    const card = folderKey(f.name);
    lastIndex.current = Math.max(0, order.indexOf(card));
    try {
      await api.deleteFolder(f.name);
      setNotice(t('notice.folderDeleted'));
      // Deleted from its own page (breadcrumb menu): back to its parent, focus on the gallery.
      const here = f.name === project;
      if (here) setProject(f.parent, true);
      await reload();
      requestAnimationFrame(() => (here ? gallery.current : cardFocusTarget(card))?.focus());
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const moveById = (id: string, to: string | null) => {
    const a = items.find((x) => x.id === id);
    if (a) void move(a, to);
  };

  const folderActionsFor = (f: NamedFolder): FolderActions => ({
    onOpen: () => enterFolder(f.name),
    onManage: () => setFolderOpen({ name: f.name }),
    onCopy: () => void copyFolderLink(f),
    onShare: () => void shareFolder(f),
    onDelete: () => void deleteFolder(f),
    onDropCard: (id) => moveById(id, f.name),
  });

  const links: LinkActions = { copy: copyLink, share, togglePin };
  const actionsFor = (a: ArtifactDto) => ({
    folders: projectNames,
    onMove: (to: string | null) => void move(a, to),
    onNewFolder: () => setNewFolder({ moveId: a.id }),
    onManage: () => openArtifact(a.id),
    onPreview: () => void run(() => openPreview(a.id)),
    onCopy: () => void copyLink(a),
    onShare: () => void share(a),
    onTogglePin: () => void togglePin(a),
  });

  const closeDrawer = useCallback(() => {
    // The panel already asked about unsaved changes: the Back blocker must not ask again.
    drawerDirty.current = false;
    if (pushedPanel.current) {
      pushedPanel.current = false;
      router.history.back();
    } else go(latest.current.project, null, true);
  }, [router, go]);
  const selectedSummary = selected ? items.find((a) => a.id === selected) : undefined;
  // Position of the open artifact: if its card disappears (deletion), focus goes to its neighbour.
  const lastIndex = useRef(0);
  useEffect(() => {
    if (selected && order.includes(selected)) lastIndex.current = order.indexOf(selected);
  });
  const cardFocusTarget = (id: string): HTMLElement | null => {
    const card = (cid: string | undefined) => (cid ? list.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(cid)}"]`) ?? null : null);
    const own = card(id);
    if (own) {
      setFocusId(id);
      return own;
    }
    // The order may predate the reload: take the first card still present, following ones first.
    const i = lastIndex.current;
    for (const cid of [...order.slice(i), ...order.slice(0, i).reverse()]) {
      const other = card(cid);
      if (other) {
        setFocusId(cid);
        return other;
      }
    }
    return gallery.current;
  };

  return (
    <div className="min-h-dvh" onDragOver={(e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.relatedTarget) setDragging(false); }} onDrop={onDrop}>
      {/* Top bar on every page: the path on the left (the open folder carries its actions menu); Share in a folder, account tools at the root. */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-canvas px-3.5">
        <FolderBreadcrumb
          trail={project === null ? [] : [
            { name: null, title: t('app.heading') },
            ...(currentFolder ? ancestorsOf(namedFolders, currentFolder.name).map((a) => ({ name: a.name, title: a.title ?? a.name })) : []),
          ]}
          current={currentFolder ? (
            <FolderMenu f={currentFolder} {...folderActionsFor(currentFolder)} current align="start"
              trigger={<><span className="truncate">{pageTitle}</span><ChevronDownIcon className="size-3.5 text-muted" /></>}
              triggerClass="flex min-w-0 max-w-[16rem] items-center gap-1 rounded-md px-1.5 py-1 hover:bg-surface-2 aria-expanded:bg-surface-2" />
          ) : <span className="truncate px-1.5">{pageTitle}</span>}
          onOpen={(name) => (name === null ? leaveFolder() : setProject(name))} />
        {currentFolder ? (
          <button type="button" onClick={() => setFolderOpen({ name: currentFolder.name, tab: 'access' })}
            aria-label={t('folder.shareButtonLabel', { title: pageTitle, visibility: visibilityLabel(currentFolder.visibility).toLowerCase() })}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[15px] hover:bg-surface-2 max-sm:w-9 max-sm:justify-center max-sm:px-0">
            <FolderVisIcon className="size-[18px]" /><span className="max-sm:sr-only">{t('folder.shareButton')}</span>
          </button>
        ) : project === null && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Popover ref={shortcuts} label={t('gallery.shortcuts')} tip={t('gallery.shortcutsTip')} trigger={<KeyboardIcon />} triggerClass={toolButton} panelClass="w-[min(22rem,calc(100vw-2rem))] p-4">
              {() => (
                <div tabIndex={-1} data-autofocus className="outline-none">
                  <p className="text-sm font-medium">{t('gallery.shortcuts')}</p>
                  <dl className="mt-3 space-y-2 text-sm">
                    {SHORTCUTS.map((s) => (
                      <div key={s.label} className="flex items-center justify-between gap-3">
                        <dt className="text-muted">{t(s.label)}</dt>
                        <dd className="flex shrink-0 gap-1">{s.keys.map((k) => <kbd key={k}>{keyLabel(k)}</kbd>)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </Popover>
            <LanguageSwitch className="h-9 min-w-9" />
            <button type="button" onClick={onLogout} aria-label={t('gallery.logout')} data-tip={t('gallery.logout')} className={toolButton}>
              <LogoutIcon />
            </button>
          </div>
        )}
      </header>

      <div className="mx-auto max-w-[54rem] px-5 pt-10 pb-24 sm:px-8 sm:pt-12">
        {/* Title on the left, tools on the right; the search slots in before the tools (or below on mobile). */}
        <div className="relative flex flex-wrap items-center gap-x-3 gap-y-3">
          <h1 title={pageTitle} className="order-1 min-w-0 grow basis-0 truncate font-serif text-[2rem] leading-tight font-normal tracking-[-0.015em] sm:text-[2.25rem]">{pageTitle}</h1>

          {searchOpen && (
            <label className="order-3 flex h-9 w-full items-center gap-2 rounded-full border border-line bg-surface px-3.5 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring sm:order-2 sm:w-56">
              <SearchIcon className="size-4 text-muted" />
              <span className="sr-only">{t('shortcut.search')}</span>
              <input ref={searchInput} type="search" placeholder={t('gallery.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden" />
            </label>
          )}

          <div className="order-2 ml-auto flex shrink-0 items-center gap-2 sm:order-3">
            <div role="toolbar" aria-label={t('gallery.toolbar')} className="flex items-center gap-1">
            <button ref={searchButton} type="button" aria-label={searchOpen ? t('gallery.closeSearch') : t('shortcut.search')} data-tip={searchOpen ? t('gallery.closeSearch') : t('gallery.searchTip')}
              aria-keyshortcuts="/" aria-pressed={searchOpen} onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))} className={toolButton}>
              {searchOpen ? <CloseIcon /> : <SearchIcon />}
            </button>
            <Popover label={filterCount ? tn('gallery.filterActive', filterCount) : t('gallery.filter')} tip={t('gallery.filter')}
              trigger={<><FilterIcon />{filterCount > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-ring ring-2 ring-surface" />}</>}
              triggerClass={toolButton} wrapClass={TOOL_WRAP} panelClass={`${TOOL_PANEL} sm:w-[22rem] p-4`}>
              {() => (
                <div className="space-y-4">
                  <div role="group" aria-label={t('gallery.type')}>
                    <p className="text-xs font-medium text-muted">{t('gallery.type')}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button type="button" aria-pressed={kind === null} onClick={() => setKind(null)} className={chip(kind === null)}>{t('gallery.all')}</button>
                      {KIND_FILTERS.map(({ kind: k }) => (
                        <button key={k} type="button" aria-pressed={kind === k} disabled={kindCount(k) === 0 && kind !== k} onClick={() => setKind(kind === k ? null : k)}
                          className={`${chip(kind === k)} disabled:cursor-not-allowed disabled:opacity-40`}>
                          {kindTileLabel(k)} <span className="tabular-nums opacity-70">{kindCount(k)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div role="group" aria-label={t('common.visibility')}>
                    <p className="text-xs font-medium text-muted">{t('common.visibility')}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button type="button" aria-pressed={visibility === null} onClick={() => setVisibility(null)} className={chip(visibility === null)}>{t('gallery.all')}</button>
                      {VISIBILITY_ORDER.map((v) => (
                        <button key={v} type="button" aria-pressed={visibility === v} onClick={() => setVisibility(visibility === v ? null : v)} className={chip(visibility === v)}>
                          {visibilityShort(v)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div role="group" aria-label={t('gallery.tags')}>
                    <p className="text-xs font-medium text-muted">{t('gallery.tags')} <span className="font-normal">{t('gallery.tagsAllRequired')}</span></p>
                    {tagCounts.length === 0 ? (
                      <p className="mt-2 text-sm text-muted">{t('gallery.noTags')}</p>
                    ) : (
                      <div className="mt-2 flex max-h-52 flex-wrap gap-1.5 overflow-y-auto">
                        {tagCounts.map((tag) => (
                          <button key={tag.name} type="button" aria-pressed={activeTags.includes(tag.name)} onClick={() => toggleTag(tag.name)} className={chip(activeTags.includes(tag.name))}>
                            {tag.name} <span className="tabular-nums opacity-70">{tag.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {filterCount > 0 && (
                    <button type="button" onClick={clearFilters} className="text-sm text-muted underline decoration-line-strong hover:text-ink">{t('gallery.clearFilters')}</button>
                  )}
                </div>
              )}
            </Popover>
              {/* Layout and sort share one “Display” menu (three tools, as in the mockup). */}
              <Popover label={t('gallery.displayLabel', { layout: t(view === 'grid' ? 'gallery.grid' : 'gallery.list'), sort: t(`sort.${sort}`) })} tip={t('gallery.display')}
                trigger={<>{view === 'grid' ? <GridIcon /> : <ListIcon />}{sort !== 'recent' && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-ring ring-2 ring-surface" />}</>}
                triggerClass={toolButton} wrapClass={TOOL_WRAP} panelClass={`${TOOL_PANEL} sm:w-60 p-1.5`}>
                {() => (
                  <>
                    <div role="radiogroup" aria-label={t('gallery.layout')} className="grid grid-cols-2 gap-1">
                      {(['grid', 'list'] as const).map((v) => {
                        const Icon = v === 'grid' ? GridIcon : ListIcon;
                        return (
                          <label key={v} className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-ring ${view === v ? 'bg-surface-2 font-medium' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}>
                            <input type="radio" name="gallery-view" value={v} checked={view === v} onChange={() => setView(v)} className="sr-only" data-autofocus={view === v || undefined} />
                            <Icon className="size-4" />{t(v === 'grid' ? 'gallery.grid' : 'gallery.list')}
                          </label>
                        );
                      })}
                    </div>
                    <p className="mx-2.5 mt-2 border-t border-line pt-2.5 pb-1 text-xs font-medium text-muted">{t('gallery.sort')}</p>
                    {sortOptions()}
                  </>
                )}
              </Popover>
            </div>
            <Popover label={t('gallery.create')} trigger={<><PlusIcon className="size-[18px]" /><span>{t('gallery.create')}</span><ChevronDownIcon className="size-4 text-muted" /></>}
              triggerClass="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface-2 pr-2 pl-2.5 text-sm font-medium hover:bg-surface-3 aria-expanded:bg-surface-3" panelClass="w-64 p-1.5">
              {(close) => (
                <>
                  <button type="button" aria-keyshortcuts="N" onClick={() => { close(); pick(ACCEPT_ALL); }} className={menuItem}>
                    <UploadIcon className="size-4 text-muted" /><span className="flex-1">{t('shortcut.publish')}</span><kbd>N</kbd>
                  </button>
                  <button type="button" onClick={() => { close(); setNewFolder({ moveId: null }); }} className={menuItem}>
                    <FolderPlusIcon className="size-4 text-muted" />{currentFolder ? t('gallery.newSubfolder') : t('common.newFolder')}
                  </button>
                </>
              )}
            </Popover>
          </div>
        </div>

        {filterCount > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label={t('gallery.activeFilters')} role="group">
            {kind && (
              <button type="button" onClick={() => setKind(null)} className={chip(false)} aria-label={t('gallery.removeFilter', { name: kindTileLabel(kind) })}>
                {kindTileLabel(kind)} <CloseIcon className="size-3.5 text-muted" />
              </button>
            )}
            {visibility && (
              <button type="button" onClick={() => setVisibility(null)} className={chip(false)} aria-label={t('gallery.removeFilter', { name: visibilityShort(visibility) })}>
                {visibilityShort(visibility)} <CloseIcon className="size-3.5 text-muted" />
              </button>
            )}
            {activeTags.map((tag) => (
              <button key={tag} type="button" onClick={() => toggleTag(tag)} className={chip(false)} aria-label={t('gallery.removeTag', { name: tag })}>
                #{tag} <CloseIcon className="size-3.5 text-muted" />
              </button>
            ))}
            <button type="button" onClick={clearFilters} className="ml-1 text-[13px] text-muted underline decoration-line-strong hover:text-ink">{t('gallery.clearAll')}</button>
          </div>
        )}

        <section ref={gallery} tabIndex={-1} aria-label={project !== null ? t('gallery.folderSection', { name: pageTitle }) : t('gallery.published')} className="mt-8 outline-none sm:mt-10">
          {!loaded ? null : currentFolder && inScope.length === 0 && children.length === 0 ? (
            <div className="px-6 py-16 text-center sm:py-20">
              <p className="text-base text-muted">{t('gallery.folderEmpty', { name: pageTitle })}</p>
              <p className="mx-auto mt-3 max-w-sm text-sm text-muted text-pretty">{t('gallery.folderEmptyHint')}</p>
            </div>
          ) : items.length === 0 && namedFolders.length === 0 ? (
            <button type="button" data-static onClick={() => pick(ACCEPT_ALL)}
              className="grid w-full place-items-center gap-3 rounded-2xl border border-dashed border-line-strong px-6 py-20 text-center text-[15px] text-muted hover:bg-surface">
              <UploadIcon className="size-7" />
              {t('gallery.firstDrop')}
            </button>
          ) : order.length === 0 ? (
            <div className="rounded-2xl border border-line px-6 py-16 text-center">
              <p className="text-[15px]">{t('gallery.noResults')}</p>
              <p className="mt-1 text-sm text-muted">{t('gallery.noResultsHint')}</p>
              {(filterCount > 0 || kind || q) && (
                <button type="button" onClick={() => { clearFilters(); setQuery(''); }} className="mt-4 rounded-full bg-surface-2 px-4 py-2 text-sm hover:bg-surface-3">
                  {t('gallery.clearSearchFilters')}
                </button>
              )}
            </div>
          ) : view === 'grid' ? (
            <ul ref={list} onKeyDown={onListKey} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
              className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 lg:gap-x-8 lg:gap-y-8">
              {folderCards.map((f) => {
                const card = folderKey(f.name);
                return <FolderCard key={card} f={f} tabbable={card === tabbableId} onFocusCard={() => setFocusId(card)} sharedViaTitle={sharedViaTitleOf(f)} {...folderActionsFor(f)} />;
              })}
              {visible.map((a) => <ArtifactCard key={a.id} a={a} tabbable={a.id === tabbableId} onFocusCard={() => setFocusId(a.id)} {...actionsFor(a)} />)}
            </ul>
          ) : (
            <ul ref={list} onKeyDown={onListKey} className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {folderCards.map((f) => {
                const card = folderKey(f.name);
                return <FolderRow key={card} f={f} tabbable={card === tabbableId} onFocusCard={() => setFocusId(card)} sharedViaTitle={sharedViaTitleOf(f)} {...folderActionsFor(f)} />;
              })}
              {visible.map((a) => {
                const Icon = KIND_ICON[a.kind];
                const act = actionsFor(a);
                const tabbable = a.id === tabbableId;
                const priv = a.visibility === 'private';
                return (
                  <li key={a.id} className="flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
                    <button type="button" data-static data-card={a.id} tabIndex={tabbable ? 0 : -1} onFocus={() => setFocusId(a.id)} onClick={act.onPreview}
                      draggable onDragStart={(e) => { e.dataTransfer.setData(CARD_DRAG_TYPE, a.id); e.dataTransfer.effectAllowed = 'move'; }}
                      aria-label={t('card.openLabel', { title: a.title, version: '', pinned: a.pinned ? t('card.pinnedPart') : '' })} aria-keyshortcuts="E"
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left sm:gap-4">
                      <span className={`band kind-${a.kind} grid size-10 shrink-0 place-items-center rounded-lg`}><Icon className="glyph size-5" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          {a.pinned && <PinIcon className="size-3.5 text-muted" />}
                          <span className="truncate text-[15px]">{a.title}</span>
                        </span>
                        <MetaLine a={a} />
                        <span className="sr-only">{kindLabel(a.kind)}</span>
                      </span>
                      <span className="hidden shrink-0 font-mono text-xs text-muted lg:block">/a/{a.slug}{a.version && ` · v${a.version.number}`}</span>
                    </button>
                    <div className="hidden shrink-0 gap-1 text-sm sm:flex">
                      <button type="button" tabIndex={tabbable ? 0 : -1} onClick={() => { if (!priv) act.onCopy(); }} aria-disabled={priv || undefined}
                        data-tip={priv ? t('card.privateHint') : undefined} aria-label={priv ? t('gallery.copyLinkPrivate', { hint: t('card.privateHint') }) : t('common.copyLink')}
                        className={`rounded-lg px-2.5 py-1.5 ${priv ? 'tip tip-end cursor-default text-muted' : 'hover:bg-surface-2'}`}>{t('common.copy')}</button>
                      <button type="button" tabIndex={tabbable ? 0 : -1} onClick={act.onManage} className="rounded-lg px-2.5 py-1.5 hover:bg-surface-2">{t('common.manage')}</button>
                    </div>
                    <div className="shrink-0 sm:hidden">
                      <ActionsMenu a={a} {...act} tabIndex={tabbable ? 0 : -1} triggerClass="grid size-9 place-items-center rounded-lg hover:bg-surface-2" />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <input ref={fileInput} type="file" className="hidden" accept={ACCEPT_ALL}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) setPending(f); e.target.value = ''; }} />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-[var(--scrim)] p-6">
          <div className="enter-fade flex items-center gap-3 rounded-2xl border border-dashed border-line-strong bg-surface px-8 py-6 text-lg">
            <UploadIcon className="size-6 text-muted" /> {t('gallery.dropToPublish')}
          </div>
        </div>
      )}
      {/* Outside #root: still announced when a modal layer makes the page inert. */}
      {createPortal(
        <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          {notice && <div key={notice} className="enter-rise max-w-md rounded-xl bg-ink px-4 py-2.5 text-center text-sm text-canvas shadow-[0_10px_30px_-10px_oklch(0_0_0/0.5)]">{notice}</div>}
        </div>,
        document.body,
      )}
      {newFolder && <NewFolderDialog existing={namedFolders.map((f) => f.name)} parent={inFolder} parentTitle={currentFolder?.title ?? undefined} onClose={() => setNewFolder(null)} onCreated={onFolderCreated} />}
      {pending && <PublishDialog key={`${pending.name}-${pending.lastModified}-${pending.size}`} file={pending} defaultProject={project && project !== NONE ? project : ''} projects={projectNames} paths={folderPaths} tags={tagCounts.map((t) => t.name)} onClose={() => setPending(null)} onPublished={reload} />}
      {loaded && folderOpen && !selected && (
        <FolderDrawer key={folderOpen.name} name={folderOpen.name} initialTab={folderOpen.tab} folders={namedFolders} summary={projects.find((p) => p.name === folderOpen.name)} onClose={() => setFolderOpen(null)}
          onChanged={reload} onNotice={setNotice}
          fallbackFocus={() => list.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(folderKey(folderOpen.name))}"]`) ?? gallery.current}
          onRenamed={(n) => { setProject(n, true); setFolderOpen({ name: n }); }} />
      )}
      {loaded && selected && (
        <ArtifactDrawer id={selected} summary={selectedSummary} order={artifactOrder} projects={projectNames} paths={folderPaths} tagNames={tagCounts.map((t) => t.name)} links={links}
          onNavigate={(id) => { go(project, id, true); setFocusId(id); }} onClose={closeDrawer} onChanged={reload} onNotice={setNotice}
          dirtyRef={drawerDirty} restoreFocus={() => cardFocusTarget(selected)} />
      )}
    </div>
  );
}
