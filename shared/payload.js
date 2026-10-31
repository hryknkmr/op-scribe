/**
 * op-scribe - the one definition of the payload (op-scribe.recording/v2).
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

  const SCHEMA = 'op-scribe.recording/v2';
  const POLICY = 'commercial-strict/1';

  // ------------------------------------------------------------------- shape

  const str = (row, max, re) => ({ type: 'string', row, max, re });
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const URL_VALUE = str('U1', 2048);
  const opt = (node) => ({ ...node, optional: true });

  const TARGET = {
    type: 'object',
    fields: {
      role: opt(str('T4', 24, /^[a-z][a-z0-9-]{0,23}$/)),
      tag: opt(str('T4', 24, /^[a-z][a-z0-9-]{0,23}$/)),
      name: opt(str('T2', 81)),
      selector: opt(str('T3', 160)),
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
      tool: opt(str('W6', 81)),
      args: opt({ type: 'args', row: 'W1-W5' }),
      ok: opt({ type: 'bool', row: 'T6' }),
      note: opt(str('T1', 301))
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
          hostsAliased: { type: 'int', row: 'M1', min: 0 },
          redactions: { type: 'map', row: 'M1', key: /^[a-z]{1,16}$/, of: { type: 'int', row: 'M1', min: 0 } }
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
              browser: opt(str('M3', 60)),
              platform: opt(str('M3', 60)),
              language: opt(str('M3', 60))
            }
          },
          steps: { type: 'array', max: 500, of: STEP },
          webmcpTools: {
            type: 'array',
            max: 50,
            of: {
              type: 'object',
              fields: {
                site: URL_VALUE,
                tools: { type: 'array', max: 50, of: str('W6', 81) }
              }
            }
          }
        }
      },
      reproduction: {
        type: 'object',
        fields: {
          generator: { type: 'enum', row: 'M4', values: ['template', 'on-device-ai', 'manual', 'none'] },
          markdown: str('E4', 100000),
          gherkin: str('E3', 400000)
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

  const STEP_FIELDS = ['type', 't', 'env', 'source', 'url', 'value', 'checked', 'key', 'tool', 'args', 'ok', 'note'];
  const TARGET_FIELDS = ['role', 'name', 'tag', 'selector', 'href'];
  const ENV_FIELDS = ['browser', 'platform', 'language'];

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
      startUrl: rec.startUrl,
      environment: Object.fromEntries(Object.entries(pick(environment || {}, ENV_FIELDS))
        .map(([k, v]) => [k, String(v).slice(0, 60)])),
      steps: (rec.steps || []).map((step, i) => {
        const out = { n: i + 1, ...pick(step, STEP_FIELDS) };
        if (step.target) out.target = pick(step.target, TARGET_FIELDS);
        return out;
      }),
      webmcpTools: Object.entries(rec.webmcpTools || {}).map(([site, tools]) => ({ site, tools }))
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
  const KIND = /^[a-z]{1,16}$/;
  const KEPT_MAX = { choice: 121, search: 121, text: 201, arg: 201 };
  const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const hasOnly = (obj, keys) => Object.keys(obj).every((k) => keys.includes(k));

  /** Row E2: the treatment a typed value may have, given its field and environment. */
  function checkTyped(v, env, path, problems) {
    const bad = (problem) => problems.push({ path, problem });
    if (!isObject(v) || !TREATMENTS.has(v.treatment) || !FIELDS.has(v.field)) return bad('not a typed value');
    if (v.treatment === 'kept') {
      if (!hasOnly(v, ['treatment', 'field', 'text', 'number'])) return bad('unknown field');
      if (v.field === 'arg' && typeof v.number === 'number' && v.text === undefined) {
        if (!Number.isFinite(v.number)) return bad('not a finite number');
        if (env === 'commercial') return bad('commercial number kept');
        return undefined;
      }
      if (typeof v.text !== 'string' || v.number !== undefined) return bad('kept value is not text');
      if (v.field === 'secret' || v.field === 'pii' || v.field === 'file') return bad(`${v.field} kept`);
      if (v.text === '') return undefined;
      if (env === 'commercial' && (v.field === 'text' || v.field === 'arg')) return bad('commercial free text kept');
      if ([...v.text].length > KEPT_MAX[v.field]) return bad('too long');
      return undefined;
    }
    if (!KIND.test(String(v.kind))) return bad('bad kind');
    if (v.treatment === 'length') {
      if (!hasOnly(v, ['treatment', 'field', 'kind', 'length'])) return bad('unknown field');
      if (v.field === 'secret' || v.field === 'file') return bad(`${v.field} not redacted`);
      if (!Number.isInteger(v.length) || v.length < 0) return bad('bad length');
      return undefined;
    }
    if (v.field === 'file') {
      if (v.kind !== 'file' || !hasOnly(v, ['treatment', 'field', 'kind', 'count'])) return bad('bad file value');
      if (!Number.isInteger(v.count) || v.count < 0) return bad('bad count');
      return undefined;
    }
    if (!hasOnly(v, ['treatment', 'field', 'kind'])) return bad('unknown field');
    return undefined;
  }

  /** Rows W1-W5: null, booleans and typed values, in arrays and objects up to depth 3. */
  function checkArgs(node, env, path, problems, depth = 0) {
    if (node === null || typeof node === 'boolean') return;
    if (isObject(node) && typeof node.treatment === 'string') {
      checkTyped(node, env, path, problems);
      if (node.field !== 'arg') problems.push({ path, problem: 'not an argument value' });
      return;
    }
    if (depth >= 3) {
      problems.push({ path, problem: 'too deep' });
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > 10) problems.push({ path, problem: 'too many items' });
      node.forEach((v, i) => checkArgs(v, env, `${path}[${i}]`, problems, depth + 1));
      return;
    }
    if (isObject(node)) {
      const entries = Object.entries(node);
      if (entries.length > 20) problems.push({ path, problem: 'too many keys' });
      for (const [k, v] of entries) {
        if ([...k].length > 40) problems.push({ path, problem: 'key too long' });
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
        for (const k of Object.keys(value)) {
          if (!(k in node.fields)) bad(`unknown field ${k.slice(0, 40)}`);
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
          if (!node.key.test(k)) bad('bad key');
          checkNode(node.of, v, `${path}.${k}`, problems);
        }
        return undefined;
      case 'string':
        if (value === null && node.nullable) return undefined;
        if (typeof value !== 'string') return bad('not a string');
        if ([...value].length > node.max) return bad('too long');
        if (node.re && !node.re.test(value)) return bad('unexpected form');
        return undefined;
      case 'const':
        return value === node.value ? undefined : bad('unexpected value');
      case 'enum':
        return node.values.includes(value) ? undefined : bad('unexpected value');
      case 'int':
        return Number.isInteger(value) && value >= node.min ? undefined : bad('not an integer');
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

  // Row T6: what each kind of step must and may carry, besides n, type, t, env and source.
  const STEP_RULES = {
    navigate: { required: ['url'], allowed: ['url'] },
    click: { required: [], allowed: ['url', 'target'] },
    input: { required: ['value'], allowed: ['url', 'target', 'value'] },
    select: { required: ['value'], allowed: ['url', 'target', 'value'] },
    check: { required: ['checked'], allowed: ['url', 'target', 'checked'] },
    upload: { required: ['value'], allowed: ['url', 'target', 'value'] },
    key: { required: ['key'], allowed: ['url', 'target', 'key'] },
    submit: { required: [], allowed: ['url', 'target'] },
    tool: { required: ['tool', 'ok'], allowed: ['url', 'tool', 'ok', 'args'] },
    note: { required: ['note'], allowed: ['url', 'note'] }
  };
  const BASE_FIELDS = ['n', 'type', 't', 'env', 'source'];

  function checkStepKind(step, path, problems) {
    const rule = STEP_RULES[step.type];
    for (const f of rule.required) {
      if (step[f] === undefined || step[f] === '') problems.push({ path: `${path}.${f}`, problem: `missing for ${step.type}` });
    }
    for (const f of Object.keys(step)) {
      if (!BASE_FIELDS.includes(f) && !rule.allowed.includes(f)) problems.push({ path: `${path}.${f}`, problem: `not allowed for ${step.type}` });
    }
    const field = step.value?.field;
    if (step.type === 'upload' && step.value !== undefined && field !== 'file') problems.push({ path: `${path}.value`, problem: 'upload is not a file value' });
    if (step.type !== 'upload' && field === 'file') problems.push({ path: `${path}.value`, problem: 'file value outside upload' });
    if (step.type === 'tool' && step.source !== 'agent') problems.push({ path: `${path}.source`, problem: 'tool step not from agent' });
  }

  const SAFE_VALUE = /^[\w.-]{1,24}$/;
  const SPA_ROUTE = /^#\/[\w/-]{0,60}$/;
  const PLACEHOLDER_URL = /^\[\[url:[a-z0-9+.-]{1,16}\]\]$/;

  /**
   * Rows U1-U4, U7, U8: a URL value is either the placeholder for a URL that was
   * redacted as a whole, or an http(s) URL without user:pass@. In a commercial
   * step every query value is [[v]] and there is no fragment (the interim
   * rule until ③). site (WebMCP) is an origin only.
   */
  function checkUrl(value, env, path, problems, { origin = false } = {}) {
    const bad = (problem) => problems.push({ path, problem });
    if (PLACEHOLDER_URL.test(value)) return;
    let url;
    try { url = new URL(value); } catch { return bad('not a URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return bad('not http(s)');
    if (url.username || url.password) return bad('credentials in URL');
    if (origin && (url.pathname !== '/' || url.search || url.hash || value !== url.origin)) return bad('not an origin');
    if (env === 'commercial') {
      for (const [, v] of url.searchParams) if (v && v !== '[[v]]') return bad('commercial query value kept');
      if (url.hash) return bad('commercial fragment kept');
      return;
    }
    // standard (rows U7, U8): only the allowed forms; the key names are the worker's job (E2).
    for (const [, v] of url.searchParams) if (v && v !== '[[v]]' && !SAFE_VALUE.test(v)) return bad('query value not in an allowed form');
    if (url.hash && !SPA_ROUTE.test(url.hash)) return bad('fragment is not an SPA route');
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
    // The start URL is the first navigation's URL; judge it by that step even if earlier steps were deleted.
    const startEnv = steps.find((s) => s.url === payload.recording.startUrl)?.env;
    checkUrl(payload.recording.startUrl, startEnv, 'recording.startUrl', problems);
    payload.recording.webmcpTools.forEach((w, i) => checkUrl(w.site, 'standard', `recording.webmcpTools[${i}].site`, problems, { origin: true }));
    steps.forEach((step, i) => {
      const path = `recording.steps[${i}]`;
      if (step.n !== i + 1) problems.push({ path: `${path}.n`, problem: 'out of order' });
      checkStepKind(step, path, problems);
      if (step.url !== undefined) checkUrl(step.url, step.env, `${path}.url`, problems);
      if (step.target?.href !== undefined) checkUrl(step.target.href, step.env, `${path}.target.href`, problems);
      if (step.value !== undefined) checkTyped(step.value, step.env, `${path}.value`, problems);
      if (step.value?.field === 'arg') problems.push({ path: `${path}.value`, problem: 'argument value outside args' });
      if (step.args !== undefined) checkArgs(step.args, step.env, `${path}.args`, problems);
    });
    if (payload.privacy.coverage !== D.coverageOf(steps)) {
      problems.push({ path: 'privacy.coverage', problem: 'does not match the steps' });
    }
    if (payload.reproduction.gherkin !== D.toGherkin(payload.recording)) {
      problems.push({ path: 'reproduction.gherkin', problem: 'not rebuilt from the recording' });
    }
    return problems;
  }

  const api = { SCHEMA, POLICY, SHAPE, shapeRows, buildPayload, checkPayload };
  root.OpScribePayload = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
