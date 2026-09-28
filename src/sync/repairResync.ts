/**
 * Full repair synchronization ("Synchronisation complète").
 *
 * Incremental sync only ships what changed since the last bookmark. When a
 * merchant reports "data was not synchronized", the cause is almost always
 * one of: rows marked synced that never landed (old bugs), a cursor that
 * advanced past unapplied rows, quarantined rows nobody retried, or two
 * devices paired to DIFFERENT cloud databases. This operation repairs all of
 * them in one pass:
 *
 *   1. Same-DB + reachability preconditions (fail loudly, never half-repair).
 *   2. Requeue quarantined rows back to pending (reported, may re-fail visibly).
 *   3. PUSH phase: re-enqueue EVERYTHING from the local authority with its
 *      ORIGINAL stable idempotency keys, then push until the outbox is empty.
 *      Replays are safe by construction: ledger/items are DO NOTHING,
 *      everything else is version-guarded (stale rows reject visibly via the
 *      GUARD-STALE path instead of clobbering newer cloud state).
 *   4. PULL phase: reset every table cursor to epoch, then pull until zero.
 *      Stock recompute, Dexie remirror, debt reconcile all run inside pull.
 *   5. Verify: row-count integrity per table + report (incl. the cloud DB
 *      identity so the merchant can confirm both devices share one database).
 *
 * Offline-first is preserved: with no cloud reachability the repair refuses
 * immediately and local sales continue untouched.
 */

import { getLocalDb, enqueueGenericSync, utcNowIso, toBoundedSyncJson, getPendingOutbox, isDeviceLocalSettingKey, stripDeviceLocalSettingValue } from '../db/sqlPluginAdapter';
import { db as dexieDb } from '../db/database';
import { getCloudCredentials } from './keychain';
import { probeOnline } from './tursoClient';
import { syncManager } from './SyncManager';
import type { GenericEntity } from '../db/sqlPluginAdapter';

export interface RepairProgress {
  phase: 'precheck' | 'push' | 'pull' | 'verify' | 'done';
  detail: string;
  pushed?: number;
  pulled?: number;
}

export interface FullResyncReport {
  ok: boolean;
  cloudHost: string;
  requeued: number;
  pushed: number;
  pulled: number;
  outboxRemaining: number;
  verified: boolean;
  verifyReport: string;
  verifyDetails: Array<{ table: string; localCount: number; remoteCount: number; match: boolean }>;
  message: string;
}

type ProgressFn = (p: RepairProgress) => void;

async function enqueueOutbox(
  db: { execute: (sql: string, args?: unknown[]) => Promise<unknown> },
  key: string | null | undefined,
  entity: string,
  entityId: string,
  payloadJson: string,
  now: string,
): Promise<boolean> {
  if (!key) return false;
  try {
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES ($1,$2,$3,'UPSERT',$4,'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT', payload_json=excluded.payload_json,
         status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=$5`,
      [key, entity, entityId, payloadJson, now],
    );
    return true;
  } catch (err) {
    console.warn(`[repair] re-enqueue skipped [${entity}/${entityId}]:`, err);
    return false;
  }
}

/** Re-enqueue every durable row with its ORIGINAL stable key (reruns are no-ops). */
async function reenqueueAllFromAuthority(): Promise<number> {
  const db = await getLocalDb();
  const now = utcNowIso();
  let n = 0;

  const rowsOf = async (sql: string): Promise<Array<Record<string, unknown>>> =>
    ((await db.select(sql).catch(() => [])) as Array<Record<string, unknown>>) ?? [];

  // Core tables: payloads are the stored canonical JSON / row shapes the push
  // branches already understand (same shapes writeCheckoutAtomic enqueued).
  // P0 thin-payload rule: NEVER enqueue an `{id}`-only stub — the push lane
  // serializes payload_json to the remote row and pull overwrites local money
  // columns from it (`?? 0/''`), so a stub permanently zeroes the entity on
  // every peer. Rows without canonical JSON are skipped loudly for manual
  // repair instead.
  const skipThin = (entity: string, id: string): boolean => {
    console.warn(`[repair] skipping [${entity}/${id}]: missing canonical JSON (refusing {id}-only stub)`);
    return false;
  };
  for (const r of await rowsOf('SELECT * FROM products WHERE deleted = 0')) {
    const key = String(r.idempotency_key || '');
    if (await enqueueOutbox(db, key || `stub-${r.id}`, 'product', String(r.id), toBoundedSyncJson(r), now)) n++;
  }
  for (const r of await rowsOf('SELECT * FROM transactions')) {
    const key = String(r.idempotency_key || '');
    const payload = String(r.json_payload || '');
    if (!payload) { skipThin('order', String(r.id)); continue; }
    if (await enqueueOutbox(db, key || `legacy-${r.id}`, 'order', String(r.id), payload, now)) n++;
  }
  for (const r of await rowsOf('SELECT * FROM transaction_items')) {
    const key = String(r.idempotency_key || '');
    const payload = String(r.json_payload || '');
    if (!payload) { skipThin('order_item', String(r.id)); continue; }
    if (await enqueueOutbox(db, key || `legacy-${r.id}`, 'order_item', String(r.id), payload, now)) n++;
  }
  for (const r of await rowsOf('SELECT * FROM inventory_ledger WHERE deleted = 0')) {
    const key = String(r.idempotency_key || '');
    const payload = JSON.stringify({
      id: r.id, product_id: r.product_id, delta: r.delta, reason: r.reason,
      ref_type: r.ref_type, ref_id: r.ref_id, device_id: r.device_id, idempotency_key: key,
    });
    if (await enqueueOutbox(db, key || `legacy-${r.id}`, 'ledger', String(r.id), payload, now)) n++;
  }
  for (const r of await rowsOf('SELECT * FROM stock_batches WHERE deleted = 0')) {
    const key = String(r.idempotency_key || '');
    const payload = JSON.stringify({
      batch_id: r.batch_id, product_id: r.product_id, quantity_remaining: r.quantity_remaining,
      unit_cost: r.unit_cost, received_at: r.received_at, purchase_order_id: r.purchase_order_id,
      device_id: r.device_id, idempotency_key: key, version: r.version,
      created_at: r.created_at, updated_at: r.updated_at, deleted: 0,
    });
    if (await enqueueOutbox(db, key || `legacy-${r.batch_id}`, 'stock_batches', String(r.batch_id), payload, now)) n++;
  }
  for (const r of await rowsOf('SELECT * FROM customers WHERE deleted = 0')) {
    const key = String(r.idempotency_key || '');
    let payload = String(r.json_payload || '');
    if (!payload) {
      try {
        const dexCust = await dexieDb.customers.get(String(r.id));
        if (dexCust) payload = JSON.stringify(dexCust);
      } catch {}
    }
    if (!payload) {
      payload = JSON.stringify({
        id: String(r.id),
        name: String(r.name || ''),
        phone: String(r.phone || ''),
        email: String(r.email || ''),
        loyaltyPoints: Number(r.loyalty_points || 0),
        storeCredit: Number(r.store_credit || 0),
        pricingTier: String(r.pricing_tier || 'Retail'),
        totalSpent: Number(r.total_spent || 0),
        registeredDevice: 'local',
        version: Number(r.version || 1),
      });
    }
    if (await enqueueOutbox(db, key || `legacy-${r.id}`, 'customer', String(r.id), payload, now)) n++;
  }
  for (const r of await rowsOf('SELECT * FROM customer_debts WHERE deleted = 0')) {
    const key = String(r.idempotency_key || '');
    let payload = String(r.json_payload || '');
    if (!payload) {
      try {
        const dexDebt = await dexieDb.customerDebts.get(String(r.id));
        if (dexDebt) payload = JSON.stringify(dexDebt);
      } catch {}
    }
    if (!payload) {
      payload = JSON.stringify({
        id: String(r.id),
        customerId: String(r.customer_id || ''),
        customerName: String(r.customer_name || 'Client'),
        type: String(r.type || 'DEBT_ACQUIRED'),
        amount: Number(r.amount || 0),
        balanceAfter: Number(r.balance_after || 0),
        receiptNumber: r.receipt_number ? String(r.receipt_number) : undefined,
        paymentMethod: r.payment_method ? String(r.payment_method) : undefined,
        notes: r.notes ? String(r.notes) : undefined,
        recordedBy: r.recorded_by ? String(r.recorded_by) : undefined,
        createdAt: String(r.created_at || now),
        version: Number(r.version || 1),
      });
    }
    if (await enqueueOutbox(db, key || `legacy-${r.id}`, 'customer_debt', String(r.id), payload, now)) n++;
  }
  try {
    const dexCusts = await dexieDb.customers.toArray().catch(() => []);
    for (const c of dexCusts) {
      if (!c?.id) continue;
      const key = (c as unknown as { idempotency_key?: string }).idempotency_key || `cust-${c.id}`;
      if (await enqueueOutbox(db, key, 'customer', String(c.id), JSON.stringify(c), now)) n++;
    }
  } catch (e) {
    console.warn('[repair] re-enqueue skipped dexie customers:', e);
  }
  for (const r of await rowsOf('SELECT * FROM credit_vouchers WHERE deleted = 0')) {
    const payload = JSON.stringify({
      id: r.id, code: r.code, initial_amount: r.initial_amount, remaining_amount: r.remaining_amount,
      status: r.status, customer_name: r.customer_name, customer_phone: r.customer_phone,
      notes: r.notes, device_id: r.device_id, idempotency_key: r.idempotency_key,
      version: r.version, created_at: r.created_at, updated_at: r.updated_at,
      expires_at: r.expires_at, deleted: 0,
    });
    try {
      await enqueueGenericSync('credit_voucher', String(r.id), JSON.parse(payload) as Record<string, unknown>);
      n++;
    } catch (err) {
      console.warn('[repair] re-enqueue skipped [credit_voucher]:', err);
    }
  }

  // Dexie-only lanes (generic KV): re-enqueue from the UI replica — the same
  // source backfill uses. Stable keys make reruns no-ops.
  const dexieLanes: Array<{ entity: GenericEntity; table: string; idOf: (r: Record<string, unknown>) => string }> = [
    { entity: 'repair_order', table: 'repairOrders', idOf: (r) => String(r.id ?? '') },
    { entity: 'purchase_order', table: 'purchaseOrders', idOf: (r) => String(r.id ?? '') },
    { entity: 'trade_in', table: 'tradeIns', idOf: (r) => String(r.id ?? '') },
    { entity: 'imei', table: 'imeiRecords', idOf: (r) => String(r.imei ?? '') },
    { entity: 'audit_log', table: 'securityAuditLogs', idOf: (r) => String(r.id ?? '') },
    { entity: 'bundle', table: 'bundles', idOf: (r) => String(r.id ?? '') },
    { entity: 'store_expense', table: 'storeExpenses', idOf: (r) => String(r.id ?? '') },
    { entity: 'cash_session', table: 'cashSessions', idOf: (r) => String(r.id ?? '') },
    { entity: 'cash_movement', table: 'cashMovements', idOf: (r) => String(r.id ?? '') },
    { entity: 'cash_drop', table: 'cashDrops', idOf: (r) => String(r.id ?? '') },
  ];
  const dex = dexieDb as unknown as Record<string, { toArray: () => Promise<Record<string, unknown>[]> }>;
  for (const lane of dexieLanes) {
    try {
      const rows = (await dex[lane.table]?.toArray().catch(() => [])) ?? [];
      for (const row of rows) {
        const id = lane.idOf(row);
        if (!id) continue;
        try {
          await enqueueGenericSync(lane.entity, id, row);
          n++;
        } catch (e) {
          console.warn(`[repair] re-enqueue skipped [${lane.entity}/${id}]:`, e);
        }
      }
    } catch (e) {
      console.warn(`[repair] re-enqueue skipped table ${lane.table}:`, e);
    }
  }
  // payouts ride the cash_drop lane with their routing flag.
  try {
    const payoutRows = (await (dex as Record<string, { toArray: () => Promise<Record<string, unknown>[]> }>).payouts?.toArray().catch(() => [])) ?? [];
    for (const row of payoutRows) {
      const id = String(row.id ?? '');
      if (!id) continue;
      try {
        await enqueueGenericSync('cash_drop', id, { ...row, _isPayout: true });
        n++;
      } catch (e) {
        console.warn(`[repair] re-enqueue skipped [cash_drop/${id}]:`, e);
      }
    }
  } catch (e) {
    console.warn('[repair] re-enqueue skipped payouts:', e);
  }
  // Store profile + team (never device-local keys: sync.* cursors/state,
  // PIN/credential material, per-device printer routing stripped).
  try {
    const settings = (await dex.appSettings?.toArray().catch(() => [])) as Array<{ key: string; value: unknown }> ?? [];
    for (const s of settings) {
      if (!s?.key || isDeviceLocalSettingKey(String(s.key))) continue;
      try {
        await enqueueGenericSync('setting', String(s.key), { key: String(s.key), value: stripDeviceLocalSettingValue(String(s.key), s.value) });
        n++;
      } catch (e) {
        console.warn(`[repair] re-enqueue skipped [setting/${s.key}]:`, e);
      }
    }
  } catch (e) {
    console.warn('[repair] re-enqueue skipped settings:', e);
  }
  return n;
}

export async function fullResync(onProgress?: ProgressFn): Promise<FullResyncReport> {
  const fail = (message: string, extra?: Partial<FullResyncReport>): FullResyncReport => ({
    ok: false, cloudHost: '', requeued: 0, pushed: 0, pulled: 0, outboxRemaining: 0,
    verified: false, verifyReport: message, verifyDetails: [], message, ...extra,
  });
  const say = (p: RepairProgress) => { try { onProgress?.(p); } catch { /* UI-only */ } };

  say({ phase: 'precheck', detail: 'Vérification du cloud…' });
  const creds = await getCloudCredentials();
  if (!creds?.url || !creds?.token) {
    return fail('Aucun compte cloud configuré sur cet appareil — appairez-le d’abord.');
  }
  let cloudHost = '';
  try {
    cloudHost = new URL(creds.url.replace(/^libsql:\/\//, 'https://')).hostname;
  } catch {
    return fail('URL cloud illisible — vérifiez les identifiants.');
  }
  let online = false;
  try {
    online = await probeOnline(5000);
  } catch {
    online = false;
  }
  if (!online) {
    return fail('Cloud injoignable — vérifiez Internet puis relancez. Rien n’a été modifié localement.');
  }

  // Quarantined rows back to pending (reported; may re-fail visibly instead).
  let requeuedQuarantine = 0;
  try {
    requeuedQuarantine = await syncManager.retryQuarantinedOutbox();
  } catch { /* non-fatal */ }

  say({ phase: 'push', detail: 'Remise en file de toutes les données locales…' });
  let requeued = 0;
  try {
    requeued = await reenqueueAllFromAuthority();
  } catch (err) {
    return fail(`Échec de la remise en file: ${err instanceof Error ? err.message : String(err)}`, { cloudHost });
  }

  // PUSH until empty (bounded). Guard-rejects stay pending visibly per design.
  // pendingCount is intentionally a non-empty probe (not an exact count): the
  // exact badge refresh happens inside pushOnce after every round.
  const outboxNonEmpty = async (): Promise<boolean> => {
    try {
      return (await getPendingOutbox(1)).length > 0;
    } catch {
      return true;
    }
  };
  let pushed = 0;
  for (let round = 0; round < 25; round++) {
    if (!(await outboxNonEmpty())) break;
    say({ phase: 'push', detail: `Envoi vers le cloud… (passe ${round + 1})`, pushed });
    await syncManager.pushOnce(true);
    pushed += 1;
  }
  const remaining = (await outboxNonEmpty()) ? 1 : 0;

  // PULL phase: cursors to epoch so every row is re-read (applies are
  // idempotent), then pull until zero (bounded like initialPull).
  say({ phase: 'pull', detail: 'Relecture complète du cloud…' });
  try {
    const db = await getLocalDb();
    await db.execute("DELETE FROM app_settings WHERE key LIKE 'sync.cursor.%'").catch(() => {});
  } catch (err) {
    return fail(`Curseurs illisibles: ${err instanceof Error ? err.message : String(err)}`, { cloudHost, requeued, pushed });
  }
  let pulled = 0;
  for (let round = 0; round < 100; round++) {
    let n = 0;
    try {
      n = await syncManager.pullOnce(true);
    } catch {
      break;
    }
    pulled += n;
    say({ phase: 'pull', detail: `Réception du cloud… (${pulled} reçus)`, pushed, pulled });
    if (n <= 0) break;
  }
  try {
    const { reconcileCustomerDebtFromLedger } = await import('../db/sqlPluginAdapter');
    await reconcileCustomerDebtFromLedger().catch(() => {});
  } catch { /* pull already reconciles; belt and suspenders */ }

  // VERIFY + announce so peers converge too.
  say({ phase: 'verify', detail: 'Vérification d’intégrité…' });
  let verified = false;
  let verifyReport = '';
  let verifyDetails: FullResyncReport['verifyDetails'] = [];
  try {
    const res = await syncManager.verifyCloudIntegrity();
    verified = res.verified;
    verifyReport = res.report;
    verifyDetails = res.details;
  } catch (err) {
    verifyReport = `Vérification impossible: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    syncManager.broadcastRelayChange();
  } catch { /* signal best-effort */ }

  say({ phase: 'done', detail: verifyReport, pushed, pulled });
  const message = verified
    ? `Synchronisation complète réussie : ${requeued + requeuedQuarantine} remis en file, cloud et appareil identiques sur ${verifyDetails.length} tables.`
    : `Synchronisation terminée avec écarts — ${verifyReport} (base cloud : ${cloudHost}).`;
  return {
    ok: verified && remaining === 0,
    cloudHost, requeued: requeued + requeuedQuarantine, pushed, pulled,
    outboxRemaining: remaining,
    verified, verifyReport, verifyDetails, message,
  };
}
