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
    if (config) window.postMessage({ source: ISO, type: 'ANNOUNCE' }, location.origin);
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

  function describe(el) {
    if (!el) return undefined;
    const target = {
      role: implicitRole(el),
      name: accessibleName(el).slice(0, 200),
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el)
    };
    if (el.tagName === 'A' && el.href) target.href = el.href;
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
      // A search box by the page's markup only (docs/adr/0001).
      search: el.type === 'search' || el.getAttribute('role') === 'searchbox' || Boolean(el.closest('[role="search"]')),
      contentEditable: el.isContentEditable
    };
  }

  // ------------------------------------------------------------------ steps

  function emit(type, extra = {}) {
    lastStep = { type, at: Date.now() };
    send('STEP', { type, pageUrl: location.href, ...extra });
  }

  function currentValue(el) {
    if (el.isContentEditable) return el.innerText;
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map((o) => o.text.trim()).join(', ');
    return el.value;
  }

  /** This page is on a production host (docs/adr/0001): typed text is kept as its length only. */
  const onProduction = () => S.hostAllowed(location.hostname.replace(/\.+$/, ''), config?.productionHosts);

  function recordValue(el) {
    if (!config) return;
    const value = currentValue(el);
    if (committed.get(el) === value) return;
    committed.set(el, value);
    const meta = fieldMeta(el);
    const masked = S.maskFieldValue(value, meta, { ...config, strict: onProduction() });
    if (!masked) return;
    const cls = S.classifyField(meta);
    emit(el.tagName === 'SELECT' ? 'select' : 'input', {
      target: describe(el),
      value: masked.value,
      valueKinds: masked.kinds,
      // What kind of field it was (text, search, choice, ...): the worker checks production values against it.
      valueClass: cls.kind === 'secret' ? cls.label : cls.kind
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

  for (const [type, handler] of Object.entries(handlers)) {
    window.addEventListener(type, (event) => {
      // Synthetic events (page scripts, automation) are not human operations.
      if (!config || !event.isTrusted) return;
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
      emit('tool', { tool: String(data.name).slice(0, 80), args: S.maskArgs(data.args, { ...config, strict: onProduction() }), ok: data.ok !== false });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.from !== 'op-scribe/worker') return;
    if (message.type === 'OPS_STOP') {
      config = null;
      window.postMessage({ source: ISO, type: 'STOP' }, location.origin);
    }
  });

  // Settings edited mid-recording apply to the next step, not just the next page.
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes.opsSettings?.newValue;
    if (area !== 'local' || !next || !config) return;
    // Only the listed words, and only added ones: the host lists stay as they were when recording started, and a
    // word removed mid-recording is still hidden until it ends (docs/adr/0001).
    config = { ...config, keywords: [...new Set([...(config.keywords || []), ...(next.keywords || [])])] };
  });

  globalThis.__opScribeRecorder = { hello };
  hello();
})();
