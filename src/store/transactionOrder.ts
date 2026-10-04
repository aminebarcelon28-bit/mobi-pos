import type { SaleTransaction } from '../types/pos';
import { sortTransactionsNewestFirst } from '../utils/dateUtils';

/**
 * Centralized Zustand `transactions` writer (ordering hardening).
 *
 * Every mutation endpoint that commits a `transactions` array — live sale,
 * void, refund, boot hydrate, pull refresh — must pass its array through
 * here so the store invariant (newest-first per the canonical comparator in
 * `utils/dateUtils.ts`) holds across sessions. Previously live sales
 * prepended while boot/pull rehydrated unordered Dexie `toArray()` output,
 * so the list order flipped between sessions and the refund panel's
 * `slice(0, 30)` amputated the newest receipts.
 *
 * Non-mutating: returns a new sorted array, never reorders the input.
 */
export function sortedTransactions(
  list: readonly SaleTransaction[] | undefined | null,
): SaleTransaction[] {
  return sortTransactionsNewestFirst(list ?? []);
}
