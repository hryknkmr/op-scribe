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
const { finalScan, hostAllowed, isPlaceholder, REDACTION_KINDS } = require('../shared/sanitize.js');
const { STEP_FIELDS, TARGET_FIELDS } = require('../shared/describe.js');

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
  // The shape first, so nothing below runs on a missing or malformed part.
  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!Array.isArray(recording.steps) || !recording.steps.every(isObject)) return 'steps missing or malformed';
  if (!isObject(payload.reproduction)) return 'reproduction missing';
  if (recording.environment !== undefined && !isObject(recording.environment)) return 'environment malformed';
  if (recording.steps.some((step) => (step.target !== undefined && !isObject(step.target)) || !isObject(step.privacy))) {
    return 'step target or privacy malformed';
  }
  // Only the fields buildPayload writes: anything else (a host table, a tab id) is not accepted.
  const extra = (object, allowed) => Object.keys(object || {}).find((key) => !allowed.includes(key));
  const unknown = extra(payload, ['schema', 'recording', 'reproduction', 'sentAt'])
    || extra(recording, ['id', 'startedAt', 'endedAt', 'startUrl', 'privacy', 'environment', 'steps', 'webmcpTools'])
    || extra(privacy, ['policy', 'coverage', 'commercialSteps', 'standardSteps', 'hostsAliased', 'redactions']);
  if (unknown) return `unknown field: ${unknown}`;
  // And below them, every level buildPayload writes (docs/FORMAT.md).
  const deeper = extra(recording.environment, ['browser', 'platform', 'language'])
    || extra(payload.reproduction, ['generator', 'markdown', 'gherkin', 'summary'])
    || (Array.isArray(recording.steps) && recording.steps.map((step) => extra(step, ['n', ...STEP_FIELDS, 'privacy', 'target'])
      || extra(step?.target, TARGET_FIELDS) || extra(step?.privacy, ['profile'])).find(Boolean))
    || (recording.webmcpTools !== undefined && !Array.isArray(recording.webmcpTools) && 'webmcpTools')
    || (Array.isArray(recording.webmcpTools) && recording.webmcpTools.map((entry) => extra(entry, ['site', 'tools'])
      || (typeof entry?.site !== 'string' || !Array.isArray(entry.tools) || entry.tools.some((t) => typeof t !== 'string') ? 'webmcpTools[]' : '')).find(Boolean));
  if (deeper) return `unknown field: ${deeper}`;
  // And of the types buildPayload writes: text where text is written, so nothing hides in an array or an object.
  const TEXT_FIELDS = ['type', 'url', 'value', 'valueClass', 'key', 'tool', 'note', 'source'];
  const badType = recording.steps.find((step) => TEXT_FIELDS.some((field) => step[field] !== undefined && typeof step[field] !== 'string')
    || (step.target && Object.values(step.target).some((v) => typeof v !== 'string'))
    || (step.args !== undefined && (typeof step.args !== 'object' || step.args === null)));
  if (badType) return 'a step field of the wrong type';
  // Numbers and flags where buildPayload writes them, and redaction counts only of the filter's kinds.
  const count = (n) => Number.isInteger(n) && n >= 0 && n < 1e6;
  if (recording.steps.some((step) => !count(step.n) || !count(step.t)
      || (step.checked !== undefined && typeof step.checked !== 'boolean') || (step.ok !== undefined && typeof step.ok !== 'boolean'))) {
    return 'a step number or flag of the wrong type';
  }
  if (!count(privacy.hostsAliased) || typeof privacy.redactions !== 'object' || privacy.redactions === null
      || Object.entries(privacy.redactions).some(([k, n]) => !REDACTION_KINDS.has(k) || !count(n))) return 'privacy counts malformed';
  // Every URL field holds an http(s) URL on an allowed host or an alias (site-N.invalid), or a placeholder; a bare host
  // name or another scheme is not accepted. A site is an origin.
  const urlProblem = (value, originOnly = false) => {
    if (value === undefined || value === null || isPlaceholder(value)) return false;
    let url;
    try { url = new URL(value); } catch { return true; }
    if (!['http:', 'https:'].includes(url.protocol)) return true;
    if (originOnly && value !== url.origin) return true;
    return !hostAllowed(url.hostname, HOST_ALLOWLIST) && !/^site-\d+\.invalid$/.test(url.hostname);
  };
  if (urlProblem(recording.startUrl) || recording.steps.some((step) => urlProblem(step.url) || urlProblem(step.target?.href))
      || (recording.webmcpTools || []).some((entry) => urlProblem(entry.site, true))) return 'a URL field not on an allowed or aliased host';
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

async function handle(req, res) {
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
}

createServer((req, res) => {
  // Whatever goes wrong with one request is that request's error, never the server's end.
  handle(req, res).catch((error) => {
    console.warn('request failed', error);
    if (!res.headersSent) reply(res, 400, { error: 'bad request' });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`op-scribe receiver on http://localhost:${PORT}/recordings${TOKEN ? ' (token required)' : ''}`);
});
