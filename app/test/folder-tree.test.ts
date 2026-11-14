import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, tx } from '../src/db.ts';
import { ancestors, canReparent, children, folderLevel, MAX_FOLDER_DEPTH, setChildrenOrder, setParent, subtreeHeight } from '../src/folder-tree.ts';
import { getProject, renameProject, upsertProject } from '../src/repo.ts';

/** a > b > c > d (4 levels), e at the root. */
function tree() {
  const db = openDb(':memory:');
  for (const n of ['a', 'b', 'c', 'd', 'e']) upsertProject(db, n, {});
  setParent(db, 'b', 'a');
  setParent(db, 'c', 'b');
  setParent(db, 'd', 'c');
  return db;
}

test('ancestors nearest first, levels and heights', () => {
  const db = tree();
  assert.deepEqual(ancestors(db, 'd').map((p) => p.name), ['c', 'b', 'a']);
  assert.deepEqual(ancestors(db, 'a'), []);
  assert.equal(folderLevel(db, 'd'), 4);
  assert.equal(subtreeHeight(db, 'a'), 4);
  assert.equal(subtreeHeight(db, 'd'), 1);
  assert.equal(subtreeHeight(db, 'sans-fiche'), 1);
  assert.equal(MAX_FOLDER_DEPTH, 4);
});

test('canReparent: self, missing, cycle, depth, ok', () => {
  const db = tree();
  assert.equal(canReparent(db, 'a', 'a'), 'self');
  assert.equal(canReparent(db, 'a', 'nope'), 'missing');
  assert.equal(canReparent(db, 'a', 'd'), 'cycle');
  assert.equal(canReparent(db, 'b', 'c'), 'cycle');
  assert.equal(canReparent(db, 'e', 'd'), 'depth');   // e would be level 5
  assert.equal(canReparent(db, 'e', 'c'), 'ok');      // level 4
  assert.equal(canReparent(db, 'b', 'e'), 'ok');      // b's sub-tree (3 levels) under e (level 1) → 4 levels
  assert.equal(canReparent(db, 'c', 'e'), 'ok');      // c, d under e → levels 2, 3
  assert.equal(canReparent(db, 'd', null), 'ok');
});

test('setParent creates sheets, children follow a rename, sibling order', () => {
  const db = tree();
  setParent(db, 'nouveau', 'a');
  assert.equal(getProject(db, 'nouveau')!.parent_name, 'a');
  assert.deepEqual(children(db, 'a').map((p) => p.name), ['b', 'nouveau']);
  assert.equal(setChildrenOrder(db, 'a', ['nouveau', 'b']), true);
  assert.deepEqual(children(db, 'a').map((p) => p.name), ['nouveau', 'b']);
  assert.equal(setChildrenOrder(db, 'a', ['b']), false);
  assert.equal(setChildrenOrder(db, 'a', ['b', 'b']), false);
  tx(db, () => renameProject(db, 'a', 'z'));
  assert.deepEqual(children(db, 'z').map((p) => p.name), ['nouveau', 'b']);
  setParent(db, 'b', null);
  assert.equal(getProject(db, 'b')!.parent_name, null);
  assert.equal(getProject(db, 'b')!.position, null);
});

test('ancestors stops on a corrupt cycle', () => {
  const db = tree();
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE projects SET parent_name = ? WHERE name = ?').run('d', 'a');
  assert.ok(ancestors(db, 'd').length <= MAX_FOLDER_DEPTH);
});
