import { useEffect, useState } from 'react';

/**
 * Frozen receipt COGS from `sale_batch_allocations` (STRICT LEDGER, v104).
 *
 * Receipt surfaces (ticket inspector, reprints) must derive COGS as
 * SUM(qty_consumed × unit_cost_at_sale) for the sale — never by pricing
 * `item.costPrice` / `product.referenceCost` on the fly (that path printed
 * 6,200 for a 6,100 ticket: 400×2 instead of 500+400).
 *
 * Resolution order per ticket: SQLite authority (`getAllocationCogsForSale`)
 * → targeted single-ticket backfill (a sale that missed the boot/pull
 * backfill still converges on view) → re-query → Dexie
 * `saleBatchAllocations` mirror (web preview / lock contention).
 *
 * Race discipline (the #REC-20260926-13HQ1J-02-CAAF5 class):
 * - `ledgerLoaded` is false until the CURRENT saleId resolves. Callers MUST
 *   render pending while `!loaded` — rendering the stored row meanwhile
 *   flashes the stale 6,200 profit.
 * - State is keyed by saleId: switching tickets never shows the previous
 *   ticket's COGS (the resolved value is only returned when it belongs to
 *   the requested key).
 * - `ledgerCogs: null` with `loaded: true` means the ticket genuinely has
 *   no ledger rows — only then may callers fall back to the stored row.
 * Never throws, never blocks render.
 */
export function useReceiptLedgerCogs(saleId: string | undefined): {
  ledgerCogs: number | null;
  ledgerLoaded: boolean;
} {
  const [state, setState] = useState<{ key: string; cogs: number | null; loaded: boolean }>({
    key: '',
    cogs: null,
    loaded: false,
  });
  const key = String(saleId ?? '');

  useEffect(() => {
    if (!key) {
      setState({ key: '', cogs: null, loaded: true });
      return;
    }
    let cancelled = false;
    const sumMirrorRows = (rows: Array<{
      qtyConsumed?: unknown;
      unitCostAtSale?: unknown;
      deleted?: unknown;
    }> | null | undefined): { cogs: number; count: number } => {
      const live = (rows ?? []).filter((r) => Number(r.deleted ?? 0) === 0);
      let sum = 0;
      for (const r of live) {
        sum += Math.max(0, Math.floor(Number(r.qtyConsumed ?? 0))) * Math.max(0, Number(r.unitCostAtSale ?? 0));
      }
      return { cogs: Math.round(sum), count: live.length };
    };
    (async () => {
      // 1. SQLite authority (Tauri).
      try {
        const { getAllocationCogsForSale, backfillSaleAllocationsForSale } = await import(
          '../db/sqlPluginAdapter'
        );
        const first = await getAllocationCogsForSale(key);
        if (!cancelled && first) {
          setState({ key, cogs: first.cogs, loaded: true });
          return;
        }
        // Miss: the sale may have skipped the boot/pull backfill — repair
        // this one ticket, then re-read before falling back anywhere.
        if (!cancelled) {
          await backfillSaleAllocationsForSale(key).catch(() => 0);
          const second = await getAllocationCogsForSale(key).catch(() => null);
          if (!cancelled && second) {
            setState({ key, cogs: second.cogs, loaded: true });
            return;
          }
        }
      } catch {
        // No SQLite (web preview) or lock — fall through to the mirror.
      }
      // 2. Dexie offline mirror.
      try {
        const { dexieDb } = await import('../db/database');
        const rows = await dexieDb.saleBatchAllocations
          .where('saleId')
          .equals(key)
          .toArray()
          .catch(() => []);
        if (cancelled) return;
        const { cogs, count } = sumMirrorRows(rows);
        setState({ key, cogs: count > 0 ? cogs : null, loaded: true });
      } catch {
        if (!cancelled) setState({ key, cogs: null, loaded: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (state.key !== key) return { ledgerCogs: null, ledgerLoaded: false };
  return { ledgerCogs: state.cogs, ledgerLoaded: state.loaded };
}
