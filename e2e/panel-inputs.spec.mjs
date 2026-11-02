import { test, expect } from './fixtures.mjs';

// What the tester writes in the panel (ADR 0005): the scope and the version at the start, a verdict
// on each expectation with the actual result of an NG, and what was not tested at the stop.

// The panel's sections open one at a time: the one holding the element is opened first.
const openSection = (ui, id) => ui.locator(`#${id}`).evaluate((node) => { node.closest('details').open = true; });

test('the panel takes a verdict on each expectation and what was not tested at the stop (ADR 0005)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  // The start as the panel sends it; this panel is a tab, so its own start button has no page to record.
  const tab = await panel.page.evaluate(async () => (await chrome.tabs.query({ url: 'http://a.test/*' }))[0]);
  expect(await panel.send('START', { tabId: tab.id, url: tab.url, scope: '検索画面の絞り込み', targetVersion: '2.3.0' })).toEqual({ ok: true });
  await panel.page.reload();
  const ui = panel.page;
  await openSection(ui, 'rec-meta');
  await expect(ui.locator('#rec-meta')).toContainText('対象と範囲: 検索画面の絞り込み');
  await expect(ui.locator('#scope')).toBeDisabled();
  await expect(ui.locator('#not-tested')).toBeEnabled();

  // An expectation gets a verdict form; an exploration note does not.
  await openSection(ui, 'note-input');
  await ui.locator('#note-input').fill('一覧に結果が出る');
  await ui.locator('#note-form button[type="submit"]').click();
  await ui.locator('#note-kind').selectOption('idea');
  await ui.locator('#note-input').fill('並び順が気になる');
  await ui.locator('#note-form button[type="submit"]').click();
  const form = ui.locator('form.verdict');
  await expect(form).toHaveCount(1);
  const ref = await form.getAttribute('data-ref');
  expect(ref).toMatch(/^E-[0-9a-z]{6}$/);
  const verdictOf = async () => (await panel.recording()).steps.find((s) => s.ref === ref);

  // NG without an actual result is not sent: the browser asks for it.
  await form.getByLabel('NG', { exact: true }).check();
  await form.getByRole('button', { name: '判定を保存' }).click();
  await expect(form.locator('[name="actual"]')).toHaveJSProperty('validity.valueMissing', true);
  expect((await verdictOf()).verdict).toBeUndefined();

  // With it, the worker keeps the NG and the panel draws what was kept.
  await form.locator('[name="actual"]').fill('一覧が空のまま');
  await form.getByRole('button', { name: '判定を保存' }).click();
  await expect.poll(async () => (await verdictOf()).verdict).toBe('ng');
  expect((await verdictOf()).actual).toEqual(['一覧が空のまま']);
  await expect(ui.locator('form.verdict legend')).toContainText('NG');

  // OK clears the actual result.
  await ui.locator('form.verdict').getByLabel('OK', { exact: true }).check();
  await ui.locator('form.verdict').getByRole('button', { name: '判定を保存' }).click();
  await expect.poll(async () => (await verdictOf()).verdict).toBe('ok');
  expect((await verdictOf()).actual).toBeUndefined();

  // The stop names this recording and keeps what was not tested.
  await openSection(ui, 'not-tested');
  await ui.locator('#not-tested').fill('決済と返品');
  await ui.locator('#rec-stop').click();
  await expect.poll(async () => (await panel.recording()).state).toBe('stopped');
  expect((await panel.recording()).notTested).toEqual(['決済と返品']);
  await expect(ui.locator('#rec-meta')).toContainText('やっていないこと: 決済と返品');
});

test('a verdict being written keeps its choice and its text while steps arrive (ADR 0005)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await panel.page.reload();
  const ui = panel.page;
  await openSection(ui, 'note-input');
  await ui.locator('#note-input').fill('保存できる');
  await ui.locator('#note-form button[type="submit"]').click();
  const form = ui.locator('form.verdict');
  await form.getByLabel('NG', { exact: true }).check();
  await form.locator('[name="actual"]').fill('エラーが');
  // A step arrives and the list is drawn again.
  await site.fill('#q', 'x');
  await site.press('#q', 'Enter');
  await expect.poll(async () => (await panel.recording()).steps.map((s) => s.type)).toContain('key');
  await expect(ui.locator('form.verdict').getByLabel('NG', { exact: true })).toBeChecked();
  await expect(ui.locator('form.verdict [name="actual"]')).toHaveValue('エラーが');
  await expect(ui.locator('form.verdict [name="actual"]')).toBeFocused();
});
