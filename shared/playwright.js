/**
 * op-scribe - a recording as a draft Playwright test (Issue #2).
 *
 * Built straight from a checked payload's recording, like the Gherkin: no
 * browser, no page and no model is involved, so the same recording always
 * gives the same file. It is a draft for a person to check and finish, not a
 * replay to pass or fail on (owner decision 2026-11-05): the recording drops
 * and changes what it must to mask (aliased hosts, dropped fragments,
 * normalized characters, cut texts), so the file cannot be what was done.
 * What it does do, to make the draft safer to finish:
 *   - before each operation, it checks the page shows the origin and path the
 *     step was recorded on, and throws otherwise;
 *   - an element is found by role + name, then by selector, and only when one
 *     of them matches exactly one element; a step without either throws;
 *   - a masked value, a file, a cut value and the real origin behind a
 *     site-N.invalid alias are read from environment variables;
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

  const { ALIAS_HOST, HIDDEN_CHARS, oneLine, typedAllowed } = root.OpScribeLimits || require('./limits.js');
  const D = root.OpScribeDescribe || require('./describe.js');

  const txt = D.rendered;
  const HIDDEN = new RegExp(HIDDEN_CHARS, 'u');
  // Escaped in every literal, so the code shows what it holds and stays one line (E7).
  const UNSAFE = new RegExp(`[\\p{Cc}\\u2028\\u2029]|${HIDDEN_CHARS}`, 'gu');
  // The recording's text enters the file only through pageLit() and comment(). The exit scans the steps the
  // file is made from and each page literal as the text it holds, not the file: an escape in the code (a
  // doubled backslash) could hide a keyword, and the generator's own code is no page text (owner decision
  // 2026-11-05, ADR 0005). A comment holds only the steps' text, which the exit scans as steps.
  const lit = (text) => JSON.stringify(String(text)).replace(UNSAFE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  let pageTexts = null;
  const pageLit = (text) => {
    if (pageTexts) pageTexts.push(String(text));
    return lit(text);
  };
  const comment = (text) => `// ${oneLine(String(text ?? '').replace(new RegExp(HIDDEN_CHARS, 'gu'), ''))}`;
  // A stop is a failure, not a skip: a run that cannot go on must not pass as green (review of #80).
  const stop = (why) => `throw new Error(${lit(why)});`;
  // The page's own ‹ and › as 〈 and 〉, so every ‹…› in a comment is a masked part (E4), as describe.js shows it.
  const shown = (text) => D.humanize(String(text ?? '').replace(/‹/g, '〈').replace(/›/g, '〉'));
  // A text the masking cut ends in the "…" it appends - shorter than its limit, too, when a masked part
  // that did not fit was dropped first (sanitize.js, cutRuns). Any text ending in "…" is taken as cut: one
  // the page wrote that way is then supplied or found by selector, which is only safer (review of #80).
  const isCut = (text) => text.endsWith('…');

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
    if (/^[a-z]+$/.test(target.role || '') && name && name.trim() && !HIDDEN.test(name) && !isCut(name)) {
      // The role is a word of the format, not page text (K2): the steps scan leaves it, and so does this one.
      spec.push(`role: ${lit(target.role)}`, `name: ${pageLit(name)}`);
    }
    if (typeof target.selector === 'string' && target.selector && !isCut(target.selector)) spec.push(`selector: ${pageLit(target.selector)}`);
    return spec.length ? `{ ${spec.join(', ')} }` : null;
  }

  // Playwright's names for the modifiers the recording keeps (limits.js, VOCAB.key).
  const MODIFIERS = { ctrl: 'Control', meta: 'Meta', alt: 'Alt' };
  const keyOf = (key) => String(key).split('+').map((k) => MODIFIERS[k] || k).join('+');

  const TARGETED = new Set(['click', 'input', 'select', 'check', 'upload']);
  const OPERATIONS = new Set([...TARGETED, 'key']);
  /** A step the draft replays: a navigation, or the person's operation. */
  const isReplayed = (step) => step.type === 'navigate' || (OPERATIONS.has(step.type) && step.source === 'user');
  const NOTE_KINDS = { bug: '不具合', question: '疑問', idea: '気づき', next: '次に試す' };
  const VERDICTS = { ok: 'OK', ng: 'NG' };

  const HELPERS = {
    place: [
      '/** A URL as its origin and path, with %-escapes undone where the browser may show them either way. */',
      'function place(url) {',
      '  const { origin, pathname } = new URL(url);',
      '  try { return decodeURI(origin + pathname); } catch { return origin + pathname; }',
      '}'
    ],
    at: [
      '/** That the page shows the origin and path its step was on: anything else stops the test. */',
      'async function at(page, url, step) {',
      '  await expect.poll(() => place(page.url()), { message: `ステップ ${step}: 記録した画面（${place(url)}）にいない` }).toBe(place(url));',
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
      '  return new URL(origin).origin;',
      '}'
    ],
    tab: [
      '/** A tab of the recording, the first time: the one page not yet used that shows the origin and path its step was on. */',
      'async function tabOf(context, opened, tab, url) {',
      '  if (!opened.has(tab)) {',
      '    if (url === null) throw new Error(`タブ ${tab} を見分けられない（そのステップの URL が伏せてある）`);',
      '    let found = null;',
      '    await expect.poll(() => {',
      '      const used = [...opened.values()];',
      '      const pages = context.pages().filter((p) => !used.includes(p) && place(p.url()) === place(url));',
      '      found = pages.length === 1 ? pages[0] : null;',
      '      return pages.length;',
      '    }, { message: `タブ ${tab}: ${place(url)} を開いているタブが一つに決まらない` }).toBe(1);',
      '    opened.set(tab, found);',
      '  }',
      '  return opened.get(tab);',
      '}'
    ]
  };

  /** The value a masked or kept input, select or upload step fills in, as code. */
  function valueCode(step, n, used) {
    const v = step.value || {};
    // Only a typed value that may exist is written out (TYPED_SCHEMA), as describe.js renders only those: a kept
    // secret is never typed in, even from a recording that did not go through checkPayload (review of #80).
    const allowed = typedAllowed(v.treatment, v.field, v.kind);
    if (allowed && v.treatment === 'kept') {
      if (typeof v.number === 'number') return pageLit(String(v.number));
      const text = plain(v.text);
      // A value cut short is not what was typed or chosen: supplied like a masked one (review of #80).
      if (text !== null && !isCut(text)) return pageLit(text);
    }
    if (allowed && v.treatment === 'length' && v.length === 0) return lit('');
    used.add('value');
    let what = D.humanize(D.display(v)) || '伏せた値';
    if (allowed && v.treatment === 'kept') what = plain(v.text) === null ? '記録では一部を伏せた値' : '記録では途中で切れている値';
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
    if (!url.alias) return pageLit(`${url.origin}${url.rest}`);
    used.add('site');
    // Appended to the origin, not resolved against it: a path starting with // would name another host (review of #80).
    return `site(${lit(siteVar(url.alias))}) + ${pageLit(url.rest)}`;
  }

  /**
   * recording: a checked payload's recording. Returns { text, pageTexts }: the file, and each literal in it
   * that holds the recording's text, as that text, for the exit to scan.
   */
  function buildPlaywright(recording) {
    pageTexts = [];
    try {
      return { text: fileOf(recording), pageTexts };
    } finally {
      pageTexts = null;
    }
  }

  /** The draft alone. */
  const toPlaywright = (recording) => buildPlaywright(recording).text;

  function fileOf(recording) {
    const steps = recording?.steps || [];
    const used = new Set();
    const body = [];
    const say = (text) => body.push(comment(text));
    // Only the steps the draft replays decide its tabs and where it starts: a notice or a tool call is a comment
    // and must not choose the page the test opens first (review of #80).
    const replayed = steps.filter(isReplayed);
    const tabs = [...new Set(replayed.map((s) => s.tab).filter((t) => t !== undefined))];
    let tab = replayed.find((s) => s.tab !== undefined)?.tab;
    if (tabs.length > 1) {
      used.add('tab');
      body.push(`const opened = new Map([[${Number(tab)}, page]]);`);
    }

    // Where it starts: the first replayed step when it opens a page, else the page of the first replayed step.
    const first = replayed[0];
    if (first && first.type !== 'navigate') {
      const start = gotoCode(urlOf(first.url), used);
      say('記録の始まり（最初の画面を開く操作）が残っていない。最初に再生するステップの画面から始める');
      body.push(start ? `await page.goto(${start});` : stop('始める画面の URL が記録に無いか、伏せてある'));
    }

    let previous = null;
    steps.forEach((step, i) => {
      const n = Number.isInteger(step.n) ? step.n : i + 1;
      if (step.type === 'note' && step.kind) {
        say(`[${NOTE_KINDS[step.kind] || step.kind}] ${shown(txt(step.note))}`);
        return;
      }
      // Only a step the test replays switches tabs: a notice or a tool call in a tab the test never opens
      // is a comment, and must not make it look for that tab (review of #80).
      // A step in another tab than the one replayed now, which the draft does not replay: a comment only, and
      // not the step before the next one there (a click's navigation stays the click's; review of #80).
      if (step.tab !== undefined && step.tab !== tab && !isReplayed(step)) {
        say(`${n}. （タブ ${step.tab}）${shown(D.describeStep(step))}（再生しない）`);
        return;
      }
      if (step.tab !== undefined && step.tab !== tab) {
        say(`タブ ${step.tab} に切り替える`);
        body.push(`page = await tabOf(context, opened, ${Number(step.tab)}, ${gotoCode(urlOf(step.url), used) ?? 'null'});`);
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
            body.push(`await at(page, ${gotoCode(url, used)}, ${n});`);
          } else say('⚠ 遷移先の URL は一部を伏せてあるので、どの画面に移ったかを確かめられない（違う画面のまま続くことがある）');
        // The same URL again is not opened twice - only when both are whole: two masked URLs that render alike
        // (/user/‹ID›) may be two pages, and the second must still be opened or stop (review of #80).
        } else if (!(previous?.type === 'navigate' && previous.tab === step.tab && url && urlOf(previous.url)
            && txt(previous.url) === txt(step.url))) {
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
          body.push(`await at(page, ${gotoCode(url, used)}, ${n});`);
        } else say('⚠ この画面の URL は一部を伏せてあるので、いる画面を確かめられない（違う画面で操作することがある）');
        body.push(...operation(step, n, used));
      } else {
        say(`人の操作として記録されていないので書き出さない（source: ${step.source}）`);
      }
      previous = step;
    });
    if (!steps.length) say('（操作はまだ記録されていません）');

    const head = [
      comment('op-scribe: Playwright のテストの下書き。記録から機械的に作ったもので、AI の出力は使っていない'),
      comment(`記録 ID: ${recording?.id || 'unknown'}`),
      comment('下書きです。記録は伏せるために情報を落とし・変えている（ホストの別名、URL の # 以降、全角や記号の正規化、長い文字の切り詰め）ので、'),
      comment('ここにあるのは行った操作そのものではない。人が確かめて直してから使い、そのまま実行した結果を合否の根拠にしない'),
      comment('操作の前に、記録した画面（origin とパス）にいるかを確かめ、違えば止まる。要素は 役割と名前 → selector の順で、一つに決まるときだけ使う'),
      comment('‹…› の値は記録では伏せてある。OPSCRIBE_VALUE_<ステップ番号> などの環境変数でテスト値を渡し、元の値を推測しない')
    ];
    if (recording?.trimmed) head.push(comment('記録の一部が上限で消えている。消えた操作は再生されず、画面が合わないところで止まる'));
    if (used.has('site')) head.push(comment('site-N.invalid は実際のホスト名を伏せた別名。OPSCRIBE_SITE_<N> に実際の origin を渡す'));
    // Double quotes: a quote before @ reads as part of an e-mail address to finalScan, which the exit runs.
    head.push('import { test, expect } from "@playwright/test";');
    if (used.has('files')) head.push('import { delimiter } from "node:path";');
    // at and tabOf both compare places.
    if (used.has('at') || used.has('tab')) used.add('place');
    const helpers = ['place', 'at', 'find', 'value', 'files', 'site', 'tab'].filter((h) => used.has(h)).flatMap((h) => ['', ...HELPERS[h]]);
    const out = [
      ...head,
      ...helpers,
      '',
      `test(${lit(`op-scribe ${recording?.id || 'unknown'}（下書き）`)}, async ({ page, context }) => {`,
      ...body.map((l) => `  ${l}`),
      '});'
    ];
    return `${out.join('\n')}\n`;
  }

  const api = { toPlaywright, buildPlaywright };
  root.OpScribePlaywright = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
