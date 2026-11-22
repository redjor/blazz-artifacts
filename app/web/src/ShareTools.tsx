import { useEffect, useState } from 'react';
import { getLocale } from './i18n/index.ts';
import type { ArtifactDto } from './types.ts';
import { menuItem } from './ui.ts';

export function ShareTools({artifact, onCopy}: {artifact: ArtifactDto; onCopy: (value: string) => void}) {
 const fr = getLocale() === 'fr';
 const [sharing,setSharing]=useState<{url:string;embedCode:string|null}|null>(null);
 const [error,setError]=useState(false);
 const [show,setShow]=useState(false);
 useEffect(() => {
   if (!show) return;
   const controller = new AbortController();
   setSharing(null);setError(false);
   fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/sharing`,{signal:controller.signal})
     .then(async r => {if(!r.ok) throw new Error();return r.json();})
     .then(setSharing).catch(() => {if(!controller.signal.aborted)setError(true)});
   return () => controller.abort();
 },[show,artifact.id,artifact.visibility,artifact.publishedVersionId,artifact.activeLinkUrl]);
 if (!artifact.publishedVersionId || artifact.visibility === 'private') return null;
 const base=`/api/artifacts/${encodeURIComponent(artifact.id)}/qr`;
 return <div className="border-t border-line pt-1">
   <button type="button" className={menuItem} aria-expanded={show} onClick={() => setShow(!show)}>{fr?'QR code et intégration':'QR code and embed'}</button>
   {show && <div className="space-y-2 p-2 text-sm">
     {error ? <p role="alert">{fr?'Aucun lien disponible. Vérifiez les accès.':'No link available. Check sharing access.'}</p> : !sharing ? <p role="status">{fr?'Chargement…':'Loading…'}</p> : <>
       <img src={`${base}?format=svg`} alt={fr?'QR code du lien de partage':'Sharing link QR code'} className="mx-auto size-36 rounded-lg bg-white" />
       <div className="flex justify-center gap-4"><a href={`${base}?format=svg&download=1`} download className="underline">SVG</a><a href={`${base}?format=png&download=1`} download className="underline">PNG</a></div>
       {sharing.embedCode ? <button type="button" className={menuItem} onClick={() => onCopy(sharing.embedCode!)}>{fr?'Copier le code iframe':'Copy iframe code'}</button> : <p className="text-xs text-muted">{fr?'L’intégration iframe est réservée aux documents publics.':'Embedding is available for public documents only.'}</p>}
     </>}
   </div>}
 </div>;
}
