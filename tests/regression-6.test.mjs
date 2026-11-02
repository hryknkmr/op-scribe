// What PR #6 protected, kept as the fixed examples of ADR 0003 (the review scale calls a regression here
// HIGH on any row). #6 wrote partial masks into strings; ADR 0002 dropped that form, so these check the
// protection (the value does not survive), not #6's output. See #14 for how the 79 tests were carried over.
// Fixtures use reserved names only. Secret-shaped strings are assembled at runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');

const text = (input, opts) => S.renderRuns(S.scrubText(input, opts).runs);
const url = (raw, keywords) => S.renderRuns(S.scrubUrl(raw, { hostAllowlist: ['example.com'], keywords }).url);
const BASIC = ['Basic ', 'dXNl', 'cjpw', 'YXNz'].join('');

test('credentials written as key and value are hidden, at any length and quoted whole', () => {
  for (const [input, output] of [['password=x', 'password=[[secret]]'], ['pin=12', 'pin=[[secret]]'], ['otp=123456', 'otp=[[secret]]'],
    ['cvv=123', 'cvv=[[secret]]'], ['session=abcd', 'session=[[secret]]'], ['2fa=123456', '2fa=[[secret]]'],
    ['backup code: ABCDEF', 'backup code: [[secret]]'], ['{"pin":"1234"}', '{"pin":"[[secret]]"}'],
    ['client_secret=abc', 'client_secret=[[secret]]'], ['access_token=abc', 'access_token=[[secret]]'],
    ['password="hunter 2"', 'password="[[secret]]"'], ['x=1&token=abc', 'x=1&token=[[secret]]'], ['password="hunter', 'password="[[secret]]'],
    ['{"password":"abc\\"suffix","q":"x"}', '{"password":"[[secret]]","q":"x"}'], ['auth_key=ABCD-EFGH', 'auth_key=[[secret]]'],
    ['ログイン後の認証コード: 123456', 'ログイン後の認証コード: [[secret]]']]) {
    assert.equal(text(input), output, input);
    assert.equal(S.finalScan({ t: input }).length, 1, input);
  }
  for (const kept of ['note: hello world', 'state=open', 'credit: available', '注意: これは例です', '時間: 10:30']) assert.equal(text(kept), kept);
});

test('Basic and Bearer values are hidden, the words in a sentence are not', () => {
  for (const t of [`Authorization: ${BASIC}`, ['Basic ', 'YT', 'pi'].join(''), ['basic ', 'YT', 'pi'].join(''), 'Bearer abc123']) {
    assert.ok(text(t).endsWith('[[secret]]'), t);
  }
  for (const kept of ['Basic auth を使う', 'Basic authentication', 'Bearer of the card', 'Bearer certificate', 'Bearer 2 wins', 'Bearer McCloud entered', 'Basic JavaScript tutorial']) assert.equal(text(kept), kept);
});

test('cards with any one separator, national ids and phone numbers in common notations', () => {
  for (const sep of [' ', '.', '-', '*', '_', '/', '\t']) {
    const t = ['4111', '1111', '1111', '1111'].join(sep);
    assert.equal(text(t), '[[card]]', JSON.stringify(t));
    assert.equal(S.finalScan({ t }).length, 1, JSON.stringify(t));
  }
  assert.equal(text('123-45-6789'), '[[secret]]');
  for (const t of ['(415) 555-2671', '415-555-2671', '03 1234 5678', '(03) 1234-5678', '415.555.2671', '+1.415.555.2671', '０９０－１２３４－５６７８']) {
    assert.equal(text(t), '[[phone]]', t);
  }
  for (const kept of ['2026-10-31', '1 000 000 円', 'v1.2.0', '3件', 'build 2026.1234.5678 completed']) assert.equal(text(kept), kept);
});

test('digits of any script and every dash are read as ASCII before the rules (ADR 0003, normalization)', () => {
  for (const t of ['٠٩٠١٢٣٤٥٦٧٨', '०९०१२३४५६७८', '090–1234–5678', '090—1234—5678']) {
    assert.equal(text(t), '[[phone]]', t);
    assert.equal(S.finalScan({ t }).length, 1, t);
  }
});

test('IPv6 addresses are hidden whole, times and scope operators are not', () => {
  for (const t of ['fd00::1', '2001:db8:0:0:0:0:0:1', '2001:db8:1:2:3:4:192.0.2.33', '::ffff:192.0.2.1']) {
    assert.equal(text(t), '[[ip]]', t);
    assert.equal(S.finalScan({ t }).length, 1, t);
  }
  for (const kept of ['10:30:00 に開始', 'std::vector', 'Note:: 備考', 'a :: b']) assert.equal(text(kept), kept);
});

test('addresses in any letters and domain literals are one address; a package version is not', () => {
  for (const t of ['太郎@例え.テスト', '太郎@社内', '名taro@example.com', 'other@[IPv6:2001:db8::1]', 'someone@[192.168.1.1]',
    '"john doe"@example.com', '"john\\"doe"@example.com', 'verysecret*tag@example.com', "o'neil@example.com"]) {
    assert.equal(text(t), '[[email]]', t);
  }
  assert.equal(text('react@18 @handle'), 'react@18 @handle');
  assert.equal(text('担当は@tanakaです'), '担当は@tanakaです');
});

test('fields named as credentials and card data are secret, in any spelling', () => {
  const secret = ['verification_code', 'verificationCode1', 'verificationcode', 'sms-code', 'pin_code', 'api_key', 'accessKey', 'private_key',
    '_csrf', 'auth_key', 'recovery_key', 'ssn', 'social_security_number', 'マイナンバー', 'session', 'session_id', 'session_key', 'sid',
    'Recovery code', 'newpassword', 'userpass', 'otp1', 'o​tp', 'to⁦ken'];
  for (const name of secret) assert.equal(S.classifyField({ name }).kind, 'secret', name);
  for (const label of ['Verification code', 'API key', 'APIキー', 'トークン', '秘密鍵', 'PINコード', 'OTPコード', 'TOTPコード', 'SMSコード', 'ログインコード']) {
    assert.equal(S.classifyField({ label }).kind, 'secret', label);
  }
  for (const name of ['exp_month', 'card_exp_year', 'cvv2', 'cvc2', 'cid', 'cvn', 'cv2', 'cav2', 'cardVerificationValue', 'securitycode', 'cardholder', 'credit_card']) {
    const c = S.classifyField({ name });
    assert.equal(c.kind, 'secret', name);
  }
  assert.equal(S.classifyField({ label: 'セキュリティコード' }).kind, 'secret');
});

test('fields named as ids are personal, before the choices and the search box (I4 first)', () => {
  for (const name of ['user_id', 'orderID', 'order_number', 'iban', 'account_number']) assert.equal(S.classifyField({ name }).kind, 'pii', name);
  // The stricter list wins: pass in a name is secret.
  assert.equal(S.classifyField({ name: 'passport' }).kind, 'secret');
  for (const label of ['ユーザーID', 'ログインID', '会員番号']) assert.equal(S.classifyField({ label }).kind, 'pii', label);
  assert.equal(S.classifyField({ tag: 'select', type: 'select', name: 'user_id' }).kind, 'pii');
  // A credential or card name beats the chosen option.
  for (const name of ['otp', 'session', 'session_id', 'sid']) assert.equal(S.classifyField({ tag: 'select', type: 'select', name }).kind, 'secret', name);
  assert.equal(S.classifyField({ tag: 'select', type: 'select', name: 'exp_month' }).kind, 'secret');
  assert.equal(S.classifyField({ type: 'search', name: 'user_id' }).kind, 'pii');
});

test('WebMCP arguments use the same names, and the protocol words of a key', () => {
  const out = S.maskArgs({ _csrf: 'short-secret', credential: 'x', apiKey: 'y', bearer: 'z', authorization: BASIC, user_id: 'abc123', code: 'abc', q: 'shoes' });
  for (const key of ['_csrf', 'credential', 'apiKey', 'bearer', 'authorization', 'user_id', 'code']) assert.equal(out[key].treatment, 'redacted', key);
  assert.equal(out.q.treatment, 'kept');
});

test('a key that is an own name of Object.prototype is an ordinary key', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) assert.equal(S.classifyKey(name), null, name);
});

test('URL parameters use the same names, with their keys decoded', () => {
  for (const raw of ['https://example.com/?credential=shortSecret', 'https://example.com/?bearer=shortSecret', 'https://example.com/?%2574oken=Abc123',
    'https://example.com/?%252574oken=Abc123', 'https://example.com/?api_key=short']) {
    assert.ok(url(raw).endsWith('=[[v]]'), raw);
  }
  assert.equal(url('https://example.com/?q=shoes&tab=items'), 'https://example.com/?q=shoes&tab=items');
});

test('an id inside a path segment, and a fragment route with anything to hide is dropped (U8)', () => {
  for (const [raw, out] of [['/orders/123456.json', '/orders/[[id]]'], ['/orders/order-123456', '/orders/[[id]]'], ['/orders/123456;view=full', '/orders/[[id]]'],
    ['/#/orders/123456/x', '/'], ['/#/settings', '/#/settings'], ['/blog/v1.2/intro', '/blog/v1.2/intro']]) {
    assert.equal(url(`https://example.com${raw}`), `https://example.com${out}`, raw);
  }
  assert.equal(url('https://example.com/app#/projects/AcmeSecret/x', ['AcmeSecret']), 'https://example.com/app');
});

test('a URL inside a URL is hidden, however it is written or encoded', () => {
  const inner = 'https://private.internal.test/';
  for (const raw of [`https://example.com/go/${encodeURIComponent(inner)}a`, 'https://example.com/redirect//private.internal.test/login',
    `https://example.com/a/${encodeURIComponent(encodeURIComponent(encodeURIComponent(encodeURIComponent(inner))))}`,
    'https://example.com/#/redirect//private/login']) {
    assert.ok(!url(raw).includes('private'), raw);
  }
});

test('a URL written in a text is hidden whole, in any form (K4)', () => {
  for (const t of ['https://docs.internal.test/orders/1234567', 'HTTPS://docs.internal.test/a', 'ftp://private.internal.test/a', 'file://private.internal.test/share',
    '//docs.internal.test/a', '//intranet/a', '//localhost:8080/a', 'https:private.internal.test/a', 'https:\\\\private.internal.test\\help',
    '//internal_host.test/help', 'data:text/plain,x', 'javascript:alert(1)', './callback?code=abc123', '../orders/123456', 'callback?code=abc123', '?code=abc123', '/orders/123456']) {
    assert.equal(text(t), '[[masked]]', t);
  }
  assert.equal(text('詳しくは https://docs.internal.test/a を見る。'), '詳しくは [[masked]] を見る。');
  assert.equal(text('See https://example.com, then continue.'), 'See [[masked]], then continue.');
  for (const kept of ['a/b//c と 1//2', '/search?q=shoes', '東京/大阪', '10/31', 'v1.2', 'file.txt', 'メモ: 確認済み', 'data: 123']) assert.equal(text(kept), kept);
});

test('the exit stops URLs in a text, and passes the URLs of a recording', () => {
  for (const t of ['ftp://private.internal.test/a', 'file://x.test/a', 'data:text/plain,x', 'javascript:alert(1)', 'see /orders/123456 now', '?code=abc123', './callback?code=abc123',
    '../orders/123456', 'https:private.internal.test/a', 'see //internal_host.test/help', 'https://example.com/callback?code=abc123', 'https://example.com/?id=abc123', 'https://example.com/?phone=1234']) {
    assert.equal(S.finalScan({ t }).length, 1, t);
  }
  const { url } = S.scrubUrl('https://example.com/orders/123456?q=shoes&token=abc#/settings', { hostAllowlist: ['example.com'] });
  assert.deepEqual(S.finalScan({ url }), []);
  assert.deepEqual(S.finalScan({ t: 'https://site-1.invalid/a?tab=x' }), []);
});

test('in commercial only short plain path segments stay (U5)', () => {
  const ctx = { hostAllowlist: ['www.example.com'], commercialHosts: ['www.example.com'] };
  const out = (raw) => S.renderRuns(S.scrubUrl(raw, ctx).url);
  assert.equal(out('https://www.example.com/items/ランニング/abc'), 'https://www.example.com/items/[[v]]/abc');
  assert.equal(out(`https://www.example.com/${'z'.repeat(25)}/b`), 'https://www.example.com/[[v]]/b');
  assert.equal(S.renderRuns(S.scrubUrl('https://other.example.com/ランニング', { hostAllowlist: ['other.example.com'] }).url), 'https://other.example.com/%E3%83%A9%E3%83%B3%E3%83%8B%E3%83%B3%E3%82%B0');
});

test('ordinary words are not read as credentials, and never hide one', () => {
  for (const name of ['compass', 'bypass', 'secretary', 'tokenizer', 'cardinality', 'discard', 'postcard', 'headphones']) {
    assert.equal(S.classifyField({ name }).kind, 'free', name);
  }
  for (const name of ['bypass_password', 'bypass_code', 'compass_token', 'postcard_secret']) assert.equal(S.classifyField({ name }).kind, 'secret', name);
  // A longer name is judged as it always was: never free, whatever word it starts with.
  for (const name of ['tokenizer_email', 'discardEmail', 'headphone_phone', 'cardinalPhone']) assert.notEqual(S.classifyField({ name }).kind, 'free', name);
});
