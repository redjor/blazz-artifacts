import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepareGoogleFont, googleFontCss, googleFontCatalog, validateFontData } from '../src/google-fonts.ts';
import { parseTheme } from '../src/themes.ts';
import { renderSourcePage } from '../src/ingest/ingest.ts';
import { tempDataDir } from './helpers.ts';

const theme = { name:'Client', clientName:'', logoDataUrl:'', primaryColor:'#123456', accentColor:'#234567', font:'google:Roboto', width:'standard', preset:'report', header:'',footer:'' };
const url = 'https://fonts.gstatic.com/s/roboto/v51/test.woff2';
const css = (src=url) => [400,700].map(w => `@font-face{font-family:'Roboto';font-style:normal;font-weight:${w};src:url(${src}) format('woff2');unicode-range:U+0000-00FF;}`).join('');
test('catalog and input validation reject unknown fonts and ignore forged assets', () => {
  assert.ok(googleFontCatalog.fonts.length > 1900);
  assert.ok(googleFontCatalog.fonts.some(f => f.family === 'Roboto'));
  assert.throws(() => parseTheme({...theme,font:'google:No such font'}));
  assert.throws(() => parseTheme({...theme,font:'google:Roboto;src:url(https://evil.test)'}));
  assert.equal(parseTheme({...theme,fontData:{faces:['malicious']}}).fontData,undefined);
});
test('selected assets are validated, deduplicated, cached and frozen in rendered snapshots', async t => {
  const binary = await readFile(new URL('../src/fonts/figtree-latin-wght-normal.woff2',import.meta.url));
  const calls: string[] = [];
  t.mock.method(globalThis,'fetch',async (input: string, init: RequestInit) => {
    calls.push(String(input)); assert.equal(init.redirect,'error');
    return new Response(String(input).startsWith('https://fonts.googleapis.com/') ? css() : binary);
  });
  const dir = await tempDataDir();
  const data = await prepareGoogleFont(theme.font,dir);
  assert.equal(calls.length,2); assert.equal(data!.faces.length,2);
  assert.ok(validateFontData(data,theme.font));
  const snapshot = {...parseTheme(theme),id:'saved',fontData:data};
  const html = renderSourcePage('markdown','# Report','Report','en',snapshot);
  assert.match(html,/font-family:BlazzGoogleFont/); assert.match(html,/data:font\/woff2;base64/);
  assert.doesNotMatch(html,/fonts\.(googleapis|gstatic)\.com/);
  t.mock.method(globalThis,'fetch',async () => {throw new Error('offline');});
  assert.deepEqual(await prepareGoogleFont(theme.font,dir),data);
  assert.equal(renderSourcePage('markdown','# Report','Report','en',JSON.parse(JSON.stringify(snapshot))),html);
  assert.equal(googleFontCss(theme.font,{...data,faces:[{...data!.faces[0],unicodeRange:'U+0;}body{color:red'}]}),'');
  assert.ok(validateFontData({...data,family:'Retired family'},'google:Retired family'));
});
test('untrusted remote URLs, bad bytes and offline errors cannot be imported', async t => {
  for (const src of ['https://evil.test/steal.woff2','https://fonts.gstatic.com.evil.test/s/f/v1/a.woff2','https://fonts.gstatic.com/s/f/v1/a.woff2?redirect=evil']) {
    let calls=0;
    t.mock.method(globalThis,'fetch',async () => {calls++;return new Response(css(src));});
    await assert.rejects(prepareGoogleFont(theme.font,await tempDataDir()), {code:'font_unavailable',status:503});
    assert.equal(calls,1);
  }
  t.mock.method(globalThis,'fetch',async (input:string) => new Response(input.includes('googleapis') ? css() : 'not a font'));
  await assert.rejects(prepareGoogleFont(theme.font,await tempDataDir()),{code:'font_unavailable'});
  t.mock.method(globalThis,'fetch',async () => {throw new Error('offline');});
  await assert.rejects(prepareGoogleFont(theme.font,await tempDataDir()),{code:'font_unavailable'});
});
test('italic-only families and numbered CJK subset paths import correctly', async t => {
  const binary = await readFile(new URL('../src/fonts/figtree-latin-wght-normal.woff2',import.meta.url));
  t.mock.method(globalThis,'fetch',async (input: string) => {
    if (input.includes('googleapis')) { assert.match(decodeURIComponent(input),/ital,wght@1,400/); return new Response("@font-face{font-style:italic;font-weight:400;src:url(https://fonts.gstatic.com/s/molle/v1/test.12.woff2) format('woff2');unicode-range:U+0000-00FF;}"); }
    return new Response(binary);
  });
  const data = await prepareGoogleFont('google:Molle',await tempDataDir());
  assert.equal(data!.faces[0].style,'italic');
  assert.match(googleFontCss('google:Molle',data),/font-style:italic/);
});
