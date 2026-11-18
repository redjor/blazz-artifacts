// Paste to publish (design 15): text copied from an assistant (an HTML page, a JSON document, Markdown) becomes a
// file for the usual publish dialog. Pure: no i18n, no DOM beyond File (also run by the server tests).

export type PastedKind = 'html' | 'json' | 'markdown';

const EXT: Record<PastedKind, string> = { html: 'html', json: 'json', markdown: 'md' };
const TYPE: Record<PastedKind, string> = { html: 'text/html', json: 'application/json', markdown: 'text/markdown' };
/** Below this, a paste is a word or a URL typed in the wrong place, not a document. */
const MIN_CHARS = 20;
const CLOSING_TAG = /<\/(html|head|body|main|header|footer|section|article|div|p|h[1-6]|ul|ol|table|svg|style|script|form|nav)>/i;

/** What the clipboard text is; null when it does not look like a document (too short, a single line of prose). */
export function detectPaste(text: string): PastedKind | null {
  const s = text.trim();
  if (s.length < MIN_CHARS) return null;
  if (/^<!doctype html/i.test(s) || /^<html[\s>]/i.test(s) || (s.startsWith('<') && CLOSING_TAG.test(s))) return 'html';
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return 'json';
    } catch {
      // not JSON: Markdown below if it has several lines
    }
  }
  return s.includes('\n') ? 'markdown' : null;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const clean = (s: string) => decode(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** The document's own title: <title> or the first <h1> for HTML, the first `# ` heading for Markdown. */
function titleOf(kind: PastedKind, text: string): string | null {
  if (kind === 'html') {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
    return m ? clean(m[1]) || null : null;
  }
  if (kind === 'markdown') {
    const m = /^#[ \t]+(.+)$/m.exec(text);
    return m ? m[1].replace(/[#*_`]+/g, '').trim() || null : null;
  }
  return null;
}

/**
 * The file the publish dialog receives, named after the document's title (else `fallbackTitle`): the dialog derives
 * the title and the address from the name. Null when the text is not a document.
 */
export function pastedFile(text: string, fallbackTitle: string): File | null {
  const kind = detectPaste(text);
  if (!kind) return null;
  const title = (titleOf(kind, text) ?? fallbackTitle).replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
  return new File([text], `${title || 'pasted'}.${EXT[kind]}`, { type: TYPE[kind] });
}
