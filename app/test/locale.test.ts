import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { notFoundPage, unlockPage, folderUnlockPage } from '../src/content/pages.ts';
import { renderFolderPage } from '../src/content/folder-page.ts';
import { ERRORS } from '../src/errors.ts';
import { MESSAGES, pickLocale, staticLocale, tr } from '../src/i18n.ts';
import { renderSourcePage } from '../src/ingest/ingest.ts';
import { renderArticle } from '../src/ingest/page.ts';
import { seedArtifact, setup } from './harness.ts';

const base = {
  HUB_SECRET: Buffer.alloc(48, 1).toString('base64'),
  PUBLIC_HUB_URL: 'https://hub.example.com',
  PUBLIC_CONTENT_URL: 'https://artifacts.example.com',
};

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('HUB_LOCALE: en by default, fr and auto accepted, anything else refused', () => {
  assert.equal(loadConfig(base).locale, 'en');
  assert.equal(loadConfig({ ...base, HUB_LOCALE: 'fr' }).locale, 'fr');
  assert.equal(loadConfig({ ...base, HUB_LOCALE: 'auto' }).locale, 'auto');
  assert.equal(loadConfig({ ...base, HUB_LOCALE: '' }).locale, 'en');
  assert.throws(() => loadConfig({ ...base, HUB_LOCALE: 'de' }), /HUB_LOCALE/);
});

test('pickLocale: fixed setting ignores Accept-Language; auto follows it with q-values, falls back to en', () => {
  assert.equal(pickLocale('en', 'fr-FR,fr;q=0.9'), 'en');
  assert.equal(pickLocale('fr', 'en-US'), 'fr');
  assert.equal(pickLocale('auto', 'fr-FR,fr;q=0.9,en;q=0.8'), 'fr');
  assert.equal(pickLocale('auto', 'de-DE, en;q=0.5, fr;q=0.4'), 'en');
  assert.equal(pickLocale('auto', 'en;q=0.2, fr-CA;q=0.8'), 'fr');
  assert.equal(pickLocale('auto', 'de'), 'en');
  assert.equal(pickLocale('auto', 'fr;q=0'), 'en');
  assert.equal(pickLocale('auto', undefined), 'en');
  assert.equal(staticLocale('auto'), 'en');
  assert.equal(staticLocale('fr'), 'fr');
});

test('server dictionaries: identical keys and placeholders in en and fr', () => {
  const en = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.fr).sort(), en);
  for (const k of en) assert.deepEqual(placeholders(MESSAGES.fr[k as keyof typeof MESSAGES.fr]), placeholders(MESSAGES.en[k as keyof typeof MESSAGES.en]), k);
  assert.equal(tr('en', 'folder.count', { n: 1 }), '1 artifact');
  assert.equal(tr('en', 'folder.count', { n: 3 }), '3 artifacts');
  assert.equal(tr('fr', 'folder.count', { n: 1 }), '1 artéfact');
  assert.equal(tr('fr', 'folder.count', { n: 3 }), '3 artéfacts');
});

test('API error codes: snake_case, English messages', () => {
  for (const [code, message] of Object.entries(ERRORS)) {
    assert.match(code, /^[a-z][a-z0-9_]*$/, code);
    assert.doesNotMatch(message, /[éèàùç«»]/, `${code}: ${message}`);
  }
});

test('visitor pages: <html lang> and copy follow the locale', () => {
  const en = notFoundPage('en');
  assert.match(en, /<html lang="en">/);
  assert.match(en, /Not found/);
  const fr = notFoundPage('fr');
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, /Introuvable/);

  const unlockEn = unlockPage({ slug: 's', title: 'T', next: '', error: 'x' }, 'en');
  assert.match(unlockEn, /This content is protected by a code\./);
  assert.match(unlockEn, /<button type="submit">Unlock<\/button>/);
  const unlockFr = folderUnlockPage({ name: 'n', title: 'T' }, 'fr');
  assert.match(unlockFr, /<html lang="fr">/);
  assert.match(unlockFr, /Ce dossier est protégé par un code\./);
  assert.match(unlockFr, /<button type="submit">Accéder<\/button>/);
});

test('folder page: English by default, French copy and typography only in fr', () => {
  const card = { href: '/d/x/a/y', title: 'Plan : v2', kind: 'markdown' as const, updatedAt: new Date(0).toISOString(), versionNumber: 2, thumbUrl: null };
  const input = { name: 'x', title: 'Client : Acme', description: null, cards: [card], nowMs: 0, folders: [], breadcrumb: [] };
  const en = renderFolderPage(input, 'en');
  assert.match(en, /<html lang="en">/);
  assert.match(en, /1 artifact</);
  assert.match(en, /Client : Acme/, 'no non-breaking space in English');
  assert.match(en, />Dark</);
  assert.match(en, />today</);
  const fr = renderFolderPage({ ...input, preview: { visibility: 'private' } }, 'fr');
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, /1 artéfact</);
  assert.match(fr, /Client : Acme|Client : Acme/);
  assert.match(fr, /Visibilité du dossier : privé/);
  assert.match(fr, />aujourd’hui</);
  assert.match(renderFolderPage({ ...input, cards: [] }, 'en'), /This folder is empty for now\./);
  assert.match(renderFolderPage({ ...input, cards: [] }, 'fr'), /Ce dossier est vide pour l’instant\./);
});

test('Markdown page chrome: Contents / Sommaire, original link label, lang and typography', () => {
  const md = '# Title : one\n\n## A\n\nx\n\n## B\n\ny';
  const en = renderSourcePage('markdown', md, 'f', 'en');
  assert.match(en, /<html lang="en">/);
  assert.match(en, /<span>Contents<\/span>/);
  assert.match(en, /download>Original Markdown<\/a>/);
  assert.match(en, /Title : one/);
  const fr = renderSourcePage('markdown', md, 'f', 'fr');
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, /<span>Sommaire<\/span>/);
  assert.match(fr, /download>Markdown original<\/a>/);
  assert.match(fr, /Title : one/);
  assert.match(renderSourcePage('json', '{}', 'f', 'fr'), /download>JSON original<\/a>/);
  assert.match(renderArticle({ fallbackTitle: 't', body: '<p>x</p>' }), /<html lang="en">/);
});

test('content server: HUB_LOCALE=fr renders French pages; auto follows Accept-Language', async () => {
  const fr = await setup({ locale: 'fr' });
  const res = await fr.content.request('/a/missing');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /<html lang="fr">[\s\S]*Introuvable/);

  const auto = await setup({ locale: 'auto' });
  await seedArtifact(auto, { slug: 'locked', visibility: 'code', code: 'sesame-123', files: { 'index.html': 'x' }, kind: 'html' });
  const asFr = await auto.content.request('/a/locked', { headers: { 'accept-language': 'fr-FR,fr;q=0.9' } });
  assert.equal(asFr.status, 401);
  assert.match(await asFr.text(), /<html lang="fr">[\s\S]*Ce contenu est protégé par un code/);
  const asEn = await auto.content.request('/a/locked', { headers: { 'accept-language': 'en-GB' } });
  assert.match(await asEn.text(), /<html lang="en">[\s\S]*This content is protected by a code/);
  const wrong = await auto.content.request('/unlock/locked', {
    method: 'POST', headers: { 'accept-language': 'fr', 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=nope',
  });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Code incorrect\./);
});
