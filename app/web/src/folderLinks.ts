// Folder link actions, shared by the gallery (folder cards and menus) and the folder panel:
// one place for the exposure safeguard, the 7-day share and the “copy link” rules.
import { api, copyDeferred, copyText } from './api.ts';
import { subtreeExposure, type TreeFolder } from './folderTree.ts';
import { t, tn } from './i18n/index.ts';
import type { FolderDetail, Visibility } from './types.ts';

/** What the link actions read from a folder: its summary in the gallery, its detail in the panel. */
type LinkFolder = Pick<FolderDetail, 'name' | 'visibility' | 'privateCount' | 'activeLinkUrl'> & { url: string | null };

/** Safeguard: number of private artifacts that would become visible through the folder when switching to `next`. */
export function confirmExposure(f: Pick<FolderDetail, 'name' | 'visibility' | 'privateCount'>, next: Visibility, tree: TreeFolder[] = []): boolean {
  if (next === 'private' || f.visibility !== 'private') return true;
  const sub = subtreeExposure(tree, f.name);
  const privateCount = Math.max(f.privateCount, sub.privateArtifacts);
  if (privateCount === 0 && sub.folders === 0) return true;
  const extra = sub.folders > 0 ? tn('exposure.subtree', sub.folders) : '';
  const how = t(`exposure.${next}`);
  const body = privateCount === 0
    ? tn('exposure.confirmFolders', sub.folders, { name: f.name, how })
    : tn('exposure.confirm', privateCount, { name: f.name, how });
  return window.confirm(`${body}${extra}\n\n${t('confirm.continue')}`);
}

/**
 * Share for 7 days: private-artifact safeguard, confirmation when current visitors lose access, then the link
 * is created and copied. Null when a confirmation was declined; rejects with the API error.
 */
export async function shareFolderFor7Days(f: LinkFolder, tree: TreeFolder[]): Promise<{ project: FolderDetail; copied: boolean } | null> {
  if (!confirmExposure(f, 'link', tree)) return null;
  if ((f.visibility === 'public' || f.visibility === 'code') && !window.confirm(t('confirm.folderToLink'))) return null;
  const req = api.shareFolder(f.name, { hours: 168 });
  // Copy started in the click's user activation, fed once the server answers.
  const copied = copyDeferred(req.then((r) => {
    if (!r.link.url) throw new Error(t('common.unreadableLink'));
    return r.link.url;
  })).then(() => true, () => false);
  const { project } = await req;
  return { project, copied: await copied };
}

/**
 * Copy a folder's link: the address that actually works for a visitor (public address, address + code, active link).
 * True when there is no active link and the owner agreed to create one: the caller then shares the folder.
 */
export async function copyFolderLink(f: LinkFolder, notify: (message: string) => void): Promise<boolean> {
  const copy = (url: string, ok: string) => copyText(url).then(() => notify(ok), () => notify(t('common.copyFailed')));
  if (f.visibility === 'private' || !f.url) {
    notify(t('folder.privateHint'));
    return false;
  }
  if (f.visibility === 'public') await copy(f.url, t('notice.folderAddressCopied'));
  else if (f.visibility === 'code') await copy(f.url, t('notice.addressCopiedCode'));
  else if (f.activeLinkUrl) await copy(f.activeLinkUrl, t('notice.folderLinkCopied'));
  else return window.confirm(t('confirm.noActiveFolderLink'));
  return false;
}
