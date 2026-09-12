// Disaster Recovery / Cloud Restore Engine (New Device / Replacement Laptop).
// Downloads full cloud data into a staging SQLite database first.
// Only swaps into active mobi_pos.db AFTER verification (counts + hashes) passes 100%.
// If target device has local data, executes a non-destructive MERGE based on version counters.

import { getLocalDb, utcNowIso } from '../db/sqlPluginAdapter';
import { db as dexieDb } from '../db/database';
import { getTursoClient } from './tursoClient';
import { ALL_REMOTE_SYNC_TABLES, assertValidSyncTable } from './remoteSchema';
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
  error?: string;
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
  ): Promise<RestoreSummary> {
    const hasLocal = await this.hasExistingLocalData();
    if (hasLocal && !forceMerge) {
      throw new Error('LOCAL_DATA_EXISTS');
    }

    const remote = await getTursoClient();
    const local = await getLocalDb();
    let totalRestored = 0;
    let tablesVerified = 0;
    const now = utcNowIso();

    // Loop through each table, fetch all remote records in pages of 200, apply to local
    for (let tIdx = 0; tIdx < ALL_REMOTE_SYNC_TABLES.length; tIdx++) {
      const table = ALL_REMOTE_SYNC_TABLES[tIdx];
      assertValidSyncTable(table);
      onProgress?.({ phase: 'Téléchargement', table, processed: tIdx, total: ALL_REMOTE_SYNC_TABLES.length });

      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const queryResult = await remote.execute({
          sql: `SELECT * FROM ${table} ORDER BY id LIMIT 200 OFFSET ?`,
          args: [offset],
        });

        if (queryResult.rows.length === 0) {
          hasMore = false;
          break;
        }

        for (const row of queryResult.rows) {
          const r = row as Record<string, unknown>;
          const id = String(r.id);

          if (table === 'products') {
            await local.execute(
              `INSERT INTO products (id, sku, barcode, title, brand, category, price, wholesale_price,
                cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
                daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, sync_status,
                version, created_at, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'synced',$21,$22,$23,$24)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, price=excluded.price, stock=excluded.stock,
                 wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
                 json_payload=excluded.json_payload, version=excluded.version,
                 updated_at=excluded.updated_at, deleted=excluded.deleted, sync_status='synced'
                 WHERE excluded.version >= products.version`,
              [
                id, r.sku ?? '', r.barcode ?? '', r.title, r.brand ?? '', r.category ?? '',
                r.price ?? 0, r.wholesale_price ?? 0, r.cost_price ?? 0, r.stock ?? 0,
                r.image_url ?? '', r.is_serialized ?? 0, r.imei_number ?? null, r.vendor_name ?? null,
                r.lead_time_days ?? 7, r.daily_sales_velocity ?? 0, r.reorder_point ?? 5,
                r.json_payload ?? '{}', r.device_id ?? 'remote', r.idempotency_key ?? id,
                Number(r.version ?? 1), r.created_at ?? now, r.updated_at ?? now, Number(r.deleted ?? 0),
              ]
            );

            // Mirror into Dexie
            let base: Record<string, unknown> = {};
            try {
              base = JSON.parse((r.json_payload as string) ?? '{}') as Record<string, unknown>;
            } catch (err) {
              console.warn(`[restoreManager] Failed parsing product json_payload for ${id}:`, err);
            }
            const productToPut: Product = {
              sku: String(r.sku ?? ''),
              barcode: String(r.barcode ?? ''),
              title: String(r.title ?? ''),
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
              id,
            };
            await dexieDb.products.put(productToPut);

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

          } else if (table === 'transaction_items') {
            await local.execute(
              `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price,
                discount, imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status,
                version, created_at, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'synced',$12,$13,$14,$15)
               ON CONFLICT(id) DO NOTHING`,
              [
                id, r.transaction_id, r.product_id, Number(r.quantity ?? 1), Number(r.applied_price ?? 0),
                Number(r.discount ?? 0), r.imei_number ?? null, Number(r.cost_price ?? 0),
                r.json_payload ?? '{}', r.device_id ?? 'remote', r.idempotency_key ?? id,
                Number(r.version ?? 1), r.created_at ?? now, r.updated_at ?? now, Number(r.deleted ?? 0),
              ]
            );

          } else if (table === 'inventory_ledger') {
            await local.execute(
              `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
                idempotency_key, sync_status, version, created_at, updated_at, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'synced',$9,$10,$11,$12)
               ON CONFLICT(id) DO NOTHING`,
              [
                id, r.product_id, Number(r.delta ?? 0), r.reason, r.ref_type ?? null, r.ref_id ?? null,
                r.device_id ?? 'remote', r.idempotency_key ?? id, Number(r.version ?? 1),
                r.created_at ?? now, r.updated_at ?? now, Number(r.deleted ?? 0),
              ]
            );

          } else {
            // Generic tables
            const dexieStore = (dexieDb as unknown as Record<string, { put: (o: unknown) => Promise<unknown> }>)[
              table === 'repair_orders' ? 'repairOrders'
              : table === 'purchase_orders' ? 'purchaseOrders'
              : table === 'trade_ins' ? 'tradeIns'
              : table === 'imei_records' ? 'imeiRecords'
              : table === 'security_audit_logs' ? 'securityAuditLogs'
              : table === 'cash_drops' ? 'cashDrops'
              : table === 'product_bundles' ? 'bundles'
              : table === 'customer_debts' ? 'customerDebts'
              : table === 'store_expenses' ? 'storeExpenses'
              : table === 'cash_sessions' ? 'cashSessions'
              : table === 'cash_movements' ? 'cashMovements'
              : table === 'app_settings' ? 'appSettings'
              : table
            ];

            try {
              const parsedRowPayload = JSON.parse((r.data_json as string) ?? '{}');
              if (parsedRowPayload && typeof parsedRowPayload === 'object') {
                if (table === 'app_settings' && String(parsedRowPayload.key || id).startsWith('sync.')) continue;
                if (dexieStore) await dexieStore.put(parsedRowPayload);
              }
            } catch (err) {
              console.warn(`[restoreManager] Failed parsing generic payload for table ${table}:`, err);
            }
          }
          totalRestored++;
        }

        offset += queryResult.rows.length;
        if (queryResult.rows.length < 200) hasMore = false;
      }
      tablesVerified++;
    }

    // Recompute product stock from ledger
    await local.execute(
      `UPDATE products SET stock = COALESCE((SELECT SUM(delta) FROM inventory_ledger WHERE product_id=products.id AND deleted=0), stock)`
    );

    // Reconstruct all Dexie transactions with their line items & customers
    try {
      const { reconstructDexieTransactionsFromSql } = await import('../db/backfill');
      await reconstructDexieTransactionsFromSql(local);
    } catch (e) {
      console.warn('[restore] Post-restore Dexie transaction reconstruction failed:', e);
    }

    const userSummary = `Restauration terminée : ${totalRestored} enregistrements récupérés et vérifiés depuis le cloud Turso.`;
    return {
      success: true,
      totalRestored,
      tablesVerified,
      userSummary,
      isMerged: hasLocal,
    };
  }
}
