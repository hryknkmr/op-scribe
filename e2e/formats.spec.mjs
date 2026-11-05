import { test, expect } from './fixtures.mjs';

// The readers' formats from the panel (ADR 0005): a bug ticket for an NG and the session record,
// copied through their exit, which scans each whole text with the keywords as they are now.

const openSection = (ui, id) => ui.locator(`#${id}`).evaluate((node) => { node.closest('details').open = true; });
const countCopies = (ui) => ui.evaluate(() => {
  window.__copies = [];
  navigator.clipboard.writeText = async (text) => { window.__copies.push(text); };
});
const copies = (ui) => ui.evaluate(() => window.__copies);

test('a bug ticket and the session record are copied from the recording, and a keyword stops them (ADR 0005)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  expect(await panel.send('ADD_NOTE', { text: '検索結果が出る' })).toEqual({ ok: true });
  const { id, steps } = await panel.recording();
  const { ref } = steps.find((s) => s.type === 'note');
  expect(await panel.send('SET_VERDICT', { recordingId: id, ref, verdict: 'ng', actual: 'Acme の画面が出る' })).toEqual({ ok: true });
  await panel.page.reload();
  const ui = panel.page;
  await countCopies(ui);
  await openSection(ui, 'copy-ticket');
  // While recording: a ticket can be made, the session record not yet.
  await expect(ui.locator('#ticket-ref')).toHaveValue(ref);
  await expect(ui.locator('#copy-session')).toBeDisabled();
  // A hand-edited Markdown that is stale does not matter: the formats never use it.
  await ui.locator('#repro').evaluate((t) => { t.value = '手で書いた手順'; t.dispatchEvent(new Event('input')); });
  await panel.send('ADD_NOTE', { text: '後から足したメモ', kind: 'idea' });
  await ui.locator('#copy-ticket').click();
  await expect(ui.locator('#output-status')).toHaveText('バグチケットをコピーしました');
  await expect.poll(() => copies(ui)).toHaveLength(1);
  const [ticket] = await copies(ui);
  expect(ticket.split('\n')[0]).toMatch(new RegExp(`^# \\[${ref}\\] 『検索結果が出る』が期待どおりにならない（.+）$`));
  expect(ticket).toContain('## 実際の結果\nAcme の画面が出る');
  expect(ticket).toContain(`記録 ID: ${id}`);

  await panel.stop();
  await expect(ui.locator('#copy-session')).toBeEnabled();
  await ui.locator('#copy-session').click();
  await expect.poll(() => copies(ui)).toHaveLength(2);
  const session = (await copies(ui))[1];
  expect(session).toContain('## 結論\n問題あり（NG 1 件）');
  expect(session).toContain(`- [${ref}] 検索結果が出る`);

  // Registered now: both stop, and nothing more is written.
  await ui.evaluate(async () => {
    const { opsSettings } = await chrome.storage.local.get('opsSettings');
    await chrome.storage.local.set({ opsSettings: { ...opsSettings, keywords: ['Acme'] } });
  });
  for (const button of ['copy-ticket', 'copy-session']) {
    await ui.locator('#output-status').evaluate((p) => { p.textContent = ''; });
    await ui.locator(`#${button}`).click();
    await expect(ui.locator('#output-status')).toContainText('伏せ忘れの疑いがあるため中止しました');
  }
  expect(await copies(ui)).toHaveLength(2);
});

test('the Playwright test copied from the panel replays the recording in a fresh page (#2)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await site.fill('#q', '天気');
  await site.click('#go');
  await expect.poll(async () => (await panel.recording()).steps.map((s) => s.type)).toContain('click');
  await panel.stop();
  const ui = panel.page;
  await countCopies(ui);
  await openSection(ui, 'copy-playwright');
  await ui.locator('#copy-playwright').click();
  await expect(ui.locator('#output-status')).toHaveText('Playwright テストをコピーしました');
  await expect.poll(() => copies(ui)).toHaveLength(1);
  const [file] = await copies(ui);
  expect(file).toContain('import { test, expect } from "@playwright/test";');
  expect(file).not.toContain('a.test');

  // Run the file's test with the real expect against a new page; the alias's origin comes from the environment.
  const code = file.split('\n').filter((l) => !l.startsWith('import ')).join('\n');
  let body = null;
  const register = Object.assign((title, fn) => { body = fn; }, { fixme: (cond, why) => { if (cond) throw new Error(`fixme: ${why}`); } });
  const AsyncFunction = (async () => {}).constructor;
  await new AsyncFunction('test', 'expect', 'process', 'delimiter', code)(register, expect, { env: { OPSCRIBE_SITE_1: 'http://a.test' } }, ':');
  const replay = await context.newPage();
  await body({ page: replay, context });
  await expect(replay.locator('#q')).toHaveValue('天気');
  await expect(replay.locator('#result')).toHaveText('結果を表示しました');
});
