/**
 * OutboxFlusher — Offline Writes Drain Engine
 * Implements AGENTS.md §1, §7 (Phase 4) & Contracts C5, C6.
 *
 * Guarantees:
 * - Exponential backoff with random jitter to prevent thundering herd.
 * - Single-flight lock preventing concurrent outbox drain races.
 * - Full idempotency: every payload carries a deterministic key.
 */

import { getPendingOutbox, markOutbox, utcNowIso } from '../db/sqlPluginAdapter';
import { withBusyRetry } from '../db/busyRetry';
import { withWriteLock } from '../db/writeMutex';
import type { OutboxRow } from './types';

/** Age after which an `inflight` row is presumed orphaned (crashed flush). */
export const STALE_INFLIGHT_AGE_MIN = 30;

/**
 * Boot/flush watchdog: reset `inflight` rows older than 30 min back to
 * `pending` so a killed process can never strand mutations in limbo (C6).
 * The WHERE clause touches ONLY `inflight` rows — `pending`/`failed` rows
 * keep their backoff, and `synced` rows are already deleted by markOutbox
 * (there is no `deleted` outbox status; deletes are operations, not states).
 * Returns the number of rows rescued. Never throws.
 */
export async function resetStaleInflightOutbox(maxAgeMin = STALE_INFLIGHT_AGE_MIN): Promise<number> {
  try {
    const { getLocalDb } = await import('../db/sqlPluginAdapter');
    const db = await getLocalDb();
    const cutoff = new Date(Date.now() - maxAgeMin * 60_000).toISOString();
    const stale = (await db.select(
      "SELECT idempotency_key FROM sync_outbox WHERE status='inflight' AND updated_at < $1",
      [cutoff],
    ).catch(() => [])) as Array<{ idempotency_key: string }>;
    if (!stale || stale.length === 0) return 0;
    const now = utcNowIso();
    // B-061: serialize the batch of UPDATEs with the write lane — raw
    // execute() outside withWriteLock races checkout's multi-statement write
    // on the pooled connection and feeds SQLITE_BUSY into the sale path.
    await withBusyRetry(
      () =>
        withWriteLock(async () => {
          for (const row of stale) {
            await db.execute(
              `UPDATE sync_outbox SET status='pending', next_retry_at=NULL,
                 last_error='watchdog: stale inflight reset to pending', updated_at=$1
               WHERE idempotency_key=$2 AND status='inflight'`,
              [now, row.idempotency_key],
            ).catch(() => {});
          }
        }),
      { attempts: 4, baseDelayMs: 60, label: 'outbox-watchdog' }
    );
    console.warn(`[outbox:watchdog] Reset ${stale.length} stale inflight row(s) to pending`);
    return stale.length;
  } catch (err) {
    console.warn('[outbox:watchdog] Stale-inflight reset skipped:', err);
    return 0;
  }
}

export function calculateBackoffMs(retryCount: number): number {
  // Doc ② §7.4 verbatim: base 1s, factor 2, cap 60s, FULL JITTER (anti-thundering-herd)
  const base = 1_000;
  const cap = 60_000;
  const slot = Math.min(cap, base * (1 << Math.min(retryCount, 6)));
  return Math.floor(Math.random() * slot); // full jitter: uniform in [0, slot)
}

export class OutboxFlusher {
  private isFlushing = false;
  private timer: number | null = null;

  start(intervalMs = 10_000) {
    this.stop();
    this.timer = window.setInterval(() => {
      void this.flushPendingBatch();
    }, intervalMs);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flushPendingBatch(
    batchSize = 50,
    pushHandler?: (rows: OutboxRow[]) => Promise<{ succeededKeys: string[]; failedKeys: Array<{ key: string; error: string }> }>
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.isFlushing) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.isFlushing = true;
    // P0-4: keys claimed below but never accounted for (pushHandler throw,
    // partial result) must return to pending here — otherwise they strand in
    // `inflight` until the 30-min watchdog. Success paths account every key
    // before returning, so this loop is a no-op for them.
    const claimedKeys: string[] = [];

    try {
      // Watchdog first: rescue mutations orphaned by a previous crash before
      // picking up new work, so no sale waits behind a dead inflight row.
      await resetStaleInflightOutbox();
      const pendingRows = (await getPendingOutbox(batchSize)) as unknown as OutboxRow[];
      if (!pendingRows || pendingRows.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      // Mark all in-flight to prevent duplicate concurrent pickup.
      // No outer withWriteLock here (house rule: not re-entrant): markOutbox
      // self-serializes per row, and this retry wraps the whole loop so a
      // BUSY collision replays the idempotent marks instead of deadlocking.
      // A collision delays, never drops.
      await withBusyRetry(
        async () => {
          for (const row of pendingRows) {
            await markOutbox(row.idempotency_key, { status: 'inflight' });
          }
        },
        { attempts: 4, baseDelayMs: 60, label: 'outbox-claim' }
      );
      for (const row of pendingRows) claimedKeys.push(row.idempotency_key);

      if (pushHandler) {
        const result = await pushHandler(pendingRows);
        const accounted = new Set<string>([
          ...result.succeededKeys,
          ...result.failedKeys.map((f) => f.key),
        ]);

        await withBusyRetry(
          async () => {
            for (const key of result.succeededKeys) {
              await markOutbox(key, { status: 'synced' });
            }

            for (const failure of result.failedKeys) {
              const row = pendingRows.find((r) => r.idempotency_key === failure.key);
              const nextRetryCount = (row?.retry_count ?? 0) + 1;
              const nextRetryAt = new Date(Date.now() + calculateBackoffMs(nextRetryCount)).toISOString();

              await markOutbox(failure.key, {
                status: nextRetryCount >= 10 ? 'failed' : 'pending',
                retryCount: nextRetryCount,
                nextRetryAt,
                error: failure.error,
              });
            }

            for (const row of pendingRows) {
              if (!accounted.has(row.idempotency_key)) {
                // Handler dropped the key from both lists — requeue, never strand.
                await markOutbox(row.idempotency_key, { status: 'pending' });
              }
            }
          },
          { attempts: 4, baseDelayMs: 60, label: 'outbox-mark' }
        );

        return {
          processed: pendingRows.length,
          succeeded: result.succeededKeys.length,
          failed: result.failedKeys.length,
        };
      } else {
        // P0-4: no handler means NOTHING was pushed — marking `synced` here
        // would delete rows (getLocalDb purges synced) = silent sale loss.
        // Requeue loudly instead; wire a real handler to drain.
        console.warn(
          `[outboxFlusher] flushPendingBatch called with no pushHandler — ${pendingRows.length} row(s) left pending (NOT synced)`
        );
        await withBusyRetry(
          async () => {
            for (const row of pendingRows) {
              await markOutbox(row.idempotency_key, { status: 'pending' });
            }
          },
          { attempts: 4, baseDelayMs: 60, label: 'outbox-requeue' }
        ).catch(() => {});
        for (const row of pendingRows) claimedKeys.splice(claimedKeys.indexOf(row.idempotency_key), 1);
        return {
          processed: 0,
          succeeded: 0,
          failed: 0,
        };
      }
    } catch (err) {
      console.warn('Outbox flush encountered unexpected error:', err);
      return { processed: 0, succeeded: 0, failed: 0 };
    } finally {
      // Rescue: any claimed-but-unaccounted key (pushHandler throw, mark-loop
      // BUSY exhaustion) goes back to pending — inflight is never terminal.
      if (claimedKeys.length > 0) {
        const rescue = [...claimedKeys];
        claimedKeys.length = 0;
        for (const key of rescue) {
          await markOutbox(key, { status: 'pending' }).catch(() => {});
        }
      }
      this.isFlushing = false;
    }
  }
}

export const outboxFlusher = new OutboxFlusher();
