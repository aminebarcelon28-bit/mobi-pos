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
    // P0 hygiene: never persist a multi-MB image blob into Dexie (it would be
    // mirrored into SQLite + outbox + cloud on the next touch). References stay.
    let cleanProduct = product;
    try {
      const [{ sanitizeImageField }] = await Promise.all([getSqlAdapter()]);
      const cleanImageUrl = sanitizeImageField(product.imageUrl);
      if (cleanImageUrl !== product.imageUrl) {
        console.warn(`[sync:hygiene] stripped oversized product image (${(product.imageUrl ?? '').length}B) for ${product.id}`);
        cleanProduct = { ...product, imageUrl: cleanImageUrl ?? '' };
      }
    } catch {
      // Hygiene is best-effort — the outbox bound still applies downstream.
    }
    await dexieDb.products.put(cleanProduct);
    try {
      const [{ syncProductUpsert }, { syncManager }] = await Promise.all([
        getSqlAdapter(),
        getSyncManager(),
      ]);
      await syncProductUpsert({
        id: cleanProduct.id, sku: cleanProduct.sku, barcode: cleanProduct.barcode, title: cleanProduct.title,
        brand: cleanProduct.brand, category: cleanProduct.category, price: cleanProduct.price,
        wholesalePrice: cleanProduct.wholesalePrice, costPrice: cleanProduct.costPrice, stock: cleanProduct.stock,
        imageUrl: cleanProduct.imageUrl, isSerialized: cleanProduct.isSerialized,
        imeiNumber: cleanProduct.imeiNumber, vendorName: cleanProduct.vendorName,
        leadTimeDays: cleanProduct.leadTimeDays, dailySalesVelocity: cleanProduct.dailySalesVelocity,
        reorderPoint: cleanProduct.reorderPoint,
        raw: cleanProduct as unknown as Record<string, unknown>,
      });
      syncManager.notifyLocalWrite();
    } catch (err) {
      console.warn('Product sync enqueue skipped:', err);
    }
  },

  async bulkSaveProducts(products: Product[]): Promise<void> {
    let cleanProducts = products;
    try {
      const [{ sanitizeImageField }] = await Promise.all([getSqlAdapter()]);
      cleanProducts = products.map((product) => {
        const cleanImageUrl = sanitizeImageField(product.imageUrl);
        return cleanImageUrl !== product.imageUrl
          ? { ...product, imageUrl: cleanImageUrl ?? '' }
          : product;
      });
    } catch {
      // Hygiene is best-effort — the outbox bound still applies downstream.
    }
    await dexieDb.products.bulkPut(cleanProducts);
    try {
      const [{ syncProductUpsertBulk }, { syncManager }] = await Promise.all([
        getSqlAdapter(),
        getSyncManager(),
      ]);
      await syncProductUpsertBulk(cleanProducts.map((product) => ({
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

  /** Targeted post-pull refresh: fetch only touched product ids (P1). */
  async getProductsByIds(ids: string[]): Promise<Product[]> {
    const unique = [...new Set((ids ?? []).map((id) => String(id || '')).filter(Boolean))];
    if (unique.length === 0) return [];
    return await dexieDb.products.where('id').anyOf(unique).toArray();
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

