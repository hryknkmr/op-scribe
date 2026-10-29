/**
 * op-scribe - privacy filter shared by every context.
 *
 * Classic script on purpose: content scripts cannot be ES modules, the
 * service worker loads it with importScripts, the side panel with a plain
 * <script>, and the node tests with require().
 *
 * Contract: everything that is persisted or sent has been through here, and
 * when a value cannot be shown to be harmless it is replaced, never kept.
 * Replacements are placeholders of the form [[kind]] so a reader (and the
 * on-device model) can tell what was there without seeing it.
 */
(function (root) {
  'use strict';

  const mark = (kind) => `[[${kind}]]`;
  const PLACEHOLDER = /\[\[[a-z0-9:_-]+\]\]/gi;

  const DEFAULT_SETTINGS = Object.freeze({
    // strict: free-text values are never kept, only their length.
    // balanced: free-text values are kept after pattern masking.
    privacyLevel: 'strict',
    // Hosts that may appear as-is. Every other host becomes site-N.invalid.
    hostAllowlist: [],
    // Words that must never leave the browser (company, product, people).
    keywords: [],
    endpoint: '',
    authHeader: ''
  });

  const defaults = () => ({ ...DEFAULT_SETTINGS, hostAllowlist: [], keywords: [] });

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
   */
  function scrubText(input, opts = {}) {
    const kinds = [];
    if (input == null) return { text: '', kinds };
    let text = String(input).normalize('NFKC');
    // Zero-width and bidi controls can hide content from the human reviewer.
    text = text.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');

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
  const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'textarea']);

  function piiLabel(hints, type) {
    if (type === 'email' || /mail|メール/i.test(hints)) return 'email';
    if (type === 'tel' || /phone|tel|mobile|fax|電話|携帯/i.test(hints)) return 'phone';
    if (/card|カード/i.test(hints)) return 'card';
    return 'personal';
  }

  /**
   * Decides how a form control's value may be recorded.
   * kind: secret | pii | choice | free | ignore
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
    if (type === 'email' || type === 'tel' || PII_AUTOCOMPLETE.test(autocomplete) || PII_HINT.test(hints)) {
      return { kind: 'pii', label: piiLabel(hints, type) };
    }
    if (['select', 'checkbox', 'radio', 'range', 'color'].includes(type) || meta.tag === 'select') {
      return { kind: 'choice' };
    }
    if (TEXT_TYPES.has(type) || meta.tag === 'textarea' || meta.contentEditable) return { kind: 'free' };
    return { kind: 'free' };
  }

  /**
   * The value of a form control as it may be stored. Runs inside the page so
   * typed text that must not be kept never reaches the extension at all.
   */
  function maskFieldValue(raw, meta, opts = {}) {
    const cls = classifyField(meta);
    if (cls.kind === 'ignore') return null;
    const text = raw == null ? '' : String(raw);
    if (!text) return { value: '', kinds: [] };
    if (cls.kind === 'secret') return { value: mark('secret'), kinds: ['secret'] };
    if (cls.kind === 'pii') return { value: mark(cls.label), kinds: [cls.label] };
    if (cls.kind === 'choice' || opts.privacyLevel === 'balanced') {
      const r = scrubText(text, { keywords: opts.keywords, maxLength: 120 });
      return { value: r.text, kinds: r.kinds };
    }
    return { value: mark(`text:${[...text].length}`), kinds: ['text'] };
  }

  /** Masks WebMCP tool arguments with the same rules as form fields. */
  function maskArgs(value, opts = {}, depth = 0, key = '') {
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      return Number.isFinite(value) && Math.abs(value) < 1e6 ? value : mark('number');
    }
    if (typeof value === 'string') {
      const masked = maskFieldValue(value, { name: key }, opts);
      return masked ? masked.value : '';
    }
    if (depth >= 3) return mark('nested');
    if (Array.isArray(value)) return value.slice(0, 10).map((v) => maskArgs(v, opts, depth + 1, key));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 20)) {
        const safeKey = scrubText(k, { keywords: opts.keywords }).kinds.length ? 'masked' : k;
        out[safeKey] = maskArgs(v, opts, depth + 1, k);
      }
      return out;
    }
    return mark('value');
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
      const r = scrubText(raw, { keywords: ctx.keywords, maxLength: 200 });
      return { url: r.text, kinds: r.kinds };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { url: mark(`url:${url.protocol.replace(':', '')}`), kinds };
    }

    const host = url.hostname.toLowerCase();
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
        const harmless = ctx.privacyLevel === 'balanced'
          && !SENSITIVE_PARAM.test(k)
          && /^[\w.-]{1,24}$/.test(v)
          && !scrubText(v, { keywords: ctx.keywords }).kinds.length;
        value = harmless ? encodeURIComponent(v) : mark('v');
        if (!harmless) kinds.push('query');
      }
      params.push(`${encodeURIComponent(key)}=${value}`);
    }

    // SPA routes such as #/settings are kept in balanced mode; anything else is dropped.
    let hash = '';
    if (url.hash && ctx.privacyLevel === 'balanced' && /^#\/[\w/-]{0,60}$/.test(url.hash)) {
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
    classifyField,
    maskFieldValue,
    maskArgs,
    scrubUrl,
    hostAllowed,
    finalScan
  };

  root.OpScribeSanitize = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
