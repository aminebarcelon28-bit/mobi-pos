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

export type PaymentMethodType = 'Espèces' | 'Avoir Client' | 'BaridiMob' | 'Chèque' | 'Crédit Client' | 'Reprise' | 'Autre';

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
   * Shift-opener snapshot (Part 1 seller rule): the immutable identity of the
   * cashier who opened the owning shift (`CashSession.openedBy`) at commit
   * time. Historical reprints read THIS first, so the printed `Vendeur`
   * survives handovers (`setShiftCashier` re-points `cashierName`, never this)
   * and stays correct weeks later. Rides `json_payload` — no migration.
   * Absent on legacy rows, which fall back through the resolution chain.
   */
  shiftOpenedByName?: string;
  /**
   * Staged voucher tender captured at checkout (code + applied amount).
   * Persisted on the row (not just the envelope) so void/refund flows can
   * credit the bearer value back instead of burning it. Absent = no voucher.
   */
  voucherCode?: string | null;
  voucherCreditApplied?: number;
  /**
   * Two-way exchange linkage (trade-in + new purchase, net delta).
   * Persisted on the row (not just the envelope) so void/refund flows can
   * reverse the intake leg instead of burning it. Absent = no trade-in.
   * `tradeInDeduction` is the buyback value applied 1:1 against the cart
   * (no +10% wallet bonus in exchange mode — bonus would inflate cost basis).
   */
  tradeInId?: string | null;
  tradeInDeduction?: number;
  /**
   * Soulte boutique settled on this ticket (shop owed the difference).
   * Persisted for receipt + audit so the payout method is traceable.
   */
  tradeInSoulte?: { amount: number; method: 'cash' | 'wallet' } | null;
  /**
   * Chaos S5: trade-in value restored to the wallet BY this refund row.
   * Bounds cumulative restoration across partial refunds so the same
   * deduction is never re-credited twice. Absent = no trade restoration.
   */
  tradeInRestored?: number;
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

export type StockAlertSeverity = 'rupture' | 'critical' | 'warning';

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
  severity: StockAlertSeverity;
}

export interface VendorDirectoryEntry {
  phone?: string;
  /** WhatsApp-specific number; falls back to `phone` when unset. */
  whatsapp?: string;
  email?: string;
  updatedAt?: string;
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

/** Snapshot for the supplier reception PV (Bon de Réception & Contrôle). */
export interface POReceptionSnapshot {
  /** productId → physically received quantity at control time. */
  receivedQty: Record<string, number>;
  /** productId → invoice-verified unit cost (optional). */
  actualCosts?: Record<string, number>;
  /** productId → discrepancy note (optional). */
  reasons?: Record<string, string>;
  /** Supplier invoice / BL number (optional). */
  supplierInvoice?: string;
  /** Reception timestamp ISO (defaults to print time). */
  receivedAt?: string;
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

// ── Nuanced physical-intake damage schema (Phase 4.6) ──
// Replaces the primitive boolean `bodyOk` with an explicit, legally defensible
// intake record. Every field is optional so legacy records (which only carry
// `bodyOk`) deserialize without migration; the intake form populates them.
export type ScreenCondition =
  | 'intact'
  | 'scratched'
  | 'cracked'
  | 'display_bleed'
  | 'dead_pixels'
  | 'no_display';

export const SCREEN_CONDITION_LABELS: Record<ScreenCondition, string> = {
  intact: 'Intact',
  scratched: 'Rayé / éraflé',
  cracked: 'Fissuré',
  display_bleed: 'Tache / trait d’affichage',
  dead_pixels: 'Pixels morts',
  no_display: 'Écran mort / ne s’allume pas',
};

export const SCREEN_CONDITION_ORDER: ScreenCondition[] = [
  'intact',
  'scratched',
  'cracked',
  'display_bleed',
  'dead_pixels',
  'no_display',
];

export type ChassisDamage =
  | 'none'
  | 'scratches'
  | 'dents'
  | 'bent_frame'
  | 'cracked_back';

export const CHASSIS_DAMAGE_LABELS: Record<ChassisDamage, string> = {
  none: 'Intact',
  scratches: 'Rayures',
  dents: 'Coups / bosses',
  bent_frame: 'Châssis tordu',
  cracked_back: 'Dos cassé',
};

/** Multi-select: `none` is exclusive with every other value. */
export const CHASSIS_DAMAGE_ORDER: ChassisDamage[] = [
  'none',
  'scratches',
  'dents',
  'bent_frame',
  'cracked_back',
];

export type DeviceLockType = 'none' | 'pin' | 'pattern' | 'account_locked';

export const DEVICE_LOCK_LABELS: Record<DeviceLockType, string> = {
  none: 'Aucun verrouillage',
  pin: 'Code PIN',
  pattern: 'Schéma',
  account_locked: 'Compte verrouillé (FRP/Activation)',
};

export const DEVICE_LOCK_ORDER: DeviceLockType[] = ['none', 'pin', 'pattern', 'account_locked'];

export interface DeviceLockState {
  type: DeviceLockType;
  /**
   * NEVER the raw secret. The intake form accepts a lock code, then stores
   * only whether one was supplied (`[fourni]`); the raw value is discarded so
   * a stolen database cannot unlock the customer's phone.
   */
  provided?: boolean;
}

/** True when the dossier records a lock the workshop cannot bypass. */
export function hasDeviceLock(state?: DeviceLockState): boolean {
  return Boolean(state && state.type && state.type !== 'none');
}

export interface IntakeDamageAssessment {
  screenCondition?: ScreenCondition;
  chassisDamage?: ChassisDamage[];
  liquidIndicatorTripped?: boolean;
  deviceLock?: DeviceLockState;
  /** Free-form technician note on pre-existing damage (printed on the work order only). */
  preExistingNotes?: string;
}

/** Aggregate physical-damage severity, used for badge tone + warranty policy. */
export function intakeDamageSeverity(
  dmg?: IntakeDamageAssessment
): 'none' | 'minor' | 'major' {
  if (!dmg) return 'none';
  const chassis = (dmg.chassisDamage || []).filter((c) => c !== 'none');
  const screen = dmg.screenCondition;
  const screenMajor =
    screen === 'cracked' ||
    screen === 'display_bleed' ||
    screen === 'dead_pixels' ||
    screen === 'no_display';
  if (dmg.liquidIndicatorTripped || screenMajor || chassis.includes('bent_frame') || chassis.includes('cracked_back')) {
    return 'major';
  }
  if (screen === 'scratched' || chassis.length > 0) return 'minor';
  return 'none';
}

/**
 * Whether the intake constat voids the REPAIR warranty, as distinct from
 * `intakeDamageSeverity` (which grades PHYSICAL damage only).
 *
 * These are deliberately different questions. A locked device is not physical
 * damage, so it does not colour the damage badge — but the workshop cannot
 * verify any function on it, so it cannot certify the repair either. Keeping
 * the two separate stops a locked phone from being reported as "Conforme"
 * while still being warranty-eligible, and stops a merely scratched chassis
 * from being used to void a repair warranty.
 */
export function intakeBlocksRepairWarranty(dmg?: IntakeDamageAssessment): boolean {
  if (!dmg) return false;
  if (intakeDamageSeverity(dmg) === 'major') return true;
  if (hasDeviceLock(dmg.deviceLock)) return true;
  return false;
}

/** Compact one-line physical-damage summary for tickets and work orders. */
export function describeIntakeDamage(dmg?: IntakeDamageAssessment): string {
  if (!dmg) return 'Constat non renseigné';
  const parts: string[] = [];
  if (dmg.screenCondition) parts.push(`Écran: ${SCREEN_CONDITION_LABELS[dmg.screenCondition]}`);
  const chassis = (dmg.chassisDamage || []).filter((c) => c !== 'none');
  parts.push(
    `Châssis: ${chassis.length ? chassis.map((c) => CHASSIS_DAMAGE_LABELS[c]).join(', ') : 'Intact'}`
  );
  parts.push(`Indicateur liquide: ${dmg.liquidIndicatorTripped ? 'DÉCLENCHÉ' : 'OK'}`);
  parts.push(`Verrouillage: ${dmg.deviceLock ? DEVICE_LOCK_LABELS[dmg.deviceLock.type] : 'Non renseigné'}`);
  return parts.join(' • ');
}

// ── Strict warranty tier policy (Phase 4.6) ──
// Floating day ranges ("358J", "J-X") are disallowed. Every warranty is one of
// the immutable tiers below, resolved to an exact calendar expiry date
// (YYYY-MM-DD) computed at the moment of coverage start. Repair warranty starts
// at restitution (RESTITUE), never at intake.
export type WarrantyTier =
  | 'none'
  | 'test_7d'
  | 'repair_30d'
  | 'repair_90d'
  | 'repair_180d';

/** Ordered tier list for selectors — the ONLY legal choices, in order. */
export const WARRANTY_TIER_ORDER: WarrantyTier[] = [
  'none',
  'test_7d',
  'repair_30d',
  'repair_90d',
  'repair_180d',
];

export const WARRANTY_TIER_DAYS: Record<WarrantyTier, number> = {
  none: 0,
  test_7d: 7,
  repair_30d: 30,
  repair_90d: 90,
  repair_180d: 180,
};

export const WARRANTY_TIER_LABELS: Record<WarrantyTier, string> = {
  none: 'Sans garantie',
  test_7d: 'Garantie test 7 jours',
  repair_30d: 'Garantie réparation 30 jours',
  repair_90d: 'Garantie réparation 90 jours',
  repair_180d: 'Garantie réparation 180 jours',
};

/** Resolve a legacy months value to the nearest strict tier (read-only audit). */
export function warrantyMonthsToTier(months: number | undefined): WarrantyTier {
  const m = Math.max(0, Math.floor(Number(months) || 0));
  if (m <= 0) return 'none';
  if (m <= 1) return 'test_7d';
  if (m <= 3) return 'repair_30d';
  if (m <= 6) return 'repair_90d';
  return 'repair_180d';
}

export type RepairStatus =
  | 'Diagnostic'
  | 'En attente de pièces'
  | 'En cours'
  | 'Prêt / Terminé'
  | 'Livré'
  | 'Annulé';

export const ACTIVE_REPAIR_STATUSES: RepairStatus[] = [
  'Diagnostic',
  'En attente de pièces',
  'En cours',
];

/** Single DZD-rounding source for SAV balances. */
export function repairRemainingBalance(order: Pick<RepairOrder, 'totalCost' | 'depositAmount'>): number {
  return Math.max(0, Math.round(order.totalCost || 0) - Math.round(order.depositAmount || 0));
}

/** Current SAV dossier schema version. v2 = strict legal record (Phase 5). */
export const REPAIR_SCHEMA_VERSION = 2 as const;

export type RepairSchemaVersion = typeof REPAIR_SCHEMA_VERSION;

/** True when the order carries the full v2 legal record (not a legacy dossier). */
export function isSchemaV2Order(
  order: Pick<RepairOrder, 'schemaVersion'>
): boolean {
  return order.schemaVersion === REPAIR_SCHEMA_VERSION;
}

/** Pill shown on every legacy (v1 / unmigrated) dossier. */
export const LEGACY_DOSSIER_PILL = 'Dossier Archivé (Non migré)';

/**
 * Itemized SAV financials in integer DZD. `balanceDue` is DERIVED, never
 * stored: a persisted balance can drift from its components and become an
 * unrecoverable money-flow bug (a paid repair that still reads as unpaid).
 */
export interface RepairFinancials {
  partsCost: number;
  laborCost: number;
  totalCost: number;
  depositAmount: number;
  balanceDue: number;
}

/** Single rounding source for every displayed/printed SAV money figure. */
export function repairFinancials(
  order: Pick<RepairOrder, 'laborCost' | 'partsCost' | 'depositAmount'>
): RepairFinancials {
  const laborCost = Math.max(0, Math.round(Number(order.laborCost) || 0));
  const partsCost = Math.max(0, Math.round(Number(order.partsCost) || 0));
  const totalCost = laborCost + partsCost;
  const depositAmount = Math.max(0, Math.min(totalCost, Math.round(Number(order.depositAmount) || 0)));
  return {
    partsCost,
    laborCost,
    totalCost,
    depositAmount,
    balanceDue: totalCost - depositAmount,
  };
}

/** One intake photo: bytes live on the filesystem, only evidence lives here. */
export interface IntakePhotoRef {
  /** Relative path under the attachment root — never an absolute path. */
  relativePath: string;
  /** SHA-256 (hex) of the stored bytes; the tamper-evidence anchor. */
  sha256: string;
  capturedAt: string;
  /** Free label shown on the work order ("écran", "connecteur"...). */
  label?: string;
  byteSize?: number;
}

export const REPAIR_STATUS_BADGE_TOKENS: Record<RepairStatus, string> = {
  Diagnostic: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  'En attente de pièces': 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
  'En cours': 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  'Prêt / Terminé': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  // eslint-disable-next-line @typescript-eslint/naming-convention
  'Livré': 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  // eslint-disable-next-line @typescript-eslint/naming-convention
  'Annulé': 'bg-rose-500/10 text-rose-500 border-rose-500/20',
};

/**
 * Append a status-transition entry to the order's timeline. Returns a new
 * array (immutable append); the caller persists the order.
 */
export function appendRepairStatusHistory(
  order: RepairOrder,
  status: RepairStatus,
  updatedBy: string,
  note?: string
): RepairStatusHistoryEntry[] {
  const prev = order.statusHistory || [];
  // Coalesce: if the last entry already matches this status and was recorded
  // within the same second, don't bloat the timeline with duplicate rows.
  const last = prev[prev.length - 1];
  if (last && last.status === status && last.updatedBy === updatedBy) {
    const sameSecond =
      Math.abs(new Date(last.timestamp).getTime() - Date.now()) < 2000;
    if (sameSecond) return prev;
  }
  return [
    ...prev,
    {
      status,
      timestamp: new Date().toISOString(),
      updatedBy,
      ...(note ? { note } : {}),
    },
  ];
}

/** Compute an exact calendar expiry date (YYYY-MM-DD) from a start date + tier. */
export function computeWarrantyExpiryISO(startIso: string, tier: WarrantyTier): string {
  const days = WARRANTY_TIER_DAYS[tier] || 0;
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/**
 * Warranty start marker for repair coverage. Repair warranty always begins at
 * restitution (device handover), never at intake. The intake form locks this
 * value; the actual date is stamped when the order transitions to `Livré`.
 */
export const REPAIR_WARRANTY_START = 'RESTITUE' as const;

/** Label text for the current REPAIR_SCHEMA_VERSION. */
export const SCHEMA_VERSION_LABEL: Record<number, string> = {
  1: 'Legacy (v1)',
  2: 'Dossier complet (v2)',
};

/**
 * Backward-compatible migration helper. Legacy repair orders (pre-4.6) carry
 * only the primitive `ConditionChecklist` booleans and no signature. This
 * function applies safe defaults so historical tickets deserialize, display,
 * and edit without throwing. It is idempotent — calling it on an already
 * migrated order returns the same object.
 *
 * MIGRATION IS NEVER SILENTLY APPLIED AT RUNTIME for legal fields: migrated
 * copies are render-only (read-only "Dossier Archivé" mode). `schemaVersion`
 * stays absent on them so no save path can silently "upgrade" history.
 */
export function migrateRepairOrder(order: RepairOrder): RepairOrder {
  if (!order) return order;
  if (isSchemaV2Order(order)) return order;
  const hasIntake = !!order.intakeDamage;
  const hasSignature = !!order.signatureCustomer;
  const hasTier = !!order.warrantyTier;
  const hasHistory = Array.isArray(order.statusHistory);
  if (hasIntake && hasSignature && hasTier && hasHistory) return order;

  const migrated: RepairOrder = { ...order };

  if (!hasTier) {
    // Derive a strict tier from the legacy warranty snapshot / months.
    const months = order.warrantySnapshot?.expiryDate
      ? Math.max(0, Math.ceil((new Date(order.warrantySnapshot.expiryDate).getTime() - new Date(order.createdAt).getTime()) / 86400000))
      : undefined;
    migrated.warrantyTier = warrantyMonthsToTier(months);
  }

  if (!hasIntake) {
    migrated.intakeDamage = {
      screenCondition: order.conditionChecklist?.screenOk ? 'intact' : 'cracked',
      chassisDamage: order.conditionChecklist?.bodyOk ? [] : ['scratches'],
      liquidIndicatorTripped: false,
    };
  }

  if (!hasSignature) {
    // Legacy ticket: no signature on file. Leave null — the intake form
    // blocks NEW saves, but we never fabricate a signature for old data.
    migrated.signatureCustomer = undefined;
  }

  if (!hasHistory) {
    migrated.statusHistory = [
      {
        status: order.status,
        timestamp: order.createdAt || new Date().toISOString(),
        updatedBy: 'Système (Migration)',
        note: 'Historique migré depuis le format antérieur',
      },
    ];
  }

  return migrated;
}

export interface WarrantySnapshot {
  isUnderWarranty: boolean;
  label: string;
  expiryDate?: string;
}

/** Selects which SAV document renders inside the shared print-repair-target. */
export type RepairPrintKind = 'work_order' | 'restitution' | 'quote';

/** Cross-modal print handshake: Command dashboard arms it, Repair modal consumes it. */
export interface PendingRepairPrint {
  orderId: string;
  kind: Exclude<RepairPrintKind, 'work_order'>;
}

/** Devis number derived from the ticket (no stored field, no migration). */
export function repairQuoteNumber(order: Pick<RepairOrder, 'ticketNumber'>): string {
  return `DEV-${order.ticketNumber}`;
}

/** Quote validity window in days (computed at print time). */
export const REPAIR_QUOTE_VALIDITY_DAYS = 15;

/** Invalidation banner for restitution invoked before settlement. */
export const RESTITUTION_UNSETTLED_BANNER = 'DOCUMENT NON VALIDE — EN ATTENTE DE RÈGLEMENT';

/** Default store city for dated legal signature lines. */
export const DEFAULT_STORE_CITY = 'Mascara';

/** City for « Fait à …, le … » legal lines (ASCII-safe for thermal). */
export function storeCityOf(settings?: { city?: string } | null): string {
  const city = (settings?.city || '').trim();
  return city || DEFAULT_STORE_CITY;
}

/** Dated legal location line shared by all A4/thermal signature blocks. */
export function faitALine(settings?: { city?: string } | null, at?: Date | string): string {
  const d = at instanceof Date ? at : new Date(typeof at === 'string' ? at : Date.now());
  return `Fait à ${storeCityOf(settings)}, le ${d.toLocaleDateString('fr-DZ')}`;
}

/** Harmonized unclaimed-device clause (thermal ↔ A4 identical). */
export const UNCLAIMED_DEVICE_CLAUSE =
  "Appareil non réclamé après 90 jours considéré comme abandonné et orienté vers le recyclage/démantèlement (Art. CGV).";

/** Harmonized data-loss disclaimer (thermal 1-line + A4 long form share it). */
export const DATA_LOSS_DISCLAIMER =
  "AVIS: Sauvegarde des données à la charge du client. L'atelier décline toute responsabilité en cas de perte logicielle.";

export interface RepairOrder {
  id: string;
  ticketNumber: string;
  /**
   * Absent / 1 on historical dossiers (render-only, read-only in the UI).
   * `2` marks a full legal record: damage matrix, signature, strict tier,
   * photo evidence, itemized financials.
   */
  schemaVersion?: number;
  customerName: string;
  customerPhone: string;
  deviceModel: string;
  imei: string;
  /** How `imei` was entered (IMEI / serial / none). v2 only. */
  imeiKind?: 'imei' | 'serial' | 'none';
  /** Printable French label for the identifier ("IMEI", "N° Série", "Sans ID"). */
  imeiKindLabel?: string;
  problemDescription: string;
  diagnosticNotes: string;
  conditionChecklist: ConditionChecklist;
  postRepairChecklist?: ConditionChecklist;
  // Phase 4.6: nuanced intake damage assessment (backward-compatible — all optional).
  intakeDamage?: IntakeDamageAssessment;
  status: RepairStatus;
  laborCost: number;
  partsCost: number;
  totalCost: number;
  depositAmount?: number;
  estimatedCompletionDate?: string;
  createdAt: string;
  updatedAt?: string;
  /** Exact RESTITUE date (ISO date) the warranty clock was anchored to. */
  deliveredAt?: string;
  warrantySnapshot?: WarrantySnapshot;
  // Phase 4.6: enterprise-grade SAV enhancements.
  assignedTechnicianId?: string;
  technicianNotes?: string;
  /** @deprecated v1 field name. v2 writes `signatureCustomerIntake`. */
  signatureCustomer?: string;
  signatureTechnician?: string;
  /** Customer touch signature captured at INTAKE (base64 PNG). Required for v2. */
  signatureCustomerIntake?: string;
  /** Customer touch signature captured at RESTITUTION (base64 PNG). */
  signatureCustomerRestitution?: string;
  signatureIntakeAt?: string;
  signatureRestitutionAt?: string;
  /** v1 free-form photo strings; v2 uses filesystem-backed `intakePhotos`. */
  photos?: string[];
  /** Filesystem-backed photo evidence (path + SHA-256), never inline bytes. */
  intakePhotos?: IntakePhotoRef[];
  /** Customer agreed to the draft SAV terms at intake (v2, boolean + date). */
  legalTermsAcceptedAt?: string;
  warrantyTier?: WarrantyTier;
  warrantyExpiresAt?: string;
  statusHistory?: RepairStatusHistoryEntry[];
}

/** Append-only audit trail for status transitions. */
export interface RepairStatusHistoryEntry {
  status: RepairStatus;
  timestamp: string;
  updatedBy: string;
  note?: string;
}

// ── Inspector → SAV intake handoff (Phase 5, Option A) ──
// Packaged by the Inspector when the operator taps "Créer Prise en Charge SAV"
// and consumed (then atomically cleared) by the repair modal on mount. Living
// in the repair slice (not component state) means the handoff survives a modal
// close/reopen and never requires the technician to retype the identifier.
//
// `warrantyDossier` is the FROZEN resolver snapshot: the ticket must record
// what the operator saw at inspection time, not a re-lookup that could differ.
export interface IntakeDraft {
  /** Sanitized identifier: 15 valid digits (IMEI) or an uppercase serial. */
  sanitizedId: string;
  idType: 'imei' | 'serial' | 'manual';
  deviceTitle: string;
  customer: {
    name?: string;
    phone?: string;
  };
  warrantyDossier: WarrantyDossierSnapshot;
  createdAt: string;
}

/** How long a seeded draft stays actionable before it is treated as stale. */
export const INTAKE_DRAFT_TTL_MS = 15 * 60 * 1000;

/** Freshness gate — a stale draft must never hydrate a new ticket. */
export function isIntakeDraftFresh(draft: IntakeDraft | null, nowMs = Date.now()): boolean {
  if (!draft) return false;
  const t = new Date(draft.createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t <= INTAKE_DRAFT_TTL_MS;
}

/** Printable French labels for the identifier mode. */
export const DEVICE_ID_KIND_LABELS: Record<'imei' | 'serial' | 'manual', string> = {
  imei: 'IMEI',
  serial: 'N° Série',
  manual: 'Sans ID',
};

/**
 * Stored vocabulary: the form's `manual` mode is persisted as `none`, so a
 * stored ticket can never contain a UI-only value. Only these three are legal
 * in `RepairOrder.imeiKind`.
 */
export const STORED_ID_KIND_LABELS: Record<'imei' | 'serial' | 'none', string> = {
  imei: 'IMEI',
  serial: 'N° Série',
  none: 'Sans ID',
};

// ── Conditions Générales de Prise en Charge SAV (v2 legal terms) ──
// Rendered verbatim on the intake PV and printed on the ticket. The customer
// signs them at intake; the acceptance timestamp is stored on the order.
/* PROVISIONAL_LEGAL_TERMS: REQUIRES_OWNER_SIGN_OFF */
/**
 * Machine-readable form of the sign-off tag above. The boundary check greps
 * for the literal, so the two must stay in sync; exporting it also lets a
 * caller tell the customer that the text is not yet legally reviewed.
 */
export const LEGAL_TERMS_PROVISIONAL = 'REQUIRES_OWNER_SIGN_OFF' as const;
export const SAV_LEGAL_TERMS_FR = [
  "1. Objet — L'atelier prend l'appareil en charge aux seules fins de diagnostic et de réparation, après constat contradictoire de l'état mentionné ci-dessus.",
  "2. Pannes cachées — L'atelier ne saurait être tenu responsable des défaillances internes non apparentes (oxydation de carte mère, batterie interne défectueuse, corrosion, humidité interne) constatées après démontage, ni de leurs conséquences en cascade.",
  "3. Exclusion de garantie — Toute garantie est exclue en cas de choc, casse, infiltration liquide, rupture du sceau d'inviolabilité, intervention d'un tiers, ou non-respect des conditions d'usage.",
  "4. Responsabilité limitée — La responsabilité de l'atelier est limitée au seul coût de la réparation convenue. Aucun dommage indirect (perte de données, préjudice d'exploitation, perte de revenus) ne pourra lui être imputé.",
  "5. Données — La sauvegarde des données est à la charge exclusive du client. L'atelier ne garantit aucune restitution de données et décline toute responsabilité en cas de perte logicielle.",
  "6. Devis — Le devis est gratuit et sans engagement. La réparation ne débute qu'après accord écrit du client sur le montant estimé.",
  "7. Acompte — L'acompte versé est déduit du solde final. Il n'est remboursable que si la réparation n'est pas exécutée pour cause de pièce indisponible.",
  "8. Gardiennage / déchéance — Tout appareil non réclamé après 90 jours à compter du dépôt est réputé abandonné et orienté vers le recyclage ou le démantèlement, conformément aux CGV de l'atelier. Le client en est informé lors de la remise.",
  "9. Restitution — La restitution s'opère contre présentation du ticket et signature du bon de restitution. L'appareil est réputé vérifié fonctionnel au moment de la remise.",
  "10. Garantie réparation — La garantie réparation court à compter de la RESTITUTION de l'appareil (jamais de la date de dépôt), pour la durée du niveau de garantie choisi, inscrit sur le présent document.",
] as const;

/* PROVISIONAL_LEGAL_TERMS: REQUIRES_OWNER_SIGN_OFF — ملخص بالعربية */
export const SAV_LEGAL_TERMS_AR = [
  '1. موضوع العقد: استلام الجهاز لغرض التشخيص والإصلاح فقط، بعد معاينة حالته الموثقة أعلاه.',
  '2. الأعطال الخفية: لا يتحمل الورشة مسؤولية الأعطال الداخلية غير الظاهرة (صدأ اللوحة الأم، تلف البطارية، الرطوبة) المكتشفة بعد التفكيك.',
  '3. استثناء الضمان: يُستثنى الضمان في حالة الصدم أو الكسر أو دخول السوائل أو كسر ختم الأمان أو تدخّل طرف ثالث.',
  '4. حدود المسؤولية: تقتصر مسؤولية الورشة على كلفة الإصلاح المتفق عليها فقط، ولا تتحمل أي أضرار غير مباشرة.',
  '5. البيانات: حفظ نسخة من البيانات مسؤولية العميل حصرياً، والورشة غير مسؤولة عن فقدانها.',
  '6. العروض: العرض مجاني وغير ملزم، ولا يبدأ الإصلاح إلا بعد موافقة العميل كتابياً.',
  '7. التسبيق: يُخصم التسبيق من المبلغ النهائي.',
  '8. الحيازة والضياع: كل جهاز لم يُستلم خلال 90 يوماً يُعتبر متروكاً ويُوجَّه إلى إعادة التدوير أو التفكيك.',
  '9. التسليم: يتم التسليم مقابل تقديم التذكرة والتوقيع على وصل التسليم.',
  '10. ضمان الإصلاح: يسري الضمان من تاريخ التسليم (وليس من تاريخ الإيداع) ولمدة المستوى المختار.',
] as const;

/** Single-line intake summary (thermal, 32-col) of the accepted terms. */
export const SAV_LEGAL_TERMS_SHORT =
  'CGV SAV: panne cachee exclue • choc/liquide/sceau = garantie exclue • donnees a la charge du client • non reclame sous 90j = recyclage • garantie = RESTITUE.';

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

/**
 * Two-way exchange direction for a staged trade-in against a cart total.
 * Net Balance = Gross Cart Total − Trade-In Buyback Value (1:1, no bonus).
 */
export type TradeInDirection = 'CUSTOMER_PAYS' | 'SOULTE_SHOP_PAYS' | 'EVEN';

/**
 * Validated trade-in payload staged from the cart/payment flow.
 * Does NOT commit to the DB — the atomic checkout flight persists intake
 * + purchase together so a canceled exchange leaves zero orphaned records.
 * The +10% wallet bonus is disabled here: buyback applies 1:1 to avoid
 * inflating inventory cost basis and distorting margins.
 */
export interface StagedTradeIn extends Omit<TradeInItem, 'id' | 'createdAt' | 'resalePrice'> {
  stagedId: string;
}

/** Settlement snapshot for the exchange delta banner / soulte view. */
export interface TradeInSettlement {
  staged: StagedTradeIn | null;
  buybackValue: number;
  grossCartTotal: number;
  netBalance: number;
  direction: TradeInDirection;
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

/**
 * Frozen warranty resolution carried from the Inspector into a SAV ticket.
 *
 * The ticket must record what the operator actually saw at inspection time.
 * A re-lookup at save time could resolve differently (a concurrent sale, a
 * device re-registered on another record, a clock change), so the snapshot is
 * treated as immutable evidence: nothing downstream recomputes it.
 */
export interface WarrantyDossierSnapshot {
  /** Sanitized identifier that was resolved (15 valid digits, serial, or null-ish). */
  idValue: string;
  /** Which identifier mode produced `idValue`. */
  idMode: 'imei' | 'serial' | 'manual';
  /** The resolved lifecycle dossier at inspection time. */
  dossier: ImeiLifecycleDossier;
  /** Which customer-warranty tier the resolver suggested, if any. */
  suggestedTier: WarrantyTier;
  /** Monotonic capture timestamp for audit/debugging. */
  resolvedAt: string;
}

export type PosDocumentType =
  | 'SALE_RECEIPT'
  | 'REPAIR_CLAIM_STUB'
  | 'REPAIR_WORK_ORDER'
  | 'TRADE_IN_VOUCHER'
  | 'PRODUCT_LABEL'
  | 'Z_REPORT'
  | 'WARRANTY_CERTIFICATE'
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
  /** Activity tagline (e.g. "Commerce & Vente Téléphonie"). Optional: omitted when blank. */
  storeSubheader?: string;
  logoUrl: string;
  /** Optional: header lines render only when non-blank (never a ghost label). */
  address?: string;
  phone?: string;
  /** Optional contact email — printed as `Email: <email>`, omitted when blank. */
  email?: string;
  customHeaderMsg: string;
  customFooterMsg: string;
  showBarcode: boolean;
  autoPrintEnabled?: boolean;
  kickCashDrawerOnCash?: boolean;
  printerRouting?: PrinterRoutingConfig;
  loyaltyConfig?: LoyaltyProgramConfig;
  paperWidth?: '80mm' | '58mm';
  taxNumber?: string; // NIF / NIS / RC (legacy single field)
  /** Granular Algerian fiscal identifiers (win over taxNumber when set). */
  rc?: string;
  nif?: string;
  nis?: string;
  art?: string;
  /** Store city for dated legal lines (« Fait à … »). Defaults to Mascara. */
  city?: string;
  /**
   * Custom bottom note / policy — PRIMARY footer. When set it replaces the
   * default return policy block on every slip; `customFooterMsg` stays as the
   * legacy fallback (the settings modal mirrors both on save). Empty (or
   * whitespace-only) falls back cleanly — never a blank policy block.
   */
  footerMessage?: string;
  printerInterface?: 'BROWSER' | 'SPOOLER' | 'NETWORK' | 'SERIAL';
  printerName?: string;
  baridimobRip?: string;        // 16 or 20-digit BaridiMob RIP
  ccpAccount?: string;          // CCP Account + Clé
  bankBeneficiaryName?: string; // Account Holder Name
  /** DEPRECATED (no-TVA product, Gate Addendum A): ignored — every sale is HT-only. Kept until Phase 1b removes it. */
  vatRate?: number;
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
  /**
   * FT-06/C provenance. `'local'` (default) = written on this device through
   * the native chain; `'imported'` = merged from a backup envelope
   * (insert-only, carries no chain links). Absent (legacy rows) reads as
   * `'local'`. The UI must label `'imported'` rows as unverified history,
   * never as chained evidence.
   */
  source?: string;
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
  /** Informational X-report splits (never part of expected-cash math). */
  savDeposits?: number;
  savSettled?: number;
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
