import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { injectShim, STORAGE_SHIM } from '../src/content/shim.ts';

const TAG = `<script>${STORAGE_SHIM}</script>`;

test('injectShim : après <head>, insensible à la casse, avec attributs', () => {
  assert.equal(injectShim('<!doctype html><html><head><title>x</title></head>'), `<!doctype html><html><head>${TAG}<title>x</title></head>`);
  assert.equal(injectShim('<HTML><HEAD lang="fr"><script>a()</script>'), `<HTML><HEAD lang="fr">${TAG}<script>a()</script>`);
});

test('injectShim : <header> n’est pas <head>', () => {
  assert.equal(injectShim('<html><header>h</header>'), `<html>${TAG}<header>h</header>`);
});

test('injectShim : sans <head>, après <html>', () => {
  assert.equal(injectShim('<!DOCTYPE html><HTML lang="en"><body></body>'), `<!DOCTYPE html><HTML lang="en">${TAG}<body></body>`);
});

test('injectShim : sans <head> ni <html>, après le doctype', () => {
  assert.equal(injectShim('<!DOCTYPE html>\n<p>x</p>'), `<!DOCTYPE html>${TAG}\n<p>x</p>`);
  assert.ok(injectShim('<!doctype html><p>x</p>').startsWith('<!doctype html>'));
});

test('injectShim : sinon en tête', () => {
  assert.equal(injectShim('<p>x</p>'), `${TAG}<p>x</p>`);
});

// Le shim s'exécute dans un contexte vm avec un objet window ordinaire (un getter qui lève sur le global vm est avalé par V8).
function fakeWindow(name = '', throwing = true) {
  const win: Record<string, any> = { name };
  if (throwing) {
    for (const k of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(win, k, { configurable: true, get() { throw new Error('SecurityError'); } });
    }
  }
  const run = () => (runInContext(`(function(window){${STORAGE_SHIM}})`, createContext({})) as (w: unknown) => void)(win);
  return { win, run };
}

test('shim : remplace les stockages qui lèvent une exception', () => {
  const { win, run } = fakeWindow();
  run();
  win.localStorage.setItem('a', 1);
  win.localStorage.setItem('b', 'x');
  win.sessionStorage.setItem('s', true);
  assert.equal(win.localStorage.getItem('a'), '1');
  assert.equal(win.localStorage.getItem('absent'), null);
  assert.equal(win.sessionStorage.getItem('s'), 'true');
  assert.equal(win.localStorage.length, 2);
  assert.equal(win.localStorage.key(1), 'b');
  assert.equal(win.localStorage.key(5), null);
  win.localStorage.removeItem('a');
  assert.equal(win.localStorage.length, 1);
  win.localStorage.clear();
  assert.equal(win.localStorage.length, 0);
  assert.equal(win.sessionStorage.getItem('s'), 'true');
});

test('shim : persistance via window.name entre deux pages', () => {
  const a = fakeWindow();
  a.run();
  a.win.localStorage.setItem('k', 'v');
  a.win.sessionStorage.setItem('t', 'w');
  assert.ok(JSON.parse(a.win.name).__hubStore);
  const b = fakeWindow(a.win.name);
  b.run();
  assert.equal(b.win.localStorage.getItem('k'), 'v');
  assert.equal(b.win.sessionStorage.getItem('t'), 'w');
  assert.equal(b.win.sessionStorage.getItem('k'), null);
});

test('shim : window.name quelconque toléré', () => {
  for (const name of ['garbage', '{"__hubStore":null}', '{"__hubStore":{"l":5}}', 'null']) {
    const { win, run } = fakeWindow(name);
    run();
    assert.equal(win.localStorage.length, 0, name);
    win.localStorage.setItem('a', 'b');
    assert.equal(win.localStorage.getItem('a'), 'b');
  }
});

test('shim : laisse intacts les stockages qui fonctionnent', () => {
  const { win, run } = fakeWindow('', false);
  const real = { marker: 'real' };
  Object.defineProperty(win, 'localStorage', { configurable: true, value: real });
  Object.defineProperty(win, 'sessionStorage', { configurable: true, value: real });
  run();
  assert.equal(win.localStorage, real);
  assert.equal(win.sessionStorage, real);
  assert.equal(win.name, '');
});

test('shim : window.name hostile ne fait jamais lever getItem', () => {
  const hostile = [
    '{"__hubStore":{"l":{"a":{"toString":1}}}}',
    '{"__hubStore":{"l":{"a":1,"b":null,"c":["x"],"d":"ok"},"s":[1,2]}}',
    '{"__hubStore":{"l":null,"s":"str"}}',
    '{"__hubStore":{"l":{"__proto__":"p","constructor":{"x":1},"toString":"t"}}}',
    '{"__hubStore":[]}',
  ];
  for (const name of hostile) {
    const { win, run } = fakeWindow(name);
    run();
    for (const slot of ['localStorage', 'sessionStorage']) {
      for (const k of ['a', 'b', 'c', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) win[slot].getItem(k);
    }
    win.localStorage.setItem('n', 'v');
    assert.equal(win.localStorage.getItem('n'), 'v', name);
  }
  const { win, run } = fakeWindow('{"__hubStore":{"l":{"a":{"toString":1},"d":"ok","e":3}}}');
  run();
  assert.equal(win.localStorage.getItem('a'), null);
  assert.equal(win.localStorage.getItem('e'), null);
  assert.equal(win.localStorage.getItem('d'), 'ok');
  assert.equal(win.localStorage.length, 1);
  const p = fakeWindow('{"__hubStore":{"l":{"__proto__":"p"}}}');
  p.run();
  assert.equal(p.win.localStorage.getItem('__proto__'), 'p');
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('shim : les clés __proto__ écrites par la page restent des données', () => {
  const { win, run } = fakeWindow();
  run();
  win.localStorage.setItem('__proto__', 'x');
  assert.equal(win.localStorage.getItem('__proto__'), 'x');
  assert.equal(win.localStorage.length, 1);
  assert.equal(win.localStorage.getItem('toString'), null);
});

test('injectShim : ignore les commentaires HTML', () => {
  assert.equal(injectShim('<!-- <head> --><html><head></head>'), `<!-- <head> --><html><head>${TAG}</head>`);
  assert.equal(injectShim('<!-- c --><!doctype html><p>x</p>'), `<!-- c --><!doctype html>${TAG}<p>x</p>`);
  assert.equal(injectShim('<!-- <html><head> -->\n<p>x</p>'), `${TAG}<!-- <html><head> -->\n<p>x</p>`);
});
