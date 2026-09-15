import type { StateCreator } from 'zustand';
import type { PosState, CatalogSlice } from '../types';
import type { Product, IMEIRecord } from '../../types/pos';
import { productRepository } from '../../db/repositories/productRepository';
import { imeiRepository } from '../../db/repositories/imeiRepository';
import { audioBus } from '../../utils/audioEvents';

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
    const { products, logSecurityAction } = get();
    const previousProducts = products;

    // 1. Mandatory Title Validation
    if (!input.title || !input.title.trim()) {
      return { success: false, reason: 'La désignation du produit est obligatoire.' };
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

    let updatedProducts: Product[];
    let targetProduct: Product;

    if (input.id) {
      targetProduct = input as Product;
      updatedProducts = products.map((p) => (p.id === input.id ? targetProduct : p));
      logSecurityAction(
        'Modification Produit Catalogue',
        `Mise à jour fiche: ${targetProduct.title} (SKU: ${targetProduct.sku}, Stock: ${targetProduct.stock})`,
        'Yacine (Admin)',
        false
      );
    } else {
      targetProduct = {
        ...(input as Omit<Product, 'id'>),
        id: `prod-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      };
      updatedProducts = [targetProduct, ...products];
      logSecurityAction(
        'Création Produit Catalogue',
        `Nouveau produit: ${targetProduct.title} (Code-barres: ${targetProduct.barcode}, Stock: ${targetProduct.stock})`,
        'Yacine (Admin)',
        false
      );
    }

    // 4. Instant optimistic state update & audio feedback (<1ms)
    audioBus.emit('success');
    set({
      products: updatedProducts,
      editingProduct: null,
      ...(options?.keepModalOpen ? {} : { activeModal: null }),
    });

    // 5. Background asynchronous persistence (Dexie + SQLite + Outbox)
    void (async () => {
      try {
        await productRepository.save(targetProduct);
      } catch (err: unknown) {
        console.error('Background product persistence failed:', err);
        audioBus.emit('error');
        // Rollback state in case of catastrophic storage failure
        set({ products: previousProducts });
      }
    })();

    return { success: true };
  },

  deleteProduct: async (id) => {
    const { products, cart } = get();
    const updatedProducts = products.filter((p) => p.id !== id);
    const updatedCart = cart.filter((item) => item.product.id !== id);
    try {
      await productRepository.delete(id);
      set({ products: updatedProducts, cart: updatedCart });
    } catch (err) {
      console.error(`Failed to delete product [${id}]:`, err);
    }
  },

  ingestInvoiceBatch: async (updatedProducts: Product[], newImeis: IMEIRecord[]) => {
    const { products, imeiRecords, logSecurityAction } = get();
    if (updatedProducts.length === 0) return;

    await productRepository.bulkSave(updatedProducts);

    for (const rec of newImeis) {
      await imeiRepository.save(rec);
    }

    const updatedMap = new Map<string, Product>(updatedProducts.map((p) => [p.id, p]));
    const nextProducts = products.map((p) => updatedMap.get(p.id) || p);
    const nextImeis = newImeis.length > 0 ? [...newImeis, ...imeiRecords] : imeiRecords;

    logSecurityAction(
      'Import Facture Fournisseur (CSV)',
      `${updatedProducts.length} références mises à jour, ${newImeis.length} IMEI enregistrés`,
      'Système (Import Facture)',
      false
    );

    audioBus.emit('success');
    set({ products: nextProducts, imeiRecords: nextImeis });
  },
});
