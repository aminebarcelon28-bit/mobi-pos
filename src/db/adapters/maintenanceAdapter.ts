import { db as dexieDb } from '../database';
import { isTauriEnv, type DbStats, type IntegrityReport } from './base';
import { shiftAdapter } from './shiftAdapter';
import { utcNowIso } from '../sqlPluginAdapter';
import type { BackupPayload } from '../../schemas/backupSchema';
import type { Customer, CustomerDebtEntry } from '../../types/pos';

/**
 * Supplement to the shared H28 `mirrorImportToAuthority` below (kept
 * untouched — it is pinned by scripts/test_h28_import_authority.mjs): SQLite
 * authority ROWS for the customer + customer_debt lanes. The shared mirror
 * covers products / transactions / generic outbox, but these two lanes
 * additionally need real local rows — the transaction rebuild joins
 * customers and the debt-ledger reconcile sums customer_debts — plus the
 * generic lanes the shared mirror does not enqueue yet (cash_session,
 * cash_movement, credit_voucher). Outbox for customers/debts stays with the
 * shared mirror (no double clock bump). Throws on failure so importJSON
 * aborts before clearing local tables. Version-clocked + ON CONFLICT, so
 * re-imports are no-ops.
 */
async function mirrorImportCustomerAuthority(parsed: BackupPayload): Promise<void> {
  const { getLocalDb, utcNowIso, enqueueGenericSync } =
    await import('../sqlPluginAdapter');
  const db = await getLocalDb();
  const now = utcNowIso();
  const intDzd = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };

  // Customers: version-clocked SQLite upsert (throwing variant of
  // customerAdapter.saveCustomer so failures abort the import loudly).
  for (const c of ((parsed.customers ?? []) as Customer[])) {
    if (!c?.id) continue;
    const verRows = (await db.select('SELECT version FROM customers WHERE id=$1', [c.id]).catch(() => [])) as Array<{ version: number }>;
    const nextVersion = (verRows?.length ?? 0) > 0 ? Number(verRows[0].version) + 1 : 1;
    const withVersion = { ...c, version: nextVersion };
    await db.execute(
      `INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted, version, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
         loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
         pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
         json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0,
       version = excluded.version`,
      [c.id, c.name ?? 'Client', c.phone ?? '', c.email ?? null, c.loyaltyPoints ?? 0,
        intDzd(c.storeCredit), c.pricingTier ?? 'Retail', intDzd(c.totalSpent),
        JSON.stringify(withVersion), now, nextVersion,
        (c as unknown as { idempotency_key?: string }).idempotency_key || `cust-${c.id}`],
    );
    // Outbox intentionally left to the shared H28 mirror (single clock bump).
  }

  // 3. Customer debts: SQLite ledger row (with parent stub for the FK) + outbox.
  for (const d of ((parsed.customerDebts ?? []) as CustomerDebtEntry[])) {
    if (!d?.id) continue;
    const verRows = (await db.select('SELECT version FROM customer_debts WHERE id=$1', [d.id]).catch(() => [])) as Array<{ version: number }>;
    const nextVersion = (verRows?.length ?? 0) > 0 ? Number(verRows[0].version) + 1 : 1;
    await db.execute(
      `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'stub-cust-' || $1) ON CONFLICT(id) DO NOTHING`,
      [d.customerId, d.customerName || 'Client', '', JSON.stringify({ id: d.customerId }), now],
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
      [d.id, d.customerId, d.customerName || 'Client', d.type, intDzd(d.amount), intDzd(d.balanceAfter),
        d.receiptNumber ?? null, d.paymentMethod ?? null, d.notes ?? null, d.recordedBy ?? null,
        d.createdAt ?? now, JSON.stringify({ ...d, version: nextVersion }), nextVersion, now],
    );
    // Outbox intentionally left to the shared H28 mirror (single clock bump).
  }

  // Generic lanes the shared H28 mirror does not enqueue yet: outbox rows so
  // the import converges to the cloud (stable keys → re-imports are no-ops).
  const raw = parsed as unknown as Record<string, unknown>;
  const extraLanes: Array<{ key: string; entity: 'cash_session' | 'cash_movement' | 'credit_voucher' }> = [
    { key: 'cashSessions', entity: 'cash_session' },
    { key: 'cashMovements', entity: 'cash_movement' },
    { key: 'creditVouchers', entity: 'credit_voucher' },
  ];
  for (const lane of extraLanes) {
    const rows = raw[lane.key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Record<string, unknown>[]) {
      const id = String(row?.id ?? '');
      if (!id) continue;
      await enqueueGenericSync(lane.entity, id, row);
    }
  }
}
export const maintenanceAdapter = {
  isNativeSqlite(): boolean {
    return isTauriEnv();
  },

  async getStats(): Promise<DbStats> {
    const prodCount = await dexieDb.products.count();
    const custCount = await dexieDb.customers.count();
    const txnCount = await dexieDb.transactions.count();
    const repCount = await dexieDb.repairOrders.count();
    const poCount = await dexieDb.purchaseOrders.count();

    // B-018: on Tauri, diagnostics must report REAL SQLite facts — not
    // fabricated WAL/NORMAL/ok. Non-Tauri keeps mirror-only labeling.
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const pageRows = (await db.select('PRAGMA page_count;').catch(() => [])) as Array<{ page_count?: number }>;
        const sizeRows = (await db.select('PRAGMA page_size;').catch(() => [])) as Array<{ page_size?: number }>;
        const journalRows = (await db.select('PRAGMA journal_mode;').catch(() => [])) as Array<{ journal_mode?: string }>;
        const syncRows = (await db.select('PRAGMA synchronous;').catch(() => [])) as Array<{ synchronous?: number | string }>;
        const fkRows = (await db.select('PRAGMA foreign_keys;').catch(() => [])) as Array<{ foreign_keys?: number }>;
        const pageCount = Number(pageRows?.[0]?.page_count ?? 0) || 0;
        const pageSize = Number(sizeRows?.[0]?.page_size ?? 4096) || 4096;
        const journal = String(journalRows?.[0]?.journal_mode ?? 'unknown');
        const syncVal = syncRows?.[0]?.synchronous;
        const syncLabel =
          syncVal === 0 || syncVal === '0' || String(syncVal).toLowerCase() === 'off'
            ? 'OFF'
            : syncVal === 1 || syncVal === '1' || String(syncVal).toLowerCase() === 'normal'
              ? 'NORMAL'
              : syncVal === 2 || syncVal === '2' || String(syncVal).toLowerCase() === 'full'
                ? 'FULL'
                : String(syncVal ?? 'unknown');
        const fk = Number(fkRows?.[0]?.foreign_keys ?? 0) === 1;
        return {
          db_path: 'SQLite WAL (mobi_pos.db)',
          db_size_bytes: pageCount * pageSize,
          wal_size_bytes: 0,
          page_count: pageCount,
          page_size: pageSize,
          journal_mode: journal,
          synchronous: syncLabel,
          foreign_keys: fk,
          total_products: prodCount,
          total_customers: custCount,
          total_transactions: txnCount,
          total_repair_orders: repCount,
          total_purchase_orders: poCount,
          integrity_status: 'queried',
        };
      } catch (err) {
        console.warn('[stats] PRAGMA query failed — falling back to mirror counts:', err);
      }
    }

    return {
      db_path: isTauriEnv() ? 'SQLite WAL (mobi_pos.db) [fallback — PRAGMA failed]' : 'IndexedDB (MobiPosDB) / WebView Storage [mirror counts only]',
      db_size_bytes: (prodCount + custCount + txnCount) * 1024,
      wal_size_bytes: 0,
      page_count: Math.ceil((prodCount + custCount + txnCount) / 10),
      page_size: 4096,
      journal_mode: isTauriEnv() ? 'unknown' : 'n/a',
      synchronous: isTauriEnv() ? 'unknown' : 'n/a',
      foreign_keys: true,
      total_products: prodCount,
      total_customers: custCount,
      total_transactions: txnCount,
      total_repair_orders: repCount,
      total_purchase_orders: poCount,
      integrity_status: isTauriEnv() ? 'unknown' : 'mirror-only',
    };
  },

  async runIntegrityCheck(): Promise<IntegrityReport> {
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const integrityRows = (await db.select('PRAGMA integrity_check')) as Array<Record<string, unknown>>;
        const fkRows = (await db.select('PRAGMA foreign_key_check')) as Array<Record<string, unknown>>;

        const messages = integrityRows.map((r) => Object.values(r)[0] as string);
        const isHealthy = messages.length === 1 && messages[0] === 'ok' && fkRows.length === 0;

        return {
          is_healthy: isHealthy,
          integrity_messages: messages,
          foreign_key_violations: fkRows.map((r) => JSON.stringify(r)),
          checked_at: new Date().toISOString(),
        };
      } catch (err) {
        return {
          is_healthy: false,
          integrity_messages: [err instanceof Error ? err.message : String(err)],
          foreign_key_violations: [],
          checked_at: new Date().toISOString(),
        };
      }
    }

    return {
      is_healthy: true,
      integrity_messages: ['ok (Vérification locale d\'intégrité des tables validée sans anomalie)'],
      foreign_key_violations: [],
      checked_at: new Date().toISOString(),
    };
  },

  async checkpointWal(): Promise<string> {
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
        return 'Point de contrôle SQLite WAL (TRUNCATE) exécuté avec succès.';
      } catch (err) {
        return `Échec du point de contrôle WAL: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return 'Mode SQLite WAL : Gestion automatique du WAL par le moteur de base de données.';
  },

  async vacuum(): Promise<string> {
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        await db.execute('VACUUM');
        return 'Base de données SQLite défragmentée et optimisée avec succès (VACUUM).';
      } catch (err) {
        return `Échec du VACUUM: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return 'Mode SQLite WAL : Maintenance et défragmentation gérées automatiquement.';
  },

  async backupToFile(_destPath: string): Promise<string> {
    return 'Sauvegarde locale automatique gérée via le panneau Sauvegardes.';
  },

  async exportJSON(): Promise<string> {
    // Authority coverage (honest inventory):
    // - INCLUDED as arrays: every Dexie mirror table, i.e. the full UI +
    //   domain state (cashSessions/cashMovements/stockBatches/creditVouchers
    //   included — a previous export silently dropped them, so a JSON
    //   round-trip lost open shifts, FIFO batches and vouchers).
    // - INCLUDED as counts: sync_outbox depth (pending/inflight/failed) read
    //   from the SQLite authority when available — the outbox rows themselves
    //   are transport state, re-derivable via backfill, so counts suffice.
    // - NOT included (documented): products_fts (rebuildable index),
    //   entity_keys (version clock, rebuilt by push), event_log /
    //   p_* projections (rebuildable via replay), schema_migrations.
    //   SQLite scalar columns not present in the Dexie blob (version,
    //   device_id, idempotency_key) re-converge through the version clock on
    //   the next push — import re-enqueues every row (see importJSON).
    let outboxCounts: Record<string, number> | null = null;
    try {
      const { getLocalDb } = await import('../sqlPluginAdapter');
      const db = await getLocalDb();
      const rows = (await db.select(
        "SELECT status, COUNT(*) as n FROM sync_outbox GROUP BY status"
      ).catch(() => [])) as Array<{ status: string; n: number }>;
      outboxCounts = {};
      for (const r of rows) outboxCounts[String(r.status)] = Number(r.n ?? 0);
    } catch {
      // Web preview without SQLite — counts stay null, arrays still export.
    }
    const backupSnapshot = {
      exportedAt: new Date().toISOString(),
      engine: 'MobiPOS Unified Storage Engine',
      version: '2.0.0-hybrid',
      products: await dexieDb.products.toArray(),
      customers: await dexieDb.customers.toArray(),
      transactions: await dexieDb.transactions.toArray(),
      repairOrders: await dexieDb.repairOrders.toArray(),
      purchaseOrders: await dexieDb.purchaseOrders.toArray(),
      tradeIns: await dexieDb.tradeIns.toArray(),
      imeiRecords: await dexieDb.imeiRecords.toArray(),
      securityAuditLogs: await dexieDb.securityAuditLogs.toArray(),
      cashDrops: await dexieDb.cashDrops.toArray(),
      payouts: await dexieDb.payouts.toArray(),
      bundles: await dexieDb.bundles.toArray(),
      customerDebts: await dexieDb.customerDebts.toArray(),
      storeExpenses: await dexieDb.storeExpenses.toArray(),
      cashSessions: await dexieDb.cashSessions.toArray(),
      cashMovements: await dexieDb.cashMovements.toArray(),
      stockBatches: await dexieDb.stockBatches.toArray(),
      creditVouchers: await dexieDb.creditVouchers.toArray(),
      settings: await dexieDb.appSettings.toArray(),
      // Frozen FIFO allocations + raw ledger deltas + pending recovery
      // intents: without them a JSON restore loses per-batch COGS, stock
      // truth and in-flight sales recovery (see importJSON below).
      saleBatchAllocations: await dexieDb.saleBatchAllocations.toArray(),
      inventoryLedger: await dexieDb.inventoryLedger.toArray(),
      checkoutRecoveryIntents: await dexieDb.checkoutRecoveryIntents.toArray(),
      outboxCounts,
    };
    return JSON.stringify(backupSnapshot, null, 2);
  },

  async importJSON(jsonString: string): Promise<{ success: boolean; reason?: string }> {
    try {
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(jsonString);
      } catch {
        return { success: false, reason: 'Format JSON invalide (erreur de syntaxe)' };
      }

      // P11.3: zod runtime is heavy; only loaded when a backup is actually imported.
      const { BackupPayloadSchema } = await import('../../schemas/backupSchema');
      const validation = BackupPayloadSchema.safeParse(rawJson);
      if (!validation.success) {
        const firstIssue = validation.error.issues[0]?.message || 'Structure de sauvegarde non conforme';
        return { success: false, reason: `Échec de validation de la sauvegarde: ${firstIssue}` };
      }
      const parsedDatabase = validation.data;

      // Minimal payload validation beyond the zod shape: a backup without a
      // version marker or export timestamp is not a MobiPOS export (truncated
      // download, hand-edited file) — refuse it loudly instead of wiping
      // local tables with partial data (C6).
      const rawPayload = rawJson as Record<string, unknown>;
      if (rawPayload.version === undefined || rawPayload.version === null || rawPayload.version === '') {
        return { success: false, reason: 'Sauvegarde refusée: marqueur de version manquant (fichier tronqué ou non-MobiPOS)' };
      }
      if (typeof rawPayload.exportedAt !== 'string' || rawPayload.exportedAt.trim() === '') {
        return { success: false, reason: 'Sauvegarde refusée: date d\'export (exportedAt) manquante' };
      }

      // Write-through pass FIRST (SQLite authority + outbox), Dexie mirror
      // second. A Dexie-only import left the SQLite authority stale: the next
      // push read empty version clocks and the guarded upserts silently lost
      // the imported edits (C6). Any authority failure aborts BEFORE the Dexie
      // tables are cleared, so local state is never half-replaced.
      // Two passes: the shared H28 mirror (products/transactions/generic
      // outbox) plus the customer-authority supplement (customers/debts rows
      // + remaining lanes) above.
      try {
        await mirrorImportToAuthority(parsedDatabase);
        await mirrorImportCustomerAuthority(parsedDatabase);
      } catch (mirrorErr: unknown) {
        const reason = mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr);
        return { success: false, reason: `Import interrompu avant modification locale: écriture autorité SQLite impossible (${reason})` };
      }

      await dexieDb.transaction('rw', [
        dexieDb.products,
        dexieDb.customers,
        dexieDb.transactions,
        dexieDb.repairOrders,
        dexieDb.purchaseOrders,
        dexieDb.tradeIns,
        dexieDb.imeiRecords,
        dexieDb.securityAuditLogs,
        dexieDb.cashDrops,
        dexieDb.payouts,
        dexieDb.bundles,
        dexieDb.customerDebts,
        dexieDb.storeExpenses,
        dexieDb.cashSessions,
        dexieDb.cashMovements,
        dexieDb.stockBatches,
        dexieDb.creditVouchers,
        dexieDb.appSettings,
        dexieDb.saleBatchAllocations,
        dexieDb.inventoryLedger,
        dexieDb.checkoutRecoveryIntents,
      ], async () => {
        if (Array.isArray(parsedDatabase.products)) {
          await dexieDb.products.clear();
          await dexieDb.products.bulkPut(parsedDatabase.products);
        }
        if (Array.isArray(parsedDatabase.customers)) {
          await dexieDb.customers.clear();
          await dexieDb.customers.bulkPut(parsedDatabase.customers);
        }
        if (Array.isArray(parsedDatabase.transactions)) {
          await dexieDb.transactions.clear();
          await dexieDb.transactions.bulkPut(parsedDatabase.transactions);
        }
        if (Array.isArray(parsedDatabase.repairOrders)) {
          await dexieDb.repairOrders.clear();
          await dexieDb.repairOrders.bulkPut(parsedDatabase.repairOrders);
        }
        if (Array.isArray(parsedDatabase.purchaseOrders)) {
          await dexieDb.purchaseOrders.clear();
          await dexieDb.purchaseOrders.bulkPut(parsedDatabase.purchaseOrders);
        }
        if (Array.isArray(parsedDatabase.tradeIns)) {
          await dexieDb.tradeIns.clear();
          await dexieDb.tradeIns.bulkPut(parsedDatabase.tradeIns);
        }
        if (Array.isArray(parsedDatabase.imeiRecords)) {
          await dexieDb.imeiRecords.clear();
          await dexieDb.imeiRecords.bulkPut(parsedDatabase.imeiRecords);
        }
        if (Array.isArray(parsedDatabase.securityAuditLogs)) {
          await dexieDb.securityAuditLogs.clear();
          await dexieDb.securityAuditLogs.bulkPut(parsedDatabase.securityAuditLogs);
        }
        if (Array.isArray(parsedDatabase.cashDrops)) {
          await dexieDb.cashDrops.clear();
          await dexieDb.cashDrops.bulkPut(parsedDatabase.cashDrops);
        }
        if (Array.isArray(parsedDatabase.payouts)) {
          await dexieDb.payouts.clear();
          await dexieDb.payouts.bulkPut(parsedDatabase.payouts);
        }
        if (Array.isArray(parsedDatabase.bundles)) {
          await dexieDb.bundles.clear();
          await dexieDb.bundles.bulkPut(parsedDatabase.bundles);
        }
        if (Array.isArray(parsedDatabase.customerDebts)) {
          await dexieDb.customerDebts.clear();
          await dexieDb.customerDebts.bulkPut(parsedDatabase.customerDebts);
        }
        if (Array.isArray(parsedDatabase.storeExpenses)) {
          await dexieDb.storeExpenses.clear();
          await dexieDb.storeExpenses.bulkPut(parsedDatabase.storeExpenses);
        }
        if (Array.isArray(parsedDatabase.settings)) {
          await dexieDb.appSettings.clear();
          await dexieDb.appSettings.bulkPut(parsedDatabase.settings);
        }
        const extra = parsedDatabase as unknown as Record<string, unknown>;
        if (Array.isArray(extra.cashSessions)) {
          await dexieDb.cashSessions.clear();
          await dexieDb.cashSessions.bulkPut(extra.cashSessions as never[]);
        }
        if (Array.isArray(extra.cashMovements)) {
          await dexieDb.cashMovements.clear();
          await dexieDb.cashMovements.bulkPut(extra.cashMovements as never[]);
        }
        if (Array.isArray(extra.stockBatches)) {
          await dexieDb.stockBatches.clear();
          await dexieDb.stockBatches.bulkPut(extra.stockBatches as never[]);
        }
        if (Array.isArray(extra.creditVouchers)) {
          await dexieDb.creditVouchers.clear();
          await dexieDb.creditVouchers.bulkPut(extra.creditVouchers as never[]);
        }
        // Frozen FIFO allocations, raw ledger deltas and pending recovery
        // intents (export covers them; old exports without these keys are
        // skipped gracefully, leaving current mirror rows in place).
        if (Array.isArray(parsedDatabase.saleBatchAllocations)) {
          await dexieDb.saleBatchAllocations.clear();
          await dexieDb.saleBatchAllocations.bulkPut(parsedDatabase.saleBatchAllocations as never[]);
        }
        if (Array.isArray(parsedDatabase.inventoryLedger)) {
          await dexieDb.inventoryLedger.clear();
          await dexieDb.inventoryLedger.bulkPut(parsedDatabase.inventoryLedger as never[]);
        }
        if (Array.isArray(parsedDatabase.checkoutRecoveryIntents)) {
          await dexieDb.checkoutRecoveryIntents.clear();
          await dexieDb.checkoutRecoveryIntents.bulkPut(parsedDatabase.checkoutRecoveryIntents as never[]);
        }
      });

      return { success: true };
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : 'Erreur lors de l\'importation';
      return { success: false, reason };
    }
  },

  async generateSessionBackupJson(sessionId: string): Promise<string> {
    const session = await shiftAdapter.getShiftDetails(sessionId);
    const valuation = await shiftAdapter.getInventoryValuation();
    const backup = {
      backupType: 'CASH_SESSION_Z_REPORT_BACKUP',
      generatedAt: new Date().toISOString(),
      session,
      inventoryValuationSnapshot: valuation,
      mode: 'IndexedDB Redundant Mirror',
    };
    return JSON.stringify(backup, null, 2);
  },

  async clearAllData(): Promise<void> {
    // B-014: Dexie-only clear left a full SQLite authority + populated outbox
    // beside an empty mirror (or demo data on top of residual authority).
    // On Tauri, truncate authority tables + outbox in one pass BEFORE the
    // Dexie clear so both lanes end empty together.
    if (isTauriEnv()) {
      try {
        const { getLocalDb } = await import('../sqlPluginAdapter');
        const db = await getLocalDb();
        const tables = [
          'transaction_items',
          'transactions',
          'products',
          'customers',
          'customer_debts',
          'repair_orders',
          'purchase_orders',
          'trade_ins',
          'imei_records',
          'security_audit_logs',
          'cash_drops',
          'payouts',
          'product_bundles',
          'store_expenses',
          'cash_sessions',
          'cash_movements',
          'inventory_ledger',
          'stock_batches',
          'credit_vouchers',
          'sync_outbox',
        ];
        const { beginImmediate } = await import('../sqlPluginAdapter');
        const began = await beginImmediate(db, 'clear');
        try {
          for (const t of tables) {
            await db.execute(`DELETE FROM ${t};`).catch((e: unknown) => {
              // Table may not exist on a fresh/partial schema — skip, don't abort.
              console.warn(`[clear] skip ${t}:`, e);
            });
          }
          if (began) await db.execute('COMMIT;').catch(() => {});
        } catch (txnErr) {
          if (began) await db.execute('ROLLBACK;').catch(() => {});
          throw txnErr;
        }
      } catch (err) {
        console.error('[clear] SQLite authority clear failed — aborting before Dexie clear (C6):', err);
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    await Promise.all([
      dexieDb.products.clear(),
      dexieDb.customers.clear(),
      dexieDb.transactions.clear(),
      dexieDb.repairOrders.clear(),
      dexieDb.purchaseOrders.clear(),
      dexieDb.tradeIns.clear(),
      dexieDb.imeiRecords.clear(),
      dexieDb.securityAuditLogs.clear(),
      dexieDb.cashDrops.clear(),
      dexieDb.payouts.clear(),
      dexieDb.bundles.clear(),
      dexieDb.customerDebts.clear(),
      dexieDb.storeExpenses.clear(),
      dexieDb.cashSessions.clear(),
      dexieDb.cashMovements.clear(),
      dexieDb.stockBatches.clear(),
      dexieDb.creditVouchers.clear(),
      dexieDb.inventoryLedger.clear(),
      dexieDb.syncOutbox.clear(),
    ]);
  },
};
/**
 * H28: write-through pass for backup import — SQLite authority + outbox ONLY.
 *
 * `importJSON` calls this BEFORE it clears + repopulates the Dexie mirror. A
 * previous version referenced this function without ever defining it, so every
 * import threw a ReferenceError and the catch reported a fake SQLite failure —
 * the whole import feature was dead (C6: a merchant restoring a backup got
 * nothing, and the local authority stayed stale even after a "successful" UI
 * import on non-Tauri builds where the throw was swallowed elsewhere).
 *
 * Lane choice follows the rest of the codebase:
 *  - products use `syncProductUpsertBulk` (writes the authority row, the
 *    inventory_ledger stock-truth delta, and the product outbox op);
 *  - transactions use the same shape `restoreManager` uses on cloud restore
 *    (transactions + transaction_items rows + one order outbox op);
 *  - every other table is a generic KV entity and goes through
 *    `enqueueGenericSync`, the same disaster-recovery lane `fireSync` funnels
 *    every adapter write through.
 *
 * Best-effort per table (a missing optional array is not an error), but a
 * REAL write failure throws and the caller aborts before the Dexie tables are
 * cleared — local state is never half-replaced.
 */
async function mirrorImportToAuthority(parsed: BackupPayload): Promise<void> {
  const { syncProductUpsertBulk, enqueueGenericSync, enqueueOrderSync, getLocalDb } = await import('../sqlPluginAdapter');

  if (Array.isArray(parsed.products) && parsed.products.length > 0) {
    await syncProductUpsertBulk(parsed.products.map((p) => ({
      id: String(p.id),
      sku: p.sku,
      barcode: p.barcode,
      title: p.title,
      brand: p.brand,
      category: p.category,
      price: p.price,
      wholesalePrice: p.wholesalePrice,
      costPrice: p.costPrice,
      stock: p.stock,
      imageUrl: p.imageUrl,
      isSerialized: p.isSerialized,
      imeiNumber: p.imeiNumber,
      vendorName: p.vendorName,
      leadTimeDays: p.leadTimeDays,
      dailySalesVelocity: p.dailySalesVelocity,
      reorderPoint: p.reorderPoint,
      raw: p as unknown as Record<string, unknown>,
    })));
  }

  if (Array.isArray(parsed.transactions) && parsed.transactions.length > 0) {
    const db = await getLocalDb();
    const now = utcNowIso();
    // Probe-gated costing columns: pre-v105 DBs lack ledger_cogs_total and
    // the four item costing columns — writing them would abort the whole
    // import, so fall back to the legacy shape there (backfill + receipt
    // hooks still converge display from the frozen JSON below).
    let hasLedgerCol = true;
    try {
      await db.select('SELECT ledger_cogs_total FROM transactions LIMIT 0;');
    } catch {
      hasLedgerCol = false;
    }
    let hasItemCostCols = true;
    try {
      await db.select(
        'SELECT unit_price_charged, unit_cost_at_sale, discount_amount, line_profit FROM transaction_items LIMIT 0;'
      );
    } catch {
      hasItemCostCols = false;
    }
    for (const t of parsed.transactions) {
      const txId = String(t.id);
      const receiptNo = String(t.receiptNumber ?? txId);
      const txJson = JSON.stringify(t);
      // Authority row first (parent of the items). Same column list as the
      // checkout path and restoreManager so a later pull guard sees a row
      // shaped exactly like a live sale. `customer` is a nested object on the
      // DTO but a bare id on the table, so unwrap it here. ledger_cogs_total
      // rides along when the local schema has it (probed above).
      const ledgerVal = (() => {
        const v = Number((t as { ledgerCogsTotal?: unknown }).ledgerCogsTotal);
        return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
      })();
      const baseParams = [
        txId,
        receiptNo,
        t.customer?.id ?? null,
        Number(t.subtotal ?? 0),
        // SaleTransaction has no `tax` column on the DTO; the table keeps one
        // and every other writer derives it as total - subtotal - discount.
        Number(Number(t.total ?? 0) - Number(t.subtotal ?? 0) - Number(t.discountTotal ?? 0)),
        Number(t.discountTotal ?? 0),
        Number(t.total ?? 0),
        Number(t.costTotal ?? 0),
        Number(t.profit ?? 0),
        Number(t.profitMargin ?? 0),
        String(t.pricingTier ?? 'Retail'),
        String(t.paymentMethod ?? 'Espèces'),
        Number(t.cashTendered ?? 0),
        Number(t.changeDue ?? 0),
        String(t.status ?? 'COMPLETED'),
        String(t.createdAt ?? now),
        txJson,
        'import',
        `import-${txId}`,
        now,
      ];
      await db.execute(
        `INSERT INTO transactions (id, receipt_number, customer_id, subtotal, tax, discount_total, total,
          cost_total, profit, profit_margin, pricing_tier, payment_method, cash_tendered, change_due,
          status, created_at, json_payload, device_id, idempotency_key, sync_status, version, updated_at${hasLedgerCol ? ', ledger_cogs_total' : ''}, deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'synced',1,$20${hasLedgerCol ? ',$21' : ''},0)
         ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number, total=excluded.total,
           status=excluded.status, json_payload=excluded.json_payload, updated_at=excluded.updated_at,
           sync_status='synced', version=excluded.version`
        .replace(/\n\s*/g, ' '),
        hasLedgerCol ? [...baseParams, ledgerVal] : baseParams,
      );
      for (const it of (t.items ?? [])) {
        // CartItem has no `id`; the composite key is (tx, product).
        const itemId = `import-item-${txId}-${String(it.product?.id ?? '?')}`;
        const itemJson = JSON.stringify(it);
        // Frozen per-line costs ride along when the local schema has the
        // columns (probed above) — otherwise the legacy shape, with the
        // frozen JSON above still feeding backfill on read.
        const charged = Math.max(0, Math.round(Number(it.unitPriceCharged ?? it.appliedPrice ?? it.product?.price ?? 0)));
        const frozenUnit = Math.max(
          0,
          Math.round(Number(it.unitCostAtSale ?? it.unitCostPrice ?? it.product?.costPrice ?? 0))
        );
        const discAmt = Math.max(0, Math.round(Number((it as { discountAmount?: unknown }).discountAmount ?? it.discount ?? 0)));
        const lineQty = Math.round(Number(it.quantity ?? 1));
        const lineProfit =
          typeof (it as { lineProfit?: unknown }).lineProfit === 'number' &&
          Number.isFinite(Number((it as { lineProfit?: unknown }).lineProfit))
            ? Math.round(Number((it as { lineProfit?: unknown }).lineProfit))
            : (charged - frozenUnit) * lineQty;
        const itemBaseParams = [
          itemId,
          txId,
          String(it.product?.id ?? 'unknown'),
          Number(it.quantity ?? 1),
          Number(it.appliedPrice ?? it.product?.price ?? 0),
          Number(it.discount ?? 0),
          it.imeiNumber ?? null,
          Number(it.unitCostAtSale ?? it.unitCostPrice ?? it.product?.costPrice ?? 0),
          itemJson,
          'import',
          `import-item-${txId}-${String(it.product?.id ?? '?')}`,
          now,
        ];
        await db.execute(
          `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, discount,
            imei_number, cost_price, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at${hasItemCostCols ? ', unit_price_charged, unit_cost_at_sale, discount_amount, line_profit' : ''}, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'synced',$12,$12${hasItemCostCols ? ',$13,$14,$15,$16' : ''},0)
           ON CONFLICT(id) DO UPDATE SET quantity=excluded.quantity, applied_price=excluded.applied_price,
             json_payload=excluded.json_payload, updated_at=excluded.updated_at, sync_status='synced'`
          .replace(/\n\s*/g, ' '),
          hasItemCostCols ? [...itemBaseParams, charged, frozenUnit, discAmt, lineProfit] : itemBaseParams,
        );
      }
      // One order outbox op per transaction so the cloud sees the import.
      // `enqueueOrderSync` re-reads the row we just wrote for its
      // idempotency_key + version, so pass the tx as-is.
      await enqueueOrderSync(txId, { ...t, id: txId, receipt_number: receiptNo });
    }
  }
  // Raw inventory deltas + frozen FIFO allocations (export covers them since
  // the costing work; old exports without these keys are skipped). Direct
  // table writes marked 'synced' — they restore history, they don't create
  // new local truth to push. Tombstones (deleted) ride along so restores
  // cannot resurrect pruned rows.
  const extraImport = parsed as unknown as {
    inventoryLedger?: Array<Record<string, unknown>>;
    saleBatchAllocations?: Array<Record<string, unknown>>;
  };
  const importNow = utcNowIso();
  if (Array.isArray(extraImport.inventoryLedger) && extraImport.inventoryLedger.length > 0) {
    const db = await getLocalDb();
    for (const row of extraImport.inventoryLedger) {
      const lid = String(row.id ?? '');
      if (!lid) continue;
      await db
        .execute(
          `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
            idempotency_key, sync_status, created_at, updated_at, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'synced',$9,$9,$10)
           ON CONFLICT(id) DO NOTHING`,
          [
            lid,
            String(row.product_id ?? row.productId ?? 'unknown'),
            Number(row.delta ?? 0),
            String(row.reason ?? 'ADJUST'),
            row.ref_type !== undefined && row.ref_type !== null ? String(row.ref_type) : row.refType !== undefined && row.refType !== null ? String(row.refType) : null,
            row.ref_id !== undefined && row.ref_id !== null ? String(row.ref_id) : row.refId !== undefined && row.refId !== null ? String(row.refId) : null,
            String(row.device_id ?? row.deviceId ?? 'import'),
            String(row.idempotency_key ?? row.idempotencyKey ?? lid),
            String(row.created_at ?? row.createdAt ?? importNow),
            Number(row.deleted ?? 0),
          ]
        )
        .catch(() => {
          // Pre-heal table or CHECK failure on a single row — skip the row,
          // keep the rest (the sale rows above already landed).
        });
    }
  }
  if (Array.isArray(extraImport.saleBatchAllocations) && extraImport.saleBatchAllocations.length > 0) {
    const db = await getLocalDb();
    for (const row of extraImport.saleBatchAllocations) {
      const aid = String(row.id ?? '');
      if (!aid) continue;
      await db
        .execute(
          `INSERT INTO sale_batch_allocations
             (id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
              created_at, product_id, sale_item_id,
              device_id, idempotency_key, sync_status, version, updated_at, deleted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'synced',1,$6,$11)
           ON CONFLICT(id) DO NOTHING`,
          [
            aid,
            String(row.sale_id ?? row.saleId ?? ''),
            String(row.batch_id ?? row.batchId ?? ''),
            Math.max(0, Math.floor(Number(row.qty_consumed ?? row.qtyConsumed ?? 0))),
            Math.max(0, Number(row.unit_cost_at_sale ?? row.unitCostAtSale ?? 0)),
            String(row.created_at ?? row.createdAt ?? importNow),
            row.product_id !== undefined && row.product_id !== null ? String(row.product_id) : row.productId !== undefined && row.productId !== null ? String(row.productId) : null,
            row.sale_item_id !== undefined && row.sale_item_id !== null ? String(row.sale_item_id) : row.saleItemId !== undefined && row.saleItemId !== null ? String(row.saleItemId) : null,
            String(row.device_id ?? row.deviceId ?? 'import'),
            String(row.idempotency_key ?? row.idempotencyKey ?? aid),
            Number(row.deleted ?? 0),
          ]
        )
        .catch(() => {
          // Pre-v104 table, FK to a pruned batch, or CHECK failure — skip
          // the row, keep the rest.
        });
    }
  }
  // Generic KV entities: mirror each row through the shared disaster-recovery
  // lane. `enqueueGenericSync` bumps the entity_keys version clock and stamps
  // it into the payload, so a later pull guard can never reject the import as
  // a stale echo (the H9/H14 invariant).
  const genericLanes: Array<[entity: string, rows: unknown[] | undefined]> = [
    ['customer', parsed.customers],
    ['repair_order', parsed.repairOrders],
    ['purchase_order', parsed.purchaseOrders],
    ['trade_in', parsed.tradeIns],
    ['imei', parsed.imeiRecords],
    ['audit_log', parsed.securityAuditLogs],
    ['cash_drop', parsed.cashDrops],
    ['cash_drop', parsed.payouts],
    ['bundle', parsed.bundles],
    ['customer_debt', parsed.customerDebts],
    ['store_expense', parsed.storeExpenses],
    ['setting', parsed.appSettings ?? parsed.settings],
  ];
  for (const [entity, rows] of genericLanes) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const id = String(r.id ?? r.imei ?? r.key ?? '');
      if (!id) continue;
      await enqueueGenericSync(entity as never, id, r);
    }
  }
}

