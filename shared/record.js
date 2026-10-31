/**
 * op-scribe - turns what a content script or the panel reports into a stored step.
 *
 * Runs in the service worker. Whatever the content script already did, every
 * step is sanitized again here: the environment is decided again from where
 * the message came from (ADR 0001), typed values are checked and re-masked,
 * URLs are aliased, user keywords masked, and redactions counted.
 *
 * No chrome.* here so the node tests can drive it. Classic script for the
 * same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const S = root.OpScribeSanitize || require('./sanitize.js');
  const { scrubText, scrubUrl, hostAllowed, typed, classifyField, walkArgs } = S;

  const STEP_TYPES = new Set(['navigate', 'click', 'input', 'select', 'check', 'upload', 'key', 'submit', 'tool', 'note']);
  // What a step must carry to mean anything (row T6); without it the step is not recorded.
  const REQUIRED = { navigate: 'url', input: 'value', select: 'value', check: 'checked', upload: 'value', key: 'key', tool: 'tool', note: 'note' };
  const FIELDS = new Set(['secret', 'pii', 'choice', 'search', 'text', 'file', 'arg']);
  const KEPT_LIMIT = { choice: 120, search: 120, text: 200, arg: 200 };
  const KIND = /^[a-z]{1,16}$/;
  // ADR 0003 rows T4 and T5.
  const TOKEN = /^[a-z][a-z0-9-]{0,23}$/;
  const KEY = /^(?:ctrl\+)?(?:meta\+)?(?:alt\+)?Enter$|^Escape$/;
  // RegExp#test(undefined) tests the string "undefined".
  const is = (re, value) => typeof value === 'string' && re.test(value);

  /** The recording's fixed host lists, taken from the settings when it started. */
  function policyOf(settings) {
    return {
      commercialHosts: [...(settings.commercialHosts || [])],
      hostAllowlist: [...(settings.hostAllowlist || [])]
    };
  }

  const hostOf = (url) => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  };

  /** 'commercial' when any of the URLs (top page, frame) is on a listed production host. */
  function envOf(urls, policy) {
    return urls.some((url) => url && hostAllowed(hostOf(url), policy.commercialHosts)) ? 'commercial' : 'standard';
  }

  /**
   * Names, notes and tool names are one line (rows T1, T2, W6): a line break
   * from the page could otherwise forge a Gherkin step or a Markdown heading (#18).
   */
  const oneLine = (text) => String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');

  const hasCommercial = (rec) => (rec.steps || []).some((s) => s.env === 'commercial');

  /**
   * A typed value from the content script, checked and masked again. Anything
   * that is not a well-formed typed value is redacted, never kept.
   */
  function cleanValue(value, env, settings, kinds, field = null) {
    const fail = (f) => {
      kinds.push('v');
      return typed.redacted(f, 'v');
    };
    if (!value || typeof value !== 'object' || typeof value.treatment !== 'string') return fail(field || 'text');
    const f = field || (FIELDS.has(value.field) ? value.field : 'text');
    const kind = is(KIND, value.kind) ? value.kind : 'v';
    switch (value.treatment) {
      case 'redacted':
        if (f === 'file') return typed.file(Number.isInteger(value.count) && value.count >= 0 ? Math.min(value.count, 999) : 0);
        return typed.redacted(f, kind);
      case 'length':
        if (!Number.isInteger(value.length) || value.length < 0) return fail(f);
        return { treatment: 'length', field: f, kind, length: Math.min(value.length, 1e6) };
      case 'kept': {
        if (f === 'arg' && typeof value.number === 'number') {
          return env !== 'commercial' && Number.isFinite(value.number) && Math.abs(value.number) < 1e6
            ? typed.keptNumber(value.number)
            : typed.redacted('arg', 'number');
        }
        const text = typeof value.text === 'string' ? value.text : '';
        if (f === 'secret' || f === 'pii' || f === 'file') return fail(f);
        if (!text && env === 'commercial' && (f === 'text' || f === 'arg')) return typed.length(f, 'text', '');
        if (!text) return typed.kept(f, '');
        if (env === 'commercial' && (f === 'text' || f === 'arg')) return fail(f);
        // Already escaped by the content script: keep its own placeholders.
        const r = scrubText(text, { keywords: settings.keywords, maxLength: KEPT_LIMIT[f], escape: false });
        kinds.push(...r.kinds);
        return typed.kept(f, r.text);
      }
      default:
        return fail(f);
    }
  }

  /**
   * WebMCP arguments (rows W1-W5), walked by the same walkArgs as maskArgs:
   * the same limits, and a credential or personal key redacts its whole
   * subtree, whatever arrives. Typed leaves are checked again.
   */
  function cleanArgs(node, env, settings, kinds) {
    return walkArgs(node, {
      keywords: settings.keywords,
      isLeaf: (n) => n === null || typeof n !== 'object' || typeof n.treatment === 'string',
      leaf: (n) => {
        if (n === null || typeof n === 'boolean') return n;
        if (n && typeof n === 'object') return cleanValue(n, env, settings, kinds, 'arg');
        // A raw string or number never comes from maskArgs.
        kinds.push('v');
        return typed.redacted('arg', 'v');
      }
    });
  }

  /**
   * Rows I3, I4 again in the worker: the content script sends the field's
   * names (never its value) and the worker classifies them with the same
   * classifyField. A field that turns out to be secret or personal is
   * redacted even if the content script kept it. The names are not stored.
   */
  function reclassify(value, meta, env) {
    if (!meta || typeof meta !== 'object' || !value) return value;
    const bounded = {};
    for (const k of ['tag', 'type', 'name', 'id', 'autocomplete', 'label', 'placeholder', 'ariaLabel', 'role']) {
      if (typeof meta[k] === 'string') bounded[k] = meta[k].slice(0, 200);
    }
    const cls = classifyField(bounded);
    if (cls.kind === 'secret') return typed.redacted('secret', cls.label);
    if (cls.kind !== 'pii' || value.field === 'pii') return value;
    if (env === 'commercial' && value.treatment === 'length') return { ...value, field: 'pii', kind: cls.label };
    return typed.redacted('pii', cls.label);
  }

  /**
   * raw: what the content script, the panel or the tab listener reported.
   * from: { tabUrl, frameUrl } as Chrome reports the sender; empty for the panel.
   * Returns the step to store, or null when it is not a step this recorder knows.
   */
  function cleanStep(raw, rec, settings, from = {}) {
    const type = String(raw.type);
    if (!STEP_TYPES.has(type)) return null;
    const policy = rec.policy;
    const env = from.tabUrl || from.frameUrl
      ? envOf([from.tabUrl, from.frameUrl], policy)
      : (hasCommercial(rec) ? 'commercial' : 'standard');
    const ctx = { ...policy, aliases: rec.aliases, keywords: settings.keywords, env };
    const kinds = [];
    const text = (value, maxLength) => {
      const r = scrubText(oneLine(value), { keywords: settings.keywords, maxLength });
      kinds.push(...r.kinds);
      return r.text;
    };
    const url = (value) => {
      const r = scrubUrl(value, ctx);
      kinds.push(...r.kinds.filter((k) => k !== 'host'));
      return r.url;
    };

    const step = { type, t: Math.max(0, Date.now() - rec.startedAt), env, source: raw.source === 'agent' ? 'agent' : 'user' };
    if (raw.pageUrl) step.url = url(raw.pageUrl);
    if (raw.target) {
      const t = raw.target;
      step.target = {};
      if (is(TOKEN, t.role)) step.target.role = t.role;
      if (is(TOKEN, t.tag)) step.target.tag = t.tag;
      if (t.name) step.target.name = text(t.name, 80);
      // A selector is a locator, not prose: if anything had to be masked, drop it entirely.
      if (t.selector) {
        const r = scrubText(oneLine(t.selector), { keywords: settings.keywords });
        if (!r.kinds.length) step.target.selector = r.text.slice(0, 160);
      }
      if (t.href) step.target.href = url(t.href);
    }
    if (raw.value !== undefined) step.value = reclassify(cleanValue(raw.value, env, settings, kinds), raw.field, env);
    if (raw.checked !== undefined) step.checked = Boolean(raw.checked);
    if (is(KEY, raw.key)) step.key = raw.key;
    if (type === 'tool') {
      step.tool = text(raw.tool, 80);
      step.ok = raw.ok !== false;
      step.source = 'agent';
      if (raw.args !== undefined) step.args = cleanArgs(raw.args, env, settings, kinds);
    }
    if (type === 'note') step.note = text(raw.note, 300);
    if (REQUIRED[type] && (step[REQUIRED[type]] === undefined || step[REQUIRED[type]] === '')) return null;
    if (type === 'upload' && step.value.field !== 'file') step.value = typed.file(0);
    if (type !== 'upload' && step.value?.field === 'file') step.value = typed.redacted('text', 'v');
    for (const kind of [...kinds, ...(Array.isArray(raw.valueKinds) ? raw.valueKinds : [])]) {
      if (is(KIND, kind)) rec.redactions[kind] = (rec.redactions[kind] || 0) + 1;
    }
    return step;
  }

  const api = { policyOf, envOf, oneLine, cleanStep };
  root.OpScribeRecord = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
