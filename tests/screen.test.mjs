import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Screen = require('../shared/screen.js');
const D = require('../shared/describe.js');

const kinds = (result) => result.purposes.map((p) => p.kind);

test('intentOf reads the purpose of a label', () => {
  assert.equal(Screen.intentOf('下書き保存'), 'update');
  assert.equal(Screen.intentOf('記事を削除'), 'delete');
  assert.equal(Screen.intentOf('新規作成'), 'create');
  assert.equal(Screen.intentOf('CSV をダウンロード'), 'output');
  assert.equal(Screen.intentOf('キャンセル'), 'dismiss');
  assert.equal(Screen.intentOf('Sign in'), 'auth');
  assert.equal(Screen.intentOf('急上昇'), null);
});

test('a page with a search form and a long list of cards is a search/list screen', () => {
  const result = Screen.classifyScreen({
    url: 'https://example.com/search?q=x',
    title: '検索結果',
    forms: [{ kind: 'search', fields: [{ type: 'search', label: 'キーワード' }], submit: '検索' }],
    repeated: { count: 20 }
  });
  assert.deepEqual(kinds(result).slice(0, 2).sort(), ['list', 'search']);
  assert.match(result.summary, /の画面$/);
});

test('a login form is an auth screen', () => {
  const result = Screen.classifyScreen({
    url: 'https://example.com/login',
    forms: [{ kind: 'form', fields: [{ type: 'email', label: 'メール' }, { type: 'password', label: 'パスワード' }], submit: 'ログイン' }]
  });
  assert.equal(kinds(result)[0], 'auth');
  assert.ok(result.purposes[0].reasons.includes('パスワード欄'));
});

test('an editor with save and delete buttons is a create/update screen', () => {
  const result = Screen.classifyScreen({
    url: 'https://example.com/notes/123/edit',
    editor: true,
    buttons: ['下書き保存', '公開に進む', '削除']
  });
  assert.ok(kinds(result).includes('update'));
  assert.ok(kinds(result).includes('create'));
});

test('a long article without forms is a detail screen', () => {
  const result = Screen.classifyScreen({ url: 'https://example.com/n/abc', article: true, textLength: 4200 });
  assert.equal(kinds(result)[0], 'detail');
});

test('an empty page falls back to browse', () => {
  assert.deepEqual(kinds(Screen.classifyScreen({ url: 'https://example.com/' })), ['browse']);
});

test('describeComponents names forms, lists and navigation', () => {
  const parts = Screen.describeComponents({
    forms: [{ kind: 'search', fields: [{ type: 'search', label: 'キーワード' }] }],
    repeated: { count: 12 },
    navLinks: ['ホーム', '急上昇']
  });
  assert.deepEqual(parts, ['検索フォーム（キーワード）', '一覧（同じ形のリンク 12 件）', 'ナビゲーション（ホーム、急上昇）']);
});

const screen = (url, title, extra = {}) => ({
  type: 'screen',
  url,
  screen: { title, h1: '', summary: extra.summary || '一覧の閲覧の画面', purposes: [{ kind: 'list', label: '一覧の閲覧', reasons: ['同じ形のリンクが 20 件'] }], components: extra.components || ['一覧（同じ形のリンク 20 件）'] }
});

const rec = {
  id: 'rec-screen',
  privacyLevel: 'strict',
  startUrl: 'https://example.com/',
  steps: [
    { type: 'navigate', t: 0, url: 'https://example.com/' },
    screen('https://example.com/', 'トップ', { summary: '検索・閲覧の画面', components: ['検索フォーム（キーワード）'] }),
    { type: 'click', t: 1000, url: 'https://example.com/', target: { role: 'link', name: '急上昇', component: { kind: 'nav' } } },
    { type: 'navigate', t: 1300, url: 'https://example.com/trend' },
    screen('https://example.com/trend', '急上昇'),
    { type: 'click', t: 3000, url: 'https://example.com/trend', target: { role: 'link', name: 'ある記事', component: { kind: 'list', size: 20 } } },
    { type: 'navigate', t: 3200, url: 'https://example.com/n/abc' },
    screen('https://example.com/n/abc', 'ある記事', { summary: '詳細の閲覧の画面', components: ['本文（約 4200 文字）'] })
  ]
};

test('steps are grouped under the screen they happened on, with the screen it led to', () => {
  const repro = D.buildReproduction(rec);
  assert.deepEqual(repro.screens.map((s) => s.title), ['トップ', '急上昇', 'ある記事']);
  assert.equal(repro.steps[1].action, 'ナビゲーションの「急上昇」リンクをクリックする');
  assert.equal(repro.steps[1].expected, '「急上昇」画面に遷移する');
  assert.equal(repro.steps[2].action, '一覧（20 件）の「ある記事」リンクをクリックする');
  assert.equal(repro.steps[2].screen, 1);
  assert.equal(repro.title, '「トップ」から「ある記事」までの操作（3 ステップ）');

  const md = D.toMarkdown(repro);
  assert.match(md, /### 画面 2: 「急上昇」\n- URL: https:\/\/example\.com\/trend\n- 画面の目的: 一覧の閲覧の画面（根拠: 同じ形のリンクが 20 件）\n- 主な UI: 一覧（同じ形のリンク 20 件）\n\n3\. 一覧（20 件）の「ある記事」リンクをクリックする/);
});

test('Gherkin describes each screen it reaches, with purpose and UI rows', () => {
  const feature = D.toGherkin(rec);
  assert.match(feature, /Given 「トップ」画面を開いている\n {6}\| url +\| https:\/\/example\.com\/ \|\n {6}\| title +\| トップ +\|\n {6}\| purpose \| 検索・閲覧の画面 \|/);
  assert.match(feature, /When ナビゲーションの「急上昇」リンクをクリックする\n {6}\| action +\| click +\|\n {6}\| url +\| https:\/\/example\.com\/ \|\n {6}\| component \| ナビゲーション \|/);
  assert.match(feature, /Then 「急上昇」画面が表示される\n {6}\| url +\| https:\/\/example\.com\/trend \|/);
  assert.match(feature, /\| ui +\| 本文（約 4200 文字） \|/);
  assert.doesNotMatch(feature, /に遷移する/); // the screen line replaces the bare URL line
});

test('isPageRewrite folds a same-page URL change that no operation caused', () => {
  const steps = [
    { type: 'navigate', t: 500, url: 'https://example.com/n/abc?gs=[[v]]' },
    screen('https://example.com/n/abc?gs=[[v]]', 'ある記事')
  ];
  const folded = D.isPageRewrite(steps, { type: 'navigate', t: 1800, url: 'https://example.com/n/abc' });
  assert.equal(folded?.length, 2);
  assert.equal(D.isPageRewrite(steps, { type: 'navigate', t: 1800, url: 'https://example.com/n/other' }), null);
  assert.equal(D.isPageRewrite([...steps, { type: 'click', t: 1000 }], { type: 'navigate', t: 1800, url: 'https://example.com/n/abc' }), null);
});

test('a list page with lots of card text is not mistaken for a detail page', () => {
  const result = Screen.classifyScreen({ url: 'https://example.com/trend', repeated: { count: 30 }, textLength: 5000 });
  assert.deepEqual(kinds(result), ['list']);
  assert.ok(!Screen.describeComponents({ repeated: { count: 30 }, textLength: 5000 }).some((c) => c.startsWith('本文')));
});

test('strict mode describes navigation and headings by count only', () => {
  assert.deepEqual(Screen.describeComponents({ navCount: 8, headingCount: 3, buttons: ['検索'] }),
    ['ナビゲーション（リンク 8 件）', 'ボタン（検索）', '見出し 3 個']);
});

test('the same screen after operations keeps its own section; a plain refresh of it does not', () => {
  const list = (ai) => ({ ...screen('https://example.com/tasks', 'タスク一覧', { summary: '一覧の閲覧の画面' }), ...(ai ? { screen: { title: 'タスク一覧', summary: '一覧の閲覧の画面', purposes: [], components: [], ai } } : {}) });
  const repro = D.buildReproduction({
    steps: [
      { type: 'navigate', t: 0, url: 'https://example.com/tasks' },
      list({ purpose: '7 件の一覧', summary: '' }),
      list(null),  // captured again with nothing done: a refresh, the understanding is kept
      { type: 'click', t: 1000, url: 'https://example.com/tasks', target: { role: 'button', name: '削除する' },
        change: { appeared: ['6 件'], removed: [], transient: ['タスクを削除しました'] } },
      list({ purpose: '6 件の一覧', summary: '' })
    ]
  });
  assert.deepEqual(repro.screens.map((s) => s.ai?.purpose), ['7 件の一覧', '6 件の一覧']);
  assert.deepEqual(repro.steps[1].transient, ['タスクを削除しました']);
  const md = D.toMarkdown(repro);
  assert.match(md, /- 操作後に現れた文字: 「6 件」\n {3}- 操作後に一時的に表示された文字: 「タスクを削除しました」/);
  assert.match(md, /### 画面 2: 「タスク一覧」/);
  assert.match(D.toGherkin({ steps: repro && [
    { type: 'click', t: 0, url: 'https://example.com/tasks', target: { role: 'button', name: '削除する' }, change: { appeared: [], removed: [], transient: ['タスクを削除しました'] } }
  ] }), /\| transient +\| タスクを削除しました \|/);
});

test('Gherkin shows the same screen again as the result of an operation, but not a plain refresh', () => {
  const list = () => screen('https://example.com/tasks', 'タスク一覧', { summary: '一覧の閲覧の画面' });
  const feature = D.toGherkin({ steps: [
    { type: 'navigate', t: 0, url: 'https://example.com/tasks' },
    list(),
    list(),
    { type: 'click', t: 1000, url: 'https://example.com/tasks', target: { role: 'button', name: '削除する' } },
    list()
  ] });
  assert.equal(feature.match(/「タスク一覧」画面/g).length, 2);  // the Background and the result of the click
  assert.match(feature, /When 「削除する」ボタンをクリックする[\s\S]*\n {4}Then 「タスク一覧」画面が表示される/);
});

test('an encyclopedia article is a detail page despite its site search, settings radios and in-text links', () => {
  const result = Screen.classifyScreen({
    url: 'https://example.com/wiki/Tower',
    title: 'Tower - Example',
    forms: [
      { kind: 'search', global: true, fields: [{ type: 'search', label: '検索' }], submit: '検索' },
      { kind: 'form', fields: [{ type: 'radio', label: '小' }, { type: 'radio', label: '標準' }, { type: 'radio', label: '大' }], submit: '' }
    ],
    repeated: { count: 1519 },
    tables: 40,
    prose: 30000
  });
  assert.deepEqual(kinds(result), ['detail']);
  const parts = Screen.describeComponents({ prose: 30000, repeated: { count: 1519 } });
  assert.ok(parts.includes('本文（約 30000 文字）'));
  assert.ok(!parts.some((p) => p.startsWith('一覧')));
});

test('a search box on the page itself still makes it a search screen', () => {
  const result = Screen.classifyScreen({ url: 'https://example.com/', forms: [{ kind: 'search', fields: [{ type: 'search', label: 'q' }], submit: '検索' }] });
  assert.equal(kinds(result)[0], 'search');
});
