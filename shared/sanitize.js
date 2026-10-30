/**
 * op-scribe - privacy filter shared by every context.
 *
 * Classic script on purpose: content scripts cannot be ES modules, the
 * service worker loads it with importScripts, the side panel with a plain
 * <script>, and the node tests with require().
 *
 * Policy (one level for everything):
 *   - Credentials are replaced entirely: password fields, credit-card data,
 *     one-time codes, API keys, tokens, private keys.        → [[secret]] / [[card]]
 *   - Contact details and identifiers stay recognizable but partial:
 *     emails, phone numbers, long numeric / hex / UUID ids. → t***@e***.com, ***-****-5678, 12****89
 *   - Everything else (typed text, titles, labels, options) is kept.
 *   - Words the user lists (company, product, people) and hosts the user did not
 *     allow are masked as configured.
 * Contract: everything persisted or sent has been through here.
 */
(function (root) {
  'use strict';

  const mark = (kind) => `[[${kind}]]`;

  /**
   * Placeholders this filter itself produces. Only these are skipped by the
   * final scan; anything else written as [[...]] (by a page, the model or a
   * person editing the text) is scanned like ordinary text.
   */
  const PLACEHOLDER = /\[\[(?:secret|card|masked|v|nested|value|file:\d+|url:[a-z-]+)\]\]/g;

  const DEFAULT_SETTINGS = Object.freeze({
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

  // ----------------------------------------------------------- partial masks

  /** someone@mail.example.com → s***@m***.com */
  function partialEmail(email) {
    const [local, domain] = email.split('@');
    const labels = domain.split('.');
    const tld = labels.length > 1 ? labels.pop() : '';
    return `${[...local][0]}***@${[...labels.join('.')][0] || ''}***${tld ? `.${tld}` : ''}`;
  }

  /** Keeps the head and tail characters: 12345678 → 12****78 */
  function partialId(value, head = 2, tail = 2) {
    const chars = [...value];
    if (chars.length <= head + tail + 1) return `${chars[0] || ''}${'*'.repeat(Math.max(chars.length - 1, 1))}`;
    return `${chars.slice(0, head).join('')}${'*'.repeat(Math.min(chars.length - head - tail, 6))}${chars.slice(-tail).join('')}`;
  }

  /** Keeps the separators and the last four digits: 090-1234-5678 → ***-****-5678 */
  function partialPhone(phone) {
    let remaining = phone.replace(/\D/g, '').length;
    return phone.replace(/\d/g, (d) => {
      remaining -= 1;
      return remaining < 4 ? d : '*';
    });
  }

  /** 192.168.10.5 → 192.168.*.* */
  const partialIp = (ip) => ip.split('.').map((part, i) => (i < 2 ? part : '*')).join('.');

  // Order matters: credentials first, then contact details, then generic ids.
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
    // Long opaque strings mixing letters and digits are session ids or signed parameters.
    { kind: 'secret', re: /(?<![\w-])(?=[\w-]{32,}(?![\w-]))(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]+/g },
    { kind: 'card', re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
    { kind: 'email', re: /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, replace: partialEmail },
    { kind: 'phone', re: /(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g, replace: partialPhone },
    { kind: 'phone', re: /\+\d{1,3}[- ]?\d{1,4}[- ]?\d{2,4}[- ]?\d{3,4}(?!\d)/g, replace: partialPhone },
    { kind: 'phone', re: /(?<!\d)0\d{9,10}(?!\d)/g, replace: partialPhone },
    { kind: 'id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replace: (m) => partialId(m, 4, 4) },
    { kind: 'ip', re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, replace: partialIp },
    { kind: 'id', re: /\b[0-9a-f]{24,}\b/gi, replace: (m) => partialId(m, 4, 4) },
    { kind: 'id', re: /(?<!\d)\d{7,}(?!\d)/g, replace: (m) => partialId(m) }
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
   * Applies the policy to free text. Masking runs before truncation so a cut
   * can never expose half an address.
   */
  const TEXT_URL = /https?:\/\/[^\s<>"'「」『』（）()、。]+/gi;

  function scrubText(input, opts = {}) {
    const kinds = [];
    if (input == null) return { text: '', kinds };
    let text = String(input).normalize('NFKC');
    // Zero-width and bidi controls can hide content from the human reviewer.
    text = text.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');

    // URLs written in the text follow the URL policy (hosts not allowed under their alias, ids partly
    // hidden) when the caller knows the recording's hosts: opts.hosts = { hostAllowlist, aliases }.
    if (opts.hosts) {
      text = text.replace(TEXT_URL, (match) => {
        const [, url, tail] = match.match(/^(.*?)([.,;:!?]*)$/);
        const r = scrubUrl(url, { ...opts.hosts, keywords: opts.keywords });
        kinds.push(...r.kinds);
        return `${r.url}${tail}`;
      });
    }

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
  const CARD_HINT = /card.?(number|no|num)|cc.?(num|number)|cvc|cvv|security.?code|expir|有効期限|カード番号|セキュリティコード/i;
  const SECRET_HINT = /pass|pwd|secret|token|otp|\bpin\b|暗証|パスワード|認証コード|確認コード|ワンタイム/i;
  const EMAIL_HINT = /mail|メール/i;
  const PHONE_HINT = /phone|\btel\b|mobile|fax|電話|携帯/i;

  /**
   * Decides how a form control's value may be recorded.
   * kind: secret | email | phone | text | ignore
   */
  function classifyField(meta = {}) {
    const type = String(meta.type || '').toLowerCase();
    const autocomplete = String(meta.autocomplete || '').toLowerCase();
    const hints = [meta.name, meta.id, meta.label, meta.placeholder, meta.ariaLabel]
      .filter(Boolean).join(' ').normalize('NFKC');

    if (type === 'hidden') return { kind: 'ignore' };
    if (/\bcc-/.test(autocomplete) || CARD_HINT.test(hints)) return { kind: 'secret', label: 'card' };
    if (type === 'password' || SECRET_AUTOCOMPLETE.test(autocomplete) || SECRET_HINT.test(hints)) {
      return { kind: 'secret', label: 'secret' };
    }
    if (type === 'email' || /\bemail\b/.test(autocomplete) || EMAIL_HINT.test(hints)) return { kind: 'email' };
    if (type === 'tel' || /\btel\b/.test(autocomplete) || PHONE_HINT.test(hints)) return { kind: 'phone' };
    return { kind: 'text' };
  }

  /**
   * The value of a form control as it may be stored. Runs inside the page so
   * a credential never reaches the extension at all.
   */
  function maskFieldValue(raw, meta, opts = {}) {
    const cls = classifyField(meta);
    if (cls.kind === 'ignore') return null;
    const text = raw == null ? '' : String(raw);
    if (!text) return { value: '', kinds: [] };
    if (cls.kind === 'secret') return { value: mark(cls.label), kinds: [cls.label] };
    const r = scrubText(text, { keywords: opts.keywords, maxLength: 200 });
    // A contact field the patterns did not recognize (e.g. a partial address) is still partially hidden.
    if ((cls.kind === 'email' || cls.kind === 'phone') && !r.kinds.length) {
      return { value: partialId(r.text, 1, cls.kind === 'phone' ? 4 : 1), kinds: [cls.kind] };
    }
    return { value: r.text, kinds: r.kinds };
  }

  /** Masks WebMCP tool arguments with the same rules as form fields, keyed by argument name. */
  function maskArgs(value, opts = {}, depth = 0, key = '') {
    // The key decides first: { otp: 123456 } is a credential whatever its type.
    if (key && classifyField({ name: key }).kind === 'secret' && value != null && typeof value !== 'object') {
      return mark('secret');
    }
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return mark('value');
      const r = scrubText(String(value));
      return r.kinds.length ? r.text : value;
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

  const ID_SEGMENT = /^(?:\d{3,}|[0-9a-f]{12,}|[0-9a-f-]{32,36})$/i;
  const SECRET_PARAM = /token|code|key|secret|sig|session|auth|pass|nonce|ticket|state|otp/i;

  // URLs nested in a URL (?next=https://..., /go/https%3A...) follow the same host policy and share its aliases.
  const hostsOf = (ctx) => {
    if (!ctx.aliases) ctx.aliases = {};
    return { hostAllowlist: ctx.hostAllowlist, aliases: ctx.aliases };
  };

  /** One path or fragment segment under the policy. */
  function scrubSegment(segment, ctx, kinds) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep raw */ }
    if (decoded.startsWith('@') && decoded.length > 1) {
      kinds.push('id');
      return `@${partialId(decoded.slice(1), 1, 1)}`;
    }
    if (ID_SEGMENT.test(decoded)) {
      kinds.push('id');
      return partialId(decoded);
    }
    const r = scrubText(decoded, { keywords: ctx.keywords, hosts: hostsOf(ctx) });
    if (!r.kinds.length) return segment;
    kinds.push(...r.kinds);
    return encodeURIComponent(r.text).replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%2A/gi, '*');
  }

  /**
   * ctx.aliases is mutated: it maps each real origin to its stable alias for
   * this recording, and lives only in the browser (never in the payload).
   */
  function scrubUrl(raw, ctx = {}) {
    const kinds = [];
    const { aliases } = hostsOf(ctx);
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

    const path = url.pathname.split('/').map((seg) => (seg ? scrubSegment(seg, ctx, kinds) : seg)).join('/');

    const params = [];
    for (const [k, v] of url.searchParams) {
      const key = scrubText(k, { keywords: ctx.keywords }).kinds.length ? 'masked' : k;
      let value = '';
      if (v && SECRET_PARAM.test(k)) {
        value = mark('secret');
        kinds.push('secret');
      } else if (v) {
        const r = scrubText(v, { keywords: ctx.keywords, hosts: hostsOf(ctx) });
        kinds.push(...r.kinds);
        value = encodeURIComponent(r.text).replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%2A/gi, '*');
      }
      params.push(`${encodeURIComponent(key)}=${value}`);
    }

    // Fragments are kept like paths: SPA routes (#/settings) stay readable, ids and listed words are masked.
    let hash = '';
    if (url.hash.includes('://')) {
      // A URL inside the fragment (#/redirect/https://...): read as text, so its host follows the policy.
      let decoded = url.hash.slice(1);
      try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
      const r = scrubText(decoded, { keywords: ctx.keywords, hosts: hostsOf(ctx) });
      kinds.push(...r.kinds);
      hash = `#${r.text}`;
    } else if (url.hash.length > 1) {
      hash = `#${url.hash.slice(1).split('/').map((seg) => (seg ? scrubSegment(seg, ctx, kinds) : seg)).join('/')}`;
    }

    return { url: `${origin}${path}${params.length ? `?${params.join('&')}` : ''}${hash}`, kinds };
  }

  // -------------------------------------------------------------- final gate

  /**
   * Walks every string in an object and reports anything the policy would
   * still mask. Run on the exact text right before it leaves the browser;
   * a non-empty result blocks it.
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
    partialEmail,
    partialId,
    partialPhone,
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
