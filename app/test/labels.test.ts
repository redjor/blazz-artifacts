import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLabel, normalizeTags } from '../src/labels.ts';

test('normalizeLabel', () => {
  const cases: Record<string, string | null> = {
    'Client Acme': 'client-acme',
    '  Café_Crème  ': 'cafe-creme',
    'a  --  b': 'a-b',
    '-x-': 'x',
    'R&D!': 'rd',
    '': null,
    '   ': null,
    '日本語': null,
    '---': null,
    [`${'a'.repeat(31)} b`]: 'a'.repeat(31),
    [`${'b'.repeat(40)}`]: 'b'.repeat(32),
  };
  for (const [src, want] of Object.entries(cases)) assert.equal(normalizeLabel(src), want, src);
});

test('normalizeTags : doublons fusionnés, tri, invalide, maximum 20', () => {
  assert.deepEqual(normalizeTags(['B', 'a', 'b ']), ['a', 'b']);
  assert.equal(normalizeTags(['ok', '!!!']), null);
  assert.equal(normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`)), null);
  assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))?.length, 20);
});
