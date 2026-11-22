import { googleFontCss, themeFontFamily, validateFontData } from './google-fonts.ts';
import { FONT_FACES, FONT_FILES, fontFile } from './fonts.ts';
import { accessibleColor } from './ingest/page.ts';
import type { Preview } from './preview.ts';
import type { Version } from './repo.ts';
import { parseTheme, type Theme } from './themes.ts';

/** Read the published snapshot, never the mutable theme library or folder assignment. */
export function thumbnailTheme(v: Version | undefined): Theme | null {
  if (!v || v.kind !== 'markdown' || !v.theme_snapshot) return null;
  try { const raw = JSON.parse(v.theme_snapshot); const theme = parseTheme(raw, true); return { ...theme, fontData: validateFontData(raw.fontData, theme.font), id: '' }; }
  catch { return null; }
}

const escape = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const lines = (text: string, width: number, count: number): string[] => {
  const chunks: string[] = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    // Split long unbroken identifiers too, keeping every line inside the image.
    for (let i = 0; i < word.length; i += width) {
      const piece = word.slice(i, i + width);
      if (line && line.length + piece.length + 1 > width) { chunks.push(line); line = ''; }
      line += (line ? ' ' : '') + piece;
    }
  }
  if (line) chunks.push(line);
  if (chunks.length > count) chunks[count - 1] = chunks[count - 1].slice(0, -1) + '…';
  return chunks.slice(0, count);
};

let fonts: string | undefined;
function embeddedFonts(): string {
  if (fonts) return fonts;
  fonts = FONT_FACES;
  for (const file of Object.keys(FONT_FILES)) fonts = fonts.replace(`/_fonts/${file}`, `data:font/woff2;base64,${fontFile(file)!.toString('base64')}`);
  return fonts;
}

/** Lightweight branded excerpt, used only when the version has no uploaded capture. */
export function renderThemeThumbnail(theme: Theme, preview: Preview, fallbackTitle: string): string {
  const bg = '#faf7f2';
  const color = accessibleColor(theme.primaryColor, bg);
  const font = themeFontFamily(theme.font);
  const margin = theme.width === 'narrow' ? 130 : theme.width === 'wide' ? 56 : 88;
  const centered = theme.preset !== 'documentation';
  const x = centered ? 480 : margin;
  const heading = lines(preview?.heading ?? fallbackTitle, theme.font === 'mono' ? 23 : 30, 2);
  const text = lines(preview?.text ?? '', theme.font === 'mono' ? 47 : 63, 4);
  const textSvg = (list: string[], y: number, step: number) => list.map((s, i) => `<tspan x="${margin}" y="${y + i * step}">${escape(s)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
<style>${embeddedFonts()}${googleFontCss(theme.font, theme.fontData)}text{font-family:${font}}</style>
<rect width="960" height="600" fill="${bg}"/>
${theme.logoDataUrl ? `<image href="${escape(theme.logoDataUrl)}" x="${margin}" y="42" width="58" height="58" preserveAspectRatio="xMinYMid meet"/>` : ''}
${!theme.logoDataUrl && theme.clientName ? `<text x="${margin}" y="78" font-size="22" font-weight="650" fill="${color}">${escape(lines(theme.clientName, 42, 1)[0] ?? '')}</text>` : ''}
<path d="M${margin} 120H${960 - margin}" stroke="#e2dcd3"/>
${theme.header ? `<text x="${margin}" y="149" font-size="17" fill="#57534e">${escape(lines(theme.header, 70, 1)[0] ?? '')}</text>` : ''}
<text fill="${color}" font-size="${theme.preset === 'editorial' ? 46 : 42}" font-weight="700" text-anchor="${centered ? 'middle' : 'start'}">${heading.map((s, i) => `<tspan x="${x}" y="${202 + i * 50}">${escape(s)}</tspan>`).join('')}</text>
<rect x="${centered ? 444 : margin}" y="282" width="72" height="5" rx="2" fill="${theme.accentColor}"/>
<text font-size="23" fill="#2e2a27">${textSvg(text, 337, 36)}</text>
${theme.footer ? `<path d="M${margin} 530H${960 - margin}" stroke="#e2dcd3"/><text x="${margin}" y="563" font-size="17" fill="#57534e">${escape(lines(theme.footer, 72, 1)[0] ?? '')}</text>` : ''}
</svg>`;
}
