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
  StagedTradeIn,
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
  CashierUser,
  CreditVoucher,
} from '../types/pos';
import type { PullTouchSummary } from '../sync/types';

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
  | 'credit_voucher'
  | 'product_matrix'
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
  | 'custom_item'
  | null;

export interface CartSlice {
  cart: CartItem[];
  storeCreditApplied: number;
  heldSales: HeldSale[];

  addToCart: (product: Product, overridePin?: boolean, quantity?: number, isReturn?: boolean) => { success: boolean; reason?: string };
  toggleCartItemReturn: (productId: string) => void;
  updateCartQty: (productId: string, delta: number) => void;
  setCartItemQty: (productId: string, quantity: number) => void;
  removeFromCart: (productId: string) => void;
  clearCart: () => void;
  setCartItemDiscount: (productId: string, discount: number) => void;
  applyCartDiscountPercent: (percent: number) => void;
  setStoreCreditApplied: (amount: number) => void;
  setCartItemIMEI: (productId: string, imei: string) => void;
  overrideCartItemPrice: (
    productId: string,
    newUnitPrice: number,
    managerApproved?: boolean
  ) => { success: boolean; requiresPin?: boolean; reason?: string };

  holdSale: () => { success: boolean; reason?: string };
  retrieveSale: (saleId: string) => { success: boolean; reason?: string; warnings?: string[] };
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
  ingestInvoiceBatch: (
    updatedProducts: Product[],
    newImeis: IMEIRecord[],
    receipts?: Array<{ productId: string; qty: number; unitCost: number }>,
    opts?: { importKey?: string },
  ) => Promise<void>;
  bulkSaveProducts: (newProducts: Product[]) => Promise<void>;
  applyStocktakeAudit: (items: { productId: string; countedStock: number; previousStock: number }[]) => Promise<void>;
}

export interface CustomerSlice {
  customers: Customer[];
  currentCustomer: Customer | null;
  customerDebts: CustomerDebtEntry[];

  addCustomer: (customer: CustomerInput) => Promise<void>;
  updateCustomer: (id: string, updates: Partial<Customer>) => Promise<{ success: boolean; reason?: string }>;
  deleteCustomer: (id: string, opts?: { forfeitNote?: string }) => Promise<{ success: boolean; reason?: string }>;
  setCurrentCustomer: (customer: Customer | null) => void;
  issueStoreCredit: (
    customerId: string,
    amount: number,
    managerPin?: string
  ) => Promise<{ success: boolean; reason?: string; credited?: number }>;
  redeemLoyaltyPoints: (customerId: string, points: number, saleTotal?: number) => Promise<{ success: boolean; creditAdded?: number; reason?: string }>;
  adjustCustomerPoints: (customerId: string, points: number, description: string) => Promise<{ success: boolean; reason?: string }>;
  recordCustomerDebtPayment: (
    customerId: string,
    amount: number,
    method: PaymentMethodType,
    notes?: string,
    opts?: { allowOverpayToCredit?: boolean; entryId?: string }
  ) => Promise<{ success: boolean; reason?: string; debtEntry?: CustomerDebtEntry; appliedAmount?: number; changeDue?: number; overpayConvertedToCredit?: number }>;
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
  // Mid-shift drawer handover: re-points the OPEN session's currentCashier
  // without closing the session. Called fire-and-forget by switchCashier.
  setShiftCashier: (cashierName: string) => Promise<{ success: boolean; reason?: string }>;
}

export interface OrderSlice {
  transactions: SaleTransaction[];
  lastTransaction: SaleTransaction | null;
  cashTendered: number;
  paymentMethod: 'Espèces';
  selectedTransactionForRefund: SaleTransaction | null;

  setCashTendered: (amount: number) => void;
  processPayment: (tenders?: PaymentTender[]) => Promise<{ success: boolean; reason?: string; recoveryQueued?: boolean; warnings?: string[] }>;
  quickCashPayment: () => Promise<{ success: boolean; reason?: string }>;
  voidTransaction: (transactionId: string, reason: string, cashierName?: string) => Promise<{ success: boolean; reason?: string }>;
  processRefund: (payload: ProcessRefundPayload) => Promise<{ success: boolean; refundTransaction?: SaleTransaction; reason?: string }>;
  reprintReceipt: (transaction: SaleTransaction) => void;
  setSelectedTransactionForRefund: (t: SaleTransaction | null) => void;
}

export type SettleRepairResult =
  | { action: 'cart'; remainingBalance: number; cartProductId: string }
  | { action: 'deliverable'; remainingBalance: number };

export interface RepairSlice {
  repairOrders: RepairOrder[];
  selectedRepairOrderForNotification: RepairOrder | null;
  selectedRepairNotificationTemplate: import('../types/pos').RepairNotificationType | null;
  /** Cross-modal print handshake (Command archive → Repair modal auto-print). */
  pendingRepairPrint: import('../types/pos').PendingRepairPrint | null;
  setPendingRepairPrint: (req: import('../types/pos').PendingRepairPrint | null) => void;

  /**
   * Inspector → SAV intake handoff (Phase 5, Option A). Lives in the REPAIR
   * slice (not UI state) so the dossier survives a modal close/reopen and the
   * SAV form hydrates without retyping the identifier.
   */
  intakeDraft: import('../types/pos').IntakeDraft | null;
  /** Writer. Replaces any previous draft (single-slot handoff). */
  seedIntakeDraft: (draft: import('../types/pos').IntakeDraft) => void;
  /** Atomic reader+clearer; returns null for an absent OR stale draft. */
  consumeIntakeDraft: () => import('../types/pos').IntakeDraft | null;
  /** Explicit discard (modal cancelled / Escape without save). */
  clearIntakeDraft: () => void;

  createRepairOrder: (order: Omit<RepairOrder, 'id' | 'ticketNumber' | 'totalCost' | 'createdAt'>) => Promise<void>;
  updateRepairOrderStatus: (orderId: string, newStatus: RepairOrder['status']) => Promise<{ remainingBalance: number }>;
  updateRepairOrder: (orderId: string, updates: Partial<RepairOrder>) => Promise<void>;
  setSelectedRepairOrderForNotification: (
    order: RepairOrder | null,
    template?: import('../types/pos').RepairNotificationType | null
  ) => void;
  /** Zero-leakage settlement: cart injection when balance>0, else direct deliverable. */
  settleAndDeliverRepair: (orderId: string) => Promise<SettleRepairResult>;
  markRepairDelivered: (orderId: string) => Promise<boolean>;
  deleteRepairOrderGuarded: (orderId: string) => Promise<{ success: boolean; reason?: string }>;
}

export interface ProcurementSlice {
  purchaseOrders: PurchaseOrder[];
  activeDraftPO: PurchaseOrder | null;
  /** Sets or clears the active draft PO. Used by the
   *  replenishment "Voir Commande" deep-link to route the
   *  PurchaseOrderModal straight to a specific order. */
  setActiveDraftPO: (po: PurchaseOrder | null) => void;
  /** Transient intent: the next PurchaseOrderModal mount opens
   *  directly on the manual draft builder ("Générer un bon de
   *  commande" shortcut). Consumed by the modal itself. */
  poDraftBuilderRequested: boolean;
  requestPoDraftBuilder: () => void;
  consumePoDraftBuilder: () => void;
  dismissedProcurementIds: string[];
  customQtyMap: Record<string, number>;
  selectedItemsMap: Record<string, boolean>;
  extraVendorProducts: Record<string, string[]>;
  customActiveVendors: string[];
  vendorMoqMap: Record<string, number>;
  vendorDirectory: Record<string, import('../types/pos').VendorDirectoryEntry>;

  dismissProcurementProduct: (productId: string) => void;
  restoreDismissedProcurementProducts: () => void;
  setCustomQty: (productId: string, qty: number) => void;
  setCustomQtyBatch: (entries: Record<string, number>) => void;
  removeCustomQtyForVendor: (productIds: string[]) => void;
  toggleProcurementItem: (productId: string) => void;
  setProcurementItemsSelected: (productIds: string[], selected: boolean) => void;
  addExtraVendorProduct: (vendorName: string, productId: string) => void;
  removeExtraVendorProduct: (vendorName: string, productId: string) => void;
  setCustomActiveVendors: (vendors: string[]) => void;
  addCustomActiveVendor: (vendorName: string) => void;
  removeCustomActiveVendor: (vendorName: string) => void;
  setVendorMoq: (vendorName: string, target: number) => void;
  setVendorContact: (vendorName: string, contact: import('../types/pos').VendorDirectoryEntry) => void;
  clearProcurementDraft: () => void;
  createDraftPOForVendor: (
    vendorName: string,
    customItems?: Array<{ productId: string; qty: number; unitCost?: number }>,
    status?: PurchaseOrder['status']
  ) => Promise<{ success: boolean; reason?: string }>;
  createWaitingListPO: (
    vendorName: string,
    customItems?: Array<{ productId: string; qty: number; unitCost?: number }>,
    notes?: string
  ) => Promise<PurchaseOrder>;
  createManualPurchaseOrder: (
    vendorName: string,
    items: Array<{ productId: string; qty: number; unitCost?: number }>,
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
  }) => Promise<{ success: boolean; isPartial: boolean; totalReceivedCost: number; reason?: string }>;
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
  cashierUsers: CashierUser[];
  activeCashier: CashierUser | null;
  isScreenLocked: boolean;
  /**
   * Explicit lock requested this session (lock button). The trusted-companion
   * auto-unlock skips the PIN wall only while this is false; an explicit lock
   * is always honored until the next successful unlock. Never persisted.
   */
  sessionLockRequested: boolean;
  creditVouchers: CreditVoucher[];

  toggleTheme: () => void;
  setPricingTier: (tier: PricingTier) => void;
  openModal: (modal: ActiveModalType) => void;
  closeModal: () => void;
  setPendingPinAction: (action: (() => void) | null) => void;
  setActiveImeiDossier: (dossier: ImeiLifecycleDossier | null) => void;
  setReceiptSettings: (settings: ReceiptSettings) => Promise<void>;
  setManagerPin: (newPin: string) => Promise<void>;
  /**
   * Phase 4a rotation authority. Under Tauri this mints Argon2id AND writes
   * natively via `pin_set` (the hash never enters the WebView), then refreshes
   * memory + Dexie mirror from the SQLite authority. Outside Tauri it
   * delegates to the legacy TS mint (web preview only). Throws on deny /
   * transport failure — callers surface the error and MUST NOT fall back to
   * a local mint under Tauri (that would re-plant a fast hash AND violate
   * native-write-only). Returns the minted envelope generation (`v2`/`v1`).
   */
  rotatePinCredential: (userId: string, newPin: string, isManager: boolean, opts?: { recoveryReset?: boolean }) => Promise<{ format: string }>;
  /**
   * Re-read `manager_pin` + `cashier_users` from the SQLite authority into
   * the Dexie mirror and memory (Tauri only). Used after native `pin_set`,
   * which bypasses the mirror. No sync: credentials are device-local keys.
   */
  refreshCredentialsFromAuthority: () => Promise<void>;
  // P11.3: returns a Promise so callers that need the audit row persisted before
  // proceeding (PIN change, customer delete) can await it. Callers that ignore the
  // return value still compile (fire-and-forget stays valid).
  logSecurityAction: (action: string, details: string, user?: string, requiresPin?: boolean) => Promise<void>;
  verifyManagerPin: (pin: string) => boolean;

  lockScreen: () => void;
  unlockScreen: (enteredPin: string) => { success: boolean; cashier?: CashierUser; reason?: string };
  switchCashier: (cashierId: string, enteredPin: string) => { success: boolean; reason?: string };
  setCashierUsers: (users: CashierUser[]) => Promise<void>;
  createCreditVoucher: (input: {
    initialAmount: number;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
    expiresInDays?: number;
  }) => Promise<CreditVoucher>;
  redeemCreditVoucher: (
    code: string,
    amount: number
  ) => Promise<{ success: boolean; deducted: number; remaining: number; reason?: string; voucher?: CreditVoucher }>;
  fetchCreditVouchers: () => Promise<void>;

  createBundle: (bundle: Omit<ProductBundle, 'id'>) => Promise<void>;
  deleteBundle: (bundleId: string) => Promise<void>;
  addBundleToCart: (bundleId: string) => { success: boolean; reason?: string };
  processTradeIn: (tradeIn: Omit<TradeInItem, 'id' | 'createdAt' | 'resalePrice'>) => Promise<{ success: true; warning?: string } | { success: false; reason: string }>;
  /**
   * Two-way exchange staging (Phase 2): validated trade-in payload held in
   * memory ONLY — zero DB writes until the atomic checkout flight commits
   * intake + purchase together. A canceled exchange discards this with no
   * orphaned rows. Buyback applies 1:1 (no +10% wallet bonus).
   */
  stagedTradeIn: StagedTradeIn | null;
  setStagedTradeIn: (staged: StagedTradeIn | null) => void;
  clearStagedTradeIn: () => void;
  /**
   * Modal request bus for mode="exchange": opener stashes initial data +
   * nonce here, then opens 'trade_in_buyback'. The modal reads it to
   * prefill and to decide exchange vs standalone when no direct prop wins.
   */
  tradeInExchangeRequest: { initial: Partial<StagedTradeIn>; nonce: number } | null;
  openTradeInExchange: (initial?: Partial<StagedTradeIn>) => void;
  clearTradeInExchangeRequest: () => void;
  /**
   * Request bus for the "Compléter la pièce" flow: the Inspector hands over a
   * trade-in id, the modal opens in IDENTITY-EDIT mode (pre-filled, and locked
   * to the identity fields — IMEI, amounts and `createdAt` are not editable).
   */
  tradeInEditRequest: { tradeInId: string; nonce: number } | null;
  openTradeInIdentityEdit: (tradeInId: string) => void;
  clearTradeInEditRequest: () => void;
  /**
   * The ONLY write path for seller identity data after intake. Patches the
   * existing record (so `createdAt`, IMEI and amounts cannot drift), persists
   * it through `saveTradeIn`, and writes one audit line per edit with the old
   * and new values MASKED to the last 4 characters.
   */
  updateTradeInIdentity: (
    tradeInId: string,
    patch: {
      nationalIdType?: TradeInItem['nationalIdType'] | null;
      nationalIdNumber?: string | null;
      customerPhone?: string | null;
    }
  ) => Promise<{ success: true } | { success: false; reason: string }>;
  /**
   * Soulte payout choice for a Net<0 exchange (shop owes the customer).
   * Explicit selection only — no default (a pre-selected default would
   * disburse cash or mint liability without a cashier decision).
   */
  exchangeSoultePayout: 'cash' | 'wallet' | null;
  setExchangeSoultePayout: (choice: 'cash' | 'wallet' | null) => void;
  /**
   * Pure intake commit for the atomic exchange checkout: persists product +
   * trade + IMEI + FIFO batch + ledger (same shape as processTradeIn) with
   * NO cash/wallet side effects — those belong to the checkout flight
   * (tenders / soulte payout). Returns ids for the sale linkage.
   */
  commitStagedTradeInIntake: (staged: StagedTradeIn) => Promise<
    | { success: true; tradeId: string; productId: string }
    | { success: false; reason: string }
  >;
  addStoreExpense: (expense: Omit<StoreExpense, 'id' | 'createdAt'>) => Promise<void>;
  deleteStoreExpense: (id: string) => Promise<{ success: boolean; reason?: string; compensated?: boolean }>;

  validateIMEI: (imei: string) => { valid: boolean; reason?: string };
  searchByIMEI: (imei: string) => { product?: Product; po?: PurchaseOrder; transaction?: SaleTransaction } | null;

  initDatabase: (opts?: { force?: boolean }) => Promise<void>;
  refreshAfterPull: () => Promise<void>;
  refreshPullTargets: (summary: PullTouchSummary) => Promise<void>;
  exportDatabase: () => void;
  importDatabase: (jsonString: string, actor?: string) => Promise<{ success: boolean; reason?: string; auditOk?: boolean }>;
}

export type PosState = CartSlice &
  CatalogSlice &
  CustomerSlice &
  ShiftSlice &
  OrderSlice &
  RepairSlice &
  ProcurementSlice &
  UISlice;
