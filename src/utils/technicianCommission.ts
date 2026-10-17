/**
 * UPGRADE-05 — technician commission math (pure, integer DZD).
 *
 * A commission rule is percent-based: `ratePercent` of the chosen basis
 * (`labor` = main d'œuvre only, `total` = labor + parts). Rules are resolved
 * at settlement time: an active technician-specific rule outranks the active
 * default rule (technician_id NULL); newest wins within the same class.
 *
 * Money: basis amounts are integer DZD, rates are percents (0–100). The
 * result is rounded once to integer DZD — the single rounding boundary for
 * payroll math, mirroring `repairFinancials` at the repair write boundary.
 */

export type CommissionBasis = 'labor' | 'total';

/** Minimal shape shared by the SQLite row and UI form. */
export interface CommissionRuleLike {
  id: string;
  /** null = default rule that applies to every technician. */
  technicianId: string | null;
  basis: CommissionBasis;
  ratePercent: number;
  active: boolean;
  /** Newest-first arbitration tiebreaker (ISO string). */
  createdAt?: string;
}

export interface CommissionEvaluation {
  basis: CommissionBasis;
  basisAmount: number;
  ratePercent: number;
  /** Integer DZD owed to the technician for this ticket (0 when no rule). */
  amount: number;
  ruleId: string | null;
}

export const COMMISSION_BASIS_LABELS: Record<CommissionBasis, string> = {
  labor: "Main d'œuvre",
  total: 'Total facture (MO + pièces)',
};

/** Clamp a percent into [0, 100]; NaN → 0. Percent, not money — exact enough as REAL. */
export function clampRatePercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Pick the rule that governs a technician: active specific rule first, then
 * active default (technician_id NULL). Inactive rules never apply. Within a
 * class the newest `createdAt` wins; missing dates lose to dated ones.
 */
export function resolveActiveCommissionRule(
  rules: readonly CommissionRuleLike[],
  technicianId: string | null | undefined
): CommissionRuleLike | null {
  const active = (rules || []).filter((r) => r && r.active);
  if (active.length === 0) return null;
  const newestFirst = [...active].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
  );
  if (technicianId) {
    const specific = newestFirst.find((r) => r.technicianId === technicianId);
    if (specific) return specific;
  }
  return newestFirst.find((r) => r.technicianId === null || r.technicianId === undefined) ?? null;
}

/**
 * Evaluate the commission for a settled repair. `order.laborCost`/`totalCost`
 * are integer DZD (see `repairFinancials`). No rule → an honest zero with the
 * labor basis recorded, so payroll can distinguish "evaluated, nothing owed"
 * from "never evaluated" (the field is only stamped when evaluation ran).
 */
export function computeRepairCommission(
  rule: CommissionRuleLike | null,
  order: { laborCost?: number; totalCost?: number }
): CommissionEvaluation {
  const laborCost = Math.max(0, Math.round(Number(order.laborCost) || 0));
  const totalCost = Math.max(0, Math.round(Number(order.totalCost) || 0));
  if (!rule) {
    return {
      basis: 'labor',
      basisAmount: laborCost,
      ratePercent: 0,
      amount: 0,
      ruleId: null,
    };
  }
  const basis: CommissionBasis = rule.basis === 'total' ? 'total' : 'labor';
  const basisAmount = basis === 'total' ? totalCost : laborCost;
  const ratePercent = clampRatePercent(rule.ratePercent);
  const amount = Math.round((basisAmount * ratePercent) / 100);
  return { basis, basisAmount, ratePercent, amount, ruleId: rule.id };
}

/** Human duration for timer readouts ("45 min", "2 h 05"). Non-money. */
export function formatDurationMs(ms: number): string {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const totalMinutes = Math.floor(safe / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${String(minutes).padStart(2, '0')}`;
}
