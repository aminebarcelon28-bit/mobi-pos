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
  RepairOrder,
  ProductBundle,
  TradeInItem,
  IMEIRecord,
  PaymentTender,
  PaymentMethodType,
  ProcessRefundPayload,
  CustomerDebtEntry,
  StoreExpense,
  CashSession,
  CashMovement,
  DenominationCount,
  InventoryValuation,
  ImeiLifecycleDossier,
} from '../types/pos';

export type ActiveModalType =
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
  | 'shift_open'
  | 'shift_movement'
  | 'shift_close'
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
  | 'whatsapp_dispatch'
  | 'imei_inspector'
  | 'command_tickets'
  | 'debt_ledger'
  | 'expense_manager'
  | 'db_maintenance'
  | 'mobile_simulator'
  | 'cloud_pairing'
  | null;

export interface CartSlice {
  cart: CartItem[];
  storeCreditApplied: number;
  heldSales: HeldSale[];

  addToCart: (product: Product, overridePin?: boolean, quantity?: number) => { success: boolean; reason?: string };
  updateCartQty: (productId: string, delta: number) => void;
  setCartItemQty: (productId: string, quantity: number) => void;
  removeFromCart: (productId: string) => void;
  clearCart: () => void;
  setCartItemDiscount: (productId: string, discount: number) => void;
  applyCartDiscountPercent: (percent: number) => void;
  setStoreCreditApplied: (amount: number) => void;
  setCartItemIMEI: (productId: string, imei: string) => void;

  holdSale: () => { success: boolean; reason?: string };
  retrieveSale: (saleId: string) => void;
  deleteHeldSale: (saleId: string) => void;
}

export interface CatalogSlice {
  products: Product[];
  selectedCategory: CategoryType;
  searchQuery: string;
  sortOption: SortOption;
  editingProduct: Product | null;

  setSortOption: (option: SortOption) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: CategoryType) => void;
  setEditingProduct: (product: Product | null) => void;
  saveProduct: (
    productInput: ProductInput,
    options?: { keepModalOpen?: boolean }
  ) => Promise<{ success: boolean; reason?: string }>;
  deleteProduct: (id: string) => Promise<void>;
  ingestInvoiceBatch: (updatedProducts: Product[], newImeis: IMEIRecord[]) => Promise<void>;
}

export interface CustomerSlice {
  customers: Customer[];
  currentCustomer: Customer | null;
  customerDebts: CustomerDebtEntry[];

  addCustomer: (customer: CustomerInput) => Promise<void>;
  updateCustomer: (id: string, updates: Partial<Customer>) => Promise<void>;
  deleteCustomer: (id: string) => Promise<void>;
  setCurrentCustomer: (customer: Customer | null) => void;
  issueStoreCredit: (customerId: string, amount: number) => Promise<void>;
  redeemLoyaltyPoints: (customerId: string, points: number) => Promise<{ success: boolean; creditAdded?: number; reason?: string }>;
  adjustCustomerPoints: (customerId: string, points: number, description: string) => Promise<void>;
  recordCustomerDebtPayment: (
    customerId: string,
    amount: number,
    method: PaymentMethodType,
    notes?: string
  ) => Promise<{ success: boolean; debtEntry?: CustomerDebtEntry }>;
}

export interface ShiftSlice {
  activeShift: CashSession | null;
  allShifts: CashSession[];
  shiftFloat: number;
  cashDrops: CashDropEntry[];
  payouts: CashDropEntry[];
  inventoryValuation: InventoryValuation | null;

  addCashDrop: (entry: Omit<CashDropEntry, 'id' | 'timestamp'>) => Promise<void>;
  startShift: (
    openingFloat: number,
    cashierName?: string,
    openingNote?: string,
    denominations?: DenominationCount
  ) => Promise<{ success: boolean; session?: CashSession; reason?: string }>;
  logCashMovement: (
    amount: number,
    type: 'EXPENSE' | 'MANUAL_DEPOSIT',
    reason: string,
    cashierName?: string
  ) => Promise<{ success: boolean; movement?: CashMovement; reason?: string }>;
  closeShift: (
    blindCount: number,
    closingNote?: string,
    cashierName?: string
  ) => Promise<{ success: boolean; session?: CashSession; reason?: string }>;
  fetchActiveShift: () => Promise<void>;
  fetchInventoryValuation: () => Promise<void>;
  fetchAllShifts: () => Promise<void>;
  printXReport: () => Promise<boolean>;
}

export interface OrderSlice {
  transactions: SaleTransaction[];
  lastTransaction: SaleTransaction | null;
  cashTendered: number;
  paymentMethod: 'Espèces';
  selectedTransactionForRefund: SaleTransaction | null;

  setCashTendered: (amount: number) => void;
  processPayment: (tenders?: PaymentTender[]) => Promise<{ success: boolean; reason?: string }>;
  quickCashPayment: () => Promise<{ success: boolean; reason?: string }>;
  voidTransaction: (transactionId: string, reason: string, cashierName?: string) => Promise<{ success: boolean; reason?: string }>;
  processRefund: (payload: ProcessRefundPayload) => Promise<{ success: boolean; refundTransaction?: SaleTransaction; reason?: string }>;
  reprintReceipt: (transaction: SaleTransaction) => void;
  setSelectedTransactionForRefund: (t: SaleTransaction | null) => void;
}

export interface RepairSlice {
  repairOrders: RepairOrder[];
  selectedRepairOrderForNotification: RepairOrder | null;

  createRepairOrder: (order: Omit<RepairOrder, 'id' | 'ticketNumber' | 'totalCost' | 'createdAt'>) => Promise<void>;
  updateRepairOrderStatus: (orderId: string, newStatus: RepairOrder['status']) => Promise<void>;
  updateRepairOrder: (orderId: string, updates: Partial<RepairOrder>) => Promise<void>;
  setSelectedRepairOrderForNotification: (order: RepairOrder | null) => void;
}

export interface ProcurementSlice {
  purchaseOrders: PurchaseOrder[];
  activeDraftPO: PurchaseOrder | null;
  dismissedProcurementIds: string[];

  dismissProcurementProduct: (productId: string) => void;
  restoreDismissedProcurementProducts: () => void;
  createDraftPOForVendor: (
    vendorName: string,
    customItems?: Array<{ productId: string; qty: number; unitCost?: number }>,
    status?: PurchaseOrder['status']
  ) => void;
  createWaitingListPO: (
    vendorName: string,
    customItems?: Array<{ productId: string; qty: number; unitCost?: number }>,
    notes?: string
  ) => Promise<PurchaseOrder>;
  validateAndReceivePO: (payload: {
    poId: string;
    verifiedItems: Array<{
      productId: string;
      receivedQty: number;
      actualUnitCost?: number;
      imeis?: string[];
      discrepancyReason?: string;
    }>;
    recordExpense?: boolean;
    expensePaymentMethod?: PaymentMethodType;
    notes?: string;
  }) => Promise<{ success: boolean; isPartial: boolean; totalReceivedCost: number }>;
  cancelPO: (poId: string, reason?: string) => Promise<void>;
  deletePO: (poId: string) => Promise<void>;
  directRestockVendor: (
    vendorName: string,
    items: Array<{ productId: string; qty: number }>
  ) => Promise<{ success: boolean; count: number }>;
  approvePurchaseOrder: (poId: string) => Promise<void>;
}

export interface UISlice {
  isDbInitialized: boolean;
  themeMode: 'dark' | 'light';
  pricingTier: PricingTier;
  activeModal: ActiveModalType;
  pendingPinAction: (() => void) | null;
  hardwareStatus: HardwareStatus;
  receiptSettings: ReceiptSettings;
  licenseDetails: LicenseDetails;
  bundles: ProductBundle[];
  tradeIns: TradeInItem[];
  imeiRecords: IMEIRecord[];
  activeImeiDossier: ImeiLifecycleDossier | null;
  managerPin: string;
  securityAuditLog: SecurityAuditLogEntry[];
  storeExpenses: StoreExpense[];

  toggleTheme: () => void;
  setPricingTier: (tier: PricingTier) => void;
  openModal: (modal: ActiveModalType) => void;
  closeModal: () => void;
  setPendingPinAction: (action: (() => void) | null) => void;
  setActiveImeiDossier: (dossier: ImeiLifecycleDossier | null) => void;
  setReceiptSettings: (settings: ReceiptSettings) => Promise<void>;
  setManagerPin: (newPin: string) => Promise<void>;
  logSecurityAction: (action: string, details: string, user?: string, requiresPin?: boolean) => void;
  verifyManagerPin: (pin: string) => boolean;

  createBundle: (bundle: Omit<ProductBundle, 'id'>) => Promise<void>;
  deleteBundle: (bundleId: string) => Promise<void>;
  addBundleToCart: (bundleId: string) => { success: boolean; reason?: string };
  processTradeIn: (tradeIn: Omit<TradeInItem, 'id' | 'createdAt' | 'resalePrice'>) => Promise<void>;
  addStoreExpense: (expense: Omit<StoreExpense, 'id' | 'createdAt'>) => Promise<void>;
  deleteStoreExpense: (id: string) => Promise<void>;

  validateIMEI: (imei: string) => { valid: boolean; reason?: string };
  searchByIMEI: (imei: string) => { product?: Product; po?: PurchaseOrder; transaction?: SaleTransaction } | null;

  initDatabase: () => Promise<void>;
  seedDemoData: () => Promise<void>;
  refreshAfterPull: () => Promise<void>;
  exportDatabase: () => void;
  importDatabase: (jsonString: string) => Promise<{ success: boolean; reason?: string }>;
}

export type PosState = CartSlice &
  CatalogSlice &
  CustomerSlice &
  ShiftSlice &
  OrderSlice &
  RepairSlice &
  ProcurementSlice &
  UISlice;
