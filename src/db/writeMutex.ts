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
/**
 * Thrown when a section waits longer than `timeoutMs` to ENTER the lock.
 * Fail-fast, not fail-silent: callers surface it like any write failure
 * (recovery intents + idempotency keys cover the unrun sale on retry/boot).
 * Deliberately NOT retried by withBusyRetry: re-queueing behind a hung
 * holder multiplies the wait instead of bounding it.
 */
export class LockTimeoutError extends Error {
  readonly code = 'DB_LOCK_TIMEOUT';
  constructor(label: string, timeoutMs: number) {
    super(`[${label}] timed out waiting ${timeoutMs}ms for the write lock (holder may be hung)`);
    this.name = 'LockTimeoutError';
  }
}

/** Bound a waiter spends queued before failing loudly. Default 120 s. */
export const WRITE_LOCK_TIMEOUT_MS = 120_000;

export interface WriteLockOptions {
  /** Queue-wait budget in ms. Fails with LockTimeoutError when exceeded. `0` (or negative) = wait forever (legacy). */
  timeoutMs?: number;
  /** Label for diagnostics. Default 'db-write'. */
  label?: string;
}

let tail: Promise<unknown> = Promise.resolve();

export function withWriteLock<T>(fn: () => Promise<T>, opts?: WriteLockOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? WRITE_LOCK_TIMEOUT_MS;
  const label = opts?.label ?? 'db-write';
  const prev = tail;
  let releaseTail!: () => void;
  tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let halfTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimers = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (halfTimer !== null) {
      clearTimeout(halfTimer);
      halfTimer = null;
    }
  };
  return new Promise<T>((resolve, reject) => {
    if (timeoutMs > 0) {
      halfTimer = setTimeout(() => {
        console.warn(
          `[writeMutex:${label}] waiting ${Math.round(timeoutMs / 2)}ms for the write lock — holder may be hung`,
        );
      }, Math.floor(timeoutMs / 2));
      // unref best-effort: never keep a process alive over a diagnostic timer.
      (halfTimer as unknown as { unref?: () => void }).unref?.();
      // NOTE: this timer stays referenced on purpose. It is the mechanism
      // delivering the rejection — unref-ing it would let an idle event
      // loop exit (or hang silently) instead of failing loudly. Only the
      // diagnostic half-timer above is unref'd.
      timer = setTimeout(() => {
        timedOut = true;
        clearTimers();
        reject(new LockTimeoutError(label, timeoutMs));
        // The chain continues below: when our turn arrives the section is
        // SKIPPED (poison-once) so a hung holder cannot cause a duplicate
        // execution later. Recovery intents + idempotency keys cover the
        // unrun sale on retry/boot.
      }, timeoutMs);
    }
    void prev.then(() => {
      if (timedOut) {
        releaseTail();
        return;
      }
      clearTimers();
      fn().then(
        (value) => {
          releaseTail();
          resolve(value);
        },
        (err) => {
          releaseTail();
          reject(err);
        },
      );
    });
  });
}

/**
 * Bounds any promise in time. Rejects with `onTimeout()` (default generic
 * Error) when `ms` elapses first; `0`/negative disables. For per-call IPC
 * budgets on lanes that cannot hang forever (see IPC-015 residual).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'op'): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    // Referenced on purpose (see above): an unref'd budget timer would let
    // an idle loop exit instead of delivering the timeout.
    const timer = setTimeout(() => {
      reject(new Error(`[${label}] timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
