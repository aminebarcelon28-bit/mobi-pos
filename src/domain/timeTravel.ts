// Point-in-Time Time Travel & Disaster Rebuild — ES-LFP Phase P7
// Implements Authority ③ §6.3, Authority ③ §9 (P7 Gate), and AGENTS.md §1/§7.
//
// 1. Time-Travel Queries: Replays event stream up to any historical HLC timestamp
//    to compute exact point-in-time stock and prices without mutating live projections.
// 2. Disaster Recovery: Rebuilds local SQLite projections from scratch using raw `event_log`.

import type { SqlExecutor } from './reducers.ts';
import { replayProjections } from '../sync/snapshotBackfill.ts';

export interface PointInTimeProduct {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
  deleted: boolean;
}

/**
 * Replays history up to targetHlc to inspect historical state (Time-Travel).
 */
export async function queryStateAtHlc(
  db: SqlExecutor,
  targetHlc: string
): Promise<Map<string, PointInTimeProduct>> {
  const rows = (await db.select(
    `SELECT event_id, aggregate, hlc, device_id, schema_v, event_type, data_json
     FROM event_log
     WHERE hlc <= ?
     ORDER BY hlc ASC;`,
    [targetHlc]
  ).catch(() => [])) as Array<{
    event_id: string;
    aggregate: string;
    hlc: string;
    device_id: string;
    schema_v: number;
    event_type: string;
    data_json: string;
  }>;

  const products = new Map<string, PointInTimeProduct>();

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json);
      switch (row.event_type) {
        case 'product_created': {
          products.set(data.id, {
            id: data.id,
            name: data.name,
            priceCents: data.price_cents,
            stock: 0,
            deleted: false,
          });
          break;
        }
        case 'product_renamed': {
          const p = products.get(data.id);
          if (p && !p.deleted) p.name = data.new_name;
          break;
        }
        case 'price_changed': {
          const p = products.get(data.id);
          if (p && !p.deleted) p.priceCents = data.new_cents;
          break;
        }
        case 'stock_sold': {
          const p = products.get(data.product_id);
          if (p && !p.deleted) p.stock -= Number(data.qty);
          break;
        }
        case 'stock_received': {
          const p = products.get(data.product_id);
          if (p && !p.deleted) p.stock += Number(data.qty);
          break;
        }
        case 'stock_adjusted': {
          const p = products.get(data.product_id);
          if (p && !p.deleted) p.stock += Number(data.delta);
          break;
        }
        case 'product_deleted': {
          const p = products.get(data.id);
          if (p) p.deleted = true;
          break;
        }
      }
    } catch {
      // Skip corrupt historical row in time-travel reconstruction
    }
  }

  return products;
}

/**
 * Rebuild local database projections from scratch from event_log (One-Tap Self Repair).
 */
export async function rebuildFromEventLog(
  db: SqlExecutor
): Promise<{ replayedCount: number; productsCount: number; transactionsCount: number }> {
  const replayedCount = await replayProjections(db);

  const prodCountRows = (await db.select('SELECT COUNT(*) as c FROM p_products;').catch(() => [
    { c: 0 },
  ])) as Array<{ c: number }>;
  const txCountRows = (await db.select('SELECT COUNT(*) as c FROM p_transactions;').catch(() => [
    { c: 0 },
  ])) as Array<{ c: number }>;

  return {
    replayedCount,
    productsCount: Number(prodCountRows?.[0]?.c ?? 0),
    transactionsCount: Number(txCountRows?.[0]?.c ?? 0),
  };
}
