// service-worker.js in a vm with a stand-in for the chrome APIs it uses (#23).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');

function worker() {
  const session = {};
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const seen = [];
  const noop = async () => {};
  const chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (items) => { Object.assign(session, items); },
        remove: async (key) => { delete session[key]; }
      },
      local: { get: async () => ({}), set: noop }
    },
    runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'), sendMessage: noop },
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => [],
      unregisterContentScripts: noop,
      registerContentScripts: noop,
      // What an injected recorder sees when it says HELLO straight away.
      executeScript: async () => { seen.push(await send({ from: 'op-scribe/content', type: 'HELLO' }, { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' })); }
    },
    action: { onClicked: on('clicked'), setBadgeText: noop, setBadgeBackgroundColor: noop },
    tabs: { onUpdated: on('updated'), onRemoved: on('removed'), sendMessage: noop },
    sidePanel: { setPanelBehavior: noop }
  };
  const send = (message, sender = {}) => new Promise((resolve) => { listeners.message(message, sender, resolve); });
  const context = vm.createContext({ chrome, console, URL, crypto, setTimeout, clearTimeout });
  context.self = context;
  context.importScripts = (...files) => { for (const f of files) vm.runInContext(read(f), context, { filename: f }); };
  vm.runInContext(read('service-worker.js'), context, { filename: 'service-worker.js' });
  return { send, seen };
}

test('the page open at the start of a recording is told it is being recorded', async () => {
  const { send, seen } = worker();
  const reply = await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.ok(seen.length > 0, 'the recorder was injected');
  assert.equal(seen[0].active, true);
});
