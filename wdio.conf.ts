import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import type { Options } from '@wdio/types';

/**
 * WebdriverIO + @wdio/tauri-service configuration for the MobiPOS Tauri v2 app.
 *
 * Binary resolution
 * -----------------
 *   WDIO_E2E_BINARY=<path>        explicit override (absolute, or relative to cwd)
 *   WDIO_E2E_PROFILE=release|debug  which e2e flavor profile to prefer (default: debug)
 *
 * Driver provider
 * ---------------
 *   The embedded WebDriver server (`tauri-plugin-wdio-webdriver`) is registered
 *   only under `--features e2e` (src-tauri/src/lib.rs), so it exists in e2e
 *   builds but NOT in standard builds. `tauri build` (even --debug) serves
 *   the BUNDLED frontend (devUrl is only for `tauri dev`), so the e2e page
 *   is whatever `scripts/build-e2e.mjs` bundled — with VITE_E2E=1 seams.
 *   The vite dev server on :1420 is NOT used by e2e runs (proven Gate 4:
 *   page lacks DEV-only globals; keep it running only for development).
 *
 *   Therefore the default pairing is:
 *     release -> external (tauri-driver + msedgedriver on Windows)
 *     debug   -> embedded (requires a `vite` dev server on :1420)
 *
 *   WDIO_E2E_DRIVER=embedded|external overrides the derived default.
 *
 * Isolation (Phase 1: isolated `.e2e` container)
 * ----------------------------------------------
 *   The e2e flavor carries identifier `com.mobi.pos.e2e`
 *   (src-tauri/tauri.e2e.conf.json), so it opens its OWN data dir and NEVER
 *   the real till's. There is no live snapshot/restore: production data is
 *   never opened, and the `.e2e` container is reset via `e2e_reset_and_seed`.
 */

const ROOT = process.cwd();
const BIN_NAME = process.platform === 'win32' ? 'mobi-pos.exe' : 'mobi-pos';

type Profile = 'release' | 'debug';
type DriverProvider = 'embedded' | 'external';

function profileDir(profile: Profile): string {
  return profile === 'release' ? 'release' : 'debug';
}

function candidatesFor(profile: Profile): string[] {
  const dir = profileDir(profile);
  // e2e flavor FIRST, always: a plain (non-e2e) binary must never be picked
  // up by accident — driving it would open PRODUCTION data (Gate 1 incident
  // 2026-10-10: a fresh target/release build shadowed the e2e binary and the
  // external driver launched the real till).
  return [
    path.resolve(ROOT, 'target-e2e', dir, BIN_NAME),
    path.resolve(ROOT, 'target', dir, BIN_NAME),
    path.resolve(ROOT, 'src-tauri', 'target', dir, BIN_NAME),
  ];
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildHint(): string {
  return [
    'No compiled Tauri binary was found. Build one first:',
    '  npm run build:frontend && cargo build --release -p mobi-pos   (release, self-contained)',
    '  npm run build:e2e                                            (debug, needs `npm run dev`)',
    'or point the suite at a specific binary with WDIO_E2E_BINARY=<path>.',
  ].join('\n');
}

function resolveAppBinary(): { file: string; profile: Profile } {
  const override = process.env.WDIO_E2E_BINARY?.trim();
  if (override) {
    const file = path.resolve(ROOT, override);
    if (!fs.existsSync(file)) {
      throw new Error(`WDIO_E2E_BINARY does not exist: ${file}`);
    }
    // NOTE: match the LAST path segment, not `${sep}debug${sep}` — dirname
    // of a file path never has a trailing separator, so the old contains()
    // check always fell through to 'release' (and picked the external
    // driver) for explicit debug binaries. Fixed in Phase 1.
    const segs = path.dirname(file).split(path.sep);
    const profile: Profile = segs[segs.length - 1] === 'debug' ? 'debug' : 'release';
    return { file, profile };
  }

  const wanted = process.env.WDIO_E2E_PROFILE === 'release' ? 'release' : 'debug';
  const order: Profile[] = wanted === 'release' ? ['release', 'debug'] : ['debug', 'release'];
  for (const profile of order) {
    const found = firstExisting(candidatesFor(profile));
    if (found) return { file: found, profile };
  }
  throw new Error(buildHint());
}

function resolveDriverProvider(profile: Profile): DriverProvider {
  const override = process.env.WDIO_E2E_DRIVER?.trim();
  if (override === 'embedded' || override === 'external') return override;
  return profile === 'debug' ? 'embedded' : 'external';
}

const app = resolveAppBinary();
const driverProvider = resolveDriverProvider(app.profile);

// Hard fail-closed at import time (runs in launcher AND workers): without
// an explicit WDIO_E2E_BINARY override the binary MUST be the e2e flavor.
// A silent fallback to a production binary would open production data.
if (!process.env.WDIO_E2E_BINARY?.trim() && !app.file.includes('target-e2e')) {
  throw new Error(
    `[wdio] refusing non-e2e binary: ${app.file} ` +
      '(build with `npm run build:e2e` or set WDIO_E2E_BINARY explicitly)',
  );
}

export const APP_BINARY = app.file;
export const APP_PROFILE = app.profile;
export const DRIVER_PROVIDER = driverProvider;
export const LOG_DIR = path.resolve(ROOT, 'test-logs');
export const APP_PIN = '202020';

// ── Isolated `.e2e` lifecycle + provenance guard (Phase 1) ──
// The e2e flavor opens ONLY the `com.mobi.pos.e2e` data dir — production
// data is never opened, so there is no snapshot/restore. `POS_E2E_WIPE=1`
// wipes the `.e2e` container for a clean-room run (default: keep, specs
// reset via `e2e_reset_and_seed`).
//
// Provenance guard (Gate 1.6): onPrepare aborts unless
//   (a) the overlay carries the isolated identifier,
//   (b) the production config does NOT (and has no withGlobalTauri),
//   (c) the resolved binary is the e2e flavor (target-e2e) unless
//       WDIO_E2E_BINARY explicitly overrides.
// Runtime identity (identifier/dataDir/gatewayMode/gitSha) is asserted
// in-suite via `e2e_build_info` (see e2e/lib + hello spec).
const E2E_IDENTIFIER = 'com.mobi.pos.e2e';

function e2eDataDir(): string {
  const base = process.env.APPDATA;
  if (!base) throw new Error('[wdio] APPDATA not set — .e2e data dir needs Windows');
  return path.join(base, E2E_IDENTIFIER);
}

function provenanceGuard(): void {
  const overlayRaw = fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.e2e.conf.json'), 'utf8');
  const overlay = JSON.parse(overlayRaw) as { identifier?: string; app?: { withGlobalTauri?: boolean } };
  if (overlay.identifier !== E2E_IDENTIFIER) {
    throw new Error(
      `[wdio] provenance FAIL: overlay identifier is ${JSON.stringify(overlay.identifier)} — expected ${E2E_IDENTIFIER}`,
    );
  }
  if (overlay.app?.withGlobalTauri !== true) {
    throw new Error('[wdio] provenance FAIL: overlay must set app.withGlobalTauri=true (e2e flavor only)');
  }
  const prodRaw = fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8');
  const prod = JSON.parse(prodRaw) as { identifier?: string; app?: { withGlobalTauri?: boolean } };
  if (prod.identifier === E2E_IDENTIFIER) {
    throw new Error('[wdio] provenance FAIL: production config carries the e2e identifier');
  }
  if (prod.app?.withGlobalTauri === true) {
    throw new Error('[wdio] provenance FAIL: production config must not set withGlobalTauri');
  }
  const explicit = (process.env.WDIO_E2E_BINARY ?? '').trim();
  if (!explicit && !app.file.includes('target-e2e')) {
    throw new Error(
      `[wdio] provenance FAIL: resolved binary is not the e2e flavor: ${app.file} ` +
        '(build with `npm run build:e2e` or set WDIO_E2E_BINARY explicitly)',
    );
  }
  console.log(`[wdio] provenance OK (overlay=${E2E_IDENTIFIER}, binary=${app.file})`);
}

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

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop the app kindly first: a graceful close lets SQLite finish the
 * current journal work (a force-kill landing mid-vacuum tore freelist
 * pages once — see the quarantined 18:36 snapshot + DISCOVERY §12).
 * Falls back to taskkill /F after 15 s. Drivers are always force-killed
 * (no DB handles there).
 */
function stopAppGracefully(): void {
  if (!isProcRunning('mobi-pos.exe')) return;
  try {
    execSync('taskkill /IM mobi-pos.exe', { stdio: 'ignore' });
  } catch {
    // already exiting or access denied — fall through to the wait
  }
  for (let i = 0; i < 30 && isProcRunning('mobi-pos.exe'); i++) sleepMs(500);
  if (isProcRunning('mobi-pos.exe')) {
    console.log('[wdio] graceful close timed out — force-killing');
    try {
      execSync('taskkill /F /IM mobi-pos.exe', { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
}

function isAppRunning(): boolean {
  return isProcRunning('mobi-pos.exe');
}

function maybeWipeE2eContainer(): void {
  if (process.env.POS_E2E_WIPE !== '1') return;
  const dir = e2eDataDir();
  // Fail closed: refuse to wipe anything that is not the e2e container.
  if (!dir.endsWith(E2E_IDENTIFIER)) {
    throw new Error(`[wdio] refusing to wipe non-e2e dir: ${dir}`);
  }
  stopAppGracefully();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[wdio] wiped .e2e container: ${dir}`);
  // The WebView profile (Dexie mirrors, recovery intents, outbox shadows)
  // persists per identifier OUTSIDE the data dir — a clean room must clear
  // it too, or stale intents replay at boot holding the checkout flight
  // guard (proven Gate 4: ALREADY_PROCESSING storms on "fresh" runs).
  const profileBase = process.env.LOCALAPPDATA;
  if (profileBase) {
    const profileDir = path.join(profileBase, E2E_IDENTIFIER);
    if (profileDir.endsWith(E2E_IDENTIFIER)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
      console.log(`[wdio] wiped .e2e WebView profile: ${profileDir}`);
    }
  }
}

/**
 * Fail closed on zombie WDIO workers: e2e:clean kills app+drivers but NOT
 * node workers, and an orphaned worker from a timed-out launch keeps
 * driving sales/resets into the SAME container (proven Gate 4: overlapping
 * bodies, ALREADY_PROCESSING storms, phantom divergences, mid-read wipes).
 * Lockfile mutual exclusion (pure Node — wmic is removed on current
 * Windows and nested shells quote-fragile): a live lock holder aborts the
 * launch; a stale lock (dead pid) is adopted with a warning.
 */
const RUN_LOCK = path.join(LOG_DIR, '.wdio-run.lock');

function refuseZombieWorkers(): void {
  // Check only (no writes): onPrepare wipes LOG_DIR right after, which
  // would delete a just-written claim. claimRunLock() writes post-wipe.
  let holder: string | null = null;
  try {
    holder = fs.readFileSync(RUN_LOCK, 'utf8').trim();
  } catch {
    holder = null;
  }
  if (!holder) return;
  const pid = Number(holder);
  let alive = false;
  try {
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, 0);
      alive = true;
    }
  } catch {
    alive = false;
  }
  if (alive) {
    throw new Error(
      `[wdio] another WDIO run (pid ${pid}) holds ${RUN_LOCK} — refusing to launch over it (kill stale node.exe wdio workers first)`,
    );
  }
  console.log(`[wdio] adopting stale run lock (dead pid ${holder})`);
}

function claimRunLock(): void {
  try {
    fs.writeFileSync(RUN_LOCK, String(process.pid));
  } catch {
    // best-effort
  }
}

function releaseRunLock(): void {
  try {
    if (fs.readFileSync(RUN_LOCK, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(RUN_LOCK, { force: true });
    }
  } catch {
    // best-effort
  }
}

export const config: Options.Testrunner = {
  runner: 'local',
  // NOTE: both `*.spec.ts` (new smoke suite) and legacy `*.e2e.ts` specs live
  // here. A previous `**/*.spec.ts` glob matched ZERO files, so runs silently
  // executed nothing — keep the broad pattern so new specs are picked up.
  specs: ['./test/specs/**/*.ts'],
  exclude: ['./test/specs/_probe.e2e.ts'],
  // One app instance at a time: it owns one database. Never parallelize
  // money tests: invoke ONE --spec per `wdio run` (repeated --spec flags
  // spawn parallel workers that reset/seed under each other — proven by a
  // 6-failure pile-up). Serial suites, always.
  maxInstances: 1,
  maxInstancesPerCapability: 1,

  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: APP_BINARY,
      },
    },
  ],

  logLevel: process.env.WDIO_LOG_LEVEL ?? 'info',
  bail: 0,
  outputDir: LOG_DIR,
  waitforTimeout: 20000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: APP_BINARY,
        driverProvider,
        // tauri-driver is already installed via `cargo install tauri-driver`.
        autoInstallTauriDriver: false,
        // msedgedriver is auto-downloaded/pinned to the local Edge build (Windows).
        autoDownloadEdgeDriver: true,
        captureBackendLogs: true,
        backendLogLevel: 'info',
        captureFrontendLogs: true,
        frontendLogLevel: 'info',
        commandTimeout: 60000,
        startTimeout: 120000,
        statusPollTimeout: 10000,
        logLevel: 'info',
      },
    ],
  ],

  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 300000,
    // Explicit: a failed money/stress test is a finding to root-cause, never
    // to retry. Retries also overlap orphaned in-page loops with the retry,
    // producing ALREADY_PROCESSING storms that mask the real result.
    retries: 0,
  },

  onPrepare: () => {
    // Zombie check FIRST: the wipe below deletes the lock, so the check
    // must precede it (and the claim must follow it).
    refuseZombieWorkers();
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
    claimRunLock();
    console.log(`[wdio] binary : ${APP_BINARY}`);
    console.log(`[wdio] profile: ${APP_PROFILE}`);
    console.log(`[wdio] driver : ${driverProvider}`);
    console.log(`[wdio] logs   : ${LOG_DIR}`);
    // Fail closed: never start a run while a till may hold the DB lock.
    if (isAppRunning()) {
      throw new Error(
        '[wdio] mobi-pos.exe is running — run `npm run e2e:clean` first ' +
          'if it is an orphan from a crash.',
      );
    }
    provenanceGuard();
    maybeWipeE2eContainer();
    console.log(`[wdio] e2e data dir: ${e2eDataDir()}`);
    // Run manifest (Gate 1 evidence): git SHA, dirty flag, flavor, profile,
    // tool versions. gitSha is compared in-suite against e2e_build_info.
    try {
      const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
      fs.writeFileSync(
        path.join(LOG_DIR, 'manifest.json'),
        JSON.stringify(
          {
            gitSha: sha,
            dirty: dirty.length > 0,
            binary: APP_BINARY,
            profile: APP_PROFILE,
            driver: driverProvider,
            node: process.version,
            platform: process.platform,
          },
          null,
          2,
        ),
      );
      console.log(`[wdio] manifest: gitSha=${sha} dirty=${dirty.length > 0}`);
    } catch {
      console.log('[wdio] manifest: git metadata unavailable');
    }
  },

  onComplete: () => {
    // No restore: production data was never opened. Graceful stop first so
    // SQLite finishes journal work (a force-kill landing mid-vacuum tore
    // freelist pages once — DISCOVERY §12). Drivers are always force-killed.
    stopAppGracefully();
    try {
      execSync('taskkill /F /IM msedgedriver.exe /IM tauri-driver.exe', { stdio: 'ignore' });
    } catch {
      // already dead — the common case
    }
    releaseRunLock();
  },

  before: async () => {
    const handles = await browser.getWindowHandles();
    if (handles.length > 0) {
      await browser.switchToWindow(handles[0]);
    }
  },
};
