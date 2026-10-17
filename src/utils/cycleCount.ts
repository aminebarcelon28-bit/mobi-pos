/**
 * UPGRADE-10 — Scheduled ABC micro-stocktakes: pure arithmetic.
 *
 * A cycle-count task freezes the expectation at open time:
 *   expected = snapshot_qty + Σ(ledger deltas since the open watermark,
 *              excluding other ADJUST corrections)
 * so a sale (or void, or receive) that happens between task open and submit
 * is carried by the expected figure instead of being booked as phantom
 * shrinkage/gain at validation. Everything here is clock-injected and pure —
 * no wall-clock reads, no IO — so the oracles can replay any timeline.
 *
 * Cadence (industry cycle-count): A = 30 d, B = 90 d, C = 365 d. A-class =
 * serialized (IMEI-tracked) or high-value items; the shipped thresholds are
 * pinned by the suite and re-tuned only by an explicit owner decision.
 */

export type AbcClass = 'A' | 'B' | 'C';

/** Retail-value floors (DZD) that split B/C and A/B. */
export const ABC_A_MIN_PRICE_DZD = 20000;
export const ABC_B_MIN_PRICE_DZD = 5000;

/** Count cadence per class, in days. */
export const ABC_CADENCE_DAYS: Record<AbcClass, number> = { A: 30, B: 90, C: 365 };

/** Ledger reason excluded from task expectations: corrections, not movements. */
export const CYCLE_COUNT_EXCLUDED_REASON = 'ADJUST';

export interface CycleCountProductLike {
  id: string;
  price?: number | null;
  isSerialized?: boolean | null;
}

export interface LedgerMovementLike {
  delta: number;
  reason: string;
}

export interface DueCycleProduct {
  productId: string;
  abcClass: AbcClass;
  dueAt: string;
}

export interface CycleCountSubmissionResult {
  taskId: string;
  productId: string;
  countedQty: number;
  expectedQty: number;
  varianceQty: number;
}

export interface CycleCountSubmitOutcome {
  submitted: number;
  skipped: number;
  varianceUnits: number;
  results: CycleCountSubmissionResult[];
}

/** Fail toward counting: an unknown class is the slowest cadence, never a skip. */
export function normalizeAbcClass(value: unknown): AbcClass {
  const s = String(value ?? '').trim().toUpperCase();
  return s === 'A' || s === 'B' || s === 'C' ? s : 'C';
}

/**
 * Integer-safe coercion for quantities read from SQLite (INTEGER columns and
 * sums). Never NaN, never fractional. Lives here rather than in the repo lane
 * because the money-boundary registry counts `Math.*` primitives per file
 * (counts may only decrease) — quantity math belongs in this pure engine.
 */
export function toIntQty(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Classify a product for cadence purposes. Serialized (IMEI-tracked) items
 * are always A — their units are individually traceable and pilferage-prone;
 * otherwise the retail-value floors apply.
 */
export function abcClassForProduct(p: Pick<CycleCountProductLike, 'price' | 'isSerialized'>): AbcClass {
  if (p?.isSerialized === true) return 'A';
  const price = Number(p?.price ?? 0);
  if (!Number.isFinite(price)) return 'C';
  if (price >= ABC_A_MIN_PRICE_DZD) return 'A';
  if (price >= ABC_B_MIN_PRICE_DZD) return 'B';
  return 'C';
}

export function cadenceDaysFor(cls: AbcClass): number {
  return ABC_CADENCE_DAYS[normalizeAbcClass(cls)];
}

/** ISO-8601 UTC day arithmetic on an explicit input instant (no wall clock). */
export function addDaysIso(nowIso: string, days: number): string {
  const t = Date.parse(nowIso);
  if (!Number.isFinite(t)) return nowIso;
  return new Date(t + Math.trunc(days) * 86_400_000).toISOString();
}

/** The next due instant for a task opened now. */
export function nextDueIso(nowIso: string, cls: AbcClass): string {
  return addDaysIso(nowIso, cadenceDaysFor(cls));
}

/**
 * Due when never counted, or when the cadence elapsed since the last count.
 * Unparseable timestamps read as due (never silently skip a count).
 */
export function isTaskDue(
  lastCountedAt: string | null | undefined,
  cls: AbcClass,
  nowIso: string
): boolean {
  if (!lastCountedAt) return true;
  const last = Date.parse(lastCountedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return true;
  return now >= last + cadenceDaysFor(cls) * 86_400_000;
}

/** Σ of movement deltas, excluding ADJUST corrections (and non-numeric noise). */
export function sumMovementDeltas(movements: LedgerMovementLike[] | null | undefined): number {
  let sum = 0;
  for (const m of movements ?? []) {
    if (String(m?.reason ?? '').trim().toUpperCase() === CYCLE_COUNT_EXCLUDED_REASON) continue;
    const d = Number(m?.delta ?? 0);
    if (Number.isFinite(d)) sum += Math.trunc(d);
  }
  return sum;
}

/**
 * Expected on-hand at submit: the open-time snapshot plus every movement that
 * happened since the open watermark. The repo lane passes the already-summed
 * total (the SQL applies the same ADJUST exclusion + rowid watermark).
 */
export function expectedQtyFromMovedTotal(snapshotQty: number, movedTotalExcludingAdjust: number): number {
  const snap = Math.trunc(Number(snapshotQty) || 0);
  const moved = Math.trunc(Number(movedTotalExcludingAdjust) || 0);
  return snap + moved;
}

export function computeExpectedQty(
  snapshotQty: number,
  movements: LedgerMovementLike[] | null | undefined
): number {
  return expectedQtyFromMovedTotal(snapshotQty, sumMovementDeltas(movements));
}

/** Counted − expected. Zero means the count agrees with the booked reality. */
export function computeVarianceQty(countedQty: number, expectedQty: number): number {
  const counted = Math.trunc(Number(countedQty) || 0);
  const expected = Math.trunc(Number(expectedQty) || 0);
  return counted - expected;
}

/**
 * The ONLY items a cycle-count submit may hand to `appendStocktakeAdjustments`:
 * submitted tasks whose snapshot-arithmetic variance is non-zero. A variance of
 * zero books nothing — a sale between open and submit is already inside the
 * expected figure, so it must never mint a phantom ADJUST row.
 */
export function selectBookingItems(
  results: CycleCountSubmissionResult[] | null | undefined
): Array<{ productId: string; countedStock: number }> {
  return (results ?? [])
    .filter((r) => Number.isFinite(Number(r?.varianceQty)) && Math.trunc(Number(r.varianceQty)) !== 0)
    .map((r) => ({
      productId: String(r.productId ?? ''),
      countedStock: Math.max(0, Math.trunc(Number(r.countedQty) || 0)),
    }))
    .filter((b) => b.productId !== '');
}

/**
 * Products due for a count: no open task yet AND cadence elapsed since the
 * last completed count (never-counted products are due immediately).
 * Deterministic order: A first, then soonest due, then id.
 */
export function selectDueProducts(
  products: CycleCountProductLike[] | null | undefined,
  lastCountedAtByProduct: Map<string, string> | null | undefined,
  openTaskProductIds: Set<string> | null | undefined,
  nowIso: string
): DueCycleProduct[] {
  const lastCounted = lastCountedAtByProduct ?? new Map<string, string>();
  const open = openTaskProductIds ?? new Set<string>();
  const due: DueCycleProduct[] = [];
  for (const p of products ?? []) {
    const productId = String(p?.id ?? '');
    if (!productId || open.has(productId)) continue;
    const cls = abcClassForProduct(p);
    if (!isTaskDue(lastCounted.get(productId) ?? null, cls, nowIso)) continue;
    const lastAt = lastCounted.get(productId);
    const dueAt = lastAt ? addDaysIso(lastAt, cadenceDaysFor(cls)) : nowIso;
    due.push({ productId, abcClass: cls, dueAt });
  }
  const classRank: Record<AbcClass, number> = { A: 0, B: 1, C: 2 };
  due.sort(
    (a, b) =>
      classRank[a.abcClass] - classRank[b.abcClass] ||
      a.dueAt.localeCompare(b.dueAt) ||
      a.productId.localeCompare(b.productId)
  );
  return due;
}
