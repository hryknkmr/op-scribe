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
      const text = [...el.labels].map(textOf).join(' ');
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

  const visible = (el) => {
    if (!el?.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const unique = (list) => [...new Set(list.filter(Boolean))];
  const CHROME_REGION = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';

  /** Name of a region: aria-label, aria-labelledby, or its first heading. */
  function regionName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim().slice(0, 30);
    const by = el.getAttribute('aria-labelledby');
    const labelled = by && document.getElementById(by.split(/\s+/)[0]);
    if (labelled) return textOf(labelled).slice(0, 30);
    const heading = el.querySelector('legend, h1, h2, h3, h4');
    return heading ? textOf(heading).slice(0, 30) : '';
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
          .map((f) => ({ type: f.tagName === 'INPUT' ? (f.type || 'text') : f.tagName.toLowerCase(), label: accessibleName(f).slice(0, 30) }));
        const submit = el.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        return {
          kind: isSearchForm(el) ? 'search' : 'form',
          name: regionName(el),
          fields,
          submit: submit ? accessibleName(submit).slice(0, 30) : ''
        };
      })
      .filter((form) => form.fields.length);

    const buttons = unique([...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .filter((b) => visible(b) && !b.closest('[contenteditable="true"]'))
      .map((b) => accessibleName(b).slice(0, 30)))
      .slice(0, 15);
    const navLinks = unique([...document.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href]')]
      .filter(visible)
      .map((a) => accessibleName(a).slice(0, 20)))
      .slice(0, 10);
    // Section names only. Headings in an article, an editor, a card (inside or around a
    // link) or a list item are content - other people's titles - not part of the UI.
    const headings = unique([...document.querySelectorAll('h2, h3')]
      .filter((h) => visible(h) && !h.closest('article, [contenteditable="true"], a, li') && !h.querySelector('a'))
      .map((h) => textOf(h).slice(0, 30)))
      .slice(0, 6);
    const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')]
      .filter(visible).map(regionName).slice(0, 3);
    const editor = [...document.querySelectorAll('[contenteditable="true"], textarea')]
      .some((el) => visible(el) && el.getBoundingClientRect().height > 120);
    const h1 = [...document.querySelectorAll('h1')].find(visible);
    const main = document.querySelector('main, [role="main"]') || document.body;

    return {
      url: location.href,
      title: document.title.slice(0, 120),
      h1: h1 ? textOf(h1).slice(0, 80) : '',
      lang: document.documentElement.lang || '',
      forms,
      buttons,
      navLinks,
      headings,
      dialogs,
      editor,
      article: Boolean(document.querySelector('article') && (main.innerText || '').length > 800),
      textLength: (main.innerText || '').length,
      tables: [...document.querySelectorAll('table')].filter(visible).length,
      links: contentLinks().length,
      repeated: repeatedGroup()
    };
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
    send('STEP', { type: 'screen', pageUrl: location.href, screen: extractScreen() });
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
    send('STEP', { type, pageUrl: location.href, actor: type === 'tool' ? 'agent' : actor, ...extra });
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

  for (const [type, handler] of Object.entries(handlers)) {
    window.addEventListener(type, (event) => {
      if (!config) return;
      if (!event.isTrusted && !SCRIPT_RECORDABLE.has(type)) return;
      actor = !event.isTrusted ? 'script' : navigator.webdriver ? 'automation' : 'user';
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
      return void sendResponse(config && document.body ? { pageUrl: location.href, screen: extractScreen() } : null);
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
