import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.ts';
import { kindLabel, visibilityShort } from './format.ts';
import { t, tn } from './i18n/index.ts';
import { FolderIcon, KIND_ICON, SearchIcon } from './icons.tsx';
import { useLayer } from './layers.ts';
import type { ArtifactDto } from './types.ts';

/** An action of the palette: label, optional shortcut shown on the right, and what it does. */
export interface PaletteAction { id: string; label: string; icon: ReactNode; keys?: string[]; run: () => void }
export interface PaletteFolder { name: string; title: string | null; count: number }

type Entry =
  | { kind: 'artifact'; key: string; a: ArtifactDto }
  | { kind: 'folder'; key: string; f: PaletteFolder }
  | { kind: 'action'; key: string; action: PaletteAction };

const MAX_ARTIFACTS = 8;
const MAX_FOLDERS = 6;
const RECENT = 5;

/** Accents and case ignored: "ecran" matches "Écran". */
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Every typed word appears in the text. */
const matches = (text: string, words: string[]) => words.every((w) => text.includes(w));

/**
 * Command palette (design 08): Ctrl/Cmd+K, then a few letters and Enter to reach an artifact, a folder or an action.
 * Combobox pattern: the input keeps focus, `aria-activedescendant` points at the active option.
 */
export function CommandPalette({ items, folders, paths, actions, onClose, onOpenArtifact, onOpenArtifactTab, onOpenFolder }: {
  items: ArtifactDto[]; folders: PaletteFolder[];
  /** Readable path of each folder (“client / mockups”). */
  paths: Record<string, string>;
  actions: PaletteAction[];
  onClose: () => void;
  onOpenArtifact: (a: ArtifactDto) => void; onOpenArtifactTab: (a: ArtifactDto) => void; onOpenFolder: (name: string) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Full-text matches (design 07) for `q`, ids best first.
  const [content, setContent] = useState<{ q: string; ids: string[] } | null>(null);
  const id = useId();
  useLayer({ el: layer, modal: true, onEscape: onClose });

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      api.search(term).then((r) => { if (current) setContent({ q: term, ids: r.results.map((x) => x.id) }); }, () => {});
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);

  const words = fold(query).split(/\s+/).filter(Boolean);
  const pathOf = (name: string | null) => (name ? (paths[name] ?? name) : t('common.noFolder'));
  let artifacts: ArtifactDto[];
  if (words.length === 0) {
    artifacts = [...items].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, RECENT);
  } else {
    const local = items.filter((a) => matches(fold(`${a.title} ${a.slug} ${a.tags.join(' ')} ${a.project ? pathOf(a.project) : ''}`), words));
    // Title matches first, then the most recent.
    local.sort((x, y) => Number(matches(fold(y.title), words)) - Number(matches(fold(x.title), words)) || y.updatedAt.localeCompare(x.updatedAt));
    const byId = new Map(items.map((a) => [a.id, a]));
    const seen = new Set(local.map((a) => a.id));
    const fromText = content?.q === query.trim() ? content.ids.filter((x) => !seen.has(x) && byId.has(x)).map((x) => byId.get(x)!) : [];
    artifacts = [...local, ...fromText].slice(0, MAX_ARTIFACTS);
  }
  const foundFolders = words.length === 0 ? [] : folders
    .filter((f) => matches(fold(`${f.title ?? ''} ${f.name} ${pathOf(f.name)}`), words))
    .sort((x, y) => pathOf(x.name).localeCompare(pathOf(y.name)))
    .slice(0, MAX_FOLDERS);
  const foundActions = actions.filter((x) => matches(fold(x.label), words));

  const groups: { label: string; entries: Entry[] }[] = [
    { label: words.length === 0 ? t('palette.recent') : t('palette.artifacts'), entries: artifacts.map((a) => ({ kind: 'artifact' as const, key: `a:${a.id}`, a })) },
    { label: t('palette.folders'), entries: foundFolders.map((f) => ({ kind: 'folder' as const, key: `f:${f.name}`, f })) },
    { label: t('palette.actions'), entries: foundActions.map((action) => ({ kind: 'action' as const, key: `x:${action.id}`, action })) },
  ].filter((g) => g.entries.length > 0);
  const flat = groups.flatMap((g) => g.entries);
  const current = flat.length ? Math.min(active, flat.length - 1) : -1;
  const optionId = (i: number) => `${id}-o${i}`;

  useEffect(() => {
    if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  });

  const pick = (e: Entry, newTab = false) => {
    onClose();
    if (e.kind === 'artifact') (newTab ? onOpenArtifactTab : onOpenArtifact)(e.a);
    else if (e.kind === 'folder') onOpenFolder(e.f.name);
    else e.action.run();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Enter' && current >= 0) {
      e.preventDefault();
      pick(flat[current], e.ctrlKey || e.metaKey);
    }
  };

  let index = -1;
  return createPortal(
    <div ref={layer} className="enter-fade fixed inset-0 z-40 flex items-start justify-center overscroll-contain bg-[var(--scrim)] p-3 pt-[10vh] sm:p-4 sm:pt-[14vh]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t('palette.title')} onClick={(e) => e.stopPropagation()}
        className="enter-rise surface-raised flex max-h-[76dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-surface">
        <label className="flex shrink-0 items-center gap-3 border-b border-line px-4">
          <SearchIcon className="size-5 text-muted" />
          <span className="sr-only">{t('palette.title')}</span>
          <input data-autofocus type="text" role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined} autoComplete="off" spellCheck={false}
            value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} placeholder={t('palette.placeholder')}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] outline-none focus-visible:outline-none" />
        </label>
        <p role="status" className="sr-only">{flat.length === 0 ? t('gallery.noResults') : tn('gallery.results', flat.length)}</p>
        <div id={`${id}-list`} role="listbox" aria-label={t('palette.title')} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {flat.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">{t('gallery.noResults')}</p>}
          {groups.map((g, gi) => (
            <div key={g.label} role="group" aria-labelledby={`${id}-g${gi}`} className="pb-1">
              <p id={`${id}-g${gi}`} className="px-3 pt-2 pb-1 text-xs font-medium text-muted">{g.label}</p>
              {g.entries.map((e) => {
                index += 1;
                const i = index;
                const on = i === current;
                return (
                  <div key={e.key} id={optionId(i)} role="option" aria-selected={on} onMouseMove={() => { if (!on) setActive(i); }}
                    onMouseDown={(ev) => ev.preventDefault()} onClick={(ev) => pick(e, ev.ctrlKey || ev.metaKey)}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${on ? 'bg-surface-2' : ''}`}>
                    <EntryRow e={e} pathOf={pathOf} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <p className="hidden shrink-0 border-t border-line px-4 py-2 text-xs text-muted sm:block">{t('palette.hint')}</p>
      </div>
    </div>,
    document.body,
  );
}

function EntryRow({ e, pathOf }: { e: Entry; pathOf: (name: string | null) => string }) {
  if (e.kind === 'artifact') {
    const Icon = KIND_ICON[e.a.kind];
    return (
      <>
        <span aria-hidden="true" className={`band kind-${e.a.kind} grid size-8 shrink-0 place-items-center rounded-md`}><Icon className="glyph size-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{e.a.title}</span>
          <span className="block truncate text-xs text-muted">{pathOf(e.a.project)} · {kindLabel(e.a.kind)} · {visibilityShort(e.a.visibility)}</span>
        </span>
      </>
    );
  }
  if (e.kind === 'folder') {
    return (
      <>
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2"><FolderIcon className="size-4 text-muted" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{e.f.title ?? e.f.name}</span>
          <span className="block truncate text-xs text-muted">{pathOf(e.f.name)} · {tn('folder.count', e.f.count)}</span>
        </span>
      </>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md text-muted">{e.action.icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{e.action.label}</span>
      {e.action.keys && <span className="flex shrink-0 gap-1">{e.action.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>}
    </>
  );
}
