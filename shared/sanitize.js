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
  const PLACEHOLDER = /\[\[(?:secret|card|masked|v|nested|value|text:\d+|file:\d+|url:[a-z-]+)\]\]/g;

  /** Exactly one placeholder this filter writes. A [[...]] of any other kind is the page's text and is read as such. */
  const isPlaceholder = (value) => new RegExp(`^${PLACEHOLDER.source}$`).test(String(value));

  const DEFAULT_SETTINGS = Object.freeze({
    privacyLevel: 'partial',
    // Hosts that may appear as-is. Every other host becomes site-N.invalid.
    hostAllowlist: [],
    // Real production hosts: there, typed text is kept as its length only (search boxes and chosen options
    // aside) and URL values only when short and plain. Everywhere else (beta, staging) values are kept.
    productionHosts: [],
    // Words that must never leave the browser (company, product, people).
    keywords: [],
    endpoint: '',
    authHeader: ''
  });

  const defaults = () => ({ ...DEFAULT_SETTINGS, hostAllowlist: [], productionHosts: [], keywords: [] });

  /** The check digit of a Japanese My Number (12 digits). */
  function myNumber(digits) {
    if (!/^\d{12}$/.test(digits)) return false;
    let sum = 0;
    for (let n = 1; n <= 11; n += 1) {
      const p = Number(digits[11 - n]);
      sum += p * (n <= 6 ? n + 1 : n - 5);
    }
    const r = sum % 11;
    return Number(digits[11]) === (r <= 1 ? 0 : 11 - r);
  }

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
    // Four digits or fewer (an extension): none are kept.
    if (remaining <= 4) return phone.replace(/\d/g, '*');
    return phone.replace(/\d/g, (d) => {
      remaining -= 1;
      return remaining < 4 ? d : '*';
    });
  }

  /** 192.168.10.5 → 192.168.*.* */
  const partialIp = (ip) => ip.split('.').map((part, i) => (i < 2 ? part : '*')).join('.');
  // IPv6: the first group only (fd00::1 -> fd00:*:*).
  const partialIp6 = (ip) => ip.split(':').map((part, i) => (i < 1 ? part : '*')).join(':');

  // Order matters: credentials first, then contact details, then generic ids. Listed words come after all of these
  // (scrubText), so that none of them is cut apart by a word inside it (alice@Acme.example.com).
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
      re: /(?<![\p{L}\p{N}_.-])([\p{L}\p{N}][\p{L}\p{N}_.-]*(?:[ _-]\p{L}[\p{L}\p{N}_.-]*){0,2})(["']?\s*[:=]\s*)((?:Basic|Bearer)\s+[^\s"'&,}]+|"[^"]*"?|'[^']*'?|[^\s"'&,}]+)/giu,
      accept: (match) => {
        const [, key, , value] = match.match(/^([\p{L}\p{N}][\p{L}\p{N}_.-]*(?:[ _-]\p{L}[\p{L}\p{N}_.-]*){0,2})(["']?\s*[:=]\s*)([\s\S]*)$/u);
        return ['secret', 'card'].includes(classifyKey(key)) && !isPlaceholder(value.replace(/^["']|["']$/g, ''));
      },
      replace: (match, key, sep, value) => {
        // An unclosed quote (password="hunter) takes the rest of the text: it is all the value as far as can be told.
        const quote = /^["']/.test(value) ? value[0] : '';
        const closed = quote && value.length > 1 && value.endsWith(quote);
        return `${key}${sep}${quote}${mark('secret')}${closed ? quote : ''}`;
      }
    },
    // A domain literal: someone@[192.0.2.1], someone@[IPv6:2001:db8::1]. Before the IP rules take its inside apart.
    { kind: 'email', re: /[\p{L}\p{N}._%+-]+@\[(?:IPv6:)?[0-9A-Fa-f:.]+\]/gu, replace: (m) => `${[...m][0]}***@[***]` },
    // A quoted local part: "john doe"@example.com.
    // Not one this filter already wrote ("j***"@e***.com).
    { kind: 'email', re: /"(?![^"]*\*\*\*")[^"\n@]{1,64}"@(?![\p{L}\p{N}-]*\*)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/gu, replace: (m) => `"${m[1]}***"@${partialEmail(`x@${m.split('@').pop()}`).split('@')[1]}` },
    // Addresses before the generic rules below, which would cut one apart (a 32-letter local part, a listed word).
    // Not right after another letter: 名taro@example.com is one address with a non-ASCII local part (below).
    { kind: 'email', re: /(?<![\p{L}\p{N}\p{M}])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu, replace: partialEmail },
    // An address on a single-label (internal) domain, in any letters: alice@intranet, 太郎@社内.
    { kind: 'email', re: /(?<![\p{L}\p{N}\p{M}.%+@*-])[\p{L}\p{N}\p{M}._%+-]+@\p{L}[\p{L}\p{N}\p{M}-]*(?![\p{L}\p{N}\p{M}.@*-])/gu, replace: partialEmail },
    // Addresses with non-ASCII letters (太郎@例え.テスト), after the ASCII ones so those keep their own bounds.
    // Words written right before such an address are taken with it: over-matching only hides more.
    { kind: 'email', re: /[\p{L}\p{N}\p{M}._%+-]+@[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)+/gu, replace: partialEmail },
    // Long opaque strings mixing letters and digits are session ids or signed parameters.
    { kind: 'secret', re: /(?<![\w-])(?=[\w-]{32,}(?![\w-]))(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]+/g },
    // Digits set apart by spaces, hyphens, dots, tabs or line breaks are still one card number.
    { kind: 'card', re: /(?<!\d)\d(?:[ \t\n.-]?\d){12,18}(?!\d)/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
    // National ids by their form, whatever the field: a US social security number, a Japanese My Number (check digit).
    { kind: 'secret', re: /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g },
    { kind: 'secret', re: /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g, accept: (m) => myNumber(m.replace(/\D/g, '')) },
    { kind: 'phone', re: /(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g, replace: partialPhone },
    { kind: 'phone', re: /\+\d{1,3}[- ]?\d{1,4}[- ]?\d{2,4}[- ]?\d{3,4}(?!\d)/g, replace: partialPhone },
    { kind: 'phone', re: /(?<!\d)0\d{9,10}(?!\d)/g, replace: partialPhone },
    // Dotted: 415.555.2671, +1.415.555.2671 (an IPv4 address has four groups of at most three digits).
    { kind: 'phone', re: /(?<![\d.])(?:\+\d{1,3}\.)?\d{2,4}\.\d{3,4}\.\d{4}(?![\d.])/g, replace: partialPhone },
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

  // Zero-width and bidi controls can hide content from the human reviewer, and split a word (o\u200btp).
  const invisible = (value) => String(value).replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
  /** A name or a word as it is compared: NFKC, without invisible controls. */
  const plain = (value) => invisible(String(value ?? '').normalize('NFKC'));

  function keywordPattern(keywords) {
    const list = (keywords || [])
      .map((k) => plain(k).trim())
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
  const TEXT_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'「」『』（）()、。]+|\b(?:data|javascript|vbscript|mailto|file|blob):[^\s<>"'「」『』（）()、。]+|(?<![\w/:])\/\/(?:[^\s/@<>"']+@)?(?:\[[0-9A-Fa-f:.]+\]|[\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)*)(?::\d+)?(?:[/?#][^\s<>"'「」『』（）()、。]*)?/giu;

  function scrubText(input, opts = {}) {
    const kinds = [];
    if (input == null) return { text: '', kinds };
    let text = String(input).normalize('NFKC');
    // Zero-width and bidi controls can hide content from the human reviewer.
    text = invisible(text);

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

    for (const rule of RULES) {
      text = text.replace(rule.re, (...args) => {
        const match = args[0];
        if (rule.accept && !rule.accept(match)) return match;
        kinds.push(rule.kind);
        return rule.replace ? rule.replace(...args) : mark(rule.kind);
      });
    }

    const keywords = keywordPattern(opts.keywords);
    if (keywords) {
      // Placeholders this filter wrote are left whole: a listed word "secret" must not break [[secret]].
      text = text.split(new RegExp(`(${PLACEHOLDER.source})`)).map((part, i) => (i % 2 ? part : part.replace(keywords, () => {
        kinds.push('keyword');
        return mark('masked');
      }))).join('');
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
  const wordsOf = (key) => plain(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // Latin and other letters written together are separate words: PINコード -> pin コード.
    .replace(/([A-Za-z0-9])([^\x00-\x7f])/g, '$1 $2').replace(/([^\x00-\x7f])([A-Za-z0-9])/g, '$1 $2')
    .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map((w) => JA_WORDS[w] || w)
    .map((w) => (/^\d/.test(w) ? w : w.replace(/\d+$/, ''))).filter(Boolean);

  // Whole words, or (the long ones) inside a word written without separators: newpassword, accesstoken.
  // Japanese words that name the same thing as an English one, so the pairs below apply: PINコード, APIキー.
  const JA_WORDS = { コード: 'code', キー: 'key' };
  const CREDENTIAL_WORDS = new Set(['csrf', 'xsrf', 'pwd', 'pin', 'session', 'sessionid', 'sid', 'otp', 'totp', 'hotp', 'mfa', '2fa', 'passcode', 'bearer', 'cookie']);
  // Ends a word written without separators (newpassword, accesstoken, clientsecret), or starts one for passwords
  // (passwordconfirm). Not inside a longer word: secretary and tokenizer are not credentials.
  const CREDENTIAL_PARTS = /(?:password|passwd|passphrase|secret|token|tokens|credential|credentials|authorization|apikey|accesskey|privatekey)$|^(?:password|passwd|passphrase)|^pass$|^(?:user|login|admin|account|new|old|current|confirm|db)pass$|^(?:verification|verify|confirm|confirmation|auth|access|login|sms|backup|recovery|onetime|otp|mfa|pin)code$/;
  const KEY_OWNERS = ['api', 'access', 'private', 'signing', 'client', 'license', 'secret', 'session', 'auth', 'recovery', 'backup',
    'master', 'encryption', 'shared', 'product', 'activation'];
  // National ids are hidden whole, like credentials: ssn, social security number, マイナンバー.
  const NATIONAL_IDS = /^(?:ssn|sin|nin|itin|mynumber)$/;
  const CODE_OWNERS = ['verification', 'verify', 'confirm', 'confirmation', 'auth', 'authentication', 'access', 'login',
    'sms', 'backup', 'recovery', 'time', 'otp', 'totp', 'hotp', 'mfa', '2fa', 'pin', 'ログイン', '確認', '認証', 'セキュリティ'];
  // Only in URLs and protocol arguments: OAuth and signed-URL parameters. A form field named "state" or "code" is a
  // place or a promotion code, and is kept.
  const PROTOCOL_WORDS = new Set(['auth', 'key', 'code', 'state', 'session', 'sid', 'sig', 'signature', 'nonce', 'ticket', 'pass', 'saml', 'assertion']);
  const JA_CARD = /有効期限|カード番号|セキュリティコード/;
  const JA_SECRET = /暗証|パスワード|(?:認証|確認|ログイン|セキュリティ|バックアップ|リカバリー?)コード|二段階|2段階|ワンタイム|トークン|秘密鍵|シークレット|(?:API|アクセス|プライベート)キー/i;
  // ユーザーID, ログインID, 会員番号: an id named in Japanese (after NFKC, ＩＤ is ID).
  const JA_ID = /[^\x00-\x7f]ID$|(?:会員|顧客|注文|ユーザー|アカウント|管理)番号$/i;
  const JA_EMAIL = /メール/;
  const JA_PHONE = /電話|携帯/;
  // Whole words only: a headphone model is not a phone number.
  const PHONE_WORDS = new Set(['phone', 'tel', 'telephone', 'mobile', 'fax', 'cell', 'cellphone', 'mobilephone', 'phonenumber', 'telno']);
  const ID_WORDS = new Set(['id', 'ids', 'uid', 'uuid', 'guid', 'username', 'userid', 'loginid', 'login', 'account', 'handle', 'nickname']);

  /**
   * card | secret | email | phone | id | null. protocol: the key is a URL parameter or a protocol
   * argument, where a few more words (code, state, session, ...) name credentials.
   */
  function classifyKey(key, { protocol = false } = {}) {
    const text = plain(key || '');
    const words = wordsOf(text);
    if (!words.length) return null;
    const has = (list) => words.some((w) => list.includes(w));
    const pair = (owners, second) => words.some((w, i) => owners.includes(w) && words[i + 1] === second);
    // Any name with card or cc in it (credit_card, cc-name, cardholder): card data is hidden whole.
    // card on its own (card_title) is not card data; with what names a card's data it is (card_number, card holder).
    // Verification values too, by any of their names: cvv2, cv2, cid, cvn, cav2, card verification value.
    if (JA_CARD.test(text) || has(['cc', 'credit', 'cvc', 'cvv', 'csc', 'cv', 'cid', 'cvn', 'cav', 'cvd', 'ccnumber', 'cardnumber', 'creditcard', 'cardholder', 'securitycode', 'cardcode'])
        || pair(['card'], 'holder') || pair(['verification'], 'value') || pair(['card'], 'name') || pair(['card'], 'code') || pair(['card', 'cc'], 'number')
        || pair(['card', 'cc'], 'no') || pair(['card', 'cc'], 'num') || pair(['security'], 'code')
        || words.some((w) => w.startsWith('expir')) || (has(['exp']) && has(['month', 'year', 'date', 'mm', 'yy', 'card', 'cc']))) return 'card';
    if (JA_SECRET.test(text) || /マイナンバー|個人番号/.test(text) || words.some((w) => NATIONAL_IDS.test(w))
        || words.join(' ').includes('social security') || pair(['my'], 'number')
        || words.some((w) => CREDENTIAL_WORDS.has(w) || CREDENTIAL_PARTS.test(w))
        || pair(KEY_OWNERS, 'key') || pair(CODE_OWNERS, 'code') || words.some((w) => /^(?:pass|pwd|otp|pin)$/.test(w) && protocol)
        || (protocol && words.some((w) => PROTOCOL_WORDS.has(w)))) return 'secret';
    if (JA_EMAIL.test(text) || words.some((w) => w.includes('email') || /^mail(?:add?ress|addr)?$/.test(w)) || pair(['e'], 'mail')) return 'email';
    if (JA_PHONE.test(text) || words.some((w) => PHONE_WORDS.has(w))) return 'phone';
    // Bank and document numbers are ids: iban, account number, routing number, passport number.
    if (has(['iban', 'bic', 'swift', 'passport']) || pair(['account', 'bank', 'routing', 'passport', 'member', 'customer', 'order', 'tax'], 'number')
        || /(?:口座|会員|顧客|注文|旅券)番号/.test(text)) return 'id';
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
    const autocomplete = plain(meta.autocomplete || '').toLowerCase();
    if (type === 'hidden') return { kind: 'ignore' };
    // A chosen option is the page's own text (Japan from country_id, Morning from a "session" list): kept, except
    // when the name says card data or a credential (an expiry month, a one-time code chosen from a list).
    const chosen = meta.tag === 'select' || /^(?:select|radio|checkbox|range|color)/.test(type);
    const found = new Set([meta.name, meta.id, meta.label, meta.placeholder, meta.ariaLabel].map((h) => classifyKey(h)));
    if (/\bcc-/.test(autocomplete) || found.has('card')) return { kind: 'secret', label: 'card' };
    // For a chosen option, a name that only says "session" (a meeting's morning session) is not enough.
    const hints = [meta.name, meta.id, meta.label, meta.placeholder, meta.ariaLabel];
    // Only a name that is "session" and nothing else: session_id, session_key and sid are credentials.
    const strong = !chosen || hints.some((h) => classifyKey(h) === 'secret' && wordsOf(h).join(' ') !== 'session');
    if (type === 'password' || SECRET_AUTOCOMPLETE.test(autocomplete) || (found.has('secret') && strong)) return { kind: 'secret', label: 'secret' };
    if (chosen) return { kind: 'choice' };
    if (type === 'email' || /\bemail\b/.test(autocomplete)) return { kind: 'email' };
    if (type === 'tel' || /\btel\b/.test(autocomplete)) return { kind: 'phone' };
    if (/\b(?:username|nickname)\b/.test(autocomplete)) return { kind: 'id' };
    const kind = RANK.find((k) => found.has(k));
    if (kind) return { kind };
    // A search box, known from the page's markup only (type=search, role=searchbox, inside role=search): its words
    // are what a reproduction needs, so they are kept on production too. A field merely named q is free text.
    return { kind: type === 'search' || meta.search ? 'search' : 'text' };
  }

  /** A value whose key or field says what it is (classifyKey's kinds), under the policy for that kind. */
  /**
   * A value this filter already hid: a placeholder, or the shape a partial mask leaves (ab**23, s***@e***.com,
   * ***-****-5678). Trusted only by the final scan (opts.trustHidden), which reads what this filter already wrote;
   * a value from the page is masked whatever it looks like (****123456 typed into a phone field is not trusted).
   */
  const alreadyHidden = (value) => isPlaceholder(value) || /^[^*\s]{0,4}\*+[^*\s]{0,4}$/.test(value)
    || /^[^\s@*]?\*{3}@[^\s@*]?\*{3}(?:\.[^\s@*]+)?$/.test(value) || /^[+\s()*-]*\*[+\d\s()*-]*$/.test(value);

  function maskByKind(kind, text, opts = {}) {
    // A credential is replaced whatever it looks like (ab**cd may be a password); at the exit, only this filter's
    // own placeholder passes again unchanged.
    if (kind === 'secret' || kind === 'card') {
      return opts.trustHidden && isPlaceholder(String(text).trim()) ? { value: text, kinds: [] } : { value: mark(kind), kinds: [kind] };
    }
    if (kind && opts.trustHidden && alreadyHidden(String(text).trim())) return { value: text, kinds: [] };
    const r = scrubText(text, { keywords: opts.keywords, maxLength: opts.maxLength, hosts: opts.hosts });
    // A contact field keeps its value only when the whole of it was recognized as one address or number
    // (and so partly hidden). Nothing recognized in it (someone): partly hidden as a whole. Something else
    // recognized in it (alice@localhost next to an id, words around a credential): hidden entirely.
    // A phone field holding only digits and separators keeps its last four digits, as a phone number does
    // (unless a stronger rule, a card number, found it).
    if (kind === 'phone' && /^[+\d\s().-]+$/.test(text.trim()) && /\d/.test(text) && r.kinds.every((k) => k === 'phone' || k === 'id')) {
      return { value: partialPhone(text.trim()), kinds: ['phone'] };
    }
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
    // On a production host (opts.strict) typed text is kept as its length only.
    if (opts.strict && cls.kind === 'text') return { value: mark(`text:${[...text].length}`), kinds: ['text'] };
    const kind = cls.kind === 'secret' ? cls.label : ['search', 'choice', 'text'].includes(cls.kind) ? null : cls.kind;
    return maskByKind(kind, text, { keywords: opts.keywords, maxLength: 200 });
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
      // On a production host every text argument is kept as its length only: contact details and ids too.
      if (opts.strict && typeof value === 'string' && !(opts.trustHidden && isPlaceholder(value))) {
        return mark(`text:${[...value].length}`);
      }
      const r = maskByKind(meaning, String(value), { keywords: opts.keywords, maxLength: 200, trustHidden: opts.trustHidden });
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

  /** A host as the browser writes it: lowercase, Punycode for other letters (münich.example), no root dot. */
  function canonicalHost(value) {
    const raw = String(value || '').trim().replace(/\.+$/, '');
    if (!raw) return '';
    try { return new URL(`http://${raw}`).hostname.replace(/\.+$/, ''); } catch { return raw.toLowerCase(); }
  }

  /** Whether a host is on a list (exact, or *.example.com for it and its subdomains), both written in any form. */
  function hostAllowed(host, list) {
    const h = canonicalHost(host);
    return (list || []).some((raw) => {
      const p = String(raw).trim();
      if (!p) return false;
      if (p.startsWith('*.')) {
        const base = canonicalHost(p.slice(2));
        return Boolean(base) && (h === base || h.endsWith(`.${base}`));
      }
      return h === canonicalHost(p);
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
    return { hostAllowlist: ctx.hostAllowlist, productionHosts: ctx.productionHosts, aliases: ctx.aliases, trustHidden: ctx.trustHidden, strict: ctx.strict };
  };

  /** Decoded until it no longer changes (at most 3 times): https%253A%252F%252F... is a URL too. See overEncoded. */
  const decodeDeep = (value) => {
    let out = String(value);
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(out); i += 1) {
      let next;
      try { next = decodeURIComponent(out); } catch { break; }
      if (next === out) break;
      out = next;
    }
    return out;
  };
  // Still encoded after decodeDeep (encoded more deeply than is read): hidden whole rather than half read.
  const overEncoded = (value) => {
    const decoded = decodeDeep(value);
    try { return decodeURIComponent(decoded) !== decoded; } catch { return false; }
  };
  // What a production URL keeps of a value or a path segment: short, plain letters and digits.
  const PLAIN = /^[\w.-]{1,24}$/;

  /** One path or fragment segment under the policy. */
  function scrubSegment(segment, ctx, kinds) {
    const decoded = decodeDeep(segment);
    if (ctx.trustHidden && alreadyHidden(decoded.replace(/^@/, ''))) return segment;
    if (overEncoded(segment)) {
      kinds.push('path');
      return mark('v');
    }
    // A card number or a token in a path is hidden whole, before the partial rule for ids could keep part of it.
    const strong = scrubText(decoded, { keywords: ctx.keywords }).kinds.filter((k) => k === 'secret' || k === 'card');
    if (strong.length) {
      kinds.push(...strong);
      return mark(strong.includes('card') ? 'card' : 'secret');
    }
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
    // On production only a short, plain segment is kept (a route word, an id partly hidden as above).
    if (ctx.strict && !PLAIN.test(decoded)) {
      kinds.push('path');
      return mark('v');
    }
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
        const decoded = decodeDeep(v);
        // The key is decoded like the value: %2574oken is token.
        const meaning = classifyKey(decodeDeep(k), { protocol: true }) || (ID_SEGMENT.test(decoded) ? 'id' : null);
        let r;
        if (ctx.trustHidden && isPlaceholder(decoded)) r = { value: decoded, kinds: [] };
        else if (meaning === 'secret' || meaning === 'card') r = maskByKind(meaning, decoded, { trustHidden: ctx.trustHidden });
        // Encoded more deeply than is read, or (on production) anything but a short plain value, whatever its key
        // says (an email address is not plain): hidden whole.
        else if (overEncoded(v) || (ctx.strict && !PLAIN.test(decoded))) r = { value: mark('v'), kinds: ['query'] };
        else r = maskByKind(meaning, decoded, { keywords: ctx.keywords, hosts: hostsOf(ctx), trustHidden: ctx.trustHidden });
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
      // Hidden whole; the kind tells the final scan an unhidden one (ftp://, file://) is there.
      return { url: mark(`url:${url.protocol.replace(':', '')}`), kinds: ['url'] };
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

    // A production URL (its own host is registered, or it was written on a production page: ctx.strict) keeps
    // only short plain values. The same aliases object is shared, so nested hosts get the recording's aliases.
    const strict = Boolean(ctx.strict) || hostAllowed(host, ctx.productionHosts);
    const sctx = { ...ctx, strict };
    const path = url.pathname.split('/').map((seg) => (seg ? scrubSegment(seg, sctx, kinds) : seg)).join('/');

    const params = scrubParams(url.searchParams, sctx, kinds);

    // Fragments are routes (#/orders/123456;view=full): every segment of the route is scrubbed like a path.
    // Parameters (#access_token=..., #/route?code=...) follow the query rules; a URL inside the fragment
    // (#/redirect/https://...?x=1) is read as text, so its host and its own parameters follow the policy.
    // On production only a route (#/settings) and parameters are kept; anything else in a fragment is [[v]].
    let hash = '';
    const fragment = url.hash.slice(1);
    const route = (part) => part.split('/').map((seg) => (seg ? scrubSegment(seg, sctx, kinds) : seg)).join('/');
    const decodedFragment = decodeDeep(fragment);
    const nested = decodedFragment.search(/[a-z][a-z0-9+.-]*:\/\//i);
    if (fragment && (overEncoded(fragment) || (strict && nested >= 0))) {
      kinds.push('query');
      hash = `#${mark('v')}`;
    } else if (nested >= 0) {
      const r = scrubText(decodedFragment.slice(nested), { keywords: ctx.keywords, hosts: hostsOf(sctx) });
      kinds.push(...r.kinds);
      hash = `#${route(decodedFragment.slice(0, nested))}${r.text}`;
    } else if (decodedFragment.includes('?')) {
      // Judged on the decoded fragment: #/route%3Fcode%3Dabc is a route with parameters too.
      const at = decodedFragment.indexOf('?');
      hash = `#${route(decodedFragment.slice(0, at))}?${scrubParams(new URLSearchParams(decodedFragment.slice(at + 1)), sctx, kinds).join('&')}`;
    } else if (/^[^/]*=/.test(decodedFragment)) {
      hash = `#${scrubParams(new URLSearchParams(decodedFragment), sctx, kinds).join('&')}`;
    } else if (strict && fragment && !decodedFragment.startsWith('/') && !(sctx.trustHidden && isPlaceholder(decodedFragment))) {
      kinds.push('query');
      hash = `#${mark('v')}`;
    } else if (fragment) {
      hash = `#${route(fragment)}`;
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
      // Any other [[...]] is the page's text: read without its brackets (password=[[hunter2]]), and also taken out
      // (Ac[[foo]]me), so it can neither hide its content nor split a word.
      const opened = String(text).replace(/\[\[([^\]]*)\]\]/g, (m, inner) => (isPlaceholder(m) ? m : inner));
      const kinds = [opened.replace(PLACEHOLDER, ' '), opened.replace(PLACEHOLDER, ''), String(text).replace(/\[\[[^\]]*\]\]/g, '')]
        .flatMap((t) => scrubText(t, { keywords: opts.keywords }).kinds);
      if (kinds.length) findings.push({ path: path || '(root)', kinds: [...new Set(kinds)] });
    };
    const credential = (key, options) => ['secret', 'card'].includes(classifyKey(key, options));
    // URLs written in the text (an edited ?code=abc123, /orders/123456): whatever scrubUrl would still hide,
    // except the host, which only the recording can place (its aliases are scanned as keywords).
    const aliasNames = (raw) => {
      if (Array.isArray(opts.aliases)) return opts.aliases;
      // Every host in this URL that has the form of an alias.
      return (raw.match(/\bsite-\d+\.invalid\b/gi) || []).map((h) => h.toLowerCase());
    };
    // strictUrls: inside a step recorded on production, URLs must also pass the production rules unchanged.
    const urlParams = (text, path, strictUrls = false) => {
      for (const match of String(text).match(TEXT_URL) || []) {
        const relative = match.startsWith('//');
        const raw = relative ? `https:${match}` : match;
        // Hosts, nested ones too, when the caller knows the allowlist: allowed, or an alias this filter wrote
        // (opts.aliases: the recording's alias names; without them, the form site-N.invalid).
        const known = Array.isArray(opts.hostAllowlist);
        const kinds = scrubUrl(raw, { hostAllowlist: known ? [...opts.hostAllowlist, ...aliasNames(raw)] : [], keywords: opts.keywords, trustHidden: true, strict: strictUrls })
          .kinds.filter((kind) => known || kind !== 'host');
        if (kinds.length) {
          findings.push({ path: path || '(root)', kinds: [...new Set(kinds)] });
          return;
        }
      }
      // A path or a query written on its own (/orders/123456, ./callback?code=abc, ../orders/1, callback?code=abc,
      // ?code=abc): resolved against a placeholder base and read like any URL.
      const RELATIVE = /(?<![\w:/.@%-])(?:\.{1,2}\/|\/(?!\/))[^\s"'<>「」『』（）()、。]*|(?<![\w/.%-])(?:[\w.-]+)?\?[\w.-]+=[^\s"'<>「」『』（）()、。]*/g;
      for (const match of String(text).replace(TEXT_URL, ' ').match(RELATIVE) || []) {
        let resolved;
        try { resolved = new URL(match, 'https://relative.invalid/base/').href; } catch { continue; }
        const kinds = scrubUrl(resolved,
          { hostAllowlist: ['relative.invalid'], keywords: opts.keywords, trustHidden: true, strict: strictUrls }).kinds.filter((kind) => kind !== 'host');
        if (kinds.length) {
          findings.push({ path: path || '(root)', kinds: [...new Set(kinds)] });
          return;
        }
      }
    };
    // under: the credential kind of a key above, which covers everything nested in it.
    // args: inside WebMCP arguments, where keys are protocol keys (code, state) as in maskArgs.
    // namedUnder: the contact or id kind of an argument key above ({ user_id: { value: ... } }), as maskArgs carries it.
    // commercial: inside a step recorded on a production host (privacy.profile === 'commercial').
    const walk = (v, path, key = '', under = null, args = false, namedUnder = null, commercial = false) => {
      // Counts of what this filter hid, keyed by kind (secret: 2): not values. Only the recording's own, only numbers.
      if (/^(?:recording\.)?privacy\.redactions$/.test(path) && v && typeof v === 'object' && !Array.isArray(v)
          && Object.entries(v).every(([k, n]) => /^[a-z]{1,16}$/.test(k) && Number.isInteger(n) && n >= 0 && n < 1e6)) return undefined;
      const inArgs = args || key === 'args';
      const kind = under || (key && credential(key, { protocol: args }) ? classifyKey(key, { protocol: args }) : null);
      // In WebMCP arguments, a contact or id key's value must be one this filter already hid (a***@e***.com, ab**23).
      const named = (args && key ? classifyKey(key, { protocol: true }) : null) || namedUnder;
      if (!kind && ['email', 'phone', 'id'].includes(named) && (typeof v === 'number' || typeof v === 'string')
          && String(v).trim() && !alreadyHidden(String(v).trim())) {
        findings.push({ path: path || '(root)', kinds: [named] });
      }
      // A value under a key naming a credential is one, unless it is only a placeholder of this filter.
      if (kind && (typeof v === 'number' || (typeof v === 'string' && v.replace(PLACEHOLDER, '').trim()))) {
        findings.push({ path: path || '(root)', kinds: [kind] });
      }
      // On production a text argument is only its length: anything else left in WebMCP arguments is a value.
      // (array items too, which have no key of their own).
      if (commercial && inArgs && key !== 'args' && typeof v === 'string' && v && !isPlaceholder(v)) {
        findings.push({ path: path || '(root)', kinds: ['text'] });
      }
      if (typeof v === 'string') {
        urlParams(v, path, commercial);
        return check(v, path);
      }
      const carried = ['email', 'phone', 'id'].includes(named) ? named : null;
      if (Array.isArray(v)) return v.forEach((item, i) => walk(item, `${path}[${i}]`, '', kind, inArgs, carried, commercial));
      if (v && typeof v === 'object') {
        // A step recorded on production: a typed value must be only its length unless it was a search box or a
        // chosen option (valueClass), or a contact or id field's partial mask.
        const onProduction = commercial || v.privacy?.profile === 'commercial';
        // A value from a credential or card field is only ever a placeholder, on any host; one from a contact or id
        // field is a placeholder or a partial mask.
        if (['secret', 'card'].includes(v.valueClass) && typeof v.value === 'string' && v.value && !isPlaceholder(v.value)) {
          findings.push({ path: path ? `${path}.value` : 'value', kinds: [v.valueClass] });
        }
        if (['email', 'phone', 'id'].includes(v.valueClass) && typeof v.value === 'string' && v.value.trim() && !alreadyHidden(v.value.trim())) {
          findings.push({ path: path ? `${path}.value` : 'value', kinds: [v.valueClass] });
        }
        if (v.privacy?.profile === 'commercial' && typeof v.value === 'string' && v.value
            && !['search', 'choice'].includes(v.valueClass) && !isPlaceholder(v.value) && !alreadyHidden(v.value.trim())) {
          findings.push({ path: path ? `${path}.value` : 'value', kinds: ['text'] });
        }
        for (const [k, item] of Object.entries(v)) {
          check(k, `${path}{key}`);
          urlParams(k, `${path}{key}`, onProduction);
          walk(item, path ? `${path}.${k}` : k, k, kind, inArgs, carried, onProduction);
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
    maskByKind,
    maskArgs,
    scrubUrl,
    hostAllowed,
    isPlaceholder,
    aliasedHosts,
    finalScan
  };

  root.OpScribeSanitize = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
