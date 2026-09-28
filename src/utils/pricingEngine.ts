/**
 * Centralized Pricing & Financial Calculation Engine
 * Single Source of Truth for retail/wholesale pricing, cost fallbacks, and profit margins.
 * Adheres strictly to DEVELOPMENT_STANDARDS.md §1.4 (DRY) and §1.5.
 */

import type { Product, PricingTier, VolumeDiscountTier } from '../types/pos';

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
  product: Pick<Product, 'price'> & Partial<Pick<Product, 'wholesalePrice' | 'semiWholesalePrice' | 'volumeDiscounts'>>,
  quantity: number,
  pricingTier?: PricingTier,
  customBasePrice?: number
): { unitPrice: number; isVolumeDiscount: boolean; basePrice: number; discountPerUnit: number } {
  const basePrice = customBasePrice !== undefined ? customBasePrice : getProductPriceForTier(product, pricingTier);
  const tier = getVolumeDiscountTier(product, quantity);
  if (tier && tier.price < basePrice) {
    return {
      unitPrice: tier.price,
      isVolumeDiscount: true,
      basePrice,
      discountPerUnit: basePrice - tier.price,
    };
  }
  return {
    unitPrice: basePrice,
    isVolumeDiscount: false,
    basePrice,
    discountPerUnit: 0,
  };
}

