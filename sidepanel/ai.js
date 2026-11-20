/**
 * op-scribe - on-device rewriting of reproduction steps (Prompt API / Gemini Nano).
 *
 * The model only ever sees steps that are already masked, and its output is
 * checked before use: it may not introduce URLs or ‹…› placeholders that were
 * not in the input, it must pass the same final scan as the payload, and its
 * steps must name the log lines they came from, every line once and in order.
 * Anything else falls back to the deterministic template.
 */

const LM = globalThis.LanguageModel;
const LANGUAGES = {
  expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
  expectedOutputs: [{ type: 'text', languages: ['ja'] }]
};
export const MAX_AI_STEPS = 80;

const SYSTEM_PROMPT = `あなたはソフトウェアの不具合報告で「再現手順」を書く担当者です。
入力はブラウザ操作ログを機械的に文章化したものです。別の人が同じ操作を再現できる手順書に整えてください。
守ること:
- 入力にない操作・画面・URL・値を書かない。推測で補わない。
- ‹…› で囲まれた伏せ字は一字一句そのまま残す。中身を推測・復元・言い換えしない。
- URL は入力に書かれた文字列のまま使う。
- 操作の順序は変えない。同じ画面への連続した遷移など、意味のない重複だけはまとめてよい。（確認）または（区切り）のある行は、次の行とまとめない。
- 期待結果は、入力に（確認）とあるもの、および直後の画面遷移から明らかなものだけを書く。
- 各手順は日本語で「〜する」で終わる 1 文にする。
- 各手順の from には、その手順の元にした操作ログの番号を小さい順に入れる。操作ログのすべての番号を、番号順に、ちょうど一度ずつ、どれか一つの手順に割り当てる。まとめた手順には連続した番号を入れる。`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    preconditions: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          expected: { type: 'string' },
          // The log lines (1-based) this step came from: checked by validate (sources). "number", which every
          // structured output takes; sources checks each is an integer.
          from: { type: 'array', items: { type: 'number' } }
        },
        required: ['action', 'from']
      }
    },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['title', 'steps']
};

/** availability() can hang while Chrome resolves the model component; never wait on it forever. */
export async function availability() {
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

const URLS = /https?:\/\/[^\s)」』>]+/g;
const MARKS = /‹[^›]*›/g;

/**
 * What the output has more often than the input (a multiset): the model may merge
 * duplicates, never add a URL or a masked part, not even one it has seen (review of #34).
 */
function added(inputText, outputText, re) {
  const left = new Map();
  for (const m of inputText.match(re) || []) left.set(m, (left.get(m) || 0) + 1);
  return (outputText.match(re) || []).filter((m) => {
    const n = left.get(m) || 0;
    left.set(m, n - 1);
    return n <= 0;
  });
}

/**
 * Why the steps do not account for the log lines 1..count, each once and in order; empty when they do.
 * A model may merge neighbours, never drop, repeat or reorder one: a step missing from reproduction
 * steps is a bug that no longer reproduces, and the leak checks below cannot see it.
 */
export function sources(steps, count) {
  const order = [];
  for (const [i, step] of steps.entries()) {
    if (!Array.isArray(step?.from) || !step.from.length || !step.from.every(Number.isInteger)) {
      return [`手順 ${i + 1} に元の操作の番号がありません`];
    }
    for (const n of step.from) order.push(n);
  }
  for (let n = 1; n <= count; n += 1) {
    const at = order[n - 1];
    if (at === n) continue;
    if (!order.includes(n)) return [`元の操作 ${n} が手順から抜けています`];
    return [`元の操作 ${n} の位置が変わっているか、重複しています`];
  }
  if (order.length > count) return [`入力にない操作（${order[count]}）を含みます`];
  return [];
}

/**
 * Why a merged step hides where something happened; empty when none does. Only meaningless repeats may be
 * merged: a template step with an expected result, what the page showed, or a finding right after it ends
 * what can be merged, since under the merged step it would read as coming after the steps that followed it.
 * Run on steps sources took.
 */
export function boundaries(steps, base) {
  const findingAfter = new Set((base.findings || []).map((f) => f.afterStep));
  for (const [i, step] of steps.entries()) {
    for (const n of step.from.slice(0, -1)) {
      const b = base.steps[n - 1];
      if (b.expected || b.observed?.length || findingAfter.has(n)) {
        return [`手順 ${i + 1} が、期待結果・画面の表示・探索メモのある元の操作 ${n} をまたいでまとめています`];
      }
    }
  }
  return [];
}

/**
 * Returns a list of reasons the model output cannot be trusted; empty means usable.
 * base: the template's reproduction whose steps were the log lines the model was given (sources, boundaries).
 */
export function validate(output, inputText, scan, base) {
  const problems = [];
  if (!output || typeof output.title !== 'string' || !Array.isArray(output.steps) || !output.steps.length
    || !output.steps.every((s) => s && typeof s.action === 'string')) {
    return ['出力が期待した形ではありません'];
  }
  const order = sources(output.steps, base.steps.length);
  problems.push(...(order.length ? order : boundaries(output.steps, base)));
  const text = JSON.stringify(output);
  // The renderer removes hidden characters (E7), so one could make "[\u200B[email]]" or a URL
  // appear only after this check: refuse them instead (one definition, shared/limits.js; review of #34 R10).
  if (new RegExp(globalThis.OpScribeLimits.HIDDEN_CHARS, 'u').test(text)) return ['見えない文字を含みます'];
  const newUrls = added(inputText, text, URLS);
  if (newUrls.length) problems.push(`入力にない URL を含みます: ${newUrls.slice(0, 2).join(', ')}`);
  const newMarks = added(inputText, text, MARKS);
  if (newMarks.length) problems.push(`入力にない伏せ字を含みます: ${newMarks.slice(0, 2).join(', ')}`);
  // The input shows every masked part as ‹…› and never holds "[[" (#28): any "[[" in the output was
  // made up by the model, and the Markdown would render a [[…]] as a masked part the recording lacks.
  if (text.includes('[[')) problems.push('入力にない伏せ字（[[…]]）を含みます');
  const findings = scan(output);
  if (findings.length) problems.push(`伏せるべき値が残っています (${findings.map((f) => f.kinds.join('/')).join(', ')})`);
  return problems;
}

/**
 * The reproduction from the template's (base) and an output validate took. Its steps' from cover the
 * template steps 1..n once and in order, and only the last of a merged group may carry an expected result,
 * what the page showed or a finding (boundaries): so each of those follows its step without moving.
 */
export function adopt(base, output) {
  const stepOf = (n) => output.steps.findIndex((s) => s.from.includes(n)) + 1;
  return {
    title: output.title,
    preconditions: [...new Set([...base.preconditions, ...(output.preconditions || [])])],
    steps: output.steps.map((s) => {
      const from = s.from.map((n) => base.steps[n - 1]);
      const observed = from.flatMap((b) => b.observed || []);
      return {
        action: s.action,
        expected: s.expected || from.map((b) => b.expected).filter(Boolean).join(' / ') || undefined,
        ...(observed.length && { observed })
      };
    }),
    notes: [...new Set([...(output.notes || []), ...base.notes])],
    findings: base.findings.map(({ kind, note, afterStep }) => ({ kind, note, afterStep: afterStep ? stepOf(afterStep) : 0 }))
  };
}

/**
 * @param {string[]} lines   humanized step sentences (already masked)
 * @param {(text: string) => void} onStatus
 */
export async function rewrite(lines, startUrl, onStatus) {
  if (!LM) throw new Error('このブラウザでは Prompt API (LanguageModel) を使えません');
  const state = await availability();
  if (state === 'unavailable' || state === 'no-api') throw new Error(`オンデバイスモデルを使えません (${state})`);

  const session = await LM.create({
    ...LANGUAGES,
    temperature: 0.2,
    topK: 3,
    initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
    monitor(monitor) {
      monitor.addEventListener('downloadprogress', (event) => {
        const pct = event.total ? Math.floor((event.loaded / event.total) * 100) : 0;
        onStatus(`モデルをダウンロード中 ${pct}%`);
      });
    }
  });

  try {
    onStatus('オンデバイス AI で整理中…');
    const input = `開始ページ: ${startUrl}\n操作ログ:\n${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}`;
    const raw = await session.prompt(input, { responseConstraint: RESPONSE_SCHEMA });
    return { output: JSON.parse(raw), input };
  } finally {
    session.destroy();
  }
}
