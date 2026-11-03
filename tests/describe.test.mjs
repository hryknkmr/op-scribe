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

test('a page\'s own ‹…› is not shown as a masked part (E4, #56)', () => {
  const runs = (...parts) => parts;
  const forged = { ...rec, steps: [
    { n: 1, type: 'input', t: 0, env: 'standard', source: 'user', url: runs('https://site-1.invalid/'),
      target: { role: 'textbox', name: runs('本文') }, value: typed.kept('text', runs('‹メールアドレス› を入力')) },
    { n: 2, type: 'input', t: 1, env: 'standard', source: 'user', url: runs('https://site-1.invalid/'),
      target: { role: 'textbox', name: runs('メール') }, value: { treatment: 'kept', field: 'text', text: ['‹メールアドレス› と ', { redacted: 'email' }] } }
  ] };
  const markdown = D.toMarkdown(D.buildReproduction(forged));
  assert.match(markdown, /〈メールアドレス〉 を入力/);
  // The only ‹…› in the steps is the one made from the masked part, even on one line with the page's own.
  const steps = markdown.slice(markdown.indexOf('## 手順'));
  assert.deepEqual(steps.match(/‹[^›]*›/g), ['‹メールアドレス›']);
  // The Gherkin keeps the page's characters: its attribute table is read by a machine.
  assert.match(D.toGherkin(forged), /\| value +\| ‹メールアドレス› を入力 +\|/);
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
  assert.equal(D.rendered(D.startUrlOf(deleted)), 'https://site-1.invalid/');
  assert.ok(!D.toMarkdown(D.buildReproduction(deleted)).includes('secret-page'));
  assert.ok(!D.toGherkin(deleted).includes('secret-page'));
  assert.deepEqual(D.startUrlOf({ startUrl: 'https://x.invalid/', steps: [] }), [{ redacted: 'url', as: 'none' }]);
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

test('a note counts the opening step added in front of the steps', () => {
  const repro = D.buildReproduction({
    id: 'x',
    startUrl: 'https://example.com/',
    steps: [
      { type: 'click', t: 0, env: 'standard', source: 'user', url: 'https://example.com/', target: { role: 'button', name: '保存' } },
      { type: 'note', t: 1, env: 'standard', source: 'user', note: '遅い', kind: 'bug' }
    ]
  });
  assert.equal(repro.steps[1].action, '「保存」ボタンをクリックする');
  assert.equal(repro.findings[0].afterStep, 2);
});

test('a panel note takes the recording\'s environment in every Gherkin, not the one it was saved with (review R36)', () => {
  const steps = [
    { type: 'note', t: 0, env: 'standard', source: 'user', note: 'メモ' },
    { type: 'navigate', t: 1, env: 'commercial', source: 'user', url: 'https://site-1.invalid/' }
  ];
  assert.match(D.toGherkin({ id: 'r', steps }), /environments: commercial$/m);
  // A part of the recording still reads the whole: the note is commercial even without the commercial step.
  assert.match(D.toGherkin({ id: 'r', steps: [steps[0]] }, { envSteps: steps }), /environments: commercial$/m);
});

test('the Markdown shows a URL with any scheme as a label, never [[…]] (E4; review of #34 R1)', () => {
  for (const as of ['web+demo', 'x.y', 'mailto', 'invalid']) {
    const rec = { steps: [{ type: 'click', t: 1, env: 'standard', source: 'user', url: [{ redacted: 'url', as }], target: { role: 'button', name: ['OK'] } }] };
    const md = D.toMarkdown(D.buildReproduction(rec));
    assert.ok(!/\[\[/.test(md), `${as}: ${md}`);
  }
});

test('in the Gherkin, the sentences show ‹…› and the attribute tables [[…]] (E3; review of #34 R4)', () => {
  const rec = { id: 'rec-g', steps: [
    { type: 'navigate', t: 0, env: 'standard', source: 'user', url: ['https://site-1.invalid/users/', { redacted: 'id' }] },
    { type: 'click', t: 9000, env: 'standard', source: 'user', url: ['https://site-1.invalid/'], target: { role: 'button', name: ['OK'] } },
    { type: 'navigate', t: 9100, env: 'standard', source: 'user', url: [{ redacted: 'url', as: 'invalid' }] },
    { type: 'navigate', t: 20000, env: 'standard', source: 'user', url: ['https://site-1.invalid/?q=', { redacted: 'v' }] }
  ] };
  const lines = D.toGherkin(rec).split('\n');
  const sentences = lines.filter((l) => /^\s+(Given|When|Then|And) /.test(l));
  const cells = lines.filter((l) => /^\s+\|/.test(l));
  assert.ok(sentences.length >= 3 && sentences.every((l) => !l.includes('[[')), sentences.join('\n'));
  assert.ok(cells.some((l) => l.includes('[[id]]')) && cells.some((l) => l.includes('[[url:invalid]]')) && cells.some((l) => l.includes('[[v]]')), cells.join('\n'));
});

test('every Gherkin step says where it came from: user, agent or unknown (row W7; review of #37 R7)', () => {
  const rec = { id: 'rec-s', steps: [
    { type: 'navigate', t: 0, env: 'standard', source: 'unknown', url: ['https://site-1.invalid/'] },
    { type: 'click', t: 1, env: 'standard', source: 'user', url: ['https://site-1.invalid/'], target: { role: 'button', name: ['OK'] } },
    { type: 'navigate', t: 2, env: 'standard', source: 'unknown', url: ['https://site-1.invalid/next'] },
    { type: 'note', t: 3, env: 'standard', source: 'agent', url: ['https://site-1.invalid/next'], note: ['表示される'] },
    { type: 'navigate', t: 9000, env: 'standard', source: 'unknown', url: ['https://site-1.invalid/last'] }
  ] };
  const sources = [...D.toGherkin(rec).matchAll(/\| source +\| (\w+) +\|/g)].map((m) => m[1]);
  assert.deepEqual(sources, ['unknown', 'user', 'unknown', 'agent', 'unknown']);
});

test('a Background made from a later step says unknown (row W7; review of #37 R8)', () => {
  const rec = { id: 'rec-b', steps: [{ type: 'click', t: 1, env: 'standard', source: 'user', url: ['https://site-1.invalid/'], target: { role: 'button', name: ['OK'] } }] };
  const sources = [...D.toGherkin(rec).matchAll(/\| source +\| (\w+) +\|/g)].map((m) => m[1]);
  assert.deepEqual(sources, ['unknown', 'user']);
});

const shown = (level, text) => ({ type: 'notice', t: 200, env: 'standard', source: 'unknown', url: ['https://a.test/'], level, notice: [text] });

test('a notice is what the page showed, not an expected result', () => {
  const click = { type: 'click', t: 100, env: 'standard', source: 'user', url: ['https://a.test/'], target: { role: 'button', name: ['保存'] } };
  const repro = D.buildReproduction({ steps: [click, shown('alert', '保存できません')], startUrl: ['https://a.test/'] });
  const step = repro.steps.at(-1);
  assert.equal(step.expected, undefined);
  assert.deepEqual(step.observed, ['警告: 保存できません']);
  assert.match(D.toMarkdown(repro), /^ {3}- 画面の表示: 警告: 保存できません$/m);
});

test('a notice between an operation and its navigation does not hide what caused it', () => {
  const click = { type: 'click', t: 100, env: 'standard', source: 'user', url: ['https://a.test/'], target: { role: 'button', name: ['保存'] } };
  const moved = { type: 'navigate', t: 300, env: 'standard', source: 'unknown', url: ['https://a.test/done'] };
  const rec = { steps: [click, shown('status', '保存しました'), moved], startUrl: ['https://a.test/'] };
  assert.match(D.buildReproduction(rec).steps.at(-1).expected, /に遷移する/);
  assert.match(D.toGherkin(rec), /Then 通知「保存しました」が表示される[\s\S]*And "https:\/\/a\.test\/done" に遷移する/);
});

test('a notice in the Gherkin carries what it showed and its source', () => {
  const feature = D.toGherkin({ steps: [shown('alert', '失敗 | 再試行')], startUrl: ['https://a.test/'] });
  assert.match(feature, /\| level +\| alert +\|/);
  assert.match(feature, /\| notice +\| 失敗 \\\| 再試行 \|/);
  assert.match(feature, /\| source +\| unknown +\|/);
});

// ------------------------------------------------------------- ADR 0005 formats

// A recording as the payload has it: texts are runs (plain strings are a run each here).
const T0 = '2026-11-03T01:00:00.000Z';
const nav = (url, t = 0) => ({ type: 'navigate', t, env: 'standard', source: 'unknown', url: [url] });
const click = (name, url, t = 0) => ({ type: 'click', t, env: 'standard', source: 'user', url: [url], target: { role: 'button', name: [name] } });
const notice = (text, url, t = 0) => ({ type: 'notice', t, env: 'standard', source: 'unknown', url: [url], notice: [text], level: 'status' });
const tool = (name, url, t = 0) => ({ type: 'tool', t, env: 'standard', source: 'agent', url: [url], tool: [name], ok: true });
const expect = (note, ref, verdict, actual) => ({ type: 'note', t: 0, env: 'standard', source: 'user', note: [note], ref,
  ...(verdict && { verdict }), ...(actual && { actual: [actual] }) });
const recording = (steps, extra = {}) => ({ id: 'rec-fmt-1', startedAt: T0, endedAt: '2026-11-03T01:12:30.000Z', environment: { browser: ['Chrome 141'] }, steps, ...extra });
const A = 'https://site-1.invalid/a';
const B = 'https://site-1.invalid/b';

test('a bug ticket has the five fields of ADR 0005, one for each NG, and names the recording (format A)', () => {
  const r = recording([nav(A), click('保存', A, 100), expect('保存できる', 'E-aaaaaa', 'ng', 'エラーが出る'), expect('一覧に戻る', 'E-bbbbbb', 'ok'),
    expect('件数が増える', 'E-cccccc', 'ng', '増えない')], { targetVersion: ['2.3.0'] });
  const tickets = D.bugTickets(r);
  assert.deepEqual(tickets.map((t) => t.ref), ['E-aaaaaa', 'E-cccccc']);
  const [first] = tickets;
  assert.equal(first.text.split('\n')[0], `# [E-aaaaaa] 『保存できる』が期待どおりにならない（${A}）`);
  for (const heading of ['## 再現手順', '## 期待結果', '## 実際の結果', '## 環境・対象バージョン']) assert.ok(first.text.includes(`\n${heading}\n`), heading);
  assert.ok(first.text.includes(`1. ${A} を開く\n2. 「保存」ボタンをクリックする\n`), first.text);
  assert.ok(first.text.includes('\nエラーが出る\n'));
  assert.ok(first.text.includes('- 環境: Chrome 141\n- 対象のバージョン: 2.3.0'));
  assert.ok(first.text.trimEnd().endsWith('記録 ID: rec-fmt-1'));
  // The second ticket's steps stop before its own expectation, and leave the earlier notes out.
  assert.ok(!tickets[1].text.includes('保存できる'), tickets[1].text);
});

test('the steps of a ticket: an NG at once after the opening is that one line; none before it says so; a gap is warned (format A)', () => {
  const opened = D.bugTickets(recording([nav(A), expect('表示される', 'E-aaaaaa', 'ng', '真っ白')]))[0].text;
  const stepsOf = (text) => text.split('\n## 再現手順\n')[1].split('\n\n')[0].split('\n').filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(stepsOf(opened), [`1. ${A} を開く`], opened);
  assert.ok(!opened.includes('欠けている'));
  const nothing = D.bugTickets(recording([expect('表示される', 'E-aaaaaa', 'ng', '真っ白')]))[0].text;
  assert.ok(nothing.includes('（記録された操作なし）'), nothing);
  assert.ok(nothing.startsWith('# [E-aaaaaa] 『表示される』が期待どおりにならない（画面不明）'), nothing);
  // The first step is no navigation (the tester deleted it), or a limit dropped steps: a gap may be there.
  assert.ok(nothing.includes('（記録の一部が欠けている可能性がある）'));
  const trimmed = D.bugTickets(recording([nav(A), expect('表示される', 'E-aaaaaa', 'ng', '真っ白')], { trimmed: 'other' }))[0].text;
  assert.ok(trimmed.includes('（記録の一部が欠けている可能性がある）'));
});

test('a ticket takes the notices from the last operation, tool call or navigation before its NG (format A)', () => {
  const noticesOf = (steps) => D.bugTickets(recording(steps))[0].text.split('\n').filter((l) => l.startsWith('- 通知'));
  // click -> notice(1) -> tool -> notice(2) -> NG: only what came after the tool call.
  assert.deepEqual(noticesOf([nav(A), click('保存', A), notice('一つ目', A), tool('x', A), notice('二つ目', A), expect('出る', 'E-aaaaaa', 'ng', 'x')]),
    ['- 通知「二つ目」が表示される']);
  // No operation before it: from the start.
  assert.deepEqual(noticesOf([notice('最初から', A), expect('出る', 'E-aaaaaa', 'ng', 'x')]), ['- 通知「最初から」が表示される']);
  // navigate(A) -> notice -> navigate(B) -> notice -> NG: only B's.
  assert.deepEqual(noticesOf([nav(A), notice('A の通知', A), nav(B), notice('B の通知', B), expect('出る', 'E-aaaaaa', 'ng', 'x')]),
    ['- 通知「B の通知」が表示される']);
  // Notices are no steps to take.
  const text = D.bugTickets(recording([nav(A), click('保存', A), notice('保存しました', A), expect('出る', 'E-aaaaaa', 'ng', 'x')]))[0].text;
  assert.ok(!/^\d+\. 通知/m.test(text), text);
});

test('the conclusion of a session record follows the table of ADR 0005, row by row (format B)', () => {
  const of = (steps, extra) => D.sessionRecord(recording(steps, extra)).split('\n## 結論\n')[1].split('\n')[0];
  const ok = expect('出る', 'E-aaaaaa', 'ok');
  const ng = expect('出る', 'E-bbbbbb', 'ng', 'x');
  const open = expect('出る', 'E-cccccc');
  assert.equal(of([nav(A), ng, open]), '問題あり（NG 1 件）（未判定 1 件）');
  assert.equal(of([nav(A), ng], { trimmed: 'user' }), '問題あり（NG 1 件）（記録の一部が欠けている）');
  assert.equal(of([nav(A), ok], { trimmed: 'user' }), '判定なし（記録の一部が欠けている）');
  // other: the warning is at the top, and the verdicts decide.
  assert.equal(of([nav(A), ok], { trimmed: 'other' }), '確かめた範囲で問題なし（OK 1 件）');
  assert.ok(D.sessionRecord(recording([nav(A), ok], { trimmed: 'other' })).includes('（記録の一部が上限で消えている。'));
  assert.equal(of([nav(A)]), '判定なし（期待結果が無い）');
  assert.equal(of([nav(A)], { trimmed: 'other' }), '判定なし（期待結果が無い）');
  assert.equal(of([nav(A), ok, open]), '判定なし（未判定 1 件）');
  assert.equal(of([nav(A), ok]), '確かめた範囲で問題なし（OK 1 件）');
});

test('a session record is made only once the recording has ended, never with an end before the start (format B)', () => {
  assert.equal(D.sessionRecord(recording([nav(A)], { endedAt: null })), null);
  assert.equal(D.sessionRecord(recording([nav(A)], { endedAt: '2026-11-03T00:59:00.000Z' })), null);
  const text = D.sessionRecord(recording([nav(A)]));
  assert.ok(text.includes(`${T0} 〜 2026-11-03T01:12:30.000Z（12 分）`), text);
  assert.ok(text.includes('記録 ID: rec-fmt-1'));
});

test('the masked URLs as they changed, with the three counts apart, and an appendix of every step (format B)', () => {
  const agentNote = { type: 'note', t: 0, env: 'standard', source: 'agent', url: [B], note: ['ページの申告'] };
  const idea = { type: 'note', t: 0, env: 'standard', source: 'user', note: ['気になる'], kind: 'idea' };
  const steps = [click('先に', A), nav(A), click('次へ', A), nav(B), tool('x', B), agentNote, notice('完了', B), nav(A), idea, expect('出る', 'E-aaaaaa', 'ng', '出ない')];
  const text = D.sessionRecord(recording(steps));
  const parts = text.split('\n## 実施した操作\n')[1].split('\n\n')[0].split('\n').slice(1);
  assert.deepEqual(parts, [
    `1. ${A}: 記録された操作 2 件 / ツール呼び出し 0 件 / ページからの申告 0 件`,
    `2. ${B}: 記録された操作 0 件 / ツール呼び出し 1 件 / ページからの申告 1 件`,
    `3. ${A}: 記録された操作 0 件 / ツール呼び出し 0 件 / ページからの申告 0 件`
  ], text);
  // A step before the first URL goes to a first 画面不明 part.
  const unknown = D.sessionRecord(recording([idea, nav(A)])).split('\n## 実施した操作\n')[1].split('\n')[1];
  assert.equal(unknown, '1. 画面不明: 記録された操作 0 件 / ツール呼び出し 0 件 / ページからの申告 0 件');
  const appendix = text.split('\n## 付録: 記録したステップ\n')[1].trimEnd().split('\n');
  assert.equal(appendix.length, steps.length);
  assert.equal(appendix[5], '6. ページの申告（ページからの申告）');
  assert.equal(appendix[8], '9. 気になる（気づき）');
  assert.equal(appendix[9], '10. 出る（期待結果: NG）');
  assert.ok(text.includes('- [E-aaaaaa] 出る（画面: https://site-1.invalid/a）: NG\n  - 実際の結果: 出ない\n  - バグチケット [E-aaaaaa]'), text);
  assert.ok(text.includes('## 見つけたこと\n- 気づき\n  - 気になる'));
  // The page's note is no expectation of the tester's.
  assert.ok(!text.split('\n## 確かめたこと\n')[1].split('\n## ')[0].includes('ページの申告'));
});

test('a ticket says what to settle before replaying: an element with nothing to find it by, and a masked value (ADR 0005, #42 slice 3)', () => {
  const cuesOf = (steps) => {
    const text = D.bugTickets(recording([...steps, expect('出る', 'E-aaaaaa', 'ng', 'x')]))[0].text;
    const part = text.split('\n再現の前に確かめること:\n')[1];
    return part ? part.split('\n\n')[0].split('\n') : [];
  };
  const bare = { type: 'click', t: 0, env: 'standard', source: 'user', url: [A], target: { tag: 'div' } };
  const secret = { type: 'input', t: 0, env: 'standard', source: 'user', url: [A], target: { role: 'textbox', name: ['パスワード'] }, value: typed.redacted('secret', 'secret') };
  const kept = { type: 'input', t: 0, env: 'standard', source: 'user', url: [A], target: { role: 'searchbox', name: ['検索'] }, value: typed.kept('search', ['靴']) };
  const pageKey = { type: 'key', t: 0, env: 'standard', source: 'user', url: [A], key: 'Escape' };
  const agentTool = tool('x', A);
  assert.deepEqual(cuesOf([nav(A), bare, secret, kept, pageKey, agentTool, bare]), [
    '- 要素をクリックする（対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す）',
    '- 「パスワード」入力欄に ‹秘匿値› を入力する（値を伏せてある。テスト値を用意して使い、伏せた値は推測しない）'
  ]);
  // Both on one sentence, or the same sentence twice: one line, the two notes in a fixed order.
  const both = { type: 'input', t: 0, env: 'standard', source: 'user', url: [A], target: { tag: 'input' }, value: typed.redacted('secret', 'secret') };
  assert.deepEqual(cuesOf([nav(A), both, both]), [
    '- 要素に ‹秘匿値› を入力する（対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す。値を伏せてある。テスト値を用意して使い、伏せた値は推測しない）'
  ]);
  // A field emptied is no value to supply: its sentence says to empty it.
  const emptied = { type: 'input', t: 0, env: 'standard', source: 'user', url: [A], target: { role: 'textbox', name: ['本文'] }, value: { treatment: 'length', field: 'text', kind: 'text', length: 0 } };
  assert.deepEqual(cuesOf([nav(A), emptied]), []);
  // A selector or a name is enough to find it by; nothing to settle, no section.
  assert.deepEqual(cuesOf([nav(A), { ...bare, target: { tag: 'div', selector: '#save' } }, kept]), []);
  // A cue is what the sentence shows (review r45): a name of masked parts only, or a role the
  // sentence does not name (it reads 要素), gives the reader nothing to find the element by.
  const maskedName = { ...bare, target: { name: [{ redacted: 'email' }] } };
  const unnamedRole = { ...bare, target: { role: 'slider' } };
  const blankName = { ...bare, target: { role: 'slider', name: ['​ '] } };
  assert.deepEqual(cuesOf([nav(A), maskedName, unnamedRole, blankName]), [
    '- 「‹メールアドレス›」をクリックする（対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す）',
    '- 要素をクリックする（対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す）',
    '- 「 」をクリックする（対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す）'
  ]);
  // The page's own characters beside a masked part, a role the sentence names, or a selector: a cue.
  assert.deepEqual(cuesOf([nav(A),
    { ...bare, target: { role: 'slider', name: ['音量 ', { redacted: 'number' }] } },
    { ...bare, target: { role: 'button', name: [{ redacted: 'email' }] } },
    { ...bare, target: { role: 'slider', selector: '#volume' } }]), []);
  // A name of masked parts only, or of blanks, hides the selector from the sentence (review r46).
  assert.deepEqual(cuesOf([nav(A),
    { ...bare, target: { role: 'slider', name: [{ redacted: 'email' }], selector: '#email' } },
    { ...bare, target: { name: [' '], selector: '#x' } }]), [
    '- 「‹メールアドレス›」をクリックする（対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す）',
    '- 「 」をクリックする（対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す）'
  ]);
  // Only the steps of the ticket: what comes after its NG is not looked at.
  const after = D.bugTickets(recording([nav(A), expect('出る', 'E-aaaaaa', 'ng', 'x'), bare]))[0].text;
  assert.ok(!after.includes('再現の前に確かめること'), after);
});
