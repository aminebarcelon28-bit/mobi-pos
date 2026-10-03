import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:1420';

export default defineConfig({
  // Two suites live side by side: `e2e/` drives the full licensed app shell,
  // `tests/` mounts the SAV/inspector modals in isolation via the UI harness
  // (the app shell is behind a fail-closed license gate, so the modals are
  // unreachable in CI without weakening licensing). This Playwright version
  // requires a string testDir, so the two roots are selected by testMatch.
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'tests/**/*.spec.ts'],
  testIgnore: [
    'node_modules/**',
    'src-tauri/**',
    'test-results/**',
    // Scratch git-worktrees (untracked agent sandboxes) must never join the
    // suite: their stale spec duplicates break module resolution and
    // double-run every licensed flow.
    '.kilo/**',
  ],
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/playwright-report.json' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    // The app's receipt auto-print calls window.print — stub it so headless
    // runs never block on a (non-existent) print dialog.
    launchOptions: { args: ['--disable-print-preview'] },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Repo-pinned local build (1228) — override with
          // E2E_CHROME_PATH if a Playwright-matched build is installed.
          executablePath:
            process.env.E2E_CHROME_PATH ??
            'C:\\Users\\Click\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe',
          args: ['--disable-print-preview'],
        },
      },
    },
    {
      // WebKit is the only engine that implements the iOS focus-zoom rule
      // (viewport scales in when a focused control computes < 16px), so the
      // mobile input-floor assertions are meaningless anywhere else. Scoped
      // to the harness spec so the licensed e2e/ suite is not duplicated here.
      name: 'webkit-mobile',
      testMatch: /sav-inspector-ui\.spec\.ts/,
      use: { ...devices['iPhone 15'] },
    },
  ],
  timeout: 120_000,
  expect: { timeout: 20_000 },
});
