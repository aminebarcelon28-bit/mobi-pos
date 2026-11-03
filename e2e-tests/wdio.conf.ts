/**
 * WebdriverIO config for the POS_EDGE_CASE_ENCYCLOPEDIA harness (self-contained
 * under `e2e-tests/`). Drives the REAL MobiPOS Tauri app through an EXTERNAL
 * `tauri-driver` (+ msedgedriver on Windows), with everything sandboxed:
 *
 *  - APPDATA / LOCALAPPDATA / USERPROFILE point into a tmp sandbox, so the
 *    app opens `{sandbox}/appdata/com.mobi.pos.e2e/mobi_pos.db` — never the
 *    real till's data dir. The e2e-flavor identifier (`com.mobi.pos.e2e`)
 *    is a second isolation layer (src-tauri/tauri.e2e.conf.json).
 *  - The binary is the freshly built e2e flavor at `target-e2e/debug/`.
 *
 * Clean room: `POS_E2E_WIPE=1 npx wdio run e2e-tests/wdio.conf.ts` wipes the
 * sandbox before the run (app must be stopped; the config enforces that).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
// Shared, unit-tested sandbox rule (plain .mjs: the skill is dependency-free).
// @ts-ignore - the skill ships no type declarations on purpose
import { e2eDataDirProblem } from '../.opencode/skills/e2e-testing/scripts/_lib.mjs';
import type { Options } from '@wdio/types';

// Capture the REAL home BEFORE sandbox overrides (tauri-driver lives there).
const REAL_HOME = process.env.USERPROFILE || os.homedir();

// ── Sandbox env — applied at import time in EVERY process (launcher + worker),
// before tauri-driver/msedgedriver/the app can be spawned.
const ROOT = (() => {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'src-tauri', 'tauri.conf.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('[e2e-tests] repo root not found above cwd');
})();

const E2E_IDENTIFIER = 'com.mobi.pos.e2e';
const SANDBOX =
  process.env.POS_WDIO_SANDBOX?.trim() ||
  path.join(process.env.TEMP || os.tmpdir(), 'opencode', 'pos-wdio-sandbox');
if (!SANDBOX) throw new Error('[e2e-tests] cannot resolve sandbox dir');
process.env.POS_WDIO_SANDBOX = SANDBOX;

const SANDBOX_APPDATA = path.join(SANDBOX, 'home', 'AppData', 'Roaming');
const SANDBOX_LOCALAPPDATA = path.join(SANDBOX, 'home', 'AppData', 'Local');
const SANDBOX_HOME = path.join(SANDBOX, 'home');

// Validate BEFORE creating anything: a bad POS_WDIO_SANDBOX must stop the run
// without leaving directories behind (and an import-time throw is not swallowed
// by @wdio/cli, unlike one from onPrepare).
for (const dir of [
  path.join(SANDBOX_APPDATA, E2E_IDENTIFIER),
  path.join(SANDBOX_LOCALAPPDATA, E2E_IDENTIFIER),
]) {
  assertE2eDataDir(dir);
}

fs.mkdirSync(SANDBOX_APPDATA, { recursive: true });
fs.mkdirSync(SANDBOX_LOCALAPPDATA, { recursive: true });
fs.mkdirSync(SANDBOX_HOME, { recursive: true });

process.env.APPDATA = SANDBOX_APPDATA;
process.env.LOCALAPPDATA = SANDBOX_LOCALAPPDATA;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.XDG_DATA_HOME = path.join(SANDBOX, 'data');
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, 'config');
if (!process.env.HOME) process.env.HOME = SANDBOX_HOME;

// The app resolves its data dir through the Windows known-folder API, which
// EXPANDS `%USERPROFILE%` from the environment — so USERPROFILE is the
// redirect that actually sandboxes the DB (verified empirically):
//   DB      : {sandbox}/home/AppData/Roaming/com.mobi.pos.e2e/mobi_pos.db
//   WebView : {sandbox}/home/AppData/Local/com.mobi.pos.e2e/EBWebView
export const DB_PATH = path.join(SANDBOX_APPDATA, E2E_IDENTIFIER, 'mobi_pos.db');
export const WEBVIEW_DIR = path.join(SANDBOX_LOCALAPPDATA, E2E_IDENTIFIER);
export const SANDBOX_DIR = SANDBOX;

/** Refuse to delete anything that is not exactly
 * `<sandbox>/home/AppData/{Roaming|Local}/com.mobi.pos.e2e`.
 * The rule itself lives in the skill (`_lib.mjs e2eDataDirProblem`) and is
 * unit-tested there (8/8 guard cases); this config does not re-implement it. */
function assertE2eDataDir(dir: string): void {
  const problem = e2eDataDirProblem(dir, SANDBOX);
  if (problem) {
    throw new Error(`[e2e-tests] refusing to use ${path.resolve(dir)}: ${problem}`);
  }
}

// ── Binary (e2e flavor, fail closed).
const BIN_NAME = process.platform === 'win32' ? 'mobi-pos.exe' : 'mobi-pos';
const BIN_PATH = process.env.WDIO_E2E_BINARY?.trim()
  ? path.resolve(ROOT, process.env.WDIO_E2E_BINARY.trim())
  : path.join(ROOT, 'target-e2e', 'debug', BIN_NAME);
if (!fs.existsSync(BIN_PATH)) {
  throw new Error(
    `[e2e-tests] e2e binary not found: ${BIN_PATH}\n` +
      'Build it first: `npm run build:e2e` (from the repo root).',
  );
}

// ── Provenance, at IMPORT TIME on purpose.
// @wdio/cli's `runLauncherHook` logs and swallows ordinary errors thrown from
// `onPrepare`, and `SevereServiceError` is not recognised across the
// transpiled-config boundary (verified 2026-10-27: the hook threw, the suite
// ran anyway). A throw while the config module loads cannot be swallowed, so
// the check lives here. `--provenance` keeps it to the binary only — the
// driver/orphan checks would misfire inside a worker, where tauri-driver is
// already running and USERPROFILE points into the sandbox.
// ── One-time checks run in the LAUNCHER only.
// wdio forks a fresh worker process per spec and each one re-imports this
// config (measured 2026-10-27: 3 specs -> 4 imports). Running the 41 MB binary
// hash + git diff in every worker costs seconds and, worse, the orphan check
// can fire on a sibling worker's app that has not been torn down yet — a new
// flake. The marker is set by the launcher and inherited by every worker, so
// these run exactly once per run; the cheap sandbox validation above still
// runs everywhere (a worker must never get an unvalidated sandbox).
const IS_LAUNCHER = !process.env.POS_WDIO_LAUNCHER_PID;
if (IS_LAUNCHER) process.env.POS_WDIO_LAUNCHER_PID = String(process.pid);

const PREFLIGHT = path.join(ROOT, '.opencode', 'skills', 'e2e-testing', 'scripts', 'preflight.mjs');
if (!fs.existsSync(PREFLIGHT)) {
  throw new Error(
    `[e2e-tests] provenance check missing: ${PREFLIGHT} — the e2e-testing skill is mandatory`,
  );
}
if (IS_LAUNCHER) {
  const verdict = spawnSync(process.execPath, [PREFLIGHT, '--provenance', '--quiet'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (verdict.status !== 0) {
    throw new Error(
      '[e2e-tests] preflight refused this binary (see the blockers above) — ' +
        'fix them or run `npm run build:e2e`; a green run on an uncertified binary is a lie',
    );
  }

  // Orphans, same reason: an `onPrepare` throw is swallowed, so a running app
  // would not stop the run — the wipe would half-fail and the session would
  // attach to the wrong process.
  if (isProcRunning('mobi-pos.exe')) {
    throw new Error(
      '[e2e-tests] mobi-pos.exe is already running — refusing to start over it. ' +
        'Run `npm run e2e:clean` if it is an orphan.',
    );
  }
}

const TAURI_DRIVER_PATH =
  process.env.WDIO_TAURI_DRIVER?.trim() ||
  path.join(REAL_HOME, '.cargo', 'bin', process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver');
// No hardcoded per-user fallback: WDIO_TAURI_DRIVER wins, then ~/.cargo/bin,
// then a bare `tauri-driver` on PATH (the service surfaces its own not-found
// error, which is actionable).
const DRIVER_PATH_FINAL = fs.existsSync(TAURI_DRIVER_PATH) ? TAURI_DRIVER_PATH : 'tauri-driver';

function isProcRunning(image: string): boolean {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return out.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

function killDrivers(): void {
  try {
    execSync('taskkill /F /IM msedgedriver.exe /IM tauri-driver.exe', { stdio: 'ignore' });
  } catch {
    /* already dead — the common case */
  }
}

function stopAppGracefully(): void {
  if (!isProcRunning('mobi-pos.exe')) return;
  try {
    execSync('taskkill /IM mobi-pos.exe', { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && isProcRunning('mobi-pos.exe')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (isProcRunning('mobi-pos.exe')) {
    console.log('[e2e-tests] graceful close timed out — force-killing');
    try {
      execSync('taskkill /F /IM mobi-pos.exe', { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
}

const LOG_DIR = path.join(ROOT, 'e2e-tests', 'test-logs');

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./specs/**/*.e2e.ts'],
  maxInstances: 1,
  maxInstancesPerCapability: 1,

  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: BIN_PATH,
      },
    },
  ],

  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: BIN_PATH,
        driverProvider: 'external',
        // Two-instance harness: each app process needs its own tauri-driver
        // port, otherwise the second run collides with the first on 4444.
        ...(Number(process.env.POS_TAURI_DRIVER_PORT) > 0
          ? { tauriDriverPort: Number(process.env.POS_TAURI_DRIVER_PORT) }
          : {}),
        tauriDriverPath: DRIVER_PATH_FINAL,
        autoInstallTauriDriver: false,
        // msedgedriver is not pre-installed on this machine; the service
        // downloads the build matching the local WebView2 runtime.
        autoDownloadEdgeDriver: true,
        captureBackendLogs: true,
        backendLogLevel: 'info',
        captureFrontendLogs: true,
        frontendLogLevel: 'info',
        // WebView2 cold start on first launch can exceed 60 s (observed),
        // making the first /session POST fail with DevToolsActivePort and
        // eat a full retry — give the app room to come up.
        commandTimeout: 120000,
        startTimeout: 180000,
        statusPollTimeout: 15000,
        logLevel: 'info',
      },
    ],
  ],

  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    // Scale specs may spend >5 min in a single synchronous seed / recompute.
    // Default stays at the historical 5 min; opt in per run.
    timeout: Number(process.env.WDIO_MOCHA_TIMEOUT ?? 300000),
    retries: 0,
  },

  logLevel: process.env.WDIO_LOG_LEVEL ?? 'info',
  bail: 0,
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 2,
  outputDir: LOG_DIR,

  onPrepare: () => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    console.log(`[e2e-tests] binary : ${BIN_PATH}`);
    console.log(`[e2e-tests] sandbox: ${SANDBOX}`);
    console.log(`[e2e-tests] db     : ${DB_PATH}`);
    // Orphans are refused at import time (an onPrepare throw is swallowed by
    // @wdio/cli, so it would not stop the run).
    if (process.env.POS_E2E_WIPE === '1') {
      for (const dir of [path.join(SANDBOX_APPDATA, E2E_IDENTIFIER), WEBVIEW_DIR]) {
        assertE2eDataDir(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[e2e-tests] wiped ${dir}`);
      }
    }
    // Provenance already ran at import time (top of this file) — it cannot be
    // swallowed there. This hook only wipes and records the run.
    fs.writeFileSync(
      path.join(LOG_DIR, 'manifest.json'),
      JSON.stringify(
        {
          gitSha: execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
          binary: BIN_PATH,
          sandbox: SANDBOX,
          dbPath: DB_PATH,
          node: process.version,
        },
        null,
        2,
      ),
    );
  },

  onComplete: () => {
    stopAppGracefully();
    killDrivers();
  },

  before: async () => {
    const handles = await browser.getWindowHandles();
    if (handles.length > 0) {
      await browser.switchToWindow(handles[0]);
    }
    // esbuild keepNames emits `__name(...)` calls into serialized execute
    // callbacks — define it page-side before any spec runs (raw string: a
    // compiled callback would itself reference `__name`). Re-installed after
    // every refresh by pos.ts installPageShims/clearWebMirrors.
    await browser
      .execute(
        'window.__name = window.__name || function (target, value) {' +
          ' try { Object.defineProperty(target, "name", { value: value, configurable: true }); }' +
          ' catch (_e) { /* non-configurable */ }' +
          ' return target; };',
      )
      .catch(() => {
        /* best effort — specs re-install after refresh anyway */
      });
  },

  /**
   * Append one NDJSON line per finished test — the raw fuel for
   * `tools/coverage.mjs`. (Custom reporter classes need an `emit` method in
   * WDIO 9; a config hook is simpler and cannot break the run.)
   */
  afterTest: async function (
    test: { fullTitle?: string; title?: string; file?: string },
    _context: unknown,
    result: { error?: Error; duration?: number; passed?: boolean; retries?: number },
  ) {
    try {
      // A skipped test (`this.skip()`) reaches afterTest with passed=false and
      // no error object; recording that as "fail" would count a permitted
      // skip as a vulnerability in the coverage dashboard.
      const state = result.passed ? 'pass' : result.error ? 'fail' : 'skip';
      const rec = {
        ts: new Date().toISOString(),
        kind: state,
        file: test?.file ?? null,
        fullTitle: test?.fullTitle ?? test?.title ?? '',
        state,
        durationMs: typeof result.duration === 'number' ? result.duration : null,
        error: result.error ? [String(result.error.message ?? result.error)] : null,
        retries: result.retries ?? 0,
      };
      fs.mkdirSync(path.join(ROOT, 'e2e-tests', 'results'), { recursive: true });
      fs.appendFileSync(
        path.join(ROOT, 'e2e-tests', 'results', 'events.ndjson'),
        JSON.stringify(rec) + '\n',
      );
    } catch {
      /* reporting must never fail a test */
    }
  },
};
