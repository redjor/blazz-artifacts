import { accessibleColor } from '../src/ingest/page.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getVersion } from '../src/repo.ts';
import { versionDir } from '../src/storage.ts';
import { parseTheme } from '../src/themes.ts';
import { renderSourcePage } from '../src/ingest/ingest.ts';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminApp } from '../src/admin/server.ts';
import { hashSecret } from '../src/crypto.ts';
import { openDb } from '../src/db.ts';
import { loginLimiterOptions, RateLimiter } from '../src/ratelimit.ts';
import { tempDataDir } from './helpers.ts';
import { setCookies, setup } from './harness.ts';

// Client themes: inheritance, version snapshots and preview-bound application.

const PASSWORD = 'mot-de-passe-solide';
const ORIGIN = 'https://hub.test';

async function adminSetup() {
  const h = await setup({ adminPasswordHash: await hashSecret(PASSWORD), artifactBar: true });
  const admin = createAdminApp({ db: h.db, cfg: h.cfg, keys: h.keys, loginLimiter: new RateLimiter(loginLimiterOptions) });
  const res = await admin.request('/api/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const headers = { cookie: setCookies(res), origin: ORIGIN, 'x-csrf-token': csrfToken };
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    admin.request(`/api${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const upload = (method: 'POST' | 'PUT', path: string, name: string, data: string, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', new File([data], name));
    return admin.request(`/api${path}`, { method, headers, body: form });
  };
  return { ...h, call, upload };
}


const theme = { name: 'Acme', clientName: '<img src=x onerror=alert(1)>', logoDataUrl: '', primaryColor: '#234567', accentColor: '#456789', font: 'serif', width: 'wide', preset: 'report', header: '<script>evil()</script>', footer: 'Confidential & private' };
test('theme validation rejects CSS, remote/vector/mismatched/oversize logos and invalid enum values', () => {
  for (const patch of [{primaryColor:'red'}, {accentColor:'#123;'}, {font:'url(x)'}, {width:[]}, {preset:'custom'}, {logoDataUrl:'https://example.com/x.png'}, {logoDataUrl:'data:image/svg+xml;base64,PHN2Zz4='}, {logoDataUrl:'data:image/png;base64,YWJj'}, {logoDataUrl:'data:image/png;base64,'+Buffer.alloc(600000).toString('base64')}, {header:'x'.repeat(1001)}]) assert.throws(() => parseTheme({...theme,...patch}));
  assert.equal(parseTheme(theme).name, 'Acme');
});
test('themes inherit, snapshot, preview, apply, restore and survive deletion without rewriting published HTML', async () => {
  const h = await adminSetup();
  const t = await (await h.call('/themes', {method:'POST',body:theme})).json() as {id:string};
  await h.call('/projects', {method:'POST',body:{name:'parent',themeId:t.id}});
  await h.call('/projects', {method:'POST',body:{name:'child',parent:'parent'}});
  const a = await (await h.upload('POST','/artifacts','report.md','# Actual source\n\n## Detail\n\nSome content.',{project:'child'})).json() as {id:string;version:{id:string};effectiveThemeId:string};
  assert.equal(a.effectiveThemeId,t.id);
  const original = await readFile(join(versionDir(h.cfg.dataDir,a.id,a.version.id),'index.html'),'utf8');
  assert.match(original,/--client-primary:#234567/);
  assert.match(original,/&lt;script&gt;evil/);
  assert.doesNotMatch(original,/<script>evil/);
  await h.call('/themes/'+t.id,{method:'PUT',body:{...theme,primaryColor:'#abcdef'}});
  assert.equal(await readFile(join(versionDir(h.cfg.dataDir,a.id,a.version.id),'index.html'),'utf8'),original);
  const p = await (await h.call(`/artifacts/${a.id}/theme-preview`,{method:'POST',body:{themeId:t.id}})).json() as {url:string;previewToken:string};
  const preview = await h.call(p.url.slice(4));
  assert.equal(preview.status,200);
  assert.match(preview.headers.get('content-security-policy')!,/sandbox/);
  assert.equal(preview.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.match(await preview.text(),/Actual source/);
  const applied = await h.call(`/artifacts/${a.id}/apply-theme`,{method:'POST',body:{themeId:t.id,versionId:a.version.id,previewToken:p.previewToken}});
  assert.equal(applied.status,200);
  const b = await applied.json() as {version:{id:string};themeId:string};
  assert.notEqual(b.version.id,a.version.id);
  assert.equal(b.themeId,t.id);
  assert.match(getVersion(h.db,b.version.id)!.theme_snapshot!,/#abcdef/);
  assert.equal((await h.call(`/artifacts/${a.id}/apply-theme`,{method:'POST',body:{themeId:t.id,versionId:a.version.id}})).status,409);
  await h.call('/themes/'+t.id,{method:'DELETE'});
  const dto = await (await h.call('/artifacts/'+a.id)).json() as {themeId:string|null;effectiveThemeId:string|null};
  assert.equal(dto.themeId,null);
  assert.equal(dto.effectiveThemeId,null);
  assert.match(getVersion(h.db,b.version.id)!.theme_snapshot!,/#abcdef/);
  const snapshot = JSON.parse(getVersion(h.db,a.version.id)!.theme_snapshot!);
  const rerender = renderSourcePage('markdown','# Source','Report','en',snapshot);
  assert.match(rerender,/#234567/);
  assert.doesNotMatch(rerender,/#abcdef/);
  assert.equal((await h.call(`/artifacts/${a.id}/versions/${a.version.id}/restore`,{method:'POST'})).status,200);
  assert.equal(await readFile(join(versionDir(h.cfg.dataDir,a.id,a.version.id),'index.html'),'utf8'),original);
});
test('unknown assignments fail and non-Markdown apply fails', async () => {
  const h = await adminSetup();
  assert.equal((await h.call('/themes',{method:'POST',body:{}})).status,400);
  assert.equal((await h.call('/projects',{method:'POST',body:{name:'bad',themeId:'missing'}})).status,400);
  const a = await (await h.upload('POST','/artifacts','plain.html','<p>plain</p>')).json() as {id:string;version:{id:string}};
  assert.equal((await h.call(`/artifacts/${a.id}/apply-theme`,{method:'POST',body:{themeId:null,versionId:a.version.id}})).status,400);
});
test('theme migration is idempotent on old schema', async () => {
  const file = join(await tempDataDir(),'hub.sqlite');
  const db = openDb(file);
  db.exec('ALTER TABLE artifacts DROP COLUMN theme_id; ALTER TABLE projects DROP COLUMN theme_id; ALTER TABLE versions DROP COLUMN theme_snapshot; DROP TABLE themes');
  db.close();
  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) n FROM themes').get()!.n,0);
  again.close();
  openDb(file).close();
});

test('artifact overrides folder defaults on future uploads; clearing inherits again', async () => {
  const h = await adminSetup();
  const aTheme = await (await h.call('/themes',{method:'POST',body:theme})).json() as {id:string};
  const bTheme = await (await h.call('/themes',{method:'POST',body:{...theme,name:'Override',primaryColor:'#112233'}})).json() as {id:string};
  await h.call('/projects',{method:'POST',body:{name:'client',themeId:aTheme.id}});
  const a = await (await h.upload('POST','/artifacts','doc.md','# First',{project:'client'})).json() as {id:string;version:{id:string}};
  await h.call('/artifacts/'+a.id,{method:'PATCH',body:{themeId:bTheme.id}});
  const b = await (await h.upload('PUT',`/artifacts/${a.id}/content`,'doc.md','# Second')).json() as {version:{id:string}};
  assert.match(getVersion(h.db,b.version.id)!.theme_snapshot!,/#112233/);
  assert.match(getVersion(h.db,a.version.id)!.theme_snapshot!,/#234567/);
  const inherited = await (await h.call('/artifacts/'+a.id,{method:'PATCH',body:{themeId:null}})).json() as {effectiveThemeId:string};
  assert.equal(inherited.effectiveThemeId,aTheme.id);
  const json = await (await h.upload('PUT',`/artifacts/${a.id}/content`,'doc.json','{}')).json() as {version:{id:string}};
  assert.equal(getVersion(h.db,json.version.id)!.theme_snapshot,null);
});

test('theme text colors adapt to both reading palettes while safe colors stay unchanged', () => {
  assert.equal(accessibleColor('#234567','#faf7f2'),'#234567');
  assert.notEqual(accessibleColor('#234567','#161312'),'#234567');
  assert.notEqual(accessibleColor('#ffffff','#faf7f2'),'#ffffff');
  assert.equal(accessibleColor('#ffffff','#161312'),'#ffffff');
});
test('apply requires fresh preview of the same theme and preserves custom title fallback', async () => {
  const h = await adminSetup();
  const t = await (await h.call('/themes',{method:'POST',body:theme})).json() as {id:string};
  const a = await (await h.upload('POST','/artifacts','doc.md','No heading here.',{title:'Custom title'})).json() as {id:string;version:{id:string}};
  const preview = async () => await (await h.call(`/artifacts/${a.id}/theme-preview`,{method:'POST',body:{themeId:t.id}})).json() as {previewToken:string;url:string};
  const first = await preview();
  await h.call('/themes/'+t.id,{method:'PUT',body:{...theme,name:'Changed'}});
  assert.equal((await h.call(`/artifacts/${a.id}/apply-theme`,{method:'POST',body:{themeId:t.id,versionId:a.version.id,previewToken:first.previewToken}})).status,409);
  const fresh = await preview();
  const result = await h.call(`/artifacts/${a.id}/apply-theme`,{method:'POST',body:{themeId:t.id,versionId:a.version.id,previewToken:fresh.previewToken}});
  assert.equal(result.status,200);
  const b = await result.json() as {version:{id:string}};
  assert.match(await readFile(join(versionDir(h.cfg.dataDir,a.id,b.version.id),'index.html'),'utf8'),/<h1 class="doc-title">Custom title<\/h1>/);
});

test('theme endpoints reject non-object JSON without internal errors', async () => {
  const h = await adminSetup();
  const a = await (await h.upload('POST', '/artifacts', 'doc.md', '# Document')).json() as { id: string };
  for (const body of [null, [], 'invalid']) {
    for (const path of ['/themes', '/themes/preview', `/artifacts/${a.id}/theme-preview`, `/artifacts/${a.id}/apply-theme`]) {
      assert.equal((await h.call(path, { method: 'POST', body })).status, 400, path);
    }
  }
});

test('themed thumbnails reflect the published snapshot in gallery, folders and history', async () => {
  const h = await adminSetup();
  const saved = await (await h.call('/themes', { method: 'POST', body: theme })).json() as { id: string };
  await h.call('/projects', { method: 'POST', body: { name: 'branded', themeId: saved.id } });
  const a = await (await h.upload('POST', '/artifacts', 'report.md', '# Delivery <review>\n\nThe actual excerpt.', { project: 'branded' })).json() as { id: string; thumbnailUrl: string; version: { id: string } };
  assert.ok(a.thumbnailUrl);
  const image = await h.call(a.thumbnailUrl.slice(4));
  assert.equal(image.headers.get('content-type'), 'image/svg+xml');
  assert.match(image.headers.get('content-security-policy')!, /default-src 'none'/);
  const original = await image.text();
  assert.match(original, /The actual excerpt/);
  assert.match(original, /#456789/);
  assert.match(original, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(original, /<script/);
  await h.call('/themes/' + saved.id, { method: 'PUT', body: { ...theme, accentColor: '#abcdef' } });
  assert.equal(await (await h.call(a.thumbnailUrl.slice(4))).text(), original);
  const versionUrl = `/artifacts/${a.id}/versions/${a.version.id}/thumbnail`;
  assert.equal(await (await h.call(versionUrl)).text(), original);
  const folder = await (await h.call('/projects/branded')).json() as { artifacts: { thumbnailUrl: string }[] };
  assert.equal(folder.artifacts[0].thumbnailUrl, a.thumbnailUrl);
  const history = await (await h.call(`/artifacts/${a.id}/versions`)).json() as { thumbnailUrl: string }[];
  assert.ok(history[0].thumbnailUrl.includes(`/versions/${a.version.id}/thumbnail`));
  const other = await (await h.upload('POST', '/artifacts', 'other.md', '# Other')).json() as { id: string; thumbnailUrl: string | null };
  assert.equal(other.thumbnailUrl, null);
  assert.equal((await h.call(`/artifacts/${other.id}/versions/${a.version.id}/thumbnail`)).status, 404);
  await h.call('/themes/' + saved.id, { method: 'DELETE' });
  assert.equal(await (await h.call(versionUrl)).text(), original);
});

test('Google font catalog, preparation, editor DTOs and published thumbnail snapshots', async t => {
  const binary = await readFile(new URL('../src/fonts/figtree-latin-wght-normal.woff2',import.meta.url));
  const css = [400,700].map(w => `@font-face{font-style:normal;font-weight:${w};src:url(https://fonts.gstatic.com/s/roboto/v1/test.woff2) format('woff2');unicode-range:U+0000-00FF;}`).join('');
  t.mock.method(globalThis,'fetch',async (url: string) => new Response(url.includes('googleapis') ? css : binary));
  const h = await adminSetup();
  const catalog = await (await h.call('/themes/fonts')).json() as {fonts:{family:string}[]};
  assert.ok(catalog.fonts.length > 1900);
  const created = await h.call('/themes',{method:'POST',body:{...theme,font:'google:Roboto',fontData:{evil:true}}});
  assert.equal(created.status,201);
  const saved = await created.json() as {id:string;fontData?:unknown}; assert.equal(saved.fontData,undefined);
  assert.doesNotMatch(await (await h.call('/themes')).text(),/base64woff2/);
  const preview = await (await h.call('/themes/preview',{method:'POST',body:{...theme,font:'google:Roboto'}})).json() as {url:string};
  const page = await h.call(preview.url.slice(4));
  assert.match(page.headers.get('content-security-policy')!,/font-src 'self' data:/);
  assert.match(await page.text(),/font-family:BlazzGoogleFont/);
  await h.call('/projects',{method:'POST',body:{name:'google',themeId:saved.id}});
  const art = await (await h.upload('POST','/artifacts','font.md','# Font snapshot',{project:'google'})).json() as {id:string;version:{id:string};thumbnailUrl:string};
  const snapshot = getVersion(h.db,art.version.id)!.theme_snapshot!; assert.match(snapshot,/base64woff2/);
  const before = await (await h.call(art.thumbnailUrl.slice(4))).text(); assert.match(before,/font-family:BlazzGoogleFont/);
  t.mock.method(globalThis,'fetch',async () => {throw new Error('offline');});
  assert.equal((await h.call('/themes/'+saved.id,{method:'PUT',body:theme})).status,200);
  assert.equal(await (await h.call(art.thumbnailUrl.slice(4))).text(),before);
  const fail = await h.call('/themes',{method:'POST',body:{...theme,font:'google:Abel'}});
  assert.equal(fail.status,503); assert.equal((await fail.json() as {code:string}).code,'font_unavailable');
});
