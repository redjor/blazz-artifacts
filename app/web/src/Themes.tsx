import { useEffect, useId, useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { FontPicker } from './FontPicker.tsx';
import { t } from './i18n/index.ts';
import { Modal } from './Modal.tsx';
import type { MarkdownTheme, ThemeDraft } from './types.ts';

const field = 'w-full rounded-lg border border-line bg-transparent px-3 py-2 text-base hover:border-line-strong';
const button = 'rounded-lg border border-line px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-40';
const primary = 'rounded-lg bg-ink px-3 py-2 text-sm font-medium text-canvas disabled:opacity-40';
const EMPTY: ThemeDraft = { name: '', clientName: '', logoDataUrl: '', primaryColor: '#1e3a5f', accentColor: '#2563eb', font: 'sans', width: 'standard', preset: 'documentation', header: '', footer: '' };

function PreviewFrame({ url }: { url: string }) {
  return <iframe title={t('themes.previewTitle')} src={url} sandbox="" referrerPolicy="no-referrer" className="h-[55dvh] min-h-64 w-full rounded-lg border border-line bg-white" />;
}

/** Editing a library entry never rewrites already generated documents. */
function ThemeEditor({ theme, onClose, onSaved, onDeleted }: {
  theme: MarkdownTheme | null; onClose: () => void; onSaved: (theme: MarkdownTheme) => void; onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<ThemeDraft>(theme ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const id = useId();
  const dirty = JSON.stringify(draft) !== JSON.stringify(theme ?? EMPTY);
  const close = () => { if (!busy && (!dirty || window.confirm(t('themes.unsaved')))) onClose(); };
  const change = <K extends keyof ThemeDraft>(key: K, value: ThemeDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value })); setPreview(''); setError('');
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setError('');
    try { onSaved(await api.saveTheme(draft, theme?.id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const showPreview = async () => {
    setBusy(true); setError('');
    try { setPreview((await api.themePreview({ ...draft, name: draft.name.trim() || t('themes.previewTitle') })).url); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!theme || !window.confirm(t('themes.deleteConfirm'))) return;
    setBusy(true); setError('');
    try { await api.deleteTheme(theme.id); onDeleted(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const logo = async (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 512 * 1024) { setError(t('themes.logoInvalid')); return; }
    setBusy(true);
    try {
      const value = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
      });
      change('logoDataUrl', value);
    } catch { setError(t('themes.logoInvalid')); }
    finally { setBusy(false); }
  };
  return <Modal title={theme ? t('themes.edit') : t('themes.new')} onClose={close} wide>
    <p className="mb-4 text-sm text-muted">{t('themes.editHint')}</p>
    <form onSubmit={submit} aria-label={t('themes.edit')} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        <legend className="sr-only">{t('themes.title')}</legend>
        <div><label htmlFor={`${id}-name`} className="mb-1 block text-sm">{t('themes.name')}</label>
          <input id={`${id}-name`} name="name" className={field} required maxLength={120} value={draft.name} onChange={(e) => change('name', e.target.value)} /></div>
        <div><label htmlFor={`${id}-client`} className="mb-1 block text-sm">{t('themes.clientName')}</label>
          <input id={`${id}-client`} name="clientName" className={field} maxLength={120} value={draft.clientName} onChange={(e) => change('clientName', e.target.value)} /></div>
        <div><label htmlFor={`${id}-logo`} className="mb-1 block text-sm">{t('themes.logo')}</label>
          <input id={`${id}-logo`} name="logo" type="file" accept="image/png,image/jpeg,image/webp" className={field} onChange={(e) => { void logo(e.target.files?.[0]); e.target.value = ''; }} />
          {draft.logoDataUrl && <div className="mt-2 flex items-center gap-3"><img src={draft.logoDataUrl} alt={draft.clientName} className="max-h-14 max-w-32 object-contain" /><button type="button" className={button} onClick={() => change('logoDataUrl', '')}>{t('themes.removeLogo')}</button></div>}</div>
        <fieldset><legend className="mb-2 text-sm">{t('themes.preset')}</legend><div className="flex flex-wrap gap-2">
          {(['documentation', 'report', 'editorial'] as const).map((value) => <label key={value} className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 has-checked:bg-surface-2">
            <input type="radio" name="preset" value={value} checked={draft.preset === value} onChange={() => change('preset', value)} />{t(`themes.${value}`)}</label>)}
        </div></fieldset>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(['primaryColor', 'accentColor'] as const).map((key) => <div key={key}><label htmlFor={`${id}-${key}`} className="mb-1 block text-sm">{t(`themes.${key}`)}</label>
            <div className="flex gap-2"><input type="color" aria-label={t(`themes.${key}`)} className="h-11 w-12 shrink-0 cursor-pointer rounded border border-line" value={draft[key]} onChange={(e) => change(key, e.target.value)} />
              <input id={`${id}-${key}`} name={key} className={`${field} font-mono`} pattern="#[0-9a-fA-F]{6}" required maxLength={7} spellCheck={false} value={draft[key]} onChange={(e) => change(key, e.target.value)} /></div></div>)}
          <div><label htmlFor={`${id}-width`} className="mb-1 block text-sm">{t('themes.width')}</label><select id={`${id}-width`} name="width" className={field} value={draft.width} onChange={(e) => change('width', e.target.value as ThemeDraft['width'])}>
            {(['narrow', 'standard', 'wide'] as const).map((v) => <option key={v} value={v}>{t(`themes.${v}`)}</option>)}</select></div>
        </div>
        <FontPicker value={draft.font} onChange={(font) => change('font', font)} />
        {(['header', 'footer'] as const).map((key) => <div key={key}><label htmlFor={`${id}-${key}`} className="mb-1 block text-sm">{t(`themes.${key}`)}</label>
          <textarea id={`${id}-${key}`} name={key} className={`${field} resize-y`} rows={2} maxLength={500} value={draft[key]} onChange={(e) => change(key, e.target.value)} /></div>)}
      </fieldset>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primary} disabled={busy}>{busy ? t('common.saving') : t('common.save')}</button>
        <button type="button" className={button} disabled={busy} onClick={() => void showPreview()}>{t('themes.preview')}</button>
        {theme && <button type="button" className={`${button} text-danger`} disabled={busy} onClick={() => void remove()}>{t('themes.delete')}</button>}
      </div>
    </form>
    {preview && <div className="mt-5"><PreviewFrame url={preview} /></div>}
  </Modal>;
}

/** Shared selection UI for a folder default or a Markdown document override. */
export function ThemeSection({ themeId, effectiveThemeId, artifactId, versionId, onSave, onChanged }: {
  themeId: string | null; effectiveThemeId: string | null; artifactId?: string; versionId?: string;
  onSave: (id: string | null) => Promise<unknown>; onChanged: () => Promise<unknown>;
}) {
  const [themes, setThemes] = useState<MarkdownTheme[]>([]);
  const [selected, setSelected] = useState(themeId ?? '');
  const [editor, setEditor] = useState<MarkdownTheme | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<{ url: string; themeId: string | null; versionId: string; previewToken: string } | null>(null);
  const id = useId();
  useEffect(() => { let live = true; api.themes().then((list) => { if (live) { setThemes(list); setLoaded(true); } }, (e) => { if (live) setError((e as Error).message); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  const chosen = themes.find((theme) => theme.id === selected);
  const effective = themes.find((theme) => theme.id === effectiveThemeId);
  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); if (message) setNotice(message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const showPreview = () => run(async () => {
    if (!artifactId || !versionId) return;
    const result = await api.artifactThemePreview(artifactId, selected || null);
    setPreview({ url: result.url, themeId: selected || null, versionId, previewToken: result.previewToken });
  });
  return <section className="space-y-3 border-t border-line pt-6" aria-labelledby={`${id}-title`}>
    <div><h3 id={`${id}-title`} className="text-[15px] font-medium">{t('themes.title')}</h3>
      <p className="mt-1 text-sm text-muted">{t(artifactId ? 'themes.artifactHint' : 'themes.folderHint')}</p></div>
    <form aria-labelledby={`${id}-title`} onSubmit={(e) => { e.preventDefault(); void run(() => onSave(selected || null), t(artifactId ? 'themes.selectionSaved' : 'themes.saved')); }} className="space-y-3">
      <label htmlFor={`${id}-select`} className="sr-only">{t('themes.title')}</label>
      <select id={`${id}-select`} name="themeId" className={field} disabled={busy || loading || !loaded} value={selected} onChange={(e) => { setSelected(e.target.value); setPreview(null); setNotice(''); }}>
        <option value="">{t(artifactId ? 'themes.inherit' : 'themes.inheritFolder')}</option>
        {themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
      </select>
      <p className="text-xs text-muted">{t('themes.effective', { name: effective?.name ?? t('themes.default') })}</p>
      <div className="flex flex-wrap gap-2">
        {artifactId && versionId && <button type="button" className={primary} disabled={busy || loading || !loaded} onClick={() => void showPreview()}>{t('themes.previewApply')}</button>}
        <button type="submit" className={button} disabled={busy || loading || !loaded}>{t('themes.saveSelection')}</button>
      </div>
    </form>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => setEditor(null)}>{t('themes.new')}</button>
      {chosen && <button type="button" className={button} disabled={busy} onClick={() => setEditor(chosen)}>{t('themes.edit')}</button>}</div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!loaded && !loading && <button type="button" className={button} disabled={busy} onClick={() => void run(async () => { setThemes(await api.themes()); setLoaded(true); })}>{t('common.retry')}</button>}
    {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
    {editor !== undefined && <ThemeEditor theme={editor} onClose={() => setEditor(undefined)} onSaved={(theme) => {
      setThemes((list) => [...list.filter((item) => item.id !== theme.id), theme].sort((a, b) => a.name.localeCompare(b.name)));
      setLoaded(true); setSelected(theme.id); setEditor(undefined); setPreview(null); setNotice(t('themes.saved'));
    }} onDeleted={() => { setEditor(undefined); setSelected(''); setPreview(null); void run(async () => { setThemes(await api.themes()); await onChanged(); }); }} />}
    {preview && <Modal title={t('themes.previewTitle')} onClose={() => { if (!busy) setPreview(null); }} wide>
      <p className="mb-3 text-sm text-muted">{t('themes.previewHint')}</p>
      <PreviewFrame url={preview.url} />
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <button type="button" className={`${primary} mt-4`} disabled={busy} onClick={() => void run(async () => {
        await api.applyTheme(artifactId!, preview.themeId, preview.versionId, preview.previewToken); setPreview(null); await onChanged();
      }, t('themes.applied'))}>{busy ? t('common.saving') : t('themes.apply')}</button>
    </Modal>}
  </section>;
}
