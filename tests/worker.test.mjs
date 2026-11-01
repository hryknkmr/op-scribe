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
  const updated = [];
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
      // As in a browser, the injection ends without waiting for the HELLO the recorder sends.
      executeScript: async ({ files }) => {
        if (control.failInject) throw new Error('inject failed');
        if (!files.includes('content/recorder.js') || control.silentRecorder) return;
        control.hello = hello().then((reply) => seen.push(reply));
      }
    },
    action: { onClicked: on('clicked'), setBadgeText: noop, setBadgeBackgroundColor: noop },
    tabs: { onUpdated: { addListener: (fn) => { updated.push(fn); } }, onRemoved: on('removed'), sendMessage: async (id, message) => { if (control.noRecorder) throw new Error('no receiver'); if (message.type === 'OPS_PING') await control.ping; } },
    sidePanel: { setPanelBehavior: noop }
  };
  const send = (message, sender = {}) => new Promise((resolve) => { listeners.message(message, sender, resolve); });
  const hello = () => send({ from: 'op-scribe/content', type: 'HELLO' }, { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' });
  // What a service worker has as globals and the worker uses (TextDecoder: the masking's percent decoding).
  const context = vm.createContext({ chrome, console, URL, crypto, setTimeout, clearTimeout, TextDecoder, TextEncoder });
  context.self = context;
  context.importScripts = (...files) => { for (const f of files) vm.runInContext(read(f), context, { filename: f }); };
  vm.runInContext(read('service-worker.js'), context, { filename: 'service-worker.js' });
  const pageLoaded = () => Promise.all(updated.map((fn) => fn(7, { status: 'complete' })));
  return { send, hello, pageLoaded, seen, control, session };
}

test('the page open at the start of a recording is told it is being recorded', async () => {
  const { send, seen, control, session } = worker();
  const reply = await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  await control.hello;
  assert.ok(seen.length > 0, 'the recorder was injected');
  assert.equal(seen[0].active, true);
  assert.equal(session.opsRecording.attached, true);
});

test('an injection that ends with no HELLO does not count as attached', async () => {
  const { send, control, session } = worker();
  control.silentRecorder = true;
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  assert.equal(session.opsRecording.attached, false);
});

test('a loaded page with no recorder is not attached, and one that has a recorder keeps it', async () => {
  const { send, control, session, pageLoaded } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await control.hello;
  await pageLoaded();
  assert.equal(session.opsRecording.attached, true);
  control.noRecorder = true;
  await pageLoaded();
  assert.equal(session.opsRecording.attached, false);
});

test('a late failed ping of an earlier recording leaves the new one attached', async () => {
  const { send, control, session, pageLoaded } = worker();
  const start = { from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } };
  await send(start);
  await control.hello;
  let fail;
  control.ping = new Promise((resolve, reject) => { fail = reject; });
  const loaded = pageLoaded();
  await send(start);
  await control.hello;
  fail(new Error('no receiver'));
  await loaded;
  assert.equal(session.opsRecording.attached, true);
});

test('a HELLO queued behind the stop gets no configuration', async () => {
  const { send, hello, control } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await control.hello;
  const stopping = send({ from: 'op-scribe/panel', type: 'STOP' });
  assert.equal((await hello()).active, false);
  await stopping;
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

test('a page the recorder could not reach stays unattached until a recorder says HELLO', async () => {
  const { send, hello, control, session } = worker();
  control.failInject = true;
  const reply = await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  assert.equal(reply.ok, true);
  assert.equal(session.opsRecording.state, 'recording');
  assert.equal(session.opsRecording.attached, false);
  // A step from the worker, such as a same-document URL change, shows nothing about the recorder.
  await send({ from: 'op-scribe/panel', type: 'ADD_NOTE', detail: { text: 'a' } });
  assert.equal(session.opsRecording.attached, false);
  assert.equal((await hello()).active, true);
  assert.equal(session.opsRecording.attached, true);

});

test('a site that reports tools before any step keeps its alias, so a later site does not take it', async () => {
  const { send, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await control.hello;
  const from = (url) => ({ tab: { id: 7, url }, url });
  await send({ from: 'op-scribe/content', type: 'WEBMCP_TOOLS', detail: { pageUrl: 'https://tools.test/', names: ['search'] } }, from('https://tools.test/'));
  await send({ from: 'op-scribe/content', type: 'STEP', detail: { type: 'navigate', url: 'https://other.test/' } }, from('https://other.test/'));
  const rec = session.opsRecording;
  const toolSite = Object.keys(rec.webmcpTools)[0];
  assert.equal(`https://${rec.aliases['https://tools.test']}`, toolSite);
  assert.notEqual(rec.aliases['https://other.test'], rec.aliases['https://tools.test']);
});
