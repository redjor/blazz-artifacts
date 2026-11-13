import { tr, type Locale } from '../i18n.ts';
import { escapeHtml, renderDocument } from '../ingest/page.ts';

export function unlockPage(o: { slug: string; title: string; next: string; error?: string }, locale: Locale = 'en'): string {
  const error = o.error ? `<p class="error">${escapeHtml(o.error)}</p>` : '';
  return renderDocument({
    locale,
    title: o.title,
    body: `<h1>${escapeHtml(o.title)}</h1>
<p>${tr(locale, 'unlock.artifact')}</p>${error}
<form method="post" action="/unlock/${escapeHtml(o.slug)}">
<input type="password" name="code" autocomplete="off" required autofocus aria-label="${tr(locale, 'unlock.code')}">
<input type="hidden" name="next" value="${escapeHtml(o.next)}">
<button type="submit">${tr(locale, 'unlock.submit')}</button>
</form>`,
  });
}

export function notFoundPage(locale: Locale = 'en'): string {
  const title = tr(locale, 'notFound.title');
  return renderDocument({ locale, title, body: `<h1>${title}</h1><p>${tr(locale, 'notFound.body')}</p>` });
}

export function folderUnlockPage(o: { name: string; title: string; error?: string }, locale: Locale = 'en'): string {
  const error = o.error ? `<p class="error">${escapeHtml(o.error)}</p>` : '';
  return renderDocument({
    locale,
    title: o.title,
    body: `<h1>${escapeHtml(o.title)}</h1>
<p>${tr(locale, 'unlock.folder')}</p>${error}
<form method="post" action="/unlock-folder/${escapeHtml(o.name)}">
<input type="password" name="code" autocomplete="off" required autofocus aria-label="${tr(locale, 'unlock.code')}">
<button type="submit">${tr(locale, 'unlock.submit')}</button>
</form>`,
  });
}
