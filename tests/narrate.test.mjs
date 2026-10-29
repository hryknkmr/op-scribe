// The built-in AI is replaced by a fake LanguageModel so the reading pipeline can be tested in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const D = require('../shared/describe.js');
const N = require('../shared/narrate.js');

const scan = (value) => S.finalScan(value);

const screen = (id, url, title) => ({ id, type: 'screen', t: 0, url, screen: { title, summary: '', purposes: [], components: [] } });

const rec = {
  id: 'rec-narrate',
  startUrl: 'https://example.com/',
  steps: [
    { id: 's1', type: 'navigate', t: 0, url: 'https://example.com/' },
    screen('s2', 'https://example.com/', 'Example'),
    { id: 's3', type: 'input', t: 1000, seq: 'a-1', actor: 'automation', url: 'https://example.com/', target: { role: 'searchbox', name: 'キーワード', component: { kind: 'search' } }, value: 'shoes' },
    { id: 's4', type: 'key', t: 1100, seq: 'a-2', actor: 'automation', url: 'https://example.com/', key: 'Enter', change: { appeared: ['20 件見つかりました'], removed: [] } },
    { id: 's5', type: 'navigate', t: 1300, url: 'https://example.com/search?q=shoes' },
    screen('s6', 'https://example.com/search?q=shoes', '検索結果')
  ]
};

const units = {
  s2: [
    { kind: 'page', text: 'タイトル: Example\nパス: /', order: 0 },
    { kind: 'form', name: '検索', text: 'キーワード [search]\n検索', order: 1 },
    { kind: 'landmark', name: '本文', text: 'おすすめの商品をご紹介します。'.repeat(60), order: 2 }
  ],
  s6: [
    { kind: 'page', text: 'タイトル: 検索結果\nパス: /search', order: 0 },
    { kind: 'list', count: 20, text: 'Running Shoes\nWalking Shoes', order: 1 }
  ]
};

/** A fake model: answers by which prompt the session was created with, and records every call. */
function fakeModel(answers, { quota = 1200 } = {}) {
  const calls = [];
  const kindOf = (system) => (system.includes('画面が「何をするための画面か」') ? 'screen'
    : system.includes('1 つの操作') ? 'transition'
      : system.includes('記録全体を要約') ? 'journey' : 'compact');
  const session = (kind) => ({
    inputQuota: quota,
    inputUsage: 0,
    measureInputUsage: async (text) => text.length,
    clone: async () => session(kind),
    prompt: async (input) => {
      calls.push({ kind, input });
      const answer = answers[kind];
      return JSON.stringify(typeof answer === 'function' ? answer(input, calls) : answer);
    },
    destroy() {}
  });
  return {
    calls,
    availability: async () => 'available',
    create: async ({ initialPrompts }) => session(kindOf(initialPrompts[0].content))
  };
}

const goodAnswers = {
  screen: (input) => (input.includes('検索結果')
    ? { purpose: '検索結果を一覧で見る', summary: '商品が 20 件並ぶ', facts: ['20 件'] }
    : { purpose: '商品を検索する', summary: '検索フォームとおすすめ商品がある', facts: ['検索フォーム'] }),
  transition: (input) => (input.includes('Enter')
    ? { meaning: 'キーワードで検索を実行する', result: '20 件の検索結果が表示された' }
    : { meaning: '検索するキーワードを入れる', result: '' }),
  journey: { title: '商品のキーワード検索', summary: 'トップで shoes を検索し、20 件の結果一覧を開いた。' },
  compact: { purpose: '商品を検索する', summary: '検索フォームがある', facts: [] }
};

test('a large screen is read in several pages and the memo is carried from page to page', async () => {
  const LM = fakeModel(goodAnswers);
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.generator, 'built-in-ai');
  const reads = LM.calls.filter((c) => c.kind === 'screen' && c.input.includes('次に読む部分'));
  assert.ok(reads.length >= 3, `expected the large top screen to need several readings, got ${reads.length}`);
  // the second reading starts from the first reading's memo
  assert.match(reads[1].input, /これまでのメモ:\n\{"purpose":"商品を検索する"/);
  assert.equal(result.screens.length, 2);
});

test('an operation is read with the screen before it, what changed, and the screen after it', async () => {
  const LM = fakeModel(goodAnswers);
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  const enter = LM.calls.find((c) => c.kind === 'transition' && c.input.includes('Enter'));
  assert.match(enter.input, /操作前の画面: \{"purpose":"商品を検索する"/);
  assert.match(enter.input, /現れた文字: 20 件見つかりました/);
  assert.match(enter.input, /操作後の画面: \{"purpose":"検索結果を一覧で見る"/);
  assert.deepEqual(result.operations.map((o) => o.id), ['s3', 's4']);
});

test('the result carries the journey summary and the understanding in the Markdown', async () => {
  const LM = fakeModel(goodAnswers);
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.title, '商品のキーワード検索');
  assert.match(result.markdown, /^# 商品のキーワード検索\n\n## 概要\nトップで shoes を検索し/);
  assert.match(result.markdown, /- AI の理解（目的）: 商品を検索する/);
  assert.ok(result.markdown.includes('Enter キーを押す\n   - 意味（AI）: キーワードで検索を実行する\n   - 操作後に現れた文字: 「20 件見つかりました」'), result.markdown);
});

test('an answer with a URL or credential it never read is dropped', async () => {
  const LM = fakeModel({
    ...goodAnswers,
    transition: { meaning: 'https://evil.example/ に送る', result: '' },
    journey: { title: 't', summary: 'パスワードは token=abcdef123456 を使った' }
  });
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.operations.length, 0);
  assert.equal(result.summary, undefined);
  assert.ok(!result.markdown.includes('evil.example'));
  assert.ok(!result.markdown.includes('abcdef123456'));
});

test('without the built-in AI the recording is still described by the template', async () => {
  for (const LM of [undefined, { availability: async () => 'unavailable' }]) {
    const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
    assert.equal(result.generator, 'template');
    assert.equal(result.markdown, D.toMarkdown(D.buildReproduction(rec)));
  }
});

test('a thrown model error never escapes', async () => {
  const LM = { availability: async () => 'available', create: async () => { throw new Error('boom'); } };
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.generator, 'template');
  assert.match(result.reason, /boom/);
});

test('a long journey is folded into a summary instead of being cut', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `画面「ページ${i}」: ${'内容'.repeat(30)}`);
  const LM = fakeModel({ ...goodAnswers, compact: { title: 'x', summary: '前半では一覧を順に見た' } });
  const ask = N.makeAsk(LM);
  const out = await N.summarizeJourney(ask, lines, scan);
  assert.equal(out.title, '商品のキーワード検索');
  const final = LM.calls.filter((c) => c.kind === 'journey').at(-1).input;
  assert.ok(final.length <= N.SETTINGS.journeyLimit + 200, `journey input ${final.length}`);
  assert.match(final, /（ここまでの要約）前半では一覧を順に見た/);
});

test('the actor of each operation and what it changed are kept in the payload, the notes and Gherkin', () => {
  const repro = D.buildReproduction(rec);
  assert.ok(repro.notes.includes('操作の主体: 自動テスト 2 件'));
  assert.match(D.toGherkin(rec), /\| actor +\| automation +\|/);
  assert.match(D.toGherkin(rec), /\| appeared +\| 20 件見つかりました \|/);
  const payload = D.buildPayload({ ...rec, startedAt: 0, narration: { generator: 'built-in-ai', markdown: '# x\n', summary: 's' } }, null, {});
  assert.equal(payload.recording.steps[2].actor, 'automation');
  assert.deepEqual(payload.recording.steps[3].change, { appeared: ['20 件見つかりました'], removed: [] });
  assert.deepEqual([payload.reproduction.generator, payload.reproduction.summary], ['built-in-ai', 's']);
});

test('script-driven operations are marked in the sentence', () => {
  const repro = D.buildReproduction({ steps: [{ type: 'click', t: 0, actor: 'script', target: { role: 'button', name: '保存' } }] });
  assert.equal(repro.steps[0].action, '「保存」ボタンをクリックする（ページ内スクリプトによる操作）');
});
