import type { Customer, CustomerDebtEntry, LoyaltyLedgerEntry, LoyaltyProgramConfig } from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete, isTauriEnv } from './base';
import { isBusyError } from '../busyRetry';
import { normalizeAlgerianPhone } from '../../utils/phoneUtils';
import {
  normalizeLoyaltyConfig,
  reconcileMilestoneTranches,
  ensureCreditGenesis,
  healUnbackedHeadline,
} from '../../utils/loyaltyEngine';

/** Merchant loyalty config for hydration-time reconciliation (defaults when unreadable). */
async function readLoyaltyConfig(): Promise<LoyaltyProgramConfig> {
  try {
    const { settingsRepository } = await import('../../db/repositories/settingsRepository');
    const stored = await settingsRepository.get('mobi_pos_receipt_settings', null);
    const cfg = (stored as { loyaltyConfig?: unknown } | null)?.loyaltyConfig;
    return normalizeLoyaltyConfig(cfg);
  } catch {
    return normalizeLoyaltyConfig(undefined);
  }
}

/**
 * P2.3 hydration hook: catches multi-till spend leaps (offline merges that
 * leap past tranches neither till crossed) and anchors the ledger-derived
 * balance genesis. Idempotent via deterministic keys — re-running over an
 * already-swept ledger is a no-op. Changed rows persist through the
 * versioned save path so catch-up awards propagate to peers.
 */
async function reconcileLoyaltyState(list: Customer[]): Promise<Customer[]> {
  let cfg: LoyaltyProgramConfig;
  try {
    cfg = await readLoyaltyConfig();
  } catch {
    return list;
  }
  if (!cfg.enabled) return list;
  let changed = false;
  const out = list.map((c) => {
    if (!c || !c.id) return c;
    const ledger = c.ledger || [];
    const genesis = ensureCreditGenesis({ ...c, ledger });
    const withGenesis = genesis ? [genesis, ...ledger] : ledger;
    const sweep = reconcileMilestoneTranches(c.id, c.totalSpent || 0, cfg, withGenesis, 0);
    // G-07 heal: a headline must be backed by buckets (legacy rows and seeded
    // fixtures can carry points with no bucket). Pure + idempotent.
    const heal = healUnbackedHeadline(
      c.id,
      c.loyaltyPoints || 0,
      c.pointBuckets,
      cfg.pointRedemptionRate,
      new Date().toISOString(),
    );
    const healedBuckets = heal.buckets;
    const healed = heal.healed;
    if (!genesis && sweep.entries.length === 0 && !healed) return c;
    changed = true;
    return {
      ...c,
      storeCredit: (c.storeCredit || 0) + sweep.totalReward,
      pointBuckets: healedBuckets,
      ledger: [...sweep.entries, ...withGenesis],
    };
  });
  if (!changed) return list;
  for (const c of out) {
    if (!c || !c.id) continue;
    const orig = list.find((o) => o && o.id === c.id);
    if (orig !== c) {
      try {
        await customerAdapter.saveCustomer(c);
      } catch (err) {
        console.error(`[customer] loyalty reconcile persist failed for [${c.id}]:`, err);
      }
    }
  }
  return out;
}

export const customerAdapter = {
  async saveCustomer(customer: Customer): Promise<void> {
    // Version clock: SQLite is the sync authority. Deriving the next version
    // from the in-memory object (which often carries no `version` field — a
    // draft, a second tab, a rehydrated record) made Dexie, the SQLite row and
    // the pushed outbox payload disagree: the payload claimed v2 while the row
    // had advanced to v3, so a peer holding v3 rejected the cloud row and the
    // merchant's customer edit never converged. Read the authoritative value.
    //
    // A3 (DB-013): the read-then-write below is additionally guarded —
    // concurrent writers that both read v3 no longer both land v4. Each
    // attempt upserts only if the row still carries the version that was
    // read (`WHERE customers.version = $read`), then verifies what landed.
    // Verification by version equality is sound under this repo's id
    // discipline: same-id writes are same-op retries (identical content) or
    // deterministic-id convergence (designed to collapse). Transient races
    // converge inside the retry loop; only adversarial hammering reaches
    // the force-write fallback, which warns loudly instead of losing
    // silently. No new throw paths: BUSY/Tauri failures behave as before.
    const OPTIMISTIC_WRITE_ATTEMPTS = 3;
    const fallbackBase = Number((customer as unknown as { version?: number }).version || 0);
    let nextVersion = fallbackBase + 1;
    const baseArgs = [
      customer.id,
      customer.name,
      customer.phone,
      customer.email || null,
      customer.loyaltyPoints || 0,
      customer.storeCredit || 0,
      customer.pricingTier || 'Retail',
      customer.totalSpent || 0,
    ];
    const idemKey =
      (customer as unknown as { idempotency_key?: string }).idempotency_key || `cust-${customer.id}`;
    const writeRow = async (
      db: { execute: (sql: string, args?: unknown[]) => Promise<unknown>; select: (sql: string, args?: unknown[]) => Promise<unknown> },
      baseVersion: number,
      version: number,
      now: string,
      guarded: boolean,
      rowJson: string,
    ): Promise<void> => {
      const predicate = guarded ? ' WHERE customers.version = $13' : '';
      // The debt COLUMN is a cache of the ledger (the authority) and is read
      // first by `getAllCustomers` below, so a sale/repayment that only moved
      // the payload left every debt surface blind after a restart ([MNY-25]:
      // payload + ledger 1 000, column 0 → "0 débiteurs", and the credit gate
      // compared the ceiling against 0). $14 is appended after $13 so the
      // optimistic predicate keeps its placeholder; a caller that does not
      // carry `currentDebt` passes NULL and the stored value is preserved.
      const debtArg =
        typeof customer.currentDebt === 'number' && Number.isFinite(customer.currentDebt)
          ? Math.round(customer.currentDebt)
          : null;
      await db.execute(
        `INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted, version, idempotency_key, created_at, current_debt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $10, $14)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
           loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
           pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
           current_debt=COALESCE(excluded.current_debt, customers.current_debt),
         version = excluded.version,
         created_at = CASE WHEN COALESCE(customers.created_at, '') = '' THEN excluded.created_at ELSE customers.created_at END${predicate}`,
        [
          ...baseArgs,
          rowJson,
          now,
          version,
          // UNIQUE index on idempotency_key rejects the '' default twice:
          // every local row gets its own stable key (updates keep theirs).
          idemKey,
          baseVersion,
          debtArg,
        ],
      );
    };
    const readCurrent = async (
      db: { select: (sql: string, args?: unknown[]) => Promise<unknown> },
    ): Promise<number | null> => {
      const verRows = (await db
        .select('SELECT version FROM customers WHERE id=$1', [customer.id])
        .catch(() => [])) as Array<{ version: number }>;
      if (verRows && verRows.length > 0) return Number(verRows[0].version ?? 0);
      return null;
    };
    try {
      const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
      const { runOptimisticWriteLoop, payloadFingerprint } = await import('../../sync/causalVersion');
      const db = await getLocalDb();
      const now = utcNowIso();
      const rowJson = (version: number): string => JSON.stringify({ ...customer, version });
      const parseJson = (raw: unknown): Record<string, unknown> => {
        try {
          const parsed: unknown = JSON.parse(String(raw ?? '{}'));
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        } catch {
          return {};
        }
      };
      const outcome = await runOptimisticWriteLoop(
        {
          read: () => readCurrent(db),
          write: (base, next, guarded) => writeRow(db, base, next, now, guarded, rowJson(next)),
          inspect: async () => {
            const rows = (await db
              .select('SELECT version, json_payload FROM customers WHERE id=$1', [customer.id])
              .catch(() => [])) as Array<{ version?: unknown; json_payload?: unknown }>;
            const row = rows?.[0];
            if (!row) return { version: null, fingerprint: null };
            return {
              version: Number((row as { version?: unknown }).version ?? NaN),
              fingerprint: payloadFingerprint(parseJson((row as { json_payload?: unknown }).json_payload)),
            };
          },
          fingerprintFor: (version: number) => payloadFingerprint(parseJson(rowJson(version))),
        },
        fallbackBase,
        OPTIMISTIC_WRITE_ATTEMPTS,
      );
      nextVersion = outcome.next;
      if (outcome.forced) {
        const msg =
          `[customer] Concurrent writes to [${customer.id}] survived ${outcome.attemptsUsed} guarded attempts — ` +
          `last-writer-wins at v${outcome.next}. Review the customer ledger if balances look off.`;
        console.warn(msg);
        try {
          const { usePosStore } = await import('../../store/usePosStore');
          await usePosStore.getState().logSecurityAction('Écriture concurrente (client)', msg, 'Système', false);
        } catch {
          // Audit is best-effort; the warning above already surfaced it.
        }
      }
    } catch (err) {
      // B-016: a bare catch made BUSY and real authority failures look like
      // "web mode". Rethrow BUSY (retryable) and any Tauri failure (caller
      // must surface C6); only non-Tauri environments skip SQLite silently.
      if (isBusyError(err)) throw err;
      if (isTauriEnv()) {
        console.error('[customer] SQLite authority write failed:', err);
        throw err;
      }
      // Non-Tauri (web) — no local authority; Dexie + fireSync still run below.
    }
    // Authority-first: Dexie mirrors only what SQLite durable holds (or the
    // in-memory fallback in web mode). Previously Dexie was written before
    // SQLite even attempted, so a Tauri SQLite failure left Dexie ahead.
    const customerWithVersion = { ...customer, version: nextVersion };
    await dexieDb.customers.put(customerWithVersion);
    void fireSync('customer', customer.id, customerWithVersion);
  },

  /**
   * D4-A / cold review N2: mirror the LOYALTY bookkeeping of a completed refund.
   *
   * The money (wallet balance, `creditDeltaDzd` rows, milestone revocation) was
   * committed by `refund_sale_atomic` inside its own transaction. Saving the
   * whole customer object after that commit re-wrote `store_credit` from a
   * snapshot taken before it, so a concurrent wallet debit landing in between
   * was erased (free credit). This method:
   *   - never touches `store_credit` or `current_debt`;
   *   - merge-patches loyalty keys into the row's CURRENT payload;
   *   - appends only the ledger rows this refund created, by id.
   * See `src/db/refundMirrorSql.ts` for the statements and their idempotency.
   *
   * Returns the customer as the COMMITTED row now holds it. Callers must use
   * that snapshot for the outbox/Dexie, never their pre-commit object: the
   * outbox keeps one row per (entity, id), so enqueueing a stale wallet would
   * replace a debit's pending payload (review F1).
   */
  async saveRefundMirror(
    customer: Customer,
    newLedgerEntries: readonly LoyaltyLedgerEntry[] = []
  ): Promise<Customer> {
    let snapshot: Customer = customer;
    if (isTauriEnv()) {
      const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
      const { buildRefundMirrorStatements } = await import('../refundMirrorSql');
      const db = await getLocalDb();
      // D6: an ~80MB loyalty book must not be rewritten or cloned on the main
      // thread. The NATIVE already wrote the wallet/loyalty rows inside its
      // transaction, so the TS mirror is redundant above this size: skip it and
      // let the boot rehydrate the UI from SQLite (which is the authority).
      const probe = (await db
        .select('SELECT LENGTH(json_payload) AS n FROM customers WHERE id = $1', [customer.id])
        .catch(() => [])) as Array<{ n?: unknown }>;
      const huge = Number(probe?.[0]?.n ?? 0) > 4_000_000;
      if (huge) {
        console.warn('[refund:mirror] huge customer payload - TS mirror skipped (native wrote it)');
        return customer;
      }
      const statements = buildRefundMirrorStatements(customer, utcNowIso(), newLedgerEntries);
      for (const statement of statements) {
        const affected = await db.execute(statement.sql, statement.args);
        // 0 rows on a ledger append means the row vanished (deleted=0 no longer
        // matches) or the payload carries a legacy non-array ledger. Silence
        // would lose the audit row; say so.
        if (statement.args.length > 2) {
          const rows = Number(
            (affected as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0
          );
          if (rows === 0) {
            console.warn(
              `[refund:mirror] ledger row ${String(statement.args[2])} was not appended to [${customer.id}] ` +
                '(row deleted or ledger payload is not an array).'
            );
          }
        }
      }
      const rows = (await db
        .select(
          'SELECT store_credit, loyalty_points, total_spent, current_debt, json_payload, version, LENGTH(json_payload) AS payload_len FROM customers WHERE id = $1',
          [customer.id]
        )
        .catch(() => [])) as Array<Record<string, unknown>>;
      const row = rows?.[0];
      if (row) {
        let payload: Record<string, unknown> = {};
        // D6: never parse an ~80MB loyalty book on the main thread (it delayed
        // the next refund past the supervisor window). The native already
        // persisted the ledger; Dexie keeps the caller's copy.
        if (Number(row.payload_len ?? 0) <= 4_000_000) {
          try {
            payload = JSON.parse(String(row.json_payload ?? '{}')) as Record<string, unknown>;
          } catch {
            payload = {};
          }
        }
        snapshot = {
          ...customer,
          storeCredit:
            typeof row.store_credit === 'number' ? row.store_credit : customer.storeCredit,
          loyaltyPoints:
            typeof row.loyalty_points === 'number' ? row.loyalty_points : customer.loyaltyPoints,
          totalSpent: typeof row.total_spent === 'number' ? row.total_spent : customer.totalSpent,
          currentDebt:
            typeof row.current_debt === 'number' ? row.current_debt : customer.currentDebt,
          ledger: Array.isArray(payload.ledger)
            ? (payload.ledger as Customer['ledger'])
            : customer.ledger,
          version:
            typeof row.version === 'number'
              ? row.version
              : (customer as unknown as { version?: number }).version,
        } as Customer;
      }
    }
    // Dexie mirrors the committed snapshot, so the UI reads the same balance the
    // authority holds (never the pre-commit object).
    await dexieDb.customers.put(snapshot);
    void fireSync('customer', snapshot.id, snapshot as unknown as Record<string, unknown>);
    return snapshot;
  },

  async bulkSaveCustomers(customers: Customer[]): Promise<void> {
    await dexieDb.customers.bulkPut(customers);
    for (const c of customers) {
      await customerAdapter.saveCustomer(c);
    }
  },

  /**
   * One-time, idempotent back-fill of the `customers.current_debt` CACHE from
   * the ledger, which is the authority for a receivable.
   *
   * Rows written before 2026-10-30 carry a column that never advanced with the
   * payload (P2-7), so a merchant upgrading with live credit would still read a
   * stale 0 even though `saveCustomer` now maintains the column. Only rows that
   * DISAGREE are touched, and only when the customer has at least one ledger
   * row — a customer with no ledger history keeps whatever the column/payload
   * held (legacy/imported shapes must not be zeroed).
   *
   * Returns the number of rows repaired (0 on a clean DB, so boot is a no-op).
   */
  async healDebtCacheFromLedger(): Promise<number> {
    if (!isTauriEnv()) return 0;
    try {
      const { getLocalDb } = await import('../sqlPluginAdapter');
      const db = await getLocalDb();
      const res = (await db.execute(
        `UPDATE customers
            SET current_debt = (
              SELECT COALESCE(SUM(CASE WHEN d.type = 'DEBT_ACQUIRED' THEN d.amount
                                       WHEN d.type = 'PAYMENT_SETTLED' THEN -d.amount
                                       ELSE 0 END), 0)
                FROM customer_debts d
               WHERE d.customer_id = customers.id AND d.deleted = 0
            )
          WHERE EXISTS (
              SELECT 1 FROM customer_debts d
               WHERE d.customer_id = customers.id AND d.deleted = 0
            )
            AND COALESCE(current_debt, -1) <> (
              SELECT COALESCE(SUM(CASE WHEN d.type = 'DEBT_ACQUIRED' THEN d.amount
                                       WHEN d.type = 'PAYMENT_SETTLED' THEN -d.amount
                                       ELSE 0 END), 0)
                FROM customer_debts d
               WHERE d.customer_id = customers.id AND d.deleted = 0
            )`,
      )) as unknown as { rowsAffected?: number } | undefined;
      const repaired = typeof res?.rowsAffected === 'number' ? res.rowsAffected : 0;
      if (repaired > 0) {
        console.warn(`[customer] current_debt cache repaired from the ledger for ${repaired} row(s)`);
      }
      return repaired;
    } catch (err) {
      // Never fails boot: the read-side ledger guard already keeps the UI
      // honest, this only fixes the stored cache.
      console.warn('[customer] current_debt cache back-fill skipped:', err);
      return 0;
    }
  },

  async getAllCustomers(): Promise<Customer[]> {
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const rows = (await db
          .select(
            'SELECT id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, version, created_at, current_debt, whatsapp_opt_in FROM customers WHERE deleted = 0 ORDER BY name ASC',
          )) as Array<Record<string, unknown>>;
        // The LEDGER is the authority for a receivable; `customers.current_debt`
        // is a cache of it and was historically never written by the TS sale
        // path (P2-7). Reading the cache first therefore hid a real 1 000 DA
        // debt after every restart ([MNY-25]). One grouped read keeps the
        // per-customer loop free of queries.
        let ledgerDebt = new Map<string, number>();
        try {
          const agg = (await db.select(
            `SELECT customer_id, SUM(CASE WHEN type = 'DEBT_ACQUIRED' THEN amount
                                          WHEN type = 'PAYMENT_SETTLED' THEN -amount
                                          ELSE 0 END) AS b
               FROM customer_debts WHERE deleted = 0 GROUP BY customer_id`,
          )) as Array<{ customer_id: unknown; b: unknown }>;
          ledgerDebt = new Map(
            (agg || [])
              .filter((r) => String(r?.customer_id ?? '').trim() !== '')
              .map((r) => [String(r.customer_id), Number(r.b ?? 0)] as const),
          );
        } catch {
          // Ledger unreadable (pre-v8 table): fall back to the cached column.
        }
        if (rows && rows.length > 0) {
          const loaded: Customer[] = [];
          for (const r of rows) {
            let base: Partial<Customer> & { secondary_phone?: string } = {};
            if (r.json_payload) {
              try {
                base = JSON.parse(String(r.json_payload)) as Partial<Customer> & {
                  secondary_phone?: string;
                };
              } catch {}
            }
            const cust: Customer = {
              email: String(r.email || base.email || ''),
              registeredDevice: String(r.registered_device || base.registeredDevice || ''),
              pointBuckets: Array.isArray(base.pointBuckets) ? base.pointBuckets : undefined,
              ledger: Array.isArray(base.ledger) ? base.ledger : undefined,
              ...base,
              id: String(r.id || base.id || ''),
              name: String(r.name || base.name || 'Client'),
              phone: String(r.phone ?? base.phone ?? ''),
              secondaryPhone: String(base.secondaryPhone ?? base.secondary_phone ?? '') || undefined,
              loyaltyPoints: Number(r.loyalty_points ?? base.loyaltyPoints ?? 0),
              storeCredit: Number(r.store_credit ?? base.storeCredit ?? 0),
              pricingTier: (r.pricing_tier as Customer['pricingTier']) || base.pricingTier || 'Retail',
              totalSpent: Number(r.total_spent ?? base.totalSpent ?? 0),
              currentDebt: (() => {
                const id = String(r.id || base.id || '');
                const fromLedger = ledgerDebt.get(id);
                if (typeof fromLedger === 'number' && Number.isFinite(fromLedger)) {
                  return Math.max(0, fromLedger);
                }
                return Number(r.current_debt ?? (base as any).currentDebt ?? (base as any).current_debt ?? 0);
              })(),
              whatsappOptIn: Boolean(r.whatsapp_opt_in ?? base.whatsappOptIn),
            };
            (cust as unknown as { version?: number }).version = Number(r.version ?? (base as unknown as { version?: number }).version ?? 1);
            loaded.push(cust);
          }
          if (loaded.length > 0) {
            await dexieDb.customers.bulkPut(loaded).catch(() => {});
            return reconcileLoyaltyState(loaded);
          }
        }
      } catch (err) {
        console.warn('[customerAdapter] SQLite getAllCustomers failed, fallback to Dexie:', err);
      }
    }
    const list = await dexieDb.customers.toArray();
    return reconcileLoyaltyState(list);
  },

  async findCustomerByPhone(phone: string): Promise<Customer | undefined> {
    const trimmed = phone.trim();
    if (!trimmed) return undefined;
    // normalizeAlgerianPhone (utils/phoneUtils) canonicalizes Arabic-Indic /
    // full-width digits and 0/213/+213/00213 prefixes, so a till typing
    // '+213 550 12 34 56' finds the customer stored as '0550002222'.
    // Fallback is trim-only exact match when normalization yields nothing.
    let candidates = [trimmed];
    try {
      const norm = normalizeAlgerianPhone(trimmed);
      const variants = [norm.local, norm.digitsOnly, norm.international, norm.whatsAppFormat, norm.formattedDisplay]
        .map((v) => (v ?? '').trim())
        .filter((v) => v.length > 0);
      if (variants.length > 0) candidates = [...new Set([trimmed, ...variants])];
    } catch {
      // Normalizer unavailable — trim-only lookup below.
    }
    for (const c of candidates) {
      const hit = await dexieDb.customers.where('phone').equals(c).first().catch(() => undefined);
      if (hit) return hit;
    }
    return undefined;
  },

  /**
   * Tombstone a customer. Returns true on success, false when the SQLite
   * authority write failed (Tauri) — the caller MUST surface a false return
   * instead of reporting a delete that the authority never recorded (C6).
   * The tombstone bumps the version clock so a stale same-version echo can
   * never resurrect the row through the guarded upsert.
   */
  async deleteCustomer(id: string): Promise<boolean> {
    if (isTauriEnv()) {
      try {
        const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const verRows = (await db
          .select('SELECT version FROM customers WHERE id=$1', [id])
          .catch(() => [])) as Array<{ version: number }>;
        const nextVersion = (verRows?.length ?? 0) > 0 ? Number(verRows[0].version) + 1 : 1;
        await db.execute(
          'UPDATE customers SET deleted = 1, version = $1, updated_at = $2 WHERE id = $3',
          [nextVersion, utcNowIso(), id],
        );
      } catch (err) {
        console.error(`[customerAdapter] SQLite tombstone FAILED for customer [${id}]:`, err);
        return false;
      }
    } else {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        await db.execute('UPDATE customers SET deleted = 1 WHERE id = $1', [id]);
      } catch {
        // Web preview: Dexie is the store — SQLite mirror is best-effort.
      }
    }
    await dexieDb.customers.delete(id);
    void fireSyncDelete('customer', id);
    return true;
  },

  async saveCustomerDebt(debt: CustomerDebtEntry): Promise<void> {
    // H9: the debt lane had no version clock. `CustomerDebtEntry` carries no
    // `version` field, so `toRemoteUpsert` wrote `version || 1` = 1 on EVERY
    // write and `applyRemoteRow`'s stale-echo guard (`local.version > version`)
    // could never fire. The lane was pure last-write-wins, so a reordered
    // replay (backfill re-enqueues every Dexie debt row under one stable
    // idempotency key) resurrected a SETTLED balance: the historical
    // DEBT_ACQUIRED row landed after the PAYMENT_SETTLED row and clobbered it,
    // re-owing a customer for money already paid. Read the authoritative
    // version from SQLite and bump it, exactly as saveCustomer does.
    let nextVersion = Number((debt as unknown as { version?: number }).version || 0) + 1;
    try {
      const { getLocalDb } = await import('../sqlPluginAdapter');
      const db = await getLocalDb();
      const verRows = (await db
        .select('SELECT version FROM customer_debts WHERE id=$1', [debt.id])
        .catch(() => [])) as Array<{ version: number }>;
      if (verRows && verRows.length > 0) nextVersion = Number(verRows[0].version) + 1;
    } catch (err) {
      // I9 (UPGRADE-11): a bare catch made BUSY and real authority failures
      // look like "web mode". Rethrow BUSY (retryable) and any Tauri failure
      // (the caller must surface it); only non-Tauri environments skip
      // SQLite silently.
      if (isBusyError(err)) throw err;
      if (isTauriEnv()) {
        console.error('[customer-debt] SQLite version read failed:', err);
        throw err;
      }
      // Non-Tauri (web) — keep the in-memory version fallback above.
    }
    const debtWithVersion = {
      ...debt,
      origin: debt.origin ?? 'operational',
      version: nextVersion,
    };
    await dexieDb.customerDebts.put(debtWithVersion);
    try {
      const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
      const db = await getLocalDb();
      // H9: the row was never written to local SQLite — only Dexie + outbox.
      // The `version` column therefore could never participate in the guard,
      // and the debt ledger had no local durability beyond IndexedDB. The
      // customer row is the parent in an ON DELETE CASCADE FK, so a debt row
      // for an unknown customer must not strand the write: insert the parent
      // stub first (idempotent), then the debt row.
      await db.execute(
        `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, 'stub-cust-' || $1, $5)
         ON CONFLICT(id) DO NOTHING`,
        [debt.customerId, debt.customerName || 'Client', '', JSON.stringify({ id: debt.customerId, name: debt.customerName || 'Client' }), utcNowIso()],
      );
      await db.execute(
        `INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after,
           receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted,
             due_date, kind, origin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16, $17)
         ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id, customer_name=excluded.customer_name,
           type=excluded.type, amount=excluded.amount, balance_after=excluded.balance_after,
           receipt_number=excluded.receipt_number, payment_method=excluded.payment_method,
           notes=excluded.notes, recorded_by=excluded.recorded_by, created_at=excluded.created_at,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
           due_date=excluded.due_date, kind=excluded.kind,
           origin=excluded.origin, version = excluded.version
         WHERE excluded.version >= customer_debts.version`,
        [
          debt.id, debt.customerId, debt.customerName || 'Client', debt.type,
          Number(debt.amount || 0), Number(debt.balanceAfter || 0),
          debt.receiptNumber || null, debt.paymentMethod || null,
          debt.notes || null, debt.recordedBy || null, debt.createdAt,
          JSON.stringify(debtWithVersion), nextVersion, utcNowIso(),
          debt.dueDate ?? null, debt.kind || '',
          debtWithVersion.origin,
        ],
      );
    } catch (err) {
      // I9 (UPGRADE-11): distinguish web mode from real authority failures —
      // a Tauri write failure must never look like "web mode" (local SQLite
      // durability is exactly what this mirror lane exists for).
      if (isBusyError(err)) throw err;
      if (isTauriEnv()) {
        console.error('[customer-debt] SQLite mirror write failed:', err);
        throw err;
      }
      // Non-Tauri (web) — Dexie + fireSync remain the only lanes.
    }
    void fireSync('customer_debt', debt.id, debtWithVersion);
  },

  async getAllCustomerDebts(): Promise<CustomerDebtEntry[]> {
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const rows = (await db
          .select(
            'SELECT id, customer_id, customer_name, type, amount, balance_after, receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, due_date, kind, origin FROM customer_debts WHERE deleted = 0 ORDER BY created_at DESC',
          )
          .catch(() => [])) as Array<Record<string, unknown>>;
        if (rows && rows.length > 0) {
          const loaded: CustomerDebtEntry[] = rows.map((r) => {
            let base: Partial<CustomerDebtEntry> = {};
            if (r.json_payload) {
              try {
                base = JSON.parse(String(r.json_payload));
              } catch {}
            }
            return {
              id: String(r.id || base.id),
              customerId: String(r.customer_id || base.customerId),
              customerName: String(r.customer_name || base.customerName || 'Client'),
              type: (r.type || base.type) as 'DEBT_ACQUIRED' | 'PAYMENT_SETTLED',
              amount: Number(r.amount ?? base.amount ?? 0),
              balanceAfter: Number(r.balance_after ?? base.balanceAfter ?? 0),
              receiptNumber: r.receipt_number ? String(r.receipt_number) : base.receiptNumber,
              paymentMethod: (r.payment_method || base.paymentMethod) as any,
              notes: r.notes ? String(r.notes) : base.notes,
              recordedBy: r.recorded_by ? String(r.recorded_by) : base.recordedBy,
              createdAt: String(r.created_at || base.createdAt || ''),
              dueDate: r.due_date ? String(r.due_date) : base.dueDate,
              kind: (r.kind || base.kind) as any,
              origin: String(r.origin || base.origin || 'operational') as CustomerDebtEntry['origin'],
              allocations: base.allocations,
            };
          });
          await dexieDb.customerDebts.bulkPut(loaded).catch(() => {});
          return loaded;
        }
      } catch (err) {
        console.warn('[customerAdapter] SQLite getAllCustomerDebts failed, fallback to Dexie:', err);
      }
    }
    return await dexieDb.customerDebts.toArray();
  },
};
