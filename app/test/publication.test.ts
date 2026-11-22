import assert from 'node:assert/strict';
import test from 'node:test';
import { getArtifact, activateVersion, publishVersion, upsertProject } from '../src/repo.ts';
import { newId } from '../src/ids.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { versionDir } from '../src/storage.ts';
import { signPinnedPath } from '../src/content/signing.ts';
import { seedArtifact, setup } from './harness.ts';

test('draft stays hidden on stable URL and folder until explicit publication; old version can be republished', async () => {
 const h = await setup();
 upsertProject(h.db, 'client', {visibility:'public'}, false);
 const a = await seedArtifact(h, {slug:'report',visibility:'public',project:'client',files:{'index.html':'approved'}});
 const vid = newId(), dir = versionDir(h.cfg.dataDir,a.id,vid);
 await mkdir(dir,{recursive:true}); await writeFile(join(dir,'index.html'),'draft-secret');
 activateVersion(h.db,a.id,{id:vid,entry_path:'index.html',original_name:'draft.html',size_bytes:12,file_count:1},'html',undefined,undefined,true);
 assert.equal(getArtifact(h.db,a.id)?.published_version_id,a.current_version_id);
 const res = await h.content.request('/a/report');
 assert.match(res.headers.get('location')!, new RegExp(a.current_version_id!));
 assert.doesNotMatch(await (await h.content.request('/d/client')).text(), /draft-secret/);
 assert.match((await h.content.request('/d/client/a/report')).headers.get('location')!,new RegExp(a.current_version_id!));
 const sig = signPinnedPath(h.keys.pathSig,{artifactId:a.id,versionId:vid,epoch:a.access_epoch},Math.floor(h.clock.now()/1000));
 assert.equal(await (await h.content.request(`/a/report/${sig}/index.html`)).text(),'draft-secret');
 assert.equal(publishVersion(h.db,a.id,vid),true);
 assert.match((await h.content.request('/a/report')).headers.get('location')!,new RegExp(vid));
 assert.equal(publishVersion(h.db,a.id,a.current_version_id!),true);
 assert.equal(publishVersion(h.db,a.id,newId()),false);
});

import { createAdminApp } from '../src/admin/server.ts';
import { sha256 } from '../src/crypto.ts';
import { RateLimiter, loginLimiterOptions } from '../src/ratelimit.ts';
import { updateArtifact } from '../src/repo.ts';
import QRCode from 'qrcode';

test('API upload is draft, cannot leak to folders, OG or embed; publication uses exact version', async () => {
 const h=await setup({apiTokenHash:sha256('test-token'),linkPreviews:true});
 const admin=createAdminApp({...h,loginLimiter:new RateLimiter(loginLimiterOptions),now:h.clock.now});
 const headers={authorization:'Bearer test-token'};
 const form=new FormData();form.set('file',new File(['# secret draft'],'draft.md'));form.set('visibility','public');form.set('project','client');
 const res=await admin.request('/api/artifacts',{method:'POST',headers,body:form});
 assert.equal(res.status,201);const a=await res.json();assert.equal(a.publishedVersionId,null);
 upsertProject(h.db,'client',{visibility:'public'});
 for (const path of ['/a/draft','/embed/draft/','/d/client/a/draft']) assert.equal((await h.content.request(path)).status,404,path);
 assert.doesNotMatch(await (await h.content.request('/d/client')).text(),/secret draft|draft.md|\/a\/draft/);
 assert.equal((await h.content.request('/a/draft',{headers:{'user-agent':'Slackbot-LinkExpanding'}})).status,404);
 const pv=await (await admin.request(`/api/artifacts/${a.id}/preview`,{headers})).json();
 assert.equal((await h.content.request(pv.url)).status,200);
 const approve=(body:unknown)=>admin.request(`/api/artifacts/${a.id}/publish`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await approve(null)).status,400);
 assert.equal((await approve({versionId:newId()})).status,404);
 assert.equal((await approve({versionId:a.version.id})).status,200);
 assert.equal((await h.content.request('/a/draft')).status,302);
 const embed=await h.content.request('/embed/draft/');
 assert.equal(embed.status,200);assert.equal(embed.headers.get('x-frame-options'),null);assert.match(embed.headers.get('content-security-policy')!,/frame-ancestors \*/);
 assert.doesNotMatch(embed.headers.get('content-security-policy')!,/allow-same-origin/);
 const sharing=await (await admin.request(`/api/artifacts/${a.id}/sharing`,{headers})).json();
 assert.match(sharing.embedCode,/\/embed\/draft\//);
 const svg=await admin.request(`/api/artifacts/${a.id}/qr`,{headers});assert.equal(svg.status,200);
 assert.equal(await svg.text(),await QRCode.toString(sharing.url,{type:'svg',margin:4,errorCorrectionLevel:'M'}));
 const png=await admin.request(`/api/artifacts/${a.id}/qr?format=png&download=1`,{headers});
 assert.match(png.headers.get('content-disposition')!,/attachment/);assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1,4).toString(),'PNG');
 updateArtifact(h.db,a.id,{visibility:'private'},true);
 assert.equal((await h.content.request('/embed/draft/')).status,404);
 assert.equal((await admin.request(`/api/artifacts/${a.id}/sharing`,{headers})).status,409);
});

test('publication migration keeps existing approved documents and is idempotent', async () => {
 const {openDb}=await import('../src/db.ts');const {tempDataDir}=await import('./helpers.ts');
 const file=join(await tempDataDir(),'legacy.sqlite');let db=openDb(file);
 db.exec("INSERT INTO artifacts(id,slug,title,kind,visibility,current_version_id,created_at,updated_at) VALUES('old','old','old','html','public','version-one','now','now')");
 db.exec('DROP VIEW live_artifacts; ALTER TABLE artifacts DROP COLUMN published_version_id; CREATE VIEW live_artifacts AS SELECT * FROM artifacts WHERE deleted_at IS NULL');db.close();
 db=openDb(file);assert.equal(getArtifact(db,'old')!.published_version_id,'version-one');
 db.exec("UPDATE artifacts SET current_version_id='draft-two'");db.close();
 db=openDb(file);assert.equal(getArtifact(db,'old')!.published_version_id,'version-one');db.close();
});
