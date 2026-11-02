// The recorder observes a person's operation; it must never take control of it (#42).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content/recorder.js', import.meta.url), 'utf8');

// Whether each listener is passive is checked by its options in tests/recorder.test.mjs.

test('the recorder never cancels or stops the operation (#42)', () => {
  assert.doesNotMatch(source, /\.preventDefault\s*\(/);
  assert.doesNotMatch(source, /\.stop(?:Immediate)?Propagation\s*\(/);
});
