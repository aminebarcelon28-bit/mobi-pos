/**
 * Localized money-input parsing (FR/DZ conventions).
 *
 * `parseFloat` silently truncates French decimals ("12,50" -> 12), so every
 * user-facing money field must go through this instead.
 * Returns NaN when unparseable — callers keep their `|| 0` fallbacks.
 */
export function parseLocalizedAmount(input: unknown): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  const raw = String(input ?? '').trim();
  if (!raw) return NaN;
  // Strip grouping spaces (regular, NBSP, narrow NBSP) and apostrophes.
  const compact = raw.replace(/[\s\u00A0\u202F\u2009']/g, '');
  const hasComma = compact.includes(',');
  const hasDot = compact.includes('.');
  let norm = compact;
  if (hasComma && hasDot) {
    // French grouping: dots group thousands, comma is the decimal mark.
    // "12.500,50" -> "12500.50".
    // Refuse US-grouped input ("1,200.50", valid US = 1200.5) instead of
    // mangling it to 1.2005 (OBS-A4): a 1000x silent undercharge. Only
    // strict FR grouping (1-3 leading digits, dot-groups of exactly 3,
    // comma-decimal tail) is accepted here.
    if (!/^\d{1,3}(\.\d{3})+,\d+$/.test(compact)) return NaN;
    norm = compact.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    norm = compact.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(compact)) {
    // B-027: dot-only FR thousand grouping ("45.000", "1.000.000") —
    // previously misread as decimal (45) or rejected (NaN→0).
    norm = compact.replace(/\./g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(norm)) return NaN;
  const n = Number(norm);
  return Number.isFinite(n) ? n : NaN;
}

/** Integer minor units (DA): the single rounding point for parsed input. */
export function roundDAZ(n: number): number {
  return Math.round(n);
}
