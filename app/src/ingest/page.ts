import { googleFontCss, themeFontFamily } from '../google-fonts.ts';
import type { Theme } from '../themes.ts';
import { FONT_FACES, FONT_STACK } from '../fonts.ts';
import { tr, type Locale } from '../i18n.ts';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

const CSS = `
${FONT_FACES}
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa;--link:#0969da;
--kw:#cf222e;--str:#0a3069;--num:#0550ae;--com:#59636e;--fn:#8250df;--ti:#953800}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--code:#151b23;--link:#4493f8;
--kw:#ff7b72;--str:#a5d6ff;--num:#79c0ff;--com:#9198a1;--fn:#d2a8ff;--ti:#ffa657}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ${FONT_STACK}}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;justify-content:flex-end;margin-bottom:16px;font-size:14px}
a{color:var(--link)}
h1,h2{border-bottom:1px solid var(--border);padding-bottom:.3em}
img{max-width:100%}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid var(--border);padding:6px 12px}
pre{background:var(--code);padding:16px;border-radius:8px;overflow-x:auto;font-size:14px;line-height:1.45}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
:not(pre)>code{background:var(--code);padding:.15em .35em;border-radius:6px}
blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--border)}
.task-list-item{list-style:none}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--kw)}
.hljs-string,.hljs-attr,.hljs-regexp{color:var(--str)}
.hljs-number,.hljs-built_in,.hljs-attribute{color:var(--num)}
.hljs-comment,.hljs-quote{color:var(--com);font-style:italic}
.hljs-title,.hljs-function{color:var(--fn)}
.hljs-type,.hljs-variable,.hljs-tag{color:var(--ti)}
form{display:grid;gap:12px;max-width:320px}
input{font:inherit;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;padding:8px 12px;border:0;border-radius:8px;background:var(--fg);color:var(--bg);cursor:pointer}
.error{color:var(--kw)}
`;

// Reading palettes. The theme follows the system; the #theme-toggle checkbox inverts it,
// in pure CSS: the Markdown page is served without scripts (CSP sandbox).
export const LIGHT = `--bg:#faf7f2;--fg:#1c1917;--soft:#2e2a27;--muted:#78716c;--rule:#e2dcd3;--band:#efe9e0;--code:#f1ece4;--link:#9a3412;
--kw:#b42318;--str:#1d4ed8;--num:#7c3aed;--com:#78716c;--fn:#7c2d12;--ti:#a16207;--img:oklch(0 0 0 / 0.1);color-scheme:light`;
export const DARK = `--bg:#161312;--fg:#efebe6;--soft:#ddd7d0;--muted:#a39b93;--rule:#34302d;--band:#272422;--code:#211e1c;--link:#f0a37a;
--kw:#ff8b7b;--str:#a5c8ff;--num:#c9a7ff;--com:#a39b93;--fn:#f0b48a;--ti:#e8c27a;--img:oklch(1 0 0 / 0.1);color-scheme:dark`;

// One typeface everywhere: Figtree (src/fonts.ts). SERIF names the reading and display roles, now set in Figtree too.
export const SERIF = FONT_STACK;
export const SANS = FONT_STACK;

const ARTICLE_CSS = `
${FONT_FACES}
:root{${LIGHT}}
html:has(#theme-toggle:checked){${DARK}}
@media (prefers-color-scheme:dark){
:root{${DARK}}
html:has(#theme-toggle:checked){${LIGHT}}
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.7 ${SERIF};
text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
.theme-toggle{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.page{max-width:68ch;margin:0 auto;padding:20px 24px 112px}
.reader-top{display:flex;align-items:center;justify-content:space-between;gap:16px}.reader-top .toolbar{margin-left:auto;flex-wrap:wrap}
.toolbar{display:flex;justify-content:flex-end;align-items:center;gap:8px;font:14px/1 ${SANS}}
.toolbar a,.theme-btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border-radius:999px;
color:var(--muted);text-decoration:none;cursor:pointer;user-select:none;transition:background-color 150ms ease-out,color 150ms ease-out}
@media (hover:hover){.toolbar a:hover,.theme-btn:hover{background:var(--band);color:var(--fg)}}
#theme-toggle:focus-visible~.page .theme-btn{outline:2px solid var(--link);outline-offset:2px}
.theme-btn .to-light,html:has(#theme-toggle:checked) .theme-btn .to-dark{display:none}
html:has(#theme-toggle:checked) .theme-btn .to-light{display:inline}
@media (prefers-color-scheme:dark){
.theme-btn .to-dark{display:none}.theme-btn .to-light{display:inline}
html:has(#theme-toggle:checked) .theme-btn .to-light{display:none}
html:has(#theme-toggle:checked) .theme-btn .to-dark{display:inline}
}
.doc-head{margin:40px 0 44px;text-align:center}
.doc-title{margin:0 auto;hyphens:manual;font-size:clamp(2.1rem,1.4rem + 3vw,3.1rem);line-height:1.12;font-weight:650;letter-spacing:-0.02em;text-wrap:balance}
.prose{color:var(--soft)}
.prose>:first-child{margin-top:0}
.prose p,.prose ul,.prose ol,.prose blockquote,.prose pre,.prose table,.prose figure,.prose details{margin:0 0 1.15em}
.prose h1,.prose h2,.prose h3,.prose h4{color:var(--fg);font-weight:600;letter-spacing:-0.01em;text-wrap:balance}
.prose h1,.prose h2{margin:2.2em 0 1.1em;text-align:center;line-height:1.25}
.prose h1{font-size:1.6em}.prose h2{font-size:1.4em}
.prose h1::after,.prose h2::after{content:"";display:block;width:56px;height:2px;margin:.55em auto 0;background:var(--rule)}
.prose h3{font-size:1.2em;margin:1.9em 0 .6em;font-weight:600;line-height:1.35}
.prose h4{font-size:1em;margin:1.6em 0 .5em;font-weight:600;font-style:italic}
.prose p,.prose li{text-wrap:pretty;hyphens:auto}
.prose strong{color:var(--fg);font-weight:700}
.prose a{color:var(--link);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.prose ul,.prose ol{padding-left:1.5em}
.prose li{margin:.55em 0;padding-left:.15em}.prose li>ul,.prose li>ol{margin:.4em 0 0}
.prose li::marker{color:var(--muted)}
.prose .task-list-item{list-style:none;margin-left:-1.5em}
.prose .task-list-item input{margin:0 .6em 0 0;vertical-align:-.05em}
.prose blockquote{padding:.1em 0 .1em 1.2em;border-left:2px solid var(--rule);color:var(--muted);font-style:italic}
.prose blockquote>:last-child,.prose li>p:last-child,.prose details>:last-child{margin-bottom:0}
.prose hr{border:0;margin:3em auto;width:56px;height:2px;background:var(--rule)}
.prose img{display:block;max-width:100%;height:auto;margin:2em auto;border-radius:8px;outline:1px solid var(--img);outline-offset:-1px}
.prose code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8em;font-variant-numeric:normal}
.prose :not(pre)>code{background:var(--code);padding:.12em .38em;border-radius:5px;color:var(--fg)}
.prose pre{background:var(--code);padding:18px 22px;border-radius:10px;overflow-x:auto;font-size:15px;line-height:1.6}
.prose table{display:table;width:100%;border-collapse:collapse;font-size:.88em;line-height:1.45;margin:1.6em 0 1.8em}
.prose thead th{background:var(--band);color:var(--fg);font-weight:700;border-bottom:2px solid var(--rule)}
.prose th,.prose td{padding:16px 20px;text-align:left;vertical-align:top;border-bottom:1px solid var(--rule)}
.prose td{color:var(--soft)}
.prose .diagram{width:min(1100px,calc(100vw - 48px));margin:2em 0 2em 50%;translate:-50% 0;--diagram-bg:var(--bg);--diagram-fg:var(--fg);--diagram-muted:var(--muted)}
.prose .diagram svg{display:block;max-width:100%;height:auto;margin:0 auto}
.prose details{padding:.8em 1em;border:1px solid var(--rule);border-radius:8px}
.prose summary{cursor:pointer;color:var(--fg);font-weight:600}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:var(--kw)}
.hljs-string,.hljs-attr,.hljs-regexp{color:var(--str)}
.hljs-number,.hljs-built_in,.hljs-attribute{color:var(--num)}
.hljs-comment,.hljs-quote{color:var(--com);font-style:italic}
.hljs-title,.hljs-function{color:var(--fn)}
.hljs-type,.hljs-variable,.hljs-tag{color:var(--ti)}
.prose h2{scroll-margin-top:24px}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
.toc-btn{position:fixed;left:20px;bottom:20px;z-index:10;display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 16px 0 14px;
border:1px solid transparent;border-radius:999px;background:var(--band);color:var(--fg);font:500 14px/1 ${SANS};cursor:pointer;
box-shadow:0 0 0 1px var(--rule),0 6px 20px -6px oklch(0 0 0 / 0.25);-webkit-tap-highlight-color:transparent;
transition-property:scale,background-color;transition-duration:150ms;transition-timing-function:ease-out}
@media (hover:hover){.toc-btn:hover{background:var(--code)}}
@media (prefers-reduced-motion:no-preference){.toc-btn:active{scale:.96}}
.toc-btn:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.toc{position:fixed;inset:auto auto 76px 20px;margin:0;width:min(340px,calc(100vw - 40px));max-height:min(60vh,520px);
overflow:auto;overscroll-behavior:contain;padding:14px 8px 10px;border:1px solid transparent;border-radius:16px;
background:var(--bg);color:var(--fg);box-shadow:0 0 0 1px var(--rule),0 18px 48px -12px oklch(0 0 0 / 0.35);font:15px/1.4 ${SANS}}
.toc-title{margin:0 12px 8px;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.toc ol{list-style:none;margin:0;padding:0;counter-reset:toc}
.toc li{counter-increment:toc}
.toc a{display:flex;gap:10px;padding:9px 12px;border-radius:10px;color:var(--soft);text-decoration:none;text-wrap:pretty}
.toc a::before{content:counter(toc);min-width:1.2em;color:var(--muted);font-variant-numeric:tabular-nums}
@media (hover:hover){.toc a:hover{background:var(--band);color:var(--fg)}}
.toc a:focus-visible{outline:2px solid var(--link);outline-offset:-2px}
.toc:popover-open{opacity:1;translate:0 0}
@media (prefers-reduced-motion:no-preference){
.toc{transition:opacity 150ms ease-out,translate 150ms ease-out,display 150ms allow-discrete,overlay 150ms allow-discrete}
@starting-style{.toc:popover-open{opacity:0;translate:0 8px}}
}
@media print{.toc-btn,.toc{display:none}}
@media (max-width:640px){
body{font-size:17px}.page{padding:12px 18px 80px}.doc-head{margin:24px 0 32px}
.prose table{display:block;overflow-x:auto}.prose th,.prose td{padding:12px 14px}
.prose .diagram{width:calc(100vw - 36px);overflow-x:auto}.prose .diagram svg{max-width:none}
}
@media print{.toolbar,.theme-toggle{display:none}.page{max-width:none;padding:0}body{background:#fff;color:#000}}
`;

const LEADING_H1 = /^\s*<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>\s*/i;
const stripTags = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const decodeBasic = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// French typography: non-breaking space before « ; : ! ? » and after « (outside code and tags),
// so a sign never ends up alone at the start of a line. Applied only to French pages.
export function frenchSpacing(html: string): string {
  let raw = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<(code|pre|svg)\b/i.test(part)) raw++;
        else if (/^<\/(code|pre|svg)>/i.test(part)) raw = Math.max(0, raw - 1);
        return part;
      }
      if (raw) return part;
      return part
        .replace(/ ([;:!?»])/g, ' $1')
        .replace(/« /g, '« ')
        .replace(/ (&raquo;)/g, ' $1');
    })
    .join('');
}

function anchorId(text: string, used: Set<string>): string {
  const base =
    text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

// Adds an anchor to each h2 and builds the table of contents. The HTML is already sanitised:
// ids and labels are produced here, never copied verbatim from the source.
function withAnchors(body: string): { body: string; toc: { id: string; label: string }[] } {
  const used = new Set<string>();
  const toc: { id: string; label: string }[] = [];
  const out = body.replace(/<h2(?:\s[^>]*)?>([\s\S]*?)<\/h2>/gi, (_m, inner: string) => {
    const label = decodeBasic(stripTags(inner)).replace(/ /g, ' ');
    const id = anchorId(label, used);
    toc.push({ id, label });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  return { body: out, toc };
}

const TOC_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/></svg>';

function tocHtml(toc: { id: string; label: string }[], locale: Locale): string {
  if (toc.length < 2) return '';
  const label = tr(locale, 'toc');
  const items = toc.map((t) => `<li><a href="#${t.id}">${escapeHtml(t.label)}</a></li>`).join('');
  return `<button type="button" class="toc-btn" popovertarget="toc" aria-label="${label}">${TOC_ICON}<span>${label}</span></button>
<nav id="toc" popover class="toc" aria-label="${label}"><p class="toc-title">${label}</p><ol>${items}</ol></nav>`;
}

/** French typography on French pages only. */
export const typography = (locale: Locale, html: string) => (locale === 'fr' ? frenchSpacing(html) : html);

// Reader page for Markdown and JSON. `body` is already sanitised HTML.
export function renderArticle(o: { theme?: Theme | null; fallbackTitle: string; body: string; originalHref?: string; originalLabel?: string; locale?: Locale }): string {
  const locale = o.locale ?? 'en';
  const isJson = /^<pre><code>/.test(o.body);
  const source = isJson ? o.body : typography(locale, o.body);
  const lead = LEADING_H1.exec(source);
  const titleHtml = lead && stripTags(lead[1]) ? lead[1] : typography(locale, escapeHtml(o.fallbackTitle));
  const anchored = withAnchors(lead && stripTags(lead[1]) ? source.slice(lead[0].length) : source);
  const body = anchored.body;
  const plainTitle = lead && stripTags(lead[1]) ? decodeBasic(stripTags(lead[1])) : o.fallbackTitle;
  const original = o.originalHref
    ? `<a href="${escapeHtml(o.originalHref)}" download>${escapeHtml(o.originalLabel ?? tr(locale, 'original'))}</a>`
    : '';
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(plainTitle)}</title>
<style>${ARTICLE_CSS}${o.theme ? themeCss(o.theme) : ''}</style>
</head>
<body>
<input type="checkbox" id="theme-toggle" class="theme-toggle" aria-label="${tr(locale, 'theme.toggle')}">
<div class="page">
<div class="reader-top">${o.theme ? themeBrand(o.theme) : ''}<nav class="toolbar">${original}<label for="theme-toggle" class="theme-btn" aria-hidden="true"><span class="to-dark">◐ ${tr(locale, 'theme.dark')}</span><span class="to-light">◑ ${tr(locale, 'theme.light')}</span></label></nav></div>
${o.theme?.header ? `<p class="client-header">${escapeHtml(o.theme.header)}</p>` : ''}
<header class="doc-head"><h1 class="doc-title">${titleHtml}</h1></header>
<article class="prose">${body}</article>
${o.theme?.footer ? `<footer class="client-footer">${escapeHtml(o.theme.footer)}</footer>` : ''}
</div>
${tocHtml(anchored.toc, locale)}
</body>
</html>
`;
}

export function renderDocument(o: { title: string; body: string; originalHref?: string; originalLabel?: string; locale?: Locale }): string {
  const locale = o.locale ?? 'en';
  const header = o.originalHref
    ? `<header><a href="${escapeHtml(o.originalHref)}" download>${escapeHtml(o.originalLabel ?? tr(locale, 'original'))}</a></header>`
    : '';
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<style>${CSS}</style>
</head>
<body><main>${header}${o.body}</main></body>
</html>
`;
}

function themeBrand(t: Theme): string {
  return `<div class="client-brand">${t.logoDataUrl ? `<img src="${escapeHtml(t.logoDataUrl)}" alt="${escapeHtml(t.clientName)}">` : ''}${!t.logoDataUrl && t.clientName ? `<strong>${escapeHtml(t.clientName)}</strong>` : ''}</div>`;
}
function themeCss(t: Theme): string {
  const font = themeFontFamily(t.font);
  const width = { narrow: '56ch', standard: '68ch', wide: '92ch' }[t.width];
  const layout = { documentation: '.doc-head,.prose h1,.prose h2{text-align:left}.prose h1::after,.prose h2::after{margin-left:0}', report: '.doc-head{padding:40px 0;border-top:4px solid var(--client-primary);border-bottom:1px solid var(--rule)}', editorial: '.doc-title{font-size:clamp(2.5rem,5vw,4rem)}.prose{line-height:1.85}' }[t.preset];
  const light = `--client-title:${accessibleColor(t.primaryColor, '#faf7f2')};--client-link:${accessibleColor(t.accentColor, '#faf7f2')}`;
  const dark = `--client-title:${accessibleColor(t.primaryColor, '#161312')};--client-link:${accessibleColor(t.accentColor, '#161312')}`;
  return `${googleFontCss(t.font, t.fontData)}:root{${light}}html:has(#theme-toggle:checked){${dark}}@media(prefers-color-scheme:dark){:root{${dark}}html:has(#theme-toggle:checked){${light}}}:root{--client-primary:${t.primaryColor};--client-accent:${t.accentColor}}body{font-family:${font}}.page{max-width:${width}}.doc-title{color:var(--client-title)}.prose a{color:var(--client-link)}.prose h1::after,.prose h2::after{background:var(--client-accent)}.client-brand{flex-shrink:0;white-space:pre-wrap}.client-brand img{display:block;width:auto;height:40px;max-width:120px;object-fit:contain}.client-header{white-space:pre-wrap;margin-top:24px}.client-brand strong{display:block}.client-brand p{margin-bottom:0}.client-footer{margin-top:48px;padding-top:24px;border-top:1px solid var(--rule);font-size:14px;color:var(--muted);white-space:pre-wrap}${layout}@media print{.doc-title{color:#000}.prose a{color:#000}}`;
}

/** Mix toward the contrasting endpoint until text reaches WCAG AA on its reading palette. */
export function accessibleColor(color: string, background: string): string {
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const luminance = (v: number[]) => v.map(n => { const c = n / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  const bg = luminance(rgb(background)), input = rgb(color), end = bg > .5 ? 0 : 255;
  for (let step = 0; step <= 100; step++) {
    const mixed = input.map(n => Math.round(n + (end - n) * step / 100));
    const l = luminance(mixed);
    if ((Math.max(l, bg) + .05) / (Math.min(l, bg) + .05) >= 4.5) return '#' + mixed.map(n => n.toString(16).padStart(2, '0')).join('');
  }
  return end === 0 ? '#000000' : '#ffffff';
}
