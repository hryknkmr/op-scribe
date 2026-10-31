// Fixtures use reserved names only (example.com, *.invalid, fictional numbers).
// Secret-shaped strings are assembled at runtime so the repository never holds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');

// Credential-shaped values are put together here, so the finished form never sits in the file (AGENTS.md).
const BASIC = `Basic ${['dXNl', 'cjpw', 'YXNz'].join('')}`;

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
  for (const url of ['//intranet/a', '//localhost:8080/a', '//10.0.0.5/a', '//[fd00::1]/a']) {
    assert.match(S.scrubText(`開く ${url}`, { hosts }).text, /^開く \/\/site-\d+\.invalid(:\d+)?\/a$/, url);
  }
  // A host the recording has aliased is aliased when written without a URL too; an unvisited subdomain is not.
  assert.equal(S.scrubText('docs.internal.test を見た（a.docs.internal.test は別）', { hosts }).text, 'site-1.invalid を見た(a.docs.internal.test は別)');
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

test('IPv6 addresses are partly hidden, times and scope operators are not', () => {
  assert.equal(S.scrubText('接続先 fd00::1 と 2001:db8:0:0:0:0:0:1').text, '接続先 fd00:*:* と 2001:*:*:*:*:*:*:*');
  for (const text of ['10:30:00 に開始', 'std::vector', 'Note:: 備考']) assert.equal(S.scrubText(text).text, text, text);
  assert.deepEqual(S.finalScan({ v: 'fd00::1' }).map((f) => f.kinds), [['ip']]);
  // Ending in an IPv4 address: taken whole as IPv6, not as an IPv4 address with a prefix.
  assert.equal(S.scrubText('2001:db8:1:2:3:4:192.0.2.33 と ::ffff:192.0.2.1').text, '2001:*:*:*:*:*:* と :*:*:*');
  assert.deepEqual(S.finalScan({ v: '2001:db8:1:2:3:4:192.0.2.33' }).map((f) => f.kinds), [['ip']]);
});

test('a host with non-ASCII letters is aliased and scanned in both its Punycode and its Unicode form', () => {
  const hosts = { hostAllowlist: ['example.com'], aliases: {} };
  S.scrubText('https://münich.example/a', { hosts });
  assert.deepEqual(S.aliasedHosts(hosts.aliases).map(([host]) => host).sort(), ['münich.example', 'xn--mnich-kva.example']);
  assert.equal(S.scrubText('本文: münich.example と xn--mnich-kva.example', { hosts }).text, '本文: site-1.invalid と site-1.invalid');
  const keywords = S.aliasedHosts(hosts.aliases).map(([host]) => host);
  assert.deepEqual(S.finalScan({ v: 'münich.example' }, { keywords }).map((f) => f.kinds), [['keyword']]);
});

test('verification and PIN code fields are credentials, in any spelling', () => {
  for (const meta of [{ name: 'verification_code' }, { name: 'pin_code' }, { label: 'Verification code' }, { name: 'sms-code' }, { id: 'totp' }]) {
    assert.equal(S.maskFieldValue('123456', meta).value, '[[secret]]', JSON.stringify(meta));
  }
  assert.equal(S.maskFieldValue('90210', { name: 'zip_code' }).value, '90210');
  assert.equal(S.maskFieldValue('shoes', { name: 'shipping' }).value, 'shoes');
});

test('a contact field is kept only when its whole value is one recognized address or number', () => {
  assert.equal(S.maskFieldValue('alice@localhost ref 1234567', { type: 'email' }).value, '[[masked]]');
  // A stronger rule is never weakened by the contact field: credentials, cards and listed words stay hidden.
  assert.equal(S.maskFieldValue('password=hunter22', { type: 'email' }).value, '[[masked]]');
  assert.equal(S.maskFieldValue('4111 1111 1111 1111', { type: 'tel' }).value, '[[masked]]');
  assert.equal(S.maskFieldValue('Acme@example.com', { type: 'email' }, { keywords: ['Acme'] }).value, 'A***@e***.com');
  // A postal address is not an email field.
  assert.equal(S.maskFieldValue('123 Main Street', { label: 'Mailing address' }).value, '123 Main Street');
  assert.equal(S.maskFieldValue('a@example.com', { name: 'mailaddress' }).value, 'a***@e***.com');
  assert.equal(S.maskFieldValue('user@example.com', { type: 'email' }).value, 'u***@e***.com');
  assert.equal(S.maskFieldValue('090-1234-5678', { type: 'tel' }).value, '***-****-5678');
});

test('credential parameters are hidden in the query and in the fragment', () => {
  const url = (raw) => S.scrubUrl(raw, { hostAllowlist: ['example.com'] }).url;
  assert.equal(url('https://example.com/a?pin=1234&q=x'), 'https://example.com/a?pin=[[secret]]&q=x');
  assert.equal(url('https://example.com/#code=123456'), 'https://example.com/#code=[[secret]]');
  assert.equal(url('https://example.com/#access_token=abcd1234&x=1'), 'https://example.com/#access_token=[[secret]]&x=1');
  assert.equal(url('https://example.com/#/route?code=9&tab=a'), 'https://example.com/#/route?code=[[secret]]&tab=a');
  assert.equal(url('https://example.com/#/settings'), 'https://example.com/#/settings');
});

test('finalScan reads text around a placeholder as a whole', () => {
  const findings = S.finalScan({ a: 'Ac[[secret]]me', b: 'user[[secret]]@example.com', c: 'password=[[secret]]' }, { keywords: ['Acme'] });
  assert.deepEqual(findings.map((f) => f.path), ['a', 'b']);
});

test('API and private key fields are credentials, also as WebMCP arguments', () => {
  for (const meta of [{ name: 'api_key' }, { label: 'API key' }, { name: 'private_key' }, { name: 'accessKey' }]) {
    assert.equal(S.maskFieldValue('AbCd1234EfGh5678', meta).value, '[[secret]]', JSON.stringify(meta));
  }
  assert.deepEqual(S.maskArgs({ apiKey: 'AbCd1234EfGh5678', keyword: 'shoes' }), { apiKey: '[[secret]]', keyword: 'shoes' });
});

test('hosts and addresses in non-ASCII letters are hidden whole', () => {
  const hosts = { hostAllowlist: [], aliases: {} };
  assert.equal(S.scrubText('see //münich.example/a and //例え.テスト/a', { hosts }).text, 'see //site-1.invalid/a and //site-2.invalid/a');
  assert.deepEqual(S.finalScan({ x: 'münich.example 例え.テスト' }, { keywords: S.aliasedHosts(hosts.aliases).map(([h]) => h) }).length, 1);
  assert.equal(S.scrubText('連絡先は 太郎@例え.テスト まで。ASCII: user@example.comです').text, '連絡先は 太***@例***.テスト まで。ASCII: u***@e***.comです');
});

test('URL parameters use the same credential keys as fields, and id values are partly hidden', () => {
  const url = (raw) => S.scrubUrl(raw, { hostAllowlist: ['example.com'] }).url;
  assert.equal(url('https://example.com/?credential=shortSecret&bearer=shortSecret'), 'https://example.com/?credential=[[secret]]&bearer=[[secret]]');
  assert.equal(url('https://example.com/?id=abcdef123456&keyword=shoes&author=x'), 'https://example.com/?id=ab******56&keyword=shoes&author=x');
  assert.equal(url('https://example.com/#id=abcdef123456'), 'https://example.com/#id=ab******56');
  assert.deepEqual(S.maskArgs({ credential: 'x', apiKey: 'y', author: 'z' }), { credential: '[[secret]]', apiKey: '[[secret]]', author: 'z' });
});

test('a URL nested in the fragment keeps its own query and still follows the host policy', () => {
  const ctx = { hostAllowlist: ['example.com'], aliases: {} };
  assert.equal(S.scrubUrl('https://example.com/#/redirect/https://private.internal.test/a?x=1&token=abcd', ctx).url,
    'https://example.com/#/redirect/https://site-1.invalid/a?x=1&token=[[secret]]');
});

test('a listed word never breaks a placeholder', () => {
  assert.equal(S.scrubText('[[secret]] と secret', { keywords: ['secret'] }).text, '[[secret]] と [[masked]]');
});

test('one key judge: the same name means the same in fields, URLs, WebMCP arguments and the final scan', () => {
  assert.equal(S.classifyKey('orderID'), 'id');
  assert.equal(S.classifyKey('newpassword'), 'secret');
  assert.equal(S.classifyKey('Recovery code'), 'secret');
  assert.equal(S.classifyKey('state'), null);
  assert.equal(S.classifyKey('state', { protocol: true }), 'secret');
  assert.equal(S.maskFieldValue('abc123', { name: 'user_id' }).value, 'ab**23');
  assert.equal(S.maskFieldValue('Tokyo', { name: 'state' }).value, 'Tokyo');
  assert.equal(S.maskFieldValue('SAVE10', { name: 'promo_code' }).value, 'SAVE10');
  assert.deepEqual(S.maskArgs({ token: { value: 'abcd' }, authorization: BASIC, user_id: 'abc123', nested: { order_id: { v: 'zz9' } } }),
    { token: '[[secret]]', authorization: '[[secret]]', user_id: 'ab**23', nested: { order_id: { v: 'z**' } } });
  assert.equal(S.scrubUrl('https://example.com/?authorization=Basic%20x&email=alice%40localhost&orderID=abc123', { hostAllowlist: ['example.com'] }).url,
    'https://example.com/?authorization=[[secret]]&email=a***%40l***&orderID=ab**23');
  assert.deepEqual(S.finalScan({ args: { token: 'abc' }, steps: [{ key: 'Enter', args: { otp: '[[secret]]' } }] }).map((f) => f.path), ['args.token']);
});

test('credentials written as key and value in text are hidden', () => {
  for (const [input, output] of [['otp=123456', 'otp=[[secret]]'], ['cvv=123', 'cvv=[[secret]]'], ['session=abcd', 'session=[[secret]]'],
    [`Authorization: ${BASIC}`, 'Authorization: [[secret]]'], ['backup code: ABCDEF', 'backup code: [[secret]]'], ['{"pin":"1234"}', '{"pin":"[[secret]]"}']]) {
    assert.equal(S.scrubText(input).text, output);
  }
  assert.equal(S.scrubText('password=[[secret]]').text, 'password=[[secret]]');
});

test('a counter after a key name and card expiry fields are understood', () => {
  for (const name of ['cvv2', 'cvc2', 'exp_month', 'card_exp_year']) assert.equal(S.maskFieldValue('123', { name }).value, '[[card]]', name);
  for (const name of ['otp1', 'verificationCode1']) assert.equal(S.maskFieldValue('123456', { name }).value, '[[secret]]', name);
});

test('a URL that cannot be parsed is hidden whole', () => {
  assert.equal(S.scrubText('open https://private.internal.test:bad/x now', { hosts: { hostAllowlist: [], aliases: {} } }).text, 'open [[url:invalid]] now');
});

test('finalScan stops credential URL parameters and numeric credentials, not the filter\'s own counts', () => {
  const findings = S.finalScan({
    markdown: 'open https://example.com/callback?code=abc123 and https://example.com/?code=[[secret]]&id=ab**23',
    args: { otp: 123456 },
    recording: { privacy: { redactions: { secret: 2, card: 1 } } }
  });
  assert.deepEqual(findings.map((f) => f.path), ['markdown', 'args.otp']);
});

test('short credentials, nested credentials, user names, internal addresses and other URL schemes', () => {
  assert.equal(S.scrubText('password=x pin=12').text, 'password=[[secret]] pin=[[secret]]');
  assert.deepEqual(S.finalScan({ args: { token: { value: 'x' }, list: [{ secret: 'y' }] } }).map((f) => f.path), ['args.token.value', 'args.list[0].secret']);
  assert.equal(S.maskFieldValue('taro_y', { autocomplete: 'username' }).value, 'ta**_y');
  assert.equal(S.maskFieldValue('taro_y', { name: 'username' }).value, 'ta**_y');
  assert.equal(S.scrubText('alice@intranet or bob@example.com').text, 'a***@i*** or b***@e***.com');
  assert.equal(S.scrubText('see ftp://private.internal.test/a', { hosts: { hostAllowlist: [], aliases: {} } }).text, 'see [[url:ftp]]');
});

test('an unknown [[...]] cannot split what the final scan looks for', () => {
  const findings = S.finalScan({ a: 'Ac[[foo]]me', b: 'user[[foo]]@example.com', c: 'pass[[foo]]word=hunter22' }, { keywords: ['Acme'] });
  assert.deepEqual(findings.map((f) => f.path), ['a', 'b', 'c']);
});

test('opaque mixed ids in a path, phone numbers in common notations, and only the real redaction counts skipped', () => {
  assert.equal(S.scrubUrl('https://example.com/users/abc123def456ghi7', { hostAllowlist: ['example.com'] }).url, 'https://example.com/users/ab******i7');
  for (const [input, output] of [['(415) 555-2671', '(***) ***-2671'], ['415-555-2671', '***-***-2671'], ['03 1234 5678', '** **** 5678'], ['(03) 1234-5678', '(**) ****-5678']]) {
    assert.equal(S.scrubText(input).text, output);
  }
  for (const kept of ['2026-10-31', '1 000 000 円']) assert.equal(S.scrubText(kept).text, kept);
  assert.deepEqual(S.finalScan({ recording: { privacy: { redactions: { secret: 2 } } }, steps: [{ args: { redactions: { token: 'abc' } } }] })
    .map((f) => f.path), ['steps[0].args.redactions.token']);
});

test('key and value in text are judged by the same key classifier, quoted values whole', () => {
  for (const [input, output] of [['client_secret=abc', 'client_secret=[[secret]]'], ['access_token=abc', 'access_token=[[secret]]'],
    ['password="hunter 2"', 'password="[[secret]]"'], ['x=1&token=abc', 'x=1&token=[[secret]]']]) {
    assert.equal(S.scrubText(input).text, output);
    assert.equal(S.finalScan({ t: input }).length, 1, input);
  }
  for (const kept of ['note: hello world', 'state=open', 'secretary: Ms. A']) assert.equal(S.scrubText(kept).text, kept);
  assert.equal(S.maskFieldValue('x', { name: 'secretary' }).value, 'x');
  assert.equal(S.maskFieldValue('x', { name: 'tokenizer' }).value, 'x');
  assert.equal(S.maskFieldValue('Japan', { name: 'country_id', tag: 'select', type: 'select-one' }).value, 'Japan');
});

test('names in Japanese: credentials, ids, and key and value in a Japanese sentence', () => {
  for (const label of ['APIキー', 'トークン', '秘密鍵']) assert.equal(S.maskFieldValue('short123', { label }).value, '[[secret]]', label);
  for (const label of ['ユーザーID', 'ログインID', '会員番号']) assert.equal(S.maskFieldValue('abc123', { label }).value, 'ab**23', label);
  assert.equal(S.maskFieldValue('shoes', { label: 'キーワード' }).value, 'shoes');
  assert.equal(S.scrubText('ログイン後の認証コード: 123456').text, 'ログイン後の認証コード: [[secret]]');
  assert.equal(S.scrubText('注意: これは例です').text, '注意: これは例です');
});

test('an id inside a path segment is partly hidden, and WebMCP argument keys are protocol keys at the exit', () => {
  const url = (path) => S.scrubUrl(`https://example.com${path}`, { hostAllowlist: ['example.com'] }).url;
  assert.equal(url('/orders/123456.json'), 'https://example.com/orders/12**56.json');
  assert.equal(url('/orders/order-123456'), 'https://example.com/orders/order-12**56');
  assert.equal(url('/orders/123456;view=full'), 'https://example.com/orders/12**56;view=full');
  assert.equal(url('/blog/v1.2/intro'), 'https://example.com/blog/v1.2/intro');
  const findings = S.finalScan({ steps: [{ key: 'Enter', args: { code: 'abc123', privacy: { redactions: { otp: 'x' } } } }], recording: { privacy: { redactions: { secret: 1 } } } });
  assert.deepEqual(findings.map((f) => f.path), ['steps[0].args.code', 'steps[0].args.privacy.redactions.otp']);
});

test('compound credential names, unclosed quotes, and URLs in text checked at the exit like scrubUrl', () => {
  for (const name of ['pass', 'userpass', 'verificationcode']) assert.equal(S.maskFieldValue('hunter2', { type: 'text', name }).value, '[[secret]]', name);
  assert.equal(S.maskFieldValue('123', { name: 'securitycode' }).value, '[[card]]');
  for (const name of ['compass', 'bypass']) assert.equal(S.maskFieldValue('x', { name }).value, 'x', name);
  assert.equal(S.scrubText('password="hunter').text, 'password="[[secret]]');
  for (const t of ['https://example.com/users/@someone/orders/123456', 'https://example.com/?id=abc123', 'https://example.com/?phone=1234']) {
    assert.equal(S.finalScan({ t }).length, 1, t);
  }
  // What the filter itself wrote passes the exit.
  const ctx = { hostAllowlist: ['example.com'] };
  const once = S.scrubUrl('https://example.com/users/@someone/orders/123456?id=abc123&email=a%40example.com&code=x', ctx).url;
  assert.deepEqual(S.finalScan({ once }, { hostAllowlist: ['example.com'] }), []);
});

test('a credential is replaced whatever it looks like, and a chosen option is kept unless it is card data', () => {
  for (const value of ['ab**cd', '[[hunter2]]']) assert.equal(S.maskFieldValue(value, { type: 'password' }).value, '[[secret]]', value);
  assert.equal(S.maskFieldValue('Japan', { tag: 'select', type: 'select', name: 'country_id' }).value, 'Japan');
  // A credential name beats the chosen option: a one-time code chosen from a list is still a credential.
  assert.equal(S.maskFieldValue('123456', { tag: 'select', type: 'select', name: 'otp' }).value, '[[secret]]');
  assert.equal(S.maskFieldValue('Work', { tag: 'select', type: 'select', name: 'email' }).value, 'Work');
  assert.equal(S.maskFieldValue('12', { tag: 'select', type: 'select', name: 'exp_month' }).value, '[[card]]');
});

test('an address with a non-ASCII local part is one address, and a host with the root dot is the same host', () => {
  assert.equal(S.scrubText('名taro@example.com').text, '名***@e***.com');
  const ctx = { hostAllowlist: [], aliases: {} };
  assert.equal(S.scrubUrl('https://private.internal.test./a', ctx).url, 'https://site-1.invalid/a');
  assert.equal(S.scrubText('host private.internal.test here', { hosts: ctx }).text, 'host site-1.invalid here');
});

test('only the filter\'s own placeholders are trusted; hosts and contact keys of arguments are checked at the exit', () => {
  assert.equal(S.scrubText('password=[[hunter2]]').text, 'password=[[secret]]');
  assert.equal(S.finalScan({ a: 'password=[[hunter2]]' }).length, 1);
  assert.deepEqual(S.finalScan({ a: 'password=[[secret]]' }), []);
  assert.deepEqual(S.finalScan({ m: 'see https://private.internal.test/ and https://site-1.invalid/a and https://example.com/' }, { hostAllowlist: ['example.com'] })
    .map((f) => f.kinds), [['host']]);
  assert.deepEqual(S.finalScan({ args: { email: 'alice', phone: '1234', user_id: 'abc123', ok: 'a***@e***.com', uid: 'ab**23' } }).map((f) => f.path),
    ['args.email', 'args.phone', 'args.user_id']);
  assert.deepEqual(S.finalScan({ recording: { id: 'rec-abc', steps: [{ id: 's12', key: 'Enter' }] } }), []);
});

test('nested URLs encoded more than once, userinfo in scheme-relative URLs, and no trust in look-alikes from the page', () => {
  const ctx = { hostAllowlist: ['example.com'], aliases: {} };
  const raw = 'https://example.com/login?next=https%253A%252F%252Fprivate.internal.test%252Fa#/go/https%253A%252F%252Fother.internal.test%252Fb';
  assert.equal(S.scrubUrl(raw, ctx).url, 'https://example.com/login?next=https%3A%2F%2Fsite-1.invalid%2Fa#/go/https://site-2.invalid/b');
  assert.deepEqual(S.finalScan({ raw }, { hostAllowlist: ['example.com'] }).map((f) => f.kinds), [['host']]);
  assert.equal(S.scrubText('see //user:pass@private.internal.test/path', { hosts: { hostAllowlist: [], aliases: {} } }).text, 'see //site-1.invalid/path');
  assert.equal(S.maskFieldValue('****123456', { type: 'tel' }).value, '******3456');
  for (const value of ['[[masked]]', '[[card]]']) assert.equal(S.maskFieldValue(value, { type: 'password' }).value, '[[secret]]');
});

test('an address is read before listed words and opaque strings can cut it apart; short Basic values and phone digits', () => {
  assert.equal(S.scrubText('alice@Acme.example.com', { keywords: ['Acme'] }).text, 'a***@A***.com');
  assert.equal(S.scrubText(`${'a1'.repeat(17)}@internal.test`).text, 'a***@i***.test');
  assert.equal(S.scrubText(`Authorization: Basic ${'YT' + 'pi'}`).text, 'Authorization: [[secret]]');
  assert.equal(S.scrubText('Basic auth を使う').text, 'Basic auth を使う');
  assert.equal(S.maskFieldValue('4155552671', { type: 'tel' }).value, '******2671');
  assert.equal(S.maskFieldValue('4111 1111 1111 1111', { type: 'tel' }).value, '[[masked]]');
});

test('single-label addresses in any letters, fragment routes, relative URLs at the exit, and session lists', () => {
  assert.equal(S.scrubText('太郎@社内 alice@社内 太郎@intranet react@18 @handle').text, '太***@社*** a***@社*** 太***@i*** react@18 @handle');
  const ctx = { hostAllowlist: ['example.com'], aliases: {} };
  const scrubbed = S.scrubUrl('https://example.com/#/orders/123456/redirect/https://private.internal.test/a?x=1', ctx).url;
  assert.equal(scrubbed, 'https://example.com/#/orders/12**56/redirect/https://site-1.invalid/a?x=1');
  assert.deepEqual(S.finalScan({ scrubbed }, { hostAllowlist: ['example.com'] }), []);
  assert.equal(S.scrubUrl('https://example.com/#/orders/123456;view=full', ctx).url, 'https://example.com/#/orders/12**56;view=full');
  for (const t of ['see /orders/123456 now', '?code=abc123']) assert.equal(S.finalScan({ t }).length, 1, t);
  for (const t of ['東京/大阪', '10/31', '/orders/12**56', '/search?q=shoes']) assert.deepEqual(S.finalScan({ t }), [], t);
  assert.equal(S.maskFieldValue('Morning', { tag: 'select', type: 'select', name: 'session' }).value, 'Morning');
  // Only a list named "session" and nothing else: a session id chosen from a list is a credential.
  for (const name of ['meeting_session', 'session_id', 'session_key', 'sid']) {
    assert.equal(S.maskFieldValue('abc123', { tag: 'select', type: 'select', name }).value, '[[secret]]', name);
  }
  assert.equal(S.maskFieldValue('x', { name: 'session' }).value, '[[secret]]');
});

test('other URL schemes are stopped at the exit, parameter keys are decoded, and card names are card data', () => {
  assert.deepEqual(S.finalScan({ a: 'ftp://private.internal.test/a', b: 'file://private.internal.test/share', c: '[[url:ftp]]' }, { hostAllowlist: [] })
    .map((f) => f.path), ['a', 'b']);
  assert.equal(S.scrubUrl('https://example.com/?%2574oken=Abc123', { hostAllowlist: ['example.com'] }).url, 'https://example.com/?%2574oken=[[secret]]');
  for (const name of ['credit_card', 'creditCard', 'cc-name', 'cardholder']) assert.equal(S.maskFieldValue('4111111111111112', { name }).value, '[[card]]', name);
  for (const name of ['discard', 'postcard']) assert.equal(S.classifyKey(name), null, name);
});

test('invisible controls cannot split a name or a listed word; nested contact keys and short phone numbers', () => {
  for (const name of ['o​tp', 'to​ken', '認​証コード']) assert.equal(S.maskFieldValue('123456', { name }).value, '[[secret]]', JSON.stringify(name));
  assert.equal(S.scrubText('Acme and Ac​me', { keywords: ['Ac​me'] }).text, '[[masked]] and [[masked]]');
  assert.deepEqual(S.finalScan({ args: { user_id: { value: 'abc123' }, email: { value: 'alice' } } }).map((f) => f.path), ['args.user_id.value', 'args.email.value']);
  const args = S.maskArgs({ phone: '1234' });
  assert.deepEqual(args, { phone: '****' });
  assert.deepEqual(S.finalScan({ args }), []);
});

test('encoded fragment parameters, exact aliases at the exit, keys starting with a digit, other schemes in text, stable re-masking', () => {
  const url = 'https://example.com/#/route%3Fcode%3Dabc123';
  assert.equal(S.scrubUrl(url, { hostAllowlist: ['example.com'] }).url, 'https://example.com/#/route?code=[[secret]]');
  assert.equal(S.finalScan({ url }).length, 1);
  assert.deepEqual(S.finalScan({ a: 'https://private.internal.invalid/', b: 'https://site-1.invalid/x' }, { hostAllowlist: [] }).map((f) => f.path), ['a']);
  assert.deepEqual(S.finalScan({ b: 'https://site-2.invalid/x' }, { hostAllowlist: [], aliases: ['site-1.invalid'] }).map((f) => f.path), ['b']);
  assert.equal(S.scrubText('2fa=123456 10:30').text, '2fa=[[secret]] 10:30');
  assert.deepEqual(S.finalScan({ a: 'data:text/plain,x', b: 'javascript:alert(1)' }).map((f) => f.path), ['a', 'b']);
  const once = S.maskArgs({ email: 'a@example.com', phone: '090-1234-5678' });
  assert.deepEqual(S.maskArgs(once, { trustHidden: true }), once);
});

test('names mixing Latin and Japanese, narrower card and phone words, and only real redaction counts skipped', () => {
  for (const label of ['PINコード', 'OTPコード', 'TOTPコード', 'SMSコード', 'ログインコード']) {
    assert.equal(S.maskFieldValue('123456', { label }).value, '[[secret]]', label);
  }
  for (const name of ['cardTitle', 'cardinality', 'headphone_model', 'smartphone']) assert.equal(S.classifyKey(name), null, name);
  for (const name of ['card_number', 'cardholder', 'credit_card']) assert.equal(S.classifyKey(name), 'card', name);
  assert.equal(S.classifyKey('mobile_phone'), 'phone');
  assert.deepEqual(S.finalScan({ recording: { privacy: { redactions: { 'alice@example.com': 1 } } } }).length, 1);
  assert.deepEqual(S.finalScan({ recording: { privacy: { redactions: { secret: 2, email: 1 } } } }), []);
});

test('production (docs/adr/0001): free text is its length only; search boxes by markup and chosen options are kept', () => {
  const strict = { strict: true };
  assert.equal(S.maskFieldValue('Taro Yamada', { name: 'full_name' }, strict).value, '[[text:11]]');
  assert.equal(S.maskFieldValue('shoes', { type: 'search' }, strict).value, 'shoes');
  assert.equal(S.maskFieldValue('shoes', { name: 'q', search: true }, strict).value, 'shoes');
  assert.equal(S.maskFieldValue('shoes', { name: 'q' }, strict).value, '[[text:5]]');
  assert.equal(S.maskFieldValue('Japan', { tag: 'select', type: 'select' }, strict).value, 'Japan');
  assert.equal(S.maskFieldValue('a@example.com', { type: 'email' }, strict).value, '[[text:13]]');
  assert.equal(S.maskFieldValue('Taro', { name: 'full_name' }).value, 'Taro');
  assert.deepEqual(S.maskArgs({ q: 'shoes', count: 3, otp: '1' }, strict), { q: '[[text:5]]', count: 3, otp: '[[secret]]' });
});

test('production URLs keep only short plain values; other hosts keep theirs; deep encodings are hidden everywhere', () => {
  const ctx = () => ({ hostAllowlist: ['www.example.com', 'beta.example.com'], productionHosts: ['www.example.com'], aliases: {} });
  assert.equal(S.scrubUrl('https://www.example.com/items/ランニング/abc?q=shoes&ref=https%3A%2F%2Fx.test#/settings', ctx()).url,
    'https://www.example.com/items/[[v]]/abc?q=shoes&ref=[[v]]#/settings');
  assert.equal(S.scrubUrl('https://www.example.com/a#section', ctx()).url, 'https://www.example.com/a#[[v]]');
  assert.equal(S.scrubUrl('https://beta.example.com/a#section', ctx()).url, 'https://beta.example.com/a#section');
  const deep = encodeURIComponent(encodeURIComponent(encodeURIComponent(encodeURIComponent('https://private.internal.test/'))));
  assert.equal(S.scrubUrl(`https://beta.example.com/a/${deep}`, ctx()).url, 'https://beta.example.com/a/[[v]]');
});

test('csrf keys, dotted phone numbers and quoted local parts', () => {
  assert.deepEqual(S.maskArgs({ _csrf: 'short-secret' }), { _csrf: '[[secret]]' });
  assert.equal(S.scrubText('415.555.2671 +1.415.555.2671 192.168.1.1 "john doe"@example.com').text,
    '***.***.2671 +*.***.***.2671 192.168.*.* "j***"@e***.com');
});

test('a card number or a token in a path is hidden whole; production arguments are all length only', () => {
  const ctx = { hostAllowlist: ['example.com'] };
  assert.equal(S.scrubUrl('https://example.com/cards/4111111111111111', ctx).url, 'https://example.com/cards/[[card]]');
  assert.equal(S.scrubUrl(`https://example.com/t/${'a1'.repeat(16)}`, ctx).url, 'https://example.com/t/[[secret]]');
  assert.deepEqual(S.maskArgs({ email: 'a@example.com', user_id: 'cu123', items: ['Taro Yamada'], otp: '1', n: 3 }, { strict: true }),
    { email: '[[text:13]]', user_id: '[[text:5]]', items: ['[[text:11]]'], otp: '[[secret]]', n: 3 });
  assert.deepEqual(S.finalScan({ steps: [{ privacy: { profile: 'commercial' }, args: { items: ['Taro Yamada'], email: 'a***@e***.com', ok: '[[text:3]]' } }] })
    .map((f) => f.path), ['steps[0].args.items[0]', 'steps[0].args.email']);
});

test('card verification names, host lists in any written form, and credential field values at the exit', () => {
  for (const name of ['cardVerificationValue', 'cid', 'cvn', 'cv2', 'cav2']) assert.equal(S.maskFieldValue('123', { name }).value, '[[card]]', name);
  assert.equal(S.hostAllowed('xn--mnich-kva.example', ['münich.example']), true);
  assert.equal(S.hostAllowed('www.xn--mnich-kva.example', ['*.münich.example']), true);
  assert.equal(S.hostAllowed('www.example.com.', ['WWW.Example.com.']), true);
  assert.equal(S.hostAllowed('evil-example.com', ['*.example.com']), false);
  assert.deepEqual(S.finalScan({ steps: [{ valueClass: 'card', value: '123' }, { valueClass: 'card', value: '[[card]]' }] }).map((f) => f.path), ['steps[0].value']);
});

test('production query values must be plain whatever the key; contact and id field values are re-masked and checked', () => {
  const ctx = { hostAllowlist: ['www.example.com'], productionHosts: ['www.example.com'], aliases: {} };
  assert.equal(S.scrubUrl('https://www.example.com/?email=alice@example.com&uid=abc123', ctx).url, 'https://www.example.com/?email=[[v]]&uid=ab**23');
  assert.deepEqual(S.maskByKind('id', 'customer42', { trustHidden: true }), { value: 'cu******42', kinds: ['id'] });
  assert.deepEqual(S.finalScan({ steps: [{ valueClass: 'id', value: 'customer42', privacy: { profile: 'standard' } }, { valueClass: 'id', value: 'cu******42' }] })
    .map((f) => f.path), ['steps[0].value']);
});

test('relative URLs of any form at the exit, domain-literal addresses, and range and color as chosen values', () => {
  for (const t of ['./callback?code=abc123', '../orders/123456', 'callback?code=abc123']) assert.equal(S.finalScan({ t }).length, 1, t);
  for (const t of ['東京/大阪', '10/31', 'v1.2', 'file.txt', '/search?q=shoes']) assert.deepEqual(S.finalScan({ t }), [], t);
  assert.equal(S.scrubText('someone@[192.168.1.1] other@[IPv6:2001:db8::1]').text, 's***@[***] o***@[***]');
  assert.equal(S.maskFieldValue('50', { type: 'range' }, { strict: true }).value, '50');
  assert.equal(S.maskFieldValue('#ff0000', { type: 'color' }, { strict: true }).value, '#ff0000');
});

test('more credential and id names: auth and recovery keys, national ids, bank and document numbers; keys are checked as URLs', () => {
  for (const name of ['auth_key', 'recovery_key', 'ssn', 'social_security_number', 'マイナンバー']) assert.equal(S.classifyKey(name), 'secret', name);
  for (const name of ['iban', 'account_number', 'passport', 'order_number']) assert.equal(S.classifyKey(name), 'id', name);
  for (const name of ['author', 'keyword', 'number']) assert.equal(S.classifyKey(name), null, name);
  assert.equal(S.scrubText('auth_key=ABCD-EFGH ssn=123-45-6789').text, 'auth_key=[[secret]] ssn=[[secret]]');
  assert.deepEqual(S.finalScan({ recording: { aliases: { 'https://private.internal.test': 'site-1.invalid' } } }, { hostAllowlist: [] })
    .map((f) => f.kinds), [['host']]);
});

test('card numbers with any separator, national ids by their form, and what the filter writes always passes the exit', () => {
  for (const t of ['4111.1111.1111.1111', '4111\t1111\t1111\t1111']) assert.equal(S.scrubText(t).text, '[[card]]', JSON.stringify(t));
  assert.equal(S.scrubText('123-45-6789').text, '[[secret]]');
  // A My Number with a valid check digit is hidden whole; twelve digits without one are an id.
  const base = '12345678901';
  let sum = 0;
  for (let n = 1; n <= 11; n += 1) sum += Number(base[11 - n]) * (n <= 6 ? n + 1 : n - 5);
  const myNumber = `${base}${sum % 11 <= 1 ? 0 : 11 - (sum % 11)}`;
  assert.equal(S.scrubText(myNumber).text, '[[secret]]');
  assert.equal(S.scrubText('123456789012').text, '12******12');
  for (const kept of ['2026-10-31']) assert.equal(S.scrubText(kept).text, kept);
  // Idempotent at the exit: every rule's output passes finalScan.
  for (const input of ['"john doe"@example.com', 'someone@[192.168.1.1]', 'alice@intranet', '太郎@例え.テスト', '名taro@example.com',
    '090-1234-5678', '(03) 1234-5678', '415.555.2671', '192.168.1.1', 'fd00::1', '2001:db8::192.0.2.33', '4111 1111 1111 1111',
    '123-45-6789', 'password=hunter2', `Authorization: ${BASIC}`, 'user@example.com', '12345678', '550e8400-e29b-41d4-a716-446655440000',
    'otp=123456', myNumber]) {
    const out = S.scrubText(input).text;
    assert.deepEqual(S.finalScan({ out }), [], `${input} -> ${out}`);
  }
});

test('a scheme-relative URL inside a path or a fragment is read as a URL, and escaped quotes stay inside a value', () => {
  const ctx = () => ({ hostAllowlist: ['example.com', 'www.example.com'], productionHosts: ['www.example.com'], aliases: {} });
  assert.equal(S.scrubUrl('https://example.com/#/redirect//private.internal.test/login', ctx()).url, 'https://example.com/#/redirect//site-1.invalid/login');
  assert.equal(S.scrubUrl('https://www.example.com/#/redirect//private.internal.test/login', ctx()).url, 'https://www.example.com/#[[v]]');
  assert.equal(S.scrubUrl('https://example.com/redirect//private.internal.test/login', ctx()).url, 'https://example.com/redirect//site-1.invalid/login');
  assert.equal(S.finalScan({ u: 'https://example.com/#/redirect//private.internal.test/login' }, { hostAllowlist: ['example.com'] }).length, 1);
  assert.equal(S.scrubText('{"password":"abc\\"suffix","q":"x"}').text, '{"password":"[[secret]]","q":"x"}');
});

test('a page\'s own scheme name never becomes a trusted placeholder, and escaped quotes in a quoted local part', () => {
  assert.equal(S.scrubText('open acmesecret://host/path and ftp://x.test/a', { hosts: { hostAllowlist: [], aliases: {} } }).text, 'open [[url:other]] and [[url:ftp]]');
  assert.equal(S.finalScan({ a: '[[url:acmesecret]]' }, { keywords: ['acmesecret'] }).length, 1);
  assert.equal(S.scrubText('"john\\"doe"@example.com').text, '"j***"@e***.com');
});

test('the local part is read whole with its symbols, and only the filter\'s own partial address is left as it is', () => {
  for (const [input, output] of [['verysecret*tag@example.com', 'v***@e***.com'], ['alice@i***.private.example', 'a***@i***.example'],
    ["o'neil@example.com", 'o***@e***.com'], ['a***@e***.com', 'a***@e***.com']]) {
    assert.equal(S.scrubText(input).text, output, input);
    assert.deepEqual(S.finalScan({ output }), [], output);
  }
  assert.equal(S.finalScan({ raw: 'verysecret*tag@example.com' }).length, 1);
});

test('on production every typed value but a search box and a chosen option is its length, contact fields too', () => {
  const strict = { strict: true };
  assert.equal(S.maskFieldValue('a@example.com', { type: 'email' }, strict).value, '[[text:13]]');
  assert.equal(S.maskFieldValue('090-1234-5678', { type: 'tel' }, strict).value, '[[text:13]]');
  assert.equal(S.maskFieldValue('hunter2', { type: 'password' }, strict).value, '[[secret]]');
  const findings = S.finalScan({ steps: [
    { privacy: { profile: 'commercial' }, valueClass: 'email', value: 'a***@e***.com' },
    { privacy: { profile: 'commercial' }, valueClass: 'text', value: ['Taro Yamada'] },
    { privacy: { profile: 'commercial' }, valueClass: 'email', value: '[[text:13]]' }
  ] });
  assert.deepEqual(findings.map((f) => f.path), ['steps[0].value', 'steps[1].value']);
});

test('a card number set apart by any one separator is a card number', () => {
  for (const t of ['4111*1111*1111*1111', '4111_1111_1111_1111', '4111/1111/1111/1111']) {
    assert.equal(S.maskFieldValue(t, { type: 'text' }).value, '[[card]]', t);
    assert.equal(S.finalScan({ t }).length, 1, t);
  }
  assert.equal(S.scrubText('41******11').text, '41******11');
});

test('every invisible format character is ignored in names, keys, listed words and the final scan', () => {
  assert.equal(S.maskFieldValue('short-secret', { name: 'to⁦ken' }).value, '[[secret]]');
  assert.match(S.scrubUrl('https://example.com/?to⁦ken=short-secret', { hostAllowlist: ['example.com'] }).url, /=\[\[secret\]\]$/);
  assert.equal(S.scrubText('Ac⁦me', { keywords: ['Acme'] }).text, '[[masked]]');
  assert.equal(S.finalScan({ a: 'to⁦ken=abc' }).length, 1);
  assert.equal(S.scrubText('a؜b️c').text, 'abc');
});

test('own partial masks pass the exit on production, a malformed escape does not stop decoding, short Bearer and Basic', () => {
  const ctx = { hostAllowlist: ['www.example.com'], productionHosts: ['www.example.com'], aliases: {} };
  const url = S.scrubUrl('https://www.example.com/?uid=abc123', ctx).url;
  assert.equal(url, 'https://www.example.com/?uid=ab**23');
  assert.deepEqual(S.finalScan({ steps: [{ privacy: { profile: 'commercial' }, url }] }, { hostAllowlist: ['www.example.com'] }), []);
  const raw = 'https://example.com/?next=https%253A%252F%252Fprivate.internal.test%ZZ';
  assert.equal(S.scrubUrl(raw, { hostAllowlist: ['example.com'], aliases: {} }).url, 'https://example.com/?next=[[url:invalid]]');
  assert.equal(S.finalScan({ raw }, { hostAllowlist: ['example.com'] }).length, 1);
  assert.equal(S.scrubText(`Basic ${btoa('a:b')} / Bearer abc123 / Basic auth を使う`).text, '[[secret]] / [[secret]] / Basic auth を使う');
});

test('Basic in any case, and http URLs written without // or with backslashes, and hosts with underscores', () => {
  for (const t of [`basic ${'YT' + 'pi'}`, `BASIC ${'YT' + 'pi'}`]) assert.equal(S.scrubText(t).text, '[[secret]]', t);
  const hosts = () => ({ hostAllowlist: [], aliases: {} });
  assert.equal(S.scrubText('https:private.internal.test/a', { hosts: hosts() }).text, 'https://site-1.invalid/a');
  assert.equal(S.scrubText('https:\\\\private.internal.test\\help', { hosts: hosts() }).text, 'https://site-1.invalid/help');
  assert.equal(S.scrubText('see //internal_host.test/help', { hosts: hosts() }).text, 'see //site-1.invalid/help');
  for (const t of ['https:private.internal.test/a', 'see //internal_host.test/help']) assert.equal(S.finalScan({ t }, { hostAllowlist: [] }).length, 1, t);
  assert.equal(S.scrubText('時間: 10:30', { hosts: hosts() }).text, '時間: 10:30');
});

test('a text placeholder carries a length, not a number; digits of any script; only the filter\'s redaction kinds are skipped', () => {
  assert.deepEqual(S.finalScan({ a: '[[text:4111111111111111]]', b: '[[text:09012345678]]', c: '[[text:12]]' }).map((f) => f.path), ['a', 'b']);
  assert.equal(S.scrubText('٠٩٠١٢٣٤٥٦٧٨ ०९०१२३४५६७८').text, '*******5678 *******5678');
  assert.equal(S.finalScan({ a: '०९०१२३४५६७८' }).length, 1);
  assert.equal(S.finalScan({ recording: { privacy: { redactions: { otp: 123456 } } } }).length, 1);
  assert.deepEqual(S.finalScan({ recording: { privacy: { redactions: { secret: 2 } } } }), []);
});
