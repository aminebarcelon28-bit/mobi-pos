/**
 * Shared database adapter primitives and environment helpers.
 */

export interface DbStats {
  db_path: string;
  db_size_bytes: number;
  wal_size_bytes: number;
  page_count: number;
  page_size: number;
  journal_mode: string;
  synchronous: string;
  foreign_keys: boolean;
  total_products: number;
  total_customers: number;
  total_transactions: number;
  total_repair_orders: number;
  total_purchase_orders: number;
  integrity_status: string;
}

export interface IntegrityReport {
  is_healthy: boolean;
  integrity_messages: string[];
  foreign_key_violations: string[];
  checked_at: string;
}

export const isTauriEnv = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
};

import type { GenericEntity } from '../sqlPluginAdapter';

// Full-sync disaster-recovery lane: every entity change is enqueued as JSON
// after its Dexie mirror lands. Fire-and-forget by design — use `void`.
export async function fireSync(entity: GenericEntity, id: string, syncPayload: unknown): Promise<void> {
  try {
    const { enqueueGenericSync } = await import('../sqlPluginAdapter');
    const { syncManager } = await import('../../sync/SyncManager');
    await enqueueGenericSync(entity, id, (syncPayload ?? {}) as Record<string, unknown>);
    syncManager.notifyLocalWrite();
  } catch (e) {
    console.warn(`Sync enqueue skipped [${entity}]:`, e);
  }
}

export async function fireSyncDelete(entity: GenericEntity, id: string): Promise<void> {
  try {
    const { enqueueGenericDelete } = await import('../sqlPluginAdapter');
    const { syncManager } = await import('../../sync/SyncManager');
    await enqueueGenericDelete(entity, id);
    syncManager.notifyLocalWrite();
  } catch (e) {
    console.warn(`Sync delete enqueue skipped [${entity}]:`, e);
  }
}
