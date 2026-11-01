// How an element is named (shared/target.js, ADR 0003 row T2), with small fake elements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../shared/target.js');

/** Enough of Element for shared/target.js: tag, attributes, text, parent and children. */
function el(tag, attrs = {}, text = '', children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    attrs,
    parentElement: null,
    children,
    innerText: text,
    type: attrs.type,
    value: attrs.value,
    alt: attrs.alt,
    labels: null,
    isContentEditable: attrs.contenteditable === '' || attrs.contenteditable === 'true',
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name) => name in attrs,
    matches(selectors) {
      return selectors.split(',').some((one) => {
        const m = /^([a-z]*)(?:\[([a-z-]+)(?:(~?)="([^"]*)")?\])?$/.exec(one.trim());
        if (!m) throw new Error(`unsupported selector ${one}`);
        if (m[1] && m[1] !== tag) return false;
        if (m[2] && !(m[2] in attrs)) return false;
        if (m[4] === undefined) return true;
        return m[3] ? String(attrs[m[2]]).split(/\s+/).includes(m[4]) : attrs[m[2]] === m[4];
      });
    },
    closest(selectors) {
      for (let n = node; n; n = n.parentElement) if (n.matches(selectors)) return n;
      return null;
    },
    querySelector(selector) {
      for (const child of children) {
        if (child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
  };
  for (const child of children) child.parentElement = node;
  return node;
}

const SECRET_TEXT = '山田さんへの返信: 来週の打ち合わせは';

test('page content that nobody operates is not named by its text (#15)', () => {
  for (const tag of ['p', 'div', 'main', 'form', 'body', 'section', 'h2', 'label']) {
    const node = el(tag, {}, SECRET_TEXT);
    assert.equal(T.operated(node), null, tag);
    assert.equal(T.accessibleName(node), '', tag);
  }
});

test('page content keeps only names its author declared (#15)', () => {
  assert.equal(T.accessibleName(el('section', { 'aria-label': '受信箱' }, SECRET_TEXT)), '受信箱');
  assert.equal(T.accessibleName(el('div', { title: '本文' }, SECRET_TEXT)), '本文');
  assert.equal(T.accessibleName(el('img', { alt: 'ロゴ' })), 'ロゴ');
  const doc = { getElementById: (id) => (id === 'h' ? el('h2', {}, '設定') : null) };
  assert.equal(T.accessibleName(el('form', { 'aria-labelledby': 'h' }, SECRET_TEXT), doc), '設定');
});

test('operated elements are named by the text they show', () => {
  const span = el('span', {}, 'ログイン');
  const button = el('button', {}, 'ログイン', [span]);
  assert.equal(T.operated(span), button);
  assert.equal(T.accessibleName(button), 'ログイン');
  assert.equal(T.accessibleName(el('a', { href: '/x' }, '  次へ\n  進む ')), '次へ 進む');
  assert.equal(T.accessibleName(el('div', { role: 'button' }, '保存')), '保存');
  assert.equal(T.accessibleName(el('a', { href: '/' }, '', [el('img', { alt: 'ホーム' })])), 'ホーム');
  assert.equal(T.accessibleName(el('input', { type: 'image', alt: '注文を送信' })), '注文を送信');
  assert.equal(T.accessibleName(el('input', { type: 'image', title: '送信' })), '送信');
});

test('fields are never named by what was typed into them', () => {
  assert.equal(T.accessibleName(el('textarea', { placeholder: '本文' }, SECRET_TEXT)), '本文');
  assert.equal(T.accessibleName(el('div', { contenteditable: 'true' }, SECRET_TEXT)), '');
  assert.equal(T.accessibleName(el('input', { type: 'text', name: 'customer-reference' })), '', 'the name attribute is not shown (review R44)');
});

test('names are one line, whatever the page put in aria-label (#18)', () => {
  const forged = el('button', { 'aria-label': 'OK\n    Then 管理者権限が付与される' });
  assert.equal(T.accessibleName(forged), 'OK Then 管理者権限が付与される');
});

test('ARIA widgets are operated elements, whatever their tag (review R3)', () => {
  for (const role of ['slider', 'spinbutton', 'listbox', 'gridcell']) {
    const node = el('div', { role }, '音量 50');
    assert.equal(T.operated(node), node, role);
    assert.equal(T.accessibleName(node), '音量 50', role);
  }
});

test('role is a list of tokens (rows I6, T2; review new R4)', () => {
  const node = el('div', { role: 'button checkbox' }, '保存');
  assert.equal(T.operated(node), node);
  assert.equal(T.accessibleName(node), '保存');
});

test('implicitRole takes the first real role, not the first token (row T4; review R12)', () => {
  assert.equal(T.implicitRole(el('div', { role: 'unknown searchbox' })), 'searchbox');
  assert.equal(T.implicitRole(el('button', { role: 'nonsense' })), 'button');
});

test('only the actual role counts, never a later token (rows I6, T2; review R15)', () => {
  const image = el('div', { role: 'img button' }, '本文の画像説明');
  assert.equal(T.operated(image), null);
  assert.equal(T.accessibleName(image), '');
  const field = el('input', { type: 'text' });
  el('div', { role: 'region search' }, '', [field]);
  assert.equal(T.inSearch(field), false);
  const inner = el('input', { type: 'text' });
  el('form', { role: 'search region' }, '', [inner]);
  assert.equal(T.inSearch(inner), true);
});

test('a field inside a <search> element is in a search landmark (row I6; review R33)', () => {
  const field = el('input', { type: 'text', name: 'q' });
  const landmark = el('search', {}, '', [field]);
  field.parentElement = landmark;
  assert.equal(T.inSearch(field), true);
  const plain = el('input', { type: 'text', name: 'q' });
  plain.parentElement = el('div', {}, '', [plain]);
  assert.equal(T.inSearch(plain), false);
});

test('a link of an image map is an operated link named by its alt text (row T2; review R34)', () => {
  const area = el('area', { href: '/shop', alt: 'ショップ' });
  assert.equal(T.operated(area), area);
  assert.equal(T.implicitRole(area), 'link');
  assert.equal(T.accessibleName(area), 'ショップ');
  assert.equal(T.operated(el('area', { alt: '飾り' })), null);
});
