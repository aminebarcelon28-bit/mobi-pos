#!/usr/bin/env node
/**
 * Two-instance + gateway fault suite — ONE headless command, hermetic.
 *
 *   npm run test:two-instance
 *
 * What runs:
 *   1. a loopback merchant gateway (proxy/gateway.mjs) with two ENROLLED device
 *      keys (fixed test seeds, ALLOW_TEST_KEY gated);
 *   2. the real app, twice, one at a time (A then B), each in its own sandbox
 *      data dir and driver port, each performing a real checkout. B runs on a
 *      +90 s fake clock;
 *   3. a deterministic fault schedule driven by this runner against the gateway,
 *      signing the two devices' mutations with their enrolled test keys:
 *        partition (dropped socket) → heal → duplicate delivery → reorder (future
 *        hole) → crash-before-ACK replay → clock skew → revocation isolation.
 *
 * Why sequential instances: two concurrent WDIO processes race on config load on
 * this host (documented in D-SYN-two-instance). Concurrency is not what this
 * suite is for — the app instances supply identity/numbering/isolation, the
 * runner supplies the fault schedule, so every step is deterministic and the
 * whole thing is one command with one artifact.
 *
 * Dev-only: no network beyond loopback, no credentials, no hardware.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createGatewayServer, publicKeyHexFromSeedHex } from '../../../proxy/gateway.mjs';
import { postMutations } from '../../../src/api/syncGateway.ts';
import { envelopeFor, signEnvelope, deviceKeypair } from '../../fixtures/mockGatewayServer.mjs';

process.env.ALLOW_TEST_KEY = '1';

const ROOT = process.cwd();
const BIN = path.join(ROOT, 'target-e2e', 'debug', process.platform === 'win32' ? 'mobi-pos.exe' : 'mobi-pos');
const OUT = path.join(ROOT, 'tests', 'results');
const BASE = path.join(process.env.TEMP || '/tmp', 'opencode', 'pos-two-instance');

const SEED_A = '11'.repeat(32);
const SEED_B = '22'.repeat(32);

let pass = 0;
let fail = 0;
const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, ok: Boolean(cond), detail });
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

// ── sandbox / process hygiene ───────────────────────────────────────────────
const killStale = (sandbox) => {
  if (process.platform !== 'win32') return;
  const needle = sandbox.replace(/\\/g, '\\\\');
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" +
    needle +
    "*' -and ($_.Name -like 'mobi-pos*' -or $_.Name -like 'msedgewebview2*' -or $_.Name -like 'msedgedriver*') } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: 30000 });
  } catch {
    /* best effort */
  }
};

const runInstance = (name, port, skewMs) => {
  const sandbox = path.join(BASE, name);
  const result = path.join(OUT, `two-instance-${name}.json`);
  const log = path.join(OUT, `two-instance-${name}.log`);
  killStale(sandbox);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox, { recursive: true });
  fs.rmSync(result, { force: true });

  const fd = fs.openSync(log, 'w');
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wdio', 'run', 'e2e-tests/wdio.conf.ts', '--spec', 'e2e-tests/specs/90-two-instance.e2e.ts'],
    {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        POS_WDIO_SANDBOX: sandbox,
        POS_TAURI_DRIVER_PORT: String(port),
        POS_INSTANCE: name,
        POS_RESULT_FILE: result,
        POS_FAKE_CLOCK_SKEW_MS: String(skewMs),
        WDIO_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', fd, fd],
      timeout: 10 * 60 * 1000,
    },
  );
  fs.closeSync(fd);
  killStale(sandbox);
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(result, 'utf8'));
  } catch {
    payload = null;
  }
  return { name, code: r.status ?? 1, result: payload, log };
};

// ── gateway ────────────────────────────────────────────────────────────────
const gw = createGatewayServer({});
gw.registerDevice('dev-A', publicKeyHexFromSeedHex(SEED_A));
gw.registerDevice('dev-B', publicKeyHexFromSeedHex(SEED_B));
const addr = await gw.listen(0);
const baseUrl = `http://127.0.0.1:${addr.port ?? addr}`;

const keys = { 'dev-A': deviceKeypair(SEED_A), 'dev-B': deviceKeypair(SEED_B) };
/** A signed mutation exactly in the shape the native lane emits. */
const mutation = (deviceId, seq, verifiedMs, ticket = 'TKT-TWO') => {
  const refundId = `REF-${deviceId}-${seq}`;
  const envelope = envelopeFor(ticket, refundId, 100 + seq, deviceId, seq, verifiedMs);
  return {
    seqNo: seq,
    ticketId: `${ticket}-${seq}`,
    payload: JSON.stringify({ id: refundId, net: 100 + seq }),
    deviceSignature: signEnvelope(keys[deviceId].privateKey, envelope),
    envelope,
  };
};
const send = async (deviceId, mutations) => {
  try {
    const res = await postMutations(baseUrl, { deviceId, mutations });
    return { ok: true, acks: res.ackSeqNos ?? [], token: res.serverTimeToken };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};
const ledgerOf = (deviceId) => gw.ledger().filter((m) => m.deviceId === deviceId);

try {
  // ── 1. two real app instances ───────────────────────────────────────────
  console.log('[two-instance] instance A (real clock)');
  const a = runInstance('A', 4511, 0);
  console.log(`[two-instance] instance B (fake clock +90 s)`);
  const b = runInstance('B', 4512, 90_000);

  check('instance A exited 0 and produced a result', a.code === 0 && Boolean(a.result), `A=${a.code}`);
  check('instance B exited 0 and produced a result', b.code === 0 && Boolean(b.result), `B=${b.code}`);
  check(
    'the two instances used different data dirs',
    Boolean(a.result?.dbPath) && a.result.dbPath !== b.result?.dbPath,
    `${a.result?.dbPath} vs ${b.result?.dbPath}`,
  );
  check(
    'each terminal has its own enrolled device identity',
    Boolean(a.result?.deviceId) && Boolean(b.result?.deviceId) && a.result.deviceId !== b.result.deviceId,
    `${a.result?.deviceId} vs ${b.result?.deviceId}`,
  );
  check(
    'each terminal mints from its own fiscal series, both at 000001',
    Boolean(a.result?.series) && Boolean(b.result?.series) && a.result.series !== b.result.series &&
      String(a.result?.receipt).endsWith('-000001') && String(b.result?.receipt).endsWith('-000001'),
    `${a.result?.receipt} / ${b.result?.receipt}`,
  );
  check(
    'the fake clock is visible to the second terminal and does not leak into the number',
    Date.parse(b.result?.appClock ?? 0) - Date.parse(a.result?.appClock ?? 0) > 60_000 &&
      /^REC-[0-9A-Z]{4,8}-\d{6,}$/.test(String(b.result?.receipt ?? '')),
    `${a.result?.appClock} vs ${b.result?.appClock}`,
  );

  // ── 2. fault schedule against the gateway ──────────────────────────────
  const appClockB = Date.parse(b.result?.appClock ?? Date.now());
  const aBatch = [1, 2, 3].map((s) => mutation('dev-A', s, Date.now()));

  // partition: the socket is dropped before the server reads the batch
  gw.simulateDrop(1);
  const dropped = await send('dev-A', aBatch);
  check('partition: a dropped socket is a failure, never a silent ACK', !dropped.ok, dropped.ok ? 'unexpected ACK' : 'refused');
  check('partition: no row was ingested', ledgerOf('dev-A').length === 0, `rows=${ledgerOf('dev-A').length}`);

  // heal: the same batch goes through
  const healed = await send('dev-A', aBatch);
  check(
    'heal: the batch commits with contiguous ACKs and a time token',
    healed.ok && healed.acks.join(',') === '1,2,3' && String(healed.token ?? '').startsWith('SERVERTIME_V1.'),
    JSON.stringify(healed.acks ?? healed.error),
  );

  // duplicate delivery
  const dup = await send('dev-A', aBatch);
  check(
    'duplicate: a replay ACKs without double-inserting',
    dup.ok && ledgerOf('dev-A').length === 3,
    `rows=${ledgerOf('dev-A').length}`,
  );

  // reorder: B's seq 2 arrives before seq 1
  const bBatch = [1, 2, 3, 4].map((s) => mutation('dev-B', s, appClockB));
  const gap = await send('dev-B', [bBatch[1]]);
  const expected = Number(/expected_(\d+)_received_(\d+)/.exec(String(gap.error ?? ''))?.[1] ?? -1);
  check(
    'reorder: a future hole is refused with expected/received',
    !gap.ok && expected === 1 && ledgerOf('dev-B').length === 0,
    String(gap.error ?? '').slice(0, 90),
  );

  // clock skew: B's envelopes carry its +90 s clock; seq (not time) orders
  const skewed = await send('dev-B', bBatch);
  check(
    'clock skew: a device 90 s ahead syncs in sequence order',
    skewed.ok && skewed.acks.join(',') === '1,2,3,4' &&
      ledgerOf('dev-B').map((m) => m.seqNo).join(',') === '1,2,3,4',
    JSON.stringify(skewed.acks ?? skewed.error),
  );

  // crash before the ACK is read: replay the same batch after restart
  const replay = await send('dev-B', bBatch);
  check(
    'crash-before-ACK: the replay is idempotent (4 rows, not 8)',
    replay.ok && ledgerOf('dev-B').length === 4,
    `rows=${ledgerOf('dev-B').length}`,
  );

  // revocation isolates one device
  gw.setDeviceStatus('dev-B', 'revoked');
  const revoked = await send('dev-B', [mutation('dev-B', 5, appClockB)]);
  const stillA = await send('dev-A', [mutation('dev-A', 4, Date.now())]);
  check(
    'revocation: the revoked device is refused while the other keeps syncing',
    !revoked.ok && /DEVICE_REVOKED|403/.test(String(revoked.error ?? '')) && stillA.ok,
    `${String(revoked.error ?? '').slice(0, 40)} | A=${JSON.stringify(stillA.acks ?? stillA.error)}`,
  );

  // ── 3. invariants ──────────────────────────────────────────────────────
  const all = gw.ledger();
  // A: 3 healed + 1 after B was revoked = 4. B: 1..4 = 4. No duplicates.
  const expectedRows = 4 + 4;
  check(
    'final: every ACKed mutation appears exactly once across both devices',
    all.length === new Set(all.map((m) => `${m.deviceId}:${m.seqNo}`)).size && all.length === expectedRows,
    `rows=${all.length} expected=${expectedRows}`,
  );
  check(
    'final: per-device cursors match the highest contiguous seq',
    gw.cursorOf('dev-A') === 4 && gw.cursorOf('dev-B') === 4,
    `A=${gw.cursorOf('dev-A')} B=${gw.cursorOf('dev-B')}`,
  );

  const record = {
    at: new Date().toISOString(),
    pass,
    fail,
    mode: 'sequential-instances + runner-driven gateway faults',
    instances: { A: a.result, B: b.result },
    exitCodes: { A: a.code, B: b.code },
    ledger: all.map((m) => ({ deviceId: m.deviceId, seqNo: m.seqNo })),
    cursors: { A: gw.cursorOf('dev-A'), B: gw.cursorOf('dev-B') },
    checks,
  };
  fs.writeFileSync(path.join(OUT, 'two-instance.json'), JSON.stringify(record, null, 2));
} finally {
  await gw.close();
}

console.log(`\nTWO-INSTANCE + GATEWAY FAULTS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
