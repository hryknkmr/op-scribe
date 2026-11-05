// A recording as a Playwright test (Issue #2): made from a checked payload, run here against a stand-in page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../shared/payload.js');
const F = require('../shared/formats.js');
const { toPlaywright } = require('../shared/playwright.js');

const T0 = Date.UTC(2026, 10, 5, 1, 0, 0);
const A = 'https://site-1.invalid';
const base = { t: 0, env: 'standard', source: 'user' };

const recordingOf = (steps, extra = {}) => P.buildPayload({ id: 'rec-pw-1', startedAt: T0, endedAt: T0 + 60000, aliases: {}, redactions: {}, webmcpTools: {}, steps, ...extra },
  { generator: 'none', markdown: '' }, {}).recording;

/**
 * Runs a generated file against a stand-in page whose elements are { role, name, selector }.
 * Returns the calls made, or throws what the test would have failed with.
 */
async function run(text, { elements = [], env = {}, pages = 1, urls = [] } = {}) {
  const calls = [];
  const code = text.split('\n').filter((l) => !l.startsWith('import ')).join('\n');
  // A click on an element with { to } moves its page there, as a link would.
  const locator = (page, match, how) => ({
    count: async () => elements.filter(match).length,
    click: async () => {
      calls.push(['click', how]);
      const to = elements.find(match)?.to;
      if (to) page.setUrl(to);
    },
    fill: async (v) => calls.push(['fill', how, v]),
    selectOption: async (v) => calls.push(['select', how, v]),
    setChecked: async (v) => calls.push(['check', how, v]),
    setInputFiles: async (v) => calls.push(['files', how, v]),
    press: async (k) => calls.push(['press', how, k])
  });
  const makePage = (id) => {
    let url = 'about:blank';
    const page = {
      id,
      url: () => url,
      goto: async (to) => { url = to; calls.push(['goto', id, to]); },
      // An element with { page } is on that page only.
      getByRole: (role, { name, exact }) => {
        assert.equal(exact, true);
        return locator(page, (e) => (e.page ?? id) === id && e.role === role && e.name === name, `role=${role} name=${name}`);
      },
      locator: (selector) => locator(page, (e) => (e.page ?? id) === id && e.selector === selector, `css=${selector}`),
      keyboard: { press: async (k) => calls.push(['press', 'page', k]) },
      setUrl: (to) => { url = to; }
    };
    return page;
  };
  const all = Array.from({ length: Math.max(pages, urls.length) }, (_, i) => makePage(i + 1));
  urls.forEach((u, i) => { if (u) all[i].setUrl(u); });
  const context = { pages: () => all };
  let body = null;
  class Fixme extends Error {}
  const fakeTest = (title, fn) => { body = fn; };
  fakeTest.fixme = (cond, why) => { if (cond) throw new Fixme(why); };
  const poll = (fn, opts = {}) => {
    const check = (ok) => async (want) => {
      const got = await fn();
      if (!ok(got, want)) throw new Error(opts.message || `poll: ${got} vs ${want}`);
    };
    return { toBe: check((g, w) => g === w), toBeGreaterThan: check((g, w) => g > w) };
  };
  const expect = Object.assign(() => { throw new Error('no plain expect is written'); }, { poll });
  const AsyncFunction = (async () => {}).constructor;
  await new AsyncFunction('test', 'expect', 'process', 'delimiter', code)(fakeTest, expect, { env }, ':');
  assert.equal(typeof body, 'function');
  try {
    await body({ page: all[0], context });
  } catch (error) {
    if (error instanceof Fixme) return { calls, fixme: error.message };
    throw error;
  }
  return { calls, pages: all };
}

test('operations find their element by role + name, else selector, and fill kept values as recorded (#2)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: [`${A}/form?x=1`] },
    { ...base, type: 'input', url: [`${A}/form`], target: { role: 'textbox', name: ['件名'], tag: 'input', selector: '#subject' }, value: { treatment: 'kept', field: 'text', text: ['こんにちは'] } },
    { ...base, type: 'select', url: [`${A}/form`], target: { role: 'combobox', name: ['種類'], tag: 'select' }, value: { treatment: 'kept', field: 'choice', text: ['質問'] } },
    { ...base, type: 'check', url: [`${A}/form`], target: { role: 'checkbox', name: ['同意する'], tag: 'input' }, checked: true },
    { ...base, type: 'key', url: [`${A}/form`], key: 'ctrl+Enter' },
    { ...base, type: 'click', t: 100, url: [`${A}/form`], target: { role: 'button', name: ['送信'], tag: 'button', selector: '[data-testid="send"]' } },
    { ...base, type: 'navigate', t: 200, source: 'unknown', url: [`${A}/done`] }
  ]);
  const text = toPlaywright(rec);
  assert.match(text, /^\/\/ op-scribe: Playwright のテスト/);
  assert.match(text, /^import \{ test, expect \} from "@playwright\/test";$/m);
  const elements = [
    { role: 'textbox', name: '件名', selector: '#subject' },
    { role: 'combobox', name: '種類' },
    { role: 'checkbox', name: '同意する' },
    // Two buttons named 送信: the selector decides.
    { role: 'button', name: '送信', selector: '[data-testid="send"]', to: 'https://staging.example.com/done' },
    { role: 'button', name: '送信', selector: '#other' }
  ];
  const { calls } = await run(text, { elements, env: { OPSCRIBE_SITE_1: 'https://staging.example.com' } });
  assert.deepEqual(calls, [
    ['goto', 1, 'https://staging.example.com/form?x=1'],
    ['fill', 'role=textbox name=件名', 'こんにちは'],
    ['select', 'role=combobox name=種類', { label: '質問' }],
    ['check', 'role=checkbox name=同意する', true],
    ['press', 'page', 'Control+Enter'],
    ['click', 'css=[data-testid="send"]']
  ]);
  // The navigation the click caused is checked, not opened: a click that goes nowhere fails it.
  elements[3].to = undefined;
  await assert.rejects(run(text, { elements, env: { OPSCRIBE_SITE_1: 'https://staging.example.com' } }), /ステップ 7: 記録した画面（https:\/\/staging\.example\.com\/done）にいない/);
});

test('a caused navigation is checked by its path; an ambiguous element stops without a guess (#2)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'click', t: 100, url: ['https://www.example.com/a'], target: { role: 'link', name: ['次へ'], tag: 'a' } },
    { ...base, type: 'navigate', t: 200, source: 'unknown', url: ['https://www.example.com/b'] }
  ]);
  const text = toPlaywright(rec);
  // A host that is not an alias is opened as recorded, with no OPSCRIBE_SITE variable.
  assert.doesNotMatch(text, /OPSCRIBE_SITE/);
  assert.match(text, /await at\(page, "https:\/\/www\.example\.com\/b", 3\);/);
  await assert.rejects(run(text, { elements: [{ role: 'link', name: '次へ' }, { role: 'link', name: '次へ' }] }), /ステップ 2: 対象が一つに決まらない/);
  await assert.rejects(run(text, { elements: [{ role: 'link', name: '次へ' }] }), /ステップ 3: 記録した画面（https:\/\/www\.example\.com\/b）にいない/);
  const { calls } = await run(text, { elements: [{ role: 'link', name: '次へ', to: 'https://www.example.com/b' }] });
  assert.deepEqual(calls, [['goto', 1, 'https://www.example.com/a'], ['click', 'role=link name=次へ']]);
});

test('masked values, files and aliased origins come from the environment, and a missing one stops (#2)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: [`${A}/login`] },
    { ...base, type: 'input', url: [`${A}/login`], target: { role: 'textbox', name: ['メール'], tag: 'input' }, value: { treatment: 'redacted', field: 'pii', kind: 'email' } },
    { ...base, type: 'input', url: [`${A}/login`], target: { role: 'textbox', name: ['メモ'], tag: 'textarea' }, value: { treatment: 'length', field: 'text', kind: 'text', length: 0 } },
    { ...base, type: 'upload', url: [`${A}/login`], target: { role: 'button', name: ['添付'], tag: 'input' }, value: { treatment: 'redacted', field: 'file', kind: 'file', count: 2 } }
  ]);
  const text = toPlaywright(rec);
  assert.match(text, /^import \{ delimiter \} from "node:path";$/m);
  const elements = [{ role: 'textbox', name: 'メール' }, { role: 'textbox', name: 'メモ' }, { role: 'button', name: '添付' }];
  await assert.rejects(run(text, { elements }), /OPSCRIBE_SITE_1 に実際の origin/);
  await assert.rejects(run(text, { elements, env: { OPSCRIBE_SITE_1: 'http://localhost:3000' } }), /OPSCRIBE_VALUE_2 に ‹メールアドレス› のテスト値/);
  const { calls } = await run(text, { elements, env: { OPSCRIBE_SITE_1: 'http://localhost:3000', OPSCRIBE_VALUE_2: 'qa@example.com', OPSCRIBE_FILES_4: 'a.png:b.png' } });
  assert.deepEqual(calls, [
    ['goto', 1, 'http://localhost:3000/login'],
    ['fill', 'role=textbox name=メール', 'qa@example.com'],
    ['fill', 'role=textbox name=メモ', ''],
    ['files', 'role=button name=添付', ['a.png', 'b.png']]
  ]);
});

test('a step with nothing to find its element by, or a masked URL to open, stops the test (#2)', async () => {
  const noCue = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    // The name was masked whole and there is no selector.
    { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: [{ redacted: 'email' }], tag: 'button' } }
  ]);
  // A stop is a failure, never a skip that would pass as green.
  await assert.rejects(run(toPlaywright(noCue)), /ステップ 2: 対象を見つける手がかり/);
  assert.doesNotMatch(toPlaywright(noCue), /test\.(fixme|skip)/);
  const maskedUrl = recordingOf([{ ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/users/', { redacted: 'id' }] }]);
  await assert.rejects(run(toPlaywright(maskedUrl)), /ステップ 1: 開く URL が伏せてある/);
});

test('what the page showed, expectations, notes and tool calls are comments, never steps (#2)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'notice', source: 'unknown', url: ['https://www.example.com/a'], notice: ['保存しました'], level: 'status' },
    { ...base, type: 'note', note: ['保存できる'], ref: 'E-abcdef', verdict: 'ng', actual: ['できない'] },
    { ...base, type: 'note', note: ['二重に送られる'], kind: 'bug' },
    { ...base, type: 'tool', source: 'agent', url: ['https://www.example.com/a'], tool: ['search'], ok: true }
  ], { endedAt: T0 + 60000 });
  const text = toPlaywright(rec);
  assert.match(text, /\/\/ 期待結果 \[E-abcdef\]（判定: NG）/);
  assert.match(text, /\/\/ \[不具合\] 二重に送られる/);
  assert.match(text, /\/\/ WebMCP ツールの呼び出しは書き出さない/);
  const { calls } = await run(text);
  assert.deepEqual(calls, [['goto', 1, 'https://www.example.com/a']]);
});

test('a step in another tab switches to the one new page on its path, and stops when that is not one (#40, #2)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', tab: 1, url: ['https://www.example.com/a'] },
    // Tab 3 first: its steps follow the page it was on, not the order the tabs appear in.
    { ...base, type: 'click', tab: 3, url: ['https://www.example.com/c'], target: { role: 'button', name: ['OK'], tag: 'button' } },
    { ...base, type: 'click', tab: 2, url: ['https://www.example.com/b'], target: { role: 'button', name: ['OK'], tag: 'button' } }
  ]);
  const text = toPlaywright(rec);
  assert.match(text, /page = await tabOf\(context, opened, 3, "https:\/\/www\.example\.com\/c"\);/);
  // Page 2 shows /b and page 3 shows /c: each click lands on the page of its own step.
  const urls = [null, 'https://www.example.com/b', 'https://www.example.com/c'];
  const ok = await run(text, { elements: [{ role: 'button', name: 'OK', page: 3 }, { role: 'button', name: 'OK', page: 2 }], urls });
  assert.deepEqual(ok.calls.slice(1), [['click', 'role=button name=OK'], ['click', 'role=button name=OK']]);
  // Were the steps on page 2 run on page 3 (or the other way round), find() would find nothing there.
  await assert.rejects(run(text, { elements: [{ role: 'button', name: 'OK', page: 3 }], urls: [null, 'https://www.example.com/b', 'https://www.example.com/c'] }), /ステップ 3: 対象が一つに決まらない/);
  // No page on the path, or two: it stops.
  await assert.rejects(run(text, { urls: [null, 'https://www.example.com/b'] }), /タブ 3: https:\/\/www\.example\.com\/c を開いているタブが一つに決まらない/);
  await assert.rejects(run(text, { urls: [null, 'https://www.example.com/c', 'https://www.example.com/c'] }), /タブ 3: https:\/\/www\.example\.com\/c を開いているタブが一つに決まらない/);
  // Same path on another origin is not the tab.
  await assert.rejects(run(text, { urls: [null, 'https://www.example.com/b', 'https://other.example.com/c'] }), /タブ 3: https:\/\/www\.example\.com\/c を開いているタブが一つに決まらない/);
  // A tab whose step has a masked URL cannot be told apart.
  const masked = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', tab: 1, url: ['https://www.example.com/a'] },
    { ...base, type: 'click', tab: 2, url: ['https://www.example.com/u/', { redacted: 'id' }], target: { role: 'button', name: ['OK'], tag: 'button' } }
  ]);
  await assert.rejects(run(toPlaywright(masked), { pages: 2 }), /タブ 2 を見分けられない/);
});

test('the page\'s text never becomes code: quotes, line breaks and hidden characters stay inside escaped literals (#2, E7)', async () => {
  const evil = '"); process.exit(1); ("\u2028`${x}`\u0085';
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: [evil], tag: 'button', selector: '[data-x="*/\n"]' } },
    // A name with a character that hides or reorders text is not used to find anything (the masking removes them anyway).
    { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: ['abc\u202e'], tag: 'button' } }
  ]);
  const text = toPlaywright(rec);
  assert.doesNotMatch(text, /[\u2028\u2029\u202e\u0085]/u);
  // Every line is one line of code or comment: none starts with page text.
  for (const l of text.split('\n')) assert.doesNotMatch(l, /^process\.exit/);
  const name = rec.steps[1].target.name.join('');
  // The click on the evil name happens; the next step stops, and the stop says so.
  await assert.rejects(run(text, { elements: [{ role: 'button', name }] }), /ステップ 3: 対象を見つける手がかり/);
  const clicked = await run(text.replace(/^  throw new Error\(.*$/m, ''), { elements: [{ role: 'button', name }] });
  assert.deepEqual(clicked.calls.at(-1), ['click', `role=button name=${name}`]);
});

test('the Playwright test goes through the formats exit: a keyword registered later stops it (#2, E6)', () => {
  const steps = [
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: ['Acme に送る'], tag: 'button' } }
  ];
  const payload = P.buildPayload({ id: 'rec-pw-2', startedAt: T0, aliases: {}, redactions: {}, webmcpTools: {}, steps }, { generator: 'none', markdown: '' }, {});
  const clean = F.checkedFormats(payload, { keywords: [], hosts: [] });
  assert.ok(clean.playwright.text.includes('Acme に送る'));
  assert.equal(clean.playwright.findings.length, 0);
  const word = F.checkedFormats(payload, { keywords: ['Acme'], hosts: [] });
  assert.equal(word.playwright.text, null);
  assert.ok(word.playwright.findings.length);
  // The same recording gives the same file.
  assert.equal(toPlaywright(payload.recording), clean.playwright.text);
});

test('a navigation after a tool call is opened, not checked: the test does not replay the call (#2, review of #80)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'tool', t: 10, source: 'agent', url: ['https://www.example.com/a'], tool: ['next'], ok: true },
    { ...base, type: 'navigate', t: 20, source: 'unknown', url: ['https://www.example.com/next'] },
    { ...base, type: 'click', t: 30, url: ['https://www.example.com/next'], target: { role: 'link', name: ['戻る'], tag: 'a' } },
    { ...base, type: 'navigate', t: 40, source: 'unknown', url: ['https://www.example.com/a'] }
  ]);
  const text = toPlaywright(rec);
  // The comment says what the line does: open, or check where the click went.
  assert.match(text, /\/\/ 3\. https:\/\/www\.example\.com\/next を開く\n  await page\.goto\("https:\/\/www\.example\.com\/next"\);/);
  assert.match(text, /\/\/ 5\. https:\/\/www\.example\.com\/a に遷移したことを確かめる\n  await at\(page, "https:\/\/www\.example\.com\/a", 5\);/);
  const { calls } = await run(text, { elements: [{ role: 'link', name: '戻る', to: 'https://www.example.com/a' }] });
  assert.deepEqual(calls, [['goto', 1, 'https://www.example.com/a'], ['goto', 1, 'https://www.example.com/next'], ['click', 'role=link name=戻る']]);
});

test('a keyword hidden by an escape inside a literal still stops the exit (#2, E6, review of #80)', () => {
  // CSS reads \m as m and \6d  as m: both selectors name "acme". The file holds them with the backslash doubled.
  for (const selector of ['[data-x="ac\\me"]', '[data-x="ac\\6d e"]']) {
    const steps = [
      { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
      { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: ['OK'], tag: 'button', selector } }
    ];
    const payload = P.buildPayload({ id: 'rec-pw-3', startedAt: T0, aliases: {}, redactions: {}, webmcpTools: {}, steps }, { generator: 'none', markdown: '' }, {});
    const made = F.checkedFormats(payload, { keywords: ['acme'], hosts: [] });
    assert.equal(made.playwright.text, null, selector);
    assert.ok(made.playwright.findings.some((f) => f.kinds.includes('keyword')), selector);
  }
});

test('a value or a name the masking cut short is never used as if whole (#2, review of #80)', async () => {
  const long = `${'x'.repeat(200)}…`;
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'input', url: ['https://www.example.com/a'], target: { role: 'textbox', name: ['本文'], tag: 'textarea' }, value: { treatment: 'kept', field: 'text', text: [long] } },
    { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: [`${'y'.repeat(80)}…`], tag: 'button', selector: '#go' } }
  ]);
  const text = toPlaywright(rec);
  assert.doesNotMatch(text, /"x{200}…"/);
  assert.doesNotMatch(text, /y{80}…"/);
  await assert.rejects(run(text, { elements: [{ role: 'textbox', name: '本文' }] }), /OPSCRIBE_VALUE_2 に 記録では途中で切れている値 のテスト値/);
  const { calls } = await run(text, { elements: [{ role: 'textbox', name: '本文' }, { selector: '#go' }], env: { OPSCRIBE_VALUE_2: 'z' } });
  assert.deepEqual(calls.slice(1), [['fill', 'role=textbox name=本文', 'z'], ['click', 'css=#go']]);
});

test('a step on a page the recording lost the way to stops instead of acting on the page it is on (#2, review of #80)', async () => {
  // The navigation to /admin was trimmed: the second click is recorded on /admin.
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/'] },
    { ...base, type: 'click', t: 10, url: ['https://www.example.com/'], target: { role: 'button', name: ['削除'], tag: 'button' } },
    { ...base, type: 'click', t: 20000, url: ['https://www.example.com/admin'], target: { role: 'button', name: ['削除'], tag: 'button' } }
  ], { trimmed: 'other' });
  const text = toPlaywright(rec);
  assert.match(text, /\/\/ 記録の一部が上限で消えている/);
  await assert.rejects(run(text, { elements: [{ role: 'button', name: '削除' }] }), /ステップ 3: 記録した画面（https:\/\/www\.example\.com\/admin）にいない/);
});

test('page text that looks like a masked part is shown apart from one in the comments (#2, E4)', () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: ['‹メールアドレス›'], tag: 'button' } }
  ]);
  const text = toPlaywright(rec);
  assert.match(text, /\/\/ 2\. 「〈メールアドレス〉」ボタンをクリックする/);
});

test('the draft says it is a draft, and checks the origin as well as the path (#2, owner decision 2026-11-05)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://site-1.invalid/home'] },
    // The navigation to site-2 was lost: the input is recorded on site-2's /home.
    { ...base, type: 'input', t: 20000, url: ['https://site-2.invalid/home'], target: { role: 'textbox', name: ['検索'], tag: 'input' }, value: { treatment: 'kept', field: 'search', text: ['a'] } }
  ]);
  const text = toPlaywright(rec);
  assert.match(text, /^\/\/ op-scribe: Playwright のテストの下書き/);
  assert.match(text, /そのまま実行した結果を合否の根拠にしない/);
  assert.doesNotMatch(text, /推測しない・記録どおり/);
  const env = { OPSCRIBE_SITE_1: 'https://one.example.com', OPSCRIBE_SITE_2: 'https://two.example.com' };
  await assert.rejects(run(text, { elements: [{ role: 'textbox', name: '検索' }], env }), /ステップ 2: 記録した画面（https:\/\/two\.example\.com\/home）にいない/);
});

test('a path with [ ] matches however the browser shows it (#2, review of #80)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a%5Bb%5D'] },
    { ...base, type: 'click', url: ['https://www.example.com/a%5Bb%5D'], target: { role: 'button', name: ['OK'], tag: 'button' } }
  ]);
  const text = toPlaywright(rec);
  const runAt = (shown) => run(text.replace('await page.goto("https://www.example.com/a%5Bb%5D");', `page.setUrl(${JSON.stringify(shown)});`), { elements: [{ role: 'button', name: 'OK' }] });
  assert.deepEqual((await runAt('https://www.example.com/a[b]')).calls, [['click', 'role=button name=OK']]);
  assert.deepEqual((await runAt('https://www.example.com/a%5Bb%5D')).calls, [['click', 'role=button name=OK']]);
});

test('a step the draft does not replay never switches tabs, and an empty recording is no failure (#2, review of #80)', async () => {
  const rec = recordingOf([
    { ...base, type: 'navigate', source: 'unknown', tab: 1, url: ['https://www.example.com/a'] },
    { ...base, type: 'notice', source: 'unknown', tab: 2, url: ['https://www.example.com/b'], notice: ['開きました'], level: 'status' },
    { ...base, type: 'tool', source: 'agent', tab: 2, url: ['https://www.example.com/b'], tool: ['x'], ok: true }
  ]);
  const text = toPlaywright(rec);
  assert.doesNotMatch(text, /page = await tabOf/);
  assert.deepEqual((await run(text)).calls, [['goto', 1, 'https://www.example.com/a']]);
  const empty = toPlaywright(recordingOf([]));
  assert.doesNotMatch(empty, /throw new Error\("/);
  assert.deepEqual((await run(empty)).calls, []);
});

test('the exit scans the page\'s text, not the generator\'s code: a keyword like "page" stops only a draft that holds it (#2, owner decision 2026-11-05)', () => {
  const make = (name) => P.buildPayload({ id: 'rec-pw-4', startedAt: T0, aliases: {}, redactions: {}, webmcpTools: {}, steps: [
    { ...base, type: 'navigate', source: 'unknown', url: ['https://www.example.com/a'] },
    { ...base, type: 'click', url: ['https://www.example.com/a'], target: { role: 'button', name: [name], tag: 'button' } }
  ] }, { generator: 'none', markdown: '' }, {});
  for (const word of ['page', 'await', 'test', 'find', 'クリック', 'タブ']) {
    assert.ok(F.checkedFormats(make('保存'), { keywords: [word], hosts: [] }).playwright.text, word);
  }
  const held = F.checkedFormats(make('page を保存'), { keywords: ['page'], hosts: [] }).playwright;
  assert.equal(held.text, null);
});
