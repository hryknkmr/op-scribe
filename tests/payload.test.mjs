// The one payload definition (shared/payload.js) and its ties to ADR 0003.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const D = require('../shared/describe.js');
const P = require('../shared/payload.js');

const { typed } = S;

/**
 * The payload holds kept text and URLs as runs (#28). These tests write them
 * rendered, as strings; runsOf reads [[kind]] and [[url:x]] back into masked parts.
 */
const runsOf = (text) => String(text).split(/(\[\[[a-z]+(?::[a-z][a-z0-9+.-]*)?\]\])/).filter(Boolean).map((p) => {
  const m = /^\[\[([a-z]+)(?::(.+))?\]\]$/.exec(p);
  if (!m) return p;
  return m[1] === 'url' ? { redacted: 'url', as: m[2] } : { redacted: m[1] };
});
const fixTyped = (v) => {
  if (Array.isArray(v)) v.forEach(fixTyped);
  else if (v && typeof v === 'object') {
    if (v.treatment === 'kept' && typeof v.text === 'string') v.text = runsOf(v.text);
    else if (typeof v.treatment !== 'string') Object.values(v).forEach(fixTyped);
  }
};
/** A recording (or a payload's recording) with every string field that is runs made runs, in place. */
function withRuns(r) {
  if (typeof r.startUrl === 'string') r.startUrl = runsOf(r.startUrl);
  for (const step of r.steps || []) {
    for (const f of ['url', 'tool', 'note', 'actual']) if (typeof step[f] === 'string') step[f] = runsOf(step[f]);
    if (step.target) for (const f of ['name', 'href']) if (typeof step.target[f] === 'string') step.target[f] = runsOf(step.target[f]);
    fixTyped(step.value);
    fixTyped(step.args);
  }
  if (Array.isArray(r.webmcpTools)) {
    r.webmcpTools.forEach((w) => {
      if (typeof w.site === 'string') w.site = [w.site];
      w.tools = w.tools.map((t) => (typeof t === 'string' ? runsOf(t) : t));
    });
  }
  else if (r.webmcpTools) for (const site of Object.keys(r.webmcpTools)) r.webmcpTools[site] = r.webmcpTools[site].map((t) => (typeof t === 'string' ? runsOf(t) : t));
  if (r.environment) for (const k of Object.keys(r.environment)) if (typeof r.environment[k] === 'string') r.environment[k] = runsOf(r.environment[k]);
  for (const f of ['scope', 'targetVersion', 'notTested']) if (typeof r[f] === 'string') r[f] = runsOf(r[f]);
  return r;
}
const show = (runs) => S.renderRuns(runs);

const rec = {
  id: 'rec-test-1',
  state: 'stopped',
  tabId: 7,
  startedAt: Date.UTC(2026, 9, 29, 1, 0, 0),
  endedAt: Date.UTC(2026, 9, 29, 1, 2, 0),
  startUrl: 'https://site-1.invalid/',
  policy: { commercialHosts: ['shop.corp.invalid'], hostAllowlist: [] },
  aliases: { 'https://intranet.corp.invalid': 'site-1.invalid' },
  grantedPatterns: ['https://intranet.corp.invalid/*'],
  redactions: { text: 1, secret: 1 },
  webmcpTools: { 'https://site-1.invalid': ['search_catalog'] },
  steps: [
    { type: 'navigate', t: 0, env: 'commercial', source: 'unknown', url: 'https://site-1.invalid/' },
    { type: 'input', t: 1000, env: 'commercial', source: 'user', url: 'https://site-1.invalid/',
      target: { role: 'textbox', tag: 'input', name: 'パスワード' }, value: typed.redacted('secret', 'secret') },
    { type: 'input', t: 2000, env: 'commercial', source: 'user', url: 'https://site-1.invalid/',
      target: { role: 'searchbox', name: '検索' }, value: typed.kept('search', '週末') },
    { type: 'input', t: 3000, env: 'commercial', source: 'user', url: 'https://site-1.invalid/',
      target: { role: 'textbox', name: '本文' }, value: { treatment: 'length', field: 'text', kind: 'text', length: 5 } },
    { type: 'tool', t: 4000, env: 'commercial', source: 'agent', tool: 'search_catalog', ok: true,
      args: { q: { treatment: 'length', field: 'arg', kind: 'text', length: 3 }, all: true } },
    { type: 'note', t: 5000, env: 'commercial', source: 'user', note: '結果が出る', ref: 'E-a1b2c3' }
  ]
};

const env = { browser: ['Chrome 141'], platform: ['macOS'], language: ['ja'], userAgent: 'should not be copied' };
const clone = (v) => JSON.parse(JSON.stringify(v));
const build = (r = rec, markdown = '') => P.buildPayload(withRuns(clone(r)), { generator: 'template', markdown }, env);

test('buildPayload carries no local-only state and passes both exit checks', () => {
  const payload = build(rec, D.toMarkdown(D.buildReproduction(withRuns(clone(rec)))));
  const json = JSON.stringify(payload);
  for (const leak of ['tabId', 'aliases', 'grantedPatterns', 'intranet.corp.invalid', 'shop.corp.invalid', 'userAgent', 'commercialHosts']) {
    assert.ok(!json.includes(leak), `payload contains ${leak}`);
  }
  assert.equal(payload.schema, 'op-scribe.recording/v4');
  assert.deepEqual(payload.privacy, { policy: 'commercial-strict/1', coverage: 'commercial', hostsAliased: 1, redactions: { text: 1, secret: 1 } });
  assert.deepEqual(P.checkPayload(payload), []);
  assert.deepEqual(S.finalScan(payload, { keywords: ['intranet.corp.invalid'] }), []);
});

test('buildPayload always rebuilds the Gherkin from the recording (row E3)', () => {
  const payload = P.buildPayload(rec, { generator: 'manual', markdown: '', gherkin: 'hand edited' }, env);
  assert.equal(payload.reproduction.gherkin, D.toGherkin(rec));
  assert.match(payload.reproduction.gherkin, /^Feature: /m);
});

test('every field of the payload definition names a row of ADR 0003 (row E1)', () => {
  const adr = readFileSync(new URL('../docs/adr/0003-privacy-guarantee-matrix.md', import.meta.url), 'utf8');
  const rows = new Set([...adr.matchAll(/^\| ([A-Z]\d+) \|/gm)].map((m) => m[1]));
  assert.ok(rows.size > 30, `found ${rows.size} rows`);
  const expand = (row) => {
    const range = /^([A-Z])(\d+)-\1(\d+)$/.exec(row);
    if (!range) return [row];
    return Array.from({ length: Number(range[3]) - Number(range[2]) + 1 }, (_, i) => `${range[1]}${Number(range[2]) + i}`);
  };
  for (const { path, row } of P.shapeRows()) {
    assert.ok(row, `${path} has no row`);
    for (const id of expand(row)) assert.ok(rows.has(id), `${path} names ${id}, which is not in ADR 0003`);
  }
});

test('checkPayload rejects fields and types that are not in the definition (row E1)', () => {
  const cases = [
    (p) => { p.recording.tabId = 7; },
    (p) => { p.recording.steps[0].pageTitle = 'x'; },
    (p) => { p.recording.steps[0].type = 'scroll'; },
    (p) => { p.recording.steps[0].env = 'beta'; },
    (p) => { p.recording.steps[1].target.role = 'Button <b>'; },
    (p) => { p.recording.steps[0].n = 3; },
    (p) => { p.privacy.policy = 'none'; },
    (p) => { p.recording.id = 'rec-<script>'; },
    (p) => { p.reproduction.generator = 'gpt'; },
    (p) => { p.privacy.redactions.Text = 1; }
  ];
  for (const change of cases) {
    const payload = clone(build());
    change(payload);
    assert.notDeepEqual(P.checkPayload(payload), [], change.toString());
  }
});

test('checkPayload checks the treatment of each typed value (row E2)', () => {
  const kept = (field, text) => ({ treatment: 'kept', field, text: runsOf(text) });
  const cases = [
    [2, kept('text', 'raw text')], // commercial free text kept
    [1, kept('secret', 'hunter2')], // secret kept
    [1, { treatment: 'length', field: 'secret', kind: 'secret', length: 7 }],
    [2, kept('pii', 'Taro')],
    [2, '[[secret]]'], // a v1 placeholder string is not a typed value
    [2, { treatment: 'redacted', field: 'text', kind: 'v', text: 'leak' }], // extra field
    [2, { treatment: 'kept', field: 'search', text: 'x'.repeat(200) }]
  ];
  for (const [index, value] of cases) {
    const payload = clone(build());
    payload.recording.steps[index].value = value;
    payload.reproduction.gherkin = D.toGherkin(payload.recording);
    assert.notDeepEqual(P.checkPayload(payload), [], JSON.stringify(value));
  }
});

test('checkPayload checks WebMCP arguments (rows W2-W5)', () => {
  const cases = [
    { q: 'raw string' },
    { q: { treatment: 'kept', field: 'arg', text: 'shoes' } }, // commercial
    { n: { treatment: 'kept', field: 'arg', number: 3 } }, // commercial
    { a: { b: { c: { d: true } } } },
    { list: Array.from({ length: 11 }, () => true) }
  ];
  for (const args of cases) {
    const payload = clone(build());
    payload.recording.steps[4].args = args;
    payload.reproduction.gherkin = D.toGherkin(payload.recording);
    assert.notDeepEqual(P.checkPayload(payload), [], JSON.stringify(args));
  }
});

test('checkPayload accepts kept text in standard steps, and checks coverage and the Gherkin (rows E2, E3, M1)', () => {
  const standard = clone(rec);
  for (const step of standard.steps) step.env = 'standard';
  standard.steps[3].value = { treatment: 'kept', field: 'text', text: '本文です' };
  standard.steps[4].args.q = { treatment: 'kept', field: 'arg', text: 'shoes' };
  const payload = build(standard);
  assert.equal(payload.privacy.coverage, 'standard');
  assert.deepEqual(P.checkPayload(payload), []);

  const wrongCoverage = clone(payload);
  wrongCoverage.privacy.coverage = 'commercial';
  assert.deepEqual(P.checkPayload(wrongCoverage).map((p) => p.path), ['privacy.coverage']);

  const edited = clone(payload);
  edited.reproduction.gherkin += '\n# extra';
  assert.deepEqual(P.checkPayload(edited).map((p) => p.path), ['reproduction.gherkin']);
});

test('checkPayload is independent of the masking: it never calls shared/sanitize.js', () => {
  const source = readFileSync(new URL('../shared/payload.js', import.meta.url), 'utf8');
  assert.ok(!/OpScribeSanitize|sanitize\.js'\)/.test(source));
});

const regen = (p) => { withRuns(p.recording); p.reproduction.gherkin = D.toGherkin(p.recording); return p; };

test('checkPayload checks the form of every URL value (rows U1-U4, U7, U8; review R1)', () => {
  const cases = [
    (p) => { p.recording.startUrl = 'javascript:alert(1)'; },
    (p) => { p.recording.steps[0].url = 'not a url'; },
    (p) => { p.recording.steps[0].url = 'https://name:pw@site-1.invalid/'; },
    (p) => { p.recording.steps[0].url = 'https://site-1.invalid/?q=hello'; }, // commercial query kept
    (p) => { p.recording.steps[0].url = 'https://site-1.invalid/#/route'; }, // commercial fragment kept
    (p) => { p.recording.steps[1].target.href = 'data:text/html,x'; },
    (p) => { p.recording.webmcpTools[0].site = 'https://site-1.invalid/path?x=1'; }
  ];
  for (const change of cases) {
    const payload = clone(build());
    change(payload);
    assert.notDeepEqual(P.checkPayload(regen(payload)), [], change.toString());
  }
  const ok = clone(build());
  ok.recording.steps[0].url = 'https://site-1.invalid/?q=[[v]]';
  ok.recording.startUrl = ok.recording.steps[0].url;
  ok.recording.steps[1].url = '[[url:invalid]]';
  assert.deepEqual(P.checkPayload(regen(ok)), []);
});

test('checkPayload checks what each kind of step must and may carry (row T6; review R1)', () => {
  const cases = [
    (p) => { delete p.recording.steps[1].value; }, // input without a value
    (p) => { p.recording.steps[0].value = { treatment: 'kept', field: 'text', text: '' }; }, // navigate with a value
    (p) => { delete p.recording.steps[0].url; }, // navigate without a URL
    (p) => { p.recording.steps[5].checked = true; }, // note with checked
    (p) => { p.recording.steps[4].source = 'user'; }, // tool not from agent
    (p) => { p.recording.steps[1].value = { treatment: 'redacted', field: 'file', kind: 'file', count: 1 }; } // file outside upload
  ];
  for (const change of cases) {
    const payload = clone(build());
    change(payload);
    assert.notDeepEqual(P.checkPayload(regen(payload)), [], change.toString());
  }
});

test('checkPayload: an empty secret or personal value is not kept either (rows I2-I4; review R1)', () => {
  for (const field of ['secret', 'pii']) {
    const payload = clone(build());
    payload.recording.steps[1].value = { treatment: 'kept', field, text: '' };
    assert.notDeepEqual(P.checkPayload(regen(payload)), [], field);
  }
});

test('checkPayload: standard URLs keep only the allowed forms, and key steps carry a valid key (rows U7, U8, T5; review R2)', () => {
  const standardRec = clone(rec);
  for (const step of standardRec.steps) step.env = 'standard';
  const base = () => clone(build(standardRec));
  const cases = [
    (p) => { p.recording.steps[0].url = 'https://site-1.invalid/?token=abc%20def'; },
    (p) => { p.recording.steps[0].url = 'https://site-1.invalid/#customer-secret'; },
    (p) => { p.recording.steps[0].url = `https://site-1.invalid/?q=${'a'.repeat(25)}`; },
    (p) => { p.recording.steps.push({ n: p.recording.steps.length + 1, type: 'key', t: 9, env: 'standard', source: 'user' }); },
    (p) => { p.recording.steps.push({ n: p.recording.steps.length + 1, type: 'key', t: 9, env: 'standard', source: 'user', key: 'ctrl+ctrl+Enter' }); }
  ];
  for (const change of cases) {
    const payload = base();
    change(payload);
    assert.notDeepEqual(P.checkPayload(regen(payload)), [], change.toString());
  }
  const ok = base();
  ok.recording.steps[0].url = 'https://site-1.invalid/?tab=items&q=[[v]]#/settings';
  ok.recording.startUrl = ok.recording.steps[0].url;
  assert.deepEqual(P.checkPayload(regen(ok)), []);
});

test('checkPayload: prototype names are not fields, dates must exist, commercial empty text is not kept (rows E1, M2, I8; review R3)', () => {
  const cases = [
    (p) => { p.constructor = 'benign'; },
    (p) => { p.recording.toString = 'x'; },
    (p) => { p.recording.startedAt = '2026-99-99T99:99:99.999Z'; },
    (p) => { p.recording.steps[3].value = { treatment: 'kept', field: 'text', text: '' }; }
  ];
  for (const change of cases) {
    const payload = clone(build());
    change(payload);
    assert.notDeepEqual(P.checkPayload(regen(payload)), [], change.toString());
  }
});

test('checkPayload: kept numbers stay in range, and the start URL is a step URL judged by that step (rows W3, U7; review R4)', () => {
  const standardRec = clone(rec);
  for (const step of standardRec.steps) step.env = 'standard';
  const big = clone(build(standardRec));
  big.recording.steps[4].args.q = { treatment: 'kept', field: 'arg', number: 1e100 };
  assert.notDeepEqual(P.checkPayload(regen(big)), []);

  const orphan = clone(build());
  orphan.recording.startUrl = 'https://site-1.invalid/?q=leak';
  assert.notDeepEqual(P.checkPayload(regen(orphan)), []);

  // With the first navigation deleted, the payload's start URL becomes another step's URL.
  const deleted = clone(rec);
  deleted.startUrl = 'https://site-1.invalid/?q=leak';
  const payload = build(deleted);
  assert.equal(show(payload.recording.startUrl), 'https://site-1.invalid/');
  assert.deepEqual(P.checkPayload(payload), []);
  const empty = build({ ...clone(rec), steps: [] });
  assert.deepEqual(empty.recording.startUrl, [{ redacted: 'url', as: 'none' }]);
  assert.deepEqual(P.checkPayload(empty), []);
});

test('what the masking cuts, the check accepts: a 41-character argument key (rows W5, E1; review R5)', () => {
  const S2 = require('../shared/sanitize.js');
  const standardRec = clone(rec);
  for (const step of standardRec.steps) step.env = 'standard';
  standardRec.steps[4].args = S2.maskArgs({ ['k'.repeat(60)]: 'x' }, { env: 'standard' });
  assert.equal([...Object.keys(standardRec.steps[4].args)[0]].length, 41);
  assert.deepEqual(P.checkPayload(build(standardRec)), []);
});

test('checkPayload bounds typed lengths and file counts like the masking does (row E2; review new R1)', () => {
  const big = clone(build());
  big.recording.steps[3].value = { treatment: 'length', field: 'text', kind: 'text', length: Number.MAX_SAFE_INTEGER };
  assert.notDeepEqual(P.checkPayload(regen(big)), []);
  const files = clone(build());
  files.recording.steps.push({ n: files.recording.steps.length + 1, type: 'upload', t: 9, env: 'commercial', source: 'user',
    value: { treatment: 'redacted', field: 'file', kind: 'file', count: Number.MAX_SAFE_INTEGER } });
  assert.notDeepEqual(P.checkPayload(regen(files)), []);
});

test('an argument tree far too deep is refused without rendering it (rows E1, E3; review new R2)', () => {
  const payload = clone(build());
  let deep = true;
  for (let i = 0; i < 20000; i += 1) deep = { d: deep };
  payload.recording.steps[4].args = deep;
  let problems;
  assert.doesNotThrow(() => { problems = P.checkPayload(payload); });
  assert.ok(problems.some((p) => p.problem === 'too deep'));
});

test('the largest recording the limits allow, with the worst characters, passes and fits the totals (rows E1, E3, E4; review R13)', () => {
  const { LIMITS, TOTALS } = require('../shared/limits.js');
  // Characters that escapes make longest: a control character (\u0001 in JSON), a quote,
  // a backslash and a pipe (doubled again in a Gherkin cell). Names, notes and argument keys are one line.
  const worst = (n, control = true) => Array.from({ length: n }, (_, i) => (control ? '\u0001"\\|' : '"\\|')[i % (control ? 4 : 3)]).join('');
  const url = `https://site-1.invalid/${'a/'.repeat(LIMITS.url)}`.slice(0, LIMITS.url);
  const args = Object.fromEntries(Array.from({ length: LIMITS.argLeaves }, (_, i) => [
    `${String(i).padStart(2, '0')}${worst(LIMITS.argKey - 2, false)}…`,
    { treatment: 'kept', field: 'arg', text: `${worst(LIMITS.kept.arg)}…` }
  ]));
  const kinds = [
    (i) => ({ type: 'tool', t: i, env: 'standard', source: 'agent', url, tool: `${worst(LIMITS.tool, false)}…`, ok: true, args }),
    (i) => ({ type: 'click', t: i, env: 'standard', source: 'user', url,
      target: { role: 'button', tag: 'button', name: `${worst(LIMITS.name, false)}…`, selector: worst(LIMITS.selector, false), href: url } }),
    (i) => ({ type: 'input', t: i, env: 'standard', source: 'user', url, target: { role: 'textbox', name: `${worst(LIMITS.name, false)}…` },
      value: { treatment: 'kept', field: 'text', text: `${worst(LIMITS.kept.text)}…` } }),
    // The tester's expectation with every field v4 gives it (ADR 0005): an NG with its actual result.
    (i) => ({ type: 'note', t: i, env: 'standard', source: 'user', note: `${worst(LIMITS.note, false)}…`,
      ref: `E-${i.toString(36).padStart(6, '0')}`, verdict: 'ng', actual: `${worst(LIMITS.actual, false)}…` }),
    (i) => ({ type: 'note', t: i, env: 'standard', source: 'user', note: `${worst(LIMITS.note, false)}…`, kind: 'next' })
  ];
  const steps = Array.from({ length: LIMITS.steps }, (_, i) => kinds[i % kinds.length](i));
  const big = withRuns({ ...clone(rec), startUrl: url, steps, webmcpTools: {}, trimmed: 'other',
    scope: `${worst(LIMITS.scope, false)}…`, targetVersion: `${worst(LIMITS.targetVersion, false)}…`, notTested: `${worst(LIMITS.notTested, false)}…` });
  const markdown = D.toMarkdown(D.buildReproduction(big));
  assert.ok([...markdown].length <= TOTALS.markdown, `markdown ${markdown.length} > ${TOTALS.markdown}`);
  const payload = P.buildPayload(big, { generator: 'template', markdown }, {});
  assert.ok([...payload.reproduction.gherkin].length <= TOTALS.gherkin, `gherkin ${payload.reproduction.gherkin.length} > ${TOTALS.gherkin}`);
  assert.deepEqual(P.checkPayload(payload), []);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(bytes <= TOTALS.payloadBytes, `${bytes} > ${TOTALS.payloadBytes}`);
});

test('a panel note takes its environment from the recording when the payload is built (M1, E2; review R12)', () => {
  const note = { type: 'note', t: 1, env: 'standard', source: 'user', note: 'メモ', ref: 'E-000001' };
  const r = { ...clone(rec), steps: [
    { type: 'navigate', t: 0, env: 'standard', source: 'unknown', url: 'https://site-2.invalid/' },
    note,
    { type: 'navigate', t: 2, env: 'commercial', source: 'unknown', url: 'https://site-1.invalid/' }
  ] };
  const payload = build(r);
  assert.equal(payload.recording.steps[1].env, 'commercial');
  assert.deepEqual(P.checkPayload(payload), []);
  // With the standard step deleted, the recording is commercial only.
  const onlyCommercial = build({ ...r, steps: r.steps.slice(1) });
  assert.equal(onlyCommercial.privacy.coverage, 'commercial');
  assert.deepEqual(P.checkPayload(onlyCommercial), []);
  // A note left standard in a commercial recording is refused.
  const stale = clone(payload);
  stale.recording.steps[1].env = 'standard';
  stale.privacy.coverage = 'mixed';
  assert.ok(P.checkPayload(regen(stale)).some((p) => p.problem === 'panel note environment'));
});

test('a value longer than its limit passes only with the "…" the cut appends (row E2; review R13)', () => {
  const standardRec = clone(rec);
  for (const step of standardRec.steps) step.env = 'standard';
  const cases = [
    (p) => { p.recording.steps[2].value = { treatment: 'kept', field: 'search', text: 'a'.repeat(121) }; },
    (p) => { p.recording.steps[1].target.name = 'n'.repeat(81); },
    (p) => { p.recording.steps[5].note = 'm'.repeat(301); }
  ];
  for (const change of cases) {
    const payload = clone(build(standardRec));
    change(payload);
    assert.notDeepEqual(P.checkPayload(regen(payload)), [], change.toString());
  }
  const ok = clone(build(standardRec));
  ok.recording.steps[2].value = { treatment: 'kept', field: 'search', text: `${'a'.repeat(120)}…` };
  assert.deepEqual(P.checkPayload(regen(ok)), []);
});

test('privacy.redactions counts only the known kinds, within the limit (row M1; review R16)', () => {
  for (const change of [
    (p) => { p.privacy.redactions.made = 1; },
    (p) => { p.privacy.redactions.text = 1e10; }
  ]) {
    const payload = clone(build());
    change(payload);
    assert.notDeepEqual(P.checkPayload(payload), [], change.toString());
  }
});

test('only the typed values that may exist pass the check, and describe renders nothing else (E1-E3, TYPED_SCHEMA; review R20)', () => {
  const bad = [
    { treatment: 'redacted', field: 'text', kind: 'url' },
    { treatment: 'length', field: 'search', kind: 'text', length: 2 },
    { treatment: 'redacted', field: 'secret', kind: 'email' },
    { treatment: 'length', field: 'pii', kind: 'secret', length: 2 }
  ];
  for (const value of bad) {
    const r = clone(rec);
    r.steps[1].value = value;
    assert.ok(P.checkPayload(regen(build(r))).some((p) => p.problem === 'bad kind'), JSON.stringify(value));
    assert.equal(D.display(value), '[[v]]');
  }
  // What the masking makes still passes (nested and value are kinds of their own).
  const r = clone(rec);
  r.steps[4].args = { deep: typed.redacted('arg', 'nested'), fn: typed.redacted('arg', 'value') };
  assert.deepEqual(P.checkPayload(build(r)), []);
});

test('the environment is masked before it is cut, and a raw one too long is refused (M3; review R20)', () => {
  const browser = `${'x'.repeat(59)}Acme`;
  const masked = S.cleanLine(browser, { keywords: ['Acme'], maxLength: 60 }).runs;
  assert.ok(!show(masked).includes('A'), show(masked));
  assert.deepEqual(P.checkPayload(P.buildPayload(withRuns(clone(rec)), { generator: 'template', markdown: '' }, { browser: masked })), []);
  const raw = P.buildPayload(withRuns(clone(rec)), { generator: 'template', markdown: '' }, { browser: [browser] });
  assert.deepEqual(raw.recording.environment.browser, [browser], 'buildPayload never cuts');
  assert.ok(P.checkPayload(raw).some((p) => p.path === 'recording.environment.browser'));
});

test('a selector longer than its limit passes only with the cut mark (row T3; review R21)', () => {
  const r = clone(rec);
  r.steps[1].target.selector = `#${'a'.repeat(160)}`;
  assert.ok(P.checkPayload(regen(build(r))).some((p) => p.path.endsWith('.target.selector')));
  r.steps[1].target.selector = `#${'a'.repeat(159)}…`;
  assert.deepEqual(P.checkPayload(regen(build(r))), []);
});

test('a personal field keeps its length only in a commercial step (row E2, I4; review R22)', () => {
  const r = clone(rec);
  r.steps[1] = { ...r.steps[1], env: 'standard', value: { treatment: 'length', field: 'pii', kind: 'email', length: 12 } };
  r.steps.forEach((s) => { s.env = 'standard'; });
  assert.ok(P.checkPayload(regen(build(r))).some((p) => p.problem === 'standard personal value not redacted'));
  r.steps[1].value = typed.redacted('pii', 'email');
  assert.ok(!P.checkPayload(regen(build(r))).some((p) => p.path.startsWith('recording.steps[1]')));
});

test('the exits refuse what the masking cannot make: a personal card, a scheme that is not one, a key suffix below 2 (E1, E2; review R25)', () => {
  const card = clone(rec);
  card.steps[1].value = { treatment: 'length', field: 'pii', kind: 'card', length: 16 };
  assert.ok(P.checkPayload(regen(build(card))).some((p) => p.problem === 'bad kind'));

  const url = clone(rec);
  url.steps[0].url = '[[url:1]]';
  url.startUrl = '[[url:1]]';
  assert.ok(P.checkPayload(regen(build(url))).some((p) => p.path === 'recording.steps[0].url'));
  assert.deepEqual(S.scrubUrl('1:').url, [{ redacted: 'url', as: 'invalid' }]);

  for (const [suffix, ok] of [['-0', false], ['-1', false], ['-01', false], ['-2', true], ['-10', true]]) {
    const r = clone(rec);
    r.steps[4].args = { ['あ'.repeat(41 - suffix.length) + suffix]: typed.redacted('arg', 'v') };
    assert.equal(P.checkPayload(build(r)).some((p) => p.problem === 'key too long'), !ok, suffix);
  }
});

test('one-line fields refuse a line break, a control or an invisible character at the safety gate (E7, T1-T3, W6, M3; review R26)', () => {
  const set = {
    name: (r, v) => { r.steps[1].target.name = v; },
    selector: (r, v) => { r.steps[1].target.selector = v; },
    note: (r, v) => { r.steps[5].note = v; },
    tool: (r, v) => { r.steps[4].tool = v; },
    toolList: (r, v) => { r.webmcpTools['https://site-1.invalid'] = [v]; }
  };
  for (const [field, put] of Object.entries(set)) {
    for (const bad of ['a\nThen b', 'a\u0007b', 'a\u2028b', 'a\u200Bb', 'a\u202Eb']) {
      const r = clone(rec);
      put(r, bad);
      assert.ok(P.checkPayload(regen(build(r))).some((p) => ['not one line', 'hidden character'].includes(p.problem)), `${field} ${JSON.stringify(bad)}`);
    }
  }
  const env = P.buildPayload(withRuns(clone(rec)), { generator: 'template', markdown: '' }, { browser: ['Chrome\n141'] });
  assert.ok(P.checkPayload(env).some((p) => p.path.startsWith('recording.environment.browser') && p.problem === 'not one line'));
});

test('a selector never carries a placeholder of ours (T3, E6; review R26)', () => {
  const r = clone(rec);
  r.steps[1].target.selector = '#[[secret]]';
  assert.ok(P.checkPayload(regen(build(r))).some((p) => p.path.endsWith('.target.selector') && p.problem === 'unexpected form'));
});

test('checkCanonical finds what is safe but not what the masking writes (E8; review R26)', () => {
  assert.deepEqual(P.checkCanonical(build(rec)), []);
  const r = clone(rec);
  r.steps[0].url = '[[url:https]]';
  r.steps[4].args = { ['あ'.repeat(38) + '-21']: typed.redacted('arg', 'v') };
  r.steps[5].note = 'e\u0301';
  r.steps[2].url = 'HTTPS://SITE-1.INVALID:443/';
  r.webmcpTools = { 'https://site-1.invalid': ['a'], 'https://site-1.invalid/': ['b'] };
  const payload = build(r);
  payload.recording.webmcpTools[1].site = ['https://site-1.invalid'];
  const problems = P.checkCanonical(payload).map((p) => p.problem);
  for (const problem of ['http placeholder', 'key suffix past the key count', 'not NFKC', 'not the parsed URL', 'site twice']) {
    assert.ok(problems.includes(problem), problem);
  }
});

test('a line break in a URL or a hidden character in an argument is refused, and never renders as a line (E7; review R27)', () => {
  const url = clone(rec);
  url.steps[2].url = 'https://site-1.invalid/\n    Then injected';
  assert.ok(P.checkPayload(regen(build(url))).some((p) => p.path.startsWith('recording.steps[2].url') && p.problem === 'not one line'));
  assert.ok(!/^\s*Then injected/m.test(D.toGherkin(withRuns(url))), 'the renderer keeps it on one line even past the gate');

  const arg = clone(rec);
  arg.steps[4].args = { 'a\u202Eb': typed.kept('arg', 'x'), q: typed.kept('arg', 'c\u202Ed') };
  arg.steps.forEach((s) => { s.env = 'standard'; });
  const problems = P.checkPayload(regen(build(arg)));
  assert.ok(problems.some((p) => p.problem === 'key not one line'));
  assert.ok(problems.some((p) => p.path.includes('.q.text') && p.problem === 'hidden character'));
  assert.ok(!/\u202E/.test(D.toGherkin(arg)) && !/\u202E/.test(D.toMarkdown(D.buildReproduction(arg))));

  // A person's line breaks in a kept text are theirs: allowed, and rendered on one line.
  const typedText = clone(rec);
  typedText.steps[3] = { ...typedText.steps[3], env: 'standard', value: typed.kept('text', '一行目\n二行目') };
  typedText.steps.forEach((s) => { s.env = 'standard'; });
  assert.ok(!P.checkPayload(regen(build(typedText))).some((p) => p.problem === 'not one line'));
});

test('every bidi control and default-ignorable character is removed, never rendered and refused, from one definition (E7; review R28)', () => {
  for (const c of ['\u061C', '\u2066', '\u2067', '\u2068', '\u2069', '\u00AD', '\u{E0041}']) {
    assert.deepEqual(S.cleanLine(`a${c}b`).runs, ['ab'], JSON.stringify(c));
    const r = clone(rec);
    r.steps[1].target.name = `a${c}b`;
    assert.ok(!D.toGherkin(r).includes(c) && !D.toMarkdown(D.buildReproduction(r)).includes(c), JSON.stringify(c));
    assert.ok(P.checkPayload(regen(build(r))).some((p) => p.problem === 'hidden character'), JSON.stringify(c));
  }
});

test('a URL holds a masked part only where the masking puts one, and no bracket of its own (K1, U1-U8, E2; review R29, #28)', () => {
  const v = { redacted: 'v' };
  for (const [value, ok] of [
    [['https://site-1.invalid/[x]'], false], // a bracket in a text of the URL
    [['https://site-1.invalid/a?q=', v, 'x'], false], // a masked value with text after it
    [['https://site-1.invalid/', v], true], // a commercial path segment (U5)
    [['https://site-1.invalid/a', v], false], // half a path segment
    [['https://site-1.invalid/a', { redacted: 'id' }], false], // half a path segment
    [['https://site-1.invalid/a?q=', { redacted: 'id' }], false], // a path part in the query
    [['https://site-1.invalid/a#/', { redacted: 'id' }], false], // in the fragment
    [['https://site-1.invalid/', { redacted: 'email' }], false], // not a kind a URL holds
    [['https://', { redacted: 'id' }, '/'], false], // as the host
    [['https://site-1.invalid/a?', { redacted: 'masked' }, '=1'], true],
    [['https://site-1.invalid/a?q=', v, '&r=1'], true],
    [['https://site-1.invalid/users/', { redacted: 'id' }, '/', { redacted: 'user' }], true],
    [['https://[::1]:8080/a'], true],
    [['https://site-1.invalid/%5B%5Bx%5D%5D'], true]
  ]) {
    const r = clone(rec);
    r.steps.forEach((step) => { step.env = 'standard'; });
    r.steps[2].url = value;
    const problems = P.checkPayload(regen(build(r))).filter((p) => p.path.startsWith('recording.steps[2].url'));
    assert.equal(problems.length === 0, ok, `${JSON.stringify(value)}: ${JSON.stringify(problems)}`);
  }
});

test('the no-URL marker is a start URL only, and only when no step has a URL (U2, E2; review R30)', () => {
  const start = clone(rec);
  const payload = build(start);
  payload.recording.startUrl = '[[url:none]]';
  assert.ok(P.checkPayload(regen(payload)).some((p) => p.problem === 'no URL while a step has one'));
  const step = clone(rec);
  step.steps[2].url = '[[url:none]]';
  assert.ok(P.checkPayload(regen(build(step))).some((p) => p.problem === 'no-URL marker as a URL'));
});

test('checkCanonical finds an argument key that is not NFKC (E8; review R30)', () => {
  const r = clone(rec);
  r.steps[4].args = { 'e\u0301': typed.redacted('arg', 'v') };
  assert.ok(P.checkCanonical(build(r)).some((p) => p.problem === 'key not NFKC'));
});

test('a select holds a choice, never free text with its longer limit (I5, E2; review R31)', () => {
  const r = clone(rec);
  r.steps.forEach((s) => { s.env = 'standard'; });
  r.steps[2] = { ...r.steps[2], type: 'select', value: typed.kept('text', 'x'.repeat(200)) };
  assert.ok(P.checkPayload(regen(build(r))).some((p) => p.problem === 'text value in select'));
  r.steps[2].value = typed.kept('choice', '東京');
  assert.ok(!P.checkPayload(regen(build(r))).some((p) => p.path === 'recording.steps[2].value'));
});

test('a deleted start URL never comes back, not even when a later step goes there (E3, E4; review R34)', () => {
  const r = clone(rec);
  r.startUrl = 'https://site-1.invalid/a';
  r.steps = [
    { type: 'click', t: 1, env: 'standard', source: 'user', url: 'https://site-1.invalid/b', target: { role: 'button', name: 'x' } },
    { type: 'navigate', t: 2, env: 'standard', source: 'unknown', url: 'https://site-1.invalid/a' }
  ];
  assert.equal(D.rendered(D.startUrlOf(r)), 'https://site-1.invalid/b');
  const payload = build(r);
  assert.equal(show(payload.recording.startUrl), 'https://site-1.invalid/b');
  payload.recording.startUrl = 'https://site-1.invalid/a';
  assert.ok(P.checkPayload(regen(payload)).some((p) => p.problem === 'not the first URL of the steps'));
});

test('checkCanonical finds a search box or a choice that is not kept (E8, I5, I6; review R41)', () => {
  const r = clone(rec);
  r.steps[2].value = typed.redacted('search', 'v');
  assert.ok(P.checkCanonical(build(r)).some((p) => p.problem === 'search or choice not kept'));
});

test('the count of aliased hosts is within the alias limit (M1, E2; review R44)', () => {
  const p = build();
  p.privacy.hostsAliased = 1e100;
  assert.ok(P.checkPayload(regen(p)).some((x) => x.path === 'privacy.hostsAliased'));
});

test('checkPayload refuses runs that are not in the one form the masking writes (#28)', () => {
  const standardRec = clone(rec);
  for (const step of standardRec.steps) step.env = 'standard';
  for (const [text, problem] of [
    [['a', 'b'], 'texts not joined'],
    [['a', ''], 'empty text in runs'],
    [['[[email]]'], 'placeholder in text'],
    [[{ redacted: 'email', note: 'x' }], 'unknown field in a masked part'],
    [[{ redacted: 'v' }], 'not a masked part'],
    [[{ redacted: 'url', as: 'invalid' }], 'not a masked part'],
    ['plain string', 'not runs']
  ]) {
    const payload = build(standardRec);
    payload.recording.steps[3].value = { treatment: 'kept', field: 'text', text };
    payload.reproduction.gherkin = D.toGherkin(payload.recording);
    const problems = P.checkPayload(payload);
    assert.ok(problems.some((p) => p.path === 'recording.steps[3].value' && p.problem === problem), `${JSON.stringify(text)}: ${JSON.stringify(problems)}`);
  }
});

test('a keyword that is a placeholder name passes the exits when the page never wrote it (K2, E6; #28)', () => {
  const r = clone(rec);
  r.steps.forEach((step) => { step.env = 'standard'; });
  r.steps[3].value = typed.kept('text', ['問い合わせ ', { redacted: 'email' }]);
  const payload = build(r, D.toMarkdown(D.buildReproduction(withRuns(clone(r)))));
  assert.deepEqual(P.checkPayload(payload), []);
  assert.ok(payload.reproduction.gherkin.includes('[[email]]'), 'the Gherkin keeps the placeholder for agents');
  assert.ok(!payload.reproduction.markdown.includes('[['), payload.reproduction.markdown);
  assert.deepEqual(S.finalScan(payload, { keywords: ['mail', 'email', 'masked', 'url', 'invalid', 'text', 'site', 'value'] })
    .map((f) => f.path), ['reproduction.markdown'], 'only the Markdown note about site-N.invalid, a known limit of K2');
  assert.deepEqual(S.finalScan(payload, { keywords: ['mail', 'email', 'masked', 'url', 'text', 'value'] }), []);
  // ... and stops a payload where the page did write it.
  r.steps[5].note = 'mail の件';
  assert.deepEqual(S.finalScan(build(r), { keywords: ['mail'] }).map((f) => f.path), ['recording.steps[5].note[0]']);
});

test('the site of a WebMCP tool list is runs of one origin, nothing masked (W6, E1; review of #34 R2)', () => {
  assert.deepEqual(build().recording.webmcpTools[0].site, ['https://site-1.invalid']);
  for (const site of ['https://site-1.invalid', [{ redacted: 'url', as: 'invalid' }], ['https://site-1.invalid/', { redacted: 'id' }], ['https://site-1.invalid/a']]) {
    const payload = build();
    payload.recording.webmcpTools[0].site = site;
    assert.ok(P.checkPayload(payload).some((p) => p.path === 'recording.webmcpTools[0].site'), JSON.stringify(site));
  }
});

test('a URL marker carries its as as a string of its own (U1, U2, E1; review of #34 R5)', () => {
  for (const marker of [{ redacted: 'url' }, { redacted: 'url', as: null }, { redacted: 'url', as: true }]) {
    const payload = build();
    payload.recording.steps[1].url = [marker];
    assert.ok(P.checkPayload(regen(payload)).some((p) => p.path.startsWith('recording.steps[1].url') && p.problem === 'bad URL marker'), JSON.stringify(marker));
  }
  assert.equal(S.renderRuns([{ redacted: 'url' }]), '[[url:invalid]]');
});

test('a keyword added after the recording is found in a percent-encoded URL path (K2, E6; review of #34 R5)', () => {
  const recorded = S.scrubUrl('https://example.com/%41cme/x', { hostAllowlist: ['example.com'] }).url;
  assert.deepEqual(recorded, ['https://example.com/%41cme/x']);
  assert.equal(S.finalScan({ url: recorded }, { keywords: ['Acme'] }).length, 1);
  assert.deepEqual(S.finalScan({ url: ['https://example.com/%E3%81%82/x'] }, { keywords: ['Acme'] }), []);
});

test('an escape that is not UTF-8 does not hide the escapes after it (U5, K2, E6; review of #34 R6)', () => {
  assert.deepEqual(S.scrubUrl('https://example.com/%FF%41cme/x', { hostAllowlist: ['example.com'], keywords: ['Acme'] }).url,
    ['https://example.com/', { redacted: 'masked' }, '/x']);
  assert.equal(S.finalScan({ url: ['https://example.com/%FF%41cme/x'] }, { keywords: ['Acme'] }).length, 1);
});

test('the recording id and times are the extension\'s, not page text (K2, E6; review of #34 R7)', () => {
  const r = clone(rec);
  r.steps.forEach((step) => { step.env = 'standard'; });
  const payload = build(r);
  const keywords = ['rec', 'test', '20', '00', 'Z'];
  assert.deepEqual(S.finalScan(payload, { keywords }).filter((f) => /^(recording\.(id|startedAt|endedAt)|sentAt)$/.test(f.path)), []);
  r.steps[5].note = 'rec 20';
  assert.ok(S.finalScan(build(r), { keywords }).some((f) => f.path.startsWith('recording.steps[5].note')));
  assert.equal(S.finalScan({ id: 'acme-rec' }, { keywords: ['rec'] }).length, 1, 'an id not of the form is scanned');
});

test('each kind of step has the source W7 gives it (row W7; review of #37 R9)', () => {
  for (const [index, source] of [[0, 'user'], [1, 'agent'], [4, 'user'], [5, 'unknown'], [5, 'agent']]) {
    const payload = build();
    payload.recording.steps[index].source = source;
    assert.ok(P.checkPayload(regen(payload)).some((p) => p.path === `recording.steps[${index}].source`), `${index} ${source}`);
  }
  assert.deepEqual(P.checkPayload(build()), []);
});

// ------------------------------------------------------------- ADR 0005 (v4)

test('v3 and v4 are accepted, each against its own shape, and any other schema is refused (ADR 0005, M1)', () => {
  const v4 = build(rec);
  assert.deepEqual(P.checkPayload(v4), []);
  // The same recording as v3: no ref, and no field v4 added.
  const v3 = clone(v4);
  v3.schema = 'op-scribe.recording/v3';
  delete v3.recording.steps[5].ref;
  assert.deepEqual(P.checkPayload(v3), []);
  // A v4 field in a v3 payload is an unknown field, not judged by v4's rules.
  for (const mix of [(p) => { p.recording.steps[5].ref = 'E-a1b2c3'; }, (p) => { p.recording.trimmed = 'other'; }, (p) => { p.recording.scope = ['x']; }]) {
    const p = clone(v3);
    mix(p);
    assert.ok(P.checkPayload(p).some((x) => x.problem.startsWith('unknown field')), JSON.stringify(P.checkPayload(p)));
  }
  for (const schema of ['op-scribe.recording/v2', 'op-scribe.recording/v5', undefined]) {
    assert.deepEqual(P.checkPayload({ ...clone(v4), schema }), [{ path: 'schema', problem: 'unknown schema' }]);
  }
  assert.deepEqual(P.checkPayload(null), [{ path: 'schema', problem: 'unknown schema' }]);
  // v3 keeps accepting an end before the start; v4 does not.
  const early = (p) => { p.recording.endedAt = new Date(Date.parse(p.recording.startedAt) - 1000).toISOString(); return p; };
  assert.deepEqual(P.checkPayload(early(clone(v3))), []);
  assert.deepEqual(P.checkPayload(early(clone(v4))), [{ path: 'recording.endedAt', problem: 'before the start' }]);
});

test('v4: a ref on every expectation of the tester and nowhere else, a verdict only there, an actual result exactly on an NG (ADR 0005, T8)', () => {
  const at = (p) => p.recording.steps[5];
  const problems = (change) => {
    const p = build(rec);
    change(p);
    return P.checkPayload(p).map((x) => `${x.path} ${x.problem}`);
  };
  assert.deepEqual(problems((p) => { delete at(p).ref; }), ['recording.steps[5].ref missing for an expectation']);
  assert.deepEqual(problems((p) => { p.recording.steps[1].ref = 'E-000001'; }), ['recording.steps[1].ref not allowed for input', 'recording.steps[1].ref only on an expectation of the tester']);
  assert.deepEqual(problems((p) => { at(p).ref = 'E-SHOUT1'; }), ['recording.steps[5].ref unexpected form']);
  // Two expectations with one ref.
  assert.deepEqual(problems((p) => { p.recording.steps.push({ ...clone(at(p)), n: 7 }); p.reproduction.gherkin = D.toGherkin(p.recording); }), ['recording.steps[6].ref ref twice']);
  // An exploration note is not an expectation: no ref, no verdict.
  assert.deepEqual(problems((p) => { at(p).kind = 'idea'; }), ['recording.steps[5].ref only on an expectation of the tester']);
  assert.deepEqual(problems((p) => { at(p).actual = ['見えた']; }), ['recording.steps[5].actual actual result without an NG']);
  assert.deepEqual(problems((p) => { at(p).verdict = 'ok'; at(p).actual = ['見えた']; }), ['recording.steps[5].actual actual result without an NG']);
  assert.deepEqual(problems((p) => { at(p).verdict = 'ng'; }), ['recording.steps[5].actual missing for an NG']);
  assert.deepEqual(problems((p) => { at(p).verdict = 'ng'; at(p).actual = ['  ']; }), ['recording.steps[5].actual missing for an NG']);
  assert.deepEqual(problems((p) => { at(p).verdict = 'ng'; at(p).actual = [{ redacted: 'email' }]; }), [], 'a masked part is text once rendered');
  assert.deepEqual(problems((p) => { at(p).verdict = 'ok'; }), []);
  assert.deepEqual(problems((p) => { at(p).verdict = 'maybe'; }), ['recording.steps[5].verdict unexpected value']);
  assert.deepEqual(problems((p) => { p.recording.trimmed = 'all'; }), ['recording.trimmed unexpected value']);
  // The recording's own texts: kept only with text in them; a masked part alone is text once rendered.
  for (const f of ['scope', 'targetVersion', 'notTested']) {
    assert.deepEqual(problems((p) => { p.recording[f] = []; }), [`recording.${f} empty`]);
    assert.deepEqual(problems((p) => { p.recording[f] = ['   ']; }), [`recording.${f} empty`]);
    assert.deepEqual(problems((p) => { p.recording[f] = [{ redacted: 'email' }]; }), []);
  }
});

test('buildPayload copies the recording\'s own texts and builds the same payload again for the same sentAt (ADR 0005)', () => {
  const r = { ...clone(rec), scope: '検索画面', targetVersion: '2.3.0', notTested: '決済', trimmed: 'other' };
  const first = P.buildPayload(withRuns(clone(r)), { generator: 'none', markdown: '' }, env);
  assert.deepEqual(P.checkPayload(first), []);
  assert.equal(show(first.recording.scope), '検索画面');
  assert.equal(first.recording.trimmed, 'other');
  const again = P.buildPayload(withRuns(clone(r)), { generator: 'none', markdown: '' }, env, first.sentAt);
  assert.equal(JSON.stringify(again, null, 2), JSON.stringify(first, null, 2));
  // A verdict changes the payload: the previewed text and the one built now differ (the send check).
  // A verdict, the stop or a tool list changes the payload without a step: the previewed text
  // and the one built now differ, which is what the send compares.
  const changes = [
    (x) => { x.steps[5].verdict = 'ok'; },
    (x) => { x.endedAt += 60000; },
    (x) => { x.notTested = ['決済と返品']; },
    (x) => { x.webmcpTools['https://site-1.invalid'] = [['search_catalog'], ['add_to_cart']]; }
  ];
  for (const change of changes) {
    const changed = withRuns(clone(r));
    change(changed);
    assert.notEqual(JSON.stringify(P.buildPayload(changed, { generator: 'none', markdown: '' }, env, first.sentAt), null, 2), JSON.stringify(first, null, 2), String(change));
  }
});

test('the final scan does not stop on the words v4 adds when a keyword is the same word (ADR 0005, K2)', () => {
  for (const [verdict, trimmed] of [['ok', 'user'], ['ng', 'other']]) {
    const r = withRuns({ ...clone(rec), trimmed });
    r.steps[5].verdict = verdict;
    if (verdict === 'ng') r.steps[5].actual = ['空のまま'];
    const payload = P.buildPayload(r, { generator: 'none', markdown: '' }, env);
    assert.deepEqual(P.checkPayload(payload), []);
    assert.deepEqual(S.finalScan(payload, { keywords: [verdict, trimmed, 'E-a1b2c3'] }), [], `${verdict} ${trimmed}`);
  }
  const payload = P.buildPayload(withRuns(clone(rec)), { generator: 'none', markdown: '' }, env);
  // The same word anywhere else is still found.
  payload.recording.steps[5].note = ['user'];
  assert.ok(S.finalScan(payload, { keywords: ['user'] }).length);
});
