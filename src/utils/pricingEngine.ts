/**
 * Centralized Pricing & Financial Calculation Engine
 * Single Source of Truth for retail/wholesale pricing, cost fallbacks, and profit margins.
 * Adheres strictly to DEVELOPMENT_STANDARDS.md §1.4 (DRY) and §1.5.
 */

import type { Product, PricingTier, VolumeDiscountTier, ActivePriceBookItem } from '../types/pos';

export const DEFAULT_WHOLESALE_DISCOUNT_RATIO = 0.75;
export const DEFAULT_SEMI_WHOLESALE_DISCOUNT_RATIO = 0.88;
export const DEFAULT_COST_PRICE_RATIO = 0.5;

/**
 * Calculates effective wholesale price for a product.
 * Returns product.wholesalePrice if set (> 0), otherwise falls back to Math.round(product.price * 0.75).
 */
export function getWholesalePrice(
  product: Pick<Product, 'price'> & Partial<Pick<Product, 'wholesalePrice'>>
): number {
  if (typeof product.wholesalePrice === 'number' && product.wholesalePrice > 0) {
    return product.wholesalePrice;
  }
  return Math.round((product.price || 0) * DEFAULT_WHOLESALE_DISCOUNT_RATIO);
}

/**
 * Calculates effective semi-wholesale (demi-gros) price for a product.
 * Returns product.semiWholesalePrice if set (> 0).
 * Otherwise falls back to the midpoint between retail and wholesale price,
 * or Math.round(product.price * 0.88).
 */
export function getSemiWholesalePrice(
  product: Pick<Product, 'price'> & Partial<Pick<Product, 'wholesalePrice' | 'semiWholesalePrice'>>
): number {
  if (typeof product.semiWholesalePrice === 'number' && product.semiWholesalePrice > 0) {
    return product.semiWholesalePrice;
  }
  const wholesale = typeof product.wholesalePrice === 'number' && product.wholesalePrice > 0
    ? product.wholesalePrice
    : Math.round((product.price || 0) * DEFAULT_WHOLESALE_DISCOUNT_RATIO);

  if ((product.price || 0) > wholesale) {
    return Math.round(((product.price || 0) + wholesale) / 2);
  }
  return Math.round((product.price || 0) * DEFAULT_SEMI_WHOLESALE_DISCOUNT_RATIO);
}

/**
 * Calculates effective product selling price according to customer pricing tier.
 */
export function getProductPriceForTier(
  product: Pick<Product, 'price'> & Partial<Pick<Product, 'wholesalePrice' | 'semiWholesalePrice'>>,
  pricingTier?: PricingTier
): number {
  if (pricingTier === 'Wholesale') {
    return getWholesalePrice(product);
  }
  if (pricingTier === 'VIP') {
    return getSemiWholesalePrice(product);
  }
  return product.price || 0;
}

/**
 * Returns effective unit cost price for a product, falling back to standard retail cost ratio when unknown.
 */
export function getEffectiveCostPrice(
  product: Pick<Product, 'price'> & Partial<Pick<Product, 'costPrice'>>,
  fallbackRatio: number = DEFAULT_COST_PRICE_RATIO
): number {
  if (typeof product.costPrice === 'number' && product.costPrice > 0) {
    return product.costPrice;
  }
  return Math.round((product.price || 0) * fallbackRatio);
}

/**
 * Calculates gross margin amount and percentage with zero-division guard.
 */
export function calculateProfit(
  total: number,
  costTotal: number
): { profit: number; profitMargin: number } {
  const profit = total - costTotal;
  const profitMargin = total > 0 ? Number(((profit / total) * 100).toFixed(1)) : 0;
  return { profit, profitMargin };
}

/**
 * Evaluates available volume tiers for a given quantity.
 * Returns the qualifying tier with the highest minimum quantity.
 */
export function getVolumeDiscountTier(
  product: Pick<Product, 'volumeDiscounts'>,
  quantity: number
): VolumeDiscountTier | undefined {
  if (!product.volumeDiscounts || product.volumeDiscounts.length === 0) {
    return undefined;
  }
  const eligible = product.volumeDiscounts
    .filter(
      (t) =>
        typeof t.minQty === 'number' &&
        t.minQty > 0 &&
        typeof t.price === 'number' &&
        t.price > 0 &&
        quantity >= t.minQty
    )
    .sort((a, b) => b.minQty - a.minQty);

  return eligible[0];
}

/**
 * Calculates effective unit price taking into account pricing tier and volume discounts.
 * When a volume tier is eligible and offers a lower price than the base tier price,
 * returns the volume discount unit price and discount amount.
 */
export function computeEffectiveUnitPrice(
  product: Pick<Product, 'price' | 'id'> & Partial<Pick<Product, 'wholesalePrice' | 'semiWholesalePrice' | 'volumeDiscounts'>>,
  quantity: number,
  pricingTier?: PricingTier,
  customBasePrice?: number,
  priceBookItems?: readonly ActivePriceBookItem[] | null
): { unitPrice: number; isVolumeDiscount: boolean; basePrice: number; discountPerUnit: number; priceSource: 'CUSTOM' | 'CONTRACT' | 'TIER' } {
  // UPGRADE-04: contract price books OUTRANK the tier ladder — a negotiated
  // price is a commitment; volume breaks may still undercut it (favorable to
  // the customer, identical to the tier behavior). `customBasePrice` (manager
  // override) outranks everything, as before.
  const contract =
    customBasePrice === undefined
      ? getPriceBookUnitPrice(priceBookItems, String(product.id ?? ''), quantity)
      : undefined;
  const basePrice =
    customBasePrice !== undefined
      ? customBasePrice
      : contract !== undefined
      ? contract
      : getProductPriceForTier(product, pricingTier);
  const priceSource: 'CUSTOM' | 'CONTRACT' | 'TIER' =
    customBasePrice !== undefined ? 'CUSTOM' : contract !== undefined ? 'CONTRACT' : 'TIER';
  const tier = getVolumeDiscountTier(product, quantity);
  if (tier && tier.price < basePrice) {
    return {
      unitPrice: tier.price,
      isVolumeDiscount: true,
      basePrice,
      discountPerUnit: basePrice - tier.price,
      priceSource,
    };
  }
  return {
    unitPrice: basePrice,
    isVolumeDiscount: false,
    basePrice,
    discountPerUnit: 0,
    priceSource,
  };
}

/**
 * UPGRADE-04 — contract price lookup: the qualifying price-book item for a
 * product at a quantity (highest `minQty` ≤ qty wins). Pure; the items list
 * is pre-resolved per customer by the store (`customerPriceBook`).
 */
export function getPriceBookUnitPrice(
  items: readonly ActivePriceBookItem[] | null | undefined,
  productId: string,
  quantity: number
): number | undefined {
  if (!items || items.length === 0 || !productId) return undefined;
  const qty = Math.max(1, Math.floor(Number(quantity) || 0));
  let best: ActivePriceBookItem | undefined;
  for (const item of items) {
    if (item.productId !== productId) continue;
    if (!Number.isFinite(item.minQty) || item.minQty > qty) continue;
    if (!Number.isFinite(item.unitPrice) || item.unitPrice <= 0) continue;
    if (!best || item.minQty > best.minQty) best = item;
  }
  return best?.unitPrice;
}

/**
 * UPGRADE-04 — the base unit price for a line: contract price book when one
 * applies, tier price otherwise. Display/totals lanes use this so a contract
 * customer never sees a tier fallback price on screen.
 */
export function resolveBaseUnitPrice(
  product: Pick<Product, 'price' | 'id'> & Partial<Pick<Product, 'wholesalePrice' | 'semiWholesalePrice'>>,
  pricingTier?: PricingTier,
  quantity?: number,
  priceBookItems?: readonly ActivePriceBookItem[] | null
): number {
  const contract = getPriceBookUnitPrice(priceBookItems, String(product.id ?? ''), quantity ?? 1);
  if (contract !== undefined) return contract;
  return getProductPriceForTier(product, pricingTier);
}

/**
 * UPGRADE-04 — the next volume tier ABOVE the current quantity (lowest
 * qualifying `minQty` strictly greater than `currentQty`). Undefined when no
 * further tier exists.
 */
export function getNextVolumeTier(
  product: Pick<Product, 'volumeDiscounts'>,
  currentQty: number
): VolumeDiscountTier | undefined {
  const tiers = product.volumeDiscounts;
  if (!tiers || tiers.length === 0) return undefined;
  const qty = Math.max(0, Math.floor(Number(currentQty) || 0));
  const ahead = tiers
    .filter(
      (t) =>
        typeof t.minQty === 'number' &&
        t.minQty > qty &&
        typeof t.price === 'number' &&
        t.price > 0
    )
    .sort((a, b) => a.minQty - b.minQty);
  return ahead[0];
}

/**
 * UPGRADE-04 — volume-break nudge for one cart line: "add N more → Y DA/u".
 * Returns undefined when there is no next tier, or when it would not lower
 * the unit price actually being charged on the line.
 */
export function getVolumeBreakNudge(
  product: Pick<Product, 'volumeDiscounts'>,
  currentQty: number,
  currentUnitPrice: number | undefined
): { minQty: number; missing: number; unitPrice: number; savingsPerUnit: number } | undefined {
  const next = getNextVolumeTier(product, currentQty);
  if (!next) return undefined;
  const current = Math.max(0, Math.round(Number(currentUnitPrice) || 0));
  if (current > 0 && next.price >= current) return undefined;
  const qty = Math.max(0, Math.floor(Number(currentQty) || 0));
  const missing = Math.max(1, Math.ceil(next.minQty - qty));
  return {
    minQty: next.minQty,
    missing,
    unitPrice: next.price,
    savingsPerUnit: current > 0 ? current - next.price : 0,
  };
}

