/**
 * IPC/concurrency guardrails (B4: IPC-006/007/008/015) — tests for
 * src/db/writeMutex.ts, src/db/busyRetry.ts and src/db/checkoutFlight.ts.
 * All three modules are dependency-free and node-safe.
 *
 * Proves: lock waiters time out loudly (never wedge forever); timed-out
 * sections never run later (poison-once, no duplicates); release is
 * owner-scoped; renew requires an owner (pull lanes can no longer keep a
 * sale flight alive); retry bounds and error taxonomy hold.
 */
import {
  LockTimeoutError,
  WRITE_LOCK_TIMEOUT_MS,
  withTimeout,
  withWriteLock,
} from '../src/db/writeMutex.ts';
import {
  BeginUnavailableError,
  isBusyError,
  withBusyRetry,
} from '../src/db/busyRetry.ts';
import {
  CHECKOUT_FLIGHT_TIMEOUT_MS,
  isCheckoutFlightActive,
  releaseCheckoutFlight,
  renewCheckoutFlight,
  tryAcquireCheckoutFlight,
} from '../src/db/checkoutFlight.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  // 1. Lock waiter times out loudly instead of wedging forever.
  {
    const holder = withWriteLock(async () => { await sleep(400); return 'held'; });
    let err: unknown = null;
    try {
      await withWriteLock(async () => 'waiter', { timeoutMs: 60, label: 'test' });
    } catch (e) { err = e; }
    check('waiter rejects after timeoutMs', err instanceof LockTimeoutError, String(err));
    check('LockTimeoutError carries code', (err as LockTimeoutError)?.code === 'DB_LOCK_TIMEOUT');
    await holder;
  }

  // 2. Poison-once: the timed-out section never executes when its turn comes.
  {
    let ran = false;
    const holder = withWriteLock(async () => { await sleep(250); return 1; });
    await withWriteLock(async () => { ran = true; }, { timeoutMs: 40 }).catch(() => {});
    await holder;
    // Chain must still work for the next waiter (no wedge, no skip-all).
    const after = await withWriteLock(async () => 'next', { timeoutMs: 2000 });
    check('timed-out section never runs later', ran === false);
    check('chain survives a timeout', after === 'next');
  }

  // 3. timeoutMs <= 0 preserves legacy infinite wait (opt-out, explicit).
  {
    const holder = withWriteLock(async () => { await sleep(120); return 1; });
    const v = await withWriteLock(async () => 'infinite', { timeoutMs: 0 });
    await holder;
    check('timeoutMs 0 waits indefinitely', v === 'infinite');
  }
  check('default timeout is minutes-scale', WRITE_LOCK_TIMEOUT_MS >= 60_000, `${WRITE_LOCK_TIMEOUT_MS}ms`);

  // 4. withTimeout helper bounds arbitrary promises.
  {
    check('fast promise passes through', (await withTimeout(Promise.resolve(7), 500)) === 7);
    let err: unknown = null;
    try {
      await withTimeout(new Promise(() => {}), 40, 'hang-test');
    } catch (e) { err = e; }
    check('hung promise rejects with label', err instanceof Error && /hang-test/.test(err.message));
    check('non-positive budget disables', (await withTimeout(Promise.resolve(1), 0)) === 1);
  }

  // 5. Flight acquire/release is owner-scoped.
  try {
    check('acquire succeeds when free', tryAcquireCheckoutFlight('A') === true);
    check('second acquire refused', tryAcquireCheckoutFlight('B') === false);
    check('active + owner visible', isCheckoutFlightActive() === true);
    releaseCheckoutFlight('B');
    check('stale-owner release is a no-op', isCheckoutFlightActive() === true);
    renewCheckoutFlight();
    renewCheckoutFlight('B');
    check('anonymous/wrong-owner renew is a no-op (no throw, no state change)', isCheckoutFlightActive() === true);
    releaseCheckoutFlight('A');
    check('owner release frees', isCheckoutFlightActive() === false);
    check('watchdog window is a minute', CHECKOUT_FLIGHT_TIMEOUT_MS === 60_000);
  } finally {
    releaseCheckoutFlight();
  }

  // 6. Retry bounds + taxonomy.
  {
    let calls = 0;
    try {
      await withBusyRetry(async () => { calls += 1; throw new Error('SQLITE_BUSY: database is locked'); }, { attempts: 3, baseDelayMs: 10, label: 't' });
    } catch { /* expected */ }
    check('attempts bound honored', calls === 3, `calls=${calls}`);
    check('isBusyError recognizes code 5', isBusyError({ code: 5 }));
    check('isBusyError recognizes message', isBusyError(new Error('database is locked')));
    const beginErr = new BeginUnavailableError('test-label', new Error('no such module'));
    check('BeginUnavailableError carries code + label',
      beginErr instanceof Error && beginErr.code === 'DB_BEGIN_UNAVAILABLE' && /test-label/.test(beginErr.message));
  }

  console.log(`\nipc-guards: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); try { releaseCheckoutFlight(); } catch { /* noop */ } process.exit(1); });
