import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.mjs';

// The lowest Chrome the extension says it runs on is the Chromium these tests run on (Playwright's own).
// A Playwright bump that brings a newer Chromium fails here until manifest.json and README are raised too,
// so no Chrome the tests never ran on stays in the supported range.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('minimum_chrome_version and README name the Chromium major the E2E tests run on', async ({ context }) => {
  const page = await context.newPage();
  const ua = await page.evaluate(() => navigator.userAgent);
  const major = ua.match(/Chrome\/(\d+)\./)?.[1];
  expect(major, ua).toBeTruthy();

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  expect(manifest.minimum_chrome_version).toBe(major);

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  expect(readme).toContain(`| Chrome ${major} 以降 | 必須 |`);
});
