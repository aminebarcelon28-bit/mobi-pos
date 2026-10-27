import { defineConfig } from '@playwright/test';

const CDP_PORT = process.env.CDP_PORT ?? '9223';

export default defineConfig({
  testDir: '.',
  testMatch: ['**/refund-audit/**/*.spec.mjs'],
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'refund-audit/results/playwright-report.json' }]],
  use: {
    baseURL: `http://localhost:${CDP_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--disable-print-preview'] },
  },
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // CDP connection is handled per-test via connectOverCDP in the test setup
  // rather than launching a browser, since we connect to the running Tauri WebView2.
});