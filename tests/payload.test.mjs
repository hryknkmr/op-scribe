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
    { type: 'navigate', t: 0, env: 'commercial', source: 'user', url: 'https://site-1.invalid/' },
    { type: 'input', t: 1000, env: 'commercial', source: 'user', url: 'https://site-1.invalid/',
      target: { role: 'textbox', tag: 'input', name: 'パスワード' }, value: typed.redacted('secret', 'secret') },
    { type: 'input', t: 2000, env: 'commercial', source: 'user', url: 'https://site-1.invalid/',
      target: { role: 'searchbox', name: '検索' }, value: typed.kept('search', '週末') },
    { type: 'input', t: 3000, env: 'commercial', source: 'user', url: 'https://site-1.invalid/',
      target: { role: 'textbox', name: '本文' }, value: { treatment: 'length', field: 'text', kind: 'text', length: 5 } },
    { type: 'tool', t: 4000, env: 'commercial', source: 'agent', tool: 'search_catalog', ok: true,
      args: { q: { treatment: 'length', field: 'arg', kind: 'text', length: 3 }, all: true } },
    { type: 'note', t: 5000, env: 'commercial', source: 'user', note: '結果が出る' }
  ]
};

const env = { browser: 'Chrome 141', platform: 'macOS', language: 'ja', userAgent: 'should not be copied' };
const build = (r = rec, markdown = '') => P.buildPayload(r, { generator: 'template', markdown }, env);
const clone = (v) => JSON.parse(JSON.stringify(v));

test('buildPayload carries no local-only state and passes both exit checks', () => {
  const payload = build(rec, D.toMarkdown(D.buildReproduction(rec)));
  const json = JSON.stringify(payload);
  for (const leak of ['tabId', 'aliases', 'grantedPatterns', 'intranet.corp.invalid', 'shop.corp.invalid', 'userAgent', 'commercialHosts']) {
    assert.ok(!json.includes(leak), `payload contains ${leak}`);
  }
  assert.equal(payload.schema, 'op-scribe.recording/v2');
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
  const kept = (field, text) => ({ treatment: 'kept', field, text });
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

const regen = (p) => { p.reproduction.gherkin = D.toGherkin(p.recording); return p; };

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
