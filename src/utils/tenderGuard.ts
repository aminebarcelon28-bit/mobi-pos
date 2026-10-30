/**
 * Fat-finger cash-tender guard ([MNY-29]).
 *
 * Observed: a 50 000 DA tender on a 500 DA ticket (100×) committed silently —
 * `cash_tendered=50000`, `change_due=49500`, receipt printed. The money math
 * was correct; nothing asked the cashier whether they meant it.
 *
 * The rule needs BOTH terms:
 *  - a RATIO, because a fixed amount either nags on legitimate big sales or
 *    misses a 100× on a small ticket;
 *  - an absolute FLOOR on the TENDERED amount, because a pure ratio nags on
 *    ordinary small sales (a 50 DA item paid with a 1 000 DA note is 20×, and
 *    that is normal cash behaviour). The floor must be on the tender, never on
 *    the ticket total — a floor on the total would skip the very 500 DA ticket
 *    that exposed this bug.
 *
 * Owner-set 2026-10-30: `tendered > 10 × total AND tendered ≥ 5 000 DA`.
 * Adjust `FAT_FINGER_FLOOR_DA` to the shop's normal large payments if needed;
 * the ratio is the part that scales.
 *
 * Zero/refund tickets are excluded: `total <= 0` has its own refund-due path
 * (`PaymentModal` disbursement branch), which must never be gated as a typo.
 */
export const FAT_FINGER_RATIO = 10;
export const FAT_FINGER_FLOOR_DA = 5_000;

export function isFatFingerTender(tenderedDa: number, totalDa: number): boolean {
  if (!Number.isFinite(tenderedDa) || !Number.isFinite(totalDa)) return false;
  const tendered = Math.round(tenderedDa);
  const total = Math.round(totalDa);
  if (tendered <= 0 || total <= 0) return false;
  if (tendered < FAT_FINGER_FLOOR_DA) return false;
  return tendered > total * FAT_FINGER_RATIO;
}
