import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import sanitizeHtml from 'sanitize-html';

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
  return sanitizeHtml(md.render(src), SANITIZE);
}
