import type { Customer, LoyaltyLedgerEntry, LoyaltyTierInfo, LoyaltyTierDef, LoyaltyProgramConfig, SpendMilestone, MilestoneAward, FinancialProfitImpact, CartItem, SaleTransaction, RefundItem, LoyaltyPointBucket, PromoCampaignRule } from '../types/pos';
import { newId } from './ids';

// ══════════════════════════════════════════════════════════════
// DEFAULT GRANULAR LOYALTY PROGRAM CONFIGURATION
// ══════════════════════════════════════════════════════════════

const DEFAULT_CAMPAIGN_ID = 'CAMP-WEEKEND-DOUBLE';
const DEFAULT_CAMPAIGN_DURATION_MS = 7 * 24 * 3600 * 1000;

/**
 * Builds the stock weekend campaign with a NOW-anchored window.
 * Call at USE time (first config access), never at module import: an
 * import-time `new Date()` froze the start to process boot, so long-running
 * tills served a stale — eventually expired — window all week.
 */
export function createDefaultWeekendCampaign(now: number = Date.now()): PromoCampaignRule {
  return {
    id: DEFAULT_CAMPAIGN_ID,
    name: 'Campagne Offre Spéciale Week-end 2x Points',
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + DEFAULT_CAMPAIGN_DURATION_MS).toISOString(),
    multiplier: 2.0,
    active: true,
  };
}

// Lazy cache: the default window anchors on FIRST access, not on import.
let cachedDefaultCampaigns: PromoCampaignRule[] | null = null;

/** Default campaigns, initialized on first access (lazy startDate). */
export function getDefaultActiveCampaigns(): PromoCampaignRule[] {
  if (!cachedDefaultCampaigns) {
    cachedDefaultCampaigns = [createDefaultWeekendCampaign()];
  }
  return cachedDefaultCampaigns;
}

/**
 * Campaign gate: the `active` flag AND the [startDate, endDate] window must
 * both admit `now`. Missing/unparseable bounds are treated as open (legacy
 * campaigns without dates keep working); a closed window always excludes.
 */
export function isCampaignActiveNow(
  campaign: PromoCampaignRule,
  now: number = Date.now()
): boolean {
  if (!campaign || campaign.active !== true) return false;
  if (campaign.startDate) {
    const start = new Date(campaign.startDate).getTime();
    if (Number.isFinite(start) && now < start) return false;
  }
  if (campaign.endDate) {
    const end = new Date(campaign.endDate).getTime();
    if (Number.isFinite(end) && now > end) return false;
  }
  return true;
}

export const DEFAULT_LOYALTY_CONFIG: LoyaltyProgramConfig = {
  enabled: true,
  disabledMode: 'freeze-all',
  pointsEnabled: true,
  tierMultipliersEnabled: true,
  baseSpendPerPoint: 100, // 100 DA spent = 1 base point
  pointRedemptionRate: 10, // 1 Point = 10 DA store credit
  minimumRedemptionPoints: 50, // Minimum 50 points needed to redeem
  maximumRedemptionPercentPerSale: 50, // Max 50% of basket can be paid via points/credit
  // Dynamic tier table — byte-identical economics to the legacy fixed 5 tiers.
  tiers: [
    { id: 'tier-0', name: 'Bronze', minSpend: 0, multiplier: 1.0, expiryDays: 180,
      style: { badgeColor: 'text-amber-600', bgColor: 'bg-amber-600/15', borderColor: 'border-amber-600/30', icon: '🥉' } },
    { id: 'tier-1', name: 'Silver', minSpend: 50000, multiplier: 1.25, expiryDays: 180,
      style: { badgeColor: 'text-slate-300', bgColor: 'bg-slate-300/15', borderColor: 'border-slate-300/30', icon: '🥈' } },
    { id: 'tier-2', name: 'Gold', minSpend: 150000, multiplier: 1.5, expiryDays: 365,
      style: { badgeColor: 'text-amber-400', bgColor: 'bg-amber-500/15', borderColor: 'border-amber-500/30', icon: '🥇' } },
    { id: 'tier-3', name: 'Platinum', minSpend: 300000, multiplier: 2.0, expiryDays: null,
      style: { badgeColor: 'text-cyan-400', bgColor: 'bg-cyan-500/15', borderColor: 'border-cyan-500/30', icon: '💎' } },
    { id: 'tier-4', name: 'VIP Diamond', minSpend: 600000, multiplier: 2.5, expiryDays: null,
      style: { badgeColor: 'text-purple-400', bgColor: 'bg-purple-500/15', borderColor: 'border-purple-500/30', icon: '👑' } },
  ],
  // Legacy 20k → 1k repeatable milestone, preserved as the default.
  spendMilestones: [
    { id: 'ms-20k', threshold: 20000, reward: 1000, repeatable: true },
  ],
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
  // Lazy: evaluated via getDefaultActiveCampaigns() on first ACCESS, not at
  // module import. The setter keeps plain assignment (`cfg.activeCampaigns =
  // [...]`) working for persisted-config hydration.
  get activeCampaigns(): PromoCampaignRule[] {
    return getDefaultActiveCampaigns();
  },
  set activeCampaigns(next: PromoCampaignRule[]) {
    cachedDefaultCampaigns = next;
  },
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
// CONFIG NORMALIZATION & SAFE DEFAULTS
// Sanitizes receiptSettings.loyaltyConfig on every read. Stored rows may
// be absent (fresh install), legacy (pre-tier-table), or merchant-edited
// (unsorted, Tier 0 deleted, invalid numbers) — the engine never trusts
// the raw shape. Invariants: Tier 0 (id tier-0, minSpend 0) always exists
// and is first; tiers ascend by minSpend; thresholds > 0; rewards >= 0.
// ══════════════════════════════════════════════════════════════

const DEFAULT_TIER_STYLE = { badgeColor: '', bgColor: '', borderColor: '', icon: '⭐' };

const sanitizeTierDef = (raw: unknown, index: number): LoyaltyTierDef | null => {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<LoyaltyTierDef>;
  const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `tier-${index}`;
  const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim() : `Palier ${index + 1}`;
  const minSpend = Number(t.minSpend);
  const multiplier = Number(t.multiplier);
  if (!Number.isFinite(minSpend) || minSpend < 0) return null;
  // Only Tier 0 may sit at the zero floor — impostor zero-floor tiers would
  // shadow it and break the identity pin below.
  if (id !== 'tier-0' && minSpend <= 0) return null;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return null;
  const style = (t.style && typeof t.style === 'object' ? t.style : {}) as LoyaltyTierDef['style'];
  const expiryDays =
    t.expiryDays === null || t.expiryDays === undefined
      ? undefined
      : Number.isFinite(Number(t.expiryDays)) && Number(t.expiryDays) >= 0
        ? Number(t.expiryDays)
        : undefined;
  return {
    id,
    name,
    minSpend: Math.floor(minSpend),
    multiplier,
    style: {
      badgeColor: typeof style.badgeColor === 'string' ? style.badgeColor : DEFAULT_TIER_STYLE.badgeColor,
      bgColor: typeof style.bgColor === 'string' ? style.bgColor : DEFAULT_TIER_STYLE.bgColor,
      borderColor: typeof style.borderColor === 'string' ? style.borderColor : DEFAULT_TIER_STYLE.borderColor,
      icon: typeof style.icon === 'string' && style.icon ? style.icon : DEFAULT_TIER_STYLE.icon,
    },
    ...(expiryDays === undefined ? {} : { expiryDays }),
  };
};

/** Maps legacy fixed 5-tier thresholds/multipliers onto the dynamic table. */
const legacyThresholdsToTiers = (raw: unknown): LoyaltyTierDef[] | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<LoyaltyProgramConfig>;
  const th = r.tierThresholds;
  const mu = r.tierMultipliers;
  if (!th || !mu) return null;
  const nums = [th.silverMinSpend, th.goldMinSpend, th.platinumMinSpend, th.vipDiamondMinSpend,
    mu.bronze, mu.silver, mu.gold, mu.platinum, mu.vipDiamond].map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const base = DEFAULT_LOYALTY_CONFIG.tiers;
  return [
    { ...base[0] },
    { ...base[1], minSpend: Math.floor(nums[0]), multiplier: nums[4 + 1] },
    { ...base[2], minSpend: Math.floor(nums[1]), multiplier: nums[4 + 2] },
    { ...base[3], minSpend: Math.floor(nums[2]), multiplier: nums[4 + 3] },
    { ...base[4], minSpend: Math.floor(nums[3]), multiplier: nums[4 + 4] },
  ];
};

const sanitizeMilestone = (raw: unknown): SpendMilestone | null => {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<SpendMilestone>;
  if (typeof m.id !== 'string' || !m.id.trim()) return null;
  const threshold = Number(m.threshold);
  const reward = Number(m.reward);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  if (!Number.isFinite(reward) || reward < 0) return null;
  return { id: m.id.trim(), threshold: Math.floor(threshold), reward: Math.floor(reward), repeatable: m.repeatable !== false };
};

const numOr = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const normalizeLoyaltyConfig = (raw: unknown): LoyaltyProgramConfig => {
  const base = DEFAULT_LOYALTY_CONFIG;
  if (!raw || typeof raw !== 'object') {
    return { ...base, tiers: base.tiers.map((t) => ({ ...t })), spendMilestones: base.spendMilestones.map((m) => ({ ...m })) };
  }
  const r = raw as Partial<LoyaltyProgramConfig>;

  let tiers: LoyaltyTierDef[];
  if (Array.isArray(r.tiers)) {
    const seen = new Set<string>();
    tiers = [];
    r.tiers.forEach((t, i) => {
      const clean = sanitizeTierDef(t, i);
      if (!clean || seen.has(clean.id)) return;
      seen.add(clean.id);
      tiers.push(clean);
    });
    tiers.sort((a, b) => a.minSpend - b.minSpend);
    // Identity pin (not positional): tier-0 is always first. Sort alone
    // cannot guarantee that once merchant tiers share the zero floor —
    // sanitizeTierDef above already rejects those, this is belt-and-braces.
    if (tiers.length === 0 || tiers[0].id !== 'tier-0') {
      tiers = [{ ...base.tiers[0] }, ...tiers.filter((t) => t.id !== 'tier-0')];
      tiers.sort((a, b) => a.minSpend - b.minSpend);
    }
  } else {
    tiers = legacyThresholdsToTiers(r) || base.tiers.map((t) => ({ ...t }));
  }

  let spendMilestones: SpendMilestone[];
  if (Array.isArray(r.spendMilestones)) {
    const seen = new Set<string>();
    spendMilestones = [];
    for (const m of r.spendMilestones) {
      const clean = sanitizeMilestone(m);
      if (!clean || seen.has(clean.id)) continue;
      seen.add(clean.id);
      spendMilestones.push(clean);
    }
  } else {
    spendMilestones = base.spendMilestones.map((m) => ({ ...m }));
  }

  const pct = numOr(r.maximumRedemptionPercentPerSale, base.maximumRedemptionPercentPerSale);
  return {
    enabled: r.enabled !== false,
    disabledMode: r.disabledMode === 'earn-off-redeem-on' ? 'earn-off-redeem-on' : 'freeze-all',
    pointsEnabled: r.pointsEnabled ?? true,
    tierMultipliersEnabled: r.tierMultipliersEnabled ?? true,
    baseSpendPerPoint: numOr(r.baseSpendPerPoint, base.baseSpendPerPoint) > 0
      ? numOr(r.baseSpendPerPoint, base.baseSpendPerPoint) : base.baseSpendPerPoint,
    pointRedemptionRate: numOr(r.pointRedemptionRate, base.pointRedemptionRate) > 0
      ? numOr(r.pointRedemptionRate, base.pointRedemptionRate) : base.pointRedemptionRate,
    minimumRedemptionPoints: Math.max(0, Math.floor(numOr(r.minimumRedemptionPoints, base.minimumRedemptionPoints))),
    maximumRedemptionPercentPerSale: Math.min(100, Math.max(0, pct)),
    tiers,
    spendMilestones,
    tierThresholds: (r.tierThresholds && typeof r.tierThresholds === 'object' ? r.tierThresholds : base.tierThresholds),
    tierMultipliers: (r.tierMultipliers && typeof r.tierMultipliers === 'object' ? r.tierMultipliers : base.tierMultipliers),
    categoryMultipliers: Array.isArray(r.categoryMultipliers) ? r.categoryMultipliers : base.categoryMultipliers,
    activeCampaigns: Array.isArray(r.activeCampaigns) ? r.activeCampaigns : base.activeCampaigns,
    enableCardBarcodeScanning: r.enableCardBarcodeScanning !== false,
    cardPrefix: typeof r.cardPrefix === 'string' && r.cardPrefix ? r.cardPrefix : base.cardPrefix,
  };
};

// ══════════════════════════════════════════════════════════════
// MASTER-SWITCH GATES
// ══════════════════════════════════════════════════════════════

/** Earn (points, milestones, spend progression) is allowed only when enabled. */
export const isEarnAllowed = (config?: LoyaltyProgramConfig | null): boolean =>
  normalizeLoyaltyConfig(config ?? undefined).enabled === true;

/** Redemption stays available under earn-off-redeem-on; frozen otherwise. */
export const isRedeemAllowed = (config?: LoyaltyProgramConfig | null): boolean => {
  const cfg = normalizeLoyaltyConfig(config ?? undefined);
  if (cfg.enabled) return true;
  return cfg.disabledMode === 'earn-off-redeem-on';
};

// ══════════════════════════════════════════════════════════════
// LOYALTY ENGINE CORE FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Resolves the loyalty tier info by walking the normalized dynamic tier
 * table (ascending minSpend). customer.loyaltyTier is a display cache —
 * every caller must resolve through here from totalSpent.
 */
export const calculateCustomerTier = (
  totalSpent: number = 0,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): LoyaltyTierInfo => {
  const tiers = normalizeLoyaltyConfig(config).tiers;
  const safeSpend = Math.max(0, Number.isFinite(Number(totalSpent)) ? Number(totalSpent) : 0);
  let current = tiers[0];
  for (const t of tiers) {
    if (safeSpend >= t.minSpend) current = t;
    else break;
  }
  return {
    id: current.id,
    name: current.name,
    minSpend: current.minSpend,
    pointsMultiplier: current.multiplier,
    discountPercent: 0,
    badgeColor: current.style.badgeColor,
    bgColor: current.style.bgColor,
    borderColor: current.style.borderColor,
    icon: current.style.icon,
    expiryDays: current.expiryDays ?? null,
  };
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
  // Granular kill-switch: points off earns nothing (milestones are separate).
  if (config?.pointsEnabled === false) return 0;
  // Granular multiplier switch: tier factor flattens to 1.0x; campaigns still apply.
  const effectiveTierMult = config?.tierMultipliersEnabled === false ? 1.0 : pointsMultiplier;
  const baseSpendPerPoint = config?.baseSpendPerPoint || 100;
  
  // Active campaign multiplier: flag AND live [startDate, endDate] window.
  // An expired (or not-yet-started) campaign with active=true no longer
  // inflates points — previously the window was never consulted. Shared
  // with calculateNetPaidEarnedPoints so earn and reversal agree.
  const now = Date.now();
  const campaignMultiplier = activeCampaignMultiplier(config, now);

  if (!cart || cart.length === 0) {
    const base = Math.floor(total / baseSpendPerPoint);
    return Math.floor(base * effectiveTierMult * campaignMultiplier);
  }

  let totalPoints = 0;
  for (const item of cart) {
    const itemSubtotal = item.appliedPrice * item.quantity - item.discount;
    if (itemSubtotal <= 0) continue;

    const catMultiplierObj = (config?.categoryMultipliers || []).find(cm => cm.category === item.product.category);
    const categoryMult = catMultiplierObj ? catMultiplierObj.multiplier : 1.0;

    const baseItemPoints = Math.floor(itemSubtotal / baseSpendPerPoint);
    const finalItemPoints = Math.floor(baseItemPoints * effectiveTierMult * categoryMult * campaignMultiplier);
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
  const tiers = normalizeLoyaltyConfig(config).tiers;
  const safeSpend = Math.max(0, Number.isFinite(Number(totalSpent)) ? Number(totalSpent) : 0);
  const currentTier = calculateCustomerTier(safeSpend, config);

  let currentIdx = 0;
  tiers.forEach((t, i) => {
    if (safeSpend >= t.minSpend) currentIdx = i;
  });
  const nextDef = tiers[currentIdx + 1] ?? null;
  if (!nextDef) {
    return { currentTier, nextTier: null, progressPercent: 100, remainingSpend: 0 };
  }

  const spendInCurrentTier = Math.max(0, safeSpend - currentTier.minSpend);
  const tierSpan = nextDef.minSpend - currentTier.minSpend;
  const progressPercent =
    tierSpan <= 0 ? 100 : Math.min(100, Math.max(0, Math.round((spendInCurrentTier / tierSpan) * 100)));
  const remainingSpend = Math.max(0, nextDef.minSpend - safeSpend);

  return {
    currentTier,
    nextTier: {
      name: nextDef.name,
      minSpend: nextDef.minSpend,
      pointsMultiplier: nextDef.multiplier,
      discountPercent: 0,
      badgeColor: nextDef.style.badgeColor,
      bgColor: nextDef.style.bgColor,
      borderColor: nextDef.style.borderColor,
      icon: nextDef.style.icon,
    } as LoyaltyTierInfo,
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
  type: 'earn' | 'redeem' | 'bonus' | 'conversion' | 'adjustment' | 'expired' | 'milestone',
  points: number,
  balanceAfter: number,
  description: string,
  referenceId?: string,
  creditDeltaDzd?: number,
  expiresAt?: string | null,
  performedBy?: string
): LoyaltyLedgerEntry => {
  return {
     // Collision-safe: ledger rows are upserted, so a duplicate id silently
     // overwrites a prior entry and a points movement disappears (C6).
     id: newId('LEDGER'),
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
export const activeCampaignMultiplier = (
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG,
  now: number = Date.now()
): number =>
  (config?.activeCampaigns || [])
    .filter((c) => isCampaignActiveNow(c, now))
    .reduce((max, c) => Math.max(max, c.multiplier), 1.0);

export const calculateNetPaidEarnedPoints = (
  cart: CartItem[],
  netCashPaid: number,
  grossTotal: number,
  pointsMultiplier: number = 1.0,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG,
  campaignMultiplier?: number
): number => {
  if (netCashPaid <= 0 || grossTotal <= 0) return 0;
  // Granular kill-switch: points off earns nothing (milestones are separate).
  if (config?.pointsEnabled === false) return 0;
  // Granular multiplier switch: tier factor flattens to 1.0x; the campaign
  // factor below still applies.
  const effectiveTierMult = config?.tierMultipliersEnabled === false ? 1.0 : pointsMultiplier;
  const baseSpendPerPoint = config?.baseSpendPerPoint || 100;

  // Campaign symmetry: same active-window multiplier as
  // calculateEarnedPointsForCart. Callers reversing points (void/refund)
  // pass the AT-SALE multiplier persisted on the transaction so a void
  // after the campaign ends still deducts what was earned; absent (legacy
  // rows) falls back to currently-active campaigns.
  const campaignMult = campaignMultiplier ?? activeCampaignMultiplier(config);

  // Proportional net-paid ratio across cart
  const netRatio = Math.min(1.0, netCashPaid / grossTotal);

  let totalPoints = 0;
  for (const item of cart) {
    const itemGross = item.appliedPrice * item.quantity - item.discount;
    // B-032: `<= 0` is false for NaN — use !(> 0) so NaN never enters the bucket.
    if (!(itemGross > 0)) continue;

    // Allocate proportional net cash to this line item
    const itemNetPaid = itemGross * netRatio;

    // Margin-weighted category multiplier
    const catMultiplierObj = (config?.categoryMultipliers || []).find(
      (cm) => cm.category === item.product.category
    );
    const categoryMult = catMultiplierObj ? catMultiplierObj.multiplier : 1.0;

    const baseItemPoints = Math.floor(itemNetPaid / baseSpendPerPoint);
    const finalItemPoints = Math.floor(baseItemPoints * effectiveTierMult * categoryMult * campaignMult);
    totalPoints += finalItemPoints;
  }

  // No floor: zero/negative net-paid earns exactly zero. A Math.max(1, …) floor
  // here mints points from nothing (e.g. fully-credit sales) and breaks the
  // earn/reversal symmetry (void could never deduct a point that was minted).
  return totalPoints;
};

/**
 * ⏳ FIFO POINT BUCKET DEPLETION ENGINE
 * Consumes the oldest expiring points first during credit redemptions.
 */
export const depleteFifoPointBuckets = (
  buckets: LoyaltyPointBucket[],
  pointsToRedeem: number
): {
  updatedBuckets: LoyaltyPointBucket[];
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
  tier: string = 'Bronze',
  pointRate: number = 10,
  expiryDays?: number | null
): LoyaltyPointBucket => {
  // Per-tier lifetime when provided; otherwise the legacy name mapping
  // (Gold 365d, Platinum+ lifetime, everything else 180d).
  let daysValid: number | null;
  if (expiryDays === undefined) {
    daysValid = 180;
    if (tier === 'Gold') daysValid = 365;
    if (tier === 'Platinum' || tier === 'VIP Diamond') daysValid = null; // VIP Lifetime Exemption
  } else {
    daysValid = expiryDays;
  }

  const expiresAt = daysValid
    ? new Date(Date.now() + daysValid * 24 * 3600 * 1000).toISOString()
    : null;

  return {
    id: newId('BUCKET'),
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

// ══════════════════════════════════════════════════════════════
// REDEMPTION PRE-CHECK (minimum + per-sale percent cap)
// Enforces DEFAULT_LOYALTY_CONFIG.minimumRedemptionPoints and
// maximumRedemptionPercentPerSale (percent of the NET sale, via the
// optional saleTotal param). When saleTotal is absent, only the
// minimum is enforced — the percent cap needs a sale to exist.
// ══════════════════════════════════════════════════════════════

export type RedemptionCheckReason =
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_POINTS'
  | 'BELOW_MINIMUM'
  | 'EXCEEDS_SALE_PERCENT'
  | 'PROGRAM_DISABLED';

export const canRedeemPoints = (
  balance: number,
  requested: number,
  saleTotal?: number,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): { allowed: boolean; reason?: RedemptionCheckReason; maxRedeemablePoints?: number } => {
  // Granular kill-switch: the points system is off (program-level gates in
  // isRedeemAllowed additionally cover freeze-all / earn-off modes).
  if (config?.pointsEnabled === false) return { allowed: false, reason: 'PROGRAM_DISABLED' };
  const safeBalance = Math.max(0, Math.floor(isNaN(balance) ? 0 : balance));
  const want = Math.floor(isNaN(requested) ? 0 : requested);
  if (want <= 0) return { allowed: false, reason: 'INVALID_AMOUNT' };
  if (want > safeBalance) return { allowed: false, reason: 'INSUFFICIENT_POINTS' };
  const minimum = Math.max(
    1,
    Math.floor(config?.minimumRedemptionPoints ?? DEFAULT_LOYALTY_CONFIG.minimumRedemptionPoints)
  );
  if (want < minimum) {
    return { allowed: false, reason: 'BELOW_MINIMUM', maxRedeemablePoints: safeBalance };
  }
  if (saleTotal !== undefined && saleTotal !== null) {
    const netSale = Math.max(0, Math.floor(saleTotal));
    const pct = config?.maximumRedemptionPercentPerSale ?? DEFAULT_LOYALTY_CONFIG.maximumRedemptionPercentPerSale;
    const rate = config?.pointRedemptionRate || 10;
    const maxCreditDzd = Math.floor((netSale * Math.max(0, pct)) / 100);
    const maxPoints = Math.floor(maxCreditDzd / Math.max(1, rate));
    if (want > maxPoints) {
      return {
        allowed: false,
        reason: 'EXCEEDS_SALE_PERCENT',
        maxRedeemablePoints: Math.min(maxPoints, safeBalance),
      };
    }
  }
  return { allowed: true };
};

// ══════════════════════════════════════════════════════════════
// SYMMETRIC EARN REVERSAL (mirrors calculateNetPaidEarnedPoints)
// The sale path earns via calculateNetPaidEarnedPoints(cart,
// remainingToPay, grossSubtotal, tierMultiplier) — net-paid,
// category-weighted. The void/refund paths live in
// createOrderSlice.ts (owned by the checkout agent), so these pure
// helpers reconstruct the SAME inputs from the stored transaction
// and return the symmetric deduction. Adopt them at the
// calculateEarnedPoints(txn.total / refundTotal) call sites.
// ══════════════════════════════════════════════════════════════

/** 'Crédit Client' (debt) portion of a stored transaction. */
export const getTxnCreditDebtAmount = (txn: SaleTransaction): number => {
  const tenders = txn.tenders || [];
  const fromTenders = tenders
    .filter((t) => t.method === 'Crédit Client')
    .reduce((acc, t) => acc + (t.amount || 0), 0);
  if (fromTenders > 0) return fromTenders;
  if (txn.paymentMethod === 'Crédit Client') return txn.total || 0;
  return txn.debtAdded || 0;
};

/** 'Avoir Client' (store-credit redeemed) portion of a stored transaction. */
export const getTxnStoreCreditApplied = (txn: SaleTransaction): number => {
  const tenders = txn.tenders || [];
  const fromTenders = tenders
    .filter((t) => t.method === 'Avoir Client')
    .reduce((acc, t) => acc + (t.amount || 0), 0);
  if (fromTenders > 0) return fromTenders;
  if (txn.paymentMethod === 'Avoir Client') return txn.total || 0;
  return 0;
};

/**
 * Reconstructs the sale-time earn inputs: net cash paid (total minus the
 * credit-debt portion, exactly as remainingToPay at checkout) and the
 * PRE-sale tier multiplier (post-sale totalSpent minus net-paid, re-tiered).
 * Approximation note: if totalSpent was edited after the sale, the
 * multiplier falls back to the re-derived tier — still net-paid weighted,
 * never the legacy gross-total figure.
 */
export const getPreSaleEarnBasis = (
  txn: SaleTransaction,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): { netCashPaid: number; grossTotal: number; pointsMultiplier: number; preSaleSpent: number } => {
  const grossTotal = Math.max(0, txn.subtotal ?? txn.total ?? 0);
  const netCashPaid = Math.max(0, (txn.total || 0) - getTxnCreditDebtAmount(txn));
  const postSpent = txn.customer?.totalSpent ?? 0;
  const preSaleSpent = Math.max(0, postSpent - netCashPaid);
  const pointsMultiplier = calculateCustomerTier(preSaleSpent, config).pointsMultiplier;
  return { netCashPaid, grossTotal, pointsMultiplier, preSaleSpent };
};

/**
 * Symmetric void deduction for a stored SaleTransaction.
 * Checkout agent: replace `calculateEarnedPoints(txn.total, newTier.pointsMultiplier)`
 * in voidTransaction with this.
 */
export const computeVoidDeduction = (
  txn: SaleTransaction,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): { pointsToDeduct: number; pointsMultiplier: number; netCashPaid: number; grossTotal: number } => {
  const items = txn.items || [];
  const { netCashPaid, grossTotal, pointsMultiplier } = getPreSaleEarnBasis(txn, config);
  if (netCashPaid <= 0 || grossTotal <= 0 || items.length === 0) {
    return { pointsToDeduct: 0, pointsMultiplier, netCashPaid, grossTotal };
  }
  return {
    pointsToDeduct: calculateNetPaidEarnedPoints(
      items,
      netCashPaid,
      grossTotal,
      pointsMultiplier,
      config,
      txn.loyaltyCampaignMultiplier
    ),
    pointsMultiplier,
    netCashPaid,
    grossTotal,
  };
};

/**
 * Symmetric partial-refund deduction for refunded lines of a stored sale.
 * The refunded lines are re-weighted with the SAME category multipliers and
 * the SAME net-paid ratio as the original sale, restricted to refunded qty.
 * Checkout agent: replace `calculateEarnedPoints(refundTotal, newTier.pointsMultiplier)`
 * in processRefund with this.
 */
export const computeRefundDeduction = (
  originalTransaction: SaleTransaction,
  refundItems: RefundItem[],
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): { pointsToDeduct: number; pointsMultiplier: number; refundTotal: number } => {
  const refundTotal = (refundItems || []).reduce((acc, i) => acc + (i.totalRefundAmount || 0), 0);
  const { netCashPaid, grossTotal, pointsMultiplier } = getPreSaleEarnBasis(originalTransaction, config);
  if (refundTotal <= 0 || grossTotal <= 0 || netCashPaid <= 0) {
    return { pointsToDeduct: 0, pointsMultiplier, refundTotal: Math.max(0, refundTotal) };
  }
  const cartLines: CartItem[] = [];
  for (const ri of refundItems || []) {
    const orig = (originalTransaction.items || []).find((i) => i.product?.id === ri.productId);
    if (!orig || (orig.quantity || 0) <= 0 || ri.quantity <= 0) continue;
    const ratio = ri.quantity / (orig.quantity || 1);
    cartLines.push({
      ...orig,
      quantity: ri.quantity,
      discount: Math.max(0, (orig.discount || 0) * ratio),
    });
  }
  if (cartLines.length === 0) {
    return { pointsToDeduct: 0, pointsMultiplier, refundTotal };
  }
  const refundGross = cartLines.reduce(
    (acc, l) => acc + l.appliedPrice * l.quantity - (l.discount || 0),
    0
  );
  if (refundGross <= 0) {
    return { pointsToDeduct: 0, pointsMultiplier, refundTotal };
  }
  const refundNetPaid = refundGross * Math.min(1, netCashPaid / grossTotal);
  return {
    pointsToDeduct: calculateNetPaidEarnedPoints(
      cartLines,
      refundNetPaid,
      refundGross,
      pointsMultiplier,
      config,
      originalTransaction.loyaltyCampaignMultiplier
    ),
    pointsMultiplier,
    refundTotal,
  };
};

// ══════════════════════════════════════════════════════════════
// BUCKET + MILESTONE REVERSAL
// Sale grants: FIFO depletion (pointsToRedeem = floor(credit/rate)) +
// an earn bucket (originTransactionId = receiptNumber) + 1000 DA
// milestone credit per 20k-DZD spend step crossed. Void/refund must
// undo all three, not just the headline loyaltyPoints number.
// ══════════════════════════════════════════════════════════════

export const MILESTONE_SPEND_STEP_DZD = 20000;
export const MILESTONE_CREDIT_BONUS_DZD = 1000;
/** issueStoreCredit amounts above this (DZD) require manager-PIN verification. */
export const STORE_CREDIT_PIN_THRESHOLD_DZD = 5000;

/**
 * @deprecated Superseded by computeMilestoneClawback (snapshot-based,
 * per-tranche, config-agnostic). Kept exported for compat; no production
 * callers remain.
 */
export const computeMilestoneRevocation = (
  totalSpentBefore: number,
  totalSpentAfter: number
): { revokedMilestones: number; revokedCreditDzd: number } => {
  const crossed = Math.max(
    0,
    Math.floor(Math.max(0, totalSpentAfter) / MILESTONE_SPEND_STEP_DZD) -
      Math.floor(Math.max(0, totalSpentBefore) / MILESTONE_SPEND_STEP_DZD)
  );
  return { revokedMilestones: crossed, revokedCreditDzd: crossed * MILESTONE_CREDIT_BONUS_DZD };
};

/**
 * Bucket reversal for a voided sale. Drops the earn bucket minted by this
 * sale (originTransactionId = receiptNumber — the sale never happened) and
 * pays back the FIFO depletion its store-credit redemption caused, refilling
 * latest-expiry buckets first (exact inverse of oldest-first depletion),
 * capped at each bucket's initialPoints so later redemptions can't overfill.
 * Checkout agent: call in voidTransaction after computeVoidDeduction.
 */
export const restoreBucketsForVoid = (
  buckets: LoyaltyPointBucket[],
  txn: SaleTransaction,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG
): { updatedBuckets: LoyaltyPointBucket[]; restoredPoints: number; removedBucketIds: string[] } => {
  const removedBucketIds: string[] = [];
  const kept = (buckets || []).filter((b) => {
    if (b.originTransactionId && b.originTransactionId === txn.receiptNumber) {
      removedBucketIds.push(b.id);
      return false;
    }
    return true;
  });
  const rate = config?.pointRedemptionRate || 10;
  let toRestore = Math.floor(getTxnStoreCreditApplied(txn) / Math.max(1, rate));
  const clones = new Map<string, LoyaltyPointBucket>();
  const sorted = [...kept]
    .sort((a, b) => {
      if (!a.expiresAt && !b.expiresAt) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      if (!a.expiresAt) return -1;
      if (!b.expiresAt) return 1;
      return new Date(b.expiresAt).getTime() - new Date(a.expiresAt).getTime();
    })
    .map((b) => {
      const c = { ...b };
      clones.set(c.id, c);
      return c;
    });
  let restoredPoints = 0;
  for (const b of sorted) {
    if (toRestore <= 0) break;
    const room = Math.max(0, (b.initialPoints || 0) - (b.remainingPoints || 0));
    if (room <= 0) continue;
    const add = Math.min(room, toRestore);
    b.remainingPoints = (b.remainingPoints || 0) + add;
    b.isFullyConsumed = false;
    toRestore -= add;
    restoredPoints += add;
  }
  return {
    updatedBuckets: kept.map((b) => clones.get(b.id) || b),
    restoredPoints,
    removedBucketIds,
  };
};

/**
 * Earn-bucket shrink for a partial refund: reduces the remaining points of
 * the bucket minted by the ORIGINAL sale (originTransactionId = original
 * receiptNumber) by the refund's symmetric deduction. Anything not covered
 * (bucket already spent/expired) falls back to the headline adjustment the
 * checkout agent already performs.
 * Checkout agent: call in processRefund after computeRefundDeduction.
 */
export const shrinkEarnBucketForRefund = (
  buckets: LoyaltyPointBucket[],
  originReceiptNumber: string,
  pointsToDeduct: number
): { updatedBuckets: LoyaltyPointBucket[]; appliedDeduction: number; residualHeadlineDeduction: number } => {
  let needed = Math.max(0, Math.floor(pointsToDeduct || 0));
  let appliedDeduction = 0;
  const updatedBuckets = (buckets || []).map((b) => {
    if (needed <= 0) return b;
    if (b.originTransactionId !== originReceiptNumber) return b;
    const cut = Math.min(b.remainingPoints || 0, needed);
    if (cut <= 0) return b;
    needed -= cut;
    appliedDeduction += cut;
    const remainingPoints = (b.remainingPoints || 0) - cut;
    return { ...b, remainingPoints, isFullyConsumed: remainingPoints === 0 };
  });
  return { updatedBuckets, appliedDeduction, residualHeadlineDeduction: needed };
};

// ══════════════════════════════════════════════════════════════
// WRITE-LAYER CLAMPS (integer DZD, non-negative)
// setStoreCreditApplied lives in createCartSlice (checkout-agent
// owned) — it must wrap its input with clampStoreCreditAmount.
// ══════════════════════════════════════════════════════════════

export const clampStoreCreditAmount = (amount: number): number => {
  if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount)) return 0;
  return Math.max(0, Math.floor(amount));
};

// ══════════════════════════════════════════════════════════════
// SPEND MILESTONES — TRANCHE MATH, KEYS, EVALUATION, CLAWBACK
// Config-driven successor of the hardcoded 20k→1k milestone. All
// tranche math funnels through trancheIndex (integer-DZD rounding
// kills IEEE 754 boundary drops like 19999.999999999996 / 20000).
// Dedup is net-grants based (grants − clawbacks): a clawed-back
// tranche has net 0 and legitimately re-qualifies on re-cross —
// revocations can never permanently lock a customer out.
// ══════════════════════════════════════════════════════════════

/**
 * Net eligible spend reversal for a refund.
 *
 * D1 (locked): debt is EXCLUDED from spend progression everywhere — a sale
 * advances totalSpent by (total − debt − avoir), never by gross. Credit
 * sales therefore earn no spend while unpaid, which closes the
 * buy-on-credit → earn-rewards → default gaming vector. Debt payments do
 * not retro-add spend either; the rule is uniform: only net-paid value
 * (cash/card/voucher out-of-pocket, net of store-credit redemption)
 * progresses loyalty.
 *
 * Mirrors that basis on the way out: voucher and store-credit subsidies
 * return to their own lanes (voucher restore, wallet refill), so they must
 * never reduce totalSpent.
 */
export const computeSpendReversal = (
  netRefund: number,
  avoirShare: number,
  voucherShare: number
): number => {
  const n = Math.max(0, Math.round(Number(netRefund) || 0));
  const a = Math.max(0, Math.round(Number(avoirShare) || 0));
  const v = Math.max(0, Math.round(Number(voucherShare) || 0));
  return Math.max(0, n - a - v);
};

/** Tranche index of a cumulative spend for a threshold (both integer-DZD). */
export const trancheIndex = (spent: number, threshold: number): number => {
  const th = Math.round(Number(threshold));
  if (!Number.isFinite(th) || th <= 0) return 0;
  const s = Number(spent);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.floor(Math.round(s) / th);
};

/** Deterministic grant key. One-time milestones omit the tranche segment. */
export const milestoneGrantKey = (
  customerId: string,
  milestoneId: string,
  tranche?: number
): string =>
  tranche === undefined
    ? `${customerId}:milestone:${milestoneId}`
    : `${customerId}:milestone:${milestoneId}:tranche:${tranche}`;

/** Deterministic clawback key — always tranche-qualified + originating txn. */
export const milestoneClawbackKey = (
  customerId: string,
  milestoneId: string,
  tranche: number | undefined,
  txnId: string
): string => `${milestoneGrantKey(customerId, milestoneId, tranche)}:clawback:${txnId}`;

/**
 * Net active grants for a (milestone, tranche): +1 per grant key, −1 per
 * clawback key with the same prefix. Award only when net == 0.
 */
export const netMilestoneGrants = (
  ledger: LoyaltyLedgerEntry[] | undefined,
  customerId: string,
  milestoneId: string,
  tranche?: number
): number => {
  if (!Array.isArray(ledger) || ledger.length === 0) return 0;
  const grantKey = milestoneGrantKey(customerId, milestoneId, tranche);
  let net = 0;
  for (const e of ledger) {
    if (!e || typeof e.referenceId !== 'string') continue;
    if (e.referenceId === grantKey) net += 1;
    else if (e.referenceId.startsWith(`${grantKey}:clawback:`)) net -= 1;
  }
  return net;
};

/**
 * Legacy bridge: pre-upgrade `Bonus Palier 20k` entries carry no
 * deterministic keys. Each legacy entry's `+X DA` parses to
 * floor(X / reward) assumed tranches, always claimed ascending from
 * tranche 1 (the legacy scheme awarded strictly ascending). Scoped to
 * milestones on the legacy 20k step — custom thresholds have no legacy
 * history to bridge.
 */
export const parseLegacyBonusTranches = (
  ledger: LoyaltyLedgerEntry[] | undefined,
  reward: number
): number => {
  if (!Array.isArray(ledger) || !Number.isFinite(Number(reward)) || Number(reward) <= 0) return 0;
  let tranches = 0;
  for (const e of ledger) {
    if (!e || e.type !== 'bonus' || typeof e.description !== 'string') continue;
    const m = e.description.match(/\+([\d\s.,]+)\s*DA/);
    if (!m) continue;
    const amount = parseFloat(m[1].replace(/[\s,]/g, ''));
    if (Number.isFinite(amount) && amount > 0) {
      tranches += Math.floor(amount / Number(reward));
    }
  }
  return Math.max(0, tranches);
};

const isLegacyStep = (threshold: number): boolean =>
  Math.round(Number(threshold)) === MILESTONE_SPEND_STEP_DZD;

export interface MilestoneEvaluation {
  awards: MilestoneAward[];
  totalReward: number;
  entries: LoyaltyLedgerEntry[];
}

const milestoneGrantEntry = (
  customerId: string,
  milestoneId: string,
  threshold: number,
  reward: number,
  tranche: number | undefined,
  pointsBalanceAfter: number
): LoyaltyLedgerEntry => {
  const entry = createLedgerEntry(
    customerId,
    'milestone',
    0,
    pointsBalanceAfter,
    `Palier ${threshold.toLocaleString('fr-DZ')} DZD débloqué (+${reward} DA d'Avoir)` +
      (tranche !== undefined ? ` — Tranche ${tranche}` : ''),
    milestoneGrantKey(customerId, milestoneId, tranche),
    reward
  );
  entry.milestoneThresholdDzd = threshold;
  entry.milestoneRewardDzd = reward;
  return entry;
};

/**
 * Evaluates milestone crossings for a spend movement (prevSpent →
 * newSpent, both on the SAME net-paid basis). Only tranches strictly
 * inside the delta are candidates — past tranches are never
 * retro-awarded. Honors gates, one-time vs repeatable, deterministic
 * dedup, and the legacy bridge.
 */
export const evaluateSpendMilestones = (
  customerId: string,
  prevSpent: number,
  newSpent: number,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG,
  ledger: LoyaltyLedgerEntry[] = [],
  pointsBalanceAfter: number = 0
): MilestoneEvaluation => {
  const cfg = normalizeLoyaltyConfig(config);
  const empty: MilestoneEvaluation = { awards: [], totalReward: 0, entries: [] };
  if (!isEarnAllowed(cfg)) return empty;
  const prev = Math.max(0, Math.floor(Number(prevSpent) || 0));
  const next = Math.max(0, Math.floor(Number(newSpent) || 0));
  if (next <= prev) return empty;

  const awards: MilestoneAward[] = [];
  const entries: LoyaltyLedgerEntry[] = [];
  let totalReward = 0;
  for (const m of cfg.spendMilestones) {
    const fromT = trancheIndex(prev, m.threshold);
    const toT = trancheIndex(next, m.threshold);
    if (toT <= fromT) continue;
    const legacyK = isLegacyStep(m.threshold) ? parseLegacyBonusTranches(ledger, m.reward) : 0;
    if (!m.repeatable) {
      if (fromT >= 1) continue;
      if (netMilestoneGrants(ledger, customerId, m.id) > 0) continue;
      if (legacyK > 0) continue;
      awards.push({ milestoneId: m.id, threshold: m.threshold, rewardAmount: m.reward });
      entries.push(milestoneGrantEntry(customerId, m.id, m.threshold, m.reward, undefined, pointsBalanceAfter));
      totalReward += m.reward;
    } else {
      for (let n = fromT + 1; n <= toT; n++) {
        if (n <= legacyK) continue;
        if (netMilestoneGrants(ledger, customerId, m.id, n) > 0) continue;
        awards.push({ milestoneId: m.id, threshold: m.threshold, rewardAmount: m.reward, tranche: n });
        entries.push(milestoneGrantEntry(customerId, m.id, m.threshold, m.reward, n, pointsBalanceAfter));
        totalReward += m.reward;
      }
    }
  }
  return { awards, totalReward, entries };
};

export interface MilestoneRevocation {
  milestoneId: string;
  tranche?: number;
  threshold: number;
  reward: number;
}

export interface MilestoneClawback {
  revoked: MilestoneRevocation[];
  totalRevoked: number;
  entries: LoyaltyLedgerEntry[];
}

/**
 * Computes milestone clawback for a spend reversal (prevSpent → newSpent,
 * prev > next). Revokes un-crossed tranches as structured per-tranche
 * entries. Amounts come from the transaction's immutable award snapshots
 * first (config edits never change what was granted), then ledger grant
 * snapshots, then live config as last resort. Blind by design: revocation
 * does not check net-grants — a wrongly-revoked tranche re-qualifies on
 * the next crossing evaluation, so errors converge instead of compounding.
 */
export const computeMilestoneClawback = (
  customerId: string,
  prevSpent: number,
  newSpent: number,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG,
  source: { txnId: string; awards?: MilestoneAward[]; ledger?: LoyaltyLedgerEntry[] } = { txnId: '' },
  pointsBalanceAfter: number = 0
): MilestoneClawback => {
  const cfg = normalizeLoyaltyConfig(config);
  const empty: MilestoneClawback = { revoked: [], totalRevoked: 0, entries: [] };
  const prev = Math.max(0, Math.floor(Number(prevSpent) || 0));
  const next = Math.max(0, Math.floor(Number(newSpent) || 0));
  if (next >= prev) return empty;

  // Snapshot priority: txn immutable awards → ledger grant snapshots
  // (milestoneRewardDzd, else positive creditDeltaDzd) → live config.
  // Legacy rows carry no txn snapshots, so without the ledger tier a
  // post-edit void would revoke the WRONG (live) amount.
  const snapshotOf = (
    milestoneId: string,
    tranche: number | undefined,
    liveThreshold: number,
    liveReward: number
  ): { threshold: number; reward: number } => {
    const a = (source.awards || []).find(
      (x) => x && x.milestoneId === milestoneId && (x.tranche ?? undefined) === tranche
    );
    if (a) return { threshold: a.threshold, reward: a.rewardAmount };
    const key = milestoneGrantKey(customerId, milestoneId, tranche);
    const g = (source.ledger || []).find((e) => e && e.referenceId === key);
    if (g) {
      const snapReward = Number(g.milestoneRewardDzd);
      const snapThreshold = Number(g.milestoneThresholdDzd);
      if (Number.isFinite(snapReward) && snapReward > 0) {
        return {
          threshold: Number.isFinite(snapThreshold) && snapThreshold > 0 ? Math.floor(snapThreshold) : liveThreshold,
          reward: Math.floor(snapReward),
        };
      }
      const delta = Number(g.creditDeltaDzd);
      if (Number.isFinite(delta) && delta > 0) {
        return { threshold: liveThreshold, reward: Math.floor(delta) };
      }
    }
    return { threshold: liveThreshold, reward: liveReward };
  };

  const revoked: MilestoneRevocation[] = [];
  const entries: LoyaltyLedgerEntry[] = [];
  let totalRevoked = 0;
  for (const m of cfg.spendMilestones) {
    const fromT = trancheIndex(prev, m.threshold);
    const toT = trancheIndex(next, m.threshold);
    if (toT >= fromT) continue;
    if (!m.repeatable) {
      if (fromT < 1) continue;
      const snap = snapshotOf(m.id, undefined, m.threshold, m.reward);
      const threshold = snap.threshold;
      const reward = snap.reward;
      revoked.push({ milestoneId: m.id, threshold, reward });
      const entry = createLedgerEntry(
        customerId,
        'milestone',
        0,
        pointsBalanceAfter,
        `Révocation palier ${threshold.toLocaleString('fr-DZ')} DZD (−${reward} DA d'Avoir)`,
        milestoneClawbackKey(customerId, m.id, undefined, source.txnId),
        -reward
      );
      entry.milestoneThresholdDzd = threshold;
      entry.milestoneRewardDzd = reward;
      entries.push(entry);
      totalRevoked += reward;
    } else {
      for (let n = fromT; n >= toT + 1; n--) {
        const snap = snapshotOf(m.id, n, m.threshold, m.reward);
        const threshold = snap.threshold;
        const reward = snap.reward;
        revoked.push({ milestoneId: m.id, tranche: n, threshold, reward });
        const entry = createLedgerEntry(
          customerId,
          'milestone',
          0,
          pointsBalanceAfter,
          `Révocation palier ${threshold.toLocaleString('fr-DZ')} DZD (−${reward} DA d'Avoir) — Tranche ${n}`,
          milestoneClawbackKey(customerId, m.id, n, source.txnId),
          -reward
        );
        entry.milestoneThresholdDzd = threshold;
        entry.milestoneRewardDzd = reward;
        entries.push(entry);
        totalRevoked += reward;
      }
    }
  }
  return { revoked, totalRevoked, entries };
};

/**
 * Reconciliation sweeper: awards tranches the spend implies but the
 * ledger lacks (multi-till leaps, offline merges). Only evaluates
 * milestones present in the normalized config — retired IDs are never
 * backfilled. Idempotent via the same net-grants keys as checkout.
 */
export const reconcileMilestoneTranches = (
  customerId: string,
  totalSpent: number,
  config: LoyaltyProgramConfig = DEFAULT_LOYALTY_CONFIG,
  ledger: LoyaltyLedgerEntry[] = [],
  pointsBalanceAfter: number = 0
): MilestoneEvaluation => {
  const cfg = normalizeLoyaltyConfig(config);
  const empty: MilestoneEvaluation = { awards: [], totalReward: 0, entries: [] };
  if (!isEarnAllowed(cfg)) return empty;
  const spent = Math.max(0, Math.floor(Number(totalSpent) || 0));

  const awards: MilestoneAward[] = [];
  const entries: LoyaltyLedgerEntry[] = [];
  let totalReward = 0;
  for (const m of cfg.spendMilestones) {
    const expected = trancheIndex(spent, m.threshold);
    if (expected < 1) continue;
    const legacyK = isLegacyStep(m.threshold) ? parseLegacyBonusTranches(ledger, m.reward) : 0;
    if (!m.repeatable) {
      if (netMilestoneGrants(ledger, customerId, m.id) > 0) continue;
      if (legacyK > 0) continue;
      awards.push({ milestoneId: m.id, threshold: m.threshold, rewardAmount: m.reward });
      entries.push(milestoneGrantEntry(customerId, m.id, m.threshold, m.reward, undefined, pointsBalanceAfter));
      totalReward += m.reward;
    } else {
      for (let n = 1; n <= expected; n++) {
        if (n <= legacyK) continue;
        if (netMilestoneGrants(ledger, customerId, m.id, n) > 0) continue;
        awards.push({ milestoneId: m.id, threshold: m.threshold, rewardAmount: m.reward, tranche: n });
        entries.push(milestoneGrantEntry(customerId, m.id, m.threshold, m.reward, n, pointsBalanceAfter));
        totalReward += m.reward;
      }
    }
  }
  return { awards, totalReward, entries };
};

// ══════════════════════════════════════════════════════════════
// LEDGER-DERIVED CREDIT BALANCE (multi-till convergence)
// The scalar storeCredit is Last-Write-Wins on sync. From the upgrade
// forward, every credit movement carries creditDeltaDzd, so the balance
// derives from converged ledger inputs instead of the scalar. Legacy
// value is frozen once as a genesis entry (deduped by key).
// ══════════════════════════════════════════════════════════════

export const creditGenesisKey = (customerId: string): string => `${customerId}:credit-genesis`;

/** Appends the one-time genesis entry freezing the pre-upgrade scalar balance. */
export const ensureCreditGenesis = (customer: Customer): LoyaltyLedgerEntry | null => {
  const ledger = customer?.ledger || [];
  const key = creditGenesisKey(customer.id);
  if (ledger.some((e) => e && e.referenceId === key)) return null;
  const base = Math.floor(Number(customer.storeCredit) || 0);
  if (base <= 0) return null;
  return createLedgerEntry(
    customer.id,
    'adjustment',
    0,
    Number(customer.loyaltyPoints) || 0,
    `Solde d'Avoir initial reporté (${base} DA)`,
    key,
    base
  );
};

/** Sums credit movements; entries without a delta contribute 0. */
export const deriveStoreCreditFromLedger = (
  ledger: LoyaltyLedgerEntry[] | undefined
): number => {
  if (!Array.isArray(ledger)) return 0;
  let total = 0;
  for (const e of ledger) {
    const d = Number(e?.creditDeltaDzd);
    if (Number.isFinite(d)) total += d;
  }
  return Math.floor(total);
};
