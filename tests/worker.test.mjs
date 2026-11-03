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
        get: async (key) => {
          const value = { [key]: session[key] === undefined ? undefined : structuredClone(session[key]) };
          // A test may hold one read: what it read arrives after what happens meanwhile.
          const held = control.holdRead;
          control.holdRead = null;
          await held;
          return value;
        },
        set: async (items) => { Object.assign(session, structuredClone(items)); },
        remove: async (key) => { delete session[key]; }
      },
      // A test may set the settings (control.settings) at any point; read at the time of each get.
      local: { get: async (key) => (control.settings && key === 'opsSettings' ? { [key]: structuredClone(control.settings) } : {}), set: noop }
    },
    runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'), sendMessage: noop },
    // A test may name origins the extension has no access to (control.denied).
    permissions: { contains: async ({ origins }) => !origins.some((o) => (control.denied || []).includes(o)) },
    scripting: {
      getRegisteredContentScripts: async () => (control.failUnregister ? [{ id: 'recorder' }] : []),
      unregisterContentScripts: async () => { if (control.failUnregister) throw new Error('unregister failed'); },
      registerContentScripts: async () => { if (control.failRegister) throw new Error('register failed'); },
      // As in a browser, the injection ends without waiting for the HELLO the recorder sends.
      executeScript: async ({ target, files }) => {
        (control.injected ||= []).push(target.tabId);
        if (control.failInject) throw new Error('inject failed');
        if (!files.includes('content/recorder.js') || control.silentRecorder) return;
        control.hello = hello().then((reply) => seen.push(reply));
      }
    },
    action: { onClicked: on('clicked'), setBadgeText: noop, setBadgeBackgroundColor: noop },
    tabs: { onUpdated: { addListener: (fn) => { updated.push(fn); } }, onRemoved: on('removed'), onCreated: on('created'), get: async (id) => { await control.holdGet; if (control.gone?.includes(id)) throw new Error('No tab'); return control.tabs?.[id] ? { id, ...control.tabs[id] } : { id }; }, sendMessage: async (id, message) => { (control.toTabs ||= []).push([id, message.type]); if (control.noRecorder) throw new Error('no receiver'); if (message.type === 'OPS_PING') await control.ping; if (message.type === 'OPS_FLUSH') await control.flush?.(); } },
    sidePanel: { setPanelBehavior: noop }
  };
  // A recorder names the recording it was told about (HELLO); a test may name another.
  const send = (message, sender = {}) => new Promise((resolve) => {
    const named = message.from === 'op-scribe/content' && !('recording' in message) ? { ...message, recording: session.opsRecording?.id } : message;
    listeners.message(named, sender, resolve);
  });
  const hello = () => send({ from: 'op-scribe/content', type: 'HELLO' }, { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' });
  // What a service worker has as globals and the worker uses (TextDecoder: the masking's percent decoding).
  const context = vm.createContext({ chrome, console, URL, crypto, setTimeout, clearTimeout, TextDecoder, TextEncoder });
  context.self = context;
  context.importScripts = (...files) => { for (const f of files) vm.runInContext(read(f), context, { filename: f }); };
  vm.runInContext(read('service-worker.js'), context, { filename: 'service-worker.js' });
  const pageLoaded = () => Promise.all(updated.map((fn) => fn(7, { status: 'complete' })));
  const removeTab = (id) => listeners.removed(id);
  // A tab opened from another (openerTabId), with its URL now or, as Chrome may, only in a later update.
  const openTab = (tab) => listeners.created(tab);
  const urlChanged = (id, url) => Promise.all(updated.map((fn) => fn(id, { url })));
  return { send, hello, pageLoaded, removeTab, openTab, urlChanged, listeners, seen, control, session };
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

test('a value the page commits when asked before the stop is in the recording (#9)', async () => {
  const { send, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await control.hello;
  const page = { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' };
  control.flush = () => send({ from: 'op-scribe/content', type: 'STEP', detail: { type: 'click', pageUrl: 'https://example.com/', target: { tag: 'button' } } }, page);
  await send({ from: 'op-scribe/panel', type: 'STOP' });
  assert.equal(session.opsRecording.state, 'stopped');
  assert.equal(session.opsRecording.steps.at(-1).type, 'click');
});

test('a recording started while the earlier one commits its last value is not the one stopped (#9)', async () => {
  const { send, control, session } = worker();
  const start = { from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } };
  await send(start);
  await control.hello;
  control.flush = () => { control.flush = null; return send(start); };
  await send({ from: 'op-scribe/panel', type: 'STOP' });
  assert.equal(session.opsRecording.state, 'recording');
});

test('a step sent for an earlier recording is not added to the one that follows it in the tab (#9)', async () => {
  const { send, control, session } = worker();
  const start = { from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } };
  await send(start);
  await control.hello;
  const earlier = session.opsRecording.id;
  await send(start);
  await control.hello;
  const page = { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' };
  const reply = await send({ from: 'op-scribe/content', type: 'STEP', recording: earlier, detail: { type: 'click', pageUrl: 'https://example.com/', target: { tag: 'button' } } }, page);
  assert.equal(reply.error, 'NOT_RECORDING');
  assert.deepEqual(session.opsRecording.steps.map((s) => s.type), ['navigate']);
});

test('a stop that finds nothing recording does not stop a recording started meanwhile (#9)', async () => {
  const { send, control, session } = worker();
  let release;
  control.holdRead = new Promise((resolve) => { release = resolve; });
  const stopping = send({ from: 'op-scribe/panel', type: 'STOP' });
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  release();
  await stopping;
  assert.equal(session.opsRecording.state, 'recording');
});

test('a closed tab stops its own recording, not one started in another tab meanwhile (#9)', async () => {
  const { send, removeTab, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await control.hello;
  let release;
  control.holdRead = new Promise((resolve) => { release = resolve; });
  // The closed tab's recording is read, and another start is asked for meanwhile. The close is
  // handled in the queue (#40), so the start comes after it and is not the one the close ends.
  const removed = removeTab(7);
  const started = send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 8, url: 'https://example.com/' } });
  release();
  await removed;
  await started;
  assert.equal(session.opsRecording.tabId, 8);
  assert.equal(session.opsRecording.state, 'recording');
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

test('a step is deleted only by an index it has, on the recording the panel showed (#56)', async () => {
  const { send, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  for (const text of ['a', 'b', 'c']) await send({ from: 'op-scribe/panel', type: 'ADD_NOTE', detail: { text } });
  const before = structuredClone(session.opsRecording);
  const basis = `${before.id}@${before.revision}`;
  const del = (detail) => send({ from: 'op-scribe/panel', type: 'DELETE_STEP', detail });
  for (const index of [undefined, 'x', '0', null, '', false, [], -1, 1.5, before.steps.length]) {
    assert.equal((await del({ index, basis })).ok, false, JSON.stringify(index));
  }
  // Without the basis, or with another recording's or an earlier revision's.
  for (const other of [undefined, `rec-other@${before.revision}`, `${before.id}@${before.revision - 1}`]) {
    assert.equal((await del({ index: 1, basis: other })).ok, false, String(other));
  }
  assert.equal((await send({ from: 'op-scribe/panel', type: 'ADD_NOTE', detail: { text: '' } })).ok, false);
  assert.deepEqual(session.opsRecording, before);
  // A double click: the first removes the step, the second, on the same basis, removes nothing.
  const replies = await Promise.all([del({ index: 1, basis }), del({ index: 1, basis })]);
  assert.deepEqual(replies.map((r) => r.ok), [true, false]);
  assert.deepEqual(session.opsRecording.steps, [before.steps[0], ...before.steps.slice(2)]);
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

test('a page on a host of the alias form gets no tools recorded and no answer (rows U4, W8; review of #46)', async () => {
  const { send, control, session } = worker();
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await control.hello;
  const from = { tab: { id: 7, url: 'https://site-1.invalid/' }, url: 'https://site-1.invalid/', origin: 'https://site-1.invalid' };
  const before = Object.keys(session.opsRecording.aliases).length;
  await send({ from: 'op-scribe/content', type: 'WEBMCP_TOOLS', detail: { names: ['search'] } }, from);
  assert.deepEqual(session.opsRecording.webmcpTools, {});
  // The reply is made in the worker's realm: compared as JSON.
  const refused = JSON.stringify({ ok: false, error: 'NOT_RECORDING' });
  for (const detail of [{ op: 'status' }, { op: 'reproduction' }, { op: 'expect', args: { text: '表示される' } }]) {
    assert.equal(JSON.stringify(await send({ from: 'op-scribe/content', type: 'WEBMCP_REQUEST', detail }, from)), refused, detail.op);
  }
  assert.equal(Object.keys(session.opsRecording.aliases).length, before);
});

// ------------------------------------------------------------- ADR 0005 (v4)

// The worker runs in a vm: what it returns is made plain before it is compared.
const plain = (v) => JSON.parse(JSON.stringify(v));
const panel = (type, detail) => ({ from: 'op-scribe/panel', type, detail });
const startAt = (send, detail = {}) => send(panel('START', { tabId: 7, url: 'https://example.com/', ...detail }));

test('the start and the stop keep what the tester wrote, masked, and the stop names the recording it ends (ADR 0005)', async () => {
  const { send, control, session } = worker();
  await startAt(send, { scope: '検索画面 tester@example.com', targetVersion: '2.3.0' });
  await control.hello;
  const rec = session.opsRecording;
  assert.ok(Array.isArray(rec.scope) && !JSON.stringify(rec.scope).includes('tester@example.com'), JSON.stringify(rec.scope));
  assert.equal(rec.redactions.email, 1);
  assert.deepEqual(plain(rec.targetVersion), ['2.3.0']);
  // Another recording's panel does not stop this one.
  assert.deepEqual(plain(await send(panel('STOP', { recordingId: 'rec-other', notTested: 'x' }))), { ok: false, reason: 'OTHER_RECORDING' });
  assert.equal(session.opsRecording.state, 'recording');
  const revision = session.opsRecording.revision;
  assert.deepEqual(plain(await send(panel('STOP', { recordingId: rec.id, notTested: '決済' }))), { ok: true });
  assert.equal(session.opsRecording.state, 'stopped');
  assert.deepEqual(plain(session.opsRecording.notTested), ['決済']);
  assert.equal(session.opsRecording.revision, revision, 'the stop is not a change to the steps');
});

test('a stop writes an end no earlier than the start, whatever the clock did (ADR 0005)', async () => {
  const { send, control, session } = worker();
  await startAt(send);
  await control.hello;
  session.opsRecording.startedAt = Date.now() + 60 * 60 * 1000;
  await send(panel('STOP'));
  assert.equal(session.opsRecording.endedAt, session.opsRecording.startedAt);
});

test('SET_VERDICT judges an expectation by the recording and its ref, while steps keep arriving (ADR 0005)', async () => {
  const { send, control, session } = worker();
  await startAt(send);
  await control.hello;
  assert.deepEqual(plain(await send(panel('ADD_NOTE', { text: '一覧が出る' }))), { ok: true });
  const { id, steps } = session.opsRecording;
  const { ref } = steps.at(-1);
  assert.match(ref, /^E-[0-9a-z]{6}$/);
  // A step arrives between what the panel showed and its update: the update still lands.
  const page = { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/' };
  await send({ from: 'op-scribe/content', type: 'STEP', detail: { type: 'click', pageUrl: 'https://example.com/', target: { tag: 'button' } } }, page);
  const revision = session.opsRecording.revision;
  assert.deepEqual(plain(await send(panel('SET_VERDICT', { recordingId: id, ref, verdict: 'ng', actual: '空のまま' }))), { ok: true });
  const judged = session.opsRecording.steps.find((s) => s.ref === ref);
  assert.equal(judged.verdict, 'ng');
  assert.deepEqual(plain(judged.actual), ['空のまま']);
  assert.equal(session.opsRecording.revision, revision, 'a verdict does not make a draft stale');
  assert.deepEqual(plain(await send(panel('SET_VERDICT', { recordingId: 'rec-other', ref, verdict: 'ok' }))), { ok: false, reason: 'OTHER_RECORDING' });
  assert.deepEqual(plain(await send(panel('SET_VERDICT', { recordingId: id, ref, verdict: 'ng' }))), { ok: false, reason: 'NO_ACTUAL' });
  assert.equal(session.opsRecording.steps.find((s) => s.ref === ref).verdict, 'ng', 'left as it was');
});

test('a note a limit keeps out still saves the recording\'s trimmed mark (ADR 0005, M5)', async () => {
  const { send, control, session } = worker();
  await startAt(send);
  await control.hello;
  const page = { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/', origin: 'https://example.com' };
  // The page's own expectations up to its limit, then one more.
  let reply;
  for (let i = 0; i <= 100; i += 1) reply = await send({ from: 'op-scribe/content', type: 'WEBMCP_REQUEST', detail: { op: 'expect', args: { text: `期待 ${i}` } } }, page);
  assert.equal(reply.error, 'NOT_RECORDED');
  assert.equal(session.opsRecording.trimmed, 'other');
});

test('what masking a tool list needed is counted in privacy.redactions (M1)', async () => {
  const { send, control, session } = worker();
  await startAt(send);
  await control.hello;
  const page = { tab: { id: 7, url: 'https://example.com/' }, url: 'https://example.com/', origin: 'https://example.com' };
  await send({ from: 'op-scribe/content', type: 'WEBMCP_TOOLS', detail: { names: ['notify_tester@example.com', 'search'] } }, page);
  const rec = session.opsRecording;
  assert.equal(rec.redactions.email, 1);
  assert.ok(!JSON.stringify(rec.webmcpTools).includes('tester@example.com'));
});

test('a start masks what the tester wrote with the keywords as they are when it runs, not when it was asked (K2; ADR 0005)', async () => {
  const { send, control, session } = worker();
  const started = startAt(send, { scope: 'Acme の検索画面' });
  // Registered in another window while the start waits for its turn.
  control.settings = { keywords: ['Acme'] };
  await started;
  assert.ok(!JSON.stringify(session.opsRecording.scope).includes('Acme'), JSON.stringify(session.opsRecording.scope));
});

// ------------------------------------------------------------- tabs opened from the recording (#40)

const startIn7 = async (w) => {
  await w.send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 7, url: 'https://example.com/' } });
  await w.control.hello;
};
const from = (id, url) => ({ tab: { id, url }, url, origin: new URL(url).origin });
// The person adds a waiting tab from the panel, on the page it is on (#72).
const join = (w, id, url) => w.send({ from: 'op-scribe/panel', type: 'ADD_ORIGIN', detail: { url, tabId: id } });
const stepIn = (w, id, url) => w.send({ from: 'op-scribe/content', type: 'STEP', detail: { type: 'click', pageUrl: url, target: { role: 'button', name: 'OK' } } }, from(id, url));

test('a tab opened from the recording waits, even on a site the extension can reach, and joins when the person adds it (#40, #72)', async () => {
  const w = worker();
  await startIn7(w);
  await w.openTab({ id: 9, openerTabId: 7, url: 'https://shop.example.com/item' });
  assert.deepEqual(w.session.opsRecording.tabIds, [7]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, [9]);
  assert.equal((await stepIn(w, 9, 'https://shop.example.com/item')).ok, false);
  // It joins with the page it is on when the person adds it, not the one it opened to.
  assert.equal((await join(w, 9, 'https://shop.example.com/item?redirected')).ok, true);
  const rec = w.session.opsRecording;
  assert.deepEqual(rec.tabIds, [7, 9]);
  assert.deepEqual(rec.waitingTabIds, []);
  assert.ok(rec.grantedPatterns.includes('https://shop.example.com/*'));
  assert.ok(w.control.injected.includes(9), 'the recorder was injected into the new tab');
  assert.equal(rec.steps.at(-1).type, 'navigate');
  assert.equal((await stepIn(w, 9, 'https://shop.example.com/item')).ok, true);
  assert.equal(w.session.opsRecording.steps.at(-1).type, 'click');
  assert.match(JSON.stringify(rec.steps.at(-1).url), /redirected/);
  // A tab opened from that tab can join too.
  await w.openTab({ id: 10, openerTabId: 9, url: 'https://example.com/help' });
  assert.equal((await join(w, 10, 'https://example.com/help')).ok, true);
  assert.deepEqual(w.session.opsRecording.tabIds, [7, 9, 10]);
});

test('a tab opened any other way never joins, and its steps are refused (#40)', async () => {
  const w = worker();
  await startIn7(w);
  await w.openTab({ id: 9, url: 'https://example.com/other' });
  await w.openTab({ id: 10, openerTabId: 99, url: 'https://example.com/other' });
  assert.deepEqual(w.session.opsRecording.tabIds, [7]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, []);
  assert.equal((await stepIn(w, 9, 'https://example.com/other')).ok, false);
});

test('a tab on a site the extension cannot reach waits until the panel adds it, and never joins by a later navigation (#40, #72)', async () => {
  const w = worker();
  await startIn7(w);
  w.control.denied = ['https://login.example.net/*'];
  // The page to open, as Chrome gives it before the tab has loaded.
  await w.openTab({ id: 9, openerTabId: 7, pendingUrl: 'https://login.example.net/' });
  assert.deepEqual(w.session.opsRecording.tabIds, [7]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, [9]);
  assert.equal((await stepIn(w, 9, 'https://login.example.net/')).ok, false);
  // Moving on to a site the extension can reach (the address bar, say) does not make it join.
  await w.urlChanged(9, 'https://example.com/elsewhere');
  assert.deepEqual(w.session.opsRecording.tabIds, [7]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, [9]);
  // Not a page of the web: it does not join, whatever the panel asks.
  assert.equal((await w.send({ from: 'op-scribe/panel', type: 'ADD_ORIGIN', detail: { url: 'chrome://newtab/', tabId: 9 } })).ok, false);
  // The person grants the site in the panel.
  w.control.denied = [];
  const reply = await w.send({ from: 'op-scribe/panel', type: 'ADD_ORIGIN', detail: { url: 'https://login.example.net/', tabId: 9 } });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(w.session.opsRecording.tabIds, [7, 9]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, []);
  // The panel cannot add a tab that is neither recorded nor waiting.
  assert.equal((await w.send({ from: 'op-scribe/panel', type: 'ADD_ORIGIN', detail: { url: 'https://example.com/', tabId: 42 } })).error, 'NOT_RECORDING_TAB');
});

test('a recording holds at most LIMITS.tabs tabs, waiting ones included (#40)', async () => {
  const w = worker();
  await startIn7(w);
  for (let id = 100; id < 120; id += 1) {
    await w.openTab({ id, openerTabId: 7, url: 'https://example.com/x' });
    if (id % 2) await join(w, id, 'https://example.com/x');
  }
  const rec = w.session.opsRecording;
  assert.equal(rec.tabIds.length + rec.waitingTabIds.length, 10);
});

test('closing a tab leaves the recording on; closing its last tab ends it, and a waiting tab closed is forgotten (#40)', async () => {
  const w = worker();
  await startIn7(w);
  await w.openTab({ id: 9, openerTabId: 7, url: 'https://example.com/a' });
  await join(w, 9, 'https://example.com/a');
  await w.openTab({ id: 11, openerTabId: 9, url: 'https://wait.example.net/' });
  await w.removeTab(11);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, []);
  await w.removeTab(7);
  assert.equal(w.session.opsRecording.state, 'recording');
  assert.deepEqual(w.session.opsRecording.tabIds, [9]);
  assert.equal((await stepIn(w, 9, 'https://example.com/a')).ok, true);
  await w.removeTab(9);
  assert.equal(w.session.opsRecording.state, 'stopped');
});

test('a tab whose page Chrome gives only when asked waits by that page (#40)', async () => {
  const w = worker();
  await startIn7(w);
  // Neither url nor pendingUrl on creation: the tab says it only when asked.
  w.control.tabs = { 9: { url: 'https://example.com/late' } };
  await w.openTab({ id: 9, openerTabId: 7 });
  assert.deepEqual(w.session.opsRecording.waitingTabIds, [9]);
});

test('a stop flushes and stops every tab of the recording (#40)', async () => {
  const w = worker();
  await startIn7(w);
  await w.openTab({ id: 9, openerTabId: 7, url: 'https://example.com/a' });
  await join(w, 9, 'https://example.com/a');
  w.control.toTabs = [];
  await w.send({ from: 'op-scribe/panel', type: 'STOP' });
  const sent = (type) => w.control.toTabs.filter(([, t]) => t === type).map(([id]) => id).sort();
  assert.deepEqual(sent('OPS_FLUSH'), [7, 9]);
  assert.deepEqual(sent('OPS_STOP'), [7, 9]);
});

test('a tab that opens to the new tab page is no candidate, even with an opener and a later site it can reach (#72)', async () => {
  const w = worker();
  await startIn7(w);
  // Ctrl+T or the new tab button: Chrome may name the active tab as the opener.
  await w.openTab({ id: 9, openerTabId: 7, pendingUrl: 'chrome://newtab/' });
  await w.urlChanged(9, 'https://example.com/typed');
  assert.deepEqual(w.session.opsRecording.tabIds, [7]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, []);
  assert.equal((await stepIn(w, 9, 'https://example.com/typed')).ok, false);
  // Nor is a tab whose page is unknown when it opens and turns out to be the new tab page.
  await w.openTab({ id: 10, openerTabId: 7 });
  await w.urlChanged(10, 'chrome://newtab/');
  await w.urlChanged(10, 'https://example.com/typed');
  assert.deepEqual(w.session.opsRecording.tabIds, [7]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, []);
  assert.deepEqual(w.session.opsRecording.openingTabIds, []);
});

test('a tab whose page comes only in its first update (window.open) is decided by that page (#72)', async () => {
  const w = worker();
  await startIn7(w);
  await w.openTab({ id: 9, openerTabId: 7 });
  assert.deepEqual(w.session.opsRecording.openingTabIds, [9]);
  await w.urlChanged(9, 'https://example.com/popup');
  assert.deepEqual(w.session.opsRecording.waitingTabIds, [9]);
  assert.deepEqual(w.session.opsRecording.openingTabIds, []);
  // Closed before its first page, it is forgotten.
  await w.openTab({ id: 10, openerTabId: 7 });
  await w.removeTab(10);
  assert.deepEqual(w.session.opsRecording.openingTabIds, []);
});

test('a navigation is recorded before the click that follows it (#72)', async () => {
  const w = worker();
  await startIn7(w);
  const moved = w.urlChanged(7, 'https://example.com/next');
  const clicked = stepIn(w, 7, 'https://example.com/next');
  await Promise.all([moved, clicked]);
  assert.deepEqual(w.session.opsRecording.steps.map((x) => x.type).slice(-2), ['navigate', 'click']);
});

test('a tab that closes while its page is asked for is forgotten, so it never holds a place (#72)', async () => {
  const w = worker();
  await startIn7(w);
  for (let id = 20; id < 29; id += 1) {
    let release;
    w.control.holdGet = new Promise((resolve) => { release = resolve; });
    const opened = w.openTab({ id, openerTabId: 7 });
    await w.removeTab(id);
    w.control.gone = [...(w.control.gone || []), id];
    release();
    await opened;
  }
  w.control.holdGet = null;
  assert.deepEqual(w.session.opsRecording.openingTabIds, []);
  // A link opened afterwards still finds a place.
  await w.openTab({ id: 30, openerTabId: 7, pendingUrl: 'https://example.com/link' });
  assert.deepEqual(w.session.opsRecording.waitingTabIds, [30]);
});

test('a first update that comes while the page is asked for decides, and a later one does not (#72)', async () => {
  const w = worker();
  await startIn7(w);
  let release;
  w.control.holdGet = new Promise((resolve) => { release = resolve; });
  const opened = w.openTab({ id: 9, openerTabId: 7 });
  // Ctrl+T: the new tab page comes first, then the address the person types.
  await w.urlChanged(9, 'chrome://newtab/');
  release();
  await opened;
  await w.urlChanged(9, 'https://example.com/typed');
  assert.deepEqual(w.session.opsRecording.tabIds, [7]);
  assert.deepEqual(w.session.opsRecording.waitingTabIds, []);
  assert.deepEqual(w.session.opsRecording.openingTabIds, []);
});
