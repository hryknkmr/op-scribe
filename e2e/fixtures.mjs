// The extension in a real Chromium, on made-up sites (*.test) that Playwright serves.
// The copy of the extension gets host permission for them, which a person grants in the panel.
import { test as base, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'e2e', 'site');
const PARTS = ['manifest.json', 'service-worker.js', 'content', 'shared', 'sidepanel', 'icons'];

function extensionCopy(dir) {
  for (const part of PARTS) fs.cpSync(path.join(ROOT, part), path.join(dir, part), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // https: the send endpoint in e2e/exits.spec.mjs, granted ahead as a person grants it in the panel.
  manifest.host_permissions = ['http://*.test/*', 'https://*.test/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

// WebMCP is behind a flag in Chrome. This stands in for document.modelContext with the calls
// the extension uses, and keeps the registered tools where a test can call them as an agent would.
function webmcpStandIn() {
  const tools = new Map();
  const modelContext = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => tools.delete(tool.name));
      return Promise.resolve();
    },
    getTools: () => Promise.resolve([...tools.values()]),
  };
  Object.defineProperty(document, 'modelContext', { value: modelContext, configurable: true });
  Object.defineProperty(window, '__e2eTools', { value: tools });
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-scribe-e2e-'));
    const ext = extensionCopy(fs.mkdtempSync(path.join(tmp, 'ext-')));
    const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
      channel: 'chromium',
      headless: !process.env.HEADED,
      // A page's own service worker could fetch past the routes above (Playwright does not see its requests).
      serviceWorkers: 'block',
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    // Anything but the made-up sites is refused, so no test can reach a real host. Playwright tries the
    // routes added last first: this one only gets what the *.test route below does not take.
    await context.route(/^https?:\/\//, (route) => route.abort('blockedbyclient'));
    // WebSockets have their own routes. Without connectToServer none reaches a server; each is closed.
    await context.routeWebSocket(/./, (ws) => ws.close({ code: 4000, reason: 'e2e: no real hosts' }));
    await context.route(/^http:\/\/[a-z0-9-]+\.test\//, (route) => {
      const name = new URL(route.request().url()).pathname.replace(/^\/$/, '/form.html').slice(1);
      const file = path.join(SITE, path.basename(name));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ path: file, contentType: 'text/html; charset=utf-8' });
    });
    await context.addInitScript(webmcpStandIn);
    await use(context);
    await context.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },

  /** An extension page: it sends what the side panel sends, and reads the recording. */
  panel: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await page.evaluate(() => chrome.storage.local.set({
      opsSettings: { commercialHosts: [], hostAllowlist: [], keywords: [], endpoint: '', authHeader: '' },
    }));
    const send = (type, detail) => page.evaluate(([t, d]) => chrome.runtime.sendMessage({ from: 'op-scribe/panel', type: t, detail: d }), [type, detail]);
    await use({
      page,
      send,
      async start(site) {
        const tab = await page.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0], site.url().replace(/[?#].*$/, '').replace(/[^/]*$/, ''));
        const reply = await send('START', { tabId: tab.id, url: tab.url });
        if (!reply?.ok) throw new Error(`START: ${JSON.stringify(reply)}`);
        // The recorder says HELLO once it listens.
        await page.waitForFunction(async () => (await chrome.storage.session.get('opsRecording')).opsRecording?.attached === true);
      },
      stop: () => send('STOP'),
      addSite: (url) => send('ADD_ORIGIN', { url }),
      recording: () => page.evaluate(async () => (await chrome.storage.session.get('opsRecording')).opsRecording),
    });
  },
});

/** Calls a tool the page has registered, as an agent on the page would. */
export const callTool = (page, name, args = {}) => page.evaluate(async ([n, a]) => {
  const tool = window.__e2eTools.get(n);
  if (!tool) throw new Error(`no tool ${n}: ${[...window.__e2eTools.keys()].join(', ')}`);
  return tool.execute(a);
}, [name, args]);

/** Waits until the page has our tools (they are registered when the recorder is injected). */
export const toolsReady = (page) => page.waitForFunction(() => window.__e2eTools?.has('opscribe_recording_status'));

export { expect } from '@playwright/test';
