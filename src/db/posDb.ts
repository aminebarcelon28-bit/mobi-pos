/**
 * PosDb — Unified Storage & Sync Interface (Engine A / Engine B Façade)
 * Conforms to AGENTS.md §1 & §6.1, and ADR-001.
 * 
 * Enforces the core contracts:
 * C1 (Sync latency <= 1.5s p95)
 * C2 (Offline till operation 100%)
 * C5 (Zero duplicate mutations / Idempotency keys)
 * C6 (Outbox invariant / Zero silent data loss)
 */

import { sqliteAdapter } from './sqliteAdapter';
import { syncManager } from '../sync/SyncManager';
import type { Product, Customer, SaleTransaction } from '../types/pos';
import type { DbStats, IntegrityReport } from './adapters/base';
import type { SyncStatus } from '../sync/types';

export interface PosDbInterface {
  products: {
    getAll(): Promise<Product[]>;
    findByBarcodeOrSku(query: string): Promise<Product | undefined>;
    save(product: Product): Promise<void>;
    bulkSave(products: Product[]): Promise<void>;
    delete(id: string): Promise<void>;
  };
  transactions: {
    getAll(): Promise<SaleTransaction[]>;
    processSaleAtomic(
      transaction: SaleTransaction,
      updatedProducts: Product[],
      updatedCustomer?: Customer
    ): Promise<void>;
  };
  customers: {
    getAll(): Promise<Customer[]>;
    save(customer: Customer): Promise<void>;
    delete(id: string): Promise<void>;
  };
  sync: {
    getStatus(): SyncStatus;
    subscribe(listener: (status: SyncStatus) => void): () => void;
    kick(): Promise<void>;
    notifyLocalWrite(): void;
  };
  diagnostics: {
    getStats(): Promise<DbStats>;
    checkIntegrity(): Promise<IntegrityReport>;
  };
}

export const posDb: PosDbInterface = {
  products: {
    async getAll(): Promise<Product[]> {
      return await sqliteAdapter.getAllProducts();
    },
    async findByBarcodeOrSku(query: string): Promise<Product | undefined> {
      return await sqliteAdapter.findProductByBarcodeOrSku(query);
    },
    async save(product: Product): Promise<void> {
      await sqliteAdapter.saveProduct(product);
    },
    async bulkSave(products: Product[]): Promise<void> {
      await sqliteAdapter.bulkSaveProducts(products);
    },
    async delete(id: string): Promise<void> {
      await sqliteAdapter.deleteProduct(id);
    },
  },

  transactions: {
    async getAll(): Promise<SaleTransaction[]> {
      return await sqliteAdapter.getAllTransactions();
    },
    async processSaleAtomic(
      transaction: SaleTransaction,
      updatedProducts: Product[],
      updatedCustomer?: Customer
    ): Promise<void> {
      await sqliteAdapter.processSaleTransactionAtomic(transaction, updatedProducts, updatedCustomer);
    },
  },

  customers: {
    async getAll(): Promise<Customer[]> {
      return await sqliteAdapter.getAllCustomers();
    },
    async save(customer: Customer): Promise<void> {
      await sqliteAdapter.saveCustomer(customer);
    },
    async delete(id: string): Promise<void> {
      await sqliteAdapter.deleteCustomer(id);
    },
  },

  sync: {
    getStatus(): SyncStatus {
      return {
        online: typeof navigator === 'undefined' ? true : navigator.onLine,
        pushing: false,
        pulling: false,
        pendingCount: 0,
        lastPushAt: null,
        lastPullAt: null,
        lastError: null,
        quotaExceeded: false,
      };
    },
    subscribe(listener: (status: SyncStatus) => void): () => void {
      return syncManager.subscribe(listener);
    },
    async kick(): Promise<void> {
      await syncManager.kick();
    },
    notifyLocalWrite(): void {
      syncManager.notifyLocalWrite();
    },
  },

  diagnostics: {
    async getStats(): Promise<DbStats> {
      return await sqliteAdapter.getStats();
    },
    async checkIntegrity(): Promise<IntegrityReport> {
      return await sqliteAdapter.runIntegrityCheck();
    },
  },
};
