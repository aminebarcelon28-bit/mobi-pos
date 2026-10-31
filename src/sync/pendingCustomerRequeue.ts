/**
 * Case 23 (docs/EDGE_CASES.md) — the native wallet write stamps
 * `customers.sync_status = 'pending'` INSIDE the refund/void transaction. Until
 * this pass existed nothing consumed that marker: propagation relied on the
 * client's best-effort `enqueueGenericSync` after the commit, so a crash in that
 * window (or a forged/native-only write) left the wallet change with no outbox
 * row — it would only travel on the next unrelated edit.
 *
 * This module is the reader: at boot it re-enqueues every pending customer row
 * and clears the marker only when the version it enqueued is still the current
 * one (a newer write stays pending for the next pass).
 */

export interface PendingCustomerRow {
  id: string;
  version: number;
  json_payload: string;
}

export interface PendingCustomerDb {
  select(sql: string, args?: unknown[]): Promise<unknown>;
  execute(sql: string, args?: unknown[]): Promise<unknown>;
}

export interface PendingCustomerRequeue {
  id: string;
  version: number;
  payload: Record<string, unknown>;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? '{}'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Pure: one payload per customer, newest version wins (defensive against duplicates). */
export function planPendingCustomerRequeue(
  rows: ReadonlyArray<Record<string, unknown>>,
): PendingCustomerRequeue[] {
  const byId = new Map<string, PendingCustomerRequeue>();
  for (const raw of rows) {
    const id = String(raw?.id ?? '').trim();
    if (!id) continue;
    const version = Number(raw?.version ?? 0);
    const existing = byId.get(id);
    if (existing && existing.version >= version) continue;
    byId.set(id, {
      id,
      version,
      payload: { ...parsePayload(raw?.json_payload), id, version },
    });
  }
  return [...byId.values()];
}

/**
 * Re-enqueue every pending customer, then clear the marker for the version that
 * was enqueued. Never throws: a boot pass must not block the app.
 */
export async function requeuePendingCustomers(
  db: PendingCustomerDb,
  enqueue: (entity: 'customer', id: string, payload: Record<string, unknown>) => Promise<void>,
  warn: (message: string, detail?: unknown) => void = () => undefined,
): Promise<number> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    const selected = (await db.select(
      `SELECT id, version, json_payload FROM customers
        WHERE COALESCE(sync_status, '') = 'pending'
          AND COALESCE(deleted, 0) = 0`,
    )) as Array<Record<string, unknown>>;
    rows = Array.isArray(selected) ? selected : [];
  } catch (err) {
    // Fresh DB before ensureLocalSyncColumns added the column, or a BUSY read.
    warn('[sync:recover] pending-customer read skipped', err);
    return 0;
  }

  let requeued = 0;
  for (const item of planPendingCustomerRequeue(rows)) {
    try {
      await enqueue('customer', item.id, item.payload);
      await db.execute(
        `UPDATE customers
            SET sync_status = 'synced'
          WHERE id = $1 AND version = $2 AND COALESCE(sync_status, '') = 'pending'`,
        [item.id, item.version],
      );
      requeued += 1;
    } catch (err) {
      warn(`[sync:recover] pending customer ${item.id} not requeued`, err);
    }
  }
  return requeued;
}
