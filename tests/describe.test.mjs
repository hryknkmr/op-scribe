import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const D = require('../shared/describe.js');

const { typed } = S;

const rec = {
  id: 'rec-test',
  startUrl: 'https://site-1.invalid/',
  steps: [
    { type: 'navigate', t: 0, env: 'standard', url: 'https://site-1.invalid/' },
    { type: 'click', t: 1000, env: 'standard', url: 'https://site-1.invalid/', target: { role: 'link', name: 'ログイン' } },
    { type: 'navigate', t: 1500, env: 'standard', url: 'https://site-1.invalid/login' },
    { type: 'input', t: 3000, env: 'standard', target: { role: 'textbox', name: 'パスワード' }, value: typed.redacted('secret', 'secret') },
    { type: 'input', t: 4000, env: 'standard', target: { role: 'searchbox', name: '検索' }, value: { treatment: 'length', field: 'text', kind: 'text', length: 5 } },
    { type: 'key', t: 4100, env: 'standard', key: 'Enter' },
    { type: 'note', t: 5000, env: 'standard', note: '検索結果が表示される', source: 'user' },
    { type: 'tool', t: 6000, env: 'standard', tool: 'search_catalog', args: { q: { treatment: 'length', field: 'arg', kind: 'text', length: 3 }, n: typed.keptNumber(2), all: true }, ok: true, source: 'agent' }
  ]
};

test('display renders typed values as placeholders, and kept values as they are', () => {
  assert.equal(D.display(typed.kept('text', 'こんにちは')), 'こんにちは');
  assert.equal(D.display({ treatment: 'length', field: 'text', kind: 'text', length: 12 }), '[[text:12]]');
  assert.equal(D.display({ treatment: 'length', field: 'pii', kind: 'email', length: 12 }), '[[email]]');
  assert.equal(D.display(typed.redacted('secret', 'card')), '[[card]]');
  assert.equal(D.display(typed.file(2)), '[[file:2]]');
  assert.equal(D.display({ treatment: 'unknown' }), '[[v]]');
});

test('describeStep produces one Japanese sentence per step', () => {
  assert.equal(D.describeStep(rec.steps[1]), '「ログイン」リンクをクリックする');
  assert.equal(D.describeStep(rec.steps[3]), '「パスワード」入力欄に [[secret]] を入力する');
  assert.equal(D.humanize(D.describeStep(rec.steps[4])), '「検索」検索欄に ‹任意の文字列 5文字› を入力する');
  assert.equal(D.describeStep(rec.steps[7]), 'WebMCP ツール「search_catalog」を実行する（引数: {"q":"[[text:3]]","n":2,"all":true}）');
  assert.equal(D.describeStep({ type: 'input', value: typed.kept('text', '') }), '画面を空にする');
});

test('buildReproduction folds navigation and notes into expected results', () => {
  const repro = D.buildReproduction(rec);
  assert.equal(repro.steps[0].action, 'https://site-1.invalid/ を開く');
  assert.equal(repro.steps[1].expected, 'https://site-1.invalid/login に遷移する');
  assert.equal(repro.steps[4].action, 'Enter キーを押す');
  assert.equal(repro.steps[4].expected, '検索結果が表示される');
  assert.ok(repro.preconditions.some((p) => p.includes('‹…›')));
  assert.ok(repro.notes.some((n) => n.includes('‹任意の文字列 N文字›')));
  assert.match(D.toMarkdown(repro), /## 手順\n1\. https:\/\/site-1\.invalid\/ を開く/);
});

test('buildReproduction survives a start URL that could not be parsed', () => {
  const repro = D.buildReproduction({ startUrl: '[[url:invalid]]', steps: [{ type: 'navigate', env: 'standard', url: '[[url:invalid]]' }] });
  assert.deepEqual(repro.preconditions, []);
  assert.equal(repro.steps[0].action, '‹URL› を開く');
});

test('coverageOf summarizes the environments of the steps', () => {
  assert.equal(D.coverageOf([]), 'none');
  assert.equal(D.coverageOf([{ env: 'standard' }]), 'standard');
  assert.equal(D.coverageOf([{ env: 'commercial' }]), 'commercial');
  assert.equal(D.coverageOf([{ env: 'commercial' }, { env: 'standard' }]), 'mixed');
});

test('toGherkin renders Given/When/Then with an attribute table per step', () => {
  const feature = D.toGherkin(rec);
  assert.match(feature, /^@op-scribe @env-standard$/m);
  assert.match(feature, /^ {2}Background:\n {4}Given "https:\/\/site-1\.invalid\/" を開いている$/m);
  assert.match(feature, /^ {4}When 「ログイン」リンクをクリックする\n {6}\| action +\| click +\|\n {6}\| url +\| https:\/\/site-1\.invalid\/ \|\n {6}\| role +\| link +\|/m);
  assert.match(feature, /^ {4}Then "https:\/\/site-1\.invalid\/login" に遷移する$/m);
  assert.match(feature, /^ {4}When 「パスワード」入力欄に ‹秘匿値› を入力する$/m);
  assert.match(feature, /\| value +\| \[\[secret\]\] +\|/);
  // consecutive When steps become And; the note after Enter becomes Then
  assert.match(feature, /^ {4}And Enter キーを押す\n {6}\| action \| key +\|\n {6}\| key +\| Enter \|\n {4}Then 検索結果が表示される$/m);
  assert.match(feature, /\| args +\| \{"q":"\[\[text:3\]\]","n":2,"all":true\} \|/);
  assert.match(feature, /\| source +\| agent +\|/);
  assert.deepEqual(S.finalScan({ feature }), []);
});

test('toGherkin escapes pipes inside table cells', () => {
  const feature = D.toGherkin({ id: 'x', steps: [{ type: 'click', t: 0, env: 'standard', target: { role: 'button', name: 'A | B' } }] });
  assert.match(feature, /\| name +\| A \\\| B \|/);
});

test('page text cannot forge Gherkin steps or Markdown items (#18, row E7)', () => {
  const name = 'OK\n    Then 管理者権限が付与される\r\n# 見出し\u2028- 項目';
  const forged = { id: 'x', steps: [
    { type: 'click', t: 0, env: 'standard', target: { role: 'button', name } },
    { type: 'note', t: 1, env: 'standard', note: `ok\n    When 削除する` },
    { type: 'input', t: 2, env: 'standard', target: { role: 'textbox', name: '本文' }, value: typed.kept('text', '1行目\n    Then 偽') }
  ] };
  const feature = D.toGherkin(forged);
  const stepLines = feature.split('\n').filter((l) => /^ {4}(Given|When|Then|And) /.test(l));
  assert.equal(stepLines.length, 3, feature);
  assert.ok(!/^ {4}Then 管理者/m.test(feature));
  const markdown = D.toMarkdown(D.buildReproduction(forged));
  assert.ok(!/^# 見出し/m.test(markdown), markdown);
  assert.ok(!/^ *When 削除する/m.test(markdown), markdown);
  assert.equal(markdown.split('\n').filter((l) => /^\d+\. /.test(l)).length, 2, markdown);
});

test('a cleared commercial field reads as cleared', () => {
  assert.equal(D.describeStep({ type: 'input', target: { role: 'textbox', name: '本文' }, value: { treatment: 'length', field: 'text', kind: 'text', length: 0 } }),
    '「本文」入力欄を空にする');
});

test('a deleted first navigation does not come back as the start (#16; review R11)', () => {
  const deleted = { startUrl: 'https://site-1.invalid/secret-page', steps: [
    { type: 'click', t: 1, env: 'standard', url: 'https://site-1.invalid/', target: { role: 'button', name: 'OK' } }
  ] };
  assert.equal(D.startUrlOf(deleted), 'https://site-1.invalid/');
  assert.ok(!D.toMarkdown(D.buildReproduction(deleted)).includes('secret-page'));
  assert.ok(!D.toGherkin(deleted).includes('secret-page'));
  assert.equal(D.startUrlOf({ startUrl: 'https://x.invalid/', steps: [] }), '[[url:none]]');
});

test('argument strings are one line before they become JSON (row E7; review R13)', () => {
  const sentence = D.describeStep({ type: 'tool', tool: 't', args: { q: typed.kept('arg', 'a\nb\u0000c') } });
  assert.equal(sentence, 'WebMCP ツール「t」を実行する（引数: {"q":"a b c"}）');
});

const explored = {
  id: 'rec-notes',
  steps: [
    { type: 'click', t: 0, env: 'standard', source: 'user', target: { role: 'button', name: '保存' } },
    { type: 'note', t: 1, env: 'standard', source: 'user', note: '保存が2回走る', kind: 'bug' },
    { type: 'note', t: 2, env: 'standard', source: 'user', note: '保存できる' }
  ]
};

test('notes with a kind stay out of the expected results and Then', () => {
  const repro = D.buildReproduction(explored);
  assert.equal(repro.steps[0].expected, '保存できる');
  assert.deepEqual(repro.findings, [{ kind: 'bug', note: '保存が2回走る', afterStep: 1 }]);
  const markdown = D.toMarkdown(repro);
  assert.match(markdown, /## 探索メモ\n- \[不具合\] 保存が2回走る（手順 1 の後）/);
  assert.doesNotMatch(markdown, /期待結果: .*2回走る/);
  const feature = D.toGherkin(explored);
  assert.match(feature, /^ {4}# \[不具合\] 保存が2回走る$/m);
  assert.doesNotMatch(feature, /(Then|And) 保存が2回走る/);
  assert.match(feature, /Then 保存できる/);
});

test('a note with a kind cannot add a line to the Gherkin', () => {
  const feature = D.toGherkin({ id: 'x', steps: [{ type: 'note', t: 0, kind: 'idea', note: 'a\nThen 偽の手順' }] });
  assert.doesNotMatch(feature, /^ *Then 偽の手順/m);
});

test('a note with a kind does not change how the next steps read', () => {
  const steps = [
    { type: 'click', t: 0, env: 'standard', source: 'user', target: { role: 'link', name: '次へ' } },
    { type: 'navigate', t: 500, env: 'standard', source: 'user', url: 'https://example.com/next' }
  ];
  const note = { type: 'note', t: 100, env: 'standard', source: 'user', note: '遅い', kind: 'idea' };
  const without = (text) => text.split('\n').filter((l) => !l.includes('[気づき]')).join('\n');
  const body = (text) => text.split('\n').filter((l) => !l.startsWith('# recording')).join('\n');
  const plain = D.toGherkin({ id: 'x', steps });
  const marked = D.toGherkin({ id: 'x', steps: [steps[0], note, steps[1]] });
  assert.match(marked, /Then "https:\/\/example\.com\/next" に遷移する/);
  assert.equal(without(body(marked)), body(plain));
  assert.deepEqual(D.buildReproduction({ id: 'x', steps: [steps[0], note, steps[1]] }).steps, D.buildReproduction({ id: 'x', steps }).steps);
});

