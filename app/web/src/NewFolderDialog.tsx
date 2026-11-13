import { useId, useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { normalizeLabel } from './format.ts';
import { t } from './i18n/index.ts';
import { Modal } from './Modal.tsx';
import type { FolderDetail } from './types.ts';

const field = 'w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm hover:border-line-strong';

/** Explicit creation of an empty folder: private by default, shareable later from its panel. */
export function NewFolderDialog({ existing, onClose, onCreated }: {
  existing: string[]; onClose: () => void; onCreated: (folder: FolderDetail) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const slug = normalizeLabel(name);
  const typed = name.trim() !== '';
  const taken = !!slug && existing.includes(slug);
  const hint = !typed ? t('newFolder.hintEmpty') : !slug ? t('common.charset') : taken ? t('newFolder.taken') : t('newFolder.private');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!slug || taken) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await api.createFolder({ name: slug, ...(title.trim() && { title: title.trim() }), ...(description.trim() && { description: description.trim() }) });
      await onCreated(folder);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('common.newFolder')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1 text-sm">
          <label htmlFor={`${id}-name`} className="block text-muted">{t('folder.name')}</label>
          <input id={`${id}-name`} data-autofocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('common.namePlaceholder')} autoComplete="off"
            aria-invalid={(typed && !slug) || taken || undefined} aria-describedby={`${id}-url ${id}-hint`} className={field} />
          <span id={`${id}-url`} className="block truncate font-mono text-xs text-muted">/d/<strong className="font-medium text-ink">{slug ?? '…'}</strong></span>
          <span id={`${id}-hint`} className={`block text-xs ${(typed && !slug) || taken ? 'text-danger' : 'text-muted'}`}>{hint}</span>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t('common.title')} <span className="text-xs">{t('newFolder.titleHint')}</span></span>
          <input maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={slug ?? ''} className={field} />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t('common.description')} <span className="text-xs">{t('newFolder.descriptionHint')}</span></span>
          <textarea maxLength={1000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className={`${field} min-h-20 resize-y leading-relaxed`} />
        </label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button disabled={busy || !slug || taken} className="w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-canvas disabled:opacity-40">
          {busy ? t('common.creating') : t('common.create')}
        </button>
      </form>
    </Modal>
  );
}
