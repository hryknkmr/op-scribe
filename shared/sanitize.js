/**
 * op-scribe - privacy filter shared by every context.
 *
 * Classic script on purpose: content scripts cannot be ES modules, the
 * service worker loads it with importScripts, the side panel with a plain
 * <script>, and the node tests with require().
 *
 * Contract: everything that is persisted or sent has been through here, and
 * when a value cannot be shown to be harmless it is replaced, never kept.
 *
 * Form values and WebMCP arguments come out as typed values
 * ({ treatment, field, kind, ... }, see docs/adr/0003), and every text that is
 * kept comes out as runs: strings and { redacted: kind } parts (#28). Nothing
 * here writes a placeholder into a text; only renderRuns (shared/limits.js)
 * and shared/describe.js do, when rendering. A "[[" written by the page is
 * broken up before masking, so a rendering's [[…]] are always ours.
 */
(function (root) {
  'use strict';

  const { LIMITS, cut, primaryRole, HIDDEN_CHARS, RUN_KINDS, URL_MARKERS, renderRuns, isVocab } = root.OpScribeLimits || require('./limits.js');
  // Zero-width and bidi controls: removed before any rule looks, in text and in field names alike.
  const INVISIBLE = new RegExp(HIDDEN_CHARS, 'gu');
  const redaction = (kind) => ({ redacted: kind });

  /** The redaction kind of each masked part of runs, as privacy.redactions counts it (row M1). */
  const runKinds = (runs) => (Array.isArray(runs) ? runs : []).filter((p) => p && typeof p === 'object')
    .map((p) => (p.redacted === 'masked' ? 'keyword' : p.redacted));

  const DEFAULT_SETTINGS = Object.freeze({
    // Real production hosts. Steps there keep only the length of free text (ADR 0001).
    commercialHosts: [],
    // Hosts that may appear as-is. Every other host becomes site-N.invalid.
    hostAllowlist: [],
    // Words that must never leave the browser (company, product, people).
    keywords: [],
    endpoint: '',
    authHeader: ''
  });

  const defaults = () => ({ ...DEFAULT_SETTINGS, commercialHosts: [], hostAllowlist: [], keywords: [] });

  function luhn(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  // Order matters: specific shapes first, the generic long-number rule last.
  const RULES = [
    { kind: 'secret', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
    { kind: 'secret', re: /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g },
    { kind: 'secret', re: /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})/g },
    { kind: 'secret', re: /\bBearer\s+[\w.~+/-]{10,}=*/gi },
    {
      kind: 'secret',
      re: /\b(token|api[_-]?key|secret|password|passwd|pwd)(\s*[:=]\s*)[^\s"'&]{4,}/gi,
      keep: (match, word, sep) => `${word}${sep}`
    },
    // The dot in the domain is optional: alice@localhost is an address too. So is a quoted local part.
    // Every ASCII character a local part may hold (RFC 5322 atext), so none is left as a piece.
    { kind: 'email', re: /(?:"(?:[^"\\\r\n]|\\.){1,64}"|[\w.!#$%&'*+/=?^`{|}~-]+)@(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)/g },
    { kind: 'card', re: /(?<!\d)\d(?:[ .-]?\d){12,18}(?!\d)/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
    { kind: 'phone', re: /(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g },
    { kind: 'phone', re: /\+\d{1,3}[- ]?\d{1,4}[- ]?\d{2,4}[- ]?\d{3,4}(?!\d)/g },
    // North American numbers: 212-555-0123, (212) 555-0123 (review R41).
    { kind: 'phone', re: /(?<![\d-])\d{3}-\d{3}-\d{4}(?![\d-])|\(\d{3}\) ?\d{3}-\d{4}(?![\d-])/g },
    { kind: 'phone', re: /(?<!\d)0\d{9,10}(?!\d)/g },
    { kind: 'postal', re: /〒\s*\d{3}-?\d{4}|(?<![\d-])\d{3}-\d{4}(?![\d-])/g },
    { kind: 'id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
    { kind: 'ip', re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g },
    { kind: 'id', re: /\b[0-9a-f]{24,}\b/gi },
    // Long opaque tokens (session ids, signed parameters): letters and digits mixed.
    { kind: 'id', re: /(?<![\w-])(?=[\w-]{32,}(?![\w-]))(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]+/g },
    { kind: 'number', re: /(?<!\d)\d{7,}(?!\d)/g }
  ];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** A keyword as the text it is matched against: NFKC and without hidden characters (K2; review R35). */
  const keywordForm = (raw) => String(raw).normalize('NFKC').replace(INVISIBLE, '').trim();

  /**
   * Whether a keyword is used (row K2): two characters or more. No placeholder
   * is ever in a text the scan reads as written (#28), so a keyword such as
   * "mail" is used like any other.
   */
  const usableKeyword = (raw) => [...keywordForm(raw)].length >= 2;

  function keywordPattern(keywords) {
    const list = (keywords || [])
      .map(keywordForm)
      .filter(usableKeyword)
      .sort((a, b) => b.length - a.length);
    // u: case is folded for every character, outside the BMP too ("𐐀" and "𐐨"; review R33).
    return list.length ? new RegExp(list.map(escapeRe).join('|'), 'giu') : null;
  }

  /** Runs with adjacent strings joined and empty strings dropped: the one form runs are kept in. */
  function joinRuns(parts) {
    const out = [];
    for (const p of parts) {
      if (typeof p === 'string') {
        if (!p) continue;
        if (typeof out[out.length - 1] === 'string') out[out.length - 1] += p;
        else out.push(p);
      } else {
        out.push(p);
      }
    }
    return out;
  }

  /** Each string of runs through fn(string) → parts; masked parts are left as they are. */
  const splitRuns = (runs, fn) => joinRuns(runs.flatMap((p) => (typeof p === 'string' ? fn(p) : [p])));

  /**
   * Runs cut to max rendered characters (code points), with "…" appended:
   * never inside a surrogate pair, and a masked part that does not fit whole is
   * left out rather than rendered half.
   */
  function cutRuns(runs, max) {
    if (!max || [...renderRuns(runs)].length <= max) return runs;
    const out = [];
    let room = max;
    for (const p of runs) {
      if (typeof p === 'string') {
        const chars = [...p];
        out.push(chars.slice(0, room).join(''));
        room -= Math.min(room, chars.length);
      } else {
        const n = [...renderRuns([p])].length;
        if (n > room) room = 0;
        else { out.push(p); room -= n; }
      }
      if (!room) break;
    }
    return joinRuns([...out, '…']);
  }

  /**
   * Masks personal and confidential fragments in free text, as runs.
   * Masking runs before truncation so a cut can never expose half an address.
   * A "[[" from the source is broken up, so a rendering never shows one the page wrote (K1).
   */
  function scrubText(input, opts = {}) {
    const kinds = [];
    if (input == null) return { runs: [], kinds };
    let text = String(input).normalize('NFKC');
    // Zero-width and bidi controls can hide content from the human reviewer.
    text = text.replace(INVISIBLE, '');
    // After the invisible characters are gone, so a zero-width space between two "[" cannot slip through.
    text = text.replace(/\[(?=\[)/g, '[ ');

    // The patterns first, on the text as written: a keyword masked first would break the
    // context they need ("token=abcd", "user@example.com" with "example" listed; review R30).
    let runs = [text];
    for (const rule of RULES) {
      runs = splitRuns(runs, (part) => {
        const out = [];
        let last = 0;
        for (const m of part.matchAll(rule.re)) {
          if (rule.accept && !rule.accept(m[0])) continue;
          kinds.push(rule.kind);
          // A rule may keep the words before the value ("token=" in "token=abcd").
          out.push(part.slice(last, m.index), rule.keep ? rule.keep(...m) : '', redaction(rule.kind));
          last = m.index + m[0].length;
        }
        out.push(part.slice(last));
        return out;
      });
    }

    // Keywords in what the patterns left (the strings), never across a masked part.
    const keywords = keywordPattern(opts.keywords);
    if (keywords) {
      runs = splitRuns(runs, (part) => part.split(keywords).flatMap((piece, i) => {
        if (i === 0) return [piece];
        kinds.push('keyword');
        return [redaction('masked'), piece];
      }));
    }
    return { runs: cutRuns(runs, opts.maxLength), kinds };
  }

  /**
   * Runs from elsewhere (the content script) checked and masked again: each
   * string is scrubbed, each masked part kept if it is one of kinds. Null when
   * runs is not runs at all. found collects the kinds masked here.
   */
  function scrubRuns(runs, opts = {}, found = []) {
    if (!Array.isArray(runs)) return null;
    const allowed = opts.kinds || RUN_KINDS.text;
    const parts = [];
    for (const p of runs) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p === 'object' && Object.keys(p).length === 1 && allowed.includes(p.redacted)) parts.push(redaction(p.redacted));
      else return null;
    }
    const out = splitRuns(joinRuns(parts), (part) => {
      const r = scrubText(part, { keywords: opts.keywords });
      found.push(...r.kinds);
      return r.runs;
    });
    return cutRuns(out, opts.maxLength);
  }

  /** One line: a line break from the page could otherwise forge a Gherkin step or a Markdown heading (#18). */
  const oneLine = (text) => String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');

  /**
   * The one way a free text becomes a text field of the output - a name, a
   * tool name, a note, the environment: one line, masked, then cut (rows K2,
   * T1, T2, W6, M3). Never cut a raw text before this: a keyword or an
   * address across the limit would be left as a piece no rule finds.
   */
  const cleanLine = (value, opts = {}) => scrubText(oneLine(value), opts);

  // ------------------------------------------------------------------ fields

  const SECRET_AUTOCOMPLETE = /\b(?:cc-[a-z-]+|one-time-code|current-password|new-password)\b/;
  const PII_AUTOCOMPLETE = /\b(?:email|tel[a-z-]*|name|given-name|family-name|additional-name|honorific-[a-z]+|nickname|username|street-address|address-line\d|address-level\d|postal-code|bday[a-z-]*|sex|organization|organization-title)\b/;
  const SECRET_HINT = /pass|pwd|secret|token|otp|pin(?![a-z])|cvc|cvv|security.?code|暗証|パスワード|認証コード|確認コード|ワンタイム/i;
  const PII_HINT = /mail|phone|tel|mobile|fax|name|kana|furigana|address|addr|street|city|zip|postal|birth|bday|gender|card|account|iban|ssn|my.?number|氏名|名前|姓|フリガナ|ふりがな|住所|郵便|電話|携帯|メール|生年月日|誕生日|口座|カード|性別|勤務先|会社名|マイナンバー/i;

  function piiLabel(hints, type) {
    if (type === 'email' || /mail|メール/i.test(hints)) return 'email';
    if (type === 'tel' || /phone|tel|mobile|fax|電話|携帯/i.test(hints)) return 'phone';
    return 'personal';
  }

  /**
   * Decides how a form control's value may be recorded (ADR 0003, rows I1-I8).
   * kind: ignore | secret | pii | choice | search | free
   */
  function classifyField(meta = {}) {
    const type = String(meta.type || '').toLowerCase();
    const autocomplete = String(meta.autocomplete || '').toLowerCase();
    // Normalized like any text first: "pa\u200Bssword" is a password field (review R24).
    const hints = [meta.name, meta.id, meta.label, meta.labelText, meta.placeholder, meta.ariaLabel]
      .filter(Boolean).join(' ').normalize('NFKC').replace(INVISIBLE, '');

    if (type === 'hidden') return { kind: 'ignore' };
    if (type === 'password' || SECRET_AUTOCOMPLETE.test(autocomplete) || SECRET_HINT.test(hints)) {
      return { kind: 'secret', label: 'secret' };
    }
    if (/card|カード/i.test(hints)) return { kind: 'secret', label: 'card' };
    if (type === 'email' || type === 'tel' || PII_AUTOCOMPLETE.test(autocomplete) || PII_HINT.test(hints)) {
      return { kind: 'pii', label: piiLabel(hints, type) };
    }
    if (['select', 'checkbox', 'radio', 'range', 'color'].includes(type) || meta.tag === 'select') {
      return { kind: 'choice' };
    }
    // Markup only: a field that merely looks like a search box is free text.
    // role is a list of tokens; the element takes the first real role in it.
    const role = primaryRole(meta.role);
    if (type === 'search' || role === 'searchbox' || meta.inSearch) return { kind: 'search' };
    return { kind: 'free' };
  }

  const KEPT_LIMIT = LIMITS.kept;
  const FIELD_OF = { secret: 'secret', pii: 'pii', choice: 'choice', search: 'search', free: 'text' };

  /**
   * The treatment of a form control's value, by its classification and the
   * environment (rows I2-I8). The content script masks by it and the worker
   * checks what arrives against it, so the two cannot disagree (review R22).
   */
  const FIELD_TREATMENT = Object.freeze({
    secret: Object.freeze({ commercial: 'redacted', standard: 'redacted' }),
    pii: Object.freeze({ commercial: 'length', standard: 'redacted' }),
    free: Object.freeze({ commercial: 'length', standard: 'kept' }),
    choice: Object.freeze({ commercial: 'kept', standard: 'kept' }),
    search: Object.freeze({ commercial: 'kept', standard: 'kept' })
  });
  const fieldTreatment = (cls, env) => FIELD_TREATMENT[cls.kind]?.[env === 'commercial' ? 'commercial' : 'standard'];
  const lengthOf = (text) => [...text].length;

  /** Typed values (ADR 0003). A kept text is runs; rendered as placeholders only by shared/describe.js. */
  const typed = {
    kept: (field, runs) => ({ treatment: 'kept', field, text: runs }),
    keptNumber: (number) => ({ treatment: 'kept', field: 'arg', number }),
    length: (field, kind, text) => ({ treatment: 'length', field, kind, length: Math.min(lengthOf(text), LIMITS.typedLength) }),
    redacted: (field, kind) => ({ treatment: 'redacted', field, kind }),
    file: (count) => ({ treatment: 'redacted', field: 'file', kind: 'file', count: Math.min(count, LIMITS.fileCount) })
  };

  /**
   * The value of a form control as it may be stored. Runs inside the page so
   * typed text that must not be kept never reaches the extension at all.
   * opts.env is 'commercial' or 'standard' (ADR 0001).
   * Returns { value: typed value, kinds } or null when the field is not recorded.
   */
  function maskFieldValue(raw, meta, opts = {}) {
    const cls = classifyField(meta);
    if (cls.kind === 'ignore') return null;
    const field = FIELD_OF[cls.kind];
    const text = raw == null ? '' : String(raw);
    const kind = cls.label || 'text';
    const kinds = text ? [kind] : [];
    // Secret fields are redacted even when empty (rows I2, I3); personal fields keep the
    // length in commercial (0 when cleared) and are redacted in standard (I4); commercial
    // free text is a length even when cleared (I8).
    const treatment = fieldTreatment(cls, opts.env);
    if (treatment === 'redacted') return { value: typed.redacted(field, kind), kinds };
    if (treatment === 'length') return { value: typed.length(field, kind, text), kinds };
    if (!text) return { value: typed.kept(field, []), kinds: [] };
    const r = scrubText(text, { keywords: opts.keywords, maxLength: KEPT_LIMIT[field] });
    return { value: typed.kept(field, r.runs), kinds: r.kinds };
  }

  /**
   * The one walk over WebMCP arguments, shared by the content script (maskArgs)
   * and the worker (shared/record.js), so both apply the same limits and the
   * same key rule (ADR 0003, rows W1 and W5). Under a key that names a
   * credential or personal data, the whole subtree becomes one redacted
   * value: nothing below it is looked at, so depth cannot hide a value.
   *   isLeaf(node) - true for what leaf() handles
   *   leaf(node)   - the value to keep for a leaf
   */
  const DROP = Symbol('dropped');

  function walkArgs(node, handlers, depth = 0, budget = { leaves: LIMITS.argLeaves }) {
    const { isLeaf, leaf, keywords } = handlers;
    // At most argLeaves values in one call's arguments; the rest are dropped (W5).
    const spend = () => (budget.leaves -= 1) >= 0;
    if (isLeaf(node)) return spend() ? leaf(node) : DROP;
    if (depth >= LIMITS.argDepth) return spend() ? typed.redacted('arg', 'nested') : DROP;
    // An object or array below the root is a value too, empty or not: counted, so nesting
    // cannot hold thousands of keys past the argLeaves the totals are built on (W5; review R38).
    if (depth > 0 && !spend()) return DROP;
    const walk = (child) => walkArgs(child, handlers, depth + 1, budget);
    if (Array.isArray(node)) return node.slice(0, LIMITS.argItems).map(walk).filter((v) => v !== DROP);
    const out = {};
    let masked = 0;
    // Masked keys are numbered, and a name already taken (after the cut or
    // NFKC) gets -2, -3 ..., so no value overwrites another (W5). The suffix
    // replaces the end of the name, so the name stays within its limit.
    const unique = (base) => {
      let name = base;
      for (let n = 2; Object.hasOwn(out, name); n += 1) name = `${[...base].slice(0, cut(LIMITS.argKey) - `-${n}`.length).join('')}-${n}`;
      return name;
    };
    for (const [k, v] of Object.entries(node).slice(0, LIMITS.argKeys)) {
      // A key is rendered like a name: one line, masked, then cut (cleanLine; E7, review R27).
      const name = cleanLine(k, { keywords, maxLength: LIMITS.argKey });
      const cls = classifyField({ name: k });
      // A key of the masked form from the page is masked too, so every masked-N is ours (#28).
      const masks = name.kinds.length || /^masked-\d/i.test(renderRuns(name.runs));
      const value = cls.kind === 'secret' || cls.kind === 'pii' ? (spend() ? typed.redacted('arg', cls.label) : DROP) : walk(v);
      if (value === DROP) continue;
      // defineProperty, not assignment: a key named "__proto__" stays an ordinary key.
      Object.defineProperty(out, unique(masks ? `masked-${masked += 1}` : renderRuns(name.runs)), {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return out;
  }

  /**
   * Masks WebMCP tool arguments in the page (rows W1-W5). Every string and
   * number becomes a typed value; booleans and null stay as they are. A
   * page-made object never looks typed, because its leaves are typed values.
   */
  function maskArgs(value, opts = {}) {
    const commercial = opts.env === 'commercial';
    return walkArgs(value, {
      keywords: opts.keywords,
      isLeaf: (node) => node === null || typeof node !== 'object',
      leaf: (node) => {
        // null and booleans as they are; undefined, a BigInt or anything else that is not
        // text or a number is redacted below, never turned into null (W4; review R24).
        if (node === null || typeof node === 'boolean') return node;
        if (typeof node === 'number') {
          return !commercial && Number.isFinite(node) && Math.abs(node) < LIMITS.keptNumber
            ? typed.keptNumber(node)
            : typed.redacted('arg', 'number');
        }
        if (typeof node !== 'string') return typed.redacted('arg', 'value');
        if (commercial) return typed.length('arg', 'text', node);
        return typed.kept('arg', scrubText(node, { keywords: opts.keywords, maxLength: KEPT_LIMIT.arg }).runs);
      }
    });
  }

  // -------------------------------------------------------------------- URLs

  /**
   * A host as the URL parser writes it (lowercase, IDN as Punycode), so a
   * listed "例え.invalid" matches the "xn--r8jz45g.invalid" a URL yields.
   */
  function parsedHost(host) {
    const h = String(host).trim().toLowerCase();
    let parsed = h;
    try { parsed = new URL(`http://${h}/`).hostname; } catch { /* keep as written */ }
    // "shop.example.com." is the same host as "shop.example.com".
    return parsed.replace(/\.+$/, '');
  }

  function hostAllowed(host, list) {
    return (list || []).some((raw) => {
      const entry = String(raw).trim().toLowerCase();
      if (!entry) return false;
      const p = entry.startsWith('*.') ? `*.${parsedHost(entry.slice(2))}` : parsedHost(entry);
      if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
      return host === p;
    });
  }

  function aliasFor(origin, aliases) {
    if (aliases[origin]) return aliases[origin];
    // Past the limit a new host gets no alias: the caller redacts its URL whole and the step on it
    // is not recorded, so no host the final scan cannot know is ever in the recording (K5; review R42).
    if (Object.keys(aliases).length >= LIMITS.aliases) return null;
    const taken = new Set(Object.values(aliases));
    let n = Object.keys(aliases).length + 1;
    while (taken.has(`site-${n}.invalid`)) n += 1;
    aliases[origin] = `site-${n}.invalid`;
    return aliases[origin];
  }

  const ID_SEGMENT = /^(?:\d{3,}|[0-9a-f]{12,}|[0-9a-f-]{32,36}|(?=.*\d)(?=.*[a-z])[a-z0-9_-]{16,})$/i;
  const SENSITIVE_PARAM = /token|code|key|secret|sig|session|auth|pass|mail|phone|tel|name|user|state|nonce|ticket|^id$|_id$|Id$/i;

  /**
   * ADR 0003, rows U1-U8. ctx.env is the environment of the step that holds
   * the URL; the URL is also commercial when its own host is listed in
   * ctx.commercialHosts. Until the commercial URL rule lands (row U5, ③), a
   * commercial URL drops every query value and the fragment.
   *
   * ctx.aliases is mutated: it maps each real origin to its stable alias for
   * this recording, and lives only in the browser (never in the payload).
   */
  function scrubUrl(raw, ctx = {}) {
    const kinds = [];
    const aliases = ctx.aliases || {};
    const whole = (as) => [{ redacted: 'url', as }];
    let url;
    try {
      url = new URL(String(raw));
    } catch {
      return { url: whole('invalid'), kinds: ['url'] };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      // none, long and invalid name our own markers (no URL, too long, unparsable): a
      // scheme of that name would read as one of them, so it is just invalid (U2; review R30).
      const scheme = url.protocol.replace(':', '').slice(0, LIMITS.scheme);
      return { url: whole(URL_MARKERS.includes(scheme) ? 'invalid' : scheme), kinds: ['url'] };
    }

    const host = parsedHost(url.hostname);
    const commercial = ctx.env === 'commercial' || ctx.allCommercial === true || hostAllowed(host, ctx.commercialHosts);
    let origin;
    // The origin of the normalized host, so "example.com." and "example.com" are one site (U4; review R24).
    const port = url.port ? `:${url.port}` : '';
    // A host of the alias form would read as the alias of another site: not recorded, like a host past
    // the alias limit (U4, K5). It never resolves, so no real page is lost.
    if (ALIAS.test(host)) return { url: whole('invalid'), kinds: ['url', 'host'], untracked: true };
    if (hostAllowed(host, ctx.hostAllowlist)) {
      origin = `${url.protocol}//${host}${port}`;
    } else {
      const alias = aliasFor(`${url.protocol}//${host}${port}`, aliases);
      if (!alias) return { url: whole('invalid'), kinds: ['url', 'host'], untracked: true };
      origin = `${url.protocol}//${alias}`;
      kinds.push('host');
    }

    // A masked path segment, query key or query value is a part of its own (#28), never a word in the URL.
    const parts = [origin];
    url.pathname.split('/').forEach((seg, i) => {
      if (i > 0) parts.push('/');
      if (!seg) return;
      let decoded = seg;
      // Every escape that makes a character, even after one that does not ("%FF%41cme"; review of #34 R6).
      decoded = percentDecode(seg);
      if (decoded.startsWith('@')) { kinds.push('user'); parts.push(redaction('user')); return; }
      if (ID_SEGMENT.test(decoded)) { kinds.push('id'); parts.push(redaction('id')); return; }
      const r = scrubText(decoded, { keywords: ctx.keywords });
      if (r.kinds.length) { kinds.push(...r.kinds); parts.push(redaction('masked')); return; }
      // The parser leaves [ and ] as they are; encoded, a page's "[[secret]]" never reads as ours (K1).
      parts.push(seg.replace(/\[/g, '%5B').replace(/\]/g, '%5D'));
    });

    let first = true;
    for (const [k, v] of url.searchParams) {
      parts.push(first ? '?' : '&');
      first = false;
      parts.push(scrubText(k, { keywords: ctx.keywords }).kinds.length ? redaction('masked') : encodeURIComponent(k), '=');
      if (v) {
        const harmless = !commercial
          && !SENSITIVE_PARAM.test(k)
          // The same vocabulary as form fields (rows I3, I4, U7): address, card, postal ...
          && !['secret', 'pii'].includes(classifyField({ name: k }).kind)
          && /^[\w.-]{1,24}$/.test(v)
          && !scrubText(v, { keywords: ctx.keywords }).kinds.length;
        parts.push(harmless ? encodeURIComponent(v) : redaction('v'));
        if (!harmless) kinds.push('query');
      }
    }

    // SPA routes such as #/settings are kept outside production; anything else is dropped.
    if (url.hash && !commercial && /^#\/[\w/-]{0,60}$/.test(url.hash)) {
      parts.push(url.hash);
    } else if (url.hash) {
      kinds.push('hash');
    }

    const runs = joinRuns(parts);
    // A URL too long to send is redacted as a whole rather than cut (row U1).
    // origin: the site as the recording names it (real or alias), also when the URL is redacted whole for its length.
    if ([...renderRuns(runs)].length > LIMITS.url) return { url: whole('long'), kinds: [...kinds, 'url'], origin };
    return { url: runs, kinds, origin };
  }

  // -------------------------------------------------------------- final gate

  /**
   * Walks every string in an object and reports anything the filters would
   * still mask. Run on the exact payload right before it leaves the browser;
   * a non-empty result blocks sending.
   */
  /**
   * Real host names (row K5), apart from keywords: any length, matched only
   * as a whole host label sequence, so a one-letter host "x" is found but the
   * x in "box" is not.
   */
  function hostPattern(hosts) {
    const list = (hosts || []).map((h) => String(h).normalize('NFKC').trim().toLowerCase().replace(/\.+$/, ''))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    return list.length ? new RegExp(`(?<![\\p{L}\\p{N}.-])(?:${list.map(escapeRe).join('|')})(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, 'iu') : null;
  }

  /**
   * A CSS-escaped text as written (CSS Syntax 4.3.7): the selector escapes
   * "intranet.corp.invalid" as "intranet\\.corp\\.invalid", which no keyword,
   * host or pattern would otherwise match (T3, K2, K5; review R23).
   */
  const cssUnescape = (text) => String(text).replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n]?|([^\n0-9a-fA-F]))/g, (m, hex, ch) => {
    if (ch !== undefined) return ch;
    const code = parseInt(hex, 16);
    return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(code);
  });

  /**
   * A text with its percent-escapes undone where they make UTF-8: a URL path keeps "%41cme" as
   * the page wrote it, and a keyword added after the recording must still find it (K2, E6;
   * review of #34 R5).
   */
  // A byte that is not UTF-8 becomes U+FFFD and the bytes after it are still read.
  const UTF8 = new TextDecoder();
  function percentDecode(text) {
    return String(text).replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => UTF8.decode(Uint8Array.from(m.match(/%(..)/g), (h) => parseInt(h.slice(1), 16))));
  }

  // scheme://host[:port], never with user info: "https://user:pass@host" stays in the patterns.
  const URL_HOST = /(https?:\/\/)([^\/\s"'<>|?#\\@]+)(?=[\/\s"'<>|?#\\]|$)/gi;

  // The Gherkin is not scanned as a text (E3, E6; #28): it is rebuilt from the recording at every
  // exit and by the receiver, checkPayload refuses one that is not, and the recording it is built
  // from is scanned instead. As a text it holds the format's words (url, value, textbox ...) and
  // the placeholders, which a keyword such as "url" or "mail" would hit every time. A WebMCP reply
  // scans the steps its Gherkin was built from (guardReply). The Markdown a person edits is scanned
  // as written (E4).
  const RENDERED = new Set(['reproduction.gherkin', 'reply.gherkin', 'gherkin']);
  // The host of an http(s) URL in the alias form ("site-3.invalid"): a keyword such as "site" or
  // "invalid" is not looked for in it (E6). Only there: the same form anywhere else is scanned.
  const ALIAS = /^site-\d+\.invalid$/;

  function finalScan(value, opts = {}) {
    const findings = [];
    const hosts = hostPattern(opts.hosts);
    const keywords = keywordPattern(opts.keywords);
    const check = (text, path) => {
      if (RENDERED.has(path)) return;
      const plain = String(text);
      // As written, with CSS escapes undone (a selector carries them; review R23) and with
      // percent-escapes undone (a URL carries them).
      const kinds = [plain, cssUnescape(plain), percentDecode(plain)].flatMap((t) => {
        // The host of a URL is left out of the patterns (K3) only: it is an alias or a host the
        // user allowed by name, an IP host too (U4; review R32). Keywords and real hosts still apply.
        const urlHosts = [];
        const body = t.replace(URL_HOST, (m, scheme, host) => {
          urlHosts.push(host.normalize('NFKC'));
          return `${scheme} `;
        });
        return [...scrubText(body, { keywords: opts.keywords }).kinds,
          // Only the alias's host name is left out; a port after it is scanned like any text (reviews of #34 R2, R9).
          ...(keywords && urlHosts.some((h) => {
            const name = h.replace(/:\d*$/, '');
            return (ALIAS.test(name.toLowerCase()) ? h.slice(name.length) : h).match(keywords);
          }) ? ['keyword'] : []),
          ...(hosts?.test(t.normalize('NFKC')) ? ['host'] : [])];
      });
      if (kinds.length) findings.push({ path: path || '(root)', kinds: [...new Set(kinds)] });
    };
    const walk = (v, path, inArgs = false) => {
      if (typeof v === 'string') return check(v, path);
      if (Array.isArray(v)) {
        // Each item on its own, as any array of texts; and for runs, the strings next to each
        // other as one text too, so a keyword split over two strings is still found. A masked
        // part is a gap; its scheme is scanned as a text of its own (review of #34).
        let joined = [];
        const flush = (i) => {
          if (joined.length > 1) check(joined.join(''), `${path}[${i}]`);
          joined = [];
        };
        v.forEach((item, i) => {
          walk(item, `${path}[${i}]`, inArgs);
          if (typeof item === 'string') joined.push(item);
          else flush(i - 1);
        });
        flush(v.length - 1);
        return undefined;
      }
      if (v && typeof v === 'object') {
        const typedLeaf = typeof v.treatment === 'string' || typeof v.redacted === 'string';
        for (const [k, item] of Object.entries(v)) {
          // Keys are the format's own names, but under args, where the page named them (W1).
          if (inArgs && !typedLeaf && !/^masked-\d+(?:-\d+)?$/.test(k)) check(k, `${path}{key}`);
          // The format's own words are not page text (K2, #28); a URL marker neither.
          if (isVocab(k, item) || (k === 'as' && URL_MARKERS.includes(item))) continue;
          walk(item, path ? `${path}.${k}` : k, (inArgs || k === 'args') && !typedLeaf);
        }
      }
      return undefined;
    };
    walk(value, '');
    return findings;
  }

  const api = {
    DEFAULT_SETTINGS,
    defaults,
    scrubText,
    scrubRuns,
    cutRuns,
    joinRuns,
    renderRuns,
    runKinds,
    oneLine,
    cleanLine,
    usableKeyword,
    typed,
    classifyField,
    fieldTreatment,
    walkArgs,
    maskFieldValue,
    maskArgs,
    scrubUrl,
    hostAllowed,
    parsedHost,
    finalScan,
    cssUnescape
  };

  root.OpScribeSanitize = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
