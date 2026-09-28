import Dexie, { type Table } from 'dexie';
import type {
  Product,
  Customer,
  SaleTransaction,
  RepairOrder,
  PurchaseOrder,
  TradeInItem,
  IMEIRecord,
  SecurityAuditLogEntry,
  CashDropEntry,
  ProductBundle,
  CustomerDebtEntry,
  StoreExpense,
  CashSession,
  CashMovement,
  StockBatch,
  CreditVoucher,
  SaleBatchAllocation,
} from '../types/pos';

export interface AppSettingItem {
  key: string;
  value: unknown;
}

/** B-004 FIX-4: Dexie recovery-intent row (see checkoutRecovery.ts). */
export interface CheckoutRecoveryIntentRow {
  id: string;
  transactionId: string;
  receiptNumber: string;
  payload: Record<string, unknown>;
  customerPayload?: Record<string, unknown> | null;
  debtEntry?: Record<string, unknown> | null;
  createdAt: string;
  lastError?: string;
  attempts: number;
}

export class MobiPosDatabase extends Dexie {
  products!: Table<Product, string>;
  customers!: Table<Customer, string>;
  transactions!: Table<SaleTransaction, string>;
  repairOrders!: Table<RepairOrder, string>;
  purchaseOrders!: Table<PurchaseOrder, string>;
  tradeIns!: Table<TradeInItem, string>;
  imeiRecords!: Table<IMEIRecord, string>;
  securityAuditLogs!: Table<SecurityAuditLogEntry, string>;
  cashDrops!: Table<CashDropEntry, string>;
  payouts!: Table<CashDropEntry, string>;
  bundles!: Table<ProductBundle, string>;
  customerDebts!: Table<CustomerDebtEntry, string>;
  storeExpenses!: Table<StoreExpense, string>;
  cashSessions!: Table<CashSession, string>;
  cashMovements!: Table<CashMovement, string>;
  appSettings!: Table<AppSettingItem, string>;
  inventoryLedger!: Table<Record<string, unknown>, string>;
  syncOutbox!: Table<Record<string, unknown>, string>;
  stockBatches!: Table<StockBatch, string>;
  creditVouchers!: Table<CreditVoucher, string>;
  checkoutRecoveryIntents!: Table<CheckoutRecoveryIntentRow, string>;
  /** v104 frozen FIFO COGS ledger (offline mirror of sale_batch_allocations). */
  saleBatchAllocations!: Table<SaleBatchAllocation, string>;

  constructor() {
    super('MobiPosDB');

    // Schema v3 with secondary indexes for fast lookups
    this.version(3).stores({
      products: 'id, sku, barcode, category, brand, title',
      customers: 'id, phone, name, loyaltyCardCode, barcode',
      transactions: 'id, receiptNumber, createdAt',
      repairOrders: 'id, ticketNumber, status, imei, customerPhone',
      purchaseOrders: 'id, poNumber, vendorName, status',
      tradeIns: 'id, imei, brand, createdAt',
      imeiRecords: 'imei, productId, receivedAt',
      securityAuditLogs: 'id, timestamp, user',
      cashDrops: 'id, timestamp',
      payouts: 'id, timestamp',
      bundles: 'id, barcode',
      customerDebts: 'id, customerId, createdAt',
      storeExpenses: 'id, category, createdAt',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, createdAt',
      appSettings: 'key',
    });

    // v4: offline-first sync (web fallback mirror of plugin-sql tables).
    // plugin-sql remains source of truth on Tauri; Dexie mirrors for browser preview.
    this.version(4).stores({
      products: 'id, sku, barcode, category, brand, title',
      customers: 'id, phone, name, loyaltyCardCode, barcode',
      transactions: 'id, receiptNumber, createdAt',
      repairOrders: 'id, ticketNumber, status, imei, customerPhone',
      purchaseOrders: 'id, poNumber, vendorName, status',
      tradeIns: 'id, imei, brand, createdAt',
      imeiRecords: 'imei, productId, receivedAt',
      securityAuditLogs: 'id, timestamp, user',
      cashDrops: 'id, timestamp',
      payouts: 'id, timestamp',
      bundles: 'id, barcode',
      customerDebts: 'id, customerId, createdAt',
      storeExpenses: 'id, category, createdAt',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, createdAt',
      appSettings: 'key',
      inventoryLedger: 'id, productId, createdAt',
      syncOutbox: 'idempotencyKey, status, entityType',
    });

    // v5: FIFO stock batches
    this.version(5).stores({
      products: 'id, sku, barcode, category, brand, title',
      customers: 'id, phone, name, loyaltyCardCode, barcode',
      transactions: 'id, receiptNumber, createdAt',
      repairOrders: 'id, ticketNumber, status, imei, customerPhone',
      purchaseOrders: 'id, poNumber, vendorName, status',
      tradeIns: 'id, imei, brand, createdAt',
      imeiRecords: 'imei, productId, receivedAt',
      securityAuditLogs: 'id, timestamp, user',
      cashDrops: 'id, timestamp',
      payouts: 'id, timestamp',
      bundles: 'id, barcode',
      customerDebts: 'id, customerId, createdAt',
      storeExpenses: 'id, category, createdAt',
      cashSessions: 'id, status, openedAt',
      cashMovements: 'id, sessionId, type, createdAt',
      appSettings: 'key',
      inventoryLedger: 'id, productId, createdAt',
      syncOutbox: 'idempotencyKey, status, entityType',
      stockBatches: 'batchId, productId, receivedAt, purchaseOrderId',
    });

    // v6: Scannable Avoir Vouchers (credit_vouchers)
    this.version(6).stores({
      products: 'id, sku, barcode, category, brand, title',
      customers: 'id, phone, name, loyaltyCardCode, barcode',
      transactions: 'id, receiptNumber, createdAt',
      repairOrders: 'id, ticketNumber, status, imei, customerPhone',
      purchaseOrders: 'id, poNumber, vendorName, status',
      tradeIns: 'id, imei, brand, createdAt',
      imeiRecords: 'imei, productId, receivedAt',
      securityAuditLogs: 'id, timestamp, user',
      cashDrops: 'id, timestamp',
      payouts: 'id, timestamp',
      bundles: 'id, barcode',
      customerDebts: 'id, customerId, createdAt',
      storeExpenses: 'id, category, createdAt',
      cashSessions: 'id, status, openedAt, deviceId',
      cashMovements: 'id, sessionId, type, createdAt',
      appSettings: 'key',
      inventoryLedger: 'id, productId, createdAt',
      syncOutbox: 'idempotencyKey, status, entityType',
      stockBatches: 'batchId, productId, receivedAt, purchaseOrderId',
      creditVouchers: 'id, code, status, customerPhone, createdAt',
    });

    // v7: B-004 FIX-4 — durable checkout recovery intent (singleton 'active').
    // Written to IndexedDB BEFORE the SQLite order write; survives SQLITE_BUSY.
    this.version(7).stores({
      products: 'id, sku, barcode, category, brand, title',
      customers: 'id, phone, name, loyaltyCardCode, barcode',
      transactions: 'id, receiptNumber, createdAt',
      repairOrders: 'id, ticketNumber, status, imei, customerPhone',
      purchaseOrders: 'id, poNumber, vendorName, status',
      tradeIns: 'id, imei, brand, createdAt',
      imeiRecords: 'imei, productId, receivedAt',
      securityAuditLogs: 'id, timestamp, user',
      cashDrops: 'id, timestamp',
      payouts: 'id, timestamp',
      bundles: 'id, barcode',
      customerDebts: 'id, customerId, createdAt',
      storeExpenses: 'id, category, createdAt',
      cashSessions: 'id, status, openedAt, deviceId',
      cashMovements: 'id, sessionId, type, createdAt',
      appSettings: 'key',
      inventoryLedger: 'id, productId, createdAt',
      syncOutbox: 'idempotencyKey, status, entityType',
      stockBatches: 'batchId, productId, receivedAt, purchaseOrderId',
      creditVouchers: 'id, code, status, customerPhone, createdAt',
      checkoutRecoveryIntents: 'id, createdAt',
    });

    // v8: STRICT FIFO ALLOCATION LEDGER mirror (frozen checkout COGS).
    this.version(8).stores({
      products: 'id, sku, barcode, category, brand, title',
      customers: 'id, phone, name, loyaltyCardCode, barcode',
      transactions: 'id, receiptNumber, createdAt',
      repairOrders: 'id, ticketNumber, status, imei, customerPhone',
      purchaseOrders: 'id, poNumber, vendorName, status',
      tradeIns: 'id, imei, brand, createdAt',
      imeiRecords: 'imei, productId, receivedAt',
      securityAuditLogs: 'id, timestamp, user',
      cashDrops: 'id, timestamp',
      payouts: 'id, timestamp',
      bundles: 'id, barcode',
      customerDebts: 'id, customerId, createdAt',
      storeExpenses: 'id, category, createdAt',
      cashSessions: 'id, status, openedAt, deviceId',
      cashMovements: 'id, sessionId, type, createdAt',
      appSettings: 'key',
      inventoryLedger: 'id, productId, createdAt',
      syncOutbox: 'idempotencyKey, status, entityType',
      stockBatches: 'batchId, productId, receivedAt, purchaseOrderId',
      creditVouchers: 'id, code, status, customerPhone, createdAt',
      checkoutRecoveryIntents: 'id, createdAt',
      saleBatchAllocations: 'id, saleId, batchId, productId',
    });
  }
}

export const db = new MobiPosDatabase();
export const dexieDb = db;
