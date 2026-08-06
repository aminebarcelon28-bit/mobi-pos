import type { Product, StockAlert } from '../types/pos';

/**
 * Algorithmic Reorder Alert Engine
 * Evaluates real-time sales velocity (burn rate), lead times, and safety stock.
 */
export const calculateStockAlerts = (products: Product[]): StockAlert[] => {
  const alerts: StockAlert[] = [];

  products.forEach((product) => {
    // Algorithmic minimum threshold: (Velocity * LeadTime) + SafetyStock (3 units)
    const dynamicThreshold = Math.ceil(
      (product.dailySalesVelocity || 1.5) * (product.leadTimeDays || 7) + 3
    );
    const reorderPoint = product.reorderPoint || dynamicThreshold;

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
        dailyVelocity: product.dailySalesVelocity || 1.5,
        severity: product.stock <= 5 ? 'critical' : 'warning',
      });
    }
  });

  return alerts.sort((a, b) => {
    if (a.severity === 'critical' && b.severity !== 'critical') return -1;
    if (a.severity !== 'critical' && b.severity === 'critical') return 1;
    return a.currentStock - b.currentStock;
  });
};
