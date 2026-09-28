/**
 * SQLITE_BUSY retry for critical writers (checkout, void, refund).
 *
 * Root cause it defends against (diagnosed 2026-09-22): tauri-plugin-sql v2
 * pools SQLite connections (sqlx Pool, one per CPU-ish), so
 * - `BEGIN IMMEDIATE … COMMIT` issued as separate IPC calls can land on
 *   different pooled connections (no real transaction, possible leaked lock),
 * - `PRAGMA busy_timeout` set at boot covers only the pooled connection that
 *   happened to run it — the rest fail with SQLITE_BUSY (code 5) instantly.
 * Any lane that writes outside `withWriteLock` (sync pull-apply rows, outbox
 * flusher marks, event batches) can therefore collide with a sale in flight.
 *
 * The serializer (`withWriteLock`) keeps same-window writers single-flight;
 * THIS module converts the residual races (pool multiplexing, second window,
 * a long pull chunk) from LOST SALES into short waits: the whole critical
 * section is retried with exponential backoff + jitter. Each attempt runs the
 * full section (including its own BEGIN/ROLLBACK), so a retry never resumes
 * a half-written transaction — idempotency keys make re-execution safe.
 */

export interface BusyRetryOptions<T = unknown> {
  /** Total attempts including the first try. Default 6. */
  attempts?: number;
  /** Base backoff in ms before retry #1; doubles each time. Default 80. */
  baseDelayMs?: number;
  /** Hard cap per backoff step in ms. Default 2500. */
  maxDelayMs?: number;
  /** Label for console diagnostics. Default 'db-write'. */
  label?: string;
  /**
   * B-001 FIX-3: fired on the FINAL BUSY failure only. May RETURN a value of
   * type T to recover (suppress the throw) — e.g. fall back to Dexie or a
   * soft-success path. Returning `undefined`/`void` (or throwing) preserves the
   * historical "exhausted → rethrow" behavior. NoInfer keeps a void diagnostic
   * hook from polluting T at the call site.
   */
  onExhausted?: (
    error: unknown,
    attempts: number,
  ) => NoInfer<T> | void | Promise<NoInfer<T> | void>;
}

/** True for SQLITE_BUSY in all its plugin/Node disguises. */
export function isBusyError(error: unknown): boolean {
  if (!error) return false;
  const anyErr = error as Record<string, unknown>;
  // tauri-plugin-sql surfaces { code: 5, message: '... database is locked' }
  // node:sqlite/better-sqlite3 use numeric .code too.
  // B-017: do NOT treat bare `errno === 5` as BUSY — on POSIX errno 5 is
  // EIO (real disk failure). Only trust errno when the message confirms BUSY.
  if (anyErr.code === 5 || anyErr.code === 'SQLITE_BUSY') return true;
  const msg = String(
    (anyErr.message as string | undefined) ??
      (anyErr.error as string | undefined) ??
      error,
  ).toLowerCase();
  if (msg.includes('database is locked') || msg.includes('sqlite_busy')) return true;
  return anyErr.errno === 5 && msg.includes('locked');
}

/**
 * True when BEGIN/COMMIT/ROLLBACK hit a STALE transaction left on a pooled
 * connection (tauri-plugin-sql sqlx Pool has no session pinning: a prior
 * BEGIN may have landed on conn A while its COMMIT/ROLLBACK landed on conn B,
 * so conn A keeps an abandoned write txn forever).
 *
 * SQLite reports these as code 1 (SQLITE_ERROR), NOT code 5 — so
 * `isBusyError` misses them and callers used to fall into the non-atomic
 * sequential path while the stale txn still held locks (poisons later
 * checkouts that reuse the connection: "database is locked" cascade).
 *
 * Verified in production console 2026-09-23:
 *   `(code: 1) cannot start a transaction within a transaction`
 */
export function isStaleTxnError(error: unknown): boolean {
  if (!error) return false;
  const anyErr = error as Record<string, unknown>;
  const msg = String(
    (anyErr.message as string | undefined) ??
      (anyErr.error as string | undefined) ??
      error,
  ).toLowerCase();
  return (
    msg.includes('cannot start a transaction within a transaction') ||
    msg.includes('cannot commit - no transaction is active') ||
    msg.includes('cannot rollback - no transaction is active') ||
    msg.includes('sqlstate 25001') || // SQLite driver nested/active-txn SQLSTATE
    (anyErr.code === 1 &&
      (msg.includes('transaction within a transaction') ||
        msg.includes('no transaction is active')))
  );
}

/**
 * Transient DB-state errors that must RETRY the whole critical section, never
 * degrade to a non-atomic fallback or a swallowed `.catch(() => [])`.
 * = SQLITE_BUSY (pool lock) ∪ stale pooled transaction (code 1).
 */
export function isRetryableDbError(error: unknown): boolean {
  return isBusyError(error) || isStaleTxnError(error);
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withBusyRetry<T>(fn: () => Promise<T>, opts: BusyRetryOptions<T> = {}): Promise<T> {
  const attempts = Math.max(1, Math.min(12, Math.round(opts.attempts ?? 8)));
  const baseDelayMs = Math.max(10, opts.baseDelayMs ?? 120);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 3000);
  const label = opts.label || 'db-write';

  let lastError: unknown = null;
  let exhausted: BusyRetryOptions<T>['onExhausted'] | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // B-063: keep an active checkout flight's heartbeat fresh while this
    // retry loop is still working — otherwise the idle watchdog force-releases
    // mid-retry and a second busy-retry:checkout starts on the same pool.
    try {
      const { renewCheckoutFlight } = await import('./checkoutFlight');
      renewCheckoutFlight();
    } catch { /* heartbeat is best-effort */ }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Retry BOTH BUSY (code 5) and stale pooled-txn (code 1) — see
      // isStaleTxnError: missing the latter silently disabled atomic checkout.
      if (!isRetryableDbError(error) || attempt >= attempts) break;
      // Exponential backoff with ±25% jitter so two racing lanes de-sync.
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = backoff * (0.75 + Math.random() * 0.5);
      const kind = isBusyError(error) ? 'SQLITE_BUSY' : 'STALE_TXN';
      console.warn(
        `[busy-retry:${label}] attempt ${attempt}/${attempts} hit ${kind} — retrying in ${Math.round(jitter)}ms`
      );
      await sleep(jitter);
    }
  }
  // B-001 FIX-3: onExhausted may return a recovery value of type T.
  // Only retryable DB errors reach here after the loop break (real errors
  // break with the same throw path below). A returned non-undefined value
  // suppresses the throw so callers can soft-fallback instead of losing the sale.
  exhausted = opts.onExhausted;
  if (exhausted && isRetryableDbError(lastError)) {
    try {
      const recovered = await exhausted(lastError, attempts);
      if (recovered !== undefined) return recovered as T;
    } catch {
      // Diagnostics must never break the error path — fall through to throw.
    }
  }
  throw lastError;
}
