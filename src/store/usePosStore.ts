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
} from '../types/pos';
import { INITIAL_PRODUCTS, INITIAL_CUSTOMERS } from '../data/mockData';
import {
  calculateCustomerTier,
  calculateEarnedPoints,
  convertPointsToCredit,
  createLedgerEntry,
} from '../utils/loyaltyEngine';
import { calculateStockAlerts } from '../utils/alertEngine';

// ──────────────────────────────────────────────
// State Interface
// ──────────────────────────────────────────────

interface PosState {
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
    | null;
  pendingPinAction: (() => void) | null;
  editingProduct: Product | null;
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
  saveProduct: (productInput: ProductInput) => void;
  deleteProduct: (id: string) => void;

  // ── Customers ──
  addCustomer: (customer: CustomerInput) => void;
  updateCustomer: (id: string, updates: Partial<Customer>) => void;
  deleteCustomer: (id: string) => void;
  setCurrentCustomer: (customer: Customer | null) => void;
  issueStoreCredit: (customerId: string, amount: number) => void;
  redeemLoyaltyPoints: (customerId: string, points: number) => { success: boolean; creditAdded?: number; reason?: string };
  adjustCustomerPoints: (customerId: string, points: number, description: string) => void;

  // ── Database Backup ──
  exportDatabase: () => void;
  importDatabase: (jsonString: string) => { success: boolean; reason?: string };

  // ── Payment ──
  setCashTendered: (amount: number) => void;
  processPayment: (tenders?: PaymentTender[]) => { success: boolean; reason?: string };
  quickCashPayment: () => { success: boolean; reason?: string };

  // ── Receipts & Settings ──
  setReceiptSettings: (settings: ReceiptSettings) => void;
  reprintReceipt: (transaction: SaleTransaction) => void;

  // ── Security ──
  logSecurityAction: (action: string, details: string, user?: string, requiresPin?: boolean) => void;
  verifyManagerPin: (pin: string) => boolean;

  // ── Purchase Orders ──
  createDraftPOForVendor: (vendorName: string) => void;
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
// Persistence Loaders
// ──────────────────────────────────────────────

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(fallback)) {
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as T;
      } else {
        return parsed as T;
      }
    }
  } catch (e) {
    console.error(`Failed to load ${key}`, e);
  }
  return fallback;
}


function persistSync(key: string, data: unknown) {
  localStorage.setItem(key, JSON.stringify(data));
}

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
  themeMode: initialTheme,
  pricingTier: 'Retail',
  products: loadPersisted('mobi_pos_products', INITIAL_PRODUCTS),
  sortOption: 'name_asc',
  cart: [],
  selectedCategory: 'Tous les produits',
  searchQuery: '',
  customers: loadPersisted('mobi_pos_customers', INITIAL_CUSTOMERS),
  currentCustomer: null,
  heldSales: [],
  transactions: loadPersisted('mobi_pos_transactions', [] as SaleTransaction[]),
  securityAuditLog: [
    {
      id: 'log-1',
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      user: 'Yacine (Admin)',
      action: 'Initialisation Système POS',
      details: 'Caisse démarrée avec succès',
      requiresPin: false,
    },
  ],
  shiftFloat: 20000,
  cashDrops: loadPersisted('mobi_pos_cashdrops', [] as CashDropEntry[]),
  payouts: loadPersisted('mobi_pos_payouts', [] as CashDropEntry[]),
  receiptSettings: loadPersisted('mobi_pos_receipt_settings', {
    storeName: 'ACCESSOIRES MOBI',
    storeSubheader: 'Vente Accessoires & Téléphonie',
    logoUrl: '',
    address: 'Boulevard Mohamed V, Alger Centre',
    phone: '021 65 43 21 / 0550 00 11 22',
    email: 'contact@mobi-accessories.dz',
    taxId: 'RC: 16/00-0123456B22 • NIF: 002216012345678',
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
  }),
  licenseDetails: {
    machineFingerprint: 'CPU-HWID-9F82A-DZ-2026',
    status: 'Active',
    licenseKey: 'ED25519-MOBI-ENTERPRISE-8921-OK',
    maxTerminals: 5,
    activatedAt: '01/08/2026',
  },
  purchaseOrders: loadPersisted('mobi_pos_purchaseorders', [] as PurchaseOrder[]),
  activeDraftPO: null,
  storeCreditApplied: 0,
  repairOrders: loadPersisted('mobi_pos_repairs', [] as RepairOrder[]),
  bundles: loadPersisted('mobi_pos_bundles', [
    {
      id: 'bndl-1',
      bundleTitle: 'Pack Protection Intégral iPhone 15 Pro Max',
      barcode: '990000112233',
      bundlePrice: 4800,
      childSkus: ['APC-15PM-CL', 'ZAGG-15PM-TG'],
    },
  ] as ProductBundle[]),
  tradeIns: loadPersisted('mobi_pos_tradeins', [] as TradeInItem[]),
  imeiRecords: loadPersisted('mobi_pos_imei', [] as IMEIRecord[]),
  activeModal: null,
  pendingPinAction: null,
  editingProduct: null,
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
  closeModal: () => set({ activeModal: null, editingProduct: null }),
  setPendingPinAction: (action) => set({ pendingPinAction: action }),

  // ══════════════════════════════════════════
  // Cart
  // ══════════════════════════════════════════

  addToCart: (product, overridePin = false) => {
    const { cart, pricingTier, logSecurityAction } = get();

    const existingIndex = cart.findIndex((item) => item.product.id === product.id);
    const currentQtyInCart = existingIndex >= 0 ? cart[existingIndex].quantity : 0;

    // Block zero-stock or exceeding stock unless overridden by PIN
    if (currentQtyInCart + 1 > product.stock && !overridePin) {
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

  saveProduct: (input) => {
    const { products } = get();
    let updatedProducts: Product[];
    if (input.id) {
      updatedProducts = products.map((p) => (p.id === input.id ? (input as Product) : p));
    } else {
      const newProduct: Product = {
        ...(input as Omit<Product, 'id'>),
        id: `prod-${Date.now()}`,
      };
      updatedProducts = [newProduct, ...products];
    }
    persistSync('mobi_pos_products', updatedProducts);
    set({ products: updatedProducts, activeModal: null, editingProduct: null });
  },

  deleteProduct: (id) => {
    const { products, cart } = get();
    const updatedProducts = products.filter((p) => p.id !== id);
    const updatedCart = cart.filter((item) => item.product.id !== id);
    persistSync('mobi_pos_products', updatedProducts);
    set({ products: updatedProducts, cart: updatedCart });
  },

  // ══════════════════════════════════════════
  // Customers
  // ══════════════════════════════════════════

  addCustomer: (input) => {
    const { customers } = get();
    const newCustomer: Customer = {
      ...(input as Omit<Customer, 'id'>),
      id: input.id || `cust-${Date.now()}`,
    };
    const updated = [newCustomer, ...customers];
    persistSync('mobi_pos_customers', updated);
    set({ customers: updated });
  },

  updateCustomer: (id, updates) => {
    const { customers, currentCustomer } = get();
    const updated = customers.map((c) => (c.id === id ? { ...c, ...updates } : c));
    persistSync('mobi_pos_customers', updated);
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === id) {
      newState.currentCustomer = { ...currentCustomer, ...updates };
      if (updates.pricingTier) newState.pricingTier = updates.pricingTier;
    }
    set(newState as PosState);
  },

  deleteCustomer: (id) => {
    const { customers, currentCustomer } = get();
    const updated = customers.filter((c) => c.id !== id);
    persistSync('mobi_pos_customers', updated);
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

  issueStoreCredit: (customerId, amount) => {
    const { customers, currentCustomer } = get();
    const updated = customers.map((c) =>
      c.id === customerId ? { ...c, storeCredit: c.storeCredit + amount } : c
    );
    persistSync('mobi_pos_customers', updated);
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === customerId) {
      newState.currentCustomer = { ...currentCustomer, storeCredit: currentCustomer.storeCredit + amount };
    }
    set(newState as PosState);
  },

  redeemLoyaltyPoints: (customerId, points) => {
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
    persistSync('mobi_pos_customers', updatedCustomers);

    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
    return { success: true, creditAdded: creditAmount };
  },

  adjustCustomerPoints: (customerId, points, description) => {
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
    persistSync('mobi_pos_customers', updatedCustomers);

    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
  },

  // ══════════════════════════════════════════
  // Database Backup & Restore
  // ══════════════════════════════════════════

  exportDatabase: () => {
    const { products, customers, transactions, repairOrders, bundles, tradeIns, imeiRecords, receiptSettings } = get();
    const data = {
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
      products,
      customers,
      transactions,
      repairOrders,
      bundles,
      tradeIns,
      imeiRecords,
      receiptSettings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MOBI_POS_BACKUP_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  importDatabase: (jsonString) => {
    try {
      const data = JSON.parse(jsonString);
      if (!data.products || !Array.isArray(data.products)) {
        return { success: false, reason: 'Format JSON invalide' };
      }
      if (data.products) persistSync('mobi_pos_products', data.products);
      if (data.customers) persistSync('mobi_pos_customers', data.customers);
      if (data.transactions) persistSync('mobi_pos_transactions', data.transactions);
      if (data.repairOrders) persistSync('mobi_pos_repairs', data.repairOrders);
      if (data.bundles) persistSync('mobi_pos_bundles', data.bundles);
      if (data.tradeIns) persistSync('mobi_pos_tradeins', data.tradeIns);
      if (data.imeiRecords) persistSync('mobi_pos_imei', data.imeiRecords);

      set({
        products: data.products || get().products,
        customers: data.customers || get().customers,
        transactions: data.transactions || get().transactions,
        repairOrders: data.repairOrders || get().repairOrders,
        bundles: data.bundles || get().bundles,
        tradeIns: data.tradeIns || get().tradeIns,
        imeiRecords: data.imeiRecords || get().imeiRecords,
        receiptSettings: data.receiptSettings || get().receiptSettings,
      });
      return { success: true };
    } catch {
      return { success: false, reason: 'Fichier JSON corrompu ou illisible' };
    }
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
        pricingTier === 'Wholesale' ? item.product.wholesalePrice || item.product.price * 0.75 : item.product.price;
      return acc + itemPrice * item.quantity - item.discount;
    }, 0);

    const tax = 0;
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
      persistSync('mobi_pos_customers', updatedCustomers);
    }

    const transaction: SaleTransaction = {
      id: `TXN-${Math.floor(100000 + Math.random() * 900000)}`,
      receiptNumber: `REC-${Date.now().toString().slice(-6)}`,
      customer: updatedCustomer,
      items: [...cart],
      subtotal: grossSubtotal,
      tax,
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

    persistSync('mobi_pos_products', updatedProducts);
    persistSync('mobi_pos_transactions', newTransactions);

    set({
      products: updatedProducts,
      transactions: newTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer,
      lastTransaction: transaction,
      cart: [],
      cashTendered: 0,
      storeCreditApplied: 0,
      activeModal: 'receipt',
      hardwareStatus: { ...get().hardwareStatus, cashDrawerOpen: true },
    });

    return { success: true };
  },

  quickCashPayment: () => {
    const { cart, pricingTier, processPayment } = get();
    if (cart.length === 0) return { success: false, reason: 'EMPTY_CART' };

    const grossSubtotal = cart.reduce((acc, item) => {
      const itemPrice = pricingTier === 'Wholesale' ? item.product.wholesalePrice || item.product.price * 0.75 : item.product.price;
      return acc + itemPrice * item.quantity - item.discount;
    }, 0);

    return processPayment([{ method: 'Espèces', amount: grossSubtotal }]);
  },

  // ══════════════════════════════════════════
  // Receipts & Settings
  // ══════════════════════════════════════════

  setReceiptSettings: (settings) => {
    persistSync('mobi_pos_receipt_settings', settings);
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

  createDraftPOForVendor: (vendorName) => {
    const { products } = get();
    const alerts = calculateStockAlerts(products).filter((a) => a.vendorName === vendorName);

    const lineItems: POLineItem[] = alerts.map((a) => {
      const p = products.find((prod) => prod.id === a.productId)!;
      const suggestedQty = Math.max(10, (p.reorderPoint || 20) * 2 - p.stock);
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

  approvePurchaseOrder: (poId) => {
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
    persistSync('mobi_pos_products', updatedProducts);
    persistSync('mobi_pos_purchaseorders', updatedPOs);

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

  createRepairOrder: (orderInput) => {
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
    persistSync('mobi_pos_repairs', updated);
    set({ repairOrders: updated });
  },

  updateRepairOrderStatus: (orderId, newStatus) => {
    const { repairOrders } = get();
    const updated = repairOrders.map((r) =>
      r.id === orderId ? { ...r, status: newStatus, updatedAt: new Date().toLocaleDateString('fr-DZ', { hour: '2-digit', minute: '2-digit' } as Intl.DateTimeFormatOptions) } : r
    );
    persistSync('mobi_pos_repairs', updated);
    set({ repairOrders: updated });
  },

  updateRepairOrder: (orderId, updates) => {
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
    persistSync('mobi_pos_repairs', updated);
    set({ repairOrders: updated });
  },

  // ══════════════════════════════════════════
  // Trade-In
  // ══════════════════════════════════════════

  processTradeIn: (tradeInput) => {
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

    persistSync('mobi_pos_products', updatedProducts);
    persistSync('mobi_pos_tradeins', updatedTradeIns);

    // Issue store credit if requested
    let updatedCustomers = customers;
    let updatedCurrentCustomer = currentCustomer;
    if (tradeInput.creditToWallet && currentCustomer) {
      updatedCustomers = customers.map((c) =>
        c.id === currentCustomer.id ? { ...c, storeCredit: c.storeCredit + tradeInput.buybackValue } : c
      );
      updatedCurrentCustomer = { ...currentCustomer, storeCredit: currentCustomer.storeCredit + tradeInput.buybackValue };
      persistSync('mobi_pos_customers', updatedCustomers);
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

  createBundle: (bundleInput) => {
    const { bundles } = get();
    const newBundle: ProductBundle = {
      ...bundleInput,
      id: `bndl-${Date.now()}`,
    };
    const updated = [newBundle, ...bundles];
    persistSync('mobi_pos_bundles', updated);
    set({ bundles: updated });
  },

  deleteBundle: (bundleId) => {
    const { bundles } = get();
    const updated = bundles.filter((b) => b.id !== bundleId);
    persistSync('mobi_pos_bundles', updated);
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

  addCashDrop: (entry) => {
    const { cashDrops } = get();
    const newDrop: CashDropEntry = {
      ...entry,
      id: `drop-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    };
    const updated = [newDrop, ...cashDrops];
    persistSync('mobi_pos_cashdrops', updated);
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
