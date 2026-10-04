import type {
  Product,
  Customer,
  SaleTransaction,
  SecurityAuditLogEntry,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { sortTransactionsNewestFirst } from '../../utils/dateUtils';
import { fireSync, isTauriEnv } from './base';
import { getLocalDb, beginImmediate, utcNowIso } from '../sqlPluginAdapter';
import { buildOrderOutboxInsert, existingRowOutboxKey, newReceiptOutboxKey } from '../../sync/outboxFold';
import { withWriteLock } from '../writeMutex';
import { withBusyRetry, isBusyError } from '../busyRetry';

/**
 * Same-window double-submit guards. A double-tap on "Annuler" / "Rembourser"
 * (or a relayed hotkey firing twice) must not run the same void/refund twice:
 * the second call throws ALREADY_PROCESSING while the first is in flight.
 * Sequential duplicates are caught separately by the in-transaction re-reads
 * below; these Sets only cover the concurrent window. Always cleared in
 * `finally` so a failure can never wedge later voids/refunds.
 */
const voidInFlight = new Set<string>();
const refundInFlight = new Set<string>();

function refundFlightKey(refundTransaction: SaleTransaction): string {
  const items = (refundTransaction.refundedItems ?? [])
    .map((ri) => `${ri.productId}:${ri.quantity}:${ri.restock ? 1 : 0}`)
    .sort()
    .join(',');
  return `${refundTransaction.originalTransactionId ?? refundTransaction.id}|${items}`;
}

/** Purchased quantities per product from the original sale's line items. */
function purchasedQtyByProduct(txn: SaleTransaction | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of txn?.items ?? []) {
    const pid = i.product?.id;
    if (!pid) continue;
    out.set(pid, (out.get(pid) ?? 0) + Math.abs(Number(i.quantity ?? 0)));
  }
  return out;
}

/** Requested quantities per product from the refund's refunded-items list. */
function requestedQtyByProduct(refundTransaction: SaleTransaction): Map<string, number> {
  const out = new Map<string, number>();
  for (const ri of refundTransaction.refundedItems ?? []) {
    out.set(ri.productId, (out.get(ri.productId) ?? 0) + Number(ri.quantity ?? 0));
  }
  return out;
}

/**
 * Result channel for the atomic void/refund paths. `warnings` carries
 * non-fatal post-commit failures (currently: SQLite IMEI-release resets) that
 * previously vanished into console.warn — the Dexie release already committed
 * inside the atomic block, but the SQLite mirror row can stay stuck 'sold',
 * so callers MUST surface these (toast / audit) instead of dropping them.
 */
export interface ImeiReleaseResult {
  warnings?: string[];
}

/**
 * Enterprise audit telemetry backfill: atomic sale/void/refund lanes put the
 * audit row directly (no operationsAdapter hop), so entries built by callers
 * without device/IP would otherwise persist with empty telemetry and break
 * the "Terminal / IP" expansion + PDF/A-3 traceability. Best-effort, never
 * throws — the financial write must not fail over a bookkeeping field.
 */
async function enrichAuditTelemetry(
  entry: SecurityAuditLogEntry | undefined
): Promise<SecurityAuditLogEntry | undefined> {
  if (!entry) return entry;
  const needsDevice = !entry.deviceId;
  const needsIp = !entry.ipAddress;
  const needsTs = !entry.timestamp || !entry.timestamp.includes('T');
  if (!needsDevice && !needsIp && !needsTs) return entry;
  try {
    const { getDeviceId, getIpAddress } = await import('../../utils/deviceInfo');
    return {
      ...entry,
      timestamp: needsTs ? new Date().toISOString() : entry.timestamp,
      deviceId: entry.deviceId || getDeviceId(),
      ipAddress: entry.ipAddress || (await getIpAddress().catch(() => 'Non détectée (hors-ligne)')),
    };
  } catch {
    return {
      ...entry,
      timestamp: needsTs ? new Date().toISOString() : entry.timestamp,
    };
  }
}

export const transactionAdapter = {
  async processSaleTransactionAtomic(
    transaction: SaleTransaction,
    updatedProducts: Product[],
    updatedCustomer?: Customer,
    auditEntry?: SecurityAuditLogEntry
  ): Promise<void> {
    const enrichedAudit = await enrichAuditTelemetry(auditEntry);
    // Persist to Dexie in single transaction
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs], async () => {
      await dexieDb.transactions.put(transaction);
      await dexieDb.products.bulkPut(updatedProducts);
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (enrichedAudit) {
        await dexieDb.securityAuditLogs.put(enrichedAudit);
      }
    });
    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (enrichedAudit) void fireSync('audit_log', enrichedAudit.id, enrichedAudit);
  },

  async getAllTransactions(): Promise<SaleTransaction[]> {
    // Newest-first: Dexie index scan (createdAt, see database.ts) for the
    // coarse order, then the canonical comparator defensively re-sorts so
    // legacy / non-ISO strings still land deterministically (invalid sinks).
    try {
      const ordered = await dexieDb.transactions.orderBy('createdAt').reverse().toArray();
      return sortTransactionsNewestFirst(ordered);
    } catch {
      return sortTransactionsNewestFirst(await dexieDb.transactions.toArray());
    }
  },

  async voidTransactionAtomic(
    _transactionId: string,
    voidedTransaction: SaleTransaction,
    restoredProducts: Product[],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<ImeiReleaseResult> {
    const warnings: string[] = [];
    const flightKey = String(_transactionId || voidedTransaction.id);
    if (voidInFlight.has(flightKey)) {
      throw new Error('ALREADY_PROCESSING');
    }
    voidInFlight.add(flightKey);
    const enrichedAudit = await enrichAuditTelemetry(auditEntry);
    try {
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs, dexieDb.imeiRecords], async () => {
      // In-transaction re-read: a sequential duplicate void lands here after
      // the first void already flipped the mirror to VOIDED — abort instead
      // of re-applying loyalty/stock rollbacks a second time.
      const existing = await dexieDb.transactions.get(voidedTransaction.id).catch(() => undefined);
      if (existing && (existing as SaleTransaction).status === 'VOIDED') {
        throw new Error('ALREADY_VOIDED');
      }
      // Cross-operation guard (same atomicity): voiding a refunded ticket
      // would re-restore the refunded leg while the refund payout stays
      // booked. Refunded tickets move only via further per-leg refunds.
      const existingStatus = String((existing as SaleTransaction | undefined)?.status ?? '');
      if (existing && (existingStatus === 'REFUNDED' || existingStatus === 'PARTIALLY_REFUNDED')) {
        throw new Error('REFUNDED_TICKET');
      }
      await dexieDb.transactions.put(voidedTransaction);
      if (restoredProducts.length > 0) {
        await dexieDb.products.bulkPut(restoredProducts);
      }
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (enrichedAudit) {
        await dexieDb.securityAuditLogs.put(enrichedAudit);
      }
      if (restoredImeis.length > 0) {
        for (const imei of restoredImeis) {
          const rec = await dexieDb.imeiRecords.get(imei);
          if (rec) {
            await dexieDb.imeiRecords.put({
              ...rec,
              saleTransactionId: undefined,
              soldAt: undefined,
            });
          }
        }
      }
    });

    if (isTauriEnv()) {
      await withBusyRetry(
        () =>
          withWriteLock(async () => {
      try {
        const db = await getLocalDb();
        const useTxn = await beginImmediate(db, 'db:void');
        try {
          // In-SQLite-transaction re-read of the durable status: cross-tab /
          // cross-window duplicate voids serialize here and the loser aborts.
          // Missing row (SQLite lane never saw the sale) skips the check.
          const statusRows = (await db
            .select('SELECT status, version, idempotency_key FROM transactions WHERE id=$1', [voidedTransaction.id])
            .catch((e: unknown) => {
              if (isBusyError(e)) throw e;
              return [];
            })) as Array<{ status?: string; version?: number; idempotency_key?: string }>;
          const sqliteStatus = String(statusRows?.[0]?.status ?? '');
          if (sqliteStatus === 'VOIDED') {
            throw new Error('ALREADY_VOIDED');
          }
          if (sqliteStatus === 'REFUNDED' || sqliteStatus === 'PARTIALLY_REFUNDED') {
            throw new Error('REFUNDED_TICKET');
          }
          // B-020: flip authority status in the SAME txn as IMEI release so a
          // crash between Dexie put and enqueueOrderSync cannot leave SQLite
          // COMPLETED while Dexie is VOIDED (stale-echo split-brain).
          await db.execute(
            `UPDATE transactions SET status='VOIDED', updated_at=$2, version = version + 1, sync_status='pending' WHERE id=$1`,
            [voidedTransaction.id, new Date().toISOString()]
          ).catch((updErr: unknown) => {
            if (isBusyError(updErr)) throw updErr;
            // Row may not exist yet in SQLite lane — non-fatal (enqueue later).
            console.warn('[db:void] status flip skipped:', updErr);
          });
          // C1 (DB-012): fold the outbox row into the SAME txn as the money
          // flip. A crash after COMMIT then leaves peers converging via this
          // row; the later enqueueOrderSync refreshes it idempotently onto
          // the same key (harmless version re-bump, never a duplicate
          // payout). Best-effort with a warning, like the IMEI lane below:
          // an outbox failure must not roll back a durable flip.
          try {
            const outboxNow = utcNowIso();
            const baseVersion = Number(
              statusRows?.[0]?.version ?? (voidedTransaction as unknown as { version?: number }).version ?? 0,
            );
            const outboxKey = existingRowOutboxKey(voidedTransaction.id, statusRows?.[0]?.idempotency_key);
            const outbox = buildOrderOutboxInsert(
              voidedTransaction.id,
              outboxKey,
              {
                ...(voidedTransaction as unknown as Record<string, unknown>),
                receipt_number: voidedTransaction.receiptNumber,
                created_at: voidedTransaction.createdAt,
                idempotency_key: outboxKey,
                updated_at: outboxNow,
                version: baseVersion + 1,
              },
              outboxNow,
            );
            await db.execute(outbox.sql, outbox.args as unknown[]);
          } catch (outboxErr: unknown) {
            if (isBusyError(outboxErr)) throw outboxErr;
            const msg = '[db:void] Outbox fold skipped — peers converge on the later enqueue (or not at all after a crash in between).';
            console.warn(msg, outboxErr);
            warnings.push(msg);
          }
          for (const imei of restoredImeis) {
            try {
              await db.execute(
                'UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = $1',
                [imei]
              );
            } catch (imeiErr) {
              const msg = `[db:void] IMEI ${imei} resté 'sold' dans SQLite (miroir Dexie libéré) — re-synchroniser manuellement.`;
              console.warn(msg, imeiErr);
              warnings.push(msg);
            }
          }
          if (useTxn) {
            await db.execute('COMMIT;');
          }
        } catch (txnErr) {
          if (useTxn) {
            await db.execute('ROLLBACK;').catch(() => {});
          }
          throw txnErr;
        }
      } catch (err) {
        if (err instanceof Error && (err.message === 'ALREADY_VOIDED' || err.message === 'REFUNDED_TICKET')) {
          throw err;
        }
        // BUSY must retry, not degrade to a warning — a void that only
        // releases Dexie while SQLite stays 'sold' diverges the mirrors.
        if (isBusyError(err)) throw err;
        const msg = '[db:void] Connexion SQLite indisponible — libérations IMEI non répercutées (miroir Dexie libéré).';
        console.warn(msg, err);
        warnings.push(msg);
      }
          }),
        { attempts: 6, baseDelayMs: 80, label: 'void' },
      );
    }

    if (restoredImeis.length > 0) {
      for (const imei of restoredImeis) {
        const rec = await dexieDb.imeiRecords.get(imei);
        if (rec) void fireSync('imei', imei, rec);
      }
    }

    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (enrichedAudit) void fireSync('audit_log', enrichedAudit.id, enrichedAudit);
    return warnings.length > 0 ? { warnings } : {};
    } finally {
      voidInFlight.delete(flightKey);
    }
  },

  async processRefundAtomic(
    refundTransaction: SaleTransaction,
    updatedOriginalTransaction?: SaleTransaction,
    restockedProducts: Product[] = [],
    updatedCustomer?: Customer,
    restoredImeis: string[] = [],
    auditEntry?: SecurityAuditLogEntry
  ): Promise<ImeiReleaseResult> {
    const warnings: string[] = [];
    const flightKey = refundFlightKey(refundTransaction);
    if (refundInFlight.has(flightKey)) {
      throw new Error('ALREADY_PROCESSING');
    }
    refundInFlight.add(flightKey);
    const enrichedRefundAudit = await enrichAuditTelemetry(auditEntry);
    try {
    // In-transaction re-read of the over-refund bound (both mirrors): the
    // pre-write check in the slice races a second refund, so the bound is
    // re-derived here from durable rows — purchased (original items) minus
    // already-refunded (committed refund rows) — inside each transaction.
    const assertRefundBound = (alreadyRefunded: Map<string, number>) => {
      if (!updatedOriginalTransaction) return;
      const purchased = purchasedQtyByProduct(updatedOriginalTransaction);
      const requested = requestedQtyByProduct(refundTransaction);
      for (const [pid, qty] of requested) {
        const remaining = (purchased.get(pid) ?? 0) - (alreadyRefunded.get(pid) ?? 0);
        if (qty > remaining) {
          throw new Error(`REFUND_EXCEEDS:${pid}`);
        }
      }
    };
    await dexieDb.transaction('rw', [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs, dexieDb.imeiRecords], async () => {
      const originalId = refundTransaction.originalTransactionId;
      // Cross-operation guard (same atomicity as the bound re-read below):
      // refunding a voided ticket would pay out on a cancelled sale — the
      // void already restored stock and reversed loyalty.
      if (originalId) {
        const origRow = await dexieDb.transactions.get(originalId).catch(() => undefined);
        if (origRow && (origRow as SaleTransaction).status === 'VOIDED') {
          throw new Error('ORIGINAL_VOIDED');
        }
      }
      if (originalId && updatedOriginalTransaction) {
        const prior = new Map<string, number>();
        const all = await dexieDb.transactions.toArray().catch(() => []);
        for (const t of all) {
          const rt = t as SaleTransaction;
          if (rt.isRefund && rt.originalTransactionId === originalId && rt.id !== refundTransaction.id) {
            for (const ri of rt.refundedItems ?? []) {
              prior.set(ri.productId, (prior.get(ri.productId) ?? 0) + Number(ri.quantity ?? 0));
            }
          }
        }
        assertRefundBound(prior);
      }
      await dexieDb.transactions.put(refundTransaction);
      if (updatedOriginalTransaction) {
        await dexieDb.transactions.put(updatedOriginalTransaction);
      }
      if (restockedProducts.length > 0) {
        await dexieDb.products.bulkPut(restockedProducts);
      }
      if (updatedCustomer) {
        await dexieDb.customers.put(updatedCustomer);
      }
      if (enrichedRefundAudit) {
        await dexieDb.securityAuditLogs.put(enrichedRefundAudit);
      }
      if (restoredImeis.length > 0) {
        for (const imei of restoredImeis) {
          const rec = await dexieDb.imeiRecords.get(imei);
          if (rec) {
            await dexieDb.imeiRecords.put({
              ...rec,
              saleTransactionId: undefined,
              soldAt: undefined,
            });
          }
        }
      }
    });

    if (isTauriEnv()) {
      await withBusyRetry(
        () =>
          withWriteLock(async () => {
      try {
        const db = await getLocalDb();
        const useTxn = await beginImmediate(db, 'db:refund');
        try {
          // In-SQLite-transaction re-read of the durable refund bound.
          const originalId = refundTransaction.originalTransactionId;
          // Cross-operation guard, SQLite mirror: a void that landed after
          // the Dexie gate must still refuse the payout here.
          if (originalId) {
            const stRows = (await db
              .select('SELECT status FROM transactions WHERE id = $1', [originalId])
              .catch((e: unknown) => {
                if (isBusyError(e)) throw e;
                return [];
              })) as Array<{ status?: string }>;
            if (stRows?.[0] && String(stRows[0].status ?? '') === 'VOIDED') {
              throw new Error('ORIGINAL_VOIDED');
            }
          }
          if (originalId && updatedOriginalTransaction) {
            const prior = new Map<string, number>();
            const collectRefundRow = (parsed: {
              id?: string; originalTransactionId?: string; refundedItems?: Array<{ productId?: string; quantity?: number }>;
            }): void => {
              if (parsed.originalTransactionId === originalId && parsed.id !== refundTransaction.id) {
                for (const ri of parsed.refundedItems ?? []) {
                  if (ri.productId) {
                    prior.set(ri.productId, (prior.get(ri.productId) ?? 0) + Number(ri.quantity ?? 0));
                  }
                }
              }
            };
            const parseRow = (jsonPayload: unknown): void => {
              try {
                collectRefundRow(JSON.parse(String(jsonPayload ?? '{}')) as {
                  id?: string; originalTransactionId?: string; refundedItems?: Array<{ productId?: string; quantity?: number }>;
                });
              } catch {
                // Unparseable receipt payload — ignore this row, keep the bound.
              }
            };
            // DB-002: indexed primary on original_transaction_id (stamped at
            // write, backfilled once for legacy rows) plus a LIKE residual
            // for rows whose column is still NULL (fallback-statement
            // writes on pre-linkage schemas). Same bound as the old full
            // scan, without scanning the whole history per refund.
            let boundRows: Array<{ json_payload?: string }> | null = null;
            try {
              boundRows = (await db.select(
                "SELECT json_payload FROM transactions WHERE deleted = 0 AND (original_transaction_id = $1 OR (original_transaction_id IS NULL AND json_payload LIKE '%originalTransactionId%'))",
                [originalId],
              )) as Array<{ json_payload?: string }>;
            } catch (e: unknown) {
              if (isBusyError(e)) throw e;
              // Pre-linkage schema (no column yet): legacy full scan. Slow
              // but complete — never an empty bound.
              boundRows = (await db
                .select("SELECT json_payload FROM transactions WHERE deleted = 0 AND json_payload LIKE '%originalTransactionId%'")
                .catch((legacyErr: unknown) => {
                  if (isBusyError(legacyErr)) throw legacyErr;
                  return [];
                })) as Array<{ json_payload?: string }>;
            }
            for (const row of boundRows ?? []) {
              parseRow(row.json_payload);
            }
            assertRefundBound(prior);
          }
          // C1 (DB-012): fold the original's status flip and BOTH outbox
          // rows (original + refund receipt) into the SAME txn. A crash
          // after COMMIT leaves peers converging via these rows; the later
          // writeCheckoutAtomic/enqueueOrderSync calls refresh them
          // idempotently onto the same keys (monotonic re-bump, never a
          // duplicate payout). The receipt's SQLite row itself still lands
          // via the existing F3 replay path (replay-safe short-circuit).
          if (originalId && updatedOriginalTransaction) {
            const outboxNow = utcNowIso();
            try {
              const origRows = (await db
                .select('SELECT version, idempotency_key FROM transactions WHERE id = $1', [originalId])
                .catch((e: unknown) => {
                  if (isBusyError(e)) throw e;
                  return [];
                })) as Array<{ version?: number; idempotency_key?: string }>;
              if (origRows?.[0]) {
                const bumped = Number(origRows[0].version ?? 0) + 1;
                await db.execute(
                  `UPDATE transactions SET status=$1, updated_at=$2, version=$3, sync_status='pending' WHERE id=$4`,
                  [updatedOriginalTransaction.status, outboxNow, bumped, originalId],
                );
                const origKey = existingRowOutboxKey(originalId, origRows[0].idempotency_key);
                const origOutbox = buildOrderOutboxInsert(
                  originalId,
                  origKey,
                  {
                    ...(updatedOriginalTransaction as unknown as Record<string, unknown>),
                    receipt_number: updatedOriginalTransaction.receiptNumber,
                    created_at: updatedOriginalTransaction.createdAt,
                    idempotency_key: origKey,
                    updated_at: outboxNow,
                    version: bumped,
                  },
                  outboxNow,
                );
                await db.execute(origOutbox.sql, origOutbox.args as unknown[]);
              } else {
                console.warn('[db:refund] original row absent in SQLite — status flip deferred (enqueue later).');
              }
            } catch (flipErr: unknown) {
              if (isBusyError(flipErr)) throw flipErr;
              const msg = '[db:refund] Original status flip skipped — peers converge on the later enqueue (or not at all after a crash in between).';
              console.warn(msg, flipErr);
              warnings.push(msg);
            }
            try {
              const receiptKey = newReceiptOutboxKey(
                refundTransaction.id,
                (refundTransaction as unknown as { idempotency_key?: string }).idempotency_key,
              );
              const receiptOutbox = buildOrderOutboxInsert(
                refundTransaction.id,
                receiptKey,
                {
                  ...(refundTransaction as unknown as Record<string, unknown>),
                  receipt_number: refundTransaction.receiptNumber,
                  created_at: refundTransaction.createdAt,
                  idempotency_key: receiptKey,
                  updated_at: outboxNow,
                  version: 1,
                },
                outboxNow,
              );
              await db.execute(receiptOutbox.sql, receiptOutbox.args as unknown[]);
            } catch (receiptErr: unknown) {
              if (isBusyError(receiptErr)) throw receiptErr;
              const msg = '[db:refund] Refund-receipt outbox fold skipped — peers converge on the later enqueue (or not at all after a crash in between).';
              console.warn(msg, receiptErr);
              warnings.push(msg);
            }
          }
          for (const imei of restoredImeis) {
            try {
              await db.execute(
                'UPDATE imei_records SET sale_transaction_id = NULL, sold_at = NULL, version = version + 1 WHERE imei = $1',
                [imei]
              );
            } catch (imeiErr) {
              const msg = `[db:refund] IMEI ${imei} resté 'sold' dans SQLite (miroir Dexie libéré) — re-synchroniser manuellement.`;
              console.warn(msg, imeiErr);
              warnings.push(msg);
            }
          }
          if (useTxn) {
            await db.execute('COMMIT;');
          }
        } catch (txnErr) {
          if (useTxn) {
            await db.execute('ROLLBACK;').catch(() => {});
          }
          throw txnErr;
        }
      } catch (err) {
        if (err instanceof Error && (err.message === 'ALREADY_PROCESSING' || err.message.startsWith('REFUND_EXCEEDS') || err.message === 'ORIGINAL_VOIDED')) {
          throw err;
        }
        if (isBusyError(err)) throw err;
        const msg = '[db:refund] Connexion SQLite indisponible — libérations IMEI non répercutées (miroir Dexie libéré).';
        console.warn(msg, err);
        warnings.push(msg);
      }
          }),
        { attempts: 6, baseDelayMs: 80, label: 'refund' },
      );
    }

    if (restoredImeis.length > 0) {
      for (const imei of restoredImeis) {
        const rec = await dexieDb.imeiRecords.get(imei);
        if (rec) void fireSync('imei', imei, rec);
      }
    }

    if (updatedCustomer) void fireSync('customer', updatedCustomer.id, updatedCustomer);
    if (enrichedRefundAudit) void fireSync('audit_log', enrichedRefundAudit.id, enrichedRefundAudit);
    return warnings.length > 0 ? { warnings } : {};
    } finally {
      refundInFlight.delete(flightKey);
    }
  },
};
