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
    tabs: { onUpdated: { addListener: (fn) => { updated.push(fn); } }, onRemoved: on('removed'), sendMessage: async (id, message) => { if (control.noRecorder) throw new Error('no receiver'); if (message.type === 'OPS_PING') await control.ping; if (message.type === 'OPS_FLUSH') await control.flush?.(); } },
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
  return { send, hello, pageLoaded, removeTab, seen, control, session };
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
  // The closed tab's recording is read, and another starts before the stop is queued.
  const removed = removeTab(7);
  await send({ from: 'op-scribe/panel', type: 'START', detail: { tabId: 8, url: 'https://example.com/' } });
  release();
  await removed;
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

test('a stop that comes after another one says what was not tested was not saved (ADR 0005)', async () => {
  const { send, control, session } = worker();
  await startAt(send);
  await control.hello;
  const id = session.opsRecording.id;
  // Two panels stop at once; the second one's text cannot be saved and it is told so.
  const [first, second] = await Promise.all([
    send(panel('STOP', { recordingId: id, notTested: '決済' })),
    send(panel('STOP', { recordingId: id, notTested: '返品' }))
  ]);
  assert.deepEqual([plain(first), plain(second)], [{ ok: true }, { ok: false, reason: 'ALREADY_STOPPED' }]);
  assert.deepEqual(plain(session.opsRecording.notTested), ['決済']);
  // A stop with nothing written after the end is no failure.
  assert.deepEqual(plain(await send(panel('STOP', { recordingId: id }))), { ok: true });
  assert.deepEqual(plain(await send(panel('STOP', { recordingId: id, notTested: '  ' }))), { ok: true });
  assert.deepEqual(plain(await send(panel('STOP', { recordingId: id, notTested: '在庫' }))), { ok: false, reason: 'ALREADY_STOPPED' });
});
