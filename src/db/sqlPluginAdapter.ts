// Local SQLite access via @tauri-apps/plugin-sql (all platforms incl. mobile).
// Path MUST match lib.rs: add_migrations("sqlite:mobi_pos.db", ...).
// Checkout code must use these helpers inside a single transaction:
//   order + items + ledger deltas + outbox rows + cached stock update.

import Database from '@tauri-apps/plugin-sql';

const DB_PATH = 'sqlite:mobi_pos.db';

let cached: Database | null = null;
let columnsEnsured = false;

export async function ensureLocalSyncColumns(db: Database): Promise<void> {
  const statements = [
    'ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE transaction_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE inventory_ledger ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE customers ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE security_audit_logs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE repair_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE purchase_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE trade_ins ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE imei_records ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE cash_drops ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE product_bundles ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE customer_debts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE store_expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE cash_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE cash_movements ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE app_settings ADD COLUMN key TEXT;',
    'ALTER TABLE app_settings ADD COLUMN value_json TEXT;',
    'ALTER TABLE app_settings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE sync_outbox ADD COLUMN last_error TEXT;',
    'ALTER TABLE sync_outbox ADD COLUMN error TEXT;',
    'UPDATE app_settings SET key = id WHERE key IS NULL AND id IS NOT NULL;',
    'UPDATE app_settings SET value_json = data_json WHERE value_json IS NULL AND data_json IS NOT NULL;',
  ];
  for (const sql of statements) {
    try {
      await db.execute(sql);
    } catch {
      // Expected if column already exists on upgraded database
    }
  }
}

export async function getLocalDb(): Promise<Database> {
  if (!cached) {
    cached = await Database.load(DB_PATH);
    // Apply mandatory SQLite PRAGMAs per rules.md R3.2 / Section 10
    await cached.execute('PRAGMA journal_mode = WAL;');
    await cached.execute('PRAGMA synchronous = NORMAL;');
    await cached.execute('PRAGMA busy_timeout = 5000;');
    await cached.execute('PRAGMA foreign_keys = ON;');
  }
  if (!columnsEnsured) {
    columnsEnsured = true;
    await ensureLocalSyncColumns(cached);
  }
  return cached;
}

export function utcNowIso(): string {
  return new Date().toISOString();
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function getOrCreateDeviceId(db: Database): Promise<string> {
  const rows = (await db.select('SELECT value_json FROM app_settings WHERE key = \'sync.device_id\'')
    .catch(() => [])) as Array<{ value_json: string }>;
  if (rows?.[0]?.value_json) {
    try {
      return JSON.parse(rows[0].value_json as string) as string;
    } catch (err) {
      console.warn('[db:deviceId] Malformed device ID JSON, regenerating:', err);
    }
  }
  const id = newIdempotencyKey();
  await db.execute(
    "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ('sync.device_id', ?, ?)",
    [JSON.stringify(id), utcNowIso()],
  );
  return id;
}

export interface LedgerDeltaInput {
  productId: string;
  delta: number;
  reason: 'SALE' | 'VOID' | 'REFUND' | 'RECEIVE' | 'ADJUST' | 'SEED';
  refType: string;
  refId: string;
}

export interface CheckoutWriteInput {
  orderRow: Record<string, unknown> & { id: string };
  items: Array<Record<string, unknown> & { id: string; product_id: string }>;
  deltas: LedgerDeltaInput[];
  /** Full SaleTransaction (with items carrying product objects + tenders).
   * Stored as the canonical receipt JSON locally, in the outbox, and remotely
   * so a fresh laptop can restore complete receipts from the cloud. */
  fullTx?: Record<string, unknown>;
  /** Minimal product snapshots so ledger FK + pull cache never dangle when the
   *  legacy seed path only reached Dexie (plugin-sql migrations run fresh). */
  productSnapshots?: Array<{
    id: string; sku?: string; barcode?: string; title?: string;
    brand?: string; category?: string; price?: number;
  }>;
}

/**
 * Atomic local checkout write (OFFLINE-FIRST — never touches network):
 *  - UPSERT order + items
 *  - INSERT ledger deltas (append-only, never UPDATE stock directly)
 *  - Recompute cached products.stock = SUM(ledger) per touched product
 *  - Enqueue one sync_outbox row per entity with shared idempotency keys
 */
export async function writeCheckoutAtomic(input: CheckoutWriteInput): Promise<{ deviceId: string }> {
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();

  // Transaction rules (rules.md R3.5 / Section 10 Blocker prevention):
  // Every multi-statement write MUST be inside an explicit transaction.
  await db.execute('BEGIN IMMEDIATE TRANSACTION;');
  try {
    // Ensure referenced products exist locally (stub if seed only hit Dexie).
    // MUST run before order_items (FK product_id -> products).
    for (const p of input.productSnapshots ?? []) {
      const pId = String(p.id || `prod-${Date.now()}`);
      await db.execute(
        `INSERT OR IGNORE INTO products (id, sku, barcode, title, brand, category, price,
          wholesale_price, cost_price, stock, json_payload, device_id, idempotency_key,
          sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0,$8,$9,$10,'pending',$11,$11,0)`,
        [
          pId, p.sku ?? '', p.barcode ?? '', p.title || pId || 'Article', p.brand || 'Autre',
          p.category || 'Tous les produits', Number(p.price ?? 0), JSON.stringify(p), deviceId,
          `stub-${pId}`, now,
        ],
      );
    }

    // (Product UPSERTs are enqueued after the stock recompute below, so the
    // payload carries post-sale stock and rowids stay parent-first.)
    const touchedIds = [...new Set([
      ...(input.productSnapshots ?? []).map((p) => String(p.id || '')).filter(Boolean),
      ...input.deltas.map((d) => String(d.productId || '')).filter(Boolean),
    ])];

    const txId = String(input.orderRow.id || `TXN-${Date.now()}`);
    const receiptNo = String(input.orderRow.receipt_number || input.orderRow.receiptNumber || txId);
    const orderKey = String(input.orderRow.idempotency_key || newIdempotencyKey());
    const orderSync = 'pending';
    // Canonical receipt JSON: full transaction when available (restorable),
    // otherwise the partial order row.
    const receiptJson = JSON.stringify(input.fullTx ?? input.orderRow ?? { id: txId });

    await db.execute(
      `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
        cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
        status, created_at, json_payload, device_id, idempotency_key, sync_status, updated_at, deleted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,0)
       ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, total=excluded.total,
         status=excluded.status, json_payload=excluded.json_payload, updated_at=excluded.updated_at,
         sync_status='pending', idempotency_key=excluded.idempotency_key`,
      [
        txId,
        receiptNo,
        (input.orderRow.customer_id as string) ?? (input.orderRow.customerId as string) ?? null,
        Number(input.orderRow.subtotal ?? 0),
        Number(input.orderRow.tax ?? 0),
        Number(input.orderRow.discount_total ?? input.orderRow.discountTotal ?? 0),
        Number(input.orderRow.total ?? 0),
        Number(input.orderRow.cost_total ?? input.orderRow.costTotal ?? 0),
        Number(input.orderRow.profit ?? 0),
        Number(input.orderRow.profit_margin ?? input.orderRow.profitMargin ?? 0),
        String(input.orderRow.pricing_tier ?? input.orderRow.pricingTier ?? 'Retail'),
        String(input.orderRow.payment_method ?? input.orderRow.paymentMethod ?? 'Espèces'),
        Number(input.orderRow.cash_tendered ?? input.orderRow.cashTendered ?? 0),
        Number(input.orderRow.change_due ?? input.orderRow.changeDue ?? 0),
        String(input.orderRow.status ?? 'COMPLETED'),
        String(input.orderRow.created_at ?? input.orderRow.createdAt ?? now),
        receiptJson,
        deviceId,
        orderKey,
        orderSync,
        now,
      ],
    );

    for (const [idx, it] of input.items.entries()) {
      const itemId = String(it.id || `${txId}-item-${idx}`);
      const prodId = String(it.product_id || it.productId || 'unknown');
      const itemKey = String(it.idempotency_key || newIdempotencyKey());
      await db.execute(
        `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
          imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$12,0)
         ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, applied_price=excluded.applied_price,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, sync_status='pending'`,
        [
          itemId,
          txId,
          prodId,
          Number(it.quantity ?? 1),
          Number(it.applied_price ?? it.appliedPrice ?? 0),
          Number(it.discount ?? 0),
          (it.imei_number as string) ?? (it.imeiNumber as string) ?? null,
          Number(it.cost_price ?? it.costPrice ?? 0),
          JSON.stringify({ ...it, id: itemId, transaction_id: txId, product_id: prodId }),
          deviceId,
          itemKey,
          now,
        ],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'order_item',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [itemKey, itemId, JSON.stringify({ ...it, id: itemId, transaction_id: txId, product_id: prodId })],
      );

      const imeiNum = String((it.imei_number as string) ?? (it.imeiNumber as string) ?? '').trim();
      if (imeiNum) {
        const imeiData = {
          imei: imeiNum,
          product_id: prodId,
          sale_transaction_id: txId,
          sold_at: now,
          received_at: now,
          version: 1,
        };
        const imeiKey = `imei-${imeiNum}`;
        try {
          // Document-lane schema (migration v4+)
          await db.execute(
            `INSERT INTO imei_records (id, data_json, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
             VALUES ($1, $2, $3, $4, 'pending', 1, $5, $5, 0)
             ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at, sync_status='pending'`,
            [imeiNum, JSON.stringify(imeiData), deviceId, imeiKey, now],
          );
        } catch {
          // Relational schema fallback (migration v1-v3)
          try {
            await db.execute(
              `INSERT INTO imei_records (imei, product_id, sale_transaction_id, sold_at, received_at, version)
               VALUES ($1, $2, $3, $4, $4, 1)
               ON CONFLICT(imei) DO UPDATE SET sale_transaction_id=excluded.sale_transaction_id, sold_at=excluded.sold_at,
                 product_id=excluded.product_id, version=imei_records.version + 1`,
              [imeiNum, prodId, txId, now],
            );
          } catch (e: unknown) {
            console.warn('[db:imei] IMEI table record write skipped:', e);
          }
        }
        await db.execute(
          `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
           VALUES ($1,'imei',$2,'UPSERT',$3,'pending')
           ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
          [imeiKey, imeiNum, JSON.stringify(imeiData), now],
        );
      }
    }

    for (const [idx, d] of input.deltas.entries()) {
      const ledgerId = newIdempotencyKey();
      const ledgerKey = newIdempotencyKey();
      const prodId = String(d.productId || 'unknown');
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9,0)`,
        [ledgerId, prodId, Number(d.delta ?? 0), String(d.reason ?? 'SALE'), String(d.refType ?? 'order'), String(d.refId ?? `${txId}-${idx}`), deviceId, ledgerKey, now],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          ledgerKey, ledgerId,
          JSON.stringify({ id: ledgerId, product_id: prodId, delta: Number(d.delta ?? 0), reason: String(d.reason ?? 'SALE'), ref_type: String(d.refType ?? 'order'), ref_id: String(d.refId ?? `${txId}-${idx}`), device_id: deviceId, idempotency_key: ledgerKey }),
        ],
      );
    }

    // Recompute cached stock for touched products (allow-negative + alert policy).
    const touched = [...new Set(input.deltas.map((d) => String(d.productId || '')).filter(Boolean))];
    for (const pid of touched) {
      await db.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0),0),
          updated_at=$2, sync_status='pending' WHERE id=$1`,
        [pid, now],
      );
    }

    // Enqueue product UPSERTs with post-sale stock. Rowids stay parent-first
    // (products before order/items/ledger) so remote FKs resolve in batch order.
    // DO UPDATE (not NOTHING): the same product may sell twice before a push.
    for (const pid of touchedIds) {
      const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pid]).catch(() => [])) as Array<Record<string, unknown>>;
      const prow = rows?.[0];
      if (!prow) continue;
      const pkey = (prow.idempotency_key as string) || `stub-${pid}`;
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'product',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
        [pkey, pid, JSON.stringify(prow), now],
      );
    }

    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,'order',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
      [orderKey, txId, receiptJson],
    );

    await db.execute('COMMIT;');
  } catch (error) {
    await db.execute('ROLLBACK;').catch(() => {});
    throw error;
  }

  return { deviceId };
}

export async function getPendingOutbox(limit = 50): Promise<Array<Record<string, unknown>>> {
  const db = await getLocalDb();
  return (await db.select(
    `SELECT * FROM sync_outbox WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)
     ORDER BY rowid LIMIT $2`,
    [utcNowIso(), limit],
  )) as Array<Record<string, unknown>>;
}

export async function markOutbox(
  idempotencyKey: string,
  patch: { status: 'inflight' | 'pending' | 'synced' | 'failed'; retryCount?: number; nextRetryAt?: string | null; error?: string | null },
): Promise<void> {
  const db = await getLocalDb();
  if (patch.status === 'synced') {
    await db.execute('DELETE FROM sync_outbox WHERE idempotency_key=$1', [idempotencyKey]);
    return;
  }
  await db.execute(
    `UPDATE sync_outbox SET status=$1, retry_count=COALESCE($2, retry_count),
      next_retry_at=$3, last_error=$4, updated_at=$5 WHERE idempotency_key=$6`,
    [patch.status, patch.retryCount ?? null, patch.nextRetryAt ?? null, patch.error ?? null, utcNowIso(), idempotencyKey],
  );
}

/**
 * Append compensating ledger deltas (VOID / REFUND / RECEIVE / ADJUST) without
 * creating a new order. Used by void/refund/receive paths. Recomputes cached
 * stock (allow-negative policy) and enqueues outbox rows. Best-effort: throws
 * only if plugin-sql DB is unavailable (e.g. plain web preview) — callers must
 * catch and continue with the legacy Dexie path.
 */
export async function appendInventoryDeltas(
  deltas: LedgerDeltaInput[],
  opts?: { notifySync?: () => void },
): Promise<{ deviceId: string }> {
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();

  await db.execute('BEGIN IMMEDIATE TRANSACTION;');
  try {
    for (const d of deltas) {
      const ledgerId = newIdempotencyKey();
      const ledgerKey = newIdempotencyKey();
      const prodId = String(d.productId || 'unknown');
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$9,0)`,
        [ledgerId, prodId, Number(d.delta ?? 0), String(d.reason ?? 'ADJUST'), d.refType ? String(d.refType) : null, d.refId ? String(d.refId) : null, deviceId, ledgerKey, now],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          ledgerKey, ledgerId,
          JSON.stringify({ id: ledgerId, product_id: prodId, delta: Number(d.delta ?? 0), reason: String(d.reason ?? 'ADJUST'), ref_type: d.refType ?? null, ref_id: d.refId ?? null, device_id: deviceId, idempotency_key: ledgerKey }),
        ],
      );
    }
    const touched = [...new Set(deltas.map((d) => String(d.productId || '')).filter(Boolean))];
    for (const pid of touched) {
      await db.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock),
          updated_at=$2, sync_status='pending' WHERE id=$1`,
        [pid, now],
      );
    }
    for (const pid of touched) {
      const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pid]).catch(() => [])) as Array<Record<string, unknown>>;
      const prow = rows?.[0];
      if (!prow) continue;
      const pkey = (prow.idempotency_key as string) || `stub-${pid}`;
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'product',$2,'UPSERT',$3,'pending')
         ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=$4`,
        [pkey, pid, JSON.stringify(prow), now],
      );
    }
    await db.execute('COMMIT;');
  } catch (err) {
    await db.execute('ROLLBACK;').catch(() => {});
    throw err;
  }

  try {
    opts?.notifySync?.();
  } catch (err: unknown) {
    console.warn('[db:checkout] notifySync callback failed:', err);
  }
  return { deviceId };
}

export interface ProductSyncInput {
  id: string; sku?: string; barcode?: string; title: string;
  brand?: string; category?: string; price?: number; wholesalePrice?: number;
  costPrice?: number; stock?: number; imageUrl?: string; isSerialized?: boolean;
  imeiNumber?: string; vendorName?: string; leadTimeDays?: number;
  dailySalesVelocity?: number; reorderPoint?: number;
  raw?: Record<string, unknown>;
}

/**
 * Product create/edit sync (catalog manager path). Keeps the ledger as stock
 * truth: a user-edited stock becomes an ADJUST delta vs the current ledger
 * SUM (or a SEED delta for brand-new products), then the cached row and a
 * product outbox UPSERT follow. Best-effort — callers must catch.
 */
export async function syncProductUpsert(p: ProductSyncInput): Promise<void> {
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();
  const wantStock = Math.trunc(p.stock ?? 0);
  const pId = String(p.id || `prod-${Date.now()}`);
  const title = String(p.title || p.sku || pId || 'Article');
  const brand = String(p.brand || 'Autre');
  const category = String(p.category || 'Tous les produits');

  await db.execute('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const existing = (await db.select('SELECT idempotency_key, created_at FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<Record<string, unknown>>;
    const prev = existing?.[0];
    const pkey = (prev?.idempotency_key as string) || newIdempotencyKey();

    const ledgerStats = (await db.select(
      'SELECT COALESCE(SUM(delta),0) as s, COUNT(*) as n FROM inventory_ledger WHERE product_id=$1 AND deleted=0', [pId],
    ).catch(() => [{ s: 0, n: 0 }])) as Array<{ s: number; n: number }>;
    const currentSum = Number(ledgerStats?.[0]?.s ?? 0);
    const hasLedger = Number(ledgerStats?.[0]?.n ?? 0) > 0;

    await db.execute(
      `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
        cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
        daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key,
        sync_status, created_at, updated_at, deleted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pending',$21,$22,0)
       ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, title=excluded.title,
         brand=excluded.brand, category=excluded.category, price=excluded.price,
         wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
         image_url=excluded.image_url, is_serialized=excluded.is_serialized,
         imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
         lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
         reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
         updated_at=excluded.updated_at, sync_status='pending', deleted=0`,
      [
        pId, p.sku ?? '', p.barcode ?? '', title, brand, category,
        Number(p.price ?? 0), Number(p.wholesalePrice ?? 0), Number(p.costPrice ?? 0), wantStock,
        p.imageUrl ?? null, p.isSerialized ? 1 : 0, p.imeiNumber ?? null, p.vendorName ?? null,
        p.leadTimeDays ?? 7, p.dailySalesVelocity ?? 0, p.reorderPoint ?? 5,
        JSON.stringify(p.raw ?? p), deviceId, pkey, (prev?.created_at as string) ?? now, now,
      ],
    );

    // Stock truth stays in the ledger: record the user's new baseline as a delta.
    const baseline = hasLedger ? currentSum : 0;
    const adjust = wantStock - baseline;
    if (adjust !== 0) {
      const ledgerId = newIdempotencyKey();
      const ledgerKey = newIdempotencyKey();
      await db.execute(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted)
         VALUES ($1,$2,$3,'ADJUST','manual',$2,$4,$5,'pending',$6,$6,0)`,
        [ledgerId, pId, adjust, deviceId, ledgerKey, now],
      );
      await db.execute(
        `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
         VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
        [ledgerKey, ledgerId, JSON.stringify({
          id: ledgerId, product_id: pId, delta: adjust, reason: 'ADJUST',
          ref_type: 'manual', ref_id: pId, device_id: deviceId, idempotency_key: ledgerKey,
        })],
      );
      await db.execute(
        `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock),
          updated_at=$2, sync_status='pending' WHERE id=$1`,
        [pId, now],
      );
    }

    const productPayload = {
      id: pId,
      sku: p.sku ?? '',
      barcode: p.barcode ?? '',
      title,
      brand,
      category,
      price: Number(p.price ?? 0),
      wholesale_price: Number(p.wholesalePrice ?? 0),
      cost_price: Number(p.costPrice ?? 0),
      stock: wantStock,
      image_url: p.imageUrl ?? null,
      is_serialized: p.isSerialized ? 1 : 0,
      imei_number: p.imeiNumber ?? null,
      vendor_name: p.vendorName ?? null,
      lead_time_days: p.leadTimeDays ?? 7,
      daily_sales_velocity: p.dailySalesVelocity ?? 0,
      reorder_point: p.reorderPoint ?? 5,
      json_payload: JSON.stringify(p.raw ?? p),
      device_id: deviceId,
      idempotency_key: pkey,
      sync_status: 'pending',
      created_at: (prev?.created_at as string) ?? now,
      updated_at: now,
      deleted: 0,
    };

    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,'product',$2,'UPSERT',$3,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=$4`,
      [pkey, pId, JSON.stringify(productPayload), now],
    );
    await db.execute('COMMIT;');
  } catch (err) {
    await db.execute('ROLLBACK;').catch(() => {});
    throw err;
  }
}

/**
 * Bulk product create/edit sync inside chunked transactions.
 * Prevents per-product disk fsync bottlenecks when importing or batch-updating.
 */
export async function syncProductUpsertBulk(products: ProductSyncInput[]): Promise<void> {
  if (!products || products.length === 0) return;
  const db = await getLocalDb();
  const deviceId = (await getOrCreateDeviceId(db)) || 'default';
  const now = utcNowIso();

  const CHUNK_SIZE = 100;
  for (let i = 0; i < products.length; i += CHUNK_SIZE) {
    const chunk = products.slice(i, i + CHUNK_SIZE);
    await db.execute('BEGIN IMMEDIATE TRANSACTION;');
    try {
      for (const p of chunk) {
        const pId = String(p.id || `prod-${Date.now()}`);
        const title = String(p.title || p.sku || pId || 'Article');
        const brand = String(p.brand || 'Autre');
        const category = String(p.category || 'Tous les produits');
        const wantStock = Math.trunc(p.stock ?? 0);
        const existing = (await db.select('SELECT idempotency_key, created_at FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<Record<string, unknown>>;
        const prev = existing?.[0];
        const pkey = (prev?.idempotency_key as string) || newIdempotencyKey();

        const sumRows = (await db.select(
          'SELECT COALESCE(SUM(delta),0) as s FROM inventory_ledger WHERE product_id=$1 AND deleted=0', [pId],
        ).catch(() => [{ s: 0 }])) as Array<{ s: number }>;
        const hasLedger = ((await db.select(
          'SELECT COUNT(*) as n FROM inventory_ledger WHERE product_id=$1 AND deleted=0', [pId],
        ).catch(() => [{ n: 0 }])) as Array<{ n: number }>)[0]?.n > 0;
        const currentSum = Number(sumRows?.[0]?.s ?? 0);

        await db.execute(
          `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
            cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
            daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key,
            sync_status, created_at, updated_at, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'pending',$21,$22,0)
           ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, title=excluded.title,
             brand=excluded.brand, category=excluded.category, price=excluded.price,
             wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
             image_url=excluded.image_url, is_serialized=excluded.is_serialized,
             imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
             lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
             reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
             updated_at=excluded.updated_at, sync_status='pending', deleted=0`,
          [
            pId, p.sku ?? '', p.barcode ?? '', title, brand, category,
            Number(p.price ?? 0), Number(p.wholesalePrice ?? 0), Number(p.costPrice ?? 0), wantStock,
            p.imageUrl ?? null, p.isSerialized ? 1 : 0, p.imeiNumber ?? null, p.vendorName ?? null,
            p.leadTimeDays ?? 7, p.dailySalesVelocity ?? 0, p.reorderPoint ?? 5,
            JSON.stringify(p.raw ?? p), deviceId, pkey, (prev?.created_at as string) ?? now, now,
          ],
        );

        const baseline = hasLedger ? currentSum : 0;
        const adjust = wantStock - baseline;
        if (adjust !== 0) {
          const ledgerId = newIdempotencyKey();
          const ledgerKey = newIdempotencyKey();
          await db.execute(
            `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
              idempotency_key, sync_status, created_at, updated_at, deleted)
             VALUES ($1,$2,$3,'ADJUST','manual',$2,$4,$5,'pending',$6,$6,0)`,
            [ledgerId, pId, adjust, deviceId, ledgerKey, now],
          );
          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1,'ledger',$2,'UPSERT',$3,'pending') ON CONFLICT(idempotency_key) DO NOTHING`,
            [ledgerKey, ledgerId, JSON.stringify({
              id: ledgerId, product_id: pId, delta: adjust, reason: 'ADJUST',
              ref_type: 'manual', ref_id: pId, device_id: deviceId, idempotency_key: ledgerKey,
            })],
          );
          await db.execute(
            `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=$1 AND deleted=0), stock),
              updated_at=$2, sync_status='pending' WHERE id=$1`,
            [pId, now],
          );
        }

        const rows = (await db.select('SELECT * FROM products WHERE id=$1', [pId]).catch(() => [])) as Array<Record<string, unknown>>;
        if (rows?.[0]) {
          await db.execute(
            `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
             VALUES ($1,'product',$2,'UPSERT',$3,'pending')
             ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
            [pkey, pId, JSON.stringify(rows[0]), now],
          );
        }
      }
      await db.execute('COMMIT;');
    } catch (err) {
      await db.execute('ROLLBACK;').catch(() => {});
      console.warn('[sqlPluginAdapter] Bulk product sync transaction failed:', err);
    }
  }
}

/** Product delete sync: soft-delete locally + tombstone outbox op (full snapshot
 *  payload so the remote can upsert-then-tombstone even if it never saw the row). */
export async function syncProductDelete(id: string): Promise<void> {
  const db = await getLocalDb();
  const now = utcNowIso();
  const safeId = String(id || '');
  if (!safeId) return;
  const rows = (await db.select('SELECT * FROM products WHERE id=$1', [safeId]).catch(() => [])) as Array<Record<string, unknown>>;
  const pkey = (rows?.[0]?.idempotency_key as string) || `legacy-${safeId}`;
  const snapshot = { ...(rows?.[0] ?? { id: safeId }), deleted: 1, updated_at: now };
  await db.execute(
    `UPDATE products SET deleted=1, updated_at=$1, sync_status='pending' WHERE id=$2`, [now, safeId],
  ).catch((err: unknown) => {
    console.warn('[sync:soft-delete] Failed to update product deleted flag:', err);
  });
  await db.execute(
    `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES ($1,'product',$2,'DELETE',$3,'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET operation='DELETE', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
    [pkey, safeId, JSON.stringify(snapshot), now],
  );
}

/** Generic document-lane entities: full JSON in outbox payload, KV tables remotely. */
export type GenericEntity =
  | 'customer' | 'repair_order' | 'purchase_order' | 'trade_in' | 'imei' | 'audit_log'
  | 'cash_drop' | 'bundle' | 'customer_debt' | 'store_expense'
  | 'cash_session' | 'cash_movement' | 'setting';

async function stableEntityKey(
  db: { select: (sql: string, args?: unknown[]) => Promise<unknown>; execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  entity: string, id: string,
): Promise<string> {
  const safeEntity = String(entity || 'unknown');
  const safeId = String(id || 'unknown');
  // entity_keys also self-creates here so pre-v4 local DBs work with no rebuild.
  await db.execute(
    `CREATE TABLE IF NOT EXISTS entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id))`,
  ).catch((err: unknown) => {
    console.warn('[sync:entity-keys] Table init skipped:', err);
  });
  const rows = (await db.select(
    'SELECT idempotency_key FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [safeEntity, safeId],
  ).catch((err: unknown) => {
    console.warn('[sync:entity-keys] Key lookup failed:', err);
    return [];
  })) as Array<{ idempotency_key: string }>;
  if (rows?.[0]?.idempotency_key) return rows[0].idempotency_key;
  const key = newIdempotencyKey();
  await db.execute(
    'INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key) VALUES ($1,$2,$3)',
    [safeEntity, safeId, key],
  ).catch((err: unknown) => {
    console.warn('[sync:entity-keys] Key registration skipped:', err);
  });
  return key;
}

/**
 * Enqueue any entity for full cloud sync (disaster-recovery lane). The payload
 * is the complete object as JSON; remote persists it in a per-entity KV table.
 * Never throws fatally — callers still catch, but this is already defensive.
 */
export async function enqueueGenericSync(
  entity: GenericEntity, id: string, entityPayload: Record<string, unknown>,
): Promise<void> {
  const db = await getLocalDb();
  const now = utcNowIso();
  const safeId = String(id || (entityPayload?.id as string) || `${entity}-${Date.now()}`);
  const key = await stableEntityKey(db, entity, safeId);
  await db.execute(
    `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES ($1,$2,$3,'UPSERT',$4,'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$5`,
    [key, entity, safeId, JSON.stringify(entityPayload ?? {}), now],
  );
}

/** Tombstone a generic entity (soft-delete converges everywhere). */
export async function enqueueGenericDelete(entity: GenericEntity, id: string): Promise<void> {
  const db = await getLocalDb();
  const now = utcNowIso();
  const safeId = String(id || `${entity}-${Date.now()}`);
  const key = await stableEntityKey(db, entity, safeId);
  await db.execute(
    `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES ($1,$2,$3,'DELETE',$4,'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET operation='DELETE', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$5`,
    [key, entity, safeId, JSON.stringify({ id: safeId, deleted: 1 }), now],
  );
}

/**
 * Enqueue a status-change order UPSERT (VOID / REFUNDED / PARTIALLY_REFUNDED).
 * Reuses the original idempotency_key so the remote ON CONFLICT(key) DO UPDATE
 * path fires with last-write-wins (no PK clash from a fresh key).
 */
export async function enqueueOrderSync(
  orderId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = await getLocalDb();
  const now = utcNowIso();
  if (payload.status) {
    await db.execute(
      'UPDATE transactions SET status=$1, updated_at=$2 WHERE id=$3',
      [payload.status, now, orderId],
    ).catch((err: unknown) => {
      console.warn('[sync:order] Order status update failed:', err);
    });
  }
  const rows = (await db.select('SELECT idempotency_key FROM transactions WHERE id=$1', [orderId]).catch((err: unknown) => {
    console.warn('[sync:order] Idempotency key lookup failed:', err);
    return [];
  })) as Array<{ idempotency_key: string }>;
  const key = rows?.[0]?.idempotency_key || `legacy-${orderId}`;
  await db.execute(
    `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES ($1,'order',$2,'UPSERT',$3,'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$4`,
    [key, orderId, JSON.stringify({ ...payload, idempotency_key: key, updated_at: now }), now],
  );
}

export async function getSyncCursor(): Promise<string> {
  const db = await getLocalDb();
  const rows = (await db
    .select("SELECT value_json FROM app_settings WHERE key='sync.last_pull_at'")
    .catch(() => [])) as Array<{ value_json: string }>;
  try {
    if (rows?.[0]) return JSON.parse(rows[0].value_json as string) as string;
  } catch (err: unknown) {
    console.warn('[db:cursor] Failed to parse sync cursor json:', err);
  }
  return '1970-01-01T00:00:00.000Z';
}

export async function setSyncCursor(iso: string): Promise<void> {
  const db = await getLocalDb();
  await db.execute(
    "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ('sync.last_pull_at', ?, ?)",
    [JSON.stringify(iso), utcNowIso()],
  );
}
