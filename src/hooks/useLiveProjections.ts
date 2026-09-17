// Reactive Projection Live Query Hooks — ES-LFP Phase P3
// Implements Authority ③ §7, Authority ③ §9, and AGENTS.md §1/§7.
//
// Performs high-speed (sub-millisecond) local reads directly against SQLite
// projection tables (`p_products`, `p_transactions`, `p_transaction_items`).
// Emits and listens to `pos:projection-changed` for instant reactive re-renders.

import { useState, useEffect, useCallback } from 'react';
import { getLocalDb } from '../db/sqlPluginAdapter.ts';

export interface ProjectedProductRow {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
  deleted: number;
  row_hlc: string;
  updated_at: string;
}

export interface ProjectedTransactionItemRow {
  tx_id: string;
  product_id: string;
  qty: number;
  unit_cents: number;
}

export interface ProjectedTransactionRow {
  id: string;
  total_cents: number;
  ts: string;
  row_hlc: string;
  device_id: string;
  items?: ProjectedTransactionItemRow[];
}

export const PROJECTION_CHANGE_EVENT = 'pos:projection-changed';

/**
 * Notify all live queries that one or more projections have updated.
 */
export function notifyProjectionsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROJECTION_CHANGE_EVENT));
  }
}

/**
 * Reactive hook querying products directly from SQLite `p_products`.
 */
export function useProjectedProducts(
  searchTerm?: string,
  options?: { onlyInStock?: boolean; limit?: number }
) {
  const [products, setProducts] = useState<ProjectedProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchProducts = useCallback(async () => {
    try {
      setLoading(true);
      const db = await getLocalDb();

      let sql = 'SELECT * FROM p_products WHERE deleted = 0';
      const params: unknown[] = [];

      if (searchTerm && searchTerm.trim()) {
        sql += ' AND name LIKE ?';
        params.push(`%${searchTerm.trim()}%`);
      }

      if (options?.onlyInStock) {
        sql += ' AND stock > 0';
      }

      sql += ' ORDER BY name ASC';

      if (options?.limit && options.limit > 0) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }

      const rows = (await db.select(sql, params).catch(() => [])) as ProjectedProductRow[];
      setProducts(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [searchTerm, options?.onlyInStock, options?.limit]);

  useEffect(() => {
    fetchProducts();

    const handler = () => {
      fetchProducts();
    };

    window.addEventListener(PROJECTION_CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener(PROJECTION_CHANGE_EVENT, handler);
    };
  }, [fetchProducts]);

  return { products, loading, error, refresh: fetchProducts };
}

/**
 * Reactive hook querying transactions directly from SQLite `p_transactions` & `p_transaction_items`.
 */
export function useProjectedTransactions(limit: number = 50) {
  const [transactions, setTransactions] = useState<ProjectedTransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchTransactions = useCallback(async () => {
    try {
      setLoading(true);
      const db = await getLocalDb();

      const txRows = (await db.select(
        'SELECT * FROM p_transactions ORDER BY ts DESC LIMIT ?;',
        [limit]
      ).catch(() => [])) as ProjectedTransactionRow[];

      if (txRows.length === 0) {
        setTransactions([]);
        setError(null);
        return;
      }

      // Fetch corresponding line items
      const txIds = txRows.map((t) => t.id);
      const placeholders = txIds.map(() => '?').join(',');
      const itemRows = (await db.select(
        `SELECT * FROM p_transaction_items WHERE tx_id IN (${placeholders});`,
        txIds
      ).catch(() => [])) as ProjectedTransactionItemRow[];

      const itemsByTx = new Map<string, ProjectedTransactionItemRow[]>();
      for (const item of itemRows) {
        const list = itemsByTx.get(item.tx_id) || [];
        list.push(item);
        itemsByTx.set(item.tx_id, list);
      }

      const combined = txRows.map((tx) => ({
        ...tx,
        items: itemsByTx.get(tx.id) || [],
      }));

      setTransactions(combined);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchTransactions();

    const handler = () => {
      fetchTransactions();
    };

    window.addEventListener(PROJECTION_CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener(PROJECTION_CHANGE_EVENT, handler);
    };
  }, [fetchTransactions]);

  return { transactions, loading, error, refresh: fetchTransactions };
}

