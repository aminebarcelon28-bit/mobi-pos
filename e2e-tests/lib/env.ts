/**
 * Environment / path resolution for the encyclopedia harness.
 *
 * The harness is fully self-contained under `e2e-tests/` and NEVER modifies
 * app sources. All isolation happens through env overrides (`APPDATA` etc.)
 * applied by `wdio.conf.ts` BEFORE the app process is spawned, so the app
 * opens a sandboxed data dir instead of the real till's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Locate the repo root by walking up from cwd looking for src-tauri/tauri.conf.json. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'src-tauri', 'tauri.conf.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('[e2e-tests/env] repo root not found above cwd (no src-tauri/tauri.conf.json)');
}

export const ROOT = findRepoRoot();
export const E2E_DIR = path.join(ROOT, 'e2e-tests');
export const FIXTURES_DIR = path.join(E2E_DIR, 'fixtures');
export const LOGS_DIR = path.join(E2E_DIR, 'test-logs');

export const BIN_NAME = process.platform === 'win32' ? 'mobi-pos.exe' : 'mobi-pos';
export const BIN_PATH = process.env.WDIO_E2E_BINARY?.trim()
  ? path.resolve(ROOT, process.env.WDIO_E2E_BINARY.trim())
  : path.join(ROOT, 'target-e2e', 'debug', BIN_NAME);

export const TAURI_DRIVER_PATH =
  process.env.WDIO_TAURI_DRIVER?.trim() ||
  path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver');

/** Isolated e2e identifier from src-tauri/tauri.e2e.conf.json. */
export const E2E_IDENTIFIER = 'com.mobi.pos.e2e';

/**
 * Sandbox root. Child processes (tauri-driver, msedgedriver, the app) inherit
 * the overridden USERPROFILE from `wdio.conf.ts`; Windows known-folder
 * resolution (what Tauri's app_data_dir uses) expands `%USERPROFILE%` from
 * the env, so the app's data dir resolves INSIDE this sandbox:
 *   DB      : {sandbox}/home/AppData/Roaming/com.mobi.pos.e2e/mobi_pos.db
 *   WebView : {sandbox}/home/AppData/Local/com.mobi.pos.e2e/EBWebView
 * (Verified empirically: APPDATA/LOCALAPPDATA env overrides alone did NOT
 * redirect the app — the known-folder API ignores them.)
 */
export const SANDBOX =
  process.env.POS_WDIO_SANDBOX?.trim() ||
  path.join(process.env.TEMP || os.tmpdir(), 'opencode', 'pos-wdio-sandbox');

export const SANDBOX_HOME = path.join(SANDBOX, 'home');
export const SANDBOX_ROAMING = path.join(SANDBOX_HOME, 'AppData', 'Roaming');
export const SANDBOX_LOCAL = path.join(SANDBOX_HOME, 'AppData', 'Local');

/** Live SQLite file (Tauri app_data_dir = known-folder roaming/{identifier}). */
export const DB_DIR = path.join(SANDBOX_ROAMING, E2E_IDENTIFIER);
export const DB_PATH = path.join(DB_DIR, 'mobi_pos.db');

/** WebView2 profile dir (Dexie mirrors + localStorage live here). */
export const WEBVIEW_DIR = path.join(SANDBOX_LOCAL, E2E_IDENTIFIER);

export const APP_PIN = process.env.POS_E2E_PIN?.trim() || '202020';

/** Apply sandbox env overrides to this process (children inherit them). */
export function applySandboxEnv(): void {
  process.env.APPDATA = SANDBOX_ROAMING;
  process.env.LOCALAPPDATA = SANDBOX_LOCAL;
  process.env.USERPROFILE = SANDBOX_HOME;
  process.env.XDG_DATA_HOME = path.join(SANDBOX, 'data');
  process.env.XDG_CONFIG_HOME = path.join(SANDBOX, 'config');
  if (!process.env.HOME) process.env.HOME = SANDBOX_HOME;
}

/** Delete the sandbox (both roaming data dir + WebView profile). App must be stopped. */
export function wipeSandbox(): void {
  for (const dir of [DB_DIR, WEBVIEW_DIR]) {
    if (!dir.includes(E2E_IDENTIFIER)) {
      throw new Error(`[e2e-tests/env] refusing to wipe non-e2e dir: ${dir}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
