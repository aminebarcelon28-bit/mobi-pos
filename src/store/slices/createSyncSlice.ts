import type { StateCreator } from 'zustand';
import type { PosState, SyncSlice } from '../types';

/**
 * Signed-lane sync health (MOBI-SYNC-DRAIN-TRANSPORT). Mirrors the drain
 * worker's telemetry into Zustand so drawers/badges render without importing
 * the worker graph (P11.3: the worker pulls the sql adapter + gateway).
 * Counts are signed-lane only (`seq_no IS NOT NULL`); the Turso badge keeps
 * the global totals via `useSyncStatus`.
 */
export const SYNC_BACKLOG_WARN_AT = 500;

export const createSyncSlice: StateCreator<PosState, [], [], SyncSlice> = (set, get) => ({
  outboxPendingCount: 0,
  outboxInFlightCount: 0,
  isSyncing: false,
  lastDrainAt: null,
  lastDrainError: null,
  drainArmed: false,

  startSyncDrain: () => {
    void (async () => {
      const { startSyncDrain } = await import('../../db/adapters/syncDrainWorker');
      startSyncDrain({
        onHealth: (h) => {
          const s = get();
          if (
            s.outboxPendingCount !== h.pending ||
            s.outboxInFlightCount !== h.inflight ||
            s.isSyncing !== h.syncing ||
            s.lastDrainAt !== h.lastDrainAt ||
            s.lastDrainError !== h.lastError ||
            s.drainArmed !== h.armed
          ) {
            set({
              outboxPendingCount: h.pending,
              outboxInFlightCount: h.inflight,
              isSyncing: h.syncing,
              lastDrainAt: h.lastDrainAt,
              lastDrainError: h.lastError,
              drainArmed: h.armed,
            });
          }
        },
      });
    })();
  },

  stopSyncDrain: () => {
    void (async () => {
      const { stopSyncDrain } = await import('../../db/adapters/syncDrainWorker');
      stopSyncDrain();
      set({ isSyncing: false });
    })();
  },

  refreshSyncHealth: async () => {
    try {
      const { getLocalDb } = await import('../../db/sqlPluginAdapter');
      const db = await getLocalDb();
      const p = (await db
        .select("SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'pending' AND seq_no IS NOT NULL")
        .catch(() => [])) as Array<{ n: number }>;
      const f = (await db
        .select("SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'inflight' AND seq_no IS NOT NULL")
        .catch(() => [])) as Array<{ n: number }>;
      set({
        outboxPendingCount: Number(p?.[0]?.n ?? 0),
        outboxInFlightCount: Number(f?.[0]?.n ?? 0),
      });
    } catch {
      // Telemetry only — never fails a caller.
    }
  },
});
