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
  const { LIMITS, STEP_RULES, REDACTION_KINDS, typedAllowed, renderRuns } = root.OpScribeLimits || require('./limits.js');
  const { scrubText, scrubRuns, runKinds, cleanLine, oneLine, scrubUrl, hostAllowed, parsedHost, typed, classifyField, fieldTreatment, walkArgs } = S;

  const NOTE_KINDS = new Set(['bug', 'question', 'idea', 'next']);
  const STEP_TYPES = new Set(['navigate', 'click', 'input', 'select', 'check', 'upload', 'key', 'submit', 'tool', 'note']);
  const FIELDS = new Set(['secret', 'pii', 'choice', 'search', 'text', 'file', 'arg']);
  const KEPT_LIMIT = LIMITS.kept;
  // ADR 0003 rows T4 and T5.
  const TOKEN = /^[a-z][a-z0-9-]{0,23}$/;
  const KEY = /^(?:ctrl\+)?(?:meta\+)?(?:alt\+)?Enter$|^Escape$/;
  // RegExp#test(undefined) tests the string "undefined".
  const is = (re, value) => typeof value === 'string' && re.test(value);

  /**
   * The recording's fixed host lists, taken from the settings when it started.
   * A name longer than a host can be (253) is no host and is left out; the panel
   * saves at most LIMITS.hosts names a list, so the recording stays bounded (review R41).
   */
  function policyOf(settings) {
    const list = (names) => [...new Set((names || []).map(String))].filter((h) => [...h].length <= LIMITS.host);
    const commercial = list(settings.commercialHosts);
    return {
      commercialHosts: commercial.slice(0, LIMITS.hosts),
      // More production hosts than a recording holds (settings saved by an older version):
      // every step is commercial, the strict side, rather than some production host left out (review R42).
      allCommercial: commercial.length > LIMITS.hosts,
      // Fewer allowed names only alias more hosts: cutting this list is the strict side.
      hostAllowlist: list(settings.hostAllowlist).slice(0, LIMITS.hosts)
    };
  }

  const hostOf = (url) => {
    try { return parsedHost(new URL(url).hostname); } catch { return ''; }
  };

  /** 'commercial' when any of the URLs (top page, frame) is on a listed production host. */
  function envOf(urls, policy) {
    if (policy.allCommercial) return 'commercial';
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
        if (f === 'secret' || f === 'pii' || f === 'file') return fail(f);
        // Runs (#28): each string masked again, each masked part kept if it is one the masking makes.
        const found = [];
        const runs = scrubRuns(value.text, { keywords: settings.keywords, maxLength: KEPT_LIMIT[f] }, found);
        if (!runs) return fail(f);
        if (!runs.length && env === 'commercial' && (f === 'text' || f === 'arg')) return typed.length(f, 'text', '');
        if (!runs.length) return typed.kept(f, []);
        if (env === 'commercial' && (f === 'text' || f === 'arg')) return fail(f);
        // The content script sends no kinds for arguments: count every masked part the text holds,
        // the ones masked there and here alike (M1). Field values come with their kinds (valueKinds).
        kinds.push(...(f === 'arg' ? runKinds(runs) : found));
        return typed.kept(f, runs);
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
  const STRICTNESS = { kept: 0, length: 1, redacted: 2 };
  const META_NAMES = ['tag', 'type', 'name', 'id', 'autocomplete', 'label', 'labelText', 'placeholder', 'ariaLabel', 'role'];

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
    // The treatment the content script gives this field in one environment or the other
    // (fieldTreatment, review R22). It may have judged the environment otherwise: a value
    // looser than this step's environment allows is made strict, never kept looser.
    const expected = fieldTreatment(cls, env);
    if (![fieldTreatment(cls, 'commercial'), fieldTreatment(cls, 'standard')].includes(value.treatment)) return null;
    if (STRICTNESS[value.treatment] < STRICTNESS[expected]) {
      kinds.push(cls.label || 'v');
      return typed.redacted(field, cls.label || 'v');
    }
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
      return r.runs;
    };
    let site;
    const url = (value, page = false) => {
      const r = scrubUrl(value, ctx);
      kinds.push(...r.kinds.filter((k) => k !== 'host'));
      if (page) site = r.origin;
      return r.url;
    };

    // Where a step came from follows from its kind (W7): a navigation is unknown, a tool call and an
    // expectation from the page are agent, everything else - what the content script saw a person do,
    // a note in the side panel - is user. The worker marks the page's expectation (raw.source).
    const source = type === 'navigate' ? 'unknown' : type === 'tool' || (type === 'note' && raw.source === 'agent') ? 'agent' : 'user';
    // The page's expectation belongs to its page (W8): without one it is not recorded.
    if (type === 'note' && source === 'agent' && !raw.pageUrl) return null;
    const step = { type, t: Math.max(0, Date.now() - rec.startedAt), env, source };
    // A note of the person's is written in the side panel and belongs to no page (W7, W8).
    if (raw.pageUrl && !(type === 'note' && source === 'user')) {
      // A page on a host past the alias limit is not recorded (K5; review R42).
      if (scrubUrl(raw.pageUrl, { ...ctx, aliases: { ...rec.aliases } }).untracked) return null;
      step.url = url(raw.pageUrl, true);
    }
    if (raw.target) {
      const t = raw.target;
      step.target = {};
      if (is(TOKEN, t.role)) step.target.role = t.role;
      if (is(TOKEN, t.tag)) step.target.tag = t.tag;
      if (t.name) step.target.name = text(t.name, LIMITS.name);
      // A selector is a locator, not prose: if anything had to be masked, drop it entirely.
      if (t.selector) {
        const r = scrubText(oneLine(t.selector), { keywords: settings.keywords });
        const selector = renderRuns(r.runs);
        // CSS escapes undone, and the real hosts this recording knows, too (T3, K5; review R23).
        const hosts = [...Object.keys(rec.aliases || {}).map(hostOf), ...policy.commercialHosts.map((h) => String(h).replace(/^\*\./, ''))];
        if (S.finalScan(oneLine(t.selector), { keywords: settings.keywords, hosts: hosts.filter(Boolean) }).length) r.kinds.push('selector');
        // Cut like any kept text, with the "…" that says so (T3; review R21).
        const chars = [...selector];
        if (!r.kinds.length) step.target.selector = chars.length > LIMITS.selector ? `${chars.slice(0, LIMITS.selector).join('')}…` : selector;
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
    if (type === 'note') {
      step.note = text(raw.note, LIMITS.note);
      if (NOTE_KINDS.has(raw.kind)) step.kind = raw.kind;
    }
    // Only what this kind of step may carry, and nothing without what it must (row T6).
    const rule = STEP_RULES[type];
    for (const f of Object.keys(step)) {
      if (!['type', 't', 'env', 'source'].includes(f) && !rule.allowed.includes(f)) delete step[f];
    }
    // The site of the page, as the recording names it: WebMCP returns a site its own steps by it (W8, #17).
    // Kept in the browser only; buildPayload copies the fields of SHAPE, which has none for it.
    if (site) step.site = site;
    if (rule.required.some((f) => step[f] === undefined || step[f] === '' || (Array.isArray(step[f]) && !step[f].length))) return null;
    for (const kind of [...kinds, ...(Array.isArray(raw.valueKinds) ? raw.valueKinds : [])]) {
      // Only the kinds the payload may count (row M1), and never past the limit.
      if (REDACTION_KINDS.includes(kind)) rec.redactions[kind] = Math.min((rec.redactions[kind] || 0) + 1, LIMITS.redactionCount);
    }
    return step;
  }

  /**
   * Every answer WebMCP gives the page is an exit (rows W8, E6): the whole
   * object goes through the final scan with the keywords as they are now and
   * the real hosts behind the aliases, and is withheld on a find (review R37).
   * steps: the steps a Gherkin in the reply was built from. The final scan
   * does not read a Gherkin as text, so they are scanned in its place (E3, #28).
   */
  function guardReply(reply, rec, settings, steps = []) {
    const hosts = Object.keys(rec.aliases || {}).map(hostOf).filter(Boolean);
    return S.finalScan({ reply, steps }, { keywords: settings.keywords, hosts }).length ? { ok: false, error: 'BLOCKED_SUSPECTED_LEAK' } : reply;
  }

  // The origin of a URL whose host is an alias. A real host of that form is never recorded (U4), so every match is one.
  const ALIAS_ORIGIN = /^(https?:\/\/)(site-\d+\.invalid)(?=[/?#]|$)/;

  /**
   * An alias numbers a site in the whole recording: site-2 says another site came first.
   * The page gets aliases of its own from site-1, its site first when it is an alias and then
   * in the order its steps name them, so a reply tells nothing of the other sites (W8; review
   * of #37 R12). An allowed host keeps its name (U4).
   * Only hosts are renamed (url, target.href): text is the page's own and stays as it is.
   */
  function localAliases(site, steps) {
    const names = new Map();
    const swap = (u) => {
      const m = ALIAS_ORIGIN.exec(u);
      if (!m) return u;
      if (!names.has(m[2])) names.set(m[2], `site-${names.size + 1}.invalid`);
      return `${m[1]}${names.get(m[2])}${u.slice(m[0].length)}`;
    };
    const runs = (url) => typeof url === 'string' ? swap(url)
      : Array.isArray(url) && typeof url[0] === 'string' ? [swap(url[0]), ...url.slice(1)] : url;
    const here = swap(site);
    return {
      site: here,
      steps: steps.map((s) => {
        const local = { ...s };
        if (s.url !== undefined) local.url = runs(s.url);
        if (s.target?.href !== undefined) local.target = { ...s.target, href: runs(s.target.href) };
        return local;
      }),
    };
  }

  /**
   * What WebMCP tells a page on site about the recording (row W8): the steps on
   * that site, its own notes included (an agent's note carries the URL of the
   * page it came from), and nothing about the rest - no panel note, no count of
   * the whole recording (#17). Null for another op.
   */
  function webmcpReply(rec, settings, recordedSite, op) {
    const D = root.OpScribeDescribe || require('./describe.js');
    const { site, steps: own } = localAliases(recordedSite, rec.steps.filter((s) => s.site === recordedSite));
    if (op === 'status') {
      return guardReply({ ok: true, recording: true, site, stepsOnThisSite: own.length }, rec, settings);
    }
    if (op === 'reproduction') {
      // No recording id: one id handed to every site would tie them together (W8; review of #37 R4).
      const scoped = { ...rec, id: undefined, steps: own, startUrl: own[0]?.url };
      const markdown = D.toMarkdown(D.buildReproduction(scoped));
      const gherkin = D.toGherkin(scoped, { envSteps: rec.steps });
      return guardReply({ ok: true, site, steps: own.length, markdown, gherkin }, rec, settings, own);
    }
    return null;
  }

  const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

  /**
   * Adds a cleaned step. Past the step limit, or past the size the session
   * storage holds, the oldest steps go first, so the newest step is always
   * kept and the recording can always be saved (review R40).
   */
  /** The step that goes first when a recording is past a limit: the oldest the page reported, else the oldest (W7, #17). */
  const reported = (s) => s.source !== 'user';
  const nextToDrop = (rec) => Math.max(rec.steps.findIndex(reported), 0);
  // The steps not from the person on one site: the limit is a site's own, so what one page can add
  // tells it nothing about the other sites (W7, W8; owner decision on #37).
  const reportedOn = (rec, site) => rec.steps.filter((s) => reported(s) && s.site === site);

  function appendStep(rec, step) {
    if (!step) return false;
    // What a site reports is kept up to agentSteps; past it the new one is not recorded (W7, #17).
    if (reported(step) && reportedOn(rec, step.site).length >= LIMITS.agentSteps) return false;
    // At the step limit with only the person's steps, a reported step would go itself: not recorded,
    // and the recording - its revision too - stays as it was (E4; review of #37 R11).
    if (reported(step) && rec.steps.length >= LIMITS.steps && !rec.steps.some(reported)) return false;
    rec.revision = (rec.revision || 0) + 1;
    rec.steps.push(step);
    // Past the step limit the steps the page reported go first, oldest first, whoever added the
    // new one; a reported step with none to give way goes itself. The person's go only after them.
    while (rec.steps.length > LIMITS.steps) rec.steps.splice(nextToDrop(rec), 1);
    fitRecord(rec);
    return rec.steps[rec.steps.length - 1] === step;
  }

  /**
   * Cleans and adds a step in one go. Cleaning names new sites and counts what it
   * redacted; a step that is not recorded - not a step, not kept, or past a limit -
   * leaves both as they were (W7, E4; review of #37 R14).
   * keep: whether to add the cleaned step at all (a navigation to where the tab already is).
   * Returns the step when it is recorded, else null.
   */
  function addStep(rec, raw, settings, from, keep = () => true) {
    const aliases = { ...rec.aliases };
    const redactions = { ...rec.redactions };
    const step = cleanStep(raw, rec, settings, from);
    if (step && keep(step) && appendStep(rec, step)) return step;
    rec.aliases = aliases;
    rec.redactions = redactions;
    return null;
  }

  /**
   * The one way a recording is made to fit its share of the session storage
   * (storeBytes): appendStep runs it, and the worker runs it on every save,
   * whatever changed (review R43).
   */
  function fitRecord(rec) {
    if (!rec?.steps) return;
    // More reported steps on a site than agentSteps (a recording saved before the limit): its oldest go (W7).
    let changed = false;
    for (const site of new Set(rec.steps.filter(reported).map((s) => s.site))) {
      const extra = reportedOn(rec, site).slice(0, -LIMITS.agentSteps);
      if (!extra.length) continue;
      rec.steps = rec.steps.filter((s) => !extra.includes(s));
      changed = true;
    }
    if (changed) rec.revision = (rec.revision || 0) + 1;
    // One full count a step (at most 3 bytes a UTF-16 unit, so most recordings skip even that),
    // then each removed step's own size and its comma.
    const json = JSON.stringify(rec);
    if (json.length * 3 <= LIMITS.storeBytes) return;
    let bytes = new TextEncoder().encode(json).length;
    // The rest of the recording is bounded (hosts, aliases), so dropping steps always gets under;
    // a single step too large for the room is dropped too rather than break the save (review R41).
    // The steps the page reported go first, oldest first, then the person's (W7, #17).
    const before = rec.steps.length;
    while (rec.steps.length && bytes > LIMITS.storeBytes) bytes -= bytesOf(rec.steps.splice(nextToDrop(rec), 1)[0]) + 1;
    // Steps went: a Markdown made from the recording before is stale now (E4; review R44).
    if (rec.steps.length !== before) rec.revision = (rec.revision || 0) + 1;
  }

  const api = { policyOf, envOf, oneLine, cleanStep, appendStep, addStep, fitRecord, guardReply, webmcpReply };
  root.OpScribeRecord = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
