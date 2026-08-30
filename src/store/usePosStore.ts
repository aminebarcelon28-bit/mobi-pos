import { create } from 'zustand';
import type {
  Product,
  ProductInput,
  CartItem,
  Customer,
  CustomerInput,
  HeldSale,
  SaleTransaction,
  CategoryType,
  SortOption,
  PricingTier,
  ReceiptSettings,
  SecurityAuditLogEntry,
  CashDropEntry,
  LicenseDetails,
  HardwareStatus,
  PurchaseOrder,
  POLineItem,
  RepairOrder,
  ProductBundle,
  TradeInItem,
  IMEIRecord,
  PaymentTender,
  LoyaltyLedgerEntry,
  ProcessRefundPayload,
} from '../types/pos';
import { INITIAL_PRODUCTS, INITIAL_CUSTOMERS } from '../data/mockData';
import {
  calculateCustomerTier,
  calculateEarnedPoints,
  convertPointsToCredit,
  createLedgerEntry,
} from '../utils/loyaltyEngine';
import { calculateStockAlerts } from '../utils/alertEngine';
import { productRepository } from '../db/repositories/productRepository';
import { customerRepository } from '../db/repositories/customerRepository';
import { repairRepository } from '../db/repositories/repairRepository';
import { settingsRepository } from '../db/repositories/settingsRepository';
import { backupRepository } from '../db/repositories/backupRepository';
import { sqliteAdapter } from '../db/sqliteAdapter';
import { soundEngine } from '../utils/audioFeedback';

// ──────────────────────────────────────────────
// State Interface
// ──────────────────────────────────────────────

interface PosState {
  isDbInitialized: boolean;
  themeMode: 'dark' | 'light';
  pricingTier: PricingTier;
  products: Product[];
  sortOption: SortOption;
  cart: CartItem[];
  selectedCategory: CategoryType;
  searchQuery: string;
  customers: Customer[];
  currentCustomer: Customer | null;
  heldSales: HeldSale[];
  transactions: SaleTransaction[];
  securityAuditLog: SecurityAuditLogEntry[];
  shiftFloat: number;
  cashDrops: CashDropEntry[];
  payouts: CashDropEntry[];
  receiptSettings: ReceiptSettings;
  licenseDetails: LicenseDetails;
  purchaseOrders: PurchaseOrder[];
  activeDraftPO: PurchaseOrder | null;
  storeCreditApplied: number;
  repairOrders: RepairOrder[];
  bundles: ProductBundle[];
  tradeIns: TradeInItem[];
  imeiRecords: IMEIRecord[];
  activeModal:
    | 'payment'
    | 'receipt'
    | 'hold'
    | 'discount'
    | 'customers'
    | 'settings'
    | 'compatibility'
    | 'product_editor'
    | 'inventory_manager'
    | 'reports'
    | 'label_printer'
    | 'invoice_ingestion'
    | 'receipt_template'
    | 'licensing'
    | 'security_audit'
    | 'shift_zreport'
    | 'vendor_procurement'
    | 'purchase_order'
    | 'repair_work_order'
    | 'trade_in_buyback'
    | 'kitting_bundle'
    | 'hotkey_guide'
    | 'customer_display'
    | 'pin_prompt'
    | 'loyalty_card'
    | 'refund'
    | null;
  pendingPinAction: (() => void) | null;
  editingProduct: Product | null;
  selectedTransactionForRefund: SaleTransaction | null;
  paymentMethod: 'Espèces';
  cashTendered: number;
  lastTransaction: SaleTransaction | null;
  hardwareStatus: HardwareStatus;

  // ── Theme & UI ──
  toggleTheme: () => void;
  setPricingTier: (tier: PricingTier) => void;
  setSortOption: (option: SortOption) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: CategoryType) => void;
  openModal: (modal: PosState['activeModal']) => void;
  closeModal: () => void;
  setPendingPinAction: (action: (() => void) | null) => void;
  setSelectedTransactionForRefund: (t: SaleTransaction | null) => void;

  // ── Cart ──
  addToCart: (product: Product, overridePin?: boolean) => { success: boolean; reason?: string };
  updateCartQty: (productId: string, delta: number) => void;
  removeFromCart: (productId: string) => void;
  clearCart: () => void;
  setCartItemDiscount: (productId: string, discount: number) => void;
  applyCartDiscountPercent: (percent: number) => void;
  setStoreCreditApplied: (amount: number) => void;
  setCartItemIMEI: (productId: string, imei: string) => void;

  // ── Held Sales ──
  holdSale: () => void;
  retrieveSale: (saleId: string) => void;

  // ── Products ──
  setEditingProduct: (product: Product | null) => void;
  saveProduct: (productInput: ProductInput) => Promise<{ success: boolean; reason?: string }>;
  deleteProduct: (id: string) => void;

  // ── Customers ──
  addCustomer: (customer: CustomerInput) => void;
  updateCustomer: (id: string, updates: Partial<Customer>) => void;
  deleteCustomer: (id: string) => void;
  setCurrentCustomer: (customer: Customer | null) => void;
  issueStoreCredit: (customerId: string, amount: number) => void;
  redeemLoyaltyPoints: (customerId: string, points: number) => Promise<{ success: boolean; creditAdded?: number; reason?: string }>;
  adjustCustomerPoints: (customerId: string, points: number, description: string) => void;

  // ── Database & Backup ──
  initDatabase: () => Promise<void>;
  seedDemoData: () => Promise<void>;
  exportDatabase: () => void;
  importDatabase: (jsonString: string) => Promise<{ success: boolean; reason?: string }>;

  // ── Payment & Refunds / Voids ──
  setCashTendered: (amount: number) => void;
  processPayment: (tenders?: PaymentTender[]) => { success: boolean; reason?: string };
  quickCashPayment: () => { success: boolean; reason?: string };
  voidTransaction: (transactionId: string, reason: string, cashierName?: string) => Promise<{ success: boolean; reason?: string }>;
  processRefund: (payload: ProcessRefundPayload) => Promise<{ success: boolean; refundTransaction?: SaleTransaction; reason?: string }>;

  // ── Receipts & Settings ──
  setReceiptSettings: (settings: ReceiptSettings) => void;
  reprintReceipt: (transaction: SaleTransaction) => void;

  // ── Security ──
  logSecurityAction: (action: string, details: string, user?: string, requiresPin?: boolean) => void;
  verifyManagerPin: (pin: string) => boolean;

  // ── Purchase Orders ──
  createDraftPOForVendor: (
    vendorName: string,
    customItems?: Array<{ productId: string; qty: number; unitCost?: number }>
  ) => void;
  directRestockVendor: (
    vendorName: string,
    items: Array<{ productId: string; qty: number }>
  ) => Promise<{ success: boolean; count: number }>;
  approvePurchaseOrder: (poId: string) => void;

  // ── Repair Orders ──
  createRepairOrder: (order: Omit<RepairOrder, 'id' | 'ticketNumber' | 'totalCost' | 'createdAt'>) => void;
  updateRepairOrderStatus: (orderId: string, newStatus: RepairOrder['status']) => void;
  updateRepairOrder: (orderId: string, updates: Partial<RepairOrder>) => void;

  // ── Trade-In ──
  processTradeIn: (tradeIn: Omit<TradeInItem, 'id' | 'createdAt' | 'resalePrice'>) => void;

  // ── Bundles ──
  createBundle: (bundle: Omit<ProductBundle, 'id'>) => void;
  deleteBundle: (bundleId: string) => void;
  addBundleToCart: (bundleId: string) => { success: boolean; reason?: string };

  // ── Cash Drops ──
  addCashDrop: (entry: Omit<CashDropEntry, 'id' | 'timestamp'>) => void;

  // ── IMEI ──
  validateIMEI: (imei: string) => { valid: boolean; reason?: string };
  searchByIMEI: (imei: string) => { product?: Product; po?: PurchaseOrder; transaction?: SaleTransaction } | null;
}

// ──────────────────────────────────────────────
// Initializers
// ──────────────────────────────────────────────

const initialTheme = (localStorage.getItem('mobi_pos_theme') as 'dark' | 'light') || 'dark';

if (typeof document !== 'undefined') {
  if (initialTheme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

// ──────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────

export const usePosStore = create<PosState>((set, get) => ({
  isDbInitialized: false,
  themeMode: initialTheme,
  pricingTier: 'Retail',
  products: [],
  sortOption: 'name_asc',
  cart: [],
  selectedCategory: 'Tous les produits',
  searchQuery: '',
  customers: [],
  currentCustomer: null,
  heldSales: [],
  transactions: [],
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
  shiftFloat: 20000,
  cashDrops: [],
  payouts: [],
  receiptSettings: {
    storeName: 'ACCESSOIRES MOBI',
    storeSubheader: 'Vente Accessoires & Téléphonie',
    logoUrl: '',
    address: 'Boulevard Mohamed V, Alger Centre',
    phone: '021 65 43 21 / 0550 00 11 22',
    email: 'contact@mobi-accessories.dz',
    customHeaderMsg: 'Bienvenue chez MOBI ACCESSORIES',
    customFooterMsg: 'Les articles achetés ne sont ni repris ni échangés sans ticket de caisse. Garantie 12 mois SAV.',
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
  },
  licenseDetails: {
    machineFingerprint: 'CPU-HWID-9F82A-DZ-2026',
    status: 'Active',
    licenseKey: 'ED25519-MOBI-ENTERPRISE-8921-OK',
    maxTerminals: 5,
    activatedAt: '01/08/2026',
  },
  purchaseOrders: [],
  activeDraftPO: null,
  storeCreditApplied: 0,
  repairOrders: [],
  bundles: [],
  tradeIns: [],
  imeiRecords: [],
  activeModal: null,
  pendingPinAction: null,
  editingProduct: null,
  selectedTransactionForRefund: null,
  paymentMethod: 'Espèces',
  cashTendered: 0,
  lastTransaction: null,
  hardwareStatus: {
    printerConnected: true,
    scannerConnected: true,
    cashDrawerOpen: false,
    customerDisplayConnected: true,
  },

  // ══════════════════════════════════════════
  // Theme & UI
  // ══════════════════════════════════════════

  toggleTheme: () => {
    const nextTheme = get().themeMode === 'dark' ? 'light' : 'dark';
    localStorage.setItem('mobi_pos_theme', nextTheme);
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    set({ themeMode: nextTheme });
  },

  setPricingTier: (tier) => set({ pricingTier: tier }),
  setSortOption: (option) => set({ sortOption: option }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedCategory: (category) => set({ selectedCategory: category }),
  openModal: (modal) => {
    if (modal === 'payment' && get().cart.length === 0) {
      return;
    }
    set({ activeModal: modal });
  },
  closeModal: () => set({ activeModal: null, editingProduct: null, selectedTransactionForRefund: null }),
  setPendingPinAction: (action) => set({ pendingPinAction: action }),
  setSelectedTransactionForRefund: (t) => set({ selectedTransactionForRefund: t }),

  // ══════════════════════════════════════════
  // Cart
  // ══════════════════════════════════════════

  addToCart: (product, overridePin = false) => {
    const { cart, pricingTier, logSecurityAction } = get();

    const existingIndex = cart.findIndex((item) => item.product.id === product.id);
    const currentQtyInCart = existingIndex >= 0 ? cart[existingIndex].quantity : 0;

    // Block zero-stock or exceeding stock unless overridden by PIN
    if (currentQtyInCart + 1 > product.stock && !overridePin) {
      soundEngine.playError();
      logSecurityAction('Tentative Vente Dépassement Stock', `Produit: ${product.title} (Demandé: ${currentQtyInCart + 1}, Stock: ${product.stock})`, 'Caissier', true);
      return { success: false, reason: 'STOCK_EMPTY' };
    }

    const activePrice = pricingTier === 'Wholesale' ? product.wholesalePrice || product.price * 0.75 : product.price;

    if (existingIndex >= 0) {
      const updated = [...cart];
      updated[existingIndex] = { ...updated[existingIndex], quantity: updated[existingIndex].quantity + 1 };
      set({ cart: updated });
    } else {
      set({
        cart: [
          ...cart,
          {
            product,
            quantity: 1,
            discount: 0,
            appliedPrice: activePrice,
            imeiNumber: product.isSerialized ? '' : undefined,
          },
        ],
      });
    }
    soundEngine.playScan();
    return { success: true };
  },

  updateCartQty: (productId, delta) => {
    const { cart } = get();
    const updated = cart
      .map((item) => {
        if (item.product.id === productId) {
          const newQty = item.quantity + delta;
          if (delta > 0 && newQty > item.product.stock) {
            return item; // Do not exceed available stock
          }
          return newQty > 0 ? { ...item, quantity: newQty } : null;
        }
        return item;
      })
      .filter((item): item is CartItem => item !== null);
    set({ cart: updated });
  },

  removeFromCart: (productId) => {
    const { cart } = get();
    set({ cart: cart.filter((item) => item.product.id !== productId) });
  },

  clearCart: () => set({ cart: [], storeCreditApplied: 0 }),

  setCartItemDiscount: (productId, discount) => {
    const { cart } = get();
    set({
      cart: cart.map((item) => (item.product.id === productId ? { ...item, discount } : item)),
    });
  },

  applyCartDiscountPercent: (percent) => {
    const { cart, pricingTier } = get();
    set({
      cart: cart.map((item) => {
        const itemPrice =
          pricingTier === 'Wholesale' ? item.product.wholesalePrice || item.product.price * 0.75 : item.product.price;
        const itemTotal = itemPrice * item.quantity;
        const discountAmount = Math.round((itemTotal * percent) / 100);
        return { ...item, discount: discountAmount, appliedPrice: itemPrice };
      }),
    });
  },

  setStoreCreditApplied: (amount) => set({ storeCreditApplied: amount }),

  setCartItemIMEI: (productId, imei) => {
    const { cart } = get();
    set({
      cart: cart.map((item) => (item.product.id === productId ? { ...item, imeiNumber: imei } : item)),
    });
  },

  // ══════════════════════════════════════════
  // Held Sales
  // ══════════════════════════════════════════

  holdSale: () => {
    const { cart, currentCustomer, heldSales } = get();
    if (cart.length === 0) return;
    const newHold: HeldSale = {
      id: `hold-${Date.now()}`,
      customer: currentCustomer,
      items: [...cart],
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    };
    set({ heldSales: [...heldSales, newHold], cart: [], storeCreditApplied: 0 });
  },

  retrieveSale: (saleId) => {
    const { heldSales } = get();
    const target = heldSales.find((h) => h.id === saleId);
    if (target) {
      const activeTier = target.customer ? target.customer.pricingTier : 'Retail';
      set({
        cart: target.items,
        currentCustomer: target.customer,
        pricingTier: activeTier,
        heldSales: heldSales.filter((h) => h.id !== saleId),
        activeModal: null,
      });
    }
  },

  // ══════════════════════════════════════════
  // Products
  // ══════════════════════════════════════════

  setEditingProduct: (product) => set({ editingProduct: product, activeModal: 'product_editor' }),

  saveProduct: async (input) => {
    const { products, logSecurityAction } = get();

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

    try {
      await productRepository.save(targetProduct);
      soundEngine.playSuccess();
      set({ products: updatedProducts, activeModal: null, editingProduct: null });
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la sauvegarde en base de données';
      console.error('Save product failed:', err);
      return { success: false, reason: msg };
    }
  },

  deleteProduct: async (id) => {
    const { products, cart } = get();
    const updatedProducts = products.filter((p) => p.id !== id);
    const updatedCart = cart.filter((item) => item.product.id !== id);
    await productRepository.delete(id);
    set({ products: updatedProducts, cart: updatedCart });
  },

  // ══════════════════════════════════════════
  // Customers
  // ══════════════════════════════════════════

  addCustomer: async (input) => {
    const { customers } = get();
    const newCustomer: Customer = {
      ...(input as Omit<Customer, 'id'>),
      id: input.id || `cust-${Date.now()}`,
    };
    const updated = [newCustomer, ...customers];
    await customerRepository.save(newCustomer);
    set({ customers: updated });
  },

  updateCustomer: async (id, updates) => {
    const { customers, currentCustomer } = get();
    const updated = customers.map((c) => (c.id === id ? { ...c, ...updates } : c));
    const target = updated.find((c) => c.id === id);
    if (target) {
      await customerRepository.save(target);
    }
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === id) {
      newState.currentCustomer = { ...currentCustomer, ...updates };
      if (updates.pricingTier) newState.pricingTier = updates.pricingTier;
    }
    set(newState as PosState);
  },

  deleteCustomer: async (id) => {
    const { customers, currentCustomer } = get();
    const updated = customers.filter((c) => c.id !== id);
    await customerRepository.delete(id);
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === id) {
      newState.currentCustomer = null;
      newState.pricingTier = 'Retail';
    }
    set(newState as PosState);
  },

  setCurrentCustomer: (customer) => {
    if (customer) {
      set({ currentCustomer: customer, pricingTier: customer.pricingTier || 'Retail' });
    } else {
      set({ currentCustomer: null, pricingTier: 'Retail' });
    }
  },

  issueStoreCredit: async (customerId, amount) => {
    const { customers, currentCustomer } = get();
    const updated = customers.map((c) =>
      c.id === customerId ? { ...c, storeCredit: c.storeCredit + amount } : c
    );
    const target = updated.find((c) => c.id === customerId);
    if (target) {
      await customerRepository.save(target);
    }
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === customerId) {
      newState.currentCustomer = { ...currentCustomer, storeCredit: currentCustomer.storeCredit + amount };
    }
    set(newState as PosState);
  },

  redeemLoyaltyPoints: async (customerId, points) => {
    const { customers, currentCustomer } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer || customer.loyaltyPoints < points || points <= 0) {
      return { success: false, reason: 'INSUFFICIENT_POINTS' };
    }

    const { creditAmount } = convertPointsToCredit(points);
    const newPoints = customer.loyaltyPoints - points;
    const newCredit = customer.storeCredit + creditAmount;

    const ledgerEntry = createLedgerEntry(
      customerId,
      'conversion',
      -points,
      newPoints,
      `Échange de ${points} pts contre ${creditAmount} DA d'Avoir Client`
    );

    const existingLedger = customer.ledger || [];
    const updatedCustomer: Customer = {
      ...customer,
      loyaltyPoints: newPoints,
      storeCredit: newCredit,
      ledger: [ledgerEntry, ...existingLedger],
    };

    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    await customerRepository.save(updatedCustomer);

    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
    return { success: true, creditAdded: creditAmount };
  },

  adjustCustomerPoints: async (customerId, points, description) => {
    const { customers, currentCustomer } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer || points === 0) return;

    const newPoints = Math.max(0, customer.loyaltyPoints + points);
    const ledgerEntry = createLedgerEntry(
      customerId,
      points > 0 ? 'bonus' : 'adjustment',
      points,
      newPoints,
      description || (points > 0 ? 'Ajustement / Bonus de points' : 'Déduction de points')
    );

    const existingLedger = customer.ledger || [];
    const updatedCustomer: Customer = {
      ...customer,
      loyaltyPoints: newPoints,
      ledger: [ledgerEntry, ...existingLedger],
    };

    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    await customerRepository.save(updatedCustomer);

    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
  },

  // ══════════════════════════════════════════
  // Database Engine & Backup Operations
  // ══════════════════════════════════════════

  initDatabase: async () => {
    try {
      // 1. Fetch records from SQLite Engine
      let products = await sqliteAdapter.getAllProducts();
      let customers = await sqliteAdapter.getAllCustomers();
      let transactions = await sqliteAdapter.getAllTransactions();
      let repairOrders = await sqliteAdapter.getAllRepairOrders();
      let purchaseOrders = await sqliteAdapter.getAllPurchaseOrders();
      let tradeIns = await sqliteAdapter.getAllTradeIns();
      let imeiRecords = await sqliteAdapter.getAllIMEIRecords();
      let cashDrops = await sqliteAdapter.getCashDrops(false);
      let payouts = await sqliteAdapter.getCashDrops(true);
      let bundles = await sqliteAdapter.getAllBundles();

      // 2. Migration loader: Check if legacy localStorage or mock data needed on initial startup
      const legacyProducts = localStorage.getItem('mobi_pos_products');
      const legacyCustomers = localStorage.getItem('mobi_pos_customers');
      const legacyTxns = localStorage.getItem('mobi_pos_transactions');

      if (products.length === 0) {
        if (legacyProducts) {
          try {
            const parsed = JSON.parse(legacyProducts);
            if (Array.isArray(parsed) && parsed.length > 0) {
              products = parsed;
              await sqliteAdapter.bulkSaveProducts(products);
            }
          } catch {}
        } else {
          // Auto-seed initial demo catalogue on fresh installation
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
          } catch {}
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
        } catch {}
      }

      // 3. Update store state with database records
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
        isDbInitialized: true,
      });
    } catch (e) {
      console.error('Failed to initialize SQLite Database:', e);
      set({ isDbInitialized: true });
    }
  },

  seedDemoData: async () => {
    await backupRepository.seedDemoData(INITIAL_PRODUCTS, INITIAL_CUSTOMERS);
    const products = await productRepository.getAll();
    const customers = await customerRepository.getAll();
    set({ products, customers });
  },

  exportDatabase: async () => {
    try {
      const jsonString = await backupRepository.exportJSON();
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `MOBI_POS_INDEXEDDB_BACKUP_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed:', e);
    }
  },

  importDatabase: async (jsonString: string) => {
    const res = await backupRepository.importJSON(jsonString);
    if (res.success) {
      await get().initDatabase();
    }
    return res;
  },

  // ══════════════════════════════════════════
  // Payment
  // ══════════════════════════════════════════

  setCashTendered: (amount) => set({ cashTendered: amount }),

  processPayment: (tenders) => {
    const { cart, currentCustomer, cashTendered, products, transactions, pricingTier, storeCreditApplied, logSecurityAction, customers } = get();
    if (cart.length === 0) return { success: false, reason: 'EMPTY_CART' };

    // IMEI enforcement for serialized items
    const missingIMEI = cart.find((item) => item.product.isSerialized && (!item.imeiNumber || item.imeiNumber.trim() === ''));
    if (missingIMEI) {
      return { success: false, reason: `IMEI_REQUIRED:${missingIMEI.product.title}` };
    }

    const grossSubtotal = cart.reduce((acc, item) => {
      const itemPrice =
        item.appliedPrice !== undefined
          ? item.appliedPrice
          : pricingTier === 'Wholesale'
          ? item.product.wholesalePrice || item.product.price * 0.75
          : item.product.price;
      return acc + itemPrice * item.quantity - (item.discount || 0);
    }, 0);

    const actualStoreCreditApplied = tenders 
      ? tenders.filter(t => t.method === 'Avoir Client').reduce((acc, t) => acc + t.amount, 0)
      : storeCreditApplied;

    if (actualStoreCreditApplied > 0 && currentCustomer) {
      if (actualStoreCreditApplied > currentCustomer.storeCredit) {
        return { success: false, reason: 'INSUFFICIENT_STORE_CREDIT' };
      }
    }

    const total = Math.max(0, grossSubtotal - actualStoreCreditApplied);

    // Validate cash is sufficient
    const totalTendered = tenders 
      ? tenders.filter(t => t.method !== 'Avoir Client').reduce((acc, t) => acc + t.amount, 0)
      : cashTendered;

    if (totalTendered < total) {
      return { success: false, reason: 'INSUFFICIENT_CASH' };
    }

    const changeDue = Math.max(0, totalTendered - total);
    const costTotal = cart.reduce((acc, item) => acc + (item.product.costPrice || item.product.price * 0.4) * item.quantity, 0);
    
    // Exact Net Profit = Net Revenue (Total After All Discounts & Credit) minus Total Cost of Goods Sold (COGS)
    const profit = total - costTotal;
    const profitMargin = total > 0 ? Number(((profit / total) * 100).toFixed(1)) : 0;

    let hasSyncConflict = false;
    const updatedProducts = products.map((p) => {
      const cartMatch = cart.find((item) => item.product.id === p.id);
      if (cartMatch) {
        const newStock = p.stock - cartMatch.quantity;
        if (newStock < 0) hasSyncConflict = true;
        return { ...p, stock: Math.max(0, newStock) };
      }
      return p;
    });

    if (hasSyncConflict) {
      logSecurityAction('Conflit de Sync Stock Négatif (CRDT)', 'Vente enregistrée avec stock final à 0 un.', 'Système Local', false);
    }

    // Update customer credit, loyalty points, tier & ledger history
    let updatedCustomer = currentCustomer;
    let updatedCustomers = customers;
    if (currentCustomer) {
      const currentTotalSpent = currentCustomer.totalSpent || 0;
      const currentTier = calculateCustomerTier(currentTotalSpent);
      const earnedPoints = calculateEarnedPoints(total, currentTier.pointsMultiplier);
      const newTotalSpent = currentTotalSpent + total;
      const newTier = calculateCustomerTier(newTotalSpent);

      // Rule: Every 20,000 DA spent unlocks 1,000 DA Store Credit Bonus
      const prev20kMilestones = Math.floor(currentTotalSpent / 20000);
      const new20kMilestones = Math.floor(newTotalSpent / 20000);
      const milestoneBonusUnlocked = Math.max(0, new20kMilestones - prev20kMilestones);
      const earnedCreditBonus = milestoneBonusUnlocked * 1000;

      const newCredit = Math.max(0, currentCustomer.storeCredit - actualStoreCreditApplied) + earnedCreditBonus;
      const newPoints = currentCustomer.loyaltyPoints + earnedPoints;

      const txnId = `TXN-${Math.floor(100000 + Math.random() * 900000)}`;
      const receiptNo = `REC-${Date.now().toString().slice(-6)}`;

      const newEntries: LoyaltyLedgerEntry[] = [];
      if (earnedPoints > 0) {
        newEntries.push(createLedgerEntry(
          currentCustomer.id,
          'earn',
          earnedPoints,
          newPoints,
          `Achat Ticket ${receiptNo} (${total} DA - Multiplicateur ${currentTier.name} ${currentTier.pointsMultiplier}x)`,
          txnId
        ));
      }

      if (earnedCreditBonus > 0) {
        newEntries.push(createLedgerEntry(
          currentCustomer.id,
          'bonus',
          0,
          newPoints,
          `🎁 Bonus Palier 20 000 DA Atteint : +${earnedCreditBonus} DA Crédit Avoir Client`,
          txnId
        ));
      }

      const existingLedger = currentCustomer.ledger || [];
      updatedCustomer = {
        ...currentCustomer,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        ledger: [...newEntries, ...existingLedger],
      };

      updatedCustomers = customers.map((c) =>
        c.id === currentCustomer.id ? updatedCustomer! : c
      );
      customerRepository.save(updatedCustomer!);
    }

    const transaction: SaleTransaction = {
      id: `TXN-${Math.floor(100000 + Math.random() * 900000)}`,
      receiptNumber: `REC-${Date.now().toString().slice(-6)}`,
      customer: updatedCustomer,
      items: [...cart],
      subtotal: grossSubtotal,
      discountTotal: cart.reduce((acc, item) => acc + item.discount, 0),
      total,
      costTotal,
      profit,
      profitMargin,
      pricingTier,
      paymentMethod: tenders && tenders.length > 0 ? tenders[0].method : 'Espèces',
      tenders,
      cashTendered: tenders ? tenders.reduce((acc, t) => acc + t.amount, 0) : cashTendered,
      changeDue,
      createdAt: new Date().toLocaleDateString('fr-DZ', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    };

    const newTransactions = [transaction, ...transactions];

    sqliteAdapter.processSaleTransactionAtomic(
      transaction,
      updatedProducts,
      updatedCustomer || undefined,
      undefined
    );

    soundEngine.playSuccess();
    soundEngine.playCashDrawer();

    set({
      products: updatedProducts,
      transactions: newTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer,
      lastTransaction: transaction,
      cart: [],
      cashTendered: 0,
      storeCreditApplied: 0,
      activeModal: null,
      hardwareStatus: { ...get().hardwareStatus, cashDrawerOpen: true },
    });

    return { success: true };
  },

  quickCashPayment: () => {
    const { cart, pricingTier, processPayment } = get();
    if (cart.length === 0) return { success: false, reason: 'EMPTY_CART' };

    const grossSubtotal = cart.reduce((acc, item) => {
      const itemPrice =
        item.appliedPrice !== undefined
          ? item.appliedPrice
          : pricingTier === 'Wholesale'
          ? item.product.wholesalePrice || item.product.price * 0.75
          : item.product.price;
      return acc + itemPrice * item.quantity - (item.discount || 0);
    }, 0);

    return processPayment([{ method: 'Espèces', amount: grossSubtotal }]);
  },

  voidTransaction: async (transactionId, reason, cashierName) => {
    const { transactions, products, customers, logSecurityAction } = get();
    const txn = transactions.find((t) => t.id === transactionId);
    if (!txn) {
      return { success: false, reason: 'TRANSACTION_NOT_FOUND' };
    }
    if (txn.status === 'VOIDED') {
      return { success: false, reason: 'ALREADY_VOIDED' };
    }

    // 1. Restore Product inventory (+qty for sold items)
    const updatedProducts = products.map((p) => {
      const soldItem = txn.items.find((item) => item.product.id === p.id);
      if (soldItem) {
        return { ...p, stock: p.stock + soldItem.quantity };
      }
      return p;
    });

    // 2. Gather Serialized IMEIs to release
    const restoredImeis = txn.items
      .filter((item) => item.imeiNumber && item.imeiNumber.trim() !== '')
      .map((item) => item.imeiNumber!.trim());

    // 3. Customer loyalty & store credit rollback
    let updatedCustomer: Customer | undefined = undefined;
    let updatedCustomers = customers;
    if (txn.customer) {
      const cust = customers.find((c) => c.id === txn.customer!.id) || txn.customer;
      const currentTotalSpent = cust.totalSpent || 0;
      const newTotalSpent = Math.max(0, currentTotalSpent - txn.total);
      const newTier = calculateCustomerTier(newTotalSpent);

      // Deduct loyalty points that were earned on this sale
      const earnedPoints = calculateEarnedPoints(txn.total, newTier.pointsMultiplier);
      const newPoints = Math.max(0, cust.loyaltyPoints - earnedPoints);

      // If customer paid using Store Credit, restore it
      const storeCreditPaid = txn.tenders
        ? txn.tenders.filter((t) => t.method === 'Avoir Client').reduce((acc, t) => acc + t.amount, 0)
        : txn.paymentMethod === 'Avoir Client' ? txn.total : 0;
      const newCredit = (cust.storeCredit || 0) + storeCreditPaid;

      const ledgerEntry = createLedgerEntry(
        cust.id,
        'adjustment',
        -earnedPoints,
        newPoints,
        `Annulation Ticket #${txn.receiptNumber} (${reason}) - Points & Crédit restaurés`,
        txn.id
      );

      const existingLedger = cust.ledger || [];
      updatedCustomer = {
        ...cust,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        ledger: [ledgerEntry, ...existingLedger],
      };

      updatedCustomers = customers.map((c) => (c.id === updatedCustomer!.id ? updatedCustomer! : c));
    }

    // 4. Mark transaction as VOIDED
    const voidedTxn: SaleTransaction = {
      ...txn,
      status: 'VOIDED',
      voidReason: reason,
      voidedAt: new Date().toLocaleDateString('fr-DZ', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      voidedBy: cashierName || 'Manager',
    };

    const updatedTransactions = transactions.map((t) => (t.id === transactionId ? voidedTxn : t));

    // 5. Create Security Audit Entry
    const auditEntry: SecurityAuditLogEntry = {
      id: `AUDIT-${Date.now()}`,
      timestamp: new Date().toISOString(),
      user: cashierName || 'Manager',
      action: 'Annulation Vente (Erreur de Caisse)',
      details: `Ticket #${txn.receiptNumber} (${txn.total} DA) annulé. Motif: ${reason}`,
      requiresPin: true,
    };

    // 6. Execute atomic backend rollback
    await sqliteAdapter.voidTransactionAtomic(
      transactionId,
      voidedTxn,
      updatedProducts,
      updatedCustomer,
      restoredImeis,
      auditEntry
    );

    logSecurityAction(
      'Annulation Vente (Erreur)',
      `Ticket #${txn.receiptNumber} (${txn.total} DA) annulé. Motif: ${reason}`,
      cashierName || 'Manager',
      true
    );

    soundEngine.playSuccess();

    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      lastTransaction: voidedTxn,
    });

    return { success: true };
  },

  processRefund: async (payload) => {
    const { originalTransaction, refundItems, refundMethod, refundReason, cashierName } = payload;
    const { transactions, products, customers, logSecurityAction } = get();

    if (refundItems.length === 0) {
      return { success: false, reason: 'NO_ITEMS_SELECTED' };
    }

    const refundTotal = refundItems.reduce((acc, i) => acc + i.totalRefundAmount, 0);
    const costRefundTotal = refundItems.reduce((acc, ri) => {
      const prod = products.find((p) => p.id === ri.productId);
      return acc + (prod?.costPrice || ri.unitPrice * 0.4) * ri.quantity;
    }, 0);

    // 1. Restock products where restock === true
    const updatedProducts = products.map((p) => {
      const rItem = refundItems.find((item) => item.productId === p.id && item.restock);
      if (rItem) {
        return { ...p, stock: p.stock + rItem.quantity };
      }
      return p;
    });

    // 2. Restored IMEIs
    const restoredImeis = refundItems
      .filter((i) => i.restock && i.imeiNumber && i.imeiNumber.trim() !== '')
      .map((i) => i.imeiNumber!.trim());

    // 3. Customer updates: If refundMethod is 'Avoir Client', issue store credit
    let updatedCustomer: Customer | undefined = undefined;
    let updatedCustomers = customers;

    if (originalTransaction.customer) {
      const cust = customers.find((c) => c.id === originalTransaction.customer!.id) || originalTransaction.customer;
      const currentTotalSpent = cust.totalSpent || 0;
      const newTotalSpent = Math.max(0, currentTotalSpent - refundTotal);
      const newTier = calculateCustomerTier(newTotalSpent);

      // Points deduction proportional to refunded amount
      const pointsToDeduct = calculateEarnedPoints(refundTotal, newTier.pointsMultiplier);
      const newPoints = Math.max(0, cust.loyaltyPoints - pointsToDeduct);

      // Add Store Credit if refunded via 'Avoir Client'
      const creditToAdd = refundMethod === 'Avoir Client' ? refundTotal : 0;
      const newCredit = (cust.storeCredit || 0) + creditToAdd;

      const ledgerEntries: LoyaltyLedgerEntry[] = [];
      if (creditToAdd > 0) {
        ledgerEntries.push(
          createLedgerEntry(
            cust.id,
            'conversion',
            0,
            newPoints,
            `Émission Avoir Client (${refundTotal} DA) suite au retour Ticket #${originalTransaction.receiptNumber}`,
            originalTransaction.id
          )
        );
      }
      if (pointsToDeduct > 0) {
        ledgerEntries.push(
          createLedgerEntry(
            cust.id,
            'adjustment',
            -pointsToDeduct,
            newPoints,
            `Déduction points fidélité (${pointsToDeduct} pts) suite au remboursement Ticket #${originalTransaction.receiptNumber}`,
            originalTransaction.id
          )
        );
      }

      const existingLedger = cust.ledger || [];
      updatedCustomer = {
        ...cust,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        ledger: [...ledgerEntries, ...existingLedger],
      };

      updatedCustomers = customers.map((c) => (c.id === updatedCustomer!.id ? updatedCustomer! : c));
    }

    // 4. Create Refund Transaction
    const refundReceiptNumber = `AVOIR-${Date.now().toString().slice(-6)}`;
    const refundTxnId = `REF-${Math.floor(100000 + Math.random() * 900000)}`;

    const refundTransaction: SaleTransaction = {
      id: refundTxnId,
      receiptNumber: refundReceiptNumber,
      status: 'COMPLETED',
      isRefund: true,
      originalReceiptNumber: originalTransaction.receiptNumber,
      originalTransactionId: originalTransaction.id,
      refundReason,
      refundMethod,
      refundedItems: refundItems,
      customer: updatedCustomer || originalTransaction.customer,
      items: refundItems.map((ri) => {
        const origProd = products.find((p) => p.id === ri.productId) || {
          id: ri.productId,
          title: ri.title,
          sku: ri.sku,
          price: ri.unitPrice,
        } as Product;
        return {
          product: origProd,
          quantity: ri.quantity,
          discount: 0,
          appliedPrice: ri.unitPrice,
          imeiNumber: ri.imeiNumber,
        };
      }),
      subtotal: refundTotal,
      discountTotal: 0,
      total: refundTotal,
      costTotal: costRefundTotal,
      profit: 0,
      profitMargin: 0,
      pricingTier: originalTransaction.pricingTier,
      paymentMethod: refundMethod,
      cashTendered: refundMethod === 'Espèces' ? refundTotal : 0,
      changeDue: 0,
      createdAt: new Date().toLocaleDateString('fr-DZ', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    };

    // 5. Update Original Transaction status
    const totalOrigItems = originalTransaction.items.reduce((acc, i) => acc + i.quantity, 0);
    const totalRefundedItems = refundItems.reduce((acc, i) => acc + i.quantity, 0);
    const isFullyRefunded = totalRefundedItems >= totalOrigItems;

    const updatedOriginalTransaction: SaleTransaction = {
      ...originalTransaction,
      status: isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    };

    const updatedTransactions = [
      refundTransaction,
      ...transactions.map((t) => (t.id === originalTransaction.id ? updatedOriginalTransaction : t)),
    ];

    // 6. Create Audit Log
    const auditEntry: SecurityAuditLogEntry = {
      id: `AUDIT-${Date.now()}`,
      timestamp: new Date().toISOString(),
      user: cashierName || 'Manager',
      action: 'Remboursement / Avoir Émis',
      details: `Avoir #${refundReceiptNumber} (${refundTotal} DA en ${refundMethod}) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}`,
      requiresPin: true,
    };

    // 7. Atomic SQLite Execution
    await sqliteAdapter.processRefundAtomic(
      refundTransaction,
      updatedOriginalTransaction,
      updatedProducts,
      updatedCustomer,
      restoredImeis,
      auditEntry
    );

    logSecurityAction(
      'Remboursement / Avoir Émis',
      `Avoir #${refundReceiptNumber} (${refundTotal} DA en ${refundMethod}) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}`,
      cashierName || 'Manager',
      true
    );

    soundEngine.playSuccess();
    if (refundMethod === 'Espèces') {
      soundEngine.playCashDrawer();
    }

    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      lastTransaction: refundTransaction,
      activeModal: 'receipt', // Automatically show the Avoir / Refund thermal receipt!
      hardwareStatus: refundMethod === 'Espèces' ? { ...get().hardwareStatus, cashDrawerOpen: true } : get().hardwareStatus,
    });

    return { success: true, refundTransaction };
  },

  // ══════════════════════════════════════════
  // Receipts & Settings
  // ══════════════════════════════════════════

  setReceiptSettings: async (settings) => {
    await settingsRepository.set('mobi_pos_receipt_settings', settings);
    set({ receiptSettings: settings });
  },

  reprintReceipt: (transaction) => {
    set({
      lastTransaction: transaction,
      activeModal: 'receipt',
    });
  },

  // ══════════════════════════════════════════
  // Security
  // ══════════════════════════════════════════

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
    return pin === '1234';
  },

  // ══════════════════════════════════════════
  // Purchase Orders
  // ══════════════════════════════════════════

  createDraftPOForVendor: (vendorName, customItems) => {
    const { products } = get();

    let lineItems: POLineItem[];

    if (customItems && customItems.length > 0) {
      lineItems = customItems.map((ci) => {
        const p = products.find((prod) => prod.id === ci.productId);
        const unitCost = ci.unitCost !== undefined ? ci.unitCost : (p ? p.costPrice : 1500);
        return {
          productId: ci.productId,
          title: p ? p.title : 'Produit',
          sku: p ? p.sku : 'SKU-N/A',
          currentStock: p ? p.stock : 0,
          suggestedQty: ci.qty,
          unitCost,
          totalCost: ci.qty * unitCost,
        };
      });
    } else {
      const alerts = calculateStockAlerts(products).filter(
        (a) => (a.vendorName || 'Fournisseur Général') === vendorName
      );

      lineItems = alerts.map((a) => {
        const p = products.find((prod) => prod.id === a.productId)!;
        const suggestedQty = Math.max(1, (p.reorderPoint || 10) * 2 - p.stock);
        const unitCost = p.costPrice || p.price * 0.4;
        return {
          productId: p.id,
          title: p.title,
          sku: p.sku,
          currentStock: p.stock,
          suggestedQty,
          unitCost,
          totalCost: suggestedQty * unitCost,
        };
      });
    }

    const totalAmount = lineItems.reduce((acc, item) => acc + item.totalCost, 0);

    const draftPO: PurchaseOrder = {
      id: `po-${Date.now()}`,
      poNumber: `PO-${Date.now().toString().slice(-6)}`,
      vendorName,
      createdAt: new Date().toLocaleDateString('fr-DZ'),
      items: lineItems,
      totalAmount,
      status: 'Draft',
    };

    set({ activeDraftPO: draftPO, activeModal: 'purchase_order' });
  },

  directRestockVendor: async (vendorName, items) => {
    const { products, logSecurityAction } = get();
    if (!items || items.length === 0) return { success: false, count: 0 };

    const itemsMap = new Map(items.map((i) => [i.productId, i.qty]));
    let restockedUnits = 0;

    const updatedProducts = products.map((p) => {
      if (itemsMap.has(p.id)) {
        const addedQty = itemsMap.get(p.id) || 0;
        restockedUnits += addedQty;
        return { ...p, stock: p.stock + addedQty };
      }
      return p;
    });

    try {
      await productRepository.bulkSave(updatedProducts);
      soundEngine.playSuccess();
      logSecurityAction(
        'Réception Directe Fournisseur (JIT Restock)',
        `Entrée en stock rapide pour ${vendorName} : ${items.length} références (+${restockedUnits} unités)`,
        'Yacine (Admin)',
        false
      );
      set({ products: updatedProducts });
      return { success: true, count: restockedUnits };
    } catch (e) {
      console.error('Direct restock failed:', e);
      return { success: false, count: 0 };
    }
  },

  approvePurchaseOrder: async (poId) => {
    const { activeDraftPO, purchaseOrders, products } = get();
    if (!activeDraftPO || activeDraftPO.id !== poId) return;

    const approvedPO: PurchaseOrder = { ...activeDraftPO, status: 'Approved' };

    const updatedProducts = products.map((p) => {
      const poItem = approvedPO.items.find((item) => item.productId === p.id);
      if (poItem) {
        return { ...p, stock: p.stock + poItem.suggestedQty, purchaseOrderId: approvedPO.id };
      }
      return p;
    });

    const updatedPOs = [approvedPO, ...purchaseOrders];
    await productRepository.bulkSave(updatedProducts);
    await sqliteAdapter.savePurchaseOrder(approvedPO);

    set({
      products: updatedProducts,
      purchaseOrders: updatedPOs,
      activeDraftPO: null,
      activeModal: null,
    });
  },

  // ══════════════════════════════════════════
  // Repair Orders
  // ══════════════════════════════════════════

  createRepairOrder: async (orderInput) => {
    const { repairOrders } = get();
    const totalCost = orderInput.laborCost + orderInput.partsCost;
    const newOrder: RepairOrder = {
      ...orderInput,
      id: `rep-${Date.now()}`,
      ticketNumber: `REP-${Math.floor(1000 + Math.random() * 9000)}`,
      totalCost,
      createdAt: new Date().toLocaleDateString('fr-DZ', { hour: '2-digit', minute: '2-digit' } as Intl.DateTimeFormatOptions),
    };
    const updated = [newOrder, ...repairOrders];
    await repairRepository.save(newOrder);
    set({ repairOrders: updated });
  },

  updateRepairOrderStatus: async (orderId, newStatus) => {
    const { repairOrders } = get();
    const updated = repairOrders.map((r) =>
      r.id === orderId ? { ...r, status: newStatus, updatedAt: new Date().toLocaleDateString('fr-DZ', { hour: '2-digit', minute: '2-digit' } as Intl.DateTimeFormatOptions) } : r
    );
    const target = updated.find((r) => r.id === orderId);
    if (target) {
      await repairRepository.save(target);
    }
    set({ repairOrders: updated });
  },

  updateRepairOrder: async (orderId, updates) => {
    const { repairOrders } = get();
    const updated = repairOrders.map((r) =>
      r.id === orderId
        ? {
            ...r,
            ...updates,
            totalCost: (updates.laborCost ?? r.laborCost) + (updates.partsCost ?? r.partsCost),
            updatedAt: new Date().toLocaleDateString('fr-DZ', { hour: '2-digit', minute: '2-digit' } as Intl.DateTimeFormatOptions),
          }
        : r
    );
    const target = updated.find((r) => r.id === orderId);
    if (target) {
      await repairRepository.save(target);
    }
    set({ repairOrders: updated });
  },

  // ══════════════════════════════════════════
  // Trade-In
  // ══════════════════════════════════════════

  processTradeIn: async (tradeInput) => {
    const { tradeIns, products, customers, currentCustomer } = get();

    const resalePrice = Math.round(tradeInput.buybackValue * (1 + tradeInput.resaleMarginPercent / 100));

    const newTradeIn: TradeInItem = {
      ...tradeInput,
      resalePrice,
      id: `trade-${Date.now()}`,
      createdAt: new Date().toLocaleDateString('fr-DZ', { hour: '2-digit', minute: '2-digit' } as Intl.DateTimeFormatOptions),
    };

    // Convert trade-in directly into sellable serialized inventory product
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
      imageUrl: 'https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=300&auto=format&fit=crop&q=80',
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

    // Issue store credit if requested
    let updatedCustomers = customers;
    let updatedCurrentCustomer = currentCustomer;
    if (tradeInput.creditToWallet && currentCustomer) {
      updatedCustomers = customers.map((c) =>
        c.id === currentCustomer.id ? { ...c, storeCredit: c.storeCredit + tradeInput.buybackValue } : c
      );
      updatedCurrentCustomer = { ...currentCustomer, storeCredit: currentCustomer.storeCredit + tradeInput.buybackValue };
      await customerRepository.save(updatedCurrentCustomer);
    }

    set({
      products: updatedProducts,
      tradeIns: updatedTradeIns,
      customers: updatedCustomers,
      currentCustomer: updatedCurrentCustomer,
      activeModal: null,
    });
  },

  // ══════════════════════════════════════════
  // Bundles
  // ══════════════════════════════════════════

  createBundle: async (bundleInput) => {
    const { bundles } = get();
    const newBundle: ProductBundle = {
      ...bundleInput,
      id: `bndl-${Date.now()}`,
    };
    const updated = [newBundle, ...bundles];
    await sqliteAdapter.saveBundle(newBundle);
    set({ bundles: updated });
  },

  deleteBundle: async (bundleId) => {
    const { bundles } = get();
    const updated = bundles.filter((b) => b.id !== bundleId);
    await sqliteAdapter.deleteBundle(bundleId);
    set({ bundles: updated });
  },

  addBundleToCart: (bundleId) => {
    const { bundles, products, cart } = get();
    const bundle = bundles.find((b) => b.id === bundleId);
    if (!bundle) return { success: false, reason: 'BUNDLE_NOT_FOUND' };

    // Validate all child SKUs have stock
    const outOfStock = bundle.childSkus.filter((sku) => {
      const product = products.find((p) => p.sku === sku);
      return !product || product.stock <= 0;
    });

    if (outOfStock.length > 0) {
      return { success: false, reason: `CHILD_OUT_OF_STOCK:${outOfStock.join(',')}` };
    }

    const childProducts = bundle.childSkus
      .map((sku) => products.find((p) => p.sku === sku))
      .filter((p): p is Product => p !== undefined);

    const regularSum = childProducts.reduce((sum, p) => sum + p.price, 0);
    const bundleDiscountTotal = Math.max(0, regularSum - bundle.bundlePrice);

    let updatedCart = [...cart];

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

  // ══════════════════════════════════════════
  // Cash Drops
  // ══════════════════════════════════════════

  addCashDrop: async (entry) => {
    const { cashDrops } = get();
    const newDrop: CashDropEntry = {
      ...entry,
      id: `drop-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    };
    const updated = [newDrop, ...cashDrops];
    await sqliteAdapter.saveCashDrop(newDrop, false);
    set({ cashDrops: updated });
  },

  // ══════════════════════════════════════════
  // IMEI
  // ══════════════════════════════════════════

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
}));
