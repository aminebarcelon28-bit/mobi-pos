/**
 * UPGRADE-07 — procurement landed-cost records + supplier price history.
 *
 * Tables (migration v122):
 *  - `po_freight`:        allocation evidence for a receipt's freight total
 *                         (integer DZD, method VALUE|QTY|WEIGHT, per-line
 *                         JSON). Freight is strictly the physical shipping/
 *                         handling fee — never a fiscal levy.
 *  - `supplier_price_history`: one row per received line (unit cost + qty +
 *                         batch id + invoice number) — the evidence lane for
 *                         >10% price-creep disputes.
 *
 * Merchant-local operational records: NOT trust tables and NOT synced
 * entities (no outbox lane — same posture as part_rmas/defective_returns).
 * Money is integer DZD; the single Math.round boundary sits at the write
 * site. Outside Tauri every read degrades to empty and every write returns
 * false (the WebView preview has no v122 tables).
 */
import { isTauriEnv } from './base';

export interface PoFreightAllocationLine {
  productId: string;
  batchId?: string | null;
  quantity: number;
  freightPerUnit: number;
  allocated: number;
}

export interface SupplierPriceRow {
  id: string;
  productId: string;
  productName?: string | null;
  supplier: string;
  invoiceNo?: string | null;
  unitCost: number;
  quantity: number;
  batchId?: string | null;
  receivedAt: string;
}

export interface SupplierPriceRecord {
  id: string;
  productId: string;
  productName: string | null;
  supplier: string;
  invoiceNo: string | null;
  unitCost: number;
  quantity: number;
  batchId: string | null;
  receivedAt: string;
}

/**
 * Persists the freight allocation record for a receipt. Idempotent by `id`
 * (derived from the receive nonce) so a BUSY-retry converges instead of
 * duplicating evidence. Throws on real failures — the caller's receive
 * transaction treats that as fail-closed.
 */
export async function insertPoFreightRecord(record: {
  id: string;
  poId: string;
  amount: number;
  method: string;
  allocated: PoFreightAllocationLine[];
}): Promise<boolean> {
  if (!isTauriEnv()) return false;
  const { getLocalDb } = await import('../sqlPluginAdapter');
  const db = await getLocalDb();
  await db.execute(
    `INSERT INTO po_freight (id, po_id, amount, method, allocated_json)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(id) DO UPDATE SET
       amount = excluded.amount,
       method = excluded.method,
       allocated_json = excluded.allocated_json`,
    [
      record.id,
      record.poId,
      Math.max(0, Math.round(Number(record.amount) || 0)),
      record.method,
      JSON.stringify(record.allocated),
    ]
  );
  return true;
}

/**
 * Appends the per-line supplier price rows of a receipt. Identities derive
 * from the batch ids, so a retry converges via ON CONFLICT DO NOTHING —
 * evidence is never duplicated.
 */
export async function insertSupplierPriceRows(rows: SupplierPriceRow[]): Promise<number> {
  if (!isTauriEnv() || rows.length === 0) return 0;
  // Native lane (SEC-01): one transaction, idempotent by row id, so a retried
  // receipt appends nothing twice.
  const { invokeCommand } = await import('../../platform/invoke');
  const report = await invokeCommand<{ written: number }>('insert_supplier_price_rows', {
    rows: rows.map((row) => ({
      id: row.id,
      productId: row.productId,
      productName: row.productName ?? null,
      supplier: row.supplier,
      invoiceNo: row.invoiceNo ?? null,
      unitCost: Math.max(0, Math.round(Number(row.unitCost) || 0)),
      quantity: Math.max(0, Number(row.quantity) || 0),
      batchId: row.batchId ?? null,
      receivedAt: row.receivedAt,
    })),
  });
  return report.written;
}

/**
 * Non-Tauri hosts never reached the SQL path here either (`insertSupplierPriceRows`
 * has always returned 0 off-Tauri), so there is no renderer fallback to keep.
 */

/**
 * Latest recorded unit cost per product for one supplier (before the current
 * receipt's rows are appended — callers must invoke this BEFORE inserting).
 * Reads degrade to an empty map outside Tauri or on any error.
 */
export async function getLatestSupplierPrices(
  productIds: string[],
  supplier: string
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (!isTauriEnv() || productIds.length === 0 || !supplier) return prices;
  try {
    const { getLocalDb } = await import('../sqlPluginAdapter');
    const db = await getLocalDb();
    const placeholders = productIds.map((_, i) => `$${i + 2}`).join(', ');
    const rows = (await db.select(
      `SELECT product_id, unit_cost FROM supplier_price_history
       WHERE supplier = $1 AND product_id IN (${placeholders}) AND unit_cost > 0
       ORDER BY received_at DESC, created_at DESC`,
      [supplier, ...productIds]
    )) as Array<{ product_id: string; unit_cost: number }>;
    for (const row of rows) {
      if (!prices.has(row.product_id)) {
        const cost = Number(row.unit_cost) || 0;
        if (cost > 0) prices.set(row.product_id, cost);
      }
    }
  } catch (err) {
    console.warn('[procurementCost] price-history lookup skipped:', err);
  }
  return prices;
}

/**
 * Recent price history for a product (optionally scoped to one supplier) —
 * the evidence read for disputes. Degrades to an empty list outside Tauri.
 */
export async function listSupplierPriceHistory(
  productId: string,
  supplier?: string,
  limit = 12
): Promise<SupplierPriceRecord[]> {
  if (!isTauriEnv() || !productId) return [];
  try {
    const { getLocalDb } = await import('../sqlPluginAdapter');
    const db = await getLocalDb();
    const safeLimit = Math.max(1, Math.min(100, Math.round(limit)));
    const rows = (await db.select(
      supplier
        ? `SELECT id, product_id, product_name, supplier, invoice_no, unit_cost, quantity, batch_id, received_at
           FROM supplier_price_history WHERE product_id = $1 AND supplier = $2
           ORDER BY received_at DESC, created_at DESC LIMIT ${safeLimit}`
        : `SELECT id, product_id, product_name, supplier, invoice_no, unit_cost, quantity, batch_id, received_at
           FROM supplier_price_history WHERE product_id = $1
           ORDER BY received_at DESC, created_at DESC LIMIT ${safeLimit}`,
      supplier ? [productId, supplier] : [productId]
    )) as Array<{
      id: string;
      product_id: string;
      product_name?: string | null;
      supplier: string;
      invoice_no?: string | null;
      unit_cost: number;
      quantity: number;
      batch_id?: string | null;
      received_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name ?? null,
      supplier: r.supplier,
      invoiceNo: r.invoice_no ?? null,
      unitCost: Number(r.unit_cost) || 0,
      quantity: Number(r.quantity) || 0,
      batchId: r.batch_id ?? null,
      receivedAt: r.received_at,
    }));
  } catch (err) {
    console.warn('[procurementCost] price-history read skipped:', err);
    return [];
  }
}
