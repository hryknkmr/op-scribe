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
  const control = {};
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
      getRegisteredContentScripts: async () => (control.failUnregister ? [{ id: 'recorder' }] : []),
      unregisterContentScripts: async () => { if (control.failUnregister) throw new Error('unregister failed'); },
      registerContentScripts: async () => { if (control.failRegister) throw new Error('register failed'); },
      // What an injected recorder sees when it says HELLO straight away.
      executeScript: async ({ files }) => {
        if (control.failInject) throw new Error('inject failed');
        if (!files.includes('content/recorder.js')) return;
        seen.push(await send({ from: 'op-scribe/content', type: 'HELLO' }, { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' }));
      }
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
  return { send, seen, control, session };
}

test('the page open at the start of a recording is told it is being recorded', async () => {
  const { send, seen } = worker();
  const reply = await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.ok(seen.length > 0, 'the recorder was injected');
  assert.equal(seen[0].active, true);
});

test('a restart that fails does not leave the earlier recording saved as recording', async () => {
  const { send, control, session } = worker();
  const start = { from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } };
  await send(start);
  control.failRegister = true;
  const reply = await send(start);
  assert.equal(reply.ok, false);
  assert.equal(session.opsRecording.state, 'stopped');
});

test('a note keeps a known kind and drops any other', async () => {
  const { send, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await send({ from: 'op-scribe/panel', type: 'ADD_NOTE', detail: { text: 'a', kind: 'bug' } });
  await send({ from: 'op-scribe/panel', type: 'ADD_NOTE', detail: { text: 'b', kind: 'other' } });
  const notes = session.opsRecording.steps.filter((s) => s.type === 'note');
  assert.equal(notes[0].kind, 'bug');
  assert.equal(notes[1].kind, undefined);
});

test('a restart that cannot stop the earlier recording does not leave it saved as recording', async () => {
  const { send, control, session } = worker();
  const start = { from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } };
  await send(start);
  control.failUnregister = true;
  const reply = await send(start);
  assert.equal(reply.ok, false);
  assert.equal(session.opsRecording.state, 'stopped');
});

test('a page the recorder could not reach is reported, and the recording goes on for the next page', async () => {
  const { send, control, session } = worker();
  control.failInject = true;
  const reply = await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  assert.equal(reply.ok, true);
  assert.equal(reply.warning, 'PAGE_NOT_ATTACHED');
  assert.equal(session.opsRecording.state, 'recording');
});
