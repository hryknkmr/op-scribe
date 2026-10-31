// tools/receiver.mjs as a process: bad payloads are refused before anything is written,
// and the server keeps running (#13).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../shared/sanitize.js');
const P = require('../shared/payload.js');

const dir = mkdtempSync(join(tmpdir(), 'opscribe-receiver-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, [new URL('../tools/receiver.mjs', import.meta.url).pathname],
  { cwd: dir, env: { ...process.env, PORT: String(port), OPSCRIBE_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill());

await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => { if (String(chunk).includes('receiver on')) resolve(); });
  server.on('exit', (code) => reject(new Error(`receiver exited ${code}`)));
});

const post = async (body, type = 'application/json') => {
  const res = await fetch(`http://127.0.0.1:${port}/recordings`, {
    method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

const good = () => P.buildPayload({
  id: 'rec-recv-1', startedAt: Date.UTC(2026, 9, 31), endedAt: null, startUrl: 'https://site-1.invalid/',
  aliases: {}, redactions: {}, webmcpTools: {},
  steps: [
    { type: 'navigate', t: 0, env: 'commercial', source: 'user', url: 'https://site-1.invalid/' },
    { type: 'input', t: 5, env: 'commercial', source: 'user', target: { role: 'textbox', name: '本文' },
      value: { treatment: 'length', field: 'text', kind: 'text', length: 3 } }
  ]
}, { generator: 'none', markdown: '' }, {});

test('payloads with a broken shape are refused with 422 and nothing is written', async () => {
  for (const body of [
    { schema: P.SCHEMA },
    { schema: P.SCHEMA, recording: null },
    { schema: P.SCHEMA, recording: { steps: 'x' }, reproduction: {} },
    null,
    [],
    '"just a string"'
  ]) {
    const res = await post(body);
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  assert.ok(!existsSync(join(dir, 'recordings')) || readdirSync(join(dir, 'recordings')).length === 0);
  assert.equal(server.exitCode, null, 'the receiver must still be running');
});

test('a commercial value that was kept is refused (row E2)', async () => {
  const payload = good();
  payload.recording.steps[1].value = S.typed.kept('text', 'raw');
  const res = await post(payload);
  assert.equal(res.status, 422);
  assert.ok(res.body.problems.some((p) => p.problem === 'commercial free text kept'));
});

test('a well-formed payload is stored, and the old checks still hold', async () => {
  assert.equal((await post(good())).status, 201);
  assert.deepEqual(readdirSync(join(dir, 'recordings')), ['rec-recv-1.json']);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('{}', 'text/plain')).status, 415);
  assert.equal(server.exitCode, null);
});
