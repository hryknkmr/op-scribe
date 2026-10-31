import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../shared/units.js');

const units = [
  { kind: 'landmark', name: '本文', text: 'その他の文章', order: 5 },
  { kind: 'form', name: '検索', text: 'キーワード [search]', order: 2 },
  { kind: 'page', name: '', text: 'タイトル: 検索', order: 0 },
  { kind: 'feedback', name: '', text: '入力してください', order: 1 },
  { kind: 'list', name: '', text: 'A\nB\nC', count: 3, order: 3 }
];

test('units are packed whole, most informative first', () => {
  const [page] = U.paginate(units, 1000);
  const headers = page.match(/【[^】]+】/g);
  assert.deepEqual(headers, ['【ページ】', '【メッセージ】', '【フォーム「検索」】', '【一覧（3 件）】', '【領域「本文」】']);
});

test('units that do not fit start a new page, never split when they fit alone', () => {
  const pages = U.paginate(units, 40);
  assert.ok(pages.length > 1);
  for (const page of pages) assert.ok(page.length <= 40, page);
  assert.ok(pages.some((p) => p.includes('【フォーム「検索」】\nキーワード [search]')));
});

test('a unit larger than one reading is split into numbered pages at line and sentence boundaries', () => {
  const long = { kind: 'section', name: '規約', text: '第1条 本規約は適用されます。'.repeat(20) + '\n' + '第2条 定義。'.repeat(20), order: 0 };
  const pages = U.paginate([long], 120);
  assert.ok(pages.length > 3);
  pages.forEach((page, i) => {
    assert.ok(page.length <= 120, `page ${i} is ${page.length}`);
    assert.match(page, new RegExp(`^【区画「規約」（${i + 1}/${pages.length}）】\\n`));
  });
  // nothing is lost
  const joined = pages.map((p) => p.replace(/^【[^】]+】\n/, '')).join('');
  assert.equal(joined.replace(/\s/g, ''), long.text.replace(/\s/g, ''));
});

test('splitText prefers sentence ends to hard cuts', () => {
  assert.deepEqual(U.splitText('一つ目。二つ目。三つ目。', 9), ['一つ目。二つ目。', '三つ目。']);
});
