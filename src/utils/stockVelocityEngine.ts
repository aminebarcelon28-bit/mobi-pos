import type { CategoryType } from '../types/pos';
import type { EditableReviewLine } from '../types/po';

export type VelocityTier = 'FAST_RUNNER' | 'STEADY' | 'SLOW_MOVING';

export interface LineVelocityMetrics {
  clientId: string;
  dailyVelocity: number;
  absorptionDays: number;
  tier: VelocityTier;
  capitalCommitted: number;
  recommendedMarkupPct: number;
  suggestedSellingPrice: number;
  projectedProfit: number;
  riskLabel: string;
}

export interface BatchVelocitySummary {
  totalCapitalCommitted: number;
  averageAbsorptionDays: number;
  fastRunnerCount: number;
  steadyCount: number;
  slowMovingCount: number;
  projectedGrossYield: number;
  capitalRiskIndex: 'FAIBLE' | 'MODÉRÉ' | 'ÉLEVÉ';
  lines: Map<string, LineVelocityMetrics>;
}

/**
 * Category-based heuristic baseline daily sales velocity when a product
 * does not have historical sales recorded.
 */
const CATEGORY_DEFAULT_VELOCITY: Record<string, number> = {
  'Chargeurs': 1.2,
  'Câbles': 1.8,
  'Protège-Écran': 2.5,
  'Coques iPhone': 1.0,
  'Coques Samsung': 0.8,
  'Écrans & Pièces': 0.4,
  'Batteries': 0.6,
  'Services': 1.0,
};

/**
 * Computes predictive stock absorption, capital exposure, and category-elastic
 * dynamic pricing suggestions for each received item.
 */
export function calculateBatchVelocity(
  lines: EditableReviewLine[],
  catalogProducts: Array<{
    id: string;
    category?: CategoryType | string;
    dailySalesVelocity?: number;
    price?: number;
    costPrice?: number;
  }>
): BatchVelocitySummary {
  const catalogMap = new Map(catalogProducts.map((p) => [p.id, p]));
  const lineMetricsMap = new Map<string, LineVelocityMetrics>();

  let totalCapital = 0;
  let weightedDaysSum = 0;
  let totalPieces = 0;
  let fastCount = 0;
  let steadyCount = 0;
  let slowCount = 0;
  let totalProjectedProfit = 0;

  lines.forEach((line) => {
    const qty = Math.max(0, line.quantity);
    const cost = Math.max(0, line.unit_cost);
    const capital = Math.round(qty * cost * 100) / 100;
    totalCapital += capital;
    totalPieces += qty;

    const matchedProd = line.selected_product_id ? catalogMap.get(line.selected_product_id) : undefined;
    const cat = (matchedProd?.category as string) || 'Chargeurs';

    // Daily velocity from catalog history or category heuristic
    const rawVelocity = matchedProd?.dailySalesVelocity && matchedProd.dailySalesVelocity > 0
      ? matchedProd.dailySalesVelocity
      : (CATEGORY_DEFAULT_VELOCITY[cat] || 0.75);

    const dailyVelocity = Math.round(rawVelocity * 10) / 10;
    const absorptionDays = dailyVelocity > 0 ? Math.ceil(qty / dailyVelocity) : 45;

    // Velocity Tier & Category-elastic Dynamic Markup
    let tier: VelocityTier = 'STEADY';
    let recommendedMarkupPct = 40;
    let riskLabel = 'Rotation Régulière';

    if (absorptionDays <= 12) {
      tier = 'FAST_RUNNER';
      recommendedMarkupPct = 30; // Competitive aggressive price to clear quickly
      riskLabel = '⚡ Rotation Rapide (< 12 j)';
      fastCount++;
    } else if (absorptionDays <= 35) {
      tier = 'STEADY';
      recommendedMarkupPct = 45; // Balanced standard retail margin
      riskLabel = '🟢 Rotation Optimale (12-35 j)';
      steadyCount++;
    } else {
      tier = 'SLOW_MOVING';
      recommendedMarkupPct = 75; // Higher margin to offset capital lockup
      riskLabel = '⚠️ Capital Immobilisé (> 35 j)';
      slowCount++;
    }

    const suggestedSellingPrice = Math.round(cost * (1 + recommendedMarkupPct / 100));
    const currentSelling = line.selling_price && line.selling_price > 0 ? line.selling_price : suggestedSellingPrice;
    const projectedProfit = Math.round(qty * (currentSelling - cost) * 100) / 100;
    totalProjectedProfit += projectedProfit;

    weightedDaysSum += absorptionDays * qty;

    lineMetricsMap.set(line.client_id, {
      clientId: line.client_id,
      dailyVelocity,
      absorptionDays,
      tier,
      capitalCommitted: capital,
      recommendedMarkupPct,
      suggestedSellingPrice,
      projectedProfit,
      riskLabel,
    });
  });

  const averageAbsorptionDays = totalPieces > 0 ? Math.round(weightedDaysSum / totalPieces) : 0;
  const projectedGrossYield = totalCapital > 0 ? Math.round((totalProjectedProfit / totalCapital) * 1000) / 10 : 0;

  let capitalRiskIndex: 'FAIBLE' | 'MODÉRÉ' | 'ÉLEVÉ' = 'FAIBLE';
  if (averageAbsorptionDays > 45 || slowCount > lines.length / 2) {
    capitalRiskIndex = 'ÉLEVÉ';
  } else if (averageAbsorptionDays > 25) {
    capitalRiskIndex = 'MODÉRÉ';
  }

  return {
    totalCapitalCommitted: Math.round(totalCapital * 100) / 100,
    averageAbsorptionDays,
    fastRunnerCount: fastCount,
    steadyCount,
    slowMovingCount: slowCount,
    projectedGrossYield,
    capitalRiskIndex,
    lines: lineMetricsMap,
  };
}
