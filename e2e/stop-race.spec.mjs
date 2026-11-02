// #9: the operation right before STOP is kept, even a value still being typed.
import { test, expect } from './fixtures.mjs';

const ROUNDS = 5;

for (const [name, act, expected] of [
  ['click, then stop at once', async (site) => { await site.click('#go'); }, { type: 'click' }],
  ['type and leave the field, then stop at once', async (site) => { await site.fill('#q', 'ねこ'); await site.locator('#q').blur(); }, { type: 'input', text: 'ねこ' }],
  ['type and stay in the field, then stop', async (site) => { await site.fill('#q', 'いぬ'); }, { type: 'input', text: 'いぬ' }],
  ['type, then focus moves to the panel, then stop', async (site, panel) => { await site.fill('#q', 'とり'); await panel.page.bringToFront(); }, { type: 'input', text: 'とり' }],
]) {
  test(`#9: ${name}`, async ({ context, panel }) => {
    const site = await context.newPage();
    for (let i = 0; i < ROUNDS; i += 1) {
      await site.goto('http://a.test/');
      await panel.start(site);
      await act(site, panel);
      await panel.stop();
      const steps = (await panel.recording()).steps.filter((s) => s.type === expected.type);
      // Once: the value committed at stop is not recorded again by the blur that follows.
      expect(steps, `round ${i + 1}`).toHaveLength(1);
      if (expected.text) expect(steps[0].value).toEqual({ field: 'text', text: [expected.text], treatment: 'kept' });
    }
  });
}

test('#9: a value the page set, not typed, is not committed at stop', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await site.focus('#q');
  await site.evaluate(() => { document.querySelector('#q').value = 'うそ'; });
  await panel.stop();
  expect((await panel.recording()).steps.filter((s) => s.type === 'input')).toEqual([]);
});
