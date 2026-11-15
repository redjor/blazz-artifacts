// Artifact frame page (design 10): the visitor bar above the artifact, which stays in an <iframe> on its signed path.
// Served to browser navigations only; script-free and not sandboxed (see FRAME_PAGE_CSP).
import { tr, type Locale } from '../i18n.ts';
import { DARK, escapeHtml, LIGHT, SANS } from '../ingest/page.ts';
import { BAR_CSS, BAR_HEIGHT, barLink, ICON_DOWNLOAD, ICON_OPEN, renderBar } from './bar.ts';

export interface FramePageInput {
  title: string; version: number | null;
  /** Folder links from the granting folder down (empty outside a folder). */
  path: { href: string; title: string }[];
  /** Signed path of the entry: the iframe and “Open alone”. */
  src: string;
  /** Signed path of the original file and its download name (Markdown, JSON, PDF), or null. */
  original: { href: string; name: string } | null;
}

const CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root{${DARK}}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px/1.5 ${SANS};-webkit-font-smoothing:antialiased}
${BAR_CSS}
.artifact{display:block;flex:1;width:100%;min-height:calc(100dvh - ${BAR_HEIGHT}px);border:0;background:#fff}
`;

export function renderFramePage(o: FramePageInput, locale: Locale): string {
  const actions = [
    o.original ? barLink({ href: o.original.href, label: tr(locale, 'original'), icon: ICON_DOWNLOAD, download: o.original.name, title: tr(locale, 'bar.downloadTitle') }) : '',
    barLink({ href: o.src, label: tr(locale, 'bar.openAlone'), icon: ICON_OPEN, title: tr(locale, 'bar.openAloneTitle') }),
  ].join('');
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<style>${CSS}</style>
</head>
<body>
${renderBar({ path: o.path, title: o.title, version: o.version, actions }, locale)}
<iframe class="artifact" src="${escapeHtml(o.src)}" title="${escapeHtml(o.title)}" allowfullscreen></iframe>
</body>
</html>
`;
}
