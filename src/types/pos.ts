export type BrandName = 'Apple' | 'Samsung' | 'Google' | 'ZAGG' | 'Belkin' | 'Anker' | 'Autre';

export type CategoryType = 
  | 'Tous les produits'
  | 'Coques iPhone'
  | 'Coques Samsung'
  | 'Coques Google'
  | 'Chargeurs'
  | 'Câbles'
  | 'Protège-Écran'
  | 'Téléphones d\'Occasion (Reprise)';

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
  volumeDiscounts?: VolumeDiscountTier[];
  costPrice: number;
  stock: number;
  imageUrl: string;
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
}

export type ProductInput = Omit<Product, 'id'> & { id?: string };

export interface CartItem {
  product: Product;
  quantity: number;
  discount: number;
  serialNumber?: string;
  imeiNumber?: string;
  appliedPrice: number;
  unitCostPrice?: number; // Immutable unit cost price captured permanently at checkout
  volumeTierApplied?: boolean;
}

export type LoyaltyTierName = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'VIP Diamond';

export interface LoyaltyTierInfo {
  name: LoyaltyTierName;
  minSpend: number;
  pointsMultiplier: number;
  discountPercent: number;
  badgeColor: string;
  bgColor: string;
  borderColor: string;
  icon: string;
}

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
  baseSpendPerPoint: number; // e.g. 100 DA spent = 1 base point
  pointRedemptionRate: number; // e.g. 10 Pts = 100 DA (1 Pt = 10 DA value)
  minimumRedemptionPoints: number; // e.g. 50 pts required
  maximumRedemptionPercentPerSale: number; // e.g. 50% max of cart total
  tierThresholds: {
    silverMinSpend: number;
    goldMinSpend: number;
    platinumMinSpend: number;
    vipDiamondMinSpend: number;
  };
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
  type: 'earn' | 'redeem' | 'bonus' | 'conversion' | 'adjustment' | 'expired';
  points: number;
  balanceAfter: number;
  description: string;
  referenceId?: string;
  creditDeltaDzd?: number;
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
  loyaltyTier?: LoyaltyTierName;
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
}

export interface SecurityAuditLogEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  requiresPin: boolean;
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
  status: 'OPEN' | 'CLOSED';
  cashierName: string;
  openingNote?: string;
  closingNote?: string | null;
  denominations?: DenominationCount | null;
  movements?: CashMovement[];
  updatedAt?: string;
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

export const APP_VERSION = '1.6.0';

export const formatDZD = (amount: number): string => {
  return new Intl.NumberFormat('fr-DZ', {
    style: 'currency',
    currency: 'DZD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })
    .format(amount)
    .replace('DZD', 'DA');
};

export const formatDateTime = (dateStr?: string): string => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('fr-DZ', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};
