#!/usr/bin/env node
/**
 * Two-instance app harness (SYN queue item 2, GUI half).
 *
 * Starts TWO real app processes at the same time, each with its own sandbox data
 * dir and its own tauri-driver port, and proves what one sandbox cannot:
 *   - the two terminals run concurrently (their result windows overlap),
 *   - each has its own enrolled device identity,
 *   - each mints fiscal numbers from its OWN series (no shared counter),
 *   - neither can see the other's database.
 *
 * The gateway/signature/partition half is covered by `npm run test:sync-e2e`
 * (real Ed25519, gap arbitration, replay, revocation, SERVERTIME tokens) and
 * `npm run test:sync-two-device` (two protocol clients + faults); this runner
 * deliberately does not re-implement them.
 *
 * Hermetic: sandboxes under %TEMP%/opencode/pos-two-instance, driver ports
 * 45xx, results under tests/results, no network beyond loopback.
 *
 * Usage: node tests/harness/two-instance/run.mjs
 * Requires a built e2e binary (`npm run build:e2e`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BIN = path.join(ROOT, 'target-e2e', 'debug', process.platform === 'win32' ? 'mobi-pos.exe' : 'mobi-pos');
const OUT = path.join(ROOT, 'tests', 'results');
const BASE = path.join(process.env.TEMP || '/tmp', 'opencode', 'pos-two-instance');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

if (!fs.existsSync(BIN)) {
  console.error(`[two-instance] missing e2e binary at ${BIN} — run npm run build:e2e first`);
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });

/**
 * Kill anything still holding this instance's sandbox. A crashed run leaves
 * WebView2 processes behind; they keep EBWebView/\*.lock and the next app exits
 * on start ("session deleted as the browser has closed the connection").
 * Matching is by command line, so no other app's webviews are touched.
 */
const killStale = (sandbox) => {
  if (process.platform !== 'win32') return;
  const needle = sandbox.replace(/\\/g, '\\\\');
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" +
    needle +
    "*' -and ($_.Name -like 'mobi-pos*' -or $_.Name -like 'msedgewebview2*' -or $_.Name -like 'msedgedriver*') } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 30000 });
  } catch {
    /* best effort: a stale process is a hygiene problem, not a verdict */
  }
};

const instance = (name, port, skewMs) => {
  const sandbox = path.join(BASE, name);
  killStale(sandbox);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
  const result = path.join(OUT, `two-instance-${name}.json`);
  fs.rmSync(result, { force: true });
  return {
    name,
    port,
    skewMs,
    sandbox,
    result,
    child: null,
    log: path.join(OUT, `two-instance-${name}.log`),
  };
};

// B's clock is 90 s ahead: a live skew, not a mock.
const a = instance('A', 4511, 0);
const b = instance('B', 4512, 90_000);

const start = (i) =>
  new Promise((resolve) => {
    const log = fs.openSync(i.log, 'w');
    i.child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['wdio', 'run', 'e2e-tests/wdio.conf.ts', '--spec', 'e2e-tests/specs/90-two-instance.e2e.ts'],
      {
        cwd: ROOT,
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          POS_WDIO_SANDBOX: i.sandbox,
          POS_TAURI_DRIVER_PORT: String(i.port),
          POS_INSTANCE: i.name,
          POS_FAKE_CLOCK_SKEW_MS: String(i.skewMs),
          POS_RESULT_FILE: i.result,
          WDIO_LOG_LEVEL: 'warn',
        },
        stdio: ['ignore', log, log],
      },
    );
    i.child.on('exit', (code) => resolve(code ?? 1));
  });

console.log(`[two-instance] starting A and B concurrently (ports ${a.port}/${b.port})`);
const codes = await Promise.all([start(a), start(b)]);
killStale(a.sandbox);
killStale(b.sandbox);
const read = (i) => {
  try {
    return JSON.parse(fs.readFileSync(i.result, 'utf8'));
  } catch {
    return null;
  }
};
const ra = read(a);
const rb = read(b);
const tail = (i) => {
  try {
    return fs.readFileSync(i.log, 'utf8').split(/\r?\n/).slice(-6).join(' | ');
  } catch {
    return '<no log>';
  }
};

check('both app processes exited 0', codes[0] === 0 && codes[1] === 0, `A=${codes[0]} B=${codes[1]} :: ${tail(a)} :: ${tail(b)}`);
check('both instances produced a result', Boolean(ra) && Boolean(rb), `${Boolean(ra)}/${Boolean(rb)}`);
check('the two sandboxes are different data dirs', ra?.dbPath !== rb?.dbPath, `${ra?.dbPath} vs ${rb?.dbPath}`);
check('each terminal has its own enrolled device id', Boolean(ra?.deviceId) && Boolean(rb?.deviceId) && ra.deviceId !== rb.deviceId, `${ra?.deviceId} vs ${rb?.deviceId}`);
check(
  'each terminal mints from its own fiscal series',
  Boolean(ra?.series) && Boolean(rb?.series) && ra.series !== rb.series,
  `${ra?.series} vs ${rb?.series}`,
);
check(
  'both start their own series at 000001 (no shared counter)',
  String(ra?.receipt ?? '').endsWith('-000001') && String(rb?.receipt ?? '').endsWith('-000001'),
  `${ra?.receipt} / ${rb?.receipt}`,
);
const overlap =
  Boolean(ra?.startedAt) && Boolean(rb?.startedAt) && Date.parse(ra.startedAt) < Date.parse(rb.finishedAt) && Date.parse(rb.startedAt) < Date.parse(ra.finishedAt);
check('the two terminals really ran at the same time', overlap, `${ra?.startedAt}..${ra?.finishedAt} vs ${rb?.startedAt}..${rb?.finishedAt}`);
check('no receipt number collides across terminals', !(ra?.receipts ?? []).some((r) => (rb?.receipts ?? []).includes(r)));
// Fake clock: B's app clock must actually be shifted, and the fiscal number must
// be identical in shape (series + counter), i.e. numbering ignores wall time.
const skewApplied =
  Boolean(ra?.appClock) && Boolean(rb?.appClock) && Date.parse(rb.appClock) - Date.parse(ra.appClock) > 60_000;
check('the fake clock is applied on the second terminal (skew visible to the app)', skewApplied, `${ra?.appClock} vs ${rb?.appClock}`);
check(
  'the skewed clock does not leak into the fiscal number (no date token)',
  /^REC-[0-9A-Z]{4,8}-\d{6,}$/.test(String(ra?.receipt ?? '')) &&
    /^REC-[0-9A-Z]{4,8}-\d{6,}$/.test(String(rb?.receipt ?? '')) &&
    !String(rb?.receipt ?? '').includes(String(new Date(rb?.appClock ?? 0).getFullYear())),
  `${ra?.receipt} / ${rb?.receipt}`,
);

fs.writeFileSync(
  path.join(OUT, 'two-instance.json'),
  JSON.stringify({ at: new Date().toISOString(), pass, fail, A: ra, B: rb, codes }, null, 2),
);

console.log(`\nTWO-INSTANCE HARNESS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
