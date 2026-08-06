import { db } from '../database';
import type { Product } from '../../types/pos';

export const productRepository = {
  async getAll(): Promise<Product[]> {
    return await db.products.toArray();
  },

  async findByBarcodeOrSku(query: string): Promise<Product | undefined> {
    const trimmed = query.trim();
    if (!trimmed) return undefined;
    const byBarcode = await db.products.where('barcode').equals(trimmed).first();
    if (byBarcode) return byBarcode;
    return await db.products.where('sku').equalsIgnoreCase(trimmed).first();
  },

  async save(product: Product): Promise<void> {
    await db.products.put(product);
  },

  async bulkSave(products: Product[]): Promise<void> {
    await db.products.bulkPut(products);
  },

  async delete(id: string): Promise<void> {
    await db.products.delete(id);
  },

  async clearAll(): Promise<void> {
    await db.products.clear();
  },
};
