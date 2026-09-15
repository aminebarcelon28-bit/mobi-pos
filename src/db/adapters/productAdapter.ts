import type { Product } from '../../types/pos';
import { db as dexieDb } from '../database';

let sqlAdapterPromise: Promise<typeof import('../sqlPluginAdapter')> | null = null;
let syncManagerPromise: Promise<typeof import('../../sync/SyncManager')> | null = null;

const getSqlAdapter = () => {
  if (!sqlAdapterPromise) sqlAdapterPromise = import('../sqlPluginAdapter');
  return sqlAdapterPromise;
};

const getSyncManager = () => {
  if (!syncManagerPromise) syncManagerPromise = import('../../sync/SyncManager');
  return syncManagerPromise;
};

export const productAdapter = {
  async saveProduct(product: Product): Promise<void> {
    await dexieDb.products.put(product);
    try {
      const [{ syncProductUpsert }, { syncManager }] = await Promise.all([
        getSqlAdapter(),
        getSyncManager(),
      ]);
      await syncProductUpsert({
        id: product.id, sku: product.sku, barcode: product.barcode, title: product.title,
        brand: product.brand, category: product.category, price: product.price,
        wholesalePrice: product.wholesalePrice, costPrice: product.costPrice, stock: product.stock,
        imageUrl: product.imageUrl, isSerialized: product.isSerialized,
        imeiNumber: product.imeiNumber, vendorName: product.vendorName,
        leadTimeDays: product.leadTimeDays, dailySalesVelocity: product.dailySalesVelocity,
        reorderPoint: product.reorderPoint,
        raw: product as unknown as Record<string, unknown>,
      });
      syncManager.notifyLocalWrite();
    } catch (err) {
      console.warn('Product sync enqueue skipped:', err);
    }
  },

  async bulkSaveProducts(products: Product[]): Promise<void> {
    await dexieDb.products.bulkPut(products);
    try {
      const [{ syncProductUpsertBulk }, { syncManager }] = await Promise.all([
        getSqlAdapter(),
        getSyncManager(),
      ]);
      await syncProductUpsertBulk(products.map((product) => ({
        id: product.id, sku: product.sku, barcode: product.barcode, title: product.title,
        brand: product.brand, category: product.category, price: product.price,
        wholesalePrice: product.wholesalePrice, costPrice: product.costPrice, stock: product.stock,
        imageUrl: product.imageUrl, isSerialized: product.isSerialized,
        imeiNumber: product.imeiNumber, vendorName: product.vendorName,
        leadTimeDays: product.leadTimeDays, dailySalesVelocity: product.dailySalesVelocity,
        reorderPoint: product.reorderPoint,
        raw: product as unknown as Record<string, unknown>,
      })));
      syncManager.notifyLocalWrite();
    } catch (err) {
      console.warn('Bulk product sync enqueue skipped:', err);
    }
  },

  async getAllProducts(): Promise<Product[]> {
    return await dexieDb.products.toArray();
  },

  async findProductByBarcodeOrSku(query: string): Promise<Product | undefined> {
    const trimmed = query.trim();
    if (!trimmed) return undefined;
    const lower = trimmed.toLowerCase();
    const byBarcode = await dexieDb.products.where('barcode').equalsIgnoreCase(trimmed).first();
    if (byBarcode) return byBarcode;
    return await dexieDb.products.where('sku').equalsIgnoreCase(lower).first();
  },

  async deleteProduct(id: string): Promise<void> {
    await dexieDb.products.delete(id);
    try {
      const [{ syncProductDelete }, { syncManager }] = await Promise.all([
        getSqlAdapter(),
        getSyncManager(),
      ]);
      await syncProductDelete(id);
      syncManager.notifyLocalWrite();
    } catch (err) {
      console.warn('Product delete sync skipped:', err);
    }
  },
};

