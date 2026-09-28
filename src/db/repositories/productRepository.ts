import type { Product } from '../../types/pos';

// P11.3: a static import of the sqliteAdapter barrel pins the whole DB graph
// (adapters -> dexie + libsql) into whichever chunk imports this repository.
// Every repository is reached only from async store actions, so resolve lazily.
async function getSqlite() {
  const { sqliteAdapter } = await import('../sqliteAdapter');
  return sqliteAdapter;
}

export const productRepository = {
  async getAll(): Promise<Product[]> {
     return await (await getSqlite()).getAllProducts();
  },

  async findByBarcodeOrSku(query: string): Promise<Product | undefined> {
     return await (await getSqlite()).findProductByBarcodeOrSku(query);
  },

  async save(product: Product): Promise<void> {
     await (await getSqlite()).saveProduct(product);
  },

  async bulkSave(products: Product[]): Promise<void> {
     await (await getSqlite()).bulkSaveProducts(products);
  },

  async delete(id: string): Promise<void> {
     await (await getSqlite()).deleteProduct(id);
  },

  async clearAll(): Promise<void> {
     const sqlite = await getSqlite();
     const prods = await sqlite.getAllProducts();
    if (prods.length > 0) {
      await Promise.all(prods.map((p) => sqlite.deleteProduct(p.id)));
    }
  },
};
