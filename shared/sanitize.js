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
 * ({ treatment, field, kind, ... }, see docs/adr/0003) and only become
 * [[kind]] placeholders when rendered (shared/describe.js). Text that is kept
 * may still contain placeholders from scrubText, and those are always ours:
 * a "[[" written by the page is broken up before masking.
 */
(function (root) {
  'use strict';

  const mark = (kind) => `[[${kind}]]`;
  const PLACEHOLDER = /\[\[[a-z0-9:_-]+\]\]/gi;

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
      replace: (match, word, sep) => `${word}${sep}${mark('secret')}`
    },
    { kind: 'email', re: /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
    { kind: 'card', re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
    { kind: 'phone', re: /(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g },
    { kind: 'phone', re: /\+\d{1,3}[- ]?\d{1,4}[- ]?\d{2,4}[- ]?\d{3,4}(?!\d)/g },
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

  function keywordPattern(keywords) {
    const list = (keywords || [])
      .map((k) => String(k).normalize('NFKC').trim())
      .filter((k) => k.length >= 2)
      .sort((a, b) => b.length - a.length);
    return list.length ? new RegExp(list.map(escapeRe).join('|'), 'gi') : null;
  }

  /**
   * Masks personal and confidential fragments in free text.
   * Masking runs before truncation so a cut can never expose half an address.
   * opts.escape (default true) breaks up "[[" from the source; pass false only
   * for text that already went through here (it holds our own placeholders).
   */
  function scrubText(input, opts = {}) {
    const kinds = [];
    if (input == null) return { text: '', kinds };
    let text = String(input).normalize('NFKC');
    // Zero-width and bidi controls can hide content from the human reviewer.
    text = text.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
    // After the invisible characters are gone, so "[​[" cannot slip through.
    if (opts.escape !== false) text = text.replace(/\[(?=\[)/g, '[ ');

    const keywords = keywordPattern(opts.keywords);
    if (keywords) {
      text = text.replace(keywords, () => {
        kinds.push('keyword');
        return mark('masked');
      });
    }

    for (const rule of RULES) {
      text = text.replace(rule.re, (...args) => {
        const match = args[0];
        if (rule.accept && !rule.accept(match)) return match;
        kinds.push(rule.kind);
        return rule.replace ? rule.replace(...args) : mark(rule.kind);
      });
    }

    if (opts.maxLength && text.length > opts.maxLength) {
      text = `${text.slice(0, opts.maxLength).replace(/\[\[[^\]]*$/, '')}…`;
    }
    return { text, kinds };
  }

  // ------------------------------------------------------------------ fields

  const SECRET_AUTOCOMPLETE = /\b(?:cc-[a-z-]+|one-time-code|current-password|new-password)\b/;
  const PII_AUTOCOMPLETE = /\b(?:email|tel[a-z-]*|name|given-name|family-name|additional-name|honorific-[a-z]+|nickname|username|street-address|address-line\d|address-level\d|postal-code|bday[a-z-]*|sex|organization|organization-title)\b/;
  const SECRET_HINT = /pass|pwd|secret|token|otp|pin\b|cvc|cvv|security.?code|暗証|パスワード|認証コード|確認コード|ワンタイム/i;
  const PII_HINT = /mail|phone|tel|mobile|fax|name|kana|furigana|address|addr|street|city|zip|postal|birth|bday|gender|card|account|iban|ssn|my.?number|氏名|名前|姓|フリガナ|ふりがな|住所|郵便|電話|携帯|メール|生年月日|誕生日|口座|カード|性別|勤務先|会社名|マイナンバー/i;

  function piiLabel(hints, type) {
    if (type === 'email' || /mail|メール/i.test(hints)) return 'email';
    if (type === 'tel' || /phone|tel|mobile|fax|電話|携帯/i.test(hints)) return 'phone';
    if (/card|カード/i.test(hints)) return 'card';
    return 'personal';
  }

  /**
   * Decides how a form control's value may be recorded (ADR 0003, rows I1-I8).
   * kind: ignore | secret | pii | choice | search | free
   */
  function classifyField(meta = {}) {
    const type = String(meta.type || '').toLowerCase();
    const autocomplete = String(meta.autocomplete || '').toLowerCase();
    const hints = [meta.name, meta.id, meta.label, meta.placeholder, meta.ariaLabel]
      .filter(Boolean).join(' ').normalize('NFKC');

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
    if (type === 'search' || meta.role === 'searchbox' || meta.inSearch) return { kind: 'search' };
    return { kind: 'free' };
  }

  const KEPT_LIMIT = { choice: 120, search: 120, text: 200, arg: 200 };
  const FIELD_OF = { secret: 'secret', pii: 'pii', choice: 'choice', search: 'search', free: 'text' };
  const lengthOf = (text) => [...text].length;

  /** Typed values (ADR 0003). Rendered as placeholders only by shared/describe.js. */
  const typed = {
    kept: (field, text) => ({ treatment: 'kept', field, text }),
    keptNumber: (number) => ({ treatment: 'kept', field: 'arg', number }),
    length: (field, kind, text) => ({ treatment: 'length', field, kind, length: lengthOf(text) }),
    redacted: (field, kind) => ({ treatment: 'redacted', field, kind }),
    file: (count) => ({ treatment: 'redacted', field: 'file', kind: 'file', count })
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
    // Secret and personal fields are redacted even when empty: no exception to rows I2-I4.
    if (cls.kind === 'secret') return { value: typed.redacted(field, cls.label), kinds: text ? [cls.label] : [] };
    if (cls.kind === 'pii' && !text) return { value: typed.redacted(field, cls.label), kinds: [] };
    const commercial = opts.env === 'commercial';
    // Commercial free text is a length even when empty (row I8): "cleared" is length 0.
    if (cls.kind === 'free' && commercial) return { value: typed.length(field, 'text', text), kinds: text ? ['text'] : [] };
    if (!text) return { value: typed.kept(field, ''), kinds: [] };
    if (cls.kind === 'pii') {
      return commercial
        ? { value: typed.length(field, cls.label, text), kinds: [cls.label] }
        : { value: typed.redacted(field, cls.label), kinds: [cls.label] };
    }
    if (cls.kind === 'free' && commercial) return { value: typed.length(field, 'text', text), kinds: ['text'] };
    const r = scrubText(text, { keywords: opts.keywords, maxLength: KEPT_LIMIT[field] });
    return { value: typed.kept(field, r.text), kinds: r.kinds };
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
  function walkArgs(node, { isLeaf, leaf, keywords }, depth = 0) {
    if (isLeaf(node)) return leaf(node);
    if (depth >= 3) return typed.redacted('arg', 'nested');
    const walk = (child) => walkArgs(child, { isLeaf, leaf, keywords }, depth + 1);
    if (Array.isArray(node)) return node.slice(0, 10).map(walk);
    const out = {};
    for (const [k, v] of Object.entries(node).slice(0, 20)) {
      const name = scrubText(k, { keywords, maxLength: 40 });
      const cls = classifyField({ name: k });
      out[name.kinds.length ? 'masked' : name.text] = cls.kind === 'secret' || cls.kind === 'pii'
        ? typed.redacted('arg', cls.label)
        : walk(v);
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
        if (node == null || typeof node === 'boolean') return node ?? null;
        if (typeof node === 'number') {
          return !commercial && Number.isFinite(node) && Math.abs(node) < 1e6
            ? typed.keptNumber(node)
            : typed.redacted('arg', 'number');
        }
        if (typeof node !== 'string') return typed.redacted('arg', 'value');
        if (commercial) return typed.length('arg', 'text', node);
        return typed.kept('arg', scrubText(node, { keywords: opts.keywords, maxLength: KEPT_LIMIT.arg }).text);
      }
    });
  }

  // -------------------------------------------------------------------- URLs

  function hostAllowed(host, list) {
    return (list || []).some((raw) => {
      const p = String(raw).trim().toLowerCase();
      if (!p) return false;
      if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(p.slice(1));
      return host === p;
    });
  }

  function aliasFor(origin, aliases) {
    if (!aliases[origin]) aliases[origin] = `site-${Object.keys(aliases).length + 1}.invalid`;
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
    let url;
    try {
      url = new URL(String(raw));
    } catch {
      return { url: mark('url:invalid'), kinds: ['url'] };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { url: mark(`url:${url.protocol.replace(':', '').slice(0, 16)}`), kinds: ['url'] };
    }

    const host = url.hostname.toLowerCase();
    const commercial = ctx.env === 'commercial' || hostAllowed(host, ctx.commercialHosts);
    let origin;
    if (hostAllowed(host, ctx.hostAllowlist)) {
      origin = `${url.protocol}//${url.host}`;
    } else {
      origin = `${url.protocol}//${aliasFor(url.origin, aliases)}`;
      kinds.push('host');
    }

    const path = url.pathname.split('/').map((seg) => {
      if (!seg) return seg;
      let decoded = seg;
      try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
      if (decoded.startsWith('@')) { kinds.push('user'); return ':user'; }
      if (ID_SEGMENT.test(decoded)) { kinds.push('id'); return ':id'; }
      const r = scrubText(decoded, { keywords: ctx.keywords });
      if (r.kinds.length) { kinds.push(...r.kinds); return ':masked'; }
      return seg;
    }).join('/');

    const params = [];
    for (const [k, v] of url.searchParams) {
      const key = scrubText(k, { keywords: ctx.keywords }).kinds.length ? 'masked' : k;
      let value = '';
      if (v) {
        const harmless = !commercial
          && !SENSITIVE_PARAM.test(k)
          && /^[\w.-]{1,24}$/.test(v)
          && !scrubText(v, { keywords: ctx.keywords }).kinds.length;
        value = harmless ? encodeURIComponent(v) : mark('v');
        if (!harmless) kinds.push('query');
      }
      params.push(`${encodeURIComponent(key)}=${value}`);
    }

    // SPA routes such as #/settings are kept outside production; anything else is dropped.
    let hash = '';
    if (url.hash && !commercial && /^#\/[\w/-]{0,60}$/.test(url.hash)) {
      hash = url.hash;
    } else if (url.hash) {
      kinds.push('hash');
    }

    return { url: `${origin}${path}${params.length ? `?${params.join('&')}` : ''}${hash}`, kinds };
  }

  // -------------------------------------------------------------- final gate

  /**
   * Walks every string in an object and reports anything the filters would
   * still mask. Run on the exact payload right before it leaves the browser;
   * a non-empty result blocks sending.
   */
  function finalScan(value, opts = {}) {
    const findings = [];
    const check = (text, path) => {
      const { kinds } = scrubText(String(text).replace(PLACEHOLDER, ' '), { keywords: opts.keywords });
      if (kinds.length) findings.push({ path: path || '(root)', kinds: [...new Set(kinds)] });
    };
    const walk = (v, path) => {
      if (typeof v === 'string') return check(v, path);
      if (Array.isArray(v)) return v.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (v && typeof v === 'object') {
        for (const [k, item] of Object.entries(v)) {
          check(k, `${path}{key}`);
          walk(item, path ? `${path}.${k}` : k);
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
    mark,
    PLACEHOLDER,
    scrubText,
    typed,
    classifyField,
    walkArgs,
    maskFieldValue,
    maskArgs,
    scrubUrl,
    hostAllowed,
    finalScan
  };

  root.OpScribeSanitize = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
