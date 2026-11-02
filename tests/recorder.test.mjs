// content/recorder.js in a vm with a stand-in for the page and the chrome APIs it uses (#9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Which fields count as typed into is the real rule, not a stand-in.
const { isTextField } = createRequire(import.meta.url)('../shared/target.js');

const source = readFileSync(new URL('../content/recorder.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  class Element {}
  const attrs = {};
  const field = Object.assign(new Element(), {
    tagName: 'INPUT', value: '', id: '', nodeType: 1, parentElement: null, attrs,
    isContentEditable: false, labels: [], getAttribute: (name) => attrs[name] ?? null, closest: () => null, matches: () => true
  });
  field.contains = (node) => node === field;
  Object.defineProperty(field, 'type', { get: () => attrs.type || 'text' });
  const pageEvents = {};
  let onMessage;
  const sent = [];
  const control = { recording: 'first', fail: () => false };
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (control.fail(message)) throw new Error('Receiving end does not exist');
        // A HELLO may be answered late: it is answered for the recording asked about then.
        const recording = control.recording;
        if (message.type === 'HELLO' && control.hold) await control.hold;
        if (message.type === 'HELLO') sent.push(message);
        if (message.type === 'HELLO') return { active: true, config: { recording, commercial: false, keywords: [] } };
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
    OpScribeTarget: { isTextField, implicitRole: () => 'textbox', operated: () => null, isOperated: () => false, accessibleName: () => 'q', inSearch: () => false },
    // A stand-in for the masking: a password field's value is redacted, any other kept.
    OpScribeSanitize: {
      maskFieldValue: (value, meta) => (meta.type === 'password'
        ? { value: { field: 'password', treatment: 'redacted' }, kinds: ['password'] }
        : { value: { field: 'text', text: [value], treatment: 'kept' }, kinds: [] })
    },
    OpScribeLimits: { LIMITS: {} }
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'content/recorder.js' });
  const type = (value) => {
    field.value = value;
    pageEvents.input({ isTrusted: true, composedPath: () => [field] });
  };
  const change = () => pageEvents.change({ isTrusted: true, composedPath: () => [field] });
  const click = () => pageEvents.click({ isTrusted: true, detail: 1, composedPath: () => [field] });
  const blur = () => pageEvents.focusout({ isTrusted: true, composedPath: () => [field] });
  const steps = () => sent.filter((m) => m.type === 'STEP').map((m) => m.detail.type);
  const worker = (message) => new Promise((resolve) => {
    if (onMessage({ from: 'op-scribe/worker', ...message }, {}, resolve) !== true) resolve();
  });
  const inputs = () => sent.filter((m) => m.type === 'STEP' && m.detail.type === 'input');
  return { field, type, change, click, blur, steps, worker, inputs, control, again: () => context.__opScribeRecorder.hello() };
}

test('the value a person is still typing is committed when the recording stops (#9)', async () => {
  const r = recorder();
  await tick();
  r.type('いぬ');
  await r.worker({ type: 'OPS_FLUSH' });
  assert.deepEqual(r.inputs().map((m) => m.detail.value.text), [['いぬ']]);
});

test('what is committed is what the person typed, not a value the page set afterwards (#9, W7)', async () => {
  const r = recorder();
  await tick();
  r.type('いぬ');
  r.field.value = 'うそ';
  await r.worker({ type: 'OPS_FLUSH' });
  assert.deepEqual(r.inputs().map((m) => m.detail.value.text), [['いぬ']]);
});

test('a value typed into a password field stays redacted when the page renames the field afterwards (#9, I2)', async () => {
  for (const commit of [(r) => r.worker({ type: 'OPS_FLUSH' }), async (r) => r.change()]) {
    const r = recorder();
    await tick();
    r.field.attrs.type = 'password';
    r.type('ひみつ');
    r.field.attrs.type = 'text';
    r.field.attrs.autocomplete = 'off';
    await commit(r);
    assert.deepEqual(r.inputs().map((m) => m.detail.value), [{ field: 'password', treatment: 'redacted' }]);
    assert.doesNotMatch(JSON.stringify(r.inputs()), /ひみつ/);
  }
});

test('a change with no input before it is taken as the field is at that change', async () => {
  const r = recorder();
  await tick();
  r.field.value = 'えらんだ';
  r.change();
  assert.deepEqual(r.inputs().map((m) => m.detail.value.text), [['えらんだ']]);
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

test('a pending input is committed by the field it was typed into, whatever the page made of the field (#9)', async () => {
  // Turned into a checkbox the person then clicks: the change commits the typed value first, still redacted, once.
  let r = recorder();
  await tick();
  r.field.attrs.type = 'password';
  r.type('ひみつ');
  r.field.attrs.type = 'checkbox';
  r.click();
  r.change();
  r.blur();
  assert.deepEqual(r.steps(), ['input', 'check']);
  assert.deepEqual(r.inputs().map((m) => m.detail.value), [{ field: 'password', treatment: 'redacted' }]);

  // No longer editable: leaving it commits what was typed, before what the person does next.
  r = recorder();
  await tick();
  r.field.isContentEditable = true;
  r.field.innerText = 'メモ';
  r.type('メモ');
  r.field.isContentEditable = false;
  r.blur();
  assert.deepEqual(r.inputs().map((m) => m.detail.value.text), [['メモ']]);
});

test('a field the person only slides or picks from is taken at their input too, not at the change (#9, I5)', async () => {
  const r = recorder();
  await tick();
  r.field.attrs.type = 'range';
  r.type('30');
  r.field.value = '90';
  r.change();
  assert.deepEqual(r.inputs().map((m) => m.detail.value.text), [['30']]);
});

test('what was pending for a recording whose stop never reached the page stays out of the next (#9)', async () => {
  const r = recorder();
  await tick();
  r.type('いぬ');
  // No OPS_STOP: the next recording starts, and the page is asked again.
  r.control.recording = 'second';
  await r.again();
  await r.worker({ type: 'OPS_FLUSH' });
  assert.deepEqual(r.inputs(), []);
});

test('a late answer to an earlier HELLO does not undo the latest one (#9)', async () => {
  const r = recorder();
  await tick();
  let answerFirst;
  r.control.hold = new Promise((resolve) => { answerFirst = resolve; });
  r.control.recording = 'old';
  const earlier = r.again();
  r.control.hold = null;
  r.control.recording = 'new';
  await r.again();
  r.type('いぬ');
  answerFirst();
  await earlier;
  await r.worker({ type: 'OPS_FLUSH' });
  assert.deepEqual(r.inputs().map((m) => m.recording), ['new']);
});
