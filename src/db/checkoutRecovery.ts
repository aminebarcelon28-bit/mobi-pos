// B-004/B-005 FIX-4: durable checkout recovery intents.
//
// When writeCheckoutAtomic throws (SQLITE_BUSY past retry, disk full, CHECK
// constraint), the sale would previously vanish with only PERSISTENCE_FAILED.
// Books stayed honest (order write is first) but there was no recovery path.
//
// This module writes a recovery intent to Dexie (IndexedDB) BEFORE the SQLite
// write and clears it after ALL post-order side-effects settle. IndexedDB is
// a different storage engine than SQLite, so it survives SQLITE_BUSY / pool
// lock failures. On boot, replayCheckoutRecoveryIntents() re-runs
// writeCheckoutAtomic for every leftover intent (idempotent: deterministic
// ledger/item/outbox identities + ON CONFLICT guards make re-execution safe).
//
// F1: intents are keyed by transactionId (NOT a singleton 'active' key) — a
// second sale before the first intent replays must QUEUE alongside it, never
// overwrite it. F2: the intent clears only after post-order writes; replay
// covers order + customer + debt + IMEI sold-marks. Voucher capture and cash
// disbursement are NOT replayed: redeem is conditional-atomic (a blind retry
// cannot distinguish "already captured by me" from "captured by a peer") and
// cash-out has no idempotency key (a replay could double-disburse). Both warn
// loudly on the live path instead.

import { db as dexieDb } from './database';
import type { CheckoutWriteInput } from './sqlPluginAdapter';
import type { CheckoutRecoveryIntentRow } from './database';
import type { IMEIRecord } from '../types/pos';

export interface CheckoutRecoveryIntent {
  /** Per-transaction key — many intents can coexist, replayed oldest-first. */
  id: string;
  transactionId: string;
  receiptNumber: string;
  /** Full payload for writeCheckoutAtomic — enough to replay the order row. */
  payload: CheckoutWriteInput;
  customerPayload?: Record<string, unknown> | null;
  debtEntry?: Record<string, unknown> | null;
  createdAt: string;
  lastError?: string;
  attempts: number;
}

/** Legacy singleton key (pre-F1 builds) — reaped opportunistically, never written. */
const LEGACY_INTENT_ID = 'active' as const;

function toIntent(row: CheckoutRecoveryIntentRow): CheckoutRecoveryIntent {
  return {
    id: row.id,
    transactionId: row.transactionId,
    receiptNumber: row.receiptNumber,
    payload: row.payload as unknown as CheckoutWriteInput,
    customerPayload: row.customerPayload ?? null,
    debtEntry: row.debtEntry ?? null,
    createdAt: row.createdAt,
    lastError: row.lastError,
    attempts: row.attempts ?? 0,
  };
}

/** Persist (or overwrite) the recovery intent for one transaction. Best-effort — never throws. */
export async function saveCheckoutRecoveryIntent(
  intent: Omit<CheckoutRecoveryIntent, 'id' | 'createdAt' | 'attempts'> & { attempts?: number }
): Promise<boolean> {
  try {
    const id = String(intent.transactionId || '');
    if (!id) return false;
    const row: CheckoutRecoveryIntentRow = {
      id,
      transactionId: intent.transactionId,
      receiptNumber: intent.receiptNumber,
      payload: intent.payload as unknown as Record<string, unknown>,
      customerPayload: intent.customerPayload ?? null,
      debtEntry: intent.debtEntry ?? null,
      createdAt: new Date().toISOString(),
      lastError: intent.lastError,
      attempts: intent.attempts ?? 0,
    };
    await dexieDb.checkoutRecoveryIntents.put(row);
    return true;
  } catch (e) {
    console.error('[checkoutRecovery] Failed to save recovery intent:', e);
    return false;
  }
}

/** Clear one transaction's intent after its durable write + side-effects settle. */
export async function clearCheckoutRecoveryIntent(transactionId: string): Promise<void> {
  try {
    if (transactionId) await dexieDb.checkoutRecoveryIntents.delete(String(transactionId));
  } catch (e) {
    console.warn('[checkoutRecovery] Failed to clear recovery intent:', e);
  }
}

/**
 * Cart fingerprint: identifies retries of the SAME cart across processPayment
 * calls. Each call mints a fresh transactionId, so a retry-after-failure
 * parks a second intent for the same cart — and boot replay would commit
 * BOTH as distinct sales (double-charge + double stock depletion). The
 * fingerprint covers items + customer only (tenders legitimately vary across
 * retries of one checkout).
 */
export function cartFingerprintOfPayload(
  payload: CheckoutWriteInput | null | undefined,
  customerId?: string | null
): string {
  const items = [...((payload?.items ?? []) as Array<Record<string, unknown>>)]
    .map((it) =>
      [
        String(it?.product_id ?? ''),
        Number(it?.quantity ?? 0),
        Number(it?.applied_price ?? 0),
        Number(it?.discount ?? 0),
        it?.is_return ? 1 : 0,
        String(it?.imei_number ?? ''),
      ].join('|')
    )
    .sort()
    .join(';');
  return `${String(customerId ?? '')}::${items}`;
}

/**
 * Clear stale sibling intents: failed attempts at the same cart whose intent
 * survived because the retry minted a new transactionId. Runs on success —
 * the cart just committed durably once, so older same-cart intents are
 * retries, not distinct sales. Exact-fingerprint only: an edited cart after
 * failure keeps its intent (documented residual — fuzzy matching would risk
 * deleting a genuinely distinct queued sale).
 */
export async function clearSiblingRecoveryIntents(
  fingerprint: string,
  excludeTransactionId: string
): Promise<void> {
  try {
    const rows = await dexieDb.checkoutRecoveryIntents.toArray().catch(() => []);
    for (const row of rows ?? []) {
      if (String(row?.transactionId) === String(excludeTransactionId)) continue;
      const custId = (row?.customerPayload as { id?: unknown } | null)?.id;
      const fp = cartFingerprintOfPayload(
        row?.payload as unknown as CheckoutWriteInput,
        custId == null ? null : String(custId)
      );
      if (fp === fingerprint) {
        await dexieDb.checkoutRecoveryIntents.delete(String(row.transactionId)).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[checkoutRecovery] Failed to clear sibling recovery intents:', e);
  }
}

/** Read all leftover intents, oldest-first. */
export async function getCheckoutRecoveryIntents(): Promise<CheckoutRecoveryIntent[]> {
  try {
    const rows = await dexieDb.checkoutRecoveryIntents.orderBy('createdAt').toArray().catch(() => []);
    return (rows ?? []).map(toIntent);
  } catch {
    return [];
  }
}

/** Replay IMEI sold-marks into Dexie from a replayed payload (idempotent put by IMEI key). */
async function replayImeiMarks(
  payload: CheckoutWriteInput,
  txId: string,
  createdAt: string,
): Promise<void> {
  try {
    const items = (payload?.items ?? []) as Array<Record<string, unknown>>;
    const imeis = items
      .map((it) => ({
        imei: String((it.imei_number as string) ?? (it.imeiNumber as string) ?? '').trim(),
        productId: String((it.product_id as string) ?? (it.productId as string) ?? ''),
      }))
      .filter((x) => x.imei.length > 0);
    if (imeis.length === 0) return;
    for (const si of imeis) {
      try {
        const existing = await dexieDb.imeiRecords.get(si.imei).catch(() => undefined);
        const rec: IMEIRecord = existing || {
          imei: si.imei,
          productId: si.productId,
          receivedAt: createdAt,
        };
        rec.saleTransactionId = txId;
        rec.soldAt = createdAt;
        await dexieDb.imeiRecords.put(rec);
      } catch (e) {
        console.warn('[checkoutRecovery] IMEI mark replay deferred:', e);
      }
    }
  } catch (e) {
    console.warn('[checkoutRecovery] IMEI replay scan deferred:', e);
  }
}

/**
 * Boot replay: re-run writeCheckoutAtomic for every leftover intent,
 * oldest-first. Returns { replayed, remaining } so callers can refresh UI /
 * warn. Order rows are idempotent (ON CONFLICT on id); ledger/item/outbox
 * identities are deterministic per sale so re-execution converges instead of
 * double-applying.
 */
export async function replayCheckoutRecoveryIntents(): Promise<{
  replayed: number;
  remaining: number;
  lastError?: string;
}> {
  // Drain the legacy singleton first (one-time migration for pre-F1 builds).
  try {
    const legacy = await dexieDb.checkoutRecoveryIntents.get(LEGACY_INTENT_ID).catch(() => undefined);
    if (legacy) {
      await dexieDb.checkoutRecoveryIntents.delete(LEGACY_INTENT_ID).catch(() => {});
    }
  } catch {
    // ignore legacy drain errors
  }

  const intents = await getCheckoutRecoveryIntents();
  if (intents.length === 0) return { replayed: 0, remaining: 0 };

  // B-061: never race a live sale or a concurrent refund — if the shared
  // checkout flight is held, leave the intents for the next boot/opportunity
  // instead of opening a second busy-retry:checkout loop on the same pool.
  const { tryAcquireCheckoutFlight, releaseCheckoutFlight } = await import('./checkoutFlight');
  if (!tryAcquireCheckoutFlight('boot-replay')) {
    return { replayed: 0, remaining: intents.length, lastError: 'checkout-in-progress' };
  }

  let replayed = 0;
  let lastError: string | undefined;
  try {
    const { writeCheckoutAtomic } = await import('./sqlPluginAdapter');
    for (const intent of intents) {
      try {
        await writeCheckoutAtomic(intent.payload);

        // Order row is durable — apply the customer mutation snapshot if present
        // (same order as live processPayment: order first, then customer/debt).
        if (intent.customerPayload) {
          try {
            const { customerAdapter } = await import('./adapters/customerAdapter');
            await customerAdapter.saveCustomer(intent.customerPayload as never);
          } catch (e) {
            console.warn('[checkoutRecovery] Customer mutation replay deferred:', e);
          }
        }
        if (intent.debtEntry) {
          try {
            const { customerAdapter } = await import('./adapters/customerAdapter');
            await customerAdapter.saveCustomerDebt(intent.debtEntry as never);
          } catch (e) {
            console.warn('[checkoutRecovery] Debt entry replay deferred:', e);
          }
        }
        await replayImeiMarks(intent.payload, intent.transactionId, intent.createdAt);

        await clearCheckoutRecoveryIntent(intent.transactionId);
        replayed += 1;
        console.info(
          `[checkoutRecovery] Replayed checkout ${intent.receiptNumber} (${intent.transactionId})`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = msg;
        console.warn('[checkoutRecovery] Replay failed, will retry next boot:', msg);
        try {
          const row = await dexieDb.checkoutRecoveryIntents.get(intent.transactionId).catch(() => undefined);
          await dexieDb.checkoutRecoveryIntents.put({
            id: intent.transactionId,
            transactionId: intent.transactionId,
            receiptNumber: intent.receiptNumber,
            payload: intent.payload as unknown as Record<string, unknown>,
            customerPayload: intent.customerPayload ?? null,
            debtEntry: intent.debtEntry ?? null,
            createdAt: intent.createdAt,
            attempts: ((row?.attempts ?? intent.attempts) || 0) + 1,
            lastError: msg.slice(0, 200),
          });
        } catch {
          // keep original intent if update fails
        }
      }
    }
    return { replayed, remaining: intents.length - replayed, lastError };
  } finally {
    releaseCheckoutFlight('boot-replay');
  }
}
