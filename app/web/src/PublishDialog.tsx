import { useEffect, useState, type FormEvent } from 'react';
import { api, copyText } from './api.ts';
import { formatBytes, normalizeLabel, slugify, stripExtension } from './format.ts';
import { t } from './i18n/index.ts';
import { ProjectInput, TagsInput } from './Labels.tsx';
import { Modal } from './Modal.tsx';
import type { ArtifactDto, Visibility } from './types.ts';
import { VisibilityPicker } from './VisibilityPicker.tsx';

type SlugState = 'checking' | 'ok' | 'taken' | 'invalid';

export function PublishDialog({ file, defaultProject, projects, paths, tags: knownTags, onClose, onPublished }: {
  file: File; defaultProject: string; projects: string[]; paths?: Record<string, string>; tags: string[]; onClose: () => void; onPublished: () => void;
}) {
  const [project, setProject] = useState(defaultProject);
  const [tags, setTags] = useState<string[]>([]);
  const [title, setTitle] = useState(stripExtension(file.name));
  const [slug, setSlug] = useState(slugify(file.name));
  const [slugState, setSlugState] = useState<SlugState>('checking');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [code, setCode] = useState('');
  const [memoryStorage, setMemoryStorage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ArtifactDto | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSlugState('checking');
    const timer = setTimeout(() => {
      api.slug(slug).then((r) => setSlugState(!r.valid ? 'invalid' : r.available ? 'ok' : 'taken')).catch(() => setSlugState('invalid'));
    }, 300);
    return () => clearTimeout(timer);
  }, [slug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('title', title);
    form.set('slug', slug);
    form.set('visibility', visibility);
    if (visibility === 'code') form.set('code', code);
    if (memoryStorage) form.set('memoryStorage', 'true');
    if (project.trim()) form.set('project', normalizeLabel(project) ?? '');
    if (tags.length) form.set('tags', tags.join(','));
    form.set('file', file);
    try {
      setResult(await api.create(form));
      onPublished();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal title={t('publish.done')} onClose={onClose}>
        <p className="mb-2 text-sm text-muted">
          {result.visibility === 'link' ? t('publish.linkHint') : t('publish.urlLabel')}
        </p>
        <div className="flex gap-2">
          <input readOnly value={result.url} className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-3 py-2 text-sm hover:border-line-strong" />
          <button type="button" data-autofocus onClick={() => copyText(result.url).then(() => { setCopied(true); setError(null); }, () => { setCopied(false); setError(t('publish.copyFailed')); })} className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-canvas">
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Modal>
    );
  }

  const slugHint = t(`slug.${slugState}`);
  const canSubmit = !busy && slugState === 'ok' && title.trim() && (project.trim() === '' || normalizeLabel(project) !== null) && (visibility !== 'code' || code.length >= 6);

  return (
    <Modal title={t('publish.title')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="truncate rounded-lg bg-surface-2 px-3 py-2 text-sm">{file.name} · {formatBytes(file.size)}</p>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t('common.title')}</span>
          <input data-autofocus required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-line bg-transparent px-3 py-2 hover:border-line-strong" />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t('publish.url')} /a/<strong>{slug || '…'}</strong></span>
          <input required maxLength={48} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())}
            className="w-full rounded-lg border border-line bg-transparent px-3 py-2 font-mono hover:border-line-strong" />
          <span className={`text-xs ${slugState === 'ok' ? 'text-ok' : slugState === 'checking' ? 'text-muted' : 'text-danger'}`}>{slugHint}</span>
        </label>
        <ProjectInput value={project} onChange={setProject} projects={projects} paths={paths} />
        <TagsInput value={tags} onChange={setTags} suggestions={knownTags} />
        <VisibilityPicker value={visibility} onChange={setVisibility} />
        {visibility === 'code' && (
          <label className="block space-y-1 text-sm">
            <span className="text-muted">{t('common.secretCode')}</span>
            <input type="text" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border border-line bg-transparent px-3 py-2 hover:border-line-strong" />
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={memoryStorage} onChange={(e) => setMemoryStorage(e.target.checked)} className="mt-1" />
          <span>
            {t('common.memoryStorage')}
            <span className="block text-xs text-muted">{t('common.memoryStorageHint')}</span>
          </span>
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={!canSubmit} className="w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-canvas disabled:opacity-40">
          {busy ? t('publish.publishing') : t('publish.submit')}
        </button>
      </form>
    </Modal>
  );
}
