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
import { spawn } from 'node:child_process';

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

const instance = (name, port) => {
  const sandbox = path.join(BASE, name);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
  const result = path.join(OUT, `two-instance-${name}.json`);
  fs.rmSync(result, { force: true });
  return {
    name,
    port,
    sandbox,
    result,
    child: null,
    log: path.join(OUT, `two-instance-${name}.log`),
  };
};

const a = instance('A', 4511);
const b = instance('B', 4512);

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

fs.writeFileSync(
  path.join(OUT, 'two-instance.json'),
  JSON.stringify({ at: new Date().toISOString(), pass, fail, A: ra, B: rb, codes }, null, 2),
);

console.log(`\nTWO-INSTANCE HARNESS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
