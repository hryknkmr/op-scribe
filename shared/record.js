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
  const { LIMITS, STEP_RULES, REDACTION_KINDS, typedAllowed } = root.OpScribeLimits || require('./limits.js');
  const { scrubText, cleanLine, oneLine, placeholderKinds, scrubUrl, hostAllowed, parsedHost, typed, classifyField, walkArgs } = S;

  const STEP_TYPES = new Set(['navigate', 'click', 'input', 'select', 'check', 'upload', 'key', 'submit', 'tool', 'note']);
  const FIELDS = new Set(['secret', 'pii', 'choice', 'search', 'text', 'file', 'arg']);
  const KEPT_LIMIT = LIMITS.kept;
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
    try { return parsedHost(new URL(url).hostname); } catch { return ''; }
  };

  /** 'commercial' when any of the URLs (top page, frame) is on a listed production host. */
  function envOf(urls, policy) {
    return urls.some((url) => url && hostAllowed(hostOf(url), policy.commercialHosts)) ? 'commercial' : 'standard';
  }

  const hasCommercial = (rec) => (rec.steps || []).some((s) => s.env === 'commercial');

  /**
   * A typed value from the content script, checked and masked again. Anything
   * that is not a well-formed typed value is redacted, never kept.
   */
  function cleanValue(value, env, settings, kinds, field = null) {
    const fail = (f) => {
      kinds.push('v');
      return f === 'file' ? typed.file(0) : typed.redacted(f, 'v');
    };
    if (!value || typeof value !== 'object' || typeof value.treatment !== 'string') return fail(field || 'text');
    const f = field || (FIELDS.has(value.field) ? value.field : 'text');
    // Only a field and kind the masking makes (TYPED_SCHEMA); anything else is redacted.
    if (!typedAllowed(value.treatment, f, value.kind)) return fail(f);
    const { kind } = value;
    switch (value.treatment) {
      case 'redacted':
        if (f === 'file') return typed.file(Number.isInteger(value.count) && value.count >= 0 ? Math.min(value.count, LIMITS.fileCount) : 0);
        return typed.redacted(f, kind);
      case 'length':
        if (!Number.isInteger(value.length) || value.length < 0) return fail(f);
        return { treatment: 'length', field: f, kind, length: Math.min(value.length, LIMITS.typedLength) };
      case 'kept': {
        if (f === 'arg' && typeof value.number === 'number') {
          return env !== 'commercial' && Number.isFinite(value.number) && Math.abs(value.number) < LIMITS.keptNumber
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
        // The content script sends no kinds for arguments: count every placeholder the text holds,
        // the ones masked there and here alike (M1). Field values come with their kinds (valueKinds).
        kinds.push(...(f === 'arg' ? placeholderKinds(r.text) : r.kinds));
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
        // Redacted and length-only values are counted once, by countArgs; here only what
        // masking found inside kept text.
        if (n && typeof n === 'object') {
          const found = [];
          const value = cleanValue(n, env, settings, found, 'arg');
          if (value.treatment === 'kept') kinds.push(...found);
          return value;
        }
        // A raw string or number never comes from maskArgs.
        return typed.redacted('arg', 'v');
      }
    });
  }

  /** The redaction kinds in a cleaned argument tree: each redacted or length-only value once. */
  function countArgs(node, kinds) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.treatment === 'string') {
      if (node.treatment === 'redacted') kinds.push(node.kind);
      if (node.treatment === 'length') kinds.push(node.kind);
      return;
    }
    Object.values(node).forEach((child) => countArgs(child, kinds));
  }

  const FIELD_OF = { secret: 'secret', pii: 'pii', choice: 'choice', search: 'search', free: 'text' };
  const NO_VALUE_TYPES = new Set(['file', 'checkbox', 'radio']);
  const META_NAMES = ['tag', 'type', 'name', 'id', 'autocomplete', 'label', 'placeholder', 'ariaLabel', 'role'];

  /**
   * Rows I1-I8 again in the worker, before the value is looked at (review of
   * #22, R20): the content script sends the field's names (never its value)
   * and the worker classifies them, uncut, with the same classifyField. The
   * field that gives decides what the value may be and how long a kept text
   * may be. A field that is not recorded (I1), or a value whose field or kind
   * is not what the classification gives, drops the whole step: the worker
   * has no raw value to make the right one from. The names are not stored.
   * Returns the typed value, or null to drop the step.
   */
  function fieldValue(raw, env, settings, kinds) {
    const meta = raw.field;
    if (!meta || typeof meta !== 'object') return null;
    const names = { inSearch: meta.inSearch === true };
    for (const k of META_NAMES) if (typeof meta[k] === 'string') names[k] = meta[k];
    // The step kind the content script gives each field (review R21): a select is
    // the select tag and nothing else, a file is an upload (I7) and a checkbox or
    // radio is a check with no value (I5). Anything else claims a value it has none of.
    const type = String(names.type || '').toLowerCase();
    if ((raw.type === 'select') !== (names.tag === 'select') || NO_VALUE_TYPES.has(type)) return null;
    const cls = classifyField(names);
    if (cls.kind === 'ignore') return null;
    const field = FIELD_OF[cls.kind];
    const value = raw.value;
    if (!value || typeof value !== 'object' || value.field !== field) return null;
    if ((cls.kind === 'secret' || cls.kind === 'pii') && value.kind !== cls.label) return null;
    return cleanValue(value, env, settings, kinds, field);
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
      const r = cleanLine(value, { keywords: settings.keywords, maxLength });
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
      if (t.name) step.target.name = text(t.name, LIMITS.name);
      // A selector is a locator, not prose: if anything had to be masked, drop it entirely.
      if (t.selector) {
        const r = scrubText(oneLine(t.selector), { keywords: settings.keywords });
        // Cut like any kept text, with the "…" that says so (T3; review R21).
        const chars = [...r.text];
        if (!r.kinds.length) step.target.selector = chars.length > LIMITS.selector ? `${chars.slice(0, LIMITS.selector).join('')}…` : r.text;
      }
      if (t.href) step.target.href = url(t.href);
    }
    if (type === 'input' || type === 'select') {
      const value = fieldValue(raw, env, settings, kinds);
      if (!value) return null;
      step.value = value;
    }
    if (type === 'upload') step.value = cleanValue(raw.value, env, settings, kinds, 'file');
    if (raw.checked !== undefined) step.checked = Boolean(raw.checked);
    if (is(KEY, raw.key)) step.key = raw.key;
    if (type === 'tool') {
      step.tool = text(raw.tool, LIMITS.tool);
      step.ok = raw.ok !== false;
      step.source = 'agent';
      if (raw.args !== undefined) {
        step.args = cleanArgs(raw.args, env, settings, kinds);
        // The content script sends no kinds for arguments: count what the arguments hold now (M1).
        countArgs(step.args, kinds);
      }
    }
    if (type === 'note') step.note = text(raw.note, LIMITS.note);
    // Only what this kind of step may carry, and nothing without what it must (row T6).
    const rule = STEP_RULES[type];
    for (const f of Object.keys(step)) {
      if (!['type', 't', 'env', 'source'].includes(f) && !rule.allowed.includes(f)) delete step[f];
    }
    if (rule.required.some((f) => step[f] === undefined || step[f] === '')) return null;
    for (const kind of [...kinds, ...(Array.isArray(raw.valueKinds) ? raw.valueKinds : [])]) {
      // Only the kinds the payload may count (row M1), and never past the limit.
      if (REDACTION_KINDS.includes(kind)) rec.redactions[kind] = Math.min((rec.redactions[kind] || 0) + 1, LIMITS.redactionCount);
    }
    return step;
  }

  const api = { policyOf, envOf, oneLine, cleanStep };
  root.OpScribeRecord = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
