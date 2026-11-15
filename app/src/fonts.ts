// Figtree (SIL Open Font License 1.1, src/fonts/OFL.txt), self-hosted: visitor pages never call a third party, and
// the admin CSP only allows its own origin. Variable weight 300–900, upright and italic, Latin and Latin Extended
// subsets (the browser fetches only the subsets a page uses). The admin SPA imports the same files (web/src/styles.css).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FONT_STACK = `Figtree,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

/** Served files: name → unicode range and style. */
export const FONT_FILES: Record<string, { range: string; style: 'normal' | 'italic' }> = {
  'figtree-latin-wght-normal.woff2': { range: LATIN, style: 'normal' },
  'figtree-latin-wght-italic.woff2': { range: LATIN, style: 'italic' },
  'figtree-latin-ext-wght-normal.woff2': { range: LATIN_EXT, style: 'normal' },
  'figtree-latin-ext-wght-italic.woff2': { range: LATIN_EXT, style: 'italic' },
};

/** Where the content server serves them (CORS open: sandboxed pages have an opaque origin). */
export const FONT_PATH = '/_fonts/';

/** @font-face rules for the visitor pages. */
export const FONT_FACES = Object.entries(FONT_FILES)
  .map(([file, f]) => `@font-face{font-family:Figtree;font-style:${f.style};font-weight:300 900;font-display:swap;src:url(${FONT_PATH}${file}) format("woff2");unicode-range:${f.range}}`)
  .join('\n');

const cache = new Map<string, Buffer>();

/** The font file's bytes, or null for any other name (an allow-list, never a path). */
export function fontFile(name: string): Buffer | null {
  if (!Object.hasOwn(FONT_FILES, name)) return null;
  let data = cache.get(name);
  if (!data) {
    data = readFileSync(join(import.meta.dirname, 'fonts', name));
    cache.set(name, data);
  }
  return data;
}
