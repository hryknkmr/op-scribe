/**
 * op-scribe - ISOLATED world recorder.
 *
 * Injected only into origins the user granted when starting a recording.
 * Listens to trusted (human) events in the capture phase and reports each
 * step to the service worker. Form values are masked HERE, so text that must
 * not be kept never leaves the page.
 *
 * Also relays between the MAIN world WebMCP script (content/webmcp-tools.js)
 * and the service worker, since MAIN world code cannot reach chrome.*.
 */
(() => {
  'use strict';

  if (globalThis.__opScribeRecorder) {
    // Re-injected for a new recording: just ask the worker again.
    globalThis.__opScribeRecorder.hello();
    return;
  }

  const S = globalThis.OpScribeSanitize;
  const FROM = 'op-scribe/content';
  const MAIN = 'op-scribe/main';
  const ISO = 'op-scribe/iso';
  // The worker may be waking up or the page may be navigating; retry briefly.
  const TRANSIENT = /Receiving end does not exist|message port closed/i;

  /** { keywords } while this tab is being recorded, otherwise null. */
  let config = null;
  let lastStep = null;
  let sequence = 0;
  const documentId = Math.random().toString(36).slice(2, 8);
  /** Who performed the event being handled: user | automation | script. */
  let actor = 'user';
  const committed = new WeakMap();

  async function send(type, detail, attempt = 0) {
    try {
      return await chrome.runtime.sendMessage({ from: FROM, type, detail });
    } catch (error) {
      const text = String(error?.message || error);
      if (TRANSIENT.test(text) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        return send(type, detail, attempt + 1);
      }
      if (/Extension context invalidated/i.test(text)) config = null;
      return null;
    }
  }

  async function hello() {
    const response = await send('HELLO');
    config = response?.active ? response.config : null;
    if (config) {
      window.postMessage({ source: ISO, type: 'ANNOUNCE' }, location.origin);
      screenKey = '';
      scheduleScreen();
    }
  }

  // ---------------------------------------------------------------- targets

  const INTERACTIVE = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="option"]', '[role="combobox"]', '[role="treeitem"]',
    '[contenteditable=""]', '[contenteditable="true"]'
  ].join(',');
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'tel', 'url', 'password', 'number',
    'date', 'datetime-local', 'month', 'week', 'time']);
  const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];
  const GENERATED_ID = /\d{3,}|[0-9a-f]{8,}|^:|:$/i;

  const asElement = (node) => (node instanceof Element ? node : node?.parentElement || null);
  const resolveTarget = (node) => {
    const el = asElement(node);
    return el ? el.closest(INTERACTIVE) || el : null;
  };
  const isTextField = (el) => (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(el.type))
    || el.tagName === 'TEXTAREA' || el.isContentEditable
    || ['textbox', 'searchbox'].includes(el.getAttribute('role'));
  const isToggle = (el) => el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button':
      case 'summary': return 'button';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return 'img';
      case 'input': {
        const type = el.type || 'text';
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'range') return 'slider';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      default:
        if (el.isContentEditable) return 'textbox';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        return tag;
    }
  }

  const textOf = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  // Masked first, then cut: a cut through an address or a token would hide it from the patterns.
  const clip = (text, n) => S.scrubText(String(text || ''), { keywords: config?.keywords }).text.slice(0, n);

  /** A label's own words: a label wrapping its control would otherwise also yield the control's options or text. */
  function labelText(label) {
    if (!label.querySelector('select, input, textarea, button, [contenteditable="true"]')) return textOf(label);
    const copy = label.cloneNode(true);
    copy.querySelectorAll('select, input, textarea, button, [contenteditable="true"]').forEach((c) => c.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Approximates the accessible name. Never reads the content of a field the
   * user types into - that is a value, not a name.
   */
  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map(textOf).join(' ');
      if (text) return text;
    }
    if (el.labels?.length) {
      const text = [...el.labels].map(labelText).join(' ');
      if (text) return text;
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return el.value || el.type;
    if (el.tagName === 'IMG') return el.alt || '';
    if (el.matches('input, textarea, select') || isTextField(el) || implicitRole(el) === 'combobox') {
      return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    }
    const inner = textOf(el);
    if (inner) return inner;
    return el.querySelector('img[alt]')?.alt || el.getAttribute('title') || '';
  }

  function selectorFor(el) {
    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) return `[${attr}="${CSS.escape(value)}"]`;
    }
    if (el.id && !GENERATED_ID.test(el.id)) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      if (node !== el && node.id && !GENERATED_ID.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  // ------------------------------------------------------- screen and parts

  // What counts as shown: painted (not display:none, hidden or transparent, here or above), larger than a
  // point (not text for screen readers only), and where a person can bring it into view - by scrolling the
  // page or a scrolling area (overflow: auto/scroll), not past an area that cuts it off (overflow: hidden/clip),
  // and, for a fixed element that never scrolls, inside the screen. Covering by other elements is not judged.

  const PAINTED = { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true };
  const SCROLLS = /^(auto|scroll)$/;
  const CUTS = /^(hidden|clip)$/;
  const AXES = [['X', 'left', 'right', 'scrollLeft', 'scrollWidth'], ['Y', 'top', 'bottom', 'scrollTop', 'scrollHeight']];

  /** The padding box of an element: where its content shows, and what an overflow setting clips to. */
  const paddingBox = (el) => {
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft;
    const top = r.top + el.clientTop;
    return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
  };

  /**
   * Whether a box (viewport coordinates) inside `from` can be brought into view. Each axis is judged on its own.
   * memo: element -> computed style, shared within one reading.
   */
  function reachable(from, rect, memo = new Map()) {
    const style = (el) => {
      if (!memo.has(el)) memo.set(el, getComputedStyle(el));
      return memo.get(el);
    };
    let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const root = document.documentElement;
    let fixed = false;
    for (let el = from; el && el !== root && el !== document.body; el = el.parentElement) {
      const st = style(el);
      // Effects whose visible area is not computed here: not read rather than guessed.
      if (st.clipPath !== 'none' || (st.maskImage && st.maskImage !== 'none')) return false;
      if ((st.position === 'absolute' || st.position === 'fixed') && st.clip && st.clip !== 'auto') return false;
      let inner = null;
      for (const [axis, lo, hi, offset, size] of AXES) {
        const overflow = st[`overflow${axis}`];
        if (overflow === 'visible') continue;
        inner ||= paddingBox(el);
        if (CUTS.test(overflow)) {
          if (box[lo] < inner[lo] - 0.5 || box[hi] > inner[hi] + 0.5) return false;
        } else if (SCROLLS.test(overflow)) {
          // Somewhere in the scrolled content: in view once the area is scrolled there. Seen from further
          // out, it is then where the area is.
          const start = box[lo] - inner[lo] + el[offset];
          if (start + (box[hi] - box[lo]) <= 0 || start >= el[size]) return false;
          box = { ...box, [lo]: inner[lo], [hi]: inner[hi] };
        }
      }
      if (st.position === 'fixed') { fixed = true; break; }
    }
    const page = document.scrollingElement || root;
    const pageStyle = style(root);
    const bodyStyle = document.body ? style(document.body) : pageStyle;
    for (const [axis, lo, hi, scroll, size, view] of [['X', 'left', 'right', scrollX, 'scrollWidth', innerWidth], ['Y', 'top', 'bottom', scrollY, 'scrollHeight', innerHeight]]) {
      const locked = CUTS.test(pageStyle[`overflow${axis}`]) || CUTS.test(bodyStyle[`overflow${axis}`]);
      if (fixed || locked) {
        if (box[hi] <= 0 || box[lo] >= view) return false;
      } else if (box[hi] + scroll <= 0 || box[lo] + scroll >= page[size]) return false;
    }
    return true;
  }

  /** An element shown to the person (see above); sized: false for one that may have been emptied. */
  // Also used as a filter callback ((el, index, array)): anything but an options object and a Map is ignored.
  const visible = (el, options, memo) => {
    const sized = !(options && typeof options === 'object' && !Array.isArray(options) && options.sized === false);
    if (!(memo instanceof Map)) memo = undefined;
    if (!el?.getClientRects().length) return false;
    if (el.checkVisibility && !el.checkVisibility(PAINTED)) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    if (sized && !(rect.width > 1 && rect.height > 1)) return false;
    // The element's own overflow clips what is inside it, not itself: judged from its parent up.
    return !el.parentElement || reachable(el.parentElement, rect, memo);
  };

  // Text nodes inside these are not screen text: code, a closed box's other choices, typed values.
  const NOT_TEXT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SELECT', 'DATALIST', 'TEXTAREA', 'OPTION']);
  const INLINE = /^(inline|inline-block|inline-flex|inline-grid|contents|ruby|ruby-text)$/;

  /**
   * Reads only text that can be seen, one text node at a time: the characters' own boxes must all be
   * shown and reachable. Stops for good at the deadline (fail-closed: nothing after that point is read).
   * claimed: text nodes already given to a unit, so each is read once, by the most specific unit.
   */
  function textReader({ ms = 150 } = {}) {
    const deadline = performance.now() + ms;
    const memo = new Map();
    const verdict = new Map();
    const claimed = new Set();
    const reader = { cut: false };
    const style = (el) => {
      if (!memo.has(el)) memo.set(el, getComputedStyle(el));
      return memo.get(el);
    };
    const blockOf = (el) => {
      for (let node = el; node; node = node.parentElement) {
        if (node.tagName === 'BODY' || !INLINE.test(style(node).display)) return node;
      }
      return null;
    };
    const painted = (el) => {
      for (let node = el; node; node = node.parentElement) {
        // display: contents has no box of its own: what it shows is judged by the ancestor that has one.
        if (style(node).display !== 'contents') {
          return !node.checkVisibility || node.checkVisibility(PAINTED);
        }
      }
      return false;
    };
    const shown = (node) => {
      if (verdict.has(node)) return verdict.get(node);
      const parent = node.parentElement;
      let ok = Boolean(parent) && painted(parent);
      if (ok) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
        ok = rects.length > 0 && rects.every((r) => r.width > 1 && r.height > 1 && reachable(parent, r, memo));
      }
      verdict.set(node, ok);
      return ok;
    };
    /** The shown lines under a node (an element or a text node), in page order. */
    reader.lines = (start, { claim = false } = {}) => {
      const lines = [];
      let line = '';
      let block = null;
      const flush = () => {
        const text = line.replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
        line = '';
      };
      const take = (node) => {
        if (claimed.has(node) || !node.textContent.trim()) return;
        if (!shown(node)) return;
        const nodeBlock = blockOf(node.parentElement);
        if (nodeBlock !== block) { flush(); block = nodeBlock; }
        line += node.textContent;
        if (claim) claimed.add(node);
      };
      if (reader.cut) return lines;
      if (start.nodeType === 3) {
        take(start);
        flush();
        return lines;
      }
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        // Not rendered at all (display: none, content-visibility: hidden): nothing inside can show.
        acceptNode: (node) => (node.nodeType === 1 && (NOT_TEXT.has(node.tagName)
          || (node.checkVisibility && !node.checkVisibility() && style(node).display !== 'contents'))
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
      });
      for (let node = walker.currentNode; node; node = walker.nextNode()) {
        if (performance.now() > deadline) { reader.cut = true; break; }
        if (node.nodeType === 3) take(node);
        else if (node.tagName === 'BR') flush();
      }
      flush();
      return lines;
    };
    return reader;
  }

  const unique = (list) => [...new Set(list.filter(Boolean))];
  const CHROME_REGION = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';

  /** Name of a region: aria-label, aria-labelledby, or its first heading. */
  function regionName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return clip(aria.trim(), 30);
    const by = el.getAttribute('aria-labelledby');
    const labelled = by && document.getElementById(by.split(/\s+/)[0]);
    if (labelled) return clip(textOf(labelled), 30);
    const heading = el.querySelector('legend, h1, h2, h3, h4');
    return heading ? clip(textOf(heading), 30) : '';
  }

  function isSearchForm(form) {
    if (form.getAttribute('role') === 'search' || form.closest('[role="search"]')) return true;
    if (/search/i.test(form.getAttribute('action') || '')) return true;
    return [...form.querySelectorAll('input')].some((input) => input.type === 'search'
      || /^(q|query|keyword|keywords|search)$/i.test(input.getAttribute('name') || ''));
  }

  /**
   * Links rendered by the same component share their markup; that signature
   * is how a list of cards is told apart from one-off links.
   */
  const linkSignature = (a) => `${a.className}|${a.parentElement?.tagName}.${a.parentElement?.className}`;

  function contentLinks() {
    return [...document.querySelectorAll('a[href]')].filter((a) => !a.closest(CHROME_REGION) && visible(a));
  }

  /**
   * A button named by content rather than by the UI: inside a list item, card or article, one of a
   * row of look-alike buttons (cards as buttons), or with a name longer than a label (a whole card).
   */
  function isContentButton(button) {
    if (button.closest('li, article, [role="listitem"], [role="article"], [role="row"]')) return true;
    if ((accessibleName(button) || '').length > 40) return true;
    const parent = button.parentElement;
    if (!parent || !button.className) return false;
    return [...parent.children].filter((c) => c.tagName === button.tagName && c.className === button.className).length >= 3;
  }

  /**
   * Articles repeated side by side in one container are cards, not an article to read; a main article
   * with a row of related cards keeps its body. Each card may sit in its own wrapper (<div><article>).
   */
  const CARDS_AT = 3;
  function articlesIn(root) {
    const articles = [...root.querySelectorAll('article, [role="article"]')].filter((a) => visible(a));
    const rowOf = (a) => {
      let node = a;
      for (let i = 0; i < 3 && node.parentElement && node.parentElement.children.length === 1; i += 1) node = node.parentElement;
      return node.parentElement;
    };
    const rows = new Map();
    for (const a of articles) rows.set(rowOf(a), (rows.get(rowOf(a)) || 0) + 1);
    const cards = new Set(articles.filter((a) => rows.get(rowOf(a)) >= CARDS_AT));
    return { cards, main: articles.filter((a) => !cards.has(a)) };
  }

  /** Text written as paragraphs (an article body), not the text of cards, links or list items. */
  function proseLength(root) {
    const { cards } = articlesIn(root);
    let total = 0;
    for (const p of root.querySelectorAll('p')) {
      if (p.closest('a, li, nav, header, footer, [role="navigation"]') || !visible(p)) continue;
      const card = p.closest('article, [role="article"]');
      if (card && cards.has(card)) continue;
      total += textOf(p).length;
      if (total > 100000) break;
    }
    return total;
  }

  function repeatedGroup() {
    const groups = new Map();
    for (const a of contentLinks()) {
      const key = linkSignature(a);
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(a.href);
    }
    let best = 0;
    for (const hrefs of groups.values()) best = Math.max(best, hrefs.size);
    return best >= 5 ? { count: best } : null;
  }

  /**
   * Everything the side panel needs to say what this screen is and what it
   * is for. Labels only - never field values, never body text.
   */
  function extractScreen() {
    const collected = [...document.querySelectorAll('form, [role="search"]')].filter(visible);
    const forms = collected
      .filter((el) => !collected.some((other) => other !== el && other.contains(el)))
      .slice(0, 6)
      .map((el) => {
        const fields = [...el.querySelectorAll('input, select, textarea')]
          .filter((f) => f.type !== 'hidden' && f.type !== 'submit' && f.type !== 'button' && visible(f))
          .slice(0, 12)
          .map((f) => ({ type: f.tagName === 'INPUT' ? (f.type || 'text') : f.tagName.toLowerCase(), label: clip(accessibleName(f), 30) }));
        const submit = el.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        return {
          kind: isSearchForm(el) ? 'search' : 'form',
          // In the header or navigation: there on every page of the site, not what this page is for.
          global: Boolean(el.closest(CHROME_REGION)),
          name: regionName(el),
          fields,
          submit: submit ? clip(accessibleName(submit), 30) : ''
        };
      })
      .filter((form) => form.fields.length);

    const buttons = unique([...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .filter((b) => visible(b) && !b.closest('[contenteditable="true"]') && !isContentButton(b))
      .map((b) => clip(accessibleName(b), 30)))
      .slice(0, 15);
    const navLinks = unique([...document.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href]')]
      .filter(visible)
      .map((a) => clip(accessibleName(a), 20)))
      .slice(0, 10);
    // Section names only. Headings in an article, an editor, a card (inside or around a
    // link) or a list item are content - other people's titles - not part of the UI.
    const headings = unique([...document.querySelectorAll('h2, h3')]
      .filter((h) => visible(h) && !h.closest('article, [contenteditable="true"], a, li') && !h.querySelector('a'))
      .map((h) => clip(textOf(h), 30)))
      .slice(0, 6);
    const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')]
      .filter(visible).map(regionName).slice(0, 3);
    const editor = [...document.querySelectorAll('[contenteditable="true"], textarea')]
      .some((el) => visible(el) && el.getBoundingClientRect().height > 120);
    const h1 = [...document.querySelectorAll('h1')].find(visible);
    const main = document.querySelector('main, [role="main"]') || document.body;
    const articles = articlesIn(main).main.length;

    return {
      url: location.href,
      title: clip(document.title, 120),
      h1: h1 ? clip(textOf(h1), 80) : '',
      lang: document.documentElement.lang || '',
      forms,
      buttons,
      navLinks,
      headings,
      dialogs,
      editor,
      article: articles > 0 && (main.innerText || '').length > 800,
      textLength: (main.innerText || '').length,
      prose: proseLength(main),
      tables: [...document.querySelectorAll('table')].filter(visible).length,
      links: contentLinks().length,
      repeated: repeatedGroup()
    };
  }

  // ------------------------------------------------------------------ units

  const MAX_UNIT_CHARS = 40000;  // a whole screen; infinite feeds are cut here
  const MAX_LINE = 400;

  /**
   * Links laid out side by side with no text between them come out of innerText as one word
   * ("タスクレポート設定ヘルプ"). A line that is exactly a run of such links is given back
   * as the separate items, so the reader does not take it for one long link name.
   */
  function splitGluedLinks(el, lines) {
    const items = [...el.querySelectorAll('a, button')].slice(0, 400).map(textOf).filter(Boolean);
    if (items.length < 2) return lines;
    return lines.map((line) => {
      if (line.length > 200 || line.includes(' ')) return line;
      for (let i = 0; i < items.length - 1; i += 1) {
        let joined = '';
        for (let j = i; j < items.length && joined.length < line.length; j += 1) {
          joined += items[j];
          if (joined === line && j > i) return items.slice(i, j + 1).join(' / ');
        }
      }
      return line;
    });
  }

  /**
   * The screen as units (see shared/units.js): every visible line of text,
   * each claimed by the first - most specific - unit that contains it.
   * Only lines are read, never field values; credentials and partial ids are
   * masked before anything leaves the page.
   */
  function extractUnits() {
    const units = [];
    let order = 0;
    let budget = MAX_UNIT_CHARS;
    // Each text node goes to the first unit that reads it, so the same words in two places are both kept.
    const reader = textReader();
    const memo = new Map();
    const linesOf = (el) => splitGluedLinks(el, reader.lines(el, { claim: true }));
    const push = (kind, name, el, extra = {}) => {
      if (budget <= 0) return;
      const lines = Array.isArray(el) ? el : linesOf(el);
      if (!lines.length) return;
      const text = lines.map((l) => clip(l, MAX_LINE)).join('\n').slice(0, budget);
      budget -= text.length;
      units.push({ kind, name: clip(name, 60), text, order: order++, ...extra });
    };
    const all = (selector) => [...document.querySelectorAll(selector)].filter((el) => visible(el, {}, memo));

    const h1 = all('h1')[0];
    // Under the URL policy first (ids and @handles partly hidden, like every recorded URL),
    // then decoded so the model can read it (/wiki/%E3%83%A1... -> /wiki/メインページ).
    let path = '';
    try { path = new URL(S.scrubUrl(location.href, { keywords: config?.keywords }).url).pathname; } catch { /* not a web page */ }
    try { path = decodeURIComponent(path); } catch { /* malformed: keep as is */ }
    push('page', '', [`タイトル: ${document.title}`, h1 ? `主見出し: ${textOf(h1)}` : '', `パス: ${path}`].filter(Boolean));
    for (const el of all('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]')) push('feedback', '', el);
    for (const el of all('dialog[open], [role="dialog"], [aria-modal="true"]')) push('dialog', regionName(el), el);
    for (const form of all('form, [role="search"]')) {
      // Labels, field types and choices - what the form asks for, not what was typed.
      const fields = [...form.querySelectorAll('input, select, textarea')]
        .filter((f) => f.type !== 'hidden' && visible(f))
        .map((f) => {
          // Only the choice shown in the closed box, masked like any field value; the others are not on screen.
          const chosen = f.tagName === 'SELECT' && f.selectedOptions[0]
            ? S.maskFieldValue(f.selectedOptions[0].text.trim(), fieldMeta(f), config)?.value : '';
          const options = chosen ? `（表示中の選択: ${chosen}）` : '';
          return `${accessibleName(f) || '(無名)'} [${f.type || f.tagName.toLowerCase()}]${options}`;
        });
      push('form', regionName(form), [...fields, ...linesOf(form)]);
    }
    // Lists: groups of links rendered by the same component, read as one unit per group.
    const groups = new Map();
    for (const a of contentLinks()) {
      const key = linkSignature(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    for (const links of groups.values()) {
      const hrefs = new Set(links.map((a) => a.href));
      if (hrefs.size < 5) continue;
      const cards = unique(links.map((a) => a.closest('li, article') || a));
      push('list', '', cards.flatMap(linesOf), { count: hrefs.size });
    }
    for (const heading of all('h2, h3, h4')) {
      const container = heading.closest('section, article, [role="region"]') || heading.parentElement;
      if (container) push('section', clip(textOf(heading), 40), container);
    }
    for (const [selector, name] of [['header, [role="banner"]', 'ヘッダー'], ['nav, [role="navigation"]', 'ナビゲーション'],
      ['main, [role="main"]', 'メイン'], ['aside, [role="complementary"]', 'サイドバー'], ['footer, [role="contentinfo"]', 'フッター']]) {
      for (const el of all(selector)) push('landmark', name, el);
    }
    push('landmark', '本文', document.body);
    // Stopped at the time limit: what was not read is left out, and the model is told so.
    if (reader.cut && units[0]?.kind === 'page') units[0].text += '\n（画面が大きいため、途中までだけ読みました）';
    return units;
  }

  // ------------------------------------------------------------ what changed

  /**
   * Text that appears or disappears right after an operation: the result of
   * operations that do not change the URL (validation errors, toasts, modals).
   * - The watch lasts CHANGE_MS, long enough for a toast after a slow response
   *   (a quiet page may still be waiting for one), and ends early when the next
   *   operation starts, so a quick follow-up does not lend its result.
   * - Text that appears and is gone again before the watch ends (a toast) is
   *   kept as transient; text removed and put back (a re-rendered list) is not a change.
   * - Notification areas shown or hidden by attributes (class, hidden, ...) count too.
   */
  const CHANGE_MS = 5000;
  const SHOWN_BY = ['class', 'style', 'hidden', 'aria-hidden', 'open'];
  const NOTICE = '[role="status"], [role="alert"], [aria-live], dialog, [role="dialog"], [class*="toast" i], [class*="snackbar" i], [class*="notif" i], [class*="flash" i]';
  let finishChange = null;
  function watchChange(seq) {
    finishChange?.();
    if (!document.body) return;
    // whitespace-free text -> { text, first, last }. Removed nodes are detached, so their
    // innerText loses the cell/line spacing: lines are compared without whitespace.
    const seen = new Map();
    // notice: shown in a notification area (status, alert, toast), so it is the page telling the result.
    const note = (kind, text, notice = false) => {
      const k = text.replace(/\s+/g, '');
      const entry = seen.get(k);
      if (!entry) seen.set(k, { text, first: kind, last: kind, notice: notice && kind === 'add' });
      else {
        entry.last = kind;
        if (kind === 'add') entry.text = text;  // attached text keeps its spacing
        if (notice && kind === 'add') entry.notice = true;
      }
    };
    const seenShown = (l) => seen.get(l.replace(/\s+/g, ''))?.first === 'add';
    const inNotice = (node) => Boolean((node.nodeType === 1 ? node : node.parentElement)?.closest(NOTICE));
    const NOT_SHOWN = 'script, style, template, noscript, [hidden], [aria-hidden="true"]';
    // A removed element is detached: its style is gone, so it counts only if nothing marks it hidden.
    const markedHidden = (el) => Boolean(el.closest?.(NOT_SHOWN)) || el.style?.display === 'none' || el.style?.visibility === 'hidden';
    /** The text of a detached element as it was shown: hidden parts and scripts left out. */
    const detachedText = (el) => {
      if (markedHidden(el)) return '';
      const copy = el.cloneNode(true);
      copy.querySelectorAll(NOT_SHOWN).forEach((c) => c.remove());
      copy.querySelectorAll('[style]').forEach((c) => { if (c.style.display === 'none' || c.style.visibility === 'hidden') c.remove(); });
      return copy.textContent;
    };
    // parent: where a removed text node was (it has no parentElement any more).
    // read: the text reader of this batch, for what is still in the page (only shown text is read).
    const lines = (node, parent = null, read = null) => {
      const el = node.nodeType === 1 ? node : node.parentElement || parent;
      if (!el || el.closest('[contenteditable="true"]')) return [];
      if (node.isConnected) return (read || textReader({ ms: 30 })).lines(node).filter((l) => l.length > 1);
      const raw = node.nodeType === 3 ? (markedHidden(el) ? '' : node.textContent) : detachedText(el);
      return String(raw || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1);
    };
    // Only what was on screen: text added or changed inside something hidden never counts.
    // sized: false for where text was removed from - emptied, it may have no height left.
    const shown = (node, sized = true) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return Boolean(el) && visible(el, { sized });
    };
    const take = (records) => {
      // One reader per batch: a style read now may change before the next batch (a toast fading in).
      const read = textReader({ ms: 30 });
      for (const r of records) {
        if (r.type === 'attributes') {
          const el = r.target.closest?.(NOTICE);
          if (!el || (el.textContent || '').length > 300) continue;
          if (visible(el)) lines(el, null, read).forEach((l) => note('add', l, true));
          // Hidden by a class or style now, so innerText is empty: read what it says to see it go away.
          else String(el.textContent || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(seenShown).forEach((l) => note('remove', l));
          continue;
        }
        // One record can both remove and add (replaceChildren): the removal came first.
        // Removed from where it was shown: the parent it left is still in the page.
        // Removals are noted only to tell a toast going away (transient) and a re-rendered list (removed and
        // put back: no change). What was removed is never handed over: a removed element is detached and
        // how it was styled (hidden by a class, transparent) is lost.
        if (shown(r.target, false)) for (const n of r.removedNodes) lines(n, r.target).forEach((l) => note('remove', l));
        for (const n of r.addedNodes) if (shown(n)) lines(n, null, read).forEach((l) => note('add', l, inNotice(n)));
        if (r.type === 'characterData' && shown(r.target)) lines(r.target, null, read).forEach((l) => note('add', l, inNotice(r.target)));
      }
    };
    const observer = new MutationObserver(take);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: SHOWN_BY });
    // finish(false) hands the change over instead of sending it (recording is stopping).
    const finish = (deliver = true) => {
      if (finishChange !== finish) return null;
      finishChange = null;
      clearTimeout(timer);
      take(observer.takeRecords());
      observer.disconnect();
      const scrub = (e) => clip(e.text, 160);
      const of = (first, last) => [...seen.values()].filter((e) => e.first === first && e.last === last).slice(0, 8).map(scrub);
      const change = { appeared: of('add', 'add'), transient: of('add', 'remove') };
      const notices = [...seen.values()].filter((e) => e.notice && e.text.length <= 160).slice(0, 4).map(scrub);
      if (notices.length) change.notices = notices;
      if (!config || !(change.appeared.length || change.transient.length)) return null;
      if (deliver) send('CHANGE', { seq, change });
      return { seq, change };
    };
    const timer = setTimeout(finish, CHANGE_MS);
    finishChange = finish;
  }

  /** Which part of the screen an element belongs to. */
  function componentOf(el) {
    const dialog = el.closest('dialog, [role="dialog"], [aria-modal="true"]');
    if (dialog) return { kind: 'dialog', name: regionName(dialog) };
    const form = el.closest('form, [role="search"]');
    if (form) return { kind: isSearchForm(form) ? 'search' : 'form', name: isSearchForm(form) ? '' : regionName(form) };
    const nav = el.closest('nav, [role="navigation"]');
    if (nav) return { kind: 'nav', name: regionName(nav) };
    if (el.closest('header, [role="banner"]')) return { kind: 'header' };
    if (el.closest('footer, [role="contentinfo"]')) return { kind: 'footer' };
    const link = el.closest('a[href]');
    if (link) {
      const signature = linkSignature(link);
      const size = new Set(contentLinks().filter((a) => linkSignature(a) === signature).map((a) => a.href)).size;
      if (size >= 3) return { kind: 'list', size };
    }
    if (el.closest('aside, [role="complementary"]')) return { kind: 'aside' };
    if (el.closest('article')) return { kind: 'article' };
    if (el.closest('main, [role="main"]')) return { kind: 'main' };
    return undefined;
  }

  // A screen is identified by its URL (without fragment) and its title.
  let screenKey = '';
  let screenPending = false;
  const currentKey = () => `${location.href.split('#')[0]}|${document.title}`;

  /** force: describe the same screen again (the worker replaces the earlier description). */
  function sendScreen(force = false) {
    if (!config || !document.body) return;
    const key = currentKey();
    if (key === screenKey && !force) return;
    screenKey = key;
    send('STEP', { type: 'screen', pageUrl: location.href, screen: extractScreen(), units: extractUnits() });
  }

  /** Waits until the DOM stops changing (client-rendered lists), up to maxMs. */
  function whenQuiet(quietMs = 700, maxMs = 4000) {
    return new Promise((resolve) => {
      let timer = 0;
      const finish = () => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, quietMs);
      });
      observer.observe(document.documentElement, { subtree: true, childList: true });
      timer = setTimeout(finish, quietMs);
      const cap = setTimeout(finish, maxMs);
    });
  }

  async function scheduleScreen() {
    if (screenPending || !config) return;
    screenPending = true;
    try {
      if (document.readyState === 'loading') {
        await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
      }
      // Automated tests leave a screen within a second: describe it right away,
      // then again once client-side rendering has settled.
      sendScreen();
      const key = currentKey();
      await whenQuiet();
      if (currentKey() === key) sendScreen(true);
      else sendScreen();
    } finally {
      screenPending = false;
    }
  }

  // SPA transitions change the URL or title without a load; poll for them.
  setInterval(() => {
    if (config && currentKey() !== screenKey) scheduleScreen();
  }, 1000);

  function describe(el) {
    if (!el) return undefined;
    const target = {
      role: implicitRole(el),
      name: accessibleName(el).slice(0, 200),
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el)
    };
    if (el.tagName === 'A' && el.href) target.href = el.href;
    const component = componentOf(el);
    if (component) target.component = component;
    return target;
  }

  function fieldMeta(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type: el.tagName === 'SELECT' ? 'select' : (el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : '')),
      name: el.getAttribute('name'),
      id: el.id,
      autocomplete: el.getAttribute('autocomplete'),
      label: accessibleName(el),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      contentEditable: el.isContentEditable
    };
  }

  // ------------------------------------------------------------------ steps

  function emit(type, extra = {}) {
    // An operation always happens on a known screen: describe it first if it changed.
    if (type !== 'tool' && currentKey() !== screenKey) sendScreen();
    lastStep = { type, at: Date.now() };
    // A per-document sequence number lets the worker attach what this operation changed.
    sequence += 1;
    const seq = `${documentId}-${sequence}`;
    send('STEP', { type, seq, pageUrl: location.href, actor: type === 'tool' ? 'agent' : actor, ...extra });
    if (type !== 'tool') watchChange(seq);
  }

  function currentValue(el) {
    if (el.isContentEditable) return el.innerText;
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map((o) => o.text.trim()).join(', ');
    return el.value;
  }

  function recordValue(el) {
    if (!config) return;
    const value = currentValue(el);
    if (committed.get(el) === value) return;
    committed.set(el, value);
    const masked = S.maskFieldValue(value, fieldMeta(el), config);
    if (!masked) return;
    emit(el.tagName === 'SELECT' ? 'select' : 'input', {
      target: describe(el),
      value: masked.value,
      valueKinds: masked.kinds
    });
  }

  const handlers = {
    focusin(event) {
      const el = asElement(event.composedPath()[0]);
      if (el && (isTextField(el) || el.tagName === 'SELECT') && !committed.has(el)) {
        // Pre-filled values are not something the user did.
        committed.set(el, currentValue(el));
      }
    },

    click(event) {
      // Enter in a field makes the browser "click" the submit button (detail 0, still
      // trusted). The key step already explains it; recording the click invents an action.
      if (event.detail === 0 && lastStep?.type === 'key' && Date.now() - lastStep.at < 800) return;
      const el = resolveTarget(event.composedPath()[0]);
      if (!el) return;
      // Fields and toggles are recorded by their change, not by the focusing click.
      if (isTextField(el) || isToggle(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
      if (el.tagName === 'LABEL' && el.control
          && (isToggle(el.control) || isTextField(el.control) || el.control.tagName === 'SELECT')) return;
      emit('click', { target: describe(el) });
    },

    change(event) {
      const el = asElement(event.composedPath()[0]);
      if (!el) return;
      if (isToggle(el)) {
        emit('check', { target: describe(el), checked: el.checked });
      } else if (el.tagName === 'INPUT' && el.type === 'file') {
        emit('upload', { target: describe(el), value: `[[file:${el.files?.length || 0}]]` });
      } else if (el.matches('input, select, textarea')) {
        recordValue(el);
      }
    },

    focusout(event) {
      const el = asElement(event.composedPath()[0]);
      if (el?.isContentEditable) recordValue(el.closest('[contenteditable=""],[contenteditable="true"]') || el);
    },

    keydown(event) {
      if (event.isComposing || event.keyCode === 229) return; // IME conversion, not a command
      const el = asElement(event.composedPath()[0]);
      const modifiers = ['ctrlKey', 'metaKey', 'altKey'].filter((m) => event[m]).map((m) => m.replace('Key', ''));
      if (event.key === 'Enter' && !event.shiftKey) {
        if (el && (el.tagName === 'TEXTAREA' || el.isContentEditable) && !modifiers.length) return;
        if (el && isTextField(el)) recordValue(el);
        emit('key', { key: [...modifiers, 'Enter'].join('+'), target: el ? describe(resolveTarget(el)) : undefined });
      } else if (event.key === 'Escape') {
        emit('key', { key: 'Escape' });
      }
    },

    submit(event) {
      // Usually already explained by the click or Enter that caused it.
      if (lastStep && Date.now() - lastStep.at < 800 && ['click', 'key'].includes(lastStep.type)) return;
      emit('submit', { target: describe(asElement(event.target)) });
    }
  };

  // Operations are recorded whoever performs them; the actor is recorded with them.
  // Trusted events come from a person or from browser automation (CDP / WebDriver
  // sets navigator.webdriver). Untrusted ones were dispatched by a script; only
  // the ones that change state are kept, focus and key noise is not.
  const SCRIPT_RECORDABLE = new Set(['click', 'change', 'submit']);
  // Automation tools pick options and files by setting them and dispatching an untrusted
  // change (Playwright selectOption / setInputFiles, WebDriver Select): under automation,
  // that is the tool's operation rather than the page's own script.
  const automatedPick = (event) => navigator.webdriver && event.type === 'change'
    && (event.target?.tagName === 'SELECT' || (event.target?.tagName === 'INPUT' && event.target.type === 'file'));

  for (const [type, handler] of Object.entries(handlers)) {
    window.addEventListener(type, (event) => {
      if (!config) return;
      if (!event.isTrusted && !SCRIPT_RECORDABLE.has(type)) return;
      actor = !event.isTrusted ? (automatedPick(event) ? 'automation' : 'script') : navigator.webdriver ? 'automation' : 'user';
      try { handler(event); } catch (error) { console.warn('[op-scribe] handler failed', type, error); }
    }, true);
  }

  // ------------------------------------------------------- MAIN world relay

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MAIN || typeof data.type !== 'string') return;

    if (data.type === 'REQUEST') {
      const result = config
        ? await send('WEBMCP_REQUEST', { op: String(data.op), args: data.args })
        : { ok: false, error: 'NOT_RECORDING' };
      window.postMessage({ source: ISO, type: 'RESPONSE', id: data.id, result: result ?? { ok: false, error: 'NO_RESPONSE' } },
        location.origin);
      return;
    }
    if (!config) return;
    if (data.type === 'TOOLS' && Array.isArray(data.names)) {
      send('WEBMCP_TOOLS', { pageUrl: location.href, names: data.names.slice(0, 50).map(String) });
    }
    if (data.type === 'TOOL_CALL') {
      // Arguments come from an agent or the page; mask them like typed input.
      emit('tool', { tool: String(data.name).slice(0, 80), args: S.maskArgs(data.args, config), ok: data.ok !== false });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.from !== 'op-scribe/worker') return;
    if (message.type === 'OPS_FLUSH') {
      // Recording is about to stop: hand over the screen as it is now.
      // The last operation's change is handed over too: it would arrive after the recording stopped.
      const pending = finishChange?.(false) || null;
      return void sendResponse(config && document.body ? { pageUrl: location.href, screen: extractScreen(), units: extractUnits(), pending } : null);
    }
    if (message.type === 'OPS_STOP') {
      config = null;
      window.postMessage({ source: ISO, type: 'STOP' }, location.origin);
    }
  });

  // Settings edited mid-recording apply to the next step, not just the next page.
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes.opsSettings?.newValue;
    if (area !== 'local' || !next || !config) return;
    config = { keywords: next.keywords || [] };
  });

  globalThis.__opScribeRecorder = { hello };
  hello();
})();
