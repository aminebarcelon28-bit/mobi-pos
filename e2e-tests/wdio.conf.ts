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

// ---------------------------------------------------------------------------
// Failure artifacts (VISUAL evidence): on any failed test OR hook, capture a
// viewport PNG, a full-page PNG (CDP, when the driver supports it), the DOM
// outerHTML, the page console tap, element diagnostics (target from the error,
// elementFromPoint at its centre, visible overlays) and the raw error. Files
// are named by CASE ID under results/artifacts/<stamp>/<spec>/.
//
// PII: phones and PIN/secret assignments are masked before anything is
// written; scan-pii.mjs is run over the directory after the run.
// ---------------------------------------------------------------------------
const ARTIFACT_ROOT = path.join(ROOT, 'e2e-tests', 'results', 'artifacts');
const ARTIFACT_STAMP = () =>
  (process.env.POS_E2E_ARTIFACT_STAMP ?? '').trim() ||
  new Date().toISOString().replace(/[:.]/g, '-');

function maskPii(input: string): string {
  // scan-pii.mjs is the contract: phones (8-15 digits with separators), IPs,
  // PIN/password hashes, UUIDs and device-id keys must never leave the machine
  // in an artifact. Specific shapes first, then any remaining run of 8-15
  // digits — artifacts are evidence, so over-masking a number is acceptable
  // and under-masking is not.
  return String(input ?? '')
    .replace(/(\+213|00213)[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}/g, '<phone>')
    .replace(/(?<!\d)0[5-7][\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}(?!\d)/g, '<phone>')
    .replace(/(argon2(?:id|i|d)?\$|\$2[aby]\$|scrypt\$|pbkdf2\$)[^\s"'<]{8,}/gi, '<hash>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/((?:device|device_|deviceId|device_id)["']?\s*[:=]\s*["']?)[^"',\s}<]{4,}/gi, '$1<masked>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/("?(?:pin|password|passcode|secret|token|appPin)"?\s*[:=]\s*"?)[^",\s}]{3,}/gi, '$1<masked>')
    .replace(/(pin\s*[:=]\s*)(\d{4,8})/gi, '$1<masked>')
    .replace(/(?<!\d)(?:\d[\s.\-()]*){8,15}(?!\d)/g, '<num>');
}

function caseArtifactBase(test: { fullTitle?: string; title?: string; file?: string }): {
  dir: string;
  base: string;
} {
  const spec = path
    .basename(String(test?.file ?? 'unknown'))
    .replace(/\.e2e\.(ts|mts)$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-');
  const title = String(test?.fullTitle ?? test?.title ?? 'unknown');
  const id =
    (title.match(/\[([A-Z][A-Z0-9]{0,3}-\d{2,3})\]/) ?? [])[1] ??
    (title
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) ||
      'unknown');
  const hook = /"?(before|after)\s*(each|all)"?\s*hook/i.exec(title);
  const suffix = hook ? `.${hook[1]}-${hook[2].toLowerCase()}` : '';
  const dir = path.join(ARTIFACT_ROOT, ARTIFACT_STAMP(), spec);
  return { dir, base: path.join(dir, `${id}${suffix}`) };
}

/** Raw-string page probes: no transpiled closures, so no __name dependency. */
const PAGE_DIAGNOSTICS = `(function (targetTestid) {
  var out = { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } };
  function shown(el) {
    try {
      if (!el) return false;
      var cs = getComputedStyle(el);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }
  function rect(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function describe(el) {
    if (!el) return null;
    var cs = null; try { cs = getComputedStyle(el); } catch (e) {}
    return {
      tag: el.tagName,
      testid: el.getAttribute && el.getAttribute('data-testid'),
      aria: el.getAttribute && el.getAttribute('aria-label'),
      role: el.getAttribute && el.getAttribute('role'),
      disabled: el.disabled === true,
      displayed: shown(el),
      rect: rect(el),
      pointerEvents: cs ? cs.pointerEvents : null,
      zIndex: cs ? cs.zIndex : null,
      text: (el.textContent || '').trim().slice(0, 120),
    };
  }
  out.active = describe(document.activeElement);
  out.bodyClass = document.body ? document.body.className.slice(0, 200) : null;
  out.centerElement = describe(document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2)));
  var target = targetTestid ? document.querySelector('[data-testid="' + targetTestid + '"]') : null;
  out.target = describe(target);
  if (target) {
    var r = target.getBoundingClientRect();
    out.targetFromPoint = describe(document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)));
  }
  out.overlays = Array.prototype.slice.call(document.querySelectorAll(
    '[role="dialog"],[data-testid$="dialog"],[data-testid$="-overlay"],[data-testid="lock-screen"],[data-testid="login-pin-pad"]'
  )).filter(shown).map(describe);
  out.controls = Array.prototype.slice.call(document.querySelectorAll('button,input,[data-testid]')).filter(shown).slice(0, 120).map(describe);
  out.bodyTail = (document.body && document.body.innerText ? document.body.innerText : '').slice(-4000);
  return out;
})(`;
const PAGE_CONSOLE_TAP = 'return (window.__posErrors || []).slice(-200);';
const PAGE_OUTER_HTML = 'return document.documentElement.outerHTML;';

async function captureFailureArtifacts(
  test: { fullTitle?: string; title?: string; file?: string },
  result: { error?: Error; duration?: number; passed?: boolean },
): Promise<void> {
  const { dir, base } = caseArtifactBase(test);
  fs.mkdirSync(dir, { recursive: true });
  const title = String(test?.fullTitle ?? test?.title ?? '');
  const err = result.error;
  const targetTestid = err
    ? (String(err.message).match(/data-testid="([^"]+)"/) ?? [])[1] ?? null
    : null;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    spec: path.basename(String(test?.file ?? 'unknown')),
    title,
    caseId: path.basename(base).replace(/\.(before|after)-(each|all)$/, ''),
    durationMs: result.duration ?? null,
    error: err ? { name: err.name, message: maskPii(err.message), stack: maskPii(err.stack ?? '') } : null,
    targetTestid,
    screenshots: {} as Record<string, string>,
    probeErrors: [] as string[],
  };
  const probes = record.probeErrors as string[];

  // 1. Viewport PNG (always available).
  try {
    const b64 = await browser.takeScreenshot();
    fs.writeFileSync(`${base}.png`, Buffer.from(b64, 'base64'));
    (record.screenshots as Record<string, string>).viewport = `${base}.png`;
  } catch (e) {
    probes.push(`viewport screenshot: ${maskPii(String((e as Error)?.message ?? e))}`);
  }
  // 2. Full-page PNG. The tauri-driver session exposes no CDP bridge
  // (browser.cdp is absent), so grow the window to the document height,
  // capture, and restore. If the window manager clamps the size, the JSON
  // records the clamp and the viewport PNG remains the visual evidence.
  try {
    const metrics = (await browser.execute(
      'return { w: innerWidth, h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) };',
    )) as { w: number; h: number };
    const before = (await browser.getWindowSize()) as { width: number; height: number };
    const targetHeight = Math.max(before.height, Math.min(metrics.h + 120, 6000));
    await browser.setWindowSize(before.width, targetHeight);
    await browser.pause(300);
    const actual = (await browser.getWindowSize()) as { width: number; height: number };
    const b64 = await browser.takeScreenshot();
    fs.writeFileSync(`${base}.full.png`, Buffer.from(b64, 'base64'));
    (record.screenshots as Record<string, string>).fullPage = `${base}.full.png`;
    record.fullPage = {
      requestedHeight: targetHeight,
      actualHeight: actual.height,
      documentHeight: metrics.h,
      clamped: actual.height < targetHeight - 5,
    };
    await browser.setWindowSize(before.width, before.height);
  } catch (e) {
    probes.push(`full-page screenshot: ${maskPii(String((e as Error)?.message ?? e))}`);
  }
  // 3. DOM + diagnostics + console tap (raw-string probes).
  try {
    const html = (await browser.execute(PAGE_OUTER_HTML)) as string;
    fs.writeFileSync(`${base}.html`, maskPii(html));
  } catch (e) {
    probes.push(`outerHTML: ${maskPii(String((e as Error)?.message ?? e))}`);
  }
  let diag: Record<string, unknown> | null = null;
  try {
    diag = (await browser.execute(`return ${PAGE_DIAGNOSTICS}${JSON.stringify(targetTestid)});`)) as Record<
      string,
      unknown
    >;
    record.diagnostics = diag;
  } catch (e) {
    probes.push(`diagnostics: ${maskPii(String((e as Error)?.message ?? e))}`);
  }
  let consoleTap: unknown = null;
  try {
    consoleTap = await browser.execute(PAGE_CONSOLE_TAP);
    record.consoleTap = consoleTap;
  } catch (e) {
    probes.push(`console tap: ${maskPii(String((e as Error)?.message ?? e))}`);
  }
  fs.writeFileSync(`${base}.json`, maskPii(JSON.stringify(record, null, 2)));
  fs.writeFileSync(
    `${base}.log`,
    maskPii(
      [
        `ts: ${record.ts}`,
        `spec: ${String(record.spec)}`,
        `case: ${String(record.caseId)}`,
        `title: ${title}`,
        `error: ${err ? `${err.name}: ${err.message}` : 'none'}`,
        `stack:\n${err?.stack ?? ''}`,
        `probe errors: ${probes.join(' | ') || 'none'}`,
        `console tap:\n${JSON.stringify(consoleTap, null, 2)}`,
        `body tail:\n${diag ? String((diag as { bodyTail?: string }).bodyTail ?? '') : ''}`,
      ].join('\n'),
    ),
  );
  console.log(`[artifact] ${path.relative(ROOT, base)} (.png/.full.png/.html/.json/.log)`);
}

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
    if (!(process.env.POS_E2E_ARTIFACT_STAMP ?? '').trim()) {
      process.env.POS_E2E_ARTIFACT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
    }
    console.log(`[e2e-tests] artifacts: ${path.join(ARTIFACT_ROOT, ARTIFACT_STAMP())}`);
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
    // Native crypto (Argon2id PIN set) and keyring invokes run inside
    // `execute/async` and occasionally exceed the driver's default script
    // timeout under chained load — four rows (MNY-25, SCL-11, IDN-13, REF-14)
    // flip between sweeps purely on that abort. Raise the script ceiling; the
    // mocha budget and every assertion are unchanged. Measured: the aborts are
    // WebDriver "script timeout" errors on slow native calls, not test hangs.
    try {
      await browser.setTimeout({ script: 600000 });
    } catch (e) {
      console.log('[e2e-tests] setTimeout(script) refused:', String((e as Error)?.message ?? e));
    }
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
      if (state === 'fail') {
        await captureFailureArtifacts(test, result);
      }
    } catch {
      /* reporting must never fail a test */
    }
  },

  /**
   * Hook failures carry no test body, so `afterTest` never sees them. Capture
   * the same artifact set here, with the hook name in the file name — a red
   * hook must end the run with a picture and a named cause, not a timeout.
   */
  afterHook: async function (
    test: { fullTitle?: string; title?: string; file?: string },
    _context: unknown,
    result: { error?: Error; duration?: number; passed?: boolean },
    hookName: string,
  ) {
    try {
      if (!result?.error) return;
      await captureFailureArtifacts(
        {
          fullTitle: `${hookName} hook: ${String(test?.fullTitle ?? test?.title ?? '')}`,
          file: test?.file,
        },
        result,
      );
    } catch (e) {
      console.error('[e2e-tests] afterHook artifact failed:', (e as Error)?.message ?? e);
    }
  },
};
