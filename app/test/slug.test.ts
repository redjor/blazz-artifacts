import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../src/ids.ts';
import { isValidSlug, slugify } from '../src/slug.ts';

test('isValidSlug', () => {
  for (const ok of ['a', 'simulateur', 'rapport-2026', 'a1-b2']) assert.equal(isValidSlug(ok), true, ok);
  for (const bad of ['', '-a', 'a-', 'a--b', 'A', 'é', 'a_b', 'share', 'unlock', 'x'.repeat(49)]) {
    assert.equal(isValidSlug(bad), false, bad);
  }
});

test('slugify', () => {
  assert.equal(slugify('Rapport Été 2026.md'), 'rapport-ete-2026');
  assert.equal(slugify('  ***.zip'), 'artifact');
  assert.equal(slugify('x'.repeat(80) + '.html').length, 48);
});

test('newId produit un ULID trié dans le temps', () => {
  const a = newId(1_000);
  const b = newId(2_000);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a < b);
});
