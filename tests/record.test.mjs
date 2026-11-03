// The worker side of ADR 0001 / 0003: the environment is decided again from the
// sender, and typed values from the content script are checked again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const R = require('../shared/record.js');
const { LIMITS } = require('../shared/limits.js');

const { typed } = S;
// Kept text is runs (#28). These tests write it rendered and read it rendered.
const runsOf = (text) => String(text).split(/(\[\[[a-z]+\]\])/).filter(Boolean)
  .map((p) => (/^\[\[[a-z]+\]\]$/.test(p) ? { redacted: p.slice(2, -2) } : p));
const kept = (field, text) => typed.kept(field, runsOf(text));
const show = (runs) => S.renderRuns(runs);
// The step addStep recorded, or null; its changed flag has a test of its own.
const addStep = (...args) => R.addStep(...args).step;
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
  const value = kept('text', 'こんにちは');
  // The page URL claims beta, but Chrome reports the tab on the production host.
  const step = R.cleanStep({ ...input(value), pageUrl: BETA }, rec, settings, { tabUrl: PROD, frameUrl: PROD });
  assert.equal(step.env, 'commercial');
  assert.deepEqual(step.value, { treatment: 'redacted', field: 'text', kind: 'v' });
});

test('commercial free text that arrives kept is redacted; search and choices stay (rows I5, I6, I8, E2)', () => {
  const rec = newRec();
  const from = { tabUrl: PROD };
  assert.equal(R.cleanStep(input(kept('text', 'x')), rec, settings, from).value.treatment, 'redacted');
  assert.deepEqual(R.cleanStep(input(kept('search', '週末')), rec, settings, from).value, kept('search', '週末'));
  assert.deepEqual(R.cleanStep(input(kept('choice', '東京')), rec, settings, from).value, kept('choice', '東京'));
  const length = { treatment: 'length', field: 'text', kind: 'text', length: 7 };
  assert.deepEqual(R.cleanStep(input(length), rec, settings, from).value, length);
});

test('secret and personal fields are never kept, whatever the environment (rows I2-I4)', () => {
  for (const tabUrl of [PROD, BETA]) {
    const rec = newRec();
    // A kept value the masking never makes for these fields drops the step (review R20).
    assert.equal(R.cleanStep(input(kept('secret', 'hunter2')), rec, settings, { tabUrl }), null);
    assert.equal(R.cleanStep(input(kept('pii', 'Taro')), rec, settings, { tabUrl }), null);
    // Even empty: no exception to the rows (R1).
    assert.equal(R.cleanStep(input(kept('secret', '')), rec, settings, { tabUrl }), null);
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
  assert.equal(R.cleanStep(input(kept('text', 'token-value'), { field: { tag: 'input', type: 'hidden' } }), rec, settings, { tabUrl: BETA }), null);
  // Without the names the worker cannot classify: the step is dropped.
  assert.equal(R.cleanStep(input(kept('text', 'x'), { field: undefined }), rec, settings, { tabUrl: BETA }), null);
});

test('the field names are classified whole, never cut first (row I3; review R20)', () => {
  const step = R.cleanStep(input(kept('text', 'hunter2'), { field: { type: 'text', name: `${'x'.repeat(200)}password` } }),
    newRec(), settings, { tabUrl: BETA });
  assert.equal(step, null);
});

test('a field gets only the step kind the content script gives it (rows I5, I7; review R21)', () => {
  const at = { tabUrl: BETA };
  // A file is an upload and a checkbox or radio a check: as an input they carry nothing.
  assert.equal(R.cleanStep(input(kept('text', 'customer-name.pdf'), { field: { tag: 'input', type: 'file' } }), newRec(), settings, at), null);
  for (const type of ['checkbox', 'Radio']) {
    assert.equal(R.cleanStep(input(kept('choice', 'private-option'), { field: { tag: 'input', type } }), newRec(), settings, at), null, type);
  }
  // A select step is the select tag, and the select tag is a select step.
  assert.equal(R.cleanStep({ ...input(kept('choice', '東京'), { field: META.choice }), type: 'input' }, newRec(), settings, at), null);
  assert.equal(R.cleanStep({ ...input(kept('choice', '1'), { field: { tag: 'input', type: 'range' } }), type: 'select' }, newRec(), settings, at), null);
  assert.deepEqual(R.cleanStep({ ...input(kept('choice', '東京')), type: 'select' }, newRec(), settings, at).value, kept('choice', '東京'));
  assert.deepEqual(R.cleanStep(input(kept('choice', '1'), { type: 'input', field: { tag: 'input', type: 'range' } }), newRec(), settings, at).value, kept('choice', '1'));
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
  assert.equal(R.cleanStep(input(kept('text', long), { field: META.search }), newRec(), settings, { tabUrl: BETA }), null);
  const search = R.cleanStep(input(kept('search', long)), newRec(), settings, { tabUrl: BETA });
  assert.equal([...show(search.value.text)].length, 121);
});

test('standard kept text is masked again, keeping the content script placeholders (rows K2, K3)', () => {
  const rec = newRec();
  const step = R.cleanStep(input(kept('text', '[[email]] / Acme / user@example.com')), rec, settings, { tabUrl: BETA });
  assert.deepEqual(step.value, kept('text', '[[email]] / [[masked]] / [[email]]'));
});

test('WebMCP arguments: commercial strings and numbers are not kept (rows W2, W3)', () => {
  const rec = newRec();
  const args = { q: kept('arg', 'shoes'), n: typed.keptNumber(3), on: true, raw: 'page string' };
  const step = R.cleanStep({ type: 'tool', pageUrl: PROD, tool: 'search', args }, rec, settings, { tabUrl: PROD });
  assert.deepEqual(step.args, {
    q: { treatment: 'redacted', field: 'arg', kind: 'v' },
    n: { treatment: 'redacted', field: 'arg', kind: 'number' },
    on: true,
    raw: { treatment: 'redacted', field: 'arg', kind: 'v' }
  });
  const beta = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'search', args }, newRec(), settings, { tabUrl: BETA });
  assert.deepEqual(beta.args.q, kept('arg', 'shoes'));
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
  assert.deepEqual(step.url, ['https://site-1.invalid/cart?tab=', { redacted: 'v' }]);
});

test('names, notes, tool names and selectors are one line (rows T1-T3, W6, #18)', () => {
  const rec = newRec();
  const step = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK\n    Then 偽', selector: '#a\nb' } },
    rec, settings, { tabUrl: BETA });
  assert.equal(show(step.target.name), 'OK     Then 偽');
  assert.equal(step.target.selector, '#a b');
  const note = R.cleanStep({ type: 'note', note: 'a\u2028b\rc' }, rec, settings);
  assert.equal(show(note.note), 'a b c');
  const tool = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x\ny' }, rec, settings, { tabUrl: BETA });
  assert.equal(show(tool.tool), 'x y');
});

test('WebMCP arguments under a credential or personal key are redacted, whatever arrives (row W1; review R1)', () => {
  const args = { email: kept('arg', 'Alice'), list: { phone: [kept('arg', '1'), typed.keptNumber(2)] }, q: kept('arg', 'shoes') };
  const step = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', args }, newRec(), settings, { tabUrl: BETA });
  assert.deepEqual(step.args.email, { treatment: 'redacted', field: 'arg', kind: 'email' });
  // The whole subtree under the key is one redacted value (R3).
  assert.deepEqual(step.args.list.phone, { treatment: 'redacted', field: 'arg', kind: 'phone' });
  assert.deepEqual(step.args.q, kept('arg', 'shoes'));
});

test('names, tool names and notes are masked before they are cut, so no keyword is left half (K2; review R19)', () => {
  const rec = newRec();
  const across = (limit) => `${'あ'.repeat(limit - 2)}Acme の続き`;
  const click = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: across(80) } }, rec, settings, { tabUrl: BETA });
  const tool = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: across(80) }, rec, settings, { tabUrl: BETA });
  const note = R.cleanStep({ type: 'note', note: `${'あ'.repeat(296)} alice@example.com` }, rec, settings);
  for (const text of [click.target.name, tool.tool, note.note].map(show)) {
    assert.ok(!/Ac|@/.test(text), text);
    assert.ok(text.endsWith('…'), text);
  }
});

test('placeholders kept inside WebMCP arguments are counted (row M1; review R19)', () => {
  const rec = newRec();
  const args = { q: kept('arg', 'to [[email]] and [[masked]]'), r: kept('arg', 'Acme') };
  R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', args }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(rec.redactions, { email: 1, keyword: 2 });
});

test('steps without what they must carry are not recorded (row T6; review R1)', () => {
  const rec = newRec();
  assert.equal(R.cleanStep({ type: 'input', pageUrl: BETA }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ type: 'navigate' }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ type: 'note' }, rec, settings), null);
  const upload = R.cleanStep({ type: 'upload', pageUrl: BETA, value: kept('text', 'a.txt') }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(upload.value, typed.file(0));
});

test('a credential key redacts everything below it, at any depth and of any type (row W1; review R3)', () => {
  for (const env of [{ tabUrl: BETA }, { tabUrl: PROD }]) {
    const raw = { password: { value: kept('arg', 'hunter2'), on: true }, outer: { token: [null, typed.keptNumber(1)] } };
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
  const value = kept('text', 'hunter2');
  // What the content script kept, the names say secret or personal: the step is dropped (review R20).
  assert.equal(R.cleanStep({ ...input(value), pageUrl: BETA, field: { type: 'text', name: 'Password' } }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ ...input(kept('text', 'a')), pageUrl: BETA, field: { type: 'text', name: 'email' } }, rec, settings, { tabUrl: BETA }), null);
  const length = { treatment: 'length', field: 'text', kind: 'text', length: 3 };
  assert.equal(R.cleanStep({ ...input(length), field: { name: 'email' } }, rec, settings, { tabUrl: PROD }), null);
  const secret = R.cleanStep({ ...input(typed.redacted('secret', 'secret')), pageUrl: BETA, field: { type: 'text', name: 'Password' } }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(secret.value, { treatment: 'redacted', field: 'secret', kind: 'secret' });
  assert.equal(secret.field, undefined, 'the names are not stored');
  const mail = { treatment: 'length', field: 'pii', kind: 'email', length: 3 };
  assert.deepEqual(R.cleanStep({ ...input(mail), field: { name: 'email' } }, rec, settings, { tabUrl: PROD }).value, mail);
  const plain = R.cleanStep({ ...input(kept('text', 'hello')), pageUrl: BETA, field: { name: 'comment' } }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(plain.value, kept('text', 'hello'));
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
  const step = R.cleanStep(input(kept('text', 'x')), rec, settings, { tabUrl: 'https://shop.example.com./cart' });
  assert.equal(step.env, 'commercial');
  assert.equal(step.value.treatment, 'redacted');
});

test('the worker does not keep as a search box what its names say is free text (rows I6, I8; review R15)', () => {
  const rec = newRec();
  const search = kept('search', 'alpha beta');
  // Not what the masking makes for a free-text field: dropped, in any environment (review R20).
  assert.equal(R.cleanStep({ ...input(search), field: { type: 'text', role: 'region search', inSearch: false } }, rec, settings, { tabUrl: PROD }), null);
  assert.equal(R.cleanStep({ ...input(search), pageUrl: BETA, field: { type: 'text', inSearch: false } }, rec, settings, { tabUrl: BETA }), null);
  const real = R.cleanStep({ ...input(search), field: { type: 'text', inSearch: true } }, rec, settings, { tabUrl: PROD });
  assert.deepEqual(real.value, search);
});

test('the worker counts only the known redaction kinds (row M1; review R16)', () => {
  const rec = newRec();
  R.cleanStep({ ...input(kept('text', 'x')), pageUrl: BETA, valueKinds: ['email', 'made-up', 'zzz'] }, rec, settings, { tabUrl: BETA });
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
  rec.steps.push(R.cleanStep({ type: 'note', note: 'Acme の件', source: 'agent', pageUrl: 'https://intranet.corp.invalid/a' }, rec, { ...settings, keywords: [] },
    { tabUrl: 'https://intranet.corp.invalid/a' }));
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

test('the worker classifies by the label text too (rows I3, I4; review R38)', () => {
  const step = R.cleanStep(input(kept('text', 'hunter2'), { field: { tag: 'input', type: 'text', label: 'Comment', labelText: 'Password' } }),
    newRec(), settings, { tabUrl: BETA });
  assert.equal(step, null);
});

test('the largest recording the limits allow still fits the session storage: the oldest steps go first (review R40)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const rec = newRec();
  const url = `https://site-1.invalid/${'a'.repeat(LIMITS.url - 30)}`;
  const args = Object.fromEntries(Array.from({ length: LIMITS.argLeaves }, (_, i) => [`k${i}`, kept('arg', `${'\u0001'.repeat(LIMITS.kept.arg)}…`)]));
  const step = (i) => ({ type: 'tool', t: i, env: 'standard', source: 'agent', url, tool: `${'t'.repeat(LIMITS.tool)}…`, ok: true, args, n: i });
  // Filled to the step limit at once - more of the largest kind than appendStep lets the page add (W7),
  // to go past the storage share - then the person's last steps through appendStep.
  rec.steps = Array.from({ length: LIMITS.steps - 3 }, (_, i) => step(i));
  const note = (i) => ({ type: 'note', t: i, env: 'standard', source: 'user', url, note: [`${'\u0001'.repeat(LIMITS.note)}…`], n: i });
  for (let i = LIMITS.steps - 3; i < LIMITS.steps; i += 1) assert.ok(R.appendStep(rec, note(i)));
  const bytes = new TextEncoder().encode(JSON.stringify(rec)).length;
  assert.ok(bytes <= LIMITS.storeBytes, String(bytes));
  assert.ok(bytes < 10 * 1024 * 1024);
  assert.equal(rec.steps.at(-1).n, LIMITS.steps - 1, 'the newest step is kept');
  assert.ok(rec.steps.length < LIMITS.steps, 'older steps made room');
});

test('the host lists leave out names no host can have, and one step too large for the room is dropped (E2; review R41)', () => {
  const policy = R.policyOf({ commercialHosts: ['shop.example.com', 'x'.repeat(300)], hostAllowlist: [] });
  assert.deepEqual(policy.commercialHosts, ['shop.example.com']);
  const { LIMITS } = require('../shared/limits.js');
  const rec = newRec();
  R.appendStep(rec, { type: 'note', t: 0, env: 'standard', source: 'user', note: '\u0001'.repeat(LIMITS.storeBytes / 4) });
  assert.equal(rec.steps.length, 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(rec)).length <= LIMITS.storeBytes);
});

test('a page past the alias limit is not recorded, and an over-long production list makes every step commercial (K5, E2; review R42)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const rec = newRec();
  for (let i = 0; i < LIMITS.aliases; i += 1) rec.aliases[`https://h${i}.example.com`] = `site-${i + 1}.invalid`;
  assert.equal(R.cleanStep({ type: 'click', pageUrl: 'https://h500.example.com/', target: { role: 'button', name: 'h500.example.com' } },
    rec, settings, { tabUrl: 'https://h500.example.com/' }), null);
  assert.equal(Object.keys(rec.aliases).length, LIMITS.aliases);
  assert.ok(R.cleanStep({ type: 'click', pageUrl: 'https://h1.example.com/', target: { role: 'button', name: 'x' } }, rec, settings, { tabUrl: 'https://h1.example.com/' }));

  const many = Array.from({ length: LIMITS.hosts + 1 }, (_, i) => `p${i}.example.com`);
  const policy = R.policyOf({ commercialHosts: many, hostAllowlist: many });
  assert.equal(policy.commercialHosts.length, LIMITS.hosts);
  assert.equal(policy.hostAllowlist.length, LIMITS.hosts);
  assert.equal(policy.allCommercial, true);
  assert.equal(R.envOf(['https://other.invalid/'], policy), 'commercial');
});

test('the worker classifies by aria-labelledby text passed as label text (row I3; review R42)', () => {
  const step = R.cleanStep(input(kept('text', 'hunter2'), { field: { tag: 'input', type: 'text', label: 'Comment', ariaLabel: 'Comment', labelText: 'Password' } }),
    newRec(), settings, { tabUrl: BETA });
  assert.equal(step, null);
});

test('the session storage is shared out once, and any save is fitted, not only a new step (E2; review R43)', () => {
  const { LIMITS } = require('../shared/limits.js');
  assert.ok(LIMITS.storeBytes + LIMITS.draftBytes < 10 * 1024 * 1024);
  const rec = newRec();
  rec.grantedPatterns = Array.from({ length: LIMITS.aliases }, (_, i) => `https://h${i}.${'x'.repeat(240)}.example.com/*`);
  rec.steps = Array.from({ length: 400 }, (_, i) => ({ type: 'note', t: i, env: 'standard', source: 'user', note: '\u0001'.repeat(2000) }));
  R.fitRecord(rec);
  assert.ok(new TextEncoder().encode(JSON.stringify(rec)).length <= LIMITS.storeBytes);
  assert.ok(rec.steps.length > 0);
});

test('a save that drops steps to fit makes the recording a new revision (E4; review R44)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const rec = newRec();
  rec.revision = 7;
  rec.steps = Array.from({ length: 400 }, (_, i) => ({ type: 'note', t: i, env: 'standard', source: 'user', note: '\u0001'.repeat(4000) }));
  R.fitRecord(rec);
  assert.ok(new TextEncoder().encode(JSON.stringify(rec)).length <= LIMITS.storeBytes);
  assert.equal(rec.revision, 8);
  const small = { ...newRec(), revision: 3 };
  R.fitRecord(small);
  assert.equal(small.revision, 3, 'nothing dropped, nothing stale');
});

test('a page reports at most agentSteps steps, and they never push the person\'s steps out (row W7, #17)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const rec = newRec();
  const tool = () => R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, rec, settings, { tabUrl: BETA });
  const person = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK' } }, rec, settings, { tabUrl: BETA });
  assert.ok(R.appendStep(rec, person));
  for (let i = 0; i < LIMITS.agentSteps; i += 1) assert.ok(R.appendStep(rec, tool()));
  assert.equal(R.appendStep(rec, tool()), false, 'one more is not recorded');
  assert.equal(rec.steps.filter((s) => s.source === 'agent').length, LIMITS.agentSteps);
  assert.equal(rec.steps[0], person);
  // The person's steps are still recorded past it.
  assert.ok(R.appendStep(rec, R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK' } }, rec, settings, { tabUrl: BETA })));
});

test('WebMCP returns a site only its own steps and notes: no panel note, no count of the rest (row W8, #17)', () => {
  const rec = newRec();
  const s = { ...settings, keywords: [] };
  const own = R.cleanStep({ type: 'note', note: 'このサイトのメモ', source: 'agent', pageUrl: 'https://beta.example.com/a' }, rec, s, { tabUrl: 'https://beta.example.com/a' });
  const other = R.cleanStep({ type: 'note', note: '別サイトのメモ', source: 'agent', pageUrl: 'https://other.example.com/b' }, rec, s, { tabUrl: 'https://other.example.com/b' });
  const panel = R.cleanStep({ type: 'note', note: 'パネルのメモ' }, rec, s);
  rec.steps.push(own, other, panel);
  const site = new URL(S.renderRuns(own.url)).origin;
  const repro = R.webmcpReply(rec, s, site, 'reproduction');
  assert.equal(repro.steps, 1);
  assert.ok(repro.markdown.includes('このサイトのメモ'));
  assert.ok(!/別サイトのメモ|パネルのメモ/.test(repro.markdown + repro.gherkin));
  assert.deepEqual(R.webmcpReply(rec, s, site, 'status'), { ok: true, recording: true, site, stepsOnThisSite: 1 });
});

test('past the step limit the reported steps go first, whoever adds the new step (row W7; reviews of #37 R1, R2)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const rec = newRec();
  const click = () => R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK' } }, rec, settings, { tabUrl: BETA });
  const tool = () => R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, rec, settings, { tabUrl: BETA });
  const people = () => rec.steps.filter((s) => s.source === 'user').length;
  for (let i = 0; i < LIMITS.steps; i += 1) R.appendStep(rec, click());
  const revision = rec.revision;
  assert.equal(R.appendStep(rec, tool()), false, 'no reported step to give way: not recorded');
  assert.equal(people(), LIMITS.steps);
  assert.equal(rec.revision, revision, 'nothing changed, so no Markdown goes stale (review of #37 R11)');
  // Mixed and full: the person's new step pushes out a reported one, not the oldest of the person's.
  rec.steps.splice(0, LIMITS.agentSteps);
  for (let i = 0; i < LIMITS.agentSteps; i += 1) assert.ok(R.appendStep(rec, tool()));
  const first = rec.steps[0];
  assert.ok(R.appendStep(rec, click()));
  assert.equal(rec.steps[0], first);
  assert.equal(people(), LIMITS.steps - LIMITS.agentSteps + 1);
  assert.equal(rec.steps.length, LIMITS.steps);
});

test('a page on a host of the alias form is not recorded, whatever the lists say (rows U4, K5)', () => {
  // site-1.invalid would read as the alias of another site. It never resolves, so no real page is lost.
  for (const hostAllowlist of [[], ['site-1.invalid'], ['*.invalid']]) {
    const s = { ...settings, keywords: [], hostAllowlist };
    const rec = { ...newRec(), policy: R.policyOf(s) };
    assert.equal(addStep(rec, { type: 'click', pageUrl: 'https://site-1.invalid/b', target: { role: 'button', name: 'OK' } }, s, { tabUrl: 'https://site-1.invalid/b' }), null);
    // A link to one is redacted whole, and takes no alias.
    const link = addStep(rec, { type: 'click', pageUrl: 'https://other.example.com/a', target: { role: 'link', name: 'OK', href: 'https://SITE-2.invalid/c' } }, s, { tabUrl: 'https://other.example.com/a' });
    assert.deepEqual(link.target.href, [{ redacted: 'url', as: 'invalid' }]);
    assert.deepEqual(Object.values(rec.aliases), ['site-1.invalid'], JSON.stringify(hostAllowlist));
    // Every other host the list allows is still kept by name.
    if (hostAllowlist[0] === '*.invalid') assert.equal(new URL(S.renderRuns(S.scrubUrl('https://shop.invalid/z', { aliases: {}, hostAllowlist }).url)).host, 'shop.invalid');
  }
});

test('a step whose URL is redacted for its length is still its site\'s, and the site is not sent (rows W8, E1; review of #37)', () => {
  const P = require('../shared/payload.js');
  const rec = newRec();
  const s = { ...settings, keywords: [] };
  const long = R.cleanStep({ type: 'click', pageUrl: `${BETA}/${'a/'.repeat(1200)}`, target: { role: 'button', name: 'OK' } }, rec, s, { tabUrl: BETA });
  assert.deepEqual(long.url, [{ redacted: 'url', as: 'long' }]);
  rec.steps.push(long);
  assert.equal(R.webmcpReply(rec, s, long.site, 'status').stepsOnThisSite, 1);
  const payload = P.buildPayload({ ...rec, id: 'rec-site', webmcpTools: {} }, { generator: 'none', markdown: '' }, {});
  assert.equal(payload.recording.steps[0].site, undefined);
});

test('saving trims the reported steps of a site past the limit (row W7; review of #37)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const rec = newRec();
  const tool = () => R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, rec, settings, { tabUrl: BETA });
  rec.steps = Array.from({ length: LIMITS.agentSteps + 1 }, tool);
  R.fitRecord(rec);
  assert.equal(rec.steps.length, LIMITS.agentSteps);
});

test('a WebMCP reproduction carries no recording id (row W8; review of #37 R4)', () => {
  const rec = { ...newRec(), id: 'rec-shared-1' };
  const s = { ...settings, keywords: [] };
  const step = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK' } }, rec, s, { tabUrl: BETA });
  rec.steps.push(step);
  const repro = R.webmcpReply(rec, s, step.site, 'reproduction');
  assert.equal(repro.ok, true);
  assert.ok(!JSON.stringify(repro).includes('rec-shared-1'));
});

test('a navigation of the tab is recorded as unknown and shares the limit of what the page reports (row W7; owner decision on #37)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const P = require('../shared/payload.js');
  const rec = newRec();
  const nav = (i) => R.cleanStep({ type: 'navigate', pageUrl: `${BETA}?p=${i}`, source: 'unknown' }, rec, settings, { tabUrl: BETA });
  const person = R.cleanStep({ type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK' } }, rec, settings, { tabUrl: BETA });
  assert.equal(nav(0).source, 'unknown');
  assert.equal(person.source, 'user');
  assert.ok(R.appendStep(rec, person));
  for (let i = 0; i < LIMITS.agentSteps; i += 1) assert.ok(R.appendStep(rec, nav(i)));
  const tool = R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, rec, settings, { tabUrl: BETA });
  assert.equal(R.appendStep(rec, tool), false, 'navigations and reports share the limit');
  assert.equal(R.appendStep(rec, nav(999)), false);
  assert.equal(rec.steps[0], person);
  const payload = P.buildPayload({ ...rec, id: 'rec-nav', webmcpTools: {} }, { generator: 'none', markdown: '' }, {});
  assert.deepEqual(P.checkPayload(payload), []);
});

test('the limit is a site\'s own: what one page can add does not depend on the other sites (rows W7, W8; owner decision on #37)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const OTHER = 'https://other.example.com/x';
  const count = (others) => {
    const rec = newRec();
    for (let i = 0; i < others; i += 1) R.appendStep(rec, R.cleanStep({ type: 'tool', pageUrl: OTHER, tool: 'x', ok: true }, rec, settings, { tabUrl: OTHER }));
    let added = 0;
    while (R.appendStep(rec, R.cleanStep({ type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, rec, settings, { tabUrl: BETA }))) added += 1;
    return added;
  };
  assert.equal(count(0), LIMITS.agentSteps);
  assert.equal(count(37), LIMITS.agentSteps);
});

test('a note written in the side panel is the person\'s (row W7; owner decision on #37)', () => {
  assert.equal(R.cleanStep({ type: 'note', note: 'メモ' }, newRec(), settings).source, 'user');
});

test('WebMCP names the asking site site-1 and its links after it, whatever the recording numbers them (row W8; review of #37 R12)', () => {
  const rec = newRec();
  const s = { ...settings, keywords: [] };
  const step = (pageUrl, href) => R.cleanStep({ type: 'click', pageUrl, target: { role: 'link', name: 'OK', ...(href && { href }) } }, rec, s, { tabUrl: pageUrl });
  rec.steps.push(step('https://first.example.com/a'), step('https://second.example.com/b', 'https://first.example.com/c'));
  const second = rec.steps[1];
  assert.equal(new URL(second.site).host, 'site-2.invalid');
  const status = R.webmcpReply(rec, s, second.site, 'status');
  assert.equal(status.site, 'https://site-1.invalid');
  const repro = R.webmcpReply(rec, s, second.site, 'reproduction');
  const text = repro.markdown + repro.gherkin;
  assert.ok(text.includes('https://site-1.invalid/b'), text);
  // first.example.com is the recording's site-1; to this page it is the next site its steps name.
  assert.ok(text.includes('https://site-2.invalid/c'), text);
  assert.ok(!text.includes('site-3.invalid'), text);
  // The step stored in the recording keeps its alias.
  assert.equal(new URL(S.renderRuns(second.url)).host, 'site-2.invalid');
});

test('WebMCP keeps an allowed asking site by name and numbers the other sites from site-1 (rows U4, W8; review of #37 R13)', () => {
  const s = { ...settings, keywords: [], hostAllowlist: ['allowed.example.com'] };
  const rec = { ...newRec(), policy: R.policyOf(s) };
  const step = (pageUrl, href) => R.cleanStep({ type: 'click', pageUrl, target: { role: 'link', name: 'OK', ...(href && { href }) } }, rec, s, { tabUrl: pageUrl });
  rec.steps.push(step('https://first.example.com/a'), step('https://second.example.com/b'), step('https://allowed.example.com/c', 'https://second.example.com/d'));
  const site = rec.steps[2].site;
  assert.equal(site, 'https://allowed.example.com');
  assert.equal(R.webmcpReply(rec, s, site, 'status').site, site);
  const repro = R.webmcpReply(rec, s, site, 'reproduction');
  const text = repro.markdown + repro.gherkin;
  assert.ok(text.includes('https://allowed.example.com/c'), text);
  // second.example.com is the recording's site-2; to this page it is the first alias its steps name.
  assert.ok(text.includes('https://site-1.invalid/d'), text);
  assert.ok(!text.includes('site-2.invalid'), text);
});

test('a step that is not recorded leaves the aliases and the redaction counts as they were (rows W7, M1; review of #37 R14)', () => {
  const { LIMITS } = require('../shared/limits.js');
  const s = { ...settings, keywords: [] };
  // A site at its own limit: one more tool call that redacts an email is not recorded.
  const rec = newRec();
  for (let i = 0; i < LIMITS.agentSteps; i += 1) assert.ok(addStep(rec, { type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, s, { tabUrl: BETA }));
  const before = JSON.stringify({ aliases: rec.aliases, redactions: rec.redactions, revision: rec.revision });
  assert.equal(addStep(rec, { type: 'tool', pageUrl: BETA, tool: 'x', ok: true, args: { to: 'someone@example.com' } }, s, { tabUrl: BETA }), null);
  assert.equal(JSON.stringify({ aliases: rec.aliases, redactions: rec.redactions, revision: rec.revision }), before);
  // A recording full of the person's steps: a navigation to a new site is not recorded, and names no site.
  const full = newRec();
  for (let i = 0; i < LIMITS.steps; i += 1) full.steps.push({ type: 'click', t: 0, env: 'standard', source: 'user' });
  const nav = addStep(full, { type: 'navigate', pageUrl: 'https://new.example.com/?q=a%20b', source: 'unknown' }, s, { tabUrl: 'https://new.example.com/' });
  // A navigation is not the person's: it does not push theirs out.
  assert.equal(nav, null);
  assert.deepEqual(full.aliases, {});
  assert.deepEqual(full.redactions, {});
  // A step that is recorded keeps what its cleaning added.
  const ok = newRec();
  assert.ok(addStep(ok, { type: 'navigate', pageUrl: 'https://new.example.com/', source: 'unknown' }, s, { tabUrl: 'https://new.example.com/' }));
  assert.equal(Object.keys(ok.aliases).length, 1);
});

const notice = (extra = {}) => ({ type: 'notice', pageUrl: BETA, notice: ['保存しました'], level: 'status', ...extra });

test('a notice is kept as what the page showed, its source unknown (rows T7, W7)', () => {
  const step = R.cleanStep(notice({ level: 'alert', source: 'user' }), newRec(), settings, { tabUrl: BETA });
  assert.deepEqual(step.notice, ['保存しました']);
  assert.equal(step.level, 'alert');
  assert.equal(step.source, 'unknown');
});

test('a notice is masked, one line and cut (row T7)', () => {
  const rec = newRec();
  const step = R.cleanStep(notice({ notice: [{ redacted: 'email' }, ' に\nb@example.com へ送信しました'] }), rec, settings, { tabUrl: BETA });
  assert.deepEqual(step.notice.map((p) => p.redacted || p), ['email', ' に ', 'email', ' へ送信しました']);
  assert.equal(rec.redactions.email, 2);
  const long = R.cleanStep(notice({ notice: ['あ'.repeat(500)] }), newRec(), settings, { tabUrl: BETA });
  assert.equal([...long.notice[0]].length, LIMITS.notice + 1);
});

test('no notice comes from a commercial page, whatever the content script sent (row T7)', () => {
  assert.equal(R.cleanStep(notice({ pageUrl: PROD }), newRec(), settings, { tabUrl: PROD }), null);
});

test('a notice needs a page, a text and a known level, and one naming a real host is not kept (rows T6, T7, K5)', () => {
  const rec = newRec();
  assert.equal(R.cleanStep(notice({ pageUrl: undefined }), rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep(notice({ notice: ['   '] }), rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep(notice({ notice: 'not runs' }), rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep(notice({ level: 'loud' }), rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep(notice({ notice: [`${new URL(BETA).hostname} に保存しました`] }), rec, settings, { tabUrl: BETA }), null);
});

test('notices count as what a page reports, so they never push out the person\'s steps (row W7)', () => {
  const rec = newRec();
  for (let i = 0; i <= LIMITS.agentSteps; i += 1) addStep(rec, notice({ notice: [`通知 ${i}`] }), settings, { tabUrl: BETA });
  assert.equal(rec.steps.length, LIMITS.agentSteps);
  assert.ok(addStep(rec, { type: 'click', pageUrl: BETA }, settings, { tabUrl: BETA }));
});

// ------------------------------------------------------------- ADR 0005 (v4)

const REF = /^E-[0-9a-z]{6}$/;
const panelNote = (rec, note, extra = {}) => addStep(rec, { type: 'note', note, ...extra }, settings);

test('the tester\'s expectation gets a random ref the worker draws, and no other step gets one (ADR 0005, T8)', () => {
  const rec = newRec();
  const expectation = panelNote(rec, '一覧が出る', { ref: 'E-aaaaaa' });
  assert.match(expectation.ref, REF);
  assert.notEqual(expectation.ref, 'E-aaaaaa', 'a ref that arrived is not used');
  assert.equal(panelNote(rec, '気になる', { kind: 'idea' }).ref, undefined);
  const page = addStep(rec, { type: 'note', note: 'ページの期待結果', source: 'agent', pageUrl: BETA }, settings, { tabUrl: BETA });
  assert.equal(page.ref, undefined);
  const click = addStep(rec, { type: 'click', pageUrl: BETA, target: { role: 'button', name: 'OK' }, ref: 'E-bbbbbb' }, settings, { tabUrl: BETA });
  assert.equal(click.ref, undefined);
});

test('a ref a step of the recording already has is drawn again (ADR 0005)', () => {
  const rec = newRec();
  rec.steps.push({ type: 'note', t: 0, env: 'standard', source: 'user', note: ['x'], ref: 'E-000000' });
  // Bytes 0 six times give E-000000, which the recording has; then bytes 1 give E-111111.
  const bytes = [...Array(6).fill(0), ...Array(6).fill(1)];
  const original = crypto.getRandomValues;
  crypto.getRandomValues = (array) => { array[0] = bytes.shift(); return array; };
  try {
    assert.equal(panelNote(rec, '二つ目').ref, 'E-111111');
  } finally {
    crypto.getRandomValues = original;
  }
});

test('trimmed marks what a limit kept out: other for the page\'s steps, user for the person\'s, only ever stronger (ADR 0005, M5)', () => {
  const step = (source, extra = {}) => ({ type: source === 'user' ? 'click' : 'tool', t: 0, env: 'standard', source, site: 'https://beta.example.com', ...(source === 'user' ? {} : { tool: ['x'], ok: true }), ...extra });
  // A site at its own limit: the next tool call is refused, and the recording says so.
  const site = newRec();
  for (let i = 0; i < LIMITS.agentSteps; i += 1) assert.ok(R.appendStep(site, step('agent')));
  assert.equal(site.trimmed, undefined);
  assert.equal(R.appendStep(site, step('agent')), false);
  assert.equal(site.trimmed, 'other');
  // At the step limit, the page's step goes first: other.
  const mixed = newRec();
  mixed.steps.push(step('agent', { site: 'https://a.example.com' }));
  for (let i = 1; i < LIMITS.steps; i += 1) mixed.steps.push(step('user'));
  assert.ok(R.appendStep(mixed, step('user')));
  assert.equal(mixed.trimmed, 'other');
  // With only the person's steps, the oldest of them goes: user, and it stays user.
  assert.ok(R.appendStep(mixed, step('user')));
  assert.equal(mixed.trimmed, 'user');
  const revision = mixed.revision;
  assert.equal(R.appendStep(mixed, step('agent', { site: 'https://c.example.com' })), false, 'a reported step does not push the person\'s out');
  assert.equal(mixed.trimmed, 'user', 'never weaker');
  assert.equal(mixed.revision, revision, 'a refused step leaves the revision');
  // fitRecord's correction of a site past its limit: other.
  const old = newRec();
  for (let i = 0; i <= LIMITS.agentSteps; i += 1) old.steps.push(step('agent'));
  R.fitRecord(old);
  assert.equal(old.trimmed, 'other');
});

test('the storage share drops steps with their mark and still fits once marked (ADR 0005, M5; review R41)', () => {
  const big = (source, i) => ({ type: 'note', t: i, env: 'standard', source, note: [`${'\u0001'.repeat(LIMITS.note)}…`], ...(source === 'agent' ? { url: [BETA], site: `https://s${i}.example.com` } : {}) });
  // The new step itself too large for the room: it goes, and it was the person's.
  const alone = newRec();
  assert.equal(R.appendStep(alone, { type: 'note', t: 0, env: 'standard', source: 'user', note: '\u0001'.repeat(LIMITS.storeBytes / 4) }), false);
  assert.equal(alone.trimmed, 'user');
  // Past the share with the page's steps to give way: they go first, and the mark is other.
  const rec = newRec();
  // Measured on the smaller kind, so the steps are surely past the share.
  const per = new TextEncoder().encode(JSON.stringify(big('user', 0))).length;
  const count = Math.ceil(LIMITS.storeBytes / per) + 2;
  for (let i = 0; i < count; i += 1) rec.steps.push(big(i % 2 ? 'agent' : 'user', i));
  R.fitRecord(rec);
  assert.ok(new TextEncoder().encode(JSON.stringify(rec)).length <= LIMITS.storeBytes);
  assert.equal(rec.trimmed, 'other');
  // A recording that fits is not marked, and loses nothing.
  const small = newRec();
  small.steps.push(big('user', 0));
  R.fitRecord(small);
  assert.equal(small.trimmed, undefined);
  assert.equal(small.steps.length, 1);
});

test('a step that is not a step or is not kept does not mark the recording trimmed (ADR 0005, M5)', () => {
  const rec = newRec();
  assert.equal(addStep(rec, { type: 'scroll' }, settings), null);
  assert.equal(addStep(rec, { type: 'navigate', pageUrl: BETA, source: 'unknown' }, settings, { tabUrl: BETA }, () => false), null);
  assert.equal(rec.trimmed, undefined);
});

test('setVerdict updates an expectation by the recording id and its ref, and says why when it does not (ADR 0005)', () => {
  const rec = { ...newRec(), id: 'rec-a', revision: 3 };
  const first = panelNote(rec, '一覧が出る');
  const second = panelNote(rec, '件数が出る');
  const set = (update) => R.setVerdict(rec, { recordingId: 'rec-a', ...update }, settings);
  assert.deepEqual(R.setVerdict(rec, { recordingId: 'rec-b', ref: first.ref, verdict: 'ok' }, settings), { ok: false, reason: 'OTHER_RECORDING' });
  assert.deepEqual(set({ ref: 'E-zzzzzz', verdict: 'ok' }), { ok: false, reason: 'NO_REF' });
  assert.deepEqual(set({ ref: first.ref }), { ok: false, reason: 'BAD_VERDICT' }, 'a verdict left out is not "not judged"');
  assert.deepEqual(set({ ref: first.ref, verdict: 'maybe' }), { ok: false, reason: 'BAD_VERDICT' });
  // NG needs an actual result with text in it once masked.
  assert.deepEqual(set({ ref: first.ref, verdict: 'ng', actual: '   ' }), { ok: false, reason: 'NO_ACTUAL' });
  assert.equal(first.verdict, undefined);
  assert.deepEqual(set({ ref: first.ref, verdict: 'ng', actual: 'Acme の一覧が空になる' }), { ok: true });
  assert.equal(first.verdict, 'ng');
  assert.ok(show(first.actual).endsWith(' の一覧が空になる'), show(first.actual));
  assert.ok(!show(first.actual).includes('Acme'), 'masked like a note');
  assert.equal(rec.redactions.keyword, 1, 'counted');
  // An NG without an actual result leaves the earlier NG and its actual result.
  const before = structuredClone(first.actual);
  assert.deepEqual(set({ ref: first.ref, verdict: 'ng' }), { ok: false, reason: 'NO_ACTUAL' });
  assert.deepEqual(first.actual, before);
  // OK and not judged clear the actual result; the later of two updates stays.
  assert.deepEqual(set({ ref: first.ref, verdict: 'ok' }), { ok: true });
  assert.equal(first.verdict, 'ok');
  assert.equal(first.actual, undefined);
  assert.deepEqual(set({ ref: first.ref, verdict: null }), { ok: true });
  assert.equal(first.verdict, undefined);
  // privacy.redactions is a running total of what was masked: clearing the actual result does not lower it.
  assert.equal(rec.redactions.keyword, 1);
  set({ ref: second.ref, verdict: 'ng', actual: 'A' });
  set({ ref: second.ref, verdict: 'ng', actual: 'B' });
  assert.equal(show(second.actual), 'B');
  // A verdict is not a change to the steps: a draft made before is not stale for it.
  assert.equal(rec.revision, 3 + 2);
});

test('a verdict is only for the tester\'s expectation, never a page\'s or an exploration note (ADR 0005, W7)', () => {
  const rec = { ...newRec(), id: 'rec-a' };
  const idea = panelNote(rec, '気になる', { kind: 'idea' });
  idea.ref = 'E-111111';
  assert.deepEqual(R.setVerdict(rec, { recordingId: 'rec-a', ref: 'E-111111', verdict: 'ok' }, settings), { ok: false, reason: 'NO_REF' });
});

test('the recording\'s own texts are masked like a note, cut, counted, and not kept when empty (ADR 0005, T1)', () => {
  const rec = newRec();
  R.setRecordingText(rec, 'scope', 'Acme の検索画面', settings);
  assert.ok(!show(rec.scope).includes('Acme'));
  assert.equal(rec.redactions.keyword, 1);
  R.setRecordingText(rec, 'targetVersion', 'v'.repeat(200), settings);
  assert.equal([...show(rec.targetVersion)].length, LIMITS.targetVersion + 1);
  R.setRecordingText(rec, 'notTested', '  ', settings);
  assert.equal(rec.notTested, undefined);
  R.setRecordingText(rec, 'tabId', 'x', settings);
  assert.equal(rec.tabId, undefined, 'only the three texts');
});

test('the end of a recording is never before its start, whatever the clock did (ADR 0005)', () => {
  const rec = { startedAt: 2000 };
  assert.equal(R.endAt(rec, 1000), 2000);
  assert.equal(R.endAt(rec, 3000), 3000);
});

test('addStep says whether the recording changed: the step, or only its trimmed mark (ADR 0005)', () => {
  const rec = newRec();
  for (let i = 0; i < LIMITS.agentSteps; i += 1) assert.equal(R.addStep(rec, { type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, settings, { tabUrl: BETA }).changed, true);
  assert.deepEqual(R.addStep(rec, { type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, settings, { tabUrl: BETA }), { step: null, changed: true }, 'the first refusal marks it');
  assert.deepEqual(R.addStep(rec, { type: 'tool', pageUrl: BETA, tool: 'x', ok: true }, settings, { tabUrl: BETA }), { step: null, changed: false }, 'already marked');
  assert.deepEqual(R.addStep(rec, { type: 'scroll' }, settings), { step: null, changed: false });
});

test('a selector with a URL in it is dropped (T3, K4)', () => {
  const rec = { id: 'rec-s', steps: [], aliases: {}, redactions: {}, policy: R.policyOf({}) };
  const step = R.cleanStep({ type: 'click', target: { role: 'link', tag: 'a', name: 'x', selector: 'a[href="https://private.internal.test/orders"]' } }, rec, {}, { tabUrl: 'https://example.test/' });
  assert.equal(step.target.selector, undefined);
});

test('a step takes the tab number the worker gives it, and nothing that is not one (row T9; #40)', () => {
  const settings = { keywords: [] };
  const rec = { startedAt: Date.now(), aliases: {}, redactions: {}, steps: [], policy: { commercialHosts: [] } };
  const click = { type: 'click', pageUrl: 'https://example.com/', target: { role: 'button', name: 'OK' } };
  assert.equal(R.cleanStep(click, rec, settings, { tabUrl: 'https://example.com/', tab: 2 }).tab, 2);
  for (const tab of [undefined, 0, -1, 1.5, '2', null]) {
    assert.equal(R.cleanStep(click, rec, settings, { tabUrl: 'https://example.com/', tab }).tab, undefined, `tab ${JSON.stringify(tab)}`);
  }
  // The panel's note has no sender and no tab.
  assert.equal(R.cleanStep({ type: 'note', note: 'メモ' }, rec, settings).tab, undefined);
});

test('a WebMCP reply numbers the tabs by the order the steps of its site name them, like the aliases (rows W8, T9; #40)', () => {
  const rec = newRec();
  const settings2 = { ...settings, keywords: [] };
  const at = (tab, url) => R.cleanStep({ type: 'click', pageUrl: url, target: { role: 'button', name: 'OK' } }, rec, settings2, { tabUrl: url, tab });
  // The site's steps happened in the recording's tabs 3 and 1; another site's step in tab 2 is not its business.
  rec.steps.push(at(3, `${BETA}/a`), at(2, `${PROD}/b`), at(1, `${BETA}/c`), at(3, `${BETA}/d`));
  const site = rec.steps[0].site;
  const reply = R.webmcpReply(rec, settings2, site, 'reproduction');
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.steps, 3);
  // Tabs 3, 1, 3 of the recording are this site's tabs 1, 2, 1.
  const switches = reply.gherkin.split('\n').filter((l) => /切り替える/.test(l)).map((l) => l.trim().replace(/^(When|And) /, ''));
  assert.deepEqual(switches, ['タブ 2 に切り替える', 'タブ 1 に切り替える'], reply.gherkin);
  assert.ok(!/タブ 3/.test(reply.gherkin) && !/タブ 3/.test(reply.markdown), reply.markdown);
  // The recording itself keeps the numbers of the whole recording.
  assert.deepEqual(rec.steps.map((s) => s.tab), [3, 2, 1, 3]);
});
