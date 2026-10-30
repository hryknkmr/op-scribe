// Fixtures use reserved names only (example.com, *.invalid, fictional numbers).
// Secret-shaped strings are assembled at runtime so the repository never holds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');

// ------------------------------------------------------------ the policy

test('credentials are replaced entirely', () => {
  const token = ['gh', 'p_', 'A'.repeat(36)].join('');
  const { text, kinds } = S.scrubText(`card 4111 1111 1111 1111 / ${token} / password=hunter22`);
  assert.equal(text, 'card [[card]] / [[secret]] / password=[[secret]]');
  assert.deepEqual(new Set(kinds), new Set(['card', 'secret']));
});

test('emails, phone numbers and ids stay recognizable but partial', () => {
  const { text, kinds } = S.scrubText('連絡先 someone@mail.example.com / 090-1234-5678 / 会員番号 12345678');
  assert.equal(text, '連絡先 s***@m***.com / ***-****-5678 / 会員番号 12****78');
  assert.deepEqual(new Set(kinds), new Set(['email', 'phone', 'id']));
});

test('partial masks do not trip the final scan', () => {
  const { text } = S.scrubText('someone@example.com 090-1234-5678 12345678 192.168.10.5 0123abcd-0000-4000-8000-1234567890ab');
  assert.deepEqual(S.finalScan({ text }), []);
  assert.match(text, /192\.168\.\*\.\*/);
});

test('ordinary text is kept as typed', () => {
  for (const label of ['ログイン', '週末 レシピ', 'Save draft', '2026-10-29', '3件', 'v1.2.0', '山田さんのページ']) {
    assert.deepEqual(S.scrubText(label), { text: label, kinds: [] }, label);
  }
});

test('a non-Luhn 16 digit run is an id, not a card', () => {
  assert.equal(S.scrubText('1234567812345678').text, '12******78');
});

test('full-width digits are normalized before matching', () => {
  assert.equal(S.scrubText('０９０－１２３４－５６７８').text, '***-****-5678');
});

test('listed words are masked case-insensitively, longest first', () => {
  const { text, kinds } = S.scrubText('Acme Labs の acme チーム', { keywords: ['acme', 'Acme Labs'] });
  assert.equal(text, '[[masked]] の [[masked]] チーム');
  assert.deepEqual(kinds, ['keyword', 'keyword']);
});

test('truncation happens after masking', () => {
  const { text } = S.scrubText('mail: someone@example.com and more text', { maxLength: 12 });
  assert.ok(!text.includes('someone'), text);
});

// ------------------------------------------------------------ form fields

test('classifyField: only credentials are secret; contact fields are partial', () => {
  assert.equal(S.classifyField({ type: 'password' }).kind, 'secret');
  assert.deepEqual(S.classifyField({ autocomplete: 'cc-number' }), { kind: 'secret', label: 'card' });
  assert.deepEqual(S.classifyField({ label: 'セキュリティコード' }), { kind: 'secret', label: 'card' });
  assert.equal(S.classifyField({ type: 'text', label: '認証コード' }).kind, 'secret');
  assert.equal(S.classifyField({ type: 'text', name: 'email' }).kind, 'email');
  assert.equal(S.classifyField({ type: 'text', label: '電話番号' }).kind, 'phone');
  assert.equal(S.classifyField({ type: 'text', label: '氏名' }).kind, 'text');
  assert.equal(S.classifyField({ type: 'hidden' }).kind, 'ignore');
});

test('maskFieldValue keeps typed text, hides credentials, partially hides contact details', () => {
  assert.deepEqual(S.maskFieldValue('週末 レシピ', { type: 'search' }), { value: '週末 レシピ', kinds: [] });
  assert.equal(S.maskFieldValue('hunter2', { type: 'password' }).value, '[[secret]]');
  assert.equal(S.maskFieldValue('4111111111111111', { autocomplete: 'cc-number' }).value, '[[card]]');
  assert.equal(S.maskFieldValue('someone@example.com', { type: 'email' }).value, 's***@e***.com');
  // Not shaped like an address, but typed into an email field: still partially hidden.
  assert.equal(S.maskFieldValue('someone', { type: 'email' }).value, 's*****e');
  assert.equal(S.maskFieldValue('Taro Yamada', { name: 'full_name' }).value, 'Taro Yamada');
});

test('maskArgs decides by key first, so numeric credentials are hidden too', () => {
  const out = S.maskArgs({ query: 'shoes', otp: 123456, pin: 1234, email: 'a@example.com', count: 3, nested: { phone: '0312345678' } });
  assert.deepEqual(out, { query: 'shoes', otp: '[[secret]]', pin: '[[secret]]', email: 'a***@e***.com', count: 3, nested: { phone: '******5678' } });
});

// -------------------------------------------------------------------- URLs

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

test('scrubUrl partially hides ids and handles, keeps ordinary params, hides credential params', () => {
  const { url } = S.scrubUrl(
    'https://example.com/users/@someone/orders/123456?tab=items&q=週末&token=abcdef&mail=someone@example.com#section',
    { hostAllowlist: ['example.com'] }
  );
  assert.equal(url, 'https://example.com/users/@s*****e/orders/12**56?tab=items&q=%E9%80%B1%E6%9C%AB&token=[[secret]]&mail=s***%40e***.com#section');
});

test('scrubUrl checks fragments for listed words and ids', () => {
  const { url } = S.scrubUrl('https://example.com/app#/projects/AcmeSecret/123456', { hostAllowlist: ['example.com'], keywords: ['AcmeSecret'] });
  assert.equal(url, 'https://example.com/app#/projects/[[masked]]/12**56');
});

test('scrubUrl drops credentials embedded in the URL', () => {
  const { url } = S.scrubUrl('https://name:pw@example.com/', { hostAllowlist: ['example.com'] });
  assert.equal(url, 'https://example.com/');
});

// ------------------------------------------------------------- final gate

test('finalScan reports leftovers with their path', () => {
  const findings = S.finalScan({
    steps: [{ value: '[[secret]]' }, { target: { name: 'Contact someone@example.com' } }],
    markdown: '# 手順\n1. Acme にログインする'
  }, { keywords: ['Acme'] });
  assert.deepEqual(findings, [
    { path: 'steps[1].target.name', kinds: ['email'] },
    { path: 'markdown', kinds: ['keyword'] }
  ]);
});

test('finalScan cannot be bypassed by text dressed up as a placeholder', () => {
  for (const spoof of ['[[x:Acme]]', '[[note:Acme Labs]]', '[[masked]]Acme']) {
    assert.deepEqual(S.finalScan({ name: spoof }, { keywords: ['Acme'] }).map((f) => f.kinds), [['keyword']], spoof);
  }
  assert.deepEqual(S.finalScan({ name: '[[secret]] [[card]] [[masked]]' }, { keywords: ['Acme'] }), []);
});

test('URLs written in text follow the URL policy when the recording hosts are given', () => {
  const hosts = { hostAllowlist: ['example.com'], aliases: {} };
  const r = S.scrubText('詳しくは https://docs.internal.test/orders/1234567 を見てください。https://example.com/help も。', { hosts });
  assert.equal(r.text, '詳しくは https://site-1.invalid/orders/12***67 を見てください。https://example.com/help も。');
  assert.deepEqual(hosts.aliases, { 'https://docs.internal.test': 'site-1.invalid' });
  assert.ok(r.kinds.includes('host'));
  // The same host is given the same alias, and a trailing period stays outside the URL.
  assert.equal(S.scrubText('再掲: HTTPS://docs.internal.test/a.', { hosts }).text, '再掲: https://site-1.invalid/a.');
  // Scheme-relative URLs too, under the same alias; a path with // inside is not a URL.
  assert.equal(S.scrubText('通知: //docs.internal.test/orders/1234567 を開く', { hosts }).text, '通知: //site-1.invalid/orders/12***67 を開く');
  assert.equal(S.scrubText('a/b//c と 1//2', { hosts }).text, 'a/b//c と 1//2');
  // Without the hosts (in the page), text is left to the worker, which knows them.
  assert.equal(S.scrubText('https://docs.internal.test/a').text, 'https://docs.internal.test/a');
});

test('a URL nested in a URL follows the same host policy and its aliases reach the final scan', () => {
  const ctx = { hostAllowlist: ['example.com'], aliases: {}, keywords: [] };
  const query = S.scrubUrl('https://example.com/go?next=https%3A%2F%2Fprivate.internal.test%2Forders%2F1234567', ctx).url;
  assert.ok(!query.includes('private.internal.test'), query);
  assert.match(decodeURIComponent(query), /next=https:\/\/site-1\.invalid\/orders\/12\*\*\*67/);
  const path = S.scrubUrl('https://example.com/go/https%3A%2F%2Fprivate.internal.test%2Fa', ctx).url;
  assert.ok(!decodeURIComponent(path).includes('private.internal.test'), path);
  const hash = S.scrubUrl('https://example.com/#/redirect/https://private.internal.test/b', ctx).url;
  assert.equal(hash, 'https://example.com/#/redirect/https://site-1.invalid/b');
  assert.deepEqual(ctx.aliases, { 'https://private.internal.test': 'site-1.invalid' });
  // The real host is known now, so the final scan stops it wherever else it appears.
  assert.equal(S.finalScan({ note: 'private.internal.test' }, { keywords: ['private.internal.test'] }).length, 1);
});
