// Artifact frame page (design 10): the visitor bar above the artifact, which stays in an <iframe> on its signed path.
// Served to browser navigations only; script-free and not sandboxed (see FRAME_PAGE_CSP).
// Design 11 adds the screen-size switch (HTML pages and sites) and previous / next through a folder: plain links.
import { tr, type Locale } from '../i18n.ts';
import { DARK, escapeHtml, LIGHT, SANS } from '../ingest/page.ts';
import { FONT_FACES } from '../fonts.ts';
import { BAR_CSS, BAR_HEIGHT, barLink, ICON_DOWNLOAD, ICON_OPEN, renderBar, svgIcon } from './bar.ts';

/** Simulated screens (design 11); desktop is the full width of the window. */
export const SCREENS = { tablet: { w: 820, h: 1180 }, mobile: { w: 390, h: 844 } } as const;
export type Screen = keyof typeof SCREENS;
export const parseScreen = (raw: string | undefined): Screen | null => (raw === 'tablet' || raw === 'mobile' ? raw : null);

export interface FramePageInput {
  title: string; version: number | null;
  /** Folder links from the granting folder down (empty outside a folder). */
  path: { href: string; title: string }[];
  /** Signed path of the entry: the iframe and “Open alone”. */
  src: string;
  /** Signed path of the original file and its download name (Markdown, JSON, PDF), or null. */
  original: { href: string; name: string } | null;
  /** Screen-size switch: the address of this page without `?w=` and the simulated screen; null: no switch. */
  sizes?: { base: string; screen: Screen | null } | null;
  /** Previous and next artifact of the folder it was opened through; null outside a folder. */
  steps?: {
    prev: { href: string; title: string } | null; next: { href: string; title: string } | null;
    /** 1-based position and folder size. */
    index: number; count: number;
  } | null;
}

const ICON_DESKTOP = '<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5"/><path d="M9 20h6M12 16v4"/>';
const ICON_TABLET = '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M11 17.5h2"/>';
const ICON_MOBILE = '<rect x="7" y="3.5" width="10" height="17" rx="2"/><path d="M11 17.5h2"/>';
const ICON_PREV = '<path d="m14.5 6-6 6 6 6"/>';
const ICON_NEXT = '<path d="m9.5 6 6 6-6 6"/>';

const STAGE_PAD = 24;
const CSS = `
${FONT_FACES}
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root{${DARK}}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px/1.5 ${SANS};-webkit-font-smoothing:antialiased}
${BAR_CSS}
.artifact{display:block;flex:1;width:100%;min-height:calc(100dvh - ${BAR_HEIGHT}px);border:0;background:#fff}
.stage{flex:1;display:flex;justify-content:center;align-items:flex-start;overflow:auto;padding:${STAGE_PAD}px 16px;background:var(--band)}
.stage .artifact{flex:none;max-width:100%;min-height:0;border:1px solid var(--rule);border-radius:18px;
box-shadow:0 1px 2px oklch(0.35 0.03 60 / 0.12),0 12px 32px -8px oklch(0.35 0.03 60 / 0.22)}
${(Object.keys(SCREENS) as Screen[]).map((s) => `.size-${s}{width:${SCREENS[s].w}px;height:min(${SCREENS[s].h}px,calc(100dvh - ${BAR_HEIGHT + 2 * STAGE_PAD}px))}`).join('\n')}
.sizes{display:flex;align-items:center;gap:2px;padding:2px;margin-right:6px;border-radius:999px;background:var(--band)}
.size-btn{display:grid;place-items:center;width:34px;height:30px;border-radius:999px;color:var(--muted);text-decoration:none;
transition:background-color 150ms ease-out,color 150ms ease-out}
.size-btn[aria-current]{background:var(--bg);color:var(--fg);box-shadow:0 1px 2px oklch(0.35 0.03 60 / 0.18)}
.size-btn:focus-visible{outline:2px solid var(--link);outline-offset:1px}
@media (hover:hover){.size-btn:not([aria-current]):hover{color:var(--fg)}}
.steps{display:flex;align-items:center;margin-right:6px}
.step{padding:0 8px}
.step[aria-disabled]{opacity:.35;cursor:default}
.step-count{min-width:3.2em;text-align:center;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
@media (max-width:900px){.sizes{display:none}}
@media (max-width:640px){.step-count{display:none}}
`;

function renderSizes(o: NonNullable<FramePageInput['sizes']>, locale: Locale): string {
  const items: { screen: Screen | null; icon: string; label: string }[] = [
    { screen: null, icon: ICON_DESKTOP, label: tr(locale, 'bar.size.desktop') },
    { screen: 'tablet', icon: ICON_TABLET, label: tr(locale, 'bar.size.tablet', { w: SCREENS.tablet.w, h: SCREENS.tablet.h }) },
    { screen: 'mobile', icon: ICON_MOBILE, label: tr(locale, 'bar.size.mobile', { w: SCREENS.mobile.w, h: SCREENS.mobile.h }) },
  ];
  const links = items.map((i) => {
    const href = i.screen ? `${o.base}?w=${i.screen}` : o.base;
    const current = i.screen === o.screen ? ' aria-current="true"' : '';
    return `<a class="size-btn" href="${escapeHtml(href)}"${current} title="${escapeHtml(i.label)}" aria-label="${escapeHtml(i.label)}">${svgIcon(i.icon)}</a>`;
  });
  return `<nav class="sizes" aria-label="${escapeHtml(tr(locale, 'bar.size.label'))}">${links.join('')}</nav>`;
}

function renderSteps(o: NonNullable<FramePageInput['steps']>, locale: Locale): string {
  const step = (rel: 'prev' | 'next', target: { href: string; title: string } | null) => {
    const icon = svgIcon(rel === 'prev' ? ICON_PREV : ICON_NEXT);
    const label = tr(locale, rel === 'prev' ? 'bar.prev' : 'bar.next');
    if (!target) return `<span class="bar-btn step" aria-disabled="true" aria-label="${escapeHtml(label)}">${icon}</span>`;
    const title = `${label} : ${target.title}`.replace(' : ', locale === 'fr' ? ' : ' : ': ');
    return `<a class="bar-btn step" rel="${rel}" href="${escapeHtml(target.href)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${icon}</a>`;
  };
  const position = tr(locale, 'bar.position', { i: o.index, n: o.count });
  return `<nav class="steps" aria-label="${escapeHtml(tr(locale, 'bar.steps'))}">${step('prev', o.prev)}<span class="step-count" aria-label="${escapeHtml(position)}">${o.index} / ${o.count}</span>${step('next', o.next)}</nav>`;
}

export function renderFramePage(o: FramePageInput, locale: Locale): string {
  const actions = [
    o.steps ? renderSteps(o.steps, locale) : '',
    o.sizes ? renderSizes(o.sizes, locale) : '',
    o.original ? barLink({ href: o.original.href, label: tr(locale, 'original'), icon: ICON_DOWNLOAD, download: o.original.name, title: tr(locale, 'bar.downloadTitle') }) : '',
    barLink({ href: o.src, label: tr(locale, 'bar.openAlone'), icon: ICON_OPEN, title: tr(locale, 'bar.openAloneTitle') }),
  ].join('');
  const screen = o.sizes?.screen ?? null;
  const iframe = `<iframe class="artifact${screen ? ` size-${screen}` : ''}" src="${escapeHtml(o.src)}" title="${escapeHtml(o.title)}" allowfullscreen></iframe>`;
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
${screen ? `<div class="stage">${iframe}</div>` : iframe}
</body>
</html>
`;
}
