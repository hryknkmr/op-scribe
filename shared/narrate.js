/**
 * op-scribe - verbalizing a recording with Chrome's built-in AI (Prompt API).
 *
 * Model-agnostic: it talks to whatever on-device model Chrome exposes through
 * `LanguageModel`. Runs in the service worker (so a recording made by an
 * automated test is verbalized with no UI open) and in the side panel.
 *
 * The model only ever sees steps that are already masked, and its output is
 * checked before use: it may not introduce URLs or ‹…› placeholders that were
 * not in the input, and it must pass the same final scan as the payload.
 * Anything else falls back to the deterministic template.
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const D = root.OpScribeDescribe || (typeof require === 'function' ? require('./describe.js') : null);

  const LANGUAGES = {
    expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
    expectedOutputs: [{ type: 'text', languages: ['ja'] }]
  };
  const MAX_AI_STEPS = 80;

  const SYSTEM_PROMPT = `あなたはソフトウェアの不具合報告で「再現手順」を書く担当者です。
入力は、ブラウザで行われた操作を機械的に文章化したものです。操作したのは人のこともあれば、自動テストやエージェントのこともあります。
【画面】行は、その下の操作が行われた画面（タイトル・目的・主な UI）です。番号付きの行が操作です。
画面の目的を踏まえて、各操作が何のための操作かが伝わるように言い換えてください。
守ること:
- 番号付きの操作を 1 つずつ、同じ番号（index）で言い換える。操作を追加・統合・省略しない。
- 元の文にない動作（クリック、入力、選択など）を書かない。「開く」操作を「クリック」と書き換えない。
- 元の文にある URL と ‹…› の伏せ字は必ずそのまま残す。元の文にない URL・値・画面名を書かない。推測で補わない。
- URL の site-1.invalid のようなホスト名は、記録した人が公開しないことにした実在サイトの別名です。不正・異常・無効なサイトとして扱わない。
- 成功・失敗・不正・異常などの評価を書かない。入力に書かれていることだけを書く。
- ‹…› で囲まれた伏せ字は一字一句そのまま残す。中身を推測・復元・言い換えしない。
- 各手順は日本語で「〜する」で終わる 1 文にする。
- title には、この一連の操作を表す短い題名を書く。
- summary には、この一連の操作で何をしようとしていたかを 1〜2 文で書く。`;

  const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, action: { type: 'string' } },
          required: ['index', 'action']
        }
      }
    },
    required: ['title', 'summary', 'steps']
  };

  const URLS = /https?:\/\/[^\s)」』>、。]+/g;
  const MARKS = /‹[^›]*›/g;

  // Kinds of action a sentence can claim. A rewrite may not claim one its source does not.
  const ACTIONS = {
    click: /クリック|押す|押して|押下|タップ/,
    input: /入力/,
    select: /選択|選ぶ|選んで/,
    open: /開く|開いて|開き|アクセス|移動|遷移/,
    submit: /送信/,
    toggle: /オンにする|オフにする|チェック/,
    key: /キー/,
    upload: /アップロード/,
    clear: /空にする|消去/,
    // Judgements are facts the recording does not contain.
    judgement: /不正|異常|無効|攻撃|悪意|エラー|失敗|成功|問題/
  };

  /** availability() can hang while Chrome resolves the model component; never wait on it forever. */
  async function availability(LM) {
    if (!LM) return 'no-api';
    try {
      return await Promise.race([
        LM.availability(LANGUAGES),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))
      ]);
    } catch (error) {
      return `error: ${error.name}`;
    }
  }

  /** Screen headers unnumbered, operations numbered 1..n in the order of repro.steps. */
  function buildInput(repro, startUrl) {
    const lines = [`開始ページ: ${startUrl || '(不明)'}`, '操作ログ:'];
    let shown = null;
    (repro.steps || []).forEach((step, i) => {
      const screen = repro.screens?.[step.screen];
      if (screen && step.screen !== shown) {
        lines.push(`【画面】「${screen.title}」${screen.summary ? `— ${screen.summary}` : ''}${screen.components?.length ? `。主な UI: ${screen.components.slice(0, 4).join('、')}` : ''}`);
        shown = step.screen;
      }
      lines.push(`${i + 1}. ${step.action}${step.expected ? `（結果: ${step.expected}）` : ''}`);
    });
    return lines.join('\n');
  }

  /**
   * Problems with one piece of model text measured against the text it may draw on.
   * keepAll: the rewrite of a step must also keep every URL and ‹…› of its source,
   * since those are what make the step reproducible.
   */
  function problemsOf(text, source, scan, keepAll = false) {
    const problems = [];
    if (keepAll) {
      const lostUrl = (source.match(URLS) || []).find((u) => !text.includes(u));
      if (lostUrl) problems.push(`URL を落とした（${lostUrl}）`);
      const lostMark = (source.match(MARKS) || []).find((m) => !text.includes(m));
      if (lostMark) problems.push(`伏せ字を落とした（${lostMark}）`);
    }
    const allowedUrls = new Set(source.match(URLS) || []);
    const newUrls = (text.match(URLS) || []).filter((u) => !allowedUrls.has(u));
    if (newUrls.length) problems.push(`元にない URL（${newUrls[0]}）`);
    const allowedMarks = new Set(source.match(MARKS) || []);
    const newMarks = (text.match(MARKS) || []).filter((m) => !allowedMarks.has(m));
    if (newMarks.length) problems.push(`元にない伏せ字（${newMarks[0]}）`);
    const claimed = Object.entries(ACTIONS).filter(([, re]) => re.test(text) && !re.test(source)).map(([k]) => k);
    if (claimed.length) problems.push(`元にない動作（${claimed.join('、')}）`);
    const findings = scan ? scan({ text }) : [];
    if (findings.length) problems.push(`伏せるべき値（${findings[0].kinds.join('/')}）`);
    return problems;
  }

  /**
   * Keeps every fact from the recording and takes only wording from the model:
   * each rewritten step is checked against its own source step and replaced
   * by the template sentence when it claims anything the source does not.
   * Expected results always come from the recording.
   */
  function merge(base, output, inputText, scan) {
    const rejected = [];
    const byIndex = new Map((Array.isArray(output?.steps) ? output.steps : []).map((s) => [Number(s.index), s]));
    const steps = base.steps.map((step, i) => {
      const source = `${step.action} ${step.expected || ''}`;
      const candidate = byIndex.get(i + 1)?.action;
      if (typeof candidate !== 'string' || !candidate.trim()) {
        rejected.push(`${i + 1}: 言い換えなし`);
        return step;
      }
      // May draw on the expected result for wording, must keep what the action itself carries.
      const problems = [...problemsOf(candidate, step.action, null, true).filter((p) => p.includes('落とした')),
        ...problemsOf(candidate, source, scan)];
      if (problems.length) {
        rejected.push(`${i + 1}: ${problems[0]}`);
        return step;
      }
      return { ...step, action: candidate.trim() };
    });
    const extra = [...byIndex.keys()].filter((k) => !(k >= 1 && k <= base.steps.length));
    if (extra.length) rejected.push(`存在しない手順番号 ${extra.join(', ')} は無視`);

    const accept = (text, fallback) => (typeof text === 'string' && text.trim() && !problemsOf(text, inputText, scan).length ? text.trim() : fallback);
    return {
      repro: {
        title: accept(output?.title, base.title),
        summary: accept(output?.summary, undefined),
        screens: base.screens,
        preconditions: base.preconditions,
        steps,
        notes: base.notes
      },
      rewritten: steps.filter((s, i) => s !== base.steps[i]).length,
      rejected
    };
  }

  /**
   * Verbalizes a recording. Never throws: on any problem the deterministic
   * template is returned with the reason, so a recording always ends up
   * described.
   * @returns {{ generator: 'built-in-ai'|'template', markdown: string, summary?: string, reason?: string }}
   */
  async function narrate(rec, { LM = root.LanguageModel, scan, onStatus = () => {} } = {}) {
    const base = D.buildReproduction(rec);
    const template = (reason) => ({ generator: 'template', markdown: D.toMarkdown(base), reason });
    if (!base.steps.length) return template('操作が記録されていません');
    if (base.steps.length > MAX_AI_STEPS) return template(`${MAX_AI_STEPS} ステップを超えるため AI は使いません`);

    const state = await availability(LM);
    if (state !== 'available') return template(`Built-in AI を使えません (${state})`);

    let session;
    try {
      session = await LM.create({
        ...LANGUAGES,
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            onStatus(`モデルをダウンロード中 ${Math.floor((event.loaded / (event.total || 1)) * 100)}%`);
          });
        }
      });
      onStatus('Built-in AI で言語化しています…');
      const input = buildInput(base, rec.startUrl);
      const raw = await session.prompt(input, { responseConstraint: RESPONSE_SCHEMA });
      const { repro, rewritten, rejected } = merge(base, JSON.parse(raw), input, scan);
      if (!rewritten) return template(`AI の言い換えを採用できませんでした（${rejected[0] || '出力なし'}）`);
      const result = { generator: 'built-in-ai', markdown: D.toMarkdown(repro), rewritten, total: base.steps.length };
      if (repro.summary) result.summary = repro.summary;
      if (rejected.length) result.reason = `${rejected.length} 件はテンプレートの文を使用（${rejected.slice(0, 3).join(' / ')}）`;
      return result;
    } catch (error) {
      return template(`AI で失敗しました: ${error?.message || error}`);
    } finally {
      session?.destroy();
    }
  }

  const api = { LANGUAGES, MAX_AI_STEPS, SYSTEM_PROMPT, RESPONSE_SCHEMA, availability, buildInput, problemsOf, merge, narrate };
  root.OpScribeNarrate = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
