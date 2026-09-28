// Disaster Recovery / Cloud Restore Engine (New Device / Replacement Laptop).
//
// F4-honesty: despite the historical name, there is NO staging database and
// NO file swap in this path (swapStagingDatabase exists for backup-file
// flows only and has no callers here). What executeRestore does is a LIVE
// version-guarded MERGE into mobi_pos.db: every applied row goes through the
// same guarded upserts as pull (newer version wins, tombstones respected),
// preceded by a validated source check and a restorable pre-merge backup.
// A mid-restore kill therefore leaves a PARTIAL merge (resumable — rerun
// converges), never a swapped-in half file. The confirm dialog must say
// "merge", never "replace".


import { getLocalDb, utcNowIso } from '../db/sqlPluginAdapter';
import { db as dexieDb } from '../db/database';
import { getTursoClient } from './tursoClient';
import { type InArgs } from '@libsql/client';
import { ALL_REMOTE_SYNC_TABLES, assertValidSyncTable } from './remoteSchema';
// H25: the generic-KV apply path (SQLite authority + Dexie replica + version
// clock) is shared with the live pull path so the two can never diverge.
import { applyGenericRemoteRow } from './genericApply';
import type { Product, SaleTransaction } from '../types/pos';

export interface RestoreProgress {
  phase: string;
  table: string;
  processed: number;
  total: number;
}

export interface RestoreSummary {
  success: boolean;
  totalRestored: number;
  tablesVerified: number;
  userSummary: string;
  isMerged: boolean;
  /** Native pre-restore backup path (taken before any merge), when available. */
  backupPath?: string;
  error?: string;
}

/**
 * Minimal pre-merge validation of the cloud source: the remote must expose
 * the sync schema (products + transactions at least). A missing schema means
 * wrong credentials / an empty foreign DB — merging from it would advance
 * cursors past nothing and poison later pulls, so refuse loudly (C6).
 */
async function validateCloudSource(
  remote: { execute: (q: string | { sql: string; args?: InArgs }) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<void> {
  const res = await remote.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const names = new Set(res.rows.map((r) => String((r as Record<string, unknown>).name ?? '')));
  const missing = ['products', 'transactions'].filter((t) => !names.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Source cloud invalide: tables manquantes (${missing.join(', ')}). ` +
      `Vérifiez l'URL et le jeton — restauration refusée avant toute modification locale.`
    );
  }
}

export class RestoreManager {
  /**
   * Checks if local database has existing user data.
   */
  static async hasExistingLocalData(): Promise<boolean> {
    try {
      const local = await getLocalDb();
      const txnCount = ((await local.select('SELECT COUNT(*) as n FROM transactions').catch(() => [{ n: 0 }])) as Array<{ n: number }>)[0]?.n ?? 0;
      const prodCount = ((await local.select('SELECT COUNT(*) as n FROM products').catch(() => [{ n: 0 }])) as Array<{ n: number }>)[0]?.n ?? 0;
      return txnCount > 0 || prodCount > 0;
    } catch {
      const dTxns = await dexieDb.transactions.count().catch(() => 0);
      const dProds = await dexieDb.products.count().catch(() => 0);
      return dTxns > 0 || dProds > 0;
    }
  }

  /**
   * Convenience method to restore from cloud, auto-merging if local data exists.
   */
  static async restoreFromCloud(onProgress?: (p: RestoreProgress) => void): Promise<RestoreSummary> {
    return this.executeRestore(onProgress, true);
  }

  /**
   * Executes a safe restore.
   * If isNewDevice: restores through staging database.
   * If hasExistingData: merges remote records without deleting local records.
   */
  static async executeRestore(
    onProgress?: (p: RestoreProgress) => void,
    forceMerge = false,
    opts?: { skipPreBackup?: boolean },
  ): Promise<RestoreSummary> {
    const hasLocal = await this.hasExistingLocalData();
    if (hasLocal && !forceMerge) {
      throw new Error('LOCAL_DATA_EXISTS');
    }

    // Durability first: snapshot the current DB with the existing backup
    // command BEFORE any merge. A failed backup aborts the restore loudly —
    // merging without a rollback point risks silent data loss (C6).
    // Callers that already hold a fresh backup (first-sync migration) pass
    // skipPreBackup to avoid a duplicate snapshot.
    let backupPath: string | undefined;
    if (!opts?.skipPreBackup) {
      const { createPreMigrationBackup } = await import('../db/backupManager');
      const pre = await createPreMigrationBackup();
      if (!pre.success) {
        throw new Error(`Sauvegarde pré-restauration impossible (${pre.error ?? 'cause inconnue'}) — restauration refusée.`);
      }
      backupPath = pre.sqliteBackupPath ?? pre.dexieBackupSnapshot;
    }

    const remote = await getTursoClient();
    await validateCloudSource(remote);
    const local = await getLocalDb();
    let totalRestored = 0;
    let tablesVerified = 0;
    let skippedRows = 0;
    const now = utcNowIso();

    // Loop through each table, fetch all remote records in pages of 200, apply to local
    for (let tIdx = 0; tIdx < ALL_REMOTE_SYNC_TABLES.length; tIdx++) {
      const table = ALL_REMOTE_SYNC_TABLES[tIdx];
      assertValidSyncTable(table);
      onProgress?.({ phase: 'Téléchargement', table, processed: tIdx, total: ALL_REMOTE_SYNC_TABLES.length });

      let lastId = '';
      let hasMore = true;

      let maxSeenTime = '1970-01-01T00:00:00.000Z';
      let maxSeenId = '';

      while (hasMore) {
        const queryResult = await remote.execute({
          sql: `SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT 500`,
          args: [lastId],
        });

        if (queryResult.rows.length === 0) {
          hasMore = false;
          break;
        }

        for (const row of queryResult.rows) {
          const r = row as Record<string, unknown>;
          // Sanity: a row without an id can neither be keyed nor cursor-tracked.
          // Skip + count it loudly instead of writing an 'undefined' row (C6).
          const rawId = r.id;
          if (rawId === undefined || rawId === null || String(rawId).trim() === '') {
            skippedRows++;
            console.warn(`[restoreManager] Skipping ${table} row without id`);
            continue;
          }
          const id = String(rawId);
          const isDeleted = Number(r.deleted ?? 0) === 1;
          const rowUpdated = String(r.updated_at ?? '');
          if (rowUpdated > maxSeenTime || (rowUpdated === maxSeenTime && id > maxSeenId)) {
            maxSeenTime = rowUpdated;
            maxSeenId = id;
          }
          lastId = id;

          if (table === 'products') {
            await local.execute(
              `INSERT INTO products (id, sku, barcode, title, brand, compatible_model, category, price, wholesale_price,
                cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
                daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, sync_status,
                version, created_at, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'synced',$22,$23,$24,$25)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, brand=excluded.brand, compatible_model=excluded.compatible_model,
                 price=excluded.price, stock=excluded.stock,
                 wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
                 json_payload=excluded.json_payload, version=excluded.version,
                 updated_at=excluded.updated_at, deleted=excluded.deleted, sync_status='synced'
                 WHERE excluded.version >= products.version`,
              [
                id, r.sku ?? '', r.barcode ?? '', r.title, r.brand ?? '', r.compatible_model ?? '', r.category ?? '',
                r.price ?? 0, r.wholesale_price ?? 0, r.cost_price ?? 0, r.stock ?? 0,
                r.image_url ?? '', r.is_serialized ?? 0, r.imei_number ?? null, r.vendor_name ?? null,
                r.lead_time_days ?? 7, r.daily_sales_velocity ?? 0, r.reorder_point ?? 5,
                r.json_payload ?? '{}', r.device_id ?? 'remote', r.idempotency_key ?? id,
                Number(r.version ?? 1), r.created_at ?? now, r.updated_at ?? now, Number(r.deleted ?? 0),
              ]
            );

            // Mirror into Dexie
            if (isDeleted) {
              await dexieDb.products.delete(id).catch(() => {});
            } else {
              let base: Record<string, unknown> = {};
              try {
                base = JSON.parse((r.json_payload as string) ?? '{}') as Record<string, unknown>;
              } catch (err) {
                console.warn(`[restoreManager] Failed parsing product json_payload for ${id}:`, err);
              }
              // Remote row wins over the embedded json blob (same rule as the
              // live pull mirror): the blob may hold a pre-sale snapshot.
              const productToPut: Product = {
                ...base,
                sku: String(r.sku ?? base.sku ?? ''),
                barcode: String(r.barcode ?? base.barcode ?? ''),
                title: String(r.title ?? base.title ?? ''),
                brand: (r.brand as Product['brand']) || (base.brand as Product['brand']) || 'Autre',
                category: (r.category as Product['category']) || (base.category as Product['category']) || 'Tous les produits',
                price: Number(r.price ?? base.price ?? 0),
                wholesalePrice: Number(r.wholesale_price ?? base.wholesalePrice ?? 0),
                semiWholesalePrice: typeof base.semiWholesalePrice === 'number' ? base.semiWholesalePrice : undefined,
                costPrice: Number(r.cost_price ?? base.costPrice ?? 0),
                stock: Number(r.stock ?? base.stock ?? 0),
                imageUrl: String(r.image_url ?? base.imageUrl ?? ''),
                isSerialized: Boolean(r.is_serialized ?? base.isSerialized),
                imeiNumber: r.imei_number ? String(r.imei_number) : (base.imeiNumber as string | undefined),
                vendorName: String(r.vendor_name ?? base.vendorName ?? 'Fournisseur Général'),
                leadTimeDays: Number(r.lead_time_days ?? base.leadTimeDays ?? 7),
                dailySalesVelocity: Number(r.daily_sales_velocity ?? base.dailySalesVelocity ?? 0),
                reorderPoint: Number(r.reorder_point ?? base.reorderPoint ?? 5),
                compatibleModel: String((r.compatible_model as string) ?? base.compatibleModel ?? ''),
                id,
              };
              await dexieDb.products.put(productToPut);
            }

          } else if (table === 'transactions') {
            await local.execute(
              `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total,
                total, cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
                status, json_payload, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'synced',$19,$20,$21,$22)
                ON CONFLICT(id) DO UPDATE SET
                  status=excluded.status, total=excluded.total, json_payload=excluded.json_payload,
                  version=excluded.version, updated_at=excluded.updated_at, deleted=excluded.deleted, sync_status='synced'
                  WHERE excluded.version >= transactions.version`,
              [
                id, r.receipt_number, r.customer_id ?? null, Number(r.subtotal ?? 0), Number(r.tax ?? 0),
                Number(r.discount_total ?? 0), Number(r.total ?? 0), Number(r.cost_total ?? 0),
                Number(r.profit ?? 0), Number(r.profit_margin ?? 0), r.pricing_tier ?? 'Retail',
                r.payment_method ?? 'Espèces', Number(r.cash_tendered ?? 0), Number(r.change_due ?? 0),
                r.status ?? 'COMPLETED', r.json_payload ?? '{}', r.device_id ?? 'remote',
                r.idempotency_key ?? id, Number(r.version ?? 1), r.created_at ?? now, r.updated_at ?? now,
                Number(r.deleted ?? 0),
              ]
            );

            // Mirror transaction receipt into Dexie with receiptNumber
            if (isDeleted) {
              await dexieDb.transactions.delete(id).catch(() => {});
            } else {
              try {
                const fullTx = JSON.parse((r.json_payload as string) ?? '{}') as Partial<SaleTransaction>;
                fullTx.id = fullTx.id || id;
                fullTx.receiptNumber = fullTx.receiptNumber || (r.receipt_number as string) || id;
                fullTx.total = fullTx.total ?? Number(r.total ?? 0);
                fullTx.status = fullTx.status || (r.status as SaleTransaction['status']) || 'COMPLETED';
                fullTx.paymentMethod = fullTx.paymentMethod || (r.payment_method as SaleTransaction['paymentMethod']) || 'Espèces';
                fullTx.createdAt = fullTx.createdAt || (r.created_at as string) || now;
                await dexieDb.transactions.put(fullTx as SaleTransaction);
              } catch (err) {
                console.warn(`[restoreManager] Failed mirroring transaction into Dexie for ${id}:`, err);
              }
            }

          } else if (table === 'transaction_items') {
            const txnId = String(r.transaction_id || '');
            const prodId = String(r.product_id || 'unknown');
            await local.execute(
              `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price,
                discount, imei_number, cost_price, unit_price_charged, unit_cost_at_sale,
                discount_amount, line_profit, json_payload, device_id, idempotency_key, sync_status,
                version, created_at, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'synced',$16,$17,$18,$19)
               ON CONFLICT(id) DO NOTHING`,
              [
                id, txnId, prodId, Number(r.quantity ?? 1), Number(r.applied_price ?? 0),
                Number(r.discount ?? 0), r.imei_number ? String(r.imei_number) : null, Number(r.cost_price ?? 0),
                Number(r.unit_price_charged ?? 0), Number(r.unit_cost_at_sale ?? 0),
                Number(r.discount_amount ?? 0), Number(r.line_profit ?? 0),
                String(r.json_payload ?? '{}'), String(r.device_id ?? 'remote'), String(r.idempotency_key ?? id),
                Number(r.version ?? 1), String(r.created_at ?? now), String(r.updated_at ?? now), Number(r.deleted ?? 0),
              ]
            );

          } else if (table === 'inventory_ledger') {
            const prodId = String(r.product_id || 'unknown');
            await local.execute(
              `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
                idempotency_key, sync_status, version, created_at, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'synced',$9,$10,$11,$12)
               ON CONFLICT(id) DO NOTHING`,
              [
                id, prodId, Number(r.delta ?? 0), String(r.reason ?? 'SALE'), r.ref_type ? String(r.ref_type) : null, r.ref_id ? String(r.ref_id) : null,
                String(r.device_id ?? 'remote'), String(r.idempotency_key ?? id), Number(r.version ?? 1),
                String(r.created_at ?? now), String(r.updated_at ?? now), Number(r.deleted ?? 0),
              ]
            );

          } else {
            // H25: generic KV tables go through the ONE shared apply path
            // (SQLite authority + Dexie replica + version clock). The old
            // branch wrote the Dexie replica ONLY and advanced the cursor,
            // leaving the SQLite authority and `entity_keys` empty — the
            // first local edit then pushed a version-2 row against a remote
            // version-5 row, the guarded upsert matched ZERO rows, and the
            // edit was silently lost (C6).
            await applyGenericRemoteRow(local, table, r);
          }
          totalRestored++;
        }

        if (queryResult.rows.length < 500) hasMore = false;
      }

      // Advance table sync cursor to the latest timestamp & ID seen
      if (maxSeenTime !== '1970-01-01T00:00:00.000Z') {
        await local.execute(
          "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
          [`sync.cursor.${table}`, JSON.stringify({ time: maxSeenTime, id: maxSeenId }), now]
        ).catch(() => {});
      }

      tablesVerified++;
    }

    // Recompute product stock from ledger
    await local.execute(
      `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=products.id AND deleted=0), stock)`
    );

    // Sync recomputed product stock to Dexie immediately
    try {
      const { syncProductsFromSqlToDexie } = await import('../db/sqlPluginAdapter');
      await syncProductsFromSqlToDexie();
    } catch (stockErr) {
      console.warn('[restore] syncProductsFromSqlToDexie error:', stockErr);
    }

    // Reconstruct all Dexie transactions with their line items & customers
    try {
      const { reconstructDexieTransactionsFromSql } = await import('../db/backfill');
      await reconstructDexieTransactionsFromSql(local);
    } catch (e) {
      console.warn('[restore] Post-restore Dexie transaction reconstruction failed:', e);
    }

    const skippedNote = skippedRows > 0 ? ` (${skippedRows} ligne(s) sans identifiant ignorée(s))` : '';
    const userSummary = `Restauration terminée : ${totalRestored} enregistrements récupérés et vérifiés depuis le cloud Turso${skippedNote}.`;
    return {
      success: true,
      totalRestored,
      tablesVerified,
      userSummary,
      isMerged: hasLocal,
      backupPath,
    };
  }
}
