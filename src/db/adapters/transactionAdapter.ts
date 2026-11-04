import type {
  CartItem,
  Product,
  Customer,
  SaleTransaction,
  SecurityAuditLogEntry,
  TransactionWindowCursor,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { sortTransactionsNewestFirst } from '../../utils/dateUtils';
import { fireSync, isTauriEnv } from './base';
import { getLocalDb, beginImmediate } from '../sqlPluginAdapter';
import { withWriteLock } from '../writeMutex';
import { withBusyRetry, isBusyError } from '../busyRetry';
import { physicalCashTendered, cashDisbursedOf, clampCashRefund } from '../../utils/cashTerms';
import { refundableValueOf } from '../../utils/receiptMath';
import { offlineRefundVerdict } from '../../sync/refundLockPolicy';
import { normalizeDeviceKey } from '../../utils/deviceIdCodec';
import { imeiTrustEventId } from '../../utils/deviceTrust';

/**
 * Independent execution policy for processRefundAtomic (defense in depth).
 * The slice computes and enforces these from store state; the adapter
 * re-verifies from DURABLE rows (Dexie authority + SQLite mirror) so a
 * stale/compromised caller can never force a payout past them.
 */
export interface RefundExecutionPolicy {
  localDeviceId: string;
  activeShiftId: string | null;
  /** Online at submit time (slice probe). False = offline verdict applies. */
  online: boolean;
}

/**
 * Same-window double-submit guards. A double-tap on "Annuler" / "Rembourser"
 * (or a relayed hotkey firing twice) must not run the same void/refund twice:
 * the second call throws ALREADY_PROCESSING while the first is in flight.
 * Sequential duplicates are caught separately by the in-transaction re-reads
 * below; these Sets only cover the concurrent window. Always cleared in
 * `finally` so a failure can never wedge later voids/refunds.
 */
const voidInFlight = new Set<string>();
const refundInFlight = new Set<string>();

function refundFlightKey(refundTransaction: SaleTransaction): string {
  const items = (refundTransaction.refundedItems ?? [])
    .map((ri) => `${ri.productId}:${ri.quantity}:${ri.restock ? 1 : 0}`)
    .sort()
    .join(',');
  return `${refundTransaction.originalTransactionId ?? refundTransaction.id}|${items}`;
}

/** Purchased quantities per product from the original sale's line items. */
function purchasedQtyByProduct(txn: SaleTransaction | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of txn?.items ?? []) {
    const pid = i.product?.id;
    if (!pid) continue;
    out.set(pid, (out.get(pid) ?? 0) + Math.abs(Number(i.quantity ?? 0)));
  }
  return out;
}

/** Requested quantities per product from the refund's refunded-items list. */
function requestedQtyByProduct(refundTransaction: SaleTransaction): Map<string, number> {
  const out = new Map<string, number>();
  for (const ri of refundTransaction.refundedItems ?? []) {
    out.set(ri.productId, (out.get(ri.productId) ?? 0) + Number(ri.quantity ?? 0));
  }
  return out;
}

/**
 * Result channel for the atomic void/refund paths. `warnings` carries
 * non-fatal post-commit failures (currently: SQLite IMEI-release resets) that
 * previously vanished into console.warn — the Dexie release already committed
 * inside the atomic block, but the SQLite mirror row can stay stuck 'sold',
 * so callers MUST surface these (toast / audit) instead of dropping them.
 */
export interface ImeiReleaseResult {
  warnings?: string[];
}

/**
 * Enterprise audit telemetry backfill: atomic sale/void/refund lanes put the
 * audit row directly (no operationsAdapter hop), so entries built by callers
 * without device/IP would otherwise persist with empty telemetry and break
 * the "Terminal / IP" expansion + PDF/A-3 traceability. Best-effort, never
 * throws — the financial write must not fail over a bookkeeping field.
 */
async function enrichAuditTelemetry(
  entry: SecurityAuditLogEntry | undefined
): Promise<SecurityAuditLogEntry | undefined> {
  if (!entry) return entry;
  const needsDevice = !entry.deviceId;
  const needsIp = !entry.ipAddress;
  const needsTs = !entry.timestamp || !entry.timestamp.includes('T');
  if (!needsDevice && !needsIp && !needsTs) return entry;
  try {
    const { getDeviceId, getIpAddress } = await import('../../utils/deviceInfo');
    return {
      ...entry,
      timestamp: needsTs ? new Date().toISOString() : entry.timestamp,
      deviceId: entry.deviceId || getDeviceId(),
      ipAddress: entry.ipAddress || (await getIpAddress().catch(() => 'Non détectée (hors-ligne)')),
    };
  } catch {
    return {
      ...entry,
      timestamp: needsTs ? new Date().toISOString() : entry.timestamp,
    };
  }
}

// ── UPGRADE-01: windowed history + index-direct safety reads ────────────────
//
// Boot and every post-pull refresh load a bounded newest-first window of
// transactions (`getTransactionsWindow`); older history pages on demand via
// `loadMoreTransactions`. Money-critical consumers (shift close / Z snapshot /
// X report, reports & exports, refunds, receipt reprints, IMEI search) must
// never trust that RAM window: they read SQLite directly by index
// (idx_transactions_created_at / idx_transactions_receipt /
// idx_txn_items_imei) and map payload-first exactly like backfill.ts does, so
// a ticket outside the window can never be missed for money or warranty.

/**
 * Tolerant json_payload parse. Some legacy writers double-encoded the payload
 * (a JSON string holding a JSON string — see sqlPluginAdapter's
 * `parsed.json_payload` handling), so parse twice when the first parse yields
 * a string. Never throws — an unreadable blob maps to an empty envelope and
 * the scalar columns still carry the money fields.
 */
function parseTxPayloadLoose(raw: unknown): Record<string, unknown> {
  let obj: unknown = raw;
  for (let i = 0; i < 2 && typeof obj === 'string'; i++) {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return obj as Record<string, unknown>;
}

function toFiniteNumber(value: unknown, fallback: unknown = 0): number {
  const n = Number(value ?? fallback ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map raw SQLite `transactions` rows (+ a `transaction_items` fallback for
 * rows without embedded items) to `SaleTransaction` objects. Field-for-field
 * mirror of backfill.ts so windowed and full-history readers can never
 * disagree on the money fields.
 */
async function mapTxRowsToSaleTransactions(
  rows: Array<Record<string, unknown>>
): Promise<SaleTransaction[]> {
  if (!rows || rows.length === 0) return [];
  const parsedById = new Map<string, Record<string, unknown>>();
  const productIds = new Set<string>();
  const customerIds = new Set<string>();
  const rowsNeedingItems: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const id = String(r.id ?? '');
    const parsed = parseTxPayloadLoose(r.json_payload);
    parsedById.set(id, parsed);
    if (r.customer_id) customerIds.add(String(r.customer_id));
    const embedded = Array.isArray(parsed.items) ? (parsed.items as unknown[]) : [];
    if (embedded.length === 0) rowsNeedingItems.push(r);
    for (const it of embedded) {
      const pid = (it as { product?: { id?: unknown } } | null)?.product?.id;
      if (pid) productIds.add(String(pid));
    }
  }
  const itemsByTxnId = new Map<string, Array<Record<string, unknown>>>();
  if (rowsNeedingItems.length > 0) {
    try {
      const db = await getLocalDb();
      const ids = rowsNeedingItems.map((r) => String(r.id ?? ''));
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const part = (await db
          .select(
            `SELECT * FROM transaction_items WHERE transaction_id IN (${chunk.map(() => '?').join(',')}) AND (deleted = 0 OR deleted IS NULL)`,
            chunk
          )
          .catch(() => [])) as Array<Record<string, unknown>>;
        for (const it of part) {
          const txnId = String(it.transaction_id ?? '');
          if (!txnId) continue;
          const list = itemsByTxnId.get(txnId) ?? [];
          list.push(it);
          itemsByTxnId.set(txnId, list);
          if (it.product_id) productIds.add(String(it.product_id));
        }
      }
    } catch (err) {
      console.warn('[db:tx-read] transaction_items fallback unavailable:', err);
    }
  }
  const [prodList, custList] = await Promise.all([
    productIds.size > 0 ? dexieDb.products.bulkGet([...productIds]).catch(() => []) : Promise.resolve([]),
    customerIds.size > 0 ? dexieDb.customers.bulkGet([...customerIds]).catch(() => []) : Promise.resolve([]),
  ]);
  const productMap = new Map<string, Product>();
  for (const p of prodList) if (p) productMap.set(p.id, p);
  const customerMap = new Map<string, Customer>();
  for (const c of custList) if (c) customerMap.set(c.id, c);

  const out: SaleTransaction[] = [];
  for (const r of rows) {
    const parsed = parsedById.get(String(r.id ?? '')) ?? {};
    let items: CartItem[] = [];
    if (Array.isArray(parsed.items) && (parsed.items as unknown[]).length > 0) {
      items = parsed.items as CartItem[];
    } else {
      for (const it of itemsByTxnId.get(String(r.id ?? '')) ?? []) {
        const prod = productMap.get(String(it.product_id ?? ''));
        const rowUnitCost = toFiniteNumber(it.unit_cost_at_sale ?? it.cost_price);
        const rowCharged = toFiniteNumber(it.unit_price_charged ?? it.applied_price);
        items.push({
          product: prod ?? {
            id: String(it.product_id ?? ''),
            title: 'Article',
            sku: '',
            barcode: '',
            price: toFiniteNumber(it.applied_price),
            wholesalePrice: toFiniteNumber(it.applied_price),
            costPrice: toFiniteNumber(it.cost_price),
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
          quantity: toFiniteNumber(it.quantity, 1),
          discount: toFiniteNumber(it.discount),
          appliedPrice: toFiniteNumber(it.applied_price),
          unitCostPrice: rowUnitCost,
          unitCostAtSale: rowUnitCost,
          unitPriceCharged: rowCharged,
          discountAmount: toFiniteNumber(it.discount_amount),
          lineProfit: toFiniteNumber(
            it.line_profit,
            (rowCharged - rowUnitCost) * toFiniteNumber(it.quantity, 1)
          ),
          imeiNumber: (it.imei_number as string) ?? undefined,
        } as unknown as CartItem);
      }
    }
    let customerObj: Customer | null = (parsed.customer as Customer) || null;
    if (!customerObj && r.customer_id) {
      customerObj = customerMap.get(String(r.customer_id)) ?? null;
    }
    out.push({
      ...parsed,
      id: String(r.id ?? ''),
      receiptNumber:
        (r.receipt_number as string) ??
        (parsed.receiptNumber as string) ??
        (parsed.receipt_number as string) ??
        String(r.id ?? ''),
      items,
      customer: customerObj,
      subtotal: toFiniteNumber(r.subtotal ?? parsed.subtotal, r.total ?? 0),
      discountTotal: toFiniteNumber(r.discount_total ?? parsed.discountTotal),
      total: toFiniteNumber(r.total ?? parsed.total),
      costTotal: toFiniteNumber(r.cost_total ?? parsed.costTotal),
      profit: toFiniteNumber(r.profit ?? parsed.profit),
      profitMargin: toFiniteNumber(r.profit_margin ?? parsed.profitMargin),
      // v105 ATOMIC MATERIALIZATION: finite column value wins, then the
      // receipt-JSON envelope; absent stays absent (legacy row = unknown).
      ...(() => {
        const rawLedger =
          (r.ledger_cogs_total as unknown) ??
          (parsed.ledgerCogsTotal as unknown) ??
          (parsed.ledger_cogs_total as unknown);
        const v = Number(rawLedger);
        return Number.isFinite(v) && v >= 0 ? { ledgerCogsTotal: Math.round(v) } : {};
      })(),
      // v127 REFUND RECOVERY: recovered COGS of the RESTOCKED units (finite
      // column value wins, then the envelope alias); absent = 0 credit —
      // legacy refund rows are never over-credited in the P&L.
      ...(() => {
        const rawRestored =
          (r.restored_cogs as unknown) ??
          (parsed.restoredCogs as unknown) ??
          (parsed.restored_cogs as unknown);
        const v = Number(rawRestored);
        return Number.isFinite(v) && v > 0 ? { restoredCogs: Math.round(v) } : {};
      })(),
      pricingTier:
        (r.pricing_tier as SaleTransaction['pricingTier']) ??
        (parsed.pricingTier as SaleTransaction['pricingTier']) ??
        'Retail',
      paymentMethod:
        (r.payment_method as SaleTransaction['paymentMethod']) ??
        (parsed.paymentMethod as SaleTransaction['paymentMethod']) ??
        'Espèces',
      cashTendered: toFiniteNumber(r.cash_tendered ?? parsed.cashTendered),
      changeDue: toFiniteNumber(r.change_due ?? parsed.changeDue),
      status:
        (r.status as SaleTransaction['status']) ??
        (parsed.status as SaleTransaction['status']) ??
        'COMPLETED',
      createdAt: ((typeof r.created_at === 'string' && r.created_at) ||
        (parsed.createdAt as string) ||
        '') as string,
      tenders: (parsed.tenders as SaleTransaction['tenders']) ?? [],
      ...(r.shift_id && !parsed.shiftId ? { shiftId: String(r.shift_id) } : {}),
    } as SaleTransaction);
  }
  return out;
}

/** SQLite range read (bounded by optional from/to) + payload mapping, with a
 * Dexie-scan fallback for web preview (no SQLite authority there). */
async function readTransactionsByRange(opts: {
  from?: string | null;
  to?: string | null;
}): Promise<SaleTransaction[]> {
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  if (isTauriEnv()) {
    try {
      const db = await getLocalDb();
      const where: string[] = ['(deleted = 0 OR deleted IS NULL)'];
      const params: unknown[] = [];
      if (from) {
        params.push(from);
        where.push(`created_at >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        where.push(`created_at <= $${params.length}`);
      }
      const rows = (await db.select(
        `SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`,
        params
      )) as Array<Record<string, unknown>>;
      return await mapTxRowsToSaleTransactions(rows);
    } catch (err) {
      console.warn('[db:tx-read] SQLite range read failed, falling back to Dexie:', err);
    }
  }
  const all = sortTransactionsNewestFirst(await dexieDb.transactions.toArray());
  return all.filter((t) => {
    const at = String(t.createdAt ?? '');
    if (from && at < from) return false;
    if (to && at > to) return false;
    return true;
  });
}

export const transactionAdapter = {
  async processSaleTransactionAtomic(
    transaction: SaleTransaction,
    updatedProducts: Product[],
    updatedCustomer?: Customer,
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    const enrichedAudit = await enrichAuditTelemetry(auditEntry);
    // Persist to Dexie in single transaction
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs], async () => {
      await dexieDb.transactions.put(transaction);
      await dexieDb.products.bulkPut(updatedProducts);
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (enrichedAudit) {
        await dexieDb.securityAuditLogs.put(enrichedAudit);
      }
    });
    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (enrichedAudit) void fireSync('audit_log', enrichedAudit.id, enrichedAudit);
  },

  async getAllTransactions(): Promise<SaleTransaction[]> {
    // Newest-first: Dexie index scan (createdAt, see database.ts) for the
    // coarse order, then the canonical comparator defensively re-sorts so
    // legacy / non-ISO strings still land deterministically (invalid sinks).
    try {
      const ordered = await dexieDb.transactions.orderBy('createdAt').reverse().toArray();
      return sortTransactionsNewestFirst(ordered);
    } catch {
      return sortTransactionsNewestFirst(await dexieDb.transactions.toArray());
    }
  },

  /**
   * UPGRADE-01 — keyset-paginated window over the Dexie mirror (the
   * transaction display authority; complete in Tauri builds via backfill +
   * post-pull mirror repairs, and the only store in web preview).
   *
   * Order is `createdAt DESC, id DESC` with a strict cursor: rows equal on
   * `createdAt` continue by descending id, so no row is duplicated or skipped
   * across pages. Boot and every post-pull refresh take page 1 (LIMIT 200 by
   * default); older history loads on demand through the store's
   * `loadMoreTransactions()`.
   */
  async getTransactionsWindow(opts?: {
    cursor?: TransactionWindowCursor | null;
    limit?: number;
  }): Promise<{ items: SaleTransaction[]; nextCursor: TransactionWindowCursor | null; hasMore: boolean }> {
    const limit = Math.min(Math.max(1, Math.floor(opts?.limit ?? 200)), 1000);
    const cursor = opts?.cursor ?? null;
    try {
      let page: SaleTransaction[];
      if (!cursor) {
        page = await dexieDb.transactions.orderBy('createdAt').reverse().limit(limit + 1).toArray();
      } else {
        page = await dexieDb.transactions
          .where('createdAt')
          .belowOrEqual(cursor.createdAt)
          .reverse()
          .filter(
            (t) => !(String(t.createdAt ?? '') === cursor.createdAt && String(t.id) >= cursor.id)
          )
          .limit(limit + 1)
          .toArray();
      }
      const hasMore = page.length > limit;
      const items = page.slice(0, limit);
      const tail = items[items.length - 1];
      return {
        items,
        nextCursor:
          hasMore && tail
            ? { createdAt: String(tail.createdAt ?? ''), id: String(tail.id) }
            : null,
        hasMore,
      };
    } catch (err) {
      console.warn('[db:tx-window] Dexie keyset read failed, falling back to full scan:', err);
      const all = sortTransactionsNewestFirst(await dexieDb.transactions.toArray());
      const start = cursor
        ? all.findIndex(
            (t) => String(t.createdAt ?? '') === cursor.createdAt && String(t.id) === cursor.id
          ) + 1
        : 0;
      const fromIdx = Math.max(0, start);
      const slice = all.slice(fromIdx, fromIdx + limit);
      const hasMore = fromIdx + limit < all.length;
      const tail = slice[slice.length - 1];
      return {
        items: slice,
        nextCursor:
          hasMore && tail
            ? { createdAt: String(tail.createdAt ?? ''), id: String(tail.id) }
            : null,
        hasMore,
      };
    }
  },

  /**
   * UPGRADE-01 safety rail — receipt lookup straight to SQLite by
   * `idx_transactions_receipt`. A ticket older than the RAM window must stay
   * reprintable/refundable by scanning its barcode.
   */
  async getTransactionByReceipt(receipt: string): Promise<SaleTransaction | undefined> {
    const clean = String(receipt ?? '').trim();
    if (!clean) return undefined;
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(
          'SELECT * FROM transactions WHERE (deleted = 0 OR deleted IS NULL) AND receipt_number = $1 ORDER BY created_at DESC LIMIT 1',
          [clean]
        )) as Array<Record<string, unknown>>;
        const mapped = await mapTxRowsToSaleTransactions(rows);
        if (mapped.length > 0) return mapped[0];
      } catch (err) {
        console.warn('[db:tx-read] receipt read failed, falling back to Dexie:', err);
      }
    }
    try {
      const hits = await dexieDb.transactions.where('receiptNumber').equals(clean).toArray();
      return sortTransactionsNewestFirst(hits)[0];
    } catch {
      return undefined;
    }
  },

  /**
   * D5-A (docs/decisions/D5-large-ticket-selection.md): open a refund WITHOUT
   * transferring or parsing the whole payload. A 4e9 ticket carries ~139 MB
   * because the customer block and milestone awards scale with the sale value;
   * JSON.parse of that on the main thread is what made large tickets
   * unselectable. Only the fields the refund consumes are extracted.
   */
  async getRefundCandidateByReceipt(receiptOrId: string): Promise<SaleTransaction | undefined> {
    const clean = String(receiptOrId ?? '').trim();
    if (!clean) return undefined;
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(`SELECT id, receipt_number, status, created_at, shift_id, device_id, total,
       json_extract(json_payload,'$.subtotal') AS subtotal,
       json_extract(json_payload,'$.discountTotal') AS discountTotal,
       json_extract(json_payload,'$.total') AS totalPayload,
       json_extract(json_payload,'$.paymentMethod') AS paymentMethod,
       json_extract(json_payload,'$.cashTendered') AS cashTendered,
       json_extract(json_payload,'$.changeDue') AS changeDue,
       json_extract(json_payload,'$.tenders') AS tenders,
       json_extract(json_payload,'$.items') AS items,
       json_extract(json_payload,'$.refundedItems') AS refundedItems,
       json_extract(json_payload,'$.voucherCreditApplied') AS voucherCreditApplied,
       json_extract(json_payload,'$.voucherCode') AS voucherCode,
       json_extract(json_payload,'$.debtAdded') AS debtAdded,
       json_extract(json_payload,'$.customer.id') AS customerId,
       json_extract(json_payload,'$.customer.name') AS customerName
  FROM transactions
 WHERE (deleted = 0 OR deleted IS NULL) AND (receipt_number = $1 OR id = $1)
 ORDER BY created_at DESC LIMIT 1`, [clean])) as Array<Record<string, unknown>>;
        const r = rows?.[0];
        if (!r) return undefined;
        const j = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
        const candidate = {
          id: String(r.id),
          receiptNumber: String(r.receipt_number),
          status: String(r.status),
          createdAt: String(r.created_at ?? ''),
          shiftId: r.shift_id ? String(r.shift_id) : undefined,
          deviceId: r.device_id ? String(r.device_id) : undefined,
          device_id: r.device_id ? String(r.device_id) : undefined,
          subtotal: Number(r.subtotal ?? 0),
          discountTotal: Number(r.discountTotal ?? 0),
          total: Number(r.totalPayload ?? r.total ?? 0),
          paymentMethod: String(r.paymentMethod ?? 'Espèces'),
          cashTendered: Number(r.cashTendered ?? 0),
          changeDue: Number(r.changeDue ?? 0),
          tenders: (j(r.tenders) as unknown[]) ?? [],
          items: (j(r.items) as unknown[]) ?? [],
          refundedItems: (j(r.refundedItems) as unknown[]) ?? [],
          voucherCreditApplied: Number(r.voucherCreditApplied ?? 0) || undefined,
          voucherCode: r.voucherCode ? String(r.voucherCode) : undefined,
          debtAdded: r.debtAdded ?? undefined,
          isRefund: false,
          customer: r.customerId
            ? ({ id: String(r.customerId), name: String(r.customerName ?? ''), storeCredit: 0 } as unknown)
            : null,
        };
        return candidate as unknown as SaleTransaction;
      } catch (err) {
        console.warn('[db:tx-read] refund candidate projection failed, falling back to full read:', err);
      }
    }
    return await this.getTransactionByReceipt(clean);
  },

  /** UPGRADE-01 safety rail — direct PK read (receipt barcodes carry the id too). */
  async getTransactionById(id: string): Promise<SaleTransaction | undefined> {
    const clean = String(id ?? '').trim();
    if (!clean) return undefined;
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(
          'SELECT * FROM transactions WHERE (deleted = 0 OR deleted IS NULL) AND id = $1 LIMIT 1',
          [clean]
        )) as Array<Record<string, unknown>>;
        const mapped = await mapTxRowsToSaleTransactions(rows);
        if (mapped.length > 0) return mapped[0];
      } catch (err) {
        console.warn('[db:tx-read] id read failed, falling back to Dexie:', err);
      }
    }
    return await dexieDb.transactions.get(clean).catch(() => undefined);
  },

  /**
   * UPGRADE-01 safety rail — shift-scoped complete read (SQLite authority,
   * `idx_transactions_created_at`). Shift close, the Z snapshot and the
   * interim X report must never undercount a busy shift just because the UI
   * window holds only the newest 200 tickets.
   */
  async getTransactionsByShiftWindow(
    openedAt: string | null,
    closedAt?: string | null
  ): Promise<SaleTransaction[]> {
    return await readTransactionsByRange({ from: openedAt ?? null, to: closedAt ?? null });
  },

  /**
   * UPGRADE-01 safety rail — date-range complete read for reports, exports
   * and full-history management views (on-demand; never part of boot).
   */
  async getTransactionsByDateRange(opts?: {
    from?: string | null;
    to?: string | null;
  }): Promise<SaleTransaction[]> {
    return await readTransactionsByRange({ from: opts?.from ?? null, to: opts?.to ?? null });
  },

  /** UPGRADE-01 — honest total for diagnostics (the store holds a window only). */
  async getTransactionsCount(): Promise<number> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(
          'SELECT COUNT(*) AS c FROM transactions WHERE deleted = 0 OR deleted IS NULL'
        )) as Array<{ c?: number }>;
        const n = Number(rows?.[0]?.c);
        if (Number.isFinite(n)) return n;
      } catch (err) {
        console.warn('[db:tx-read] count read failed, falling back to Dexie:', err);
      }
    }
    return await dexieDb.transactions.count().catch(() => 0);
  },

  /**
   * UPGRADE-01 safety rail — IMEI → sale history straight to SQLite via
   * `idx_txn_items_imei`. The SQL probe uses the stored form plus a
   * digits-only pass; final equality is normalized in JS so mixed-format
   * legacy rows can never hide a device's sale.
   */
  async findTransactionsByImei(imei: string): Promise<SaleTransaction[]> {
    const needle = normalizeDeviceKey(imei);
    if (!needle) return [];
    const raw = String(imei ?? '').trim();
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const ids = new Set<string>();
        const collect = (rows: unknown[]) => {
          for (const r of rows as Array<{ transaction_id?: unknown }>) {
            if (r?.transaction_id) ids.add(String(r.transaction_id));
          }
        };
        collect(
          (await db
            .select(
              'SELECT DISTINCT transaction_id FROM transaction_items WHERE imei_number = $1 LIMIT 200',
              [raw]
            )
            .catch(() => [])) as unknown[]
        );
        if (needle !== raw) {
          collect(
            (await db
              .select(
                'SELECT DISTINCT transaction_id FROM transaction_items WHERE imei_number = $1 LIMIT 200',
                [needle]
              )
              .catch(() => [])) as unknown[]
          );
        }
        if (ids.size === 0 && needle.length >= 6) {
          collect(
            (await db
              .select(
                "SELECT DISTINCT transaction_id FROM transaction_items WHERE imei_number LIKE '%' || $1 || '%' LIMIT 200",
                [needle]
              )
              .catch(() => [])) as unknown[]
          );
        }
        if (ids.size > 0) {
          const idList = [...ids];
          const rows: Array<Record<string, unknown>> = [];
          for (let i = 0; i < idList.length; i += 200) {
            const chunk = idList.slice(i, i + 200);
            const part = (await db.select(
              `SELECT * FROM transactions WHERE id IN (${chunk.map(() => '?').join(',')}) AND (deleted = 0 OR deleted IS NULL)`,
              chunk
            )) as Array<Record<string, unknown>>;
            rows.push(...part);
          }
          const mapped = await mapTxRowsToSaleTransactions(rows);
          const hits = mapped.filter((t) =>
            (t.items || []).some((it) => normalizeDeviceKey(it.imeiNumber ?? '') === needle)
          );
          if (hits.length > 0) return sortTransactionsNewestFirst(hits);
        }
      } catch (err) {
        console.warn('[db:tx-read] IMEI read failed, falling back to Dexie scan:', err);
      }
    }
    try {
      const hits = await dexieDb.transactions
        .filter((t) =>
          (t.items || []).some((it) => normalizeDeviceKey(it.imeiNumber ?? '') === needle)
        )
        .toArray();
      return sortTransactionsNewestFirst(hits);
    } catch {
      return [];
    }
  },


  async voidTransactionAtomic(
    _transactionId: string,
    voidedTransaction: SaleTransaction,
    restoredProducts: Product[],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry,
    voidCustomer?: {
      /** Ledger rows this void created (appended by id, never the whole history). */
      ledgerEntries?: unknown[];
      /** Restored Avoir minus the milestone revocation owed by this void. */
      creditDeltaDzd?: number;
      /** Credit-debt reversed by this void (positive number, applied as -x). */
      debtDeltaDzd?: number;
    }
  ): Promise<ImeiReleaseResult> {
    const warnings: string[] = [];
    const flightKey = String(_transactionId || voidedTransaction.id);
    if (voidInFlight.has(flightKey)) {
      throw new Error('ALREADY_PROCESSING');
    }
    voidInFlight.add(flightKey);
    const enrichedAudit = await enrichAuditTelemetry(auditEntry);
    try {
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs, dexieDb.imeiRecords], async () => {
      // In-transaction re-read: a sequential duplicate void lands here after
      // the first void already flipped the mirror to VOIDED — abort instead
      // of re-applying loyalty/stock rollbacks a second time.
      const existing = await dexieDb.transactions.get(voidedTransaction.id).catch(() => undefined);
      if (existing && (existing as SaleTransaction).status === 'VOIDED') {
        throw new Error('ALREADY_VOIDED');
      }
      // Cross-operation guard (same atomicity): voiding a refunded ticket
      // would re-restore the refunded leg while the refund payout stays
      // booked. Refunded tickets move only via further per-leg refunds.
      const existingStatus = String((existing as SaleTransaction | undefined)?.status ?? '');
      if (existing && (existingStatus === 'REFUNDED' || existingStatus === 'PARTIALLY_REFUNDED')) {
        throw new Error('REFUNDED_TICKET');
      }
      await dexieDb.transactions.put(voidedTransaction);
      if (restoredProducts.length > 0) {
        await dexieDb.products.bulkPut(restoredProducts);
      }
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (enrichedAudit) {
        await dexieDb.securityAuditLogs.put(enrichedAudit);
      }
      if (restoredImeis.length > 0) {
        for (const imei of restoredImeis) {
          const rec = await dexieDb.imeiRecords.get(imei);
          if (rec) {
            await dexieDb.imeiRecords.put({
              ...rec,
              saleTransactionId: undefined,
              soldAt: undefined,
            });
          }
        }
      }
    });

    let voidMirroredNatively = false;
    if (isTauriEnv()) {
      // Native lane (SEC-01): status flip + IMEI releases + ownership events +
      // loyalty bundle + money delta in one Rust transaction.
      const { invokeCommand } = await import('../../platform/invoke');
      const nowIso = new Date().toISOString();
      const { loyaltyPatch } = updatedCustomer
        ? await import('../refundMirrorSql')
        : { loyaltyPatch: () => ({}) };
      const moneyCustomerId = String(updatedCustomer?.id ?? '').trim();
      const creditDelta = Number((voidCustomer as unknown as { creditDeltaDzd?: number })?.creditDeltaDzd ?? 0);
      const debtDelta = Number((voidCustomer as unknown as { debtDeltaDzd?: number })?.debtDeltaDzd ?? 0);
      try {
        await invokeCommand('void_sale_mirror', {
          request: {
            transactionId: voidedTransaction.id,
            nowIso,
            restoredImeis,
            imeiStatusAvailable: true,
            loyalty: updatedCustomer
              ? {
                  customerId: updatedCustomer.id,
                  patchJson: JSON.stringify(loyaltyPatch(updatedCustomer)),
                  totalSpent:
                    typeof updatedCustomer.totalSpent === 'number' && Number.isFinite(updatedCustomer.totalSpent)
                      ? updatedCustomer.totalSpent
                      : null,
                  loyaltyPoints:
                    typeof updatedCustomer.loyaltyPoints === 'number' && Number.isFinite(updatedCustomer.loyaltyPoints)
                      ? updatedCustomer.loyaltyPoints
                      : null,
                  updatedAt: nowIso,
                  ledgerEntries: ((voidCustomer?.ledgerEntries ?? []) as unknown[]).map((e) => JSON.stringify(e)),
                }
              : null,
            moneyDelta:
              moneyCustomerId && voidCustomer
                ? { customerId: moneyCustomerId, creditDelta, debtDelta, nowIso }
                : null,
          },
        });
        voidMirroredNatively = true;
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes('ALREADY_VOIDED')) throw new Error('ALREADY_VOIDED');
        if (msg.includes('REFUNDED_TICKET')) throw new Error('REFUNDED_TICKET');
        if (!/not found|unknown command/i.test(msg)) throw err;
        // Older host without the command: the renderer lane below is the fallback.
      }
    }
    if (!voidMirroredNatively && isTauriEnv()) {
      await withBusyRetry(
        () =>
          withWriteLock(async () => {
      try {
        const db = await getLocalDb();
        const useTxn = await beginImmediate(db, 'db:void');
        try {
          // In-SQLite-transaction re-read of the durable status: cross-tab /
          // cross-window duplicate voids serialize here and the loser aborts.
          // Missing row (SQLite lane never saw the sale) skips the check.
          const statusRows = (await db
            .select('SELECT status FROM transactions WHERE id=$1', [voidedTransaction.id])
            .catch((e: unknown) => {
              if (isBusyError(e)) throw e;
              return [];
            })) as Array<{ status?: string }>;
          const sqliteStatus = String(statusRows?.[0]?.status ?? '');
          if (sqliteStatus === 'VOIDED') {
            throw new Error('ALREADY_VOIDED');
          }
          if (sqliteStatus === 'REFUNDED' || sqliteStatus === 'PARTIALLY_REFUNDED') {
            throw new Error('REFUNDED_TICKET');
          }
          // B-020: flip authority status in the SAME txn as IMEI release so a
          // crash between Dexie put and enqueueOrderSync cannot leave SQLite
          // COMPLETED while Dexie is VOIDED (stale-echo split-brain).
          await db.execute(
            `UPDATE transactions SET status='VOIDED', updated_at=$2, version = version + 1, sync_status='pending' WHERE id=$1`,
            [voidedTransaction.id, new Date().toISOString()]
          ).catch((updErr: unknown) => {
            if (isBusyError(updErr)) throw updErr;
            // Row may not exist yet in SQLite lane — non-fatal (enqueue later).
            console.warn('[db:void] status flip skipped:', updErr);
          });
          for (const imei of restoredImeis) {
            try {
              await db.execute(
                'UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = $1',
                [imei]
              );
            } catch (imeiErr) {
              const msg = `[db:void] IMEI ${imei} resté 'sold' dans SQLite (miroir Dexie libéré) — re-synchroniser manuellement.`;
              console.warn(msg, imeiErr);
              warnings.push(msg);
            }
            // UPGRADE-08 — ownership ledger: the void returned this unit to
            // the shop. Best-effort + idempotent: a ledger gap must not turn a
            // void into a degraded-warning path, so failures are logged only.
            try {
              await db.execute(
                `INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note)
                 VALUES ($1, $2, 'RETURN_IN', 'order', $3, $4, '', $5)`,
                [
                  imeiTrustEventId('RETURN_IN', 'order', voidedTransaction.id, imei),
                  imei,
                  voidedTransaction.id,
                  new Date().toISOString(),
                  'Annulation de vente',
                ]
              );
            } catch (evtErr) {
              console.warn('[db:void] ownership ledger append skipped:', evtErr);
            }
          }
          // Case 41: the Dexie write above is a MIRROR - SQLite is the authority.
          // Without this, a restart rehydrates a voided sale's points/buckets
          // (G-07) and the restored Avoir is lost. Loyalty is merged into the
          // live payload and MONEY is applied as a delta, never as the pre-void
          // absolute snapshot (a concurrent wallet movement must survive).
          if (updatedCustomer || voidCustomer) {
            const { buildRefundMirrorStatements, buildCustomerMoneyDeltaStatement } = await import('../refundMirrorSql');
            const nowIso = new Date().toISOString();
            if (updatedCustomer) {
              const statements = buildRefundMirrorStatements(
                updatedCustomer,
                nowIso,
                (voidCustomer?.ledgerEntries ?? []) as never,
              );
              for (const statement of statements) {
                await db.execute(statement.sql, statement.args);
              }
            }
            const moneyCustomerId = String(updatedCustomer?.id ?? '').trim();
            if (moneyCustomerId && voidCustomer) {
              const money = buildCustomerMoneyDeltaStatement(moneyCustomerId, voidCustomer, nowIso);
              if (money) await db.execute(money.sql, money.args);
            }
          }
          if (useTxn) {
            await db.execute('COMMIT;');
          }
        } catch (txnErr) {
          if (useTxn) {
            await db.execute('ROLLBACK;').catch(() => {});
          }
          throw txnErr;
        }
      } catch (err) {
        if (err instanceof Error && (err.message === 'ALREADY_VOIDED' || err.message === 'REFUNDED_TICKET')) {
          throw err;
        }
        // BUSY must retry, not degrade to a warning — a void that only
        // releases Dexie while SQLite stays 'sold' diverges the mirrors.
        if (isBusyError(err)) throw err;
        const msg = '[db:void] Connexion SQLite indisponible — libérations IMEI non répercutées (miroir Dexie libéré).';
        console.warn(msg, err);
        warnings.push(msg);
      }
          }),
        { attempts: 6, baseDelayMs: 80, label: 'void' },
      );
    }

    if (restoredImeis.length > 0) {
      for (const imei of restoredImeis) {
        const rec = await dexieDb.imeiRecords.get(imei);
        if (rec) void fireSync('imei', imei, rec);
      }
    }

    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (enrichedAudit) void fireSync('audit_log', enrichedAudit.id, enrichedAudit);
    return warnings.length > 0 ? { warnings } : {};
    } finally {
      voidInFlight.delete(flightKey);
    }
  },

  async processRefundAtomic(
    refundTransaction: SaleTransaction,
    updatedOriginalTransaction?: SaleTransaction,
    restockedProducts: Product[] = [],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry,
    policy?: RefundExecutionPolicy,
    /**
     * Defective units released into quarantine (`status='defective'` +
     * `RETURN_DEFECTIVE` event) — mirrors the native release list exactly.
     */
    defectiveImeis: string[] = []
  ): Promise<ImeiReleaseResult> {
    const warnings: string[] = [];
    const flightKey = refundFlightKey(refundTransaction);
    if (refundInFlight.has(flightKey)) {
      throw new Error('ALREADY_PROCESSING');
    }
    const enrichedRefundAudit = await enrichAuditTelemetry(auditEntry);
    // Pre-lock durable gates (reads only — the in-flight key is claimed
    // after them so a denied refund never holds the lock; concurrent
    // duplicates still converge via the in-transaction re-reads below).
    // Fix 4: accounting-period gate, verified against the durable session
    // table (not the caller's store snapshot). No open shift = no refund.
      const openSession = await dexieDb.cashSessions
        .where('status').equals('OPEN').first().catch(() => undefined);
      if (!openSession || !openSession.id) {
        throw new Error('NO_OPEN_SHIFT');
      }
      // Durable original for the independent checks below. A missing mirror
      // row skips value checks (cannot prove staleness) but never the shift
      // gate above.
      const durableOriginalId = refundTransaction.originalTransactionId;
      const durableOriginal = (durableOriginalId
        ? await dexieDb.transactions.get(durableOriginalId).catch(() => undefined)
        : undefined) as unknown as SaleTransaction | undefined;
      const durablePriorRefunds = (await dexieDb.transactions
        .filter((t) => {
          const rt = t as unknown as { isRefund?: boolean; originalTransactionId?: string };
          return Boolean(rt.isRefund) && rt.originalTransactionId === durableOriginalId;
        })
        .toArray()
        .catch(() => [])) as unknown as SaleTransaction[];
      // Fix 3: offline fail-closed re-verified from the durable row's own
      // device/shift stamps (not the payload's claims about origin).
      if (policy && !policy.online && durableOriginal) {
        const verdict = offlineRefundVerdict(durableOriginal, {
          localDeviceId: policy.localDeviceId,
          activeShiftId: policy.activeShiftId,
        });
        if (!verdict.allow) {
          throw new Error(verdict.reason);
        }
      }
      // Fix 1: zero-value/exhausted tickets refused from durable rows, on the
      // same money-truth basis as list + slice (refundableValueOf).
      if (durableOriginal) {
        if (refundableValueOf(durableOriginal, [durableOriginal, ...(durablePriorRefunds || [])]) <= 0) {
          throw new Error('ZERO_REFUNDABLE');
        }
      }
      // Fix 2: tender-cap re-verification from durable rows. Any caller-side
      // clamp bypass (stale snapshot, compromised UI) dies here before a
      // single dinar moves — fail-closed, never silently corrected.
      {
        const durableCashTendered = physicalCashTendered(durableOriginal);
        const durablePriorCash = (durablePriorRefunds || []).reduce(
          (acc, t) => acc + cashDisbursedOf(t), 0
        );
        const requestedCash = cashDisbursedOf(refundTransaction);
        const cap = clampCashRefund({
          cashShare: requestedCash,
          cashTenderedNet: durableCashTendered,
          priorCashOut: durablePriorCash,
        });
        if (requestedCash > cap.cashOut) {
          throw new Error('CASH_CAP_EXCEEDED');
        }
      }
      // Claim the in-flight key only after the pre-lock gates pass, so a
      // denied refund never wedges the ticket (finally below always clears).
      refundInFlight.add(flightKey);
    try {
    // In-transaction re-read of the over-refund bound (both mirrors): the
    // pre-write check in the slice races a second refund, so the bound is
    // re-derived here from durable rows — purchased (original items) minus
    // already-refunded (committed refund rows) — inside each transaction.
    const assertRefundBound = (alreadyRefunded: Map<string, number>) => {
      if (!updatedOriginalTransaction) return;
      const purchased = purchasedQtyByProduct(updatedOriginalTransaction);
      const requested = requestedQtyByProduct(refundTransaction);
      for (const [pid, qty] of requested) {
        const remaining = (purchased.get(pid) ?? 0) - (alreadyRefunded.get(pid) ?? 0);
        if (qty > remaining) {
          throw new Error(`REFUND_EXCEEDS:${pid}`);
        }
      }
    };
    // ONE release list shared by the Dexie mirror, the SQLite reset and the
    // sync push — the exact native vocabulary (`imei_release` in refund.rs):
    // restocked → `in_stock`/RETURN_IN, write-off → `defective`/
    // RETURN_DEFECTIVE with the same operator note. Never derived twice.
    const imeiReleases = (
      restored: string[],
      defective: string[]
    ): Array<{
      imei: string;
      kind: 'RETURN_IN' | 'RETURN_DEFECTIVE';
      status: 'in_stock' | 'defective';
      note: string;
    }> => [
      ...restored.map((imei) => ({
        imei,
        kind: 'RETURN_IN' as const,
        status: 'in_stock' as const,
        note: 'Retour en stock (remboursement)',
      })),
      ...defective.map((imei) => ({
        imei,
        kind: 'RETURN_DEFECTIVE' as const,
        status: 'defective' as const,
        note: 'Retour défectueux — quarantaine (remboursement)',
      })),
    ];
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs, dexieDb.imeiRecords], async () => {
      const originalId = refundTransaction.originalTransactionId;
      // Cross-operation guard (same atomicity as the bound re-read below):
      // refunding a voided ticket would pay out on a cancelled sale — the
      // void already restored stock and reversed loyalty.
      if (originalId) {
        const origRow = await dexieDb.transactions.get(originalId).catch(() => undefined);
        if (origRow && (origRow as SaleTransaction).status === 'VOIDED') {
          throw new Error('ORIGINAL_VOIDED');
        }
      }
      if (originalId && updatedOriginalTransaction) {
        const prior = new Map<string, number>();
        const all = await dexieDb.transactions.toArray().catch(() => []);
        for (const t of all) {
          const rt = t as SaleTransaction;
          if (rt.isRefund && rt.originalTransactionId === originalId && rt.id !== refundTransaction.id) {
            for (const ri of rt.refundedItems ?? []) {
              prior.set(ri.productId, (prior.get(ri.productId) ?? 0) + Number(ri.quantity ?? 0));
            }
          }
        }
        assertRefundBound(prior);
      }
      await dexieDb.transactions.put(refundTransaction);
      if (updatedOriginalTransaction) {
        await dexieDb.transactions.put(updatedOriginalTransaction);
      }
      if (restockedProducts.length > 0) {
        await dexieDb.products.bulkPut(restockedProducts);
      }
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (enrichedRefundAudit) {
        await dexieDb.securityAuditLogs.put(enrichedRefundAudit);
      }
      for (const release of imeiReleases(restoredImeis, defectiveImeis)) {
        const rec = await dexieDb.imeiRecords.get(release.imei);
        if (rec) {
          await dexieDb.imeiRecords.put({
            ...rec,
            saleTransactionId: undefined,
            soldAt: undefined,
            status: release.status,
          });
        }
      }
    });

    let refundMirroredNatively = false;
    if (isTauriEnv()) {
      // Native lane (SEC-01): original-status guard + IMEI releases + events in
      // one Rust transaction. The read-only prior-refund bound check stays here.
      const { invokeCommand } = await import('../../platform/invoke');
      const nowIso = new Date().toISOString();
      const releases = imeiReleases(restoredImeis, defectiveImeis).map((r) => ({
        imei: r.imei,
        status: r.status,
        kind: r.kind,
        note: r.note,
      }));
      try {
        await invokeCommand('refund_sale_mirror', {
          request: {
            transactionId: refundTransaction.id,
            originalTransactionId: refundTransaction.originalTransactionId ?? null,
            nowIso,
            releases,
          },
        });
        refundMirroredNatively = true;
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes('ORIGINAL_VOIDED')) throw new Error('ORIGINAL_VOIDED');
        if (!/not found|unknown command/i.test(msg)) throw err;
      }
    }
    if (!refundMirroredNatively && isTauriEnv()) {
      await withBusyRetry(
        () =>
          withWriteLock(async () => {
      try {
        const db = await getLocalDb();
        const useTxn = await beginImmediate(db, 'db:refund');
        try {
          // In-SQLite-transaction re-read of the durable refund bound.
          const originalId = refundTransaction.originalTransactionId;
          // Cross-operation guard, SQLite mirror: a void that landed after
          // the Dexie gate must still refuse the payout here.
          if (originalId) {
            const stRows = (await db
              .select('SELECT status FROM transactions WHERE id = $1', [originalId])
              .catch((e: unknown) => {
                if (isBusyError(e)) throw e;
                return [];
              })) as Array<{ status?: string }>;
            if (stRows?.[0] && String(stRows[0].status ?? '') === 'VOIDED') {
              throw new Error('ORIGINAL_VOIDED');
            }
          }
          if (originalId && updatedOriginalTransaction) {
            const prior = new Map<string, number>();
            const rows = (await db
              .select("SELECT json_payload FROM transactions WHERE deleted = 0 AND json_payload LIKE '%originalTransactionId%'")
              .catch((e: unknown) => {
                if (isBusyError(e)) throw e;
                return [];
              })) as Array<{ json_payload?: string }>;
            for (const row of rows ?? []) {
              try {
                const parsed = JSON.parse(String(row.json_payload ?? '{}')) as {
                  id?: string; originalTransactionId?: string; refundedItems?: Array<{ productId?: string; quantity?: number }>;
                };
                if (parsed.originalTransactionId === originalId && parsed.id !== refundTransaction.id) {
                  for (const ri of parsed.refundedItems ?? []) {
                    if (ri.productId) {
                      prior.set(ri.productId, (prior.get(ri.productId) ?? 0) + Number(ri.quantity ?? 0));
                    }
                  }
                }
              } catch {
                // Unparseable receipt payload — ignore this row, keep the bound.
              }
            }
            assertRefundBound(prior);
          }
          // v127 heal may race a preview write on a schema-degraded DB: probe
          // the `status` column like the native engine does and degrade to the
          // legacy sold-state reset alone (telemetry never fails the refund).
          let hasImeiStatus = true;
          try {
            await db.select('SELECT status FROM imei_records LIMIT 0;');
          } catch {
            hasImeiStatus = false;
          }
          for (const release of imeiReleases(restoredImeis, defectiveImeis)) {
            const imei = release.imei;
            try {
              if (hasImeiStatus) {
                await db.execute(
                  'UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, status = $2, version = version + 1 WHERE imei = $1',
                  [imei, release.status]
                );
              } else {
                await db.execute(
                  'UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = $1',
                  [imei]
                );
              }
            } catch (imeiErr) {
              const msg = `[db:refund] IMEI ${imei} resté 'sold' dans SQLite (miroir Dexie libéré) — re-synchroniser manuellement.`;
              console.warn(msg, imeiErr);
              warnings.push(msg);
            }
            // UPGRADE-08 — ownership ledger: the refund moved this unit into
            // its post-sale state (stock or quarantine). Best-effort +
            // idempotent (logged only, never pushed to `warnings` — the
            // money-path guarantee is the sold-state reset).
            try {
              await db.execute(
                `INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note)
                 VALUES ($1, $2, $3, 'order', $4, $5, '', $6)`,
                [
                  imeiTrustEventId(release.kind, 'order', refundTransaction.id, imei),
                  imei,
                  release.kind,
                  refundTransaction.id,
                  new Date().toISOString(),
                  release.note,
                ]
              );
            } catch (evtErr) {
              console.warn('[db:refund] ownership ledger append skipped:', evtErr);
            }
          }
          if (useTxn) {
            await db.execute('COMMIT;');
          }
        } catch (txnErr) {
          if (useTxn) {
            await db.execute('ROLLBACK;').catch(() => {});
          }
          throw txnErr;
        }
      } catch (err) {
        if (err instanceof Error && (err.message === 'ALREADY_PROCESSING' || err.message.startsWith('REFUND_EXCEEDS') || err.message === 'ORIGINAL_VOIDED' || err.message === 'ZERO_REFUNDABLE' || err.message === 'CASH_CAP_EXCEEDED' || err.message === 'OFFLINE_REMOTE_TICKET' || err.message === 'NO_OPEN_SHIFT')) {
          throw err;
        }
        if (isBusyError(err)) throw err;
        const msg = '[db:refund] Connexion SQLite indisponible — libérations IMEI non répercutées (miroir Dexie libéré).';
        console.warn(msg, err);
        warnings.push(msg);
      }
          }),
        { attempts: 6, baseDelayMs: 80, label: 'refund' },
      );
    }

    for (const imei of [...restoredImeis, ...defectiveImeis]) {
      const rec = await dexieDb.imeiRecords.get(imei);
      if (rec) void fireSync('imei', imei, rec);
    }

    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (enrichedRefundAudit) void fireSync('audit_log', enrichedRefundAudit.id, enrichedRefundAudit);
    return warnings.length > 0 ? { warnings } : {};
    } finally {
      refundInFlight.delete(flightKey);
    }
  },
};
