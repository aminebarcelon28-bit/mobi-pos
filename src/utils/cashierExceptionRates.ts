/**
 * UPGRADE-09 — Cashier Exception Intelligence (EBR-lite).
 *
 * Compute-on-read over three existing tables ONLY (`security_audit_logs`,
 * `transactions`, `cash_sessions`) — zero new writable tables, zero new trust
 * surface. Every number below is derived deterministically from rows the
 * caller already has; nothing here reads a clock, so a caller can replay any
 * historical window with identical output (`sinceIso`/`untilIso` are explicit
 * inputs).
 *
 * Accountability rules (owner-set):
 *  • A rate is NEVER raw k/n. Small denominators are gated: below
 *    `minSupport` the anomaly confidence is exactly 0 and the cashier is not
 *    ranked on its rate (`1/1 void` must never outrank `15/50`).
 *  • Reported rates are shrunk toward the pooled store rate (empirical-Bayes
 *    Beta prior), so one event on a quiet day cannot swing a bonus or trigger
 *    a theft hunt.
 *  • Actor identity is the immutable roster id (`actorId`) when present;
 *    legacy rows map deterministically (roster name match, else
 *    `legacy:<slug>`), so a rename can never split or merge accountability
 *    history by accident.
 *  • Approvals are supervisor→cashier pairs. The manager credential is a
 *    single store-level credential (`verifyManagerGate`), so the approver key
 *    is the constant `manager`; concentration is reported as per-cashier
 *    share plus an HHI over the pair counts.
 *
 * Category vocabulary (first match wins, pinned by the suite):
 *  • removal   — « Suppression Article Panier … » (all vectors)
 *  • override  — « Dérogation Prix Manuel »
 *  • refund    — « Remboursement … »
 *  • discount  — « Remise … »
 *  • no_sale   — any drawer pulse ( « … Tiroir … » ), incl. the hardware test
 *  • void      — any « Annulation … » EXCEPT refusals (« … Refusée … »,
 *                which belong to the denial-burst analytics, never here)
 */

// ── Categories ─────────────────────────────────────────────────────────────

export type ExceptionCategory =
  | 'void'
  | 'removal'
  | 'no_sale'
  | 'discount'
  | 'override'
  | 'refund';

export const EXCEPTION_CATEGORIES: readonly ExceptionCategory[] = [
  'void',
  'removal',
  'no_sale',
  'discount',
  'override',
  'refund',
];

export const EXCEPTION_CATEGORY_LABELS: Record<ExceptionCategory, string> = {
  void: 'Annulations',
  removal: 'Retraits panier',
  no_sale: 'Ouvertures tiroir',
  discount: 'Remises',
  override: 'Dérogations prix',
  refund: 'Remboursements',
};

/**
 * Classify one audit action. Returns null for non-exception rows (PIN checks,
 * stock refusals, sync notices, …) — those never enter any denominator here.
 */
export function classifyExceptionAction(action: string): ExceptionCategory | null {
  const a = (action || '').toLowerCase();
  if (!a.trim()) return null;
  if (a.includes('suppression article panier')) return 'removal';
  if (a.includes('dérogation') || a.includes('derogation') || a.includes('prix manuel')) return 'override';
  if (a.includes('remboursement')) return 'refund';
  if (a.startsWith('remise')) return 'discount';
  if (a.includes('tiroir')) return 'no_sale';
  if (a.includes('annul')) {
    // A refused annulation is a DENIAL signal (its own analytics lane), not an
    // executed exception — never count it as a void.
    if (a.includes('refus')) return null;
    return 'void';
  }
  return null;
}

// ── Actor identity ─────────────────────────────────────────────────────────

export interface RosterActor {
  id: string;
  name: string;
}

/** Diacritic-insensitive, whitespace-normalized actor-name folding. */
export function foldActorName(name: string): string {
  return (name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministic slug used for legacy rows that carry no roster id. */
export function slugActorName(name: string): string {
  const slug = foldActorName(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'inconnu';
}

/**
 * Immutable actor key for one audit row:
 *  1. `actorId` when the write bound one (new rows);
 *  2. roster match by folded display name (legacy rows on this device);
 *  3. `legacy:<slug>` — deterministic fallback, stable across reads.
 */
export function normalizeActorKey(
  row: { actorId?: string | null; user?: string | null },
  roster: readonly RosterActor[] = []
): string {
  const id = (row.actorId ?? '').trim();
  if (id) return id;
  const name = (row.user ?? '').trim();
  const folded = foldActorName(name);
  if (folded) {
    const match = roster.find((r) => r.id && foldActorName(r.name) === folded);
    if (match) return match.id;
  }
  return `legacy:${slugActorName(name || 'inconnu')}`;
}

/**
 * Write-time resolution: return the immutable roster id for a display name.
 * No `legacy:` fallback here — an unresolvable name stays NULL in the column
 * and the read-time fallback owns it (single mapping law).
 */
export function resolveActorIdForWrite(
  user: string,
  activeCashier: RosterActor | null | undefined,
  roster: readonly RosterActor[] | null | undefined
): string | undefined {
  const folded = foldActorName(user);
  if (!folded) return undefined;
  if (activeCashier && activeCashier.id && foldActorName(activeCashier.name) === folded) {
    return activeCashier.id;
  }
  const match = (roster ?? []).find((r) => r.id && foldActorName(r.name) === folded);
  return match?.id;
}

// ── Statistics ─────────────────────────────────────────────────────────────

/** Wilson score lower bound (default 95%) for k successes over n trials. */
export function wilsonLowerBound(k: number, n: number, z = 1.96): number {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return 0;
  const kk = Math.max(0, Math.min(n, k));
  const p = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lb = (centre - margin) / denom;
  return Number.isFinite(lb) ? Math.max(0, lb) : 0;
}

/**
 * Empirical-Bayes shrinkage toward the pooled store rate: Beta prior with
 * `priorStrength` pseudo-observations sitting at `pooled` (same units as the
 * returned rate).
 */
export function shrunkRate(k: number, n: number, pooled: number, priorStrength = 20): number {
  const kk = Number.isFinite(k) ? Math.max(0, k) : 0;
  const nn = Number.isFinite(n) ? Math.max(0, n) : 0;
  const p = Number.isFinite(pooled) ? Math.max(0, Math.min(1, pooled)) : 0;
  const prior = Number.isFinite(priorStrength) ? Math.max(0, priorStrength) : 0;
  const total = nn + prior;
  if (total <= 0) return 0;
  return (kk + prior * p) / total;
}

export interface ExceptionThresholds {
  /**
   * Minimum denominator (transactions for the per-100 rate) before a cashier
   * can be ranked or flagged. Below it, anomaly confidence is exactly 0.
   */
  minSupport: number;
  /** Anomaly-confidence floor (Wilson LB of the per-transaction rate). */
  flagConfidence: number;
  /** Flagged only when the shrunk rate exceeds pooled × this multiplier. */
  pooledMultiplier: number;
  /** Beta-prior pseudo-observations for shrinkage. */
  priorStrength: number;
  /** Wilson z (1.96 ≈ 95%). */
  z: number;
}

export const DEFAULT_EXCEPTION_THRESHOLDS: ExceptionThresholds = {
  minSupport: 20,
  flagConfidence: 0.15,
  pooledMultiplier: 2,
  priorStrength: 20,
  z: 1.96,
};

/**
 * Gated anomaly confidence: Wilson 95% lower bound of the per-transaction
 * exception rate, EXACTLY 0 below the minimum-support gate. The gate is the
 * whole point — a raw Wilson bound on `1/1` (≈0.2065) beats `15/50` (≈0.1910),
 * which is why small denominators must be excluded BEFORE any statistic runs.
 */
export function anomalyConfidence(
  k: number,
  n: number,
  cfg: Pick<ExceptionThresholds, 'minSupport' | 'z'>
): number {
  if (!Number.isFinite(n) || n < cfg.minSupport) return 0;
  return wilsonLowerBound(k, n, cfg.z);
}

// ── Inputs / outputs ───────────────────────────────────────────────────────

export interface ExceptionAuditRow {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  requiresPin: boolean;
  actorId?: string | null;
}

export interface ShiftTxnCount {
  shiftId: string;
  count: number;
}

export interface ClosedSessionRow {
  id: string;
  cashierName: string;
  openedAt: string;
  closedAt: string | null;
  expectedCash: number | null;
  actualCash: number | null;
  discrepancy: number | null;
  status: string;
}

export interface ExceptionIntelInput {
  sinceIso: string;
  untilIso: string;
  auditRows: readonly ExceptionAuditRow[];
  shiftTxnCounts: readonly ShiftTxnCount[];
  sessions: readonly ClosedSessionRow[];
  roster: readonly RosterActor[];
  thresholds?: Partial<ExceptionThresholds>;
}

export interface ActorExceptionStats {
  actorKey: string;
  actorName: string;
  txns: number;
  shifts: number;
  counts: Record<ExceptionCategory, number>;
  totalExceptions: number;
  /** Raw per-100-txn rate — reported for honesty, NEVER used to rank. */
  per100Raw: number | null;
  /** Shrunk per-100-txn rate (toward pooled) — the displayed rate. */
  shrunkPer100: number;
  /** Shrunk exceptions per shift. */
  perShift: number;
  /** Gated anomaly confidence (0 below minSupport). */
  confidence: number;
  sufficientSupport: boolean;
  flagged: boolean;
  approvedExceptions: number;
  approvalShare: number;
}

export interface ApprovalPair {
  approverKey: string;
  cashierKey: string;
  cashierName: string;
  count: number;
}

export interface ApprovalIntel {
  /** No named supervisor identity exists (single manager credential). */
  approverKey: string;
  pairs: ApprovalPair[];
  total: number;
  /** Herfindahl index over per-cashier approval counts (1 pair → 1). */
  hhi: number;
  topShare: number;
}

export interface VarianceRow {
  sessionId: string;
  actorKey: string;
  actorName: string;
  closedAt: string | null;
  variance: number;
  absVariance: number;
  exceptionCount: number;
}

export interface ExceptionIntelResult {
  window: { sinceIso: string; untilIso: string };
  /** Ranked: sufficient support first, then confidence, shrunk rate, volume. */
  actors: ActorExceptionStats[];
  pool: {
    txns: number;
    shifts: number;
    counts: Record<ExceptionCategory, number>;
    totalExceptions: number;
    per100: number;
    perShift: number;
  };
  approvals: ApprovalIntel;
  variance: VarianceRow[];
  /** Shift-linked txns whose shift has no session row in the window. */
  unattributedTxns: number;
}

const MANAGER_APPROVER_KEY = 'manager';

function emptyCounts(): Record<ExceptionCategory, number> {
  return { void: 0, removal: 0, no_sale: 0, discount: 0, override: 0, refund: 0 };
}

function toNonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Approval marker: the row proves a manager PIN authorized the exception. */
export function isApprovalMarked(row: { requiresPin?: boolean; details?: string }): boolean {
  if (row.requiresPin) return true;
  return /approuv|approbation/i.test(row.details || '');
}

// ── The compute core ───────────────────────────────────────────────────────

export function computeExceptionIntel(input: ExceptionIntelInput): ExceptionIntelResult {
  const cfg: ExceptionThresholds = { ...DEFAULT_EXCEPTION_THRESHOLDS, ...(input.thresholds ?? {}) };
  const roster = input.roster ?? [];

  // 1) Sessions first: shift id → actor key drives txn attribution.
  const sessionActor = new Map<string, string>();
  const shiftsByActor = new Map<string, number>();
  const sessionNameByActor = new Map<string, string>();
  for (const s of input.sessions ?? []) {
    if (!s || s.status !== 'CLOSED') continue;
    const key = normalizeActorKey({ actorId: null, user: s.cashierName }, roster);
    if (s.id) sessionActor.set(s.id, key);
    shiftsByActor.set(key, (shiftsByActor.get(key) ?? 0) + 1);
    if (s.cashierName && !sessionNameByActor.has(key)) sessionNameByActor.set(key, s.cashierName);
  }

  // 2) Transactions per actor through the shift map.
  const txnsByActor = new Map<string, number>();
  let poolTxns = 0;
  let unattributedTxns = 0;
  for (const t of input.shiftTxnCounts ?? []) {
    const count = toNonNegInt(t?.count);
    poolTxns += count;
    const key = t?.shiftId ? sessionActor.get(t.shiftId) : undefined;
    if (!key) {
      unattributedTxns += count;
      continue;
    }
    txnsByActor.set(key, (txnsByActor.get(key) ?? 0) + count);
  }

  // 3) Audit rows → per-actor category counts (+ approvals). Latest name wins.
  const countsByActor = new Map<string, Record<ExceptionCategory, number>>();
  const approvedByActor = new Map<string, number>();
  const nameByActor = new Map<string, string>();
  const latestTsByActor = new Map<string, string>();
  const pool = { counts: emptyCounts(), totalExceptions: 0 };
  const classified: Array<{ actorKey: string; ts: string }> = [];

  for (const row of input.auditRows ?? []) {
    const category = classifyExceptionAction(row?.action ?? '');
    if (!category) continue;
    const key = normalizeActorKey(row, roster);
    const counts = countsByActor.get(key) ?? emptyCounts();
    counts[category] += 1;
    countsByActor.set(key, counts);
    pool.counts[category] += 1;
    pool.totalExceptions += 1;
    if (isApprovalMarked(row)) approvedByActor.set(key, (approvedByActor.get(key) ?? 0) + 1);
    const name = (row.user ?? '').trim();
    if (name) {
      const prevTs = latestTsByActor.get(key) ?? '';
      if ((row.timestamp ?? '') >= prevTs) {
        latestTsByActor.set(key, row.timestamp ?? '');
        nameByActor.set(key, name);
      }
    }
    classified.push({ actorKey: key, ts: row.timestamp ?? '' });
  }

  // 4) Actor universe = exception actors ∪ shift cashiers ∪ txn actors.
  const actorKeys = new Set<string>([
    ...countsByActor.keys(),
    ...shiftsByActor.keys(),
    ...txnsByActor.keys(),
  ]);

  const poolRatePerTxn = poolTxns > 0 ? pool.totalExceptions / poolTxns : 0;
  const poolShifts = (input.sessions ?? []).filter((s) => s && s.status === 'CLOSED').length;
  const poolRatePerShift = poolShifts > 0 ? pool.totalExceptions / poolShifts : 0;

  const actors: ActorExceptionStats[] = [];
  for (const key of actorKeys) {
    const txns = txnsByActor.get(key) ?? 0;
    const shifts = shiftsByActor.get(key) ?? 0;
    const counts = countsByActor.get(key) ?? emptyCounts();
    const totalExceptions = EXCEPTION_CATEGORIES.reduce((acc, c) => acc + counts[c], 0);
    const sufficientSupport = txns >= cfg.minSupport;
    const confidence = anomalyConfidence(totalExceptions, txns, cfg);
    const shrunk = shrunkRate(totalExceptions, txns, poolRatePerTxn, cfg.priorStrength);
    const shrunkPer100 = shrunk * 100;
    const perShift = shrunkRate(totalExceptions, shifts, poolRatePerShift, cfg.priorStrength);
    const pooledPer100 = poolRatePerTxn * 100;
    const flagged =
      sufficientSupport &&
      confidence >= cfg.flagConfidence &&
      shrunkPer100 > pooledPer100 * cfg.pooledMultiplier;
    const approvedExceptions = approvedByActor.get(key) ?? 0;
    actors.push({
      actorKey: key,
      actorName: nameByActor.get(key) ?? sessionNameByActor.get(key) ?? key.replace(/^legacy:/, ''),
      txns,
      shifts,
      counts,
      totalExceptions,
      per100Raw: txns > 0 ? (totalExceptions / txns) * 100 : null,
      shrunkPer100,
      perShift,
      confidence,
      sufficientSupport,
      flagged,
      approvedExceptions,
      approvalShare: totalExceptions > 0 ? approvedExceptions / totalExceptions : 0,
    });
  }

  // Ranked, deterministic: sufficient support first, never raw k/n ordering.
  actors.sort((a, b) => {
    if (a.sufficientSupport !== b.sufficientSupport) return a.sufficientSupport ? -1 : 1;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.shrunkPer100 !== a.shrunkPer100) return b.shrunkPer100 - a.shrunkPer100;
    if (b.txns !== a.txns) return b.txns - a.txns;
    return a.actorKey < b.actorKey ? -1 : a.actorKey > b.actorKey ? 1 : 0;
  });

  // 5) Approval concentration (supervisor=manager → cashier pairs).
  const pairs: ApprovalPair[] = actors
    .filter((a) => a.approvedExceptions > 0)
    .map((a) => ({
      approverKey: MANAGER_APPROVER_KEY,
      cashierKey: a.actorKey,
      cashierName: a.actorName,
      count: a.approvedExceptions,
    }))
    .sort((a, b) => b.count - a.count || (a.cashierKey < b.cashierKey ? -1 : 1));
  const approvalTotal = pairs.reduce((acc, p) => acc + p.count, 0);
  const hhi =
    approvalTotal > 0
      ? pairs.reduce((acc, p) => acc + Math.pow(p.count / approvalTotal, 2), 0)
      : 0;
  const topShare = approvalTotal > 0 && pairs.length > 0 ? pairs[0].count / approvalTotal : 0;

  // 6) Blind-close variance joined against in-shift exception counts.
  const variance: VarianceRow[] = [];
  for (const s of input.sessions ?? []) {
    if (!s || s.status !== 'CLOSED') continue;
    const key = normalizeActorKey({ actorId: null, user: s.cashierName }, roster);
    const varianceValue =
      typeof s.discrepancy === 'number' && Number.isFinite(s.discrepancy)
        ? s.discrepancy
        : typeof s.actualCash === 'number' &&
            typeof s.expectedCash === 'number' &&
            Number.isFinite(s.actualCash) &&
            Number.isFinite(s.expectedCash)
          ? s.actualCash - s.expectedCash
          : 0;
    const end = s.closedAt && s.closedAt.length >= 10 ? s.closedAt : input.untilIso;
    const exceptionCount = classified.filter(
      (e) => e.actorKey === key && e.ts >= s.openedAt && e.ts <= end
    ).length;
    variance.push({
      sessionId: s.id,
      actorKey: key,
      actorName: sessionNameByActor.get(key) ?? s.cashierName ?? key,
      closedAt: s.closedAt ?? null,
      variance: varianceValue,
      absVariance: Math.abs(varianceValue),
      exceptionCount,
    });
  }
  variance.sort(
    (a, b) =>
      b.absVariance - a.absVariance ||
      b.exceptionCount - a.exceptionCount ||
      (a.sessionId < b.sessionId ? -1 : 1)
  );

  return {
    window: { sinceIso: input.sinceIso, untilIso: input.untilIso },
    actors,
    pool: {
      txns: poolTxns,
      shifts: poolShifts,
      counts: pool.counts,
      totalExceptions: pool.totalExceptions,
      per100: poolRatePerTxn * 100,
      perShift: poolRatePerShift,
    },
    approvals: {
      approverKey: MANAGER_APPROVER_KEY,
      pairs,
      total: approvalTotal,
      hhi,
      topShare,
    },
    variance,
    unattributedTxns,
  };
}
