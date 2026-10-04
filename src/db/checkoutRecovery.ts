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

/** Max attempts before an intent is considered stuck and evicted. */
const MAX_RECOVERY_ATTEMPTS = 3;

/** Intents older than this are expired and cleaned up on replay. */
const INTENT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Classify a replay error as fatal (business rule — retrying will never succeed)
 * or transient (infrastructure — may resolve on next boot).
 *
 * Safely extracts all possible error representations (string, Error,
 * Dexie error, { code, message } response object) into a single
 * unified uppercase text before matching patterns.
 */
function classifyReplayError(error: unknown): 'fatal' | 'transient' {
  if (!error) return 'transient';

  const err = error as Record<string, unknown>;
  const combinedText = [
    typeof error === 'string' ? error : '',
    typeof err.code === 'string' ? err.code : '',
    typeof err.message === 'string' ? err.message : '',
    typeof err.name === 'string' ? err.name : '',
    String(error),
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  // Fatal / Non-retryable patterns
  const fatalPatterns = [
    'INSUFFICIENT_STOCK',
    'ITEM_DISCONTINUED',
    'DISCONTINUED',
    'PRICE_MISMATCH',
    'INVALID_PAYMENT',
    'PAYMENT_METHOD_INVALID',
    'INVALID_INPUT',
    'CHECK CONSTRAINT',
    'FOREIGN KEY',
  ];

  if (fatalPatterns.some((pattern) => combinedText.includes(pattern))) {
    return 'fatal';
  }

  // Transient / Retryable patterns or default
  return 'transient';
}

/** True when the intent has exceeded its TTL. */
function isIntentExpired(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() > INTENT_TTL_MS;
}

/** Emit a toast from a non-React context via the window event bridge ToastProvider subscribes to. */
function dispatchRecoveryToast(
  message: string,
  type: 'error' | 'warning' | 'info' = 'error',
): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('mobi:toast', { detail: { message, type } }));
  } catch (err) {
    console.warn('[checkoutRecovery] Failed to dispatch toast notification:', err);
  }
}

/** Delete an intent and alert the user (non-retryable). */
async function evictRecoveryIntent(
  transactionId: string,
  reason: string,
  notifyUser = false,
  toastMessage?: string,
): Promise<void> {
  try {
    await dexieDb.checkoutRecoveryIntents.delete(String(transactionId));
  } catch (e) {
    console.warn('[checkoutRecovery] Failed to evict intent:', e);
  }
  console.warn(`[checkoutRecovery] Evicted intent ${transactionId}: ${reason}`);
  if (notifyUser && toastMessage) {
    dispatchRecoveryToast(toastMessage, 'error');
  }
}

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
 * oldest-first. Returns { replayed, remaining, evicted, fatalErrors } so
 * callers can refresh UI / warn. Order rows are idempotent (ON CONFLICT
 * on id); ledger/item/outbox identities are deterministic per sale so
 * re-execution converges instead of double-applying.
 *
 * Safeguards:
 *  - Intents older than INTENT_TTL_MS are purged before replay.
 *  - Intents that have already hit MAX_RECOVERY_ATTEMPTS are evicted.
 *  - Fatal business errors (INSUFFICIENT_STOCK, CHECK/FOREIGN KEY,
 *    discontinued, invalid payment) evict the intent immediately and
 *    emit a user-facing toast — no retry.
 *  - Transient errors (SQLITE_BUSY, network, 5xx) keep the intent
 *    with an incremented attempt counter for the next boot.
 */
export async function replayCheckoutRecoveryIntents(): Promise<{
  replayed: number;
  remaining: number;
  evicted: number;
  fatalErrors: string[];
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
  if (intents.length === 0) return { replayed: 0, remaining: 0, evicted: 0, fatalErrors: [] };

  let evicted = 0;
  const fatalErrors: string[] = [];

  // ── Phase 1: purge expired or max-attempts-exceeded intents ──
  const toEvict: CheckoutRecoveryIntent[] = [];
  const toReplay: CheckoutRecoveryIntent[] = [];
  for (const intent of intents) {
    if (isIntentExpired(intent.createdAt)) {
      toEvict.push(intent);
    } else if ((intent.attempts ?? 0) >= MAX_RECOVERY_ATTEMPTS) {
      toEvict.push(intent);
    } else {
      toReplay.push(intent);
    }
  }

  for (const intent of toEvict) {
    const expired = isIntentExpired(intent.createdAt);
    if (expired) {
      await evictRecoveryIntent(
        intent.transactionId,
        'TTL expired',
        true,
        `Vente #${intent.receiptNumber} expirée — intent de récupération nettoyé.`,
      );
    } else {
      await evictRecoveryIntent(
        intent.transactionId,
        `Max attempts (${MAX_RECOVERY_ATTEMPTS}) exceeded`,
        true,
        `Vente #${intent.receiptNumber} — récupération abandonnée après ${MAX_RECOVERY_ATTEMPTS} tentatives.`,
      );
    }
    evicted += 1;
  }

  if (toReplay.length === 0) {
    return { replayed: 0, remaining: 0, evicted, fatalErrors };
  }

  // B-061: never race a live sale or a concurrent refund — if the shared
  // checkout flight is held, leave the intents for the next boot/opportunity
  // instead of opening a second busy-retry:checkout loop on the same pool.
  const { tryAcquireCheckoutFlight, releaseCheckoutFlight } = await import('./checkoutFlight');
  if (!tryAcquireCheckoutFlight('boot-replay')) {
    return { replayed: 0, remaining: toReplay.length, evicted, fatalErrors, lastError: 'checkout-in-progress' };
  }

  // Task 2: Offline boot guard — do not burn attempts when the device
  // has no connectivity. Recovery is deferred to the next boot when
  // network is restored.
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    console.info('[checkoutRecovery] Device is offline; deferring replay to next boot.');
    releaseCheckoutFlight('boot-replay');
    return {
      replayed: 0,
      remaining: toReplay.length,
      evicted,
      fatalErrors,
      lastError: 'offline',
    };
  }

  let replayed = 0;
  let fatalCount = 0;
  let lastError: string | undefined;
  try {
    const { writeCheckoutAtomic } = await import('./sqlPluginAdapter');
    for (const intent of toReplay) {
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
        if (classifyReplayError(e) === 'fatal') {
          fatalErrors.push(msg);
          fatalCount += 1;
          await evictRecoveryIntent(
            intent.transactionId,
            `Fatal: ${msg.slice(0, 120)}`,
            true,
            `Récupération annulée : stock insuffisant pour un article de la vente #${intent.receiptNumber}.`,
          );
          evicted += 1;
        } else {
          // Task 2: offline/network failures must not burn attempts.
          const isOfflineFailure =
            msg.includes('FAILED TO FETCH') ||
            msg.includes('NETWORKERROR') ||
            msg.includes('OFFLINE');

          lastError = msg;
          console.warn('[checkoutRecovery] Replay failed (transient), will retry next boot:', msg);
          try {
            // Task 3: persist the incremented attempt count via Dexie update
            // so the count survives app restarts.
            // Task 2: offline/network failures must NOT burn attempts.
            if (isOfflineFailure) {
              console.info(
                `[checkoutRecovery] Offline/network failure for ${intent.transactionId} — attempts preserved (not incremented).`
              );
              await dexieDb.checkoutRecoveryIntents.update(intent.transactionId, {
                lastError: msg.slice(0, 200),
              });
            } else {
              const newAttempts = (intent.attempts || 0) + 1;
              await dexieDb.checkoutRecoveryIntents.update(intent.transactionId, {
                attempts: newAttempts,
                lastError: msg.slice(0, 200),
              });
            }
          } catch {
            // keep original intent if update fails
          }
        }
      }
    }
    return {
      replayed,
      remaining: toReplay.length - replayed - fatalCount,
      evicted,
      fatalErrors,
      lastError,
    };
  } finally {
    releaseCheckoutFlight('boot-replay');
  }
}
