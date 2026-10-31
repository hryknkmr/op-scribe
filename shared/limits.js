/**
 * op-scribe - every length and count limit, and the fields of each step kind, in one place.
 *
 * The masking (shared/sanitize.js, shared/record.js) cuts to these limits and
 * the independent check (shared/payload.js) accepts exactly what the cut can
 * produce. Defining them twice let the two drift apart: the masking made
 * values the check then refused (review of #22). A cut text gets "…"
 * appended, so it may be one character longer than its limit (cut()).
 *
 * Classic script for the same reasons as shared/sanitize.js.
 */
(function (root) {
  'use strict';

  const LIMITS = Object.freeze({
    kept: Object.freeze({ choice: 120, search: 120, text: 200, arg: 200 }),
    name: 80,
    note: 300,
    tool: 80,
    toolList: 50,
    selector: 160,
    argKey: 40,
    argItems: 10,
    argKeys: 20,
    argDepth: 3,
    argLeaves: 100,
    keptNumber: 1e6,
    typedLength: 1e6,
    fileCount: 999,
    url: 2048,
    scheme: 16,
    environment: 60,
    steps: 500
  });

  /** The longest text a cut to n can produce. */
  const cut = (n) => n + 1;

  /**
   * What each kind of step must and may carry besides n, type, t, env and
   * source (ADR 0003, row T6). The worker builds steps by it and the check
   * accepts by it.
   */
  const STEP_RULES = Object.freeze({
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
  });

  /**
   * Upper bounds of a whole payload, derived from the limits above rather than
   * chosen apart from them (review of #22): every recording the limits allow
   * must fit. A step holds at most its URL and link (url each), name, selector,
   * note, tool name, and argLeaves arguments with their keys; 512 covers the
   * fixed fields and the JSON around them.
   */
  const STEP_CHARS = 2 * LIMITS.url + cut(LIMITS.name) + LIMITS.selector + cut(LIMITS.note) + cut(LIMITS.tool)
    + LIMITS.argLeaves * (cut(LIMITS.argKey) + cut(LIMITS.kept.arg) + 64) + 512;
  const RECORDING_CHARS = LIMITS.steps * STEP_CHARS + LIMITS.toolList * (LIMITS.url + LIMITS.toolList * cut(LIMITS.tool));
  const TOTALS = Object.freeze({
    // Markdown says each step at most twice (action and expected result); hand edits get the same room.
    markdown: 2 * RECORDING_CHARS,
    // The recording, its Gherkin (each step's text and its attribute table: at most three times) and
    // the Markdown, at 6 bytes a character at worst (a control character escaped as \u0000 in JSON).
    payloadBytes: 6 * (RECORDING_CHARS + 3 * RECORDING_CHARS + 2 * RECORDING_CHARS)
  });

  const api = { LIMITS, TOTALS, cut, STEP_RULES };
  root.OpScribeLimits = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
