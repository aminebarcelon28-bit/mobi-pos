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
} from '../types/pos';

export interface AppSettingItem {
  key: string;
  value: unknown;
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
  appSettings!: Table<AppSettingItem, string>;

  constructor() {
    super('MobiPosDB');

    // Schema v1 with secondary indexes for fast lookups
    this.version(2).stores({
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
      appSettings: 'key',
    });
  }
}

export const db = new MobiPosDatabase();
