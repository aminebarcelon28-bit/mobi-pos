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
  isDeviceLocalSettingKey,
  stripDeviceLocalSettingValue,
  type GenericEntity,
} from './sqlPluginAdapter';
import { withBusyRetry } from './busyRetry';
import type { SaleTransaction, Customer, Product, CartItem } from '../types/pos';
import { APP_VERSION } from '../types/pos';

/**
 * One-shot era. Bump when a new divergence era needs re-healing: the flag key
 * carries the era, so a second era re-runs the (idempotent) backfill instead
 * of trusting a stale v1 flag forever. The app version is recorded INSIDE the
 * flag value for forensics, never in the key (a per-version key would
 * re-enqueue the whole store on every release).
 */
const BACKFILL_SCHEMA_ERA = 2;
// Era 3: remirror now reconciles deletes (evicts Dexie ghosts for rows
// deleted in SQLite). Bumping forces a one-time re-run so existing
// divergences (UI 1960 vs SQLite 1010) converge on next boot.
const REMIRROR_SCHEMA_ERA = 3;
const BACKFILL_FLAG = `sync.backfill_v${BACKFILL_SCHEMA_ERA}`;
const REMIRROR_FLAG = `sync.remirror_v${REMIRROR_SCHEMA_ERA}`;
// Era-independent one-shot: projects the SQLite batches ledger into Dexie so
// batch-based reporting starts from the truth on upgraded installs (whose
// Dexie quantities predate the mirror). Independent of REMIRROR_FLAG so it
// runs even where the v3 remirror already completed.
const REMIRROR_BATCHES_FLAG = 'sync.remirror_batches_v1';
// v104 STRICT LEDGER one-shot: backfills sale_batch_allocations from durable
// transaction_items.fifo_allocations JSON (pre-v104 / offline sales) and
// projects the frozen ledger into the Dexie saleBatchAllocations mirror the
// allocation-backed report hooks read. Without this, upgraded installs keep
// the stale stored costTotal (500×2=1000 → 6,000) on screen while fresh
// installs correctly show 6,100. Independent of REMIRROR_FLAG like batches.
const REMIRROR_ALLOCS_FLAG = 'sync.remirror_allocs_v1';

type FlagDb = {
  select: (s: string, a?: unknown[]) => Promise<unknown>;
  execute: (s: string, a?: unknown[]) => Promise<unknown>;
};

async function readFlag(db: FlagDb, key: string): Promise<Record<string, unknown> | null> {
  try {
    const rows = (await db.select('SELECT value_json FROM app_settings WHERE key=$1', [key]).catch(() => [])) as Array<{ value_json: string }>;
    if (!rows?.[0]) return null;
    try {
      return JSON.parse(rows[0].value_json as string) as Record<string, unknown>;
    } catch {
      return { raw: rows[0].value_json };
    }
  } catch {
    return null;
  }
}

async function writeFlag(db: FlagDb, key: string, value: Record<string, unknown>): Promise<void> {
  const { utcNowIso } = await import('./sqlPluginAdapter');
  const now = utcNowIso();
  await db.execute(
    'INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ($1, $2, $3)',
    [key, JSON.stringify({ ...value, appVersion: APP_VERSION }), now],
  ).catch(() => {});
}

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
  // Retried but NOT outer-locked (house rule: withWriteLock is not
  // re-entrant): the inner writers self-serialize — enqueueGenericSync owns
  // the mutex per call — so an outer lock here would deadlock. The direct
  // boot INSERTs below are idempotent single statements (ON CONFLICT), and a
  // BUSY anywhere replays the whole idempotent pass via the outer retry.
  // Idempotent (stable keys + ON CONFLICT), so re-execution is safe.
  return withBusyRetry(() => backfillAllToOutboxInner(), {
    attempts: 4,
    baseDelayMs: 100,
    label: 'backfill',
  });
}

async function backfillAllToOutboxInner(): Promise<{ enqueued: number; skipped: boolean }> {
  const db = await getLocalDb();
  if (await readFlag(db, BACKFILL_FLAG)) return { enqueued: 0, skipped: true };

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
          status, created_at, json_payload, device_id, idempotency_key, sync_status, version, updated_at, deleted)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'backfill',$18,'pending',1,$19,0)
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
        // P0 thin-payload fix: the outbox payload MUST be the full item shape
        // (discount/imei/cost/device/version), not a 5-field projection — the
        // push lane serializes payload_json to the remote row and pull
        // overwrites local columns from it, so a thin payload permanently
        // destroys line money on peers. Same object feeds the local row.
        const itemPayload = { ...(ci as object), id: itemId, transaction_id: t.id };
        await db.execute(
          `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
            imei_number, cost_price, unit_price_charged, unit_cost_at_sale, discount_amount, line_profit,
            json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'backfill',$14,'pending',1,$15,$15,0)
            ON CONFLICT(id) DO NOTHING`,
          [itemId, t.id, pid, (ci as { quantity?: number }).quantity ?? 1,
            (ci as { appliedPrice?: number }).appliedPrice ?? 0, (ci as { discount?: number }).discount ?? 0,
            (ci as { imeiNumber?: string }).imeiNumber ?? null,
            (ci as { unitCostPrice?: number }).unitCostPrice ?? 0,
            (ci as { unitPriceCharged?: number }).unitPriceCharged
              ?? (ci as { appliedPrice?: number }).appliedPrice ?? 0,
            (ci as { unitCostAtSale?: number }).unitCostAtSale
              ?? (ci as { unitCostPrice?: number }).unitCostPrice ?? 0,
            (ci as { discountAmount?: number }).discountAmount ?? 0,
            (ci as { lineProfit?: number }).lineProfit ?? 0,
            JSON.stringify(itemPayload), iKey, t.createdAt ?? now],
        );
        await db.execute(
          `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
           VALUES ($1,'order_item',$2,'UPSERT',$3,'pending')
           ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=$4`,
          [iKey, itemId, JSON.stringify(itemPayload), now],
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
    { entity: 'credit_voucher', table: 'creditVouchers', idOf: (r) => (r.id as string) || '' },
    { entity: 'stock_batches', table: 'stockBatches', idOf: (r) => ((r.batchId ?? r.batch_id ?? r.id) as string) || '' },
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
  // settings except device-local keys (sync.* cursors/state, PIN/credential
  // material, per-device printer routing stripped from the payload).
  try {
    const settings = (await dexieDb.appSettings.toArray().catch(() => [])) as Array<{ key: string; value: unknown }>;
    for (const s of settings) {
      if (!s?.key || isDeviceLocalSettingKey(s.key)) continue;
      await enqueueGenericSync('setting', s.key, { key: s.key, value: stripDeviceLocalSettingValue(s.key, s.value) });
      enqueued++;
    }
  } catch (e) {
    console.warn('Backfill skipped settings', e);
  }

  await writeFlag(db, BACKFILL_FLAG, { at: now, enqueued, era: BACKFILL_SCHEMA_ERA });
  return { enqueued, skipped: false };
}

// Era-independent one-shot (own flag): stamps original_transaction_id on
// pre-linkage refund rows from their receipt JSON so the indexed
// over-refund bound (DB-002) sees the complete history. New writes stamp
// the column at insert; this covers everything written before. Idempotent
// (only touches NULL-column rows whose JSON carries the key) and cheap
// after the first run (flag short-circuit: one indexed settings read).
const REMIRROR_ORIGIN_FLAG = 'sync.backfill_orig_txn_v1';

export async function backfillOriginalTransactionIds(
  db: FlagDb & {
    select: (s: string, a?: unknown[]) => Promise<unknown>;
    execute: (s: string, a?: unknown[]) => Promise<unknown>;
  },
): Promise<{ backfilled: number; skipped?: boolean }> {
  if (await readFlag(db, REMIRROR_ORIGIN_FLAG)) return { backfilled: 0, skipped: true };
  let backfilled = 0;
  try {
    const rows = (await db
      .select(
        "SELECT id, json_payload FROM transactions WHERE original_transaction_id IS NULL AND json_payload LIKE '%originalTransactionId%'",
      )
      .catch(() => [])) as Array<{ id?: unknown; json_payload?: unknown }>;
    const { extractOriginalTransactionId } = await import('../sync/causalVersion');
    for (const row of rows ?? []) {
      const id = String(row?.id ?? '');
      if (!id) continue;
      const origId = extractOriginalTransactionId(row.json_payload);
      if (!origId) continue;
      try {
        await db.execute('UPDATE transactions SET original_transaction_id = $1 WHERE id = $2 AND original_transaction_id IS NULL', [
          origId,
          id,
        ]).catch(() => {});
        backfilled += 1;
      } catch {
        // Row-level failure — leave NULL (the bound's LIKE residual still
        // sees it, same as before).
      }
    }
  } catch {
    // Column missing (pre-migration schema) or unreadable DB: leave for the
    // next boot after the heal runs. Never fail boot over a backfill.
  }
  await writeFlag(db, REMIRROR_ORIGIN_FLAG, { at: utcNowIso(), backfilled }).catch(() => {});
  return { backfilled };
}

/**
 * One-time Dexie re-mirror: rows that pulls landed in plugin-sql BEFORE the
 * Dexie-mirror code existed never reached the UI store (and the pull cursor
 * has since moved past them, so no future pull will revisit them).
 * Copies plugin-sql transactions/products into Dexie. Idempotent.
 */
// Reconstructs all Dexie transactions from local SQLite transactions and transaction_items.
// Always populates receiptNumber, items, customer, and financials accurately.
export async function reconstructDexieTransactionsFromSql(
  db: { select: (s: string, a?: unknown[]) => Promise<unknown> },
  opts?: { onlyTransactionIds?: Iterable<string> },
): Promise<number> {
  let mirrored = 0;
  try {
    // Incremental path (F2): when the pull already knows which transactions
    // were touched, rebuild only those instead of the whole history.
    // No opts (explicit full-rebuild entries) keeps the legacy full scan.
    const onlyIds = opts?.onlyTransactionIds
      ? [...new Set([...opts.onlyTransactionIds].map((v) => String(v ?? '')).filter(Boolean))]
      : null;
    const scoped = !!onlyIds && onlyIds.length > 0;

    let rows: Array<Record<string, unknown>>;
    if (scoped) {
      rows = [];
      const ids = onlyIds as string[];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const part = (await db.select(
          `SELECT * FROM transactions WHERE id IN (${chunk.map(() => '?').join(',')}) AND (deleted=0 OR deleted IS NULL) ORDER BY created_at DESC, id DESC`,
          chunk,
        ).catch(() => [])) as Array<Record<string, unknown>>;
        rows.push(...part);
      }
    } else {
      rows = (await db.select("SELECT * FROM transactions WHERE deleted=0 OR deleted IS NULL ORDER BY created_at DESC, id DESC").catch(() => [])) as Array<Record<string, unknown>>;
    }
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
      let allItems: Array<Record<string, unknown>>;
      if (scoped) {
        allItems = [];
        const ids = rows.map((r) => String(r.id));
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          const part = (await db.select(
            `SELECT * FROM transaction_items WHERE transaction_id IN (${chunk.map(() => '?').join(',')}) AND (deleted=0 OR deleted IS NULL) ORDER BY transaction_id, id`,
            chunk,
          ).catch(() => [])) as Array<Record<string, unknown>>;
          allItems.push(...part);
        }
      } else {
        allItems = (await db.select(
          "SELECT * FROM transaction_items WHERE deleted=0 OR deleted IS NULL ORDER BY transaction_id, id"
        ).catch(() => [])) as Array<Record<string, unknown>>;
      }
      for (const it of allItems) {
        const txnId = it.transaction_id as string;
        if (!txnId) continue;
        const list = itemsByTxnId.get(txnId) || [];
        list.push(it);
        itemsByTxnId.set(txnId, list);
      }
    }

    // Product/customer lookup: scoped bulkGet for the touched slice, full
    // in-memory precache only for explicit full rebuilds.
    const productMap = new Map<string, Product>();
    const customerMap = new Map<string, Customer>();
    if (scoped) {
      const prodIds = new Set<string>();
      const custIds = new Set<string>();
      for (const r of rows) {
        if (r.customer_id) custIds.add(String(r.customer_id));
        // Embedded items reference products outside itemsByTxnId — collect
        // them too so scoped mirrors never fall back to stub products.
        try {
          const parsed = JSON.parse((r.json_payload as string) ?? '{}') as { items?: Array<{ product?: { id?: unknown } }> };
          for (const it of parsed.items ?? []) {
            if (it?.product?.id) prodIds.add(String(it.product.id));
          }
        } catch {
          // Unparseable here; the build loop below warns per row.
        }
      }
      for (const list of itemsByTxnId.values()) {
        for (const it of list) {
          if (it.product_id) prodIds.add(String(it.product_id));
        }
      }
      const [prods, custs] = await Promise.all([
        prodIds.size > 0 ? dexieDb.products.bulkGet([...prodIds]).catch(() => []) : [],
        custIds.size > 0 ? dexieDb.customers.bulkGet([...custIds]).catch(() => []) : [],
      ]);
      for (const p of prods) {
        if (p) productMap.set((p as Product).id, p as Product);
      }
      for (const c of custs) {
        if (c) customerMap.set((c as Customer).id, c as Customer);
      }
    } else {
      // Pre-cache Dexie products and customers in memory once
      const [allProducts, allCustomers] = await Promise.all([
        dexieDb.products.toArray().catch(() => []),
        dexieDb.customers.toArray().catch(() => []),
      ]);
      for (const p of allProducts) productMap.set(p.id, p);
      for (const c of allCustomers) customerMap.set(c.id, c);
    }

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
            const rowUnitCost = Number(
              it.unit_cost_at_sale ?? it.cost_price ?? 0,
            );
            const rowCharged = Number(
              it.unit_price_charged ?? it.applied_price ?? 0,
            );
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
              unitCostPrice: rowUnitCost,
              unitCostAtSale: rowUnitCost,
              unitPriceCharged: rowCharged,
              discountAmount: Number(it.discount_amount ?? 0),
              lineProfit: Number(
                it.line_profit ?? (rowCharged - rowUnitCost) * Number(it.quantity ?? 1),
              ),
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
          // v105 ATOMIC MATERIALIZATION: finite column value wins, then the
          // receipt-JSON envelope (synced peers), else ABSENT (legacy row =
          // unknown → receipt looks up the ledger, never zero). Never fall
          // back to costTotal here: that would cement a stale estimate as
          // "materialized" truth.
          ...(() => {
            const rawLedger =
              (r.ledger_cogs_total as unknown) ??
              (parsed.ledgerCogsTotal as unknown) ??
              (parsed.ledger_cogs_total as unknown);
            const v = Number(rawLedger);
            return Number.isFinite(v) && v >= 0 ? { ledgerCogsTotal: Math.round(v) } : {};
          })(),
          pricingTier: (r.pricing_tier as SaleTransaction['pricingTier']) ?? (parsed.pricingTier as SaleTransaction['pricingTier']) ?? 'Retail',
          paymentMethod: (r.payment_method as SaleTransaction['paymentMethod']) ?? (parsed.paymentMethod as SaleTransaction['paymentMethod']) ?? 'Espèces',
          cashTendered: Number(r.cash_tendered ?? parsed.cashTendered ?? 0),
          changeDue: Number(r.change_due ?? parsed.changeDue ?? 0),
          status: (r.status as SaleTransaction['status']) ?? (parsed.status as SaleTransaction['status']) ?? 'COMPLETED',
          // Dateless legacy rows sink via the canonical comparator (empty
          // string coerces to -Infinity) — never forge utcNowIso() here,
          // which would promote an old row to "newest".
          createdAt: ((typeof r.created_at === 'string' && r.created_at) || (parsed.createdAt as string) || '') as string,
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
  // One-shot batches-ledger healing (own flag, independent of REMIRROR_FLAG):
  // sales/restitutions depleted SQLite batches without projecting into Dexie
  // before the mirror existed, so upgraded installs carry overstated Dexie
  // quantities. Runs once even when the v3 remirror was already done.
  try {
    if (force || !(await readFlag(db, REMIRROR_BATCHES_FLAG))) {
      const { mirrorStockBatchesToDexie } = await import('./sqlPluginAdapter');
      const n = await mirrorStockBatchesToDexie(db);
      await writeFlag(db, REMIRROR_BATCHES_FLAG, { at: utcNowIso(), mirrored: n });
    }
  } catch (batchErr) {
    console.warn('[backfill] Batch mirror remirror skipped:', batchErr);
  }
  // v104 STRICT LEDGER one-shot (own flag, same independence rationale as
  // batches): backfill the frozen ledger from line JSON, then mirror it to
  // Dexie so allocation-backed reports converge on upgraded installs.
  // Idempotent (ON CONFLICT DO NOTHING) — safe to re-run with force.
  try {
    if (force || !(await readFlag(db, REMIRROR_ALLOCS_FLAG))) {
      const { backfillSaleAllocationsFromItemsWithDb, mirrorSaleAllocationsToDexie } =
        await import('./sqlPluginAdapter');
      const inserted = await backfillSaleAllocationsFromItemsWithDb(
        db as unknown as Parameters<typeof backfillSaleAllocationsFromItemsWithDb>[0]
      ).catch(() => 0);
      const mirroredAllocs = await mirrorSaleAllocationsToDexie(
        db as unknown as Parameters<typeof mirrorSaleAllocationsToDexie>[0]
      ).catch(() => 0);
      await writeFlag(db, REMIRROR_ALLOCS_FLAG, {
        at: utcNowIso(),
        inserted,
        mirrored: mirroredAllocs,
      });
    }
  } catch (allocErr) {
    console.warn('[backfill] Allocation ledger remirror skipped:', allocErr);
  }
  if (!force) {
    if (await readFlag(db, REMIRROR_FLAG)) return { mirrored: 0 };
  }

  let mirrored = 0;
  // Products: merge stored blob over row essentials (same rule as pull mirror).
  try {
    // DB-001: deterministic remirror order (ghost-reconcile diffs were
    // run-dependent on insertion order).
    const rows = (await db.select('SELECT * FROM products WHERE deleted=0 ORDER BY id').catch(() => [])) as Array<Record<string, unknown>>;
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
          // Row-column authority (double-count fix): ledger recomputes
          // (appendInventoryDeltas et al.) UPDATE products.stock WITHOUT
          // touching json_payload, so a stale blob must never win for stock.
          // Column-first with blob fallback, mirroring the transactions
          // reconstructor's `r.x ?? parsed.x` precedence below.
          stock: Number(r.stock ?? (base as { stock?: unknown }).stock ?? 0),
        });
      } catch (err) {
        console.warn(`[backfill] Error preparing product ${r.id} for Dexie:`, err);
      }
    }
    if (productsToPut.length > 0) {
      await dexieDb.products.bulkPut(productsToPut);
      mirrored += productsToPut.length;
    }
    // Reconcile deletes: Dexie-only ghosts (deleted in SQLite, or stale
    // stability-test rows removed via --remove) would otherwise keep the UI
    // count above the SQLite truth forever — bulkPut alone never deletes.
    // Ghost evictions count toward `mirrored` so boot refreshes the UI even
    // when the live set is unchanged and only ghosts were removed.
    try {
      const liveIds = new Set(productsToPut.map((p) => p.id));
      const allDexie = await dexieDb.products.toArray().catch(() => []);
      const ghosts = allDexie.filter((dp) => !liveIds.has(dp.id)).map((dp) => dp.id);
      if (ghosts.length > 0) {
        await dexieDb.products.bulkDelete(ghosts).catch(() => undefined);
        mirrored += ghosts.length;
      }
    } catch (reconcileErr) {
      console.warn('[backfill] Product ghost reconcile skipped:', reconcileErr);
    }
  } catch (err) {
    console.error('[backfill] Error remirroring products to Dexie:', err);
  }

  try {
    const custRows = (await db
      .select('SELECT * FROM customers WHERE deleted = 0 ORDER BY id')
      .catch(() => [])) as Array<Record<string, unknown>>;
    const customersToPut: Customer[] = [];
    for (const r of custRows) {
      try {
        let base: Partial<Customer> = {};
        if (r.json_payload) {
          try {
            base = JSON.parse(r.json_payload as string) as Customer;
          } catch {}
        }
        customersToPut.push({
          name: String(r.name ?? ''),
          phone: String(r.phone ?? ''),
          email: String(r.email ?? ''),
          loyaltyPoints: Number(r.loyalty_points ?? 0),
          storeCredit: Number(r.store_credit ?? 0),
          pricingTier: (r.pricing_tier as Customer['pricingTier']) || 'Retail',
          totalSpent: Number(r.total_spent ?? 0),
          registeredDevice: 'local',
          ...base,
          id: String(r.id),
        });
      } catch (err) {
        console.warn(`[backfill] Error preparing customer ${r.id} for Dexie:`, err);
      }
    }
    if (customersToPut.length > 0) {
      await dexieDb.customers.bulkPut(customersToPut);
      mirrored += customersToPut.length;
    }
    try {
      const liveCustIds = new Set(customersToPut.map((c) => c.id));
      const allDexieCusts = await dexieDb.customers.toArray().catch(() => []);
      const custGhosts = allDexieCusts.filter((dc) => !liveCustIds.has(dc.id)).map((dc) => dc.id);
      if (custGhosts.length > 0) {
        await dexieDb.customers.bulkDelete(custGhosts).catch(() => undefined);
        mirrored += custGhosts.length;
      }
    } catch (reconcileErr) {
      console.warn('[backfill] Customer ghost reconcile skipped:', reconcileErr);
    }
  } catch (err) {
    console.error('[backfill] Error remirroring customers to Dexie:', err);
  }

  const txMirrored = await reconstructDexieTransactionsFromSql(db);
  mirrored += txMirrored;

  await writeFlag(db, REMIRROR_FLAG, { at: utcNowIso(), mirrored, era: REMIRROR_SCHEMA_ERA });
  return { mirrored };
}
