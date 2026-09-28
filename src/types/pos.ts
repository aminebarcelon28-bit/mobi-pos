export type BrandName = 'Apple' | 'Samsung' | 'Google' | 'ZAGG' | 'Belkin' | 'Anker' | 'Autre';

export type CategoryType =
  | 'Tous les produits'
  | 'Coques iPhone'
  | 'Coques Samsung'
  | 'Coques Google'
  | 'Chargeurs'
  | 'Câbles'
  | 'Protège-Écran'
  | "Téléphones d'Occasion (Reprise)"
  | 'Services';

export type SortOption = 
  | 'name_asc'
  | 'price_asc'
  | 'price_desc'
  | 'stock_desc'
  | 'brand_asc';

export type PricingTier = 'Retail' | 'Wholesale' | 'VIP';

export interface VolumeDiscountTier {
  minQty: number;
  price: number;
}

export interface Product {
  id: string;
  sku: string;
  barcode: string;
  title: string;
  brand: BrandName;
  compatibleModel: string;
  compatibleTags?: string[];
  category: CategoryType;
  price: number;
  wholesalePrice: number;
  /** Demi-gros tier price. Optional: falls back to wholesalePrice when unset. */
  semiWholesalePrice?: number;
  volumeDiscounts?: VolumeDiscountTier[];
  costPrice: number;
  stock: number;
  /** @deprecated Legacy image field - product image processing is decommissioned */
  imageUrl?: string;
  color?: string;
  material?: string;
  isMagSafe?: boolean;
  isSerialized?: boolean;
  imeiNumber?: string;
  warrantyExpiresAt?: string;
  purchaseOrderId?: string;
  vendorName: string;
  leadTimeDays: number;
  dailySalesVelocity: number;
  reorderPoint: number;
  warrantyMonths?: number;
  shelfLocation?: string;
  minPrice?: number;
  isActive?: boolean;
  /** Hors-catalogue service line (pose film, réparation, saisie libre) — no stock tracking. */
  isService?: boolean;
  /** Parent product id for variant-matrix children. */
  parentProductId?: string;
  /** Human variant label, e.g. "iPhone 15 / Noir". Set on matrix children. */
  variantName?: string;
  /** True when this product heads a variant matrix (has children). */
  hasVariants?: boolean;
}

export type ProductInput = Omit<Product, 'id'> & { id?: string };

export interface FifoAllocation {
  batchId: string;
  quantity: number;
  unitCost: number;
}

export interface StockBatch {
  batchId: string;
  productId: string;
  quantityRemaining: number;
  unitCost: number;
  receivedAt: string;
  purchaseOrderId?: string;
  deviceId?: string;
  idempotencyKey?: string;
  syncStatus?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  deleted?: number;
}

/**
 * v104 STRICT FIFO ALLOCATION LEDGER row (frozen checkout COGS).
 * One row per (sale item, batch consumed): `qtyConsumed * unitCostAtSale`
 * is the exact frozen cost for those units. The Sales & Net Profit report
 * sums ONLY this table — never products.costPrice or live stock_batches.
 */
export interface SaleBatchAllocation {
  id: string;
  saleId: string;
  batchId: string;
  qtyConsumed: number;
  unitCostAtSale: number;
  createdAt?: string;
  productId?: string;
  saleItemId?: string;
  deviceId?: string;
  idempotencyKey?: string;
  syncStatus?: string;
  version?: number;
  updatedAt?: string;
  deleted?: number;
}

export interface CartItem {
  product: Product;
  quantity: number;
  discount: number;
  serialNumber?: string;
  imeiNumber?: string;
  appliedPrice: number;
  unitCostPrice?: number; // Immutable unit cost price captured permanently at checkout
  volumeTierApplied?: boolean;
  unitPriceCharged?: number;
  defaultPrice?: number;
  unitCostAtSale?: number;
  discountAmount?: number;
  lineProfit?: number;
  fifoAllocations?: FifoAllocation[];
  isReturn?: boolean; // When true, represents a returned/exchanged item (re-stocks and subtracts from cart total)
}

export type LoyaltyTierName = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'VIP Diamond';

export interface LoyaltyTierInfo {
  /** Resolved tier def id (present when resolved from a dynamic table). */
  id?: string;
  name: string;
  minSpend: number;
  pointsMultiplier: number;
  discountPercent: number;
  badgeColor: string;
  bgColor: string;
  borderColor: string;
  icon: string;
  /** Point-bucket lifetime for this tier (null = never expires). */
  expiryDays?: number | null;
}

/** Merchant-configurable tier row. Tier id `tier-0` is the immutable bottom tier (minSpend: 0). */
export interface LoyaltyTierDef {
  id: string;
  name: string;
  minSpend: number;
  multiplier: number;
  style: {
    badgeColor: string;
    bgColor: string;
    borderColor: string;
    icon: string;
  };
  /** Point-bucket lifetime for points earned while in this tier (null = never expires). */
  expiryDays?: number | null;
}

/** Merchant-configurable spend milestone: cross `threshold` DA cumulative spend → `reward` DA store credit. */
export interface SpendMilestone {
  id: string;
  threshold: number;
  reward: number;
  /** When true, every crossed tranche re-awards; otherwise each tranche awards once. */
  repeatable: boolean;
}

/**
 * Immutable award snapshot persisted on the transaction. Clawbacks reverse
 * these recorded amounts — never the mutable live config values.
 */
export interface MilestoneAward {
  milestoneId: string;
  threshold: number;
  rewardAmount: number;
  tranche?: number;
}

/** Master-switch behavior when the program is disabled. */
export type LoyaltyDisabledMode = 'freeze-all' | 'earn-off-redeem-on';

export interface CategoryMultiplier {
  category: CategoryType;
  multiplier: number;
}

export interface PromoCampaignRule {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  multiplier: number;
  active: boolean;
}

export interface LoyaltyProgramConfig {
  enabled: boolean;
  /** Behavior while `enabled === false`. */
  disabledMode: LoyaltyDisabledMode;
  /** Independent kill-switch for point earn/redeem. Milestones are unaffected. */
  pointsEnabled?: boolean;
  /** When false, tier multipliers earn at 1.0x (campaigns still apply). */
  tierMultipliersEnabled?: boolean;
  baseSpendPerPoint: number; // e.g. 100 DA spent = 1 base point
  pointRedemptionRate: number; // e.g. 10 Pts = 100 DA (1 Pt = 10 DA value)
  minimumRedemptionPoints: number; // e.g. 50 pts required
  maximumRedemptionPercentPerSale: number; // e.g. 50% max of cart total
  /**
   * Dynamic tier table, ascending by minSpend. Tier id `tier-0` must exist
   * with minSpend 0 (enforced by normalizeLoyaltyConfig).
   */
  tiers: LoyaltyTierDef[];
  /** Spend milestones (threshold → store-credit reward). Evaluated in order. */
  spendMilestones: SpendMilestone[];
  /**
   * @deprecated Legacy fixed 5-tier thresholds. Kept for stored-config
   * hydration only — normalizeLoyaltyConfig prefers `tiers` when present.
   */
  tierThresholds: {
    silverMinSpend: number;
    goldMinSpend: number;
    platinumMinSpend: number;
    vipDiamondMinSpend: number;
  };
  /**
   * @deprecated Legacy fixed 5-tier multipliers. See `tiers`.
   */
  tierMultipliers: {
    bronze: number;
    silver: number;
    gold: number;
    platinum: number;
    vipDiamond: number;
  };
  categoryMultipliers: CategoryMultiplier[];
  activeCampaigns: PromoCampaignRule[];
  enableCardBarcodeScanning: boolean;
  cardPrefix: string;
}

export interface FinancialProfitImpact {
  grossSubtotal: number;
  directDiscounts: number;
  storeCreditRedeemed: number;
  netRevenue: number;
  costOfGoodsSold: number;
  grossProfit: number;
  netProfit: number;
  grossProfitMarginPercent: number;
  netProfitMarginPercent: number;
  effectiveDiscountRatePercent: number;
  pointsEarnedValueDA: number;
  futureLiabilityDA: number;
}

export interface LoyaltyPointBucket {
  id: string;
  customerId: string;
  originTransactionId: string;
  initialPoints: number;
  remainingPoints: number;
  creditValueDzd: number;
  earnedOnNetSpendDzd: number;
  expiresAt?: string | null; // null = Lifetime (VIP Platinum & Diamond)
  isFullyConsumed: boolean;
  createdAt: string;
}

export interface AdminLoyaltyAuditLog {
  id: string;
  adminUser: string;
  actionType: 'MANUAL_OVERRIDE' | 'RULE_MODIFIED' | 'BULK_EXPIRATION' | 'FRAUD_LOCK';
  customerId?: string;
  customerName?: string;
  previousBalanceDzd: number;
  newBalanceDzd: number;
  adjustmentDeltaDzd: number;
  reason: string;
  terminalIp?: string;
  createdAt: string;
}

export interface DynamicLoyaltyProgramRules {
  id: string;
  ruleName: string;
  earningRateMultiplier: number;
  pointsToDzdRatio: number;
  creditExpirationDays: number;
  minSpendForRewardDzd: number;
  marginFloorCogsProtection: boolean;
  isActive: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface LoyaltyLedgerEntry {
  id: string;
  customerId: string;
  timestamp: string;
  type: 'earn' | 'redeem' | 'bonus' | 'conversion' | 'adjustment' | 'expired' | 'milestone';
  points: number;
  balanceAfter: number;
  description: string;
  referenceId?: string;
  creditDeltaDzd?: number;
  /** Immutable snapshot of the milestone economics behind this entry (grants + clawbacks). */
  milestoneThresholdDzd?: number;
  milestoneRewardDzd?: number;
  expiresAt?: string | null;
  performedBy?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  registeredDevice: string;
  loyaltyPoints: number;
  storeCredit: number;
  currentCreditBalanceDzd?: number;
  totalLifetimeSpentDzd?: number;
  pricingTier: PricingTier;
  /**
   * Cached display tier only — never read for calculations. All earn,
   * multiplier, and progress logic re-resolves via
   * calculateCustomerTier(totalSpent, normalizedConfig).
   */
  loyaltyTier?: string;
  totalSpent?: number;
  ledger?: LoyaltyLedgerEntry[];
  pointBuckets?: LoyaltyPointBucket[];
  avatarUrl?: string;
  loyaltyCardCode?: string;
  barcode?: string;
  currentDebt?: number;
  debtLimit?: number;
}

export interface CustomerDebtEntry {
  id: string;
  customerId: string;
  customerName: string;
  type: 'DEBT_ACQUIRED' | 'PAYMENT_SETTLED';
  amount: number;
  balanceAfter: number;
  receiptNumber?: string;
  paymentMethod?: PaymentMethodType;
  notes?: string;
  createdAt: string;
  recordedBy?: string;
}

export type ExpenseCategory =
  | 'Achat Marchandises / Fournisseur'
  | 'Loyer'
  | 'Électricité / Eau'
  | 'Salaires / Avances'
  | 'Repas / Pause'
  | 'Emballages / Sachets'
  | 'Transport / Livraison'
  | 'Internet / Téléphonie'
  | 'Maintenance / Travaux'
  | 'Perte Stock / SAV'
  | 'Autre Charge';

export interface StoreExpense {
  id: string;
  category: ExpenseCategory;
  title: string;
  amount: number;
  paymentMethod: PaymentMethodType;
  paidTo?: string;
  notes?: string;
  createdAt: string;
  recordedBy: string;
}

export interface QuickTileItem {
  id: string;
  title: string;
  price: number;
  costPrice?: number;
  icon?: string;
  color?: string;
}

export interface HeldSale {
  id: string;
  customer: Customer | null;
  items: CartItem[];
  timestamp: string;
  note?: string;
}

export type PaymentMethodType = 'Espèces' | 'Avoir Client' | 'BaridiMob' | 'Chèque' | 'Crédit Client' | 'Autre';

export type TransactionStatus = 'COMPLETED' | 'VOIDED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';

export interface PaymentTender {
  method: PaymentMethodType;
  amount: number;
  reference?: string;
}

export interface RefundItem {
  productId: string;
  title: string;
  sku: string;
  unitPrice: number;
  quantity: number;
  totalRefundAmount: number;
  restock: boolean;
  imeiNumber?: string;
  unitCostAtSale?: number;
  fifoAllocations?: FifoAllocation[];
  /**
   * Transaction-linked batch restoration: stable id of the ORIGINAL sale line
   * (`${saleTxnId}-item-${lineIdx}`, same derivation as the durable
   * transaction_items rows). Restitution matches this line first so a
   * multi-line ticket with the same product twice restores exact batches.
   */
  saleItemId?: string;
  /**
   * Return condition flag — Condition: [Remise en stock | Défectueux / SAV].
   * 'restock' re-enters the sellable FIFO queue at historical cost;
   * 'defective' routes to the write-off account (no stock movement, cost
   * logged as inventory loss). Mirrors `restock` (true/false) for compat.
   */
  condition?: 'restock' | 'defective';
}

export interface ProcessRefundPayload {
  originalTransaction: SaleTransaction;
  refundItems: RefundItem[];
  refundMethod: PaymentMethodType;
  refundReason: string;
  cashierName?: string;
}

export interface SaleTransaction {
  id: string;
  receiptNumber: string;
  status?: TransactionStatus;
  customer: Customer | null;
  items: CartItem[];
  subtotal: number;
  discountTotal: number;
  total: number;
  costTotal: number;
  profit: number;
  profitMargin: number;
  /**
   * ATOMIC COGS MATERIALIZATION (v105): exact FIFO sum
   * (Σ sale_batch_allocations.qty_consumed × unit_cost_at_sale) written
   * into the sales row inside the checkout transaction BEFORE commit.
   * The receipt reads this one number — never re-derives COGS. Absent
   * (legacy rows) means unknown: look up the ledger, never treat as zero.
   */
  ledgerCogsTotal?: number;
  ledger_cogs_total?: number;
  cost_total?: number;
  pricingTier: PricingTier;
  paymentMethod: PaymentMethodType;
  tenders?: PaymentTender[];
  cashTendered: number;
  changeDue: number;
  createdAt: string;
  cashierName?: string;
  voidReason?: string;
  voidedAt?: string;
  voidedBy?: string;
  isRefund?: boolean;
  originalReceiptNumber?: string;
  originalTransactionId?: string;
  refundReason?: string;
  refundMethod?: PaymentMethodType;
  refundedItems?: RefundItem[];
  debtAdded?: number;
  debtRemainingTotal?: number;
  deviceId?: string;
  device_id?: string;
  /**
   * Owning cash session id, stamped at checkout from the live OPEN row.
   * Closes scope by [openedAt, closedAt) with this as the attribution tiebreak;
   * absent on legacy rows, which keep the pure window rule.
   */
  shiftId?: string;
  /**
   * Staged voucher tender captured at checkout (code + applied amount).
   * Persisted on the row (not just the envelope) so void/refund flows can
   * credit the bearer value back instead of burning it. Absent = no voucher.
   */
  voucherCode?: string | null;
  voucherCreditApplied?: number;
  /**
   * Exact cash disbursed through a refund row (funding-split: net of
   * voucher/wallet/debt shares restored to their origins). The drawer lane
   * reads this; revenue lanes read total (value reversed). Absent on legacy
   * rows, which keep the old total===cash reading.
   */
  cashDisbursed?: number;
  /**
   * Loyalty campaign multiplier applied at earn time (e.g. weekend 2×).
   * Void/refund reversals read this so a post-campaign void deducts what
   * was actually earned. Absent (legacy rows) falls back to currently
   * active campaigns.
   */
  loyaltyCampaignMultiplier?: number;
  /**
   * Immutable milestone award snapshots minted by this sale. Clawbacks
   * reverse these recorded amounts — never live config. Absent (legacy
   * rows) means unknown: fall back to ledger grant snapshots.
   */
  milestoneAwards?: MilestoneAward[];
}

export interface StockAlert {
  id: string;
  productId: string;
  title: string;
  sku: string;
  brand: string;
  vendorName: string;
  currentStock: number;
  reorderPoint: number;
  dailyVelocity: number;
  severity: 'critical' | 'warning';
}

export interface POLineItem {
  productId: string;
  title: string;
  sku: string;
  currentStock: number;
  suggestedQty: number;      // Ordered quantity
  receivedQty?: number;       // Manually verified / received quantity
  unitCost: number;          // PO agreed unit cost
  actualUnitCost?: number;   // Invoice verified cost (price fluctuation)
  totalCost: number;
  actualTotalCost?: number;
  imeis?: string[];
  status?: 'Pending' | 'Partially Received' | 'Received' | 'Discrepancy' | 'Cancelled';
  discrepancyReason?: string;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorName: string;
  createdAt: string;
  validatedAt?: string;
  receivedAt?: string;
  items: POLineItem[];
  totalAmount: number;
  actualTotalAmount?: number;
  status:
    | 'Draft'
    | 'Waiting List'
    | 'Approved'
    | 'Sent'
    | 'Partially Received'
    | 'Completed'
    | 'Received'
    | 'Cancelled';
  expenseRecorded?: boolean;
  expenseId?: string;
  notes?: string;
}

export interface ConditionChecklist {
  screenOk: boolean;
  faceIdOk: boolean;
  cameraOk: boolean;
  chargingOk: boolean;
  bodyOk: boolean;
  batteryOk?: boolean;
  audioOk?: boolean;
}

export interface RepairOrder {
  id: string;
  ticketNumber: string;
  customerName: string;
  customerPhone: string;
  deviceModel: string;
  imei: string;
  problemDescription: string;
  diagnosticNotes: string;
  conditionChecklist: ConditionChecklist;
  postRepairChecklist?: ConditionChecklist;
  status: 'Diagnostic' | 'En attente de pièces' | 'En cours' | 'Prêt / Terminé';
  laborCost: number;
  partsCost: number;
  totalCost: number;
  depositAmount?: number;
  estimatedCompletionDate?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ProductBundle {
  id: string;
  bundleTitle: string;
  barcode: string;
  bundlePrice: number;
  childSkus: string[];
}

export type ConditionGrade = 'Grade A (Comme Neuf)' | 'Grade B (Bon État)' | 'Grade C (Usagé)' | 'Grade D (Écran Fissuré)';

export type PreOwnedDeviceStatus =
  | 'EN_TEST_DIAGNOSTIC'  // Ingested, undergoing hardware audit & data wipe
  | 'PRET_A_LA_VENTE'     // Tested, certified, and active on POS sales catalog
  | 'PIECES_DETACHEES';   // Hardware failed testing; routed for technician spare parts

export interface PreOwnedInspectionChecklist {
  icloudFrpRemoved: boolean;   // Crucial: No activation lock
  networkUnlocked: boolean;    // Works with Mobilis, Djezzy, Ooredoo
  faceIdTouchIdOk: boolean;
  trueToneOk: boolean;
  batteryHealthPercent: number; // e.g. 88%
  camerasOk: boolean;
  speakersMicOk: boolean;
  chassisGrade: 'Grade A (Comme neuf)' | 'Grade B (Très bon état)' | 'Grade C (Traces d\'usure)';
  testedByTechnician: string;
  testedAt?: string;
}

export interface TradeInItem {
  id: string;
  deviceModel: string;
  imei: string;
  /** Real packaging barcode when scanned at intake, else generated EAN-13. */
  barcode?: string;
  brand: BrandName;
  conditionGrade: ConditionGrade;
  customerName: string;
  customerPhone?: string;
  nationalIdNumber?: string;
  buybackValue: number;          // Cost basis for store (e.g. 50,000 DA)
  resaleMarginPercent: number;
  resalePrice: number;          // Retail listing price
  targetResalePrice?: number;
  creditToWallet: boolean;
  status?: PreOwnedDeviceStatus;
  inspectionChecklist?: PreOwnedInspectionChecklist;
  createdAt: string;
  certifiedAt?: string;
}

export type RepairNotificationType =
  | 'READY_FOR_PICKUP'
  | 'QUOTE_APPROVAL_REQUIRED'
  | 'PARTS_DELAY_NOTICE';

export interface CashTenderBreakdown {
  totalDue: number;
  cashTendered: number;
  changeDue: number;
  isFullyPaid: boolean;
  suggestedShortcuts: number[];
  changeDenominationBreakdown: Record<number, number>;
}

export interface ImeiLifecycleDossier {
  imei: string;
  productTitle: string;
  isSold: boolean;
  /** Included store warranty duration (months). Drives the dossier banner for
   *  in-stock devices whose coverage starts at sale. Optional for compat. */
  warrantyMonths?: number;
  soldAt?: string;
  warrantyExpiresAt?: string;
  isWarrantyValid: boolean;
  daysRemaining?: number;
  originalReceiptNumber?: string;
  originalCustomerName?: string;
  originalCustomerPhone?: string;
  purchasePrice?: number;
  repairHistoryCount: number;
}

export type PosDocumentType =
  | 'SALE_RECEIPT'
  | 'REPAIR_CLAIM_STUB'
  | 'REPAIR_WORK_ORDER'
  | 'TRADE_IN_VOUCHER'
  | 'PRODUCT_LABEL'
  | 'Z_REPORT'
  | 'CUSTOMER_DEBT_STATEMENT';

export interface MobileHardwareProfile {
  frontDeskReceiptPrinter: string | null;
  workshopTechnicianPrinter: string | null;
  barcodeLabelPrinter: string | null;
  customerVfdPort: string | null;
}

export type DeviceCategory =
  | 'thermalPrinter'
  | 'labelPrinter'
  | 'customerVfdDisplay'
  | 'weighingScale'
  | 'barcodeScanner'
  | 'genericSerial';

export interface DiscoveredDevice {
  id: string;
  name: string;
  category: DeviceCategory;
  portOrQueue: string;
  isUsb: boolean;
  description?: string;
}

export interface IMEIRecord {
  imei: string;
  productId: string;
  purchaseOrderId?: string;
  saleTransactionId?: string;
  warrantyExpiresAt?: string;
  receivedAt: string;
  soldAt?: string;
  notes?: string;
  version?: number;
}

export interface CashierUser {
  id: string;
  name: string;
  /** Hashed PIN (hashPin) or '' when unset. Empty never authenticates. */
  pin: string;
  role: 'admin' | 'cashier';
  avatarColor: string;
}

export interface CreditVoucher {
  id: string;
  /** Human code, e.g. AV-482913. */
  code: string;
  initialAmount: number;
  remainingAmount: number;
  status: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED';
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export type CustomerInput = Omit<Customer, 'id'> & { id?: string };

export interface PrinterRoutingConfig {
  receiptPrinterId: string;
  receiptPrinterName: string;
  labelPrinterId: string;
  labelPrinterName: string;
  reportPrinterId: string;
  reportPrinterName: string;
  autoRoutingEnabled: boolean;
}

/**
 * Per-device mobile printer (phone/tablet only, never synced).
 * Wi-Fi = raw TCP to port 9100 (any network thermal printer).
 * Bluetooth = SPP/RFCOMM to a PAIRED classic printer (pair in Android
 * settings first — no location permission needed for bonded devices).
 */
export type MobilePrinterConnection = 'wifi' | 'bluetooth';
export type MobileLabelProtocol = 'ESCPOS' | 'TSPL' | 'ZPL';

export interface MobilePrinterConfig {
  enabled: boolean;
  connection: MobilePrinterConnection;
  wifiHost: string;
  wifiPort: number;
  bluetoothName: string;
  bluetoothMac: string;
  /** Raw label language sent over Wi-Fi/BT (PNG sheet ignores this). */
  labelProtocol: MobileLabelProtocol;
}

export interface ReceiptSettings {
  storeName: string;
  storeSubheader: string;
  logoUrl: string;
  address: string;
  phone: string;
  email: string;
  customHeaderMsg: string;
  customFooterMsg: string;
  showBarcode: boolean;
  autoPrintEnabled?: boolean;
  kickCashDrawerOnCash?: boolean;
  printerRouting?: PrinterRoutingConfig;
  loyaltyConfig?: LoyaltyProgramConfig;
  paperWidth?: '80mm' | '58mm';
  taxNumber?: string; // NIF / NIS / RC
  footerMessage?: string;
  printerInterface?: 'BROWSER' | 'SPOOLER' | 'NETWORK' | 'SERIAL';
  printerName?: string;
  baridimobRip?: string;        // 16 or 20-digit BaridiMob RIP
  ccpAccount?: string;          // CCP Account + Clé
  bankBeneficiaryName?: string; // Account Holder Name
  vatRate?: number; // TVA percent (e.g. 19 for 19%). Default 0 = unchanged behavior.
}

export interface SecurityAuditLogEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  requiresPin: boolean;
  deviceId?: string;
  ipAddress?: string;
}

export interface CashDropEntry {
  id: string;
  timestamp: string;
  amount: number;
  reason: string;
  user: string;
}

export interface DenominationCount {
  qty2000: number;
  qty1000: number;
  qty500: number;
  qty200: number;
  qty100: number;
  qty50: number;
  qty20: number;
  qty10: number;
  coins: number;
}

export interface CashMovement {
  id: string;
  sessionId: string;
  type: 'EXPENSE' | 'MANUAL_DEPOSIT';
  amount: number; // In DA
  reason: string;
  cashierName?: string;
  createdAt: string;
}

export interface CashSession {
  id: string;
  openedAt: string;
  closedAt?: string | null;
  openingFloat: number;
  cashSales?: number;
  manualDeposits?: number;
  expenses?: number;
  expectedCash?: number | null;
  actualCash?: number | null;
  discrepancy?: number;
  dailyNetProfit?: number;
  totalSalesCount?: number;
  totalSalesRevenue?: number;
  totalProfits?: number;
  status: 'OPEN' | 'CLOSED';
  cashierName: string;
  openedBy?: string; // lock-screen cashier who opened the shift (immutable).
  currentCashier?: string; // who currently owns the drawer; updated via setShiftCashier.
  openingNote?: string;
  closingNote?: string | null;
  denominations?: DenominationCount | null;
  movements?: CashMovement[];
  updatedAt?: string;
  deviceId?: string;
  terminalName?: string;
}

export interface InventoryValuation {
  totalSkus: number;
  totalUnits: number;
  totalCostValue: number;
  totalRetailValue: number;
  potentialProfitMargin: number;
}

export interface ShiftCloseReport {
  session: CashSession;
  inventoryValuationSnapshot?: InventoryValuation;
  dbIntegrity?: unknown;
  backupType?: string;
  generatedAt?: string;
}

export interface ShiftZReportData {
  shiftId: string;
  openedAt: string;
  closedAt: string;
  openingFloat: number;
  totalCashSales: number;
  totalCashDrops: number;
  totalPayouts: number;
  expectedCash: number;
  actualCash: number;
  variance: number;
  transactionCount: number;
  cashierName: string;
}

export interface LicenseDetails {
  machineFingerprint: string;
  status: 'Active' | 'Unlicensed';
  licenseKey: string;
  maxTerminals: number;
  activatedAt: string;
}

export interface HardwareStatus {
  printerConnected: boolean;
  scannerConnected: boolean;
  cashDrawerOpen: boolean;
  customerDisplayConnected: boolean;
}

export const APP_VERSION = '1.6.8';

// Cached formatters: constructing Intl.NumberFormat per call showed up in
// checkout/catalog hot paths. One instance per fraction variant.
const dzdFormatters: Record<'int' | 'frac', Intl.NumberFormat> = {
  int: new Intl.NumberFormat('fr-DZ', {
    style: 'currency',
    currency: 'DZD',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }),
  frac: new Intl.NumberFormat('fr-DZ', {
    style: 'currency',
    currency: 'DZD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }),
};

export const formatDZD = (amount: number): string => {
  // Non-finite input is a data bug: render an explicit placeholder instead of
  // a valid-looking "0 DA" that would corrupt a merchant's mental ledger.
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  const safeAmount = amount;
  const isWhole = safeAmount % 1 === 0;
  return dzdFormatters[isWhole ? 'int' : 'frac']
    .format(safeAmount)
    .replace('DZD', 'DA');
};

export const formatDateTime = (dateStr?: string): string => {
  if (!dateStr) return '';
  const parsedDate = new Date(dateStr);
  if (isNaN(parsedDate.getTime())) return dateStr;
  // toLocaleString (not toLocaleDateString): the date-only variant silently
  // dropped the hour/minute fields even though they were requested.
  return parsedDate.toLocaleString('fr-DZ', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};
