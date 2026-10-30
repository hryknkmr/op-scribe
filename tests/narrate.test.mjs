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
    { id: 's4', type: 'key', t: 1100, seq: 'a-2', actor: 'automation', url: 'https://example.com/', key: 'Enter', change: { appeared: ['20 件見つかりました'] } },
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

test('a screen memo that copies the instructions instead of the screen is dropped', async () => {
  const LM = fakeModel({
    ...goodAnswers,
    screen: (input) => (input.includes('検索結果')
      ? { purpose: 'この画面で利用者ができること・この画面の目的', summary: '一覧', facts: [] }
      : goodAnswers.screen(input))
  });
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.deepEqual(result.screens.map((s) => s.id), ['s2']);
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

test('a folded part of the journey is checked like any other answer', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `画面「ページ${i}」: ${'内容'.repeat(30)}`);
  const LM = fakeModel({ ...goodAnswers, compact: { title: 'x', summary: 'https://evil.example/ に送った' } });
  const out = await N.summarizeJourney(N.makeAsk(LM), lines, scan);
  assert.ok(out);
  assert.ok(!LM.calls.filter((c) => c.kind === 'journey').at(-1).input.includes('evil.example'));
});

test('the actor of each operation and what it changed are kept in the payload, the notes and Gherkin', () => {
  const repro = D.buildReproduction(rec);
  assert.ok(repro.notes.includes('操作の主体: 自動テスト 2 件'));
  assert.match(D.toGherkin(rec), /\| actor +\| automation +\|/);
  assert.match(D.toGherkin(rec), /\| appeared +\| 20 件見つかりました \|/);
  const payload = D.buildPayload({ ...rec, startedAt: 0 }, { generator: 'built-in-ai', markdown: '# x\n', summary: 's' }, {});
  assert.equal(payload.recording.steps[2].actor, 'automation');
  assert.deepEqual(payload.recording.steps[3].change, { appeared: ['20 件見つかりました'] });
  assert.deepEqual([payload.reproduction.generator, payload.reproduction.summary], ['built-in-ai', 's']);
});

test('the model\'s text reaches the payload only as the reproduction it was previewed in', () => {
  const tainted = { ...rec, startedAt: 0, narration: { generator: 'built-in-ai', markdown: 'AI の文' }, steps: rec.steps.map((step) => ({
    ...step, ai: { meaning: 'AI の意味' }, ...(step.screen ? { screen: { ...step.screen, ai: { purpose: 'AI の目的' } } } : {})
  })) };
  const payload = D.buildPayload(tainted, null, {});
  assert.ok(!JSON.stringify(payload.recording).includes('AI の'));
  assert.ok(!payload.reproduction.markdown.includes('AI の'));
  assert.equal(payload.reproduction.generator, 'none');
  assert.ok(payload.recording.steps.some((step) => step.screen?.title));
});

test('script-driven operations are marked in the sentence', () => {
  const repro = D.buildReproduction({ steps: [{ type: 'click', t: 0, actor: 'script', target: { role: 'button', name: '保存' } }] });
  assert.equal(repro.steps[0].action, '「保存」ボタンをクリックする（ページ内スクリプトによる操作）');
});

test('a notice the page showed becomes the result as recorded, whatever the model wrote', async () => {
  const withNotice = { ...rec, steps: rec.steps.map((s) => (s.id === 's4' ? { ...s, change: { appeared: ['20 件'], transient: ['検索しました'] } } : s)) };
  const result = await N.narrate(withNotice, { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.operations.find((o) => o.id === 's4').ai.result, '「検索しました」と表示された');
});

test('an answer with a number it never read is dropped', async () => {
  const LM = fakeModel({ ...goodAnswers, transition: { meaning: '検索する', result: '35 件が表示された' } });
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.operations.length, 0);
});

test('the screen kind judged from the record is given to the model before the first page', async () => {
  const kinded = { ...rec, steps: rec.steps.map((s) => (s.id === 's6' ? { ...s, screen: { ...s.screen, purposes: [{ kind: 'list', label: '一覧の閲覧' }] } } : s)) };
  const LM = fakeModel(goodAnswers);
  await N.narrate(kinded, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.ok(LM.calls.some((c) => c.kind === 'screen' && c.input.startsWith('記録から判定した画面の種類: 一覧の閲覧\n')));
});

test('one answer that fails (cut at the output limit) does not stop the rest of the reading', async () => {
  const LM = fakeModel(goodAnswers);
  const create = LM.create;
  LM.create = async (options) => {
    const session = await create(options);
    if (!options.initialPrompts[0].content.includes('画面が「何をするための画面か」')) return session;
    const fail = (s) => ({ ...s, clone: async () => fail(await s.clone()), prompt: async (input) => {
      if (input.includes('検索結果')) throw new Error('The response exceeded output limits and was truncated.');
      return s.prompt(input);
    } });
    return fail(session);
  };
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.generator, 'built-in-ai');
  assert.deepEqual(result.screens.map((s) => s.id), ['s2']);
  assert.ok(result.operations.length > 0);
});

test('a notice on the screen an operation led to is its result and part of that screen', async () => {
  const withToast = { ...units, s6: [...units.s6, { kind: 'feedback', text: '保存しました', order: 2 }] };
  const result = await N.narrate(rec, { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => withToast[s.id] });
  assert.equal(result.operations.find((o) => o.id === 's4').ai.result, '「保存しました」と表示された');
  assert.match(result.screens.find((s) => s.id === 's6').ai.summary, /「保存しました」と表示されている。$/);
});

test('a key the operation did not use is not accepted in its meaning', async () => {
  const LM = fakeModel({ ...goodAnswers, transition: (input) => (input.includes('Enter') ? goodAnswers.transition(input) : { meaning: 'Enter キーで確定する', result: '' }) });
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.deepEqual(result.operations.map((o) => o.id), ['s4']);
});

test('a notice that was already on the previous screen is not given to the next operation as its result', async () => {
  const both = { ...units, s2: [...units.s2, { kind: 'feedback', text: '保存しました', order: 3 }], s6: [...units.s6, { kind: 'feedback', text: '保存しました', order: 2 }] };
  const result = await N.narrate(rec, { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => both[s.id] });
  assert.equal(result.operations.find((o) => o.id === 's4').ai.result, undefined);
});

test('the model never writes the result: without a notice an operation has none, whatever the model says', async () => {
  const LM = fakeModel({ ...goodAnswers, transition: () => ({ meaning: '注文を確定する', result: '支払いに成功した' }) });
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.ok(result.operations.length);
  for (const o of result.operations) assert.deepEqual(o.ai, { meaning: '注文を確定する' });
  assert.ok(!result.markdown.includes('支払いに成功した'));
});

test('a number written without its thousands separator is the same number', () => {
  assert.deepEqual(N.problemsOf({ summary: '約10000件、¥5000' }, '約10,000件 ¥5,000', null), []);
  assert.match(N.problemsOf({ summary: '約20000件' }, '約10,000件', null)[0], /読んだ文章にない数字/);
});

test('the journey is given in the order things happened: an operation before the screen it led to', async () => {
  const LM = fakeModel(goodAnswers);
  await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  const lines = LM.calls.filter((c) => c.kind === 'journey').at(-1).input.split('\n');
  const enter = lines.findIndex((l) => l.startsWith('操作:') && l.includes('Enter'));
  const results = lines.findIndex((l) => l.startsWith('画面') && l.includes('検索結果を一覧で見る'));
  assert.ok(enter >= 0 && results > enter, lines.join('\n'));
});

test('URLs in any case and key names as words are checked against what was read', () => {
  assert.match(N.problemsOf({ meaning: 'HTTPS://evil.example/path を開く' }, '', null)[0], /URL/);
  for (const key of ['Ctrl+S で保存する', 'Delete キーで消す', 'ArrowDown で選ぶ']) assert.match(N.problemsOf({ meaning: key }, '', null)[0], /キー操作/);
  assert.deepEqual(N.problemsOf({ meaning: 'Endpoint の一覧を見る' }, 'Endpoint 一覧', null), []);
  assert.deepEqual(N.problemsOf({ meaning: 'https://Example.com/ を開く' }, 'https://example.com/', null), []);
});

test('only what a notification area or a passing toast showed is the result, in any language', async () => {
  const withChange = (change) => ({ ...rec, steps: rec.steps.map((s) => (s.id === 's4' ? { ...s, change } : s)) });
  const resultOf = async (change) => (await N.narrate(withChange(change), { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => units[s.id] }))
    .operations.find((o) => o.id === 's4')?.ai.result;
  assert.equal(await resultOf({ appeared: ['この記事では、私が旅に出た話をしました。'] }), undefined);
  assert.equal(await resultOf({ appeared: ['Saved'], notices: ['Saved'] }), '「Saved」と表示された');
  assert.equal(await resultOf({ appeared: [], transient: ['Changes saved.'] }), '「Changes saved.」と表示された');
});

test('a URL in an answer is accepted only as a whole URL that was read', () => {
  assert.match(N.problemsOf({ meaning: 'https://example.com/a を開く' }, 'URL: https://example.com/abc', null)[0], /URL/);
  assert.deepEqual(N.problemsOf({ meaning: 'https://example.com/abc を開いた。' }, 'URL: https://example.com/abc', null), []);
});

test('what a status area on the reached screen says is the result, whatever its wording', async () => {
  const withStatus = { ...units, s6: [...units.s6, { kind: 'feedback', text: '3 results', order: 3 }] };
  const result = await N.narrate(rec, { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => withStatus[s.id] });
  assert.equal(result.operations.find((o) => o.id === 's4').ai.result, '「3 results」と表示された');
});

test('a screen opened by itself later is not the result of the operation before it', async () => {
  const later = { ...rec, steps: rec.steps.map((s) => (s.id === 's5' ? { ...s, t: 20000 } : s)) };
  const withStatus = { ...units, s6: [...units.s6, { kind: 'feedback', text: 'ようこそ', order: 3 }] };
  const result = await N.narrate(later, { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => withStatus[s.id] });
  assert.equal(result.operations.find((o) => o.id === 's4')?.ai.result, undefined);
  const caused = await N.narrate(rec, { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => withStatus[s.id] });
  assert.equal(caused.operations.find((o) => o.id === 's4').ai.result, '「ようこそ」と表示された');
});

test('without a downloaded model the recording is described by the template, pointing at the button that downloads it', async () => {
  let created = 0;
  const LM = { availability: async () => 'downloadable', create: async () => { created += 1; throw new Error('not here'); } };
  const result = await N.narrate(rec, { LM, scan, unitsOf: (s) => units[s.id] });
  assert.equal(result.generator, 'template');
  assert.match(result.reason, /押すとダウンロード/);
  assert.equal(created, 0);
});

test('a WebMCP tool call, recorded after it ran, is given no meaning or result and ends the operation before it', async () => {
  const withTool = { ...rec, steps: [...rec.steps.slice(0, 4),
    { id: 's4t', type: 'tool', t: 1200, url: 'https://example.com/', tool: 'search', args: { q: 'shoes' }, ok: true }, ...rec.steps.slice(4)] };
  const withStatus = { ...units, s6: [...units.s6, { kind: 'feedback', text: '検索しました', order: 3 }] };
  const result = await N.narrate(withTool, { LM: fakeModel(goodAnswers), scan, unitsOf: (s) => withStatus[s.id] });
  assert.ok(!result.operations.some((o) => o.id === 's4t'));
  assert.equal(result.operations.find((o) => o.id === 's4')?.ai.result, undefined);
});

test('links without a scheme, link syntax and script schemes are rejected', () => {
  for (const summary of ['[確認](//evil.example/path)', '//evil.example/path を開いた', '[確認](javascript:alert(document.domain))',
    'javascript:void(0) を実行', '<a href="x">確認</a>', '![x](data:image/png;base64,AA)', '<https://example.com/>']) {
    assert.ok(N.problemsOf({ summary }, '操作 https://example.com/', null).length, summary);
  }
  assert.deepEqual(N.problemsOf({ summary: '「a/b//c」を入力した' }, '入力 a/b//c', null), []);
});

test('numbers written in kanji are compared by value', () => {
  assert.match(N.problemsOf({ summary: '二十件見つかった' }, '10件見つかった', null)[0], /読んだ文章にない数字（20）/);
  assert.match(N.problemsOf({ summary: '三人に送った' }, '送信', null)[0], /数字（3）/);
  for (const summary of ['第七章を開いた', '七番を選んだ', '零件だった', '一兆件ある', '一行目を消した']) {
    assert.match(N.problemsOf({ summary }, '操作した', null)[0] || '', /読んだ文章にない数字/, summary);
  }
  for (const [summary, source] of [['十件見つかった', '10件'], ['五千円', '¥5,000'], ['1万円', '10000円'], ['二〇二六年', '2026年'], ['1兆円', '1000000000000円']]) {
    assert.deepEqual(N.problemsOf({ summary }, source, null), [], summary);
  }
  // Words with number kanji are not numbers.
  assert.deepEqual(N.problemsOf({ summary: '一覧を開き、十分に待った。万一に備えて千葉の百貨店を選んだ' }, '一覧 千葉 百貨店', null), []);
});
