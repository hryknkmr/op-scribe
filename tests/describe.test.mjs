import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const D = require('../shared/describe.js');

const rec = {
  id: 'rec-test',
  state: 'stopped',
  tabId: 7,
  startedAt: Date.UTC(2026, 9, 29, 1, 0, 0),
  endedAt: Date.UTC(2026, 9, 29, 1, 2, 0),
  startUrl: 'https://site-1.invalid/',
  privacyLevel: 'partial',
  aliases: { 'https://intranet.corp.invalid': 'site-1.invalid' },
  grantedPatterns: ['https://intranet.corp.invalid/*'],
  redactions: { text: 1, secret: 1 },
  webmcpTools: { 'https://site-1.invalid': ['search_catalog'] },
  steps: [
    { type: 'navigate', t: 0, url: 'https://site-1.invalid/' },
    { type: 'click', t: 1000, url: 'https://site-1.invalid/', target: { role: 'link', name: 'ログイン' } },
    { type: 'navigate', t: 1500, url: 'https://site-1.invalid/login' },
    { type: 'input', t: 3000, target: { role: 'textbox', name: 'パスワード' }, value: '[[secret]]' },
    { type: 'input', t: 4000, target: { role: 'searchbox', name: '検索' }, value: '[[text:5]]' },
    { type: 'key', t: 4100, key: 'Enter' },
    { type: 'note', t: 5000, note: '検索結果が表示される', source: 'user' },
    { type: 'tool', t: 6000, tool: 'search_catalog', args: { q: '[[text:3]]' }, ok: true, source: 'agent' }
  ]
};

test('describeStep produces one Japanese sentence per step', () => {
  assert.equal(D.describeStep(rec.steps[1]), '「ログイン」リンクをクリックする');
  assert.equal(D.describeStep(rec.steps[3]), '「パスワード」入力欄に [[secret]] を入力する');
  assert.equal(D.humanize(D.describeStep(rec.steps[4])), '「検索」検索欄に ‹任意の文字列 5文字› を入力する');
  assert.equal(D.describeStep(rec.steps[7]), 'WebMCP ツール「search_catalog」を実行する（引数: {"q":"[[text:3]]"}）');
});

test('buildReproduction folds navigation and notes into expected results', () => {
  const repro = D.buildReproduction(rec);
  assert.equal(repro.steps[0].action, 'https://site-1.invalid/ を開く');
  assert.equal(repro.steps[1].expected, 'https://site-1.invalid/login に遷移する');
  assert.equal(repro.steps[4].action, 'Enter キーを押す');
  assert.equal(repro.steps[4].expected, '検索結果が表示される');
  assert.ok(repro.preconditions.some((p) => p.includes('‹…›')));
  assert.match(D.toMarkdown(repro), /## 手順\n1\. https:\/\/site-1\.invalid\/ を開く/);
});

test('buildPayload carries no local-only state and passes the final scan', () => {
  const payload = D.buildPayload(rec, { generator: 'template', markdown: D.toMarkdown(D.buildReproduction(rec)) },
    { browser: 'Chrome 141', platform: 'macOS', language: 'ja', userAgent: 'should not be copied' });
  const json = JSON.stringify(payload);
  for (const leak of ['tabId', 'aliases', 'grantedPatterns', 'intranet.corp.invalid', 'userAgent']) {
    assert.ok(!json.includes(leak), `payload contains ${leak}`);
  }
  assert.equal(payload.recording.privacy.hostsAliased, 1);
  assert.deepEqual(S.finalScan(payload, { keywords: ['intranet.corp.invalid'] }), []);
});

test('toGherkin renders Given/When/Then with an attribute table per step', () => {
  const feature = D.toGherkin(rec);
  assert.match(feature, /^@op-scribe @privacy-tiered-commercial$/m);
  assert.match(feature, /^ {2}Background:\n {4}Given "https:\/\/site-1\.invalid\/" を開いている$/m);
  assert.match(feature, /^ {4}When 「ログイン」リンクをクリックする\n {6}\| action +\| click +\|\n {6}\| url +\| https:\/\/site-1\.invalid\/ \|\n {6}\| role +\| link +\|/m);
  assert.match(feature, /^ {4}Then "https:\/\/site-1\.invalid\/login" に遷移する$/m);
  assert.match(feature, /^ {4}When 「パスワード」入力欄に ‹秘匿値› を入力する$/m);
  // consecutive When steps become And; the note after Enter becomes Then
  assert.match(feature, /^ {4}And Enter キーを押す\n {6}\| action \| key +\|\n {6}\| key +\| Enter \|\n {4}Then 検索結果が表示される$/m);
  assert.match(feature, /\| args +\| \{"q":"\[\[text:3\]\]"\} \|/);
  assert.match(feature, /\| source +\| agent +\|/);
  assert.deepEqual(S.finalScan({ feature }), []);
});

test('toGherkin escapes pipes inside table cells', () => {
  const feature = D.toGherkin({ id: 'x', steps: [{ type: 'click', t: 0, target: { role: 'button', name: 'A | B' } }] });
  assert.match(feature, /\| name +\| A \\\| B \|/);
});

test('buildPayload includes Gherkin even when none was generated in the panel', () => {
  const payload = D.buildPayload(rec, { generator: 'none', markdown: '' }, {});
  assert.match(payload.reproduction.gherkin, /^Feature: /m);
});

test('payload v2: the privacy policy and coverage, and Gherkin rebuilt when a step is on production', () => {
  const recording = { id: 'r', startedAt: 0, steps: [
    { type: 'input', t: 1, url: 'https://site-1.invalid/', value: 'Taro', valueClass: 'text', privacy: { profile: 'commercial' } },
    { type: 'input', t: 2, url: 'https://site-2.invalid/', value: 'Taro', valueClass: 'text', privacy: { profile: 'standard' } }
  ] };
  const payload = D.buildPayload(recording, { generator: 'manual', markdown: '', gherkin: 'edited' }, {});
  assert.equal(payload.schema, 'op-scribe.recording/v2');
  assert.deepEqual(payload.recording.privacy, { policy: 'tiered-commercial/v1', coverage: 'mixed', commercialSteps: 1, standardSteps: 1, hostsAliased: 0, redactions: {} });
  assert.notEqual(payload.reproduction.gherkin, 'edited');
  // A typed value left on a production step is stopped at the exit; the same value elsewhere is not.
  assert.deepEqual(S.finalScan(payload).map((f) => f.path), ['recording.steps[0].value']);
});

test('Markdown asks for test values in place of partly hidden ones', () => {
  const md = D.toMarkdown(D.buildReproduction({ steps: [{ type: 'input', t: 1, url: 'https://site-1.invalid/', value: 's***@e***.com', target: { role: 'textbox', name: 'メール' } }] }));
  assert.match(md, /\* で一部を伏せた値（例: s\*\*\*@e\*\*\*\.com）は、そのまま入力せず、テスト用の値に置き換えること/);
});

test('the partial-mask note also covers arguments and IP addresses', () => {
  const md = D.toMarkdown(D.buildReproduction({ steps: [{ type: 'tool', t: 1, url: 'https://site-1.invalid/', tool: 't', args: { ip: '192.168.*.*' } }] }));
  assert.match(md, /一部を伏せた値/);
});
