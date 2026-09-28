/**
 * Same-window write serializer (promise-chain mutex).
 *
 * SQLite allows only one writer at a time; two overlapping `invoke('plugin:sql|…')`
 * batches from the same window (double-tap "Encaisser", checkout racing a sync
 * pull-apply) otherwise interleave row-by-row and can persist a half-sale
 * (order without items, ledger without the stock recompute). `withWriteLock`
 * chains those critical sections so they run one-at-a-time, in call order.
 *
 * Scope notes (read before wrapping something new):
 * - SAME WINDOW ONLY. A second tab / window / process holds its own chain, so
 *   cross-tab SQL serialization additionally relies on `BEGIN IMMEDIATE`
 *   inside each critical section: the second writer blocks on the journal lock
 *   (busy_timeout = 5000) instead of interleaving. Every section wrapped here
 *   must also run inside a SQLite transaction for that reason.
 * - NOT re-entrant. Do not nest `withWriteLock` (an inner acquisition queues
 *   behind the outer one while the outer waits for the inner = deadlock).
 *   Hold the lock at exactly ONE level per call chain: the lowest-level atomic
 *   writer (`writeCheckoutAtomic`, the refund/void SQLite sections, the sync
 *   pull-apply stock section) owns it; callers must not wrap those calls again.
 * - Never rejects itself: a failed section still releases the chain so one bad
 *   write cannot wedge every later sale.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(() => fn());
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
