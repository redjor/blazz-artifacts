// Visitor top bar (design 10), shared by the artifact frame page and the folder page: the path on the left (folder
// links, then the current title), actions on the right. Script-free; every text goes through escapeHtml.
import { tr, type Locale } from '../i18n.ts';
import { escapeHtml, SANS, SERIF, typography } from '../ingest/page.ts';

export const svgIcon = (paths: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICON_DOWNLOAD = '<path d="M12 4.5V15M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>';
export const ICON_OPEN = '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>';

export const BAR_HEIGHT = 52;

/** Bar styles; the page defines the palette (--bg, --fg, --muted, --rule, --band, --link). */
export const BAR_CSS = `
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;height:${BAR_HEIGHT}px;padding:0 12px 0 20px;
background:var(--bg);border-bottom:1px solid var(--rule);font:14px/1.2 ${SANS};color:var(--fg)}
.bar-path{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.bar-path a{flex-shrink:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);text-decoration:none;
border-radius:6px;padding:4px 2px}
.bar-path a:focus-visible{outline:2px solid var(--link);outline-offset:1px}
@media (hover:hover){.bar-path a:hover{color:var(--fg);text-decoration:underline;text-underline-offset:3px}}
.bar-sep{color:var(--rule);flex-shrink:0}
.bar-title{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 15px/1.2 ${SERIF};letter-spacing:-0.01em}
.bar-version{flex-shrink:0;padding:2px 8px;border-radius:999px;background:var(--band);color:var(--muted);font-size:12px;
font-variant-numeric:tabular-nums}
.bar-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}
.bar-btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border-radius:999px;color:var(--muted);
text-decoration:none;cursor:pointer;user-select:none;transition:background-color 150ms ease-out,color 150ms ease-out}
.bar-btn:focus-visible{outline:2px solid var(--link);outline-offset:2px}
@media (hover:hover){.bar-btn:hover{background:var(--band);color:var(--fg)}}
@media (max-width:640px){.bar{padding:0 6px 0 14px;gap:8px}.bar-btn{padding:0 10px}.bar-btn .label{position:absolute;width:1px;height:1px;
overflow:hidden;clip-path:inset(50%);white-space:nowrap}.bar-path a,.bar-path .bar-sep{display:none}.bar-path a:last-of-type,
.bar-path a:last-of-type+.bar-sep{display:inline}}
@media print{.bar{display:none}}
`;

export interface BarInput {
  /** Folder links from the granting folder down; empty when the page was not reached through a folder. */
  path: { href: string; title: string }[];
  title: string;
  version?: number | null;
  /** Already rendered action buttons (links or the theme switch label). */
  actions: string;
  /** The title is the page heading (frame page); false when the page has its own <h1> (folder page). */
  heading?: boolean;
}

/** A link styled as a bar button; on phones only its icon shows, the label stays for screen readers. */
export const barLink = (o: { href: string; label: string; icon: string; download?: string; title?: string }) =>
  `<a class="bar-btn" href="${escapeHtml(o.href)}"${o.download !== undefined ? ` download="${escapeHtml(o.download)}"` : ''}${o.title ? ` title="${escapeHtml(o.title)}"` : ''}>${svgIcon(o.icon)}<span class="label">${escapeHtml(o.label)}</span></a>`;

export function renderBar(o: BarInput, locale: Locale): string {
  const sep = '<span class="bar-sep" aria-hidden="true">/</span>';
  const links = o.path.map((p) => `<a href="${escapeHtml(p.href)}">${escapeHtml(p.title)}</a>${sep}`).join('');
  const version = o.version ? `<span class="bar-version" title="${escapeHtml(tr(locale, 'bar.version', { n: o.version }))}">v${o.version}</span>` : '';
  const tag = o.heading === false ? 'span' : 'h1';
  return `<header class="bar">
<nav class="bar-path" aria-label="${tr(locale, 'folder.breadcrumb')}">${links}<${tag} class="bar-title" aria-current="page">${typography(locale, escapeHtml(o.title))}</${tag}>${version}</nav>
<div class="bar-actions">${o.actions}</div>
</header>`;
}
