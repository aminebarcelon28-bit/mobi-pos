import { z } from 'zod';
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
import type { AppSettingItem } from '../db/database';

const ProductBackupItemSchema = z.object({
  id: z.string().min(1, 'Product id is required'),
  title: z.string().min(1, 'Product title is required'),
  sku: z.string().optional().default(''),
  barcode: z.string().optional().default(''),
  // B-050: corrupt money must REJECT the file, not import authority zeros.
  // nonnegative int (whole DA) — NaN/float/negative all fail.
  price: z
    .number()
    .int('Prix doit être un entier (DA)')
    .nonnegative('Prix ne peut pas être négatif')
    .optional()
    .default(0),
  stock: z.number().int('Stock doit être un entier').nonnegative().optional().default(0),
}).passthrough();

const CustomerBackupItemSchema = z.object({
  id: z.string().min(1, 'Customer id is required'),
  name: z.string().min(1, 'Customer name is required'),
}).passthrough();

const TransactionBackupItemSchema = z.object({
  id: z.string().min(1, 'Transaction id is required'),
  // B-050: total must be a finite nonnegative int when present (refunds store
  // positive total with isRefund flag). Corrupt floats reject the whole file.
  total: z
    .number()
    .int('Total doit être un entier (DA)')
    .nonnegative('Total ne peut pas être négatif')
    .optional()
    .default(0),
}).passthrough();

const GenericRecordSchema = z.object({
  id: z.string().optional(),
}).passthrough();

export interface BackupPayload {
  version?: string | number;
  exportedAt?: string;
  products?: Product[];
  customers?: Customer[];
  transactions?: SaleTransaction[];
  repairOrders?: RepairOrder[];
  purchaseOrders?: PurchaseOrder[];
  tradeIns?: TradeInItem[];
  imeiRecords?: IMEIRecord[];
  securityAuditLogs?: SecurityAuditLogEntry[];
  cashDrops?: CashDropEntry[];
  payouts?: CashDropEntry[];
  bundles?: ProductBundle[];
  customerDebts?: CustomerDebtEntry[];
  storeExpenses?: StoreExpense[];
  settings?: AppSettingItem[];
  appSettings?: AppSettingItem[];
  /** Frozen FIFO allocation rows (sale_batch_allocations mirror). */
  saleBatchAllocations?: Array<Record<string, unknown>>;
  /** Raw inventory ledger deltas (recomputes stock + valuation). */
  inventoryLedger?: Array<Record<string, unknown>>;
  /** Pending checkout recovery intents (replay-safe via adapter guard). */
  checkoutRecoveryIntents?: Array<Record<string, unknown>>;
}

export const BackupPayloadSchema: z.ZodType<BackupPayload> = z.object({
  version: z.union([z.string(), z.number()]).optional(),
  exportedAt: z.string().optional(),
  products: z.array(ProductBackupItemSchema).optional(),
  customers: z.array(CustomerBackupItemSchema).optional(),
  transactions: z.array(TransactionBackupItemSchema).optional(),
  repairOrders: z.array(GenericRecordSchema).optional(),
  purchaseOrders: z.array(GenericRecordSchema).optional(),
  tradeIns: z.array(GenericRecordSchema).optional(),
  imeiRecords: z.array(GenericRecordSchema).optional(),
  securityAuditLogs: z.array(GenericRecordSchema).optional(),
  cashDrops: z.array(GenericRecordSchema).optional(),
  payouts: z.array(GenericRecordSchema).optional(),
  bundles: z.array(GenericRecordSchema).optional(),
  customerDebts: z.array(GenericRecordSchema).optional(),
  storeExpenses: z.array(GenericRecordSchema).optional(),
  settings: z.array(GenericRecordSchema).optional(),
  appSettings: z.array(GenericRecordSchema).optional(),
  saleBatchAllocations: z.array(GenericRecordSchema).optional(),
  inventoryLedger: z.array(GenericRecordSchema).optional(),
  checkoutRecoveryIntents: z.array(GenericRecordSchema).optional(),
}).passthrough() as unknown as z.ZodType<BackupPayload>;
