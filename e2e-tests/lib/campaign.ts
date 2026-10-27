import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** Resolve the sandbox DB path used by the root wdio.conf.ts (.e2e flavor,
 *  real AppData under the roaming dir, isolated from production com.mobi.pos). */
export function sandboxDbPath(): string {
  const roaming =
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || require('node:os').homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'com.mobi.pos.e2e', 'mobi_pos.db');
}

export interface CampaignScenario {
  id: string;
  seed: number;
  dimensions: Record<string, unknown>;
  initialState: Record<string, unknown>;
  request: Record<string, unknown>;
  expectedOutcome: Record<string, unknown>;
  invariants: string[];
  executable: boolean;
  validity: string;
  invalidReasons: string[];
}

export function loadScenarios(file: string): CampaignScenario[] {
  const text = fs.readFileSync(file, 'utf8').trim();
  return text.split('\n').map((line) => JSON.parse(line)) as CampaignScenario[];
}

/** Open the sandbox DB with a busy timeout so concurrent app access doesn't
 *  immediately fail. Caller must close. */
export function openDb(dbPath?: string): any {
  const p = dbPath ?? sandboxDbPath();
  const db = new BetterSqlite3(p, { readonly: false, fileMustExist: false });
  db.pragma('busy_timeout = 10000');
  return db;
}

/** Seed one scenario's initial state into the sandbox DB (app must NOT hold
 *  an exclusive write lock — seed before starting the app, or between
 *  refund invocations when the app is idle). Uses deterministic ids so
 *  repeated seeds are idempotent (ON CONFLICT ... DO UPDATE). */
export function seedScenario(
  db: any,
  scen: CampaignScenario,
  nativeDeviceId?: string,
): void {
  const st: any = scen.initialState;
  const sale: any = st.sale;
  const app: any = st.app;
  const shift: any = st.shift;
  const tx = db.transaction(() => {
    // ── per-scenario cleanup: wipe any prior state for this scenario's IDs
    //    so cumulative seeding across scenarios never collides ──
    const saleId: string = sale.id;
    db.prepare(`DELETE FROM transactions WHERE id = @id`).run({ id: saleId });
    db.prepare(`DELETE FROM transaction_items WHERE transaction_id = @id`).run({ id: saleId });
    for (const ref of (st.existingRefunds ?? [])) {
      db.prepare(`DELETE FROM transactions WHERE id = @id`).run({ id: ref.id });
      db.prepare(`DELETE FROM transaction_items WHERE transaction_id = @id`).run({ id: ref.id });
      db.prepare(`DELETE FROM refund_dedup WHERE refund_id = @id`).run({ id: ref.id });
    }
    db.prepare(`DELETE FROM products WHERE id = @id`).run({ id: saleId });
    db.prepare(`DELETE FROM customers WHERE id = @id`).run({ id: sale.customer?.id ?? '' });
    db.prepare(`DELETE FROM inventory_ledger WHERE product_id = @id`).run({ id: saleId });
    if (shift?.id) db.prepare(`DELETE FROM cash_sessions WHERE id = @id`).run({ id: shift.id });
    const insProd = db.prepare(
      `INSERT INTO products (id, sku, barcode, title, brand, category, price,
        wholesale_price, cost_price, stock, image_url, json_payload, updated_at,
        idempotency_key, is_serialized, imei_number, version, sync_status, deleted)
       VALUES (@id, @id, @barcode, @title, '', @category, @price, 0, @cost, @stock,
        NULL, '{}', datetime('now','utc'), 'e2e-scen-' || @seed || '-' || @id, @isSerialized, @imei,
        1, 'pending', 0)
       ON CONFLICT(id) DO UPDATE SET stock=excluded.stock, price=excluded.price,
        cost_price=excluded.cost_price, category=excluded.category`,
    );
    for (const it of sale.items) {
      const prod: any = it.product;
      insProd.run({
        id: prod.id,
        seed: scen.seed,
        barcode: prod.sku,
        title: prod.title,
        category: prod.category ?? 'Test',
        price: prod.price,
        cost: prod.costPrice,
        stock: prod.stock,
        isSerialized: prod.isSerialized ? 1 : 0,
        imei: prod.imeiNumber ?? null,
      });
    }
    // ── customer ──
    const cust: any = sale.customer;
    if (cust && cust.id) {
      db.prepare(
        `INSERT INTO customers (id, name, phone, store_credit, current_debt, loyalty_points,
          total_spent, json_payload, updated_at, idempotency_key, version, deleted)
         VALUES (@id, @name, @phone, 0, 0, 0, 0, '{}', datetime('now','utc'),
         'e2e-scen-cust-' || @seed || '-' || @id, 1, 0)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone`,
       ).run({
         id: cust.id,
         seed: scen.seed,
         name: cust.name,
        phone: cust.phone ?? '',
      });
    }
    // ── shift / cash session ──
    if (shift && shift.id) {
      db.prepare(
        `INSERT INTO cash_sessions (id, opened_at, status, opening_float, cashier_name, json_payload, updated_at)
         VALUES (@id, @opened, 'OPEN', @float, 'E2E', '{}', datetime('now','utc'))
         ON CONFLICT(id) DO UPDATE SET status='OPEN', opened_at=excluded.opened_at`,
      ).run({
        id: shift.id,
        opened: shift.opened_at ?? sale.createdAt ?? new Date().toISOString(),
        float: shift.openingFloat ?? 0,
      });
    }
    // ── inventory ledger base (seed stock) ──
    const insLedger = db.prepare(
      `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id,
        device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version)
       VALUES ('E2E-SEED-' || @seed || '-' || @id, @id, @stock, 'SEED', 'seed', @id,
        'e2e-scen', 'e2e-seed-' || @seed || '-' || @id, 'pending', datetime('now','utc'),
        datetime('now','utc'), 0, 1)
       ON CONFLICT(id) DO UPDATE SET delta=excluded.delta`,
    );
    for (const it of sale.items) {
      const prod: any = it.product;
      if (prod.stock > 0) insLedger.run({ id: prod.id, seed: scen.seed, stock: prod.stock });
    }
    // ── the sale transaction ──
    db.prepare(
      `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, discount_total,
        total, cost_total, profit, profit_margin, pricing_tier, payment_method,
        cash_tendered, change_due, status, created_at, json_payload, device_id,
        idempotency_key, sync_status, updated_at, version, deleted,
        original_transaction_id, is_refund, shift_id, ledger_cogs_total, restored_cogs)
       VALUES (@id, @receipt, @cust, @subtotal, @discount, @total, @cost, @cost, 0,
        @tier, @method, @cash, 0, 'COMPLETED', @created, @payload, @dev,
        'e2e-scen-txn-' || @seed || '-' || @id, 'pending', datetime('now','utc'), 1, 0, NULL, 0,
        @shift, @cost, 0)
       ON CONFLICT(id) DO UPDATE SET status='COMPLETED', total=excluded.total`,
    ).run({
      id: sale.id,
      seed: scen.seed,
      receipt: sale.receiptNumber,
      cust: sale.customer?.id ?? null,
      subtotal: sale.subtotal,
      discount: sale.discountTotal,
      total: sale.total,
      cost: sale.costTotal,
      tier: sale.pricingTier ?? 'Retail',
      method: sale.paymentMethod,
      cash: sale.cashTendered,
      created: sale.createdAt,
      payload: sale.jsonPayload ?? '{}',
      // Offline: device-origin affinity — ticket device_id must equal the
      // enrolled native id, and ticket shift_id must equal active_shift_id.
      dev: (!st.app?.online && nativeDeviceId) ? nativeDeviceId : (app.deviceId ?? 'local'),
      shift: (!st.app?.online && shift?.id) ? shift.id : (shift?.id ?? null),
    });
    // ── sale items ──
    const insItem = db.prepare(
      `INSERT INTO transaction_items (id, transaction_id, product_id, quantity,
        applied_price, discount, imei_number, cost_price, unit_price_charged,
        unit_cost_at_sale, discount_amount, line_profit, sale_item_id,
        json_payload, device_id, idempotency_key, sync_status, created_at,
        updated_at, deleted, version)
       VALUES (@id, @txn, @prod, @qty, @price, 0, @imei, 0, @price, 0, 0, 0,
        @sid, '{}', @dev, 'e2e-scen-item-' || @seed || '-' || @id, 'pending', datetime('now','utc'),
        datetime('now','utc'), 0, 1)`,
    );
    for (const it of sale.items) {
      insItem.run({
        id: it.id,
        seed: scen.seed,
        txn: sale.id,
        prod: it.productId,
        qty: it.quantity,
        price: it.appliedPrice,
        imei: it.imeiNumber ?? null,
        sid: it.saleItemId,
        dev: app.deviceId ?? 'local',
      });
    }
    // ── existing refunds ──
    for (const ref of (st.existingRefunds ?? [])) {
      // refund_dedup gate row must exist BEFORE the is_refund=1 row (trigger
      // fires BEFORE INSERT and checks refund_id = NEW.id).
      db.prepare(
        `INSERT INTO refund_dedup (ticket_id, items_hash, refund_id, created_at)
         VALUES (@tid, @ih, @rid, @ct)
         ON CONFLICT(ticket_id, items_hash) DO NOTHING`,
      ).run({
        tid: sale.id,
        ih: ref.itemsHash ?? `existing-${ref.id}`,
        rid: ref.id,
        ct: ref.createdAt,
      });
      db.prepare(
        `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, discount_total,
          total, cost_total, profit, profit_margin, pricing_tier, payment_method,
          cash_tendered, change_due, status, created_at, json_payload, device_id,
          idempotency_key, sync_status, updated_at, version, deleted,
          original_transaction_id, is_refund, shift_id, ledger_cogs_total, restored_cogs)
         VALUES (@id, @receipt, @cust, 0, 0, @total, 0, 0, 0, 'Retail', @method,
          0, 0, 'COMPLETED', @created, @payload, @dev,
          'e2e-scen-ref-' || @seed || '-' || @id, 'pending', datetime('now','utc'), 1, 0,
          @origTxn, 1, @shift, 0, 0)`,
      ).run({
        id: ref.id,
        seed: scen.seed,
        receipt: ref.receiptNumber,
        cust: sale.customer?.id ?? null,
        total: ref.total,
        method: ref.refundMethod ?? 'Autre',
        created: ref.createdAt,
        payload: JSON.stringify({
          refundMethod: ref.refundMethod ?? 'Autre',
          cashDisbursed: ref.cashDisbursed ?? 0,
          total: ref.total,
        }),
        dev: ref.deviceId ?? app.deviceId ?? 'local',
        origTxn: ref.originalTransactionId,
        shift: shift?.id ?? null,
      });
      // existing refund items → transaction_items linked to the refund txn
      let li = 0;
      for (const rit of (ref.refundedItems ?? [])) {
        db.prepare(
          `INSERT INTO transaction_items (id, transaction_id, product_id, quantity,
            applied_price, discount, imei_number, cost_price, unit_price_charged,
            unit_cost_at_sale, discount_amount, line_profit, sale_item_id,
            json_payload, device_id, idempotency_key, sync_status, created_at,
            updated_at, deleted, version)
           VALUES (@id, @txn, @prod, @qty, 0, 0, @imei, 0, 0, 0, 0, 0, @sid,
            '{}', @dev, 'e2e-scen-ritem-' || @seed || '-' || @id, 'pending', datetime('now','utc'),
            datetime('now','utc'), 0, 1)`,
        ).run({
          id: `${ref.id}-item-${li++}`,
          seed: scen.seed,
          txn: ref.id,
          prod: rit.productId,
          qty: rit.quantity,
          imei: rit.imeiNumber ?? null,
          sid: rit.saleItemId ?? null,
          dev: ref.deviceId ?? app.deviceId ?? 'local',
        });
      }
    }
  });
  tx();
}

export interface RefundInvokeResult {
  ok: boolean;
  code: string;
  value?: unknown;
}
