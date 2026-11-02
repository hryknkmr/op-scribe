import { test, expect, callTool, toolsReady } from './fixtures.mjs';

const hostOf = (url) => new URL(url).host;

test('a site gets only its own steps, and is site-1 to itself whatever the recording numbers it (W8, #37)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await site.fill('#q', 'Aで入力');
  await site.click('#go');
  expect((await panel.addSite('http://b.test/')).ok).toBe(true);
  await site.goto('http://b.test/');
  await toolsReady(site);
  await site.fill('#q', 'Bで入力');
  await site.click('#go');

  // The click on B has reached the recording.
  await expect.poll(async () => (await panel.recording()).steps.at(-1)?.type).toBe('click');
  const rec = await panel.recording();
  const onB = rec.steps.filter((s) => s.site === rec.steps.at(-1).site);
  expect(hostOf(onB[0].site)).toBe('site-2.invalid');

  const status = await callTool(site, 'opscribe_recording_status');
  expect(status).toEqual({ ok: true, recording: true, site: 'http://site-1.invalid', stepsOnThisSite: onB.length });
  const repro = await callTool(site, 'opscribe_get_reproduction');
  expect(repro.ok).toBe(true);
  expect(repro.steps).toBe(onB.length);
  const text = repro.markdown + repro.gherkin;
  expect(text).toContain('site-1.invalid');
  expect(text).not.toContain('site-2.invalid');
  // Nothing of site A: neither what was typed there nor how many steps it has.
  expect(text).not.toContain('Aで入力');
  expect(JSON.stringify(repro)).not.toContain('a.test');
  expect(JSON.stringify(repro)).not.toContain('b.test');

  await site.goto('http://a.test/');
  await toolsReady(site);
  expect((await callTool(site, 'opscribe_recording_status')).site).toBe('http://site-1.invalid');
});

test('a page adds at most 100 expectations, and the person\'s steps stay (W7, #37)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await toolsReady(site);
  await site.fill('#q', '人の入力');
  await site.click('#go');
  const people = async () => (await panel.recording()).steps.filter((s) => s.source === 'user').length;
  // The input and the click have reached the recording.
  await expect.poll(people).toBe(2);
  const before = await people();

  // Every step that is not the person's counts toward a site's 100: the navigation at the start too.
  const replies = await site.evaluate(async () => {
    const tool = window.__e2eTools.get('opscribe_add_expectation');
    const out = [];
    for (let i = 0; i < 101; i += 1) out.push(await tool.execute({ text: `期待 ${i}` }));
    return out;
  });
  const refused = replies.findIndex((r) => !r.ok);
  expect(refused).toBeGreaterThan(90);
  expect(replies.slice(refused)).toEqual(replies.slice(refused).map(() => ({ ok: false, error: 'NOT_RECORDED' })));

  const rec = await panel.recording();
  expect(rec.steps.filter((s) => s.source !== 'user')).toHaveLength(100);
  expect(rec.steps.filter((s) => s.source === 'user')).toHaveLength(before);
  // The person is still recorded past the limit.
  await site.click('#go');
  await expect.poll(people).toBeGreaterThan(before);
});

test('a call to the page\'s own tool is recorded as the agent\'s, and its tools under the site\'s alias (W6, W7, #39)', async ({ context, panel }) => {
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await toolsReady(site);
  await site.evaluate(() => document.modelContext.registerTool({
    name: 'demo_search',
    description: 'Searches the demo site.',
    execute: ({ q }) => ({ hits: q ? 1 : 0 }),
  }));
  expect(await callTool(site, 'demo_search', { q: 'ねこ', mail: 'someone@example.com' })).toEqual({ hits: 1 });

  await expect.poll(async () => (await panel.recording()).steps.some((s) => s.type === 'tool')).toBe(true);
  const rec = await panel.recording();
  const call = rec.steps.find((s) => s.type === 'tool');
  expect(call.source).toBe('agent');
  // The address is redacted as one (W1), the search word kept as it is (W2).
  expect(call.args).toEqual({
    mail: { field: 'arg', kind: 'email', treatment: 'redacted' },
    q: { field: 'arg', text: ['ねこ'], treatment: 'kept' },
  });
  await expect.poll(async () => Object.values((await panel.recording()).webmcpTools).flat().map((runs) => runs.join('')))
    .toContain('demo_search');
  const sites = Object.keys((await panel.recording()).webmcpTools);
  expect(sites.map(hostOf)).toEqual(['site-1.invalid']);
});

for (const [name, script] of [
  ['focus(), a value, blur()', () => { const q = document.querySelector('#q'); q.focus(); q.value = 'ページ'; q.blur(); }],
  ['requestSubmit()', () => { document.getElementById('search').requestSubmit(); }],
  ['a button\'s click()', () => { document.querySelector('#go').click(); }],
]) {
  test(`a page's ${name} makes no step of the person's (W7, #37 R15)`, async ({ context, panel }) => {
    const site = await context.newPage();
    await site.goto('http://a.test/');
    await panel.start(site);
    await site.evaluate(script);
    // Long enough for a step the page caused to arrive.
    await site.waitForTimeout(1000);
    await panel.stop();
    expect((await panel.recording()).steps.filter((s) => s.source === 'user')).toEqual([]);
  });
}

test('known limit: a page\'s execCommand(\'insertText\') is recorded as the person\'s input (W7)', async ({ context, panel }) => {
  // Kept to watch the limit the owner accepted; when it is closed, this test is to say so.
  const site = await context.newPage();
  await site.goto('http://a.test/');
  await panel.start(site);
  await site.evaluate(() => { const q = document.querySelector('#q'); q.focus(); document.execCommand('insertText', false, 'ページ'); q.blur(); });
  await expect.poll(async () => (await panel.recording()).steps.map((s) => `${s.type}:${s.source}`)).toContain('input:user');
});
