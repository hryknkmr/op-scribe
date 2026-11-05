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

  const { LIMITS, typedAllowed, HIDDEN_CHARS, renderRuns, oneLine, ellipsize } = root.OpScribeLimits || require('./limits.js');
  // A field of a step (runs, or a plain string such as a selector) as text with [[…]] placeholders (#28).
  const txt = (value) => (value === undefined || value === null ? '' : renderRuns(value));
  const NO_URL = '[[url:none]]';

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
    user: 'ユーザー',
    keyword: '伏せ字'
  };

  /**
   * A typed value (ADR 0003) as text. The only place placeholders are made.
   *   { treatment: 'length', kind: 'text', length: 12 } → [[text:12]]
   *   { treatment: 'redacted', kind: 'email' }           → [[email]]
   */
  function display(value) {
    if (!value || typeof value !== 'object') return '';
    // A typed value that may not exist (TYPED_SCHEMA) is never rendered as what it claims.
    if (!typedAllowed(value.treatment, value.field, value.kind)) return '[[v]]';
    switch (value.treatment) {
      case 'kept': return typeof value.number === 'number' ? String(value.number) : txt(value.text);
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
   * Where the recording starts, from the steps it still has: the URL of the
   * first step that has one, or [[url:none]]. Never the recorded start URL by
   * itself: a deleted first navigation must not come back, not even when a
   * later step goes to the same URL (#16; review R34).
   * The Markdown, the Gherkin, the payload and the model input all use this.
   */
  function startUrlOf(rec) {
    return (rec?.steps || []).find((s) => s.url)?.url || [{ redacted: 'url', as: 'none' }];
  }

  const NOTE_KIND_LABELS = { bug: '不具合', question: '疑問', idea: '気づき', next: '次に試す' };
  const noticeLabel = (step) => (step.level === 'alert' ? '警告' : '通知');

  /**
   * A note written in the side panel has no URL and no page to belong to. It is
   * commercial while the recording has any commercial step (ADR 0001), decided
   * again whenever the payload is built, since steps come and go after it.
   */
  const isPanelNote = (step) => step.type === 'note' && !step.url && step.source !== 'agent';

  function panelNoteEnv(steps) {
    return (steps || []).some((s) => !isPanelNote(s) && s.env === 'commercial') ? 'commercial' : 'standard';
  }

  /**
   * The steps with every panel note's environment decided again from the
   * recording (all: its whole step list, when steps is a part of it), so each
   * output reads one environment for the same recording (review R36).
   */
  function withPanelNoteEnv(steps, all = steps) {
    const env = panelNoteEnv(all);
    return (steps || []).map((s) => (isPanelNote(s) && s.env !== env ? { ...s, env } : s));
  }

  /** commercial | standard | mixed | none, from the environment of each step. */
  function coverageOf(steps) {
    const envs = new Set((steps || []).map((s) => s.env));
    if (!envs.size) return 'none';
    if (envs.size > 1) return 'mixed';
    return envs.has('commercial') ? 'commercial' : 'standard';
  }

  /**
   * A text of the reproduction (the Markdown, and what the model reads) with its placeholders shown.
   * The page's own ‹ and › become 〈 and 〉 first, so every ‹…› in the Markdown is a masked part (E4).
   * The Gherkin keeps the page's characters as they are.
   */
  const shown = (text) => humanize(String(text ?? '').replace(/‹/g, '〈').replace(/›/g, '〉'));

  /** [[text:12]] → ‹任意の文字列 12文字›, [[email]] → ‹メールアドレス› */
  function humanize(text) {
    // The argument of [[url:…]] is a scheme ([a-z][a-z0-9+.-]*), so "web+demo" is one too.
    return String(text ?? '').replace(/\[\[([a-z]+)(?::([\w+.-]+))?\]\]/gi, (match, kind, arg) => {
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
    if (txt(target.name)) return `「${txt(target.name)}」${noun}`;
    if (target.selector) return `${noun || '要素'}（${target.selector}）`;
    return noun || '要素';
  }

  /**
   * Everything rendered as a step, heading or list item is one line (#18): a
   * line break from the page, a kept textarea value or the model would
   * otherwise start a new Gherkin step or Markdown item.
   */
  // Zero-width and bidi controls hide or reorder text for the reader (E7): never rendered.
  const HIDDEN = new RegExp(HIDDEN_CHARS, 'gu');
  const line = (text) => oneLine(String(text ?? '').replace(HIDDEN, ''));

  const quote = (value) => (/^\[\[[^\]]+\]\]$/.test(value) ? value : `「${value}」`);

  // Which tab a step happened in (#40): a navigation in another tab is not the outcome of an
  // operation in this one, and a step in another tab is said to be there before it is told.
  const sameTab = (a, b) => a?.tab === b?.tab;
  const switchText = (tab) => `タブ ${tab} に切り替える`;
  /** The tab the steps start in: the first step that has one. */
  const firstTab = (steps) => steps.find((s) => s.tab !== undefined)?.tab;

  /** One step as one Japanese sentence. Placeholders stay raw; call humanize() to display. */
  function describeStep(step) {
    return line(sentenceOf(step));
  }

  function sentenceOf(step) {
    switch (step.type) {
      case 'navigate':
        return `${txt(step.url)} を開く`;
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
      case 'tool': {
        const json = step.args && typeof step.args === 'object' ? JSON.stringify(displayArgs(step.args)) : '';
        // The sentence shows the arguments up to argsInSentence; the Gherkin table keeps them all.
        const args = ellipsize(json, LIMITS.argsInSentence);
        return `WebMCP ツール「${txt(step.tool)}」を実行する${args && args !== '{}' ? `（引数: ${args}）` : ''}${step.ok === false ? '（失敗）' : ''}`;
      }
      case 'note':
        return `（${NOTE_KIND_LABELS[step.kind] || '確認'}）${txt(step.note)}`;
      case 'notice':
        return `${noticeLabel(step)}「${txt(step.notice)}」が表示される`;
      default:
        return `${step.type} 操作`;
    }
  }

  const NAVIGATION_CAUSES = new Set(['click', 'key', 'tool']);
  const FOLLOW_MS = 4000;
  /** Whether a navigation is the outcome of the step before it: a click, key or tool call in the same tab, shortly before. */
  const followsOperation = (previous, step) => Boolean(previous) && sameTab(previous, step)
    && NAVIGATION_CAUSES.has(previous.type) && step.t - previous.t <= FOLLOW_MS;

  /**
   * Builds { title, preconditions, steps: [{ action, expected? }], notes } from a recording.
   * A navigation right after a click, a key or a tool is folded into that step's expected result.
   */
  function buildReproduction(rec) {
    const steps = rec?.steps || [];
    const out = [];
    const notes = [];
    const findings = [];
    let previous = null;
    let tab = firstTab(steps);

    for (const step of steps) {
      // What the tester noticed is not an expected result: it stays out of the steps.
      if (step.type === 'note' && step.kind) {
        findings.push({ kind: step.kind, note: shown(txt(step.note)), afterStep: out.length });
        continue;
      }
      // In another tab than the step before: the switch is a step of its own, before anything of
      // that tab - a page's note or notice too, which then belongs to the switch, not to an
      // operation in the other tab (#40). A panel note has no tab and switches nothing.
      if (step.tab !== undefined && step.tab !== tab) {
        out.push({ action: switchText(step.tab) });
        tab = step.tab;
        // The switch stands between: what follows is not the outcome of an operation before it.
        previous = null;
      }
      if (step.type === 'note') {
        // Everything in the Markdown is rendered with ‹…› labels, never [[…]] (E4, #28).
        const note = shown(txt(step.note));
        const last = out[out.length - 1];
        if (last && !last.expected) last.expected = note;
        else if (last) last.expected += ` / ${note}`;
        else notes.push(note);
        previous = step;
        continue;
      }
      // What the page showed is an observation, not an expected result. A navigation
      // after it is still caused by the operation, so it does not become previous.
      if (step.type === 'notice') {
        const seen = shown(`${noticeLabel(step)}: ${txt(step.notice)}`);
        const last = out[out.length - 1];
        if (last) (last.observed ||= []).push(seen);
        else notes.push(seen);
        continue;
      }
      if (step.type === 'navigate' && followsOperation(previous, step) && out.length) {
        const last = out[out.length - 1];
        const moved = shown(`${txt(step.url)} に遷移する`);
        last.expected = last.expected ? `${last.expected} / ${moved}` : moved;
        previous = step;
        continue;
      }
      if (step.type === 'navigate' && previous?.type === 'navigate' && sameTab(previous, step) && txt(previous.url) === txt(step.url)) continue;
      out.push({ action: shown(describeStep(step)) });
      previous = step;
    }

    const startUrl = txt(startUrlOf(rec));
    const first = txt(steps.find((s) => s.url)?.url);
    if (startUrl !== NO_URL && (!out.length || !steps[0] || steps[0].type !== 'navigate')) {
      out.unshift({ action: shown(`${startUrl} を開く`) });
      for (const finding of findings) finding.afterStep += 1;
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
    if (steps.some((s) => s.url && /\.invalid\b/.test(txt(s.url)))) {
      notes.push('site-N.invalid は実際のホスト名を伏せた別名');
    }

    return {
      title: `操作の再現手順（${out.length} ステップ）`,
      preconditions,
      steps: out,
      notes,
      findings
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
      for (const shown of step.observed || []) lines.push(`   - 画面の表示: ${line(shown)}`);
    });
    if (repro.findings?.length) {
      lines.push('', '## 探索メモ', ...repro.findings.map((f) => {
        const where = f.afterStep ? `（手順 ${f.afterStep} の後）` : '';
        return `- [${NOTE_KIND_LABELS[f.kind]}] ${line(f.note)}${where}`;
      }));
    }
    if (repro.notes?.length) lines.push('', '## 補足', ...repro.notes.map((n) => `- ${line(n)}`));
    // Every line one line, whatever field it came from (E7; review R27), and every placeholder
    // a ‹…› label, the AI's output too: the Markdown is scanned as written (E4, #28).
    return `${lines.map((l) => humanize(line(l))).join('\n')}\n`;
  }

  // ------------------------------------------------------------ Gherkin + α

  const cell = (value) => String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n')
    .replace(HIDDEN, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ');

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
    add('url', txt(step.url));
    if (step.target) {
      add('role', step.target.role);
      add('name', txt(step.target.name));
      add('tag', step.target.tag);
      add('selector', step.target.selector);
      add('href', txt(step.target.href));
    }
    if (step.value !== undefined) add('value', display(step.value));
    add('checked', step.checked);
    add('key', step.key);
    add('tool', txt(step.tool));
    add('level', step.level);
    add('notice', txt(step.notice));
    if (step.args !== undefined) add('args', displayArgs(step.args));
    // Every step says where it came from: the person (user), the page (agent) or either (unknown) (W7).
    add('source', step.source);
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
  function toGherkin(rec, { envSteps } = {}) {
    const steps = rec?.steps || [];
    const coverage = coverageOf(withPanelNoteEnv(steps, envSteps || steps));
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
    const startUrl = txt(start?.url || startUrlOf(rec));
    // [[url:none]]: the payload of a recording whose steps were all deleted.
    if (startUrl && startUrl !== NO_URL) {
      // The step's sentence shows ‹…› like the Markdown; the attribute table keeps [[…]] (E3).
      out.push('  Background:', `    Given "${humanize(startUrl)}" を開いている`,
        // A start made up from a later step's URL is not something anyone did there: unknown (W7).
        ...table([['url', startUrl], ['source', start?.source || 'unknown']], '      '), '');
    }
    out.push('  Scenario: 記録された操作');

    let lastKeyword = '';
    let previous = null;
    let tab = start?.tab ?? firstTab(steps);
    const push = (keyword, text, rows) => {
      const shown = keyword === lastKeyword ? 'And' : keyword;
      lastKeyword = keyword;
      out.push(`    ${shown} ${text}`);
      if (rows?.length) out.push(...table(rows, '      '));
    };

    for (const step of steps) {
      if (step === start) { previous = step; continue; }
      if (step.type === 'note' && step.kind) {
        out.push(`    # [${NOTE_KIND_LABELS[step.kind]}] ${line(humanize(txt(step.note)))}`);
        continue;
      }
      // In another tab than the step before: said first, as a step of the person's, before
      // anything of that tab, a notice or a page's note too (#40). Same rule as the Markdown.
      if (step.tab !== undefined && step.tab !== tab) {
        // Read from the order of the steps, not seen as the person's act: unknown, like a navigation (W7).
        push('When', switchText(step.tab), [['action', 'switch-tab'], ['tab', String(step.tab)], ['source', 'unknown']]);
        tab = step.tab;
        // The switch stands between: what follows is not the outcome of an operation before it.
        previous = null;
      }
      if (step.type === 'notice') {
        push('Then', humanize(describeStep(step)), attributesOf(step));
        continue;
      }
      if (step.type === 'note') {
        push('Then', line(humanize(txt(step.note))), step.source ? [['source', step.source]] : null);
      } else if (step.type === 'navigate') {
        const caused = followsOperation(previous, step);
        const source = step.source ? [['source', step.source]] : [];
        if (caused) push('Then', `"${humanize(txt(step.url))}" に遷移する`, [['url', txt(step.url)], ...source]);
        else push('When', `"${humanize(txt(step.url))}" を開く`, [['action', 'navigate'], ['url', txt(step.url)], ...source]);
      } else {
        push('When', humanize(describeStep(step)), attributesOf(step));
      }
      previous = step;
    }
    if (!steps.length || (steps.length === 1 && start)) out.push('    # (操作はまだ記録されていません)');
    // Every line one line, whatever field it came from: a URL, an argument key or a value (E7; review R27).
    return `${out.map(line).join('\n')}\n`;
  }

  // ------------------------------------------------------- ADR 0005 formats

  /** The tester's expectation (ADR 0005): a note without a kind, written in the side panel. */
  const isExpectation = (step) => step.type === 'note' && !step.kind && step.source === 'user';
  const VERDICTS = { ok: 'OK', ng: 'NG' };
  const verdictOf = (step) => VERDICTS[step.verdict] || '未判定';
  // What the browser handed over as the person's operation (W7): counted apart from tool calls and the page's notes.
  const OPERATIONS = new Set(['click', 'input', 'select', 'check', 'upload', 'key']);
  const isOperation = (step) => step.source === 'user' && OPERATIONS.has(step.type);
  const UNKNOWN_SCREEN = '画面不明';
  const TRIMMED = '記録の一部が欠けている可能性がある';

  /** The masked URL of the closest step before index that has one, shown, or 画面不明. */
  function screenBefore(steps, index) {
    for (let i = index - 1; i >= 0; i -= 1) if (steps[i].url) return shown(txt(steps[i].url));
    return UNKNOWN_SCREEN;
  }

  /**
   * The notices shown for the expectation at index: from the closest person's operation, tool
   * call or navigation before it (else the start), up to it, in order (ADR 0005).
   */
  function noticesBefore(steps, index) {
    let from = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (isOperation(steps[i]) || steps[i].type === 'tool' || steps[i].type === 'navigate') { from = i + 1; break; }
    }
    return steps.slice(from, index).filter((s) => s.type === 'notice').map((s) => shown(describeStep(s)));
  }

  /** The environment and the version under test, one line each. */
  function environmentLines(recording) {
    const env = recording.environment || {};
    const parts = ['browser', 'platform', 'language'].map((k) => (env[k] ? shown(txt(env[k])) : '')).filter(Boolean);
    return [
      `- 環境: ${parts.length ? parts.join(' / ') : '（記録なし）'}`,
      `- 対象のバージョン: ${recording.targetVersion ? shown(txt(recording.targetVersion)) : '（記録なし）'}`
    ];
  }

  /**
   * The steps that bring the tester to the expectation at index, as the Markdown words them,
   * without the expectations, the exploration notes, the page's notes or the notices: those are
   * no steps to take (ADR 0005). A navigation right after an operation stays folded into it.
   */
  function reproductionBefore(recording, index) {
    const before = recording.steps.slice(0, index).filter((s) => s.type !== 'note' && s.type !== 'notice');
    const repro = buildReproduction({ ...recording, steps: before });
    const lines = [];
    if (recording.trimmed || recording.steps[0]?.type !== 'navigate') lines.push(`（${TRIMMED}）`);
    lines.push(...repro.preconditions.map((p) => `- 前提: ${p}`));
    if (!repro.steps.length) lines.push('（記録された操作なし）');
    repro.steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step.action}`);
      if (step.expected) lines.push(`   - その後: ${step.expected}`);
    });
    const cues = replayCues(before);
    if (cues.length) lines.push('', '再現の前に確かめること:', ...cues.map((c) => `- ${c}`));
    return lines;
  }

  // The person's operations that act on an element (a key may be pressed on the page itself).
  const TARGETED = new Set(['click', 'input', 'select', 'check', 'upload']);
  const MASKED_VALUES = new Set(['input', 'select', 'upload']);

  /**
   * What to settle before replaying the steps (ADR 0005, Issue #42 slice 3), by fixed rules:
   * an operation whose sentence gives nothing to find its element by, and a value that
   * was masked, which the tester supplies. Each step's sentence once, in the order recorded.
   */
  const NO_CUE = '対象を見つける手がかり（役割・名前・selector）が無い。画面から同じ要素を探す';
  const MASKED = '値を伏せてある。テスト値を用意して使い、伏せた値は推測しない';
  /**
   * Whether the sentence of targetText() shows something to find the element by (reviews r45, r46):
   * a name with the page's own characters (not only masked parts, which read ‹メールアドレス›),
   * a role the sentence names (ROLE_NOUN; any other role reads 要素), or the selector, which the
   * sentence shows only when there is no name at all (a masked-only name hides it too).
   */
  function hasCue(target) {
    if (!target) return false;
    const parts = Array.isArray(target.name) ? target.name : [target.name];
    const named = parts.some((p) => typeof p === 'string' && p.replace(HIDDEN, '').trim());
    return named || Boolean(ROLE_NOUN[target.role]) || (Boolean(target.selector) && !txt(target.name));
  }
  function replayCues(steps) {
    // By sentence, in the order first recorded; its notes in a fixed order, each once.
    const bySentence = new Map();
    for (const step of steps) {
      if (step.source !== 'user') continue;
      const sentence = shown(describeStep(step));
      const acts = TARGETED.has(step.type) || (step.type === 'key' && step.target);
      const notes = bySentence.get(sentence) || new Set();
      if (acts && !hasCue(step.target)) notes.add(NO_CUE);
      // A field emptied (length 0) needs no value: its sentence says to empty it.
      const emptied = step.value?.treatment === 'length' && step.value.length === 0;
      if (MASKED_VALUES.has(step.type) && step.value && step.value.treatment !== 'kept' && !emptied) notes.add(MASKED);
      if (notes.size) bySentence.set(sentence, notes);
    }
    return [...bySentence].map(([sentence, notes]) => `${sentence}（${[NO_CUE, MASKED].filter((n) => notes.has(n)).join('。')}）`);
  }

  /**
   * Format A (ADR 0005): one bug ticket for each expectation judged NG, built from a checked
   * payload's recording. Returns [{ ref, text }] in the order of the recording.
   */
  function bugTickets(recording) {
    const steps = recording?.steps || [];
    const out = [];
    steps.forEach((step, index) => {
      if (!isExpectation(step) || step.verdict !== 'ng') return;
      const expected = shown(txt(step.note));
      const notices = noticesBefore(steps, index);
      const lines = [
        `# [${step.ref}] 『${expected}』が期待どおりにならない（${screenBefore(steps, index)}）`,
        '',
        '## 再現手順',
        ...reproductionBefore(recording, index),
        '',
        '## 期待結果',
        expected,
        '',
        '## 実際の結果',
        shown(txt(step.actual)),
        ...(notices.length ? ['', '画面に出た通知:', ...notices.map((n) => `- ${n}`)] : []),
        '',
        '## 環境・対象バージョン',
        ...environmentLines(recording),
        '',
        `記録 ID: ${recording.id}`
      ];
      out.push({ ref: step.ref, text: `${lines.map((l) => humanize(line(l))).join('\n')}\n` });
    });
    return out;
  }

  /** The conclusion of a session record, by the first row of ADR 0005's table that applies. */
  function conclusionOf(recording) {
    const judged = recording.steps.filter(isExpectation);
    const ng = judged.filter((s) => s.verdict === 'ng').length;
    const ok = judged.filter((s) => s.verdict === 'ok').length;
    const open = judged.length - ng - ok;
    if (ng) return `問題あり（NG ${ng} 件）${open ? `（未判定 ${open} 件）` : ''}${recording.trimmed ? '（記録の一部が欠けている）' : ''}`;
    if (recording.trimmed === 'user') return '判定なし（記録の一部が欠けている）';
    if (!judged.length) return '判定なし（期待結果が無い）';
    if (open) return `判定なし（未判定 ${open} 件）`;
    return `確かめた範囲で問題なし（OK ${ok} 件）`;
  }

  /**
   * The masked URLs in the order they changed (ADR 0005): a new part wherever a step's URL
   * differs from the part it is in; a step without one stays in the part it is in, or a first
   * 画面不明 part. Each part counts the person's operations, tool calls and the page's notes.
   */
  function screenParts(steps) {
    const parts = [];
    let current = null;
    for (const step of steps) {
      const url = step.url ? txt(step.url) : null;
      if (!current || (url !== null && url !== current.url)) {
        current = { url, operations: 0, tools: 0, reports: 0 };
        parts.push(current);
      }
      if (isOperation(step)) current.operations += 1;
      else if (step.type === 'tool') current.tools += 1;
      else if (step.type === 'note' && step.source === 'agent') current.reports += 1;
    }
    return parts;
  }

  /** One step of the appendix: the template's sentence, with what kind of note it is. */
  function appendixLine(step, i) {
    if (step.type !== 'note') return `${i + 1}. ${shown(describeStep(step))}`;
    const note = shown(txt(step.note));
    if (step.source === 'agent') return `${i + 1}. ${note}（ページからの申告）`;
    if (step.kind) return `${i + 1}. ${note}（${NOTE_KIND_LABELS[step.kind]}）`;
    return `${i + 1}. ${note}（期待結果: ${verdictOf(step)}）`;
  }

  /**
   * Format B (ADR 0005): the session record of one recording, built from a checked payload's
   * recording once it has ended. null while it has no end, or an end before its start.
   */
  function sessionRecord(recording) {
    if (!recording?.endedAt || !(Date.parse(recording.endedAt) >= Date.parse(recording.startedAt))) return null;
    const steps = recording.steps || [];
    const minutes = Math.floor((Date.parse(recording.endedAt) - Date.parse(recording.startedAt)) / 60000);
    const lines = ['# 実施記録', '', `記録 ID: ${recording.id}`];
    if (recording.trimmed) lines.push('', '（記録の一部が上限で消えている。操作の数・画面・付録も一部）');
    lines.push('', '## 結論', conclusionOf(recording));
    lines.push('', '## 対象と範囲', recording.scope ? shown(txt(recording.scope)) : '（記録なし）');
    lines.push('', '## 対象のバージョン・環境', ...environmentLines(recording));
    lines.push('', '## 実施した時間', `${recording.startedAt} 〜 ${recording.endedAt}（${minutes} 分）`);
    lines.push('', '## 実施した操作', '伏せた URL の移り変わり（記録された操作は、ブラウザが人の操作として届けたもの）:');
    screenParts(steps).forEach((part, i) => {
      lines.push(`${i + 1}. ${part.url === null ? UNKNOWN_SCREEN : shown(part.url)}: 記録された操作 ${part.operations} 件 / ツール呼び出し ${part.tools} 件 / ページからの申告 ${part.reports} 件`);
    });
    lines.push('', '## 確かめたこと');
    const expectations = steps.map((s, i) => [s, i]).filter(([s]) => isExpectation(s));
    if (!expectations.length) lines.push('（期待結果なし）');
    for (const [step, index] of expectations) {
      lines.push(`- [${step.ref}] ${shown(txt(step.note))}（画面: ${screenBefore(steps, index)}）: ${verdictOf(step)}`);
      if (step.verdict === 'ng') {
        lines.push(`  - 実際の結果: ${shown(txt(step.actual))}`);
        lines.push(...noticesBefore(steps, index).map((n) => `  - 画面に出た通知: ${n}`));
        lines.push(`  - バグチケット [${step.ref}]`);
      }
    }
    lines.push('', '## 見つけたこと');
    const findings = steps.filter((s) => s.type === 'note' && s.kind);
    if (!findings.length) lines.push('（なし）');
    for (const kind of Object.keys(NOTE_KIND_LABELS)) {
      const of = findings.filter((s) => s.kind === kind);
      if (of.length) lines.push(`- ${NOTE_KIND_LABELS[kind]}`, ...of.map((s) => `  - ${shown(txt(s.note))}`));
    }
    lines.push('', '## やっていないこと', recording.notTested ? shown(txt(recording.notTested)) : '（記録なし）');
    lines.push('', '## 付録: 記録したステップ', ...steps.map(appendixLine));
    return `${lines.map((l) => humanize(line(l))).join('\n')}\n`;
  }

  const api = {
    rendered: txt, display, coverageOf, startUrlOf, isPanelNote, panelNoteEnv, humanize, describeStep, buildReproduction, toMarkdown, toGherkin,
    bugTickets, sessionRecord, followsOperation
  };
  root.OpScribeDescribe = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
