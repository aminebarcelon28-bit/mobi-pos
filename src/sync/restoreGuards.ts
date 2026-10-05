/**
 * Restore source assessment (SYNC-012) — pure predicates over per-table
 * row counts. Zero dependencies (importable from node tests).
 *
 * Context: no merchant identity exists on either end of the sync (no
 * tenant/merchant column local or remote), so a foreign non-empty DB
 * cannot be distinguished cryptographically — that is gateway/enrollment
 * work (same class as A1 per-device credentials), not a local check.
 * What IS enforceable locally:
 * - emptiness must span ALL user-data tables, not just transactions +
 *   products (a customers/debts/vouchers/batches-only device was deemed
 *   "empty" and took the wrong branch);
 * - an empty-but-valid source merged into a non-empty device is a no-op
 *   that must SAY SO in the summary (wrong-DB suspicion starts here);
 * - per-table source counts ride the restore summary so a foreign merge
 *   is visible in audit/UI instead of a bare "N restored" line.
 */

export const RESTORE_DATA_TABLES: readonly string[] = [
  'transactions',
  'products',
  'customers',
  'customer_debts',
  'credit_vouchers',
  'stock_batches',
];

/** True when ANY user-data table holds rows (device is not fresh). */
export function hasLocalRestoreData(counts: Record<string, unknown>): boolean {
  for (const table of RESTORE_DATA_TABLES) {
    const n = Number((counts as Record<string, unknown>)[table] ?? 0);
    if (Number.isFinite(n) && n > 0) return true;
  }
  return false;
}

/** True when the source holds no rows anywhere (fresh/empty cloud). */
export function isSourceEmpty(counts: Record<string, unknown>): boolean {
  return !hasLocalRestoreData(counts);
}
