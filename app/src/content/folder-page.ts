import { tr, type Locale } from '../i18n.ts';
import { DARK, escapeHtml, LIGHT, SANS, SERIF, typography } from '../ingest/page.ts';
import { BAR_CSS, renderBar } from './bar.ts';
import type { Kind, Visibility } from '../repo.ts';

// Public page of a folder: rendered here, served without scripts (CSP sandbox). All text comes from the database and goes through escapeHtml.

export interface FolderCard {
  /** Card target: /d/<project>/a/<slug>, or a signed path in the admin preview. */
  href: string;
  title: string; kind: Kind; updatedAt: string; versionNumber: number | null;
  /** Thumbnail URL (already signed), or null: kind pictogram. */
  thumbUrl: string | null;
}

/** Direct sub-folder card (design 03). `href: null` in the admin preview (other folders are not previewable from here). */
export interface FolderSubCard { href: string | null; title: string; description: string | null; count: number; childCount: number; updatedAt: string }

export interface FolderPageInput {
  name: string; title: string | null; description: string | null; cards: FolderCard[]; nowMs: number;
  folders: FolderSubCard[]; breadcrumb: { href: string; title: string }[];
  /** Admin preview: notice banner and the folder's real visibility. */
  preview?: { visibility: Visibility } | null;
}

// Pictograms taken from the admin UI icon set (24 grid, 1.5 stroke).
const ICON_PATHS: Record<Kind, string> = {
  markdown: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  html: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17"/><path d="m10 12.5-2 2 2 2M14 12.5l2 2-2 2"/>',
  site: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  pdf: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h4"/>',
  json: '<path d="M8.5 4C6.5 4 6 5 6 6.8v2.4C6 10.6 5.2 11.6 4 12c1.2.4 2 1.4 2 2.8v2.4C6 19 6.5 20 8.5 20"/><path d="M15.5 4c2 0 2.5 1 2.5 2.8v2.4c0 1.4.8 2.4 2 2.8-1.2.4-2 1.4-2 2.8v2.4c0 1.8-.5 2.8-2.5 2.8"/>',
};
const svg = (paths: string, size: number, cls = '') =>
  `<svg${cls ? ` class="${cls}"` : ''} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const MOON = '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>';
const SUN = '<circle cx="12" cy="12" r="3.75"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1"/>';

const FOLDER = '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>';

// Bands and pictograms per kind, same tints as the admin UI cards.
const KIND_LIGHT = `--markdown-band:#e2e8f6;--markdown-glyph:#2546a3;--html-band:#f2e3d8;--html-glyph:#974018;--site-band:#e7e2f6;--site-glyph:#4b34b4;
--pdf-band:#f3dfdc;--pdf-glyph:#a42f28;--json-band:#f2e0e9;--json-glyph:#98285c;--card:#fffdf9;--shadow:oklch(0.35 0.03 60 / 0.16)`;
const KIND_DARK = `--markdown-band:#1f2c56;--markdown-glyph:#b4c8ff;--html-band:#44261a;--html-glyph:#f4b896;--site-band:#32245c;--site-glyph:#cdc1ff;
--pdf-band:#481f1f;--pdf-glyph:#ffb4ab;--json-band:#42192d;--json-glyph:#f8afd0;--card:#1f1b19;--shadow:oklch(0 0 0 / 0.5)`;

const CSS = `
:root{${LIGHT};${KIND_LIGHT}}
html:has(#theme-toggle:checked){${DARK};${KIND_DARK}}
@media (prefers-color-scheme:dark){
:root{${DARK};${KIND_DARK}}
html:has(#theme-toggle:checked){${LIGHT};${KIND_LIGHT}}
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 ${SANS};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:color-mix(in oklab,var(--link) 28%,transparent)}
.theme-toggle{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
${BAR_CSS}
.page{max-width:1180px;margin:0 auto;padding:0 32px 112px}
#theme-toggle:focus-visible~.bar .theme-btn{outline:2px solid var(--link);outline-offset:2px}
.theme-btn>span{display:inline-flex;align-items:center;gap:8px}
.theme-btn .to-light,html:has(#theme-toggle:checked) .theme-btn .to-dark{display:none}
html:has(#theme-toggle:checked) .theme-btn .to-light{display:inline-flex}
@media (prefers-color-scheme:dark){
.theme-btn .to-dark{display:none}.theme-btn .to-light{display:inline-flex}
html:has(#theme-toggle:checked) .theme-btn .to-light{display:none}
html:has(#theme-toggle:checked) .theme-btn .to-dark{display:inline-flex}
}
.head{max-width:62ch;margin:48px 0 56px}
.title{margin:0;font:400 clamp(2.4rem,1.6rem + 3vw,3.6rem)/1.08 ${SERIF};letter-spacing:-0.015em;text-wrap:balance;hyphens:manual}
.desc{margin:20px 0 0;color:var(--soft);font:19px/1.6 ${SERIF};text-wrap:pretty;white-space:pre-line}
.count{margin:18px 0 0;color:var(--muted);font-size:14px;font-variant-numeric:tabular-nums}
.grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:44px 32px}
.card{display:block;color:inherit;text-decoration:none;border-radius:14px;-webkit-tap-highlight-color:transparent}
.card:focus-visible{outline:2px solid var(--link);outline-offset:6px}
.frame{position:relative;display:grid;place-items:center;aspect-ratio:16/10;overflow:hidden;border-radius:12px;
background:var(--band);box-shadow:0 1px 2px var(--shadow);transition:box-shadow 200ms cubic-bezier(.16,1,.3,1),translate 200ms cubic-bezier(.16,1,.3,1)}
.frame img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.frame::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px oklch(0.5 0.02 60 / 0.14);pointer-events:none}
.glyph{width:30%;height:auto;max-width:76px}
${(['markdown', 'html', 'site', 'pdf', 'json'] as Kind[]).map((k) => `.k-${k}{background:var(--${k}-band);color:var(--${k}-glyph)}`).join('\n')}
.k-folder{background:var(--band);color:var(--muted)}
@media (hover:hover){
.card:hover .frame{box-shadow:0 14px 32px -14px var(--shadow),0 2px 6px -2px var(--shadow)}
.card:hover .name{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:4px;text-decoration-color:var(--muted)}
}
@media (hover:hover) and (prefers-reduced-motion:no-preference){.card:hover .frame{translate:0 -3px}}
.name{display:block;margin:16px 0 0;font:400 21px/1.3 ${SERIF};color:var(--fg);text-wrap:balance;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:4px 8px;margin:6px 0 0;color:var(--muted);font-size:14px;line-height:1.4}
.meta span+span::before{content:"·";margin-right:8px}
.grid.folders{margin-bottom:44px}
.sub{display:block;font-size:14px;color:var(--muted)}
.num{font-variant-numeric:tabular-nums}
.preview{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;margin:12px 0 0;padding:12px 16px;border-radius:12px;background:var(--band);color:var(--soft);font-size:14px;line-height:1.45}
.preview strong{color:var(--fg);font-weight:600}
.empty{max-width:46ch;margin:0;padding:40px 0;border-top:1px solid var(--rule);color:var(--muted);font:19px/1.6 ${SERIF};font-style:italic}
@media (max-width:640px){
body{font-size:16px}.page{padding:0 20px 80px}.head{margin:28px 0 36px}.desc{font-size:17px}.grid{gap:36px}.name{font-size:19px}
}
@media print{.theme-toggle{display:none}body{background:#fff;color:#000}}
`;

const dayFmt = (locale: Locale) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "today", "yesterday", "3 days ago", "2 weeks ago", "4 months ago", "last year" (localised by Intl). */
export function folderRelativeDate(iso: string, nowMs: number, locale: Locale = 'en'): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const days = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 86_400_000));
  if (days < 7) return rtf.format(-days, 'day');
  if (days < 30) return rtf.format(-Math.floor(days / 7), 'week');
  if (days < 365) return rtf.format(-Math.floor(days / 30), 'month');
  return rtf.format(-Math.floor(days / 365), 'year');
}

function card(c: FolderCard, nowMs: number, locale: Locale): string {
  const frame = c.thumbUrl
    ? `<img src="${escapeHtml(c.thumbUrl)}" width="960" height="600" alt="" loading="lazy" decoding="async">`
    : svg(ICON_PATHS[c.kind], 64, 'glyph');
  const version = c.versionNumber ? `<span class="num">v${c.versionNumber}</span>` : '';
  return `<li><a class="card" href="${escapeHtml(c.href)}">
<span class="frame k-${c.kind}">${frame}</span>
<span class="name">${typography(locale, escapeHtml(c.title))}</span>
<span class="meta"><span>${tr(locale, `kind.${c.kind}`)}</span><span><time datetime="${escapeHtml(c.updatedAt)}" title="${dayFmt(locale).format(new Date(c.updatedAt))}">${folderRelativeDate(c.updatedAt, nowMs, locale)}</time></span>${version}</span>
</a></li>`;
}

function folderCard(f: FolderSubCard, nowMs: number, locale: Locale): string {
  const counts = f.count + f.childCount === 0
    ? tr(locale, 'folder.emptyChild')
    : [f.count ? tr(locale, 'folder.count', { n: f.count }) : '', f.childCount ? tr(locale, 'folder.subCount', { n: f.childCount }) : '']
        .filter(Boolean).join(' · ');
  const desc = f.description?.trim() ? `<span class="sub">${typography(locale, escapeHtml(f.description.trim()))}</span>` : '';
  const inner = `<span class="frame k-folder">${svg(FOLDER, 64, 'glyph')}</span>
<span class="name">${typography(locale, escapeHtml(f.title))}</span>${desc}
<span class="meta"><span>${counts}</span><span><time datetime="${escapeHtml(f.updatedAt)}">${folderRelativeDate(f.updatedAt, nowMs, locale)}</time></span></span>`;
  return f.href
    ? `<li><a class="card" href="${escapeHtml(f.href)}">${inner}</a></li>`
    : `<li><span class="card">${inner}</span></li>`;
}

export function renderFolderPage(o: FolderPageInput, locale: Locale = 'en'): string {
  const title = o.title?.trim() || o.name;
  const n = o.cards.length;
  const count = n === 0 ? '' : `<p class="count">${tr(locale, 'folder.count', { n })}</p>`;
  const desc = o.description?.trim() ? `<p class="desc">${typography(locale, escapeHtml(o.description.trim()))}</p>` : '';
  const folders = o.folders.length
    ? `<section aria-label="${tr(locale, 'folder.folders')}"><ul class="grid folders" role="list">${o.folders.map((f) => folderCard(f, o.nowMs, locale)).join('\n')}</ul></section>`
    : '';
  const arts = n ? `<ul class="grid" role="list">${o.cards.map((c) => card(c, o.nowMs, locale)).join('\n')}</ul>` : '';
  const body = n === 0 && o.folders.length === 0 ? `<p class="empty">${tr(locale, 'folder.empty')}</p>` : folders + arts;
  // The theme switch (a label for the checkbox, pure CSS) sits at the right of the top bar (design 10).
  const themeButton = `<label for="theme-toggle" class="bar-btn theme-btn" aria-hidden="true"><span class="to-dark">${svg(MOON, 16)}<span class="label">${tr(locale, 'theme.dark')}</span></span><span class="to-light">${svg(SUN, 16)}<span class="label">${tr(locale, 'theme.light')}</span></span></label>`;
  const preview = o.preview
    ? `<p class="preview" role="note"><strong>${tr(locale, 'folder.previewTitle')}</strong><span>${tr(locale, 'folder.previewBody', { visibility: tr(locale, `visibility.${o.preview.visibility}`) })}</span></p>`
    : '';
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<input type="checkbox" id="theme-toggle" class="theme-toggle" aria-label="${tr(locale, 'theme.toggle')}">
${renderBar({ path: o.breadcrumb, title, heading: false, actions: themeButton }, locale)}
<div class="page">
${preview}
<header class="head"><h1 class="title">${typography(locale, escapeHtml(title))}</h1>${desc}${count}</header>
<main>${body}</main>
</div>
</body>
</html>
`;
}
