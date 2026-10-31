/**
 * op-scribe - MAIN world WebMCP integration.
 *
 * 1. Registers opscribe_* tools on document.modelContext so an agent on this
 *    page can read the masked reproduction steps and add expected results.
 * 2. Wraps registerTool so that when an agent calls one of the PAGE's own
 *    tools, the call is recorded next to the human steps. Only tools
 *    registered after this script runs (document_start) can be observed.
 *
 * chrome.* is not available here; everything goes through window.postMessage
 * to content/recorder.js. Messages on this channel are visible to the page,
 * which is why only masked data ever travels back.
 */
(() => {
  'use strict';

  if (window.__opScribeMain) return;
  window.__opScribeMain = true;

  const OUT = 'op-scribe/main';
  const IN = 'op-scribe/iso';
  const PREFIX = 'opscribe_';

  const modelContext = document.modelContext || navigator.modelContext;
  // WebMCP is still behind a flag. Recording works without it; this script just bows out.
  if (!modelContext || typeof modelContext.registerTool !== 'function') return;

  const post = (type, detail = {}) => window.postMessage({ source: OUT, type, ...detail }, location.origin);

  /** Older builds pass arguments as a JSON string; newer ones as an object. */
  function normalizeArgs(raw) {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    }
    return raw && typeof raw === 'object' ? raw : {};
  }

  /** Arguments must survive structured cloning; anything exotic is dropped. */
  /**
   * A copy postMessage can carry: plain values, arrays and objects, without
   * functions or other things it cannot clone. Not a JSON round trip, which
   * turns NaN and Infinity into null; the recorder must see them as numbers
   * to redact them (ADR 0003, W3). Deeper than the recorder looks is cut.
   */
  function cloneable(value, depth = 0) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value !== 'object' || depth > 8) return undefined;
    try {
      if (typeof value.toJSON === 'function') return cloneable(value.toJSON(), depth + 1);
      if (Array.isArray(value)) return value.slice(0, 100).map((v) => cloneable(v, depth + 1) ?? null);
      const out = {};
      for (const [k, v] of Object.entries(value).slice(0, 100)) {
        const c = cloneable(v, depth + 1);
        if (c !== undefined) Object.defineProperty(out, k, { value: c, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------- request/response channel

  const pending = new Map();
  let sequence = 0;

  function request(op, args = {}) {
    return new Promise((resolve) => {
      const id = `${Date.now().toString(36)}-${(sequence += 1)}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'TIMEOUT' });
      }, 5000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      post('REQUEST', { id, op, args });
    });
  }

  // --------------------------------------------------- observe page tool calls

  const controller = new AbortController();
  const nativeRegister = modelContext.registerTool;
  const hadOwnRegister = Object.prototype.hasOwnProperty.call(modelContext, 'registerTool');

  let announceTimer = 0;
  function announce() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(async () => {
      try {
        const tools = await modelContext.getTools?.();
        if (Array.isArray(tools)) post('TOOLS', { names: tools.map((tool) => tool.name) });
      } catch { /* getTools may be unavailable on some builds */ }
    }, 300);
  }

  modelContext.registerTool = function registerTool(tool, options) {
    let registered = tool;
    if (tool && typeof tool.execute === 'function' && !String(tool.name).startsWith(PREFIX)) {
      const execute = tool.execute;
      registered = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
        async execute(args, ...rest) {
          let ok = false;
          try {
            const result = await execute.call(this, args, ...rest);
            ok = true;
            return result;
          } finally {
            post('TOOL_CALL', { name: tool.name, args: cloneable(normalizeArgs(args)) ?? {}, ok });
          }
        }
      });
    }
    const result = nativeRegister.call(this, registered, options);
    announce();
    return result;
  };

  function restore() {
    controller.abort();
    if (hadOwnRegister) modelContext.registerTool = nativeRegister;
    else delete modelContext.registerTool;
    window.__opScribeMain = false;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== IN) return;
    if (data.type === 'RESPONSE') {
      pending.get(data.id)?.(data.result);
      pending.delete(data.id);
    }
    if (data.type === 'ANNOUNCE') announce();
    if (data.type === 'STOP') restore();
  });

  // registerTool has no unregister counterpart; aborting the signal releases our tools.
  window.addEventListener('pagehide', () => controller.abort(), { once: true });

  // ------------------------------------------------------------------ our tools

  const emptySchema = { type: 'object', properties: {} };
  const expectationSchema = {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Expected result in one sentence, e.g. "検索結果が一覧に表示される". 300 characters max.' }
    },
    required: ['text']
  };

  const tools = [
    {
      name: `${PREFIX}recording_status`,
      description: 'Reports whether op-scribe is recording this tab and how many steps it has captured on this site.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute: () => request('status')
    },
    {
      name: `${PREFIX}get_reproduction`,
      description: 'Returns the reproduction steps op-scribe has recorded on this site so far: `markdown` for people and '
        + '`gherkin`, a Feature file whose steps carry attribute tables (url, role, name, selector, value) for replaying them. '
        + 'Personal and confidential values are already masked as ‹…›; never guess or fill them in. '
        + 'Steps recorded on other sites are withheld.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
      execute: () => request('reproduction')
    },
    {
      name: `${PREFIX}add_expectation`,
      description: 'Adds an expected-result note after the latest recorded step. Describe what the screen should show; '
        + 'do not include personal data (it is masked anyway).',
      inputSchema: expectationSchema,
      annotations: { readOnlyHint: false },
      // Not cut here: the worker masks first and then cuts (K2).
      execute: (raw) => request('expect', { text: String(normalizeArgs(raw).text || '') })
    }
  ];

  (async () => {
    for (const tool of tools) {
      try {
        // registerTool returns a Promise on current builds and must be awaited.
        await nativeRegister.call(modelContext, { ...tool, parameters: tool.inputSchema }, { signal: controller.signal });
      } catch (error) {
        console.warn(`[op-scribe] registerTool failed for ${tool.name}`, error);
      }
    }
    announce();
  })();
})();
