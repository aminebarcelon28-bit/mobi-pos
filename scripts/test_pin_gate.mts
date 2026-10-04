/**
 * Phase 1 gate-cutover tests: the single routing module.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_pin_gate.mts
 *
 * Contract (same native counter as the lock screen):
 * - wrong PIN burns the NATIVE counter (pinVerify called, userId pinned)
 * - success resets and passes mustRotate through; Locked never records
 *   locally and carries the native countdown; native-down denies with no
 *   fallback; bad lengths never reach IPC; user gates use the exact userId
 *   (no silent manager override); weak fallback is explicit + flagged.
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failures += 1;
    console.error(`  [FAIL] ${name} ${extra}`);
  }
}

(globalThis as any).window = { __TAURI_INTERNALS__: {} };

const gate = (await import('../src/utils/pinGate.ts')) as typeof import('../src/utils/pinGate.ts');
const { verifyManagerGate, verifyUserGate, minPinLengthForGateRole } = gate;

const MANAGER_PIN = '123456';
const nativeOk = (pin: string) => async (req: { userId: string; pin: string }) => ({
  ok: req.userId === 'manager' && req.pin === pin,
  locked: false,
  lockedRemainingMs: 0,
  mustRotate: true,
  kdfUnavailable: true,
});

// ── 1. Wrong PIN burns the native counter (same userId as lock screen) ──
{
  const seen: Array<{ userId: string; pin: string }> = [];
  const res = await verifyManagerGate('000000', {
    pinVerifyFn: (async (req: any) => {
      seen.push(req);
      return { ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, kdfUnavailable: true };
    }) as any,
  });
  check('wrong PIN denied', res.ok === false && res.locked === false);
  check('native counter burned exactly once, userId manager', seen.length === 1 && seen[0].userId === 'manager', JSON.stringify(seen));
}

// ── 2. Cashier PIN never passes the manager gate ──
{
  const res = await verifyManagerGate('1111', { pinVerifyFn: nativeOk(MANAGER_PIN) as any });
  check('cashier PIN rejected by manager gate', res.ok === false);
  const ok = await verifyManagerGate(MANAGER_PIN, { pinVerifyFn: nativeOk(MANAGER_PIN) as any });
  check('manager PIN passes, mustRotate passes through', ok.ok === true && ok.mustRotate === true && ok.weaker === false);
}

// ── 3. Locked ≠ wrong: countdown surfaces, nothing recorded locally ──
{
  let nativeCalls = 0;
  const res = await verifyManagerGate(MANAGER_PIN, {
    pinVerifyFn: (async () => {
      nativeCalls += 1;
      return { ok: false, locked: true, lockedRemainingMs: 47_000, mustRotate: false, kdfUnavailable: true };
    }) as any,
  });
  check('locked maps with native countdown', res.ok === false && res.locked === true && res.remainingMs === 47_000);
  check('locked burns no extra attempt', nativeCalls === 1);
}

// ── 3b. Locked never touches the local counter (denied does) ──
// ── 3b. Locked never touches the local counter (denied does) ──
{
  const writes: string[] = [];
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: (k: string, _v: string) => {
      writes.push(k);
    },
    removeItem: () => {},
  };
  const lockedRes = await verifyManagerGate(MANAGER_PIN, {
    pinVerifyFn: (async () => ({ ok: false, locked: true, lockedRemainingMs: 47_000, mustRotate: false, weaker: false })) as any,
  });
  // Locked responses must not touch the local lockout counter (the burst
  // path may still generate the device id — that is not lockout state).
  const lockoutWrites = (keys: string[]) => keys.filter((k) => k.includes('lockout'));
  check('locked records nothing locally', lockedRes.locked === true && lockoutWrites(writes).length === 0, writes.join(','));
  const deniedRes = await verifyManagerGate('000000', {
    pinVerifyFn: (async () => ({ ok: false, locked: false, lockedRemainingMs: 0, mustRotate: false, weaker: false })) as any,
  });
  check('denied records locally (outer pacing)', deniedRes.ok === false && lockoutWrites(writes).length > 0, writes.join(','));
  delete (globalThis as any).localStorage;
}

// ── 4. Native down denies, no fallback ──
{
  let localUsed = false;
  const res = await verifyManagerGate(MANAGER_PIN, {
    pinVerifyFn: (async () => {
      throw new Error('ipc down');
    }) as any,
    localVerifyFn: () => {
      localUsed = true;
      return true;
    },
  });
  check('transport failure fails closed', res.ok === false && (res as any).reason === 'unavailable');
  check('no local fallback on the native path', localUsed === false);
}

// ── 5. Bad lengths never reach IPC ──
{
  for (const bad of ['', '12', 'abc', '1'.repeat(33)]) {
    let called = false;
    const res = await verifyManagerGate(bad, {
      pinVerifyFn: (async () => {
        called = true;
        return { ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, kdfUnavailable: true };
      }) as any,
    });
    check(`bad length rejected without IPC (${JSON.stringify(bad).slice(0, 12)})`, res.ok === false && called === false);
  }
}

// ── 6. User gates use the exact userId (no silent override) ──
{
  const seen: string[] = [];
  const res = await verifyUserGate('c1', '1111', {
    pinVerifyFn: (async (req: any) => {
      seen.push(req.userId);
      return { ok: true, locked: false, lockedRemainingMs: 0, mustRotate: false, kdfUnavailable: true };
    }) as any,
  });
  check('user gate verifies the exact profile', res.ok === true && seen.join() === 'c1', seen.join());
  const empty = await verifyUserGate('', '1111', { pinVerifyFn: (async () => ({})) as any });
  check('empty userId refused', empty.ok === false);
}

// ── 7. Weak fallback is explicit, flagged, outside-Tauri only ──
{
  (globalThis as any).window = {};
  const weak = await verifyManagerGate('123456', { allowWeakFallback: true, localVerifyFn: () => true });
  check('explicit weak fallback flagged', weak.ok === true && weak.weaker === true);
  const closed = await verifyManagerGate('123456', { localVerifyFn: () => true });
  check('missing kernel fails closed without the flag', closed.ok === false);
  (globalThis as any).window = { __TAURI_INTERNALS__: {} };
}

// ── 10. GATE_DENIED_BURST cadence + fields + privacy ──
{
  const { shouldEmitDenialBurst, recordGateDenial, resetDenialBursts, GATE_DENIED_BURST_ACTION } =
    (await import('../src/utils/gateDenials.ts')) as typeof import('../src/utils/gateDenials.ts');
  check('burst action name pinned', GATE_DENIED_BURST_ACTION === 'GATE_DENIED_BURST');
  resetDenialBursts();
  const t0 = 1_800_000_000_000;
  const sig = (locked = false) => ({ gateName: 'manager_pin', userId: 'manager', locked, lockoutDurationMs: locked ? 60_000 : 0 });
  const first = shouldEmitDenialBurst(sig(), t0);
  check('1st denial emits', first.emit === true && first.count === 1 && first.windowStart === t0);
  let silent = true;
  for (let i = 2; i <= 4; i++) {
    const r = shouldEmitDenialBurst(sig(), t0 + i * 1000);
    silent = silent && !r.emit && r.count === i;
  }
  check('2nd–4th denials silent with running count', silent);
  const fifth = shouldEmitDenialBurst(sig(), t0 + 5000);
  check('5th denial emits', fifth.emit === true && fifth.count === 5);
  const tenth = [6, 7, 8, 9].map((i) => shouldEmitDenialBurst(sig(), t0 + i * 1000));
  check('6th–9th silent', tenth.every((r) => !r.emit));
  check('10th emits', shouldEmitDenialBurst(sig(), t0 + 10_000).emit === true);
  // Rolling window: after 5 minutes the count restarts.
  const after = shouldEmitDenialBurst(sig(), t0 + 5 * 60 * 1000 + 1);
  check('window rolls (count restarts, emits as 1st)', after.emit === true && after.count === 1 && after.windowStart === t0 + 5 * 60 * 1000 + 1);
  // LOCKED emits immediately even mid-window.
  resetDenialBursts();
  shouldEmitDenialBurst(sig(), t0);
  const locked = shouldEmitDenialBurst(sig(true), t0 + 2000);
  check('LOCKED emits immediately with flag', locked.emit === true && locked.lockoutTriggered === true);
  // Per (gate, user) isolation.
  resetDenialBursts();
  shouldEmitDenialBurst(sig(), t0);
  const other = shouldEmitDenialBurst({ gateName: 'user_pin:c1', userId: 'c1', locked: false, lockoutDurationMs: 0 }, t0);
  check('windows isolated per gate+user', other.emit === true && other.count === 1);
  // Emission shape: exact fields, zero PIN material.
  resetDenialBursts();
  const rows: Array<{ action: string; details: string }> = [];
  recordGateDenial(
    (action, details) => {
      rows.push({ action, details });
    },
    { gateName: 'manager_pin', userId: 'manager', locked: true, lockoutDurationMs: 47_000 },
    t0
  );
  check('burst row emitted', rows.length === 1 && rows[0].action === 'GATE_DENIED_BURST');
  const payload = JSON.parse(rows[0].details);
  check(
    'payload carries exactly the specified fields',
    payload.gate_name === 'manager_pin' &&
      payload.user_id === 'manager' &&
      payload.denial_count === 1 &&
      payload.lockout_triggered === true &&
      payload.lockout_duration_ms === 47000 &&
      payload.window_start_epoch === t0 &&
      Object.keys(payload).length === 6,
    rows[0].details
  );
  // Privacy: no value may be a PIN-shaped digit string (lengths are never
  // recorded either). Key names are fixed by the previous assertion.
  const values = Object.values(payload) as unknown[];
  check(
    'no PIN material anywhere (no digit strings, no lengths, no patterns)',
    values.every((v) => typeof v !== 'string' || !/^\d{4,}$/.test(v)) &&
      !('pin' in payload) &&
      !('length' in payload) &&
      !('pattern' in payload) &&
      !('digits' in payload),
    rows[0].details
  );
  // Emitter failure never propagates.
  let threw = false;
  try {
    recordGateDenial(
      () => {
        throw new Error('sink down');
      },
      sig(),
      t0
    );
  } catch {
    threw = true;
  }
  check('sink failure never throws', threw === false);
}

// ── 8. UI copy minimums ──
{
  check('manager copy minimum is 6', minPinLengthForGateRole('manager') === 6);
  check('cashier copy minimum is 4', minPinLengthForGateRole('cashier') === 4);
}

// ── 9. Call-site routing (static pin; behavior is the contract above) ──
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const routed = [
    'src/components/ui/PinDialog.tsx',
    'src/components/CartPanel.tsx',
    'src/components/modals/DiscountModal.tsx',
    'src/components/modals/RefundModal.tsx',
    'src/components/modals/DebtLedgerModal.tsx',
    'src/components/mobile/tabs/MobileCheckoutTab.tsx',
    'src/components/modals/ReportsModal.tsx',
    'src/components/modals/ShiftCloseModal.tsx',
    'src/components/modals/SettingsModal.tsx',
    'src/store/slices/createCustomerSlice.ts',
    'src/db/adapters/shiftAdapter.ts',
  ];
  for (const f of routed) {
    const src = strip(readFileSync(join(ROOT, f), 'utf8'));
    check(`${f} routes via pinGate`, src.includes('verifyManagerGate') || src.includes('verifyUserGate'));
  }
  const shift = strip(readFileSync(join(ROOT, 'src/db/adapters/shiftAdapter.ts'), 'utf8'));
  check('variance gate has no local hash path left', !shift.includes('verifyPin(') && !shift.includes('manager_pin'));
}

console.log('');
if (failures === 0) console.log('RESULT: pin gate intact.');
else {
  console.error(`RESULT: ${failures} FAILURE(S)`);
  process.exit(1);
}
