import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from './Modal.tsx';
import { useLocale } from './i18n/index.ts';

interface ApiKey { id: string; name: string; scope: 'read' | 'publish' | 'full'; prefix: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null }
const field = 'w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm';
const button = 'rounded-xl border border-line px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-50';
async function keyRequest<T>(method: string, path = '', body?: object): Promise<T> {
  const headers: Record<string,string> = {};
  if (method !== 'GET') {
    const session = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    const data = await session.json();
    headers['X-CSRF-Token'] = data.csrfToken ?? '';
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`/api/keys${path}`, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export function ApiKeys({ onClose }: { onClose: () => void }) {
  const fr = useLocale() === 'fr';
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiKey['scope']>('publish');
  const [expires, setExpires] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    keyRequest<ApiKey[]>('GET').then(value => { if (live) setKeys(value); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  const labels = { read: fr ? 'Lecture' : 'Read', publish: fr ? 'Publication' : 'Publish', full: fr ? 'Accès complet' : 'Full access' };
  const date = (value: string) => new Date(value).toLocaleString(fr ? 'fr-FR' : 'en-GB');
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice(''); setSecret(null);
    try {
      const result = await keyRequest<ApiKey & { token: string }>('POST', '', { name, scope, expiresAt: expires ? new Date(expires).toISOString() : null });
      setSecret(result.token); setName('');
      setKeys(await keyRequest<ApiKey[]>('GET'));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const revoke = async (key: ApiKey) => {
    if (!window.confirm(fr ? `Révoquer la clé « ${key.name} » ? L’outil qui l’utilise perdra son accès.` : `Revoke “${key.name}”? The tool using it will lose access.`)) return;
    setBusy(true); setError(null);
    try {
      await keyRequest('DELETE', `/${encodeURIComponent(key.id)}`);
      setKeys(await keyRequest<ApiKey[]>('GET'));
      setSecret(null); setNotice(fr ? 'Clé révoquée.' : 'Key revoked.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setNotice(fr ? 'Copié.' : 'Copied.'); }
    catch { setError(fr ? 'Copie impossible. Sélectionne le texte pour le copier.' : 'Could not copy. Select the text to copy it.'); }
  };
  const mcpUrl = `${window.location.origin}/mcp`;
  return <Modal title={fr ? 'Clés API et MCP' : 'API keys and MCP'} onClose={onClose} wide>
    <p className="mb-4 text-sm text-muted">{fr ? 'Une clé par outil, révocable séparément. Les nouvelles versions restent en préparation jusqu’à leur publication.' : 'One independently revocable key per tool. New versions remain drafts until explicitly published.'}</p>
    {error && <p role="alert" className="mb-3 text-sm text-warn">{error}</p>}
    <form onSubmit={create} className="space-y-3">
      <label className="block text-sm">{fr ? 'Nom de l’outil' : 'Tool name'}<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)} className={field} placeholder="Claude Code" /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">{fr ? 'Permissions' : 'Permissions'}<select value={scope} onChange={e=>setScope(e.target.value as ApiKey['scope'])} className={field}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="block text-sm">{fr ? 'Expiration (facultative)' : 'Expiry (optional)'}<input type="datetime-local" value={expires} onChange={e=>setExpires(e.target.value)} className={field} /></label>
      </div>
      <p className="text-xs text-muted">{scope === 'read' ? (fr ? 'Consulter les documents et leurs aperçus.' : 'Read documents and their previews.') : scope === 'publish' ? (fr ? 'Créer des documents privés, préparer et publier des versions. Aucun changement des accès ni suppression.' : 'Create private documents, prepare and publish versions. No access changes or deletion.') : (fr ? 'Toutes les opérations sur les documents et dossiers. La gestion des clés reste réservée à la connexion administrateur.' : 'All document and folder operations. Key management still requires an administrator login.')}</p>
      <button disabled={busy || !name.trim()} className={button}>{fr ? 'Créer la clé' : 'Create key'}</button>
    </form>
    {secret && <div className="mt-4 space-y-2 rounded-xl border border-line bg-surface-2 p-3">
      <p className="text-sm font-medium">{fr ? 'Copie cette clé maintenant : elle ne sera plus affichée.' : 'Copy this key now: it will not be shown again.'}</p>
      <textarea aria-label={fr ? 'Nouvelle clé API' : 'New API key'} readOnly value={secret} className={`${field} font-mono`} rows={2} onFocus={e=>e.target.select()} />
      <button className={button} onClick={()=>void copy(secret)}>{fr ? 'Copier la clé' : 'Copy key'}</button>
    </div>}
    <p className="my-2 text-sm text-muted" role="status">{notice}</p>
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="mb-2 font-medium">{fr ? 'Clés existantes' : 'Existing keys'}</h3>
      {keys === null ? <p className="text-sm text-muted">{fr ? 'Chargement…' : 'Loading…'}</p> : keys.length === 0 ? <p className="text-sm text-muted">{fr ? 'Aucune clé.' : 'No keys yet.'}</p> : <ul className="divide-y divide-line">{keys.map(key => <li key={key.id} className="flex items-start justify-between gap-3 py-3">
        <div className="min-w-0"><p className="truncate text-sm font-medium">{key.name} <span className="font-normal text-muted">· {labels[key.scope]}</span></p><p className="text-xs text-muted">{key.prefix}… · {key.revokedAt ? (fr ? 'Révoquée' : 'Revoked') : key.expiresAt ? `${fr ? 'Expire le' : 'Expires'} ${date(key.expiresAt)}` : (fr ? 'Sans expiration' : 'No expiry')}</p>{key.lastUsedAt && <p className="text-xs text-muted">{fr ? 'Dernière utilisation' : 'Last used'} : {date(key.lastUsedAt)}</p>}</div>
        {!key.revokedAt && <button className={button} disabled={busy} onClick={()=>void revoke(key)}>{fr ? 'Révoquer' : 'Revoke'}</button>}
      </li>)}</ul>}
    </div>
    <div className="mt-4 space-y-2 border-t border-line pt-4">
      <h3 className="font-medium">{fr ? 'Connecter un client MCP' : 'Connect an MCP client'}</h3>
      <p className="text-sm text-muted">{fr ? 'Transport HTTP. Utilise cette URL et ta clé comme jeton Bearer.' : 'HTTP transport. Use this URL and your key as a Bearer token.'}</p>
      <div className="flex gap-2"><input readOnly aria-label="MCP URL" className={`${field} min-w-0 font-mono`} value={mcpUrl}/><button className={button} onClick={()=>void copy(mcpUrl)}>{fr ? 'Copier' : 'Copy'}</button></div>
    </div>
  </Modal>;
}
