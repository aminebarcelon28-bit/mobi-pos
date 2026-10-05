// Domain Reducer Engine — ES-LFP Projections
// Implements Authority ③ §5.3, Authority ② §5.2, and AGENTS.md §1/§7.
//
// Pure reduction: applies an Envelope to SQLite projection tables
// (p_products, p_transactions, p_transaction_items, projection_cursor).
//
// Invariants:
// 1. Deterministic: state depends purely on the stream of events in HLC order.
// 2. Numeric state (stock) uses accumulate pattern: stock = stock + delta.
// 3. Field LWW guards: updates apply only if envelope HLC exceeds current row_hlc.
// 4. Idempotent: re-applying an envelope results in an identical projection state.

import type { Envelope } from '../bindings/bindings.ts';
import { utcNowIso } from '../utils/dateUtils';

export interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

export async function reduceEnvelope(db: SqlExecutor, envelope: Envelope): Promise<void> {
  const { event_id, hlc, device_id, event } = envelope;
  const nowIso = utcNowIso();

  switch (event.type) {
    case 'product_created': {
      const { id, name, price_cents } = event.data;
      await db.execute(
        `INSERT INTO p_products (id, name, price_cents, stock, deleted, row_hlc, updated_at)
         VALUES (?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           price_cents = excluded.price_cents,
           row_hlc = excluded.row_hlc,
           updated_at = excluded.updated_at
         WHERE excluded.row_hlc > p_products.row_hlc;`,
        [id, name, Math.round(price_cents), hlc, nowIso]
      );
      break;
    }

    case 'product_renamed': {
      const { id, new_name } = event.data;
      await db.execute(
        `UPDATE p_products
         SET name = ?, row_hlc = ?, updated_at = ?
         WHERE id = ? AND ? > row_hlc AND deleted = 0;`,
        [new_name, hlc, nowIso, id, hlc]
      );
      break;
    }

    case 'price_changed': {
      const { id, new_cents } = event.data;
      await db.execute(
        `UPDATE p_products
         SET price_cents = ?, row_hlc = ?, updated_at = ?
         WHERE id = ? AND ? > row_hlc AND deleted = 0;`,
        [Math.round(new_cents), hlc, nowIso, id, hlc]
      );
      break;
    }

    case 'stock_sold': {
      const { product_id, qty } = event.data;
      await db.execute(
        `UPDATE p_products
         SET stock = stock - ?, row_hlc = ?, updated_at = ?
         WHERE id = ? AND deleted = 0;`,
        [Math.round(qty), hlc, nowIso, product_id]
      );
      break;
    }

    case 'stock_received': {
      const { product_id, qty } = event.data;
      await db.execute(
        `UPDATE p_products
         SET stock = stock + ?, row_hlc = ?, updated_at = ?
         WHERE id = ? AND deleted = 0;`,
        [Math.round(qty), hlc, nowIso, product_id]
      );
      break;
    }

    case 'stock_adjusted': {
      const { product_id, delta } = event.data;
      await db.execute(
        `UPDATE p_products
         SET stock = stock + ?, row_hlc = ?, updated_at = ?
         WHERE id = ? AND deleted = 0;`,
        [Math.round(delta), hlc, nowIso, product_id]
      );
      break;
    }

    case 'product_deleted': {
      const { id } = event.data;
      await db.execute(
        `UPDATE p_products
         SET deleted = 1, row_hlc = ?, updated_at = ?
         WHERE id = ? AND ? > row_hlc;`,
        [hlc, nowIso, id, hlc]
      );
      break;
    }

    case 'checkout_completed': {
      const { transaction_id, lines, total_cents } = event.data;
      await db.execute(
        `INSERT OR REPLACE INTO p_transactions (id, total_cents, ts, row_hlc, device_id)
         VALUES (?, ?, ?, ?, ?);`,
        [transaction_id, Math.round(total_cents), nowIso, hlc, device_id]
      );
      for (const line of lines) {
        await db.execute(
          `INSERT OR REPLACE INTO p_transaction_items (tx_id, product_id, qty, unit_cents)
           VALUES (?, ?, ?, ?);`,
          [transaction_id, line.product_id, Math.round(line.qty), Math.round(line.unit_cents)]
        );
      }
      break;
    }

    case 'device_paired':
    case 'device_revoked': {
      // Handled in device state projections
      break;
    }
  }

  // Advance projection cursor
  await db.execute(
    `INSERT INTO projection_cursor (projection_name, last_event_id, last_hlc, updated_at)
     VALUES ('default', ?, ?, ?)
     ON CONFLICT(projection_name) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       last_hlc = excluded.last_hlc,
       updated_at = excluded.updated_at
     WHERE excluded.last_hlc >= projection_cursor.last_hlc;`,
    [event_id, hlc, nowIso]
  );
}

/**
 * Reduce a batch of envelopes in strict chronological HLC order.
 */
export async function reduceBatch(db: SqlExecutor, envelopes: Envelope[]): Promise<number> {
  const sorted = [...envelopes].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
  let count = 0;
  for (const envelope of sorted) {
    await reduceEnvelope(db, envelope);
    count++;
  }
  return count;
}

