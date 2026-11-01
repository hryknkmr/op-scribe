// The recorder observes a person's operation; it must never take control of it (#42).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content/recorder.js', import.meta.url), 'utf8');

/** The source text of each addEventListener(...) call, up to its closing parenthesis. */
function listenerCalls(text) {
  const calls = [];
  for (const m of text.matchAll(/addEventListener\(/g)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && --depth === 0) { calls.push(text.slice(m.index, i + 1)); break; }
    }
  }
  return calls;
}

test('every page event the recorder listens to is passive (#42)', () => {
  const calls = listenerCalls(source);
  assert.ok(calls.length > 0);
  for (const call of calls) {
    // The relay from the MAIN world is a message, not a person's operation, and cannot be cancelled.
    if (/^addEventListener\('message',/.test(call)) continue;
    assert.match(call, /\}, \{ capture: true, passive: true \}\)$/, call.split('\n')[0]);
  }
});

test('the recorder never cancels or stops the operation (#42)', () => {
  assert.doesNotMatch(source, /\.preventDefault\s*\(/);
  assert.doesNotMatch(source, /\.stop(?:Immediate)?Propagation\s*\(/);
});
