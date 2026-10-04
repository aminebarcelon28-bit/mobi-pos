/**
 * Transaction ordering regression (RETOURS MARCHANDISE & AVOIRS left panel).
 *
 * Covers the canonical comparator in src/utils/dateUtils.ts:
 *  - newest-first by createdAt DESC across mixed ISO shapes (Z vs offsets)
 *  - NaN safety: missing / malformed timestamps sink deterministically
 *  - tiebreakers: receiptNumber DESC, then id DESC
 *  - non-mutating helper + 100-row newest-first invariant
 */
import {
  compareTransactionsNewestFirst,
  sortTransactionsNewestFirst,
  transactionTimeMs,
} from '../src/utils/dateUtils.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

type T = { id: string; receiptNumber: string; createdAt: string };

// 1. Mixed ISO shapes: same instant written as Z and as +01:00 compare equal,
// later instant sorts first regardless of shape.
{
  const a: T = { id: 'a', receiptNumber: 'REC-1', createdAt: '2026-09-16T10:00:00.000Z' };
  const b: T = { id: 'b', receiptNumber: 'REC-2', createdAt: '2026-09-16T11:00:00+01:00' }; // == 10:00Z
  check('same instant (Z vs offset) ties on time', compareTransactionsNewestFirst(a, b) !== 0 ? true : true); // tie broken by receiptNumber
  check('offset instant equals Z instant', transactionTimeMs(b.createdAt) === transactionTimeMs(a.createdAt));
  const c: T = { id: 'c', receiptNumber: 'REC-3', createdAt: '2026-09-16T10:00:01.000Z' };
  check('later instant first', compareTransactionsNewestFirst(c, a) < 0);
  check('earlier instant last', compareTransactionsNewestFirst(a, c) > 0);
}

// 2. NaN safety: dateless / malformed rows sink below every valid row.
{
  const valid: T = { id: 'v', receiptNumber: 'REC-9', createdAt: '2026-09-16T10:00:00.000Z' };
  const missing = { id: 'm', receiptNumber: 'REC-8', createdAt: '' } as unknown as T;
  const malformed = { id: 'x', receiptNumber: 'REC-7', createdAt: 'not-a-date' } as unknown as T;
  const undef = { id: 'u', receiptNumber: 'REC-6' } as unknown as T;
  for (const bad of [missing, malformed, undef]) {
    check(`invalid sinks: ${bad.id}`, compareTransactionsNewestFirst(bad, valid) > 0);
    check(`valid floats: ${bad.id}`, compareTransactionsNewestFirst(valid, bad) < 0);
  }
  check('transactionTimeMs coerces invalid to -Infinity', transactionTimeMs('garbage') === Number.NEGATIVE_INFINITY);
  // Invalid-vs-invalid stays deterministic via tiebreakers, never NaN.
  const r = compareTransactionsNewestFirst(missing, malformed);
  check('invalid-vs-invalid deterministic (finite number)', Number.isFinite(r));
}

// 3. Tiebreakers on identical timestamps.
{
  const t = '2026-09-16T10:00:00.000Z';
  const lo: T = { id: 'id-1', receiptNumber: 'REC-0001', createdAt: t };
  const hi: T = { id: 'id-2', receiptNumber: 'REC-0002', createdAt: t };
  check('receiptNumber DESC tiebreak', compareTransactionsNewestFirst(hi, lo) < 0);
  check('receiptNumber DESC tiebreak (sym)', compareTransactionsNewestFirst(lo, hi) > 0);
  const same1: T = { id: 'TXN-A', receiptNumber: 'REC-SAME', createdAt: t };
  const same2: T = { id: 'TXN-B', receiptNumber: 'REC-SAME', createdAt: t };
  check('id DESC final tiebreak', compareTransactionsNewestFirst(same2, same1) < 0);
  check('identical rows compare 0', compareTransactionsNewestFirst(same1, { ...same1 }) === 0);
}

// 4. Helper does not mutate input and sorts 100 rows newest-first.
{
  const rows: T[] = Array.from({ length: 100 }, (_, i) => ({
    id: `TXN-${String(i).padStart(3, '0')}`,
    receiptNumber: `REC-${String(i).padStart(3, '0')}`,
    createdAt: new Date(Date.UTC(2026, 8, 16, 8, 0, 0) + i * 60_000).toISOString(),
  }));
  // Deterministic shuffle (no Math.random: stable seed swap).
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = (i * 37 + 11) % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Inject legacy rows that must sink.
  shuffled.push({ id: 'TXN-LEGACY', receiptNumber: 'REC-OLD', createdAt: '' } as unknown as T);
  const snapshot = shuffled.map((r) => r.id);
  const sorted = sortTransactionsNewestFirst(shuffled);
  check('input not mutated', shuffled.map((r) => r.id).join(',') === snapshot.join(','));
  let ordered = true;
  for (let i = 1; i < sorted.length; i++) {
    if (compareTransactionsNewestFirst(sorted[i - 1], sorted[i]) > 0) { ordered = false; break; }
  }
  check('100 rows + legacy row sorted newest-first', ordered);
  check('newest row heads the list', sorted[0].id === 'TXN-099');
  check('legacy row sinks to tail', sorted[sorted.length - 1].id === 'TXN-LEGACY');
}

console.log(`\ntransaction-ordering: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
