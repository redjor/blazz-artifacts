import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { HttpError } from './http.ts';

interface CatalogFont { family: string; category: string; weights: number[]; italicOnly?: boolean }
const catalog = JSON.parse(readFileSync(new URL('./data/google-fonts.json', import.meta.url), 'utf8')) as { updatedAt: string; fonts: CatalogFont[] };
const families = new Map(catalog.fonts.map(f => [f.family, f]));
export const googleFontCatalog = { updatedAt: catalog.updatedAt, fonts: catalog.fonts.map(({ family, category }) => ({ family, category })) };
export const isGoogleFont = (font: string) => font.startsWith('google:') && families.has(font.slice(7));
export interface FontData { family: string; faces: { weight: number; style: 'normal' | 'italic'; unicodeRange: string; base64woff2: string }[] }
const MAX_BYTES = 16 * 1024 * 1024, MAX_FACE = 2 * 1024 * 1024, MAX_FACES = 512;
const rangePattern = /^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?(?:,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/i;
function validWoff(b: Buffer): boolean { return b.length >= 48 && b.length <= MAX_FACE && b.toString('ascii',0,4) === 'wOF2' && b.readUInt32BE(8) === b.length; }
/** Validate persisted snapshots too; never interpolate remote CSS or user-owned assets. */
export function validateFontData(value: unknown, font: string): FontData | undefined {
  if (!value || typeof value !== 'object' || !/^google:[^\x00-\x1f]{1,200}$/.test(font)) return;
  const data = value as FontData;
  if (data.family !== font.slice(7) || !Array.isArray(data.faces) || !data.faces.length || data.faces.length > MAX_FACES) return;
  let bytes = 0;
  for (const f of data.faces) {
    if (!f || !Number.isInteger(f.weight) || f.weight < 1 || f.weight > 1000 || !['normal','italic'].includes(f.style) || typeof f.unicodeRange !== 'string' || f.unicodeRange.length > 16000 || !rangePattern.test(f.unicodeRange) || typeof f.base64woff2 !== 'string' || f.base64woff2.length > MAX_FACE * 1.34) return;
    const b = Buffer.from(f.base64woff2, 'base64'); bytes += b.length;
    if (bytes > MAX_BYTES || b.toString('base64') !== f.base64woff2 || !validWoff(b)) return;
  }
  return data;
}
export function googleFontCss(font: string, value: unknown): string {
  const data = validateFontData(value, font);
  return data ? data.faces.map(f => `@font-face{font-family:BlazzGoogleFont;font-style:${f.style};font-weight:${f.weight};font-display:swap;src:url(data:font/woff2;base64,${f.base64woff2}) format('woff2');unicode-range:${f.unicodeRange}}`).join('') : '';
}
export function themeFontFamily(font: string): string {
  return font.startsWith('google:') ? 'BlazzGoogleFont,sans-serif' : ({ sans: 'Figtree,Arial,sans-serif', serif: 'Georgia,Times,serif', mono: 'ui-monospace,SFMono-Regular,Menlo,monospace' }[font] ?? 'sans-serif');
}
async function boundedFetch(url: string, max: number, signal: AbortSignal): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !((u.hostname === 'fonts.googleapis.com' && u.pathname === '/css2') || (u.hostname === 'fonts.gstatic.com' && /^\/s\/[a-z0-9]+\/v\d+\/[A-Za-z0-9_-]+(?:\.\d+)?\.woff2$/.test(u.pathname) && !u.search))) throw new Error('Font URL');
  const r = await fetch(url, { redirect: 'error', signal, headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } });
  if (!r.ok || !r.body || Number(r.headers.get('content-length')) > max) throw new Error('Font response');
  const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > max) throw new Error('Font size'); chunks.push(value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
const pending = new Map<string, Promise<FontData>>();
export async function prepareGoogleFont(font: string, dataDir: string): Promise<FontData | undefined> {
  if (!font.startsWith('google:')) return;
  if (!isGoogleFont(font)) throw new HttpError(400, 'invalid_theme');
  const family = font.slice(7), key = createHash('sha256').update(font).digest('hex');
  const cache = join(dataDir, 'fonts', `${key}.json`), pendingKey = `${dataDir}:${key}`;
  const existing = pending.get(pendingKey); if (existing) return existing;
  if (pending.size >= 8) throw new HttpError(503, 'font_unavailable');
  const controller = new AbortController();
  const work = (async () => {
    try {
      try { if ((await stat(cache)).size <= MAX_BYTES * 1.5) { const cached = validateFontData(JSON.parse(await readFile(cache, 'utf8')), font); if (cached) return cached; } } catch { /* missing/corrupt cache is re-fetched */ }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
      const entry = families.get(family)!; const supported = entry.weights; const style = entry.italicOnly ? 'italic' : 'normal';
      const weights = [...new Set([400,700].map(target => supported.reduce((best,n) => Math.abs(n-target) < Math.abs(best-target) ? n : best)))].sort((a,b) => a-b);
      const cssUrl = new URL('https://fonts.googleapis.com/css2'); cssUrl.searchParams.set('family', entry.italicOnly ? `${family}:ital,wght@${weights.map(w => `1,${w}`).join(';')}` : `${family}:wght@${weights.join(';')}`); cssUrl.searchParams.set('display','swap');
      const css = (await boundedFetch(cssUrl.href, 512 * 1024, signal)).toString('utf8');
      const faces: FontData['faces'] = []; const urls: string[] = [];
      for (const match of css.matchAll(/@font-face\s*\{([^{}]*)\}/g)) {
        const fields = new Map(match[1].split(';').map(s => { const i = s.indexOf(':'); return [s.slice(0,i).trim(), s.slice(i+1).trim()]; }));
        const weight = Number(fields.get('font-weight')), unicodeRange = fields.get('unicode-range') ?? 'U+0-10FFFF';
        const src = /^url\((https:\/\/[^\s()'"]+)\)\s+format\(['"]woff2['"]\)$/.exec(fields.get('src') ?? '');
        if (!src || fields.get('font-style') !== style || !weights.includes(weight) || !rangePattern.test(unicodeRange) || faces.length >= MAX_FACES) throw new Error('Font descriptors');
        urls.push(src[1]); faces.push({ weight, style, unicodeRange, base64woff2: '' });
      }
      if (!faces.length || weights.some(w => !faces.some(f => f.weight === w))) throw new Error('Font faces');
      let index = 0, total = 0; const binaries = new Map<string, Promise<Buffer>>();
      await Promise.all(Array.from({ length: Math.min(6, faces.length) }, async () => {
        while (index < faces.length) {
          const i = index++, url = urls[i];
          if (!binaries.has(url)) binaries.set(url, boundedFetch(url, MAX_FACE, signal));
          const bytes = await binaries.get(url)!; total += bytes.length;
          if (!validWoff(bytes) || total > MAX_BYTES) throw new Error('Font bytes');
          faces[i].base64woff2 = bytes.toString('base64');
        }
      }));
      const data = { family, faces }; if (!validateFontData(data, font)) throw new Error('Font data');
      await mkdir(join(dataDir,'fonts'), { recursive: true });
      const tmp = `${cache}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(data)); await rename(tmp,cache);
      return data;
    } catch { controller.abort(); throw new HttpError(503, 'font_unavailable'); }
  })();
  pending.set(pendingKey,work);
  try { return await work; } finally { pending.delete(pendingKey); }
}
