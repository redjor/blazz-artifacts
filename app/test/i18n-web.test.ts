import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ERRORS } from '../src/errors.ts';
import { detectLocale, interpolate, pluralForm } from '../web/src/i18n/core.ts';
import { en } from '../web/src/i18n/en.ts';
import { fr } from '../web/src/i18n/fr.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('admin UI dictionaries: identical key sets in en and fr', () => {
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
});

test('admin UI dictionaries: same placeholders, no empty message', () => {
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.deepEqual(placeholders(fr[key]), placeholders(en[key]), key);
    assert.ok(en[key].length > 0 && fr[key].length > 0, key);
  }
});

test('admin UI dictionaries: every plural has both forms', () => {
  for (const key of Object.keys(en)) {
    if (key.endsWith('.one')) assert.ok(`${key.slice(0, -4)}.other` in en, key);
    if (key.endsWith('.other')) assert.ok(`${key.slice(0, -6)}.one` in en, key);
  }
});

test('admin UI: every API error code has a localised message', () => {
  for (const code of Object.keys(ERRORS)) {
    assert.ok(`error.${code}` in en, `en: error.${code}`);
    assert.ok(`error.${code}` in fr, `fr: error.${code}`);
  }
});

test('locale detection: saved preference, then browser language, English otherwise', () => {
  assert.equal(detectLocale('fr', 'en-US'), 'fr');
  assert.equal(detectLocale('en', 'fr-FR'), 'en');
  assert.equal(detectLocale(null, 'fr-CA'), 'fr');
  assert.equal(detectLocale('de', 'FR'), 'fr');
  assert.equal(detectLocale(null, 'de-DE'), 'en');
  assert.equal(detectLocale(undefined, undefined), 'en');
});

test('interpolation and plural forms', () => {
  assert.equal(interpolate(en['notice.moved'], { title: 'A', folder: 'b' }), '“A” moved to “b”');
  assert.equal(interpolate('{a} {missing}', { a: 1 }), '1 {missing}');
  assert.equal(pluralForm('en', 1), 'one');
  assert.equal(pluralForm('en', 0), 'other');
  assert.equal(pluralForm('fr', 0), 'one');
  assert.equal(pluralForm('fr', 2), 'other');
});
