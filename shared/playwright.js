/**
 * op-scribe - a recording as a Playwright test (Issue #2).
 *
 * Built straight from a checked payload's recording, like the Gherkin: no
 * browser, no page and no model is involved, so the same recording always
 * gives the same file. Nothing is guessed:
 *   - an element is found by role + name, then by selector, and only when one
 *     of them matches exactly one element (docs/FORMAT.md, "再生のルール");
 *     a step without either stops the test (test.fixme);
 *   - a masked value, a file and the real origin behind a site-N.invalid alias
 *     are read from environment variables, and a missing one stops the test;
 *   - what the page showed, the tester's expectations and WebMCP tool calls
 *     are comments, not assertions: they were observed, not specified.
 *
 * Masked parts are shown as ‹…› labels made by shared/describe.js, which alone
 * renders placeholders (AGENTS.md). Every text from the recording enters the
 * code as an escaped string literal or a one-line comment.
 *
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const { ALIAS_HOST, HIDDEN_CHARS, LIMITS, oneLine } = root.OpScribeLimits || require('./limits.js');
  const D = root.OpScribeDescribe || require('./describe.js');

  const txt = D.rendered;
  const HIDDEN = new RegExp(HIDDEN_CHARS, 'u');
  // Escaped in every literal, so the code shows what it holds and stays one line (E7).
  const UNSAFE = new RegExp(`[\\p{Cc}\\u2028\\u2029]|${HIDDEN_CHARS}`, 'gu');
  // The recording's text enters the file only through lit() and comment(). An escape here (a doubled
  // backslash, \") can hide a keyword from a scan of the file, so the exit scans the steps too (shared/formats.js).
  const lit = (text) => JSON.stringify(String(text)).replace(UNSAFE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  const comment = (text) => `// ${oneLine(String(text ?? '').replace(new RegExp(HIDDEN_CHARS, 'gu'), ''))}`;
  // A stop is a failure, not a skip: a run that cannot go on must not pass as green (review of #80).
  const stop = (why) => `throw new Error(${lit(why)});`;
  // The page's own ‹ and › as 〈 and 〉, so every ‹…› in a comment is a masked part (E4), as describe.js shows it.
  const shown = (text) => D.humanize(String(text ?? '').replace(/‹/g, '〈').replace(/›/g, '〉'));
  // A text the masking cut to n ends in the "…" it appends (limits.js, ellipsize): not what the page had.
  const isCut = (text, n) => text.endsWith('…') && [...text].length === n + 1;

  /** Runs that hold the page's text only, as that text; null when any part was masked. */
  function plain(runs) {
    if (typeof runs === 'string') return runs;
    if (!Array.isArray(runs) || !runs.every((p) => typeof p === 'string')) return null;
    return runs.join('');
  }

  /** A recorded URL as { aliasOf, origin, path }, or null when it was masked or cannot be read. */
  function urlOf(runs) {
    const text = plain(runs);
    if (!text) return null;
    try {
      const url = new URL(text);
      if (!/^https?:$/.test(url.protocol)) return null;
      return { alias: ALIAS_HOST.test(url.hostname) ? url.hostname.split('.')[0] : null, origin: url.origin, path: url.pathname, rest: `${url.pathname}${url.search}${url.hash}` };
    } catch {
      return null;
    }
  }
  const siteVar = (alias) => `OPSCRIBE_${alias.replace(/-/g, '_').toUpperCase()}`;

  /** What find() is given: a role and an exact name, and a selector, as far as the recording has them. */
  function locatorSpec(target) {
    if (!target) return null;
    const spec = [];
    const name = plain(target.name);
    if (/^[a-z]+$/.test(target.role || '') && name && name.trim() && !HIDDEN.test(name) && !isCut(name, LIMITS.name)) {
      spec.push(`role: ${lit(target.role)}`, `name: ${lit(name)}`);
    }
    if (typeof target.selector === 'string' && target.selector && !isCut(target.selector, LIMITS.selector)) spec.push(`selector: ${lit(target.selector)}`);
    return spec.length ? `{ ${spec.join(', ')} }` : null;
  }

  // Playwright's names for the modifiers the recording keeps (limits.js, VOCAB.key).
  const MODIFIERS = { ctrl: 'Control', meta: 'Meta', alt: 'Alt' };
  const keyOf = (key) => String(key).split('+').map((k) => MODIFIERS[k] || k).join('+');

  const TARGETED = new Set(['click', 'input', 'select', 'check', 'upload']);
  const OPERATIONS = new Set([...TARGETED, 'key']);
  const NOTE_KINDS = { bug: '不具合', question: '疑問', idea: '気づき', next: '次に試す' };
  const VERDICTS = { ok: 'OK', ng: 'NG' };

  const HELPERS = {
    at: [
      '/** That the page shows the path its step was on: anything else stops the test. */',
      'async function at(page, path, step) {',
      '  await expect.poll(() => new URL(page.url()).pathname, { message: `ステップ ${step}: 記録した画面（${path}）にいない` }).toBe(path);',
      '}'
    ],
    find: [
      '/** The element by role + name, else by selector: the first that matches exactly one element. Never a guess. */',
      'async function find(page, { role, name, selector }, step) {',
      '  let found = null;',
      '  await expect.poll(async () => {',
      '    if (role) {',
      '      const byRole = page.getByRole(role, { name, exact: true });',
      '      if (await byRole.count() === 1) { found = byRole; return true; }',
      '    }',
      '    if (selector) {',
      '      const bySelector = page.locator(selector);',
      '      if (await bySelector.count() === 1) { found = bySelector; return true; }',
      '    }',
      '    return false;',
      '  }, { message: `ステップ ${step}: 対象が一つに決まらない（推測して操作しない）` }).toBe(true);',
      '  return found;',
      '}'
    ],
    value: [
      '/** A value masked in the recording: supplied by the tester, never guessed. */',
      'function value(name, what) {',
      '  const supplied = process.env[name];',
      '  if (supplied === undefined) throw new Error(`${name} に ${what} のテスト値を渡してください（記録では伏せてある）`);',
      '  return supplied;',
      '}'
    ],
    files: [
      '/** The files to choose: paths in one variable, separated as in PATH. */',
      'function files(name, count) {',
      '  const supplied = process.env[name];',
      '  if (!supplied) throw new Error(`${name} にファイル ${count} 件のパスを渡してください（記録はファイルを残さない）`);',
      '  return supplied.split(delimiter);',
      '}'
    ],
    site: [
      '/** The real origin behind an alias (site-N.invalid): the recording does not keep it. */',
      'function site(name) {',
      '  const origin = process.env[name];',
      '  if (!origin) throw new Error(`${name} に実際の origin を渡してください（記録では別名にしてある）`);',
      '  return origin;',
      '}'
    ],
    tab: [
      '/** A tab of the recording, the first time: the one page not yet used that shows the path its step was on. Never a guess. */',
      'async function tabOf(context, opened, tab, path) {',
      '  if (!opened.has(tab)) {',
      '    if (path === null) throw new Error(`タブ ${tab} を見分けられない（そのステップの URL が伏せてある）`);',
      '    let found = null;',
      '    await expect.poll(() => {',
      '      const used = [...opened.values()];',
      '      const pages = context.pages().filter((p) => !used.includes(p) && new URL(p.url()).pathname === path);',
      '      found = pages.length === 1 ? pages[0] : null;',
      '      return pages.length;',
      '    }, { message: `タブ ${tab}: ${path} を開いているタブが一つに決まらない` }).toBe(1);',
      '    opened.set(tab, found);',
      '  }',
      '  return opened.get(tab);',
      '}'
    ]
  };

  /** The value a masked or kept input, select or upload step fills in, as code. */
  function valueCode(step, n, used) {
    const v = step.value || {};
    if (v.treatment === 'kept') {
      if (typeof v.number === 'number') return lit(String(v.number));
      const text = plain(v.text);
      // A value cut short is not what was typed or chosen: supplied like a masked one (review of #80).
      if (text !== null && !isCut(text, LIMITS.kept[v.field] ?? Infinity)) return lit(text);
    }
    if (v.treatment === 'length' && v.length === 0) return lit('');
    used.add('value');
    const what = v.treatment === 'kept' ? '記録では途中で切れている値' : D.humanize(D.display(v)) || '伏せた値';
    return `value(${lit(`OPSCRIBE_VALUE_${n}`)}, ${lit(what)})`;
  }

  /** The statements of one person's operation, or a stop when its element cannot be found. */
  function operation(step, n, used) {
    const acts = TARGETED.has(step.type) || (step.type === 'key' && step.target);
    let el = '';
    if (acts) {
      const spec = locatorSpec(step.target);
      if (!spec) return [stop(`ステップ ${n}: 対象を見つける手がかり（役割と名前・selector）が無い`)];
      used.add('find');
      el = `(await find(page, ${spec}, ${n}))`;
    }
    switch (step.type) {
      case 'click': return [`await ${el}.click();`];
      case 'input': return [`await ${el}.fill(${valueCode(step, n, used)});`];
      case 'select': return [`await ${el}.selectOption({ label: ${valueCode(step, n, used)} });`];
      case 'check': return [`await ${el}.setChecked(${step.checked ? 'true' : 'false'});`];
      case 'upload':
        used.add('files');
        return [`await ${el}.setInputFiles(files(${lit(`OPSCRIBE_FILES_${n}`)}, ${Number(step.value?.count) || 0}));`];
      case 'key': return [`await ${el ? `${el}.press` : 'page.keyboard.press'}(${lit(keyOf(step.key))});`];
      default: return [];
    }
  }

  /** Where to go for a navigation: code for the URL, or null when it cannot be opened as recorded. */
  function gotoCode(url, used) {
    if (!url) return null;
    if (!url.alias) return lit(`${url.origin}${url.rest}`);
    used.add('site');
    return `new URL(${lit(url.rest)}, site(${lit(siteVar(url.alias))})).href`;
  }

  /**
   * recording: a checked payload's recording. Returns the test file as text.
   */
  function toPlaywright(recording) {
    const steps = recording?.steps || [];
    const used = new Set();
    const body = [];
    const say = (text) => body.push(comment(text));
    const tabs = [...new Set(steps.map((s) => s.tab).filter((t) => t !== undefined))];
    let tab = steps.find((s) => s.tab !== undefined)?.tab;
    if (tabs.length > 1) {
      used.add('tab');
      body.push(`const opened = new Map([[${Number(tab)}, page]]);`);
    }

    // Where it starts: the first step when it opens a page, else the first URL it has.
    if (steps[0]?.type !== 'navigate') {
      const start = gotoCode(urlOf(D.startUrlOf(recording)), used);
      say('記録の始まり（最初の画面を開く操作）が残っていない。URL のある最初のステップの画面から始める');
      body.push(start ? `await page.goto(${start});` : stop('始める画面の URL が記録に無いか、伏せてある'));
    }

    let previous = null;
    steps.forEach((step, i) => {
      const n = Number.isInteger(step.n) ? step.n : i + 1;
      if (step.type === 'note' && step.kind) {
        say(`[${NOTE_KINDS[step.kind] || step.kind}] ${shown(txt(step.note))}`);
        return;
      }
      if (step.tab !== undefined && step.tab !== tab) {
        say(`タブ ${step.tab} に切り替える`);
        const at = urlOf(step.url);
        body.push(`page = await tabOf(context, opened, ${Number(step.tab)}, ${at ? lit(at.path) : 'null'});`);
        tab = step.tab;
        previous = null;
      }
      // Only an operation the test replays can be what moved the page: a tool call is not replayed (review of #80).
      const caused = step.type === 'navigate' && D.followsOperation(previous, step)
        && previous.source === 'user' && OPERATIONS.has(previous.type);
      say(caused ? `${n}. ${shown(txt(step.url))} に遷移したことを確かめる` : `${n}. ${shown(D.describeStep(step))}`);
      if (step.type === 'notice') {
        say('（ページが出した表示。結果として確かめはしない）');
        return;
      }
      if (step.type === 'note') {
        if (step.ref) say(`期待結果 [${step.ref}]（判定: ${VERDICTS[step.verdict] || '未判定'}）。人が判定したもので、ここでは確かめない`);
        previous = step;
        return;
      }
      if (step.type === 'navigate') {
        const url = urlOf(step.url);
        if (caused) {
          if (url) {
            used.add('at');
            body.push(`await at(page, ${lit(url.path)}, ${n});`);
          } else say('遷移先の URL は伏せてあるので確かめない');
        } else if (!(previous?.type === 'navigate' && previous.tab === step.tab && txt(previous.url) === txt(step.url))) {
          const to = gotoCode(url, used);
          body.push(to ? `await page.goto(${to});` : stop(`ステップ ${n}: 開く URL が伏せてある`));
        }
      } else if (step.type === 'tool') {
        say('WebMCP ツールの呼び出しは書き出さない（ページの AI エージェントが行ったもの）');
      } else if (OPERATIONS.has(step.type) && step.source === 'user') {
        // First, that this is the page the step was on: a navigation the recording lost (trimmed, deleted)
        // or a page the test reached otherwise must stop the test, not let it act there (review of #80).
        const url = urlOf(step.url);
        if (url) {
          used.add('at');
          body.push(`await at(page, ${lit(url.path)}, ${n});`);
        } else say('このステップの画面の URL は伏せてあるので、いる画面は確かめない');
        body.push(...operation(step, n, used));
      } else {
        say(`人の操作として記録されていないので書き出さない（source: ${step.source}）`);
      }
      previous = step;
    });
    if (!steps.length) say('（操作はまだ記録されていません）');

    const head = [
      comment('op-scribe: Playwright のテスト。記録から機械的に作ったもので、AI の出力は使っていない'),
      comment(`記録 ID: ${recording?.id || 'unknown'}`),
      comment('要素は 役割と名前 → selector の順で探し、一つに決まらなければ止まる（推測して操作しない）'),
      comment('‹…› の値は記録では伏せてある。OPSCRIBE_VALUE_<ステップ番号> などの環境変数でテスト値を渡し、元の値を推測しない'),
      comment('操作の前に、記録した画面（URL のパス）にいることを確かめ、違えば止まる')
    ];
    if (recording?.trimmed) head.push(comment('記録の一部が上限で消えている。消えた操作は再生されず、画面が合わないところで止まる'));
    if (used.has('site')) head.push(comment('site-N.invalid は実際のホスト名を伏せた別名。OPSCRIBE_SITE_<N> に実際の origin を渡す'));
    // Double quotes: a quote before @ reads as part of an e-mail address to finalScan, which the exit runs.
    head.push('import { test, expect } from "@playwright/test";');
    if (used.has('files')) head.push('import { delimiter } from "node:path";');
    const helpers = ['at', 'find', 'value', 'files', 'site', 'tab'].filter((h) => used.has(h)).flatMap((h) => ['', ...HELPERS[h]]);
    const out = [
      ...head,
      ...helpers,
      '',
      `test(${lit(`op-scribe ${recording?.id || 'unknown'}`)}, async ({ page, context }) => {`,
      ...body.map((l) => `  ${l}`),
      '});'
    ];
    return `${out.join('\n')}\n`;
  }

  const api = { toPlaywright };
  root.OpScribePlaywright = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
