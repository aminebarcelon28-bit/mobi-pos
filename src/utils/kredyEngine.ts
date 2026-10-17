/**
 * KREDY collection & risk engine — pure, clock-injected (UPGRADE-11).
 *
 * Every calculator here takes an explicit `nowIso`; the module contains no
 * wall-clock reads (`Date.now()` is forbidden — pinned by the suite). Money in
 * the Kredy domain is INTEGER DZD (the debt ledger stores dinars; `formatDZD`
 * owns display). Installment plans are strictly 0 % / 0-fee: the engine emits
 * no fee, no interest and no rate field at all — `Σ entry amounts === total`
 * is the only arithmetic.
 *
 * Consumers: `createOrderSlice` (desktop credit gate), `MobileCheckoutTab`
 * (mobile pre-check), `createCustomerSlice` (repayment waterfall + plan
 * application), `KredyTab` / `DebtLedgerModal` (aging, score, dunning).
 */

// ── integer coercion (money-boundary registry lives elsewhere; Kredy money is
// integer dinars, so one truncating coercion is enough and it stays here) ────

/** Integer DZD coercion: never NaN, never fractional. Unknown input → 0. */
export function toIntDzd(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

const DAY_MS = 86_400_000;

/** Parsed epoch ms, or null when the ISO string is absent/unparseable. */
export function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** `baseIso` + N days, ISO-preserving. Month/leap-safe (pure Date math). */
export function addDaysIso(baseIso: string, days: number): string {
  const ms = parseIsoMs(baseIso);
  if (ms == null) return baseIso;
  return new Date(ms + Math.trunc(days) * DAY_MS).toISOString();
}

// ── aging (30/60/90 due-date ladder) ────────────────────────────────────────

export type KredyAgingBucket = 'Courant' | '1–30j' | '31–60j' | '61–90j' | '90j+';

export const KREDY_AGING_BUCKETS: readonly KredyAgingBucket[] = [
  'Courant',
  '1–30j',
  '31–60j',
  '61–90j',
  '90j+',
];

/**
 * Whole days past the due date (0 when not yet due, no due date, or an
 * unparseable clock/due). Floor semantics: a due date reached less than 24 h
 * ago still counts as `Courant`; the first overdue bucket starts at one full
 * day late.
 */
export function daysOverdue(dueDateIso: string | null | undefined, nowIso: string): number {
  const due = parseIsoMs(dueDateIso);
  const now = parseIsoMs(nowIso);
  if (due == null || now == null) return 0;
  return Math.floor((now - due) / DAY_MS);
}

export function agingBucketFor(
  dueDateIso: string | null | undefined,
  nowIso: string
): KredyAgingBucket {
  const overdue = daysOverdue(dueDateIso, nowIso);
  if (overdue <= 0) return 'Courant';
  if (overdue <= 30) return '1–30j';
  if (overdue <= 60) return '31–60j';
  if (overdue <= 90) return '61–90j';
  return '90j+';
}

/** Ranking weight for a bucket (0 = Courant, 4 = 90j+). */
export function agingBucketRank(bucket: KredyAgingBucket): number {
  return Math.max(0, KREDY_AGING_BUCKETS.indexOf(bucket));
}

// ── the single credit gate (desktop + mobile share this) ───────────────────

export interface CreditGateVerdict {
  allowed: boolean;
  reason?: 'CREDIT_LIMIT_EXCEEDED';
  currentDebt: number;
  creditAmount: number;
  projectedDebt: number;
  debtLimit: number;
}

/**
 * ONE credit gate for desktop (`createOrderSlice`) and mobile
 * (`MobileCheckoutTab`). Preserves the shipped boundary exactly: a projected
 * debt strictly ABOVE the ceiling is refused; exactly at the ceiling stays
 * allowed (both shipped call sites agreed on that predicate — unification is
 * not a boundary change). Numbers are sanitized (NaN → 0) but never re-rounded:
 * the gate must not introduce a rounding step the call sites did not have.
 */
export function assertCreditAllowed(input: {
  currentDebt: number | null | undefined;
  debtLimit: number | null | undefined;
  creditAmount: number | null | undefined;
}): CreditGateVerdict {
  const sanitize = (v: number | null | undefined): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const currentDebt = sanitize(input.currentDebt);
  const creditAmount = sanitize(input.creditAmount);
  const debtLimit = sanitize(input.debtLimit);
  const projectedDebt = currentDebt + creditAmount;
  const allowed = projectedDebt <= debtLimit;
  return allowed
    ? { allowed: true, currentDebt, creditAmount, projectedDebt, debtLimit }
    : { allowed: false, reason: 'CREDIT_LIMIT_EXCEEDED', currentDebt, creditAmount, projectedDebt, debtLimit };
}

// ── zero-interest installment plans (PTP) ───────────────────────────────────

export const KREDY_PLAN_MAX_INSTALLMENTS = 120;
export const KREDY_PLAN_MAX_INTERVAL_DAYS = 90;
/** Default credit term: a sale booked on credit is due 30 days later. */
export const KREDY_DEFAULT_TERM_DAYS = 30;

export interface DebtPlanEntryDraft {
  seq: number;
  amount: number;
  dueDate: string;
}

export interface InstallmentPlanDraft {
  totalAmount: number;
  installments: number;
  intervalDays: number;
  entries: DebtPlanEntryDraft[];
}

export type PlanValidationReason =
  | 'TOTAL_NEGATIVE'
  | 'NON_INTEGER_TOTAL'
  | 'INSTALLMENTS_RANGE'
  | 'INTERVAL_RANGE'
  | 'ENTRY_BELOW_ONE_DA'
  | 'INVALID_START'
  | 'EXCEEDS_OUTSTANDING';

/**
 * Split an integer-DZD total across N dated installments. Remainders go to
 * the EARLIEST entries (largest-remainder, deterministic) so
 * `Σ entries.amount === totalAmount` always, with no fee and no interest.
 */
export function buildInstallmentPlan(input: {
  totalAmount: number;
  installments: number;
  intervalDays: number;
  startIso: string;
  outstandingDebt?: number;
}): { ok: true; plan: InstallmentPlanDraft } | { ok: false; reason: PlanValidationReason } {
  const total = Number(input.totalAmount);
  if (!Number.isFinite(total) || total < 0) return { ok: false, reason: 'TOTAL_NEGATIVE' };
  if (!Number.isInteger(total)) return { ok: false, reason: 'NON_INTEGER_TOTAL' };
  const n = Math.trunc(Number(input.installments) || 0);
  if (n < 1 || n > KREDY_PLAN_MAX_INSTALLMENTS) return { ok: false, reason: 'INSTALLMENTS_RANGE' };
  const interval = Math.trunc(Number(input.intervalDays) || 0);
  if (interval < 1 || interval > KREDY_PLAN_MAX_INTERVAL_DAYS) return { ok: false, reason: 'INTERVAL_RANGE' };
  if (parseIsoMs(input.startIso) == null) return { ok: false, reason: 'INVALID_START' };
  if (total < n) return { ok: false, reason: 'ENTRY_BELOW_ONE_DA' };
  if (input.outstandingDebt != null) {
    const outstanding = toIntDzd(input.outstandingDebt);
    if (total > outstanding) return { ok: false, reason: 'EXCEEDS_OUTSTANDING' };
  }
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  const entries: DebtPlanEntryDraft[] = [];
  for (let i = 0; i < n; i += 1) {
    entries.push({
      seq: i + 1,
      amount: base + (i < remainder ? 1 : 0),
      dueDate: addDaysIso(input.startIso, interval * (i + 1)),
    });
  }
  return { ok: true, plan: { totalAmount: total, installments: n, intervalDays: interval, entries } };
}

// ── FIFO repayment waterfall (due_date ASC, id ASC) ────────────────────────

export interface OutstandingDebtItem {
  id: string;
  dueDate?: string | null;
  remaining: number;
}

export interface RepaymentAllocation {
  debtId: string;
  amount: number;
}

/**
 * FIFO waterfall: settle the oldest due date first (nulls last), then the
 * lowest id — deterministic under any clock, which is why the allocation
 * ordering reads due dates but never the wall clock. Conservation:
 * `Σ allocations.amount + leftover === paymentAmount` (payment clamped ≥ 0).
 */
export function allocateRepaymentFifo(
  items: readonly OutstandingDebtItem[],
  paymentAmount: number
): { allocations: RepaymentAllocation[]; leftover: number } {
  let left = Math.max(0, toIntDzd(paymentAmount));
  const ordered = [...items]
    .filter((it) => it && typeof it.id === 'string' && it.id.length > 0)
    .sort((a, b) => {
      const aMs = parseIsoMs(a.dueDate ?? null);
      const bMs = parseIsoMs(b.dueDate ?? null);
      if (aMs != null && bMs != null && aMs !== bMs) return aMs - bMs;
      if (aMs != null && bMs == null) return -1;
      if (aMs == null && bMs != null) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const allocations: RepaymentAllocation[] = [];
  for (const item of ordered) {
    if (left <= 0) break;
    const remaining = Math.max(0, toIntDzd(item.remaining));
    if (remaining <= 0) continue;
    const take = Math.min(remaining, left);
    allocations.push({ debtId: item.id, amount: take });
    left -= take;
  }
  return { allocations, leftover: left };
}

/** Remaining per acquisition = amount − Σ allocations recorded against it. */
export function outstandingItemsFromEntries(
  entries: readonly {
    id: string;
    type: string;
    amount: number;
    dueDate?: string | null;
    allocations?: readonly { debtId: string; amount: number }[] | null;
  }[]
): OutstandingDebtItem[] {
  const settledById = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== 'PAYMENT_SETTLED' || !Array.isArray(entry.allocations)) continue;
    for (const alloc of entry.allocations) {
      if (!alloc || typeof alloc.debtId !== 'string') continue;
      settledById.set(alloc.debtId, (settledById.get(alloc.debtId) || 0) + toIntDzd(alloc.amount));
    }
  }
  return entries
    .filter((e) => e.type === 'DEBT_ACQUIRED')
    .map((e) => ({
      id: e.id,
      dueDate: e.dueDate ?? null,
      remaining: Math.max(0, toIntDzd(e.amount) - (settledById.get(e.id) || 0)),
    }));
}

// ── plan entry application (same write path as the balance update) ─────────

export interface PlanEntryState {
  id: string;
  seq: number;
  amount: number;
  paidAmount: number;
}

export interface PlanEntryUpdate {
  id: string;
  paidAmount: number;
  justPaid: boolean;
}

/**
 * Fill a plan's entries in seq order with a payment remainder. Returns only
 * the touched entries plus the unconsumed remainder — `Σ taken + remaining`
 * equals the input amount, and a fully-paid entry is reported once.
 */
export function applyPaymentToPlanEntries(
  entries: readonly PlanEntryState[],
  paymentAmount: number
): { updates: PlanEntryUpdate[]; remaining: number; allPaid: boolean } {
  let left = Math.max(0, toIntDzd(paymentAmount));
  const ordered = [...entries]
    .filter((e) => e && typeof e.id === 'string')
    .sort((a, b) => (a.seq === b.seq ? (a.id < b.id ? -1 : 1) : a.seq - b.seq));
  const updates: PlanEntryUpdate[] = [];
  for (const entry of ordered) {
    if (left <= 0) break;
    const amount = Math.max(0, toIntDzd(entry.amount));
    const paid = Math.min(amount, Math.max(0, toIntDzd(entry.paidAmount)));
    const capacity = amount - paid;
    if (capacity <= 0) continue;
    const take = Math.min(capacity, left);
    const newPaid = paid + take;
    updates.push({ id: entry.id, paidAmount: newPaid, justPaid: newPaid >= amount });
    left -= take;
  }
  const allPaid =
    ordered.length > 0 &&
    ordered.every((e) => {
      const update = updates.find((u) => u.id === e.id);
      const effective = update ? update.paidAmount : Math.max(0, toIntDzd(e.paidAmount));
      return effective >= Math.max(0, toIntDzd(e.amount));
    });
  return { updates, remaining: left, allPaid };
}

// ── reliability score (0–100 + factor breakdown) ───────────────────────────

export interface KredyScoreFactor {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export interface KredyScore {
  score: number;
  factors: KredyScoreFactor[];
}

export interface KredyScoreInput {
  nowIso: string;
  currentDebt: number;
  debtLimit: number;
  entries: readonly {
    id: string;
    type: string;
    amount: number;
    createdAt?: string | null;
    dueDate?: string | null;
    allocations?: readonly { debtId: string; amount: number }[] | null;
  }[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Deterministic 0–100 reliability score with an explicit factor breakdown
 * (`Σ factors.points === score`, always — a final clamp factor keeps that
 * identity true when penalties would push below 0). Stored on the customer
 * (`credit_score` / `credit_score_at`); the breakdown is recomputed on the fly.
 */
export function computeReliabilityScore(input: KredyScoreInput): KredyScore {
  const entries = input.entries || [];
  const acquired = entries
    .filter((e) => e.type === 'DEBT_ACQUIRED')
    .reduce((sum, e) => sum + Math.max(0, toIntDzd(e.amount)), 0);
  const settled = entries
    .filter((e) => e.type === 'PAYMENT_SETTLED')
    .reduce((sum, e) => sum + Math.max(0, toIntDzd(e.amount)), 0);

  const repayRatio = acquired > 0 ? clamp01(settled / acquired) : 1;
  const repaymentPoints = Math.round(repayRatio * 40);

  let recencyPoints = 0;
  let recencyDetail = 'Aucun versement enregistré';
  const nowMs = parseIsoMs(input.nowIso);
  const paymentTimes = entries
    .filter((e) => e.type === 'PAYMENT_SETTLED')
    .map((e) => parseIsoMs(e.createdAt ?? null))
    .filter((ms): ms is number => ms != null);
  if (paymentTimes.length > 0 && nowMs != null) {
    const lastMs = Math.max(...paymentTimes);
    const days = Math.max(0, Math.floor((nowMs - lastMs) / DAY_MS));
    recencyPoints = days <= 30 ? 20 : days <= 60 ? 14 : days <= 90 ? 8 : days <= 180 ? 3 : 0;
    recencyDetail = `Dernier versement il y a ${days} j`;
  } else if (paymentTimes.length > 0) {
    recencyPoints = 3;
    recencyDetail = 'Horodatage illisible — score prudent';
  }

  const currentDebt = Math.max(0, toIntDzd(input.currentDebt));
  let overduePenalty = 0;
  let overdueDetail = 'Aucun encours';
  if (currentDebt > 0) {
    const outstanding = outstandingItemsFromEntries(entries).filter((it) => it.remaining > 0);
    let worst: KredyAgingBucket = 'Courant';
    for (const item of outstanding) {
      const bucket = agingBucketFor(item.dueDate, input.nowIso);
      if (agingBucketRank(bucket) > agingBucketRank(worst)) worst = bucket;
    }
    overduePenalty =
      worst === 'Courant' ? 0 : worst === '1–30j' ? 6 : worst === '31–60j' ? 15 : worst === '61–90j' ? 25 : 40;
    overdueDetail = worst === 'Courant' ? 'Encours à jour' : `Encours en retard : ${worst}`;
  }

  const debtLimit = Math.max(0, toIntDzd(input.debtLimit));
  let utilizationPenalty = 0;
  let utilizationDetail = 'Aucun encours';
  if (currentDebt > 0 && debtLimit > 0) {
    const ratio = currentDebt / debtLimit;
    utilizationPenalty = ratio >= 1 ? 15 : ratio >= 0.8 ? 8 : ratio >= 0.5 ? 4 : 0;
    utilizationDetail = `Utilisation plafond : ${Math.round(ratio * 100)} %`;
  }

  const base = 40;
  const raw = base + repaymentPoints + recencyPoints - overduePenalty - utilizationPenalty;
  const score = raw < 0 ? 0 : raw > 100 ? 100 : raw;
  const factors: KredyScoreFactor[] = [
    { key: 'base', label: 'Base', points: base, detail: 'Score de départ' },
    {
      key: 'repayment',
      label: 'Historique de remboursement',
      points: repaymentPoints,
      detail: acquired > 0 ? `${settled} / ${acquired} DA remboursés` : 'Aucun historique — crédit complet',
    },
    { key: 'recency', label: 'Paiement récent', points: recencyPoints, detail: recencyDetail },
    { key: 'overdue', label: 'Retard de paiement', points: -overduePenalty, detail: overdueDetail },
    { key: 'utilization', label: 'Utilisation du plafond', points: -utilizationPenalty, detail: utilizationDetail },
  ];
  if (score !== raw) {
    factors.push({ key: 'clamp', label: 'Ajustement (0–100)', points: score - raw, detail: 'Bornes 0–100' });
  }
  return { score, factors };
}

// ── dunning ladder (1 msg/stage, quiet hours, launch-only) ─────────────────

export type DunningStageId = 'R1' | 'R2' | 'R3';

export interface DunningStage {
  id: DunningStageId;
  label: string;
  minDaysOverdue: number;
}

export const DUNNING_STAGES: readonly DunningStage[] = [
  { id: 'R1', label: 'Rappel courtois', minDaysOverdue: 1 },
  { id: 'R2', label: 'Relance ferme', minDaysOverdue: 15 },
  { id: 'R3', label: 'Relance finale amiable', minDaysOverdue: 45 },
];

/** Quiet hours: no SCHEDULED dunning launches 19:00 → 08:00 (Algeria, UTC+1). */
export const KREDY_QUIET_START_HOUR = 19;
export const KREDY_QUIET_END_HOUR = 8;
export const ALGERIA_UTC_OFFSET_MINUTES = 60;

/**
 * A dunning claim older than this is treated as crashed and may be re-taken
 * (the claim row parks as `PLANIFIEE` between claim and launch result).
 */
export const KREDY_DUNNING_STALE_CLAIM_MS = 10 * 60_000;

/**
 * The ONLY status a `whatsapp_launches` row may carry. The UI never says
 * "Envoyé": a blocked popup produces no row at all, so "Lancé" is a fact.
 */
export const KREDY_LAUNCH_STATUS = 'Lancé';

/**
 * The next ladder stage that may launch: strictly the first stage not yet in
 * `launchedStages` (never skips), and only when it is overdue-eligible. One
 * launch per stage is enforced caller-side by the unique
 * `(customer_id, stage)` index; this function additionally refuses to jump.
 */
export function nextDunningStage(input: {
  launchedStages: readonly string[];
  daysOverdue: number;
}): DunningStage | null {
  const launched = new Set(input.launchedStages.map((s) => String(s || '').toUpperCase()));
  for (const stage of DUNNING_STAGES) {
    if (launched.has(stage.id)) continue;
    return input.daysOverdue >= stage.minDaysOverdue ? stage : null;
  }
  return null;
}

/** Local (Algeria) hour for an ISO instant — null when the clock is unreadable. */
export function localHourAt(nowIso: string): number | null {
  const ms = parseIsoMs(nowIso);
  if (ms == null) return null;
  return new Date(ms + ALGERIA_UTC_OFFSET_MINUTES * 60_000).getUTCHours();
}

/**
 * Quiet-hours gate for scheduled dunning. Fails closed on an unreadable
 * clock. `nextAllowedIso` is the next 08:00 local boundary (today or
 * tomorrow) so the UI can say exactly when a launch becomes possible.
 */
export function dunningLaunchGate(nowIso: string): {
  allowed: boolean;
  reason?: 'QUIET_HOURS' | 'INVALID_CLOCK';
  localHour: number | null;
  nextAllowedIso: string | null;
} {
  const ms = parseIsoMs(nowIso);
  const hour = localHourAt(nowIso);
  if (ms == null || hour == null) {
    return { allowed: false, reason: 'INVALID_CLOCK', localHour: null, nextAllowedIso: null };
  }
  if (hour >= KREDY_QUIET_START_HOUR || hour < KREDY_QUIET_END_HOUR) {
    const offsetMs = ALGERIA_UTC_OFFSET_MINUTES * 60_000;
    const localMs = ms + offsetMs;
    const dayStartLocal = Math.floor(localMs / DAY_MS) * DAY_MS;
    const nextLocal =
      hour < KREDY_QUIET_END_HOUR
        ? dayStartLocal + KREDY_QUIET_END_HOUR * 3_600_000
        : dayStartLocal + DAY_MS + KREDY_QUIET_END_HOUR * 3_600_000;
    return {
      allowed: false,
      reason: 'QUIET_HOURS',
      localHour: hour,
      nextAllowedIso: new Date(nextLocal - offsetMs).toISOString(),
    };
  }
  return { allowed: true, localHour: hour, nextAllowedIso: null };
}
