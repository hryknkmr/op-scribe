// The check on what the on-device model writes (sidepanel/ai.js, AGENTS.md: AI output is used only if it passes validate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../sidepanel/ai.js';

const input = '開始ページ: https://site-1.invalid/\n操作ログ:\n1. 「メール」入力欄に ‹メールアドレス› を入力する';
const noFindings = () => [];

test('the model may keep the masked parts it was given', () => {
  const output = { title: '手順', steps: [{ action: '「メール」入力欄に ‹メールアドレス› を入力する' }] };
  assert.deepEqual(validate(output, input, noFindings), []);
});

test('a [[…]] the model wrote is refused: the input never holds one (#28; review of #34 R3)', () => {
  for (const mark of ['[[email]]', '[[secret]]', '[[url:mailto]]', '[[text:12]]']) {
    const output = { title: '手順', steps: [{ action: `「メール」入力欄に ${mark} を入力する` }] };
    assert.ok(validate(output, input, noFindings).some((p) => p.includes('[[…]]')), mark);
  }
});

test('the model may merge what it was given, never add one more of it (review of #34)', () => {
  const twice = { title: '手順', steps: [{ action: '「メール」入力欄に ‹メールアドレス› を入力する' }, { action: '‹メールアドレス› を確かめる' }] };
  assert.ok(validate(twice, input, noFindings).some((p) => p.includes('‹メールアドレス›')));
  const url = { title: '手順', steps: [{ action: 'https://site-1.invalid/ を開く' }, { action: 'https://site-1.invalid/ を開く' }] };
  assert.ok(validate(url, input, noFindings).some((p) => p.includes('URL')));
});

test('a real host at the end of one precondition is found, whatever follows it (review of #34 R4)', async () => {
  const S = (await import('node:module')).createRequire(import.meta.url)('../shared/sanitize.js');
  const output = { title: '手順', steps: [{ action: '「メール」入力欄に ‹メールアドレス› を入力する' }], preconditions: ['intranet.corp.invalid', 'x'] };
  assert.ok(validate(output, input, (o) => S.finalScan(o, { hosts: ['intranet.corp.invalid'] })).length);
});
