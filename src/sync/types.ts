// Shared sync types (single-store, one Turso DB).

export type SyncEntityType =
  | 'product' | 'order' | 'order_item' | 'ledger' | 'customer'
  | 'repair_order' | 'purchase_order' | 'trade_in' | 'imei' | 'audit_log'
  | 'cash_drop' | 'bundle' | 'customer_debt' | 'store_expense'
  | 'cash_session' | 'cash_movement' | 'setting';

export type OutboxStatus = 'pending' | 'inflight' | 'synced' | 'failed';

export interface OutboxRow {
  rowid?: number;
  idempotency_key: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: 'UPSERT' | 'DELETE';
  payload_json: string;
  status: OutboxStatus;
  retry_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncToken {
  url: string;
  token: string;
  expiresAt: string;
}

export interface SyncEventLog {
  id: string;
  timestamp: string;
  type: 'push' | 'pull' | 'migration' | 'restore' | 'error' | 'quota' | 'info';
  summary: string;
  details?: Record<string, unknown>;
  level: 'info' | 'warn' | 'error' | 'success';
}

export interface SyncStatus {
  online: boolean;
  pushing: boolean;
  pulling: boolean;
  pendingCount: number;
  failedCount?: number;
  relayConnected?: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  quotaExceeded?: boolean;
}
