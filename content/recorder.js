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

  /**
   * { commercial, keywords } while this tab is being recorded, otherwise null.
   * The worker decides commercial from the sender and checks every value again.
   */
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

  const T = globalThis.OpScribeTarget;
  const { isTextField, implicitRole } = T;
  const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];
  const GENERATED_ID = /\d{3,}|[0-9a-f]{8,}|^:|:$/i;

  const asElement = (node) => (node instanceof Element ? node : node?.parentElement || null);
  // Page content that nobody operates is still a click target, but it is named
  // only by what its author declared (shared/target.js).
  const resolveTarget = (node) => {
    const el = asElement(node);
    return el ? T.operated(el) || el : null;
  };
  const isToggle = (el) => el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
  const accessibleName = (el) => T.accessibleName(el, document);

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
      // Whole: the worker masks first and then cuts, so a keyword across the limit is never left half (K2).
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      ...T.semanticPosition(el, document)
    };
    if ((el.tagName === 'A' || el.tagName === 'AREA') && el.href) target.href = el.href;
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
      // The text of every <label> of the field, apart from its accessible name: an aria-label
      // must not hide a label that says "password" from the classification (I3, I4; review R38).
      // aria-labelledby too: an aria-label must not hide either (review R42).
      labelText: [...(el.labels || []),
        ...String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean)]
        .map((l) => l.innerText || l.textContent || '').join(' '),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      inSearch: T.inSearch(el),
      contentEditable: el.isContentEditable
    };
  }

  const maskOptions = () => ({ env: config.commercial ? 'commercial' : 'standard', keywords: config.keywords });

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

  function recordValue(el) {
    if (!config) return;
    const value = currentValue(el);
    if (committed.get(el) === value) return;
    committed.set(el, value);
    const meta = fieldMeta(el);
    const masked = S.maskFieldValue(value, meta, maskOptions());
    if (!masked) return;
    emit(el.tagName === 'SELECT' ? 'select' : 'input', {
      target: describe(el),
      // The field's names, not its value: the worker classifies them again (ADR 0003, I3/I4).
      field: { ...meta, contentEditable: undefined },
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
      // A label with a control: the browser forwards the click to the control, which records itself.
      if (!T.isOperated(el) && el.closest('label')?.control) return;
      emit('click', { target: describe(el) });
    },

    change(event) {
      const el = asElement(event.composedPath()[0]);
      if (!el) return;
      if (isToggle(el)) {
        emit('check', { target: describe(el), checked: el.checked });
      } else if (el.tagName === 'INPUT' && el.type === 'file') {
        emit('upload', { target: describe(el), value: S.typed.file(el.files?.length || 0) });
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
      } else if (event.key === 'Escape' && !event.shiftKey && !modifiers.length) {
        // Only a bare Escape (row T5); Shift+Escape or Ctrl+Escape is another command.
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
    }, { capture: true, passive: true });
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
      send('WEBMCP_TOOLS', { names: data.names.slice(0, 50).map(String) });
    }
    if (data.type === 'TOOL_CALL') {
      // Arguments come from an agent or the page; mask them like typed input.
      emit('tool', { tool: String(data.name), args: S.maskArgs(data.args, maskOptions()), ok: data.ok !== false });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.from !== 'op-scribe/worker') return;
    if (message.type === 'OPS_PING') {
      sendResponse({ ok: true });
      if (!config) hello();
      return;
    }
    if (message.type === 'OPS_STOP') {
      config = null;
      window.postMessage({ source: ISO, type: 'STOP' }, location.origin);
    }
  });

  // Keywords added mid-recording apply to the next step. The host lists stay as
  // they were when the recording started (ADR 0001), so commercial does not change.
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes.opsSettings?.newValue;
    if (area !== 'local' || !next || !config) return;
    config = { ...config, keywords: next.keywords || [] };
  });

  globalThis.__opScribeRecorder = { hello };
  hello();
})();
