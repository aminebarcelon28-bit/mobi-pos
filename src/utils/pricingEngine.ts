/**
 * Centralized Pricing & Financial Calculation Engine
 * Single Source of Truth for retail/wholesale pricing, cost fallbacks, and profit margins.
 * Adheres strictly to DEVELOPMENT_STANDARDS.md §1.4 (DRY) and §1.5.
 */

import type { Product, PricingTier } from '../types/pos';

export const DEFAULT_WHOLESALE_DISCOUNT_RATIO = 0.75;
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
 * Calculates effective product selling price according to customer pricing tier.
 */
export function getProductPriceForTier(
  product: Pick<Product, 'price'> & Partial<Pick<Product, 'wholesalePrice'>>,
  pricingTier?: PricingTier
): number {
  if (pricingTier === 'Wholesale') {
    return getWholesalePrice(product);
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
