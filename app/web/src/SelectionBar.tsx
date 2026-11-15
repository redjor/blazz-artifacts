import { useId, useState, type FormEvent } from 'react';
import { MAX_TAGS, normalizeLabel, visibilityHint, visibilityLabel } from './format.ts';
import { t, tn } from './i18n/index.ts';
import { CheckIcon, CloseIcon, EyeIcon, FolderIcon, PinIcon, PlusIcon, TagIcon, TrashIcon, VISIBILITY_ICON } from './icons.tsx';
import { Popover } from './Popover.tsx';
import type { ArtifactDto, Visibility } from './types.ts';
import { menuItem, TOOL_PANEL, TOOL_WRAP, toolButton } from './ui.ts';

/** Visibilities offered in bulk: a secret code is set one artifact at a time (design 05). */
export type BulkVisibility = Exclude<Visibility, 'code'>;
const BULK_VISIBILITIES: BulkVisibility[] = ['private', 'link', 'public'];
export type TagsOp = 'addTags' | 'removeTags';

const dangerButton = toolButton.replace('hover:text-ink', 'hover:text-danger');

/** The value every picked artifact shares, else undefined. */
function shared<T>(picked: ArtifactDto[], get: (a: ArtifactDto) => T): T | undefined {
  if (picked.length === 0) return undefined;
  const first = get(picked[0]);
  return picked.every((a) => get(a) === first) ? first : undefined;
}

/** Comma-separated tags, normalised and merged; null when one is invalid or there are too many. */
function parseTags(text: string): string[] | null {
  const out = new Set<string>();
  for (const part of text.split(',')) {
    if (!part.trim()) continue;
    const tag = normalizeLabel(part);
    if (!tag) return null;
    out.add(tag);
  }
  return out.size <= MAX_TAGS ? [...out] : null;
}

function TagsForm({ picked, suggestions, onTags, close }: {
  picked: ArtifactDto[]; suggestions: string[]; onTags: (op: TagsOp, tags: string[]) => void; close: () => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const tags = parseTags(text);
  const invalid = text.trim() !== '' && !tags;
  const ready = !!tags && tags.length > 0;
  // Tags already on the selection, most common first: one click removes a tag from every selected artifact.
  const counts = new Map<string, number>();
  for (const a of picked) for (const tag of a.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const onSelection = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const apply = (op: TagsOp, list: string[]) => {
    close();
    onTags(op, list);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) apply('addTags', tags);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1 text-sm">
        <label htmlFor={`${id}-in`} className="block text-xs font-medium text-muted">{t('select.tagsField')}</label>
        <input id={`${id}-in`} data-autofocus list={`${id}-list`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off"
          placeholder={t('select.tagsPlaceholder')} aria-invalid={invalid || undefined} aria-describedby={`${id}-hint`}
          className="w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm hover:border-line-strong" />
        <datalist id={`${id}-list`}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
        <span id={`${id}-hint`} className={`block text-xs ${invalid ? 'text-danger' : 'text-muted'}`}>{invalid ? t('labels.invalid') : t('select.tagsHint')}</span>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={!ready} className="flex-1 rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-canvas disabled:opacity-40">{t('select.addTags')}</button>
        <button type="button" disabled={!ready} onClick={() => { if (tags) apply('removeTags', tags); }}
          className="flex-1 rounded-lg bg-surface-2 px-3 py-1.5 text-sm font-medium hover:bg-surface-3 disabled:opacity-40">{t('select.removeTags')}</button>
      </div>
      {onSelection.length > 0 && (
        <div role="group" aria-labelledby={`${id}-on`} className="border-t border-line pt-3">
          <p id={`${id}-on`} className="text-xs font-medium text-muted">{t('select.onSelection')}</p>
          <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {onSelection.map(([tag, n]) => (
              <button key={tag} type="button" onClick={() => apply('removeTags', [tag])} aria-label={t('select.removeTag', { tag, n })}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 pr-1.5 pl-2.5 text-[13px] hover:bg-surface-3">
                #{tag} <span className="tabular-nums text-muted">{n}</span><CloseIcon className="size-3.5 text-muted" />
              </button>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}

/**
 * Bulk actions on the selected artifacts (design 05), in place of the gallery tools while something is selected.
 * Every action is one request for the whole selection; the safeguards (confirmations, undo) live in the Dashboard.
 */
export function SelectionBar({ picked, total, folders, paths, tagNames, trashOn, className = '', onMove, onNewFolder, onTags, onVisibility, onPin, onTrash, onSelectAll, onClear }: {
  /** Selected artifacts that are shown. */
  picked: ArtifactDto[];
  /** Artifacts shown (what “Select all” selects). */
  total: number;
  /** Folder names in tree order, and their readable paths. */
  folders: string[]; paths: Record<string, string>;
  tagNames: string[]; trashOn: boolean; className?: string;
  onMove: (to: string | null) => void; onNewFolder: () => void; onTags: (op: TagsOp, tags: string[]) => void;
  onVisibility: (v: BulkVisibility) => void; onPin: (pin: boolean) => void; onTrash: () => void;
  onSelectAll: () => void; onClear: () => void;
}) {
  const count = picked.length;
  const folderOfAll = shared(picked, (a) => a.project);
  const visibilityOfAll = shared(picked, (a) => a.visibility);
  const allPinned = picked.every((a) => a.pinned);
  const popover = { triggerClass: toolButton, wrapClass: TOOL_WRAP };
  return (
    <div role="group" aria-label={t('select.toolbar')} className={`flex flex-wrap items-center gap-x-1 gap-y-2 ${className}`}>
      <button type="button" onClick={onClear} aria-label={t('select.clear')} data-tip={t('select.clearTip')} aria-keyshortcuts="Escape" className={toolButton}>
        <CloseIcon />
      </button>
      <span className="pr-1 text-sm font-medium tabular-nums">{tn('select.count', count)}</span>
      {count < total && (
        <button type="button" onClick={onSelectAll} aria-keyshortcuts="Control+A Meta+A"
          className="rounded-full px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-ink">{t('select.all', { n: total })}</button>
      )}
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-line max-sm:hidden" />
      <div className="ml-auto flex items-center gap-1 sm:ml-0">
        <Popover label={t('select.move')} tip={t('select.move')} trigger={<FolderIcon />} {...popover} panelClass={`${TOOL_PANEL} sm:w-64 p-1.5`}>
          {(close) => (
            <div className="max-h-72 overflow-y-auto">
              {[null, ...folders].map((f) => {
                const current = folderOfAll === f;
                return (
                  <button key={f ?? '~none'} type="button" aria-current={current || undefined} onClick={() => { if (current) return; close(); onMove(f); }}
                    className={`${menuItem} pl-8`}>
                    <CheckIcon className={`-ml-5.5 size-3.5 ${current ? 'text-ink' : 'invisible'}`} />
                    <span className={`min-w-0 truncate ${current ? 'font-medium' : ''}`}>{f === null ? t('common.noFolder') : (paths[f] ?? f)}</span>
                    {current && <span className="sr-only">{t('card.current')}</span>}
                  </button>
                );
              })}
              <button type="button" onClick={() => { close(); onNewFolder(); }} className={`${menuItem} pl-8 text-muted hover:text-ink`}>
                <PlusIcon className="-ml-5.5 size-3.5" />{t('card.newFolder')}
              </button>
            </div>
          )}
        </Popover>
        <Popover label={t('select.tags')} tip={t('select.tags')} trigger={<TagIcon />} {...popover} panelClass={`${TOOL_PANEL} sm:w-72 p-3`}>
          {(close) => <TagsForm picked={picked} suggestions={tagNames} onTags={onTags} close={close} />}
        </Popover>
        <Popover label={t('select.visibility')} tip={t('select.visibility')} trigger={<EyeIcon />} {...popover} panelClass={`${TOOL_PANEL} sm:w-72 p-1.5`}>
          {(close) => (
            <>
              {BULK_VISIBILITIES.map((v) => {
                const Icon = VISIBILITY_ICON[v];
                const current = visibilityOfAll === v;
                return (
                  <button key={v} type="button" aria-current={current || undefined} onClick={() => { if (current) return; close(); onVisibility(v); }}
                    className={`${menuItem} items-start`}>
                    <Icon className="mt-0.5 size-4 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className={`block ${current ? 'font-medium' : ''}`}>{visibilityLabel(v)}{current && <span className="sr-only">{t('card.current')}</span>}</span>
                      <span className="block text-xs text-muted">{visibilityHint(v)}</span>
                    </span>
                    {current && <CheckIcon className="mt-0.5 size-4" />}
                  </button>
                );
              })}
              <p className="mx-2.5 mt-1 border-t border-line pt-2 pb-1 text-xs text-muted">{t('select.visibilityHint')}</p>
            </>
          )}
        </Popover>
        <button type="button" onClick={() => onPin(!allPinned)} aria-label={allPinned ? t('select.unpin') : t('select.pin')} data-tip={allPinned ? t('select.unpin') : t('select.pin')}
          className={toolButton}>
          <PinIcon />
        </button>
        <button type="button" onClick={onTrash} aria-label={trashOn ? t('select.trash') : t('select.delete')} data-tip={trashOn ? t('select.trash') : t('select.delete')}
          className={dangerButton}>
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}
