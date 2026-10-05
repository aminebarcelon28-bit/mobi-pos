import type { Customer, SaleTransaction } from '../types/pos';
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

/**
 * Per-lane refresh guard (C3: STATE-001): a rejected fetch resolves to the
 * previous slice value with a loud warning instead of aborting a 16-table
 * refresh and freezing the whole UI on stale data. Callers keep the
 * destructured names; each line just wraps its fetch.
 */
export async function settleRefreshValue<T>(
  lane: string,
  work: Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await work;
  } catch (err) {
    console.warn(`[refresh] ${lane} failed, keeping previous data:`, err);
    return fallback;
  }
}

export interface StoreSelections {
  currentCustomer: Customer | null;
  selectedTransactionForRefund: SaleTransaction | null;
}

/**
 * Selection rebase after any customer/transaction reload (C3: STATE-003):
 * a selected entity that still exists is refreshed to the new object; one
 * that vanished (peer delete) clears to null instead of acting on a ghost;
 * an empty fresh list means the fetch failed over to previous data, so
 * selections are kept untouched. Pure and unit-tested.
 */
export function rebaseStoreSelections(
  freshCustomers: ReadonlyArray<Customer>,
  freshTransactions: ReadonlyArray<{ id: string }>,
  selected: StoreSelections,
): StoreSelections {
  const txIds = new Set((freshTransactions ?? []).map((t) => t?.id).filter(Boolean));
  const keepOnEmpty = txIds.size === 0;
  let currentCustomer = selected.currentCustomer;
  if (currentCustomer && !keepOnEmpty) {
    const rebased = (freshCustomers ?? []).find((c) => c?.id === currentCustomer?.id);
    currentCustomer = rebased ?? null;
  }
  let selectedTransactionForRefund = selected.selectedTransactionForRefund;
  if (selectedTransactionForRefund && !keepOnEmpty) {
    selectedTransactionForRefund = txIds.has(selectedTransactionForRefund.id)
      ? selectedTransactionForRefund
      : null;
  }
  return { currentCustomer, selectedTransactionForRefund };
}
