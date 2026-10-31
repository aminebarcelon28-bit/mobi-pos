/**
 * Native refund barrier client (MOBI-DEFECT-F).
 *
 * All money effects of a refund commit in ONE native `BEGIN IMMEDIATE`
 * transaction (`refund_sale_atomic` in `src-tauri/src/refund.rs`). This
 * module is the only Tauri-path caller: it derives the deterministic refund
 * identity, invokes the command through the platform boundary, parses the
 * typed conflict codes, and projects the committed rows into Dexie
 * (projection only — SQLite is the authority, Dexie is a cache).
 *
 * Retry rule: ONLY `BUSY` retries (the transaction never began, or a replay
 * converges on the dedup gate and cannot pay twice). Every other code —
 * including `ALREADY_REFUNDED` — never retries and performs NO side effects
 * (no print, no drawer, no toast of a payout).
 */
import { invokeCommand } from '../../platform/invoke';
import { deterministicId } from '../../utils/ids';
import { db as dexieDb } from '../database';
import type { Customer, Product, RefundItem, SaleTransaction, SecurityAuditLogEntry } from '../../types/pos';

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

/**
 * `basis` = number of refunds for this ticket the caller's snapshot already
 * knew about (store + Dexie union). Two tabs with the same stale view derive
 * the SAME hash, so the loser gets `ALREADY_REFUNDED`. A deliberate later
 * partial refund sees a higher basis, hashes differently, and is decided by
 * the in-transaction quota check. Without `basis`, two legitimate identical
 * partial refunds (1 of qty 2, twice) would collide.
 *
 * The display receipt derives from the id: no per-tab entropy, no counter —
 * the winner's receipt is the only receipt.
 */
export function refundIdentity(p: {
  ticketId: string;
  canonicalKey: string;
  method: string;
  netRefund: number;
  basis: number;
}): { itemsHash: string; refundId: string; receiptNumber: string } {
  const itemsHash = deterministicId(
    'REF',
    p.ticketId,
    p.canonicalKey,
    p.method,
    Math.round(p.netRefund),
    p.basis,
  );
  return {
    itemsHash,
    refundId: itemsHash,
    receiptNumber: `AVOIR-${itemsHash.replace(/^REF-/, '')}`,
  };
}

export function knownRefundCount(
  ticketId: string,
  txns: Array<{ originalTransactionId?: string; isRefund?: boolean }>,
): number {
  const seen = new Set<string>();
  for (const t of txns) {
    if (t.isRefund && t.originalTransactionId === ticketId && (t as { id?: string }).id) {
      seen.add(String((t as { id?: string }).id));
    }
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// Wire types (mirror src-tauri/src/refund.rs)
// ---------------------------------------------------------------------------

export interface NativeRefundLine {
  id: string;
  productId: string;
  quantity: number;
  appliedPrice: number;
  unitPriceCharged: number;
  unitCostAtSale: number;
  discountAmount: number;
  lineProfit: number;
  imeiNumber?: string | null;
  /** Original sale line identity (`${saleTxnId}-item-${lineIdx}`) when known. */
  saleItemId?: string | null;
  /** Zero-based line index in the original ticket (derivation fallback). */
  lineIndex?: number | null;
  /** 'restock' | 'defective' (absent ⇒ restock). */
  condition?: string | null;
  itemKey: string;
  itemPayload: string;
}

/**
 * Offline containment policy (MOBI-OFFLINE-REFUND-CONTAINMENT). Mirrors the
 * native defaults in `src-tauri/src/refund.rs::read_policy_i64`: the native
 * side is authoritative (reads `app_settings` in-txn); these constants drive
 * the UI pre-flight hints only, so the modal can never promise what the
 * command refuses. Tune per merchant via `app_settings` keys
 * `policy.offline_cash_refund_limit` / `policy.offline_pin_threshold`
 * (JSON numbers, integer DZD).
 */
export const DEFAULT_OFFLINE_CASH_REFUND_LIMIT = 10_000;
export const DEFAULT_OFFLINE_PIN_THRESHOLD = 5_000;

/** Best-effort read of an offline policy knob (defaults on any failure). */
export async function readOfflinePolicy(
  key: 'policy.offline_cash_refund_limit' | 'policy.offline_pin_threshold',
): Promise<number> {
  const fallback =
    key === 'policy.offline_cash_refund_limit'
      ? DEFAULT_OFFLINE_CASH_REFUND_LIMIT
      : DEFAULT_OFFLINE_PIN_THRESHOLD;
  try {
    const { getLocalDb } = await import('../sqlPluginAdapter');
    const db = await getLocalDb();
    const rows = (await db.select('SELECT value_json FROM app_settings WHERE key = $1', [key]).catch(() => [])) as Array<{
      value_json?: string | null;
    }>;
    const raw = rows?.[0]?.value_json;
    if (raw == null) return fallback;
    let parsed: number = NaN;
    try {
      const v: unknown = JSON.parse(String(raw));
      parsed = typeof v === 'number' ? v : Number.NaN;
    } catch {
      parsed = Number(String(raw).trim());
    }
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export interface NativeRefundRequest {
  ticketId: string;
  refundId: string;
  itemsHash: string;
  receiptNumber: string;
  method: string;
  /** Connectivity at submit time (TS probeOnline). Selects containment gates. */
  online: boolean;
  /** Asserted local context (getStableDeviceId + open shift). */
  localDeviceId: string;
  activeShiftId: string;
  /**
   * Supervisor authorization (Module C). Present only after a real
   * `verifyManagerGate` pass immediately pre-submit; native requires it for
   * large offline cash and records it in the in-txn audit row.
   */
  supervisor?: { userId: string; verifiedAt: string } | null;
  customerId?: string | null;
  subtotal: number;
  discountTotal: number;
  totalNet: number;
  /**
   * Value reversed by this refund (funding returned + trade value restored).
   * Written to the row's `total` column so it matches the JSON payload;
   * `totalNet` stays the funding basis for guards, profit and the signed
   * envelope. Absent on older writers ⇒ native falls back to `totalNet`.
   */
  valueReversed?: number;
  costTotal: number;
  pricingTier: string;
  paymentMethod: string;
  cashTendered: number;
  changeDue: number;
  /** Net physical cash tendered on the original ticket (cap basis). */
  cashTenderedNet: number;
  createdAt: string;
  refundPayload: string;
  originalOutboxPayload: string;
  deviceId: string;
  lines: NativeRefundLine[];
  deltas: Array<{ id: string; key: string; productId: string; delta: number }>;
  batches: Array<{
    batchId?: string | null;
    productId: string;
    quantity: number;
    unitCost: number;
    fallbackBatchId: string;
    fallbackKey: string;
  }>;
  imeis: string[];
  /** IMEIs of defective (write-off) lines: released to `defective` + evented. */
  defectiveImeis?: string[];
  /** Mandatory note for any defective line (native gate: RESTOCK_REASON_REQUIRED). */
  defectNote?: string | null;
  /**
   * Post-refund loyalty verdict computed by the shared TS math from the
   * original sale's immutable snapshots. Native REPLAYS it (never invents);
   * absent ⇒ loyalty untouched.
   */
  customerPointsAfter?: number | null;
  customerPointBucketsJson?: string | null;
  debt?: {
    entryId: string;
    customerId: string;
    customerName: string;
    amount: number;
    receiptNumber: string;
    paymentMethod: string;
    notes: string;
    recordedBy: string;
  } | null;
  voucher?: { code: string; amount: number } | null;
  /** D4-A: Avoir Client leg, applied as an increment inside the native txn. */
  walletCredit?: number | null;
  /** Milestone clawback (positive DZD to revoke) applied in the same native txn. */
  walletClawback?: number | null;
  cashMove?: {
    id: string;
    sessionId: string;
    amount: number;
    reason: string;
    cashierName: string;
  } | null;
  audit: {
    action: string;
    details: string;
    user: string;
    requiresPin: boolean;
    deviceId?: string | null;
    ipAddress?: string | null;
  };
}

export interface NativeRefundOk {
  refundId: string;
  receiptNumber: string;
  ticketStatus: string;
  ticketVersion: number;
  warnings: string[];
  /** Durable merged ticket payload (status/version/refundedItems accumulated). */
  ticketPayload: string;
  /** Live ledger balance after the (clamped) relief — null when not asked. */
  customerDebtAfter?: number | null;
  /** Relief actually applied in this commit (≤ requested, clamped live). */
  debtReliefApplied: number;
  /** Points written (echo of the shared TS verdict) — null when untouched. */
  customerPointsAfter?: number | null;
  /** Wallet balance after the native Avoir leg — null when the refund had none.
   *  The client mirrors this; it never computes or re-applies the credit. */
  customerStoreCreditAfter?: number | null;
  /** Native-computed recovered COGS (restocked lines only, frozen costs). */
  recoveredCogs: number;
}

export type RefundNativeResult =
  | {
      success: true;
      refundId: string;
      receiptNumber: string;
      ticketStatus: string;
      ticketVersion: number;
      warnings: string[];
      ticketPayload: string;
      customerDebtAfter?: number | null;
      debtReliefApplied: number;
      customerPointsAfter?: number | null;
      /** D4-A: wallet balance after the native Avoir leg (mirror, never re-applied). */
      customerStoreCreditAfter?: number | null;
      recoveredCogs: number;
      /** Hydrated original ticket (durable refundedItems union) for cache/state. */
      updatedOriginal: SaleTransaction;
    }
  | { success: false; reason: string; refundId?: string; retryable: boolean; detail: string };

// ---------------------------------------------------------------------------
// Error parsing — native conflicts arrive as OperationFailed "CODE[:detail]"
// (gate NONE), surfaced by invokeCommand as ApiError.message.
// ---------------------------------------------------------------------------

const RETRYABLE_CODES = new Set(['BUSY']);
const RESUBMITTABLE_CODES = new Set(['BUSY', 'DEBT_CHANGED']);

function parseRefundError(err: unknown): { reason: string; refundId?: string; retryable: boolean; detail: string } {
  const raw =
    (err as { originalError?: { detail?: unknown } })?.originalError?.detail ??
    (err instanceof Error ? err.message : String(err));
  const detail = String(raw ?? '');
  // Diagnostics: every native failure is visible with its raw detail, so a
  // generic PERSISTENCE_FAILED toast never hides the cause in the field log.
  console.error('[refund] native failure:', detail.slice(0, 300));
  const head = detail.split('\n')[0];
  const m = head.match(
    /^(ALREADY_REFUNDED|ORIGINAL_VOIDED|TICKET_NOT_FOUND|REFUND_EXCEEDS|REFUND_EXCEEDS_VALUE|VOUCHER_CHANGED|VOUCHER_MISSING|NO_OPEN_SHIFT|BUSY|INVALID|DEBT_CHANGED|INTERNAL|OFFLINE_FOREIGN_TICKET|OFFLINE_CASH_CAP_EXCEEDED|SUPERVISOR_PIN_REQUIRED|RESTOCK_REASON_REQUIRED|SCHEMA_UNHEALED|DEVICE_IDENTITY_SPOOFED|SUPERVISOR_AUTH_EXPIRED|SYSTEM_CLOCK_REGRESSION|DEVICE_NOT_INITIALIZED|DEVICE_SIGNATURE_FAILED|AVOIR_RECIPIENT_REQUIRED)(?::(.*))?$/,
  );
  if (!m) {
    // Diagnostics: an unmapped native failure must be visible in the field log,
    // not only as a generic toast.
    console.error('[refund] unmapped native failure:', detail);
    return { reason: 'PERSISTENCE_FAILED', retryable: false, detail };
  }
  const code = m[1];
  const rest = (m[2] ?? '').trim();
  if (code === 'ALREADY_REFUNDED') {
    return { reason: 'ALREADY_REFUNDED', refundId: rest || undefined, retryable: false, detail };
  }
  if (code === 'REFUND_EXCEEDS') return { reason: 'REFUND_EXCEEDS_PURCHASED', retryable: false, detail };
  if (code === 'REFUND_EXCEEDS_VALUE') return { reason: 'REFUND_EXCEEDS_VALUE', retryable: false, detail };
  if (code === 'INVALID') return { reason: 'INVALID_REQUEST', retryable: false, detail };
  if (code === 'AVOIR_RECIPIENT_REQUIRED') return { reason: 'AVOIR_RECIPIENT_REQUIRED', retryable: false, detail };
  if (code === 'INTERNAL' || code === 'SCHEMA_UNHEALED') {
    return { reason: 'PERSISTENCE_FAILED', retryable: false, detail };
  }
  if (code === 'OFFLINE_CASH_CAP_EXCEEDED') {
    // detail carries current:cap:attempted for the voucher-fallback prompt.
    return { reason: 'OFFLINE_CASH_CAP_EXCEEDED', retryable: false, detail };
  }
  if (code === 'SUPERVISOR_PIN_REQUIRED') {
    return { reason: 'SUPERVISOR_PIN_REQUIRED', retryable: false, detail };
  }
  if (code === 'RESTOCK_REASON_REQUIRED') {
    return { reason: 'RESTOCK_REASON_REQUIRED', retryable: false, detail };
  }
  if (code === 'DEVICE_IDENTITY_SPOOFED') {
    return { reason: 'DEVICE_IDENTITY_SPOOFED', retryable: false, detail };
  }
  if (code === 'SUPERVISOR_AUTH_EXPIRED') {
    return { reason: 'SUPERVISOR_AUTH_EXPIRED', retryable: false, detail };
  }
  if (code === 'SYSTEM_CLOCK_REGRESSION') {
    return { reason: 'SYSTEM_CLOCK_REGRESSION', retryable: false, detail };
  }
  if (code === 'DEVICE_NOT_INITIALIZED' || code === 'DEVICE_SIGNATURE_FAILED') {
    return { reason: 'PERSISTENCE_FAILED', retryable: false, detail };
  }
  return { reason: code, retryable: RETRYABLE_CODES.has(code) || RESUBMITTABLE_CODES.has(code), detail };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Invoke + Dexie projection
// ---------------------------------------------------------------------------

export interface RefundProjection {
  refund: SaleTransaction;
  updatedOriginal: SaleTransaction;
  products: Product[];
  customer?: Customer | null;
  audit: SecurityAuditLogEntry;
}

/**
 * Best-effort Dexie projection of an already-committed native refund.
 * Idempotent puts by id. A failure here is logged, never thrown: SQLite is
 * durable and the next sync/pull reconciles the cache.
 */
async function projectToDexie(p: RefundProjection): Promise<void> {
  try {
    await dexieDb.transaction(
      'rw',
      [dexieDb.transactions, dexieDb.products, dexieDb.customers, dexieDb.securityAuditLogs],
      async () => {
        await dexieDb.transactions.put(p.refund);
        await dexieDb.transactions.put(p.updatedOriginal);
        if (p.products.length > 0) await dexieDb.products.bulkPut(p.products);
        if (p.customer) await dexieDb.customers.put(p.customer);
        await dexieDb.securityAuditLogs.put(p.audit);
      },
    );
  } catch (e) {
    console.warn('[refund] Dexie projection failed; SQLite remains authoritative:', e);
  }
}

/**
 * Merge the durable `refundedItems` union (every refund, the current one
 * included — read under the native write lock) with the caller's FULL item
 * objects for THIS refund: entries of this refund keep their complete shape
 * (title, prices, fifo allocations), entries left by other refunds stay
 * minimal but faithful. Returns null when the payload has nothing usable.
 */
function hydrateRefundedItems(
  payloadJson: string,
  refundId: string,
  callerItems: SaleTransaction['refundedItems'],
): SaleTransaction['refundedItems'] | null {
  let parsed: { refundedItems?: unknown } | null = null;
  try {
    parsed = JSON.parse(payloadJson) as { refundedItems?: unknown };
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.refundedItems)) return null;
  const full = (callerItems ?? []) as unknown as Array<Record<string, unknown>>;
  const hydrated: RefundItem[] = (
    parsed.refundedItems as Array<Record<string, unknown>>
  ).map((e) => {
    const pid = e.productId ? String(e.productId) : '';
    const cond = e.condition === 'defective' ? 'defective' : 'restock';
    if (e.refundId && String(e.refundId) === refundId) {
      const sid = e.saleItemId ? String(e.saleItemId) : '';
      const imei = e.imeiNumber ? String(e.imeiNumber) : '';
      const match = full.find(
        (c) =>
          String(c.productId ?? '') === pid &&
          String(c.saleItemId ?? '') === sid &&
          String(c.imeiNumber ?? '') === imei &&
          (c.condition === 'defective' ? 'defective' : 'restock') === cond,
      );
      if (match) {
        return {
          ...(match as unknown as RefundItem),
          quantity: Number(e.quantity) || Number(match.quantity) || 0,
        };
      }
    }
    return {
      productId: pid,
      title: '',
      sku: '',
      unitPrice: 0,
      quantity: Number(e.quantity) || 0,
      totalRefundAmount: 0,
      restock: cond === 'restock',
      condition: cond,
      imeiNumber: e.imeiNumber ? String(e.imeiNumber) : undefined,
      saleItemId: e.saleItemId ? String(e.saleItemId) : undefined,
    };
  });
  return hydrated as SaleTransaction['refundedItems'];
}

export async function refundSaleNative(
  req: NativeRefundRequest,
  projection: RefundProjection,
): Promise<RefundNativeResult> {
  if (req.cashMove?.sessionId) {
    try {
      const { assertShiftVisibleToKernel } = await import('./shiftSqlite');
      await assertShiftVisibleToKernel(req.cashMove.sessionId);
    } catch (e) {
      console.warn('[refundSaleNative] assertShiftVisibleToKernel preflight warning:', e);
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      const ok = await invokeCommand<NativeRefundOk, { req: NativeRefundRequest }>(
        'refund_sale_atomic',
        { req },
        'SYNC_CONFLICT',
      );
      // Status/version are authoritative from the receipt, not the
      // pre-computed guess; `refundedItems` come from the durable merged
      // payload so a peer tab's refunds are never dropped by our projection.
      const hydratedItems = hydrateRefundedItems(
        ok.ticketPayload,
        ok.refundId,
        projection.updatedOriginal.refundedItems,
      );
      projection.updatedOriginal = {
        ...projection.updatedOriginal,
        status: (ok.ticketStatus as SaleTransaction['status']) ?? projection.updatedOriginal.status,
        ...(hydratedItems ? { refundedItems: hydratedItems } : {}),
      };
      await projectToDexie(projection);
      return { success: true, ...ok, updatedOriginal: projection.updatedOriginal };
    } catch (err) {
      const parsed = parseRefundError(err);
      if (parsed.reason === 'BUSY' && attempt < 2) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      return { success: false, ...parsed };
    }
  }
}
