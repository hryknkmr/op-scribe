/**
 * op-scribe - the one definition of the payload (op-scribe.recording/v3).
 *
 * SHAPE lists every field that may leave the browser, with its type and the
 * row of docs/adr/0003 that decides its treatment. buildPayload copies only
 * these fields, and checkPayload checks a payload against them at every exit
 * and in tools/receiver.mjs.
 *
 * checkPayload is independent of the masking on purpose (ADR 0002, measure 3):
 * it never calls shared/sanitize.js, so a value the masking missed is not
 * waved through by the same judgment. It checks shape, types, enums and the
 * typed treatment of each value; looking for patterns in kept text is the
 * separate best-effort finalScan.
 *
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const D = root.OpScribeDescribe || require('./describe.js');
  // Limits are shared with the masking; the judgment is not (see above).
  const { LIMITS, TOTALS, cut, STEP_RULES, REDACTION_KINDS, typedAllowed, HIDDEN_CHARS, RUN_KINDS, URL_MARKERS, SCHEME, renderRuns } = root.OpScribeLimits || require('./limits.js');

  // v3: every text the masking keeps is runs, not a string with placeholders in it (#28).
  const SCHEMA = 'op-scribe.recording/v3';
  const POLICY = 'commercial-strict/1';

  // ------------------------------------------------------------------- shape

  const str = (row, max, re) => ({ type: 'string', row, max, re });
  // A text the masking cuts at n: longer than n only with the "…" the cut appends.
  // Always one line, with nothing hidden (E7, safety): a line break forges a Gherkin step
  // or a Markdown heading, and an invisible or bidi control hides text from the reviewer.
  const cutStr = (row, n) => ({ type: 'string', row, max: cut(n), cutAt: n });
  // A kept text as runs (#28), cut at n rendered characters like cutStr.
  const runs = (row, n) => ({ type: 'runs', row, max: cut(n), cutAt: n });
  const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
  const HIDDEN = new RegExp(HIDDEN_CHARS, 'u');

  /**
   * Row E7 at the gate, for every string of the recording rather than a list of
   * fields (review R27): no invisible or bidi control anywhere, and no line break
   * or control character but in the text a person typed (a kept typed value).
   */
  function checkLines(node, path, problems, inKept = false) {
    if (typeof node === 'string') {
      if (HIDDEN.test(node)) problems.push({ path, problem: 'hidden character' });
      else if (!inKept && BREAKS.test(node)) problems.push({ path, problem: 'not one line' });
      return;
    }
    if (Array.isArray(node)) {
      // The runs of a kept text are the text a person typed, part by part.
      node.forEach((v, i) => checkLines(v, `${path}[${i}]`, problems, inKept));
      return;
    }
    if (!isObject(node)) return;
    const kept = node.treatment === 'kept';
    for (const [k, v] of Object.entries(node)) {
      if (HIDDEN.test(k) || BREAKS.test(k)) problems.push({ path: `${path}.${k}`, problem: 'key not one line' });
      checkLines(v, `${path}.${k}`, problems, kept && k === 'text');
    }
  }
  const overCut = (text, n) => [...text].length > n && !text.endsWith('…');
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  // A URL is runs too; where each masked part may sit is checked by checkUrl (U1-U8, K1).
  const URL_VALUE = { type: 'runs', row: 'U1', max: LIMITS.url, url: true };
  // The site of a WebMCP tool list: a URL like any other, runs of one origin and nothing masked (W6).
  const SITE = { type: 'runs', row: 'W6', max: LIMITS.url, url: true };

  /**
   * Why v is not runs of these kinds, or '' (#28): strings and { redacted } parts, the strings
   * joined (no two in a row, none empty) and never holding "[[" - a placeholder is a part,
   * never text (K1). A URL marker is the whole URL's only part.
   */
  function runsProblem(v, kinds) {
    if (!Array.isArray(v)) return 'not runs';
    for (let i = 0; i < v.length; i += 1) {
      const p = v[i];
      if (typeof p === 'string') {
        if (!p) return 'empty text in runs';
        if (typeof v[i - 1] === 'string') return 'texts not joined';
        if (p.includes('[[')) return 'placeholder in text';
      } else if (isObject(p) && kinds.includes(p.redacted)) {
        if (p.redacted !== 'url' && !hasOnly(p, ['redacted'])) return 'unknown field in a masked part';
        if (p.redacted === 'url' && (!hasOnly(p, ['redacted', 'as']) || typeof p.as !== 'string'
          || !(URL_MARKERS.includes(p.as) || SCHEME.test(p.as)) || v.length !== 1)) return 'bad URL marker';
      } else {
        return 'not a masked part';
      }
    }
    return '';
  }
  const opt = (node) => ({ ...node, optional: true });

  const TARGET = {
    type: 'object',
    fields: {
      role: opt(str('T4', 24, /^[a-z][a-z0-9-]{0,23}$/)),
      tag: opt(str('T4', 24, /^[a-z][a-z0-9-]{0,23}$/)),
      name: opt(runs('T2', LIMITS.name)),
      // Page text with "[[" is escaped by the masking: a "[[" here would forge a placeholder finalScan skips.
      selector: opt({ ...cutStr('T3', LIMITS.selector), re: /^(?![\s\S]*\[\[)/ }),
      href: opt(URL_VALUE)
    }
  };

  const STEP = {
    type: 'object',
    fields: {
      n: { type: 'int', row: 'T6', min: 1 },
      type: { type: 'enum', row: 'T6', values: ['navigate', 'click', 'input', 'select', 'check', 'upload', 'key', 'submit', 'tool', 'note'] },
      t: { type: 'int', row: 'T6', min: 0 },
      env: { type: 'enum', row: 'T6', values: ['commercial', 'standard'] },
      source: { type: 'enum', row: 'T6', values: ['user', 'agent'] },
      url: opt(URL_VALUE),
      target: opt(TARGET),
      value: opt({ type: 'typed', row: 'I1-I8' }),
      checked: opt({ type: 'bool', row: 'T6' }),
      key: opt(str('T5', 32, /^(?:ctrl\+)?(?:meta\+)?(?:alt\+)?Enter$|^Escape$/)),
      tool: opt(runs('W6', LIMITS.tool)),
      args: opt({ type: 'args', row: 'W1-W5' }),
      ok: opt({ type: 'bool', row: 'T6' }),
      note: opt(runs('T1', LIMITS.note)),
      kind: opt({ type: 'enum', row: 'T6', values: ['bug', 'question', 'idea', 'next'] })
    }
  };

  const SHAPE = {
    type: 'object',
    fields: {
      schema: { type: 'const', row: 'M1', value: SCHEMA },
      privacy: {
        type: 'object',
        fields: {
          policy: { type: 'const', row: 'M1', value: POLICY },
          coverage: { type: 'enum', row: 'M1', values: ['commercial', 'standard', 'mixed', 'none'] },
          hostsAliased: { type: 'int', row: 'M1', min: 0, max: LIMITS.aliases },
          redactions: { type: 'map', row: 'M1', keys: REDACTION_KINDS, of: { type: 'int', row: 'M1', min: 0, max: LIMITS.redactionCount } }
        }
      },
      recording: {
        type: 'object',
        fields: {
          id: str('M2', 44, /^rec-[a-z0-9-]{1,40}$/),
          startedAt: str('M2', 24, ISO),
          endedAt: { ...str('M2', 24, ISO), nullable: true },
          startUrl: URL_VALUE,
          environment: {
            type: 'object',
            fields: {
              browser: opt(runs('M3', LIMITS.environment)),
              platform: opt(runs('M3', LIMITS.environment)),
              language: opt(runs('M3', LIMITS.environment))
            }
          },
          steps: { type: 'array', max: LIMITS.steps, of: STEP },
          webmcpTools: {
            type: 'array',
            max: LIMITS.toolList,
            of: {
              type: 'object',
              fields: {
                site: SITE,
                tools: { type: 'array', max: LIMITS.toolList, of: runs('W6', LIMITS.tool) }
              }
            }
          }
        }
      },
      reproduction: {
        type: 'object',
        fields: {
          generator: { type: 'enum', row: 'M4', values: ['template', 'on-device-ai', 'manual', 'none'] },
          markdown: str('E4', TOTALS.markdown),
          gherkin: str('E3', TOTALS.gherkin)
        }
      },
      sentAt: str('M2', 24, ISO)
    }
  };

  /** Every leaf of SHAPE as { path, row }, for the test that ties SHAPE to ADR 0003. */
  function shapeRows(node = SHAPE, path = '') {
    if (node.type === 'object') return Object.entries(node.fields).flatMap(([k, v]) => shapeRows(v, path ? `${path}.${k}` : k));
    if (node.type === 'array') return shapeRows(node.of, `${path}[]`);
    if (node.type === 'map') return [{ path: `${path}{}`, row: node.row }, ...shapeRows(node.of, `${path}{}`)];
    return [{ path, row: node.row }];
  }

  // ------------------------------------------------------------------- build

  // Copied fields come from SHAPE itself, so the builder cannot carry a field the definition lacks.
  const STEP_FIELDS = Object.keys(STEP.fields).filter((f) => f !== 'n' && f !== 'target');
  const TARGET_FIELDS = Object.keys(TARGET.fields);
  const ENV_FIELDS = Object.keys(SHAPE.fields.recording.fields.environment.fields);

  const pick = (obj, fields) => {
    const out = {};
    for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
    return out;
  };

  /**
   * The exact object that is previewed and sent. Built by allowlisting fields
   * so local-only state (tab id, real-origin alias map, granted origins, host
   * lists) can never ride along by accident. The Gherkin is always rebuilt
   * from the recording, whatever the panel shows (ADR 0003, row E3).
   */
  function buildPayload(rec, reproduction, environment) {
    const recording = {
      id: rec.id,
      startedAt: new Date(rec.startedAt).toISOString(),
      endedAt: rec.endedAt ? new Date(rec.endedAt).toISOString() : null,
      // Always the URL of a step, so the receiver can judge it by that step's environment.
      startUrl: D.startUrlOf(rec),
      // Masked and cut by the panel (cleanLine), never cut here: a cut before the
      // masking leaves half a keyword (M3). Too long is refused by the check.
      environment: pick(environment || {}, ENV_FIELDS),
      steps: (rec.steps || []).map((step, i) => {
        const out = { n: i + 1, ...pick(step, STEP_FIELDS) };
        if (D.isPanelNote(step)) out.env = D.panelNoteEnv(rec.steps);
        if (step.target) out.target = pick(step.target, TARGET_FIELDS);
        return out;
      }),
      webmcpTools: Object.entries(rec.webmcpTools || {}).map(([site, tools]) => ({ site: [site], tools }))
    };
    return {
      schema: SCHEMA,
      privacy: {
        policy: POLICY,
        coverage: D.coverageOf(recording.steps),
        hostsAliased: Object.keys(rec.aliases || {}).length,
        redactions: { ...(rec.redactions || {}) }
      },
      recording,
      reproduction: {
        generator: reproduction?.generator || 'none',
        markdown: reproduction?.markdown || '',
        gherkin: D.toGherkin(recording)
      },
      sentAt: new Date().toISOString()
    };
  }

  // ------------------------------------------------------------------- check

  const TREATMENTS = new Set(['kept', 'length', 'redacted']);
  const FIELDS = new Set(['secret', 'pii', 'choice', 'search', 'text', 'file', 'arg']);
  const KEPT_MAX = Object.fromEntries(Object.entries(LIMITS.kept).map(([f, n]) => [f, cut(n)]));
  const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const hasOnly = (obj, keys) => Object.keys(obj).every((k) => keys.includes(k));

  /** Row E2: the treatment a typed value may have, given its field and environment. */
  function checkTyped(v, env, path, problems) {
    const bad = (problem) => problems.push({ path, problem });
    if (!isObject(v) || !TREATMENTS.has(v.treatment) || !FIELDS.has(v.field)) return bad('not a typed value');
    // Only the typed values that may exist (TYPED_SCHEMA): a field and kind the masking never makes is refused.
    if (!typedAllowed(v.treatment, v.field, v.kind)) return bad(v.treatment === 'kept' ? `${v.field} kept` : 'bad kind');
    if (v.treatment === 'kept') {
      if (!hasOnly(v, ['treatment', 'field', 'text', 'number'])) return bad('unknown field');
      if (v.field === 'arg' && typeof v.number === 'number' && v.text === undefined) {
        if (!Number.isFinite(v.number) || Math.abs(v.number) >= LIMITS.keptNumber) return bad('number outside the kept range');
        if (env === 'commercial') return bad('commercial number kept');
        return undefined;
      }
      if (v.number !== undefined) return bad('kept value is not text');
      const problem = runsProblem(v.text, RUN_KINDS.text);
      if (problem) return bad(problem);
      if (!v.text.length) return env === 'commercial' && (v.field === 'text' || v.field === 'arg') ? bad('commercial free text kept') : undefined;
      if (env === 'commercial' && (v.field === 'text' || v.field === 'arg')) return bad('commercial free text kept');
      const text = renderRuns(v.text);
      if ([...text].length > KEPT_MAX[v.field] || overCut(text, LIMITS.kept[v.field])) return bad('too long');
      return undefined;
    }
    if (v.treatment === 'length') {
      if (!hasOnly(v, ['treatment', 'field', 'kind', 'length'])) return bad('unknown field');
      if (v.field === 'secret' || v.field === 'file') return bad(`${v.field} not redacted`);
      if (!Number.isInteger(v.length) || v.length < 0 || v.length > LIMITS.typedLength) return bad('bad length');
      // A personal field keeps its length only in a commercial step (I4; review R22).
      if (v.field === 'pii' && env !== 'commercial') return bad('standard personal value not redacted');
      return undefined;
    }
    if (v.field === 'file') {
      if (v.kind !== 'file' || !hasOnly(v, ['treatment', 'field', 'kind', 'count'])) return bad('bad file value');
      if (!Number.isInteger(v.count) || v.count < 0 || v.count > LIMITS.fileCount) return bad('bad count');
      return undefined;
    }
    if (!hasOnly(v, ['treatment', 'field', 'kind'])) return bad('unknown field');
    return undefined;
  }

  /** Rows W1-W5: null, booleans and typed values, in arrays and objects up to depth 3. */
  /** Values (leaves) in an argument tree, counted only as deep as checkArgs accepts. */
  // Every value of the arguments, an object or array below the root included (W5; review R38).
  function countValues(node, depth = 0) {
    if (node === null || typeof node !== 'object' || typeof node.treatment === 'string' || depth > LIMITS.argDepth) return 1;
    return (depth > 0 ? 1 : 0) + Object.values(node).reduce((n, child) => n + countValues(child, depth + 1), 0);
  }

  function checkArgs(node, env, path, problems, depth = 0) {
    if (node === null || typeof node === 'boolean') return;
    if (isObject(node) && typeof node.treatment === 'string') {
      checkTyped(node, env, path, problems);
      if (node.field !== 'arg') problems.push({ path, problem: 'not an argument value' });
      return;
    }
    if (depth >= LIMITS.argDepth) {
      problems.push({ path, problem: 'too deep' });
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > LIMITS.argItems) problems.push({ path, problem: 'too many items' });
      node.forEach((v, i) => checkArgs(v, env, `${path}[${i}]`, problems, depth + 1));
      return;
    }
    if (isObject(node)) {
      const entries = Object.entries(node);
      if (entries.length > LIMITS.argKeys) problems.push({ path, problem: 'too many keys' });
      for (const [k, v] of entries) {
        if ([...k].length > cut(LIMITS.argKey) || (overCut(k, LIMITS.argKey) && !/-(?:[2-9]|[1-9]\d+)$/.test(k))) problems.push({ path, problem: 'key too long' });
        // A key is rendered into the Gherkin: no "[[" there but the masking's own (K1).
        if (k.includes('[[')) problems.push({ path, problem: 'placeholder in a key' });
        checkArgs(v, env, `${path}.${k}`, problems, depth + 1);
      }
      return;
    }
    problems.push({ path, problem: 'raw value' });
  }

  function checkNode(node, value, path, problems) {
    const bad = (problem) => problems.push({ path: path || '(root)', problem });
    switch (node.type) {
      case 'object': {
        if (!isObject(value)) return bad('not an object');
        // Own keys only: "constructor" or "toString" are not fields of the definition.
        for (const k of Object.keys(value)) {
          if (!Object.hasOwn(node.fields, k)) bad(`unknown field ${k.slice(0, 40)}`);
        }
        for (const [k, child] of Object.entries(node.fields)) {
          const p = path ? `${path}.${k}` : k;
          if (value[k] === undefined) {
            if (!child.optional) problems.push({ path: p, problem: 'missing' });
          } else {
            checkNode(child, value[k], p, problems);
          }
        }
        return undefined;
      }
      case 'array':
        if (!Array.isArray(value)) return bad('not an array');
        if (value.length > node.max) bad('too many items');
        value.forEach((item, i) => checkNode(node.of, item, `${path}[${i}]`, problems));
        return undefined;
      case 'map':
        if (!isObject(value)) return bad('not an object');
        for (const [k, v] of Object.entries(value)) {
          if (!node.keys.includes(k)) bad('unknown kind');
          checkNode(node.of, v, `${path}.${k}`, problems);
        }
        return undefined;
      case 'runs': {
        const problem = runsProblem(value, node.url ? RUN_KINDS.url : RUN_KINDS.text);
        if (problem) return bad(problem);
        const text = renderRuns(value);
        if ([...text].length > node.max || (node.cutAt && overCut(text, node.cutAt))) return bad('too long');
        return undefined;
      }
      case 'string':
        if (value === null && node.nullable) return undefined;
        if (typeof value !== 'string') return bad('not a string');
        if ([...value].length > node.max || (node.cutAt && overCut(value, node.cutAt))) return bad('too long');
        if (node.re && !node.re.test(value)) return bad('unexpected form');
        // A date must exist, not only have the right digits (row M2).
        if (node.re === ISO) {
          const date = new Date(value);
          if (Number.isNaN(date.getTime()) || date.toISOString() !== value) return bad('not a real date');
        }
        return undefined;
      case 'const':
        return value === node.value ? undefined : bad('unexpected value');
      case 'enum':
        return node.values.includes(value) ? undefined : bad('unexpected value');
      case 'int':
        return Number.isInteger(value) && value >= node.min && value <= (node.max ?? Infinity) ? undefined : bad('not an integer in range');
      case 'bool':
        return typeof value === 'boolean' ? undefined : bad('not a boolean');
      // typed and args need the step's environment; checkPayload does them.
      case 'typed':
      case 'args':
        return undefined;
      default:
        return bad('unknown shape');
    }
  }

  // Row T6: STEP_RULES (shared/limits.js) says what each kind of step must and may carry.
  const BASE_FIELDS = ['n', 'type', 't', 'env', 'source'];

  function checkStepKind(step, path, problems) {
    const rule = STEP_RULES[step.type];
    for (const f of rule.required) {
      if (step[f] === undefined || step[f] === '' || (Array.isArray(step[f]) && !step[f].length)) problems.push({ path: `${path}.${f}`, problem: `missing for ${step.type}` });
    }
    for (const f of Object.keys(step)) {
      if (!BASE_FIELDS.includes(f) && !rule.allowed.includes(f)) problems.push({ path: `${path}.${f}`, problem: `not allowed for ${step.type}` });
    }
    const field = step.value?.field;
    if (step.type === 'upload' && step.value !== undefined && field !== 'file') problems.push({ path: `${path}.value`, problem: 'upload is not a file value' });
    if (step.type !== 'upload' && field === 'file') problems.push({ path: `${path}.value`, problem: 'file value outside upload' });
    if (step.type === 'tool' && step.source !== 'agent') problems.push({ path: `${path}.source`, problem: 'tool step not from agent' });
    // The fields each kind of step can hold (I5): a select is a choice (or secret or personal by its names),
    // never free text with the longer limit; an input is never a file (review R31).
    const allowed = { select: ['choice', 'secret', 'pii'], input: ['text', 'search', 'choice', 'secret', 'pii'] }[step.type];
    if (allowed && field !== undefined && !allowed.includes(field)) problems.push({ path: `${path}.value`, problem: `${field} value in ${step.type}` });
  }

  const SAFE_VALUE = /^[\w.-]{1,24}$/;
  const SPA_ROUTE = /^#\/[\w/-]{0,60}$/;
  const PATH_PARTS = ['[[id]]', '[[user]]', '[[masked]]'];

  /**
   * Rows U1-U4, U7, U8, K1: a URL is either one marker for a URL redacted as a
   * whole, or an http(s) URL without user:pass@ whose masked parts sit where
   * the masking puts them - id, user and masked as a whole path segment,
   * masked as a query key, v as a query value. Its texts hold no bracket but
   * an IPv6 host's, so every bracket of the rendering is a masked part. In a
   * commercial step every query value is masked and there is no fragment (the
   * interim rule until ③).
   */
  function checkUrl(value, env, path, problems, { none = false } = {}) {
    const bad = (problem) => problems.push({ path, problem });
    if (value.length === 1 && value[0]?.redacted === 'url') {
      // The no-URL marker is a start URL only, never a URL a step holds (review R30).
      if (value[0].as === 'none' && !none) bad('no-URL marker as a URL');
      return;
    }
    if (!value.length) return bad('empty URL');
    const brackets = value.some((p, i) => typeof p === 'string' && /[[\]]/.test(i === 0 ? p.replace(/^https?:\/\/\[[0-9A-Fa-f:.]+\]/i, '') : p));
    if (brackets) return bad('bracket outside a placeholder');
    let url;
    try { url = new URL(renderRuns(value)); } catch { return bad('not a URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad('not http(s)');
    if (url.username || url.password) return bad('credentials in URL');
    if (url.pathname.split('/').some((seg) => /[[\]]/.test(seg) && !PATH_PARTS.includes(seg))) return bad('masked part out of place in the path');
    const pairs = url.search ? url.search.slice(1).split('&').map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    }) : [];
    for (const [k, v] of pairs) {
      if (/[[\]]/.test(k) && k !== '[[masked]]') return bad('masked part out of place in the query');
      if (/[[\]]/.test(v) && v !== '[[v]]') return bad('masked part out of place in the query');
    }
    if (/[[\]]/.test(url.hash)) return bad('masked part in the fragment');
    if (env === 'commercial') {
      if (pairs.some(([, v]) => v && v !== '[[v]]')) return bad('commercial query value kept');
      if (url.hash) return bad('commercial fragment kept');
      return;
    }
    // standard (rows U7, U8): only the allowed forms; the key names are the worker's job (E2).
    for (const [, v] of url.searchParams) if (v && v !== '[[v]]' && !SAFE_VALUE.test(v)) return bad('query value not in an allowed form');
    if (url.hash && !SPA_ROUTE.test(url.hash)) return bad('fragment is not an SPA route');
  }

  /** Row W6: the site of a WebMCP tool list is an http(s) origin, as the URL parser writes it, with nothing masked. */
  function checkSite(value, path, problems) {
    const [origin] = value;
    if (value.length !== 1 || typeof origin !== 'string') return problems.push({ path, problem: 'not an origin' });
    let url;
    try { url = new URL(origin); } catch { return problems.push({ path, problem: 'not a URL' }); }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || origin !== url.origin) problems.push({ path, problem: 'not an origin' });
    return undefined;
  }

  /**
   * Problems with a payload as [{ path, problem }]; empty means it may leave.
   * Run on the exact object about to be sent, copied or saved, and on receipt.
   */
  function checkPayload(payload) {
    const problems = [];
    checkNode(SHAPE, payload, '', problems);
    if (problems.length) return problems;

    const steps = payload.recording.steps;
    // The start URL is one of the steps' URLs, or [[url:none]]; it is judged by that step's environment.
    const start = renderRuns(payload.recording.startUrl);
    const startStep = steps.find((s) => s.url !== undefined && renderRuns(s.url) === start);
    if (!startStep && start !== '[[url:none]]') problems.push({ path: 'recording.startUrl', problem: 'not a URL of the steps' });
    else if (start !== renderRuns(D.startUrlOf(payload.recording))) problems.push({ path: 'recording.startUrl', problem: 'not the first URL of the steps' });
    // [[url:none]] means no step has a URL: with one, the start is that URL (startUrlOf; review R30).
    if (start === '[[url:none]]' && steps.some((s) => s.url !== undefined)) problems.push({ path: 'recording.startUrl', problem: 'no URL while a step has one' });
    checkUrl(payload.recording.startUrl, startStep?.env, 'recording.startUrl', problems, { none: true });
    payload.recording.webmcpTools.forEach((w, i) => checkSite(w.site, `recording.webmcpTools[${i}].site`, problems));
    // Row W7: no more steps the page reported than a recording keeps.
    if (steps.filter((s) => s.source === 'agent').length > LIMITS.agentSteps) problems.push({ path: 'recording.steps', problem: 'too many reported steps' });
    steps.forEach((step, i) => {
      const path = `recording.steps[${i}]`;
      if (step.n !== i + 1) problems.push({ path: `${path}.n`, problem: 'out of order' });
      if (D.isPanelNote(step) && step.env !== D.panelNoteEnv(steps)) problems.push({ path: `${path}.env`, problem: 'panel note environment' });
      checkStepKind(step, path, problems);
      if (step.url !== undefined) checkUrl(step.url, step.env, `${path}.url`, problems);
      if (step.target?.href !== undefined) checkUrl(step.target.href, step.env, `${path}.target.href`, problems);
      if (step.value !== undefined) checkTyped(step.value, step.env, `${path}.value`, problems);
      if (step.value?.field === 'arg') problems.push({ path: `${path}.value`, problem: 'argument value outside args' });
      if (step.args !== undefined) {
        checkArgs(step.args, step.env, `${path}.args`, problems);
        if (countValues(step.args) > LIMITS.argLeaves) problems.push({ path: `${path}.args`, problem: 'too many values' });
      }
    });
    // Rendering a payload that already failed (an over-deep argument tree, say) proves nothing and may not finish.
    if (problems.length) return problems;
    checkLines(payload.recording, 'recording', problems);
    if (problems.length) return problems;
    if (payload.privacy.coverage !== D.coverageOf(steps)) {
      problems.push({ path: 'privacy.coverage', problem: 'does not match the steps' });
    }
    if (payload.reproduction.gherkin !== D.toGherkin(payload.recording)) {
      problems.push({ path: 'reproduction.gherkin', problem: 'not rebuilt from the recording' });
    }
    return problems;
  }

  /**
   * Row E8: the form the masking produces, apart from the safety gate above.
   * checkPayload accepts a safe superset; this finds a value that is safe but
   * that the masking would not have written - a sign the producer drifted.
   * Findings are LOW (ADR 0003): the tests run it on every generated payload,
   * the exits do not stop on it.
   */
  function checkCanonical(payload) {
    const problems = [];
    const bad = (path, problem) => problems.push({ path, problem });
    const isTypedLeaf = (v) => isObject(v) && typeof v.treatment === 'string';
    const walk = (v, path) => {
      if (typeof v === 'string') {
        // The "…" a cut appends is ours and is not NFKC ("..."); everything before it is.
        const body = v.replace(/…$/u, '');
        if (body.normalize('NFKC') !== body) bad(path, 'not NFKC');
        if (/^https?:\/\//i.test(v)) {
          // The URL parser's own form: lowercase scheme and host, no default port.
          try {
            const u = new URL(v);
            if (!v.startsWith(`${u.protocol}//${u.host}`)) bad(path, 'not the parsed URL');
          } catch { bad(path, 'not a URL'); }
        }
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${path}[${i}]`));
      } else if (isObject(v)) {
        // scrubUrl keeps http(s) URLs as URLs; only other schemes become a marker (U2).
        if (v.redacted === 'url' && (v.as === 'http' || v.as === 'https')) bad(path, 'http placeholder');
        Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
      }
    };
    walk(payload?.recording, 'recording');
    // A search box or a choice is kept in either environment (I5, I6): redacted only when the worker had to.
    (payload?.recording?.steps || []).forEach((step, i) => {
      if (['search', 'choice'].includes(step.value?.field) && step.value.treatment !== 'kept') bad(`recording.steps[${i}].value`, 'search or choice not kept');
    });
    // A key the masking made unique ends in -2 .. -argKeys, at its cut length (W5).
    const keys = (node, path) => {
      if (!isObject(node) && !Array.isArray(node)) return;
      if (isTypedLeaf(node)) return;
      for (const [k, v] of Object.entries(node)) {
        const body = k.replace(/…$/u, '');
        if (body.normalize('NFKC') !== body) bad(`${path}.${k}`, 'key not NFKC');
        const n = Number(/-(\d+)$/.exec(k)?.[1]);
        if (!Array.isArray(node) && [...k].length === cut(LIMITS.argKey) && n > LIMITS.argKeys) bad(`${path}.${k}`, 'key suffix past the key count');
        keys(v, `${path}.${k}`);
      }
    };
    (payload?.recording?.steps || []).forEach((step, i) => keys(step.args, `recording.steps[${i}].args`));
    const sites = (payload?.recording?.webmcpTools || []).map((w) => renderRuns(w.site));
    sites.forEach((site, i) => { if (sites.indexOf(site) !== i) bad(`recording.webmcpTools[${i}].site`, 'site twice'); });
    return problems;
  }

  const api = { SCHEMA, POLICY, SHAPE, shapeRows, buildPayload, checkPayload, checkCanonical };
  root.OpScribePayload = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
