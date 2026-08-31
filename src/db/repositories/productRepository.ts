import { sqliteAdapter } from '../sqliteAdapter';
import type { Product } from '../../types/pos';

export const productRepository = {
  async getAll(): Promise<Product[]> {
    return await sqliteAdapter.getAllProducts();
  },

  async findByBarcodeOrSku(query: string): Promise<Product | undefined> {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return undefined;
    const products = await sqliteAdapter.getAllProducts();
    return products.find(
      (p) => p.barcode.toLowerCase() === trimmed || p.sku.toLowerCase() === trimmed
    );
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

  async clearAll(): Promise<void> {
    const prods = await sqliteAdapter.getAllProducts();
    if (prods.length > 0) {
      await Promise.all(prods.map((p) => sqliteAdapter.deleteProduct(p.id)));
    }
  },
};
