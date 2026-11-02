import { test, expect } from './fixtures.mjs';

test('records the page open at the start, then what the person does on it (#23, W7)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await site.fill('#q', '天気');
  await site.click('#go');
  await expect(site.locator('#result')).toHaveText('結果を表示しました');
  // The recorder sends without waiting: the click has reached the recording before it stops.
  await expect.poll(async () => (await panel.recording()).steps.map((s) => s.type)).toContain('click');
  await panel.stop();
  const rec = await panel.recording();
  expect(rec.steps[0]).toMatchObject({ type: 'navigate', source: 'unknown' });
  const types = rec.steps.map((s) => `${s.type}:${s.source}`);
  expect(types).toContain('input:user');
  // Typed text in an ordinary field on a site that is not commercial is kept, as typed (I8).
  expect(rec.steps.find((s) => s.type === 'input').value).toEqual({ field: 'text', text: ['天気'], treatment: 'kept' });
  expect(types).toContain('click:user');
  // The host is not on the allowlist: the recording names it by its alias.
  expect(JSON.stringify(rec.steps)).not.toContain('a.test');
});

test('the tests reach no host but the made-up ones', async ({ context }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  const reached = await site.evaluate(async () => {
    try { await fetch('https://example.com/', { mode: 'no-cors' }); return true; } catch { return false; }
  });
  expect(reached).toBe(false);
  // A WebSocket is closed by the tests' own handler, never connected to the host.
  const closed = await site.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket('wss://example.com/');
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  }));
  expect(closed).toEqual({ code: 4000, reason: 'e2e: no real hosts' });
});
