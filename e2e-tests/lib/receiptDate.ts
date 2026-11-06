/**
 * Receipt-date oracle (test-side yardstick, L0).
 *
 * The receipt's `Date:` line is printed by `formatReceiptDateTime` as
 * `DD/MM/YYYY HH:MM:SS` (shop-local, fr-DZ). The printed day — not the
 * receipt NUMBER — is the user-visible date surface: numbering moved to the
 * `PREFIX-SERIES-SEQ6` scheme (src/utils/ids.ts:newDocumentNumber), so the
 * legacy `REC-YYYYMMDD-…` token no longer exists. Parsing the printed line
 * keeps TIM-03 measuring the same three date assertions.
 *
 * Day-first is the product's format, not the host locale's: `31/12/2026`
 * must be 2026-12-31, never 2026-31-12.
 *
 * Run pins: node --import ./scripts/ts-resolve-hook.mjs \
 *   --experimental-strip-types e2e-tests/lib/receiptDate.test.mts
 */

/** YYYYMMDD of the printed `Date:` line, or '?' when the line carries none. */
export function receiptDayFromPrintedLine(line: string): string {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(line ?? '');
  if (!m) return '?';
  return `${m[3]}${m[2]}${m[1]}`;
}
