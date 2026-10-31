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

  const SCHEMA = 'op-scribe.recording/v2';

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

  /** [[secret]] → ‹秘匿値›, [[card]] → ‹カード番号› (older recordings: [[text:12]] → ‹任意の文字列 12文字›) */
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

  function targetText(target) {
    if (!target) return '画面';
    const noun = ROLE_NOUN[target.role] || '';
    if (target.name) return `「${target.name}」${noun}`;
    if (target.selector) return `${noun || '要素'}（${target.selector}）`;
    return noun || '要素';
  }

  const quote = (value) => (/^\[\[[^\]]+\]\]$/.test(value) ? value : `「${value}」`);

  /** One step as one Japanese sentence. Placeholders stay raw; call humanize() to display. */
  function describeStep(step) {
    switch (step.type) {
      case 'navigate':
        return `${step.url} を開く`;
      case 'click':
        return `${targetText(step.target)}をクリックする`;
      case 'input':
        return step.value === ''
          ? `${targetText(step.target)}を空にする`
          : `${targetText(step.target)}に ${quote(step.value)} を入力する`;
      case 'select':
        return `${targetText(step.target)}で ${quote(step.value)} を選択する`;
      case 'check':
        return step.checked
          ? `${targetText(step.target)}をオンにする`
          : `${targetText(step.target)}をオフにする`;
      case 'upload':
        return `${targetText(step.target)}に ${step.value} をアップロードする`;
      case 'key':
        return step.target ? `${targetText(step.target)}で ${step.key} キーを押す` : `${step.key} キーを押す`;
      case 'submit':
        return 'フォームを送信する';
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

    const first = steps.find((s) => s.url)?.url || rec?.startUrl;
    if (rec?.startUrl && (!out.length || !steps[0] || steps[0].type !== 'navigate')) {
      out.unshift({ action: `${rec.startUrl} を開く` });
    }

    const preconditions = [];
    if (first) preconditions.push(`${new URL(first).origin} にアクセスできる状態であること`);
    if (steps.some((s) => /\[\[(?:secret|email|phone|card|personal)\]\]/.test(JSON.stringify(s)))) {
      preconditions.push('‹…› で伏せた値（ログイン情報など）はテスト用の値を用意して入力すること');
    }
    if (steps.some((s) => /\[\[text:/.test(JSON.stringify(s)))) {
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
    const lines = [`# ${repro.title}`, ''];
    if (repro.preconditions?.length) {
      lines.push('## 前提条件', ...repro.preconditions.map((p) => `- ${p}`), '');
    }
    lines.push('## 手順');
    (repro.steps || []).forEach((step, i) => {
      lines.push(`${i + 1}. ${step.action}`);
      if (step.expected) lines.push(`   - 期待結果: ${step.expected}`);
    });
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
      add('role', step.target.role);
      add('name', step.target.name);
      add('tag', step.target.tag);
      add('selector', step.target.selector);
      add('href', step.target.href);
    }
    add('value', step.value);
    add('checked', step.checked);
    add('key', step.key);
    add('tool', step.tool);
    add('args', step.args);
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
    const out = [
      '# op-scribe: Gherkin + attributes',
      `# recording: ${rec?.id || 'unknown'} / privacy: tiered-commercial/v1`,
      '# ‹…› and [[…]] are masked values, and so are values with * (t***@e***.com, 12****78): supply test values, never guess the original.',
      '# site-N.invalid is an alias for a host that is not disclosed.',
      '@op-scribe @privacy-tiered-commercial',
      'Feature: 記録された操作の再現',
      ''
    ];
    const start = steps[0]?.type === 'navigate' ? steps[0] : null;
    const startUrl = start?.url || rec?.startUrl;
    if (startUrl) {
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
        push('Then', humanize(step.note), step.source === 'agent' ? [['source', 'agent']] : null);
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

  const STEP_FIELDS = ['type', 't', 'url', 'value', 'checked', 'key', 'tool', 'args', 'ok', 'note', 'source', 'valueClass'];
  const TARGET_FIELDS = ['role', 'name', 'tag', 'selector', 'href'];

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
  const hasCommercial = (rec) => (rec?.steps || []).some((s) => s.privacy?.profile !== 'standard');

  /**
   * The privacy of a recording (docs/adr/0001): the policy and its version, whether its steps are on
   * production, elsewhere or both, and what was hidden. The host lists themselves are not sent.
   */
  function privacyOf(rec) {
    const steps = rec.steps || [];
    const commercialSteps = steps.filter((s) => s.privacy?.profile !== 'standard').length;
    const standardSteps = steps.length - commercialSteps;
    return {
      policy: 'tiered-commercial/v1',
      coverage: !commercialSteps ? 'standard-only' : !standardSteps ? 'commercial-only' : 'mixed',
      commercialSteps,
      standardSteps,
      hostsAliased: Object.keys(rec.aliases || {}).length,
      redactions: { ...(rec.redactions || {}) }
    };
  }

  function buildPayload(rec, reproduction, environment) {
    return {
      schema: SCHEMA,
      recording: {
        id: rec.id,
        startedAt: new Date(rec.startedAt).toISOString(),
        endedAt: rec.endedAt ? new Date(rec.endedAt).toISOString() : null,
        startUrl: rec.startUrl,
        privacy: privacyOf(rec),
        environment: pick(environment || {}, ['browser', 'platform', 'language']),
        steps: (rec.steps || []).map((step, i) => {
          const out = { n: i + 1, ...pick(step, STEP_FIELDS) };
          // How the step's values were treated (docs/adr/0001); a step without one is treated as commercial.
          out.privacy = { profile: step.privacy?.profile === 'standard' ? 'standard' : 'commercial' };
          if (step.target) out.target = pick(step.target, TARGET_FIELDS);
          return out;
        }),
        webmcpTools: Object.entries(rec.webmcpTools || {}).map(([site, tools]) => ({ site, tools }))
      },
      reproduction: {
        generator: reproduction?.generator || 'none',
        markdown: reproduction?.markdown || '',
        // With a step recorded on production, Gherkin is always rebuilt from the record: an edit is not sent.
        gherkin: hasCommercial(rec) ? toGherkin(rec) : reproduction?.gherkin || toGherkin(rec)
      },
      sentAt: new Date().toISOString()
    };
  }

  const api = { SCHEMA, humanize, describeStep, buildReproduction, toMarkdown, toGherkin, buildPayload };
  root.OpScribeDescribe = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
