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
    privacyLevel: 'partial',
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
  // IPv6: the first group only (fd00::1 -> fd00:*:*).
  const partialIp6 = (ip) => ip.split(':').map((part, i) => (i < 1 ? part : '*')).join(':');

  // Order matters: credentials first, then contact details, then generic ids.
  const RULES = [
    { kind: 'secret', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
    { kind: 'secret', re: /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g },
    { kind: 'secret', re: /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})/g },
    { kind: 'secret', re: /\b(?:Bearer|Basic)\s+[\w.~+/-]{8,}=*/gi },
    {
      // A credential written as key and value in text or JSON (client_secret=abc, "pin": "1234", backup code: ABC,
      // password="hunter 2"): the key is judged by classifyKey, like every other key; a quoted value is taken whole.
      // An unquoted value is taken up to the next space.
      kind: 'secret',
      // Keys in any letters: 認証コード: 123456.
      re: /(?<![\p{L}\p{N}_.-])(\p{L}[\p{L}\p{N}_.-]*(?:[ _-]\p{L}[\p{L}\p{N}_.-]*){0,2})(["']?\s*[:=]\s*)("[^"]*"?|'[^']*'?|[^\s"'&,}]+)/gu,
      accept: (match) => {
        const [, key, , value] = match.match(/^(\p{L}[\p{L}\p{N}_.-]*(?:[ _-]\p{L}[\p{L}\p{N}_.-]*){0,2})(["']?\s*[:=]\s*)([\s\S]*)$/u);
        return ['secret', 'card'].includes(classifyKey(key)) && !/^["']?\[\[/.test(value);
      },
      replace: (match, key, sep, value) => {
        // An unclosed quote (password="hunter) takes the rest of the text: it is all the value as far as can be told.
        const quote = /^["']/.test(value) ? value[0] : '';
        const closed = quote && value.length > 1 && value.endsWith(quote);
        return `${key}${sep}${quote}${mark('secret')}${closed ? quote : ''}`;
      }
    },
    // Long opaque strings mixing letters and digits are session ids or signed parameters.
    { kind: 'secret', re: /(?<![\w-])(?=[\w-]{32,}(?![\w-]))(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]+/g },
    { kind: 'card', re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
    // Not right after another letter: 名taro@example.com is one address with a non-ASCII local part (below).
    { kind: 'email', re: /(?<![\p{L}\p{N}\p{M}])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu, replace: partialEmail },
    // An address on a single-label (internal) domain: alice@intranet.
    { kind: 'email', re: /(?<![\w.%+@*-])[\w.%+-]+@[A-Za-z][A-Za-z0-9-]*(?![\w.@*-])/g, replace: partialEmail },
    // Addresses with non-ASCII letters (太郎@例え.テスト), after the ASCII ones so those keep their own bounds.
    // Words written right before such an address are taken with it: over-matching only hides more.
    { kind: 'email', re: /[\p{L}\p{N}\p{M}._%+-]+@[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)+/gu, replace: partialEmail },
    { kind: 'phone', re: /(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g, replace: partialPhone },
    { kind: 'phone', re: /\+\d{1,3}[- ]?\d{1,4}[- ]?\d{2,4}[- ]?\d{3,4}(?!\d)/g, replace: partialPhone },
    { kind: 'phone', re: /(?<!\d)0\d{9,10}(?!\d)/g, replace: partialPhone },
    // Three groups with an area code in brackets or set apart: (415) 555-2671, 415-555-2671, 03 1234 5678, (03) 1234-5678.
    { kind: 'phone', re: /(?<![\d(-])(?:\(\d{2,4}\)\s?|\d{2,4}[ -])\d{3,4}[ -]\d{4}(?![\d-])/g, replace: partialPhone },
    { kind: 'id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replace: (m) => partialId(m, 4, 4) },
    // IPv6 first, so one ending in an IPv4 address (2001:db8::192.0.2.33) is taken whole.
    // Written out, shortened with ::, or ending in IPv4. Three groups of digits (10:30:00) is a time.
    { kind: 'ip', re: /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,6}(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/gi,
      accept: (m) => m.includes('::') || m.split(':').length === 7, replace: partialIp6 },
    { kind: 'ip', re: /(?<![\w:.])(?=[0-9a-f:]*::|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4})(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, replace: partialIp6 },
    { kind: 'ip', re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, replace: partialIp },
    { kind: 'id', re: /\b[0-9a-f]{24,}\b/gi, replace: (m) => partialId(m, 4, 4) },
    { kind: 'id', re: /(?<!\d)\d{7,}(?!\d)/g, replace: (m) => partialId(m) }
  ];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** One Punycode label (RFC 3492) as Unicode: xn--mnich-kva -> münich. Malformed input is returned as is. */
  function punyLabel(label) {
    if (!/^xn--/i.test(label)) return label;
    const input = label.slice(4).toLowerCase();
    const cut = input.lastIndexOf('-');
    const out = cut > 0 ? [...input.slice(0, cut)] : [];
    let n = 128, bias = 72, i = 0;
    const digit = (c) => (c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : 36);
    for (let pos = cut > 0 ? cut + 1 : 0; pos < input.length;) {
      const old = i;
      for (let w = 1, k = 36; ; k += 36) {
        if (pos >= input.length) return label;
        const d = digit(input.charCodeAt(pos++));
        if (d >= 36) return label;
        i += d * w;
        const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
        if (d < t) break;
        w *= 36 - t;
      }
      let delta = old === 0 ? Math.floor((i - old) / 700) : (i - old) >> 1;
      delta += Math.floor(delta / (out.length + 1));
      let k = 0;
      for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
      bias = k + Math.floor((36 * delta) / (delta + 38));
      n += Math.floor(i / (out.length + 1));
      i %= out.length + 1;
      out.splice(i++, 0, String.fromCodePoint(n));
    }
    return out.join('');
  }

  /**
   * The names of the real hosts a recording aliased, as [name, alias], longest first. A host with
   * non-ASCII letters is kept in URLs as Punycode (xn--...) but shown in text in Unicode: both forms.
   */
  function aliasedHosts(aliases = {}) {
    const out = [];
    for (const [origin, alias] of Object.entries(aliases)) {
      let host;
      try { host = new URL(origin).hostname.replace(/\.+$/, ''); } catch { continue; }
      out.push([host, alias]);
      const shown = host.split('.').map(punyLabel).join('.');
      if (shown !== host) out.push([shown, alias]);
    }
    return out.sort((a, b) => b[0].length - a[0].length);
  }

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
  // With a scheme, or scheme-relative (//host/path, which a page or a link resolves against its own scheme;
  // a host with or without dots, in any letters, an IP address, [IPv6]). Over-matching only hides more.
  const TEXT_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'「」『』（）()、。]+|(?<![\w/:])\/\/(?:\[[0-9A-Fa-f:.]+\]|[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)*)(?::\d+)?(?:[/?#][^\s<>"'「」『』（）()、。]*)?/giu;

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
        const relative = url.startsWith('//');
        const r = scrubUrl(relative ? `https:${url}` : url, { ...opts.hosts, keywords: opts.keywords });
        kinds.push(...r.kinds);
        return `${relative ? r.url.replace(/^https:/, '') : r.url}${tail}`;
      });
      // A real host the recording has aliased, written without a URL (internal.test), is aliased too.
      // Longest first, so a.internal.test is not cut to a.site-1.invalid.
      for (const [host, alias] of aliasedHosts(opts.hosts.aliases)) {
        text = text.replace(new RegExp(`(?<![\\w.-])${escapeRe(host)}(?![\\w-])`, 'gi'), () => {
          kinds.push('host');
          return alias;
        });
      }
    }

    const keywords = keywordPattern(opts.keywords);
    if (keywords) {
      // Placeholders this filter wrote are left whole: a listed word "secret" must not break [[secret]].
      text = text.split(new RegExp(`(${PLACEHOLDER.source})`)).map((part, i) => (i % 2 ? part : part.replace(keywords, () => {
        kinds.push('keyword');
        return mark('masked');
      }))).join('');
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

  // ------------------------------------------------------------- key meaning

  // What a key or a field's name says its value is. One judge for form fields, URL parameters, WebMCP
  // arguments and the final scan, so that the same name means the same everywhere.

  /**
   * A key as lowercase words: orderID -> order id, APIKey -> api key, verification_code -> verification code.
   * A number at the end of a word is a counter, not part of the name: cvv2 -> cvv, otp1 -> otp (2fa stays).
   */
  const wordsOf = (key) => String(key || '').normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.replace(/\d+$/, ''))).filter(Boolean);

  // Whole words, or (the long ones) inside a word written without separators: newpassword, accesstoken.
  const CREDENTIAL_WORDS = new Set(['pwd', 'pin', 'session', 'sessionid', 'sid', 'otp', 'totp', 'hotp', 'mfa', '2fa', 'passcode', 'bearer', 'cookie']);
  // Ends a word written without separators (newpassword, accesstoken, clientsecret), or starts one for passwords
  // (passwordconfirm). Not inside a longer word: secretary and tokenizer are not credentials.
  const CREDENTIAL_PARTS = /(?:password|passwd|passphrase|secret|token|tokens|credential|credentials|authorization|apikey|accesskey|privatekey)$|^(?:password|passwd|passphrase)|^pass$|^(?:user|login|admin|account|new|old|current|confirm|db)pass$|^(?:verification|verify|confirm|confirmation|auth|access|login|sms|backup|recovery|onetime|otp|mfa|pin)code$/;
  const KEY_OWNERS = ['api', 'access', 'private', 'signing', 'client', 'license', 'secret', 'session'];
  const CODE_OWNERS = ['verification', 'verify', 'confirm', 'confirmation', 'auth', 'authentication', 'access', 'login',
    'sms', 'backup', 'recovery', 'time', 'otp', 'mfa', 'pin'];
  // Only in URLs and protocol arguments: OAuth and signed-URL parameters. A form field named "state" or "code" is a
  // place or a promotion code, and is kept.
  const PROTOCOL_WORDS = new Set(['auth', 'key', 'code', 'state', 'session', 'sid', 'sig', 'signature', 'nonce', 'ticket', 'pass', 'saml', 'assertion']);
  const JA_CARD = /有効期限|カード番号|セキュリティコード/;
  const JA_SECRET = /暗証|パスワード|認証コード|確認コード|ワンタイム|トークン|秘密鍵|シークレット|(?:API|アクセス|プライベート)キー/i;
  // ユーザーID, ログインID, 会員番号: an id named in Japanese (after NFKC, ＩＤ is ID).
  const JA_ID = /[^\x00-\x7f]ID$|(?:会員|顧客|注文|ユーザー|アカウント|管理)番号$/i;
  const JA_EMAIL = /メール/;
  const JA_PHONE = /電話|携帯/;
  const PHONE_WORDS = new Set(['phone', 'tel', 'telephone', 'mobile', 'fax', 'cell']);
  const ID_WORDS = new Set(['id', 'ids', 'uid', 'uuid', 'guid', 'username', 'userid', 'loginid', 'login', 'account', 'handle', 'nickname']);

  /**
   * card | secret | email | phone | id | null. protocol: the key is a URL parameter or a protocol
   * argument, where a few more words (code, state, session, ...) name credentials.
   */
  function classifyKey(key, { protocol = false } = {}) {
    const text = String(key || '').normalize('NFKC');
    const words = wordsOf(text);
    if (!words.length) return null;
    const has = (list) => words.some((w) => list.includes(w));
    const pair = (owners, second) => words.some((w, i) => owners.includes(w) && words[i + 1] === second);
    if (JA_CARD.test(text) || has(['cvc', 'cvv', 'csc', 'ccnumber', 'cardnumber', 'securitycode', 'cardcode']) || pair(['card', 'cc'], 'number')
        || pair(['card', 'cc'], 'no') || pair(['card', 'cc'], 'num') || pair(['security'], 'code')
        || words.some((w) => w.startsWith('expir')) || (has(['exp']) && has(['month', 'year', 'date', 'mm', 'yy', 'card', 'cc']))) return 'card';
    if (JA_SECRET.test(text) || words.some((w) => CREDENTIAL_WORDS.has(w) || CREDENTIAL_PARTS.test(w))
        || pair(KEY_OWNERS, 'key') || pair(CODE_OWNERS, 'code') || words.some((w) => /^(?:pass|pwd|otp|pin)$/.test(w) && protocol)
        || (protocol && words.some((w) => PROTOCOL_WORDS.has(w)))) return 'secret';
    if (JA_EMAIL.test(text) || words.some((w) => w.includes('email') || /^mail(?:add?ress|addr)?$/.test(w)) || pair(['e'], 'mail')) return 'email';
    if (JA_PHONE.test(text) || words.some((w) => PHONE_WORDS.has(w) || w.endsWith('phone'))) return 'phone';
    if (JA_ID.test(text.trim()) || ID_WORDS.has(words[words.length - 1]) || pair(['user', 'login', 'screen', 'display', 'account'], 'name')) return 'id';
    return null;
  }

  // ------------------------------------------------------------------ fields

  const SECRET_AUTOCOMPLETE = /\b(?:one-time-code|current-password|new-password)\b/;
  const RANK = ['card', 'secret', 'email', 'phone', 'id'];

  /**
   * Decides how a form control's value may be recorded.
   * kind: secret (label secret | card) | email | phone | id | text | ignore
   */
  function classifyField(meta = {}) {
    const type = String(meta.type || '').toLowerCase();
    const autocomplete = String(meta.autocomplete || '').toLowerCase();
    if (type === 'hidden') return { kind: 'ignore' };
    // A chosen option is the page's own text (Japan from country_id, Morning from session): kept, except card data
    // (an expiry month chosen from a list).
    const chosen = meta.tag === 'select' || /^(?:select|radio|checkbox)/.test(type);
    const found = new Set([meta.name, meta.id, meta.label, meta.placeholder, meta.ariaLabel].map((h) => classifyKey(h)));
    if (/\bcc-/.test(autocomplete) || found.has('card')) return { kind: 'secret', label: 'card' };
    if (chosen) return { kind: 'text' };
    if (type === 'password' || SECRET_AUTOCOMPLETE.test(autocomplete) || found.has('secret')) return { kind: 'secret', label: 'secret' };
    if (type === 'email' || /\bemail\b/.test(autocomplete)) return { kind: 'email' };
    if (type === 'tel' || /\btel\b/.test(autocomplete)) return { kind: 'phone' };
    if (/\b(?:username|nickname)\b/.test(autocomplete)) return { kind: 'id' };
    const kind = RANK.find((k) => found.has(k));
    return { kind: kind || 'text' };
  }

  /** A value whose key or field says what it is (classifyKey's kinds), under the policy for that kind. */
  /**
   * A value this filter already hid: a placeholder, or the shape a partial mask leaves (ab**23, s***@e***.com,
   * ***-****-5678). Kept as it is, so that a recording passed through again (the worker, the final scan) is stable.
   */
  const alreadyHidden = (value) => /^\[\[[^\]]+\]\]$/.test(value) || /^[^*\s]{0,4}\*+[^*\s]{0,4}$/.test(value)
    || /^[^\s@*]?\*{3}@[^\s@*]?\*{3}(?:\.[^\s@*]+)?$/.test(value) || /^[+\s()*-]*\*[+\d\s()*-]*$/.test(value);

  function maskByKind(kind, text, opts = {}) {
    // A credential is replaced whatever it looks like (ab**cd may be a password); only this filter's own
    // placeholder passes again unchanged.
    if (kind === 'secret' || kind === 'card') {
      return new RegExp(`^${PLACEHOLDER.source}$`).test(String(text).trim()) ? { value: text, kinds: [] } : { value: mark(kind), kinds: [kind] };
    }
    if (kind && alreadyHidden(String(text).trim())) return { value: text, kinds: [] };
    const r = scrubText(text, { keywords: opts.keywords, maxLength: opts.maxLength, hosts: opts.hosts });
    // A contact field keeps its value only when the whole of it was recognized as one address or number
    // (and so partly hidden). Nothing recognized in it (someone): partly hidden as a whole. Something else
    // recognized in it (alice@localhost next to an id, words around a credential): hidden entirely.
    if (kind === 'email' || kind === 'phone') {
      if (!r.kinds.length) return { value: partialId(r.text, 1, kind === 'phone' ? 4 : 1), kinds: [kind] };
      const whole = kind === 'email' ? /^[^\s@[\]]*\*{3}@[^\s@[\]]*$/ : /^[+\d\s()*-]*\*[+\d\s()*-]*$/;
      if (!whole.test(r.text.trim())) return { value: mark('masked'), kinds: [...new Set([...r.kinds, kind])] };
    }
    if (kind === 'id' && !r.kinds.length) return { value: partialId(r.text), kinds: ['id'] };
    return { value: r.text, kinds: r.kinds };
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
    return maskByKind(cls.kind === 'secret' ? cls.label : cls.kind, text, { keywords: opts.keywords, maxLength: 200 });
  }

  /**
   * Masks WebMCP tool arguments by key, as URL parameters are. A key's meaning covers everything under it:
   * { token: { value: ... } } is hidden whole, { user_id: { v: ... } } is an id all the way down.
   */
  function maskArgs(value, opts = {}, depth = 0, key = '', inherited = null) {
    const meaning = (key && classifyKey(key, { protocol: true })) || inherited;
    if ((meaning === 'secret' || meaning === 'card') && value != null) return mark(meaning);
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number' || typeof value === 'string') {
      if (typeof value === 'number' && !Number.isFinite(value)) return mark('value');
      const r = maskByKind(meaning, String(value), { keywords: opts.keywords, maxLength: 200 });
      return typeof value === 'number' && r.value === String(value) ? value : r.value;
    }
    if (depth >= 3) return mark('nested');
    if (Array.isArray(value)) return value.slice(0, 10).map((v) => maskArgs(v, opts, depth + 1, '', meaning));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 20)) {
        const safeKey = scrubText(k, { keywords: opts.keywords }).kinds.length ? 'masked' : k;
        out[safeKey] = maskArgs(v, opts, depth + 1, k, meaning);
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

  // Digits, hex, a UUID, or an opaque token of 16+ letters mixed with digits (abc123def456ghi7).
  const ID_SEGMENT = /^(?:\d{3,}|[0-9a-f]{12,}|[0-9a-f-]{32,36}|(?=.*\d)(?=.*[a-z])[a-z0-9_-]{16,})$/i;

  // URLs nested in a URL (?next=https://..., /go/https%3A...) follow the same host policy and share its aliases.
  const hostsOf = (ctx) => {
    if (!ctx.aliases) ctx.aliases = {};
    return { hostAllowlist: ctx.hostAllowlist, aliases: ctx.aliases };
  };

  /** One path or fragment segment under the policy. */
  function scrubSegment(segment, ctx, kinds) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* keep raw */ }
    if (alreadyHidden(decoded.replace(/^@/, ''))) return segment;
    if (decoded.startsWith('@') && decoded.length > 1) {
      kinds.push('id');
      return `@${partialId(decoded.slice(1), 1, 1)}`;
    }
    if (ID_SEGMENT.test(decoded)) {
      kinds.push('id');
      return partialId(decoded);
    }
    // An id inside a segment (order-123456, 123456.json, 123456;view=full): the run of digits or hex is partly hidden.
    let changed = false;
    const text = decoded.replace(/(?<![0-9a-z])(?:\d{3,}|[0-9a-f]{12,})(?![0-9a-z])/gi, (id) => {
      changed = true;
      return partialId(id);
    });
    if (changed) kinds.push('id');
    const r = scrubText(text, { keywords: ctx.keywords, hosts: hostsOf(ctx) });
    if (!changed && !r.kinds.length) return segment;
    kinds.push(...r.kinds);
    return encodeURIComponent(r.text).replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%2A/gi, '*')
      .replace(/%3B/gi, ';').replace(/%3D/gi, '=');
  }

  /** Query parameters under the policy: credential keys hidden, id keys partly hidden, other values masked like text. */
  function scrubParams(entries, ctx, kinds) {
    const params = [];
    for (const [k, v] of entries) {
      const key = scrubText(k, { keywords: ctx.keywords }).kinds.length ? 'masked' : k;
      let value = '';
      if (v) {
        // The key decides first (classifyKey); a value shaped like an id is partly hidden whatever its key.
        const meaning = classifyKey(k, { protocol: true }) || (ID_SEGMENT.test(v) ? 'id' : null);
        const r = maskByKind(meaning, v, { keywords: ctx.keywords, hosts: hostsOf(ctx) });
        kinds.push(...r.kinds);
        value = encodeURIComponent(r.value).replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%2A/gi, '*');
      }
      params.push(`${encodeURIComponent(key)}=${value}`);
    }
    return params;
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
      // Not parsed (a bad port, broken IPv6): its host cannot be put under the policy, so none of it is kept.
      return { url: mark('url:invalid'), kinds: ['host'] };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { url: mark(`url:${url.protocol.replace(':', '')}`), kinds };
    }
    // example.test. (the DNS root dot) is the same host as example.test: one alias, and found in text without the dot.
    if (url.hostname.endsWith('.')) url.hostname = url.hostname.replace(/\.+$/, '');

    const host = url.hostname.toLowerCase();
    let origin;
    if (hostAllowed(host, ctx.hostAllowlist)) {
      origin = `${url.protocol}//${url.host}`;
    } else {
      origin = `${url.protocol}//${aliasFor(url.origin, aliases)}`;
      kinds.push('host');
    }

    const path = url.pathname.split('/').map((seg) => (seg ? scrubSegment(seg, ctx, kinds) : seg)).join('/');

    const params = scrubParams(url.searchParams, ctx, kinds);

    // Fragments are kept like paths: SPA routes (#/settings) stay readable, ids and listed words are masked.
    // Parameters in a fragment (#access_token=..., #/route?code=...) follow the query rules.
    let hash = '';
    const fragment = url.hash.slice(1);
    const [route, query] = fragment.includes('?') ? [fragment.slice(0, fragment.indexOf('?')), fragment.slice(fragment.indexOf('?') + 1)]
      : fragment.includes('=') ? ['', fragment] : [fragment, null];
    if (url.hash.includes('://')) {
      // A URL inside the fragment (#/redirect/https://...?x=1): read as text, so its host and its own
      // parameters follow the policy. Checked before the fragment's own parameters, which it would split.
      let decoded = fragment;
      try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
      const r = scrubText(decoded, { keywords: ctx.keywords, hosts: hostsOf(ctx) });
      kinds.push(...r.kinds);
      hash = `#${r.text}`;
    } else if (query !== null) {
      const routed = route.split('/').map((seg) => (seg ? scrubSegment(seg, ctx, kinds) : seg)).join('/');
      const fragmentParams = scrubParams(new URLSearchParams(query), ctx, kinds);
      hash = `#${routed}${route || fragment.includes('?') ? '?' : ''}${fragmentParams.join('&')}`;
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
      // Also with the placeholders taken out: text a page wrapped around one (Ac[[secret]]me) reads as a whole.
      // And with any [[...]] taken out, known or not: an unknown one (Ac[[foo]]me) must not split a word either.
      const kinds = [String(text).replace(PLACEHOLDER, ' '), String(text).replace(PLACEHOLDER, ''), String(text).replace(/\[\[[^\]]*\]\]/g, '')]
        .flatMap((t) => scrubText(t, { keywords: opts.keywords }).kinds);
      if (kinds.length) findings.push({ path: path || '(root)', kinds: [...new Set(kinds)] });
    };
    const credential = (key, options) => ['secret', 'card'].includes(classifyKey(key, options));
    // URLs written in the text (an edited ?code=abc123, /orders/123456): whatever scrubUrl would still hide,
    // except the host, which only the recording can place (its aliases are scanned as keywords).
    const urlParams = (text, path) => {
      for (const match of String(text).match(TEXT_URL) || []) {
        const relative = match.startsWith('//');
        const kinds = scrubUrl(relative ? `https:${match}` : match, { hostAllowlist: [], keywords: opts.keywords }).kinds
          .filter((kind) => kind !== 'host');
        if (kinds.length) {
          findings.push({ path: path || '(root)', kinds: [...new Set(kinds)] });
          return;
        }
      }
    };
    // under: the credential kind of a key above, which covers everything nested in it.
    // args: inside WebMCP arguments, where keys are protocol keys (code, state) as in maskArgs.
    const walk = (v, path, key = '', under = null, args = false) => {
      // Counts of what this filter hid, keyed by kind (secret: 2): not values. Only the recording's own, only numbers.
      if (/^(?:recording\.)?privacy\.redactions$/.test(path) && v && typeof v === 'object'
          && Object.values(v).every((n) => Number.isInteger(n))) return undefined;
      const inArgs = args || key === 'args';
      const kind = under || (key && credential(key, { protocol: args }) ? classifyKey(key, { protocol: args }) : null);
      // A value under a key naming a credential is one, unless it is only a placeholder of this filter.
      if (kind && (typeof v === 'number' || (typeof v === 'string' && v.replace(PLACEHOLDER, '').trim()))) {
        findings.push({ path: path || '(root)', kinds: [kind] });
      }
      if (typeof v === 'string') {
        urlParams(v, path);
        return check(v, path);
      }
      if (Array.isArray(v)) return v.forEach((item, i) => walk(item, `${path}[${i}]`, '', kind, inArgs));
      if (v && typeof v === 'object') {
        for (const [k, item] of Object.entries(v)) {
          check(k, `${path}{key}`);
          walk(item, path ? `${path}.${k}` : k, k, kind, inArgs);
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
    classifyKey,
    classifyField,
    maskFieldValue,
    maskArgs,
    scrubUrl,
    hostAllowed,
    aliasedHosts,
    finalScan
  };

  root.OpScribeSanitize = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
