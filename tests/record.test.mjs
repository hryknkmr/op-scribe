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

const input = (value, extra = {}) => ({ type: 'input', pageUrl: PROD, target: { role: 'textbox', tag: 'input', name: '本文' }, value, ...extra });

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
    assert.equal(R.cleanStep(input(typed.kept('secret', 'hunter2')), rec, settings, { tabUrl }).value.treatment, 'redacted');
    assert.equal(R.cleanStep(input(typed.kept('pii', 'Taro')), rec, settings, { tabUrl }).value.treatment, 'redacted');
    // Even empty: no exception to the rows (R1).
    assert.equal(R.cleanStep(input(typed.kept('secret', '')), rec, settings, { tabUrl }).value.treatment, 'redacted');
  }
});

test('anything that is not a well-formed typed value is redacted (row E2)', () => {
  const rec = newRec();
  for (const value of ['plain text', 42, null, { text: 'x' }, { treatment: 'other', text: 'x' }, { treatment: 'length', length: -1 }]) {
    assert.equal(R.cleanStep(input(value), rec, settings, { tabUrl: BETA }).value.treatment, 'redacted', JSON.stringify(value));
  }
  assert.ok(rec.redactions.v >= 6);
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
  assert.deepEqual(step.args.list.phone, [
    { treatment: 'redacted', field: 'arg', kind: 'phone' },
    { treatment: 'redacted', field: 'arg', kind: 'phone' }
  ]);
  assert.deepEqual(step.args.q, typed.kept('arg', 'shoes'));
});

test('steps without what they must carry are not recorded (row T6; review R1)', () => {
  const rec = newRec();
  assert.equal(R.cleanStep({ type: 'input', pageUrl: BETA }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ type: 'navigate' }, rec, settings, { tabUrl: BETA }), null);
  assert.equal(R.cleanStep({ type: 'note' }, rec, settings), null);
  const upload = R.cleanStep({ type: 'upload', pageUrl: BETA, value: typed.kept('text', 'a.txt') }, rec, settings, { tabUrl: BETA });
  assert.deepEqual(upload.value, typed.file(0));
});
