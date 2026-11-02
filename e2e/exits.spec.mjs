import { test, expect } from './fixtures.mjs';

// What leaves the browser is checked at every exit (AGENTS.md): here a word registered after the
// recording, which the recording kept as typed, has to stop the copy, the save and the send (E6, K2).

const setKeywords = (panel, keywords) => panel.page.evaluate(async (k) => {
  const { opsSettings } = await chrome.storage.local.get('opsSettings');
  await chrome.storage.local.set({ opsSettings: { ...opsSettings, keywords: k, endpoint: 'https://recv.test/', authHeader: '' } });
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

// Counts what the panel writes to the clipboard, so a copy that is stopped is seen to write nothing.
const countCopies = (panel) => panel.page.evaluate(() => {
  window.__copies = [];
  navigator.clipboard.writeText = async (text) => { window.__copies.push(text); };
});
const copies = (panel) => panel.page.evaluate(() => window.__copies);

test('a word registered after the recording stops the copy, the save and the send (E6, K2)', async ({ context, panel }) => {
  await recordTyping(context, panel, 'Acme の請求書');
  // Kept as typed: it was no keyword then.
  expect(JSON.stringify((await panel.recording()).steps)).toContain('Acme');
  const sent = [];
  await context.route('https://recv.test/**', (route) => { sent.push(route.request().postData()); return route.fulfill({ status: 204 }); });
  await countCopies(panel);

  // Before the word is registered, every exit goes through: the save, the copy and the send.
  await setKeywords(panel, []);
  const download = panel.page.waitForEvent('download');
  await press(panel, 'download');
  expect((await download).suggestedFilename()).toMatch(/\.opscribe\.json$/);
  await press(panel, 'copy-gherkin');
  await expect.poll(() => copies(panel)).toHaveLength(1);
  await press(panel, 'preview');
  await expect(panel.page.locator('#send')).toBeEnabled();
  await press(panel, 'send');
  await expect(panel.page.locator('#send-status')).toContainText('送信しました');
  expect(sent).toHaveLength(1);

  // Registered after the preview: the send checks again and stops.
  await press(panel, 'preview');
  await expect(panel.page.locator('#send')).toBeEnabled();
  await setKeywords(panel, ['Acme']);
  await press(panel, 'send');
  await expect(panel.page.locator('#send-status')).toContainText('伏せ忘れの疑いがあるため中止しました');

  // The save and the copy stop too, writing nothing.
  let downloaded = false;
  panel.page.on('download', () => { downloaded = true; });
  for (const id of ['download', 'copy-gherkin']) {
    await status(panel).evaluate((p) => { p.textContent = ''; });
    await press(panel, id);
    await expect(status(panel)).toContainText('伏せ忘れの疑いがあるため中止しました');
  }
  // A new preview names the finding and leaves the send off.
  await press(panel, 'preview');
  await expect(panel.page.locator('#findings .bad').first()).toBeVisible();
  await expect(panel.page.locator('#send')).toBeDisabled();
  expect(downloaded).toBe(false);
  expect(await copies(panel)).toHaveLength(1);
  expect(sent).toHaveLength(1);
});

test('a secret written into the Markdown by hand stops its copy (E4)', async ({ context, panel }) => {
  await recordTyping(context, panel, '天気');
  await setKeywords(panel, []);
  await countCopies(panel);
  const write = (text) => panel.page.locator('#repro').evaluate((area, t) => {
    area.value = t;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  // Without the secret the copy goes through.
  await write('## 手順\n1. 検索する');
  await press(panel, 'copy-md');
  await expect.poll(() => copies(panel)).toHaveLength(1);
  // A token-shaped value pasted into the reproduction, assembled here so no file holds it whole.
  const token = ['ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  await write(`## 手順\n1. 検索する\n\ntoken: ${token}`);
  await press(panel, 'copy-md');
  await expect(status(panel)).toContainText('伏せ忘れの疑いがあるため中止しました');
  expect(await copies(panel)).toHaveLength(1);
});

test('a verdict given after the preview stops the send, and a new preview sends it (ADR 0005)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  const toWorker = (type, detail) => panel.page.evaluate(([t, d]) => chrome.runtime.sendMessage({ from: 'op-scribe/panel', type: t, detail: d }), [type, detail]);
  expect(await toWorker('ADD_NOTE', { text: '一覧が出る' })).toEqual({ ok: true });
  await panel.stop();
  await panel.page.reload();
  await setKeywords(panel, []);
  const sent = [];
  await context.route('https://recv.test/**', (route) => { sent.push(route.request().postData()); return route.fulfill({ status: 204 }); });
  await press(panel, 'preview');
  await expect(panel.page.locator('#send')).toBeEnabled();
  // The verdict does not move the revision, but it changes what would be sent.
  const { id, steps } = await panel.recording();
  const { ref } = steps.find((s) => s.type === 'note');
  expect(await toWorker('SET_VERDICT', { recordingId: id, ref, verdict: 'ok' })).toEqual({ ok: true });
  await press(panel, 'send');
  await expect(panel.page.locator('#send-status')).toContainText('プレビューの後に記録が変わりました');
  expect(sent).toHaveLength(0);
  // Previewed again, it goes, with the verdict in it.
  await press(panel, 'preview');
  await press(panel, 'send');
  await expect(panel.page.locator('#send-status')).toContainText('送信しました');
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]).recording.steps.find((s) => s.ref === ref).verdict).toBe('ok');
});

test('a stop after the preview stops the send (ADR 0005)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await setKeywords(panel, []);
  const sent = [];
  await context.route('https://recv.test/**', (route) => { sent.push(route.request().postData()); return route.fulfill({ status: 204 }); });
  await press(panel, 'preview');
  await expect(panel.page.locator('#send')).toBeEnabled();
  // The stop writes the end and moves no revision: the send still sees the change.
  await panel.stop();
  await press(panel, 'send');
  await expect(panel.page.locator('#send-status')).toContainText('プレビューの後に記録が変わりました');
  expect(sent).toHaveLength(0);
});
