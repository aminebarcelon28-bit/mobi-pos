import type { Customer, LoyaltyLedgerEntry, LoyaltyTierInfo, LoyaltyProgramConfig, FinancialProfitImpact, CartItem } from '../types/pos';

// ══════════════════════════════════════════════════════════════
// DEFAULT GRANULAR LOYALTY PROGRAM CONFIGURATION
// ══════════════════════════════════════════════════════════════

export const DEFAULT_LOYALTY_CONFIG: LoyaltyProgramConfig = {
  enabled: true,
  baseSpendPerPoint: 100, // 100 DA spent = 1 base point
  pointRedemptionRate: 10, // 1 Point = 10 DA store credit
  minimumRedemptionPoints: 50, // Minimum 50 points needed to redeem
  maximumRedemptionPercentPerSale: 50, // Max 50% of basket can be paid via points/credit
  tierThresholds: {
    silverMinSpend: 50000,
    goldMinSpend: 150000,
    platinumMinSpend: 300000,
    vipDiamondMinSpend: 600000,
  },
  tierMultipliers: {
    bronze: 1.0,
    silver: 1.25,
    gold: 1.5,
    platinum: 2.0,
    vipDiamond: 2.5,
  },
  categoryMultipliers: [
    { category: 'Chargeurs', multiplier: 1.5 },
    { category: 'Protège-Écran', multiplier: 2.0 },
    { category: 'Coques iPhone', multiplier: 1.25 },
  ],
  activeCampaigns: [
    {
      id: 'CAMP-WEEKEND-DOUBLE',
      name: 'Campagne Offre Spéciale Week-end 2x Points',
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      multiplier: 2.0,
      active: true,
    },
  ],
  enableCardBarcodeScanning: true,
  cardPrefix: 'LOY-',
};

// ══════════════════════════════════════════════════════════════
// LOYALTY TIER CONFIGURATION MATRIX
// ══════════════════════════════════════════════════════════════

export const LOYALTY_TIERS: LoyaltyTierInfo[] = [
  {
    name: 'Bronze',
    minSpend: 0,
    pointsMultiplier: 1.0,
    discountPercent: 0,
    badgeColor: 'text-amber-600',
    bgColor: 'bg-amber-600/15',
    borderColor: 'border-amber-600/30',
    icon: '🥉',
  },
  {
    name: 'Silver',
    minSpend: 50000, // 50,000 DA cumulative spend
    pointsMultiplier: 1.25,
    discountPercent: 3,
    badgeColor: 'text-slate-300',
    bgColor: 'bg-slate-300/15',
    borderColor: 'border-slate-300/30',
    icon: '🥈',
  },
  {
    name: 'Gold',
    minSpend: 150000, // 150,000 DA cumulative spend
    pointsMultiplier: 1.5,
    discountPercent: 5,
    badgeColor: 'text-amber-400',
    bgColor: 'bg-amber-500/15',
    borderColor: 'border-amber-500/30',
    icon: '🥇',
  },
  {
    name: 'Platinum',
    minSpend: 300000, // 300,000 DA cumulative spend
    pointsMultiplier: 2.0,
    discountPercent: 8,
    badgeColor: 'text-cyan-400',
    bgColor: 'bg-cyan-500/15',
    borderColor: 'border-cyan-500/30',
    icon: '💎',
  },
  {
    name: 'VIP Diamond',
    minSpend: 600000, // 600,000 DA cumulative spend
    pointsMultiplier: 2.5,
    discountPercent: 12,
    badgeColor: 'text-purple-400',
    bgColor: 'bg-purple-500/15',
    borderColor: 'border-purple-500/30',
    icon: '👑',
  },
];

// ══════════════════════════════════════════════════════════════
// LOYALTY ENGINE CORE FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Resolves the loyalty tier info based on customer total cumulative spend
 */
export const calculateCustomerTier = (
  totalSpent: number = 0,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): LoyaltyTierInfo => {
  const safeSpend = Math.max(0, totalSpent);
  const thresholds = config?.tierThresholds || DEFAULT_LOYALTY_CONFIG.tierThresholds;
  const multipliers = config?.tierMultipliers || DEFAULT_LOYALTY_CONFIG.tierMultipliers;

  if (safeSpend >= thresholds.vipDiamondMinSpend) {
    return { ...LOYALTY_TIERS[4], minSpend: thresholds.vipDiamondMinSpend, pointsMultiplier: multipliers.vipDiamond };
  }
  if (safeSpend >= thresholds.platinumMinSpend) {
    return { ...LOYALTY_TIERS[3], minSpend: thresholds.platinumMinSpend, pointsMultiplier: multipliers.platinum };
  }
  if (safeSpend >= thresholds.goldMinSpend) {
    return { ...LOYALTY_TIERS[2], minSpend: thresholds.goldMinSpend, pointsMultiplier: multipliers.gold };
  }
  if (safeSpend >= thresholds.silverMinSpend) {
    return { ...LOYALTY_TIERS[1], minSpend: thresholds.silverMinSpend, pointsMultiplier: multipliers.silver };
  }
  return { ...LOYALTY_TIERS[0], minSpend: 0, pointsMultiplier: multipliers.bronze };
};

/**
 * Calculates points earned on a cart taking category multipliers & campaign rules into account
 */
export const calculateEarnedPointsForCart = (
  cart: CartItem[],
  total: number,
  pointsMultiplier: number = 1.0,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): number => {
  if (total <= 0) return 0;
  const baseSpendPerPoint = config?.baseSpendPerPoint || 100;
  
  // Calculate active campaign multiplier
  const campaignMultiplier = (config?.activeCampaigns || [])
    .filter(c => c.active)
    .reduce((max, c) => Math.max(max, c.multiplier), 1.0);

  if (!cart || cart.length === 0) {
    const base = Math.floor(total / baseSpendPerPoint);
    return Math.floor(base * pointsMultiplier * campaignMultiplier);
  }

  let totalPoints = 0;
  for (const item of cart) {
    const itemSubtotal = item.appliedPrice * item.quantity - item.discount;
    if (itemSubtotal <= 0) continue;

    const catMultiplierObj = (config?.categoryMultipliers || []).find(cm => cm.category === item.product.category);
    const categoryMult = catMultiplierObj ? catMultiplierObj.multiplier : 1.0;

    const baseItemPoints = Math.floor(itemSubtotal / baseSpendPerPoint);
    const finalItemPoints = Math.floor(baseItemPoints * pointsMultiplier * categoryMult * campaignMultiplier);
    totalPoints += finalItemPoints;
  }

  return totalPoints;
};

/**
 * Legacy single-total points calculation helper
 */
export const calculateEarnedPoints = (saleTotal: number, pointsMultiplier: number = 1.0): number => {
  if (saleTotal <= 0 || pointsMultiplier <= 0) return 0;
  const basePoints = Math.floor(saleTotal / 100);
  return Math.floor(basePoints * pointsMultiplier);
};

/**
 * Converts points to Store Credit (Avoir Client)
 */
export const convertPointsToCredit = (
  points: number,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): { creditAmount: number; ratePerPoint: number } => {
  if (points <= 0) return { creditAmount: 0, ratePerPoint: config?.pointRedemptionRate || 10 };
  const ratePerPoint = config?.pointRedemptionRate || 10;
  const creditAmount = Math.floor(points * ratePerPoint);
  return { creditAmount, ratePerPoint };
};

/**
 * Calculates progress towards the next tier threshold
 */
export const calculateNextTierProgress = (
  totalSpent: number = 0,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
) => {
  const currentTier = calculateCustomerTier(totalSpent, config);
  const thresholds = config?.tierThresholds || DEFAULT_LOYALTY_CONFIG.tierThresholds;

  let nextTierName = '';
  let nextMinSpend = 0;

  if (currentTier.name === 'Bronze') {
    nextTierName = 'Silver';
    nextMinSpend = thresholds.silverMinSpend;
  } else if (currentTier.name === 'Silver') {
    nextTierName = 'Gold';
    nextMinSpend = thresholds.goldMinSpend;
  } else if (currentTier.name === 'Gold') {
    nextTierName = 'Platinum';
    nextMinSpend = thresholds.platinumMinSpend;
  } else if (currentTier.name === 'Platinum') {
    nextTierName = 'VIP Diamond';
    nextMinSpend = thresholds.vipDiamondMinSpend;
  } else {
    return {
      currentTier,
      nextTier: null,
      progressPercent: 100,
      remainingSpend: 0,
    };
  }

  const nextTierObj = LOYALTY_TIERS.find(t => t.name === nextTierName) || LOYALTY_TIERS[1];
  const spendInCurrentTier = Math.max(0, totalSpent - currentTier.minSpend);
  const tierSpan = nextMinSpend - currentTier.minSpend;
  const progressPercent = Math.min(100, Math.max(0, Math.round((spendInCurrentTier / tierSpan) * 100)));
  const remainingSpend = Math.max(0, nextMinSpend - totalSpent);

  return {
    currentTier,
    nextTier: { ...nextTierObj, minSpend: nextMinSpend },
    progressPercent,
    remainingSpend,
  };
};

/**
 * FINANCIAL ACCOUNTING MODEL: Calculates true Net Profit & Margin Impact
 */
export const calculateFinancialProfitImpact = (
  grossSubtotal: number,
  directDiscounts: number,
  storeCreditRedeemed: number,
  costOfGoodsSold: number,
  pointsEarnedOnSale: number,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): FinancialProfitImpact => {
  const netRevenue = Math.max(0, grossSubtotal - directDiscounts - storeCreditRedeemed);
  const grossProfit = Math.max(0, grossSubtotal - directDiscounts - costOfGoodsSold);
  const netProfit = netRevenue - costOfGoodsSold;
  
  const grossProfitMarginPercent = grossSubtotal > 0 ? Number(((grossProfit / grossSubtotal) * 100).toFixed(1)) : 0;
  const netProfitMarginPercent = netRevenue > 0 ? Number(((netProfit / netRevenue) * 100).toFixed(1)) : 0;
  const effectiveDiscountRatePercent = grossSubtotal > 0 
    ? Number((((directDiscounts + storeCreditRedeemed) / grossSubtotal) * 100).toFixed(1)) 
    : 0;

  const pointRate = config?.pointRedemptionRate || 10;
  const pointsEarnedValueDA = pointsEarnedOnSale * pointRate;
  const futureLiabilityDA = pointsEarnedValueDA;

  return {
    grossSubtotal,
    directDiscounts,
    storeCreditRedeemed,
    netRevenue,
    costOfGoodsSold,
    grossProfit,
    netProfit,
    grossProfitMarginPercent,
    netProfitMarginPercent,
    effectiveDiscountRatePercent,
    pointsEarnedValueDA,
    futureLiabilityDA,
  };
};

/**
 * Helper to construct a standardized LoyaltyLedgerEntry
 */
export const createLedgerEntry = (
  customerId: string,
  type: 'earn' | 'redeem' | 'bonus' | 'conversion' | 'adjustment' | 'expired',
  points: number,
  balanceAfter: number,
  description: string,
  referenceId?: string,
  creditDeltaDzd?: number,
  expiresAt?: string | null,
  performedBy?: string
): LoyaltyLedgerEntry => {
  return {
    id: `LEDGER-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    customerId,
    timestamp: new Date().toISOString(),
    type,
    points,
    balanceAfter,
    description,
    referenceId,
    creditDeltaDzd,
    expiresAt,
    performedBy: performedBy || 'Système Caisse',
  };
};

/**
 * 🛡️ COGS MARGIN FLOOR GUARDRAIL (Anti-Bankruptcy Protection)
 * Guarantees that store credit redemptions can never force a transaction below wholesale cost.
 */
export const calculateMaxAllowedCredit = (
  grossTotal: number,
  totalCogs: number,
  customerAvailableCredit: number,
  maxRedemptionPercent: number = 50
): { maxAllowedCredit: number; isCogsConstrained: boolean; profitMarginFloor: number } => {
  const safeGross = Math.max(0, grossTotal);
  const safeCogs = Math.max(0, totalCogs);
  const safeBalance = Math.max(0, customerAvailableCredit);

  // 1. Max standard cap based on percentage (e.g. 50% of basket)
  const percentCap = Math.floor(safeGross * (maxRedemptionPercent / 100));

  // 2. Max allowable credit before piercing below wholesale COGS
  const profitMarginFloor = Math.max(0, safeGross - safeCogs);

  // 3. Absolute ceiling is the most restrictive of Balance, Percent Cap, and COGS Floor
  const maxAllowedCredit = Math.min(safeBalance, percentCap, profitMarginFloor);
  const isCogsConstrained = maxAllowedCredit === profitMarginFloor && profitMarginFloor < safeBalance;

  return {
    maxAllowedCredit,
    isCogsConstrained,
    profitMarginFloor,
  };
};

/**
 * 🚫 NET-PAID OUT-OF-POCKET ACCRUAL (Anti-Perpetual Inflation)
 * Awards points strictly on the net cash paid, weighted by category margins and tier multiplier.
 */
export const calculateNetPaidEarnedPoints = (
  cart: CartItem[],
  netCashPaid: number,
  grossTotal: number,
  pointsMultiplier: number = 1.0,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): number => {
  if (netCashPaid <= 0 || grossTotal <= 0) return 0;
  const baseSpendPerPoint = config?.baseSpendPerPoint || 100;

  // Proportional net-paid ratio across cart
  const netRatio = Math.min(1.0, netCashPaid / grossTotal);

  let totalPoints = 0;
  for (const item of cart) {
    const itemGross = item.appliedPrice * item.quantity - item.discount;
    if (itemGross <= 0) continue;

    // Allocate proportional net cash to this line item
    const itemNetPaid = itemGross * netRatio;

    // Margin-weighted category multiplier
    const catMultiplierObj = (config?.categoryMultipliers || []).find(
      (cm) => cm.category === item.product.category
    );
    const categoryMult = catMultiplierObj ? catMultiplierObj.multiplier : 1.0;

    const baseItemPoints = Math.floor(itemNetPaid / baseSpendPerPoint);
    const finalItemPoints = Math.floor(baseItemPoints * pointsMultiplier * categoryMult);
    totalPoints += finalItemPoints;
  }

  return Math.max(1, totalPoints);
};

/**
 * ⏳ FIFO POINT BUCKET DEPLETION ENGINE
 * Consumes the oldest expiring points first during credit redemptions.
 */
export const depleteFifoPointBuckets = (
  buckets: import('../types/pos').LoyaltyPointBucket[],
  pointsToRedeem: number
): {
  updatedBuckets: import('../types/pos').LoyaltyPointBucket[];
  consumedPoints: number;
  remainingPointsToRedeem: number;
} => {
  if (!buckets || buckets.length === 0 || pointsToRedeem <= 0) {
    return { updatedBuckets: buckets || [], consumedPoints: 0, remainingPointsToRedeem: pointsToRedeem };
  }

  // Sort: Expiring soonest first, unexpiring (null) last
  const sorted = [...buckets].sort((a, b) => {
    if (!a.expiresAt && !b.expiresAt) return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (!a.expiresAt) return 1;
    if (!b.expiresAt) return -1;
    return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
  });

  let needed = pointsToRedeem;
  let totalConsumed = 0;

  const updated = sorted.map((b) => {
    if (b.isFullyConsumed || b.remainingPoints <= 0 || needed <= 0) {
      return b;
    }
    const deduct = Math.min(b.remainingPoints, needed);
    needed -= deduct;
    totalConsumed += deduct;
    const remaining = b.remainingPoints - deduct;
    return {
      ...b,
      remainingPoints: remaining,
      isFullyConsumed: remaining === 0,
    };
  });

  return {
    updatedBuckets: updated,
    consumedPoints: totalConsumed,
    remainingPointsToRedeem: needed,
  };
};

/**
 * 📅 CREATE DATED FIFO POINT BUCKET
 */
export const createDatedPointBucket = (
  customerId: string,
  originTransactionId: string,
  pointsEarned: number,
  earnedOnNetSpendDzd: number,
  tier: import('../types/pos').LoyaltyTierName = 'Bronze',
  pointRate: number = 10
): import('../types/pos').LoyaltyPointBucket => {
  let daysValid: number | null = 180;
  if (tier === 'Gold') daysValid = 365;
  if (tier === 'Platinum' || tier === 'VIP Diamond') daysValid = null; // VIP Lifetime Exemption

  const expiresAt = daysValid
    ? new Date(Date.now() + daysValid * 24 * 3600 * 1000).toISOString()
    : null;

  return {
    id: `BUCKET-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    customerId,
    originTransactionId,
    initialPoints: pointsEarned,
    remainingPoints: pointsEarned,
    creditValueDzd: pointsEarned * pointRate,
    earnedOnNetSpendDzd,
    expiresAt,
    isFullyConsumed: false,
    createdAt: new Date().toISOString(),
  };
};

/**
 * Evaluates and auto-upgrades customer object with latest tier and spent calculations
 */
export const syncCustomerLoyaltyState = (
  customer: Customer,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): Customer => {
  const totalSpent = customer.totalSpent || 0;
  const tierInfo = calculateCustomerTier(totalSpent, config);
  return {
    ...customer,
    loyaltyTier: tierInfo.name,
    totalSpent,
    ledger: customer.ledger || [],
    pointBuckets: customer.pointBuckets || [],
  };
};
