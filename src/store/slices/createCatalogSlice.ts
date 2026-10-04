import type { StateCreator } from 'zustand';
import type { PosState, CatalogSlice } from '../types';
import type { Product } from '../../types/pos';
import { audioBus } from '../../utils/audioEvents';
import { rebaseReconciledSales } from './rebaseReconciledSales';
import { newId } from '../../utils/ids';
import {
  describeArchivedProduct,
  resolveWarrantyMonths,
} from '../../utils/warrantyResolver';
import { validateDeviceIdentifierForIntake } from '../../utils/savValidation';
import { normalizeDeviceKey } from '../../utils/deviceIdCodec';

// P11.3: repositories pull sqliteAdapter -> dexie + libsql; catalog writes are
// async user actions, so they resolve on first use, not at cold start.
async function getProductRepo() {
  const { productRepository } = await import('../../db/repositories/productRepository');
  return productRepository;
}
async function getImeiRepo() {
  const { imeiRepository } = await import('../../db/repositories/imeiRepository');
  return imeiRepository;
}

export const createCatalogSlice: StateCreator<PosState, [], [], CatalogSlice> = (set, get) => ({
  products: [],
  selectedCategory: 'Tous les produits',
  searchQuery: '',
  sortOption: 'name_asc',
  editingProduct: null,

  setSortOption: (option) => set({ sortOption: option }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedCategory: (category) => set({ selectedCategory: category }),
  setEditingProduct: (product) => set({ editingProduct: product, activeModal: 'product_editor' }),

  saveProduct: async (input, options) => {
    const { products, imeiRecords, logSecurityAction } = get();
    // Pre-image for the stock-durability adjustment below: manual edits must
    // land in the ledger, or the next sale's recompute wipes them.
    const prevStock = input.id ? products.find((p) => p.id === input.id)?.stock : undefined;

    // 1. Mandatory Title Validation
    if (!input.title || !input.title.trim()) {
      return { success: false, reason: 'La désignation du produit est obligatoire.' };
    }

    // 1b. W-43 — a serialized product carries a device identifier, so the
    // catalog editor is an acquisition writer too and uses the SAME gate as the
    // trade-in and the invoice import: a 15-digit Luhn failure is refused,
    // a serial passes, a duplicate is a WARNING.
    //
    // The product's OWN previous identifier is excluded from the duplicate
    // scan, otherwise re-saving a product without touching its IMEI would warn
    // about itself on every edit.
    const rawIdentifier = (input.imeiNumber ?? '').trim();
    let canonicalIdentifier = rawIdentifier;
    if (rawIdentifier) {
      const ownRow = input.id ? (imeiRecords || []).find((r) => r.productId === input.id) : undefined;
      const verdict = validateDeviceIdentifierForIntake(rawIdentifier, [
        ...(imeiRecords || []).filter((r) => !(ownRow && r.imei === ownRow.imei)).map((r) => r.imei),
        ...products.filter((p) => (input.id ? p.id !== input.id : true)).map((p) => p.imeiNumber),
      ]);
      if (!verdict.ok) {
        return { success: false, reason: verdict.reason };
      }
      canonicalIdentifier = verdict.canonical;
      if (verdict.warning) {
        // Warn-only, by owner decision: the row is still saved.
        console.warn('[saveProduct]', verdict.warning);
      }
    }

    // 2. Barcode Duplicate Validation
    const cleanBarcode = input.barcode ? input.barcode.trim() : '';
    if (cleanBarcode) {
      const duplicateBarcode = products.find(
        (p) => p.barcode.trim() === cleanBarcode && (input.id ? p.id !== input.id : true)
      );
      if (duplicateBarcode) {
        return {
          success: false,
          reason: `Ce code-barres (${cleanBarcode}) est déjà attribué au produit "${duplicateBarcode.title}".`,
        };
      }
    }

    // 3. SKU Duplicate Validation
    const cleanSku = input.sku ? input.sku.trim().toLowerCase() : '';
    if (cleanSku) {
      const duplicateSku = products.find(
        (p) => p.sku.trim().toLowerCase() === cleanSku && (input.id ? p.id !== input.id : true)
      );
      if (duplicateSku) {
        return {
          success: false,
          reason: `La référence SKU (${input.sku}) est déjà utilisée par le produit "${duplicateSku.title}".`,
        };
      }
    }

    let targetProduct: Product;

    if (input.id) {
      const isService = Boolean(
        input.isService ||
        input.category === 'Services' ||
        input.id.startsWith('qt-') ||
        input.id.startsWith('prod-misc-')
      );
      targetProduct = {
        ...(input as Product),
        isService,
        stock: isService ? 999999 : input.stock,
        // Canonical storage form, so the till, SAV and the warranty resolver
        // all agree on this device's identity.
        imeiNumber: canonicalIdentifier || undefined,
      };
      logSecurityAction(
        'Modification Produit Catalogue',
        `Mise à jour fiche: ${targetProduct.title} (SKU: ${targetProduct.sku}, Stock: ${targetProduct.stock})`,
        'Yacine (Admin)',
        false
      );
    } else {
      const isService = Boolean(input.isService || input.category === 'Services');
      targetProduct = {
        ...(input as Omit<Product, 'id'>),
        id: newId('prod'),
        isService,
        stock: isService ? 999999 : input.stock,
        imeiNumber: canonicalIdentifier || undefined,
      };
      logSecurityAction(
        'Création Produit Catalogue',
        `Nouveau produit: ${targetProduct.title} (Code-barres: ${targetProduct.barcode}, Stock: ${targetProduct.stock})`,
        'Yacine (Admin)',
        false
      );
    }

    // 4. Persist FIRST (Dexie + SQLite + Outbox), then publish to UI state.
    // The old optimistic set-then-background-save closed the editor modal on
    // a product the database never recorded, and its `previousProducts`
    // rollback was captured before the save — any concurrent catalog edit in
    // between got clobbered by the stale restore. Failure now returns before
    // any set(), so state is trivially "rolled back" (untouched) and fresh.
    try {
      await (await getProductRepo()).save(targetProduct);
    } catch (err: unknown) {
      console.error('Product persistence failed — catalog state untouched:', err);
      audioBus.emit('error');
      return {
        success: false,
        reason: err instanceof Error ? err.message : 'Échec d\'enregistrement du produit.',
      };
    }

    // 5. B-040: re-read get() after the await — `products`/`targetProduct`
    // snapshot is pre-await; a concurrent catalog edit between step 3 and
    // here would be clobbered by the stale map.
    audioBus.emit('success');
    const latest = get().products;
    let nextProducts: Product[];
    if (input.id) {
      nextProducts = latest.map((p) => (p.id === targetProduct.id ? targetProduct : p));
      // Product was deleted concurrently — keep the delete, do not resurrect.
      if (!nextProducts.some((p) => p.id === targetProduct.id)) {
        nextProducts = latest;
      }
    } else {
      nextProducts = latest.some((p) => p.id === targetProduct.id)
        ? latest
        : [targetProduct, ...latest];
    }
    set({
      products: nextProducts,
      editingProduct: null,
      ...(options?.keepModalOpen ? {} : { activeModal: null }),
    });

    // Stock durability: a manual stock edit without a ledger delta evaporates
    // on the next sale's `stock = SUM(ledger)` recompute (and the variance
    // never books). Persist the variance as an ADJUST delta — best-effort,
    // never fails the saved product. Services keep their 999999 sentinel
    // (the helper double-guards, but don't even call it for them). The
    // operation id is fresh per save so retries converge via deterministic
    // delta identities without colliding with later edits.
    if (targetProduct.stock !== prevStock) {
      const isService =
        targetProduct.isService ||
        targetProduct.category === 'Services' ||
        targetProduct.id.startsWith('qt-') ||
        targetProduct.id.startsWith('prod-misc-');
      if (!isService) {
        try {
          const { appendStocktakeAdjustments } = await import('../../db/sqlPluginAdapter');
          await appendStocktakeAdjustments(
            [{ productId: targetProduct.id, countedStock: targetProduct.stock, refId: newId('stedit') }],
            { refType: 'manual-edit' }
          );
        } catch (adjErr) {
          console.error('[catalog:stock] Manual stock saved but ledger adjustment deferred — recount to converge:', adjErr);
        }
      }
    }

    return { success: true };
  },

  deleteProduct: async (id) => {
    try {
      await (await getProductRepo()).delete(id);
      // Orphan-batch tombstone: deleting only the product row leaves live
      // stock_batches behind — valuation keeps their cost (retail 0 via the
      // products LEFT JOIN) as phantom unsellable assets. Tombstone them
      // here (best-effort, never fails the delete) and audit the write-off.
      try {
        const { getLocalDb } = await import('../../db/sqlPluginAdapter');
        const db = await getLocalDb();
        const live = (await db
          .select('SELECT batch_id FROM stock_batches WHERE product_id = $1 AND deleted = 0', [id])
          .catch(() => [])) as Array<{ batch_id: string }>;
        const batchIds = [...new Set((live ?? []).map((r) => String(r.batch_id)).filter(Boolean))];
        if (batchIds.length > 0) {
          const now = new Date().toISOString();
          await db.execute(
            `UPDATE stock_batches SET deleted = 1, version = version + 1, updated_at = $1, sync_status = 'pending' WHERE product_id = $2 AND deleted = 0`,
            [now, id]
          );
          for (const bid of batchIds) {
            await db
              .execute(
                `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
                 VALUES ($1, 'stock_batches', $2, 'UPSERT', $3, 'pending')
                 ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=$4`,
                [
                  `sb-${bid}-tombstone`,
                  bid,
                  JSON.stringify({ batch_id: bid, product_id: id, deleted: 1, updated_at: now }),
                  now,
                ]
              )
              .catch(() => {});
          }
          try {
            const { mirrorStockBatchesToDexie } = await import('../../db/sqlPluginAdapter');
            await mirrorStockBatchesToDexie(db as never, [id]);
          } catch {
            // Mirror heals on next mutation/boot.
          }
          get().logSecurityAction(
            'Suppression Produit (Lots Soldés)',
            `Produit supprimé — ${batchIds.length} lot(s) en stock soldé(s) (valeur retirée de l'actif).`,
            'Yacine (Admin)',
            false
          );
        }
      } catch (tombErr) {
        console.warn('[catalog:delete] Batch tombstone deferred:', tombErr);
      }
      // B-040: re-read after await so concurrent catalog edits survive.
      const latest = get().products;
      // Q-C: ARCHIVE the registry rows before the product disappears.
      //
      // Deleting the product used to orphan `productId` on every device ever
      // registered against it. The resolver then found no catalog entry and
      // called `resolveWarrantyMonths(undefined)`, which returns the 12-month
      // STORE DEFAULT — so a deleted "Grade B" occasion unit silently gained a
      // year of warranty, and the dossier lost the model name entirely.
      //
      // Snapshotted into EXISTING fields only: the product title goes into
      // `notes` (prefixed so it can be parsed back) and the term into
      // `warrantyMonths`. `productId` is cleared so nothing keeps hunting for a
      // catalog row that no longer exists. No new column, no migration.
      const doomed = (latest || []).find((p) => p.id === id);
      if (doomed) {
        try {
          const { db: dexieDb } = await import('../../db/database');
          const rows = await dexieDb.imeiRecords
            .where('productId')
            .equals(id)
            .toArray();
          for (const rec of rows) {
            const stamp = new Date().toISOString();
            const months = resolveWarrantyMonths(doomed);
            await dexieDb.imeiRecords.put({
              ...rec,
              productId: '',
              warrantyMonths: rec.warrantyMonths ?? months,
              notes: describeArchivedProduct(doomed.title, doomed.sku, stamp),
            });
          }
          // Keep the in-memory mirror in step so the open inspector agrees.
          set({
            imeiRecords: (get().imeiRecords || []).map((r) =>
              r.productId === id
                ? {
                    ...r,
                    productId: '',
                    warrantyMonths: r.warrantyMonths ?? resolveWarrantyMonths(doomed),
                    notes: describeArchivedProduct(
                      doomed.title,
                      doomed.sku,
                      new Date().toISOString()
                    ),
                  }
                : r
            ),
          });
          if (rows.length > 0) {
            get().logSecurityAction(
              'Suppression Produit (Dossiers Appareils archivés)',
              `Produit supprimé — ${rows.length} dossier(s) appareil archivés (nom et durée de garantie conservés).`,
              'Yacine (Admin)',
              false
            );
          }
        } catch (archiveErr) {
          console.warn('[catalog:delete] Registry archive deferred:', archiveErr);
        }
      }
      set({
        products: latest.filter((p) => p.id !== id),
        cart: get().cart.filter((item) => item.product.id !== id),
      });
    } catch (err) {
      console.error(`Failed to delete product [${id}]:`, err);
      audioBus.emit('error');
    }
  },

  ingestInvoiceBatch: async (updatedProducts, newImeis, receipts = [], opts) => {
    const { products, imeiRecords, logSecurityAction } = get();
    if (updatedProducts.length === 0) return;

    // W-43 — the invoice is an ACQUISITION surface, so it gets the same gate as
    // every other writer: a 15-digit value that fails Luhn is refused (it would
    // be a registry row nothing can ever resolve), serials pass, and a duplicate
    // is a WARNING rather than a refusal.
    //
    // The refusal is per-row and non-fatal: a supplier invoice that carries one
    // bad identifier must still import the other 40 lines, so the offending row
    // is dropped, counted and surfaced instead of aborting the batch. Dropping
    // silently is exactly what this gate exists to prevent.
    const knownIdentifiers = [
      ...(imeiRecords || []).map((r) => r.imei),
      // The rows this very import is about to add, so two lines of the SAME
      // invoice cannot collide with each other into two registry entries.
      ...newImeis.map((r) => r.imei),
      ...(products || []).map((p) => p.imeiNumber),
    ];
    const refused: string[] = [];
    const duplicateWarnings: string[] = [];
    const acceptedNewImeis = [];
    // Keys accepted FROM THIS BATCH, kept apart from `knownIdentifiers` (which
    // also holds pre-existing rows): re-receiving a known device must REPLACE
    // its historic row, but two lines of the SAME invoice for the same device
    // are a data-entry duplicate and must collapse into one — otherwise the
    // import writes the same registry key twice.
    const acceptedKeys = new Set<string>();
    for (const rec of newImeis) {
      const verdict = validateDeviceIdentifierForIntake(rec.imei, knownIdentifiers);
      if (!verdict.ok) {
        refused.push(`${rec.imei || '(vide)'} — ${verdict.reason}`);
        continue;
      }
      if (verdict.warning) duplicateWarnings.push(verdict.warning);
      if (acceptedKeys.has(verdict.key)) continue;
      // Store the canonical form, so a hyphenated invoice line and its
      // digits-only twin cannot become two devices.
      acceptedNewImeis.push({ ...rec, imei: verdict.canonical });
      acceptedKeys.add(verdict.key);
      knownIdentifiers.push(verdict.canonical);
    }

    await (await getProductRepo()).bulkSave(updatedProducts);

    for (const rec of acceptedNewImeis) {
      await (await getImeiRepo()).save(rec);
    }

    // Batch-tracked invoice stock: every received unit joins the FIFO batches
    // ledger (same shape as PO receipts) instead of landing as untracked
    // stock that later shadows at the latest cost. Best-effort — the catalog
    // save above already landed; a batch failure only warns.
    //
    // Idempotency: delta + batch identities derive from ONE operation key
    // (content hash from the modal when available, else a per-call nonce),
    // so a BUSY-after-commit retry converges via ON CONFLICT instead of
    // doubling stock, and re-importing the same file is a durable no-op.
    const opKey =
      opts?.importKey && String(opts.importKey).trim().length > 0
        ? String(opts.importKey).trim()
        : `once-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    try {
      const lines = (receipts ?? []).filter((r) => r && r.productId && Number(r.qty) > 0);
      if (lines.length > 0) {
        // P11.3: sqlPluginAdapter pulls the libsql/Turso sync graph; load on first write.
        const { appendInventoryDeltas, insertStockBatch } = await import('../../db/sqlPluginAdapter');
        await appendInventoryDeltas(
          lines.map((r) => {
            const lineKey = `inv-${opKey}-${r.productId}`;
            return {
              id: lineKey,
              idempotencyKey: lineKey,
              productId: r.productId,
              delta: Math.max(0, Math.floor(Number(r.qty))),
              reason: 'RECEIVE' as const,
              refType: 'INVOICE_IMPORT',
              refId: r.productId,
            };
          }),
        );
        for (const [lineIdx, r] of lines.entries()) {
          const qty = Math.max(0, Math.floor(Number(r.qty)));
          if (qty <= 0) continue;
          const unitCost = Math.max(0, Math.round(Number(r.unitCost) || 0));
          const batchId = `batch-inv-${opKey}-${r.productId}-${lineIdx}`;
          await insertStockBatch({
            batchId,
            productId: r.productId,
            quantityRemaining: qty,
            unitCost,
            idempotencyKey: `sb-${batchId}`,
          }).catch((err) => {
            console.warn('[invoice:batch] Failed to insert stock batch in SQLite:', err);
          });
          try {
            const { dexieDb } = await import('../../db/database');
            await dexieDb.stockBatches.put({
              batchId,
              productId: r.productId,
              quantityRemaining: qty,
              unitCost,
              receivedAt: new Date().toISOString(),
            });
          } catch (dexieErr) {
            console.warn('[invoice:batch] Failed to insert stock batch in Dexie:', dexieErr);
          }
        }
        try {
          const { syncManager } = await import('../../sync/SyncManager');
          syncManager.notifyLocalWrite();
        } catch {
          // Sync kick best-effort.
        }
      }
    } catch (batchErr) {
      console.warn('[invoice:batch] Batch-tracked ingestion deferred:', batchErr);
    }

    const updatedMap = new Map<string, Product>(updatedProducts.map((p) => [p.id, p]));
    const nextProducts = products.map((p) => updatedMap.get(p.id) || p);
    // Merge by CANONICAL key, not raw string: the incoming rows are canonical
    // and a historic hyphenated row must be replaced by them rather than kept
    // beside them as a phantom second device (the W-30 rule, applied here).
    const incomingKeys = new Set(acceptedNewImeis.map((r) => normalizeDeviceKey(r.imei)));
    const nextImeis =
      acceptedNewImeis.length > 0
        ? [
            ...acceptedNewImeis,
            ...(imeiRecords || []).filter((r) => !incomingKeys.has(normalizeDeviceKey(r.imei))),
          ]
        : imeiRecords;

    const refusedNote = refused.length
      ? ` — ${refused.length} refusé(s) (checksum Luhn): ${refused.slice(0, 3).join('; ')}`
      : '';
    logSecurityAction(
      'Import Facture Fournisseur (CSV)',
      `${updatedProducts.length} références mises à jour, ${acceptedNewImeis.length} IMEI enregistrés${refusedNote}`,
      'Système (Import Facture)',
      false
    );
    // A refused identifier is an integrity signal, not a cosmetic detail: the
    // operator must be able to see WHICH line was dropped, because a dropped
    // unit is a unit nobody can find at warranty lookup later.
    for (const warning of duplicateWarnings) console.warn('[invoice:import]', warning);

    audioBus.emit('success');
    set({ products: nextProducts, imeiRecords: nextImeis });

    // Batch inserts above may have triggered shadow reconciliation for
    // older sales — rebase the in-memory mirror (see procurement receive).
    await rebaseReconciledSales(get, set);
  },

  bulkSaveProducts: async (newProducts: Product[]) => {
    const { products, logSecurityAction } = get();
    if (newProducts.length === 0) return;

    // Save to DB (Dexie + SQLite + Outbox)
    await (await getProductRepo()).bulkSave(newProducts);

    // Merge into catalog in memory
    const newMap = new Map<string, Product>(newProducts.map((p) => [p.id, p]));
    const existingFiltered = products.filter((p) => !newMap.has(p.id));
    const nextProducts = [...newProducts, ...existingFiltered];

    void logSecurityAction(
      'Génération Matrice Variantes',
      `${newProducts.length} variantes enregistrées dans le catalogue`,
      'Yacine (Admin)',
      false
    );

    audioBus.emit('success');
    set({ products: nextProducts });
  },

  applyStocktakeAudit: async (items: { productId: string; countedStock: number; previousStock: number }[]) => {
    const { products, logSecurityAction } = get();
    if (items.length === 0) return;

    const countMap = new Map<string, number>(items.map((i) => [i.productId, i.countedStock]));
    const updatedProducts: Product[] = [];

    const nextProducts = products.map((p) => {
      const counted = countMap.get(p.id);
      if (counted !== undefined && counted !== p.stock) {
        const updated = { ...p, stock: Math.max(0, counted) };
        updatedProducts.push(updated);
        return updated;
      }
      return p;
    });

    if (updatedProducts.length > 0) {
      await (await getProductRepo()).bulkSave(updatedProducts);

      // Durability: without ledger deltas these counts evaporate on the next
      // sale's recompute (and shrinkage never books). Persist each variance
      // vs the live ledger sum as an ADJUST delta — best-effort, never fails
      // the saved count. Services are skipped inside the helper. One fresh
      // operation id per audit: delta identities derive from it, so retries
      // converge while distinct audits never collide.
      try {
        const { appendStocktakeAdjustments } = await import('../../db/sqlPluginAdapter');
        const stocktakeId = newId('stocktake');
        await appendStocktakeAdjustments(
          updatedProducts.map((p) => ({ productId: p.id, countedStock: p.stock, refId: stocktakeId })),
          { refType: 'stocktake' }
        );
      } catch (adjErr) {
        console.error('[catalog:stocktake] Counts saved but ledger adjustment deferred — recount to converge:', adjErr);
      }

      const totalVariance = items.reduce((acc, i) => acc + (i.countedStock - i.previousStock), 0);
      const sign = totalVariance >= 0 ? `+${totalVariance}` : `${totalVariance}`;

      void logSecurityAction(
        'Inventaire Physique (Audit Douchette)',
        `${updatedProducts.length} articles ajustés. Écart net total: ${sign} pièces`,
        'Manager',
        true
      );

      audioBus.emit('success');
      set({ products: nextProducts });
    }
  },
});
