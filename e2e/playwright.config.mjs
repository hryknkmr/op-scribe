import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.mjs$/,
  // One browser at a time: each test starts its own Chromium with the extension.
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  outputDir: '../test-results',
});
