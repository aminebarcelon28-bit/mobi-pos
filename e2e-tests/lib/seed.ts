/**
 * Direct better-sqlite3 seeding / resetting — mirrors the SQL the app's own
 * seed command uses (verified against `src-tauri/src/e2e.rs`), but executed
 * OUT-OF-BAND from Node, per the harness mandate.
 *
 * Every seeded row gets a deterministic idempotency_key so repeated seeds
 * never collide and app readers can recognize test rows.
 */
import { all, db, run, tx } from './db';

export interface SeedProduct {
  id: string;
  title: string;
  priceDa: number;
  stock: number;
  barcode?: string;
  category?: string;
  costDa?: number;
  /** Serialized device (one IMEI per unit) — REF-10 lane. */
  isSerialized?: boolean;
  imeiNumber?: string;
}

export interface SeedCustomer {
  id: string;
  name: string;
  phone: string;
}

/**
 * Bulk catalogue rows for the read-lane row-cap probe. Executed out-of-band
 * (host better-sqlite3), so seeding never depends on the renderer pool — which
 * matters once that pool is read-only.
 */
export function seedBulkProducts(count: number, prefix = 'SEC2-B-'): void {
  tx((d) => {
    const ins = d.prepare(
      `INSERT INTO products (id, sku, barcode, title, brand, category, price, stock, json_payload, updated_at, idempotency_key)
       VALUES (?, ?, ?, ?, 'Bulk', 'Test', 100, 0, '{}', datetime('now','utc'), ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    for (let x = 1; x <= count; x += 1) {
      const id = `${prefix}${x}`;
      ins.run(id, id, `SEC2B${x}`, `Bulk ${x}`, `e2e-bulk-${id}`);
    }
  });
}

export function deleteBulkProducts(prefix = 'SEC2-B-'): number {
  return run('DELETE FROM products WHERE id LIKE ?', `${prefix}%`).changes;
}

export function seedProducts(products: SeedProduct[]): void {
  tx((d) => {
    const insProd = d.prepare(
      `INSERT INTO products
       (id, sku, barcode, title, brand, compatible_model, category,
        price, wholesale_price, cost_price, stock, image_url, json_payload, updated_at,
        idempotency_key, is_serialized, imei_number)
       VALUES (@id, @id, @barcode, @title, '', NULL, @category, @price, 0, @cost, @stock, NULL, '{}',
        datetime('now','utc'), 'e2e-prod-' || @id, @isSerialized, @imeiNumber)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price,
        stock=excluded.stock, barcode=excluded.barcode, category=excluded.category,
        cost_price=excluded.cost_price, idempotency_key=excluded.idempotency_key,
        is_serialized=excluded.is_serialized, imei_number=excluded.imei_number`,
    );
    const insLedger = d.prepare(
      `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id,
        device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version)
       VALUES ('E2E-BASE-' || @id, @id, @stock, 'SEED', 'seed', @id,
        'e2e-seed', 'e2e-base-' || @id, 'pending', datetime('now','utc'), datetime('now','utc'), 0, 1)
       ON CONFLICT(id) DO UPDATE SET delta=excluded.delta`,
    );
    // A serialized fixture is only internally consistent when every unit on
    // hand has its own IMEI row — `stock: 5` with one record is exactly what
    // G-05 reports as "serialized units untracked", and every PSER-style
    // fixture in the suite had that shape, so the invariant fired on the
    // FIXTURE at the end of each run. Rows are derived from the product's own
    // IMEI (trailing digits incremented) and inserted DO NOTHING: an explicit
    // `seedImeiRecords()` call after this one still owns the status.
    // A serialized product with NO declared IMEI is left alone — that is the
    // deliberate [G-05-NC] negative control (NC-G05: stock 2, zero records).
    const insImei = d.prepare(
      `INSERT INTO imei_records
        (imei, product_id, purchase_order_id, sale_transaction_id, warranty_expires_at,
         received_at, sold_at, version, warranty_months, status)
       VALUES (@imei, @pid, NULL, NULL, NULL, @received, NULL, 1, 12, 'in_stock')
       ON CONFLICT(imei) DO NOTHING`,
    );
    for (const p of products) {
      insProd.run({
        id: p.id,
        barcode: p.barcode ?? p.id,
        title: p.title,
        category: p.category ?? 'Test',
        price: p.priceDa,
        cost: p.costDa ?? 0,
        stock: p.stock,
        isSerialized: p.isSerialized ? 1 : 0,
        imeiNumber: p.imeiNumber ?? null,
      });
      if (p.stock > 0) insLedger.run({ id: p.id, stock: p.stock });
      if (p.isSerialized && p.stock > 0 && p.imeiNumber) {
        const base = p.imeiNumber.trim();
        const received = new Date().toISOString();
        for (let unit = 0; unit < p.stock; unit += 1) {
          insImei.run({ imei: derivedImei(base, unit), pid: p.id, received });
        }
      }
    }
  });
}

/** IMEI for unit `n` of a serialized fixture: the declared IMEI itself for
 *  unit 0, then the trailing digits incremented (a numeric IMEI stays numeric,
 *  anything else gets a `-n` suffix). Only ever used for seed rows. */
function derivedImei(base: string, unit: number): string {
  if (unit === 0) return base;
  const m = /^(.*?)(\d+)$/.exec(base);
  if (!m) return `${base}-${unit + 1}`;
  const width = m[2].length;
  const next = (BigInt(m[2]) + BigInt(unit)).toString().padStart(width, '0');
  return `${m[1]}${next}`;
}

export function seedCustomers(customers: SeedCustomer[]): void {
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
       VALUES (@id, @name, @phone, '{}', datetime('now','utc'), 'e2e-cust-' || @id)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone`,
    );
    for (const c of customers) stmt.run(c);
  });
}

/** Full customer seed: wallet credit + debt/limit (PAY batch).
 *  currentDebt/debtLimit live ONLY in json_payload (customerAdapter.ts
 *  `getAllCustomers` SELECT has no current_debt column; `...base` spread
 *  carries payload fields). store_credit column wins when non-null. */
export interface SeedCustomerFull {
  id: string;
  name: string;
  phone: string;
  storeCreditDa?: number;
  currentDebtDa?: number;
  debtLimitDa?: number;
  loyaltyPoints?: number;
  /** Optional `customers.loyalty_points` COLUMN value. The app adapter maps
   *  the column first (customerAdapter.ts:245), so a payload-only seed leaves
   *  the POS seeing 0 points. Use this to mirror the real shape written by
   *  `customerAdapter.saveCustomer` (:96-97), which persists both.
   *  Defaults to 0 (previous payload-only behaviour). */
  loyaltyPointsColumnDa?: number;
  /** Optional override for the `customers.current_debt` COLUMN when it must
   *  differ from the payload value. Defaults to `currentDebtDa`.
   *
   *  Two legitimate uses:
   *  - modelling an UPGRADING device: the ledger + payload carry the real
   *    receivable while the column lags at 0 (the pre-2026-10-30 sale path
   *    never advanced it, P2-7). The reader must take the ledger
   *    (`customerAdapter.getAllCustomers` ledger-first read) and the boot
   *    heal must repair the cache.
   *  - asserting the cache is NOT the authority in a given path. */
  currentDebtColumnDa?: number;
  /** Cumulative spend driving tier progression (customers.total_spent). */
  totalSpentDa?: number;
  /** Tier name mirrored into the JSON payload (loyalty_tier is payload-only). */
  loyaltyTier?: string;
  /** Dated FIFO point buckets (expiry/LOY-07 data shape). */
  pointBuckets?: unknown[];
  /** PVC / digital loyalty-card barcode resolved by the wedge scanner. */
  loyaltyCardCode?: string;
  /** Generic scan barcode (QR/PVC payload) resolved by the wedge scanner. */
  barcode?: string;
}

export function seedCustomerFull(customers: SeedCustomerFull[]): void {
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO customers (id, name, phone, store_credit, current_debt, loyalty_points,
         total_spent, loyalty_card_code, barcode, json_payload, updated_at, idempotency_key)
       VALUES (@id, @name, @phone, @credit, @debt, @points, @spent, @card, @barcode, @payload,
         datetime('now','utc'), 'e2e-cust-' || @id)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone,
         store_credit=excluded.store_credit, current_debt=excluded.current_debt,
         loyalty_points=excluded.loyalty_points, total_spent=excluded.total_spent,
         loyalty_card_code=excluded.loyalty_card_code, barcode=excluded.barcode,
         json_payload=excluded.json_payload, updated_at=excluded.updated_at`,
    );
    for (const c of customers) {
      stmt.run({
        id: c.id,
        name: c.name,
        phone: c.phone,
        credit: c.storeCreditDa ?? 0,
        debt: c.currentDebtColumnDa ?? c.currentDebtDa ?? 0,
        points: c.loyaltyPointsColumnDa ?? 0,
        spent: c.totalSpentDa ?? 0,
        card: c.loyaltyCardCode ?? null,
        barcode: c.barcode ?? null,
        payload: JSON.stringify({
          id: c.id,
          name: c.name,
          phone: c.phone,
          storeCredit: c.storeCreditDa ?? 0,
          currentDebt: c.currentDebtDa ?? 0,
          debtLimit: c.debtLimitDa ?? 100000,
          loyaltyPoints: c.loyaltyPoints ?? 0,
          totalSpent: c.totalSpentDa ?? 0,
          loyaltyTier: c.loyaltyTier ?? 'Bronze',
          ...(c.pointBuckets ? { pointBuckets: c.pointBuckets } : {}),
          ...(c.loyaltyCardCode ? { loyaltyCardCode: c.loyaltyCardCode } : {}),
          ...(c.barcode ? { barcode: c.barcode } : {}),
        }),
      });
    }
  });
}

/** Debt-ledger seed (Kredy MNY-25 / REF-66 lanes): one `customer_debts` row
 *  per entry, mirroring the app's own INSERT column set
 *  (customerAdapter.ts `saveCustomerDebt` :375-395). The ledger is the
 *  authority the Kredy surfaces read: `customerDebtMetaMap` gates the card's
 *  expand toggle on `meta.totalMovements > 0` (KredyTab.tsx:1012) and the
 *  invariant harness derives the ledger balance from it
 *  (invariants.ts `ledgerBalance` :121-130). */
export interface SeedCustomerDebt {
  id: string;
  customerId: string;
  customerName: string;
  type: 'DEBT_ACQUIRED' | 'PAYMENT_SETTLED';
  amountDa: number;
  balanceAfterDa?: number;
  receiptNumber?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  recordedBy?: string;
  createdAt?: string;
  dueDate?: string | null;
  kind?: string;
}

export function seedCustomerDebts(rows: SeedCustomerDebt[]): void {
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after,
         receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted,
         due_date, kind)
       VALUES (@id, @cust, @name, @type, @amount, @bal, @rcpt, @pm, @notes, @by, @created, @payload, 1, @created, 0, @due, @kind)
       ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id, customer_name=excluded.customer_name,
         type=excluded.type, amount=excluded.amount, balance_after=excluded.balance_after,
         receipt_number=excluded.receipt_number, payment_method=excluded.payment_method,
         notes=excluded.notes, recorded_by=excluded.recorded_by, created_at=excluded.created_at,
         json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
         due_date=excluded.due_date, kind=excluded.kind`,
    );
    for (const r of rows) {
      const createdAt = r.createdAt ?? new Date().toISOString();
      const entry = {
        id: r.id,
        customerId: r.customerId,
        customerName: r.customerName,
        type: r.type,
        amount: r.amountDa,
        balanceAfter: r.balanceAfterDa ?? r.amountDa,
        receiptNumber: r.receiptNumber ?? null,
        paymentMethod: r.paymentMethod ?? null,
        notes: r.notes ?? null,
        recordedBy: r.recordedBy ?? 'E2E-seed',
        createdAt,
        dueDate: r.dueDate ?? null,
        kind: r.kind ?? '',
      };
      stmt.run({
        id: r.id,
        cust: r.customerId,
        name: r.customerName,
        type: r.type,
        amount: r.amountDa,
        bal: entry.balanceAfter,
        rcpt: entry.receiptNumber,
        pm: entry.paymentMethod,
        notes: entry.notes,
        by: entry.recordedBy,
        created: createdAt,
        payload: JSON.stringify(entry),
        due: entry.dueDate,
        kind: entry.kind,
      });
    }
  });
}

/** Credit-voucher (gift card / bon d'avoir) seed — matches the columns the
 *  adapter reads (voucherAdapter.findCreditVoucherByCode: `WHERE UPPER(code)
 *  = ? AND deleted = 0`). DELETE-by-code first so stale ids never collide on
 *  the UNIQUE(code) lane across non-wiped re-runs. */
export interface SeedVoucher {
  id: string;
  code: string;
  initialAmountDa: number;
  remainingAmountDa?: number;
  status?: string;
  expiresAt?: string | null;
  customerName?: string;
}

export function seedCreditVouchers(vouchers: SeedVoucher[]): void {
  tx((d) => {
    const del = d.prepare('DELETE FROM credit_vouchers WHERE code = ?');
    const stmt = d.prepare(
      `INSERT INTO credit_vouchers
        (id, code, initial_amount, remaining_amount, status, customer_name, device_id,
         idempotency_key, sync_status, version, created_at, updated_at, expires_at, deleted)
       VALUES (@id, @code, @init, @remaining, @status, @cust, 'e2e-seed',
         'e2e-voucher-' || @id, 'pending', 1, datetime('now','utc'), datetime('now','utc'), @expires, 0)`,
    );
    for (const v of vouchers) {
      del.run(v.code);
      stmt.run({
        id: v.id,
        code: v.code,
        init: v.initialAmountDa,
        remaining: v.remainingAmountDa ?? v.initialAmountDa,
        status: v.status ?? 'ACTIVE',
        cust: v.customerName ?? null,
        expires: v.expiresAt ?? null,
      });
    }
  });
}

/** IMEI lifecycle seed (REF-10 lane): one row per serialized unit, matching
 *  the columns the adapter reads (`imei`, `product_id`, `status`,
 *  `sale_transaction_id`, `warranty_months`, `received_at`). */
export interface SeedImeiRecord {
  imei: string;
  productId: string;
  status?: string;
  warrantyMonths?: number;
  receivedAt?: string;
}

export function seedImeiRecords(records: SeedImeiRecord[]): void {
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO imei_records
        (imei, product_id, purchase_order_id, sale_transaction_id, warranty_expires_at,
         received_at, sold_at, version, warranty_months, status)
       VALUES (@imei, @pid, NULL, NULL, NULL, @received, NULL, 1, @months, @status)
       ON CONFLICT(imei) DO UPDATE SET product_id=excluded.product_id,
         status=excluded.status, warranty_months=excluded.warranty_months`,
    );
    for (const r of records) {
      stmt.run({
        imei: r.imei,
        pid: r.productId,
        received: r.receivedAt ?? new Date().toISOString(),
        months: r.warrantyMonths ?? 12,
        status: r.status ?? 'in_stock',
      });
    }
  });
}

/** Kitting-bundle seed (MNY-30 lane): row + the ProductBundle json the store
 *  hydrates (`{ id, title, barcode, bundlePrice, childSkus }`). */
export interface SeedBundle {
  id: string;
  title: string;
  barcode: string;
  bundlePriceDa: number;
  childSkus: string[];
}

export function seedBundles(bundles: SeedBundle[]): void {
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO product_bundles
        (id, bundle_title, barcode, bundle_price, child_skus_json, json_payload, version)
       VALUES (@id, @title, @barcode, @price, @childJson, @payload, 1)
       ON CONFLICT(id) DO UPDATE SET bundle_title=excluded.bundle_title,
         barcode=excluded.barcode, bundle_price=excluded.bundle_price,
         child_skus_json=excluded.child_skus_json, json_payload=excluded.json_payload,
         version=product_bundles.version + 1`,
    );
    for (const b of bundles) {
      stmt.run({
        id: b.id,
        title: b.title,
        barcode: b.barcode,
        price: b.bundlePriceDa,
        childJson: JSON.stringify(b.childSkus),
        payload: JSON.stringify({
          id: b.id,
          title: b.title,
          barcode: b.barcode,
          bundlePrice: b.bundlePriceDa,
          childSkus: b.childSkus,
        }),
      });
    }
  });
}

export function seedShift(id: string, openingFloatDa: number, cashierName = 'E2E'): void {
  tx((d) => {
    d.prepare(
      `INSERT INTO cash_sessions
       (id, opened_at, opening_float, status, cashier_name, json_payload, updated_at)
       VALUES (@id, datetime('now','utc'), @float, 'OPEN', @cashier, '{}', datetime('now','utc'))
       ON CONFLICT(id) DO UPDATE SET opening_float=excluded.opening_float,
         status='OPEN', cashier_name=excluded.cashier_name`,
    ).run({ id, float: openingFloatDa, cashier: cashierName });
  });
}

export interface SeedBlockedImei {
  imei: string;
  reason: string;
  source?: string;
  active?: boolean;
}

/** Merchant-local blocked/stolen list (blocked_imeis, native read path). */
export function seedBlockedImeis(rows: SeedBlockedImei[]): void {
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO blocked_imeis (imei, reason, source, added_at, active)
       VALUES (@imei, @reason, @source, datetime('now','utc'), @active)
       ON CONFLICT(imei) DO UPDATE SET reason=excluded.reason, source=excluded.source,
         added_at=excluded.added_at, active=excluded.active`,
    );
    for (const r of rows) {
      stmt.run({
        imei: r.imei,
        reason: r.reason,
        source: r.source ?? 'e2e-seed',
        active: r.active === false ? 0 : 1,
      });
    }
  });
}

export function seedSettings(settings: { key: string; valueJson: string }[]): void {
  tx((d) => {
    const stmt = d.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES (@key, @value, datetime('now','utc'))
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
    );
    for (const s of settings) stmt.run({ key: s.key, value: s.valueJson });
  });
}

/**
 * Data-table reset: wipe merchant data rows, keep migration ledgers,
 * app_settings mirrors (PIN roster!) and FTS structure. Mirrors the reset
 * discipline proven in the repo (`e2e.rs::e2e_reset_db`):
 *  - `products_fts_*` shadows are NEVER deleted directly (destroys the index);
 *    deleting `products` rows triggers the FTS sync triggers instead.
 *  - `_sqlx_migrations` / `schema_migrations` are never touched (re-migration
 *    brick risk).
 */
const RESET_TABLES = [
  'sale_batch_allocations',
  'refund_dedup',
  'transaction_items',
  'transactions',
  'inventory_ledger',
  'stock_batches',
  'cash_movements',
  'cash_sessions',
  'credit_vouchers',
  'customer_debts',
  'loyalty_ledger',
  'store_expenses',
  'cash_drops',
  'repair_orders',
  'purchase_orders',
  'trade_ins',
  'imei_records',
  'security_audit_logs',
  // The chain links reference the rows above; wiping one without the other
  // leaves a dangling link and every later `audit_verify` fails closed
  // ("references missing log row"). Both go, and the sanctioned reset below
  // re-anchors the head and logs the reset as the new genesis link.
  'audit_chain',
  'held_orders',
  'warranty_claims',
  'debt_plans',
  'dunning_queue',
  'products',
  'customers',
];

function wipeDataTables(): { tables: string[]; rowsDeleted: number } {
  const cleared: string[] = [];
  let rowsDeleted = 0;
  tx((d) => {
    d.pragma('foreign_keys = OFF');
    for (const t of RESET_TABLES) {
      const exists = d
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(t);
      if (!exists) continue;
      const n = d.prepare(`DELETE FROM "${t}"`).run().changes;
      rowsDeleted += n;
      cleared.push(t);
    }
    d.prepare('DELETE FROM sqlite_sequence').run();
  });
  return { tables: cleared, rowsDeleted };
}

export interface SanctionedResetReport {
  tables: string[];
  rowsDeleted: number;
  auditEventId: string;
  auditChainLinks: number;
  priorHeadSeq: number | null;
  debtRepaired: number;
}

/**
 * THE sanctioned reset. Every spec's `before` uses this and nothing else, so
 * "isolated" and "chained" start from the same state:
 *
 *  1. wipe the data tables (audit log AND chain together — no dangling links);
 *  2. `audit_reanchor` — proves the chain is empty, retires the keystore head
 *     that belonged to the wiped chain, and appends the reset event as the new
 *     genesis link (post-reset == fresh boot; a live chain is refused natively);
 *  3. `repair_customer_debt_cache` — the E-0217 boot-heal, so a reset cannot
 *     leave a lagged debt cache either.
 *
 * Every invocation logs `[reset]` with what it did; a native refusal throws,
 * so a half-reset can never pass silently.
 */
export async function resetData(): Promise<SanctionedResetReport> {
  // The native reset commands are OperationalWrites: they are authorised
  // against the session principal, so the canonical session must exist
  // BEFORE the wipe. Completing setup / unlocking first also makes the
  // post-reset state exactly post-boot (a fresh boot is not locked).
  const { unlockIfNeeded } = await import('./pos');
  await unlockIfNeeded();
  const { invoke } = await import('./invoke');

  // The app keeps running while the harness wipes: a store tick can append an
  // audit row between the wipe and the re-anchor, and the native command then
  // refuses (AUDIT_CHAIN_NOT_EMPTY — correct, it must never re-baseline a live
  // chain). Re-wipe and try again, bounded and loud: this converges the RESET,
  // it never retries a verdict. After the last attempt the refusal propagates.
  let base = wipeDataTables();
  let reanchor: {
    eventId: string;
    chainLinks: number;
    priorHeadSeq: number | null;
  } | null = null;
  let lastRefusal = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      reanchor = await invoke<{
        eventId: string;
        chainLinks: number;
        priorHeadSeq: number | null;
      }>('audit_reanchor', { reason: 'e2e sanctioned reset' });
      break;
    } catch (e) {
      lastRefusal = String((e as Error)?.message ?? e);
      if (!/AUDIT_CHAIN_NOT_EMPTY/.test(lastRefusal) || attempt === 3) throw e;
      console.log(
        `[reset] re-anchor refused on attempt ${attempt}/3 (${lastRefusal.slice(0, 120)}) — re-wiping`,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      base = wipeDataTables();
    }
  }
  const debtRepaired = await invoke<number>('repair_customer_debt_cache');
  const report: SanctionedResetReport = {
    ...base,
    auditEventId: reanchor?.eventId ?? '',
    auditChainLinks: reanchor?.chainLinks ?? 0,
    priorHeadSeq: reanchor?.priorHeadSeq ?? null,
    debtRepaired,
  };
  console.log(
    `[reset] sanctioned: tables=${base.tables.length} rows=${base.rowsDeleted} ` +
      `auditEvent=${report.auditEventId} chain=${report.auditChainLinks} ` +
      `priorHead=${report.priorHeadSeq ?? 'none'} debtRepaired=${debtRepaired}`,
  );
  return report;
}
}

/** Remove every outbox row (sync residue from app-side backfills). */
export function clearOutbox(): number {
  const exists = db()
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_outbox'")
    .get();
  if (!exists) return 0;
  return run('DELETE FROM sync_outbox').changes;
}

/** All current product ids (for existence checks). */
export function productIds(): string[] {
  return all<{ id: string }>('SELECT id FROM products ORDER BY id').map((r) => r.id);
}
