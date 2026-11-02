/**
 * op-scribe - every length and count limit, and the fields of each step kind, in one place.
 *
 * The masking (shared/sanitize.js, shared/record.js) cuts to these limits and
 * the independent check (shared/payload.js) accepts every length the cut can
 * produce - a safe superset of what the masking writes, not the same set
 * (ADR 0003, E1; E8 checks the masking's own form). Defining them twice let the two drift apart: the masking made
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
    // ADR 0005: what the tester writes besides a note - the actual result of an NG, and at start and
    // stop the scope, the version under test and what was not tested. Masked like a note (T1).
    actual: 300,
    scope: 300,
    targetVersion: 80,
    notTested: 300,
    notice: 200,
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
    steps: 500,
    // Steps not from a trusted event of the person (source 'agent': WebMCP tool calls and expectations;
    // 'unknown': the tab's navigations and the page's notices, which a page script can cause too): at most this many
    // together, so they never push the person's steps out (W7, #17).
    agentSteps: 100,
    // chrome.storage.session holds 10 MiB for everything the extension keeps there, shared out
    // once here (review R43): the recording (oldest steps go first past it) and the Markdown
    // draft (not kept past it), with 1 MiB to spare.
    storeBytes: 6 * 1024 * 1024,
    draftBytes: 3 * 1024 * 1024,
    // What a recording holds besides its steps, bounded so the steps always have room (review R41).
    hosts: 100,
    host: 253,
    aliases: 500,
    redactionCount: 1e9
  });

  /** The kinds counted in privacy.redactions (row M1): only these, each a count up to redactionCount. */
  const REDACTION_KINDS = Object.freeze(['secret', 'card', 'email', 'phone', 'personal', 'postal', 'id', 'ip', 'number',
    'keyword', 'text', 'query', 'hash', 'user', 'url', 'v']);

  /**
   * Every typed value that may exist (ADR 0003, "伏せた結果の型"): the fields a
   * kept value may have, and for length and redacted the kinds each field may
   * carry. The masking makes only these, the worker keeps only these and the
   * check and the receiver accept only these; describe renders only these.
   * Defined once so the four cannot drift apart (review of #22, R20).
   * nested (an argument too deep) and value (an argument that is neither text
   * nor a number) are kinds of their own, not counted in privacy.redactions.
   */
  // A card field is a secret field (I3), never a personal one: classifyField decides it first.
  const PII_KINDS = ['email', 'phone', 'personal'];
  const TYPED_SCHEMA = Object.freeze({
    kept: Object.freeze(['text', 'choice', 'search', 'arg']),
    length: Object.freeze({ text: ['text'], arg: ['text'], pii: PII_KINDS }),
    redacted: Object.freeze({
      text: ['v'],
      choice: ['v'],
      search: ['v'],
      secret: ['secret', 'card', 'v'],
      pii: [...PII_KINDS, 'v'],
      arg: ['secret', 'card', ...PII_KINDS, 'number', 'nested', 'value', 'v'],
      file: ['file']
    })
  });

  /**
   * A text the masking keeps, as runs (ADR 0003, "残した文の型"; #28): the page's
   * text as strings and each masked part as { redacted: kind }, never a
   * placeholder written into the text. A URL is runs too; a URL redacted as a
   * whole is one part { redacted: 'url', as: 'invalid' | 'long' | 'none' | scheme }.
   * Only a renderer writes [[kind]] (renderRuns), so no string of the payload
   * holds one and a keyword is never confused with a placeholder name.
   */
  const RUN_KINDS = Object.freeze({
    text: Object.freeze(['secret', 'card', 'email', 'phone', 'postal', 'id', 'ip', 'number', 'masked']),
    // Path segments (id, user, masked), a query key (masked), a query value (v), the whole URL (url).
    url: Object.freeze(['id', 'user', 'masked', 'v', 'url'])
  });
  // The markers of a URL redacted as a whole: unparsable, too long, no URL at all.
  const URL_MARKERS = Object.freeze(['invalid', 'long', 'none']);
  const SCHEME = /^[a-z][a-z0-9+.-]{0,15}$/;

  /** A redacted part as a placeholder; anything that is not one renders as [[v]]. */
  function placeholder(part) {
    const kind = part?.redacted;
    // as must be a string of its own: SCHEME.test(undefined) reads "undefined" (review of #34 R5).
    if (kind === 'url') return `[[url:${typeof part.as === 'string' && (URL_MARKERS.includes(part.as) || SCHEME.test(part.as)) ? part.as : 'invalid'}]]`;
    return RUN_KINDS.text.includes(kind) || RUN_KINDS.url.includes(kind) ? `[[${kind}]]` : '[[v]]';
  }

  /** Runs as one text with [[kind]] placeholders: the rendering, and what lengths are counted on. */
  const renderRuns = (runs) => (Array.isArray(runs) ? runs.map((p) => (typeof p === 'string' ? p : placeholder(p))).join('') : String(runs ?? ''));

  /** Whether a treatment, field and kind make a typed value that may exist. */
  const typedAllowed = (treatment, field, kind) => (treatment === 'kept'
    ? TYPED_SCHEMA.kept.includes(field)
    : Boolean(Object.hasOwn(TYPED_SCHEMA, treatment) && Object.hasOwn(TYPED_SCHEMA[treatment], field)
      && TYPED_SCHEMA[treatment][field].includes(kind)));

  /**
   * Characters that hide or reorder text for the reader: every bidi control and
   * every default-ignorable code point (zero-width, tags, fillers), by Unicode
   * property rather than a hand-made list (E7; review R28 found U+061C and
   * U+2066-U+2069 missing from three copies of one). The masking removes them,
   * the renderer never writes them and the gate refuses them - all from here.
   */
  const HIDDEN_CHARS = '[\\p{Bidi_Control}\\p{Default_Ignorable_Code_Point}]';

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
    tool: { required: ['tool', 'ok'], allowed: ['url', 'tool', 'ok', 'args'] },
    // ref, verdict and actual only on the tester's expectation, in v4 (ADR 0005); payload.js checks which note may hold them.
    note: { required: ['note'], allowed: ['url', 'note', 'kind', 'ref', 'verdict', 'actual'] },
    notice: { required: ['url', 'notice', 'level'], allowed: ['url', 'notice', 'level'] }
  });

  /**
   * Upper bounds of a whole payload, derived from the limits above rather than
   * chosen apart from them (review of #22): every recording the limits allow
   * must fit, escapes included. Worst cases: JSON writes a control character
   * as \u0000 (6 characters) and a quote or backslash as 2; a Gherkin table
   * cell doubles backslashes and pipes once more.
   */
  const TEXT = 2 * LIMITS.url + cut(LIMITS.name) + cut(LIMITS.selector) + cut(LIMITS.note) + cut(LIMITS.actual) + cut(LIMITS.tool) + cut(LIMITS.kept.text);
  // The arguments as JSON with their typed wrappers ({"treatment":"kept","field":"arg","text":...}).
  const ARGS_JSON = LIMITS.argLeaves * (6 * cut(LIMITS.argKey) + 6 * cut(LIMITS.kept.arg) + 64) + 64;
  const STEP = Object.freeze({
    // One step in the payload JSON. Runs take at most 6 bytes a rendered character too: a
    // string part as a JSON string, and { "redacted": ... } is shorter than 6 times its placeholder.
    json: 6 * TEXT + ARGS_JSON + 1024,
    // Its Markdown: the action and the expected result (a note or the next navigation), args cut to argsInSentence.
    markdown: TEXT + cut(LIMITS.argsInSentence) + 512,
    // Its Gherkin: the sentence, then each field again in an escaped table cell, and the arguments' JSON (cell-escaped).
    gherkin: 3 * TEXT + cut(LIMITS.argsInSentence) + 2 * ARGS_JSON + 1024
  });
  const MARKDOWN = LIMITS.steps * STEP.markdown + 4096;
  const GHERKIN = LIMITS.steps * STEP.gherkin + 4096;
  const TOOLS_JSON = LIMITS.toolList * (6 * LIMITS.url + LIMITS.toolList * 6 * cut(LIMITS.tool));
  const REDACTIONS_JSON = REDACTION_KINDS.length * 32;
  // The recording's own texts (ADR 0005), as runs in JSON: 6 bytes a rendered character at worst.
  const RECORDING_TEXT_JSON = 6 * (cut(LIMITS.scope) + cut(LIMITS.targetVersion) + cut(LIMITS.notTested)) + 256;
  const TOTALS = Object.freeze({
    markdown: MARKDOWN,
    gherkin: GHERKIN,
    // The recording, plus the Markdown and the Gherkin as JSON strings: 6 bytes a character at worst.
    payloadBytes: LIMITS.steps * STEP.json + TOOLS_JSON + REDACTIONS_JSON + RECORDING_TEXT_JSON + 6 * (MARKDOWN + GHERKIN) + 4096
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

  /**
   * The payload's own words (step types, environments, treatments, fields,
   * kinds ...): fixed by the format, never from a page. The final scan does not
   * look for keywords in them, so a keyword such as "mail" does not stop every
   * recording with an { kind: 'email' } in it (K2, #28). Each key has its own
   * words, so a word of one never passes as another (a role "email" is scanned;
   * review of #34); anything else there is scanned.
   */
  const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const words = (...lists) => {
    const set = new Set(lists.flat());
    return (value) => set.has(value);
  };
  const VOCAB = Object.freeze({
    schema: (value) => /^op-scribe\.recording\/v\d+$/.test(value),
    policy: (value) => /^commercial-strict\/\d+$/.test(value),
    coverage: words(['commercial', 'standard', 'mixed', 'none']),
    generator: words(['template', 'on-device-ai', 'manual', 'none']),
    type: words(Object.keys(STEP_RULES)),
    env: words(['commercial', 'standard']),
    source: words(['user', 'agent', 'unknown']),
    treatment: words(['kept', 'length', 'redacted']),
    field: words(['secret', 'pii', 'choice', 'search', 'text', 'file', 'arg']),
    // A typed value's kind, and a note's kind (#32).
    kind: words(Object.values(TYPED_SCHEMA.length).flat(), Object.values(TYPED_SCHEMA.redacted).flat(), ['bug', 'question', 'idea', 'next']),
    level: words(['status', 'alert']),
    redacted: words(RUN_KINDS.text, RUN_KINDS.url),
    key: (value) => /^(?:ctrl\+)?(?:meta\+)?(?:alt\+)?Enter$|^Escape$/.test(value),
    role: words([...ARIA_ROLES]),
    // What the extension makes itself: the recording's id and its times (review of #34 R7).
    id: (value) => /^rec-[a-z0-9-]{1,40}$/.test(value),
    startedAt: (value) => ISO_TIME.test(value),
    endedAt: (value) => ISO_TIME.test(value),
    sentAt: (value) => ISO_TIME.test(value),
    // ADR 0005: an expectation's id, the tester's verdict and the recording's trimmed mark.
    ref: (value) => /^E-[0-9a-z]{6}$/.test(value),
    verdict: words(['ok', 'ng']),
    trimmed: words(['user', 'other'])
  });
  const isVocab = (key, value) => Object.hasOwn(VOCAB, key) && typeof value === 'string' && VOCAB[key](value);

  const api = {
    LIMITS, TOTALS, cut, HIDDEN_CHARS, STEP_RULES, REDACTION_KINDS, TYPED_SCHEMA, typedAllowed, primaryRole,
    RUN_KINDS, URL_MARKERS, SCHEME, renderRuns, isVocab
  };
  root.OpScribeLimits = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
