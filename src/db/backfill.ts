// One-time backfill: enqueue every pre-outbox Dexie row so the cloud becomes a
// superset of ALL local data (disaster-recovery guarantee). Idempotent — safe
// to re-run; stable keys + ON CONFLICT DO UPDATE make repeats no-ops.
// Runs once per install (flagged in app_settings as sync.backfill_v1).

import { db as dexieDb } from './database';
import {
  getLocalDb,
  utcNowIso,
  enqueueGenericSync,
  syncProductUpsertBulk,
  type GenericEntity,
} from './sqlPluginAdapter';
import type { SaleTransaction, Customer, Product, CartItem } from '../types/pos';

const BACKFILL_FLAG = 'sync.backfill_v1';

async function hasLocalOrder(db: { select: (s: string, a?: unknown[]) => Promise<unknown> }, id: string): Promise<boolean> {
  try {
    const rows = (await db.select('SELECT id FROM transactions WHERE id=$1', [id])) as Array<unknown>;
    return rows.length > 0;
  } catch (err) {
    console.warn(`[backfill] hasLocalOrder lookup failed for order ${id}:`, err);
    return false;
  }
}

export async function backfillAllToOutbox(): Promise<{ enqueued: number; skipped: boolean }> {
  const db = await getLocalDb();
  const flagRows = (await db
    .select('SELECT value_json FROM app_settings WHERE key=$1', [BACKFILL_FLAG])
    .catch(() => [])) as Array<{ value_json: string }>;
  if (flagRows?.[0]) return { enqueued: 0, skipped: true };

  let enqueued = 0;
  const now = utcNowIso();

  // 1. Legacy orders (Dexie-only, pre-outbox era): order + item rows with
  // legacy-* keys. Ledger is NOT reconstructed — migration v3 SEED baselines
  // already captured their stock impact (rebuilding SALE deltas would double-count).
  const txns = (await dexieDb.transactions.toArray().catch(() => [])) as SaleTransaction[];
  for (const t of txns) {
    try {
      if (!t?.id || (await hasLocalOrder(db, t.id))) continue;
      const key = `legacy-${t.id}`;
      await db.execute(
        `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
          cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
          status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'backfill',$18,'pending',$19,0)
         ON CONFLICT(id) DO NOTHING`,
        [t.id, t.receiptNumber ?? t.id, t.customer?.id ?? null, t.subtotal ?? 0, 0,
          t.discountTotal ?? 0, t.total ?? 0, t.costTotal ?? 0, t.profit ?? 0, t.profitMargin ?? 0,
          t.pricingTier ?? 'Retail', t.paymentMethod ?? 'Espèces', t.cashTendered ?? 0, t.changeDue ?? 0,
          t.status ?? 'COMPLETED', t.createdAt ?? now, JSON.stringify(t), key, now],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'order',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=$4`,
        [key, t.id, JSON.stringify(t), now],
      );
      enqueued++;
      const items = Array.isArray(t.items) ? t.items : [];
      for (const [idx, ci] of items.entries()) {
        const itemId = `${t.id}-item-${idx}`;
        const pid = (ci as { product?: { id?: string } }).product?.id ?? 'unknown';
        const iKey = `legacy-${itemId}`;
        await db.execute(
          `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
            imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'backfill',$10,'pending',$11,$11,0)
           ON CONFLICT(id) DO NOTHING`,
          [itemId, t.id, pid, (ci as { quantity?: number }).quantity ?? 1,
            (ci as { appliedPrice?: number }).appliedPrice ?? 0, (ci as { discount?: number }).discount ?? 0,
            (ci as { imeiNumber?: string }).imeiNumber ?? null,
            (ci as { unitCostPrice?: number }).unitCostPrice ?? 0,
            JSON.stringify({ ...(ci as object), transaction_id: t.id }), iKey, t.createdAt ?? now],
        );
        await db.execute(
          `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
           VALUES ($1,'order_item',$2,'UPSERT',$3,'pending')
           ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=$4`,
          [iKey, itemId, JSON.stringify({ id: itemId, transaction_id: t.id, product_id: pid,
            quantity: (ci as { quantity?: number }).quantity ?? 1,
            applied_price: (ci as { appliedPrice?: number }).appliedPrice ?? 0 }), now],
        );
        enqueued++;
      }
    } catch (e) {
      console.warn('Backfill skipped order', t?.id, e);
    }
  }

  // 2. Products (adjust-vs-ledger keeps stock truthful; no-ops when in sync).
  const products = (await dexieDb.products.toArray().catch(() => [])) as Array<Record<string, unknown> & {
    id: string; title: string;
  }>;
  if (products.length > 0) {
    try {
      await syncProductUpsertBulk(products.map((p) => ({
        id: p.id, sku: p.sku as string, barcode: p.barcode as string, title: p.title,
        brand: p.brand as string, category: p.category as string, price: p.price as number,
        wholesalePrice: p.wholesalePrice as number, costPrice: p.costPrice as number,
        stock: p.stock as number, imageUrl: p.imageUrl as string,
        isSerialized: p.isSerialized as boolean, imeiNumber: p.imeiNumber as string,
        vendorName: p.vendorName as string, leadTimeDays: p.leadTimeDays as number,
        dailySalesVelocity: p.dailySalesVelocity as number, reorderPoint: p.reorderPoint as number,
        raw: p,
      })));
      enqueued += products.length;
    } catch (e) {
      console.warn('Backfill skipped products bulk', e);
    }
  }

  // 3. Generic entities (stable keys make reruns no-ops).
  const generic: Array<{ entity: GenericEntity; table: string; idOf: (r: Record<string, unknown>) => string }> = [
    { entity: 'customer', table: 'customers', idOf: (r) => r.id as string },
    { entity: 'repair_order', table: 'repairOrders', idOf: (r) => r.id as string },
    { entity: 'purchase_order', table: 'purchaseOrders', idOf: (r) => r.id as string },
    { entity: 'trade_in', table: 'tradeIns', idOf: (r) => r.id as string },
    { entity: 'imei', table: 'imeiRecords', idOf: (r) => r.imei as string },
    { entity: 'audit_log', table: 'securityAuditLogs', idOf: (r) => r.id as string },
    { entity: 'bundle', table: 'bundles', idOf: (r) => r.id as string },
    { entity: 'customer_debt', table: 'customerDebts', idOf: (r) => r.id as string },
    { entity: 'store_expense', table: 'storeExpenses', idOf: (r) => r.id as string },
    { entity: 'cash_session', table: 'cashSessions', idOf: (r) => r.id as string },
    { entity: 'cash_movement', table: 'cashMovements', idOf: (r) => r.id as string },
  ];
  for (const g of generic) {
    try {
      const rows = (await (dexieDb as unknown as Record<string, { toArray: () => Promise<Record<string, unknown>[]> }>)[g.table].toArray().catch(() => [])) ?? [];
      for (const row of rows) {
        try {
          const id = g.idOf(row);
          if (id) {
            await enqueueGenericSync(g.entity, id, row);
            enqueued++;
          }
        } catch (e) {
          console.warn(`Backfill skipped ${g.entity}`, e);
        }
      }
    } catch (e) {
      console.warn(`Backfill skipped table ${g.table}`, e);
    }
  }
  // cash drops + payouts share the cash_drop entity (flag preserved for routing)
  for (const [dexTable, isPayout] of [['cashDrops', false], ['payouts', true]] as const) {
    try {
      const rows = (await (dexieDb as unknown as Record<string, { toArray: () => Promise<Record<string, unknown>[]> }>)[dexTable].toArray().catch(() => [])) ?? [];
      for (const row of rows) {
        const id = row.id as string;
        if (!id) continue;
        await enqueueGenericSync('cash_drop', id, { ...row, _isPayout: isPayout });
        enqueued++;
      }
    } catch (e) {
      console.warn(`Backfill skipped ${dexTable}`, e);
    }
  }
  // settings except per-device sync.* keys
  try {
    const settings = (await dexieDb.appSettings.toArray().catch(() => [])) as Array<{ key: string; value: unknown }>;
    for (const s of settings) {
      if (!s?.key || s.key.startsWith('sync.')) continue;
      await enqueueGenericSync('setting', s.key, { key: s.key, value: s.value });
      enqueued++;
    }
  } catch (e) {
    console.warn('Backfill skipped settings', e);
  }

  await db.execute(
    'INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ($1, $2, $3)',
    [BACKFILL_FLAG, JSON.stringify({ at: now, enqueued }), now],
  ).catch(() => {});
  return { enqueued, skipped: false };
}

/**
 * One-time Dexie re-mirror: rows that pulls landed in plugin-sql BEFORE the
 * Dexie-mirror code existed never reached the UI store (and the pull cursor
 * has since moved past them, so no future pull will revisit them).
 * Copies plugin-sql transactions/products into Dexie. Idempotent.
 */
// Reconstructs all Dexie transactions from local SQLite transactions and transaction_items.
// Always populates receiptNumber, items, customer, and financials accurately.
export async function reconstructDexieTransactionsFromSql(db: { select: (s: string, a?: unknown[]) => Promise<unknown> }): Promise<number> {
  let mirrored = 0;
  try {
    const rows = (await db.select("SELECT * FROM transactions WHERE deleted=0 OR deleted IS NULL").catch(() => [])) as Array<Record<string, unknown>>;
    if (rows.length === 0) return 0;

    // Check if any transactions require reading transaction_items
    let needsItemsQuery = false;
    for (const r of rows) {
      if (!r.json_payload || !((r.json_payload as string).includes('"items"'))) {
        needsItemsQuery = true;
        break;
      }
    }

    const itemsByTxnId = new Map<string, Array<Record<string, unknown>>>();
    if (needsItemsQuery) {
      const allItems = (await db.select(
        "SELECT * FROM transaction_items WHERE deleted=0 OR deleted IS NULL"
      ).catch(() => [])) as Array<Record<string, unknown>>;
      for (const it of allItems) {
        const txnId = it.transaction_id as string;
        if (!txnId) continue;
        const list = itemsByTxnId.get(txnId) || [];
        list.push(it);
        itemsByTxnId.set(txnId, list);
      }
    }

    // Pre-cache Dexie products and customers in memory once
    const [allProducts, allCustomers] = await Promise.all([
      dexieDb.products.toArray().catch(() => []),
      dexieDb.customers.toArray().catch(() => []),
    ]);
    const productMap = new Map(allProducts.map((p) => [p.id, p]));
    const customerMap = new Map(allCustomers.map((c) => [c.id, c]));

    const transactionsToPut: SaleTransaction[] = [];

    for (const r of rows) {
      try {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse((r.json_payload as string) ?? '{}') as Record<string, unknown>;
        } catch (err) {
          console.warn(`[backfill] Failed parsing json_payload for transaction ${r.id}:`, err);
        }

        const receiptNumber = (r.receipt_number as string) ?? (parsed.receiptNumber as string) ?? (parsed.receipt_number as string) ?? (r.id as string);

        let items: CartItem[] = [];
        if (Array.isArray(parsed.items) && parsed.items.length > 0) {
          items = parsed.items as CartItem[];
        } else {
          const itemRows = itemsByTxnId.get(r.id as string) || [];
          for (const it of itemRows) {
            const prod = productMap.get(it.product_id as string);
            items.push({
              product: prod ?? {
                id: it.product_id as string,
                title: 'Article',
                sku: '',
                barcode: '',
                price: Number(it.applied_price ?? 0),
                wholesalePrice: Number(it.applied_price ?? 0),
                costPrice: Number(it.cost_price ?? 0),
                category: 'Tous les produits',
                brand: 'Autre',
                stock: 0,
                imageUrl: '',
                vendorName: 'Général',
                leadTimeDays: 7,
                dailySalesVelocity: 0,
                reorderPoint: 5,
                compatibleModel: '',
              },
              quantity: Number(it.quantity ?? 1),
              discount: Number(it.discount ?? 0),
              appliedPrice: Number(it.applied_price ?? 0),
              unitCostPrice: Number(it.cost_price ?? 0),
              imeiNumber: (it.imei_number as string) ?? undefined,
            });
          }
        }

        let customerObj: Customer | null = (parsed.customer as Customer) || null;
        if (!customerObj && r.customer_id) {
          const found = customerMap.get(r.customer_id as string);
          if (found) customerObj = found;
        }

        transactionsToPut.push({
          ...parsed,
          id: r.id as string,
          receiptNumber,
          items,
          customer: customerObj || null,
          subtotal: Number(r.subtotal ?? parsed.subtotal ?? r.total ?? 0),
          discountTotal: Number(r.discount_total ?? parsed.discountTotal ?? 0),
          total: Number(r.total ?? parsed.total ?? 0),
          costTotal: Number(r.cost_total ?? parsed.costTotal ?? 0),
          profit: Number(r.profit ?? parsed.profit ?? 0),
          profitMargin: Number(r.profit_margin ?? parsed.profitMargin ?? 0),
          pricingTier: (r.pricing_tier as SaleTransaction['pricingTier']) ?? (parsed.pricingTier as SaleTransaction['pricingTier']) ?? 'Retail',
          paymentMethod: (r.payment_method as SaleTransaction['paymentMethod']) ?? (parsed.paymentMethod as SaleTransaction['paymentMethod']) ?? 'Espèces',
          cashTendered: Number(r.cash_tendered ?? parsed.cashTendered ?? 0),
          changeDue: Number(r.change_due ?? parsed.changeDue ?? 0),
          status: (r.status as SaleTransaction['status']) ?? (parsed.status as SaleTransaction['status']) ?? 'COMPLETED',
          createdAt: (r.created_at as string) ?? (parsed.createdAt as string) ?? utcNowIso(),
          tenders: (parsed.tenders as SaleTransaction['tenders']) ?? [],
        } as SaleTransaction);
      } catch (err) {
        console.warn(`[backfill] Error processing transaction ${r.id}:`, err);
      }
    }

    if (transactionsToPut.length > 0) {
      await dexieDb.transactions.bulkPut(transactionsToPut);
      mirrored = transactionsToPut.length;
    }
  } catch (err) {
    console.error('[backfill] Error reconstructing Dexie transactions from SQL:', err);
  }
  return mirrored;
}

export async function remirrorToDexie(force = false): Promise<{ mirrored: number; skipped?: boolean }> {
  const db = await getLocalDb();
  if (!force) {
    const flagRows = (await db
      .select('SELECT value_json FROM app_settings WHERE key=$1', ['sync.remirror_v1'])
      .catch(() => [])) as Array<{ value_json: string }>;
    if (flagRows?.[0]) return { mirrored: 0 };
  }

  let mirrored = 0;
  // Products: merge stored blob over row essentials (same rule as pull mirror).
  try {
    const rows = (await db.select('SELECT * FROM products WHERE deleted=0').catch(() => [])) as Array<Record<string, unknown>>;
    const productsToPut: Product[] = [];
    for (const r of rows) {
      try {
        let base: Record<string, unknown> = {};
        try {
          base = JSON.parse((r.json_payload as string) ?? '{}') as Record<string, unknown>;
        } catch (err) {
          console.warn(`[backfill] Failed parsing json_payload for product ${r.id}:`, err);
        }
        productsToPut.push({
          sku: (r.sku as string) ?? '',
          barcode: (r.barcode as string) ?? '',
          title: (r.title as string) ?? '',
          brand: (r.brand as Product['brand']) || 'Autre',
          category: (r.category as Product['category']) || 'Tous les produits',
          price: Number(r.price ?? 0),
          wholesalePrice: Number(r.wholesale_price ?? 0),
          costPrice: Number(r.cost_price ?? 0),
          stock: Number(r.stock ?? 0),
          imageUrl: String(r.image_url ?? ''),
          isSerialized: Boolean(r.is_serialized),
          imeiNumber: r.imei_number ? String(r.imei_number) : undefined,
          vendorName: String(r.vendor_name ?? 'Fournisseur Général'),
          leadTimeDays: Number(r.lead_time_days ?? 7),
          dailySalesVelocity: Number(r.daily_sales_velocity ?? 0),
          reorderPoint: Number(r.reorder_point ?? 5),
          compatibleModel: String(r.compatible_model ?? ''),
          ...base,
          id: String(r.id),
        });
      } catch (err) {
        console.warn(`[backfill] Error preparing product ${r.id} for Dexie:`, err);
      }
    }
    if (productsToPut.length > 0) {
      await dexieDb.products.bulkPut(productsToPut);
      mirrored += productsToPut.length;
    }
  } catch (err) {
    console.error('[backfill] Error remirroring products to Dexie:', err);
  }

  const txMirrored = await reconstructDexieTransactionsFromSql(db);
  mirrored += txMirrored;

  await db.execute(
    'INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ($1, $2, $3)',
    ['sync.remirror_v1', JSON.stringify({ at: utcNowIso(), mirrored }), utcNowIso()],
  ).catch(() => {});
  return { mirrored };
}
