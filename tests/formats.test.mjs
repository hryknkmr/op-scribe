// The exit for the readers' formats (ADR 0005): a checked payload, then each whole text scanned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../shared/payload.js');
const F = require('../shared/formats.js');

const T0 = Date.UTC(2026, 10, 3, 1, 0, 0);
const URL_A = 'https://site-1.invalid/a';
const steps = [
  { type: 'navigate', t: 0, env: 'standard', source: 'unknown', url: [URL_A] },
  { type: 'click', t: 10, env: 'standard', source: 'user', url: [URL_A], target: { role: 'button', name: ['保存'] } },
  { type: 'note', t: 20, env: 'standard', source: 'user', note: ['保存できる'], ref: 'E-aaaaaa', verdict: 'ng', actual: ['Acme のエラーが出る'] },
  { type: 'note', t: 30, env: 'standard', source: 'user', note: ['一覧に戻る'], ref: 'E-bbbbbb', verdict: 'ng', actual: ['戻らない'] }
];
const payload = (extra = {}) => P.buildPayload({ id: 'rec-fmt-2', startedAt: T0, endedAt: T0 + 60000, aliases: {}, redactions: {}, webmcpTools: {}, steps, ...extra },
  { generator: 'none', markdown: '' }, {});

test('the formats come only from a payload that passes the check (ADR 0005, E1)', () => {
  const bad = payload();
  bad.recording.steps[2].verdict = 'maybe';
  const made = F.checkedFormats(bad, { keywords: [], hosts: [] });
  assert.ok(made.problems?.length);
  assert.equal(made.tickets, undefined);
  assert.equal(made.session, undefined);
});

test('each text is scanned whole: one with a keyword or a real host comes back as findings only (ADR 0005, E6, K2, K5)', () => {
  const clean = F.checkedFormats(payload(), { keywords: [], hosts: [] });
  assert.deepEqual(clean.tickets.map((t) => [t.ref, Boolean(t.text), t.findings.length]), [['E-aaaaaa', true, 0], ['E-bbbbbb', true, 0]]);
  assert.ok(clean.session.text.startsWith('# 実施記録'));
  // Registered after the recording: the ticket that holds it and the session record stop; the other ticket goes.
  const word = F.checkedFormats(payload(), { keywords: ['Acme'], hosts: [] });
  assert.equal(word.tickets[0].text, null);
  assert.ok(word.tickets[0].findings.length);
  assert.ok(word.tickets[1].text);
  assert.equal(word.session.text, null);
  // A real host behind an alias, written by the tester.
  const host = F.checkedFormats(payload({ notTested: ['intranet.corp.invalid は未確認'] }), { keywords: [], hosts: ['intranet.corp.invalid'] });
  assert.equal(host.session.text, null);
  assert.ok(host.session.findings.length);
});

test('no session record while the recording has not ended (ADR 0005)', () => {
  assert.equal(F.checkedFormats(payload({ endedAt: null }), { keywords: [], hosts: [] }).session, null);
});
