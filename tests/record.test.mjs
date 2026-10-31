// The worker side of ADR 0001 / 0003: the environment is decided again from the
// sender, and typed values from the content script are checked again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const R = require('../shared/record.js');

const { typed } = S;
const settings = { keywords: ['Acme'], commercialHosts: ['shop.example.com'], hostAllowlist: [] };
const PROD = 'https://shop.example.com/cart';
const BETA = 'https://beta.example.com/cart';

function newRec() {
  return { startedAt: Date.now(), aliases: {}, redactions: {}, steps: [], policy: R.policyOf(settings) };
}

// The names of a field that classifyField puts in each field, as the content script sends them.
const META = {
  text: { tag: 'input', type: 'text', name: 'body' },
  search: { tag: 'input', type: 'search' },
  choice: { tag: 'select', type: 'select' },
  secret: { tag: 'input', type: 'password' },
  pii: { tag: 'input', type: 'email' }
};
const input = (value, extra = {}) => ({
  type: value?.field === 'choice' ? 'select' : 'input', pageUrl: PROD, target: { role: 'textbox', tag: 'input', name: '本文' }, value, field: META[value?.field] || META.text, ...extra
});

test('envOf: commercial when the top page or the frame is on a listed host', () => {
  const policy = R.policyOf({ commercialHosts: ['*.example.com'] });
  assert.equal(R.envOf([PROD], policy), 'commercial');
  assert.equal(R.envOf(['https://other.invalid/', PROD], policy), 'commercial');
  assert.equal(R.envOf(['https://other.invalid/'], policy), 'standard');
  assert.equal(R.envOf([undefined, 'not a url'], policy), 'standard');
});

test('the environment comes from the sender, not from what the content script says', () => {
  const rec = newRec();
  const kept = typed.kept('text', 'こんにちは');
  // The page URL claims beta, but Chrome reports the tab on the production host.
  const step = R.cleanStep({ ...input(kept), pageUrl: BETA }, rec, settings, { tabUrl: PROD, frameUrl: PROD });
  assert.equal(step.env, 'commercial');
  assert.deepEqual(step.value, { treatment: 'redacted', field: 'text', kind: 'v' });
});

test('commercial free text that arrives kept is redacted; search and choices stay (rows I5, I6, I8, E2)', () => {
  const rec = newRec();
  const from = { tabUrl: PROD };
  assert.equal(R.cleanStep(input(typed.kept('text', 'x')), rec, settings, from).value.treatment, 'redacted');
  assert.deepEqual(R.cleanStep(input(typed.kept('search', '週末')), rec, settings, from).value, typed.kept('search', '週末'));
  assert.deepEqual(R.cleanStep(input(typed.kept('choice', '東京')), rec, settings, from).value, typed.kept('choice', '東京'));
  const length = { treatment: 'length', field: 'text', kind: 'text', length: 7 };
  assert.deepEqual(R.cleanStep(input(length), rec, settings, from).value, length);
});

test('secret and personal fields are never kept, whatever the environment (rows I2-I4)', () => {
  for (const tabUrl of [PROD, BETA]) {
    const rec = newRec();
    // A kept value the masking never makes for these fields drops the step (review R20).
    assert.equal(R.cleanStep(input(typed.kept('secret', 'hunter2')), rec, settings, { tabUrl }), null);
    assert.equal(R.cleanStep(input(typed.kept('pii', 'Taro')), rec, settings, { tabUrl }), null);
    // Even empty: no exception to the rows (R1).
    assert.equal(R.cleanStep(input(typed.kept('secret', '')), rec, settings, { tabUrl }), null);
    assert.deepEqual(R.cleanStep(input(typed.redacted('secret', 'secret')), rec, settings, { tabUrl }).value, typed.redacted('secret', 'secret'));
  }
});

test('a value that is not a typed value of its field drops the step; a malformed one is redacted (row E2; review R20)', () => {
  const rec = newRec();
  for (const value of ['plain text', 42, null, { text: 'x' }, { treatment: 'other', text: 'x' }]) {
    assert.equal(R.cleanStep(input(value, { field: META.text }), rec, settings, { tabUrl: BETA }), null, JSON.stringify(value));
  }
  // A treatment the masking never gives this field, in either environment, drops the step too (review R22).
  for (const value of [{ treatment: 'other', field: 'text', text: 'x' }, { treatment: 'redacted', field: 'text', kind: 'url' }]) {
    assert.equal(R.cleanStep(input(value), rec, settings, { tabUrl: BETA }), null, JSON.stringify(value));
  }
  for (const value of [{ treatment: 'length', field: 'text', kind: 'text', length: -1 }, { treatment: 'length', field: 'text', kind: 'email', length: 3 }]) {
    assert.deepEqual(R.cleanStep(input(value), rec, settings, { tabUrl: BETA }).value, typed.redacted('text', 'v'), JSON.stringify(value));
  }
  assert.equal(rec.redactions.v, 2);
});

test('a value looser than the step environment allows is made strict, as the content script would have (row I4; review R22)', () => {
  const mail = { treatment: 'length', field: 'pii', kind: 'email', length: 12 };
  // The content script judged commercial, the worker judges standard: the length is not kept.
  const rec = newRec();
  assert.deepEqual(R.cleanStep(input(mail, { pageUrl: BETA }), rec, settings, { tabUrl: BETA }).value, typed.redacted('pii', 'email'));
  assert.deepEqual(rec.redactions, { email: 1 });
  assert.deepEqual(R.cleanStep(input(mail), newRec(), settings, { tabUrl: PROD }).value, mail);
  // Stricter than needed stays as it is: a redacted personal value in commercial.
  assert.deepEqual(R.cleanStep(input(typed.redacted('pii', 'email')), newRec(), settings, { tabUrl: PROD }).value, typed.redacted('pii', 'email'));
});

test('a field that is not recorded drops the step in the worker too (row I1; review R20)', () => {
  const rec = newRec();
  assert.equal(R.cleanStep(input(typed.kept('text', 'token-value'), { field: { tag: 'input', type: 'hidden' } }), rec, settings, { tabUrl: BETA }), null);
  // Without the names the worker cannot classify: the step is dropped.
  assert.equal(R.cleanStep(input(typed.kept('text', 'x'), { field: undefined }), rec, settings, { tabUrl: BETA }), null);
});

test('the field names are classified whole, never cut first (row I3; review R20)', () => {
  const step = R.cleanStep(input(typed.kept('text', 'hunter2'), { field: { type: 'text', name: `${'x'.repeat(200)}password` } }),
    newRec(), settings, { tabUrl: BETA });
  assert.equal(step, null);
});

test('a field gets only the step kind the content script gives it (rows I5, I7; review R21)', () => {
  const at = { tabUrl: BETA };
  // A file is an upload and a checkbox or radio a check: as an input they carry nothing.
  assert.equal(R.cleanStep(input(typed.kept('text', 'customer-name.pdf'), { field: { tag: 'input', type: 'file' } }), newRec(), settings, at), null);
  for (const type of ['checkbox', 'Radio']) {
    assert.equal(R.cleanStep(input(typed.kept('choice', 'private-option'), { field: { tag: 'input', type } }), newRec(), settings, at), null, type);
  }
  // A select step is the select tag, and the select tag is a select step.
  assert.equal(R.cleanStep({ ...input(typed.kept('choice', '東京'), { field: META.choice }), type: 'input' }, newRec(), settings, at), null);
  assert.equal(R.cleanStep({ ...input(typed.kept('choice', '1'), { field: { tag: 'input', type: 'range' } }), type: 'select' }, newRec(), settings, at), null);
  assert.deepEqual(R.cleanStep({ ...input(typed.kept('choice', '東京')), type: 'select' }, newRec(), settings, at).value, typed.kept('choice', '東京'));
  assert.deepEqual(R.cleanStep(input(typed.kept('choice', '1'), { type: 'input', field: { tag: 'input', type: 'range' } }), newRec(), settings, at).value, typed.kept('choice', '1'));
});

test('a long selector is cut with the mark that says so, and the check accepts exactly that (row T3; review R21)', () => {
  const selector = `[data-testid="${'x'.repeat(200)}"]`;
  const step = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', selector } }, newRec(), settings, { tabUrl: BETA });
  assert.equal([...step.target.selector].length, 161);
  assert.ok(step.target.selector.endsWith('…'));
});

test('a search box or a choice keeps only its own limit (rows I5, I6; review R20)', () => {
  const long = 'あ'.repeat(200);
  // Sent as free text for a real search box: not what the masking makes, so dropped.
  assert.equal(R.cleanStep(input(typed.kept('text', long), { field: META.search }), newRec(), settings, { tabUrl: BETA }), null);
  const search = R.cleanStep(input(typed.kept('search', long)), newRec(), settings, { tabUrl: BETA });
  assert.equal([...search.value.text].length, 121);
});

test('standard kept text is masked again, keeping the content script placeholders (rows K2, K3)', () => {
  const rec = newRec();
  const step = R.cleanStep(input(typed.kept('text', '[[email]] / Acme / user@example.com')), rec, settings, { tabUrl: BETA });
  assert.deepEqual(step.value, typed.kept('text', '[[email]] / [[masked]] / [[email]]'));
});

test('WebMCP arguments: commercial strings and numbers are not kept (rows W2, W3)', () => {
  const rec = newRec();
  const args = { q: typed.kept('arg', 'shoes'), n: typed.keptNumber(3), on: true, raw: 'page string' };
  const step = R.cleanStep({ type: 'tool', pageUrl: PROD, tool: 'search', args }, rec, settings, { tabUrl: PROD });
  assert.deepEqual(step.args, {
    q: { treatment: 'redacted', field: 'arg', kind: 'v' },
    n: { treatment: 'redacted', field: 'arg', kind: 'number' },
    on: true,
    raw: { treatment: 'redacted', field: 'arg', kind: 'v' }
  });
  const beta = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'search', args }, newRec(), settings, { tabUrl: BETA });
  assert.deepEqual(beta.args.q, typed.kept('arg', 'shoes'));
  assert.deepEqual(beta.args.n, typed.keptNumber(3));
});

test('role, tag and key keep only allowed forms (rows T4, T5)', () => {
  const rec = newRec();
  const step = R.cleanStep({
    type: 'click', pageUrl: BETA, target: { role: 'Button <b>', tag: 'button', name: 'x' }
  }, rec, settings, { tabUrl: BETA });
  assert.equal(step.target.role, undefined);
  assert.equal(step.target.tag, 'button');
  assert.equal(R.cleanStep({ type: 'key', key: 'ctrl+meta+Enter' }, rec, settings, { tabUrl: BETA }).key, 'ctrl+meta+Enter');
  // Any other key, or a key that is missing, drops the step (R2).
  for (const key of ['a', 'ctrl+ctrl+Enter', 'meta+ctrl+Enter', undefined]) {
    assert.equal(R.cleanStep({ type: 'key', key }, rec, settings, { tabUrl: BETA }), null, String(key));
  }
});

test('unknown step types are not recorded (row T6)', () => {
  assert.equal(R.cleanStep({ type: 'scroll' }, newRec(), settings, { tabUrl: BETA }), null);
});

test('a note from the panel is commercial when the recording has a commercial step', () => {
  const rec = newRec();
  assert.equal(R.cleanStep({ type: 'note', note: 'ok' }, rec, settings).env, 'standard');
  rec.steps.push(R.cleanStep({ type: 'navigate', pageUrl: PROD }, rec, settings, { tabUrl: PROD }));
  assert.equal(R.cleanStep({ type: 'note', note: 'ok' }, rec, settings).env, 'commercial');
});

test('URLs in a commercial step drop query values and the fragment (rows U7, U8)', () => {
  const rec = newRec();
  const step = R.cleanStep({ type: 'navigate', pageUrl: `${PROD}?tab=items#/x` }, rec, settings, { tabUrl: PROD });
  assert.equal(step.url, 'https://site-1.invalid/cart?tab=[[v]]');
});

test('names, notes, tool names and selectors are one line (rows T1-T3, W6, #18)', () => {
  const rec = newRec();
  const step = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK\n    Then 偽', selector: '#a\nb' } },
    rec, settings, { tabUrl: BETA });
  assert.equal(step.target.name, 'OK     Then 偽');
  assert.equal(step.target.selector, '#a b');
  const note = R.cleanStep({ type: 'note', note: 'a\u2028b\rc' }, rec, settings);
  assert.equal(note.note, 'a b c');
  const tool = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x\ny' }, rec, settings, { tabUrl: BETA });
  assert.equal(tool.tool, 'x y');
});

test('WebMCP arguments under a credential or personal key are redacted, whatever arrives (row W1; review R1)', () => {
  const args = { email: typed.kept('arg', 'Alice'), list: { phone: [typed.kept('arg', '1'), typed.keptNumber(2)] }, q: typed.kept('arg', 'shoes') };
  const step = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', args }, newRec(), settings, { tabUrl: BETA });
  assert.deepEqual(step.args.email, { treatment: 'redacted', field: 'arg', kind: 'email' });
  // The whole subtree under the key is one redacted value (R3).
  assert.deepEqual(step.args.list.phone, { treatment: 'redacted', field: 'arg', kind: 'phone' });
  assert.deepEqual(step.args.q, typed.kept('arg', 'shoes'));
});

test('names, tool names and notes are masked before they are cut, so no keyword is left half (K2; review R19)', () => {
  const rec = newRec();
  const across = (limit) => `${'あ'.repeat(limit - 2)}Acme の続き`;
  const click = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: across(80) } }, rec, settings, { tabUrl: BETA });
  const tool = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: across(80) }, rec, settings, { tabUrl: BETA });
  const note = R.cleanStep({ type: 'note', note: `${'あ'.repeat(296)} alice@example.com` }, rec, settings);
  for (const text of [click.target.name, tool.tool, note.note]) {
    assert.ok(!/Ac|@/.test(text), text);
    assert.ok(text.endsWith('…'), text);
  }
});

test('placeholders kept inside WebMCP arguments are counted (row M1; review R19)', () => {
  const rec = newRec();
  const args = { q: typed.kept('arg', 'to [[email]] and [[masked]]'), r: typed.kept('arg', 'Acme') };
  R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', args }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(rec.redactions, { email: 1, keyword: 2 });
});

test('steps without what they must carry are not recorded (row T6; review R1)', () => {
  const rec = newRec();
  assert.equal(R.cleanStep({ type: 'input', pageUrl: BETA }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ type: 'navigate' }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ type: 'note' }, rec, settings), null);
  const upload = R.cleanStep({ type: 'upload', pageUrl: BETA, value: typed.kept('text', 'a.txt') }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(upload.value, typed.file(0));
});

test('a credential key redacts everything below it, at any depth and of any type (row W1; review R3)', () => {
  for (const env of [{ tabUrl: BETA }, { tabUrl: PROD }]) {
    const raw = { password: { value: typed.kept('arg', 'hunter2'), on: true }, outer: { token: [null, typed.keptNumber(1)] } };
    const step = R.cleanStep({ type: 'tool', pageUrl: env.tabUrl, tool: 'x', args: raw }, newRec(), settings, env);
    assert.deepEqual(step.args.password, { treatment: 'redacted', field: 'arg', kind: 'secret' });
    assert.deepEqual(step.args.outer.token, { treatment: 'redacted', field: 'arg', kind: 'secret' });
  }
  // The content script side walks the same way.
  assert.deepEqual(S.maskArgs({ password: { value: 'hunter2', on: true } }, { env: 'standard' }),
    { password: { treatment: 'redacted', field: 'arg', kind: 'secret' } });
});

test('the worker classifies the field names again and redacts what the content script kept (rows I3, I4; review R3)', () => {
  const rec = newRec();
  const kept = typed.kept('text', 'hunter2');
  // What the content script kept, the names say secret or personal: the step is dropped (review R20).
  assert.equal(R.cleanStep({ ...input(kept), pageUrl: BETA, field: { type: 'text', name: 'Password' } }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ ...input(typed.kept('text', 'a')), pageUrl: BETA, field: { type: 'text', name: 'email' } }, rec, settings, { tabUrl: BETA }), null);
  const length = { treatment: 'length', field: 'text', kind: 'text', length: 3 };
  assert.equal(R.cleanStep({ ...input(length), field: { name: 'email' } }, rec, settings, { tabUrl: PROD }), null);
  const secret = R.cleanStep({ ...input(typed.redacted('secret', 'secret')), pageUrl: BETA, field: { type: 'text', name: 'Password' } }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(secret.value, { treatment: 'redacted', field: 'secret', kind: 'secret' });
  assert.equal(secret.field, undefined, 'the names are not stored');
  const mail = { treatment: 'length', field: 'pii', kind: 'email', length: 3 };
  assert.deepEqual(R.cleanStep({ ...input(mail), field: { name: 'email' } }, rec, settings, { tabUrl: PROD }).value, mail);
  const plain = R.cleanStep({ ...input(typed.kept('text', 'hello')), pageUrl: BETA, field: { name: 'comment' } }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(plain.value, typed.kept('text', 'hello'));
});

test('a listed IDN production host matches the Punycode host a URL yields (rows I8, U4; review new R3)', () => {
  const policy = R.policyOf({ commercialHosts: ['例え.invalid', '*.ドメイン.invalid'] });
  assert.equal(R.envOf(['https://例え.invalid/x'], policy), 'commercial');
  assert.equal(R.envOf(['https://xn--r8jz45g.invalid/x'], policy), 'commercial');
  assert.equal(R.envOf(['https://www.ドメイン.invalid/'], policy), 'commercial');
  assert.equal(R.envOf(['https://例.invalid/'], policy), 'standard');
});

test('a trailing dot does not take a host out of production (rows U4, I8; review R13)', () => {
  const rec = newRec();
  const step = R.cleanStep(input(typed.kept('text', 'x')), rec, settings, { tabUrl: 'https://shop.example.com./cart' });
  assert.equal(step.env, 'commercial');
  assert.equal(step.value.treatment, 'redacted');
});

test('the worker does not keep as a search box what its names say is free text (rows I6, I8; review R15)', () => {
  const rec = newRec();
  const search = typed.kept('search', 'alpha beta');
  // Not what the masking makes for a free-text field: dropped, in any environment (review R20).
  assert.equal(R.cleanStep({ ...input(search), field: { type: 'text', role: 'region search', inSearch: false } }, rec, settings, { tabUrl: PROD }), null);
  assert.equal(R.cleanStep({ ...input(search), pageUrl: BETA, field: { type: 'text', inSearch: false } }, rec, settings, { tabUrl: BETA }), null);
  const real = R.cleanStep({ ...input(search), field: { type: 'text', inSearch: true } }, rec, settings, { tabUrl: PROD });
  assert.deepEqual(real.value, search);
});

test('the worker counts only the known redaction kinds (row M1; review R16)', () => {
  const rec = newRec();
  R.cleanStep({ ...input(typed.kept('text', 'x')), pageUrl: BETA, valueKinds: ['email', 'made-up', 'zzz'] }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(Object.keys(rec.redactions), ['email']);
});

test('redacted and length-only WebMCP arguments are counted (row M1; review R17)', () => {
  const rec = newRec();
  const args = S.maskArgs({ password: 'x', q: 'shoes', n: 5 }, { env: 'commercial' });
  R.cleanStep({ type: 'tool', pageUrl: PROD, tool: 't', args }, rec, settings, { tabUrl: PROD });
  assert.deepEqual(rec.redactions, { secret: 1, text: 1, number: 1 });
});

test('an argument the worker had to redact is counted once (row M1)', () => {
  const rec = newRec();
  R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 't', args: { a: 'raw', b: { treatment: 'other' } } }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(rec.redactions, { v: 2 });
});

test('a CSS-escaped selector is checked as written and unescaped, and dropped on a find (rows T3, K2, K3, K5; review R23)', () => {
  const rec = newRec();
  rec.aliases['https://intranet.corp.invalid'] = 'site-1.invalid';
  const click = (selector) => R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', selector } }, rec, settings, { tabUrl: BETA });
  for (const selector of ['[data-testid="intranet\\.corp\\.invalid"]', '#Ac\\me-panel', '#alice\\@example\\.com',
    '#shop\\.example\\.com', '[data-testid="\\41 cme"]']) {
    assert.equal(click(selector).target.selector, undefined, selector);
  }
  assert.equal(click('#save\\.button').target.selector, '#save\\.button');
});

test('every WebMCP answer goes through the final scan, the site and the counts too (rows W8, E6; review R37)', () => {
  const rec = newRec();
  rec.aliases['https://intranet.corp.invalid'] = 'site-1.invalid';
  rec.steps.push(R.cleanStep({ type: 'note', note: 'Acme の件' }, rec, { ...settings, keywords: [] }));
  const later = { ...settings, keywords: ['Acme'] };
  // A keyword added after the note was recorded stops the reproduction.
  assert.deepEqual(R.webmcpReply(rec, later, 'https://site-1.invalid', 'reproduction'), { ok: false, error: 'BLOCKED_SUSPECTED_LEAK' });
  // A site carrying a keyword or a real host stops the status too.
  assert.deepEqual(R.webmcpReply(rec, later, 'https://acme.example.com', 'status'), { ok: false, error: 'BLOCKED_SUSPECTED_LEAK' });
  assert.deepEqual(R.webmcpReply(rec, settings, 'https://intranet.corp.invalid', 'status'), { ok: false, error: 'BLOCKED_SUSPECTED_LEAK' });
  const fine = R.webmcpReply(rec, { ...settings, keywords: [] }, 'https://site-1.invalid', 'status');
  assert.equal(fine.ok, true);
  assert.equal(R.webmcpReply(rec, settings, 'https://site-1.invalid', 'expect'), null);
});
