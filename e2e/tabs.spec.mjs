import { test, expect } from './fixtures.mjs';

// A tab opened from a tab of the recording waits, and joins when the person adds it in the panel; any other tab
// never does (#40, #72).

// What the panel sends when the person presses "このタブも記録する" on that tab. The panel shows the
// button only once the tab waits: a page Playwright sees may still be opening to the worker, and
// may not yet be the tab's url to Chrome.
async function join(panel, page) {
  await page.waitForURL(/^http:/);
  let tabId;
  await expect.poll(async () => (tabId = await panel.page.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, page.url()))).toBeDefined();
  await expect.poll(async () => (await panel.recording()).waitingTabIds ?? []).toContain(tabId);
  const reply = await panel.page.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    return chrome.runtime.sendMessage({ from: 'op-scribe/panel', type: 'ADD_ORIGIN', detail: { url: tab.url, tabId: tab.id } });
  }, tabId);
  expect(reply).toMatchObject({ ok: true });
}

test('a tab opened by a link or window.open joins the recording, and what is done there is recorded (#40)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/tabs.html');
  await panel.start(site);

  const [byLink] = await Promise.all([context.waitForEvent('page'), site.click('#blank')]);
  await byLink.waitForLoadState();
  // It waits, though the extension can reach the site, until the person adds it.
  await expect.poll(async () => (await panel.recording()).waitingTabIds?.length).toBe(1);
  expect((await panel.recording()).tabIds).toHaveLength(1);
  await join(panel, byLink);
  await expect.poll(async () => (await panel.recording()).tabIds?.length).toBe(2);
  await byLink.waitForFunction(() => document.readyState === 'complete');
  await byLink.fill('#q', 'Bで入力');
  await byLink.click('#go');
  await expect.poll(async () => (await panel.recording()).steps.filter((s) => s.source === 'user').map((s) => s.type)).toEqual(['click', 'input', 'click']);

  const [byScript] = await Promise.all([context.waitForEvent('page'), site.click('#open')]);
  await byScript.waitForLoadState();
  await expect.poll(async () => (await panel.recording()).waitingTabIds?.length).toBe(1);
  await join(panel, byScript);
  await expect.poll(async () => (await panel.recording()).tabIds?.length).toBe(3);

});

test('a popup opened empty and sent to its page afterwards waits by that page (#72)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/tabs.html');
  await panel.start(site);
  const [popup] = await Promise.all([context.waitForEvent('page'), site.click('#open-blank')]);
  await popup.waitForURL('http://c.test/');
  await popup.waitForLoadState();
  await expect.poll(async () => (await panel.recording()).waitingTabIds?.length).toBe(1);
  expect((await panel.recording()).openingTabIds ?? []).toHaveLength(0);
  await join(panel, popup);
  await expect.poll(async () => (await panel.recording()).tabIds?.length).toBe(2);
});

test('a tab not opened from the recording is not recorded, and the recording ends with its last tab (#40)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/tabs.html');
  await panel.start(site);
  const [child] = await Promise.all([context.waitForEvent('page'), site.click('#blank')]);
  await join(panel, child);
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
