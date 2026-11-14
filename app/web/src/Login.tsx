import { useState, type FormEvent } from 'react';
import { api } from './api.ts';
import { t } from './i18n/index.ts';
import { LanguageSwitch } from './LanguageSwitch.tsx';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center px-4">
      <div className="absolute top-4 right-4"><LanguageSwitch /></div>
      <form onSubmit={submit} className="surface-raised w-full max-w-sm space-y-5 rounded-[24px] bg-surface p-7">
        <div>
          <h1 className="font-serif text-[2rem] leading-tight font-normal tracking-[-0.015em]">{t('app.heading')}</h1>
          <p className="mt-1 text-sm text-muted">{t('login.subtitle')}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">{t('login.password')}</span>
          <input type="password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-line bg-transparent px-3 py-2 hover:border-line-strong" />
        </label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-canvas disabled:opacity-50">
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </main>
  );
}
