#!/usr/bin/env node
/**
 * Minimal local endpoint for trying out "send" without any external service.
 *
 *   pnpm receiver                      # http://localhost:8787/recordings
 *   OPSCRIBE_TOKEN=xyz pnpm receiver   # also require "Authorization: Bearer xyz"
 *
 * Binds to 127.0.0.1 only. Runs the same final scan as the extension and
 * rejects (422) anything that still looks personal, so a filter regression is
 * caught on both sides. Accepted payloads go to ./recordings/ (gitignored).
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { finalScan } = require('../shared/sanitize.js');

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.OPSCRIBE_TOKEN || '';
const OUT_DIR = join(process.cwd(), 'recordings');
const MAX_BYTES = 1024 * 1024;
// Hosts a payload may name as they are (comma separated); any other host must be an alias (site-N.invalid).
const PROFILES = new Set(['commercial', 'standard']);

/** What is wrong with a v2 payload's shape and its privacy summary, or '' (docs/FORMAT.md, docs/adr/0001). */
function structureProblem(payload) {
  if (payload?.schema !== 'op-scribe.recording/v2') return 'unknown schema';
  const recording = payload.recording;
  const privacy = recording?.privacy;
  if (privacy?.policy !== 'tiered-commercial/v1') return 'unknown privacy policy';
  if (!Array.isArray(recording.steps)) return 'steps missing';
  if (!payload.reproduction || typeof payload.reproduction !== 'object') return 'reproduction missing';
  if (recording.steps.some((step) => !PROFILES.has(step?.privacy?.profile))) return 'step without a privacy profile';
  const commercial = recording.steps.filter((step) => step.privacy.profile === 'commercial').length;
  const standard = recording.steps.length - commercial;
  const coverage = !commercial ? 'standard-only' : !standard ? 'commercial-only' : 'mixed';
  if (privacy.commercialSteps !== commercial || privacy.standardSteps !== standard || privacy.coverage !== coverage) {
    return 'privacy summary does not match the steps';
  }
  return '';
}

const HOST_ALLOWLIST = (process.env.OPSCRIBE_HOST_ALLOWLIST || '').split(',').map((h) => h.trim()).filter(Boolean);

const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
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
  const invalid = structureProblem(payload);
  if (invalid) return reply(res, 422, { error: invalid });

  const findings = finalScan(payload, { hostAllowlist: HOST_ALLOWLIST });
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
});
