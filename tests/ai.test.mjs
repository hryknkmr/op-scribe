// The check on what the on-device model writes (sidepanel/ai.js, AGENTS.md: AI output is used only if it passes validate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validate, sources, adopt } from '../sidepanel/ai.js';

// The side panel loads shared/limits.js before ai.js; so does this test.
createRequire(import.meta.url)('../shared/limits.js');

const input = '開始ページ: https://site-1.invalid/\n操作ログ:\n1. 「メール」入力欄に ‹メールアドレス› を入力する';
const noFindings = () => [];

test('the model may keep the masked parts it was given', () => {
  const output = { title: '手順', steps: [{ action: '「メール」入力欄に ‹メールアドレス› を入力する', from: [1] }] };
  assert.deepEqual(validate(output, input, noFindings, 1), []);
});

test('a [[…]] the model wrote is refused: the input never holds one (#28; review of #34 R3)', () => {
  for (const mark of ['[[email]]', '[[secret]]', '[[url:mailto]]', '[[text:12]]']) {
    const output = { title: '手順', steps: [{ action: `「メール」入力欄に ${mark} を入力する` }] };
    assert.ok(validate(output, input, noFindings, 1).some((p) => p.includes('[[…]]')), mark);
  }
});

test('the model may merge what it was given, never add one more of it (review of #34)', () => {
  const twice = { title: '手順', steps: [{ action: '「メール」入力欄に ‹メールアドレス› を入力する', from: [1] }, { action: '‹メールアドレス› を確かめる', from: [1] }] };
  assert.ok(validate(twice, input, noFindings, 1).some((p) => p.includes('‹メールアドレス›')));
  const url = { title: '手順', steps: [{ action: 'https://site-1.invalid/ を開く', from: [1] }, { action: 'https://site-1.invalid/ を開く', from: [1] }] };
  assert.ok(validate(url, input, noFindings, 1).some((p) => p.includes('URL')));
});

test('a real host at the end of one precondition is found, whatever follows it (review of #34 R4)', async () => {
  const S = (await import('node:module')).createRequire(import.meta.url)('../shared/sanitize.js');
  const output = { title: '手順', steps: [{ action: '「メール」入力欄に ‹メールアドレス› を入力する', from: [1] }], preconditions: ['intranet.corp.invalid', 'x'] };
  assert.ok(validate(output, input, (o) => S.finalScan(o, { hosts: ['intranet.corp.invalid'] }), 1).length);
});

test('a hidden character in the output is refused: the renderer would remove it after the check (E7; review of #34 R10)', () => {
  for (const action of ['[\u200B[email]] を入力する', 'https:\u200B//new.example/ を開く', '[\u202E[secret]]', '[\u2060[v]]']) {
    const output = { title: '手順', steps: [{ action, from: [1] }] };
    assert.ok(validate(output, input, noFindings, 1).length, JSON.stringify(action));
  }
});

// The steps must account for every log line, once and in order (sources): the leak checks cannot see a dropped step.
test('steps that cover the log lines once and in order are taken, merged neighbours too', () => {
  assert.deepEqual(sources([{ from: [1] }, { from: [2, 3] }, { from: [4] }], 4), []);
  const two = '開始ページ: https://site-1.invalid/\n操作ログ:\n1. 「検索」をクリックする\n2. 「検索」をクリックする';
  assert.deepEqual(validate({ title: '手順', steps: [{ action: '「検索」をクリックする', from: [1, 2] }] }, two, noFindings, 2), []);
});

test('a dropped, repeated, reordered or made-up step is refused', () => {
  const cases = [
    [[{ from: [1] }, { from: [3] }], 3, '2 が手順から抜けて'],
    [[{ from: [1] }], 2, '2 が手順から抜けて'],
    [[{ from: [2] }, { from: [1] }], 2, '位置が変わって'],
    [[{ from: [1] }, { from: [1, 2] }], 2, '位置が変わって'],
    [[{ from: [1] }, { from: [2] }], 1, '入力にない操作'],
    [[{ from: [1] }, { from: [] }], 1, '番号がありません'],
    [[{ from: [1] }, {}], 1, '番号がありません'],
    [[{ from: ['1'] }], 1, '番号がありません'],
    [[{ from: [1.5] }], 1, '番号がありません']
  ];
  for (const [steps, count, why] of cases) {
    const found = sources(steps, count);
    assert.ok(found.length && found[0].includes(why), `${JSON.stringify(steps)} / ${count}: ${found}`);
  }
});

test('an output without the source numbers is refused as a whole', () => {
  const output = { title: '手順', steps: [{ action: '「メール」入力欄に ‹メールアドレス› を入力する' }] };
  assert.ok(validate(output, input, noFindings, 1).some((p) => p.includes('番号がありません')));
});

test('what the page showed, an expected result the model left out, and where a finding was follow the merged steps', () => {
  const base = {
    title: 't', preconditions: ['p'], notes: ['n'],
    steps: [
      { action: 'a を開く' },
      { action: '「検索」をクリックする', expected: '一覧に遷移する', observed: ['通知: 1件'] },
      { action: '「検索」をクリックする', observed: ['通知: 2件'] },
      { action: '「保存」をクリックする', expected: '保存される' }
    ],
    findings: [{ kind: 'bug', note: 'x', afterStep: 3 }, { kind: 'question', note: 'y', afterStep: 4 }, { kind: 'idea', note: 'z', afterStep: 0 }]
  };
  const output = { title: '検索して保存する', steps: [
    { action: 'a を開く', from: [1] },
    { action: '「検索」を 2 回クリックする', from: [2, 3] },
    { action: '「保存」をクリックする', expected: '保存できたと表示される', from: [4] }
  ] };
  const repro = adopt(base, output);
  assert.deepEqual(repro.steps[1], { action: '「検索」を 2 回クリックする', expected: '一覧に遷移する', observed: ['通知: 1件', '通知: 2件'] });
  assert.equal(repro.steps[2].expected, '保存できたと表示される');
  assert.equal(repro.steps[0].expected, undefined);
  assert.deepEqual(repro.findings.map((f) => f.afterStep), [2, 3, 0]);
});
