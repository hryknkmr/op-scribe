import { test, expect } from './fixtures.mjs';

// What leaves the browser is checked at every exit (AGENTS.md): here a word registered after the
// recording, which the recording kept as typed, has to stop the copy, the save and the send (E6, K2).

const setKeywords = (panel, keywords) => panel.page.evaluate(async (k) => {
  const { opsSettings } = await chrome.storage.local.get('opsSettings');
  await chrome.storage.local.set({ opsSettings: { ...opsSettings, keywords: k, endpoint: 'http://recv.test/', authHeader: '' } });
}, keywords);
const press = (panel, id) => panel.page.locator(`#${id}`).evaluate((button) => button.click());
const status = (panel) => panel.page.locator('#output-status');

async function recordTyping(context, panel, text) {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await site.fill('#q', text);
  await site.press('#q', 'Enter');
  await expect.poll(async () => (await panel.recording()).steps.map((s) => s.type)).toContain('key');
  await panel.stop();
  // The panel draws the recording it reads.
  await panel.page.reload();
}

test('a word registered after the recording stops the copy, the save and the send (E6, K2)', async ({ context, panel }) => {
  await recordTyping(context, panel, 'Acme の請求書');
  // Kept as typed: it was no keyword then.
  expect(JSON.stringify((await panel.recording()).steps)).toContain('Acme');

  // Before the word is registered, the save goes through.
  await setKeywords(panel, []);
  const download = panel.page.waitForEvent('download');
  await press(panel, 'download');
  expect((await download).suggestedFilename()).toMatch(/\.opscribe\.json$/);

  await setKeywords(panel, ['Acme']);
  let downloaded = false;
  panel.page.on('download', () => { downloaded = true; });
  for (const id of ['download', 'copy-gherkin']) {
    await status(panel).evaluate((p) => { p.textContent = ''; });
    await press(panel, id);
    await expect(status(panel)).toContainText('伏せ忘れの疑いがあるため中止しました');
  }
  expect(downloaded).toBe(false);

  // The preview names the finding and the send stays off, so nothing reaches the endpoint.
  const sent = [];
  await context.route('http://recv.test/**', (route) => { sent.push(route.request().url()); return route.fulfill({ status: 204 }); });
  await press(panel, 'preview');
  await expect(panel.page.locator('#findings .bad').first()).toBeVisible();
  await expect(panel.page.locator('#send')).toBeDisabled();
  expect(sent).toEqual([]);
});

test('a secret written into the Markdown by hand stops its copy (E4)', async ({ context, panel }) => {
  await recordTyping(context, panel, '天気');
  await setKeywords(panel, []);
  // A token-shaped value pasted into the reproduction, assembled here so no file holds it whole.
  const token = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  await panel.page.locator('#repro').evaluate((area, t) => {
    area.value = `## 手順\n1. 検索する\n\ntoken: ${t}`;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, token);
  await press(panel, 'copy-md');
  await expect(status(panel)).toContainText('伏せ忘れの疑いがあるため中止しました');
});
