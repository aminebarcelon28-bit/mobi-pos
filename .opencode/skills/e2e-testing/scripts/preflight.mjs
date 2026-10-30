#!/usr/bin/env node
/**
 * preflight.mjs - Gate 0 environment check for the MobiPOS E2E harness.
 *
 * Verifies, without launching the app:
 *   - node >= 20 and the WDIO CLI present
 *   - the e2e binary exists, embeds HEAD (build provenance) and the
 *     `com.mobi.pos.e2e` identifier, and is not older than any source file
 *     (including `src-tauri/Cargo.lock`: a dependency bump changes the binary)
 *   - tauri-driver is where wdio.conf.ts expects it
 *   - no orphaned mobi-pos.exe / drivers (they hold the DB and the WebView dir)
 *   - the sandbox paths, and whether a DB is already there
 *
 * `--mobile` swaps the desktop checks for the mobile ones: adb present, a
 * device/emulator attached, an AVD listed, and the built APK newer than the
 * sources AND carrying the same version as tauri.conf.json / package.json.
 * A missing APK is a blocker: mobile cannot be reported as tested without one.
 *
 * Usage: node .opencode/skills/e2e-testing/scripts/preflight.mjs [--quiet] [--provenance] [--mobile]
 *        --provenance   only certify the binary (sha + identifier + freshness);
 *                       used by wdio.conf.ts at import time, where driver and
 *                       orphan checks would misfire inside a worker.
 *        --mobile       mobile lane: adb + AVD + APK version/freshness.
 * Exit:  0 all good (warnings allowed), 1 a hard blocker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  paths, repoRoot, isRunning, humanBytes, parseArgs, ok, warn, bad, info, C, IDENTIFIER, gitHead,
  APP_PATHS, sourceNewest, walk,
} from './_lib.mjs';

const args = parseArgs();
const quiet = Boolean(args.quiet);
// Provenance-only mode: used by wdio.conf.ts at import time, where the driver
// and orphan checks would misfire (workers see tauri-driver already running)
// and where only the binary's identity matters.
const provenanceOnly = Boolean(args.provenance);
const mobile = Boolean(args.mobile);
let failures = 0;
let warnings = 0;

function hard(msg) { bad(msg); failures++; }
function soft(msg) { warn(msg); warnings++; }

const root = repoRoot();
const p = paths(root);
if (!quiet) info(`repo   ${root}`);
if (!quiet) info(`node   ${process.version}  ${process.platform}`);

// 1. Node + WDIO
const major = Number(process.version.replace(/^v/, '').split('.')[0]);
if (major < 20) hard(`node ${process.version} is too old (need >= 20)`);
else if (!quiet) ok(`node ${process.version}`);

if (!provenanceOnly) {
  if (!fs.existsSync(p.wdioBin)) {
    hard(`WDIO CLI missing at ${p.wdioBin} - run npm install`);
  } else {
    const v = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@wdio', 'cli', 'package.json'), 'utf8')).version;
    if (!quiet) ok(`webdriverio ${v}`);
  }
}

// 2. Binary provenance + freshness
if (mobile) {
  mobileChecks();
} else if (!fs.existsSync(p.binary)) {
  hard(`e2e binary missing: ${p.binary}\n       build it: npm run build:e2e`);
} else {
  const st = fs.statSync(p.binary);
  // Provenance: build-e2e stamps HEAD into the binary (E2E_GIT_SHA) and the
  // e2e identifier is a compiled literal. A stale or wrong-flavor binary is
  // the quietest way for the suite to lie, so both are hard blockers.
  const head = gitHead(root);
  const bytes = fs.readFileSync(p.binary);
  if (!head) {
    hard('cannot read git HEAD - refusing to certify the e2e binary (run inside the repo)');
  } else if (!bytes.includes(Buffer.from(head))) {
    const embedded = findEmbeddedCommit(bytes, root);
    const changed = embedded ? changedAppPaths(embedded, head, root) : null;
    if (embedded && changed && changed.length === 0) {
      // A commit that touched only docs/skills/tests does not make the app
      // binary stale. Prove it with the diff instead of demanding a rebuild.
      soft(
        `binary built at ${embedded.slice(0, 12)}, HEAD ${head.slice(0, 12)} - ` +
          'no app source changed in between (provenance accepted)',
      );
    } else {
      hard(
        `e2e binary does not embed HEAD ${head.slice(0, 12)}` +
          (embedded ? ` (it embeds ${embedded.slice(0, 12)})` : ' (no commit sha found)') +
          (changed && changed.length
            ? `\n       app source changed since the build: ${changed.slice(0, 5).join(', ')}`
            : '') +
          `\n       rebuild: npm run build:e2e`,
      );
    }
  } else if (!quiet) {
    ok(`binary embeds HEAD ${head.slice(0, 12)}`);
  }
  if (!bytes.includes(Buffer.from(IDENTIFIER))) {
    hard(`e2e binary does not embed "${IDENTIFIER}" - wrong flavor, refusing to test against it`);
  }
  // Freshness: uncommitted source edits after the build are not covered by the
  // sha stamp. package.json is excluded on purpose: script edits (and this
  // skill's own npm scripts) do not change the compiled app, and flagging them
  // would push people to rebuild for nothing. Cargo.lock IS included: a
  // dependency bump recompiles the app without touching a .rs file.
  const newest = sourceNewest(root);
  const lagMs = newest - st.mtimeMs;
  if (lagMs > 1000) {
    hard(
      `source changed ${(lagMs / 60000).toFixed(1)} min AFTER the binary was built ` +
        `(newest source ${new Date(newest).toISOString()}, binary ${new Date(st.mtimeMs).toISOString()})` +
        `\n       rebuild: npm run build:e2e`,
    );
  } else if (!quiet) {
    ok(`binary ${humanBytes(st.size)}, built ${new Date(st.mtimeMs).toISOString()}, newer than all sources`);
  }
}

// 3. Driver
if (!provenanceOnly && !mobile) {
  if (!fs.existsSync(p.driver)) {
    hard(`tauri-driver not found at ${p.driver}\n       install: cargo install tauri-driver  (or set WDIO_TAURI_DRIVER)`);
  } else if (!quiet) {
    ok(`tauri-driver ${p.driver}`);
  }

  // 4. Orphans
  for (const image of ['mobi-pos.exe', 'msedgedriver.exe', 'tauri-driver.exe']) {
    if (isRunning(image)) hard(`${image} is running - run: npm run e2e:clean`);
  }
  if (failures === 0 && !quiet) ok('no orphaned app/driver processes');

  // 5. Sandbox
  const dbExists = fs.existsSync(p.db);
  if (!quiet) {
    info(`sandbox ${p.sandbox}`);
    info(`db      ${p.db}${dbExists ? ` (${humanBytes(fs.statSync(p.db).size)})` : ' (absent - first run creates it)'}`);
    info(`webview ${p.webview}`);
  }
  if (process.env.POS_WDIO_SANDBOX) {
    warn(`POS_WDIO_SANDBOX is set - runs are isolated from the default sandbox`);
  }
}

// 6. Summary
console.log('');
if (failures > 0) {
  console.log(`${C.red}${failures} blocker(s), ${warnings} warning(s).${C.reset} Fix blockers before running the harness.`);
  process.exit(1);
}
console.log(`${C.green}preflight clear${C.reset}${warnings ? ` (${warnings} warning(s))` : ''}. Next: run the smoke spec.`);

/**
 * App-source paths changed between two commits.
 * Returns [] when the range provably touches no app source, an array of paths
 * when it does, and null when the range cannot be proven (unknown sha, not an
 * ancestor of `to`, git failure) - callers must treat null as a hard failure.
 */
function changedAppPaths(from, to, root) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', from, to], { cwd: root, stdio: 'ignore' });
  } catch {
    return null; // build commit is not an ancestor of HEAD: cannot reason about it
  }
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${from}..${to}`, '--', ...APP_PATHS], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** First 40-hex string in the binary that is a real commit in this repo. */
function findEmbeddedCommit(bytes, root) {
  const seen = new Set((bytes.toString('latin1').match(/[0-9a-f]{40}/g) || []));
  for (const sha of seen) {
    try {
      // execFileSync, not execSync: cmd.exe treats `^` as an escape character
      // and would hand git a mangled `{commit}` revision.
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' });
      return sha;
    } catch { /* not a commit in this repo */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* mobile lane                                                         */
/* ------------------------------------------------------------------ */

/** Run a tool that may only exist on PATH; null when it cannot run. */
function tryCmd(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.error || (r.status !== 0 && !r.stdout)) return null;
  return String(r.stdout || '').trim();
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Mobile preflight. A mobile verdict is only worth recording when we know
 * WHICH build ran: adb present, a device attached, and an APK that is both
 * newer than the sources and stamped with the declared version.
 */
function mobileChecks() {
  const adb = tryCmd('adb', ['version']);
  if (!adb) {
    hard('adb not found on PATH - install platform-tools (or set ANDROID_HOME) before the mobile lane');
  } else {
    const line = adb.split(/\r?\n/)[0];
    ok(`adb ${line}`);
  }

  if (adb) {
    const devices = tryCmd('adb', ['devices']) || '';
    const attached = devices.split(/\r?\n/).slice(1).map((l) => l.trim()).filter((l) => /\tdevice$/.test(l));
    if (!attached.length) {
      hard('no device/emulator attached (adb devices shows none) - start an AVD or plug the device in');
    } else {
      ok(`${attached.length} device(s) attached: ${attached.map((l) => l.split('\t')[0]).join(', ')}`);
    }
  }

  const avds = tryCmd('emulator', ['-list-avds']) ?? tryCmd(path.join(process.env.ANDROID_HOME || '', 'emulator', 'emulator'), ['-list-avds']);
  if (avds === null) soft('emulator not on PATH - cannot list AVDs (only matters when you need to start one)');
  else if (!avds.trim()) soft('no AVD installed (emulator -list-avds is empty)');
  else ok(`AVD(s): ${avds.split(/\r?\n/).filter(Boolean).join(', ')}`);

  // APK: the only artifact a mobile verdict can be attributed to.
  const apkRoot = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
  const apks = fs.existsSync(apkRoot)
    ? walk(apkRoot).filter((f) => f.toLowerCase().endsWith('.apk'))
    : [];
  if (!apks.length) {
    hard(`no APK under ${path.relative(root, apkRoot)} - build it: npm run tauri android build`);
    return;
  }
  const apk = apks.map((f) => ({ f, st: fs.statSync(f) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
  ok(`APK ${path.relative(root, apk.f)} (${humanBytes(apk.st.size)}, ${new Date(apk.st.mtimeMs).toISOString()})`);

  const declared = readJsonFile(path.join(root, 'src-tauri', 'tauri.conf.json'))?.version;
  const packaged = readJsonFile(path.join(root, 'package.json'))?.version;
  if (declared && packaged && declared !== packaged) {
    hard(`version mismatch: tauri.conf.json ${declared} vs package.json ${packaged} - the APK cannot be attributed to a source version`);
  } else if (declared) {
    ok(`declared version ${declared} (tauri.conf.json = package.json)`);
  } else {
    soft('cannot read a version from src-tauri/tauri.conf.json');
  }

  const apkVersion = tryCmd('aapt', ['dump', 'badging', apk.f]);
  const versionName = apkVersion ? (/versionName='([^']+)'/.exec(apkVersion) || [])[1] : null;
  if (versionName && declared && versionName !== declared) {
    hard(`APK versionName ${versionName} != declared ${declared} - rebuild before recording a mobile verdict`);
  } else if (versionName) {
    ok(`APK versionName ${versionName}`);
  } else {
    soft('aapt not on PATH - APK versionName not read (mtime + declared version still checked)');
  }

  const newest = sourceNewest(root);
  const lagMs = newest - apk.st.mtimeMs;
  if (lagMs > 1000) {
    hard(
      `source changed ${(lagMs / 60000).toFixed(1)} min AFTER the APK was built ` +
        `(newest source ${new Date(newest).toISOString()}) - rebuild: npm run tauri android build`,
    );
  } else {
    ok('APK newer than all app sources');
  }
}
