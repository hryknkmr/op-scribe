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
    assert.ok(validate(output, input, noFindings).some((p) => p.includes(mark)), mark);
  }
});
