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
    argLeaves: 20,
    argsInSentence: 200,
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
   * must fit, escapes included. Worst cases: JSON writes a control character
   * as \u0000 (6 characters) and a quote or backslash as 2; a Gherkin table
   * cell doubles backslashes and pipes once more.
   */
  const TEXT = 2 * LIMITS.url + cut(LIMITS.name) + LIMITS.selector + cut(LIMITS.note) + cut(LIMITS.tool) + cut(LIMITS.kept.text);
  // The arguments as JSON with their typed wrappers ({"treatment":"kept","field":"arg","text":...}).
  const ARGS_JSON = LIMITS.argLeaves * (6 * cut(LIMITS.argKey) + 6 * cut(LIMITS.kept.arg) + 64) + 64;
  const STEP = Object.freeze({
    // One step in the payload JSON.
    json: 6 * TEXT + ARGS_JSON + 512,
    // Its Markdown: the action and the expected result (a note or the next navigation), args cut to argsInSentence.
    markdown: TEXT + cut(LIMITS.argsInSentence) + 512,
    // Its Gherkin: the sentence, then each field again in an escaped table cell, and the arguments' JSON (cell-escaped).
    gherkin: 3 * TEXT + cut(LIMITS.argsInSentence) + 2 * ARGS_JSON + 1024
  });
  const MARKDOWN = LIMITS.steps * STEP.markdown + 4096;
  const GHERKIN = LIMITS.steps * STEP.gherkin + 4096;
  const TOOLS_JSON = LIMITS.toolList * (6 * LIMITS.url + LIMITS.toolList * 6 * cut(LIMITS.tool));
  const TOTALS = Object.freeze({
    markdown: MARKDOWN,
    gherkin: GHERKIN,
    // The recording, plus the Markdown and the Gherkin as JSON strings: 6 bytes a character at worst.
    payloadBytes: LIMITS.steps * STEP.json + TOOLS_JSON + 6 * (MARKDOWN + GHERKIN) + 4096
  });

  /** WAI-ARIA 1.2 roles that are not abstract: the ones an element can take. */
  const ARIA_ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code '
    + 'columnheader combobox comment complementary contentinfo definition deletion dialog document emphasis feed figure '
    + 'form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math menu '
    + 'menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar '
    + 'radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status '
    + 'strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid '
    + 'treeitem').split(' '));

  /** The role an element takes from its role attribute: the first token that is a real role ("unknown searchbox"). */
  const primaryRole = (value) => String(value || '').trim().toLowerCase().split(/\s+/).find((t) => ARIA_ROLES.has(t)) || '';

  const api = { LIMITS, TOTALS, cut, STEP_RULES, ARIA_ROLES, primaryRole };
  root.OpScribeLimits = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
