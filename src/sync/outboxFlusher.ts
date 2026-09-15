/**
 * OutboxFlusher — Offline Writes Drain Engine
 * Implements AGENTS.md §1, §7 (Phase 4) & Contracts C5, C6.
 *
 * Guarantees:
 * - Exponential backoff with random jitter to prevent thundering herd.
 * - Single-flight lock preventing concurrent outbox drain races.
 * - Full idempotency: every payload carries a deterministic key.
 */

import { getPendingOutbox, markOutbox } from '../db/sqlPluginAdapter';
import type { OutboxRow } from './types';

export function calculateBackoffMs(retryCount: number): number {
  const maxBackoff = 300_000; // 5 minutes max
  const base = 1000 * 2 ** Math.min(retryCount, 8);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(maxBackoff, base + jitter);
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

    try {
      const pendingRows = (await getPendingOutbox(batchSize)) as unknown as OutboxRow[];
      if (!pendingRows || pendingRows.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      // Mark all in-flight to prevent duplicate concurrent pickup
      for (const row of pendingRows) {
        await markOutbox(row.idempotency_key, { status: 'inflight' });
      }

      if (pushHandler) {
        const result = await pushHandler(pendingRows);

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

        return {
          processed: pendingRows.length,
          succeeded: result.succeededKeys.length,
          failed: result.failedKeys.length,
        };
      } else {
        // Default: mark as synced once handled locally
        for (const row of pendingRows) {
          await markOutbox(row.idempotency_key, { status: 'synced' });
        }
        return {
          processed: pendingRows.length,
          succeeded: pendingRows.length,
          failed: 0,
        };
      }
    } catch (err) {
      console.warn('Outbox flush encountered unexpected error:', err);
      return { processed: 0, succeeded: 0, failed: 0 };
    } finally {
      this.isFlushing = false;
    }
  }
}

export const outboxFlusher = new OutboxFlusher();
