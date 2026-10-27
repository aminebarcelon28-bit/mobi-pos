import type { Product } from '../../types/pos';
import { db as dexieDb } from '../database';
import { isTauriEnv } from './base';

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

/**
 * UPGRADE-03: keep the native semantic index (sqlite-vec `vec_products`) warm
 * from the catalog lane. All three helpers are fire-and-forget projections —
 * an absent native side (web preview) or a slow index write must never fail
 * or delay a catalog mutation.
 */
async function indexProductForSuggestions(product: Product): Promise<void> {
  try {
    if (!isTauriEnv()) return;
    const name = [product.title, product.brand, product.compatibleModel]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join(' ');
    const { invokeCommand } = await import('../../platform/invoke');
    await invokeCommand('vec_index_product', { productId: product.id, name });
  } catch {
    /* advisory index — absence never blocks catalog writes */
  }
}

async function unindexProductForSuggestions(productId: string): Promise<void> {
  try {
    if (!isTauriEnv()) return;
    const { invokeCommand } = await import('../../platform/invoke');
    await invokeCommand('vec_index_product', { productId, name: '' });
  } catch {
    /* advisory index — absence never blocks catalog deletes */
  }
}

async function refreshSuggestionsIndex(force: boolean): Promise<void> {
  try {
    if (!isTauriEnv()) return;
    const { invokeCommand } = await import('../../platform/invoke');
    await invokeCommand('vec_reindex_catalog', force ? { force: true } : {});
  } catch {
    /* advisory index — retried on the next catalog read */
  }
}

/** One backfill attempt per session — the native latch makes it a no-op after. */
let vecBackfillFired = false;
function mapSqlRowToProduct(r: Record<string, unknown>): Product {
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(String(r.json_payload ?? '{}')) as Record<string, unknown>;
  } catch {
    // keep base empty
  }
  return {
    ...base,
    id: String(r.id),
    sku: String(r.sku ?? base.sku ?? ''),
    barcode: String(r.barcode ?? base.barcode ?? ''),
    title: String(r.title ?? base.title ?? r.id),
    brand: ((r.brand && String(r.brand).trim()) || (base.brand && String(base.brand).trim()) || 'Autre') as Product['brand'],
    category: ((r.category && String(r.category).trim()) || (base.category && String(base.category).trim()) || 'Tous les produits') as Product['category'],
    price: Number(r.price ?? base.price ?? 0),
    wholesalePrice: Number(r.wholesale_price ?? base.wholesalePrice ?? 0),
    semiWholesalePrice: typeof base.semiWholesalePrice === 'number' ? base.semiWholesalePrice : undefined,
    costPrice: Number(r.cost_price ?? base.costPrice ?? 0),
    stock: Number(r.stock ?? base.stock ?? 0),
    imageUrl: String(r.image_url ?? base.imageUrl ?? ''),
    isSerialized: Boolean(r.is_serialized ?? base.isSerialized),
    imeiNumber: (r.imei_number as string | undefined) ?? (base.imeiNumber as string | undefined),
    vendorName: String(r.vendor_name ?? base.vendorName ?? 'Fournisseur Général'),
    leadTimeDays: Number(r.lead_time_days ?? base.leadTimeDays ?? 7),
    dailySalesVelocity: Number(r.daily_sales_velocity ?? base.dailySalesVelocity ?? 0),
    reorderPoint: Number(r.reorder_point ?? base.reorderPoint ?? 5),
    compatibleModel: String(r.compatible_model ?? base.compatibleModel ?? ''),
  } as Product;
}

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
    void indexProductForSuggestions(cleanProduct);
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
    // Bulk imports can outrun the per-save hook — force one idempotent rebuild.
    void refreshSuggestionsIndex(true);
  },

  async getAllProducts(): Promise<Product[]> {
    if (isTauriEnv()) {
      try {
        const [{ getLocalDb }] = await Promise.all([getSqlAdapter()]);
        const db = await getLocalDb();
        const rows = (await db.select("SELECT * FROM products WHERE deleted = 0 AND id NOT LIKE 'prod-test-%'")) as Array<Record<string, unknown>>;
        if (rows && rows.length > 0) {
          const products = rows.map(mapSqlRowToProduct);
          // UPGRADE-03: seed the semantic index for the whole catalog once
          // per session (latched natively; fire-and-forget) so accessory
          // suggestions work on installs that predate the index.
          if (!vecBackfillFired) {
            vecBackfillFired = true;
            void refreshSuggestionsIndex(false);
          }
          // Keep Dexie mirror in sync and purge any stale ghost records asynchronously
          void (async () => {
            try {
              const liveIds = new Set(products.map((p) => p.id));
              const allDexie = await dexieDb.products.toArray();
              const ghosts = allDexie.filter((p) => !liveIds.has(p.id)).map((p) => p.id);
              if (ghosts.length > 0) {
                await dexieDb.products.bulkDelete(ghosts);
              }
              await dexieDb.products.bulkPut(products);
            } catch (mirrorErr) {
              console.warn('[getAllProducts] Background Dexie mirror failed:', mirrorErr);
            }
          })();
          return products;
        }
      } catch (err) {
        console.warn('[getAllProducts] SQLite authority read failed, falling back to Dexie:', err);
      }
    }

    // Web / non-Tauri or SQLite fallback path: purge test ghosts or blank title records
    const all = await dexieDb.products.toArray();
    const ghosts = all.filter((p) => p.id.startsWith('prod-test-') || (!p.title?.trim() && !p.price));
    if (ghosts.length > 0) {
      void dexieDb.products.bulkDelete(ghosts.map((g) => g.id)).catch(() => {});
      return all.filter((p) => !p.id.startsWith('prod-test-') && (p.title?.trim() || p.price > 0));
    }
    return all;
  },

  /** Targeted post-pull refresh: fetch only touched product ids (P1). */
  async getProductsByIds(ids: string[]): Promise<Product[]> {
    const unique = [...new Set((ids ?? []).map((id) => String(id || '')).filter(Boolean))];
    if (unique.length === 0) return [];
    const { isTauriEnv } = await import('./base');
    if (isTauriEnv()) {
      try {
        const [{ getLocalDb }] = await Promise.all([getSqlAdapter()]);
        const db = await getLocalDb();
        const placeholders = unique.map(() => '?').join(',');
        const rows = (await db.select(
          `SELECT * FROM products WHERE deleted = 0 AND id IN (${placeholders})`,
          unique
        )) as Array<Record<string, unknown>>;
        if (rows && rows.length > 0) {
          return rows.map(mapSqlRowToProduct);
        }
      } catch (err) {
        console.warn('[getProductsByIds] SQLite read failed, falling back to Dexie:', err);
      }
    }
    return await dexieDb.products.where('id').anyOf(unique).toArray();
  },

  async findProductByBarcodeOrSku(query: string): Promise<Product | undefined> {
    const trimmed = query.trim();
    if (!trimmed) return undefined;
    const lower = trimmed.toLowerCase();
    const { isTauriEnv } = await import('./base');
    if (isTauriEnv()) {
      try {
        const [{ getLocalDb }] = await Promise.all([getSqlAdapter()]);
        const db = await getLocalDb();
        const rows = (await db.select(
          'SELECT * FROM products WHERE (barcode = $1 OR LOWER(sku) = $2 OR id = $1) AND deleted = 0 LIMIT 1',
          [trimmed, lower]
        )) as Array<Record<string, unknown>>;
        if (rows && rows.length > 0) {
          return mapSqlRowToProduct(rows[0]);
        }
      } catch (err) {
        console.warn('[findProductByBarcodeOrSku] SQLite read failed, falling back to Dexie:', err);
      }
    }
    const byBarcode = await dexieDb.products.where('barcode').equalsIgnoreCase(trimmed).first();
    if (byBarcode && !byBarcode.id.startsWith('prod-test-')) return byBarcode;
    const bySku = await dexieDb.products.where('sku').equalsIgnoreCase(lower).first();
    if (bySku && !bySku.id.startsWith('prod-test-')) return bySku;
    return undefined;
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
    void unindexProductForSuggestions(id);
  },
};

