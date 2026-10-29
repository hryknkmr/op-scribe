// The built-in AI is replaced by a fake LanguageModel so the acceptance rules can be tested in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const D = require('../shared/describe.js');
const N = require('../shared/narrate.js');

const rec = {
  id: 'rec-narrate',
  privacyLevel: 'strict',
  startUrl: 'https://example.com/',
  steps: [
    { type: 'navigate', t: 0, url: 'https://example.com/' },
    { type: 'screen', t: 10, url: 'https://example.com/', screen: { title: 'トップ', summary: '検索の画面', purposes: [], components: ['検索フォーム（キーワード）'] } },
    { type: 'input', t: 1000, actor: 'automation', target: { role: 'searchbox', name: 'キーワード', component: { kind: 'search' } }, value: '[[text:4]]' },
    { type: 'key', t: 1100, actor: 'automation', key: 'Enter' }
  ]
};

function fakeModel(reply, state = 'available') {
  const calls = [];
  return {
    calls,
    availability: async () => state,
    create: async (options) => {
      calls.push(options);
      return {
        prompt: async (input, { responseConstraint }) => {
          calls.push({ input, responseConstraint });
          return JSON.stringify(typeof reply === 'function' ? reply(input) : reply);
        },
        destroy() {}
      };
    }
  };
}

const scan = (value) => S.finalScan(value);

test('the model sees screens and numbered masked steps, and its wording is adopted step by step', async () => {
  const LM = fakeModel({
    title: 'キーワード検索',
    summary: 'トップの検索フォームでキーワード検索を行う。',
    steps: [
      { index: 1, action: 'トップページ https://example.com/ を開く' },
      { index: 2, action: '検索フォームのキーワード欄に ‹任意の文字列 4文字› を入力する' },
      { index: 3, action: 'Enter キーを押して検索を実行する' }
    ]
  });
  const result = await N.narrate(rec, { LM, scan });
  assert.equal(result.generator, 'built-in-ai');
  assert.equal(result.rewritten, 3);
  assert.equal(result.reason, undefined);
  assert.match(result.markdown, /## 概要\nトップの検索フォームでキーワード検索を行う。/);
  assert.match(result.markdown, /### 画面 1: 「トップ」[\s\S]*3\. Enter キーを押して検索を実行する/);

  const { input } = LM.calls[1];
  assert.match(input, /【画面】「トップ」— 検索の画面。主な UI: 検索フォーム（キーワード）\n1\. https:\/\/example\.com\/ を開く\n2\. 検索フォームの「キーワード」検索欄に ‹任意の文字列 4文字› を入力する/);
  assert.ok(!input.includes('[[text:4]]'), 'model input uses the human-readable placeholder');
});

test('a rewrite that claims an action, URL or placeholder its source step lacks is replaced by the template sentence', async () => {
  const cases = [
    { index: 1, action: 'トップのリンクをクリックして https://example.com/ を開く' },  // the source only opened a URL
    { index: 2, action: '検索欄に ‹パスワード› を入力する' },                             // placeholder not in this step
    { index: 3, action: 'https://evil.example/ で Enter キーを押す' }                      // URL not in this step
  ];
  const LM = fakeModel({ title: '検索', summary: '検索する', steps: [...cases, { index: 9, action: '余計な手順を開く' }] });
  const result = await N.narrate(rec, { LM, scan });
  const template = D.buildReproduction(rec).steps.map((s) => s.action);
  assert.equal(result.generator, 'template');
  assert.match(result.reason, /1: 元にない動作（click）/);
  for (const action of template) assert.ok(result.markdown.includes(action), action);
});

test('only the clean steps are taken when some are rejected', async () => {
  const LM = fakeModel({ title: '検索', summary: '検索する', steps: [
    { index: 1, action: 'トップページ https://example.com/ を開く' },
    { index: 2, action: '検索欄をクリックして ‹任意の文字列 4文字› を入力する' },
    { index: 3, action: 'Enter キーを押す' }
  ] });
  const result = await N.narrate(rec, { LM, scan });
  assert.equal(result.generator, 'built-in-ai');
  assert.equal(result.rewritten, 2);
  assert.match(result.reason, /1 件はテンプレートの文を使用（2: 対象名・値を変えた（「キーワード」））/);
  assert.match(result.markdown, /2\. 検索フォームの「キーワード」検索欄に ‹任意の文字列 4文字› を入力する/);
});

test('a title or summary that leaks a personal value is dropped', async () => {
  const LM = fakeModel({ title: 'someone@example.com の検索', summary: '連絡先 090-1234-5678', steps: [{ index: 3, action: 'Enter キーを押す' }] });
  const result = await N.narrate(rec, { LM, scan });
  assert.ok(!result.markdown.includes('someone@'));
  assert.ok(!result.markdown.includes('090-'));
  assert.equal(result.summary, undefined);
});

test('without the built-in AI the recording is still described by the template', async () => {
  for (const LM of [undefined, fakeModel({}, 'unavailable')]) {
    const result = await N.narrate(rec, { LM, scan });
    assert.equal(result.generator, 'template');
    assert.equal(result.markdown, D.toMarkdown(D.buildReproduction(rec)));
  }
});

test('a thrown model error never escapes', async () => {
  const LM = { availability: async () => 'available', create: async () => { throw new Error('boom'); } };
  const result = await N.narrate(rec, { LM, scan });
  assert.equal(result.generator, 'template');
  assert.match(result.reason, /boom/);
});

test('the actor of each operation is kept in the payload, the template notes and Gherkin', () => {
  const repro = D.buildReproduction(rec);
  assert.ok(repro.notes.includes('操作の主体: 自動テスト 2 件'));
  assert.match(D.toGherkin(rec), /\| actor +\| automation +\|/);
  const payload = D.buildPayload({ ...rec, startedAt: 0, narration: { generator: 'built-in-ai', markdown: '# x\n', summary: 's' } }, null, {});
  assert.equal(payload.recording.steps[2].actor, 'automation');
  assert.deepEqual([payload.reproduction.generator, payload.reproduction.summary], ['built-in-ai', 's']);
});

test('script-driven operations are marked in the sentence', () => {
  const repro = D.buildReproduction({ steps: [{ type: 'click', t: 0, actor: 'script', target: { role: 'button', name: '保存' } }] });
  assert.equal(repro.steps[0].action, '「保存」ボタンをクリックする（ページ内スクリプトによる操作）');
});

test('a judgement the recording does not contain is rejected', async () => {
  const LM = fakeModel({ title: '不正サイトへのアクセス', summary: '異常な URL を開いた', steps: [{ index: 1, action: '異常な URL https://example.com/ を開く' }] });
  const result = await N.narrate(rec, { LM, scan });
  assert.equal(result.generator, 'template');
  assert.match(result.reason, /元にない動作（judgement）/);
  assert.ok(!/不正|異常/.test(result.markdown));
});

test('a rewrite that drops the URL or placeholder of its step is rejected', async () => {
  const LM = fakeModel({ title: '検索', summary: '検索する', steps: [
    { index: 1, action: 'トップページを開く' },
    { index: 2, action: '検索欄にキーワードを入力する' },
    { index: 3, action: 'Enter キーを押す' }
  ] });
  const result = await N.narrate(rec, { LM, scan });
  assert.match(result.reason, /1: URL を落とした（https:\/\/example\.com\/）/);
  assert.match(result.reason, /2: 伏せ字を落とした（‹任意の文字列 4文字›）/);
  assert.equal(result.rewritten, 1);
});

test('a rewrite that swaps the target name for another is rejected', async () => {
  const r = { id: 'rec-swap', steps: [{ type: 'click', t: 0, url: 'https://example.com/', target: { role: 'button', name: '検索' } }] };
  const LM = fakeModel({ title: 't', summary: 's', steps: [{ index: 1, action: '「注文確定」ボタンをクリックする' }] });
  const result = await N.narrate(r, { LM, scan });
  assert.equal(result.generator, 'template');
  assert.match(result.reason, /対象名・値を変えた（「検索」）/);
});
