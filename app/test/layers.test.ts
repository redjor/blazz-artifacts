import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleLayerKeyDown } from '../web/src/layers.ts';

function focusable(name: string, onFocus: (name: string) => void): HTMLElement {
  return {
    tabIndex: 0,
    getClientRects: () => [{}] as unknown as DOMRectList,
    closest: () => null,
    focus: () => onFocus(name),
  } as unknown as HTMLElement;
}

function modalAndPopover() {
  let focused = '';
  const first = focusable('first', (name) => { focused = name; });
  const last = focusable('last', (name) => { focused = name; });
  const modal = {
    querySelectorAll: () => [first, last],
    contains: (target: Node | null) => target === first || target === last,
  } as unknown as HTMLElement;
  const layers = [
    { modal: true, el: { current: modal }, onEscape() {} },
    { modal: false, el: { current: null }, onEscape() {} },
  ];
  return { first, last, focused: () => focused, layers };
}

function keyEvent(key: string, shiftKey = false) {
  let prevented = false;
  const event = {
    key,
    shiftKey,
    defaultPrevented: false,
    preventDefault() { prevented = true; },
  } as unknown as KeyboardEvent;
  return { event, prevented: () => prevented };
}

test('Tab at the end of a modal wraps to its start when a nonmodal layer is on top', () => {
  const { first, last, focused, layers } = modalAndPopover();
  const { event, prevented } = keyEvent('Tab');

  handleLayerKeyDown(event, layers, last);

  assert.equal(prevented(), true);
  assert.equal(focused(), 'first');
});

test('Shift+Tab at the start of a modal wraps to its end when a nonmodal layer is on top', () => {
  const { first, last, focused, layers } = modalAndPopover();
  const { event, prevented } = keyEvent('Tab', true);

  handleLayerKeyDown(event, layers, first);

  assert.equal(prevented(), true);
  assert.equal(focused(), 'last');
});

test('Escape still closes the top nonmodal layer', () => {
  let topClosed = false;
  const layers = [
    { modal: true, el: { current: null }, onEscape() {} },
    { modal: false, el: { current: null }, onEscape() { topClosed = true; } },
  ];
  const { event, prevented } = keyEvent('Escape');

  handleLayerKeyDown(event, layers, null);

  assert.equal(prevented(), true);
  assert.equal(topClosed, true);
});
