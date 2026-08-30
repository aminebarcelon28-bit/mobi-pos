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

export interface LoyaltyLedgerEntry {
  id: string;
  customerId: string;
  timestamp: string;
  type: 'earn' | 'redeem' | 'bonus' | 'conversion' | 'adjustment';
  points: number;
  balanceAfter: number;
  description: string;
  referenceId?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  registeredDevice: string;
  loyaltyPoints: number;
  storeCredit: number;
  pricingTier: PricingTier;
  loyaltyTier?: LoyaltyTierName;
  totalSpent?: number;
  ledger?: LoyaltyLedgerEntry[];
  avatarUrl?: string;
  loyaltyCardCode?: string;
  barcode?: string;
}

export interface HeldSale {
  id: string;
  customer: Customer | null;
  items: CartItem[];
  timestamp: string;
  note?: string;
}

export type PaymentMethodType = 'Espèces' | 'Avoir Client' | 'BaridiMob' | 'Chèque';

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
  suggestedQty: number;
  unitCost: number;
  totalCost: number;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorName: string;
  createdAt: string;
  items: POLineItem[];
  totalAmount: number;
  status: 'Draft' | 'Approved' | 'Sent' | 'Received';
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

export interface TradeInItem {
  id: string;
  deviceModel: string;
  imei: string;
  brand: BrandName;
  conditionGrade: ConditionGrade;
  buybackValue: number;
  resaleMarginPercent: number;
  resalePrice: number;
  customerName: string;
  creditToWallet: boolean;
  createdAt: string;
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
