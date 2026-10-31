/**
 * op-scribe - turns recorded steps into reproduction steps.
 *
 * Two renderings of the same steps: Markdown for people (may be rewritten by
 * the on-device model) and Gherkin + attribute tables for agents (always
 * deterministic, and rebuilt from the recording at every exit). The payload
 * itself is shaped in shared/payload.js.
 *
 * Deterministic on purpose: this is the fallback when the on-device model is
 * unavailable, the input the model rewrites, and what WebMCP tools return.
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const { LIMITS } = root.OpScribeLimits || require('./limits.js');

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
    value: '値',
    masked: '伏せ字',
    keyword: '伏せ字'
  };

  /**
   * A typed value (ADR 0003) as text. The only place placeholders are made.
   *   { treatment: 'length', kind: 'text', length: 12 } → [[text:12]]
   *   { treatment: 'redacted', kind: 'email' }           → [[email]]
   */
  function display(value) {
    if (!value || typeof value !== 'object') return '';
    switch (value.treatment) {
      case 'kept': return typeof value.number === 'number' ? String(value.number) : String(value.text ?? '');
      case 'length': return value.kind === 'text' ? `[[text:${value.length}]]` : `[[${value.kind}]]`;
      case 'redacted': return value.kind === 'file' ? `[[file:${value.count ?? 0}]]` : `[[${value.kind}]]`;
      default: return '[[v]]';
    }
  }

  const isTyped = (node) => Boolean(node && typeof node === 'object' && typeof node.treatment === 'string');

  /** WebMCP arguments with each typed leaf rendered: kept numbers stay numbers. */
  function displayArgs(node) {
    if (node === null || typeof node !== 'object') return node;
    // Each string is one line before JSON.stringify, which would write a line break as "\n" (E7).
    if (isTyped(node)) return node.treatment === 'kept' && typeof node.number === 'number' ? node.number : line(display(node));
    if (Array.isArray(node)) return node.map(displayArgs);
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, displayArgs(v)]));
  }

  /** Every typed value in a step: the input value and each WebMCP argument. */
  function typedValues(step) {
    const out = [];
    const walk = (node) => {
      if (isTyped(node)) out.push(node);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(step.value);
    walk(step.args);
    return out;
  }

  /**
   * Where the recording starts, from the steps it still has: the recorded
   * start URL only while a step still carries it (a deleted first navigation
   * must not come back, #16), otherwise the first step's URL, or [[url:none]].
   * The Markdown, the Gherkin, the payload and the model input all use this.
   */
  function startUrlOf(rec) {
    const steps = rec?.steps || [];
    if (rec?.startUrl && steps.some((s) => s.url === rec.startUrl)) return rec.startUrl;
    return steps.find((s) => s.url)?.url || '[[url:none]]';
  }

  /**
   * A note written in the side panel has no URL and no page to belong to. It is
   * commercial while the recording has any commercial step (ADR 0001), decided
   * again whenever the payload is built, since steps come and go after it.
   */
  const isPanelNote = (step) => step.type === 'note' && !step.url && step.source !== 'agent';

  function panelNoteEnv(steps) {
    return (steps || []).some((s) => !isPanelNote(s) && s.env === 'commercial') ? 'commercial' : 'standard';
  }

  /** commercial | standard | mixed | none, from the environment of each step. */
  function coverageOf(steps) {
    const envs = new Set((steps || []).map((s) => s.env));
    if (!envs.size) return 'none';
    if (envs.size > 1) return 'mixed';
    return envs.has('commercial') ? 'commercial' : 'standard';
  }

  /** [[text:12]] → ‹任意の文字列 12文字›, [[email]] → ‹メールアドレス› */
  function humanize(text) {
    return String(text ?? '').replace(/\[\[([a-z]+)(?::([\w-]+))?\]\]/gi, (match, kind, arg) => {
      if (kind === 'text') return `‹任意の文字列 ${arg}文字›`;
      if (kind === 'file') return `‹ファイル ${arg}件›`;
      if (kind === 'url') return ['invalid', 'none', 'long'].includes(arg) ? '‹URL›' : `‹${arg} ページ›`;
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

  function targetText(target) {
    if (!target) return '画面';
    const noun = ROLE_NOUN[target.role] || '';
    if (target.name) return `「${target.name}」${noun}`;
    if (target.selector) return `${noun || '要素'}（${target.selector}）`;
    return noun || '要素';
  }

  /**
   * Everything rendered as a step, heading or list item is one line (#18): a
   * line break from the page, a kept textarea value or the model would
   * otherwise start a new Gherkin step or Markdown item.
   */
  const line = (text) => String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');

  const quote = (value) => (/^\[\[[^\]]+\]\]$/.test(value) ? value : `「${value}」`);

  /** One step as one Japanese sentence. Placeholders stay raw; call humanize() to display. */
  function describeStep(step) {
    return line(sentenceOf(step));
  }

  function sentenceOf(step) {
    switch (step.type) {
      case 'navigate':
        return `${step.url} を開く`;
      case 'click':
        return `${targetText(step.target)}をクリックする`;
      case 'input':
        return display(step.value) === '' || (step.value?.treatment === 'length' && step.value.length === 0)
          ? `${targetText(step.target)}を空にする`
          : `${targetText(step.target)}に ${quote(display(step.value))} を入力する`;
      case 'select':
        return `${targetText(step.target)}で ${quote(display(step.value))} を選択する`;
      case 'check':
        return step.checked
          ? `${targetText(step.target)}をオンにする`
          : `${targetText(step.target)}をオフにする`;
      case 'upload':
        return `${targetText(step.target)}に ${display(step.value)} をアップロードする`;
      case 'key':
        return step.target ? `${targetText(step.target)}で ${step.key} キーを押す` : `${step.key} キーを押す`;
      case 'submit':
        return 'フォームを送信する';
      case 'tool': {
        const json = step.args && typeof step.args === 'object' ? JSON.stringify(displayArgs(step.args)) : '';
        // The sentence shows the arguments up to argsInSentence; the Gherkin table keeps them all.
        const args = [...json].length > LIMITS.argsInSentence ? `${[...json].slice(0, LIMITS.argsInSentence).join('')}…` : json;
        return `WebMCP ツール「${step.tool}」を実行する${args && args !== '{}' ? `（引数: ${args}）` : ''}${step.ok === false ? '（失敗）' : ''}`;
      }
      case 'note':
        return `（確認）${step.note}`;
      default:
        return `${step.type} 操作`;
    }
  }

  const NAVIGATION_CAUSES = new Set(['click', 'submit', 'key', 'tool']);
  const FOLLOW_MS = 4000;

  /**
   * Builds { title, preconditions, steps: [{ action, expected? }], notes } from a recording.
   * A navigation right after a click/submit is folded into that step's expected result.
   */
  function buildReproduction(rec) {
    const steps = rec?.steps || [];
    const out = [];
    const notes = [];
    let previous = null;

    for (const step of steps) {
      if (step.type === 'note') {
        const last = out[out.length - 1];
        if (last && !last.expected) last.expected = step.note;
        else if (last) last.expected += ` / ${step.note}`;
        else notes.push(step.note);
        previous = step;
        continue;
      }
      if (step.type === 'navigate' && previous && NAVIGATION_CAUSES.has(previous.type)
          && step.t - previous.t <= FOLLOW_MS && out.length) {
        const last = out[out.length - 1];
        const moved = `${step.url} に遷移する`;
        last.expected = last.expected ? `${last.expected} / ${moved}` : moved;
        previous = step;
        continue;
      }
      if (step.type === 'navigate' && previous?.type === 'navigate' && previous.url === step.url) continue;
      out.push({ action: humanize(describeStep(step)) });
      previous = step;
    }

    const startUrl = startUrlOf(rec);
    const first = steps.find((s) => s.url)?.url;
    if (startUrl !== '[[url:none]]' && (!out.length || !steps[0] || steps[0].type !== 'navigate')) {
      out.unshift({ action: `${startUrl} を開く` });
    }

    const preconditions = [];
    // A URL that could not be parsed was recorded as [[url:invalid]].
    let origin = '';
    try { origin = first ? new URL(first).origin : ''; } catch { /* no origin to show */ }
    if (origin) preconditions.push(`${origin} にアクセスできる状態であること`);
    const values = steps.flatMap(typedValues);
    if (values.some((v) => v.field === 'secret' || v.field === 'pii')) {
      preconditions.push('‹…› で伏せた値（ログイン情報など）はテスト用の値を用意して入力すること');
    }
    if (values.some((v) => v.treatment === 'length' && v.kind === 'text')) {
      notes.push('‹任意の文字列 N文字› は記録時の入力を伏せたもの。再現時は同じ程度の長さの値を使う');
    }
    if (steps.some((s) => s.url && /\.invalid\b/.test(s.url))) {
      notes.push('site-N.invalid は実際のホスト名を伏せた別名');
    }

    return {
      title: `操作の再現手順（${out.length} ステップ）`,
      preconditions,
      steps: out,
      notes
    };
  }

  function toMarkdown(repro) {
    const lines = [`# ${line(repro.title)}`, ''];
    if (repro.preconditions?.length) {
      lines.push('## 前提条件', ...repro.preconditions.map((p) => `- ${line(p)}`), '');
    }
    lines.push('## 手順');
    (repro.steps || []).forEach((step, i) => {
      lines.push(`${i + 1}. ${line(step.action)}`);
      if (step.expected) lines.push(`   - 期待結果: ${line(step.expected)}`);
    });
    if (repro.notes?.length) lines.push('', '## 補足', ...repro.notes.map((n) => `- ${line(n)}`));
    return `${lines.join('\n')}\n`;
  }

  // ------------------------------------------------------------ Gherkin + α

  const cell = (value) => String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ');

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
      add('role', step.target.role);
      add('name', step.target.name);
      add('tag', step.target.tag);
      add('selector', step.target.selector);
      add('href', step.target.href);
    }
    if (step.value !== undefined) add('value', display(step.value));
    add('checked', step.checked);
    add('key', step.key);
    add('tool', step.tool);
    if (step.args !== undefined) add('args', displayArgs(step.args));
    add('source', step.source === 'agent' ? 'agent' : undefined);
    return rows;
  }

  function table(rows, indent) {
    const width = Math.max(...rows.map(([k]) => k.length));
    return rows.map(([k, v]) => `${indent}| ${k.padEnd(width)} | ${cell(v)} |`);
  }

  /**
   * Feature file built straight from the recorded steps (never from model output),
   * so the attributes are exactly what was recorded.
   *   Given  - the starting screen
   *   When   - each operation, with its attribute table
   *   Then   - navigation it caused, and notes / expected results
   */
  function toGherkin(rec) {
    const steps = rec?.steps || [];
    const coverage = coverageOf(steps);
    const out = [
      '# op-scribe: Gherkin + attributes',
      `# recording: ${rec?.id || 'unknown'} / environments: ${coverage}`,
      '# ‹…› and [[…]] are masked values: supply test values, never guess the original.',
      '# site-N.invalid is an alias for a host that is not disclosed.',
      `@op-scribe @env-${coverage}`,
      'Feature: 記録された操作の再現',
      ''
    ];
    const start = steps[0]?.type === 'navigate' ? steps[0] : null;
    const startUrl = start?.url || startUrlOf(rec);
    // [[url:none]]: the payload of a recording whose steps were all deleted.
    if (startUrl && startUrl !== '[[url:none]]') {
      out.push('  Background:', `    Given "${startUrl}" を開いている`, ...table([['url', startUrl]], '      '), '');
    }
    out.push('  Scenario: 記録された操作');

    let lastKeyword = '';
    let previous = null;
    const push = (keyword, text, rows) => {
      const shown = keyword === lastKeyword ? 'And' : keyword;
      lastKeyword = keyword;
      out.push(`    ${shown} ${text}`);
      if (rows?.length) out.push(...table(rows, '      '));
    };

    for (const step of steps) {
      if (step === start) { previous = step; continue; }
      if (step.type === 'note') {
        push('Then', line(humanize(step.note)), step.source === 'agent' ? [['source', 'agent']] : null);
      } else if (step.type === 'navigate') {
        const caused = previous && NAVIGATION_CAUSES.has(previous.type) && step.t - previous.t <= FOLLOW_MS;
        if (caused) push('Then', `"${step.url}" に遷移する`, [['url', step.url]]);
        else push('When', `"${step.url}" を開く`, [['action', 'navigate'], ['url', step.url]]);
      } else {
        push('When', humanize(describeStep(step)), attributesOf(step));
      }
      previous = step;
    }
    if (!steps.length || (steps.length === 1 && start)) out.push('    # (操作はまだ記録されていません)');
    return `${out.join('\n')}\n`;
  }

  const api = { display, displayArgs, coverageOf, startUrlOf, isPanelNote, panelNoteEnv, humanize, describeStep, buildReproduction, toMarkdown, toGherkin };
  root.OpScribeDescribe = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
