#!/usr/bin/env node
/**
 * Minimal local endpoint for trying out "send" without any external service.
 *
 *   pnpm receiver                      # http://localhost:8787/recordings
 *   OPSCRIBE_TOKEN=xyz pnpm receiver   # also require "Authorization: Bearer xyz"
 *   OPSCRIBE_KEYWORDS_FILE=words.txt pnpm receiver
 *                                      # also refuse the words and real host names listed
 *                                      # (one per line, # for comments; keep the file local)
 *
 * The extension never sends its keyword list or the real hosts it aliased, so
 * the receiver can only look for them when its operator lists them (ADR 0003, E6).
 *
 * Binds to 127.0.0.1 only, and answers only a Host of localhost, 127.0.0.1 or [::1]: a page
 * whose own name a DNS rebinding points here gets nothing. Runs the same two checks as the extension's exits:
 * the structural check against the one payload definition (shared/payload.js:
 * unknown fields, types, treatments, Gherkin rebuilt from the steps) and the
 * best-effort pattern scan. Anything that fails either is rejected (422), so a
 * filter regression is caught on both sides. Accepted payloads go to
 * ./recordings/ (gitignored).
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { finalScan } = require('../shared/sanitize.js');
const { SCHEMAS, checkPayload } = require('../shared/payload.js');

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.OPSCRIBE_TOKEN || '';
const OUT_DIR = join(process.cwd(), 'recordings');
// Derived from the per-field limits: any payload the extension can build fits (shared/limits.js).
const { TOTALS } = require('../shared/limits.js');
const MAX_BYTES = TOTALS.payloadBytes;
const KEYWORDS_FILE = process.env.OPSCRIBE_KEYWORDS_FILE || '';
const KEYWORDS = KEYWORDS_FILE
  ? readFileSync(KEYWORDS_FILE, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  : [];

// The names the extension may send to over http (sidepanel.js endpointPattern), with any port.
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (!LOCAL_HOST.test(req.headers.host || '')) return reply(res, 403, { error: 'local host names only' });
  if (req.method !== 'POST' || req.url !== '/recordings') return reply(res, 404, { error: 'POST /recordings only' });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return reply(res, 401, { error: 'unauthorized' });
  if (!String(req.headers['content-type']).startsWith('application/json')) return reply(res, 415, { error: 'json only' });

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) return reply(res, 413, { error: 'too large' });
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return reply(res, 400, { error: 'invalid json' });
  }
  // v3, v4 (ADR 0005) and v5 (#40): checkPayload checks each against its own version's shape.
  if (!SCHEMAS.includes(payload?.schema)) return reply(res, 422, { error: 'unknown schema' });

  let problems;
  try {
    problems = checkPayload(payload);
  } catch (error) {
    // Whatever the payload does to the check, it is refused, and the receiver keeps running (#13).
    problems = [{ path: '(root)', problem: `check failed: ${error.name}` }];
  }
  if (problems.length) {
    console.warn('rejected: unexpected shape', problems);
    return reply(res, 422, { error: 'unexpected shape', problems });
  }
  // The list holds keywords and real host names alike; hosts are matched at any length (row K5).
  const findings = finalScan(payload, { keywords: KEYWORDS, hosts: KEYWORDS });
  if (findings.length) {
    console.warn('rejected: still contains', findings);
    return reply(res, 422, { error: 'unmasked values', findings });
  }

  const id = String(payload.recording?.id || 'unknown').replace(/[^\w-]/g, '_');
  await mkdir(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${id}.json`);
  await writeFile(file, JSON.stringify(payload, null, 2));
  console.log(`accepted ${id}: ${payload.recording.steps.length} steps, generator=${payload.reproduction.generator} -> ${file}`);
  return reply(res, 201, { ok: true, id });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`op-scribe receiver on http://localhost:${PORT}/recordings${TOKEN ? ' (token required)' : ''}`);
  if (!KEYWORDS.length) {
    console.warn('keywords: none. Set OPSCRIBE_KEYWORDS_FILE to also refuse your keywords and real host names.');
  }
});
