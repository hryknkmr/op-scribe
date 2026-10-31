// Fixtures use reserved names only (example.com, *.invalid, fictional numbers).
// Secret-shaped strings are assembled at runtime so the repository never holds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');

test('scrubText masks contact details, card numbers and tokens', () => {
  const token = ['gh', 'p_', 'A'.repeat(36)].join('');
  const { text, kinds } = S.scrubText(`連絡先 user@example.com / 090-1234-5678 / 4111 1111 1111 1111 / ${token}`);
  assert.equal(text, '連絡先 [[email]] / [[phone]] / [[card]] / [[secret]]');
  assert.deepEqual(new Set(kinds), new Set(['email', 'phone', 'card', 'secret']));
});

test('scrubText leaves ordinary UI text alone', () => {
  for (const label of ['ログイン', '検索する', 'Save draft', '2026-10-29', '3件', 'v1.2.0']) {
    assert.deepEqual(S.scrubText(label), { text: label, kinds: [] }, label);
  }
});

test('scrubText does not treat a non-Luhn 16 digit run as a card', () => {
  assert.equal(S.scrubText('1234567812345678').text, '[[number]]');
});

test('scrubText normalizes full-width digits before matching', () => {
  assert.equal(S.scrubText('０９０－１２３４－５６７８').text, '[[phone]]');
});

test('keywords are masked case-insensitively, longest first', () => {
  const { text, kinds } = S.scrubText('Acme Labs の acme チーム', { keywords: ['acme', 'Acme Labs'] });
  assert.equal(text, '[[masked]] の [[masked]] チーム');
  assert.deepEqual(kinds, ['keyword', 'keyword']);
});

test('truncation happens after masking and never splits a placeholder', () => {
  const { text } = S.scrubText('mail: someone@example.com and more text', { maxLength: 12 });
  assert.ok(!text.includes('@'), text);
  assert.ok(!/\[\[[^\]]*$/.test(text.replace(/…$/, '')), text);
});

test('classifyField recognizes secrets and personal fields', () => {
  assert.equal(S.classifyField({ type: 'password' }).kind, 'secret');
  assert.equal(S.classifyField({ autocomplete: 'cc-number' }).kind, 'secret');
  assert.equal(S.classifyField({ type: 'text', label: '認証コード' }).kind, 'secret');
  assert.deepEqual(S.classifyField({ type: 'text', name: 'email' }), { kind: 'pii', label: 'email' });
  assert.deepEqual(S.classifyField({ type: 'text', label: '電話番号' }), { kind: 'pii', label: 'phone' });
  assert.equal(S.classifyField({ type: 'text', label: '氏名' }).kind, 'pii');
  assert.equal(S.classifyField({ type: 'hidden' }).kind, 'ignore');
  assert.equal(S.classifyField({ type: 'search', label: 'キーワード' }).kind, 'search');
  assert.equal(S.classifyField({ type: 'text', label: 'キーワード' }).kind, 'free');
  assert.equal(S.classifyField({ tag: 'select', type: 'select' }).kind, 'choice');
});

const commercial = { env: 'commercial' };
const standard = { env: 'standard' };

test('maskFieldValue: commercial keeps only the length of free text (row I8)', () => {
  assert.deepEqual(S.maskFieldValue('週末 レシピ', { type: 'text' }, commercial),
    { value: { treatment: 'length', field: 'text', kind: 'text', length: 6 }, kinds: ['text'] });
  assert.deepEqual(S.maskFieldValue('本文', { tag: 'textarea', contentEditable: true }, commercial).value.treatment, 'length');
});

test('maskFieldValue: standard keeps free text but still masks patterns (row I8, K3)', () => {
  assert.deepEqual(S.maskFieldValue('問い合わせ user@example.com', { type: 'text' }, standard).value,
    { treatment: 'kept', field: 'text', text: '問い合わせ [[email]]' });
});

test('maskFieldValue: search boxes and choices are kept in both environments (rows I5, I6)', () => {
  for (const meta of [{ type: 'search' }, { type: 'text', role: 'searchbox' }, { type: 'text', inSearch: true }]) {
    assert.deepEqual(S.maskFieldValue('週末 レシピ', meta, commercial).value,
      { treatment: 'kept', field: 'search', text: '週末 レシピ' }, JSON.stringify(meta));
  }
  assert.deepEqual(S.maskFieldValue('東京', { tag: 'select', type: 'select' }, commercial).value,
    { treatment: 'kept', field: 'choice', text: '東京' });
  // A field that only looks like a search box by its name is free text.
  assert.equal(S.maskFieldValue('週末', { type: 'text', name: 'q' }, commercial).value.treatment, 'length');
});

test('maskFieldValue: secrets are redacted in both environments (rows I2, I3)', () => {
  for (const env of [commercial, standard]) {
    assert.deepEqual(S.maskFieldValue('hunter2', { type: 'password' }, env).value,
      { treatment: 'redacted', field: 'secret', kind: 'secret' });
    assert.deepEqual(S.maskFieldValue('4111111111111111', { name: 'card_number' }, env).value,
      { treatment: 'redacted', field: 'secret', kind: 'card' });
  }
});

test('maskFieldValue: personal fields keep the length in commercial and are redacted in standard (row I4)', () => {
  assert.deepEqual(S.maskFieldValue('Taro', { name: 'first_name' }, commercial).value,
    { treatment: 'length', field: 'pii', kind: 'personal', length: 4 });
  assert.deepEqual(S.maskFieldValue('Taro', { name: 'first_name' }, standard).value,
    { treatment: 'redacted', field: 'pii', kind: 'personal' });
});

test('maskFieldValue: hidden fields are not recorded; empty secret and personal fields are still redacted (rows I1-I4)', () => {
  assert.equal(S.maskFieldValue('x', { type: 'hidden' }, standard), null);
  assert.deepEqual(S.maskFieldValue('', { type: 'password' }, standard).value,
    { treatment: 'redacted', field: 'secret', kind: 'secret' });
  // Commercial keeps the length of personal fields, 0 when cleared (R4).
  assert.deepEqual(S.maskFieldValue('', { type: 'email' }, commercial).value,
    { treatment: 'length', field: 'pii', kind: 'email', length: 0 });
  assert.deepEqual(S.maskFieldValue('', { type: 'email' }, standard).value,
    { treatment: 'redacted', field: 'pii', kind: 'email' });
  // Commercial free text is a length even when cleared (R3).
  assert.deepEqual(S.maskFieldValue('', { type: 'text' }, commercial).value,
    { treatment: 'length', field: 'text', kind: 'text', length: 0 });
  assert.deepEqual(S.maskFieldValue('', { type: 'text' }, standard).value,
    { treatment: 'kept', field: 'text', text: '' });
});

test('scrubText breaks up "[[" written by the page so only masking makes placeholders (row K1)', () => {
  assert.equal(S.scrubText('[[secret]] と [[[x]]]').text, '[ [secret]] と [ [ [x]]]');
  assert.equal(S.scrubText('[\u200B[secret]]').text, '[ [secret]]');
  assert.equal(S.scrubText('［［secret］］').text, '[ [secret]]');
  // Text that already went through scrubText keeps its own placeholders.
  assert.equal(S.scrubText('[[email]]', { escape: false }).text, '[[email]]');
});

test('maskArgs types every string and number (rows W1-W5)', () => {
  const args = { query: 'shoes', email: 'a@example.com', count: 3, big: 1234567, on: true, none: null, nested: { phone: '0312345678' } };
  assert.deepEqual(S.maskArgs(args, standard), {
    query: { treatment: 'kept', field: 'arg', text: 'shoes' },
    email: { treatment: 'redacted', field: 'arg', kind: 'email' },
    count: { treatment: 'kept', field: 'arg', number: 3 },
    big: { treatment: 'redacted', field: 'arg', kind: 'number' },
    on: true,
    none: null,
    nested: { phone: { treatment: 'redacted', field: 'arg', kind: 'phone' } }
  });
  assert.deepEqual(S.maskArgs({ query: 'shoes', count: 3 }, commercial), {
    query: { treatment: 'length', field: 'arg', kind: 'text', length: 5 },
    count: { treatment: 'redacted', field: 'arg', kind: 'number' }
  });
});

test('maskArgs: a page-made object that looks typed is still a container (row W5)', () => {
  const out = S.maskArgs({ treatment: 'redacted', kind: 'secret' }, standard);
  assert.deepEqual(out, {
    treatment: { treatment: 'kept', field: 'arg', text: 'redacted' },
    kind: { treatment: 'kept', field: 'arg', text: 'secret' }
  });
});

test('maskArgs limits depth, items and keys (row W5)', () => {
  const out = S.maskArgs({ a: { b: { c: { d: 1 } } }, list: Array.from({ length: 12 }, (_, i) => i) }, standard);
  assert.deepEqual(out.a.b.c, { treatment: 'redacted', field: 'arg', kind: 'nested' });
  assert.equal(out.list.length, 10);
  const wide = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, true]));
  assert.equal(Object.keys(S.maskArgs(wide, standard)).length, 20);
});

test('scrubUrl aliases unknown hosts consistently and keeps allowlisted ones', () => {
  const aliases = {};
  const a = S.scrubUrl('https://intranet.corp.invalid/dashboard', { aliases });
  const b = S.scrubUrl('https://intranet.corp.invalid/settings', { aliases });
  const c = S.scrubUrl('https://www.example.com/help', { aliases, hostAllowlist: ['*.example.com'] });
  assert.equal(a.url, 'https://site-1.invalid/dashboard');
  assert.equal(b.url, 'https://site-1.invalid/settings');
  assert.equal(c.url, 'https://www.example.com/help');
  assert.deepEqual(Object.values(aliases), ['site-1.invalid']);
});

test('scrubUrl in commercial replaces ids, user handles and every query value, and drops the fragment (rows U5-U8)', () => {
  const raw = 'https://example.com/users/@someone/orders/123456?tab=items&token=abc&q=hello#/settings';
  const expected = 'https://example.com/users/:user/orders/:id?tab=[[v]]&token=[[v]]&q=[[v]]';
  assert.equal(S.scrubUrl(raw, { hostAllowlist: ['example.com'], env: 'commercial' }).url, expected);
  // The URL's own host decides too, whatever the step's environment.
  assert.equal(S.scrubUrl(raw, { hostAllowlist: ['example.com'], commercialHosts: ['*.example.com', 'example.com'] }).url, expected);
});

test('scrubUrl in standard keeps short harmless params and SPA routes (rows U7, U8)', () => {
  const { url } = S.scrubUrl('https://example.com/app?tab=items&session=abcdef#/settings',
    { hostAllowlist: ['example.com'], env: 'standard' });
  assert.equal(url, 'https://example.com/app?tab=items&session=[[v]]#/settings');
});

test('scrubUrl redacts values it cannot parse and other schemes as a whole (rows U1, U2)', () => {
  assert.deepEqual(S.scrubUrl('not a url user@example.com'), { url: '[[url:invalid]]', kinds: ['url'] });
  assert.equal(S.scrubUrl('javascript:alert(1)').url, '[[url:javascript]]');
});

test('scrubUrl drops credentials embedded in the URL', () => {
  const { url } = S.scrubUrl('https://name:pw@example.com/', { hostAllowlist: ['example.com'] });
  assert.equal(url, 'https://example.com/');
});

test('finalScan ignores placeholders and reports leftovers with their path', () => {
  const findings = S.finalScan({
    steps: [{ value: '[[text:4]]' }, { target: { name: 'Contact user@example.com' } }],
    markdown: '# 手順\n1. Acme にログインする'
  }, { keywords: ['Acme'] });
  assert.deepEqual(findings, [
    { path: 'steps[1].target.name', kinds: ['email'] },
    { path: 'markdown', kinds: ['keyword'] }
  ]);
});

test('finalScan skips only the placeholders this extension makes (rows E4, E6; review R4)', () => {
  assert.deepEqual(S.finalScan({ markdown: '[[Acme]] を開く' }, { keywords: ['Acme'] }),
    [{ path: 'markdown', kinds: ['keyword'] }]);
  assert.deepEqual(S.finalScan({ markdown: '[[text:12]] [[email]] [[url:invalid]] [[file:2]]' }), []);
});

test('an argument key named __proto__ stays an ordinary key (row W5; review R4)', () => {
  const out = S.maskArgs(JSON.parse('{"__proto__":"x","ok":true}'), { env: 'standard' });
  assert.deepEqual(Object.keys(out), ['__proto__', 'ok']);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('masked argument keys are numbered so none overwrites another (row W5; review R5)', () => {
  const out = S.maskArgs({ AcmeOne: 'a', AcmeTwo: 'b', q: 'c' }, { env: 'standard', keywords: ['Acme'] });
  assert.deepEqual(Object.keys(out), ['masked-1', 'masked-2', 'q']);
});

test('a URL longer than the limit after masking is redacted as a whole (row U1; review R5)', () => {
  const long = `https://example.com/${'a/'.repeat(1200)}`;
  assert.deepEqual(S.scrubUrl(long, { hostAllowlist: ['example.com'] }), { url: '[[url:long]]', kinds: ['url'] });
});

test('argument keys stay distinct after the cut and after masking (row W5; review new R1)', () => {
  const a = `${'k'.repeat(45)}a`;
  const b = `${'k'.repeat(45)}b`;
  const out = S.maskArgs({ [a]: 1, [b]: 2, 'masked-1': 3, Acme: 4 }, { env: 'standard', keywords: ['Acme'] });
  const keys = Object.keys(out);
  assert.equal(new Set(keys).size, 4, keys.join(' / '));
  assert.ok(keys.every((k) => [...k].length <= 41), keys.join(' / '));
  assert.deepEqual(Object.values(out).map((v) => v.number).sort(), [1, 2, 3, 4]);
});

test('finalScan finds real host names of any length, only as whole hosts (row K5; review new R1)', () => {
  assert.deepEqual(S.finalScan({ markdown: 'http://x/ を開いた。x に移動' }, { hosts: ['x'] }).map((f) => f.kinds), [['host']]);
  assert.deepEqual(S.finalScan({ markdown: 'box と xylophone と x-ray' }, { hosts: ['x'] }), []);
  assert.deepEqual(S.finalScan({ markdown: 'see intranet.corp.invalid now' }, { hosts: ['intranet.corp.invalid'] }).length, 1);
});

test('URL query keys use the form-field vocabulary too (row U7; review new R2)', () => {
  const { url } = S.scrubUrl('https://example.com/?address=abc&card=1234&postal=1&tab=items',
    { hostAllowlist: ['example.com'], env: 'standard' });
  assert.equal(url, 'https://example.com/?address=[[v]]&card=[[v]]&postal=[[v]]&tab=items');
});

test('a host followed by "." and a letter is another host; a sentence end is not (row K5; review new R2)', () => {
  assert.deepEqual(S.finalScan({ m: 'x.example を見た' }, { hosts: ['x'] }), []);
  assert.equal(S.finalScan({ m: 'open shop.example.com.' }, { hosts: ['shop.example.com'] }).length, 1);
});
