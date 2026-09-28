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
} from '../../utils/loyaltyEngine';
import {
  getEffectiveCostPrice,
  calculateProfit,
} from '../../utils/pricingEngine';
import { computeCartTotals, computeRefundFundingSplit } from '../../utils/receiptMath';
import { formatDZD } from '../../types/pos';
import { DRAWER_REASON_PREFIXES } from '../../constants/index';
import { DEFAULT_CREDIT_LIMIT } from './createCustomerSlice';
import { readVatRate, readVoucherStaging } from './createCartSlice';
import { audioBus } from '../../utils/audioEvents';
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
// P11.3: receipt printing is fire-and-forget and desktop-only; the escpos
// chain (spooler + serial + label builder) loads on first use, not at boot.
async function printReceipt(transaction: SaleTransaction, settings: ReceiptSettings): Promise<void> {
  try {
    const { directPrintReceipt } = await import('../../utils/escpos');
    await directPrintReceipt(transaction, settings);
  } catch (err) {
    console.warn('[print] receipt printing skipped:', err);
  }
}

export const createOrderSlice: StateCreator<PosState, [], [], OrderSlice> = (set, get) => ({
  transactions: [],
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

      // Canonical totals (single source: receiptMath.computeCartTotals):
      // signed quantities, per-line discounts, store credit, staged voucher
      // credit, VAT. Every checkout surface must derive from the same base.
      const vatRate = readVatRate(get());
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
          vatRate,
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
        vatRate,
      });
      // A voucher never over-covers the pre-credit net: excess stays on the voucher.
      voucherCreditApplied = Math.max(
        0,
        Math.min(
          voucherCreditApplied,
          Math.max(0, preCreditTotals.subtotalAfterDiscount - actualStoreCreditApplied)
        )
      );
      const totals = computeCartTotals(cart, {
        pricingTier,
        storeCreditApplied: actualStoreCreditApplied,
        voucherCreditApplied,
        vatRate,
      });
      // Accounting Invariant: gross catalog value (signed for return/exchange
      // items); total is the net due incl. VAT (ttc), never negative.
      const grossSubtotal = totals.grossSubtotal;
      const discountTotal = totals.discountTotal;
      const taxAmount = totals.tax;
      const total = totals.total;
      // B-026: when returns dominate, net is negative and ttc clamps to 0 —
      // the signed shortfall must still leave the drawer as cash-out.
      const refundDue = totals.refundDue;

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
        const debtLimit = currentCustomer.debtLimit ?? DEFAULT_CREDIT_LIMIT;
        const projectedDebt = (currentCustomer.currentDebt || 0) + creditDebtAmount;
        if (projectedDebt > debtLimit) {
          return { success: false, reason: `CREDIT_LIMIT_EXCEEDED:${debtLimit}` };
        }
      }

      // Validate cash is sufficient (excluding credit and store credit)
      const directTendered = tenders
        ? tenders
            .filter((t: PaymentTender) => t.method !== 'Avoir Client' && t.method !== 'Crédit Client')
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
        const lineProfit = fifoPreview ? ((unitPriceCharged - cost) * item.quantity) : (item.lineProfit ?? ((unitPriceCharged - cost) * item.quantity));
        return {
          ...item,
          unitCostPrice: cost,
          unitCostAtSale: cost,
          unitPriceCharged,
          defaultPrice,
          discountAmount,
          lineProfit,
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

      if (currentCustomer) {
        // Effective loyalty config: merchant settings merged over defaults.
        const loyaltyCfg = normalizeLoyaltyConfig(get().receiptSettings?.loyaltyConfig);
        const earnAllowed = isEarnAllowed(loyaltyCfg);
        const currentTotalSpent = currentCustomer.totalSpent || 0;
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

        const existingBuckets = currentCustomer.pointBuckets || [];
        // B-024: same config rate as void restore — hardcoded /10 drifted
        // when merchant customized pointRedemptionRate. Normalized (never 0:
        // a raw zero would divide by zero into Infinity and drain all buckets).
        const redemptionRate = loyaltyCfg.pointRedemptionRate;
        const pointsToRedeem = Math.floor(actualStoreCreditApplied / redemptionRate);
        const { updatedBuckets } = depleteFifoPointBuckets(existingBuckets, pointsToRedeem);

        const finalBuckets = [...updatedBuckets];
        if (earnedPoints > 0) {
          finalBuckets.push(
            createDatedPointBucket(
              currentCustomer.id,
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
          currentCustomer.id,
          currentTotalSpent,
          newTotalSpent,
          loyaltyCfg,
          currentCustomer.ledger || [],
          0
        );
        const earnedCreditBonus = milestoneEval.totalReward;

        const newCredit = Math.max(0, currentCustomer.storeCredit - actualStoreCreditApplied) + earnedCreditBonus;
        const newPoints = Math.max(0, currentCustomer.loyaltyPoints - pointsToRedeem) + earnedPoints;
        const newDebt = (currentCustomer.currentDebt || 0) + creditDebtAmount;
        for (const e of milestoneEval.entries) e.balanceAfter = newPoints;
        completedMilestoneAwards = milestoneEval.awards;

        const newEntries: LoyaltyLedgerEntry[] = [];
        if (actualStoreCreditApplied > 0) {
          newEntries.push(
            createLedgerEntry(
              currentCustomer.id,
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
              currentCustomer.id,
              'earn',
              earnedPoints,
              newPoints,
              `Gain points (${earnedPoints} pts) sur Ticket #${receiptNumber}`,
              transactionId
            )
          );
        }
        for (const e of milestoneEval.entries) newEntries.push(e);

        const existingLedger = currentCustomer.ledger || [];
        // P2.3 ledger anchor: freeze the pre-upgrade scalar balance once so
        // the sync-merge path can derive credit from ledger deltas. One-time
        // per customer (key-deduped); a no-op for everyone else.
        const genesisEntry = ensureCreditGenesis({
          ...currentCustomer,
          storeCredit: newCredit,
          ledger: [...newEntries, ...existingLedger],
        });
        updatedCustomer = {
          ...currentCustomer,
          totalSpent: newTotalSpent,
          loyaltyTier: newTier.name,
          loyaltyPoints: newPoints,
          storeCredit: newCredit,
          currentDebt: newDebt,
          pointBuckets: finalBuckets,
          ledger: genesisEntry ? [genesisEntry, ...newEntries, ...existingLedger] : [...newEntries, ...existingLedger],
        };

        if (creditDebtAmount > 0) {
          debtEntry = {
             id: newId('DEBT'),
            customerId: currentCustomer.id,
            customerName: currentCustomer.name,
            type: 'DEBT_ACQUIRED',
            amount: creditDebtAmount,
            balanceAfter: newDebt,
            receiptNumber,
            paymentMethod: 'Crédit Client',
            notes: `Vente à Crédit #${receiptNumber} - Transaction #${transactionId}`,
            createdAt: new Date().toISOString(),
            // Attribution follows mid-shift handovers: currentCashier (set via
            // setShiftCashier) wins when present, cashierName is the fallback.
            recordedBy:
              (activeShift as unknown as { currentCashier?: string } | null | undefined)?.currentCashier?.trim() ||
              activeShift?.cashierName ||
              'Caisse Principale',
          };
          newCustomerDebts = [debtEntry, ...newCustomerDebts];
        }

        const finalCust = updatedCustomer;
        updatedCustomers = customers.map((c) => (c.id === finalCust.id ? finalCust : c));
      }

      // P11.3: device id lives in the sync layer; load it lazily at checkout time.
      const { getStableDeviceId } = await import('../../sync/device');
      const currentDeviceId = await getStableDeviceId().catch(() => 'default');
      const transaction: SaleTransaction = {
        id: transactionId,
        receiptNumber: receiptNumber,
        customer: updatedCustomer,
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
        cashTendered: tenders ? tenders.reduce((acc: number, t: PaymentTender) => acc + t.amount, 0) : cashTendered,
        changeDue,
        createdAt: new Date().toISOString(),
        cashierName: activeShift?.cashierName || 'Caisse Principale',
        debtAdded: creditDebtAmount > 0 ? creditDebtAmount : undefined,
        debtRemainingTotal: updatedCustomer?.currentDebt,
        deviceId: currentDeviceId,
        device_id: currentDeviceId,
        // Owning cash session, stamped from the live OPEN row (the
        // NO_ACTIVE_SHIFT gate above guarantees one). Closes scope by window
        // with this id as the attribution tiebreak.
        shiftId: activeShift?.id ?? undefined,
        // Persisted for void/refund credit-back (not envelope-only): without
        // these on the row, cancelling a voucher-paid sale burns bearer value.
        ...(voucherCode ? { voucherCode, voucherCreditApplied } : {}),
        // At-sale loyalty campaign multiplier (see earn site above): void and
        // refund reversals deduct exactly what was earned. Absent on legacy
        // rows, which fall back to currently-active campaigns.
        ...(earnCampaignMult > 1 ? { loyaltyCampaignMultiplier: earnCampaignMult } : {}),
        // Immutable milestone snapshots: clawbacks reverse these recorded
        // amounts, never live config. Absent on legacy rows, which fall
        // back to ledger grant snapshots.
        ...(completedMilestoneAwards.length > 0 ? { milestoneAwards: completedMilestoneAwards } : {}),
      };

      const newTransactions = [transaction, ...transactions];

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
            tax: taxAmount,
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
            tax: taxAmount,
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
          const saved = await persistWithRetryOnce(() =>
            getCustomerRepo().then((repo) => repo.save(updatedCustomer))
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

      // Track sold serialized items in Dexie and store
      const soldImeis = frozenCartItems
        .filter((ci) => Boolean(ci.imeiNumber && ci.imeiNumber.trim()))
        .map((ci) => ({
          imei: ci.imeiNumber!.trim(),
          productId: ci.product?.id || '',
        }));

      let nextImeiRecords = get().imeiRecords || [];
      if (soldImeis.length > 0) {
        try {
            const { db: dexieDb } = await import('../../db/database');
          for (const si of soldImeis) {
            const existing = await dexieDb.imeiRecords.get(si.imei);
            const rec: IMEIRecord = existing || {
              imei: si.imei,
              productId: si.productId,
              receivedAt: transaction.createdAt,
            };
            rec.saleTransactionId = transaction.id;
            rec.soldAt = transaction.createdAt;
            await dexieDb.imeiRecords.put(rec);
          }
          nextImeiRecords = nextImeiRecords.map((r) => {
            const match = soldImeis.find((s) => s.imei === r.imei);
            return match ? { ...r, saleTransactionId: transaction.id, soldAt: transaction.createdAt } : r;
          });
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
        activeModal: null,
        lastTransaction: transaction,
        hardwareStatus: { ...get().hardwareStatus, cashDrawerOpen: true },
      });
      // Clear the staged voucher credit with the sale (runtime-only keys).
      (set as unknown as (p: Record<string, unknown>) => void)({
        voucherCreditApplied: 0,
        voucherCode: null,
      });

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
    const totals = computeCartTotals(cart, {
      pricingTier,
      storeCreditApplied,
      voucherCreditApplied,
      vatRate: readVatRate(get()),
    });
    // Carry the staged wallet credit as an explicit tender leg (mirrors
    // PaymentModal): without it the staging-drop guard aborts, and without
    // the guard the credit would silently vanish from the write.
    const avoirLeg =
      Math.max(0, Math.round(Number(storeCreditApplied) || 0)) > 0
        ? [{ method: 'Avoir Client' as const, amount: Math.max(0, Math.round(Number(storeCreditApplied) || 0)) }]
        : [];
    return await processPayment([{ method: 'Espèces', amount: totals.total }, ...avoirLeg]);
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

    const updatedTransactions = transactions.map((t) => (t.id === transactionId ? voidedTxn : t));

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
        auditEntry
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
      const { enqueueOrderSync } = await import('../../db/sqlPluginAdapter');
      // Status flip FIRST: its in-transaction ALREADY_VOIDED re-read trips
      // before any compensating delta is appended, so a racing duplicate void
      // cannot double-restore stock. Push the FULL voided transaction: a
      // minimal payload would overwrite the cloud receipt and wipe line items
      // on peer devices at pull time.
      await enqueueOrderSync(transactionId, {
        ...voidedTxn,
        receipt_number: voidedTxn.receiptNumber,
        created_at: voidedTxn.createdAt,
      } as unknown as Record<string, unknown>);
        const { appendInventoryDeltas } = await import('../../db/sqlPluginAdapter');
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
      // here (ALREADY_VOIDED trips at enqueueOrderSync above).
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
      const { syncManager } = await import('../../sync/SyncManager');
      syncManager.notifyLocalWrite();
    } catch (e) {
      if (e instanceof Error && e.message === 'ALREADY_VOIDED') {
        return { success: false, reason: 'ALREADY_VOIDED' };
      }
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

    const nextImeiRecords = (get().imeiRecords || []).map((r) =>
      restoredImeis.includes(r.imei)
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

    // Physical returns kept out of stock (rebut/defective) move value off the
    // books with no compensating entry — they must carry a reason note.
    const hasNonRestocked = refundItems.some((i) => !i.restock);
    if (hasNonRestocked && !(refundReason && refundReason.trim())) {
      return { success: false, reason: 'RESTOCK_REASON_REQUIRED' };
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
    const priorRecovery = (transactions || [])
      .filter((t) => t.isRefund && t.originalTransactionId === originalTransaction.id)
      .reduce((acc, t) => acc + (Number(t.total) || 0), 0);
    const funding = computeRefundFundingSplit(originalTransaction, refundTotal, priorRecovery);
    const netRefund = funding.netRefund;
    // Cash disbursed through THIS refund by method. Non-cash methods never
    // touch the drawer; avoir value always returns to the wallet (never
    // cashed out), voucher/debt via their own lanes below.
    const cashOut = refundMethod === 'Espèces' ? funding.cashShare : 0;
    const walletAddBase =
      funding.avoirShare + (refundMethod === 'Avoir Client' ? funding.cashShare : 0);

    const refundQtyMap = new Map<string, number>();
    for (const item of refundItems) {
      // Services carry no stock identity — restocking them collapses their
      // 999999 standby stock (same guard as void).
      if (item.restock && !isUnstockedProduct(item.productId, products)) {
        refundQtyMap.set(item.productId, (refundQtyMap.get(item.productId) || 0) + item.quantity);
      }
    }

    const costRefundTotal = refundItems.reduce((acc, ri) => {
      const prod = products.find((p) => p.id === ri.productId);
      const unitCost = prod ? getEffectiveCostPrice(prod) : getEffectiveCostPrice({ price: ri.unitPrice });
      return acc + unitCost * ri.quantity;
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
      .filter((i) => i.restock)
      .map((i) => i.imeiNumber?.trim())
      .filter((imei): imei is string => Boolean(imei && imei.length > 0));

    let updatedCustomer: Customer | undefined = undefined;
    let updatedCustomers = customers;

    const origCust = originalTransaction.customer;
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
      const { updatedBuckets: refundBuckets, residualHeadlineDeduction } = shrinkEarnBucketForRefund(
        cust.pointBuckets || [],
        originalTransaction.receiptNumber,
        pointsToDeduct
      );
      const newPoints = Math.max(0, (cust.loyaltyPoints || 0) - residualHeadlineDeduction);
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

      const creditToAdd = walletAddBase;
      const newCredit = (cust.storeCredit || 0) + creditToAdd - claw.totalRevoked;

      const ledgerEntries: LoyaltyLedgerEntry[] = [];
      if (creditToAdd > 0) {
        ledgerEntries.push(
          createLedgerEntry(
            cust.id,
            'conversion',
            0,
            newPoints,
            `Émission Avoir Client (${creditToAdd} DA) suite au retour Ticket #${originalTransaction.receiptNumber}`,
            originalTransaction.id,
            creditToAdd
          )
        );
      }
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

      for (const e of claw.entries) ledgerEntries.push(e);

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
    const canonicalKey = canonicalRefundItems
      .map((i) => `${i.productId}:${i.quantity}:${Math.round(i.unitPrice ?? 0)}:${i.restock ? 1 : 0}`)
      .join(',');
    const refundReceiptNumber = newReceiptNumber('AVOIR');
    const refundTxnId = deterministicId('REF', originalTransaction.id, canonicalKey, refundMethod, Math.round(refundTotal));

    // Online compensation claim (ad.md §10): when reachable, claim the
    // deterministic refund id in the cloud BEFORE paying out. A peer till
    // refunding the same items holds the same claim id — the loser aborts
    // here instead of double-paying. Offline (or claim-table trouble) the
    // payout proceeds: offline-first is inviolable and deterministic ids
    // guarantee the books still converge.
    try {
      const { tryClaimCompensation } = await import('../../sync/claims');
      const claim = await tryClaimCompensation('REFUND', `CLAIM-${refundTxnId}`, originalTransaction.id);
      if (!claim.claimed && claim.reason === 'HELD_BY_PEER') {
        return { success: false, reason: 'REFUND_ALREADY_IN_PROGRESS' };
      }
    } catch (claimErr) {
      console.warn('[refund:claim] claim skipped, proceeding offline-first:', claimErr);
    }

    const refundTransaction: SaleTransaction = {
      id: refundTxnId,
      receiptNumber: refundReceiptNumber,
      status: 'COMPLETED',
      isRefund: true,
      originalReceiptNumber: originalTransaction.receiptNumber,
      originalTransactionId: originalTransaction.id,
      refundReason,
      refundMethod,
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
      // Money truth: the NET value reversed (never the gross — gross
      // includes discounts/credits the customer never paid). The drawer
      // lane reads cashDisbursed (exact cash out); revenue lanes read
      // total (value reversed). Legacy rows without cashDisbursed keep
      // the old total===cash reading via the cashTerms fallback.
      total: netRefund,
      cashDisbursed: cashOut,
      costTotal: costRefundTotal,
      profit: 0,
      profitMargin: 0,
      pricingTier: originalTransaction.pricingTier,
      paymentMethod: refundMethod,
      cashTendered: cashOut,
      changeDue: 0,
      createdAt: new Date().toISOString(),
    };

    const totalOrigItems = (originalTransaction.items || []).reduce((acc, i) => acc + i.quantity, 0);
    const totalRefundedItems = refundItems.reduce((acc, i) => acc + i.quantity, 0);
    const isFullyRefunded = totalRefundedItems >= totalOrigItems;

    const updatedOriginalTransaction: SaleTransaction = {
      ...originalTransaction,
      status: isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    };

    const updatedTransactions = [
      refundTransaction,
      ...transactions.map((t) => (t.id === originalTransaction.id ? updatedOriginalTransaction : t)),
    ];

    const auditEntry: SecurityAuditLogEntry = {
      id: newId('AUDIT'),
      timestamp: new Date().toISOString(),
      user: cashierName || 'Manager',
      action: 'Remboursement / Avoir Émis',
      details: `Avoir #${refundReceiptNumber} (net ${netRefund} DA, brut ${refundTotal} DA, espèces ${cashOut} DA en ${refundMethod}) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}`,
      requiresPin: true,
    };

    try {
      await (await getSqlite()).processRefundAtomic(
        refundTransaction,
        updatedOriginalTransaction,
        restockedProducts,
        updatedCustomer,
        restoredImeis,
        auditEntry
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('REFUND_EXCEEDS')) return { success: false, reason: 'REFUND_EXCEEDS_PURCHASED' };
      if (msg === 'ALREADY_PROCESSING') return { success: false, reason: 'ALREADY_PROCESSING' };
      if (msg === 'ORIGINAL_VOIDED') return { success: false, reason: 'ORIGINAL_VOIDED' };
      console.error('Failed to process refund atomically:', err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }

    // Sync-lane writes for the refund (ledger deltas, batch restitution,
    // outbox rows). Failures here warn explicitly instead of vanishing.
    const refundWarnings: string[] = [];
    try {
      const restocked = refundItems.filter((i) => i.restock && i.quantity > 0 && !isUnstockedProduct(i.productId, products));
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

        // Quarantine / SAV write-off (Condition Défectueux): no sellable
        // stock movement happened above for these lines (they were excluded
        // from `restocked`). Log their historical cost as an inventory loss
        // so the P&L reflects it in operating charges — never in sales COGS
        // (refund vouchers carry cost 0) and never in the cash drawer
        // (paymentMethod 'Autre' is excluded from Espèces reconciliation).
        const defective = refundItems.filter(
          (i) => (i.condition ?? (i.restock ? 'restock' : 'defective')) === 'defective' && i.quantity > 0
        );
        if (defective.length > 0) {
          try {
            const { addStoreExpense } = get() as unknown as {
              addStoreExpense: (e: {
                category: 'Perte Stock / SAV'; title: string; amount: number;
                paymentMethod: 'Autre'; notes?: string; recordedBy: string;
              }) => Promise<unknown>;
            };
            for (const di of defective) {
              const origLine = findOrigLine(di);
              const lossUnitCost = Math.max(
                0,
                Math.round(
                  origLine?.unitCostAtSale ?? origLine?.unitCostPrice
                  ?? products.find((p) => p.id === di.productId)?.costPrice
                  ?? di.unitPrice ?? 0
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
            refundWarnings.push("Rebut SAV : perte stock à comptabiliser manuellement dans les charges.");
          }
        }
      }
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
          // Net value reversed (money truth); drawer outflow is cashOut.
          total: netRefund,
          cost_total: costRefundTotal,
          profit: 0,
          profit_margin: 0,
          pricing_tier: originalTransaction.pricingTier,
          payment_method: refundMethod,
          cash_tendered: cashOut,
          change_due: 0,
          status: 'COMPLETED',
          created_at: refundTransaction.createdAt,
        },
        fullTx: refundTransaction as unknown as Record<string, unknown>,
        items: canonicalRefundItems.map((ri, idx) => ({
          id: `${refundTxnId}-item-${idx}`,
          product_id: ri.productId,
          quantity: ri.quantity,
          applied_price: ri.unitPrice,
          discount: 0,
          imei_number: ri.imeiNumber ?? null,
          cost_price: 0,
        })),
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

    // Machine-readable payout tag for the both-offline convergence detector
    // (payoutWatch) + immediate local check against already-pulled peer rows.
    let refundPayoutTag = '';
    try {
      const { getStableDeviceId } = await import('../../sync/device');
      const { payoutTag } = await import('../../sync/payoutWatch');
      const devId = await getStableDeviceId().catch(() => 'default');
      refundPayoutTag = ` ${payoutTag(`REF:${refundTxnId}`, refundMethod, Math.round(cashOut), devId)}`;
    } catch {
      // Tag best-effort — the refund itself must never fail over a marker.
    }
    logSecurityAction(
      'Remboursement / Avoir Émis',
      `Avoir #${refundReceiptNumber} (net ${netRefund} DA, espèces ${cashOut} DA en ${refundMethod}) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}${refundPayoutTag}`,
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
    if (refundMethod === 'Espèces') {
      audioBus.emit('cashDrawer');
    }

    const nextImeiRecords = (get().imeiRecords || []).map((r) =>
      restoredImeis.includes(r.imei)
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
        refundMethod === 'Espèces' ? { ...get().hardwareStatus, cashDrawerOpen: true } : get().hardwareStatus,
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
