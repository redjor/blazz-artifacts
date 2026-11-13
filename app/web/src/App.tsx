import { useEffect, useState } from 'react';
import { api, onUnauthorized } from './api.ts';
import { Dashboard } from './Dashboard.tsx';
import { t, useLocale } from './i18n/index.ts';
import { Login } from './Login.tsx';

export function App() {
  const [state, setState] = useState<'loading' | 'anon' | 'auth'>('loading');
  // A language change re-renders the whole tree (formatters and labels are read at render time).
  const locale = useLocale();

  useEffect(() => {
    onUnauthorized(() => setState('anon'));
    let live = true;
    api.session().then((s) => live && setState(s.authenticated ? 'auth' : 'anon')).catch(() => live && setState('anon'));
    return () => {
      live = false;
      onUnauthorized(null);
    };
  }, []);

  if (state === 'loading') return <div className="grid min-h-dvh place-items-center text-sm text-muted">{t('common.loading')}</div>;
  if (state === 'anon') return <Login key={locale} onDone={() => setState('auth')} />;
  return (
    <Dashboard
      locale={locale}
      onLogout={async () => {
        try {
          await api.logout();
        } catch {
          // the session may already have expired
        }
        setState('anon');
      }}
    />
  );
}
