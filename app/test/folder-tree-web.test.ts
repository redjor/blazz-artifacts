import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ancestorsOf, childrenOf, descendantsOf, folderPath, moveTargets, sharedVia, subtreeExposure, treeOptions, type TreeFolder } from '../web/src/folderTree.ts';

const f = (name: string, parent: string | null, o: Partial<TreeFolder> = {}): TreeFolder =>
  ({ name, parent, title: null, visibility: 'private', count: 0, privateCount: 0, position: null, ...o });

// a > b > c > d ; a > b2 ; e
const FOLDERS = [
  f('a', null, { visibility: 'link', count: 1 }), f('b', 'a', { count: 2, privateCount: 1, title: 'Bravo' }), f('c', 'b', { count: 3, privateCount: 3 }),
  f('d', 'c'), f('b2', 'a', { position: 0 }), f('e', null),
];

test('tree navigation', () => {
  assert.deepEqual(childrenOf(FOLDERS, null).map((x) => x.name), ['a', 'e']);
  assert.deepEqual(childrenOf(FOLDERS, 'a').map((x) => x.name), ['b2', 'b'], 'position first, then title');
  assert.deepEqual(ancestorsOf(FOLDERS, 'd').map((x) => x.name), ['a', 'b', 'c']);
  assert.deepEqual(descendantsOf(FOLDERS, 'b').map((x) => x.name).sort(), ['c', 'd']);
  assert.equal(folderPath(FOLDERS, 'c'), 'a / Bravo / c');
  assert.deepEqual(treeOptions(FOLDERS).map((o) => `${o.depth}:${o.folder.name}`), ['0:a', '1:b2', '1:b', '2:c', '3:d', '0:e']);
});

test('exposure and shared-via', () => {
  assert.deepEqual(subtreeExposure(FOLDERS, 'b'), { folders: 2, artifacts: 5, privateArtifacts: 4 });
  assert.equal(sharedVia(FOLDERS, 'd')!.name, 'a');
  assert.equal(sharedVia(FOLDERS, 'e'), null);
  assert.equal(sharedVia(FOLDERS, 'a'), null, 'own visibility is not "via"');
});

test('move targets exclude self, descendants and too-deep parents', () => {
  const names = (n: string) => moveTargets(FOLDERS, n).map((o) => o.folder?.name ?? '(root)');
  assert.deepEqual(names('b'), ['(root)', 'a', 'e'], 'b has 3 levels: only level-1 parents fit');
  assert.deepEqual(names('e'), ['(root)', 'a', 'b2', 'b', 'c']);
  assert.ok(!names('e').includes('d'), 'level 4 cannot take children');
});
