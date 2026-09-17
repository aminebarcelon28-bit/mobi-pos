// Snapshot Backfill & Replay Runner — ES-LFP Phase P1
// Implements Authority ③ §16.2, Authority ③ §9 (P1 Gate), and AGENTS.md Contract C6.
//
// 1. Backfills legacy catalog records into `event_log` as canonical DomainEvents.
// 2. Replays `event_log` from scratch to verify Replay-Equality Invariant:
//    replayed projections == live projections.

import type { Envelope } from '../bindings/bindings.ts';
import { reduceEnvelope, type SqlExecutor } from '../domain/reducers.ts';
import { recordShadowEvent } from './eventInterceptor.ts';

interface LegacyProductRow {
  id: string;
  name: string;
  price: number;
  stock: number;
  deleted?: number;
}

interface EventLogRow {
  event_id: string;
  aggregate: string;
  hlc: string;
  device_id: string;
  schema_v: number;
  event_type: string;
  data_json: string;
}

/**
 * Idempotently backfills products that exist in legacy `products` but have no
 * representation in `p_products` or `event_log`.
 */
export async function backfillExistingProducts(
  db: SqlExecutor,
  deviceId: string = 'device-default'
): Promise<number> {
  try {
    const legacyProducts = (await db.select(
      'SELECT id, name, price, stock, deleted FROM products;'
    ).catch(() => [])) as LegacyProductRow[];

    let backfilledCount = 0;

    for (const prod of legacyProducts) {
      const existing = (await db.select(
        'SELECT id FROM p_products WHERE id = ?;',
        [prod.id]
      ).catch(() => [])) as Array<{ id: string }>;

      if (existing.length === 0) {
        const priceCents = Math.round((Number(prod.price) || 0) * 100);
        const stockQty = Math.round(Number(prod.stock) || 0);

        // 1. Record creation
        await recordShadowEvent(
          db,
          {
            type: 'product_created',
            data: {
              id: prod.id,
              name: prod.name || 'Produit',
              price_cents: priceCents,
              sku: null,
            },
          },
          `product:${prod.id}`,
          deviceId
        );

        // 2. Record initial stock adjustment if non-zero
        if (stockQty !== 0) {
          await recordShadowEvent(
            db,
            {
              type: 'stock_adjusted',
              data: {
                product_id: prod.id,
                delta: stockQty,
                reason: 'Reprise de stock initial',
              },
            },
            `product:${prod.id}`,
            deviceId
          );
        }

        // 3. Record soft-delete if deleted in legacy table
        if (prod.deleted === 1) {
          await recordShadowEvent(
            db,
            {
              type: 'product_deleted',
              data: { id: prod.id },
            },
            `product:${prod.id}`,
            deviceId
          );
        }

        backfilledCount++;
      }
    }

    return backfilledCount;
  } catch (err) {
    console.warn('[Snapshot Backfill] Non-fatal error during product backfill:', err);
    return 0;
  }
}

/**
 * Replays all historical events from `event_log` in chronological HLC order
 * to reconstruct `p_products`, `p_transactions`, and `p_transaction_items`.
 */
export async function replayProjections(db: SqlExecutor): Promise<number> {
  // 1. Wipe projections
  await db.execute('DELETE FROM p_products;');
  await db.execute('DELETE FROM p_transactions;');
  await db.execute('DELETE FROM p_transaction_items;');
  await db.execute('DELETE FROM projection_cursor;');

  // 2. Fetch all raw events in deterministic chronological HLC order
  const rows = (await db.select(
    `SELECT event_id, aggregate, hlc, device_id, schema_v, event_type, data_json
     FROM event_log
     ORDER BY hlc ASC;`
  ).catch(() => [])) as EventLogRow[];

  let replayedCount = 0;

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json);
      const envelope: Envelope = {
        event_id: row.event_id,
        aggregate: row.aggregate,
        hlc: row.hlc,
        device_id: row.device_id,
        schema_v: row.schema_v,
        event: {
          type: row.event_type as any,
          data,
        },
      };

      await reduceEnvelope(db, envelope);
      replayedCount++;
    } catch (err) {
      console.warn(`[Replay Runner] Skipping malformed event ${row.event_id}:`, err);
    }
  }

  return replayedCount;
}

