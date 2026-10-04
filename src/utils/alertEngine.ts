import type { Product, StockAlert, StockAlertSeverity } from '../types/pos';

export const SAFETY_STOCK_BUFFER = 3;
export const CRITICAL_STOCK_CAP = 5;
const FALLBACK_VELOCITY = 1.5;
const FALLBACK_LEAD_TIME_DAYS = 7;

/**
 * Dynamic JIT reorder threshold: ceil(velocity * leadTime + safety buffer).
 * Single source of truth — replaces scattered `reorderPoint || 5/10` fallbacks.
 */
export const getDynamicThreshold = (
  product: Pick<Product, 'dailySalesVelocity' | 'leadTimeDays' | 'reorderPoint'>,
): number => {
  if (typeof product.reorderPoint === 'number' && product.reorderPoint > 0) {
    return product.reorderPoint;
  }
  const velocity =
    typeof product.dailySalesVelocity === 'number' && product.dailySalesVelocity > 0
      ? product.dailySalesVelocity
      : FALLBACK_VELOCITY;
  const leadTime =
    typeof product.leadTimeDays === 'number' && product.leadTimeDays > 0
      ? product.leadTimeDays
      : FALLBACK_LEAD_TIME_DAYS;
  return Math.ceil(velocity * leadTime + SAFETY_STOCK_BUFFER);
};

/**
 * Strict 3-tier severity:
 * rupture (stock <= 0) > critical (1..5) > warning (<= threshold).
 */
export const getSeverity = (stock: number, reorderPoint: number): StockAlertSeverity => {
  if (stock <= 0) return 'rupture';
  if (stock <= CRITICAL_STOCK_CAP) return 'critical';
  if (stock <= reorderPoint) return 'warning';
  return 'warning';
};

const SEVERITY_RANK: Record<StockAlertSeverity, number> = {
  rupture: 0,
  critical: 1,
  warning: 2,
};

/**
 * Algorithmic Reorder Alert Engine
 * Evaluates real-time sales velocity (burn rate), lead times, and safety stock.
 */
export const calculateStockAlerts = (products: Product[]): StockAlert[] => {
  const alerts: StockAlert[] = [];

  products.forEach((product) => {
    const reorderPoint = getDynamicThreshold(product);

    if (product.stock <= reorderPoint) {
      alerts.push({
        id: `alert-${product.id}`,
        productId: product.id,
        title: product.title,
        sku: product.sku,
        brand: product.brand,
        vendorName: product.vendorName || 'Fournisseur Général',
        currentStock: product.stock,
        reorderPoint,
        dailyVelocity: product.dailySalesVelocity || FALLBACK_VELOCITY,
        severity: getSeverity(product.stock, reorderPoint),
      });
    }
  });

  return alerts.sort((a, b) => {
    const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rank !== 0) return rank;
    return a.currentStock - b.currentStock;
  });
};
