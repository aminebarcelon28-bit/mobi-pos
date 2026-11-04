import type {
  RepairOrder,
  PurchaseOrder,
  TradeInItem,
  IMEIRecord,
  SecurityAuditLogEntry,
  ProductBundle,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete, isTauriEnv } from './base';
import { getLocalDb, isDeviceLocalSettingKey, stripDeviceLocalSettingValue } from '../sqlPluginAdapter';
import { newId } from '../../utils/ids';
import { buildTradeInInspectionJson } from '../../utils/deviceTrust';
import {
  AUDIT_LEGACY_LIMIT,
  auditSelectParams,
  buildAuditSelect,
  buildLegacyAuditSelect,
  hasAuditBound,
  type AuditQueryBounds,
} from '../auditQuery';

export type { AuditQueryBounds };
export {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_LEGACY_LIMIT,
  auditSelectParams,
  buildAuditSelect,
  buildLegacyAuditSelect,
  hasAuditBound,
  isLegacyWallClock,
} from '../auditQuery';

interface AuditRow {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  requires_pin: number;
  device_id: string | null;
  ip_address: string | null;
}

function toAuditEntry(r: AuditRow): SecurityAuditLogEntry {
  return {
    id: r.id,
    timestamp: r.timestamp,
    user: r.user,
    action: r.action,
    details: r.details,
    requiresPin: Boolean(r.requires_pin),
    deviceId: r.device_id || undefined,
    ipAddress: r.ip_address || undefined,
  };
}

/** Newest-first by the string form, which is what the ISO lane relies on. */
function byNewestAudit(a: SecurityAuditLogEntry, b: SecurityAuditLogEntry): number {
  return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
}

export const operationsAdapter = {
  // ── REPAIRS ──
  async saveRepairOrder(repair: RepairOrder): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const payload = JSON.stringify(repair);
        await db.execute(
          `INSERT INTO repair_orders (id, ticket_number, customer_name, customer_phone, customer_id, device_model, imei, status, labor_cost, parts_cost, total_cost, deposit_amount, parts_cost_basis, costing_model, rework_of_repair_id, created_at, updated_at, json_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT(id) DO UPDATE SET
             ticket_number=excluded.ticket_number,
             customer_name=excluded.customer_name,
             customer_phone=excluded.customer_phone,
             customer_id=excluded.customer_id,
             device_model=excluded.device_model,
             imei=excluded.imei,
             status=excluded.status,
             labor_cost=excluded.labor_cost,
             parts_cost=excluded.parts_cost,
             total_cost=excluded.total_cost,
             deposit_amount=excluded.deposit_amount,
             parts_cost_basis=excluded.parts_cost_basis,
             costing_model=excluded.costing_model,
             rework_of_repair_id=excluded.rework_of_repair_id,
             updated_at=excluded.updated_at,
             json_payload=excluded.json_payload,
             version=repair_orders.version + 1`,
          [
            repair.id,
            repair.ticketNumber || '',
            repair.customerName || '',
            repair.customerPhone || '',
            repair.customerId || null,
            repair.deviceModel || '',
            repair.imei || null,
            repair.status || 'En attente',
            repair.laborCost || 0,
            repair.partsCost || 0,
            repair.totalCost || 0,
            repair.depositAmount || 0,
            // UPGRADE-06 mirrors of the json_payload fields. NULL on tickets
            // whose parts were consumed before the basis existed — SQL readers
            // treat NULL as "base inconnue", never as zero (the json_payload
            // stays authoritative; these columns serve SQL-side reporting).
            typeof repair.partsCostBasis === 'number' && Number.isFinite(repair.partsCostBasis)
              ? repair.partsCostBasis
              : null,
            repair.costingModel || null,
            repair.reworkOfRepairId || null,
            repair.createdAt || new Date().toISOString(),
            repair.updatedAt || new Date().toISOString(),
            payload,
          ],
        );
      } catch (err) {
        console.warn('[operationsAdapter] SQLite saveRepairOrder failed, fallback to Dexie:', err);
      }
    }
    await dexieDb.repairOrders.put(repair);
    void fireSync('repair_order', repair.id, repair);
  },

  async getAllRepairOrders(): Promise<RepairOrder[]> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select('SELECT json_payload FROM repair_orders ORDER BY created_at DESC')) as Array<{ json_payload: string }>;
        if (rows && rows.length > 0) {
          const list = rows
            .map((r) => {
              try {
                return JSON.parse(r.json_payload) as RepairOrder;
              } catch {
                return null;
              }
            })
            .filter((r): r is RepairOrder => r !== null);
          if (list.length > 0) {
            void dexieDb.repairOrders.bulkPut(list).catch(() => {});
            return list;
          }
        }
      } catch (err) {
        console.warn('[operationsAdapter] SQLite getAllRepairOrders failed, fallback to Dexie:', err);
      }
    }
    return await dexieDb.repairOrders.toArray();
  },

  async deleteRepairOrder(id: string): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        await db.execute('DELETE FROM repair_orders WHERE id = $1', [id]);
      } catch (err) {
        console.warn('[operationsAdapter] SQLite deleteRepairOrder failed:', err);
      }
    }
    await dexieDb.repairOrders.delete(id);
    void fireSyncDelete('repair_order', id);
  },

  // ── PURCHASE ORDERS ──
  async savePurchaseOrder(po: PurchaseOrder): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const payload = JSON.stringify(po);
        await db.execute(
          `INSERT INTO purchase_orders (id, po_number, vendor_name, total_amount, status, created_at, json_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT(id) DO UPDATE SET
             po_number=excluded.po_number,
             vendor_name=excluded.vendor_name,
             total_amount=excluded.total_amount,
             status=excluded.status,
             json_payload=excluded.json_payload,
             version=purchase_orders.version + 1`,
          [
            po.id,
            po.poNumber || '',
            po.vendorName || '',
            po.totalAmount || 0,
            po.status || 'Draft',
            po.createdAt || new Date().toISOString(),
            payload,
          ],
        );
      } catch (err) {
        console.warn('[operationsAdapter] SQLite savePurchaseOrder failed, fallback to Dexie:', err);
      }
    }
    await dexieDb.purchaseOrders.put(po);
    void fireSync('purchase_order', po.id, po);
  },

  async getAllPurchaseOrders(): Promise<PurchaseOrder[]> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select('SELECT json_payload FROM purchase_orders ORDER BY created_at DESC')) as Array<{ json_payload: string }>;
        if (rows && rows.length > 0) {
          const list = rows
            .map((r) => {
              try {
                return JSON.parse(r.json_payload) as PurchaseOrder;
              } catch {
                return null;
              }
            })
            .filter((p): p is PurchaseOrder => p !== null);
          if (list.length > 0) {
            void dexieDb.purchaseOrders.bulkPut(list).catch(() => {});
            return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          }
        }
      } catch (err) {
        console.warn('[operationsAdapter] SQLite getAllPurchaseOrders failed, fallback to Dexie:', err);
      }
    }
    const orders = await dexieDb.purchaseOrders.toArray();
    return orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  // ── TRADE-INS ──
  async saveTradeIn(trade: TradeInItem): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const payload = JSON.stringify(trade);
        // UPGRADE-08 — the trade-in rubric envelope (markers + verdict). The
        // column is for SQL-side reporting; the json_payload above keeps the
        // markers portable for peers. Pre-heal DBs (no column yet) fall into
        // the existing catch → Dexie fallback below, same as any new column.
        const inspectionJson = trade.inspectionMarkers
          ? buildTradeInInspectionJson(trade.inspectionMarkers, trade.conditionGrade)
          : null;
        await db.execute(
          `INSERT INTO trade_ins (id, device_model, imei, brand, condition_grade, buyback_value, resale_margin_percent, resale_price, customer_name, customer_phone, customer_id, credit_to_wallet, created_at, json_payload, inspection_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT(id) DO UPDATE SET
             device_model=excluded.device_model,
             imei=excluded.imei,
             brand=excluded.brand,
             condition_grade=excluded.condition_grade,
             buyback_value=excluded.buyback_value,
             resale_margin_percent=excluded.resale_margin_percent,
             resale_price=excluded.resale_price,
             customer_name=excluded.customer_name,
             customer_phone=excluded.customer_phone,
             customer_id=excluded.customer_id,
             credit_to_wallet=excluded.credit_to_wallet,
             json_payload=excluded.json_payload,
             inspection_json=excluded.inspection_json,
             version=trade_ins.version + 1`,
          [
            trade.id,
            trade.deviceModel || '',
            trade.imei || '',
            trade.brand || '',
            trade.conditionGrade || '',
            trade.buybackValue || 0,
            trade.resaleMarginPercent || 0,
            trade.resalePrice || 0,
            trade.customerName || '',
            trade.customerPhone || null,
            trade.customerId || null,
            trade.creditToWallet ? 1 : 0,
            trade.createdAt || new Date().toISOString(),
            payload,
            inspectionJson,
          ],
        );
      } catch (err) {
        console.warn('[operationsAdapter] SQLite saveTradeIn failed, fallback to Dexie:', err);
      }
    }
    await dexieDb.tradeIns.put(trade);
    void fireSync('trade_in', trade.id, trade);
  },

  async getAllTradeIns(): Promise<TradeInItem[]> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select('SELECT json_payload FROM trade_ins ORDER BY created_at DESC')) as Array<{ json_payload: string }>;
        if (rows && rows.length > 0) {
          const list = rows
            .map((r) => {
              try {
                return JSON.parse(r.json_payload) as TradeInItem;
              } catch {
                return null;
              }
            })
            .filter((t): t is TradeInItem => t !== null);
          if (list.length > 0) {
            void dexieDb.tradeIns.bulkPut(list).catch(() => {});
            return list;
          }
        }
      } catch (err) {
        console.warn('[operationsAdapter] SQLite getAllTradeIns failed, fallback to Dexie:', err);
      }
    }
    return await dexieDb.tradeIns.toArray();
  },

  // ── IMEI RECORDS ──
  async saveIMEIRecord(record: IMEIRecord): Promise<void> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        await db.execute(
          `INSERT INTO imei_records (imei, product_id, purchase_order_id, sale_transaction_id, warranty_expires_at, received_at, sold_at, warranty_months, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'in_stock'))
           ON CONFLICT(imei) DO UPDATE SET
             product_id=excluded.product_id,
             purchase_order_id=COALESCE(excluded.purchase_order_id, imei_records.purchase_order_id),
             sale_transaction_id=excluded.sale_transaction_id,
             warranty_expires_at=COALESCE(excluded.warranty_expires_at, imei_records.warranty_expires_at),
             received_at=COALESCE(excluded.received_at, imei_records.received_at),
             sold_at=excluded.sold_at,
             warranty_months=COALESCE(excluded.warranty_months, imei_records.warranty_months),
             status=COALESCE($9, imei_records.status),
             version=imei_records.version + 1`,
          [
            record.imei,
            record.productId || '',
            record.purchaseOrderId || null,
            record.saleTransactionId || null,
            record.warrantyExpiresAt || null,
            record.receivedAt || new Date().toISOString(),
            record.soldAt || null,
            record.warrantyMonths || null,
            record.status || null,
          ],
        );
      } catch (err) {
        console.warn('[operationsAdapter] SQLite saveIMEIRecord failed, fallback to Dexie:', err);
      }
    }
    await dexieDb.imeiRecords.put(record);
    void fireSync('imei', record.imei, record);
  },

  async getAllIMEIRecords(): Promise<IMEIRecord[]> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(
          'SELECT imei, product_id, purchase_order_id, sale_transaction_id, warranty_expires_at, received_at, sold_at, warranty_months, status FROM imei_records ORDER BY received_at DESC',
        )) as Array<{
          imei: string;
          product_id: string;
          purchase_order_id: string | null;
          sale_transaction_id: string | null;
          warranty_expires_at: string | null;
          received_at: string;
          sold_at: string | null;
          warranty_months: number | null;
          status: 'in_stock' | 'defective' | null;
        }>;
        if (rows && rows.length > 0) {
          const list: IMEIRecord[] = rows.map((r) => ({
            imei: r.imei,
            productId: r.product_id,
            purchaseOrderId: r.purchase_order_id || undefined,
            saleTransactionId: r.sale_transaction_id || undefined,
            warrantyExpiresAt: r.warranty_expires_at || undefined,
            receivedAt: r.received_at,
            soldAt: r.sold_at || undefined,
            warrantyMonths: r.warranty_months ?? undefined,
            status: r.status || undefined,
          }));
          void dexieDb.imeiRecords.bulkPut(list).catch(() => {});
          return list;
        }
      } catch (err) {
        console.warn('[operationsAdapter] SQLite getAllIMEIRecords failed, fallback to Dexie:', err);
      }
    }
    return await dexieDb.imeiRecords.toArray();
  },

  // ── AUDIT LOGS ──
  async saveAuditLog(entry: SecurityAuditLogEntry): Promise<void> {
    const { getDeviceId, getIpAddress } = await import('../../utils/deviceInfo');
    const deviceId = entry.deviceId || getDeviceId();
    const ipAddress = entry.ipAddress || await getIpAddress();

    const safeEntry: SecurityAuditLogEntry = {
      id: entry.id || newId('audit'),
      timestamp: entry.timestamp || new Date().toISOString(),
      user: entry.user || 'Admin',
      action: entry.action || 'ACTION',
      details: entry.details || '',
      requiresPin: Boolean(entry.requiresPin),
      deviceId,
      ipAddress,
      ...(entry.actorId ? { actorId: entry.actorId } : {}),
    };
    await dexieDb.securityAuditLogs.put(safeEntry);
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const baseParams = [
          safeEntry.id,
          safeEntry.timestamp,
          safeEntry.user,
          safeEntry.action,
          safeEntry.details,
          safeEntry.requiresPin ? 1 : 0,
          safeEntry.deviceId || null,
          safeEntry.ipAddress || null,
        ];
        if (safeEntry.actorId) {
          // UPGRADE-09: immutable actor id rides beside the display name. A
          // pre-v124 shape (column not healed yet) degrades to the legacy
          // INSERT instead of dropping the row — attribution-by-name only.
          try {
            await db.execute(
              `INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, device_id, ip_address, actor_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [...baseParams, safeEntry.actorId],
            );
          } catch (colErr) {
            if (!/actor_id/i.test(String(colErr))) throw colErr;
            await db.execute(
              `INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, device_id, ip_address)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              baseParams,
            );
          }
        } else {
          await db.execute(
            `INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, device_id, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            baseParams,
          );
        }
      } catch (err) {
        console.warn('[db:audit] Failed to persist audit log to SQLite:', err);
      }
    }
    void fireSync('audit_log', safeEntry.id, safeEntry);
  },

  /**
   * Read the audit register.
   *
   * `bounds` are pushed down into SQL rather than applied in memory. That is
   * the whole point of this method: the register is read with a hard
   * `LIMIT 300`, so a client-side date filter over the returned slice could
   * only ever see the newest 300 actions. A cashier asking for « la semaine
   * dernière » while 5 000 rows exist would get an empty or wrong window, and
   * no amount of in-memory filtering could recover rows that were never
   * fetched. `idx_audit_timestamp` (lib.rs) makes the bounded form a range
   * scan rather than a table scan.
   *
   * Omitting `bounds` keeps the original behaviour — newest 300, no lower or
   * upper bound — which is what « Toute la période… » means.
   */
  async getAuditLogs(bounds?: AuditQueryBounds): Promise<SecurityAuditLogEntry[]> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(
          buildAuditSelect(bounds),
          auditSelectParams(bounds),
        )) as AuditRow[];

        // Legacy wall-clock rows are outside any ISO range by construction, so
        // they are merged back in here and left to the caller's date filter —
        // which already understands them. Dropping them would make rows that
        // the previous in-memory filter could show unreachable.
        let legacy: SecurityAuditLogEntry[] = [];
        try {
          const legacyRows = (await db.select(buildLegacyAuditSelect(), [
            AUDIT_LEGACY_LIMIT,
          ])) as AuditRow[];
          legacy = legacyRows.map(toAuditEntry);
        } catch (legacyErr) {
          console.warn('[db:audit] legacy wall-clock lane unavailable:', legacyErr);
        }

        // A bounded query that legitimately matches nothing is an empty
        // register for that window, NOT a reason to fall back to Dexie (which
        // has no range semantics and would show unrelated rows).
        if (hasAuditBound(bounds) && rows.length === 0) return legacy;

        const merged = new Map<string, SecurityAuditLogEntry>();
        for (const r of rows) merged.set(r.id, toAuditEntry(r));
        for (const r of legacy) if (!merged.has(r.id)) merged.set(r.id, r);
        return Array.from(merged.values()).sort(byNewestAudit);
      } catch (err) {
        console.warn('[db:audit] SQLite query failed, falling back to Dexie:', err);
      }
    }
    return await dexieDb.securityAuditLogs.toArray();
  },

  /** Back-compat alias: the unbounded read used by the boot/hydrate paths. */
  async getAllAuditLogs(): Promise<SecurityAuditLogEntry[]> {
    return operationsAdapter.getAuditLogs();
  },

  // ── BUNDLES ──
  async saveBundle(bundle: ProductBundle): Promise<void> {
    await dexieDb.bundles.put(bundle);
    void fireSync('bundle', bundle.id, bundle);
  },

  async getAllBundles(): Promise<ProductBundle[]> {
    return await dexieDb.bundles.toArray();
  },

  async deleteBundle(id: string): Promise<void> {
    await dexieDb.bundles.delete(id);
    void fireSyncDelete('bundle', id);
  },

  // ── APP SETTINGS ──
  async setSetting<T>(key: string, value: T): Promise<void> {
    await dexieDb.appSettings.put({ key, value });
    // SQLite authority parity: readers increasingly go through the SQLite
    // lane (restore verify, boot paths), so a Dexie-only write would leave
    // the two stores diverged. Best-effort — Dexie already landed above.
    if (isTauriEnv()) {
      try {
        const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const verRows = (await db
          .select('SELECT version FROM app_settings WHERE key=$1', [key])
          .catch(() => [])) as Array<{ version: number }>;
        const nextVersion = (verRows?.length ?? 0) > 0 ? Number(verRows[0].version) + 1 : 1;
        try {
          // Native settings lane (SEC-01): sensitive keys are refused there by
          // name, so PIN/token/licence material never travels this path.
          const { invokeCommand } = await import('../../platform/invoke');
          await invokeCommand<void>('set_app_setting', {
            key,
            valueJson: JSON.stringify(value),
          });
        } catch {
          try {
            await db.execute(
              `INSERT INTO app_settings (key, value_json, updated_at, version)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
                 updated_at=excluded.updated_at, version=excluded.version`,
              [key, JSON.stringify(value), utcNowIso(), nextVersion],
            );
          } catch {
            // Fallback if version column does not exist on app_settings
            await db.execute(
              `INSERT INTO app_settings (key, value_json, updated_at)
               VALUES ($1, $2, $3)
               ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
                 updated_at=excluded.updated_at`,
              [key, JSON.stringify(value), utcNowIso()],
            );
          }
        }
      } catch (err) {
        if (isDeviceLocalSettingKey(key)) {
          console.error(`[setSetting] Failed to persist critical setting [${key}] to SQLite:`, err);
          throw err;
        }
        // Web preview / locked DB — Dexie remains the store.
      }
    }
    if (!isDeviceLocalSettingKey(key)) {
      const cleanValue = stripDeviceLocalSettingValue(key, value);
      void fireSync('setting', key, { key, value: cleanValue });
    }
  },

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const item = await dexieDb.appSettings.get(key);
    if (item && item.value !== undefined) {
      return item.value as T;
    }
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const rows = (await db.select('SELECT value_json FROM app_settings WHERE key=$1', [key]).catch(() => [])) as Array<{ value_json: string }>;
        if (rows && rows.length > 0 && rows[0]?.value_json) {
          try {
            const parsed = JSON.parse(rows[0].value_json) as T;
            await dexieDb.appSettings.put({ key, value: parsed }).catch(() => {});
            return parsed;
          } catch {}
        }
      } catch {}
    }
    return fallback;
  },
};
