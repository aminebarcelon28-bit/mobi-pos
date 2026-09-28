// Regression: SQLITE_BUSY (pool contention) must delay — never drop — a sale.
// Also: stale pooled txn (code 1 "cannot start a transaction within a
// transaction") must RETRY, not fall into a non-atomic sequential path.
import { isBusyError, isStaleTxnError, isRetryableDbError, withBusyRetry } from '../src/db/busyRetry.ts';
import { withWriteLock } from '../src/db/writeMutex.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name}`); }
};

// 1. BUSY recognition in all plugin disguises
check('code 5 numeric', isBusyError({ code: 5, message: 'x' }));
check('message database is locked', isBusyError(new Error('error returned from database: (code: 5) database is locked')));
check('SQLITE_BUSY string code', isBusyError({ code: 'SQLITE_BUSY' }));
// B-017: bare errno 5 is EIO on POSIX — only BUSY when message confirms locked.
check('bare errno 5 is not busy (B-017)', !isBusyError({ errno: 5 }));
check('errno 5 + locked message is busy', isBusyError({ errno: 5, message: 'database is locked' }));
check('plain error is not busy', !isBusyError(new Error('UNIQUE constraint failed')));
check('null is not busy', !isBusyError(null));
check('insufficient stock is not busy', !isBusyError(new Error('INSUFFICIENT_STOCK:p: ledger=0 requested=1')));

// 1b. Stale pooled-txn recognition (console 2026-09-23)
const staleNested = new Error('error returned from database: (code: 1) cannot start a transaction within a transaction');
check('stale nested BEGIN is stale-txn', isStaleTxnError(staleNested));
check('stale nested BEGIN is NOT busy', !isBusyError(staleNested));
check('stale nested BEGIN is retryable', isRetryableDbError(staleNested));
check('cannot commit no txn is stale', isStaleTxnError(new Error('(code: 1) cannot commit - no transaction is active')));
check('cannot rollback no txn is stale', isStaleTxnError({ code: 1, message: 'cannot rollback - no transaction is active' }));
check('busy is retryable via isRetryableDbError', isRetryableDbError({ code: 5, message: 'database is locked' }));
check('real error is not retryable', !isRetryableDbError(new Error('disk I/O error')));
check('stale detection: null safe', !isStaleTxnError(null));

// 2. Success first try — single call
let calls = 0;
const v = await withBusyRetry(async () => { calls++; return 'sale-ok'; }, { baseDelayMs: 1 });
check('first-try success returns value', v === 'sale-ok' && calls === 1);

// 3. Two BUSY collisions then success (the till scenario)
calls = 0;
const v2 = await withBusyRetry(
  async () => {
    calls++;
    if (calls < 3) throw { code: 5, message: 'database is locked' };
    return 'recovered';
  },
  { attempts: 6, baseDelayMs: 1, label: 'test' }
);
check('recovers after BUSY collisions', v2 === 'recovered' && calls === 3);

// 3b. Stale pooled txn then success (must retry, not throw immediately)
calls = 0;
const v2s = await withBusyRetry(
  async () => {
    calls++;
    if (calls < 3) throw staleNested;
    return 'stale-recovered';
  },
  { attempts: 6, baseDelayMs: 1, label: 'stale' }
);
check('recovers after stale pooled txn', v2s === 'stale-recovered' && calls === 3);

// 4. Non-busy error passes through immediately
calls = 0;
let threw: unknown = null;
try {
  await withBusyRetry(async () => { calls++; throw new Error('INSUFFICIENT_STOCK:x'); }, { baseDelayMs: 1 });
} catch (e) { threw = e; }
check('non-busy throws immediately', calls === 1 && threw instanceof Error && threw.message.startsWith('INSUFFICIENT_STOCK'));

// 5. Persistent BUSY exhausts attempts then throws the last error
calls = 0;
threw = null;
try {
  await withBusyRetry(async () => { calls++; throw { code: 5, message: 'database is locked' }; }, { attempts: 3, baseDelayMs: 1 });
} catch (e) { threw = e; }
check('persistent BUSY exhausts 3 attempts', calls === 3 && (threw as { code: number }).code === 5);

// 5b. Persistent stale txn exhausts attempts then throws
calls = 0;
threw = null;
try {
  await withBusyRetry(async () => { calls++; throw staleNested; }, { attempts: 3, baseDelayMs: 1 });
} catch (e) { threw = e; }
check('persistent stale txn exhausts 3 attempts', calls === 3 && isStaleTxnError(threw));

// 6. Mutex still serializes (retry wraps OUTSIDE the lock — order preserved)
const order: string[] = [];
await Promise.all([
  withBusyRetry(() => withWriteLock(async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 20)); order.push('a-end'); }), { baseDelayMs: 1 }),
  withBusyRetry(() => withWriteLock(async () => { order.push('b-start'); await new Promise((r) => setTimeout(r, 5)); order.push('b-end'); }), { baseDelayMs: 1 }),
]);
check('mutex serializes critical sections', order.join(',') === 'a-start,a-end,b-start,b-end');

// 7. onExhausted recovery works for stale txn too (FIX-3 extended)
calls = 0;
const recovered = await withBusyRetry(
  async () => { calls++; throw staleNested; },
  { attempts: 2, baseDelayMs: 1, onExhausted: () => ({ ok: true, via: 'stale-recovery' }) }
);
check('onExhausted recovers stale txn exhaustion', (recovered as { ok?: boolean })?.ok === true && calls === 2);

console.log(`BUSY-RETRY: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
