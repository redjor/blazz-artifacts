/** Refresh reviewed Google Fonts metadata. Run: node scripts/refresh-google-fonts.ts */
import { writeFile } from 'node:fs/promises';
const response = await fetch('https://fonts.google.com/metadata/fonts', { redirect: 'error', signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Metadata: ${response.status}`);
const raw = (await response.text()).replace(/^\)\]\}'\s*/, '');
const metadata = JSON.parse(raw) as { familyMetadataList: { family: string; category: string; fonts: Record<string, unknown> }[] };
const fonts = metadata.familyMetadataList.map(f => ({ family: f.family, category: f.category.toLowerCase().replaceAll(' ', '-'), weights: [...new Set(Object.keys(f.fonts).filter(k => Object.keys(f.fonts).some(w => /^\d+$/.test(w)) ? /^\d+$/.test(k) : /^\d+i$/.test(k)).map(k => parseInt(k,10)))].sort((a,b) => a-b), ...(!Object.keys(f.fonts).some(k => /^\d+$/.test(k)) ? {italicOnly:true} : {}) })).sort((a,b) => a.family < b.family ? -1 : 1);
if (fonts.length < 1000 || fonts.some(f => !f.family || !f.weights.length)) throw new Error('Unexpected catalog');
await writeFile(new URL('../src/data/google-fonts.json', import.meta.url), JSON.stringify({ updatedAt: new Date().toISOString().slice(0,10), fonts }));
