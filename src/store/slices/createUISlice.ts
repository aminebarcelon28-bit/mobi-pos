import type { StateCreator } from 'zustand';
import type { PosState, UISlice } from '../types';
import type {
  Product,
  ProductBundle,
  TradeInItem,
  StoreExpense,
  ReceiptSettings,
  LicenseDetails,
  HardwareStatus,
  SecurityAuditLogEntry,
} from '../../types/pos';
import { INITIAL_PRODUCTS, INITIAL_CUSTOMERS } from '../../data/mockData';
import { sqliteAdapter } from '../../db/sqliteAdapter';
import { productRepository } from '../../db/repositories/productRepository';
import { customerRepository } from '../../db/repositories/customerRepository';
import { settingsRepository } from '../../db/repositories/settingsRepository';
import { backupRepository } from '../../db/repositories/backupRepository';
import { hashPin, verifyPin } from '../../utils/security';

const initialTheme =
  typeof localStorage !== 'undefined'
    ? ((localStorage.getItem('mobi_pos_theme') as 'dark' | 'light') || 'dark')
    : 'dark';

if (typeof document !== 'undefined') {
  if (initialTheme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  storeName: 'ACCESSOIRES MOBI',
  storeSubheader: 'Vente Accessoires & Téléphonie',
  logoUrl: '',
  address: 'Boulevard Mohamed V, Alger Centre',
  phone: '021 65 43 21 / 0550 00 11 22',
  email: 'contact@mobi-accessories.dz',
  customHeaderMsg: 'Bienvenue chez MOBI ACCESSORIES',
  customFooterMsg:
    'Paiement comptant en espèces uniquement. Les articles ne sont ni repris ni échangés sans ticket de caisse. Garantie 12 mois SAV.',
  showBarcode: true,
  autoPrintEnabled: true,
  printerRouting: {
    receiptPrinterId: 'rp-1',
    receiptPrinterName: 'Imprimante Thermique Tickets (Epson TM-T88VI)',
    labelPrinterId: 'lp-1',
    labelPrinterName: 'Imprimante Étiquettes Code-Barres (Zebra ZD421)',
    reportPrinterId: 'sys-1',
    reportPrinterName: 'Imprimante Système Windows / PDF A4',
    autoRoutingEnabled: true,
  },
};

const DEFAULT_LICENSE_DETAILS: LicenseDetails = {
  machineFingerprint: 'CPU-HWID-9F82A-DZ-2026',
  status: 'Active',
  licenseKey: 'ED25519-MOBI-ENTERPRISE-8921-OK',
  maxTerminals: 5,
  activatedAt: '01/08/2026',
};

const DEFAULT_HARDWARE_STATUS: HardwareStatus = {
  printerConnected: true,
  scannerConnected: true,
  cashDrawerOpen: false,
  customerDisplayConnected: true,
};

export const createUISlice: StateCreator<PosState, [], [], UISlice> = (set, get) => ({
  isDbInitialized: false,
  themeMode: initialTheme,
  pricingTier: 'Retail',
  activeModal: null,
  pendingPinAction: null,
  hardwareStatus: DEFAULT_HARDWARE_STATUS,
  receiptSettings: DEFAULT_RECEIPT_SETTINGS,
  licenseDetails: DEFAULT_LICENSE_DETAILS,
  bundles: [],
  tradeIns: [],
  imeiRecords: [],
  activeImeiDossier: null,
  managerPin: '1234',
  securityAuditLog: [
    {
      id: 'log-1',
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      user: 'Yacine (Admin)',
      action: 'Initialisation Système POS',
      details: 'Moteur de base de données IndexedDB activé',
      requiresPin: false,
    },
  ],
  storeExpenses: [],

  toggleTheme: () => {
    const nextTheme = get().themeMode === 'dark' ? 'light' : 'dark';
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('mobi_pos_theme', nextTheme);
    }
    if (typeof document !== 'undefined') {
      if (nextTheme === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    }
    set({ themeMode: nextTheme });
  },

  setPricingTier: (tier) => set({ pricingTier: tier }),

  openModal: (modal) => {
    if (modal === 'payment' && get().cart.length === 0) {
      return;
    }
    set({ activeModal: modal });
  },

  closeModal: () =>
    set({
      activeModal: null,
      editingProduct: null,
      selectedTransactionForRefund: null,
      selectedRepairOrderForNotification: null,
      activeImeiDossier: null,
    }),

  setPendingPinAction: (action) => set({ pendingPinAction: action }),

  setActiveImeiDossier: (dossier) => set({ activeImeiDossier: dossier }),

  setReceiptSettings: async (settings) => {
    try {
      await settingsRepository.set('mobi_pos_receipt_settings', settings);
      set({ receiptSettings: settings });
    } catch (error) {
      console.error('Failed to save receipt settings:', error);
    }
  },

  setManagerPin: async (newPin) => {
    if (!newPin || newPin.length < 4) return;
    try {
      const hashedPin = hashPin(newPin);
      await settingsRepository.set('manager_pin', hashedPin);
      set({ managerPin: hashedPin });
      get().logSecurityAction(
        'Mise à Jour Code PIN Gérant',
        'Le code PIN administrateur a été chiffré et modifié avec succès (SHA-256/Salt)',
        'Manager',
        true
      );
    } catch (error) {
      console.error('Failed to update manager PIN:', error);
    }
  },

  logSecurityAction: (action, details, user = 'Yacine (Admin)', requiresPin = false) => {
    const { securityAuditLog } = get();
    const newEntry: SecurityAuditLogEntry = {
      id: `audit-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      user,
      action,
      details,
      requiresPin,
    };
    set({ securityAuditLog: [newEntry, ...securityAuditLog] });
  },

  verifyManagerPin: (pin) => {
    const currentPin = get().managerPin;
    if (!currentPin) return false;
    return verifyPin(pin, currentPin);
  },

  createBundle: async (bundleInput) => {
    try {
      const { bundles } = get();
      const newBundle: ProductBundle = {
        ...bundleInput,
        id: `bndl-${Date.now()}`,
      };
      const updated = [newBundle, ...bundles];
      await sqliteAdapter.saveBundle(newBundle);
      set({ bundles: updated });
    } catch (error) {
      console.error('Failed to create bundle:', error);
    }
  },

  deleteBundle: async (bundleId) => {
    try {
      const { bundles } = get();
      const updated = bundles.filter((b) => b.id !== bundleId);
      await sqliteAdapter.deleteBundle(bundleId);
      set({ bundles: updated });
    } catch (error) {
      console.error('Failed to delete bundle:', error);
    }
  },

  addBundleToCart: (bundleId) => {
    const { bundles, products, cart } = get();
    const bundle = bundles.find((b) => b.id === bundleId);
    if (!bundle) return { success: false, reason: 'BUNDLE_NOT_FOUND' };

    const outOfStock = bundle.childSkus.filter((sku) => {
      const product = products.find((p) => p.sku === sku);
      if (!product) return true;
      const existingInCart = cart.find((item) => item.product.id === product.id);
      const currentQty = existingInCart ? existingInCart.quantity : 0;
      return currentQty + 1 > product.stock;
    });

    if (outOfStock.length > 0) {
      return { success: false, reason: `CHILD_OUT_OF_STOCK:${outOfStock.join(',')}` };
    }

    const childProducts = bundle.childSkus
      .map((sku) => products.find((p) => p.sku === sku))
      .filter((p): p is Product => p !== undefined);

    const regularSum = childProducts.reduce((sum, p) => sum + p.price, 0);
    const bundleDiscountTotal = Math.max(0, regularSum - bundle.bundlePrice);

    const updatedCart = [...cart];

    childProducts.forEach((childProd) => {
      const itemRatio = regularSum > 0 ? childProd.price / regularSum : 1 / childProducts.length;
      const itemDiscount = Math.round(bundleDiscountTotal * itemRatio);

      const existingIndex = updatedCart.findIndex((item) => item.product.id === childProd.id);
      if (existingIndex >= 0) {
        updatedCart[existingIndex] = {
          ...updatedCart[existingIndex],
          quantity: updatedCart[existingIndex].quantity + 1,
          discount: updatedCart[existingIndex].discount + itemDiscount,
        };
      } else {
        updatedCart.push({
          product: childProd,
          quantity: 1,
          discount: itemDiscount,
          appliedPrice: childProd.price,
          imeiNumber: childProd.isSerialized ? '' : undefined,
        });
      }
    });

    set({ cart: updatedCart });
    return { success: true };
  },

  processTradeIn: async (tradeInput) => {
    try {
      const { tradeIns, products, customers, currentCustomer } = get();

      const resalePrice = Math.round(tradeInput.buybackValue * (1 + tradeInput.resaleMarginPercent / 100));

      const newTradeIn: TradeInItem = {
        ...tradeInput,
        resalePrice,
        id: `trade-${Date.now()}`,
        createdAt: new Date().toISOString(),
      };

      const convertedProduct: Product = {
        id: `prod-trade-${Date.now()}`,
        sku: `TRD-${tradeInput.imei.slice(-6)}`,
        barcode: tradeInput.imei,
        title: `${tradeInput.deviceModel} (${tradeInput.conditionGrade})`,
        brand: tradeInput.brand,
        compatibleModel: tradeInput.deviceModel,
        category: "Téléphones d'Occasion (Reprise)",
        price: resalePrice,
        wholesalePrice: Math.round(tradeInput.buybackValue * 1.15),
        costPrice: tradeInput.buybackValue,
        stock: 1,
        imageUrl:
          'https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=300&auto=format&fit=crop&q=80',
        isSerialized: true,
        imeiNumber: tradeInput.imei,
        vendorName: 'Client Buyback',
        leadTimeDays: 0,
        dailySalesVelocity: 0.5,
        reorderPoint: 0,
      };

      const updatedProducts = [convertedProduct, ...products];
      const updatedTradeIns = [newTradeIn, ...tradeIns];

      await productRepository.save(convertedProduct);
      await sqliteAdapter.saveTradeIn(newTradeIn);

      if (!tradeInput.creditToWallet && get().activeShift) {
        await get().logCashMovement(
          tradeInput.buybackValue,
          'EXPENSE',
          `Décaissement Rachat Occasion: ${newTradeIn.deviceModel} (IMEI: ${newTradeIn.imei})`
        );
      }

      let updatedCustomers = customers;
      let updatedCurrentCustomer = currentCustomer;
      if (tradeInput.creditToWallet && currentCustomer) {
        updatedCustomers = customers.map((c) =>
          c.id === currentCustomer.id ? { ...c, storeCredit: c.storeCredit + tradeInput.buybackValue } : c
        );
        updatedCurrentCustomer = {
          ...currentCustomer,
          storeCredit: currentCustomer.storeCredit + tradeInput.buybackValue,
        };
        await customerRepository.save(updatedCurrentCustomer);
      }

      set({
        products: updatedProducts,
        tradeIns: updatedTradeIns,
        customers: updatedCustomers,
        currentCustomer: updatedCurrentCustomer,
        activeModal: null,
      });
    } catch (error) {
      console.error('Failed to process trade-in:', error);
    }
  },

  addStoreExpense: async (expenseInput) => {
    try {
      const { storeExpenses, logSecurityAction } = get();
      const validAmount = Math.max(0, isNaN(expenseInput.amount) ? 0 : expenseInput.amount);
      if (!expenseInput.title || !expenseInput.title.trim() || validAmount <= 0) {
        return;
      }
      const newExpense: StoreExpense = {
        ...expenseInput,
        title: expenseInput.title.trim(),
        amount: validAmount,
        id: `EXP-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
        createdAt: new Date().toISOString(),
      };
      const updated = [newExpense, ...storeExpenses];
      await sqliteAdapter.saveStoreExpense(newExpense);

      if (get().activeShift) {
        await get().logCashMovement(
          validAmount,
          'EXPENSE',
          `Dépense d'exploitation (${newExpense.category}): ${newExpense.title}`
        );
      }

      logSecurityAction(
        'Enregistrement Charge d\'Exploitation',
        `${newExpense.category}: ${newExpense.title} (${validAmount} DA)`,
        newExpense.recordedBy || 'Admin',
        false
      );
      set({ storeExpenses: updated });
    } catch (error) {
      console.error('Failed to add store expense:', error);
    }
  },

  deleteStoreExpense: async (id) => {
    try {
      const { storeExpenses } = get();
      const updated = storeExpenses.filter((e) => e.id !== id);
      await sqliteAdapter.deleteStoreExpense(id);
      set({ storeExpenses: updated });
    } catch (error) {
      console.error('Failed to delete store expense:', error);
    }
  },

  validateIMEI: (imei) => {
    if (!/^\d{15}$/.test(imei)) {
      return { valid: false, reason: 'L\'IMEI doit contenir exactement 15 chiffres.' };
    }
    const { imeiRecords } = get();
    const duplicate = imeiRecords.find((r) => r.imei === imei);
    if (duplicate) {
      return { valid: false, reason: 'Cet IMEI existe déjà dans le système.' };
    }
    return { valid: true };
  },

  searchByIMEI: (imei) => {
    const { products, purchaseOrders, transactions } = get();
    const product = products.find((p) => p.imeiNumber === imei);
    if (!product) return null;

    const po = product.purchaseOrderId
      ? purchaseOrders.find((p) => p.id === product.purchaseOrderId)
      : undefined;

    const transaction = transactions.find((t) =>
      t.items.some((item) => item.imeiNumber === imei)
    );

    return { product, po, transaction };
  },

  initDatabase: async () => {
    try {
      let products = await sqliteAdapter.getAllProducts();
      let customers = await sqliteAdapter.getAllCustomers();
      let transactions = await sqliteAdapter.getAllTransactions();
      const repairOrders = await sqliteAdapter.getAllRepairOrders();
      const purchaseOrders = await sqliteAdapter.getAllPurchaseOrders();
      const tradeIns = await sqliteAdapter.getAllTradeIns();
      const imeiRecords = await sqliteAdapter.getAllIMEIRecords();
      const cashDrops = await sqliteAdapter.getCashDrops(false);
      const payouts = await sqliteAdapter.getCashDrops(true);
      const bundles = await sqliteAdapter.getAllBundles();
      const customerDebts = await sqliteAdapter.getAllCustomerDebts();
      const storeExpenses = await sqliteAdapter.getAllStoreExpenses();
      const activeShift = await sqliteAdapter.getActiveShift();
      const allShifts = await sqliteAdapter.getAllShifts();
      const inventoryValuation = await sqliteAdapter.getInventoryValuation();

      const legacyProducts =
        typeof localStorage !== 'undefined' ? localStorage.getItem('mobi_pos_products') : null;
      const legacyCustomers =
        typeof localStorage !== 'undefined' ? localStorage.getItem('mobi_pos_customers') : null;
      const legacyTxns =
        typeof localStorage !== 'undefined' ? localStorage.getItem('mobi_pos_transactions') : null;

      if (products.length === 0) {
        if (legacyProducts) {
          try {
            const parsed = JSON.parse(legacyProducts);
            if (Array.isArray(parsed) && parsed.length > 0) {
              products = parsed;
              await sqliteAdapter.bulkSaveProducts(products);
            }
          } catch (migrationError: unknown) {
            console.error('[db:init] Failed to migrate legacy products from localStorage:', migrationError);
          }
        } else {
          products = INITIAL_PRODUCTS;
          await sqliteAdapter.bulkSaveProducts(products);
        }
      }

      if (customers.length === 0) {
        if (legacyCustomers) {
          try {
            const parsed = JSON.parse(legacyCustomers);
            if (Array.isArray(parsed) && parsed.length > 0) {
              customers = parsed;
              await sqliteAdapter.bulkSaveCustomers(customers);
            }
          } catch (migrationError: unknown) {
            console.error('[db:init] Failed to migrate legacy customers from localStorage:', migrationError);
          }
        } else {
          customers = INITIAL_CUSTOMERS;
          await sqliteAdapter.bulkSaveCustomers(customers);
        }
      }

      if (transactions.length === 0 && legacyTxns) {
        try {
          const parsed = JSON.parse(legacyTxns);
          if (Array.isArray(parsed) && parsed.length > 0) {
            transactions = parsed;
            for (const t of transactions) {
              await sqliteAdapter.processSaleTransactionAtomic(t, [], undefined);
            }
          }
        } catch (migrationError: unknown) {
          console.error('[db:init] Failed to migrate legacy transactions from localStorage:', migrationError);
        }
      }

      const managerPin = await settingsRepository.get('manager_pin', '1234');

      set({
        products,
        customers,
        transactions,
        repairOrders,
        purchaseOrders,
        tradeIns,
        imeiRecords,
        cashDrops,
        payouts,
        bundles,
        customerDebts,
        storeExpenses,
        activeShift,
        allShifts,
        inventoryValuation,
        managerPin: typeof managerPin === 'string' && managerPin.length >= 4 ? managerPin : '1234',
        shiftFloat: activeShift?.openingFloat || 20000,
        isDbInitialized: true,
      });
    } catch (e) {
      console.error('Failed to initialize SQLite Database:', e);
      const { products, customers } = get();
      set({
        products: products.length > 0 ? products : INITIAL_PRODUCTS,
        customers: customers.length > 0 ? customers : INITIAL_CUSTOMERS,
        isDbInitialized: true,
      });
    }
  },

  seedDemoData: async () => {
    try {
      await backupRepository.seedDemoData(INITIAL_PRODUCTS, INITIAL_CUSTOMERS);
      const products = await productRepository.getAll();
      const customers = await customerRepository.getAll();
      set({ products, customers });
    } catch (error) {
      console.error('Failed to seed demo data:', error);
    }
  },

  refreshAfterPull: async () => {
    try {
      const [
        products,
        customers,
        transactions,
        repairOrders,
        purchaseOrders,
        tradeIns,
        imeiRecords,
        cashDrops,
        payouts,
        bundles,
        customerDebts,
        storeExpenses,
        activeShift,
        allShifts,
        inventoryValuation,
      ] = await Promise.all([
        sqliteAdapter.getAllProducts(),
        sqliteAdapter.getAllCustomers(),
        sqliteAdapter.getAllTransactions(),
        sqliteAdapter.getAllRepairOrders(),
        sqliteAdapter.getAllPurchaseOrders(),
        sqliteAdapter.getAllTradeIns(),
        sqliteAdapter.getAllIMEIRecords(),
        sqliteAdapter.getCashDrops(false),
        sqliteAdapter.getCashDrops(true),
        sqliteAdapter.getAllBundles(),
        sqliteAdapter.getAllCustomerDebts(),
        sqliteAdapter.getAllStoreExpenses(),
        sqliteAdapter.getActiveShift(),
        sqliteAdapter.getAllShifts(),
        sqliteAdapter.getInventoryValuation(),
      ]);
      set({
        products,
        customers,
        transactions,
        repairOrders,
        purchaseOrders,
        tradeIns,
        imeiRecords,
        cashDrops,
        payouts,
        bundles,
        customerDebts,
        storeExpenses,
        activeShift,
        allShifts,
        inventoryValuation,
      });
    } catch (e) {
      console.warn('Post-pull refresh skipped:', e);
    }
  },

  exportDatabase: async () => {
    try {
      const jsonString = await backupRepository.exportJSON();
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof document !== 'undefined') {
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `MOBI_POS_INDEXEDDB_BACKUP_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error('Export failed:', e);
    }
  },

  importDatabase: async (jsonString: string) => {
    try {
      const importResult = await backupRepository.importJSON(jsonString);
      if (importResult.success) {
        await get().initDatabase();
      }
      return importResult;
    } catch (error) {
      console.error('Import database failed:', error);
      return { success: false, reason: 'IMPORT_FAILED' };
    }
  },
});
