import type { StateCreator } from 'zustand';
import type { PosState, OrderSlice } from '../types';
import type {
  CartItem,
  SaleTransaction,
  Customer,
  CustomerDebtEntry,
  LoyaltyLedgerEntry,
  MilestoneAward,
  SecurityAuditLogEntry,
  Product,
  PaymentTender,
  IMEIRecord,
} from '../../types/pos';
// P11.3: sqliteAdapter is a barrel that spreads all six adapters, each of which
// statically pulls Dexie + libsql. Keeping it static pins the whole DB graph
// (database-*.js ~97kB + sqlPluginAdapter ~40kB) into the entry chunk, which
// defeats the lazy resolvers in the other slices. Resolve on first use.
async function getSqlite() {
  const { sqliteAdapter } = await import('../../db/sqliteAdapter');
  return sqliteAdapter;
}
// P11.3: customerRepository statically imports sqliteAdapter; a static import
// here pins it (and the DB graph) into the entry chunk.
async function getCustomerRepo() {
  const { customerRepository } = await import('../../db/repositories/customerRepository');
  return customerRepository;
}
  import { newId, newReceiptNumber, deterministicId } from '../../utils/ids';
  import { toIntMoney } from '../../utils/fifoPreview';
  import { refundIdentity, refundSaleNative } from '../../db/adapters/refundNative';
  import { committedRefundBasis, avoirRecipientRefusal } from '../../utils/refundGuards';
  import type { NativeRefundRequest } from '../../db/adapters/refundNative';
  import { sortedTransactions } from '../transactionOrder';
  import { saveCheckoutRecoveryIntent, clearCheckoutRecoveryIntent, cartFingerprintOfPayload, clearSiblingRecoveryIntents } from '../../db/checkoutRecovery';
  import { tryAcquireCheckoutFlight, releaseCheckoutFlight } from '../../db/checkoutFlight';
import {
  calculateCustomerTier,
  calculateNetPaidEarnedPoints,
  activeCampaignMultiplier,
  calculateMaxAllowedCredit,
  computeVoidDeduction,
  computeRefundDeduction,
  restoreBucketsForVoid,
  shrinkEarnBucketForRefund,
  depleteFifoPointBuckets,
  createDatedPointBucket,
  createLedgerEntry,
  normalizeLoyaltyConfig,
  evaluateSpendMilestones,
  computeMilestoneClawback,
  computeSpendReversal,
  ensureCreditGenesis,
  isEarnAllowed,
  getTxnStoreCreditApplied,
  splitCreditRedemption,
} from '../../utils/loyaltyEngine';
import {
  getEffectiveCostPrice,
  calculateProfit,
} from '../../utils/pricingEngine';
import { computeCartTotals, computeRefundFundingSplit, refundLaneTotalsOf, fundingPayloadOf, computeTradeInSettlement, computeTradeRestoreQuota, lineProfitNet, refundableValueOf } from '../../utils/receiptMath';
import type { RefundLaneTotals } from '../../utils/receiptMath';
import { clawbackLedgerForMirror } from '../../db/refundMirrorSql';
import { saleCustomerSnapshot } from '../../utils/saleCustomerSnapshot';
import {
  cashSalesFromTxns,
  cashRefundsFromTxns,
  exchangeCashOutFromMovements,
  standaloneDepositsFromMovements,
  standaloneExpensesFromMovements,
  savDepositsFromRepairs,
  estimateDrawerCash,
  physicalCashTendered,
  cashDisbursedOf,
  clampCashRefund,
} from '../../utils/cashTerms';
import { isTxInCloseScope } from '../../db/adapters/shiftAdapter';
import { formatDZD } from '../../types/pos';
import { DRAWER_REASON_PREFIXES } from '../../constants/index';
import { DEFAULT_CREDIT_LIMIT } from './createCustomerSlice';
import { addDaysIso, assertCreditAllowed, KREDY_DEFAULT_TERM_DAYS } from '../../utils/kredyEngine';
import { readVoucherStaging } from './createCartSlice';
import { audioBus } from '../../utils/audioEvents';
import { canonicalDeviceId, normalizeDeviceKey, resolveWarrantyWithFallback, warrantyAnchorFor } from '../../utils/warrantyResolver';
// P11.3: escpos pulls in the Windows spooler + serial + label builder chain.
// Printing is fire-and-forget and desktop-only, so it loads on first print.
import type { ReceiptSettings } from '../../types/pos';

/** Retry-once wrapper for post-order money writes (H8): try, retry once,
 *  then report failure so the caller queues to the outbox / warns instead
 *  of swallowing the error with .catch(console.error). */
async function persistWithRetryOnce<T>(
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (first) {
    try {
      return { ok: true, value: await fn() };
    } catch (second) {
      void first;
      return { ok: false, error: second };
    }
  }
}

function isServiceProductId(pid: string): boolean {
  return pid.startsWith('qt-') || pid.startsWith('prod-misc-');
}

/**
 * Chaos S2 drawer-availability estimate for the soulte overdraft guard.
 * Mirrors the Z reconciler term-for-term (same predicates, same window
 * rule) so the guard agrees with what closeShift will book. Memory-state
 * based: stale mirrors fail toward blocking, never toward overdraft.
 */
function estimateDrawerCashForSoulte(s: PosState): number {
  const activeShift = s.activeShift;
  const openedAt = activeShift?.openedAt ?? null;
  const inShiftWindow = (iso: string | undefined) => {
    if (!openedAt) return true;
    if (!iso) return true;
    return iso >= openedAt;
  };
  const shiftTxns = openedAt
    ? (s.transactions || []).filter((t) =>
        isTxInCloseScope(t, { id: activeShift?.id, openedAt })
      )
    : s.transactions || [];
  const sessionMovements = activeShift?.movements || [];
  return estimateDrawerCash({
    openingFloat: activeShift?.openingFloat ?? s.shiftFloat ?? 0,
    cashSales:
      cashSalesFromTxns(shiftTxns) +
      savDepositsFromRepairs((s.repairOrders || []).filter((r) => inShiftWindow(r.createdAt))),
    debtSettled: (s.customerDebts || [])
      .filter((d) => d.type === 'PAYMENT_SETTLED' && d.paymentMethod === 'Espèces' && inShiftWindow(d.createdAt))
      .reduce((acc, d) => acc + (d.amount || 0), 0),
    deposits: 0,
    manualIn: standaloneDepositsFromMovements(sessionMovements),
    refunds: cashRefundsFromTxns(shiftTxns),
    drops: (s.cashDrops || []).filter((d) => inShiftWindow(d.timestamp)).reduce((acc, d) => acc + (d.amount || 0), 0),
    payouts: (s.payouts || []).filter((p) => inShiftWindow(p.timestamp)).reduce((acc, p) => acc + (p.amount || 0), 0),
    cashExpenses: (s.storeExpenses || [])
      .filter((e) => e.paymentMethod === 'Espèces' && inShiftWindow(e.createdAt))
      .reduce((acc, e) => acc + (e.amount || 0), 0),
    tradeInCashOut: (s.tradeIns || [])
      .filter((t) => !t.creditToWallet && inShiftWindow(t.createdAt))
      .reduce((acc, t) => acc + (t.buybackValue || 0), 0),
    exchangeOut: exchangeCashOutFromMovements(sessionMovements),
    manualOut: standaloneExpensesFromMovements(sessionMovements),
  });
}

/**
 * Products that carry no stock identity: terminal id prefixes plus the
 * Services category. Checkout never depletes them (and the ledger guard
 * skips them), so void/refund/stocktake must never RESTOCK them either —
 * restocking a 999999-stock service collapses it to a small counted sum and
 * mints real batches for phantom SKUs.
 */
function isUnstockedProduct(
  pid: string,
  products: Array<{ id: string; category?: unknown }>
): boolean {
  if (!pid || isServiceProductId(pid)) return true;
  const prod = products.find((p) => p.id === pid);
  return (prod?.category as string) === 'Services';
}

/**
 * Application-level sold-status check for serialized/IMEI items (C2, no
 * schema change, no new UNIQUE constraint): mirrors the durable state
 * (Zustand mirror → Dexie → SQLite imei_records) and reports the first IMEI
 * that already carries a sale, or null when all are sellable.
 */
async function findAlreadySoldImei(
  items: CartItem[],
  get: () => Pick<PosState, 'imeiRecords'>
): Promise<string | null> {
  const mirror = get().imeiRecords || [];
  for (const item of items) {
    if (!item.product.isSerialized || !item.imeiNumber) continue;
    const imei = item.imeiNumber.trim();
    if (!imei) continue;
    const upper = imei.toUpperCase();
    const rec = mirror.find((r) => (r.imei || '').toUpperCase() === upper);
    if (rec && (rec.soldAt || rec.saleTransactionId)) return upper;
    try {
      const { db: dexieDb } = await import('../../db/database');
      const dex =
        (await dexieDb.imeiRecords.get(imei).catch(() => undefined)) ||
        (await dexieDb.imeiRecords.get(upper).catch(() => undefined));
      if (dex && (dex.soldAt || dex.saleTransactionId)) return upper;
    } catch {
      // Dexie unavailable (plain preview) — fall through to SQLite.
    }
    try {
      const { findSoldImeiStatus } = await import('../../db/sqlPluginAdapter');
      const st = await findSoldImeiStatus(imei);
      if (st && st.sold) return upper;
    } catch {
      // SQLite unavailable — mirrors above already checked.
    }
  }
  return null;
}

/**
 * UPGRADE-08 — blocked-device screen for the SALE half (fail-closed).
 *
 * A device on the merchant's blocked list is never sold, and there is no
 * per-sale override: the audited manager path is the dossier unblock (one
 * canonical audited action instead of scattered PIN prompts at the till).
 * The staged trade-in leg (exchange) is different — it is an INTAKE, so a
 * fresh one-shot manager grant captured on the Reprise screen lets it
 * proceed; the grant itself is consumed by `commitStagedTradeInIntake` only
 * after that intake persists. A read error under Tauri (`unknown`) denies
 * too — a broken list is not a clean list. Outside Tauri the adapter answers
 * `clear` (preview posture).
 */
async function checkoutDeviceTrustRefusal(
  saleItems: CartItem[],
  staged: { imei?: string } | null,
  grants: Record<string, number>
): Promise<string | null> {
  const { checkImeiBlocked } = await import('../../db/adapters/deviceTrustAdapter');
  for (const item of saleItems) {
    const raw = (item.imeiNumber || '').trim();
    if (!raw) continue;
    const verdict = await checkImeiBlocked(raw);
    if (verdict.status === 'unknown') return `DEVICE_CHECK_UNAVAILABLE:${verdict.detail}`;
    if (verdict.status === 'blocked') return `DEVICE_BLOQUE:${verdict.imei}:${verdict.reason}`;
  }
  const stagedImei = String(staged?.imei ?? '').trim();
  if (stagedImei) {
    const verdict = await checkImeiBlocked(stagedImei);
    if (verdict.status === 'unknown') return `DEVICE_CHECK_UNAVAILABLE:${verdict.detail}`;
    if (verdict.status === 'blocked') {
      const { hasFreshBlockedDeviceGrant, pruneBlockedDeviceGrants } = await import(
        '../../utils/deviceTrust'
      );
      const fresh = pruneBlockedDeviceGrants(grants, Date.now());
      if (!hasFreshBlockedDeviceGrant(fresh, verdict.imei, Date.now())) {
        return `INTAKE_BLOQUE:${verdict.imei}:${verdict.reason}`;
      }
    }
  }
  return null;
}
// P11.3: receipt printing is fire-and-forget and desktop-only; the escpos
// chain (spooler + serial + label builder) loads on first use, not at boot.
// Exchange tickets (tradeInId present) print the revived net receipt
// (items + reprise deduction + net/soulte) instead of the standard one.
async function printReceipt(transaction: SaleTransaction, settings: ReceiptSettings): Promise<void> {
  try {
    if (transaction.tradeInId) {
      try {
        const { usePosStore } = await import('../usePosStore');
        const liveState = usePosStore.getState();
        const trade = liveState.tradeIns.find((t) => t.id === transaction.tradeInId);
        if (trade) {
          const { TradeInVoucherBuilder } = await import('../../utils/tradeInVoucherBuilder');
          const { printViaWindowsSpooler, openCashDrawerViaSpooler } =
            await import('../../utils/escpos');
          const { resolvePrinterForDocument } = await import('../../utils/printerRoutingEngine');
          const bytes = TradeInVoucherBuilder.buildNetTradeInSaleReceipt(
            transaction,
            trade,
            settings,
            transaction.tradeInSoulte ?? null,
            liveState.activeShift?.openedBy ?? liveState.activeShift?.cashierName ?? null
          );
          const target = resolvePrinterForDocument('receipt', settings?.printerRouting);
          await printViaWindowsSpooler(target.printerName, bytes);
          if (settings?.kickCashDrawerOnCash !== false) {
            void openCashDrawerViaSpooler(target.printerName);
          }
          return;
        }
      } catch (err) {
        console.warn('[print] net exchange receipt failed, falling back:', err);
      }
    }
    const { directPrintReceipt } = await import('../../utils/escpos');
    // Live opener backs snapshot-less (legacy) rows on reprint hardware
    // paths; the commit-time snapshot always wins when present.
    const { usePosStore: liveStore } = await import('../usePosStore');
    const liveShift = liveStore.getState().activeShift;
    await directPrintReceipt(
      transaction,
      settings,
      undefined,
      liveShift?.openedBy ?? liveShift?.cashierName ?? null
    );
  } catch (err) {
    console.warn('[print] receipt printing skipped:', err);
  }
}

export const createOrderSlice: StateCreator<PosState, [], [], OrderSlice> = (set, get) => ({
  transactions: [],
  transactionsCursor: null,
  transactionsHasMore: false,
  transactionsLoadingMore: false,
  lastTransaction: null,
  cashTendered: 0,
  paymentMethod: 'Espèces',
  selectedTransactionForRefund: null,

  setCashTendered: (amount) => set({ cashTendered: amount }),
  setSelectedTransactionForRefund: (t) => set({ selectedTransactionForRefund: t }),

  reprintReceipt: (transaction) => {
    set({ lastTransaction: transaction });
    const settings = get().receiptSettings;
      void printReceipt(transaction, settings);
  },

  processPayment: async (tenders?: PaymentTender[]) => {
    // Degraded-license choke: expired/suspended licences refuse NEW sales
    // here — one synchronous check covering every checkout surface (desktop,
    // mobile, quick-cash). Refunds, voids, reports and export stay open.
    const { isSaleBlockedByLicense } = await import('../../licensing/degraded');
    if (isSaleBlockedByLicense()) {
      return { success: false, reason: 'LICENSE_SALE_BLOCKED' };
    }
    // B-061: shared cross-surface flight (processPayment + boot replay + refund
    // write) — the old module flag alone let a recovery replay race a live sale
    // and produce two interleaved busy-retry:checkout loops on one pool.
    if (!tryAcquireCheckoutFlight('processPayment')) {
      return { success: false, reason: 'ALREADY_PROCESSING' };
    }

    try {
      const {
        cart,
        currentCustomer,
        cashTendered,
        products,
        transactions,
        pricingTier,
        storeCreditApplied,
        customers,
        activeShift,
      } = get();

      if (cart.length === 0) return { success: false, reason: 'EMPTY_CART' };

      // C1 shift gate: no sale without an open shift. Cash accountability
      // starts at shift open — a payment outside a shift is unassigned cash.
      if (!activeShift) {
        return { success: false, reason: 'NO_ACTIVE_SHIFT' };
      }

      // IMEI enforcement for serialized items
      const missingIMEI = cart.find(
        (item) => item.product.isSerialized && (!item.imeiNumber || item.imeiNumber.trim() === '')
      );
      if (missingIMEI) {
        return { success: false, reason: `IMEI_REQUIRED:${missingIMEI.product.title}` };
      }

      // Guard against duplicate IMEI assignment in same sale
      const serializedItems = cart.filter((item) => item.product.isSerialized && item.imeiNumber);
      const seenImeis = new Set<string>();
      for (const item of serializedItems) {
        const imei = (item.imeiNumber || '').trim().toUpperCase();
        if (seenImeis.has(imei)) {
          return { success: false, reason: `DUPLICATE_IMEI:${imei}` };
        }
        seenImeis.add(imei);
      }

      // Application-level sold-status check (C2): an IMEI can be sellable in
      // the cart but already sold in the durable lane (second till, synced
      // remote sale). No schema change — reads the existing mirrors only.
      // Return legs are excluded: a cart exchange RETURNS a sold unit by
      // definition (the sold-state is the precondition, not a conflict).
      // Identification checks above (IMEI present, no intra-cart duplicates)
      // still apply to return legs.
      const saleSerializedItems = serializedItems.filter((item) => !item.isReturn);
      const alreadySoldImei = await findAlreadySoldImei(saleSerializedItems, get);
      if (alreadySoldImei) {
        return { success: false, reason: `IMEI_ALREADY_SOLD:${alreadySoldImei}` };
      }

      // UPGRADE-08 — blocked-device screen (fail-closed): sale units are
      // refused outright; the staged trade-in leg accepts a fresh manager
      // grant (captured on the Reprise screen, audited there).
      const trustRefusal = await checkoutDeviceTrustRefusal(
        saleSerializedItems,
        get().stagedTradeIn,
        get().blockedDeviceGrants
      );
      if (trustRefusal) {
        return { success: false, reason: trustRefusal };
      }

      // Canonical totals (single source: receiptMath.computeCartTotals):
      // signed quantities, per-line discounts, store credit, staged voucher
      // credit. Every checkout surface must derive from the same base.
      const stagedVoucher = readVoucherStaging(get());

      let actualStoreCreditApplied = tenders
        ? tenders.filter((t: PaymentTender) => t.method === 'Avoir Client').reduce((acc: number, t: PaymentTender) => acc + t.amount, 0)
        : storeCreditApplied;

      // Staging-drop guard: when explicit tenders are provided, the Avoir leg
      // is authoritative and cart staging is ignored. If the cart carries
      // staged wallet credit but the tenders omit the leg, every total the
      // cashier SAW included the credit while the write would ignore it
      // (under-application → INSUFFICIENT_CASH confusion or over-charge).
      // Abort loudly instead of charging past the displayed net — the
      // cashier re-pays explicitly through the payment modal. Never
      // auto-append: spending wallet credit must stay an explicit act.
      if (
        tenders &&
        actualStoreCreditApplied <= 0 &&
        Math.max(0, Math.round(Number(storeCreditApplied) || 0)) > 0
      ) {
        return { success: false, reason: 'AVOIR_STAGING_DROPPED' };
      }

      if (actualStoreCreditApplied > 0 && currentCustomer) {
        if (actualStoreCreditApplied > currentCustomer.storeCredit) {
          return { success: false, reason: 'INSUFFICIENT_STORE_CREDIT' };
        }
      }

      // Avoir Client never over-covers the basket (mirrors the voucher clamp
      // below): excess wallet credit stays on the wallet instead of cashing
      // out as real money via refundDue below. Without this, a large avoir
      // on a small ticket disburses the difference from the drawer.
      {
        const preCreditBase = computeCartTotals(cart, {
          pricingTier,
          storeCreditApplied: 0,
          voucherCreditApplied: 0,
        });
        actualStoreCreditApplied = Math.max(
          0,
          Math.min(
            actualStoreCreditApplied,
            Math.max(0, preCreditBase.subtotalAfterDiscount)
          )
        );
        // COGS margin-floor + 50% cap (mirrors the PaymentModal guardrail):
        // quick-cash / mobile / direct callers never see that UI, so without
        // this the write layer let wallet credit cover 100% of the basket or
        // pierce below wholesale cost. Clamp-only (never abort): over-cap
        // credit simply applies less and the cashier sees INSUFFICIENT_CASH
        // instead of a silently margin-less sale. Vouchers are NOT capped
        // here — bearer prepaid value the merchant already holds.
        const cartCogsEst = cart.reduce((acc, item) => {
          const unitCost =
            item.unitCostAtSale ?? item.unitCostPrice ?? item.product?.costPrice ?? 0;
          return acc + Math.max(0, Number(unitCost) || 0) * Math.abs(Number(item.quantity) || 0);
        }, 0);
        const { maxAllowedCredit } = calculateMaxAllowedCredit(
          Math.max(0, preCreditBase.subtotalAfterDiscount),
          cartCogsEst,
          actualStoreCreditApplied,
          50
        );
        actualStoreCreditApplied = Math.max(0, Math.min(actualStoreCreditApplied, maxAllowedCredit));
      }

      // Staged voucher credit is revalidated against the durable voucher lane
      // here (pre-write abort): status/expiry/balance may have moved since the
      // code was staged in the cart.
      let voucherCreditApplied = 0;
      let voucherCode: string | null = null;
      if (stagedVoucher.voucherCreditApplied > 0) {
        voucherCode = stagedVoucher.voucherCode;
        if (!voucherCode) {
          return { success: false, reason: 'VOUCHER_INVALID' };
        }
        try {
          const { voucherAdapter } = await import('../../db/adapters/voucherAdapter');
          const voucher = await voucherAdapter.findCreditVoucherByCode(voucherCode);
          if (!voucher || voucher.status !== 'ACTIVE' || voucher.remainingAmount <= 0) {
            return { success: false, reason: 'VOUCHER_INVALID' };
          }
          if (voucher.expiresAt && new Date(voucher.expiresAt).getTime() < Date.now()) {
            return { success: false, reason: 'VOUCHER_EXPIRED' };
          }
          voucherCreditApplied = Math.max(
            0,
            Math.min(stagedVoucher.voucherCreditApplied, Math.round(voucher.remainingAmount))
          );
        } catch {
          return { success: false, reason: 'VOUCHER_UNVERIFIABLE' };
        }
      }

      const preCreditTotals = computeCartTotals(cart, {
        pricingTier,
        storeCreditApplied: actualStoreCreditApplied,
        voucherCreditApplied: 0,
      });
      // A voucher never over-covers the pre-credit net: excess stays on the voucher.
      voucherCreditApplied = Math.max(
        0,
        Math.min(
          voucherCreditApplied,
          Math.max(0, preCreditTotals.subtotalAfterDiscount - actualStoreCreditApplied)
        )
      );
      // Two-way exchange leg (Phase 3): the staged buyback (1:1, no bonus)
      // rides as a payment credit. Mirror the avoir staging-drop guard: with
      // explicit tenders the Reprise leg is authoritative — a staged trade-in
      // missing from the tenders aborts loudly instead of charging past the
      // displayed net. A Reprise tender with nothing staged fails closed.
      const stagedTradeIn = get().stagedTradeIn;
      const tradeInBuybackTrue = stagedTradeIn
        ? Math.max(0, Math.round(Number(stagedTradeIn.buybackValue) || 0))
        : 0;
      let tradeInApplied = 0;
      if (stagedTradeIn) {
        tradeInApplied = tenders
          ? tenders
              .filter((t: PaymentTender) => t.method === 'Reprise')
              .reduce((acc: number, t: PaymentTender) => acc + t.amount, 0)
          : tradeInBuybackTrue;
        if (tenders && tradeInApplied <= 0 && tradeInBuybackTrue > 0) {
          return { success: false, reason: 'TRADE_STAGING_DROPPED' };
        }
      } else if (
        tenders &&
        tenders.some((t: PaymentTender) => t.method === 'Reprise' && (Number(t.amount) || 0) > 0)
      ) {
        return { success: false, reason: 'TRADE_WITHOUT_STAGING' };
      }
      const totals = computeCartTotals(cart, {
        pricingTier,
        storeCreditApplied: actualStoreCreditApplied,
        voucherCreditApplied,
        tradeInCredit: tradeInApplied,
      });
      // Accounting Invariant: gross catalog value (signed for return/exchange
      // items); total is the net due (ttc), never negative. HT-only — there is
      // no VAT term and no `tax` field (Phase 1b-i).
      const grossSubtotal = totals.grossSubtotal;
      const discountTotal = totals.discountTotal;
      const total = totals.total;
      // B-026: when returns dominate, net is negative and ttc clamps to 0 —
      // the signed shortfall must still leave the drawer as cash-out.
      const refundDue = totals.refundDue;

      // Soulte (Phase 3): true buyback vs payable base — when the shop owes
      // the difference, the payout choice (cash drawer / wallet) must have
      // been made explicitly upstream. The trade-in totals leg above is
      // clamped, so a soulte can NEVER leak into refundDue.
      const tradeSettlement = stagedTradeIn
        ? computeTradeInSettlement(totals.subtotalAfterDiscount, tradeInBuybackTrue)
        : null;
      const soulteDue =
        tradeSettlement && tradeSettlement.direction === 'SOULTE_SHOP_PAYS'
          ? tradeSettlement.shopOwes
          : 0;
      // Validated once here; the same value stamps the row (receipt/audit)
      // and drives the post-commit payout below — never re-read mid-flight.
      const soulteMethod: 'cash' | 'wallet' | null =
        soulteDue > 0 ? get().exchangeSoultePayout : null;
      if (soulteDue > 0) {
        if (!soulteMethod) {
          return { success: false, reason: 'SOULTE_CHOICE_REQUIRED' };
        }
        if (soulteMethod === 'wallet' && !currentCustomer) {
          return { success: false, reason: 'SOULTE_WALLET_NO_CUSTOMER' };
        }
        // Chaos S2 overdraft guard (cash only — wallet never touches the
        // drawer): fail closed when the shift float cannot cover the soulte.
        // Estimate mirrors the Z reconciler so the guard agrees with booking;
        // the cashier falls back to Créditer Avoir (always available).
        if (soulteMethod === 'cash') {
          const drawerEstimate = estimateDrawerCashForSoulte(get());
          if (soulteDue > drawerEstimate) {
            return {
              success: false as const,
              reason: `SOULTE_DRAWER_INSUFFICIENT:${drawerEstimate}`,
            };
          }
        }
      }

      // C2 oversell hard block (first line of defense): signed quantities vs
      // live stock, listing the short SKUs. The atomic ledger guard inside
      // writeCheckoutAtomic stays the second line of defense.
      {
        const needByProduct = new Map<string, number>();
        for (const item of cart) {
          const signedQty = item.isReturn ? -Math.abs(item.quantity) : Math.abs(item.quantity);
          if (signedQty <= 0) continue; // returns replenish — never blocked
          needByProduct.set(item.product.id, (needByProduct.get(item.product.id) || 0) + signedQty);
        }
        const shortSkus: string[] = [];
        for (const [pid, need] of needByProduct) {
          if (isServiceProductId(pid)) continue;
          const prod = products.find((p) => p.id === pid);
          // Category is a closed union elsewhere; service rows also arrive
          // with a free-form label, so compare defensively like the catalog does.
          if (!prod || (prod.category as string) === 'Services') continue;
          if (typeof prod.stock === 'number' && prod.stock < need) {
            shortSkus.push(prod.sku || prod.title || pid);
          }
        }
        if (shortSkus.length > 0) {
          return { success: false, reason: `INSUFFICIENT_STOCK:${shortSkus.join(',')}` };
        }
      }

      const creditTender = tenders?.find((t: PaymentTender) => t.method === 'Crédit Client');
      const creditDebtAmount = creditTender ? creditTender.amount : 0;

      if (creditDebtAmount > 0) {
        if (!currentCustomer) {
          return { success: false, reason: 'CUSTOMER_REQUIRED_FOR_CREDIT' };
        }
        // UPGRADE-11: ONE credit gate shared with mobile
        // (`assertCreditAllowed` — same boundary both shipped call sites
        // agreed on: strictly above the ceiling refuses; exactly-at stays).
        const verdict = assertCreditAllowed({
          currentDebt: currentCustomer.currentDebt,
          debtLimit: currentCustomer.debtLimit ?? DEFAULT_CREDIT_LIMIT,
          creditAmount: creditDebtAmount,
        });
        if (!verdict.allowed) {
          return { success: false, reason: `CREDIT_LIMIT_EXCEEDED:${verdict.debtLimit}` };
        }
      }

      // Validate cash is sufficient (excluding credit, store credit and the
      // Reprise leg — the buyback is already netted in `total` above).
      const directTendered = tenders
        ? tenders
            .filter(
              (t: PaymentTender) =>
                t.method !== 'Avoir Client' && t.method !== 'Crédit Client' && t.method !== 'Reprise'
            )
            .reduce((acc: number, t: PaymentTender) => acc + t.amount, 0)
        : cashTendered;

      const remainingToPay = Math.max(0, total - creditDebtAmount);

      if (directTendered < remainingToPay) {
        return { success: false, reason: 'INSUFFICIENT_CASH' };
      }

      const changeDue = Math.max(0, directTendered - remainingToPay);

      // B-026: refund-due requires no cash-in and must disburse cash-out.
      // A non-zero cash tender on a pure refund cart is rejected so change
      // math cannot silently swallow the money owed to the customer.
      if (refundDue > 0 && directTendered > 0) {
        return { success: false, reason: 'REFUND_DUE_REQUIRES_ZERO_TENDER' };
      }

      // FIFO-aware frozen costs: the cart carries no cost until checkout, so
      // freezing `product.costPrice` (the LATEST purchase cost) priced every
      // unit at the newest cost — (3500−400)×2 = 6200 for a 500+400 FIFO sale
      // whose true profit is 6100. Preview the oldest-first batch allocation
      // so frozen costs match what the durable write will store. Best-effort:
      // any preview failure keeps the legacy latest-cost behavior, and the
      // checkout depletion remains the single authority (it re-resolves and
      // corrects the row + adopts into the mirrors below).
      let fifoPreview: Array<{ unitCost: number; fullyCovered: boolean }> | null = null;
      try {
        const { previewFifoLineCosts } = await import('../../db/sqlPluginAdapter');
        fifoPreview = await previewFifoLineCosts(
          cart.map((item) => ({
            productId: item.product.id,
            qty: Math.abs(Number(item.quantity ?? 1)),
            isReturn: Boolean(item.isReturn),
            fallbackCost: Number(item.unitCostAtSale ?? item.unitCostPrice ?? getEffectiveCostPrice(item.product) ?? 0),
          })),
        );
      } catch {
        fifoPreview = null;
      }
      // Capture immutable unit cost price at exact checkout time to protect historical profit margins
      const frozenCartItems: CartItem[] = cart.map((item, itemIdx) => {
        const previewCost = fifoPreview?.[itemIdx]?.unitCost;
        const baseCost = item.unitCostAtSale ?? item.unitCostPrice ?? getEffectiveCostPrice(item.product);
        const cost = previewCost ?? baseCost;
        const unitPriceCharged = item.unitPriceCharged ?? item.appliedPrice ?? item.product.price;
        const defaultPrice = item.defaultPrice ?? item.product.price ?? unitPriceCharged;
        const discountAmount = item.discountAmount ?? Math.max(0, defaultPrice - unitPriceCharged);
        // When the FIFO preview resolved, recompute from it so cost and
        // profit stay consistent (a stale latest-cost lineProfit would pair
        // a 450 cost with a 400-based profit). Otherwise legacy behavior.
        // Canonical formula: receiptMath.lineProfitNet — nets line discounts
        // and signs return lines exactly like the durable checkout twins.
        const lineProfit = fifoPreview
          ? lineProfitNet({
              unitPriceCharged,
              unitCostAtSale: cost,
              quantity: item.quantity,
              discount: item.discount,
              isReturn: item.isReturn,
            })
          : (item.lineProfit ??
            lineProfitNet({
              unitPriceCharged,
              unitCostAtSale: cost,
              quantity: item.quantity,
              discount: item.discount,
              isReturn: item.isReturn,
            }));
        return {
          ...item,
          unitCostPrice: cost,
          unitCostAtSale: cost,
          unitPriceCharged,
          defaultPrice,
          discountAmount,
          lineProfit,
          // Freeze the warranty term onto the frozen line. `transaction.items`
          // IS `frozenCartItems`, so this is what the receipt renders — the same
          // value persisted as `warranty_months_at_sale` on the order line and
          // used by `warrantyAnchorFor` for the IMEI record. One snapshot, three
          // consumers: paper, database, SAV terminal.
          warrantyMonthsAtSale: resolveWarrantyWithFallback(
            (products || []).find((p) => p.id === item.product?.id) ?? null,
            item.product ?? null
          ),
        };
      });

      // Cost & Profit calculations using immutable unit costs
      const costTotal = frozenCartItems.reduce(
        (acc, item) => acc + (item.unitCostPrice ?? 0) * item.quantity,
        0
      );
      const { profit, profitMargin } = calculateProfit(total, costTotal);

      // Unique Relational Identifiers (UUID/ULID compliant)
      // P6: collision-safe ids — the old `.slice(-6)` receipt repeated every
      // ~16.7 min and the txn id's 4 random digits could clash on a burst;
      // every write below is an upsert, so a clash silently overwrites a sale.
      const transactionId = newId('TXN');
      const receiptNumber = newReceiptNumber('REC');

      // Stock deduction map (signed: return items replenish stock)
      const cartProductMap = new Map<string, number>();
      for (const item of frozenCartItems) {
        const signedQty = item.isReturn ? -Math.abs(item.quantity) : Math.abs(item.quantity);
        cartProductMap.set(
          item.product.id,
          (cartProductMap.get(item.product.id) || 0) + signedQty
        );
      }

      const modifiedProducts: Product[] = [];
      const updatedProducts = products.map((product) => {
        const cartQty = cartProductMap.get(product.id);
        if (cartQty !== undefined) {
          // Direct subtraction (no Math.max flooring): the C2 hard block
          // above plus the atomic ledger guard already refused oversells, so
          // a floor here would only hide a bug that must stay loud.
          const updated = { ...product, stock: product.stock - cartQty };
          modifiedProducts.push(updated);
          return updated;
        }
        return product;
      });

      // Customer update
      let updatedCustomer = currentCustomer;
      let updatedCustomers = customers;
      let newCustomerDebts = get().customerDebts;
      let debtEntry: CustomerDebtEntry | null = null;
      // Milestone snapshots minted below (empty for anonymous sales).
      let completedMilestoneAwards: MilestoneAward[] = [];

      // At-sale campaign multiplier: persisted on the row so void/refund
      // reversals deduct what was actually earned, even if the campaign
      // ended since (post-campaign voids must not leak bonus points).
      // Hoisted (not inside the customer block): the transaction literal
      // below needs the same value, and anonymous sales earn nothing anyway.
      const earnCampaignMult = activeCampaignMultiplier();

      // Case 44: loyalty must be computed from the DURABLE customer row, not the
      // in-memory snapshot. A native-only write (a forged/other-window refund, a
      // void in another tab) updates SQLite without refreshing this store;
      // computing from the stale snapshot would rewrite the pre-write buckets and
      // resurrect revoked points. Failure to read falls back to the snapshot with
      // a warning (a sale must not be refused over a loyalty read).
      let loyaltyBase: Customer | null = currentCustomer;
      if (currentCustomer?.id) {
        try {
          const { getLocalDb } = await import('../../db/sqlPluginAdapter');
          const db = await getLocalDb();
          const rows = (await db.select(
            'SELECT loyalty_points, total_spent, store_credit, current_debt, json_payload FROM customers WHERE id = $1',
            [currentCustomer.id],
          )) as Array<Record<string, unknown>>;
          const row = rows?.[0];
          if (row) {
            let payload: Record<string, unknown> = {};
            try {
              payload = JSON.parse(String(row.json_payload ?? '{}')) as Record<string, unknown>;
            } catch {
              payload = {};
            }
            loyaltyBase = {
              ...currentCustomer,
              loyaltyPoints:
                typeof row.loyalty_points === 'number' ? row.loyalty_points : currentCustomer.loyaltyPoints,
              totalSpent: typeof row.total_spent === 'number' ? row.total_spent : currentCustomer.totalSpent,
              storeCredit: typeof row.store_credit === 'number' ? row.store_credit : currentCustomer.storeCredit,
              currentDebt:
                typeof row.current_debt === 'number' ? row.current_debt : currentCustomer.currentDebt,
              pointBuckets: Array.isArray(payload.pointBuckets)
                ? (payload.pointBuckets as Customer['pointBuckets'])
                : currentCustomer.pointBuckets,
              ledger: Array.isArray(payload.ledger)
                ? (payload.ledger as Customer['ledger'])
                : currentCustomer.ledger,
            } as Customer;
          }
        } catch (e) {
          console.warn('[checkout:loyalty] durable customer read failed; using the in-memory snapshot', e);
        }
      }

      // REF-15: points-backed credit left after this sale (persisted below).
      let creditFromPointsRemaining: number | null = null;
      if (loyaltyBase) {
        // Effective loyalty config: merchant settings merged over defaults.
        const loyaltyCfg = normalizeLoyaltyConfig(get().receiptSettings?.loyaltyConfig);
        const earnAllowed = isEarnAllowed(loyaltyCfg);
        const currentTotalSpent = loyaltyBase.totalSpent || 0;
        const currentTier = calculateCustomerTier(currentTotalSpent, loyaltyCfg);

        const earnedPoints =
          earnAllowed && remainingToPay > 0
            ? calculateNetPaidEarnedPoints(cart, remainingToPay, grossSubtotal, currentTier.pointsMultiplier, loyaltyCfg, earnCampaignMult)
            : 0;

        // Net-paid progression (anti-self-funding): the Avoir-funded slice
        // of this ticket never advances totalSpent, so loyalty rewards can
        // never fund progress toward future loyalty rewards.
        const spendProgress = earnAllowed ? Math.max(0, remainingToPay - actualStoreCreditApplied) : 0;
        const newTotalSpent = currentTotalSpent + spendProgress;
        const newTier = calculateCustomerTier(newTotalSpent, loyaltyCfg);

        const existingBuckets = loyaltyBase.pointBuckets || [];
        // B-024: same config rate as void restore — hardcoded /10 drifted
        // when merchant customized pointRedemptionRate. Normalized (never 0:
        // a raw zero would divide by zero into Infinity and drain all buckets).
        const redemptionRate = loyaltyCfg.pointRedemptionRate;
        // REF-15: credit minted by a points->Avoir conversion has ALREADY cost
        // its points. Deducting again here burned them twice (400 -> 372 on a
        // credit-paid sale). Only the rest of the applied credit redeems
        // points; the marker shrinks by what was actually spent.
        const pointsBackedCredit = Math.max(
          0,
          Math.round(
            Number((loyaltyBase as { creditFromPointsDzd?: number }).creditFromPointsDzd ?? 0) || 0,
          ),
        );
        const creditSplit = splitCreditRedemption(
          actualStoreCreditApplied,
          pointsBackedCredit,
          redemptionRate,
        );
        const pointsToRedeem = creditSplit.pointsToRedeem;
        creditFromPointsRemaining = creditSplit.pointsBackedRemaining;
        const { updatedBuckets } = depleteFifoPointBuckets(existingBuckets, pointsToRedeem);

        const finalBuckets = [...updatedBuckets];
        if (earnedPoints > 0) {
          finalBuckets.push(
            createDatedPointBucket(
              loyaltyBase.id,
              receiptNumber,
              earnedPoints,
              remainingToPay,
              newTier.name,
              undefined,
              newTier.expiryDays ?? null
            )
          );
        }

        // Config-driven milestones evaluated on the net-paid movement.
        // In-flight tickets keep their staged redemption even if the program
        // was just disabled (validation happens at staging time); only new
        // earn is gated.
        // pointsBalanceAfter is stamped onto entries below once newPoints
        // is known (ledger convention: headline points balance).
        const milestoneEval = evaluateSpendMilestones(
          loyaltyBase.id,
          currentTotalSpent,
          newTotalSpent,
          loyaltyCfg,
          loyaltyBase.ledger || [],
          0
        );
        const earnedCreditBonus = milestoneEval.totalReward;

        const newCredit = Math.max(0, loyaltyBase.storeCredit - actualStoreCreditApplied) + earnedCreditBonus;
        const newPoints = Math.max(0, loyaltyBase.loyaltyPoints - pointsToRedeem) + earnedPoints;
        const newDebt = (loyaltyBase.currentDebt || 0) + creditDebtAmount;
        for (const e of milestoneEval.entries) e.balanceAfter = newPoints;
        completedMilestoneAwards = milestoneEval.awards;

        const newEntries: LoyaltyLedgerEntry[] = [];
        if (actualStoreCreditApplied > 0) {
          newEntries.push(
            createLedgerEntry(
              loyaltyBase.id,
              'redeem',
              -pointsToRedeem,
              newPoints,
              `Utilisation Avoir Client (${actualStoreCreditApplied} DA) sur Ticket #${receiptNumber}`,
              transactionId,
              -actualStoreCreditApplied
            )
          );
        }
        if (earnedPoints > 0) {
          newEntries.push(
            createLedgerEntry(
              loyaltyBase.id,
              'earn',
              earnedPoints,
              newPoints,
              `Gain points (${earnedPoints} pts) sur Ticket #${receiptNumber}`,
              transactionId
            )
          );
        }
        for (const e of milestoneEval.entries) newEntries.push(e);

        const existingLedger = loyaltyBase.ledger || [];
        // P2.3 ledger anchor: freeze the pre-upgrade scalar balance once so
        // the sync-merge path can derive credit from ledger deltas. One-time
        // per customer (key-deduped); a no-op for everyone else.
        const genesisEntry = ensureCreditGenesis({
          ...loyaltyBase,
          storeCredit: newCredit,
          ledger: [...newEntries, ...existingLedger],
        });
        updatedCustomer = {
          ...loyaltyBase,
          totalSpent: newTotalSpent,
          loyaltyTier: newTier.name,
          loyaltyPoints: newPoints,
          storeCredit: newCredit,
          currentDebt: newDebt,
          // REF-15: whatever points-backed credit this sale consumed is gone;
          // the rest stays marked so a later sale does not burn its points.
          ...(creditFromPointsRemaining !== null
            ? { creditFromPointsDzd: creditFromPointsRemaining }
            : {}),
          pointBuckets: finalBuckets,
          ledger: genesisEntry ? [genesisEntry, ...newEntries, ...existingLedger] : [...newEntries, ...existingLedger],
        };

        if (creditDebtAmount > 0) {
          // UPGRADE-11 (v126): a credit sale is due in 30 days by default —
          // the aging ladder (30/60/90) reads this. One clock read keeps the
          // createdAt stamp and the due date consistent.
          const debtCreatedAt = new Date().toISOString();
          debtEntry = {
             id: newId('DEBT'),
            customerId: loyaltyBase.id,
            customerName: loyaltyBase.name,
            type: 'DEBT_ACQUIRED',
            kind: 'ACHAT',
            amount: creditDebtAmount,
            balanceAfter: newDebt,
            receiptNumber,
            paymentMethod: 'Crédit Client',
            notes: `Vente à Crédit #${receiptNumber} - Transaction #${transactionId}`,
            createdAt: debtCreatedAt,
            dueDate: addDaysIso(debtCreatedAt, KREDY_DEFAULT_TERM_DAYS),
            // Attribution follows mid-shift handovers: currentCashier (set via
            // setShiftCashier) wins when present, cashierName is the fallback.
            recordedBy:
              (activeShift as unknown as { currentCashier?: string } | null | undefined)?.currentCashier?.trim() ||
              activeShift?.cashierName ||
              'Abdelkader Benali',
          };
          newCustomerDebts = [debtEntry, ...newCustomerDebts];
        }

        const finalCust = updatedCustomer;
        updatedCustomers = customers.map((c) => (c.id === finalCust.id ? finalCust : c));
      }

      // Two-way exchange intake-first commit (after ALL tender/cash gates,
      // just before the durable write): product + trade + IMEI + FIFO batch.
      // Deterministic ids (stagedId) make this retry-safe; the recovery
      // intent parked below already carries the linkage, so a boot replay
      // converges to sale + intake with no duplicates. Intake failure aborts
      // cleanly here — nothing else has been written in this flight.
      let exchangeTradeId: string | null = null;
      if (stagedTradeIn) {
        const intake = await get().commitStagedTradeInIntake(stagedTradeIn);
        if (!intake.success) {
          return { success: false, reason: `INTAKE_FAILED:${intake.reason}` };
        }
        exchangeTradeId = intake.tradeId;
      }

      // P11.3: device id lives in the sync layer; load it lazily at checkout time.
      const { getStableDeviceId } = await import('../../sync/device');
      const currentDeviceId = await getStableDeviceId().catch(() => 'default');
      // Part 1 seller rule: the receipt seller is ALWAYS the shift opener
      // (`openedBy`, immutable) — never the handover cashier that
      // `setShiftCashier` may have re-pointed onto `cashierName` mid-shift.
      // Both the display name and the `shiftOpenedByName` snapshot are stamped
      // here so reprints stay correct weeks later (rides json_payload free).
      const shiftOpenerName =
        (activeShift?.openedBy || '').trim() ||
        (activeShift?.cashierName || '').trim() ||
        undefined;
      const transaction: SaleTransaction = {
        id: transactionId,
        receiptNumber: receiptNumber,
        // D6: never embed the customer's whole loyalty book in the ticket
        // payload (200 000 tranche rows at 4e9 made the refund unmergeable).
        // Refunds/voids read the durable customer row; only identity + scalars
        // belong here.
        customer: saleCustomerSnapshot(updatedCustomer) as SaleTransaction['customer'],
        items: frozenCartItems,
        subtotal: grossSubtotal,
        discountTotal: discountTotal,
        total,
        costTotal,
        profit,
        profitMargin,
        pricingTier,
        paymentMethod: tenders && tenders.length > 0 ? tenders[0].method : 'Espèces',
        tenders,
        cashTendered: tenders
          ? tenders
              .filter((t: PaymentTender) => t.method !== 'Reprise')
              .reduce((acc: number, t: PaymentTender) => acc + t.amount, 0)
          : cashTendered,
        changeDue,
        createdAt: new Date().toISOString(),
        cashierName: shiftOpenerName || 'Abdelkader Benali',
        debtAdded: creditDebtAmount > 0 ? creditDebtAmount : undefined,
        debtRemainingTotal: updatedCustomer?.currentDebt,
        deviceId: currentDeviceId,
        device_id: currentDeviceId,
        // Owning cash session, stamped from the live OPEN row (the
        // NO_ACTIVE_SHIFT gate above guarantees one). Closes scope by window
        // with this id as the attribution tiebreak.
        shiftId: activeShift?.id ?? undefined,
        // Immutable shift-opener identity (see above): reprint-proof seller.
        ...(shiftOpenerName ? { shiftOpenedByName: shiftOpenerName } : {}),
        // Persisted for void/refund credit-back (not envelope-only): without
        // these on the row, cancelling a voucher-paid sale burns bearer value.
        ...(voucherCode ? { voucherCode, voucherCreditApplied } : {}),
        // Two-way exchange linkage (not envelope-only): void/refund flows
        // reverse the intake leg instead of burning it. cashTendered below
        // excludes the Reprise leg (money actually handed); the deduction
        // rides here. fullTx (spread below) carries both into the receipt.
        ...(exchangeTradeId
          ? { tradeInId: exchangeTradeId, tradeInDeduction: tradeInApplied }
          : {}),
        // Soulte settlement stamped for receipt + audit traceability.
        ...(soulteDue > 0 && soulteMethod
          ? { tradeInSoulte: { amount: soulteDue, method: soulteMethod } }
          : {}),
        // At-sale loyalty campaign multiplier (see earn site above): void and
        // refund reversals deduct exactly what was earned. Absent on legacy
        // rows, which fall back to currently-active campaigns.
        ...(earnCampaignMult > 1 ? { loyaltyCampaignMultiplier: earnCampaignMult } : {}),
        // Immutable milestone snapshots: clawbacks reverse these recorded
        // amounts, never live config. Absent on legacy rows, which fall
        // back to ledger grant snapshots.
        ...(completedMilestoneAwards.length > 0 ? { milestoneAwards: completedMilestoneAwards } : {}),
      };

      // Store invariant: newest-first (centralized helper — a raw prepend
      // alone diverges from boot/pull order; see store/transactionOrder).
      const newTransactions = sortedTransactions([transaction, ...transactions]);

      // Synchronous Atomic Persistence (Contract C6: Zero Silent Data Loss)
      const warnings: string[] = [];
      const noteWarning = (w: string) => {
        warnings.push(w);
      };
      // B-004 FIX-4: build the checkout payload up-front and park a durable
      // recovery intent in Dexie (IndexedDB) BEFORE the SQLite write. If
      // writeCheckoutAtomic throws, the intent survives SQLITE_BUSY/disk-full
      // and boot replay re-runs it — the sale no longer vanishes.
      const checkoutPayload = {
          orderRow: {
            id: transactionId,
            receipt_number: receiptNumber,
            customer_id: updatedCustomer?.id ?? null,
            shift_id: activeShift?.id ?? null,
            subtotal: grossSubtotal,
            discount_total: discountTotal,
            total,
            cost_total: costTotal,
            profit,
            profit_margin: profitMargin,
            pricing_tier: pricingTier,
            payment_method: transaction.paymentMethod,
            cash_tendered: transaction.cashTendered,
            change_due: changeDue,
            status: 'COMPLETED',
            created_at: transaction.createdAt,
            device_id: currentDeviceId,
          },
          fullTx: {
            ...transaction,
            ...(voucherCode ? { voucherCode, voucherCreditApplied } : {}),
          } as unknown as Record<string, unknown>,
          items: frozenCartItems.map((ci, idx) => {
            const pId = ci.product?.id || `prod-${idx}`;
            return {
              id: `${transactionId}-item-${idx}`,
              product_id: pId,
              quantity: Number(ci.quantity || 1),
              applied_price: Number(ci.appliedPrice ?? ci.product?.price ?? 0),
              unit_price_charged: Number(ci.unitPriceCharged ?? ci.appliedPrice ?? ci.product?.price ?? 0),
              default_price: Number(ci.defaultPrice ?? ci.product?.price ?? ci.appliedPrice ?? 0),
              discount_amount: Number(ci.discountAmount ?? 0),
              discount: Number(ci.discount ?? 0),
              imei_number: ci.imeiNumber ?? null,
              // Warranty captured AT SALE. The SQLite line is the durable
              // point-in-time record, so the months a customer actually bought
              // must be frozen here — the catalog `warrantyMonths` may change
              // later and must never re-date this sale.
              warranty_months_at_sale: resolveWarrantyWithFallback(
                (products || []).find((p) => p.id === pId) ?? null,
                ci.product ?? null
              ),
              cost_price: Number(ci.unitCostPrice ?? ci.product?.costPrice ?? 0),
              unit_cost_at_sale: Number(ci.unitCostAtSale ?? ci.unitCostPrice ?? ci.product?.costPrice ?? 0),
              line_profit: Number(ci.lineProfit ?? 0),
              // Edge D (exchange): return lines restock instead of depleting.
              is_return: Boolean(ci.isReturn),
            };
          }),
          deltas: frozenCartItems.map((ci, idx) => ({
            productId: ci.product?.id || `prod-${idx}`,
            delta: ci.isReturn ? Math.abs(ci.quantity || 1) : -Math.abs(ci.quantity || 1),
            reason: (ci.isReturn ? 'REFUND' : 'SALE') as 'REFUND' | 'SALE',
            refType: ci.isReturn ? 'order_exchange' : 'order',
            refId: transactionId,
          })),
          productSnapshots: frozenCartItems.map((ci, idx) => ({
            id: ci.product?.id || `prod-${idx}`,
            sku: ci.product?.sku || '',
            barcode: ci.product?.barcode || '',
            title: ci.product?.title || 'Article',
            brand: ci.product?.brand || 'Autre',
            category: ci.product?.category || 'Tous les produits',
            price: Number(ci.product?.price ?? 0),
            // Last-known on-hand for the oversell guard's stub-door baseline
            // (Dexie-only product with no SQLite row yet). Absent below only
            // for pre-fix replay payloads, which keep legacy behavior.
            stock: Number(ci.product?.stock ?? 0),
          })),
        } as const;
      const recoverySaved = await saveCheckoutRecoveryIntent({
        transactionId,
        receiptNumber,
        payload: checkoutPayload as unknown as Parameters<typeof saveCheckoutRecoveryIntent>[0]['payload'],
        customerPayload: updatedCustomer
          ? (updatedCustomer as unknown as Record<string, unknown>)
          : null,
        debtEntry: debtEntry ? (debtEntry as unknown as Record<string, unknown>) : null,
      });
      try {
          // ORDER FIRST. If this throws, nothing below has mutated the
          // customer store credit, loyalty points or debt, so a
          // PERSISTENCE_FAILED abort leaves the merchant books honest.
          // Pre-fix the customer debit landed (and was pushed to the cloud)
          // before a failed order write, while the UI reported the sale as
          // never recorded: a phantom debit with no in-product signal.
          const { writeCheckoutAtomic, enqueueGenericSync } = await import('../../db/sqlPluginAdapter');
          const checkoutResult = await writeCheckoutAtomic(checkoutPayload);
          // FIFO authority (STRICT LEDGER, v104): the durable write resolved
          // the true batch-blended COGS. MANDATORILY adopt it here so the
          // in-memory transaction, the Dexie mirror below, the printed
          // receipt and the Zustand KPIs all match the SQLite row (and
          // therefore the synced peer) to the dinar. costTotal must NEVER be
          // left at the pre-correction estimate (e.g. 500×2=1000) when the
          // frozen total (e.g. 500+400=900) is available — that gap is the
          // 6,000-instead-of-6,100 display bug.
          if (checkoutResult.fifoCostTotal != null && checkoutResult.fifoProfit != null) {
            transaction.costTotal = checkoutResult.fifoCostTotal;
            transaction.profit = checkoutResult.fifoProfit;
            transaction.profitMargin =
              transaction.total > 0
                ? Number(((transaction.profit / transaction.total) * 100).toFixed(1))
                : 0;
            // v105 ATOMIC MATERIALIZATION: the exact allocation sum the txn
            // hardcoded into transactions.ledger_cogs_total before commit —
            // the receipt reads this, never re-derives. Adopt alongside cost.
            if (checkoutResult.ledgerCogsTotal != null) {
              transaction.ledgerCogsTotal = checkoutResult.ledgerCogsTotal;
            }
            (checkoutResult.fifoItems || []).forEach((res, resIdx) => {
              const line = transaction.items[resIdx];
              if (!line) return;
              line.unitCostAtSale = res.unitCostAtSale;
              line.unitCostPrice = res.unitCostAtSale;
              line.lineProfit = res.lineProfit;
              line.fifoAllocations = (res.fifoAllocations || []).map((a: { batchId: string; quantity: number; unitCost: number }) => ({ ...a }));
            });
            // Explicit same-reference sync: newTransactions[0] IS transaction,
            // but re-assert the frozen values so a future copy (spread/clone)
            // of the array can never resurrect the stale 1,000 estimate.
            const head = newTransactions[0];
            if (head && head.id === transaction.id) {
              head.costTotal = transaction.costTotal;
              head.profit = transaction.profit;
              head.profitMargin = transaction.profitMargin;
              head.items = transaction.items;
              if (transaction.ledgerCogsTotal !== undefined) {
                head.ledgerCogsTotal = transaction.ledgerCogsTotal;
              }
            }
          } else {
            // Loud, never silent: without FIFO resolution the mirrors below
            // persist the pre-correction estimate. The allocation-backed
            // report still repairs display once the ledger lands, but this
            // warn names the sale so the gap is traceable instead of quiet.
            console.warn(
              `[checkout] FIFO COGS unresolved for ${transactionId} — persisting pre-correction estimate costTotal=${costTotal} (allocation backfill will repair display once batches land).`
            );
          }
        // F2: the recovery intent clears only after ALL post-order durable
        // side-effects below (customer, debt, mirror, voucher, cash-out,
        // IMEI) — clearing here would orphan them on a kill in that window.
        // (Business rejections like INSUFFICIENT_STOCK clear explicitly in
        // the catch: they must never auto-replay on boot.)
        // Now the customer-side mutation is safe to land:
        // the sale it belongs to is already recorded, so the debit/debt/points
        // can always be traced back to a real transaction.
        // H8: post-order money writes retry once, then queue to the outbox and
        // surface an explicit warning — never .catch(console.error) silence.
        const sqlite = await getSqlite();
        if (updatedCustomer) {
          // Pin for the closure: soulte credit reassigns updatedCustomer
          // above, which would otherwise reset narrowing inside the thunk.
          const custToSave = updatedCustomer;
          const saved = await persistWithRetryOnce(() =>
            getCustomerRepo().then((repo) => repo.save(custToSave))
          );
          if (!saved.ok) {
            try {
              await enqueueGenericSync(
                'customer',
                updatedCustomer.id,
                updatedCustomer as unknown as Record<string, unknown>
              );
              noteWarning('Fidélité/avoir : solde client synchronisé en différé (file de synchronisation).');
            } catch {
              noteWarning("Fidélité/avoir : écriture client non confirmée — vérifiez la fiche client.");
            }
          }
        }
        if (debtEntry) {
          const savedDebt = await persistWithRetryOnce(() => sqlite.saveCustomerDebt(debtEntry));
          if (!savedDebt.ok) {
            try {
              await enqueueGenericSync(
                'customer_debt',
                debtEntry.id,
                debtEntry as unknown as Record<string, unknown>
              );
              noteWarning('Dette client : écriture synchronisée en différé (file de synchronisation).');
            } catch {
              noteWarning('Dette client : écriture non confirmée — vérifiez le grand livre des dettes.');
            }
          }
        }
        const mirrored = await persistWithRetryOnce(() =>
          sqlite.processSaleTransactionAtomic(
            transaction,
            modifiedProducts,
            updatedCustomer || undefined,
            undefined
          )
        );
        if (!mirrored.ok) {
          noteWarning('Ticket enregistré (vente durable) mais index local à revérifier.');
        }

        // Restitute FIFO stock_batches in Dexie mirror for return/exchange items
        const returnItems = frozenCartItems.filter((ci) => Boolean(ci.isReturn));
        if (returnItems.length > 0) {
          try {
            const { db: dexieDb } = await import('../../db/database');
            const now = new Date().toISOString();
            for (const [rIdx, rItem] of returnItems.entries()) {
              const pId = rItem.product.id;
              const lineQty = Math.max(1, toIntMoney(Number(rItem.quantity) || 1));
              const lineCost = Math.max(0, toIntMoney(rItem.unitCostPrice ?? rItem.product.costPrice ?? 0));
              const existingBatch = await dexieDb.stockBatches.where('productId').equals(pId).first();
              if (existingBatch) {
                await dexieDb.stockBatches.update(existingBatch.batchId, {
                  quantityRemaining: (existingBatch.quantityRemaining || 0) + lineQty,
                  updatedAt: now,
                });
              } else {
                await dexieDb.stockBatches.put({
                  batchId: `batch-exchange-${transactionId}-${rIdx}`,
                  productId: pId,
                  quantityRemaining: lineQty,
                  unitCost: lineCost,
                  receivedAt: now,
                  purchaseOrderId: 'EXCHANGE',
                  createdAt: now,
                  updatedAt: now,
                });
              }
            }
          } catch (batchMirrorErr) {
            console.warn('[checkout] Dexie return batch restitution skipped:', batchMirrorErr);
          }
        }

        // Voucher capture — ONLY here, after the order row is durable, and
        // only via the atomic conditional decrement. Pre-write validation
        // above already rejected bad vouchers, so a failure here means a
        // genuine concurrent capture: warn loudly, never double-spend.
        if (voucherCode && voucherCreditApplied > 0) {
          const { voucherAdapter } = await import('../../db/adapters/voucherAdapter');
          const captured = await persistWithRetryOnce(async () => {
            const res = await voucherAdapter.redeemCreditVoucher(voucherCode, voucherCreditApplied);
            if (!res.success) throw new Error(res.reason || 'VOUCHER_CAPTURE_FAILED');
            return res;
          });
          if (!captured.ok) {
            noteWarning(
              `Bon d'avoir ${voucherCode} : ${voucherCreditApplied} DA accordés mais déduction non confirmée — à contrôler manuellement.`
            );
            // H29-E: NEVER enqueue a partial 'credit_voucher' payload here. The
            // old call passed { code, captureAmount, orderId } with no id and no
            // amounts, so enqueueGenericSync keyed the outbox row by the voucher
            // CODE and pushed a zero-balance nonsense row into the cloud
            // credit_vouchers KV table — a row that could shadow the real
            // voucher in findCreditVoucherByCode and silently overwrite its
            // remaining balance on every other device (C6). A capture failure is
            // an accountability event, not a voucher mutation: record it in the
            // audit log (its own synced lane) and leave the voucher lane to
            // voucherAdapter, the only place that writes real voucher payloads.
            const { logSecurityAction } = get();
            logSecurityAction(
              'Capture Avoir Non Confirmée',
              `Bon ${voucherCode} : ${voucherCreditApplied} DA accordés sur le ticket #${transactionId} mais la déduction atomique a échoué (${captured.error || 'échec inconnu'}). À contrôler manuellement.`,
              'Système (Vente)',
              true
            );
          } else if (captured.value.voucher) {
            try {
              const lane = (get() as unknown as { creditVouchers?: unknown }).creditVouchers;
              if (Array.isArray(lane)) {
                const fresh = captured.value.voucher;
                set({
                  creditVouchers: lane.map((cv: unknown) =>
                    (cv as { id?: string }).id === fresh.id ? fresh : cv
                  ),
                } as unknown as Partial<PosState>);
              }
            } catch {
              // UI mirror only — the durable lane already landed.
            }
          }
        }
        try {
          const { syncManager } = await import('../../sync/SyncManager');
          syncManager.notifyLocalWrite();
        } catch (syncErr) {
          console.warn('[checkout] SyncManager local write notification deferred:', syncErr);
        }
        // Convergence: re-derive the displayed debt from the ledger AFTER
        // commit (credit sales acquire debt here) — same derivation the peer
        // runs on pull, so both tills show the same number.
        if (updatedCustomer) {
          try {
            const { reconcileCustomerDebtFromLedger } = await import('../../db/sqlPluginAdapter');
            await reconcileCustomerDebtFromLedger([updatedCustomer.id]);
          } catch {
            // Display already updated; reconcile is hardening.
          }
        }
      } catch (e) {
        console.error('Checkout persistence failed (SQLite/Dexie write error):', e);
        const msg = e instanceof Error ? e.message : String(e);
        // Surface the atomic oversell guard (second line of defense) with its
        // short-SKU detail instead of a generic persistence failure.
        if (msg.startsWith('INSUFFICIENT_STOCK')) {
          // F2: business rejection — must never auto-replay on boot (a
          // restock-then-reboot would silently charge the customer).
          await clearCheckoutRecoveryIntent(transactionId).catch(() => {});
          return { success: false, reason: msg };
        }
        // Propagate a truncated single-line detail so the UI can log/show the
        // real SQLite cause (CHECK/UNIQUE/no-such-column) instead of a blind
        // generic toast. Callers match with startsWith('PERSISTENCE_FAILED').
        const detail = msg.replace(/\s+/g, ' ').slice(0, 160);
        // B-004 FIX-4: if the Dexie recovery intent landed before the SQLite
        // throw, the sale is recoverable on next boot — signal the UI so it
        // can show a softer "queued" message instead of "non enregistrée".
        if (recoverySaved) {
          return {
            success: false,
            reason: `PERSISTENCE_FAILED:${detail}`,
            recoveryQueued: true,
            warnings: [
              "Vente mise en file de récupération — elle sera reprise au prochain démarrage si l'écriture reste impossible.",
            ],
          };
        }
        return { success: false, reason: `PERSISTENCE_FAILED:${detail}` };
      }

      // B-026: order row is durable — disburse the cash-out owed for a
      // net-negative cart. Failure surfaces as a warning, never a silent drop
      // (books already show the sale; drawer must follow).
      if (refundDue > 0 && activeShift) {
        try {
          const drawerOut = await get().logCashMovement(
            refundDue,
            'EXPENSE',
            `${DRAWER_REASON_PREFIXES.EXCHANGE_CASHOUT} (ticket ${receiptNumber})`,
            activeShift.cashierName
          );
          if (!drawerOut.success) {
            noteWarning(
              `Remboursement ${formatDZD(refundDue)} DA non sorti du tiroir — vérifiez manuellement.`
            );
          }
        } catch {
          noteWarning(
            `Remboursement ${formatDZD(refundDue)} DA non sorti du tiroir — vérifiez manuellement.`
          );
        }
      }

      // Soulte boutique (Phase 3): order row is durable — settle the shop's
      // debt from the exchange. Cash leaves a single net EXPENSE tagged with
      // the trade id (read by the unified exchange lane); wallet credits the
      // customer's storeCredit 1:1. Failures warn loudly, never silently drop
      // (books already show the sale; money must follow).
      if (soulteDue > 0 && activeShift && soulteMethod) {
        const soulteChoice = soulteMethod;
        const soulteLabel = `Soulte échange ${stagedTradeIn?.deviceModel ?? ''} (Reprise ${exchangeTradeId ?? ''}) — ticket ${receiptNumber}`;
        try {
          if (soulteChoice === 'cash') {
            const soulteOut = await get().logCashMovement(
              soulteDue,
              'EXPENSE',
              `${DRAWER_REASON_PREFIXES.SOULTE_CASHOUT} ${soulteLabel}`,
              activeShift.cashierName,
              undefined,
              'TRADE_IN_SOULTE',
              'TRADE_IN',
              exchangeTradeId ?? undefined
            );
            if (!soulteOut.success) {
              noteWarning(
                `Soulte ${formatDZD(soulteDue)} DA non décaissée — versez-la manuellement.`
              );
            }
          } else if (soulteChoice === 'wallet' && updatedCustomer) {
            const credited = {
              ...updatedCustomer,
              storeCredit: (updatedCustomer.storeCredit || 0) + soulteDue,
            };
            const nextCustomers = (get().customers || []).map((c) =>
              c.id === credited.id ? credited : c
            );
            await (await getCustomerRepo()).save(credited).catch((err: unknown) => {
              throw err;
            });
            updatedCustomers = nextCustomers;
            if (get().currentCustomer?.id === credited.id) {
              updatedCustomer = credited;
            }
            get().logSecurityAction(
              'Soulte Échange Créditée (Avoir)',
              `Client: ${credited.name} — soulte de ${formatDZD(soulteDue)} DA créditée (reprise ${stagedTradeIn?.deviceModel ?? ''}, ticket ${receiptNumber}).`,
              activeShift.cashierName || 'Système (Échange)',
              false
            );
          }
        } catch {
          noteWarning(
            `Soulte ${formatDZD(soulteDue)} DA non réglée (${soulteChoice === 'cash' ? 'tiroir' : 'avoir'}) — régularisez manuellement.`
          );
        }
      }

      // Track sold serialized items in Dexie and store.
      // Q-B: a RETURN leg (`isReturn`) goes back to stock, so it must not mint a
      // sale, a registry row, or a warranty anchor. Previously every line with an
      // identifier was stamped as sold, so an exchange wrote `soldAt` +
      // `warrantyExpiresAt` for the outgoing handset — the inspector then showed
      // a live warranty on a device the customer had just handed back, and the
      // unit could never be re-sold because the "sold" gate rejected it.
      const soldImeis = frozenCartItems
        .filter((ci) => Boolean(ci.imeiNumber && ci.imeiNumber.trim()))
        .filter((ci) => !(ci as { isReturn?: boolean }).isReturn)
        .map((ci) => {
          const pId = ci.product?.id || '';
          return {
            imei: canonicalDeviceId(ci.imeiNumber),
            productId: pId,
            // Point-in-time anchor, minted once here at checkout completion.
            warrantyMonths: resolveWarrantyWithFallback(
              (products || []).find((p) => p.id === pId) ?? null,
              ci.product ?? null
            ),
          };
        });

      let nextImeiRecords = get().imeiRecords || [];
      if (soldImeis.length > 0) {
        try {
            const { db: dexieDb } = await import('../../db/database');
          for (const si of soldImeis) {
            const existing = await dexieDb.imeiRecords.get(si.imei);
            const rec: IMEIRecord = existing || {
              imei: si.imei,
              productId: si.productId,
              // No prior registry row, so there is no earlier stock-entry
              // instant to preserve; checkout time is the best available.
              receivedAt: transaction.createdAt,
            };
            rec.saleTransactionId = transaction.id;
            rec.soldAt = transaction.createdAt;
            rec.warrantyMonths = si.warrantyMonths;
            // Q-A WRITER: re-anchor when the SALE TRANSACTION CHANGES, and only
            // then.
            //
            // Before this, the guard was `if (!rec.warrantyExpiresAt)`, so a
            // device that was refunded and then genuinely re-sold kept the FIRST
            // anchor: the row carried buyer #1's expiry while `saleTransactionId`
            // and `soldAt` pointed at buyer #2's sale. The inspector then showed
            // buyer #1's clock for buyer #2's device.
            //
            // Same transaction re-written = the SAME sale (a corrected ticket, a
            // retry). Coverage the customer already holds must not be re-dated,
            // so the frozen anchor is preserved.
            const isSameSale = existing?.saleTransactionId === transaction.id;
            if (!isSameSale || !rec.warrantyExpiresAt) {
              rec.warrantyExpiresAt = warrantyAnchorFor({
                soldAt: transaction.createdAt,
                warrantyMonths: si.warrantyMonths,
              });
            }
            await dexieDb.imeiRecords.put(rec);

            // Upsert into the in-memory mirror. `.map()` alone could only
            // PATCH rows that already existed, so a device sold without a prior
            // registry row was written to Dexie but never appeared in
            // `imeiRecords` — its warranty silently reverted to "not sold"
            // until the next boot refresh read Dexie back, then re-applied.
            const siKey = normalizeDeviceKey(si.imei);
            const idx = nextImeiRecords.findIndex((r) => normalizeDeviceKey(r.imei) === siKey);
            if (idx >= 0) {
              nextImeiRecords = nextImeiRecords.map((r, i) => (i === idx ? rec : r));
            } else {
              nextImeiRecords = [rec, ...nextImeiRecords];
            }
          }
        } catch (e) {
          console.warn('[completeSale] Failed to update imeiRecords in Dexie:', e);
        }
      }

      // State Update on Success
      // F2: all durable side-effects above settled — the recovery intent for
      // this sale is no longer needed. (Voucher/cash-out failures warn loudly
      // but don't block the clear: replay covers order/customer/debt/IMEI,
      // and re-running a captured voucher or disbursed cash-out is unsafe.)
      await clearCheckoutRecoveryIntent(transactionId).catch(() => {});
      // Double-sale guard: a retry-after-failure parks a second intent under
      // a NEW transactionId for the same cart. The cart just committed once,
      // so same-cart siblings are retries — clear them or boot replay mints
      // a second sale. Exact fingerprint only (edited carts keep theirs).
      try {
        await clearSiblingRecoveryIntents(
          cartFingerprintOfPayload(checkoutPayload, updatedCustomer?.id ?? null),
          transactionId
        );
      } catch {
        // Best-effort — the sale itself is durable.
      }
      set({
        products: updatedProducts,
        transactions: newTransactions,
        customers: updatedCustomers,
        currentCustomer: updatedCustomer,
        customerDebts: newCustomerDebts,
        imeiRecords: nextImeiRecords,
        cart: [],
        cashTendered: 0,
        storeCreditApplied: 0,
        // Exchange staging is single-use: the intake committed atomically
        // with this sale, so the slot + soulte choice reset here.
        stagedTradeIn: null,
        exchangeSoultePayout: null,
        // REF-87: the checkout commits late on a huge sale (~30-40 s of
        // post-commit work). Closing the modal unconditionally then tore down a
        // REFUND dialog the operator had already opened, and the refund never
        // submitted. Only the checkout's own modal is closed here.
        activeModal: get().activeModal === 'payment' ? null : get().activeModal,
        lastTransaction: transaction,
        hardwareStatus: { ...get().hardwareStatus, cashDrawerOpen: true },
      });
      // Clear the staged voucher credit with the sale (runtime-only keys).
      (set as unknown as (p: Record<string, unknown>) => void)({
        voucherCreditApplied: 0,
        voucherCode: null,
      });

      // SAV settlement: any SAV-<ticket> service line commits delivery.
      // Idempotent — updateRepairOrderStatus no-ops visually if already Livré,
      // and the sidecar is purged so replays never double-deliver.
      try {
        const savLines = frozenCartItems.filter(
          (ci) =>
            ci.product?.sku?.startsWith('SAV-') ||
            ci.product?.id?.startsWith('repair-balance-')
        );
        if (savLines.length > 0) {
          const { repairIdForCartItem, unlinkSavCartItems } = await import('../../utils/savSettlement');
          const { REPAIR_DELIVERED_EVENT } = await import('./createRepairSlice');
          const seen = new Set<string>();
          const deliveredIds: string[] = [];
          const deliveredTickets: string[] = [];
          // Session tender per repair (paidToday plumbing): the net amount
          // this checkout collected on each SAV line, so the restitution slip
          // can print "Net payé ce jour" + SOLDE RÉGLÉ truthfully instead of
          // defaulting to Case A. Pure derivation from the frozen cart —
          // no new money math, same line-net convention as totals.
          const settledAmounts: Record<string, number> = {};
          for (const line of savLines) {
            const repairId =
              repairIdForCartItem(line.product.id) ??
              (line.product.id.startsWith('repair-balance-')
                ? line.product.id.replace(/^repair-balance-/, '')
                : null);
            if (!repairId || seen.has(repairId)) continue;
            seen.add(repairId);
            try {
              const target = get().repairOrders.find((r) => r.id === repairId);
              await get().updateRepairOrderStatus(repairId, 'Livré');
              deliveredIds.push(repairId);
              if (target?.ticketNumber) deliveredTickets.push(target.ticketNumber);
              const unit = Number(line.appliedPrice ?? line.product?.price ?? 0);
              const qty = Math.abs(Number(line.quantity ?? 1));
              settledAmounts[repairId] = Math.max(
                0,
                Math.round(unit * qty - Math.max(0, Number(line.discount ?? 0)))
              );
            } catch (e) {
              console.warn('[checkout] SAV auto-delivery failed:', e);
            }
          }
          unlinkSavCartItems(savLines.map((l) => l.product.id));
          // Delivery handshake: UI offers [Imprimer Bon de Restitution].
          if (deliveredIds.length > 0 && typeof window !== 'undefined') {
            // Key session tenders by TICKET (not loop index — tickets are
            // pushed conditionally, so indices can misalign).
            const settledByTicket: Record<string, number> = {};
            for (const rid of deliveredIds) {
              const t = get().repairOrders.find((r) => r.id === rid)?.ticketNumber;
              const amount = settledAmounts[rid];
              if (t && Number.isFinite(amount)) settledByTicket[t] = Math.max(0, Math.round(amount));
            }
            window.dispatchEvent(
              new CustomEvent(REPAIR_DELIVERED_EVENT, {
                detail: {
                  repairIds: deliveredIds,
                  ticketNumbers: deliveredTickets,
                  receiptNumber: transaction.receiptNumber,
                  settledAmounts,
                  settledByTicket,
                },
              })
            );
          }
        }
      } catch (e) {
        console.warn('[checkout] SAV settlement hook skipped:', e);
      }

      // Audio Feedback
      audioBus.emit('success');
      audioBus.emit('cashDrawer');

      // Direct Silent Hardware Printing
      const settings = get().receiptSettings;
      if (settings?.autoPrintEnabled !== false) {
          void printReceipt(transaction, settings);
      }

      return { success: true, warnings };
    } finally {
      releaseCheckoutFlight('processPayment');
    }
  },

  quickCashPayment: async () => {
    const { cart, pricingTier, storeCreditApplied, processPayment } = get();

    // Same canonical math as processPayment (signed return quantities plus
    // store/voucher credits and VAT): the single tender covers exactly the
    // net due, so change stays zero without hiding a refund.
    const { voucherCreditApplied } = readVoucherStaging(get());
    // Carry staged wallet credit AND staged trade-in as explicit tender legs
    // (mirrors PaymentModal): without them the staging-drop guards abort,
    // and without the guards the credits would silently vanish.
    const tradeInLegAmount = Math.max(0, Math.round(Number(get().stagedTradeIn?.buybackValue) || 0));
    const tradeInLeg =
      tradeInLegAmount > 0 ? [{ method: 'Reprise' as const, amount: tradeInLegAmount }] : [];
    const totalsWithTrade = computeCartTotals(cart, {
      pricingTier,
      storeCreditApplied,
      voucherCreditApplied,
      tradeInCredit: tradeInLegAmount,
    });
    const avoirLeg =
      Math.max(0, Math.round(Number(storeCreditApplied) || 0)) > 0
        ? [{ method: 'Avoir Client' as const, amount: Math.max(0, Math.round(Number(storeCreditApplied) || 0)) }]
        : [];
    return await processPayment(
      [{ method: 'Espèces', amount: totalsWithTrade.total }, ...avoirLeg, ...tradeInLeg]
    );
  },

  voidTransaction: async (transactionId, reason, cashierName) => {
    const { transactions, products, customers, logSecurityAction } = get();
    const txn = transactions.find((t) => t.id === transactionId);
    if (!txn) {
      return { success: false, reason: 'TRANSACTION_NOT_FOUND' };
    }
    if (txn.status === 'VOIDED') {
      return { success: false, reason: 'ALREADY_VOIDED' };
    }
    // Cross-operation guard: voiding a refunded ticket would re-restore the
    // refunded leg (stock, loyalty, batches) while the refund payout stays
    // booked. Refunded tickets can only move via further per-leg refunds.
    if (txn.status === 'REFUNDED' || txn.status === 'PARTIALLY_REFUNDED') {
      return { success: false, reason: 'TICKET_REFUNDED' };
    }
    // Chaos S5: void means "never happened" — a lie once a physical device
    // changed hands. The intake leg (TRADE batch/product) is not part of
    // txn.items so a void would leave the shop holding the traded-in device
    // while silently keeping the customer's cash leg unreversed. Force the
    // refund path, which restores the trade value to the wallet with an
    // audit trail. No silent evaporation, no free-money cash.
    if (txn.tradeInId) {
      get().logSecurityAction(
        'Annulation Refusée — Ticket Échange',
        `Ticket #${txn.receiptNumber} lié à la reprise ${txn.tradeInId} : annulation directe interdite, passer par un remboursement.`,
        cashierName || 'Manager',
        false
      );
      return { success: false, reason: 'VOID_EXCHANGE_USE_REFUND' };
    }

    // Online compensation claim (ad.md §10): when reachable, claim the void
    // BEFORE restoring stock/loyalty. A peer till voiding the same ticket
    // holds the same deterministic claim id — the loser aborts here instead
    // of double-restoring. Offline proceeds (deterministic ids converge).
    try {
      const { tryClaimCompensation } = await import('../../sync/claims');
      const claim = await tryClaimCompensation('VOID', deterministicId('CLAIM-VOID', transactionId), transactionId);
      if (!claim.claimed && claim.reason === 'HELD_BY_PEER') {
        return { success: false, reason: 'VOID_ALREADY_IN_PROGRESS' };
      }
    } catch (claimErr) {
      console.warn('[void:claim] claim skipped, proceeding offline-first:', claimErr);
    }

    // 1. Restore Product inventory (+qty for sold items). Services carry no
    // stock identity (checkout never depletes them) — restocking them would
    // collapse their 999999 standby stock to a small counted sum.
    const soldQtyMap = new Map<string, number>();
    for (const item of txn.items) {
      if (isUnstockedProduct(item.product.id, products)) continue;
      soldQtyMap.set(item.product.id, (soldQtyMap.get(item.product.id) || 0) + item.quantity);
    }
    const restoredProducts: Product[] = [];
    const updatedProducts = products.map((p) => {
      const soldQty = soldQtyMap.get(p.id);
      if (soldQty !== undefined) {
        const restored = { ...p, stock: p.stock + soldQty };
        restoredProducts.push(restored);
        return restored;
      }
      return p;
    });

    // 2. Gather Serialized IMEIs to release
    const restoredImeis = txn.items
      .map((item) => item.imeiNumber?.trim())
      .filter((imei): imei is string => Boolean(imei && imei.length > 0));

    // 3. Customer loyalty & store credit rollback
    let updatedCustomer: Customer | undefined = undefined;
    let updatedCustomers = customers;
    // Case 41: what the void must persist natively (SQLite is the authority).
    let voidMirrorLedger: LoyaltyLedgerEntry[] = [];
    let voidCustomerMoney: { creditDeltaDzd?: number; debtDeltaDzd?: number } = {};
    const txnCustomer = txn.customer;
    if (txnCustomer) {
      const cust = customers.find((c) => c.id === txnCustomer.id) || txnCustomer;
      const currentTotalSpent = cust.totalSpent || 0;
      // Reverse exactly what the sale added: sales credit remainingToPay
      // (net of credit-debt), so voiding must deduct net of the debt leg —
      // the debt itself is reversed separately below. Deducting the full
      // total double-reversed the debt portion (and could revoke milestones
      // earned by other sales).
      const voidCreditDebt = txn.tenders
        ? txn.tenders.filter((t) => t.method === 'Crédit Client').reduce((acc, t) => acc + t.amount, 0)
        : txn.paymentMethod === 'Crédit Client'
        ? txn.total
        : 0;
      const loyaltyCfg = normalizeLoyaltyConfig(get().receiptSettings?.loyaltyConfig);
      // Symmetric net-paid reversal: the sale advanced totalSpent by its
      // net-paid basis (net of credit-debt AND Avoir redemption), so the
      // void deducts exactly that basis — never the gross total.
      const voidPaidBasis = Math.max(0, txn.total - voidCreditDebt - getTxnStoreCreditApplied(txn));
      const newTotalSpent = Math.max(0, currentTotalSpent - voidPaidBasis);
      const newTier = calculateCustomerTier(newTotalSpent, loyaltyCfg);

      const earnedPoints = Math.max(0, Math.floor(computeVoidDeduction(txn, loyaltyCfg).pointsToDeduct));
      // Exact-inverse bucket reversal: drop the earn bucket this sale minted
      // and pay back the FIFO depletion its store-credit redemption caused.
      const { updatedBuckets: voidBuckets, restoredPoints } = restoreBucketsForVoid(
        cust.pointBuckets || [],
        txn
      );
      const newPoints = Math.max(0, (cust.loyaltyPoints || 0) - earnedPoints + restoredPoints);

      const storeCreditPaid = txn.tenders
        ? txn.tenders.filter((t) => t.method === 'Avoir Client').reduce((acc, t) => acc + t.amount, 0)
        : txn.paymentMethod === 'Avoir Client'
        ? txn.total
        : 0;
      // Structured milestone clawback from the txn's immutable snapshots.
      // Deliberately unclamped: if the customer already spent the awarded
      // credit, the balance dips negative to prevent return-loop gaming.
      // Future refunds/credit refill the negative before paying out.
      const claw = computeMilestoneClawback(
        cust.id,
        currentTotalSpent,
        newTotalSpent,
        loyaltyCfg,
        { txnId: txn.id, awards: txn.milestoneAwards, ledger: cust.ledger || [] },
        newPoints
      );
      const newCredit = (cust.storeCredit || 0) + storeCreditPaid - claw.totalRevoked;

      const creditDebtAmount = voidCreditDebt;
      const newDebt = Math.max(0, (cust.currentDebt || 0) - creditDebtAmount);

      if (creditDebtAmount > 0) {
        const voidDebtEntry: CustomerDebtEntry = {
          // Deterministic: two devices voiding the same ticket derive the same
          // debt-reversal id, so the records converge instead of doubling.
          id: deterministicId('DEBT-VOID', transactionId, cust.id, Math.round(creditDebtAmount)),
          customerId: cust.id,
          customerName: cust.name,
          type: 'PAYMENT_SETTLED',
          kind: 'CORRECTION',
          amount: creditDebtAmount,
          balanceAfter: newDebt,
          receiptNumber: txn.receiptNumber,
          paymentMethod: 'Crédit Client',
          notes: `Annulation Vente à Crédit #${txn.receiptNumber} (${reason}) - Créance annulée`,
          createdAt: new Date().toISOString(),
          recordedBy: cashierName || 'Manager',
        };
        try {
          await (await getSqlite()).saveCustomerDebt(voidDebtEntry);
          set({ customerDebts: [voidDebtEntry, ...get().customerDebts] });
        } catch (err) {
          console.error('Failed to save void debt entry:', err);
        }
      }

      // Ledger-derived balance coverage: the restored Avoir is a credit
      // movement (+storeCreditPaid) and rides on this entry's delta so the
      // derived balance stays exact. Points and credit share one row here
      // (as before) — only the delta metadata is new.
      const ledgerEntry = createLedgerEntry(
        cust.id,
        'adjustment',
        -earnedPoints,
        newPoints,
        `Annulation Ticket #${txn.receiptNumber} (${reason}) - Points & Crédit restaurés`,
        txn.id,
        storeCreditPaid
      );

      const existingLedger = cust.ledger || [];
      const voidLedgerEntries = [ledgerEntry, ...claw.entries];
      updatedCustomer = {
        ...cust,
        currentDebt: newDebt,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        pointBuckets: voidBuckets,
        ledger: [...voidLedgerEntries, ...existingLedger],
      };

      voidMirrorLedger = voidLedgerEntries;
      // Money deltas, not absolutes: a concurrent wallet movement survives.
      voidCustomerMoney = {
        creditDeltaDzd: storeCreditPaid - claw.totalRevoked,
        debtDeltaDzd: -creditDebtAmount,
      };
      const finalCustomer = updatedCustomer;
      updatedCustomers = customers.map((c) => (c.id === finalCustomer.id ? finalCustomer : c));
    }

    const voidedTxn: SaleTransaction = {
      ...txn,
      status: 'VOIDED',
      voidReason: reason,
      voidedAt: new Date().toISOString(),
      voidedBy: cashierName || 'Manager',
    };

    // Status flip keeps the row's chronological slot (same createdAt keys —
    // the stable canonical sort preserves its position while healing any
    // legacy disorder around it).
    const updatedTransactions = sortedTransactions(transactions.map((t) => (t.id === transactionId ? voidedTxn : t)));

    const auditEntry: SecurityAuditLogEntry = {
      id: newId('AUDIT'),
      timestamp: new Date().toISOString(),
      user: cashierName || 'Manager',
      action: 'Annulation Vente (Erreur de Caisse)',
      details: `Ticket #${txn.receiptNumber} (${txn.total} DA) annulé. Motif: ${reason}`,
      requiresPin: true,
    };

    try {
      await (await getSqlite()).voidTransactionAtomic(
        transactionId,
        voidedTxn,
        restoredProducts,
        updatedCustomer,
        restoredImeis,
        auditEntry,
        {
          ledgerEntries: voidMirrorLedger,
          creditDeltaDzd: voidCustomerMoney.creditDeltaDzd,
          debtDeltaDzd: voidCustomerMoney.debtDeltaDzd,
        }
      );
    } catch (err) {
      // Idempotency signals from the atomic lane surface with their own
      // reasons — a duplicate void is not a persistence failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'ALREADY_VOIDED') return { success: false, reason: 'ALREADY_VOIDED' };
      if (msg === 'ALREADY_PROCESSING') return { success: false, reason: 'ALREADY_PROCESSING' };
      if (msg === 'REFUNDED_TICKET') return { success: false, reason: 'TICKET_REFUNDED' };
      console.error('Failed to atomically void transaction:', err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }

    try {
      const { appendInventoryDeltas, enqueueOrderSync } = await import('../../db/sqlPluginAdapter');
      // REF-13: RESTORE FIRST. The atomic void above already flipped the durable
      // status, so enqueueOrderSync's duplicate-void guard refuses this, the
      // FIRST void, with ALREADY_VOIDED; when that refusal aborted the handler the
      // VOID ledger delta never landed and the voided unit stayed missing from
      // stock (status VOIDED + toast "deja annulee", drawer one unit short).
      // Deterministic LED-VOID ids keep a replayed void convergent.

        // Deterministic delta ids: a void replayed (or raced) from a second
        // device converges via ON CONFLICT DO NOTHING instead of double-restoring.
        // Services carry no stock identity (never depleted at sale) — no delta.
        await appendInventoryDeltas(
        txn.items.filter((i) => !isUnstockedProduct(i.product.id, products)).map((i) => ({
          id: deterministicId('LED-VOID', transactionId, i.product.id, i.quantity),
          idempotencyKey: deterministicId('LED-VOID', transactionId, i.product.id, i.quantity),
          productId: i.product.id,
          delta: i.quantity,
          reason: 'VOID' as const,
          refType: 'order',
          refId: transactionId,
        }))
      );
      // FIFO batch restitution for the void: the ledger delta above restores
      // the SQLite stock SUM, but without this the depleted batches stay
      // empty — voided units would silently lose their batch identity and the
      // NEXT sale would shadow them at the latest cost instead of consuming
      // the returned batches (same leak class as the 500/400 bug). Restore
      // every allocation the original depletion recorded (exact reversal);
      // lines without recorded allocations re-enter via the REFUND-batch
      // fallback at their historical line cost. Duplicate voids cannot reach
      // here: the atomic lane above throws ALREADY_VOIDED before this block.
      try {
        const { restituteStockBatches } = await import('../../db/sqlPluginAdapter');
        const voidRestitution: Array<{ batchId?: string; productId: string; quantity: number; unitCost: number }> = [];
        for (const line of txn.items ?? []) {
          const pid = line.product?.id;
          if (!pid) continue;
          // Services were never depleted — restituting them would mint real
          // batches for phantom SKUs and collapse standby stock.
          if (isUnstockedProduct(pid, products)) continue;
          const qty = Math.abs(Number(line.quantity ?? 0));
          if (qty <= 0) continue;
          const allocs = (line as { fifoAllocations?: Array<{ batchId?: string; quantity?: number; unitCost?: number }> }).fifoAllocations ?? [];
          if (allocs.length > 0) {
            for (const a of allocs) {
              voidRestitution.push({
                batchId: a.batchId,
                productId: pid,
                quantity: Math.abs(Number(a.quantity ?? 0)),
                unitCost: Number(a.unitCost ?? 0),
              });
            }
          } else {
            voidRestitution.push({
              batchId: undefined,
              productId: pid,
              quantity: qty,
              unitCost: Number(line.unitCostAtSale ?? line.unitCostPrice ?? line.product?.costPrice ?? 0),
            });
          }
        }
        if (voidRestitution.length > 0) {
          await restituteStockBatches(voidRestitution, { batchKeySeed: `void-${transactionId}` }).catch((err) => {
            console.warn('[void:batches] Batch restitution error:', err);
          });
        }
      } catch (restErr) {
        console.warn('[void:batches] Batch restitution skipped:', restErr);
      }
      // REF-13: the durable status is already VOIDED (voidTransactionAtomic
      // above), so the duplicate-void guard answers ALREADY_VOIDED to this, the
      // FIRST void. That refusal must not fail the void; the outbox payload gap
      // is tracked separately (docs/c01-ref13-void.md). A real duplicate never
      // reaches here - the atomic lane throws ALREADY_VOIDED first.
      try {
      await enqueueOrderSync(transactionId, {
        ...voidedTxn,
        receipt_number: voidedTxn.receiptNumber,
        created_at: voidedTxn.createdAt,
      } as unknown as Record<string, unknown>);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== 'ALREADY_VOIDED') throw e;
        console.warn('[void] outbox push refused: durable status already VOIDED (sync gap, docs/c01-ref13-void.md)');
      }
      const { syncManager } = await import('../../sync/SyncManager');
      syncManager.notifyLocalWrite();
    } catch (e) {
      // The void is already durable here; a ledger/sync hiccup must be loud but
      // must not report the operator's successful void as a duplicate.
      console.warn('Void ledger write skipped:', e);
    }

    // Machine-readable payout tag for the both-offline convergence detector
    // (payoutWatch): which ticket, what method/amount, which device paid out.
    // Non-cash methods are tagged too but never flagged (idempotent by design).
    let voidPayoutTag = '';
    try {
      const { getStableDeviceId } = await import('../../sync/device');
      const { payoutTag } = await import('../../sync/payoutWatch');
      const devId = await getStableDeviceId().catch(() => 'default');
      const voidCash = (txn.tenders ?? []).filter((t) => t.method === 'Espèces').reduce((a, t) => a + t.amount, 0);
      const voidMethod = voidCash > 0 || txn.paymentMethod === 'Espèces' ? 'Espèces' : String(txn.paymentMethod || 'Espèces');
      voidPayoutTag = ` ${payoutTag(`VOID:${transactionId}`, voidMethod, Math.round(txn.total), devId)}`;
    } catch {
      // Tag best-effort — the void itself must never fail over a marker.
    }
    // Voucher credit-back: voiding a voucher-paid sale must restore the
    // bearer value — otherwise the customer loses prepaid money with no
    // ledger entry. Best-effort AFTER the void is durable (mirrors the
    // capture-failure pattern): failure warns loudly + audits, never rolls
    // the void back.
    let voucherRestoreNote = '';
    const voidVoucherCode = txn.voucherCode;
    const voidVoucherAmount = Math.max(0, Math.round(Number(txn.voucherCreditApplied ?? 0)));
    if (voidVoucherCode && voidVoucherAmount > 0) {
      try {
        const { voucherAdapter } = await import('../../db/adapters/voucherAdapter');
        const restored = await voucherAdapter.creditBack(voidVoucherCode, voidVoucherAmount);
        if (restored.success) {
          voucherRestoreNote = ` Bon ${voidVoucherCode} recrédité (+${restored.restored} DA).`;
        } else {
          const msg = `Bon ${voidVoucherCode} : restauration échouée (${restored.reason}) — réémission manuelle requise.`;
          console.error(`[void:voucher] ${msg}`);
          voucherRestoreNote = ` ${msg}`;
        }
      } catch (e) {
        const msg = `Bon ${voidVoucherCode} : restauration impossible (${e instanceof Error ? e.message : String(e)}) — réémission manuelle requise.`;
        console.error(`[void:voucher] ${msg}`);
        voucherRestoreNote = ` ${msg}`;
      }
    }
    logSecurityAction(
      'Annulation Vente (Erreur)',
      `Ticket #${txn.receiptNumber} (${txn.total} DA) annulé. Motif: ${reason}${voidPayoutTag}${voucherRestoreNote}`,
      cashierName || 'Manager',
      true
    );
    // Convergence check: a peer till may already have paid this ticket out
    // while both were offline — surface it loudly instead of silently.
    try {
      const { checkDuplicatePayouts } = await import('../../sync/payoutWatch');
      const dups = await checkDuplicatePayouts();
      for (const d of dups) {
        console.warn(`[void] DOUBLE PAIEMENT suspecté sur ${d.payoutId} (${d.amount} DA, ${d.devices.length} appareils)`);
      }
    } catch {
      // Detector best-effort only.
    }

    audioBus.emit('success');

    const releasedImeiKeys = new Set(restoredImeis.map(normalizeDeviceKey));
    const nextImeiRecords = (get().imeiRecords || []).map((r) =>
      releasedImeiKeys.has(normalizeDeviceKey(r.imei))
        // `warrantyExpiresAt` is deliberately PRESERVED. Clearing it was rejected:
        // the anchor is the record of what the refunded customer was promised, and
        // it is needed for reprints, audits and disputes. The reader already
        // scopes to the latest sale and ignores a stale anchor when
        // `saleTransactionId` does not match, and the writer re-anchors on a
        // genuine resale, so clearing was redundant as well as destructive.
        // Worse, on a PARTIAL refund (one unit of a multi-item order) a bug here
        // could wipe a different unit's warranty.
        ? { ...r, saleTransactionId: undefined, soldAt: undefined }
        : r
    );

    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      imeiRecords: nextImeiRecords,
      lastTransaction: voidedTxn,
    });

    // Convergence: a voided credit sale reverses debt — re-derive the display
    // from the ledger (same derivation the peer runs on pull).
    if (updatedCustomer) {
      try {
        const { reconcileCustomerDebtFromLedger } = await import('../../db/sqlPluginAdapter');
        await reconcileCustomerDebtFromLedger([updatedCustomer.id]);
      } catch {
        // Display already updated; reconcile is hardening.
      }
    }

    return { success: true };
  },

  processRefund: async (payload) => {
    const { originalTransaction, refundItems, refundMethod, refundReason, cashierName } = payload;
    const supervisorPinVerifiedAt = (payload as { supervisorPinVerifiedAt?: string }).supervisorPinVerifiedAt;
    const supervisorUserId = (payload as { supervisorUserId?: string }).supervisorUserId;
    const { transactions, products, customers, logSecurityAction } = get();

    if (refundItems.length === 0) {
      return { success: false, reason: 'NO_ITEMS_SELECTED' };
    }

    // Cross-operation guard (live state): refunding a voided ticket would
    // pay out on a cancelled sale — the void already restored stock and
    // reversed loyalty. Read the live row, not the possibly-stale payload.
    const liveOriginal =
      transactions.find((t) => t.id === originalTransaction.id) ?? originalTransaction;
    if (liveOriginal.status === 'VOIDED') {
      return { success: false, reason: 'ORIGINAL_VOIDED' };
    }

    // P0 (owner ruling, fail closed): an Avoir Client refund must have a
    // recipient. On an anonymous ticket there is no wallet to credit, so the
    // value would be booked as refunded and reach nobody (REF-87: 4e9
    // COMPLETED as Avoir Client with 0 cash, 0 voucher, 0 wallet, 0 parked).
    // This runs BEFORE any write, so a refusal leaves no refund row, no
    // restock and no dedup hash - the leg is part of the refund transaction
    // and is never silently skipped.
    if (avoirRecipientRefusal({ method: refundMethod, hasCustomer: Boolean(String(originalTransaction.customer?.id ?? '').trim()), avoirShare: 0 })) {
      return { success: false, reason: 'AVOIR_RECIPIENT_REQUIRED' };
    }

    // Fix 4: every refund anchors to an accounting period. Without an open
    // shift the refund would land in the original (possibly CERTIFIED) shift
    // and rewrite its books — fail closed instead.
    const refundShiftGate = get().activeShift;
    if (!refundShiftGate || !refundShiftGate.id) {
      return { success: false, reason: 'NO_OPEN_SHIFT' };
    }

    // Fix 1: zero-value/exhausted tickets never reach the write path. Same
    // money-truth basis as the modal list filter (refundableValueOf) — the
    // list can never offer what submit refuses.
    if (refundableValueOf(liveOriginal, transactions) <= 0) {
      return { success: false, reason: 'ZERO_REFUNDABLE' };
    }

    // Fix 3: offline inputs for the fail-closed verdict (enforced at claim
    // time below). Probe + device identity are resolved once, up front.
    let refundOnline = false;
    try {
      const { probeOnline } = await import('../../sync/tursoClient');
      refundOnline = await probeOnline(2500);
    } catch {
      refundOnline = false;
    }
    let refundLocalDevice = '';
    try {
      const { getStableDeviceId } = await import('../../sync/device');
      refundLocalDevice = await getStableDeviceId().catch(() => '');
    } catch {
      refundLocalDevice = '';
    }

    // Physical returns kept out of stock (rebut/defective) move value off the
    // books with no compensating entry — they must carry a reason note.
    const hasNonRestocked = refundItems.some((i) => !i.restock);
    if (hasNonRestocked) {
      const reasonTrim = String(refundReason ?? '').trim();
      // REF-36: "Autre" is a category, not a motive. A write-off must carry an
      // operator-authored note; the bare placeholder value (or its option label)
      // must not satisfy the gate, or a rebut lands with no quarantine note.
      const categoryOnly = /^Autre( motif personnalis\S*)?$/i.test(reasonTrim);
      if (!reasonTrim || categoryOnly) {
        return { success: false, reason: 'RESTOCK_REASON_REQUIRED' };
      }
    }

      // Over-refund guard. The modal seeds quantities from the ORIGINAL purchased
      // quantities and admits PARTIALLY_REFUNDED tickets, so without this bound a
      // ticket of qty 2 could be refunded 1 unit, then reopened and refunded 2
      // units again — 3 units refunded against 2 purchased: duplicate cash/credit
      // payout, duplicate loyalty deduction, duplicate stock restock.
      // Sources UNIONED (dedupe by refund txn id): Zustand (local session) +
      // Dexie (pulled peer refunds — pull reconstructs Dexie, not the store, so
      // a store-only read misses a second till's refund of the same ticket).
      const alreadyRefunded = new Map<string, number>();
      const seenRefundIds = new Set<string>();
      const accumulateRefunded = (t: { id?: string; isRefund?: boolean; originalTransactionId?: string; refundedItems?: Array<{ productId: string; quantity: number }> }) => {
        if (!t.isRefund || t.originalTransactionId !== originalTransaction.id) return;
        if (t.id && seenRefundIds.has(t.id)) return;
        if (t.id) seenRefundIds.add(t.id);
        for (const ri of t.refundedItems || []) {
          alreadyRefunded.set(ri.productId, (alreadyRefunded.get(ri.productId) || 0) + ri.quantity);
        }
      };
      for (const t of transactions) accumulateRefunded(t);
      try {
        const { db: dexieDb } = await import('../../db/database');
        const dexieRefunds = await dexieDb.transactions
          .filter((t) => Boolean(t.isRefund) && t.originalTransactionId === originalTransaction.id)
          .toArray()
          .catch(() => []);
        for (const t of dexieRefunds || []) accumulateRefunded(t);
      } catch {
        // Dexie unavailable — Zustand coverage above still applies.
      }
      for (const ri of refundItems) {
        const purchased = (originalTransaction.items || [])
          .filter((i) => i.product?.id === ri.productId)
          .reduce((acc, i) => acc + i.quantity, 0);
        const remaining = purchased - (alreadyRefunded.get(ri.productId) || 0);
        if (ri.quantity > remaining) {
          return { success: false, reason: 'REFUND_EXCEEDS_PURCHASED' };
        }
      }

    // Integer DZD at the money boundary: per-line discount splits can leave
    // float dust (e.g. 1000/3) that would otherwise persist into stored rows.
    const refundTotal = Math.round(refundItems.reduce((acc, i) => acc + i.totalRefundAmount, 0));

    // Funding-split (anti-arbitrage C1/C2/C3 + discount over-refund): the
    // gross line value must be converted to the NET value the customer
    // actually gave for those items, then each funding source reversed to
    // its origin — voucher→voucher, avoir→wallet, debt→debt relief — with
    // only the cash-funded share disbursable as cash. Paying gross cash
    // minted the voucher/avoir/debt amount as free money.
    // Prior refund totals now include the trade value they restored, so the
    // cumulative funding cap must subtract it back to stay on the funding
    // basis (`recoverableBase` never contains the trade leg).
    const priorRecovery = (transactions || [])
      .filter((t) => t.isRefund && t.originalTransactionId === originalTransaction.id)
      .reduce(
        (acc, t) =>
          acc +
          Math.max(
            0,
            (Number(t.total) || 0) - (Number((t as { tradeInRestored?: number }).tradeInRestored) || 0),
          ),
        0,
      );
    // C01/D2: the lanes returned by EARLIER refunds of this ticket, read from
    // their durable JSON payload (`funding`); legacy rows derive from columns.
    // They make the split cumulative so partial refunds conserve to the dinar.
    const priorLanes: RefundLaneTotals = (transactions || [])
      .filter((t) => t.isRefund && t.originalTransactionId === originalTransaction.id)
      .reduce<RefundLaneTotals>(
        (acc, t) => {
          const l = refundLaneTotalsOf(t as unknown as Record<string, unknown>);
          acc.cash += l.cash;
          acc.avoir += l.avoir;
          acc.voucher += l.voucher;
          acc.debt += l.debt;
          acc.digital += l.digital;
          acc.gross = (acc.gross ?? 0) + (l.gross ?? 0);
          if (l.basis === 'legacy') acc.basis = 'legacy';
          return acc;
        },
        { cash: 0, avoir: 0, voucher: 0, debt: 0, digital: 0, gross: 0, basis: 'explicit', anomalies: [] }
      );
    const funding = computeRefundFundingSplit(originalTransaction, refundTotal, priorRecovery, priorLanes);
    // P0 (owner ruling): the same recipient rule for the FUNDING avoir lane - a
    // ticket that was paid with store credit refunds back into a wallet, so an
    // anonymous ticket has nowhere to put it. Refuse before any write.
    if (avoirRecipientRefusal({ method: refundMethod, hasCustomer: Boolean(String(originalTransaction.customer?.id ?? '').trim()), avoirShare: funding.avoirShare })) {
      return { success: false, reason: 'AVOIR_RECIPIENT_REQUIRED' };
    }
    const netRefund = funding.netRefund;
    // Fix 2: strict tender clamp (anti cash-extraction). Cumulative drawer
    // cash out can never exceed the net physical cash tendered on the original
    // ticket. Prior payouts union store + Dexie (pulled peer refunds) — the
    // same coverage as the over-refund guard above. Excess locks to Avoir.
    const clampWarnings: string[] = [];
    let priorCashOut = 0;
    let shiftCashOut = 0;
    try {
      const { db: dexieCashDb } = await import('../../db/database');
      const dexieCashRefunds = await dexieCashDb.transactions
        .filter((t) => Boolean(t.isRefund) && t.originalTransactionId === originalTransaction.id)
        .toArray()
        .catch(() => []);
      // Offline shift bucket basis (Module B pre-check): same union, drawer
      // cash disbursed by refunds of the CURRENT shift (any ticket).
      for (const t of transactions) {
        if (t.isRefund && t.originalTransactionId === originalTransaction.id) priorCashOut += cashDisbursedOf(t);
        if (t.isRefund && (t.shiftId || '') === (refundShiftGate.id || '')) shiftCashOut += cashDisbursedOf(t);
      }
      const seenCashIds = new Set(transactions.filter((t) => t.isRefund).map((t) => t.id));
      for (const t of dexieCashRefunds || []) {
        if (t.id && seenCashIds.has(t.id)) continue;
        priorCashOut += cashDisbursedOf(t);
        if ((t.shiftId || '') === (refundShiftGate.id || '')) shiftCashOut += cashDisbursedOf(t);
      }
    } catch {
      // Dexie unavailable — store coverage still applies (fail-closed: the
      // adapter re-verifies the cap against durable rows below).
    }
    const cashTenderedNet = physicalCashTendered(originalTransaction);
    const clamped = clampCashRefund({ cashShare: funding.cashShare, cashTenderedNet, priorCashOut });
    let effectiveRefundMethod = refundMethod;
    let walletFromCashOverflow = 0;
    if (refundMethod === 'Espèces' && clamped.avoirOverflow > 0) {
      if (clamped.cashOut === 0) {
        effectiveRefundMethod = 'Avoir Client';
        clampWarnings.push(
          `Plafond espèces ${cashTenderedNet} DA atteint — ${clamped.avoirOverflow} DA reverrouillé en avoir (jamais en espèces).`
        );
        clampWarnings.push('Aucune espèce disponible à reverser — méthode basculée automatiquement en Avoir Client.');
      } else {
        walletFromCashOverflow = clamped.avoirOverflow;
        clampWarnings.push(
          `Plafond espèces ${cashTenderedNet} DA atteint — ${clamped.avoirOverflow} DA reverrouillé en avoir (jamais en espèces).`
        );
      }
    }
    // Cash disbursed through THIS refund by method. Non-cash methods never
    // touch the drawer; avoir value always returns to the wallet (never
    // cashed out), voucher/debt via their own lanes below.
    const cashOut = effectiveRefundMethod === 'Espèces' ? clamped.cashOut : 0;
    // Module B pre-check (best-effort mirror — authoritative enforcement is
    // in-txn): while offline, drawer cash disbursed this shift is bounded.
    // Fail here with the same reason the native gate returns, so the modal
    // can offer the voucher fallback before any row is written.
    if (!refundOnline && effectiveRefundMethod === 'Espèces' && cashOut > 0) {
      try {
        const { readOfflinePolicy } = await import('../../db/adapters/refundNative');
        const shiftCap = await readOfflinePolicy('policy.offline_cash_refund_limit');
        if (shiftCashOut + cashOut > shiftCap) {
          return { success: false, reason: 'OFFLINE_CASH_CAP_EXCEEDED' };
        }
      } catch {
        // Policy read unavailable — the native gate still enforces in-txn.
      }
    }
    // REF-06 / REF-67: an Avoir refund of a card/cheque-funded ticket is the
    // only lane that actually delivers value - the card rail has no destination
    // of record, and its value sits in `digitalShare` (the split's cashShare is
    // 0 for a digital rail). The wallet leg must therefore carry the digital
    // share too, or the native always-balance gate refuses the refund with
    // "legs do not balance" and nothing is delivered.
    const walletAddBase =
      funding.avoirShare +
      walletFromCashOverflow +
      (effectiveRefundMethod === 'Avoir Client' ? funding.cashShare + funding.digitalShare : 0);

    // Chaos S5 — exchange reversal: the funding split caps cash at net paid,
    // so the trade-in value can never leak into cashOut — but without
    // restoration it would evaporate while the shop keeps the device
    // (intake stands; the TRADE batch is never touched by refund/void lanes,
    // which only walk txn.items). Restore pro-rata to the wallet with a
    // cumulative cap across partial refunds (tracked on each refund row).
    const tradeDeduction = Math.max(0, Math.round(Number(originalTransaction.tradeInDeduction) || 0));
    const hasTradeLeg = Boolean(originalTransaction.tradeInId) && tradeDeduction > 0;
    const priorTradeRestored = (transactions || [])
      .filter((t) => t.isRefund && t.originalTransactionId === originalTransaction.id)
      .reduce((acc, t) => acc + Math.max(0, Math.round(Number(t.tradeInRestored) || 0)), 0);
    const tradeRestoreNow = hasTradeLeg
      ? computeTradeRestoreQuota(tradeDeduction, netRefund, originalTransaction.total, priorTradeRestored)
      : 0;
    // Anonymous exchange ticket: no wallet exists to restore the trade value
    // into. The value is NOT minted as cash (funding split caps it) — it is
    // disclosed loudly so a manager regularizes it (policy: no silent
    // evaporation, no free-money cash).
    const tradeValueUnclaimed =
      hasTradeLeg && tradeRestoreNow > 0 && !originalTransaction.customer;

    // Value reversed = funding returned + trade value restored. The customer
    // handed the device's value for this ticket, so a full refund gives it
    // back too — the row's `total` is the value reversed, never the cash
    // share ([MNY-26]: 1300 = 600 cash + 400 wallet + 300 trade). Anonymous
    // tickets cannot receive the trade value, so it is not counted.
    const tradeRestoredValue = tradeValueUnclaimed ? 0 : tradeRestoreNow;
    const valueReversed = netRefund + tradeRestoredValue;

    // Original-line resolver: refund lines carry the ORIGINAL sale line
    // identity (`saleItemId` = `${saleTxnId}-item-${lineIdx}`), so frozen
    // costs and FIFO allocations come from the exact line sold — never a
    // product-level guess (same-SKU lines are distinct money).
    const origLines = originalTransaction.items || [];
    const findOrigLine = (ri: { productId: string; saleItemId?: string }) => {
      if (ri.saleItemId) {
        const m = String(ri.saleItemId).match(/-item-(\d+)$/);
        const idx = m ? Number(m[1]) : -1;
        const byIdx = idx >= 0 ? origLines[idx] : undefined;
        if (byIdx && byIdx.product?.id === ri.productId) return byIdx;
      }
      return origLines.find((i) => i.product?.id === ri.productId);
    };

    const refundQtyMap = new Map<string, number>();
    for (const item of refundItems) {
      // Services carry no stock identity — restocking them collapses their
      // 999999 standby stock (same guard as void).
      if (item.restock && !isUnstockedProduct(item.productId, products)) {
        refundQtyMap.set(item.productId, (refundQtyMap.get(item.productId) || 0) + item.quantity);
      }
    }

    // Recovered COGS: RESTOCKED lines only, at the FROZEN cost captured on
    // the original sale line. The native engine recomputes the same figure
    // from the same columns and stamps it as the refund row's `cost_total` /
    // `restored_cogs` (profit = net − recovered) — never re-derived from
    // live catalog prices. Defective (write-off) units credit NOTHING here;
    // their loss is a separate memo expense (no double subtraction).
    const costRefundTotal = refundItems.reduce((acc, ri) => {
      if ((ri.condition ?? (ri.restock ? 'restock' : 'defective')) !== 'restock') return acc;
      const origLine = findOrigLine(ri);
      const unitCost = Math.max(
        0,
        Math.round(
          origLine?.unitCostAtSale ?? origLine?.unitCostPrice ?? ri.unitCostAtSale
            ?? products.find((p) => p.id === ri.productId)?.costPrice ?? 0
        )
      );
      return acc + unitCost * Math.max(0, Math.round(ri.quantity));
    }, 0);

    const restockedProducts: Product[] = [];
    const updatedProducts = products.map((p) => {
      const restockQty = refundQtyMap.get(p.id);
      if (restockQty !== undefined) {
        const restocked = { ...p, stock: p.stock + restockQty };
        restockedProducts.push(restocked);
        return restocked;
      }
      return p;
    });

    const restoredImeis = refundItems
      .filter((i) => (i.condition ?? (i.restock ? 'restock' : 'defective')) === 'restock')
      .map((i) => i.imeiNumber?.trim())
      .filter((imei): imei is string => Boolean(imei && imei.length > 0));
    // Defective units also leave the sale — but into quarantine: released
    // from the ticket (no longer sellable-as-sold) and marked `defective` on
    // the SQLite row natively. They are NEVER restocked and credit no COGS.
    const defectiveImeis = refundItems
      .filter((i) => (i.condition ?? (i.restock ? 'restock' : 'defective')) === 'defective')
      .map((i) => i.imeiNumber?.trim())
      .filter((imei): imei is string => Boolean(imei && imei.length > 0));

    let updatedCustomer: Customer | undefined = undefined;
    let updatedCustomers = customers;

    // D4-A / review N2: the ledger rows THIS refund created on the TS side.
    // The mirror appends only these (never the historical array, and never the
    // wallet rows the native transaction already emitted).
    let refundMirrorLedger: LoyaltyLedgerEntry[] = [];

    const origCust = originalTransaction.customer;
    // REF-40: a soft-deleted profile must not be resurrected by a refund. The
    // delete removes the customer from `customers` and tombstones SQLite
    // (createCustomerSlice.ts:150-166), while the customer upsert clears
    // `deleted` on every conflict (customerAdapter.ts:129). Reconstructing the
    // profile from the transaction snapshot and saving it here would therefore
    // un-delete it. `origCustLive` gates both the wallet write and the save.
    const origCustLive = !origCust || customers.some((c) => c.id === origCust.id);
    // D4-A: the Avoir leg handed to the native transaction (0 = no wallet leg).
    let walletLegForNative = 0;
    // D4-A review finding 1: the milestone clawback must ride the SAME native
    // transaction as the Avoir leg, or the refund leaves revoked credit behind.
    let walletClawbackForNative = 0;
    if (origCust) {
      const cust = customers.find((c) => c.id === origCust.id) || origCust;
      const currentTotalSpent = cust.totalSpent || 0;
      // Reverse the NET value returned (never the gross — the sale added
      // remainingToPay, i.e. net of credit-debt, and gross includes
      // discounts/credits the customer never paid).
      const loyaltyCfg = normalizeLoyaltyConfig(get().receiptSettings?.loyaltyConfig);
      // D1 + net-spend reversal: voucher and store-credit subsidies return
      // to their own lanes (voucher restore, wallet refill via creditToAdd
      // below) and must never reduce totalSpent. Only the net-paid share
      // reverses progression — the exact mirror of checkout's spendProgress.
      const spendReversal = computeSpendReversal(netRefund, funding.avoirShare, funding.voucherShare);
      const newTotalSpent = Math.max(0, currentTotalSpent - spendReversal);
      const newTier = calculateCustomerTier(newTotalSpent, loyaltyCfg);

      // Symmetric refund deduction: re-weights the refunded lines with the
      // sale's own category multipliers + net-paid ratio (never gross).
      const pointsToDeduct = Math.max(
        0,
        Math.floor(computeRefundDeduction(originalTransaction, refundItems, loyaltyCfg).pointsToDeduct)
      );
      // Shrink the earn bucket minted by the original sale first; only the
      // uncovered residual hits the headline balance (bucket already spent).
      const {
        updatedBuckets: refundBuckets,
        appliedDeduction: bucketDeduction,
        residualHeadlineDeduction,
      } = shrinkEarnBucketForRefund(
        cust.pointBuckets || [],
        originalTransaction.receiptNumber,
        pointsToDeduct
      );
      // The headline IS the spendable balance and must equal Σ buckets: the
      // shrink above already removed `bucketDeduction` from the buckets, so
      // the headline drops by that same total plus the residual. Deducting
      // only the residual left the headline holding points no bucket owned
      // (G-07: headline 8 > Σ buckets 0) — a later redemption would then
      // spend an unbacked discount.
      const newPoints = Math.max(
        0,
        (cust.loyaltyPoints || 0) - (bucketDeduction + residualHeadlineDeduction)
      );
      // Structured milestone clawback from the original sale's immutable
      // snapshots. Unclamped like voids: the wallet refill below offsets
      // any negative before value flows out (refill-before-payout).
      const claw = computeMilestoneClawback(
        cust.id,
        currentTotalSpent,
        newTotalSpent,
        loyaltyCfg,
        { txnId: originalTransaction.id, awards: originalTransaction.milestoneAwards, ledger: cust.ledger || [] },
        newPoints
      );

      const creditToAdd = walletAddBase + tradeRestoreNow;
      walletLegForNative = creditToAdd;
      // REF-40: an archived profile has no usable owner for a wallet credit.
      // Refuse instead of committing a refund whose value lands nowhere (or,
      // worse, resurrects the deleted profile through the upsert).
      if (!origCustLive && creditToAdd > 0) {
        return { success: false, reason: 'CUSTOMER_UNAVAILABLE' };
      }
      const newCredit = (cust.storeCredit || 0) + creditToAdd - claw.totalRevoked;

      const ledgerEntries: LoyaltyLedgerEntry[] = [];
      // D4-A: the Avoir leg's balance update AND its creditDeltaDzd ledger
      // emission are written by `refund_sale_atomic` inside the refund
      // transaction. The TS must not emit a second ledger row for the same
      // money (double credit is the new failure mode) — the native value is
      // mirrored back afterwards.
      if (pointsToDeduct > 0) {
        ledgerEntries.push(
          createLedgerEntry(
            cust.id,
            'adjustment',
            -pointsToDeduct,
            newPoints,
            `Déduction points fidélité (${pointsToDeduct} pts) suite au remboursement Ticket #${originalTransaction.receiptNumber}`,
            originalTransaction.id
          )
        );
      }

      walletClawbackForNative = Math.max(0, Math.round(Number(claw.totalRevoked) || 0));
      // D4-A: when the revocation is routed to the native transaction, THAT
      // transaction emits its own creditDeltaDzd row. Pushing the TS rows as
      // well would record the same clawback twice, and peers re-derive the
      // wallet scalar from the ledger. `clawbackLedgerForMirror` is the single
      // (tested) gate for that decision.
      for (const e of clawbackLedgerForMirror(claw.entries, walletClawbackForNative > 0)) {
        ledgerEntries.push(e);
      }

      const existingLedger = cust.ledger || [];
      updatedCustomer = {
        ...cust,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        pointBuckets: refundBuckets,
        ledger: [...ledgerEntries, ...existingLedger],
      };
      refundMirrorLedger = ledgerEntries;

      const finalCust = updatedCustomer;
      updatedCustomers = customers.map((c) => (c.id === finalCust.id ? finalCust : c));
    }

    // Canonical item order + deterministic refund identity: two devices
    // refunding the SAME items of the SAME ticket via the SAME method derive
    // the SAME refund txn id (and item/ledger ids below), so the second write
    // converges through the ON CONFLICT paths instead of double-paying and
    // double-restocking (cross-device duplicate-refund protection, ad.md §7).
    // A genuinely different partial refund differs in items/quantities and
    // therefore gets a different id.
    const canonicalRefundItems = [...refundItems].sort((a, b) =>
      String(a.productId).localeCompare(String(b.productId)) ||
      a.quantity - b.quantity ||
      (a.unitPrice ?? 0) - (b.unitPrice ?? 0)
    );
    // Normalize the condition flag from the restock toggle so every
    // downstream lane (restitution, write-off, sync payload) reads one
    // source: Condition [Remise en stock | Défectueux / SAV].
    for (const cri of canonicalRefundItems) {
      if (!cri.condition) cri.condition = cri.restock ? 'restock' : 'defective';
    }
    // Line identity participates in the deterministic hash: same ticket,
    // same product, same qty can be a DIFFERENT legitimate refund when it
    // targets distinct sale lines / IMEIs / conditions (e.g. two IMEIs of
    // one SKU). Every component is deterministic ticket data, so two devices
    // refunding the same lines still derive the SAME id — while the old
    // product-only key made a second line refund collide (false
    // ALREADY_REFUNDED) or forced basis hacks (false REFUND_EXCEEDS).
    const canonicalKey = canonicalRefundItems
      .map(
        (i) =>
          `${i.productId}:${i.quantity}:${Math.round(i.unitPrice ?? 0)}:${i.restock ? 1 : 0}:` +
          `${i.saleItemId ?? ''}:${(i.imeiNumber ?? '').trim()}:${i.condition ?? ''}`
      )
      .join(',');
    // MOBI-DEFECT-F: basis-aware deterministic identity. `basis` counts the
    // refunds already committed for this ticket: two tabs with the same stale
    // view derive the SAME id and the loser fails on the native dedup gate,
    // while a deliberate later partial hashes differently and is decided by the
    // quota check. The durable count is authoritative — the in-memory union can
    // miss a just-committed refund (REF-87: the first chunk of a huge ticket was
    // not visible when the second was submitted, so both hashed identically and
    // the legitimate second chunk died as ALREADY_REFUNDED).
    let refundBasis = seenRefundIds.size;
    try {
      const { getLocalDb } = await import('../../db/sqlPluginAdapter');
      const localDb = await getLocalDb();
      const rows = (await localDb.select(
        'SELECT COUNT(*) AS n FROM transactions WHERE original_transaction_id = $1 AND COALESCE(is_refund,0) = 1',
        [originalTransaction.id],
      )) as Array<{ n?: number }>;
      const durableCount = Number(rows?.[0]?.n ?? 0);
      if (Number.isFinite(durableCount)) refundBasis = committedRefundBasis(refundBasis, durableCount);
    } catch {
      // SQLite unavailable (web preview / node tests): the union above applies.
    }
    const {
      itemsHash: refundItemsHash,
      refundId: refundTxnId,
      receiptNumber: refundReceiptNumber,
    } = refundIdentity({
      ticketId: originalTransaction.id,
      canonicalKey,
      method: effectiveRefundMethod,
      netRefund,
      basis: refundBasis,
    });

    // Online compensation claim (ad.md §10): when reachable, claim the
    // deterministic refund id in the cloud BEFORE paying out (90 s TTL —
    // abandoned locks self-sweep). A peer till refunding the same items holds
    // the same claim id — the loser aborts here instead of double-paying.
    // Fix 3: OFFLINE or claim-table trouble no longer proceeds blindly.
    // Offline-first survives ONLY for own-ledger current-shift tickets; a
    // remote or past-shift ticket without a live server claim is denied
    // fail-closed (split-brain double-refund can otherwise not be excluded).
    try {
      const { tryClaimCompensation } = await import('../../sync/claims');
      const { REFUND_CLAIM_TTL_SEC, offlineRefundVerdict } = await import('../../sync/refundLockPolicy');
      const claim = await tryClaimCompensation('REFUND', `CLAIM-${refundTxnId}`, originalTransaction.id, REFUND_CLAIM_TTL_SEC);
      if (!claim.claimed && claim.reason === 'HELD_BY_PEER') {
        return { success: false, reason: 'REFUND_ALREADY_IN_PROGRESS' };
      }
      if (!claim.claimed) {
        const verdict = offlineRefundVerdict(originalTransaction, {
          localDeviceId: refundLocalDevice,
          activeShiftId: refundShiftGate.id,
        });
        if (!verdict.allow) {
          return { success: false, reason: verdict.reason };
        }
      }
    } catch (claimErr) {
      console.warn('[refund:claim] claim skipped, applying offline verdict:', claimErr);
      try {
        const { offlineRefundVerdict } = await import('../../sync/refundLockPolicy');
        const verdict = offlineRefundVerdict(originalTransaction, {
          localDeviceId: refundLocalDevice,
          activeShiftId: refundShiftGate.id,
        });
        if (!verdict.allow) {
          return { success: false, reason: verdict.reason };
        }
      } catch {
        return { success: false, reason: 'OFFLINE_REMOTE_TICKET' };
      }
    }

    // Part 1 seller rule (refunds too): snapshot the live shift opener so the
    // avoir slip prints the drawer-responsible cashier, not a blank fallback.
    // The performing manager stays on the audit entry (user field below).
    // Fix 4: the shift gate above guarantees an open shift — the refund row
    // always anchors to the CURRENT shift (contra-revenue to this period),
    // never to the original (possibly certified) one.
    const refundShift = refundShiftGate;
    const refundShiftOpener =
      (refundShift?.openedBy || '').trim() ||
      (refundShift?.cashierName || '').trim() ||
      undefined;
    const refundTransaction: SaleTransaction = {
      id: refundTxnId,
      receiptNumber: refundReceiptNumber,
      status: 'COMPLETED',
      isRefund: true,
      cashierName: (cashierName || '').trim() || refundShiftOpener || 'Manager',
      shiftId: refundShift.id,
      ...(refundShiftOpener ? { shiftOpenedByName: refundShiftOpener } : {}),
      originalReceiptNumber: originalTransaction.receiptNumber,
      originalTransactionId: originalTransaction.id,
      refundReason,
      refundMethod: effectiveRefundMethod,
      refundedItems: canonicalRefundItems,
      customer: updatedCustomer || originalTransaction.customer,
      items: canonicalRefundItems.map((ri) => {
        const origProd =
          products.find((p) => p.id === ri.productId) ||
          ({
            id: ri.productId,
            title: ri.title,
            sku: ri.sku,
            price: ri.unitPrice,
          } as Product);
        return {
          product: origProd,
          quantity: ri.quantity,
          discount: 0,
          appliedPrice: ri.unitPrice,
          imeiNumber: ri.imeiNumber,
        };
      }),
      subtotal: refundTotal,
      discountTotal: 0,
      // Money truth: the value reversed — funding returned plus any trade
      // value restored (see `valueReversed`). The drawer lane reads
      // cashDisbursed (exact cash out); revenue lanes read total (value
      // reversed). Legacy rows without cashDisbursed keep the old
      // total===cash reading via the cashTerms fallback.
      total: valueReversed,
      cashDisbursed: cashOut,
      // Chaos S5 cumulative cap anchor: later partial refunds of the same
      // ticket subtract this before restoring more trade value.
      ...(tradeRestoreNow > 0 && !tradeValueUnclaimed ? { tradeInRestored: tradeRestoreNow } : {}),
      costTotal: costRefundTotal,
      // Recovered COGS of the RESTOCKED units — the P&L credit. The native
      // engine recomputes the same figure and the read-back (committedRefund)
      // overwrites both fields; the legacy lane trusts the frozen-line sum.
      restoredCogs: costRefundTotal,
      // Refund-row profit = net reversed − recovered COGS (native `profit_net`);
      // a restock refund nets 0, a write-off carries the loss.
      profit: Math.round(netRefund) - costRefundTotal,
      profitMargin: 0,
      pricingTier: originalTransaction.pricingTier || 'Retail',
      paymentMethod: effectiveRefundMethod,
      cashTendered: cashOut,
      changeDue: 0,
      createdAt: new Date().toISOString(),
    };

    // D2: the per-lane split rides the refund's existing JSON payload (no
    // migration). Later refunds of this ticket read it back through
    // `refundLaneTotalsOf`, which is what makes partial refunds conserve.
    (refundTransaction as unknown as Record<string, unknown>).funding = fundingPayloadOf(
      funding,
      funding.anomalies.includes('no-tenders') || funding.anomalies.includes('legacy-no-tenders')
        ? 'derived'
        : 'explicit'
    );

    const totalOrigItems = (originalTransaction.items || []).reduce((acc, i) => acc + i.quantity, 0);
    const totalRefundedItems = refundItems.reduce((acc, i) => acc + i.quantity, 0);
    const isFullyRefunded = totalRefundedItems >= totalOrigItems;

    const updatedOriginalTransaction: SaleTransaction = {
      ...originalTransaction,
      status: isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    };

    // Store invariant: newest-first (refund receipt carries a fresh
    // createdAt; the helper places it by comparator, not by assumption).
    const updatedTransactions = sortedTransactions([
      refundTransaction,
      ...transactions.map((t) => (t.id === originalTransaction.id ? updatedOriginalTransaction : t)),
    ]);

    const auditEntry: SecurityAuditLogEntry = {
      id: newId('AUDIT'),
      timestamp: new Date().toISOString(),
      user: cashierName || 'Manager',
      action: 'Remboursement / Avoir Émis',
      details: `Avoir #${refundReceiptNumber} (net ${netRefund} DA, brut ${refundTotal} DA, espèces ${cashOut} DA en ${effectiveRefundMethod}${
        tradeRestoreNow > 0 && !tradeValueUnclaimed
          ? `, reprise ${tradeRestoreNow} DA restaurée en avoir`
          : tradeValueUnclaimed
            ? `, reprise ${tradeRestoreNow} DA NON réclamable (ticket anonyme — régularisation manager requise)`
            : ''
      }${
        funding.digitalShare > 0
          ? `, rail d’origine à reverser ${funding.digitalShare} DA (jamais en espèces)`
          : ''
      }) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}`,
      requiresPin: true,
    };

    const recordDefectiveLossExpenses = async (warningsOut: string[]) => {
      const defective = refundItems.filter(
        (i) => (i.condition ?? (i.restock ? 'restock' : 'defective')) === 'defective' && i.quantity > 0
      );
      if (defective.length > 0) {
        try {
          const { addStoreExpense } = get() as unknown as {
            addStoreExpense: (e: {
              category: 'Perte Stock / SAV';
              title: string;
              amount: number;
              paymentMethod: 'Autre';
              notes?: string;
              recordedBy: string;
            }) => Promise<unknown>;
          };
          for (const di of defective) {
            const origLine = findOrigLine(di);
            // Loss memo = COST only (frozen at sale, catalog as last resort).
            // The sell price is never a cost basis — dropping `unitPrice`
            // here keeps a defective unit from inflating the write-off.
            const lossUnitCost = Math.max(
              0,
              Math.round(
                origLine?.unitCostAtSale ?? origLine?.unitCostPrice
                ?? products.find((p) => p.id === di.productId)?.costPrice ?? 0
              )
            );
            const lossAmount = lossUnitCost * Math.max(0, Math.round(di.quantity));
            if (lossAmount <= 0) continue;
            await addStoreExpense({
              category: 'Perte Stock / SAV',
              title: `Rebut SAV : ${di.title || di.productId} (x${di.quantity}) — Avoir #${refundReceiptNumber}`,
              amount: lossAmount,
              paymentMethod: 'Autre',
              notes: `Ticket origine #${originalTransaction.receiptNumber}. Motif: ${refundReason}`,
              recordedBy: cashierName || 'Manager',
            });
          }
        } catch (woErr) {
          console.warn('[refund:writeoff] inventory-loss entry deferred:', woErr);
          warningsOut.push("Rebut SAV : perte stock à comptabiliser manuellement dans les charges.");
        }
      }
    };

    // MOBI-DEFECT-F native barrier (Tauri only): every money effect of this
    // refund — ticket CAS, refund row + lines, inventory deltas, batch
    // restitution, debt ledger, voucher CAS, drawer trail, outbox, audit —
    // commits in ONE native BEGIN IMMEDIATE transaction. A concurrent tab
    // blocks on the journal lock, then rolls back with ALREADY_REFUNDED and
    // performs no side effects. The legacy Dexie/SQLite-split flow below runs
    // ONLY outside Tauri (web preview / Node tests).
    if ((await import('../../db/adapters/base')).isTauriEnv()) {
      const batchSeed = `ref-${refundTxnId}`;
      const restitutionAllocations: Array<{ batchId?: string; productId: string; quantity: number; unitCost: number }> = [];
      {
        const restocked = refundItems.filter(
        (i) =>
          (i.condition ?? (i.restock ? 'restock' : 'defective')) === 'restock' &&
          i.quantity > 0 &&
          !isUnstockedProduct(i.productId, products)
      );
        for (const ri of restocked) {
          const origItem = findOrigLine(ri);
          const origAllocations = origItem?.fifoAllocations || [];
          let remainingQty = ri.quantity;
          if (origAllocations.length > 0) {
            const reversedAllocations = [...origAllocations].reverse();
            for (const alloc of reversedAllocations) {
              if (remainingQty <= 0) break;
              const restoreCount = Math.min(alloc.quantity, remainingQty);
              restitutionAllocations.push({
                batchId: alloc.batchId,
                productId: ri.productId,
                quantity: restoreCount,
                unitCost: alloc.unitCost,
              });
              remainingQty -= restoreCount;
            }
          }
          if (remainingQty > 0) {
            const fallbackUnitCost = origItem?.unitCostAtSale ?? origItem?.unitCostPrice ?? origItem?.product?.costPrice ?? ri.unitPrice;
            restitutionAllocations.push({
              batchId: undefined,
              productId: ri.productId,
              quantity: remainingQty,
              unitCost: fallbackUnitCost,
            });
          }
        }
      }
      const liveCustForRelief = origCust ? (customers.find((c) => c.id === origCust.id) || origCust) : undefined;
      const debtReliefForNative = funding.debtShare > 0 && liveCustForRelief
        ? (() => {
            const reliefAmt = Math.max(0, Math.min(Math.round(funding.debtShare), Math.round(liveCustForRelief.currentDebt ?? 0)));
            if (reliefAmt <= 0) return null;
            return {
              entry: {
                entryId: deterministicId('PAYREL', refundTxnId, liveCustForRelief.id, reliefAmt),
                customerId: liveCustForRelief.id,
                customerName: liveCustForRelief.name,
                amount: reliefAmt,
                receiptNumber: `VERS-${refundTxnId.replace(/^REF-/, '')}`,
                paymentMethod: 'Crédit Client',
                notes:
                  `Remboursement Ticket #${originalTransaction.receiptNumber} — réduction de créance ` +
                  `(part dette ${reliefAmt} DA sur net remboursé ${netRefund} DA)`,
                recordedBy: cashierName || 'Manager',
              },
              relief: reliefAmt,
              newDebt: Math.max(0, Math.round(liveCustForRelief.currentDebt ?? 0) - reliefAmt),
            };
          })()
        : null;
      // REF-66: a CREDIT-funded sale whose receivable is already settled (or
      // partly settled) has no debt left to relieve, and the ticket carries no
      // cash. The refunded value would then have NO destination and the native
      // always-balance gate refuses it (total 500 != cash 0 + wallet 0 + ...).
      // The customer already paid that money to the shop, so the value is owed
      // back: it rides the Avoir leg (the only lane that always delivers and
      // needs no drawer movement), and the native writes the balance + its
      // creditDeltaDzd row inside the same transaction.
      if (funding.debtShare > 0 && origCustLive && origCust) {
        const reliefPlanned = Math.max(0, Math.round(Number(debtReliefForNative?.relief ?? 0) || 0));
        const voucherPlanned = Math.max(0, Math.round(Number(funding.voucherShare ?? 0) || 0));
        const cashPlanned = Math.max(0, Math.round(Number(cashOut) || 0));
        const uncoveredCredit = Math.max(
          0,
          Math.round(netRefund) - reliefPlanned - voucherPlanned - cashPlanned - walletLegForNative,
        );
        if (uncoveredCredit > 0) {
          walletLegForNative += uncoveredCredit;
          console.warn(
            `[refund:credit] settled receivable: ${uncoveredCredit} DA routed to the Avoir leg (no debt left to relieve, no cash on the ticket)`,
          );
        }
      }

      const voucherForNative = originalTransaction.voucherCode && funding.voucherShare > 0
        ? { code: originalTransaction.voucherCode, amount: Math.round(funding.voucherShare) }
        : null;
      const cashMoveForNative = cashOut > 0
        ? {
            id: `MOV-REF-${refundTxnId.replace(/^REF-/, '')}`,
            sessionId: refundShift.id,
            amount: Math.round(cashOut),
            reason:
              `${DRAWER_REASON_PREFIXES.REFUND_ALLOCATION} [${refundReceiptNumber}] ` +
              `tiroir=${refundShift.id} periode=${refundShift.id} ` +
              `net=${netRefund} especes=${Math.round(cashOut)} avoir=${walletAddBase + tradeRestoreNow} ` +
              `origine=${originalTransaction.receiptNumber} ticket=${originalTransaction.id} ` +
              `shift_origine=${(originalTransaction.shiftId || '').trim() || 'inconnue'}`,
            cashierName: cashierName || 'Manager',
          }
        : null;
      const nativeAuditId = `AUD-${refundTxnId}`;
      // Machine-readable payout tag for the both-offline convergence
      // detector (payoutWatch scans audit details). Computed BEFORE the
      // commit so the native audit row carries it, like the legacy
      // logSecurityAction row did.
      let nativePayoutTag = '';
      try {
        const { getStableDeviceId } = await import('../../sync/device');
        const { payoutTag } = await import('../../sync/payoutWatch');
        const devId = await getStableDeviceId().catch(() => 'default');
        nativePayoutTag = ` ${payoutTag(`REF:${refundTxnId}`, effectiveRefundMethod, Math.round(cashOut), devId)}`;
      } catch {
        // Tag best-effort — the refund itself must never fail over a marker.
      }
      const nativeReq: NativeRefundRequest = {
        ticketId: originalTransaction.id,
        refundId: refundTxnId,
        itemsHash: refundItemsHash,
        receiptNumber: refundReceiptNumber,
        method: effectiveRefundMethod,
        walletCredit: walletLegForNative > 0 ? Math.round(walletLegForNative) : null,
        walletClawback: walletClawbackForNative > 0 ? walletClawbackForNative : null,
        online: refundOnline,
        localDeviceId: refundLocalDevice || '',
        activeShiftId: refundShiftGate.id || '',
        supervisor:
          supervisorPinVerifiedAt && supervisorUserId
            ? { userId: supervisorUserId, verifiedAt: supervisorPinVerifiedAt }
            : null,
        customerId: updatedCustomer?.id ?? originalTransaction.customer?.id ?? null,
        subtotal: Math.round(refundTotal),
        discountTotal: 0,
        totalNet: Math.round(netRefund),
        // Row `total` = value reversed (funding + trade restore) — the same
        // number the receipt payload carries, so column and JSON never
        // disagree ([MNY-26]: 600 cash + 400 avoir + 300 reprise = 1300).
        valueReversed: Math.round(valueReversed),
        costTotal: Math.round(costRefundTotal),
        pricingTier: originalTransaction.pricingTier || 'Retail',
        paymentMethod: effectiveRefundMethod,
        cashTendered: Math.round(cashOut),
        changeDue: 0,
        cashTenderedNet: Math.round(cashTenderedNet),
        createdAt: refundTransaction.createdAt,
        refundPayload: JSON.stringify(refundTransaction),
        // The native lane merges from the DURABLE row payload read under its own
        // write lock; this client snapshot is only the fallback base when that
        // row is unparseable (refund.rs:1074-1093). Shipping the whole ticket is
        // what made a 4e9 refund (139 MB) stall on the IPC boundary, so the
        // fallback is now the minimal valid object. Trade-off: if the row payload
        // is corrupt, the merge starts from `{}` and the native warning fires -
        // the row is already the corrupt artefact in that case.
        originalOutboxPayload: JSON.stringify({ id: originalTransaction.id }),
        deviceId: refundLocalDevice || 'local',
        lines: canonicalRefundItems.map((ri, idx) => {
          const origLine = findOrigLine(ri);
          // Frozen cost from the exact original line (same chain the
          // recovered-COGS sum above uses): the native engine recomputes
          // its figure from these per-line values.
          const frozenUnitCost = Math.max(
            0,
            Math.round(
              origLine?.unitCostAtSale ?? origLine?.unitCostPrice ?? ri.unitCostAtSale
                ?? products.find((p) => p.id === ri.productId)?.costPrice ?? 0
            )
          );
          const lineIdxMatch = ri.saleItemId ? String(ri.saleItemId).match(/-item-(\d+)$/) : null;
          return {
            id: `${refundTxnId}-item-${idx}`,
            productId: ri.productId,
            quantity: ri.quantity,
            appliedPrice: Math.round(ri.unitPrice ?? 0),
            unitPriceCharged: Math.round(ri.unitPrice ?? 0),
            unitCostAtSale: frozenUnitCost,
            discountAmount: 0,
            lineProfit: 0,
            imeiNumber: ri.imeiNumber ?? null,
            saleItemId: ri.saleItemId ?? null,
            // Original-ticket line index (parsed from the line identity —
            // never the canonical refund order, which may differ).
            lineIndex: lineIdxMatch ? Number(lineIdxMatch[1]) : null,
            condition: ri.condition ?? (ri.restock ? 'restock' : 'defective'),
            itemKey: `${refundTxnId}-itemkey-${idx}`,
            itemPayload: JSON.stringify({
              id: `${refundTxnId}-item-${idx}`,
              transactionId: refundTxnId,
              productId: ri.productId,
              quantity: ri.quantity,
              appliedPrice: Math.round(ri.unitPrice ?? 0),
              imeiNumber: ri.imeiNumber ?? null,
            }),
          };
        }),
        deltas: refundItems
          .filter((i) => i.restock && i.quantity > 0 && !isUnstockedProduct(i.productId, products))
          .map((i) => ({
            id: deterministicId('LED-REF', refundTxnId, i.productId, i.quantity),
            key: deterministicId('LED-REF', refundTxnId, i.productId, i.quantity),
            productId: i.productId,
            delta: i.quantity,
          })),
        batches: restitutionAllocations.map((a, allocIdx) => {
          const fallbackBatchId = `batch-return-${batchSeed}-${a.productId}-${Math.max(0, Math.round(a.unitCost))}-${allocIdx}`;
          return {
            batchId: a.batchId ?? null,
            productId: a.productId,
            quantity: a.quantity,
            unitCost: a.unitCost,
            fallbackBatchId,
            fallbackKey: `sb-${fallbackBatchId}`,
          };
        }),
        imeis: restoredImeis,
        defectiveImeis,
        defectNote: hasNonRestocked ? (refundReason?.trim() || null) : null,
        // Loyalty clawback is decided by the shared TS math (immutable sale
        // snapshots); native replays it onto the durable row. The echo in
        // the receipt is authoritative for hydration.
        customerPointsAfter: updatedCustomer
          ? Math.max(0, Math.round(updatedCustomer.loyaltyPoints || 0))
          : null,
        customerPointBucketsJson: updatedCustomer
          ? JSON.stringify(updatedCustomer.pointBuckets || [])
          : null,
        debt: debtReliefForNative?.entry ?? null,
        voucher: voucherForNative,
        cashMove: cashMoveForNative,
        audit: {
          action: auditEntry.action,
          details: `${auditEntry.details}${nativePayoutTag}`,
          user: auditEntry.user,
          requiresPin: true,
          deviceId: refundLocalDevice || null,
          ipAddress: null,
        },
      };
      const updatedCustomerProjected = updatedCustomer
        ? debtReliefForNative
          ? { ...updatedCustomer, currentDebt: debtReliefForNative.newDebt }
          : updatedCustomer
        : undefined;
      const auditMirror: SecurityAuditLogEntry = {
        ...auditEntry,
        id: nativeAuditId,
        details: `${auditEntry.details}${nativePayoutTag}`,
      };
      const nativeRes = await refundSaleNative(nativeReq, {
        refund: refundTransaction,
        updatedOriginal: { ...updatedOriginalTransaction, refundedItems: canonicalRefundItems },
        products: restockedProducts,
        customer: updatedCustomerProjected,
        audit: auditMirror,
      });
      if (!nativeRes.success) {
        const r = nativeRes.reason;
        if (r === 'ALREADY_REFUNDED') return { success: false, reason: 'ALREADY_REFUNDED', refundId: nativeRes.refundId };
        if (r === 'ORIGINAL_VOIDED') return { success: false, reason: 'ORIGINAL_VOIDED' };
        if (r === 'REFUND_EXCEEDS_PURCHASED') return { success: false, reason: 'REFUND_EXCEEDS_PURCHASED' };
        if (r === 'CASH_CAP_EXCEEDED') return { success: false, reason: 'CASH_CAP_EXCEEDED' };
        if (r === 'NO_OPEN_SHIFT') return { success: false, reason: 'NO_OPEN_SHIFT' };
        if (r === 'ZERO_REFUNDABLE') return { success: false, reason: 'ZERO_REFUNDABLE' };
        if (r === 'VOUCHER_CHANGED' || r === 'VOUCHER_MISSING') return { success: false, reason: 'VOUCHER_RESTORE_FAILED' };
        if (r === 'OFFLINE_FOREIGN_TICKET') return { success: false, reason: 'OFFLINE_FOREIGN_TICKET' };
        if (r === 'OFFLINE_CASH_CAP_EXCEEDED') return { success: false, reason: 'OFFLINE_CASH_CAP_EXCEEDED' };
        if (r === 'SUPERVISOR_PIN_REQUIRED') return { success: false, reason: 'SUPERVISOR_PIN_REQUIRED' };
        if (r === 'SUPERVISOR_AUTH_EXPIRED') return { success: false, reason: 'SUPERVISOR_AUTH_EXPIRED' };
        if (r === 'RESTOCK_REASON_REQUIRED') return { success: false, reason: 'RESTOCK_REASON_REQUIRED' };
        if (r === 'SYSTEM_CLOCK_REGRESSION') return { success: false, reason: 'SYSTEM_CLOCK_REGRESSION' };
        // D4-A: the native recipient gate must reach the cashier as itself, not as a generic failure.
        if (r === 'AVOIR_RECIPIENT_REQUIRED') return { success: false, reason: 'AVOIR_RECIPIENT_REQUIRED' };
        if (r === 'REFUND_EXCEEDS_VALUE') return { success: false, reason: 'REFUND_EXCEEDS_VALUE' };
        if (r === 'DEVICE_IDENTITY_SPOOFED') return { success: false, reason: 'DEVICE_IDENTITY_SPOOFED' };
        // Keep the native detail in the reason (prefixed, so existing matchers
        // still see PERSISTENCE_FAILED): a blind generic toast cost hours on
        // REF-87.
        const nativeDetail = String((nativeRes as { detail?: unknown }).detail ?? '').trim();
        return {
          success: false,
          reason: nativeDetail
            ? `PERSISTENCE_FAILED:${nativeDetail.replace(/\s+/g, ' ').slice(0, 180)}`
            : 'PERSISTENCE_FAILED',
        };
      }
      const nativeWarnings: string[] = [...clampWarnings, ...nativeRes.warnings];
      if (tradeValueUnclaimed) {
        nativeWarnings.push(
          `Valeur reprise ${formatDZD(tradeRestoreNow)} non réclamable (ticket anonyme) — régularisation manager requise.`
        );
      }
      // ---- Read-back hydration: single authority = the committed rows ----
      // The receipt carries what actually committed — recovered COGS, the
      // (possibly clamped) relief applied, the live debt/points after, and
      // the durable merged ticket payload. Store mirrors are rebuilt from
      // it, never from the pre-commit client math or a silent fallback.
      const committedRecoveredCogs = Math.max(
        0,
        Math.round(nativeRes.recoveredCogs ?? costRefundTotal)
      );
      const committedRefund: SaleTransaction = {
        ...refundTransaction,
        costTotal: committedRecoveredCogs,
        restoredCogs: committedRecoveredCogs,
        profit: Math.round(netRefund) - committedRecoveredCogs,
      };
      const nativeReliefApplied = Math.max(
        0,
        Math.round(nativeRes.debtReliefApplied ?? debtReliefForNative?.relief ?? 0)
      );
      const nativeDebtAfter = typeof nativeRes.customerDebtAfter === 'number'
        ? Math.max(0, Math.round(nativeRes.customerDebtAfter))
        : undefined;
      // D4-A: the wallet balance after the native Avoir leg. The TS mirrors this
      // value; it never computes or re-applies the credit (no double credit).
      const nativeStoreCreditAfter = typeof nativeRes.customerStoreCreditAfter === 'number'
        ? Math.max(0, Math.round(nativeRes.customerStoreCreditAfter))
        : undefined;
      const nativePointsAfter = typeof nativeRes.customerPointsAfter === 'number'
        ? Math.max(0, Math.round(nativeRes.customerPointsAfter))
        : undefined;
      // D4-A: the native wallet leg also writes the creditDeltaDzd ledger row in
      // its payload. Mirror THOSE bytes for the ledger/points/buckets so the
      // post-commit save cannot clobber the native emission (balance alone is not
      // the destination of record).
      // D4-A: the native wallet leg also wrote the creditDeltaDzd ledger row in
      // its own payload. Mirror the COMMITTED row (authority read) for the
      // ledger/points/buckets so the post-commit save cannot clobber the native
      // emission - the balance alone is not the destination of record.
      const nativeCustomerPatch: Record<string, unknown> = await (async () => {
        try {
          const custId = String(originalTransaction.customer?.id ?? '').trim();
          if (!custId) return {};
          const { getLocalDb } = await import('../../db/sqlPluginAdapter');
          const db = await getLocalDb();
          const rows = (await db.select(
            'SELECT store_credit, loyalty_points, json_payload, LENGTH(json_payload) AS payload_len FROM customers WHERE id = $1',
            [custId],
          )) as Array<Record<string, unknown>>;
          const row = rows?.[0];
          if (!row) return {};
          // D6: a huge loyalty book (200k tranche rows, ~80MB) must not be
          // parsed on the renderer's main thread - that stalled the next refund
          // past the 120s supervisor window. The native already wrote the
          // ledger; the scalars are all the UI needs here.
          const payloadLen = Number(row.payload_len ?? 0);
          const hugePayload = payloadLen > 4_000_000;
          const payload = hugePayload
            ? {}
            : (JSON.parse(String(row.json_payload ?? '{}')) as Record<string, unknown>);
          return {
            ...(Array.isArray(payload.ledger)
              ? {
                  // Union by id: the native wallet rows AND the TS loyalty clawback
                  // rows both survive the mirror (review finding 4).
                  ledger: (() => {
                    const native = payload.ledger as Array<Record<string, unknown>>;
                    const tsEntries = Array.isArray(
                      (updatedCustomerProjected as { ledger?: unknown[] } | undefined)?.ledger,
                    )
                      ? ((updatedCustomerProjected as unknown as { ledger: Array<Record<string, unknown>> }).ledger)
                      : [];
                    const seen = new Set(native.map((e) => String(e?.id ?? '')));
                    return [...native, ...tsEntries.filter((e) => !seen.has(String(e?.id ?? '')))];
                  })(),
                }
              : {}),
            ...(typeof row.store_credit === 'number' ? { storeCredit: row.store_credit } : {}),
            ...(typeof row.loyalty_points === 'number' ? { loyaltyPoints: row.loyalty_points } : {}),
            ...(Array.isArray(payload.pointBuckets) ? { pointBuckets: payload.pointBuckets } : {}),
          };
        } catch (e) {
          // D4-A review finding 4: do NOT fall back to the TS projection here -
          // writing it would overwrite the committed ledger. Mark the mirror
          // unavailable and skip the save instead.
          console.warn('[refund:mirror] committed customer read-back failed; skipping mirror', e);
          return { __mirrorUnavailable: true } as Record<string, unknown>;
        }
      })();
      const hydratedCustomer = updatedCustomerProjected
        ? {
            ...updatedCustomerProjected,
            ...(nativeDebtAfter !== undefined ? { currentDebt: nativeDebtAfter } : {}),
            ...(nativePointsAfter !== undefined ? { loyaltyPoints: nativePointsAfter } : {}),
            ...(nativeStoreCreditAfter !== undefined ? { storeCredit: nativeStoreCreditAfter } : {}),
            ...nativeCustomerPatch,
          }
        : undefined;
      const hydratedOriginal = nativeRes.updatedOriginal ?? updatedOriginalTransaction;
      // A relief clamped to zero leaves NO ledger row — mirror that truth.
      const debtMirror: CustomerDebtEntry | undefined =
        debtReliefForNative && liveCustForRelief && nativeReliefApplied > 0
          ? {
              id: debtReliefForNative.entry.entryId,
              customerId: liveCustForRelief.id,
              customerName: liveCustForRelief.name,
              type: 'PAYMENT_SETTLED',
              amount: nativeReliefApplied,
              balanceAfter: nativeDebtAfter ?? updatedCustomerProjected?.currentDebt ?? 0,
              receiptNumber: debtReliefForNative.entry.receiptNumber,
              paymentMethod: 'Crédit Client',
              notes: debtReliefForNative.entry.notes,
              createdAt: new Date().toISOString(),
              recordedBy: cashierName || 'Manager',
            }
          : undefined;
      // Post-commit sync notifications + Dexie mirrors (best-effort: the money
      // is durable; failures warn instead of failing the refund).
      try {
        const [{ fireSync }, sql] = await Promise.all([
          import('../../db/adapters/base'),
          import('../../db/sqlPluginAdapter'),
        ]);
        if (hydratedCustomer && origCustLive && !(nativeCustomerPatch as Record<string, unknown>).__mirrorUnavailable) {
          // REF-40: never write a profile that is absent from the live list —
          // the upsert would clear its `deleted` tombstone (customerAdapter.ts:129).
          // Local authority FIRST: the wallet refill (avoir share + restored
          // trade value) and the loyalty clawback are money. Mirroring them to
          // Dexie/cloud alone loses them on restart, because boot rehydrates
          // from SQLite ([MNY-26]: store_credit stayed 0 while the refund had
          // credited 400). Same H8 policy as checkout: retry once, then queue
          // to the outbox with a loud warning.
          // D4-A / review N2: mirror loyalty ONLY. The wallet balance and its
          // ledger rows were committed natively; re-saving the whole object here
          // could erase a concurrent wallet debit. `saveRefundMirror` never
          // writes store_credit/current_debt and appends only this refund's
          // TS-side ledger rows.
          const savedCust = await persistWithRetryOnce(async () => {
            const { customerAdapter } = await import('../../db/adapters/customerAdapter');
            return customerAdapter.saveRefundMirror(hydratedCustomer, refundMirrorLedger);
          });
          if (!savedCust.ok) {
            nativeWarnings.push(
              'Avoir client : écriture locale différée — solde client en file de synchronisation.'
            );
            console.warn('[refund:persist] customer save failed; queueing to outbox', savedCust.error);
          }
          // Review F1: the outbox keeps one row per (entity, id), so enqueueing
          // the pre-commit object would replace a concurrent debit's payload.
          const committedCustomer = savedCust.ok ? savedCust.value : hydratedCustomer;
          const hugeCustomer = Boolean((nativeCustomerPatch as Record<string, unknown>).__hugePayload);
          if (hugeCustomer) {
            // D6: stringifying an ~80MB customer payload on the renderer thread
            // delayed the next refund past the supervisor window. The native row
            // is marked pending; the boot recovery pass (case 23) enqueues it.
            console.warn('[refund:sync] huge customer payload - enqueue deferred to the boot pass');
          } else {
          await sql
            .enqueueGenericSync('customer', committedCustomer.id, committedCustomer as unknown as Record<string, unknown>)
            .catch((e: unknown) => {
              nativeWarnings.push('Dette client : mise en file de synchronisation différée — le remboursement reste valide.');
              console.warn('[refund:sync] customer enqueue deferred:', e);
            });
          }
          void fireSync('customer', committedCustomer.id, committedCustomer);
          try {
            const { db } = await import('../../db/database');
            await db.customers.put(hydratedCustomer);
          } catch (e) {
            console.warn('[refund] Dexie customer hydration skipped:', e);
          }
        }
        // Refund row parity: the projection wrote the pre-commit client
        // guess; re-put the read-back hydrated row (authoritative cost/profit).
        try {
          const { db } = await import('../../db/database');
          await db.transactions.put(committedRefund);
        } catch (e) {
          console.warn('[refund] Dexie refund hydration skipped:', e);
        }
        if (debtMirror) {
          try {
            const { db } = await import('../../db/database');
            await db.customerDebts.put(debtMirror);
          } catch (e) {
            console.warn('[refund] Dexie debt mirror skipped:', e);
          }
          void fireSync('customer_debt', debtMirror.id, debtMirror);
        }
        void fireSync('audit_log', nativeAuditId, auditMirror);
        for (const imei of [...restoredImeis, ...defectiveImeis]) {
          try {
            const { db } = await import('../../db/database');
            const rec = await db.imeiRecords.get(imei);
            if (rec) {
              const released = { ...rec, saleTransactionId: undefined, soldAt: undefined };
              await db.imeiRecords.put(released);
              void fireSync('imei', imei, released);
            }
          } catch (e) {
            console.warn('[refund] Dexie IMEI mirror skipped:', e);
          }
        }
        if (voucherForNative) {
          try {
            const { db } = await import('../../db/database');
            const rows = await db.creditVouchers.where('code').equals(voucherForNative.code).toArray().catch(() => []);
            const row = rows?.[0];
            if (row) {
              const target = Math.min(row.initialAmount, row.remainingAmount + voucherForNative.amount);
              if (target !== row.remainingAmount) {
                const nowIso = new Date().toISOString();
                await db.creditVouchers.put({ ...row, remainingAmount: target, status: target > 0 ? 'ACTIVE' : row.status, updatedAt: nowIso });
                void fireSync('credit_voucher', row.id, { ...row, remainingAmount: target });
              }
            }
          } catch (e) {
            nativeWarnings.push(`Bon ${voucherForNative.code} : miroir local différé — solde vérifié côté autorité.`);
            console.warn('[refund] Dexie voucher mirror skipped:', e);
          }
        }
        if (cashMoveForNative) {
          void fireSync('cash_movement', cashMoveForNative.id, cashMoveForNative);
        }
      } catch (e) {
        console.warn('[refund:sync] post-commit notifications deferred:', e);
        nativeWarnings.push('Journal de synchronisation : écriture différée — le ticket reste valide localement.');
      }
      try {
        const { checkDuplicatePayouts } = await import('../../sync/payoutWatch');
        const dups = await checkDuplicatePayouts();
        for (const d of dups) {
          nativeWarnings.push(
            `Double encaissement suspecté sur le ticket ${d.payoutId.replace(/^(REF|VOID):/, '')} : ${d.amount} DA versés sur ${d.devices.length} appareils — contrôlez le fond de caisse.`
          );
        }
      } catch {
        // Detector best-effort only.
      }
      audioBus.emit('success');
      if (effectiveRefundMethod === 'Espèces') {
        audioBus.emit('cashDrawer');
      }
      const releasedImeiKeysNative = new Set(
        [...restoredImeis, ...defectiveImeis].map(normalizeDeviceKey)
      );
      const nextImeiRecordsNative = (get().imeiRecords || []).map((rr) =>
        releasedImeiKeysNative.has(normalizeDeviceKey(rr.imei))
          ? { ...rr, saleTransactionId: undefined, soldAt: undefined }
          : rr
      );
      const nativeUpdatedTransactions = sortedTransactions([
        committedRefund,
        ...transactions.map((t) => (t.id === originalTransaction.id ? hydratedOriginal : t)),
      ]);
      set({
        products: updatedProducts,
        transactions: nativeUpdatedTransactions,
        customers: hydratedCustomer ? customers.map((c) => (c.id === hydratedCustomer.id ? hydratedCustomer : c)) : customers,
        currentCustomer: hydratedCustomer || get().currentCustomer,
        customerDebts: debtMirror ? [debtMirror, ...get().customerDebts] : get().customerDebts,
        securityAuditLog: [auditMirror, ...get().securityAuditLog],
        imeiRecords: nextImeiRecordsNative,
        lastTransaction: committedRefund,
        activeModal: null,
        hardwareStatus:
          effectiveRefundMethod === 'Espèces' ? { ...get().hardwareStatus, cashDrawerOpen: true } : get().hardwareStatus,
      });
      const nativeSettings = get().receiptSettings;
      if (nativeSettings?.autoPrintEnabled !== false) {
        void printReceipt(committedRefund, nativeSettings);
      }
      await recordDefectiveLossExpenses(nativeWarnings);
      return { success: true, refundTransaction, warnings: nativeWarnings };
    }

    try {
      await (await getSqlite()).processRefundAtomic(
        refundTransaction,
        updatedOriginalTransaction,
        restockedProducts,
        updatedCustomer,
        restoredImeis,
        auditEntry,
        {
          localDeviceId: refundLocalDevice,
          activeShiftId: refundShiftGate.id,
          online: refundOnline,
        },
        // Defective units ride into quarantine (`status='defective'` +
        // RETURN_DEFECTIVE event) — the same split the native lane performs.
        defectiveImeis
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('REFUND_EXCEEDS')) return { success: false, reason: 'REFUND_EXCEEDS_PURCHASED' };
      if (msg === 'ALREADY_PROCESSING') return { success: false, reason: 'ALREADY_PROCESSING' };
      if (msg === 'ORIGINAL_VOIDED') return { success: false, reason: 'ORIGINAL_VOIDED' };
      if (msg === 'ZERO_REFUNDABLE') return { success: false, reason: 'ZERO_REFUNDABLE' };
      if (msg === 'CASH_CAP_EXCEEDED') return { success: false, reason: 'CASH_CAP_EXCEEDED' };
      if (msg === 'OFFLINE_REMOTE_TICKET') return { success: false, reason: 'OFFLINE_REMOTE_TICKET' };
      if (msg === 'NO_OPEN_SHIFT') return { success: false, reason: 'NO_OPEN_SHIFT' };
      console.error('Failed to process refund atomically:', err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }

    // Sync-lane writes for the refund (ledger deltas, batch restitution,
    // outbox rows). Failures here warn explicitly instead of vanishing.
    const refundWarnings: string[] = [...clampWarnings];
    if (tradeValueUnclaimed) {
      refundWarnings.push(
        `Valeur reprise ${formatDZD(tradeRestoreNow)} non réclamable (ticket anonyme) — régularisation manager requise.`
      );
    }
    try {
      const restocked = refundItems.filter(
        (i) =>
          (i.condition ?? (i.restock ? 'restock' : 'defective')) === 'restock' &&
          i.quantity > 0 &&
          !isUnstockedProduct(i.productId, products)
      );
      if (restocked.length > 0) {
        const { appendInventoryDeltas, restituteStockBatches } = await import('../../db/sqlPluginAdapter');
        await appendInventoryDeltas(
          restocked.map((i) => ({
            id: deterministicId('LED-REF', refundTxnId, i.productId, i.quantity),
            idempotencyKey: deterministicId('LED-REF', refundTxnId, i.productId, i.quantity),
            productId: i.productId,
            delta: i.quantity,
            reason: 'REFUND' as const,
            refType: 'order',
            refId: refundTxnId,
          }))
        );

        // FIFO batch restitution (Edge A — reverse depletion / LIFO returns):
        // each refund line restores the batches that supplied ITS original
        // sale line, newest first (allocations were recorded oldest-first).
        // Matching is by saleItemId (exact original line); the product-only
        // lookup is a legacy fallback for pre-link refund payloads.
        const restitutionAllocations: Array<{ batchId?: string; productId: string; quantity: number; unitCost: number }> = [];
        for (const ri of restocked) {
          const origItem = findOrigLine(ri);
          const origAllocations = origItem?.fifoAllocations || [];
          let remainingQty = ri.quantity;

          if (origAllocations.length > 0) {
            // Restore in reverse consumption order (LIFO return order) so newest batch is replenished first
            const reversedAllocations = [...origAllocations].reverse();
            for (const alloc of reversedAllocations) {
              if (remainingQty <= 0) break;
              const restoreCount = Math.min(alloc.quantity, remainingQty);
              restitutionAllocations.push({
                batchId: alloc.batchId,
                productId: ri.productId,
                quantity: restoreCount,
                unitCost: alloc.unitCost,
              });
              remainingQty -= restoreCount;
            }
          }

          if (remainingQty > 0) {
            const fallbackUnitCost = origItem?.unitCostAtSale ?? origItem?.unitCostPrice ?? origItem?.product?.costPrice ?? ri.unitPrice;
            restitutionAllocations.push({
              batchId: undefined,
              productId: ri.productId,
              quantity: remainingQty,
              unitCost: fallbackUnitCost,
            });
          }
        }

        if (restitutionAllocations.length > 0) {
          await restituteStockBatches(restitutionAllocations, { batchKeySeed: `ref-${refundTxnId}` }).catch((err) => {
            console.warn('[refund:batches] Batch restitution error:', err);
          });
        }
      }

      const defective = refundItems.filter(
        (i) => (i.condition ?? (i.restock ? 'restock' : 'defective')) === 'defective' && i.quantity > 0
      );
      if (defective.length > 0) {
        const { recordDefectiveReturn, appendInventoryDeltas } = await import('../../db/sqlPluginAdapter');
        for (const item of defective) {
          const origItem = findOrigLine(item);
          await recordDefectiveReturn({
            productId: item.productId,
            productName: origItem?.product?.title,
            imei: item.imeiNumber,
            quantity: item.quantity,
            unitCost:
              origItem?.unitCostAtSale ?? origItem?.unitCostPrice ?? origItem?.product?.costPrice ?? 0,
            reason: refundReason,
            saleId: originalTransaction.id,
            refundId: refundTxnId,
          });
        }
        await appendInventoryDeltas(
          defective.map((i) => ({
            id: deterministicId('LED-DEF', refundTxnId, i.productId, i.quantity),
            idempotencyKey: deterministicId('LED-DEF', refundTxnId, i.productId, i.quantity),
            productId: i.productId,
            delta: 0,
            reason: 'ADJUST' as const,
            refType: 'DEFECTIVE_QUARANTINE',
            refId: refundTxnId,
          }))
        ).catch((err) => console.warn('[refund:quarantine] Ledger delta error:', err));
      }

      await recordDefectiveLossExpenses(refundWarnings);
      const { enqueueOrderSync } = await import('../../db/sqlPluginAdapter');
        const { writeCheckoutAtomic } = await import('../../db/sqlPluginAdapter');
      // Full object for the same reason as void: preserve receipt detail in cloud + peers.
      // enqueueOrderSync always runs (outbox INSERT, self-locked): C6 — the refund
      // must reach the cloud even when the shared checkout flight is held.
      await enqueueOrderSync(originalTransaction.id, {
        ...updatedOriginalTransaction,
        receipt_number: originalTransaction.receiptNumber,
        created_at: originalTransaction.createdAt,
      } as unknown as Record<string, unknown>);
      // F3-recovery: the refund receipt row gets a durable intent BEFORE the
      // flight check — on held-flight deferral or write throw, boot replay
      // restores the row idempotently (deterministic refundTxnId + derived
      // keys). Stock restitution above already landed; replay only refills
      // the missing row, never double-restores.
      const refundPayload = {
        orderRow: {
          id: refundTxnId,
          receipt_number: refundReceiptNumber,
          customer_id: updatedCustomer?.id ?? originalTransaction.customer?.id ?? null,
          subtotal: refundTotal,
          discount_total: 0,
          // Value reversed (funding + trade restore); drawer outflow is cashOut.
          total: valueReversed,
          cost_total: costRefundTotal,
          // Recovered-COGS credit is also carried by the receipt JSON
          // envelope (`restoredCogs`) for schema-degraded previews where the
          // v127 column may lag the heal — the P&L credit never vanishes.
          profit: Math.round(netRefund) - costRefundTotal,
          profit_margin: 0,
          pricing_tier: originalTransaction.pricingTier,
          payment_method: effectiveRefundMethod,
          cash_tendered: cashOut,
          change_due: 0,
          status: 'COMPLETED',
          created_at: refundTransaction.createdAt,
        },
        fullTx: refundTransaction as unknown as Record<string, unknown>,
        items: canonicalRefundItems.map((ri, idx) => {
          const origLine = findOrigLine(ri);
          const frozenUnitCost = Math.max(
            0,
            Math.round(origLine?.unitCostAtSale ?? origLine?.unitCostPrice ?? ri.unitCostAtSale ?? 0)
          );
          return {
            id: `${refundTxnId}-item-${idx}`,
            product_id: ri.productId,
            quantity: ri.quantity,
            applied_price: ri.unitPrice,
            discount: 0,
            imei_number: ri.imeiNumber ?? null,
            // Frozen original-line cost (never the live catalog) so the
            // legacy lane's refund lines match the native write.
            cost_price: frozenUnitCost,
            unit_cost_at_sale: frozenUnitCost,
            // Original sale line identity — preserved on the refund line.
            sale_item_id: ri.saleItemId ?? null,
          };
        }),
        deltas: [],
      };
      await saveCheckoutRecoveryIntent({
        transactionId: refundTxnId,
        receiptNumber: refundReceiptNumber,
        payload: refundPayload as unknown as Parameters<typeof saveCheckoutRecoveryIntent>[0]['payload'],
      }).catch(() => {});
      // B-061: the durable order-row write shares the checkout flight with
      // processPayment and boot replay. processRefundAtomic above already
      // committed the money; if the flight is held, defer the order-row write
      // with an explicit warning rather than opening a second busy-retry loop.
      // The intent above replays it on boot (recoveryQueued equivalent).
      if (!tryAcquireCheckoutFlight('refund-write')) {
        console.warn('[refund] checkout flight held — order-row write deferred (money already durable via processRefundAtomic; intent replays on boot)');
        refundWarnings.push('Avoir enregistré : écriture du ticket en file — réessayer après la vente en cours.');
      } else {
        try {
      await writeCheckoutAtomic(refundPayload);
      await clearCheckoutRecoveryIntent(refundTxnId).catch(() => {});
      const { syncManager } = await import('../../sync/SyncManager');
      syncManager.notifyLocalWrite();
        } finally {
          releaseCheckoutFlight('refund-write');
        }
      }
    } catch (e) {
      console.warn('Refund ledger write skipped:', e);
      refundWarnings.push('Journal de synchronisation : écriture différée — le ticket reste valide localement.');
    }

    // Fix 4: cross-shift allocation record (double-entry trail). The refund
    // row above (shiftId = current shift) carries contra-revenue to THIS
    // period while the original ticket stays untouched; this ALLOCATION
    // movement records the physical drawer debit with the immutable original
    // link. ALLOCATION is allowlisted out of every cash-math reader —
    // informational only, never double-counted. Best-effort post-commit
    // (money already durable): failures warn, never fail the refund.
    if (cashOut > 0) {
      try {
        const { shiftAdapter } = await import('../../db/adapters/shiftAdapter');
        const origShift = (originalTransaction.shiftId || '').trim() || 'inconnue';
        await shiftAdapter.logExpense(
          cashOut,
          'ALLOCATION',
          `${DRAWER_REASON_PREFIXES.REFUND_ALLOCATION} [${refundReceiptNumber}] ` +
            `tiroir=${refundShift.id} periode=${refundShift.id} ` +
            `net=${netRefund} especes=${cashOut} avoir=${walletAddBase + tradeRestoreNow} ` +
            `origine=${originalTransaction.receiptNumber} ticket=${originalTransaction.id} ` +
            `shift_origine=${origShift}`,
          cashierName || 'Manager',
          refundShift.id
        );
      } catch (allocErr) {
        console.warn('[refund:allocation] allocation record deferred:', allocErr);
        refundWarnings.push('Traçabilité inter-caisse : écriture différée — le remboursement reste valide.');
      }
    }

    // Machine-readable payout tag for the both-offline convergence detector
    // (payoutWatch) + immediate local check against already-pulled peer rows.
    let refundPayoutTag = '';
    try {
      const { getStableDeviceId } = await import('../../sync/device');
      const { payoutTag } = await import('../../sync/payoutWatch');
      const devId = await getStableDeviceId().catch(() => 'default');
      refundPayoutTag = ` ${payoutTag(`REF:${refundTxnId}`, effectiveRefundMethod, Math.round(cashOut), devId)}`;
    } catch {
      // Tag best-effort — the refund itself must never fail over a marker.
    }
    logSecurityAction(
      'Remboursement / Avoir Émis',
      `Avoir #${refundReceiptNumber} (net ${netRefund} DA, espèces ${cashOut} DA en ${effectiveRefundMethod}) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}${refundPayoutTag}`,
      cashierName || 'Manager',
      true
    );
    try {
      const { checkDuplicatePayouts } = await import('../../sync/payoutWatch');
      const dups = await checkDuplicatePayouts();
      for (const d of dups) {
        refundWarnings.push(
          `Double encaissement suspecté sur le ticket ${d.payoutId.replace(/^(REF|VOID):/, '')} : ${d.amount} DA versés sur ${d.devices.length} appareils — contrôlez le fond de caisse.`
        );
      }
    } catch {
      // Detector best-effort only.
    }

    audioBus.emit('success');
    if (effectiveRefundMethod === 'Espèces') {
      audioBus.emit('cashDrawer');
    }

    const releasedImeiKeys = new Set(restoredImeis.map(normalizeDeviceKey));
    // Same as the void path: the anchor is preserved (see the note there).
    const nextImeiRecords = (get().imeiRecords || []).map((r) =>
      releasedImeiKeys.has(normalizeDeviceKey(r.imei))
        ? { ...r, saleTransactionId: undefined, soldAt: undefined }
        : r
    );
    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      imeiRecords: nextImeiRecords,
      lastTransaction: refundTransaction,
      activeModal: null,
      hardwareStatus:
        effectiveRefundMethod === 'Espèces' ? { ...get().hardwareStatus, cashDrawerOpen: true } : get().hardwareStatus,
    });

    // C4 debt-on-refund: relieve exactly the debt-funded share of the
    // returned value (funding.debtShare) — never the gross. Runs through the
    // existing recordCustomerDebtPayment action as-is, AFTER the refund set()
    // above so its own set() lands on top instead of being overwritten.
    {
      const custId = origCust?.id;
      if (funding.debtShare > 0 && custId) {
        try {
          const { usePosStore } = await import('../usePosStore');
          const live = usePosStore.getState();
          const cust = live.customers.find((c) => c.id === custId);
          const relief = Math.max(0, Math.min(funding.debtShare, cust?.currentDebt ?? 0));
          if (relief > 0) {
            const notes =
              `Remboursement Ticket #${originalTransaction.receiptNumber} — réduction de créance ` +
              `(part dette ${relief} DA sur net remboursé ${netRefund} DA)`;
            // Deterministic relief id: the same refund replayed/raced from a
            // second device converges instead of settling the debt twice.
            const reliefOpts = { entryId: deterministicId('PAYREL', refundTxnId, custId, Math.round(relief)) };
            let res = await live.recordCustomerDebtPayment(custId, relief, 'Crédit Client', notes, reliefOpts);
            if (!res.success) {
              res = await live.recordCustomerDebtPayment(custId, relief, 'Crédit Client', notes, reliefOpts);
            }
            if (!res.success) {
              refundWarnings.push('Dette client : réduction de créance non confirmée — vérifiez le grand livre des dettes.');
            }
          }
        } catch {
          refundWarnings.push('Dette client : réduction de créance non confirmée — vérifiez le grand livre des dettes.');
        }
      }
    }

    const settings = get().receiptSettings;
    if (settings?.autoPrintEnabled !== false) {
      void printReceipt(refundTransaction, settings);
    }

    // Voucher credit-back: restore exactly the voucher-funded share of the
    // returned value (funding.voucherShare) — full or partial, the split is
    // exact either way. Never cashed out: a failed restore warns loudly and
    // goes to manual reissue (auto-cashing it would mint the arbitrage this
    // split exists to kill). Best-effort AFTER the refund is durable; never
    // fails the refund.
    {
      const origVoucherCode = originalTransaction.voucherCode;
      if (origVoucherCode && funding.voucherShare > 0) {
        try {
          const { voucherAdapter } = await import('../../db/adapters/voucherAdapter');
          const restored = await voucherAdapter.creditBack(origVoucherCode, funding.voucherShare);
          if (restored.success) {
            logSecurityAction(
              'Avoir Recrédité (Remboursement)',
              `Bon ${origVoucherCode} recrédité (+${restored.restored} DA sur part ${funding.voucherShare} DA) — remboursement du ticket #${originalTransaction.receiptNumber}.`,
              cashierName || 'Manager',
              true
            );
          } else {
            refundWarnings.push(`Bon ${origVoucherCode} : restauration échouée (${restored.reason}) — réémission manuelle requise.`);
          }
        } catch (e) {
          refundWarnings.push(`Bon ${origVoucherCode} : restauration impossible (${e instanceof Error ? e.message : String(e)}) — réémission manuelle requise.`);
        }
      }
    }

    return { success: true, refundTransaction, warnings: refundWarnings };
  },
});
