// Property (ADR 0002, measure 5): whatever the page sends, the masking makes a
// payload the independent check accepts. The review of #22 found, one round at
// a time, values the masking produced and the check refused (lengths, ranges,
// start URL); this walks many generated inputs through the same path instead.
// Inputs are generated from a fixed seed so a failure can be replayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const R = require('../shared/record.js');
const D = require('../shared/describe.js');
const P = require('../shared/payload.js');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const settings = { keywords: ['Acme', 'Brand'], commercialHosts: ['shop.example.com'], hostAllowlist: ['beta.example.com'] };
const PIECES = ['a', 'Z', '0', '9', ' ', '\n', '\t', '[[', ']]', '[', '|', '\\', '"', '%', '%2', '#', '?', '&', '=', '/', '@',
  '.', '-', '_', 'あ', '漢', '🙂', '\u200B', '\u2028', 'Acme', 'brand', 'token', 'password', 'email', '__proto__', 'constructor',
  'user@example.com', '090-1234-5678', '[[secret]]', '[[url:none]]', '…'];

function gen(seed) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const int = (n) => Math.floor(r() * n);
  const text = (max = 60) => {
    const long = r() < 0.1 ? 600 : max;
    let s = '';
    for (let i = int(long); i > 0; i -= 1) s += pick(PIECES);
    return s;
  };
  const url = () => {
    if (r() < 0.1) return text(20);
    const scheme = pick(['https:', 'http:', 'https:', 'javascript:', 'ftp:', 'data:']);
    const host = pick(['shop.example.com', 'beta.example.com', 'other.invalid', 'xn--r8jz45g.invalid', ['name:pw', 'shop.example.com'].join('@')]);
    const path = Array.from({ length: int(r() < 0.05 ? 400 : 5) }, () => encodeURIComponent(text(8))).join('/');
    const query = Array.from({ length: int(4) }, () => `${encodeURIComponent(text(6))}=${encodeURIComponent(text(30))}`).join('&');
    const hash = r() < 0.5 ? '' : pick(['#/settings', `#${encodeURIComponent(text(10))}`, '#/a/b-c', '#/orders/123456/x', '#/Acme/x', '#/a//b']);
    return `${scheme}//${host}/${path}${query ? `?${query}` : ''}${hash}`;
  };
  const meta = () => ({
    tag: pick(['input', 'textarea', 'select', 'div']),
    type: pick(['', 'text', 'search', 'email', 'tel', 'password', 'hidden', 'checkbox', 'number', text(5)]),
    name: pick(['q', 'comment', 'email', 'Password', 'card_number', 'first_name', text(10)]),
    autocomplete: pick(['', 'off', 'email', 'one-time-code', 'cc-number', text(5)]),
    label: text(30),
    role: pick([null, 'searchbox', 'textbox', text(5)]),
    inSearch: r() < 0.2
  });
  const args = (depth = 0) => {
    const roll = r();
    if (depth > 4 || roll < 0.3) return pick([text(), int(1e9) * pick([1, -1, 1e-3]), true, null, 1e100, NaN]);
    // Over the limits (10 items, 20 keys) now and then, small otherwise, so the tree stays small.
    const size = (over) => (r() < 0.1 ? over : int(4));
    if (roll < 0.5) return Array.from({ length: size(14) }, () => args(depth + 1));
    const out = {};
    for (let i = size(24); i > 0; i -= 1) Object.defineProperty(out, pick([text(50), 'password', 'email', 'Acme1', 'Acme2', 'q', '__proto__', 'masked-1', `${'k'.repeat(45)}a`, `${'k'.repeat(45)}b`, `${'k'.repeat(40)}`]), { value: args(depth + 1), enumerable: true, configurable: true });
    return out;
  };
  return { r, pick, int, text, url, meta, args };
}

test('every payload built from generated page input passes the independent check', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const g = gen(seed);
    const rec = { id: `rec-p${seed}`, startedAt: Date.now() - 1000, endedAt: null, aliases: {}, redactions: {}, webmcpTools: {}, steps: [],
      policy: R.policyOf(settings) };
    const firstUrl = g.url();
    rec.startUrl = S.scrubUrl(firstUrl, { ...rec.policy, aliases: rec.aliases, env: R.envOf([firstUrl], rec.policy) }).url;
    for (let i = g.int(25); i >= 0; i -= 1) {
      const tabUrl = g.pick([g.url(), 'https://shop.example.com/x', 'https://beta.example.com/y']);
      const env = { env: R.envOf([tabUrl], rec.policy), keywords: settings.keywords };
      const type = g.pick(['navigate', 'click', 'input', 'select', 'check', 'upload', 'key', 'submit', 'tool', 'note', 'scroll']);
      const meta = g.meta();
      const masked = S.maskFieldValue(g.text(), meta, env);
      const raw = {
        type,
        pageUrl: g.r() < 0.9 ? g.url() : undefined,
        target: g.r() < 0.8 ? { role: g.pick(['button', 'link', g.text(5)]), tag: g.pick(['a', 'button', g.text(4)]), name: g.text(300), selector: g.text(200), href: g.url() } : undefined,
        value: type === 'upload' ? S.typed.file(g.int(5)) : masked?.value,
        field: meta,
        checked: g.r() < 0.5,
        key: g.pick(['Enter', 'Escape', 'meta+Enter', 'ctrl+alt+Enter', 'shift+Escape', 'a', undefined]),
        tool: g.text(100),
        args: S.maskArgs(g.args(), env),
        note: g.text(400),
        source: g.pick(['user', 'agent', 'page'])
      };
      const from = type === 'note' && g.r() < 0.5 ? {} : { tabUrl };
      const step = R.cleanStep(raw, rec, settings, from);
      // What the content script makes for a field, the worker never drops (rows I1-I8; review R20).
      const routed = (type === 'select') === (meta.tag === 'select') && !['file', 'checkbox', 'radio'].includes(String(meta.type).toLowerCase());
      if ((type === 'input' || type === 'select') && masked && routed) assert.ok(step, `seed ${seed}: ${JSON.stringify(meta)}`);
      if (step) rec.steps.push(step);
    }
    // Deleting steps (including the first) must not break the payload either.
    if (rec.steps.length && g.r() < 0.3) rec.steps.splice(g.int(rec.steps.length), 1);
    rec.webmcpTools['https://site-1.invalid'] = Array.from({ length: g.int(60) }, () => S.scrubText(R.oneLine(g.text(120)), { maxLength: 80 }).runs).slice(0, 50);
    const payload = P.buildPayload(rec, { generator: 'manual', markdown: D.toMarkdown(D.buildReproduction(rec)) }, { browser: S.cleanLine(g.text(100), { keywords: settings.keywords, maxLength: 60 }).runs, language: ['ja'] });
    const problems = P.checkPayload(JSON.parse(JSON.stringify(payload)));
    assert.deepEqual(problems, [], `seed ${seed}: ${JSON.stringify(problems.slice(0, 3))}`);
    // No string of the recording holds a placeholder: a masked part is a part, never text (#28).
    const strings = [];
    const collect = (v) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { strings.push(k); collect(x); });
    };
    collect(payload.recording);
    assert.deepEqual(strings.filter((x) => x.includes('[[')), [], `seed ${seed}`);
    // The Markdown made from it is all ‹…› labels (E4, #28).
    assert.ok(!/\[\[[a-z]+(?::[^\]]*)?\]\]/.test(payload.reproduction.markdown), `seed ${seed}: markdown`);
    // And in the form the masking writes (E8): the producer has not drifted.
    const drift = P.checkCanonical(payload);
    assert.deepEqual(drift, [], `seed ${seed}: ${JSON.stringify(drift.slice(0, 3))}`);
  }
});
