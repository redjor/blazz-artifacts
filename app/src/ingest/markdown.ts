import { randomBytes } from 'node:crypto';
import { renderMermaidSVG } from 'beautiful-mermaid';
import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import sanitizeHtml from 'sanitize-html';

// Mermaid fences become inline SVG here, at upload time: the reader page runs no script (CSP sandbox). Colours follow
// the page palette through --diagram-* (src/ingest/page.ts), so the theme switch applies to them.
const MERMAID_OPTIONS = { bg: 'var(--diagram-bg)', fg: 'var(--diagram-fg)', muted: 'var(--diagram-muted)', transparent: true, font: 'Figtree' };
// The renderer draws 11–13 px text; shown 25 % larger to sit closer to the 18 px reading size (wide diagrams still
// shrink to the column, see .diagram in page.ts).
const DIAGRAM_SCALE = 1.25;
// The renderer escapes labels and style values. Anything active or remote left in its output (a script, an event
// handler, a link, a url() other than an in-document #marker) keeps the code block instead.
const UNSAFE_SVG = /<script|<foreignobject|<image|<a[\s>]|<animate|<set[\s>]|\son[a-z]+\s*=|href\s*=|url\(\s*(?!['"]?#)|@import/i;

function mermaidSvg(src: string): string | null {
  let svg: string;
  try {
    svg = renderMermaidSVG(src, MERMAID_OPTIONS);
  } catch {
    return null; // Unsupported diagram type or syntax error: shown as code.
  }
  // Drop the renderer's Google Fonts import: visitor pages never call a third party, Figtree is self-hosted.
  svg = svg.replace(/^\s*@import url\([^)]*\);\s*$/gm, '');
  svg = svg.replace(/^<svg ([^>]*?)width="([\d.]+)" height="([\d.]+)"/, (_m, attrs: string, w: string, h: string) =>
    `<svg ${attrs}width="${Math.round(Number(w) * DIAGRAM_SCALE)}" height="${Math.round(Number(h) * DIAGRAM_SCALE)}"`);
  return UNSAFE_SVG.test(svg) ? null : svg;
}

type RenderEnv = { marker: string; diagrams: string[] };

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        return '';
      }
    }
    return '';
  },
}).use(taskLists, { enabled: false });

const fence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim().split(/\s+/)[0].toLowerCase() === 'mermaid') {
    const svg = mermaidSvg(token.content);
    const e = env as RenderEnv;
    if (svg) {
      e.diagrams.push(svg);
      return `<p>${e.marker}-${e.diagrams.length - 1}</p>\n`;
    }
  }
  return fence(tokens, idx, options, env, self);
};

const ALIGN = { 'text-align': [/^(left|right|center)$/] };

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'del', 's', 'details', 'summary', 'input', 'span', 'sup', 'sub', 'kbd']),
  allowedAttributes: {
    a: ['href', 'title', 'name', 'rel', 'target'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: ['class'],
    span: ['class'],
    pre: ['class'],
    li: ['class'],
    ul: ['class'],
    input: [{ name: 'type', multiple: false, values: ['checkbox'] }, 'checked', 'disabled'],
    th: ['style'],
    td: ['style'],
  },
  allowedStyles: { th: ALIGN, td: ALIGN },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' } }),
  },
};

export function renderMarkdown(src: string): string {
  // Diagrams go in after sanitising (which would strip SVG), in place of a marker the source cannot guess.
  const env: RenderEnv = { marker: `diagram-${randomBytes(12).toString('hex')}`, diagrams: [] };
  const html = sanitizeHtml(md.render(src, env), SANITIZE);
  if (!env.diagrams.length) return html;
  return html.replace(new RegExp(`<p>${env.marker}-(\\d+)</p>`, 'g'), (_m, i: string) => `<figure class="diagram">${env.diagrams[Number(i)]}</figure>`);
}
