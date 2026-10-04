import type { Customer, CustomerDebtEntry, LoyaltyProgramConfig } from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete, isTauriEnv } from './base';
import { isBusyError } from '../busyRetry';
import { normalizeAlgerianPhone } from '../../utils/phoneUtils';
import {
  normalizeLoyaltyConfig,
  reconcileMilestoneTranches,
  ensureCreditGenesis,
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
    if (!genesis && sweep.entries.length === 0) return c;
    changed = true;
    return {
      ...c,
      storeCredit: (c.storeCredit || 0) + sweep.totalReward,
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
      const predicate = guarded ? ' AND customers.version = $14' : '';
      await db.execute(
        `INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted, version, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
           loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
           pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
         version = excluded.version${predicate}`,
        [
          ...baseArgs,
          rowJson,
          now,
          version,
          // UNIQUE index on idempotency_key rejects the '' default twice:
          // every local row gets its own stable key (updates keep theirs).
          idemKey,
          baseVersion,
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

  async bulkSaveCustomers(customers: Customer[]): Promise<void> {
    await dexieDb.customers.bulkPut(customers);
    for (const c of customers) {
      await customerAdapter.saveCustomer(c);
    }
  },

  async getAllCustomers(): Promise<Customer[]> {
    const list = await dexieDb.customers.toArray();
    if (list.length > 0) return reconcileLoyaltyState(list);
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const rows = (await db.select('SELECT json_payload FROM customers WHERE deleted = 0').catch(() => [])) as Array<{ json_payload?: string }>;
        if (rows && rows.length > 0) {
          const loaded: Customer[] = [];
          for (const r of rows) {
            if (r.json_payload) {
              try {
                loaded.push(JSON.parse(r.json_payload) as Customer);
              } catch {}
            }
          }
          if (loaded.length > 0) {
            await dexieDb.customers.bulkPut(loaded).catch(() => {});
            return reconcileLoyaltyState(loaded);
          }
        }
      } catch {}
    }
    return list;
  },

  async findCustomerByPhone(phone: string): Promise<Customer | undefined> {
    const trimmed = phone.trim();
    if (!trimmed) return undefined;
    // normalizeAlgerianPhone (utils/phoneUtils) canonicalizes Arabic-Indic /
    // full-width digits and 0/213/+213/00213 prefixes, so a till typing
    // '+213 550 12 34 56' finds the customer stored as '0550123456'.
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
    } catch {
      // SQLite unavailable (web mode) — keep the in-memory fallback above.
    }
    const debtWithVersion = { ...debt, version: nextVersion };
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
        `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'stub-cust-' || $1)
         ON CONFLICT(id) DO NOTHING`,
        [debt.customerId, debt.customerName || 'Client', '', JSON.stringify({ id: debt.customerId, name: debt.customerName || 'Client' }), utcNowIso()],
      );
      await db.execute(
        `INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after,
           receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0)
         ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id, customer_name=excluded.customer_name,
           type=excluded.type, amount=excluded.amount, balance_after=excluded.balance_after,
           receipt_number=excluded.receipt_number, payment_method=excluded.payment_method,
           notes=excluded.notes, recorded_by=excluded.recorded_by, created_at=excluded.created_at,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
         version = excluded.version
         WHERE excluded.version >= customer_debts.version`,
        [
          debt.id, debt.customerId, debt.customerName || 'Client', debt.type,
          Number(debt.amount || 0), Number(debt.balanceAfter || 0),
          debt.receiptNumber || null, debt.paymentMethod || null,
          debt.notes || null, debt.recordedBy || null, debt.createdAt,
          JSON.stringify(debtWithVersion), nextVersion, utcNowIso(),
        ],
      );
    } catch {
      // ignore web mode fallback
    }
    void fireSync('customer_debt', debt.id, debtWithVersion);
  },

  async getAllCustomerDebts(): Promise<CustomerDebtEntry[]> {
    return await dexieDb.customerDebts.toArray();
  },
};

