/**
 * op-scribe - turns recorded steps into reproduction steps and the payload.
 *
 * Two renderings of the same steps: Markdown for people (may be rewritten by
 * the on-device model) and Gherkin + attribute tables for agents (always
 * deterministic).
 *
 * Deterministic on purpose: this is the fallback when the on-device model is
 * unavailable, the input the model rewrites, and what WebMCP tools return.
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const SCHEMA = 'op-scribe.recording/v1';

  const LABELS = {
    secret: '秘匿値',
    email: 'メールアドレス',
    phone: '電話番号',
    card: 'カード番号',
    personal: '個人情報',
    masked: '伏せ字',
    v: '値',
    id: 'ID',
    number: '番号',
    postal: '郵便番号',
    ip: 'IPアドレス',
    nested: '値',
    value: '値'
  };

  /** [[text:12]] → ‹任意の文字列 12文字›, [[email]] → ‹メールアドレス› */
  function humanize(text) {
    return String(text ?? '').replace(/\[\[([a-z]+)(?::([\w-]+))?\]\]/gi, (match, kind, arg) => {
      if (kind === 'text') return `‹任意の文字列 ${arg}文字›`;
      if (kind === 'file') return `‹ファイル ${arg}件›`;
      if (kind === 'url') return `‹${arg} ページ›`;
      return `‹${LABELS[kind] || kind}›`;
    });
  }

  const ROLE_NOUN = {
    link: 'リンク',
    button: 'ボタン',
    tab: 'タブ',
    menuitem: 'メニュー項目',
    option: '選択肢',
    checkbox: 'チェックボックス',
    radio: 'ラジオボタン',
    switch: 'スイッチ',
    textbox: '入力欄',
    searchbox: '検索欄',
    combobox: '選択欄',
    img: '画像',
    heading: '見出し'
  };

  const Screen = root.OpScribeScreen || (typeof require === 'function' ? require('./screen.js') : null);

  function targetText(target) {
    if (!target) return '画面';
    const noun = ROLE_NOUN[target.role] || '';
    if (target.name) return `「${target.name}」${noun}`;
    if (target.selector) return `${noun || '要素'}（${target.selector}）`;
    return noun || '要素';
  }

  /** "ヘッダーの「急上昇」リンク" - where on the screen the target sits. */
  function placedTarget(target) {
    const where = Screen.componentPhrase(target?.component);
    return where ? `${where}の${targetText(target)}` : targetText(target);
  }

  /** Intent read from the label of what was pressed, e.g. 「保存する」→ 編集・保存. */
  function intentOfStep(step) {
    if (!['click', 'submit', 'key'].includes(step.type) || !step.target?.name) return null;
    const kind = Screen.intentOf(step.target.name);
    return kind ? { kind, label: Screen.LABELS[kind] } : null;
  }

  const quote = (value) => (/^\[\[[^\]]+\]\]$/.test(value) ? value : `「${value}」`);

  const pathOf = (url) => {
    try { return new URL(url).pathname; } catch { return String(url || ''); }
  };
  const screenName = (screen, url) => screen?.title || screen?.h1 || pathOf(url);

  /** One step as one Japanese sentence. Placeholders stay raw; call humanize() to display. */
  function describeStep(step) {
    switch (step.type) {
      case 'screen':
        return `【画面】「${screenName(step.screen, step.url)}」${step.screen?.summary ? `（${step.screen.summary}）` : ''}`;
      case 'navigate':
        return `${step.url} を開く`;
      case 'click':
        return `${placedTarget(step.target)}をクリックする`;
      case 'input':
        return step.value === ''
          ? `${placedTarget(step.target)}を空にする`
          : `${placedTarget(step.target)}に ${quote(step.value)} を入力する`;
      case 'select':
        return `${placedTarget(step.target)}で ${quote(step.value)} を選択する`;
      case 'check':
        return step.checked
          ? `${placedTarget(step.target)}をオンにする`
          : `${placedTarget(step.target)}をオフにする`;
      case 'upload':
        return `${placedTarget(step.target)}に ${step.value} をアップロードする`;
      case 'key':
        return step.target ? `${placedTarget(step.target)}で ${step.key} キーを押す` : `${step.key} キーを押す`;
      case 'submit':
        return `${step.target?.component ? `${Screen.componentPhrase(step.target.component)}を` : 'フォームを'}送信する`;
      case 'tool': {
        const args = step.args && typeof step.args === 'object' ? JSON.stringify(step.args) : '';
        return `WebMCP ツール「${step.tool}」を実行する${args && args !== '{}' ? `（引数: ${args}）` : ''}${step.ok === false ? '（失敗）' : ''}`;
      }
      case 'note':
        return `（確認）${step.note}`;
      default:
        return `${step.type} 操作`;
    }
  }

  const ACTOR_LABELS = { user: '人', automation: '自動テスト', script: 'ページ内スクリプト', agent: 'エージェント' };

  const NAVIGATION_CAUSES = new Set(['click', 'submit', 'key', 'tool']);
  const FOLLOW_MS = 4000;

  /** A navigation the operation caused (a link, a submit), not one opened by itself (address bar, much later). */
  const causedBy = (action, navigation) => Boolean(action) && NAVIGATION_CAUSES.has(action.type)
    && navigation.t - action.t <= FOLLOW_MS;
  const REWRITE_MS = 3000;

  const samePage = (a, b) => {
    try {
      const x = new URL(a);
      const y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname;
    } catch {
      return false;
    }
  };

  /**
   * When a navigation is only the page rewriting its own URL (dropping a
   * tracking parameter, canonicalizing), returns the steps whose URL should be
   * updated instead of recording a new step; otherwise null.
   */
  /**
   * b is a cleaned-up form of a (a page dropping tracking parameters from its own URL): the same page,
   * with only query parameters taken away, none added or changed. /search?q=red -> ?q=blue is a new page.
   */
  const rewrittenAs = (a, b) => {
    if (!samePage(a, b)) return false;
    try {
      // Counted, not just looked up: ?tag=a -> ?tag=a&tag=a adds a parameter.
      const left = new Map();
      // A pair as JSON: a=b=c is not the same pair as a%3Db=c.
      const pair = (entry) => JSON.stringify(entry);
      for (const entry of new URL(a).searchParams) left.set(pair(entry), (left.get(pair(entry)) || 0) + 1);
      for (const entry of new URL(b).searchParams) {
        const n = left.get(pair(entry)) || 0;
        if (!n) return false;
        left.set(pair(entry), n - 1);
      }
      return true;
    } catch {
      return false;
    }
  };

  function isPageRewrite(steps, next) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i];
      if (step.type === 'screen') continue;
      if (step.type !== 'navigate') return null;
      if (next.t - step.t > REWRITE_MS || !rewrittenAs(step.url, next.url)) return null;
      return steps.slice(i);
    }
    return null;
  }

  function screenInfo(step) {
    return {
      title: screenName(step.screen, step.url),
      h1: step.screen?.h1 || '',
      url: step.url,
      summary: step.screen?.summary || '',
      reasons: (step.screen?.purposes || []).flatMap((p) => p.reasons || []).slice(0, 4),
      components: step.screen?.components || [],
      ai: step.screen?.ai || null
    };
  }

  /**
   * Builds { title, preconditions, screens, steps: [{ action, expected[], screen }], notes }.
   * Steps are grouped under the screen they happened on; a navigation caused
   * by an operation becomes that operation's expected result.
   */
  function buildReproduction(rec) {
    const steps = rec?.steps || [];
    const screens = [];
    const out = [];
    const notes = [];
    let current = null;
    let opened = [];
    let lastAction = null;
    let actedOnCurrent = false;

    const expect = (item, text) => {
      item.expected = item.expected || [];
      if (!item.expected.includes(text)) item.expected.push(text);
    };

    for (const step of steps) {
      if (step.type === 'screen') {
        const info = screenInfo(step);
        // The same screen captured again with nothing done in between is a refresh of it;
        // after operations it is a new state of the screen (e.g. a row deleted) and keeps its own section.
        if (current !== null && screens[current].url === info.url && !actedOnCurrent) {
          screens[current] = { ...info, ai: info.ai || screens[current].ai };
          continue;
        }
        screens.push(info);
        current = screens.length - 1;
        actedOnCurrent = false;
        for (const item of opened) item.screen = current;
        opened = [];
        if (lastAction?.awaiting && samePage(lastAction.awaiting, info.url)) {
          lastAction.item.expected = lastAction.item.expected.filter((e) => e !== lastAction.placeholder);
          expect(lastAction.item, `「${info.title}」画面に遷移する`);
          lastAction.awaiting = null;
        }
        continue;
      }
      if (step.type === 'note') {
        const last = out[out.length - 1];
        if (last) expect(last, humanize(step.note));
        else notes.push(humanize(step.note));
        continue;
      }
      if (step.type === 'navigate') {
        const caused = lastAction && NAVIGATION_CAUSES.has(lastAction.type) && !lastAction.navigated
          && step.t - lastAction.t <= FOLLOW_MS;
        if (caused) {
          lastAction.navigated = true;
          lastAction.awaiting = step.url;
          lastAction.placeholder = `${step.url} に遷移する`;
          expect(lastAction.item, lastAction.placeholder);
          continue;
        }
        const previous = out[out.length - 1];
        if (previous?.navigate === step.url) continue;
        const item = { action: `${step.url} を開く`, navigate: step.url, screen: current };
        out.push(item);
        opened.push(item);
        lastAction = null;
        continue;
      }
      const by = step.actor === 'script' || step.actor === 'agent' ? `（${ACTOR_LABELS[step.actor]}による操作）` : '';
      const item = { action: `${humanize(describeStep(step))}${by}`, screen: current };
      if (step.change?.appeared?.length) item.appeared = step.change.appeared.slice(0, 3);
      if (step.change?.transient?.length) item.transient = step.change.transient.slice(0, 3);
      if (step.ai?.meaning) item.meaning = step.ai.meaning;
      if (step.ai?.result) item.result = step.ai.result;
      out.push(item);
      lastAction = { type: step.type, t: step.t, item };
      actedOnCurrent = true;
    }

    if (rec?.startUrl && (!steps.length || steps[0].type !== 'navigate')) {
      out.unshift({ action: `${rec.startUrl} を開く`, screen: screens.length ? 0 : null });
    }

    const first = screens[0]?.url || steps.find((s) => s.url)?.url || rec?.startUrl;
    const preconditions = [];
    if (first) preconditions.push(`${new URL(first).origin} にアクセスできる状態であること`);
    if (steps.some((s) => /\[\[(?:secret|card)\]\]/.test(JSON.stringify(s)))) {
      preconditions.push('‹…› で伏せた値（ログイン情報など）はテスト用の値を用意して入力すること');
    }
    if (steps.some((s) => /\[\[text:/.test(JSON.stringify(s)))) {
      notes.push('‹任意の文字列 N文字› は記録時の入力を伏せたもの。再現時は同じ程度の長さの値を使う');
    }
    const actors = new Map();
    for (const s of steps) if (s.actor) actors.set(s.actor, (actors.get(s.actor) || 0) + 1);
    if ([...actors.keys()].some((a) => a !== 'user')) {
      notes.push(`操作の主体: ${[...actors].map(([a, n]) => `${ACTOR_LABELS[a] || a} ${n} 件`).join(' / ')}`);
    }
    if (steps.some((s) => s.url && /\.invalid\b/.test(s.url))) {
      notes.push('site-N.invalid は実際のホスト名を伏せた別名');
    }

    const titles = screens.map((s) => `「${s.title}」`);
    return {
      title: titles.length > 1
        ? `${titles[0]}から${titles[titles.length - 1]}までの操作（${out.length} ステップ）`
        : titles.length ? `${titles[0]}での操作（${out.length} ステップ）` : `操作の再現手順（${out.length} ステップ）`,
      preconditions,
      screens,
      steps: out.map(({ action, expected, screen, appeared, transient, meaning, result }) => ({
        action, expected: expected?.join(' / ') || undefined, screen, appeared, transient, meaning, result
      })),
      notes
    };
  }

  function screenLines(screen, index) {
    const lines = [`### 画面 ${index + 1}: 「${screen.title}」`, `- URL: ${screen.url}`];
    if (screen.h1 && screen.h1 !== screen.title) lines.push(`- 主見出し: ${screen.h1}`);
    if (screen.summary) {
      lines.push(`- 画面の目的: ${screen.summary}${screen.reasons?.length ? `（根拠: ${screen.reasons.join('、')}）` : ''}`);
    }
    if (screen.components?.length) lines.push(`- 主な UI: ${screen.components.join(' / ')}`);
    if (screen.ai?.purpose) lines.push(`- AI の理解（目的）: ${screen.ai.purpose}`);
    if (screen.ai?.summary) lines.push(`- AI の理解（内容）: ${screen.ai.summary}`);
    return lines;
  }

  /**
   * Steps carrying a screen index are rendered under that screen's heading;
   * steps without one (e.g. rewritten by the on-device model) are listed flat
   * with the screens summarized afterwards.
   */
  function toMarkdown(repro) {
    const lines = [`# ${repro.title}`, ''];
    if (repro.summary) lines.push('## 概要', repro.summary, '');
    if (repro.preconditions?.length) {
      lines.push('## 前提条件', ...repro.preconditions.map((p) => `- ${p}`), '');
    }
    lines.push('## 手順');
    const screens = repro.screens || [];
    const grouped = (repro.steps || []).some((s) => Number.isInteger(s.screen));
    let shown = null;
    (repro.steps || []).forEach((step, i) => {
      if (grouped && Number.isInteger(step.screen) && step.screen !== shown && screens[step.screen]) {
        lines.push('', ...screenLines(screens[step.screen], step.screen), '');
        shown = step.screen;
      }
      lines.push(`${i + 1}. ${step.action}`);
      if (step.meaning) lines.push(`   - 意味（AI）: ${step.meaning}`);
      if (step.appeared?.length) lines.push(`   - 操作後に現れた文字: ${step.appeared.map((t) => `「${t}」`).join(' ')}`);
      if (step.transient?.length) lines.push(`   - 操作後に一時的に表示された文字: ${step.transient.map((t) => `「${t}」`).join(' ')}`);
      if (step.expected) lines.push(`   - 期待結果: ${step.expected}`);
      if (step.result) lines.push(`   - 結果（通知）: ${step.result}`);
    });
    // Screens reached by the last operations have no step of their own, but they are where it ended.
    if (grouped) {
      for (let i = (shown ?? -1) + 1; i < screens.length; i += 1) lines.push('', ...screenLines(screens[i], i));
    }
    if (!grouped && screens.length) {
      lines.push('', '## 画面');
      screens.forEach((screen, i) => lines.push('', ...screenLines(screen, i)));
    }
    if (repro.notes?.length) lines.push('', '## 補足', ...repro.notes.map((n) => `- ${n}`));
    return `${lines.join('\n')}\n`;
  }

  // ------------------------------------------------------------ Gherkin + α

  const cell = (value) => String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');

  /**
   * Attributes an agent needs to find the same element and screen again.
   * Emitted as a Gherkin data table under the step, so the file stays valid
   * Gherkin while carrying what plain step text cannot.
   */
  function attributesOf(step) {
    const rows = [];
    const add = (key, value) => {
      if (value !== undefined && value !== null && value !== '') rows.push([key, typeof value === 'string' ? value : JSON.stringify(value)]);
    };
    add('action', step.type);
    add('url', step.url);
    if (step.target) {
      add('component', Screen.componentPhrase(step.target.component));
      add('role', step.target.role);
      add('name', step.target.name);
      add('tag', step.target.tag);
      add('selector', step.target.selector);
      add('href', step.target.href);
    }
    add('intent', intentOfStep(step)?.label);
    for (const text of step.change?.appeared?.slice(0, 3) || []) add('appeared', text);
    for (const text of step.change?.transient?.slice(0, 3) || []) add('transient', text);
    add('value', step.value);
    add('checked', step.checked);
    add('key', step.key);
    add('tool', step.tool);
    add('args', step.args);
    add('actor', step.actor && step.actor !== 'user' ? step.actor : undefined);
    add('source', step.source === 'agent' && !step.actor ? 'agent' : undefined);
    return rows;
  }

  function screenRows(step) {
    const info = screenInfo(step);
    const rows = [['url', info.url], ['title', info.title]];
    if (info.h1 && info.h1 !== info.title) rows.push(['h1', info.h1]);
    if (info.summary) rows.push(['purpose', info.summary]);
    for (const reason of info.reasons) rows.push(['reason', reason]);
    for (const component of info.components) rows.push(['ui', component]);
    return rows;
  }

  function table(rows, indent) {
    const width = Math.max(...rows.map(([k]) => k.length));
    return rows.map(([k, v]) => `${indent}| ${k.padEnd(width)} | ${cell(v)} |`);
  }

  /**
   * Feature file built straight from the recorded steps (never from model output),
   * so the attributes are exactly what was recorded.
   *   Given  - the starting screen, with what it is for
   *   When   - each operation, with where it happened and what it meant
   *   Then   - the screen it led to, and notes / expected results
   */
  function toGherkin(rec) {
    const steps = rec?.steps || [];
    const out = [
      '# op-scribe: Gherkin + attributes',
      `# recording: ${rec?.id || 'unknown'} / privacy: ${rec?.privacyLevel || 'strict'}`,
      '# ‹…› and [[…]] are masked values: supply test values, never guess the original.',
      '# site-N.invalid is an alias for a host that is not disclosed.',
      `@op-scribe @privacy-${rec?.privacyLevel || 'strict'}`,
      'Feature: 記録された操作の再現',
      ''
    ];

    // The starting point: the first navigation and the screen it showed.
    let index = 0;
    const startNav = steps[0]?.type === 'navigate' ? steps[0] : null;
    if (startNav) index = 1;
    const startScreen = steps[index]?.type === 'screen' ? steps[index] : null;
    if (startScreen) index += 1;
    const startUrl = startScreen?.url || startNav?.url || rec?.startUrl;
    if (startScreen) {
      out.push('  Background:', `    Given 「${screenName(startScreen.screen, startScreen.url)}」画面を開いている`, ...table(screenRows(startScreen), '      '), '');
    } else if (startUrl) {
      out.push('  Background:', `    Given "${startUrl}" を開いている`, ...table([['url', startUrl]], '      '), '');
    }
    out.push('  Scenario: 記録された操作');

    let lastKeyword = '';
    let lastAction = null;
    let lastScreenUrl = startScreen?.url || null;
    // The same URL after an operation is the operation's result (a row deleted), not a repeat.
    let actedSinceScreen = false;
    const push = (keyword, text, rows) => {
      const shown = keyword === lastKeyword ? 'And' : keyword;
      lastKeyword = keyword;
      out.push(`    ${shown} ${text}`);
      if (rows?.length) out.push(...table(rows, '      '));
    };
    const screenAhead = (from, url) => {
      for (let j = from + 1; j < steps.length; j += 1) {
        if (steps[j].type === 'screen') return samePage(steps[j].url, url);
        if (steps[j].type !== 'note') return false;
      }
      return false;
    };

    let wrote = false;
    for (let i = index; i < steps.length; i += 1) {
      const step = steps[i];
      if (step.type === 'screen') {
        if (lastScreenUrl === step.url && !actedSinceScreen) continue;
        lastScreenUrl = step.url;
        actedSinceScreen = false;
        push('Then', `「${screenName(step.screen, step.url)}」画面が表示される`, screenRows(step));
      } else if (step.type === 'note') {
        push('Then', humanize(step.note), step.source === 'agent' ? [['source', 'agent']] : null);
      } else if (step.type === 'navigate') {
        const caused = causedBy(lastAction, step);
        if (caused) {
          if (!screenAhead(i, step.url)) push('Then', `"${step.url}" に遷移する`, [['url', step.url]]);
        } else {
          push('When', `"${step.url}" を開く`, [['action', 'navigate'], ['url', step.url]]);
          actedSinceScreen = true;
        }
        lastAction = null;
      } else {
        push('When', humanize(describeStep(step)), attributesOf(step));
        lastAction = step;
        actedSinceScreen = true;
      }
      wrote = true;
    }
    if (!wrote) out.push('    # (操作はまだ記録されていません)');
    return `${out.join('\n')}\n`;
  }

  // Facts of the recording only: the model's text reaches the payload as reproduction.markdown, nowhere else.
  const STEP_FIELDS = ['id', 'seq', 'type', 't', 'url', 'actor', 'value', 'checked', 'key', 'tool', 'args', 'ok', 'note', 'source', 'change'];
  const SCREEN_FIELDS = ['title', 'h1', 'purposes', 'summary', 'components'];
  const TARGET_FIELDS = ['role', 'name', 'tag', 'selector', 'href', 'component'];

  const pick = (obj, fields) => {
    const out = {};
    for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
    return out;
  };

  /**
   * The exact object that is previewed and sent. Built by allowlisting fields
   * so local-only state (tab id, real-origin alias map, granted origins) can
   * never ride along by accident.
   */
  function buildPayload(rec, reproduction, environment) {
    return {
      schema: SCHEMA,
      recording: {
        id: rec.id,
        startedAt: new Date(rec.startedAt).toISOString(),
        endedAt: rec.endedAt ? new Date(rec.endedAt).toISOString() : null,
        startUrl: rec.startUrl,
        privacy: {
          level: rec.privacyLevel,
          hostsAliased: Object.keys(rec.aliases || {}).length,
          redactions: { ...(rec.redactions || {}) }
        },
        environment: pick(environment || {}, ['browser', 'platform', 'language']),
        steps: (rec.steps || []).map((step, i) => {
          const out = { n: i + 1, ...pick(step, STEP_FIELDS) };
          if (step.screen) out.screen = pick(step.screen, SCREEN_FIELDS);
          if (step.target) out.target = pick(step.target, TARGET_FIELDS);
          return out;
        }),
        webmcpTools: Object.entries(rec.webmcpTools || {}).map(([site, tools]) => ({ site, tools }))
      },
      // What the side panel shows (possibly edited), as it was previewed.
      reproduction: (() => {
        const chosen = reproduction || {};
        const out = { generator: chosen.generator || 'none', markdown: chosen.markdown || '', gherkin: reproduction?.gherkin || toGherkin(rec) };
        if (chosen.summary) out.summary = chosen.summary;
        return out;
      })(),
      sentAt: new Date().toISOString()
    };
  }

  const api = { SCHEMA, ACTOR_LABELS, humanize, describeStep, buildReproduction, toMarkdown, toGherkin, isPageRewrite, causedBy, buildPayload };
  root.OpScribeDescribe = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
