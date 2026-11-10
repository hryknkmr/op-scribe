import { test, expect } from './fixtures.mjs';

// The settings hold the send target's Authorization header, the keywords and the real hosts. The recorder
// runs in the page's process, so it must not be able to read them (service-worker.js, setAccessLevel).
test('the recorder in a recorded page cannot read the settings', async ({ context, panel }) => {
  const site = await context.newPage();
  // The recorder's world is reached the only way a test can: through the DevTools protocol.
  const cdp = await context.newCDPSession(site);
  const live = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context: c }) => live.set(c.id, c));
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => live.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => live.clear());
  await cdp.send('Runtime.enable');
  await site.goto('http://a.test/');
  await panel.start(site);
  await expect.poll(async () => (await panel.recording())?.attached).toBe(true);
  const recorder = [...live.values()].find((c) => c.auxData?.type === 'isolated' && c.name === 'op-scribe');
  expect(recorder, 'the recorder\'s world').toBeTruthy();
  const { result } = await cdp.send('Runtime.evaluate', {
    contextId: recorder.id,
    awaitPromise: true,
    returnByValue: true,
    expression: `chrome.storage.local.get(null).then((v) => 'read: ' + Object.keys(v).join(','), (e) => 'refused: ' + e.message)`
  });
  expect(result.value).toMatch(/^refused: /);
});
