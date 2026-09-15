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
import { getLocalDb } from '../sqlPluginAdapter';

export const operationsAdapter = {
  // ── REPAIRS ──
  async saveRepairOrder(repair: RepairOrder): Promise<void> {
    await dexieDb.repairOrders.put(repair);
    void fireSync('repair_order', repair.id, repair);
  },

  async getAllRepairOrders(): Promise<RepairOrder[]> {
    return await dexieDb.repairOrders.toArray();
  },

  async deleteRepairOrder(id: string): Promise<void> {
    await dexieDb.repairOrders.delete(id);
    void fireSyncDelete('repair_order', id);
  },

  // ── PURCHASE ORDERS ──
  async savePurchaseOrder(po: PurchaseOrder): Promise<void> {
    await dexieDb.purchaseOrders.put(po);
    void fireSync('purchase_order', po.id, po);
  },

  async getAllPurchaseOrders(): Promise<PurchaseOrder[]> {
    return await dexieDb.purchaseOrders.toArray();
  },

  // ── TRADE-INS ──
  async saveTradeIn(trade: TradeInItem): Promise<void> {
    await dexieDb.tradeIns.put(trade);
    void fireSync('trade_in', trade.id, trade);
  },

  async getAllTradeIns(): Promise<TradeInItem[]> {
    return await dexieDb.tradeIns.toArray();
  },

  // ── IMEI RECORDS ──
  async saveIMEIRecord(record: IMEIRecord): Promise<void> {
    await dexieDb.imeiRecords.put(record);
    void fireSync('imei', record.imei, record);
  },

  async getAllIMEIRecords(): Promise<IMEIRecord[]> {
    return await dexieDb.imeiRecords.toArray();
  },

  // ── AUDIT LOGS ──
  async saveAuditLog(entry: SecurityAuditLogEntry): Promise<void> {
    const safeEntry: SecurityAuditLogEntry = {
      id: entry.id || `audit-${Date.now()}`,
      timestamp: entry.timestamp || new Date().toISOString(),
      user: entry.user || 'Yacine (Admin)',
      action: entry.action || 'ACTION',
      details: entry.details || '',
      requiresPin: Boolean(entry.requiresPin),
    };
    await dexieDb.securityAuditLogs.put(safeEntry);
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        await db.execute(
          `INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [safeEntry.id, safeEntry.timestamp, safeEntry.user, safeEntry.action, safeEntry.details, safeEntry.requiresPin ? 1 : 0],
        );
      } catch (err) {
        console.warn('[db:audit] Failed to persist audit log to SQLite:', err);
      }
    }
    void fireSync('audit_log', safeEntry.id, safeEntry);
  },

  async getAllAuditLogs(): Promise<SecurityAuditLogEntry[]> {
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        const rows = (await db.select(
          'SELECT id, timestamp, user, action, details, requires_pin FROM security_audit_logs ORDER BY timestamp DESC LIMIT 300'
        )) as Array<{
          id: string;
          timestamp: string;
          user: string;
          action: string;
          details: string;
          requires_pin: number;
        }>;
        if (rows && rows.length > 0) {
          return rows.map((r) => ({
            id: r.id,
            timestamp: r.timestamp,
            user: r.user,
            action: r.action,
            details: r.details,
            requiresPin: Boolean(r.requires_pin),
          }));
        }
      } catch (err) {
        console.warn('[db:audit] SQLite query failed, falling back to Dexie:', err);
      }
    }
    return await dexieDb.securityAuditLogs.toArray();
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
    if (!key.startsWith('sync.')) void fireSync('setting', key, { key, value });
  },

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const item = await dexieDb.appSettings.get(key);
    if (item && item.value !== undefined) {
      return item.value as T;
    }
    return fallback;
  },
};

