/**
 * Boot/post-pull status reconciler (C1: DB-011).
 *
 * The void/refund lanes commit Dexie first and SQLite second, in separate
 * transactions on separate engines — no distributed atomicity is possible,
 * so a kill between the phases leaves the mirrors diverged. This module
 * converges them on every boot and after every pull refresh, with SQLite
 * as the authority:
 *
 * - SQLite terminal (VOIDED / REFUNDED / PARTIALLY_REFUNDED) + Dexie
 *   different → heal the Dexie row to the authority + audit. Missing Dexie
 *   rows are remirror/backfill territory, not this module's.
 * - Dexie terminal + SQLite missing-or-not-terminal → ALERT ONLY (audit
 *   entry). The healer never writes money state: flipping SQLite from a
 *   mirror would invent durability the authority never had. That direction
 *   needs a slice-level retry, not a reconciler.
 * - Everything else (COMPLETED both sides, missing Dexie rows) → agree/skip.
 *
 * All stores are injected lists/accessors, so the whole decision table
 * unit-tests without Dexie, SQLite, or Tauri. Production callers pass the
 * already-in-memory transaction list as the mirror projection (zero extra
 * I/O on the boot path) and Dexie point reads only for rows that heal.
 */

export type TerminalStatus = 'VOIDED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';

const TERMINAL = new Set<string>(['VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED']);

export function isTerminalStatus(status: unknown): status is TerminalStatus {
  return typeof status === 'string' && TERMINAL.has(status);
}

export interface StatusRow {
  id: string;
  status?: unknown;
}

export interface ReconcileStores {
  /** Authority projection: light {id,status} scan. */
  sqliteRows: StatusRow[];
  /** Mirror projection: light {id,status} list (caller slices it). */
  dexieRows: StatusRow[];
  /** Full mirror row by id (needed to preserve fields on heal writes). */
  getDexieFull: (id: string) => Promise<(StatusRow & Record<string, unknown>) | undefined>;
  /** Mirror write (healed row). */
  putDexie: (row: StatusRow & Record<string, unknown>) => Promise<void>;
  /** Audit sink. */
  fileAudit: (action: string, details: string) => Promise<unknown>;
}

export interface ReconcileOutcome {
  checked: number;
  healed: string[];
  alerts: string[];
}

function rowStatus(row: StatusRow | undefined): string {
  return typeof row?.status === 'string' ? row.status : '';
}

/**
 * Production entry: reconcile the freshly hydrated mirror against the
 * SQLite authority. All heavy imports are lazy so this module stays
 * dependency-free for tests; callers `void` it after every hydrate
 * (boot wave-2, post-pull refresh) so it never delays paint.
 * Dexie IS the authority in web preview (no SQLite lane) — no-op there.
 */
export async function reconcileAfterHydrate(
  mirrorTransactions: Array<{ id: string; status?: unknown }>,
): Promise<ReconcileOutcome> {
  const empty: ReconcileOutcome = { checked: 0, healed: [], alerts: [] };
  try {
    const base = await import('./adapters/base');
    if (!base.isTauriEnv()) return empty;
    const { getLocalDb } = await import('./sqlPluginAdapter');
    const db = await getLocalDb().catch(() => null);
    if (!db) return empty;
    const sqliteRows = (await db
      .select('SELECT id, status FROM transactions')
      .catch(() => [])) as StatusRow[];
    if (!Array.isArray(sqliteRows) || sqliteRows.length === 0) return empty;
    const database = await import('./database');
    const dexieDb = database.db;
    const { usePosStore } = await import('../store/usePosStore');
    const outcome = await reconcileTransactionStatus({
      sqliteRows,
      dexieRows: (mirrorTransactions ?? []).map((t) => ({ id: String(t?.id ?? ''), status: t?.status })),
      getDexieFull: async (id: string) =>
        (await (dexieDb.transactions.get(id) as Promise<unknown>).catch(() => undefined)) as
          | (StatusRow & Record<string, unknown>)
          | undefined,
      putDexie: async (row: StatusRow & Record<string, unknown>) => {
        await (dexieDb.transactions.put as (r: unknown) => Promise<unknown>)(row);
      },
      fileAudit: async (action: string, details: string) => {
        await usePosStore.getState().logSecurityAction(action, details, 'Système', false);
      },
    });
    if (outcome.healed.length > 0 || outcome.alerts.length > 0) {
      console.warn(
        `[statusReconcile] healed=[${outcome.healed.join(',')}] alerts=[${outcome.alerts.join(',')}]`,
      );
    }
    return outcome;
  } catch {
    return empty;
  }
}

/**
 * One reconciliation pass, both directions. Returns counts + ids; never
 * throws (a broken comparison must not fail boot — it warns and reports
 * what it managed).
 */
export async function reconcileTransactionStatus(stores: ReconcileStores): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = { checked: 0, healed: [], alerts: [] };
  try {
    const sqliteById = new Map<string, string>();
    for (const row of stores.sqliteRows ?? []) {
      if (!row || typeof row.id !== 'string' || !row.id) continue;
      sqliteById.set(row.id, rowStatus(row));
    }
    const dexieById = new Map<string, string>();
    for (const row of stores.dexieRows ?? []) {
      if (!row || typeof row.id !== 'string' || !row.id) continue;
      if (!dexieById.has(row.id)) dexieById.set(row.id, rowStatus(row));
    }

    // Forward: authority terminal, mirror differs → heal mirror + audit.
    for (const [id, authStatus] of sqliteById) {
      if (!isTerminalStatus(authStatus)) continue;
      outcome.checked += 1;
      const mirrorStatus = dexieById.get(id);
      if (mirrorStatus === undefined) continue; // presence is remirror's job.
      if (mirrorStatus === authStatus) continue;
      try {
        const full = await stores.getDexieFull(id).catch(() => undefined);
        if (!full) continue;
        await stores.putDexie({ ...full, status: authStatus });
        outcome.healed.push(id);
        try {
          await stores.fileAudit(
            'Réconciliation miroir (statut)',
            `Ticket ${id} : miroir local ${mirrorStatus || 'inconnu'} → ${authStatus} (référence SQLite). Divergence résiduelle d'une écriture interrompue.`,
          );
        } catch {
          // Audit best-effort; the heal itself is durable.
        }
      } catch {
        continue;
      }
    }

    // Reverse: mirror terminal while authority is missing-or-not-terminal →
    // alert only. A missing authority row is the crash window itself (the
    // mirror committed, SQLite never saw the write) — skipping it would
    // hide exactly what this module exists to surface. Never writes money
    // state (see module doc).
    for (const [id, mirrorStatus] of dexieById) {
      if (!isTerminalStatus(mirrorStatus)) continue;
      const authStatus = sqliteById.get(id);
      if (authStatus !== undefined && isTerminalStatus(authStatus)) continue;
      outcome.alerts.push(id);
      try {
        await stores.fileAudit(
          'Divergence miroir→autorité (statut)',
          `Ticket ${id} : miroir ${mirrorStatus} mais autorité SQLite ${authStatus || 'absente'}. ` +
            `Réconciliation automatique refusée (écrirait un état financier non durable) — rejouez l'opération depuis l'écran d'origine.`,
        );
      } catch {
        // Audit best-effort.
      }
    }
  } catch {
    // A broken pass must never fail boot.
  }
  return outcome;
}
