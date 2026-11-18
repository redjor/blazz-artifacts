import { formatDate } from './format.ts';
import { t } from './i18n/index.ts';
import { ChevronDownIcon, ShareIcon, WarningIcon } from './icons.tsx';
import { Popover } from './Popover.tsx';
import type { ArtifactDetail, ArtifactDto, Visibility } from './types.ts';
import { VisibilityPicker } from './VisibilityPicker.tsx';

const menuItem = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2';
const small = 'inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium hover:bg-surface-2';

/** The address a visitor can actually use, given the visibility; null when there is none. */
export const reachableUrl = (a: ArtifactDto): string | null =>
  a.visibility === 'public' || a.visibility === 'code' ? a.url : a.visibility === 'link' ? a.activeLinkUrl : null;

/** “Link” visibility without any usable link and no shared folder to reach it: nobody can open the artifact. */
export const linkWithoutLink = (a: ArtifactDto) =>
  a.visibility === 'link' && !a.activeLinkUrl && (!a.folderVisibility || a.folderVisibility === 'private');

/**
 * One “Share” entry point (design 13): visibility applied at once, the working address with Copy, or what to do
 * when there is none; “Manage” opens the Access tab for links, audience and codes.
 */
export function SharePopover({ view, detail, busy, triggerClass, onVisibility, onShare, onCopy, onManage }: {
  view: ArtifactDto; detail: ArtifactDetail | null; busy: boolean; triggerClass: string;
  /**
   * Immediate change, or 'tab' when a choice must be made first in the Access tab (a code to type, earlier links that
   * would work again): the popover then closes.
   */
  onVisibility: (v: Visibility) => 'tab' | 'applied';
  /** Creates a 7-day link (switching to link visibility) and copies it. */
  onShare: () => void;
  onCopy: (url: string) => void;
  onManage: () => void;
}) {
  const url = reachableUrl(view);
  const link = view.visibility === 'link' ? detail?.links.find((l) => l.url !== null && l.url === view.activeLinkUrl) : undefined;
  return (
    <Popover label={t('share.label', { title: view.title })} align="start" triggerClass={triggerClass} wrapClass="relative max-sm:static"
      panelClass="w-[min(22rem,calc(100vw-2.5rem))] p-2"
      trigger={<><ShareIcon className="size-4" />{t('share.button')}<ChevronDownIcon className="-mr-1 size-4 text-muted" /></>}>
      {(close) => (
        <>
          <VisibilityPicker compact immediate value={view.visibility} disabled={busy}
            onChange={(v) => {
              if (onVisibility(v) === 'tab') close();
            }} />
          <div className="mx-1 my-2 h-px bg-line" role="separator" />
          <div className="space-y-2 px-1 pb-1 text-sm" aria-live="polite">
            {url ? (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-line py-1 pr-1 pl-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>{url}</span>
                  <button type="button" className={small} data-autofocus onClick={() => { close(); onCopy(url); }}>{t('common.copy')}</button>
                </div>
                <p className="text-xs text-muted">
                  {view.visibility === 'code' ? t('share.codeHint')
                    : view.visibility === 'public' ? t('share.publicHint')
                      : link?.expiresAt ? t('link.expiresOn', { date: formatDate(link.expiresAt) }) : t('link.none')}
                </p>
              </>
            ) : linkWithoutLink(view) ? (
              <>
                <p className="flex gap-2 text-warn"><WarningIcon className="mt-0.5 size-4 shrink-0" />{t('share.noActiveLink')}</p>
                <button type="button" className={small} disabled={busy} onClick={() => { close(); onShare(); }}>{t('share.createLink')}</button>
              </>
            ) : (
              <>
                <p className="text-muted">
                  {view.project && view.folderVisibility && view.folderVisibility !== 'private' ? t('share.viaFolderOnly', { folder: view.project }) : t('share.privateHint')}
                </p>
                <button type="button" className={small} disabled={busy} onClick={() => { close(); onShare(); }}>{t('share.createLink')}</button>
              </>
            )}
          </div>
          <div className="mx-1 my-2 h-px bg-line" role="separator" />
          <button type="button" className={menuItem} onClick={() => { close(); onManage(); }}>{t('share.manage')}</button>
        </>
      )}
    </Popover>
  );
}
