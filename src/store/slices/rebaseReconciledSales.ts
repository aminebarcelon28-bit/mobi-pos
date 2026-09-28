import type { PosState } from '../types';

/**
 * Rebase in-memory `transactions` corrected by reconcileShadowBatches().
 *
 * Invoice receipts insert real batches, which may retroactively correct
 * older SHADOW sales (SQLite row + Dexie mirror + outbox are already durable
 * at that point). An open ticket inspector reads the Zustand mirror, so
 * without this it keeps showing pre-reconcile COGS until the next
 * boot/pull refresh. Best-effort and non-throwing: drains the ids published
 * by the adapter, re-reads the freshly reconstructed Dexie rows, and merges
 * them over (never under) the in-memory state.
 */
export async function rebaseReconciledSales(
  get: () => PosState,
  set: (partial: Partial<PosState>) => void,
): Promise<void> {
  try {
    const { drainReconciledSaleIds } = await import('../../db/sqlPluginAdapter');
    const touched = drainReconciledSaleIds();
    if (touched.length === 0) return;
    const { dexieDb } = await import('../../db/database');
    const rows = await dexieDb.transactions.bulkGet(touched).catch(() => []);
    const fresh = new Map<string, NonNullable<(typeof rows)[number]>>();
    for (const r of rows ?? []) {
      if (r && typeof r.id === 'string' && r.id) fresh.set(r.id, r);
    }
    if (fresh.size === 0) return;
    const { transactions } = get();
    const known = new Set(transactions.map((t) => t.id));
    set({
      transactions: [
        ...transactions.map((t) => {
          const f = fresh.get(t.id);
          return f ? { ...t, ...f } : t;
        }),
        ...[...fresh.values()].filter((r) => !known.has(r.id)),
      ],
    });
  } catch {
    // Best-effort mirror rebase — durable layers are already correct and the
    // next boot/pull refresh converges regardless.
  }
}
