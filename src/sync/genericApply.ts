// Generic-KV apply: the ONE place a remote generic row becomes local state.
//
// H25: the restore path (restoreManager) used to write generic rows into the
// Dexie UI replica ONLY, while the live pull path (SyncManager.applyRemoteRow)
// also mirrored `customers` / `customer_debts` into local SQLite and advanced
// the `entity_keys` version clock. After a cloud restore the generic row
// therefore existed in the UI replica while the SQLite authority — and the
// version clock the push lane reads — had no record of it. The restore also
// advanced `sync.cursor.<table>` past those rows, so the live pull would never
// revisit them. The first local edit of a restored row then bumped the clock
// from the empty-state default (1) to 2 and pushed against a remote row sitting
// at version 5: the guarded upsert matched ZERO rows, the batch still reported
// success, and the outbox row was marked synced — the edit was silently lost
// (contract C6). This module exists so the restore path and the pull path can
// never diverge again: they call the same function.
//
// Law (playbook §5): all SQL lives in Rust-side adapters / this TS seam; the
// webview never writes to both stores. Money is never touched here — generic
// KV rows carry `data_json` plus scalar columns only.

import type Database from '@tauri-apps/plugin-sql';
// busyRetry import moved to sqlPluginAdapter
import { db as dexieDb } from '../db/database';
import type { CreditVoucher, Customer, LoyaltyLedgerEntry } from '../types/pos';
import { sanitizeSyncPayload, utcNowIso, isDeviceLocalSettingKey, RECEIPT_SETTINGS_KEY, isRetryableDbError } from '../db/sqlPluginAdapter';
import { batchClampNeedsObservation, observeVersionConflict } from './conflictWatch';
import { tiedVersionGuardSql } from './causalVersion';
import { tombstoneVersionPredicate } from './causalVersion';

/** Singular push entity_type -> plural remote KV table. */
export const GENERIC_TABLES: Record<string, string> = {
  customer: 'customers',
  repair_order: 'repair_orders',
  purchase_order: 'purchase_orders',
  trade_in: 'trade_ins',
  imei: 'imei_records',
  audit_log: 'security_audit_logs',
  cash_drop: 'cash_drops',
  bundle: 'product_bundles',
  customer_debt: 'customer_debts',
  store_expense: 'store_expenses',
  cash_session: 'cash_sessions',
  cash_movement: 'cash_movements',
  setting: 'app_settings',
  stock_batches: 'stock_batches',
  credit_voucher: 'credit_vouchers',
};

/** Plural remote KV table -> Dexie store. */
export const GENERIC_PULL: Record<string, { dexie: string }> = {
  customers: { dexie: 'customers' },
  repair_orders: { dexie: 'repairOrders' },
  purchase_orders: { dexie: 'purchaseOrders' },
  trade_ins: { dexie: 'tradeIns' },
  imei_records: { dexie: 'imeiRecords' },
  security_audit_logs: { dexie: 'securityAuditLogs' },
  cash_drops: { dexie: 'cashDrops' },
  product_bundles: { dexie: 'bundles' },
  customer_debts: { dexie: 'customerDebts' },
  store_expenses: { dexie: 'storeExpenses' },
  cash_sessions: { dexie: 'cashSessions' },
  cash_movements: { dexie: 'cashMovements' },
  app_settings: { dexie: 'appSettings' },
  stock_batches: { dexie: 'stockBatches' },
  credit_vouchers: { dexie: 'creditVouchers' },
};

// H12: the pull-side watermark lives in `entity_keys`, whose key is the
// singular push `entity_type` — not the plural remote KV table name the pull
// loop passes around. Invert GENERIC_TABLES once at module load.
export const GENERIC_ENTITY_BY_TABLE: Record<string, string> = Object.fromEntries(
  Object.entries(GENERIC_TABLES).map(([entityType, table]) => [table, entityType]),
);

type DexieStore = {
  get?: (k: string) => Promise<Record<string, unknown> | undefined>;
  put: (o: unknown) => Promise<unknown>;
  delete: (k: string) => Promise<void>;
};

/**
 * H22 residue: tombstone writes may only be swallowed when the local table
 * itself predates the lane (schema missing = nothing to tombstone). BUSY / FK
 * / constraint failures must THROW so the pull cursor holds behind the row
 * (C6) instead of silently skipping a deletion from the SQLite authority —
 * the UI/authority split H22 was written to kill, on the delete path.
 */
function isSchemaMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table|no such column|has no column/i.test(msg);
}

function dexieStoreFor(table: string): DexieStore | null {
  const name = GENERIC_PULL[table]?.dexie;
  if (!name) return null;
  const store = (dexieDb as unknown as Record<string, DexieStore>)[name];
  return store ?? null;
}

/**
 * `imei_records` warranty-anchor columns present on THIS database.
 *
 * `warranty_months` only exists from migration 107 and `warranty_expires_at` from
 * the base schema. A pull that names a column the local DB does not have throws
 * `no such column`, which would abort the whole device lane — so the anchor
 * columns are probed once per database handle and only written when present.
 * Keyed by handle, not a single module-level cache, so two databases in one
 * process (a test double and the real one) cannot inherit each other's answer.
 */
const imeiAnchorColumnsByDb = new WeakMap<Database, Promise<Set<string>>>();
function imeiAnchorColumnsPresent(db: Database): Promise<Set<string>> {
  let probed = imeiAnchorColumnsByDb.get(db);
  if (!probed) {
    probed = db
      .select("SELECT name FROM pragma_table_info('imei_records')")
      .then((rows) => {
        const names = new Set((rows as Array<{ name?: string }>).map((r) => String(r?.name ?? '')));
        names.delete('');
        return names;
      })
      // An unreadable schema must not abort the pull: assume the legacy shape and
      // write the columns that have existed since the base migration.
      .catch(() => new Set(['imei', 'product_id', 'sale_transaction_id', 'warranty_expires_at', 'received_at']));
    imeiAnchorColumnsByDb.set(db, probed);
  }
  return probed;
}

/**
 * A peer's warranty term, or NULL. Never invented and never widened: a
 * non-finite, negative or non-numeric value is DROPPED so the resolver falls back
 * to what it can prove locally. `0` is preserved — it is the documented encoding
 * of "deliberately sold with no warranty", not "unknown".
 */
function coerceAnchorMonths(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** A peer's frozen warranty expiry, or NULL. An unparseable instant is dropped. */
function coerceAnchorInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(new Date(trimmed).getTime())) return null;
  return trimmed;
}

/**
 * H11/H12: the highest version ever applied to a (table, id). This is the
 * watermark the stale-echo guard must compare against. Returns 0 when no clock
 * row exists yet (a first-ever write, which always applies).
 *
 * Why `entity_keys` and not the lane table: the push clock (H10) bumps
 * `entity_keys.version` and stamps it into the payload. Reading the lane table
 * is only valid for lanes whose local SQLite table has an `id` PRIMARY KEY
 * column — `imei_records` (PK `imei`) and `app_settings` (PK `key`) have no
 * `id` column, and the 11 lanes that never mirror into SQLite have no local
 * row at all. `entity_keys` is the one clock every lane funnels through.
 */
export async function appliedGenericVersion(db: Database, table: string, id: string): Promise<number> {
  const entityType = GENERIC_ENTITY_BY_TABLE[table] ?? table;
  try {
    const rows = (await db.select(
      'SELECT version FROM entity_keys WHERE entity_type = $1 AND entity_id = $2',
      [entityType, id],
    )) as Array<{ version: number }>;
    return Number(rows?.[0]?.version ?? 0);
  } catch (err) {
    // P0-3: BUSY/stale-txn is transient lock contention, NOT "nothing
    // recorded" — swallowing it as version 0 lets a stale row/tombstone
    // apply over newer local state. Rethrow retryables so the caller retries
    // instead of forging a clean read.
    if (isRetryableDbError(err)) throw err;
    // Pre-migration-4 databases have no `version` column on entity_keys yet
    // (bumpEntityVersion self-heals it on the next push). A missing clock
    // means "nothing recorded yet", so the row applies.
    console.warn(`[sync:watermark] Failed to read ${entityType}.${id}:`, err);
    return 0;
  }
}

/**
 * H13: advance the local version clock to at least the version just applied.
 * The clock is bumped on PUSH only, so without this a pulled v3 row leaves the
 * local clock at 1; the next local edit emits v2, the remote
 * `WHERE excluded.version >= <remote>.version` guard matches no rows, the batch
 * still reports success and the outbox row is marked synced — the edit is
 * silently lost (C6). Monotonic by construction (`MAX`).
 */
export async function advanceEntityClockOnPull(db: Database, table: string, id: string, version: number): Promise<void> {
  const entityType = GENERIC_ENTITY_BY_TABLE[table] ?? table;
  const safeVersion = Number(version) || 1;
  try {
    await db.execute(
      `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(entity_type, entity_id) DO UPDATE
       SET version = MAX(excluded.version, entity_keys.version)`,
      [entityType, id, `pull-${entityType}-${id}`, safeVersion],
    );
  } catch (err) {
    // P0-3: same transient-contention rule as the watermark read above —
    // rethrow BUSY/stale-txn so a half-advanced clock retries instead of
    // stranding the lane behind the applied row.
    if (isRetryableDbError(err)) throw err;
    // Pre-migration-4 databases have no `version` column on entity_keys yet.
    // Never block an apply because the clock could not advance — the remote
    // guard still applies.
    console.warn(`[sync:clock] Failed to advance ${entityType}.${id}:`, err);
  }
}

/**
 * Mirror a generic KV row into local SQLite. `customers`, `customer_debts`,
 * `imei_records` and `security_audit_logs` have a real local projection (they
 * are read by the reconstruction paths: transaction rebuild joins customers,
 * the debt ledger reconcile sums customer_debts, IMEI sold-state is checked
 * against SQLite, and audit readers prefer SQLite when non-empty). The other
 * lanes keep their authority in `entity_keys` (version clock) + the Dexie
 * replica. Throwing here is the correct behaviour — the caller (pull loop /
 * restore) owns the cursor and must NOT advance past a row that failed to
 * land (H21).
 */
async function mirrorGenericToSqlite(
  db: Database,
  table: string,
  id: string,
  payload: Record<string, unknown>,
  version: number,
): Promise<void> {
  if (table === 'customers') {
    const c = payload;
    const now = utcNowIso();
    // P2.3 / G1 ledger-derived balance: the scalar store_credit is
    // Last-Write-Wins across tills. From the upgrade forward every credit
    // movement carries creditDeltaDzd, anchored by a one-time genesis entry
    // freezing the pre-upgrade scalar — so the merged balance derives from
    // converged ledger inputs instead of the scalar. Without a genesis
    // anchor the scalar is trusted (legacy rows predate deltas).
    let mergedLedger: LoyaltyLedgerEntry[] = Array.isArray(
      (c as { ledger?: unknown }).ledger
    )
      ? ((c as { ledger?: LoyaltyLedgerEntry[] }).ledger as LoyaltyLedgerEntry[])
      : [];
    let storeCreditValue = Number(
      (c as { storeCredit?: unknown }).storeCredit ?? 0
    );
    try {
      const { ensureCreditGenesis, deriveStoreCreditFromLedger, creditGenesisKey } =
        await import('../utils/loyaltyEngine');
      const genesis = ensureCreditGenesis({
        id: String(id),
        storeCredit: storeCreditValue,
        loyaltyPoints: Number((c as { loyaltyPoints?: unknown }).loyaltyPoints ?? 0),
        ledger: mergedLedger,
      } as unknown as Customer);
      if (genesis) mergedLedger = [genesis, ...mergedLedger];
      if (mergedLedger.some((e) => e?.referenceId === creditGenesisKey(String(id)))) {
        storeCreditValue = deriveStoreCreditFromLedger(mergedLedger);
      }
    } catch {
      // Derivation must never block a sync apply — fall back to scalars.
    }
    // The local UNIQUE index on customers.idempotency_key rejects the ''
    // default twice: every pulled/stub row without an explicit key collides
    // with the first one. Prefer the key the authoring device embedded in the
    // payload; otherwise derive a per-row-stable fallback (never '').
    // The key is INSERT-only: updates never rewrite it, so a stub key can
    // never clobber the real row's key later.
    const custKey = String(
      (c.idempotency_key as string | undefined) ??
        (c.idempotencyKey as string | undefined) ??
        `pull-cust-${id}`
    );
    await db.execute(
      `INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted, version, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
         loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
         pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
         json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0, version=excluded.version
         WHERE excluded.version >= customers.version`,
      [
        id,
        (c.name as string) || 'Client',
        (c.phone as string) || '',
        (c.email as string) || null,
        Number(c.loyaltyPoints ?? 0),
        storeCreditValue,
        (c.pricingTier as string) || 'Retail',
        Number(c.totalSpent ?? 0),
        JSON.stringify({ ...c, ledger: mergedLedger, storeCredit: storeCreditValue }),
        (c.updatedAt as string) ?? now,
        version,
        custKey,
      ],
    );
  } else if (table === 'customer_debts') {
    // H9: the debt lane had no SQLite mirror on the pull path either, so the
    // local `version` column never advanced and the stale-echo guard was
    // inert. A reordered replay resurrected a settled balance. Mirror the row
    // into SQLite under the same version guard as customers. The parent
    // customer stub is INSERT ... DO NOTHING so a debt can land before its
    // customer row without tripping the FK.
    const d = payload;
    const now = utcNowIso();
    await db.execute(
      `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'stub-cust-' || $1)
       ON CONFLICT(id) DO NOTHING`,
      [String(d.customerId ?? id), String(d.customerName ?? 'Client'), '', JSON.stringify({ id: String(d.customerId ?? id) }), now],
    );
    await db.execute(
      `INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after,
        receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0)
       ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id, customer_name=excluded.customer_name,
        type=excluded.type, amount=excluded.amount, balance_after=excluded.balance_after,
        receipt_number=excluded.receipt_number, payment_method=excluded.payment_method,
        notes=excluded.notes, recorded_by=excluded.recorded_by, created_at=excluded.created_at,
        json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0, version=excluded.version
        WHERE excluded.version >= customer_debts.version`,
      [
        id,
        String(d.customerId ?? ''),
        String(d.customerName ?? 'Client'),
        String(d.type ?? 'DEBT_ACQUIRED'),
        Number(d.amount ?? 0),
        Number(d.balanceAfter ?? 0),
        (d.receiptNumber as string) ?? null,
        (d.paymentMethod as string) ?? null,
        (d.notes as string) ?? null,
        (d.recordedBy as string) ?? null,
        (d.createdAt as string) ?? now,
        JSON.stringify(payload),
        version,
        now,
      ],
    );
  } else if (table === 'stock_batches') {
    // H27: stock_batches is a first-class sync table whose REMOTE shape
    // (migration v6) is the generic KV pair (id, data_json), but whose LOCAL
    // shape is a real FIFO table with an ENFORCED FK (`product_id
    // REFERENCES products(id)` — PRAGMA foreign_keys=ON) and two CHECKs the
    // remote table does NOT have. Map the payload onto the real columns.
    const b = payload;
    const now = utcNowIso();
    const productId = String(b.product_id ?? b.productId ?? 'unknown');
    // Clamp the two CHECKed fields. The remote table has no CHECKs, so a
    // lost-update race between two devices depleting the same batch can push
    // a negative `quantity_remaining` to the cloud. Letting that THROW here
    // would freeze the whole stock_batches lane (H21) and silently drop every
    // LATER batch row too — a worse C6 than the one this lane exists to fix.
    // Clamp to 0, log, and let the lane converge; inventory_ledger remains
    // the authoritative movement record.
    const rawQty = Number(b.quantity_remaining ?? b.quantityRemaining ?? 0);
    const rawCost = Number(b.unit_cost ?? b.unitCost ?? 0);
    const qty = Math.max(0, rawQty);
    const cost = Math.max(0, rawCost);
    const clamped = qty !== rawQty || cost !== rawCost;
    if (clamped) {
      console.warn(`[sync:generic] stock_batches.${id} clamped (qty ${rawQty}->${qty}, cost ${rawCost}->${cost})`);
    }
    // B1: a clamp on an equal-version row is a lost-update race made
    // visible (phantom-stock suspect): both tills depleted concurrently and
    // the absolute quantities no longer reconcile. Newer-wins convergence
    // is normal and stays silent. Best-effort, never blocks the lane.
    if (clamped) {
      try {
        const localBatchRows = (await db
          .select('SELECT version, device_id, quantity_remaining, unit_cost FROM stock_batches WHERE batch_id = $1', [id])
          .catch(() => [])) as Array<{
            version?: unknown; device_id?: unknown; quantity_remaining?: unknown; unit_cost?: unknown;
          }>;
        const localBatch = localBatchRows?.[0] ?? null;
        if (
          localBatch &&
          batchClampNeedsObservation({
            clamped: true,
            localVersion: localBatch.version,
            incomingVersion: version,
          })
        ) {
          const { usePosStore } = await import('../store/usePosStore');
          await observeVersionConflict(
            db as unknown as import('./conflictWatch').ConflictDb,
            async (action, details) => {
              await usePosStore.getState().logSecurityAction(action, details, 'Système (Sync)', false);
            },
            {
              table: 'stock_batches',
              id,
              localVersion: localBatch.version,
              incomingVersion: version,
              localDevice: localBatch.device_id,
              incomingDevice: b.device_id ?? b.deviceId,
              localPayload: {
                quantity_remaining: localBatch.quantity_remaining,
                unit_cost: localBatch.unit_cost,
              },
              incomingPayload: { quantity_remaining: rawQty, unit_cost: rawCost },
              at: utcNowIso(),
            },
          );
        }
      } catch {
        // Observation must never stall the stock_batches lane.
      }
    }
    // FK parent stub: a batch can land before its product (the purchase-order
    // lane and the product lane are separate cursors). INSERT ... DO NOTHING
    // so a later real product row replaces the stub — the same pattern the
    // customer_debts lane uses for customers.
    await db.execute(
      `INSERT INTO products (id, sku, barcode, title, brand, category, price,
        cost_price, stock, json_payload, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT(id) DO NOTHING`,
      [productId, '', '', productId, 'Autre', 'Tous les produits', 0, 0, 0,
        JSON.stringify({ id: productId, stub: true }), utcNowIso()],
    );
    const batchArgs = [
      id,
      productId,
      qty,
      cost,
      String(b.received_at ?? b.receivedAt ?? now),
      (b.purchase_order_id ?? b.purchaseOrderId ?? null) as string | null,
      String(b.device_id ?? b.deviceId ?? 'remote'),
      String(b.idempotency_key ?? b.idempotencyKey ?? `pull-stock_batch-${id}`),
      version,
      String(b.created_at ?? b.createdAt ?? now),
      String(b.updated_at ?? b.updatedAt ?? now),
      Number(b.deleted ?? 0),
      // Edge B: shadow linkage travels with the row so a peer that receives
      // the invoice can reconcile too. Missing on pre-link rows → null/0.
      (b.shadow_sale_id ?? b.shadowSaleId ?? null) as string | null,
      (b.shadow_item_id ?? b.shadowItemId ?? null) as string | null,
      Number(b.shadow_qty ?? b.shadowQty ?? 0),
      Number(b.shadow_resolved ?? b.shadowResolved ?? 0),
    ];
    try {
      await db.execute(
        `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
          received_at, purchase_order_id, device_id, idempotency_key, sync_status,
          version, created_at, updated_at, deleted,
          shadow_sale_id, shadow_item_id, shadow_qty, shadow_resolved)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'synced', $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT(batch_id) DO UPDATE SET product_id=excluded.product_id,
           quantity_remaining=excluded.quantity_remaining,
           unit_cost=CASE WHEN excluded.unit_cost > 0 THEN excluded.unit_cost ELSE stock_batches.unit_cost END,
           received_at=COALESCE(excluded.received_at, stock_batches.received_at),
           purchase_order_id=COALESCE(excluded.purchase_order_id, stock_batches.purchase_order_id),
           device_id=excluded.device_id, idempotency_key=excluded.idempotency_key,
           sync_status='synced', version=excluded.version, updated_at=excluded.updated_at,
           deleted=excluded.deleted,
            shadow_sale_id=excluded.shadow_sale_id, shadow_item_id=excluded.shadow_item_id,
            shadow_qty=excluded.shadow_qty, shadow_resolved=excluded.shadow_resolved
            WHERE ${tiedVersionGuardSql('stock_batches')}`,
        batchArgs,
      );
    } catch (schemaErr) {
      // Pre-heal local table without the Edge-B link columns: persist the
      // money/state columns with the legacy shape instead of freezing the
      // whole stock_batches lane (H21). The shadow linkage itself only
      // matters once the heal has run (which the boot probe enforces).
      if (!isSchemaMissingError(schemaErr)) throw schemaErr;
      console.warn('[sync:generic] stock_batches shadow columns missing locally — legacy apply');
      await db.execute(
        `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
          received_at, purchase_order_id, device_id, idempotency_key, sync_status,
          version, created_at, updated_at, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'synced', $9, $10, $11, $12)
         ON CONFLICT(batch_id) DO UPDATE SET product_id=excluded.product_id,
           quantity_remaining=excluded.quantity_remaining,
           unit_cost=CASE WHEN excluded.unit_cost > 0 THEN excluded.unit_cost ELSE stock_batches.unit_cost END,
           received_at=COALESCE(excluded.received_at, stock_batches.received_at),
           purchase_order_id=COALESCE(excluded.purchase_order_id, stock_batches.purchase_order_id),
            device_id=excluded.device_id, idempotency_key=excluded.idempotency_key,
            sync_status='synced', version=excluded.version, updated_at=excluded.updated_at,
            deleted=excluded.deleted
            WHERE ${tiedVersionGuardSql('stock_batches')}`,
        batchArgs.slice(0, 12),
      );
    }
    // Edge B: pulled SHADOW rows are pending-COGS markers, never sellable
    // stock — keep them out of the Dexie UI mirror (SQLite authority only).
    if (String(b.purchase_order_id ?? b.purchaseOrderId ?? '') === 'SHADOW') {
      return;
    }
  } else if (table === 'credit_vouchers') {
    // H29: credit_vouchers is a first-class sync table whose REMOTE shape
    // (migration v7) is the generic KV pair (id, data_json), but whose LOCAL
    // shape is a real voucher table with two CHECKs the remote table does NOT
    // have (`initial_amount >= 0`, `remaining_amount >= 0`) plus a NOT NULL
    // `code`. Map the payload onto the real columns. The version guard is the
    // same one every other lane uses (stale-echo rejection).
    const vc = payload;
    const now = utcNowIso();
    // Clamp the two CHECKed fields. The remote table has no CHECKs, so a
    // lost-update race between two devices spending the same voucher can push
    // a negative `remaining_amount` to the cloud. Letting that THROW here would
    // freeze the whole credit_vouchers lane (H21) and silently drop every LATER
    // voucher row too — a worse C6 than the one this lane exists to fix. Clamp
    // to 0, log, and let the lane converge; the atomic conditional redeem in
    // voucherAdapter remains the authoritative double-spend guard.
    const rawInit = Number(vc.initial_amount ?? vc.initialAmount ?? 0);
    const rawRem = Number(vc.remaining_amount ?? vc.remainingAmount ?? 0);
    const initial = Math.max(0, rawInit);
    const remaining = Math.max(0, rawRem);
    if (initial !== rawInit || remaining !== rawRem) {
      console.warn(`[sync:generic] credit_vouchers.${id} clamped (init ${rawInit}->${initial}, remaining ${rawRem}->${remaining})`);
    }
    await db.execute(
      `INSERT INTO credit_vouchers (id, code, initial_amount, remaining_amount, status,
        customer_name, customer_phone, notes, expires_at, created_at, updated_at,
        idempotency_key, device_id, sync_status, version, deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'synced', $14, $15)
       ON CONFLICT(id) DO UPDATE SET code=excluded.code,
         initial_amount=excluded.initial_amount, remaining_amount=excluded.remaining_amount,
         status=excluded.status, customer_name=excluded.customer_name,
         customer_phone=excluded.customer_phone, notes=excluded.notes,
         expires_at=excluded.expires_at, updated_at=excluded.updated_at,
         idempotency_key=excluded.idempotency_key, device_id=excluded.device_id,
         sync_status='synced', version=excluded.version, deleted=excluded.deleted
         WHERE excluded.version >= credit_vouchers.version`,
      [
        id,
        String(vc.code ?? ''),
        initial,
        remaining,
        String(vc.status ?? 'ACTIVE'),
        (vc.customer_name ?? vc.customerName ?? null) as string | null,
        (vc.customer_phone ?? vc.customerPhone ?? null) as string | null,
        (vc.notes ?? null) as string | null,
        (vc.expires_at ?? vc.expiresAt ?? null) as string | null,
        String(vc.created_at ?? vc.createdAt ?? now),
        String(vc.updated_at ?? vc.updatedAt ?? now),
        String(vc.idempotency_key ?? vc.idempotencyKey ?? `pull-credit_voucher-${id}`),
        String(vc.device_id ?? vc.deviceId ?? 'remote'),
        version,
        Number(vc.deleted ?? 0),
      ],
    );
  } else if (table === 'imei_records') {
    // F7b: without this mirror, a peer release (void/refund) never reaches
    // the local IMEI authority — findSoldImeiStatus reads SQLite and keeps
    // reporting `sold`, blocking legitimate resale. Legacy shape enforced
    // (data_json variant does not exist on this DB — the checkout write
    // path already falls back to it).
    const m = payload;
    const imei = String((m.imei as string) ?? id ?? '');
    if (!imei) return;
    const now = utcNowIso();

    // Point-in-time warranty anchoring (migration 107) must survive the pull.
    // The term/expiry are minted at sale and deliberately NEVER recomputed, so
    // dropping them here would make a peer device resolve its coverage from the
    // CATALOG instead — re-dating (or voiding) a warranty the customer already
    // bought, silently, on whichever device pulled the row.
    //
    // They are written on INSERT only. The conflict branch below does not touch
    // them: a locally frozen anchor is stronger evidence than a peer row, and
    // with the shared merchant sync token a peer may rewrite anything it likes
    // (Tier B residual). Widening local coverage from the wire is the one update
    // direction this lane must never take.
    const anchorCols = await imeiAnchorColumnsPresent(db);
    const cols = ['imei', 'product_id', 'sale_transaction_id', 'sold_at', 'received_at', 'version'];
    const vals: unknown[] = [
      imei,
      String((m.product_id as string) ?? (m.productId as string) ?? ''),
      ((m.sale_transaction_id ?? m.saleTransactionId ?? null) as string | null),
      ((m.sold_at ?? m.soldAt ?? null) as string | null),
      String((m.received_at ?? m.receivedAt ?? now)),
      version,
    ];
    if (anchorCols.has('warranty_expires_at')) {
      cols.push('warranty_expires_at');
      vals.push(coerceAnchorInstant(m.warranty_expires_at ?? m.warrantyExpiresAt));
    }
    if (anchorCols.has('warranty_months')) {
      cols.push('warranty_months');
      vals.push(coerceAnchorMonths(m.warranty_months ?? m.warrantyMonths));
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await db.execute(
      `INSERT INTO imei_records (${cols.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT(imei) DO UPDATE SET sale_transaction_id=excluded.sale_transaction_id,
         sold_at=excluded.sold_at, product_id=excluded.product_id,
         received_at=excluded.received_at, version=excluded.version
         WHERE excluded.version >= imei_records.version`,
      vals as never[],
    );
  } else if (table === 'security_audit_logs') {
    // F7b: audit readers prefer SQLite when non-empty, so peer entries were
    // invisible on Tauri until mirrored here.
    //
    // Phase 4.5 evidence freeze: INSERT-only (ON CONFLICT DO NOTHING). Pulled
    // rows are PEER evidence, never locally chained — the audit chain binds
    // only rows written by native audit_append, and verify walks the links,
    // not the table. Version-guarded DO UPDATE (the norm for merchant-data
    // lanes) would let a peer — or anyone holding the shared merchant sync
    // token (Tier B residual: the server validates nothing) — REWRITE an
    // existing row's action/details, including a locally chained row, which
    // would then fail chain verification. Audit entries are immutable by
    // design (same id = same payload), so first-write-wins converges replays
    // with no loss, and no pulled row can ever mutate local evidence.
    //
    // FT-06/C provenance: pulled rows land with source='peer' (never the
    // envelope's marker, even if a peer claims otherwise) so the journal
    // labels them as unverified peer history, like imported rows.
    const a = payload;
    const now = utcNowIso();
    try {
      await db.execute(
        `INSERT INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, version, device_id, ip_address, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'peer')
         ON CONFLICT(id) DO NOTHING`,
        [
          id,
          String((a.timestamp as string) ?? now),
          String((a.user as string) ?? (a.userId as string) ?? 'Système'),
          String((a.action as string) ?? ''),
          String((a.details as string) ?? ''),
          Number((a.requiresPin as number) ?? 0),
          version,
          String((a.deviceId as string) ?? ''),
          String((a.ipAddress as string) ?? ''),
        ],
      );
    } catch (auditErr: unknown) {
      const errStr = String(auditErr);
      if (errStr.includes('device_id') || errStr.includes('ip_address') || errStr.includes('source')) {
        await db.execute('ALTER TABLE security_audit_logs ADD COLUMN device_id TEXT;').catch(() => {});
        await db.execute('ALTER TABLE security_audit_logs ADD COLUMN ip_address TEXT;').catch(() => {});
        await db.execute("ALTER TABLE security_audit_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'local';").catch(() => {});
        await db.execute(
          `INSERT INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, version, device_id, ip_address, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'peer')
           ON CONFLICT(id) DO NOTHING`,
          [
            id,
            String((a.timestamp as string) ?? now),
            String((a.user as string) ?? (a.userId as string) ?? 'Système'),
            String((a.action as string) ?? ''),
            String((a.details as string) ?? ''),
            Number((a.requiresPin as number) ?? 0),
            version,
            String((a.deviceId as string) ?? ''),
            String((a.ipAddress as string) ?? ''),
          ],
        );
      } else {
        throw auditErr;
      }
    }
  } else if (table === 'app_settings') {
    // Store-profile lane (store name, receipt template, VAT rate, cashier
    // roster…): sync.* cursor/state keys are filtered upstream, everything
    // else is merchant data that must converge precisely. Payload shape is
    // {key, value} (operationsAdapter.setSetting); mirror the value into the
    // SQLite authority under the same version guard as every other lane so a
    // stale echo can never roll back a newer local edit.
    const now = utcNowIso();
    let value = (payload as Record<string, unknown>).value ?? null;
    // F3-coverage: printer routing names per-device printers — the push side
    // strips it, and applying a routing-less row verbatim would wipe the
    // local printer names. Preserve the local routing block on merge.
    if (id === RECEIPT_SETTINGS_KEY && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      try {
        const local = (await db.select(
          "SELECT value_json FROM app_settings WHERE key = 'mobi_pos_receipt_settings'"
        ).catch(() => [])) as Array<{ value_json?: string }>;
        const rawLocal = local?.[0]?.value_json;
        if (typeof rawLocal === 'string' && rawLocal) {
          const localRouting = (JSON.parse(rawLocal) as Record<string, unknown>)?.printerRouting;
          if (localRouting !== undefined) {
            value = { ...(value as Record<string, unknown>), printerRouting: localRouting };
            (payload as Record<string, unknown>).value = value;
          }
        }
      } catch {
        // keep incoming on read/parse error
      }
    }
    await db.execute(
      `INSERT INTO app_settings (key, value_json, updated_at, version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
         updated_at=excluded.updated_at, version=excluded.version
         WHERE excluded.version >= app_settings.version`,
      [id, JSON.stringify(value), now, version],
    ).catch((err: unknown) => {
      console.warn(`[sync:generic] Failed to mirror app_settings.${id}:`, err);
    });
  }
}

/**
 * Apply one remote generic-KV row to BOTH stores (SQLite authority + Dexie UI
 * replica) and advance the version clock. Shared by the live pull path and the
 * cloud-restore path so they can never diverge (H25).
 *
 * Returns true when the row was applied (or deliberately ignored as stale),
 * false is never returned — a row that cannot be applied THROWS so the caller
 * freezes the cursor (H21) instead of advancing past a lost row (C6).
 *
 * `opts.skipDexie` is for tests/hostile environments where the Dexie replica is
 * unavailable; production paths leave it false.
 */
export async function applyGenericRemoteRow(
  db: Database,
  table: string,
  row: Record<string, unknown>,
  opts: { skipDexie?: boolean } = {},
): Promise<void> {
  const version = Number(row.version ?? 1);
  const id = (row.id as string) ?? '';
  if (!id) return;

  let recordPayload: Record<string, unknown>;
  try {
    recordPayload = sanitizeSyncPayload(
      JSON.parse((row.data_json as string) ?? '{}') as Record<string, unknown>,
    );
  } catch {
    // Unparseable payload: nothing to apply. Not an error worth freezing the
    // cursor over — the row is corrupt, not missing.
    return;
  }

  // app_settings device-local keys (sync.* cursors/state, PIN/credential
  // material) never replicate — shared predicate with the push side.
  if (table === 'app_settings' && isDeviceLocalSettingKey(id)) return;
  if (table === 'app_settings' && (recordPayload.key as string)?.startsWith?.('sync.')) return;

  const isDeleted = Number(row.deleted ?? 0) === 1;

  // H19: a tombstone must clear the same stale-echo guard the upsert path
  // uses. The guard runs BEFORE any delete so a STALE tombstone (v2) arriving
  // after a NEWER local upsert (v5) cannot delete the Dexie record while the
  // guarded SQLite upsert rejects the same row (UI/authority split).
  const applied = await appliedGenericVersion(db, table, id);
  if (applied > 0 && applied > version) {
    return; // Local version is newer — stale echo, ignore.
  }
  // H13: applying the row (or its tombstone) must advance the local clock so a
  // later local re-create pushes strictly above it.
  await advanceEntityClockOnPull(db, table, id, version);

  if (isDeleted) {
    // SQLite tombstone mirroring covers every lane that HAS a SQLite mirror
    // (customers, customer_debts, stock_batches — the three lanes
    // mirrorGenericToSqlite writes). All other lanes are Dexie-only by design
    // (authority = entity_keys clock + Dexie replica) and stay as-is: their
    // tombstone is the Dexie delete below.
    if (table === 'customers') {
      // A2: version-predicated tombstone — a stale delete arriving after a
      // newer local edit must not delete the row (TOCTOU between the H19
      // pre-guard and this write). Delete-wins-ties keeps the outcome
      // deterministic across replicas; see tombstoneVersionPredicate().
      await db
        .execute(
          `UPDATE customers SET deleted = 1 WHERE ${tombstoneVersionPredicate('customers', 'id', '$1', '$2')}`,
          [id, version],
        )
        .catch((err: unknown) => {
          if (isSchemaMissingError(err)) {
            console.warn(`[sync:generic] Failed to tombstone customers.${id}:`, err);
            return;
          }
          throw err;
        });
    }
    if (table === 'customer_debts') {
      // A2: predicated like customers above; also stops the statement from
      // rewinding a raced-ahead clock to the tombstone's older version.
      await db.execute(`UPDATE customer_debts SET deleted = 1, version = $1, updated_at = $2 WHERE ${tombstoneVersionPredicate('customer_debts', 'id', '$3', '$1')}`, [version, utcNowIso(), id]).catch((err: unknown) => {
        if (isSchemaMissingError(err)) {
          console.warn(`[sync:generic] Failed to tombstone customer_debts.${id}:`, err);
          return;
        }
        throw err;
      });
    }
    if (table === 'stock_batches') {
      // H27: tombstone the SQLite authority too, not just the Dexie replica —
      // otherwise FIFO depletion on the receiving device keeps consuming a
      // batch the cloud has deleted (UI/authority split).
      await db.execute(
        `UPDATE stock_batches SET deleted = 1, version = $1, updated_at = $2, sync_status = 'synced'
         WHERE ${tombstoneVersionPredicate('stock_batches', 'batch_id', '$3', '$1')}`,
        [version, utcNowIso(), id],
      ).catch((err: unknown) => {
        if (isSchemaMissingError(err)) {
          console.warn(`[sync:generic] Failed to tombstone stock_batches.${id}:`, err);
          return;
        }
        throw err;
      });
    }
    if (table === 'credit_vouchers') {
      // H29: tombstone the SQLite authority too, not just the Dexie replica —
      // otherwise the voucher stays redeemable on the receiving device after the
      // cloud has deleted it (UI/authority split, double-spend risk).
      await db.execute(
        `UPDATE credit_vouchers SET deleted = 1, status = 'EXHAUSTED', version = $1, updated_at = $2, sync_status = 'synced'
         WHERE ${tombstoneVersionPredicate('credit_vouchers', 'id', '$3', '$1')}`,
        [version, utcNowIso(), id],
      ).catch((err: unknown) => {
        if (isSchemaMissingError(err)) {
          console.warn(`[sync:generic] Failed to tombstone credit_vouchers.${id}:`, err);
          return;
        }
        throw err;
      });
    }
    if (!opts.skipDexie) {
      if (table === 'cash_drops') {
        // cash_drops doubles as the payouts lane (_isPayout selects the store).
        const drops = (dexieDb as unknown as { cashDrops: DexieStore }).cashDrops;
        const payouts = (dexieDb as unknown as { payouts: DexieStore }).payouts;
        await drops?.delete(id).catch((err: unknown) => { console.warn('[sync:dexie] Failed to delete cashDrop:', err); });
        await payouts?.delete(id).catch((err: unknown) => { console.warn('[sync:dexie] Failed to delete payout:', err); });
      } else {
        const store = dexieStoreFor(table);
        await store?.delete(id).catch((err: unknown) => {
          console.warn(`[sync:dexie] Failed to delete ${table} record:`, err);
        });
      }
    }
    return;
  }

  await mirrorGenericToSqlite(db, table, id, recordPayload, version);

  if (!opts.skipDexie) {
    if (table === 'cash_drops') {
      const payouts = (dexieDb as unknown as { payouts: DexieStore }).payouts;
      const cashDrops = (dexieDb as unknown as { cashDrops: DexieStore }).cashDrops;
      if ((recordPayload as Record<string, unknown>)._isPayout) await payouts?.put(recordPayload);
      else await cashDrops?.put(recordPayload);
  } else if (table === 'stock_batches') {
      // H27: the remote data_json is snake_case and keyed by `batch_id`, but
      // the Dexie store keyPath is `batchId` and the StockBatch type is
      // camelCase (createProcurementSlice writes this exact shape). Reshape
      // explicitly — a raw put() would throw on the missing keyPath.
      const b = recordPayload;
      await dexieStoreFor(table)?.put({
        batchId: id,
        productId: String(b.product_id ?? b.productId ?? 'unknown'),
        quantityRemaining: Math.max(0, Number(b.quantity_remaining ?? b.quantityRemaining ?? 0)),
        unitCost: Math.max(0, Number(b.unit_cost ?? b.unitCost ?? 0)),
        receivedAt: String(b.received_at ?? b.receivedAt ?? utcNowIso()),
        purchaseOrderId: (b.purchase_order_id ?? b.purchaseOrderId ?? undefined) as string | undefined,
      });
    } else if (table === 'credit_vouchers') {
      // H29: the remote data_json is snake_case, but the Dexie store keyPath
      // is `id` and the CreditVoucher type is camelCase (voucherAdapter writes
      // this exact shape). Reshape explicitly — a raw put() of the snake_case
      // payload would leave the UI replica showing wrong/missing fields and
      // break findCreditVoucherByCode's Dexie fallback.
      const vc = recordPayload;
      await dexieStoreFor(table)?.put({
        id,
        code: String(vc.code ?? ''),
        initialAmount: Math.max(0, Number(vc.initial_amount ?? vc.initialAmount ?? 0)),
        remainingAmount: Math.max(0, Number(vc.remaining_amount ?? vc.remainingAmount ?? 0)),
        status: (vc.status ?? 'ACTIVE') as CreditVoucher['status'],
        customerName: (vc.customer_name ?? vc.customerName ?? undefined) as string | undefined,
        customerPhone: (vc.customer_phone ?? vc.customerPhone ?? undefined) as string | undefined,
        notes: (vc.notes ?? undefined) as string | undefined,
        createdAt: String(vc.created_at ?? vc.createdAt ?? utcNowIso()),
        updatedAt: String(vc.updated_at ?? vc.updatedAt ?? utcNowIso()),
        expiresAt: (vc.expires_at ?? vc.expiresAt ?? undefined) as string | undefined,
      });
    } else {
      const store = dexieStoreFor(table);
      if (table === 'app_settings') {
        const val = (recordPayload as Record<string, unknown>).value !== undefined ? (recordPayload as Record<string, unknown>).value : recordPayload;
        await store?.put({ key: id, value: val });
      } else if (table === 'security_audit_logs') {
        // FT-06/C: Dexie mirror of a pulled row is peer history too. Stamp
        // it here (the envelope must not be trusted for provenance) without
        // touching the SQLite freeze above — and put-if-absent, mirroring
        // the SQLite DO NOTHING: a re-pull must never overwrite local
        // evidence in either lane.
        const peerMirror = store as unknown as {
          get?: (id: string) => Promise<unknown>;
          put?: (row: unknown) => Promise<unknown>;
        };
        const existing = await peerMirror?.get?.(id).catch(() => undefined);
        if (!existing) {
          await peerMirror?.put?.({ ...(recordPayload as Record<string, unknown>), id, source: 'peer' });
        }
      } else {
        if (table === 'customers') (recordPayload as Record<string, unknown>).id = (recordPayload as Record<string, unknown>).id || id;
        await store?.put(recordPayload);
      }
    }
  }
}
