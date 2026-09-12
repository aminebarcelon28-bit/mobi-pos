import type {
  RepairOrder,
  PurchaseOrder,
  TradeInItem,
  IMEIRecord,
  SecurityAuditLogEntry,
  ProductBundle,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete } from './base';

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
    await dexieDb.securityAuditLogs.put(entry);
    void fireSync('audit_log', entry.id, entry);
  },

  async getAllAuditLogs(): Promise<SecurityAuditLogEntry[]> {
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

