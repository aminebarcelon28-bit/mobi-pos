/**
 * Outbox folding for atomic money lanes (C1: DB-012).
 *
 * A void/refund SQLite transaction that commits the money rows but not the
 * outbox row leaves peers diverged with no automatic recovery (nothing
 * re-enqueues a missing outbox row). So the void/refund transactions INSERT
 * their outbox rows INSIDE the same BEGIN IMMEDIATE that commits the money.
 * The later enqueueOrderSync/writeCheckoutAtomic calls then converge
 * idempotently onto the same keys (ON CONFLICT DO UPDATE refresh) — a
 * harmless version re-bump, never a duplicate payout.
 *
 * Key discipline (must match the later paths exactly, or two outbox rows
 * cover one entity — convergent but wasteful):
 * - existing rows (voided/refunded originals): the transaction's own
 *   `idempotency_key`, else `legacy-<id>` (enqueueOrderSync shape).
 * - new refund receipt rows: `orderRow.idempotency_key`, else
 *   `order-<refundTxnId>` (writeCheckoutAtomic shape).
 *
 * Zero dependencies (imports only payloadHygiene) so node tests execute
 * the REAL statement builders below against disposable DBs.
 */
import { toBoundedSyncJson } from './payloadHygiene';

export interface OrderOutboxInsert {
  sql: string;
  args: unknown[];
}

/**
 * Canonical order-lane outbox INSERT. Shape mirrors enqueueOrderSync: a
 * re-enqueue refreshes payload/retries instead of duplicating, so folded
 * rows and later explicit enqueues converge on one row per key.
 */
export function buildOrderOutboxInsert(
  entityId: string,
  key: string,
  payload: Record<string, unknown>,
  nowIso: string,
): OrderOutboxInsert {
  return {
    sql: `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
      VALUES ($1,'order',$2,'UPSERT',$3,'pending')
      ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
    args: [key, entityId, toBoundedSyncJson(payload), nowIso],
  };
}

/** Key for an existing row: its own idempotency key, else the legacy shape. */
export function existingRowOutboxKey(rowId: string, idempotencyKey: unknown): string {
  return (typeof idempotencyKey === 'string' && idempotencyKey.length > 0
    ? idempotencyKey
    : `legacy-${rowId}`);
}

/** Key for a newly minted receipt row (writeCheckoutAtomic shape). */
export function newReceiptOutboxKey(rowId: string, idempotencyKey: unknown): string {
  return (typeof idempotencyKey === 'string' && idempotencyKey.length > 0
    ? idempotencyKey
    : `order-${rowId}`);
}
