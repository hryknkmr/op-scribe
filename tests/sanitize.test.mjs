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
  assert.equal(S.classifyField({ type: 'search', label: 'キーワード' }).kind, 'free');
  assert.equal(S.classifyField({ tag: 'select', type: 'select' }).kind, 'choice');
});

test('maskFieldValue: strict keeps only the length of free text', () => {
  assert.deepEqual(S.maskFieldValue('週末 レシピ', { type: 'search' }, { privacyLevel: 'strict' }),
    { value: '[[text:6]]', kinds: ['text'] });
});

test('maskFieldValue: balanced keeps free text but still masks patterns', () => {
  assert.equal(S.maskFieldValue('問い合わせ user@example.com', { type: 'text' }, { privacyLevel: 'balanced' }).value,
    '問い合わせ [[email]]');
});

test('maskFieldValue: personal fields are masked even in balanced mode', () => {
  assert.equal(S.maskFieldValue('Taro', { name: 'first_name' }, { privacyLevel: 'balanced' }).value, '[[personal]]');
  assert.equal(S.maskFieldValue('hunter2', { type: 'password' }, { privacyLevel: 'balanced' }).value, '[[secret]]');
});

test('maskArgs masks strings by key and value', () => {
  const out = S.maskArgs({ query: 'shoes', email: 'a@example.com', count: 3, nested: { phone: '0312345678' } },
    { privacyLevel: 'balanced' });
  assert.deepEqual(out, { query: 'shoes', email: '[[email]]', count: 3, nested: { phone: '[[phone]]' } });
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

test('scrubUrl replaces ids, user handles and query values', () => {
  const { url } = S.scrubUrl(
    'https://example.com/users/@someone/orders/123456?tab=items&token=abc&q=hello#section',
    { hostAllowlist: ['example.com'] }
  );
  assert.equal(url, 'https://example.com/users/:user/orders/:id?tab=[[v]]&token=[[v]]&q=[[v]]');
});

test('scrubUrl balanced keeps short harmless params and SPA routes', () => {
  const { url } = S.scrubUrl('https://example.com/app?tab=items&session=abcdef#/settings',
    { hostAllowlist: ['example.com'], privacyLevel: 'balanced' });
  assert.equal(url, 'https://example.com/app?tab=items&session=[[v]]#/settings');
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
