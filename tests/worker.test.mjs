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
  const created = [];
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const seen = [];
  const control = {};
  const noop = async () => {};
  const chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: session[key] === undefined ? undefined : structuredClone(session[key]) }),
        set: async (items) => { Object.assign(session, structuredClone(items)); },
        remove: async (key) => { delete session[key]; }
      },
      local: { get: async () => ({}), set: noop }
    },
    runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'), sendMessage: noop },
    permissions: { contains: async ({ origins }) => control.deniedPattern !== origins[0] },
    scripting: {
      getRegisteredContentScripts: async () => (control.failUnregister ? [{ id: 'recorder' }] : []),
      unregisterContentScripts: async () => { if (control.failUnregister) throw new Error('unregister failed'); },
      registerContentScripts: async () => { if (control.failRegister) throw new Error('register failed'); },
      // As in a browser, the injection ends without waiting for the HELLO the recorder sends.
      executeScript: async ({ target, files }) => {
        if (control.failInject) throw new Error('inject failed');
        if (!files.includes('content/recorder.js') || control.silentRecorder) return;
        control.hello = hello(target.tabId, control.tabUrls?.[target.tabId]).then((reply) => seen.push(reply));
      }
    },
    action: { onClicked: on('clicked'), setBadgeText: noop, setBadgeBackgroundColor: noop },
    tabs: {
      onCreated: { addListener: (fn) => { created.push(fn); } },
      onUpdated: { addListener: (fn) => { updated.push(fn); } },
      onRemoved: on('removed'),
      sendMessage: async (id, message) => { if (control.noRecorder) throw new Error('no receiver'); if (message.type === 'OPS_PING') await control.ping; }
    },
    sidePanel: { setPanelBehavior: noop }
  };
  const send = (message, sender = {}) => new Promise((resolve) => { listeners.message(message, sender, resolve); });
  const hello = (tabId = 7, url = 'https://example.com/') => send(
    { from: 'op-scribe/content', type: 'HELLO' },
    { tab: { id: tabId, url }, url }
  );
  // What a service worker has as globals and the worker uses (TextDecoder: the masking's percent decoding).
  const context = vm.createContext({ chrome, console, URL, crypto, setTimeout, clearTimeout, TextDecoder, TextEncoder });
  context.self = context;
  context.importScripts = (...files) => { for (const f of files) vm.runInContext(read(f), context, { filename: f }); };
  vm.runInContext(read('service-worker.js'), context, { filename: 'service-worker.js' });
  const pageLoaded = (tabId = 7) => Promise.all(updated.map((fn) => fn(tabId, { status: 'complete' })));
  const pageMoved = (tabId, url) => Promise.all(updated.map((fn) => fn(tabId, { url }, { id: tabId, url })));
  const tabCreated = (tab) => Promise.all(created.map((fn) => fn(tab)));
  return { send, hello, pageLoaded, pageMoved, tabCreated, seen, control, session, listeners };
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
  const from = (url) => ({ tab: { id: 7, url }, url, origin: new URL(url).origin });
  await send({ from: 'op-scribe/content', type: 'WEBMCP_TOOLS', detail: { names: ['search'] } }, from('https://tools.test/'));
  await send({ from: 'op-scribe/content', type: 'STEP', detail: { type: 'navigate', url: 'https://other.test/' } }, from('https://other.test/'));
  const rec = session.opsRecording;
  const toolSite = Object.keys(rec.webmcpTools)[0];
  assert.equal(`https://${rec.aliases['https://tools.test']}`, toolSite);
  assert.notEqual(rec.aliases['https://other.test'], rec.aliases['https://tools.test']);
});

test('tools are held under the site Chrome reports, and sites past the tool limit keep no alias', async () => {
  const { send, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await control.hello;
  const report = (url, detail) => send({ from: 'op-scribe/content', type: 'WEBMCP_TOOLS', detail: { names: ['search'], ...detail } },
    { tab: { id: 7, url }, url, origin: new URL(url).origin });
  await report('https://real.test/', { pageUrl: 'https://claimed.test/' });
  assert.equal(session.opsRecording.aliases['https://claimed.test'], undefined);
  assert.ok(session.opsRecording.aliases['https://real.test']);
  for (let i = 0; i < 100; i += 1) await report(`https://s${i}.test/`);
  assert.equal(Object.keys(session.opsRecording.webmcpTools).length, 50);
  assert.equal(Object.keys(session.opsRecording.aliases).length, 51);
});

test('a permitted child tab opened by a recorded tab joins the recording', async () => {
  const { send, tabCreated, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  control.tabUrls = { 8: 'https://example.com/child' };
  await tabCreated({ id: 8, openerTabId: 7, url: 'https://example.com/child' });
  await control.hello;
  assert.deepEqual([...session.opsRecording.tabIds], [7, 8]);
  assert.deepEqual([...session.opsRecording.pendingTabIds], []);
  assert.ok(session.opsRecording.steps.some((step) => step.type === 'navigate'));
});

test('a tab without a recorded opener is ignored', async () => {
  const { send, tabCreated, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await tabCreated({ id: 8, url: 'https://example.com/other' });
  assert.deepEqual([...session.opsRecording.tabIds], [7]);
  assert.deepEqual([...session.opsRecording.pendingTabIds], []);
});

test('a child whose URL arrives after onCreated joins on the URL update', async () => {
  const { send, tabCreated, pageMoved, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  control.tabUrls = { 8: 'https://example.com/later' };
  await tabCreated({ id: 8, openerTabId: 7 });
  assert.deepEqual([...session.opsRecording.pendingTabIds], [8]);
  await pageMoved(8, control.tabUrls[8]);
  await control.hello;
  assert.deepEqual([...session.opsRecording.tabIds], [7, 8]);
  assert.deepEqual([...session.opsRecording.pendingTabIds], []);
});

test('an unpermitted child waits until the panel grants its origin', async () => {
  const { send, tabCreated, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  control.deniedPattern = 'https://other.example/*';
  await tabCreated({ id: 8, openerTabId: 7, url: 'https://other.example/child' });
  assert.deepEqual([...session.opsRecording.tabIds], [7]);
  assert.deepEqual([...session.opsRecording.pendingTabIds], [8]);
  assert.equal((await send({ from: 'op-scribe/content', type: 'HELLO' }, { tab: { id: 8, url: 'https://other.example/child' }, url: 'https://other.example/child' })).active, false);

  control.deniedPattern = undefined;
  control.tabUrls = { 8: 'https://other.example/child' };
  const result = await send({ from: 'op-scribe/panel', type: 'ADD_ORIGIN', detail: { tabId: 8, url: 'https://other.example/child' } });
  await control.hello;
  assert.equal(result.ok, true);
  assert.deepEqual([...session.opsRecording.tabIds], [7, 8]);
  assert.deepEqual([...session.opsRecording.pendingTabIds], []);
});

test('a child can open a permitted grandchild', async () => {
  const { send, tabCreated, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  control.tabUrls = { 8: 'https://example.com/child', 9: 'https://example.com/grandchild' };
  await tabCreated({ id: 8, openerTabId: 7, url: control.tabUrls[8] });
  await control.hello;
  await tabCreated({ id: 9, openerTabId: 8, url: control.tabUrls[9] });
  await control.hello;
  assert.deepEqual([...session.opsRecording.tabIds], [7, 8, 9]);
});

test('closing the first tab keeps recording in another owned tab', async () => {
  const { send, tabCreated, control, session, listeners } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  control.tabUrls = { 8: 'https://example.com/child' };
  await tabCreated({ id: 8, openerTabId: 7, url: control.tabUrls[8] });
  await control.hello;
  await listeners.removed(7);
  assert.equal(session.opsRecording.state, 'recording');
  assert.deepEqual([...session.opsRecording.tabIds], [8]);
});

test('a recording owns at most the configured number of related tabs', async () => {
  const { send, tabCreated, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  control.tabUrls = {};
  for (let id = 8; id <= 17; id += 1) {
    control.tabUrls[id] = `https://example.com/${id}`;
    await tabCreated({ id, openerTabId: 7, url: control.tabUrls[id] });
    if (id < 17) await control.hello;
  }
  assert.equal(session.opsRecording.tabIds.length, 10);
  assert.ok(!session.opsRecording.tabIds.includes(17));
  assert.ok(!session.opsRecording.pendingTabIds.includes(17));
});

test('closing a pending child removes it, and closing the last owned tab stops', async () => {
  const { send, tabCreated, control, session, listeners } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  control.deniedPattern = 'https://other.example/*';
  await tabCreated({ id: 8, openerTabId: 7, url: 'https://other.example/child' });
  await listeners.removed(8);
  assert.deepEqual([...session.opsRecording.pendingTabIds], []);
  await listeners.removed(7);
  assert.equal(session.opsRecording.state, 'stopped');
});

test('the panel cannot add an unrelated tab even when its origin is permitted', async () => {
  const { send, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  const result = await send({ from: 'op-scribe/panel', type: 'ADD_ORIGIN', detail: { tabId: 99, url: 'https://example.com/' } });
  assert.equal(result.error, 'NOT_RECORDING_TAB');
  assert.deepEqual([...session.opsRecording.tabIds], [7]);
});
