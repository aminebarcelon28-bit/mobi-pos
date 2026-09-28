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
    const orders = await dexieDb.purchaseOrders.toArray();
    return orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
    const { getDeviceId, getIpAddress } = await import('../../utils/deviceInfo');
    const deviceId = entry.deviceId || getDeviceId();
    const ipAddress = entry.ipAddress || await getIpAddress();

    const safeEntry: SecurityAuditLogEntry = {
      id: entry.id || newId('audit'),
      timestamp: entry.timestamp || new Date().toISOString(),
      user: entry.user || 'Yacine (Admin)',
      action: entry.action || 'ACTION',
      details: entry.details || '',
      requiresPin: Boolean(entry.requiresPin),
      deviceId,
      ipAddress,
    };
    await dexieDb.securityAuditLogs.put(safeEntry);
    if (isTauriEnv()) {
      try {
        const db = await getLocalDb();
        await db.execute(
          `INSERT OR REPLACE INTO security_audit_logs (id, timestamp, user, action, details, requires_pin, device_id, ip_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [safeEntry.id, safeEntry.timestamp, safeEntry.user, safeEntry.action, safeEntry.details, safeEntry.requiresPin ? 1 : 0, safeEntry.deviceId || null, safeEntry.ipAddress || null],
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
          'SELECT id, timestamp, user, action, details, requires_pin, device_id, ip_address FROM security_audit_logs ORDER BY timestamp DESC LIMIT 300'
        )) as Array<{
          id: string;
          timestamp: string;
          user: string;
          action: string;
          details: string;
          requires_pin: number;
          device_id: string | null;
          ip_address: string | null;
        }>;
        if (rows && rows.length > 0) {
          return rows.map((r) => ({
            id: r.id,
            timestamp: r.timestamp,
            user: r.user,
            action: r.action,
            details: r.details,
            requiresPin: Boolean(r.requires_pin),
            deviceId: r.device_id || undefined,
            ipAddress: r.ip_address || undefined,
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
        await db.execute(
          `INSERT INTO app_settings (key, value_json, updated_at, version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
             updated_at=excluded.updated_at, version=excluded.version`,
          [key, JSON.stringify(value), utcNowIso(), nextVersion],
        );
      } catch {
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

