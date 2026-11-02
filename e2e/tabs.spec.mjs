import { test, expect } from './fixtures.mjs';

// A tab opened from a tab of the recording joins it; any other tab does not (#40).

test('a tab opened by a link or window.open joins the recording, and what is done there is recorded (#40)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/tabs.html');
  await panel.start(site);

  const [byLink] = await Promise.all([context.waitForEvent('page'), site.click('#blank')]);
  await byLink.waitForLoadState();
  await expect.poll(async () => (await panel.recording()).tabIds?.length).toBe(2);
  await byLink.waitForFunction(() => document.readyState === 'complete');
  await byLink.fill('#q', 'Bで入力');
  await byLink.click('#go');
  await expect.poll(async () => (await panel.recording()).steps.filter((s) => s.source === 'user').map((s) => s.type)).toEqual(['click', 'input', 'click']);

  const [byScript] = await Promise.all([context.waitForEvent('page'), site.click('#open')]);
  await byScript.waitForLoadState();
  await expect.poll(async () => (await panel.recording()).tabIds?.length).toBe(3);

  // The browser-only tab lists are kept with the recording, never in what it sends.
  const rec = await panel.recording();
  expect(rec.tabIds).toHaveLength(3);
});

test('a tab not opened from the recording is not recorded, and the recording ends with its last tab (#40)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/tabs.html');
  await panel.start(site);
  const [child] = await Promise.all([context.waitForEvent('page'), site.click('#blank')]);
  await expect.poll(async () => (await panel.recording()).tabIds?.length).toBe(2);

  // A tab not opened from the recording. Playwright's newPage() names the page open before it as the
  // opener, so the tab is made from the panel, with no opener, as a new tab of the browser is.
  const [other] = await Promise.all([context.waitForEvent('page'), panel.page.evaluate(() => chrome.tabs.create({ url: 'http://d.test/' }))]);
  await other.waitForURL('http://d.test/');
  await other.waitForLoadState();
  await other.fill('#q', 'ほかのタブ');
  await other.click('#go');

  // The tab the recording started in closes; the one opened from it goes on.
  await site.close();
  await child.waitForFunction(() => document.readyState === 'complete');
  await child.fill('#q', '子タブ');
  await child.click('#go');
  await expect.poll(async () => (await panel.recording()).steps.filter((s) => s.source === 'user').map((s) => s.type)).toEqual(['click', 'input', 'click']);
  expect(JSON.stringify((await panel.recording()).steps)).not.toContain('ほかのタブ');
  expect((await panel.recording()).state).toBe('recording');

  await child.close();
  await expect.poll(async () => (await panel.recording()).state).toBe('stopped');
});
