// content/recorder.js in a vm with a stand-in for the page and the chrome APIs it uses (#9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../content/recorder.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  class Element {}
  const field = Object.assign(new Element(), {
    tagName: 'INPUT', type: 'text', value: '', id: '', nodeType: 1, parentElement: null,
    isContentEditable: false, labels: [], getAttribute: () => null, closest: () => null
  });
  const pageEvents = {};
  let onMessage;
  const sent = [];
  const control = { recording: 'first', fail: () => false };
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (control.fail(message)) throw new Error('Receiving end does not exist');
        sent.push(message);
        return message.type === 'HELLO' ? { active: true, config: { recording: control.recording, commercial: false, keywords: [] } } : { ok: true };
      },
      onMessage: { addListener: (fn) => { onMessage = fn; } }
    },
    storage: { onChanged: { addListener: () => {} } }
  };
  const context = vm.createContext({
    chrome, Element, setTimeout, clearTimeout, console,
    MutationObserver: class { observe() {} disconnect() {} },
    location: { href: 'https://example.com/', origin: 'https://example.com' },
    window: { addEventListener: (type, fn) => { pageEvents[type] = fn; }, postMessage: () => {} },
    document: { activeElement: field, body: {}, querySelectorAll: () => [] },
    OpScribeTarget: { isTextField: (el) => el.tagName === 'INPUT', implicitRole: () => 'textbox', operated: () => null, isOperated: () => false, accessibleName: () => 'q', inSearch: () => false },
    OpScribeSanitize: { maskFieldValue: (value) => ({ value: { field: 'text', text: [value], treatment: 'kept' }, kinds: [] }) },
    OpScribeLimits: { LIMITS: {} }
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'content/recorder.js' });
  const type = (value) => {
    field.value = value;
    pageEvents.input({ isTrusted: true, composedPath: () => [field] });
  };
  const worker = (message) => new Promise((resolve) => {
    if (onMessage({ from: 'op-scribe/worker', ...message }, {}, resolve) !== true) resolve();
  });
  const inputs = () => sent.filter((m) => m.type === 'STEP' && m.detail.type === 'input');
  return { field, type, worker, inputs, control, again: () => context.__opScribeRecorder.hello() };
}

test('the value a person is still typing is committed when the recording stops (#9)', async () => {
  const r = recorder();
  await tick();
  r.type('いぬ');
  await r.worker({ type: 'OPS_FLUSH' });
  assert.deepEqual(r.inputs().map((m) => m.detail.value.text), [['いぬ']]);
});

test('a value the page set after the person typed is not committed for them (#9, W7)', async () => {
  const r = recorder();
  await tick();
  r.type('いぬ');
  r.field.value = 'うそ';
  await r.worker({ type: 'OPS_FLUSH' });
  assert.deepEqual(r.inputs(), []);
});

test('a step sent again after a failed try names the recording it was sent for (#9)', async () => {
  const r = recorder();
  await tick();
  r.type('いぬ');
  let tries = 0;
  r.control.fail = (m) => m.type === 'STEP' && (tries += 1) === 1;
  const flushed = r.worker({ type: 'OPS_FLUSH' });
  // While the step waits to be sent again, this recording ends and the next one starts.
  await r.worker({ type: 'OPS_STOP' });
  r.control.recording = 'second';
  await r.again();
  await flushed;
  assert.deepEqual(r.inputs().map((m) => m.recording), ['first']);
});
