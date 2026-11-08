import type { StateCreator } from 'zustand';
import type { PosState, CustomerSlice } from '../types';
import type { Customer, CustomerDebtEntry, ActivePriceBook } from '../../types/pos';
import {
  convertPointsToCredit,
  createLedgerEntry,
  canRedeemPoints,
  depleteFifoPointBuckets,
  normalizeLoyaltyConfig,
  isRedeemAllowed,
  redeemablePointBalance,
  STORE_CREDIT_PIN_THRESHOLD_DZD,
} from '../../utils/loyaltyEngine';
import {
  allocateRepaymentFifo,
  applyPaymentToPlanEntries,
  buildInstallmentPlan,
  computeReliabilityScore,
  daysOverdue,
  dunningLaunchGate,
  DUNNING_STAGES,
  KREDY_DUNNING_STALE_CLAIM_MS,
  KREDY_LAUNCH_STATUS,
  nextDunningStage,
  outstandingItemsFromEntries,
} from '../../utils/kredyEngine';
import { DebtNotificationEngine } from '../../utils/debtNotificationEngine';
import { audioBus } from '../../utils/audioEvents';
import { newId, newReceiptNumber, debtDepositMovementId } from '../../utils/ids';
import { verifyManagerGate } from '../../utils/pinGate';

// ══════════════════════════════════════════════════════════════
// UNIFIED CREDIT LIMIT (integer DZD). Single source of truth for
// the default per-customer credit ceiling — DebtLedgerModal,
// KredyTab and the desktop/mobile credit checks must resolve an
// absent debtLimit through getEffectiveDebtLimit(), never through
// a local `|| 50000` / `?? Infinity` fallback.
// (PaymentModal + MobileCheckoutTab still carry their own local
// fallback — owned by another agent; adopt this constant there.)
// ══════════════════════════════════════════════════════════════
export const DEFAULT_CREDIT_LIMIT = 100000;

/** Effective ceiling: explicit per-customer limit, else the unified default. */
export const getEffectiveDebtLimit = (
  customer: { debtLimit?: number } | null | undefined
): number => customer?.debtLimit ?? DEFAULT_CREDIT_LIMIT;

// P11.3: customerRepository pulls sqliteAdapter -> dexie + libsql into the entry.
async function getCustomerRepo() {
  const { customerRepository } = await import('../../db/repositories/customerRepository');
  return customerRepository;
}

export const createCustomerSlice: StateCreator<PosState, [], [], CustomerSlice> = (set, get) => ({
  customers: [],
  currentCustomer: null,
  customerDebts: [],
  customerPriceBook: null,

  addCustomer: async (input) => {
    const { customers } = get();
    const newCustomer: Customer = {
      ...(input as Omit<Customer, 'id'>),
      id: input.id || newId('cust'),
    };
    const updated = [newCustomer, ...customers];
    try {
      await (await getCustomerRepo()).save(newCustomer);
      set({ customers: updated });
    } catch (err) {
      console.error('Failed to add customer:', err);
    }
  },

  updateCustomer: async (id, updates) => {
    const { customers, currentCustomer, logSecurityAction } = get();
    const existing = customers.find((c) => c.id === id);
    if (!existing) {
      return { success: false, reason: 'CUSTOMER_NOT_FOUND' };
    }
    const target = { ...existing, ...updates };
    // Persist BEFORE set: a failed authority write must not leave the UI
    // showing a profile the database never recorded (C6).
    try {
      await (await getCustomerRepo()).save(target);
    } catch (err) {
      console.error(`Failed to update customer [${id}]:`, err);
      return { success: false, reason: 'DB_SAVE_FAILED' };
    }
    // Money-relevant profile mutations (credit limit, balances) are audited;
    // plain identity edits (name/phone) stay quiet to avoid audit spam.
    const moneyKeys = (Object.keys(updates || {}) as string[]).filter((k) =>
      ['debtLimit', 'storeCredit', 'currentDebt', 'loyaltyPoints'].includes(k)
    );
    if (moneyKeys.length > 0) {
      await logSecurityAction(
        'Modification Financière Client',
        `Client: ${existing.name} — ${moneyKeys
          .map((k) => `${k}: ${(existing as unknown as Record<string, unknown>)[k]} → ${(updates as unknown as Record<string, unknown>)[k]}`)
          .join(', ')}.`,
        'Système POS',
        true
      );
    }
    const updated = customers.map((c) => (c.id === id ? target : c));
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === id) {
      newState.currentCustomer = { ...currentCustomer, ...updates };
      if (updates.pricingTier) newState.pricingTier = updates.pricingTier;
    }
    set(newState as PosState);
    return { success: true };
  },

  deleteCustomer: async (id, opts?: { forfeitNote?: string }) => {
    const { customers, currentCustomer, logSecurityAction } = get();
    const customerToDelete = customers.find((c) => c.id === id);
    if (customerToDelete && (customerToDelete.currentDebt || 0) > 0) {
      await logSecurityAction(
        'Suppression Client Bloquée (Dette Active)',
        `Client: ${customerToDelete.name} possède une dette non soldée de ${customerToDelete.currentDebt} DA. Suppression refusée pour préserver l'intégrité comptable.`,
        'Système POS',
        true
      );
      return { success: false, reason: 'ACTIVE_DEBT' };
    }
    // A positive store credit is a customer asset — deleting the profile
    // would silently erase it. Require an explicit forfeit note (typed by a
    // manager at the UI) before the delete proceeds.
    const credit = customerToDelete ? customerToDelete.storeCredit || 0 : 0;
    const forfeitNote = opts?.forfeitNote?.trim();
    if (customerToDelete && credit > 0 && !forfeitNote) {
      await logSecurityAction(
        'Suppression Client Bloquée (Avoir Actif)',
        `Client: ${customerToDelete.name} possède un avoir non soldé de ${credit} DA. Suppression refusée : exiger une note de confiscation explicite avant suppression.`,
        'Système POS',
        true
      );
      return { success: false, reason: 'STORE_CREDIT_ACTIVE' };
    }
    if (customerToDelete && credit > 0 && forfeitNote) {
      await logSecurityAction(
        'Avoir Client Confisqué (Suppression Client)',
        `Client: ${customerToDelete.name} — avoir de ${credit} DA abandonné avant suppression. Note: ${forfeitNote}`,
        'Système POS',
        true
      );
    }
    const updated = customers.filter((c) => c.id !== id);
    try {
      // Surface the SQLite authority result: customerAdapter.deleteCustomer
      // returns false (instead of throwing) when the tombstone write fails.
      // Deleting from UI state on a false return would orphan money (C6).
      const { sqliteAdapter } = await import('../../db/sqliteAdapter');
      const deleted = await sqliteAdapter.deleteCustomer(id);
      if (!deleted) {
        console.error(`SQLite tombstone failed for customer [${id}] — delete refused`);
        return { success: false, reason: 'DB_DELETE_FAILED' };
      }
      const newState: Partial<PosState> = { customers: updated };
      if (currentCustomer?.id === id) {
        newState.currentCustomer = null;
        newState.pricingTier = 'Retail';
      }
      set(newState as PosState);
    } catch (err) {
      console.error(`Failed to delete customer [${id}]:`, err);
      return { success: false, reason: 'DB_DELETE_FAILED' };
    }
    return { success: true };
  },

  setCurrentCustomer: (customer) => {
    if (customer) {
      set({ currentCustomer: customer, pricingTier: customer.pricingTier || 'Retail' });
    } else {
      set({ currentCustomer: null, pricingTier: 'Retail' });
    }
    // UPGRADE-04: resolve the attached customer's contract price book and
    // reprice the cart when the resolved book actually changed. Fire-and-
    // forget: a slow/absent SQLite read must never block the UI; on failure
    // the book stays null (tier pricing — fail open to the standard ladder).
    void get().refreshCustomerPriceBook();
  },

  refreshCustomerPriceBook: async () => {
    const prev = get().customerPriceBook;
    const customerId = get().currentCustomer?.id ?? null;
    let next: ActivePriceBook | null = null;
    if (customerId) {
      try {
        const { getActivePriceBookForCustomer } = await import('../../db/adapters/priceBookAdapter');
        next = await getActivePriceBookForCustomer(customerId);
      } catch {
        next = null;
      }
    }
    const keyOf = (book: ActivePriceBook | null): string =>
      book
        ? `${book.id}|${book.items.map((i) => `${i.productId}:${i.unitPrice}:${i.minQty}`).join(',')}`
        : '';
    const changed = keyOf(prev) !== keyOf(next);
    set({ customerPriceBook: next });
    if (changed) {
      // Re-derive cart line prices against the new contract base. Same
      // semantics as a tier switch: manual price overrides are preserved,
      // plain per-line discounts are recomputed (setPricingTier is the one
      // reprice lane — never a second pricing implementation).
      get().setPricingTier(get().pricingTier);
    }
  },

  issueStoreCredit: async (customerId, amount, managerPin?: string) => {
    const { customers, currentCustomer, logSecurityAction } = get();
    // Write-layer hardening: integer DZD only; non-positive amounts are
    // rejected (a negative amount here was a silent confiscation).
    const rounded = typeof amount !== 'number' || isNaN(amount) || !isFinite(amount) ? 0 : Math.round(amount);
    if (rounded <= 0) {
      return { success: false, reason: 'INVALID_AMOUNT' };
    }
    const existing = customers.find((c) => c.id === customerId);
    if (!existing) {
      return { success: false, reason: 'CUSTOMER_NOT_FOUND' };
    }
    // Large emissions mint uncapped credit: require the manager override PIN
    // (Phase 1: native gate, fail-closed — same bar as the cart
    // price-override flow).
    if (rounded > STORE_CREDIT_PIN_THRESHOLD_DZD) {
      if (!managerPin) {
        return { success: false, reason: 'MANAGER_PIN_REQUIRED' };
      }
      const gate = await verifyManagerGate(managerPin);
      if (!gate.ok) {
        await logSecurityAction(
          'Émission Avoir Refusée (PIN Manager)',
          `Client: ${existing.name} — émission de ${rounded} DA refusée (${gate.locked ? 'PIN verrouillé' : 'PIN incorrect'}).`,
          'Système POS',
          true
        );
        return { success: false, reason: 'INVALID_MANAGER_PIN' };
      }
    }
    // Ledger-derived balance coverage: manual emissions are credit
    // movements (+rounded) recorded as conversion deltas.
    const creditEntry = createLedgerEntry(
      customerId,
      'conversion',
      0,
      existing.loyaltyPoints || 0,
      `Émission manuelle d'Avoir Client (+${rounded} DA)`,
      undefined,
      rounded
    );
    const updated = customers.map((c) =>
      c.id === customerId
        ? { ...c, storeCredit: (c.storeCredit || 0) + rounded, ledger: [creditEntry, ...(c.ledger || [])] }
        : c
    );
    const target = updated.find((c) => c.id === customerId);
    if (target) {
      try {
        await (await getCustomerRepo()).save(target);
      } catch (err) {
        console.error(`Failed to save store credit for customer [${customerId}]:`, err);
        return { success: false, reason: 'DB_SAVE_FAILED' };
      }
    }
    if (rounded > STORE_CREDIT_PIN_THRESHOLD_DZD) {
      await logSecurityAction(
        'Émission Avoir Client (Montant Élevé)',
        `Client: ${existing.name} — avoir de ${rounded} DA émis sous validation Manager.`,
        'Système POS',
        true
      );
    } else {
      // Below-threshold emissions mint real spendable value too — audit them
      // (non-PIN). Previously only large emissions were logged, leaving a
      // stream of small unlogged credit minting.
      await logSecurityAction(
        'Émission Avoir Client',
        `Client: ${existing.name} — avoir de ${rounded} DA émis.`,
        'Système POS',
        false
      );
    }
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === customerId) {
      newState.currentCustomer = {
        ...currentCustomer,
        storeCredit: (currentCustomer.storeCredit || 0) + rounded,
        ledger: [creditEntry, ...(currentCustomer.ledger || [])],
      };
    }
    set(newState as PosState);
    return { success: true, credited: rounded };
  },

  redeemLoyaltyPoints: async (customerId, points, saleTotal?: number) => {
    const { customers, currentCustomer, logSecurityAction, receiptSettings } = get();
    const customer = customers.find((c) => c.id === customerId);
    const want = Math.floor(isNaN(points) ? 0 : points);
    // Master-switch gate: redemptions are refused unless the program allows
    // them (enabled, or disabled in earn-off-redeem-on mode).
    const loyaltyCfg = normalizeLoyaltyConfig(receiptSettings?.loyaltyConfig);
    if (!isRedeemAllowed(loyaltyCfg)) {
      return { success: false, reason: 'LOYALTY_DISABLED' };
    }
    // Enforces minimumRedemptionPoints always, and
    // maximumRedemptionPercentPerSale when the net sale total is provided.
    // Expired bucket stock is not spendable (LOY-07): bound the redemption by
    // the LIVE bucket balance, not the cached headline. No buckets = legacy
    // headline (nothing dated to contradict it).
    const redeemable = redeemablePointBalance(
      customer?.pointBuckets,
      customer?.loyaltyPoints ?? 0,
    );
    const check = canRedeemPoints(redeemable, want, saleTotal, loyaltyCfg);
    if (!customer || !check.allowed) {
      return { success: false, reason: !customer ? 'CUSTOMER_NOT_FOUND' : check.reason };
    }

    const { creditAmount } = convertPointsToCredit(want, loyaltyCfg);
    // Converge the headline on the live stock: a successful redemption also
    // drops points that expired, so the dead total cannot linger forever.
    const newPoints = redeemable - want;
    const newCredit = (customer.storeCredit || 0) + creditAmount;

    // Keep FIFO buckets in sync with the headline balance (the checkout sale
    // path depletes them — a standalone conversion must do the same, else the
    // buckets permanently overstate the redeemable stock).
    const { updatedBuckets } = depleteFifoPointBuckets(customer.pointBuckets || [], want);

    const ledgerEntry = createLedgerEntry(
      customerId,
      'conversion',
      -want,
      newPoints,
      `Échange de ${want} pts contre ${creditAmount} DA d'Avoir Client`,
      undefined,
      creditAmount
    );

    const existingLedger = customer.ledger || [];
    const updatedCustomer: Customer = {
      ...customer,
      loyaltyPoints: newPoints,
      storeCredit: newCredit,
      // REF-15: remember which slice of the wallet was already paid for in
      // points, so checkout does not deduct those points a second time.
      creditFromPointsDzd: (customer.creditFromPointsDzd || 0) + creditAmount,
      pointBuckets: updatedBuckets,
      ledger: [ledgerEntry, ...existingLedger],
    };

    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    try {
      await (await getCustomerRepo()).save(updatedCustomer);
    } catch (err) {
      console.error(`Failed to save redeemed points for customer [${customerId}]:`, err);
      return { success: false, reason: 'DB_SAVE_FAILED' };
    }

    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
    await logSecurityAction(
      'Conversion Points → Avoir',
      `Client: ${customer.name} — ${want} pts convertis en ${creditAmount} DA d'avoir.`,
      'Système POS',
      false
    );
    return { success: true, creditAdded: creditAmount };
  },

  adjustCustomerPoints: async (customerId, points, description, managerPin) => {
    // Privileged operation: a point adjustment mints or destroys redeemable
    // value (points convert to store credit), so it needs a manager credential
    // verified natively - not merely a hidden button (LOY-12: any operator
    // could add 50 points with no PIN at all).
    const pin = String(managerPin ?? '').trim();
    if (pin.length < 4) {
      return { success: false, reason: 'MANAGER_PIN_REQUIRED' };
    }
    const gate = await verifyManagerGate(pin);
    if (!gate.ok) {
      return {
        success: false,
        reason: gate.locked
          ? 'MANAGER_LOCKED'
          : gate.reason === 'unavailable'
          ? 'MANAGER_VERIFY_UNAVAILABLE'
          : 'MANAGER_PIN_INCORRECT',
      };
    }
    // NOTE: manual manager adjustments intentionally bypass the program
    // master switch - they are operator corrections, not program earn.
    const { customers, currentCustomer, logSecurityAction } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) return { success: false, reason: 'CUSTOMER_NOT_FOUND' };
    if (points === 0) return { success: false, reason: 'INVALID_AMOUNT' };

    const newPoints = Math.max(0, customer.loyaltyPoints + points);
    const ledgerEntry = createLedgerEntry(
      customerId,
      points > 0 ? 'bonus' : 'adjustment',
      points,
      newPoints,
      description || (points > 0 ? 'Ajustement / Bonus de points' : 'Déduction de points')
    );

    const existingLedger = customer.ledger || [];
    const updatedCustomer: Customer = {
      ...customer,
      loyaltyPoints: newPoints,
      ledger: [ledgerEntry, ...existingLedger],
    };

    // Persist BEFORE set so a failed write never shows phantom points (C6).
    try {
      await (await getCustomerRepo()).save(updatedCustomer);
    } catch (err) {
      console.error(`Failed to adjust points for customer [${customerId}]:`, err);
      return { success: false, reason: 'DB_SAVE_FAILED' };
    }

    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
    await logSecurityAction(
      'Ajustement Points Fidélité',
      `Client: ${customer.name} — ${points > 0 ? '+' : ''}${points} pts (${description || 'ajustement manuel'}). Nouveau solde : ${newPoints} pts.`,
      'Système POS',
      false
    );
    return { success: true };
  },

  recordCustomerDebtPayment: async (customerId, amount, method, notes, opts?: { allowOverpayToCredit?: boolean; entryId?: string }) => {
    const { customers, customerDebts, currentCustomer, logSecurityAction, activeCashier } = get();
    const customer = customers.find((c) => c.id === customerId);
    // Session identity binding (no hardcoded cashier): the performing
    // cashier owns the debt row, the drawer deposit, and the audit entry.
    const settlerName = activeCashier?.name || 'Caissier';
    // Integer DZD only.
    const tendered = Math.max(0, isNaN(amount) ? 0 : Math.round(amount));
    if (!customer) return { success: false, reason: 'CUSTOMER_NOT_FOUND' };
    if (tendered <= 0) return { success: false, reason: 'INVALID_AMOUNT' };

    // Fresh re-read from the repository (SQLite authority): the in-memory
    // customer may be stale if a second till/device settled part of the debt
    // since this screen rendered. Computing against a stale balance would
    // over-apply the payment and corrupt the ledger (money integrity).
    const readFreshCustomer = async (): Promise<Customer | null> => {
      try {
        const all = await (await getCustomerRepo()).getAll();
        return all.find((c) => c.id === customerId) ?? null;
      } catch {
        return null;
      }
    };

    // Pure recompute of the payment against a base snapshot. Integer DZD.
    const buildPayment = (base: Customer) => {
      const baseDebt = Math.max(0, Math.round(base.currentDebt || 0));
      // Clamp the payment to the outstanding debt. Any overpay is change owed
      // back to the customer — it is NOT silently converted to store credit
      // unless the caller explicitly opts in AFTER confirming with the customer.
      const appliedAmount = Math.min(tendered, baseDebt);
      const changeDue = tendered - appliedAmount;
      const newDebt = baseDebt - appliedAmount;
      const overpayConvertedToCredit = opts?.allowOverpayToCredit === true ? changeDue : 0;
      const updatedStoreCredit = (base.storeCredit || 0) + overpayConvertedToCredit;

      // P6: collision-safe — the old `.slice(-6)` form repeated every ~16.7 min,
      // and the debt id had no sequence guard, so a same-ms double payment
      // silently overwrote the first ledger row (upsert, no error).
      const receiptNo = newReceiptNumber('VERS');
      // Single clock read per recompute — the ledger row, the score stamp and
      // the plan fill all carry the same instant.
      const nowIso = new Date().toISOString();
      // UPGRADE-11 (v126): FIFO repayment waterfall — settle the oldest due
      // date first (nulls last), then the lowest id. Pure and clock-
      // independent, so allocation ordering is stable across clock jumps; the
      // trail rides the ledger row (`allocations`).
      const waterfall = allocateRepaymentFifo(
        outstandingItemsFromEntries(customerDebts.filter((d) => d.customerId === base.id)),
        appliedAmount
      );
      const debtEntry: CustomerDebtEntry = {
        // Deterministic when the caller passes entryId (refund debt-relief):
        // same logical relief converges instead of doubling across devices.
        id: opts?.entryId || newId('DEBT'),
        customerId: base.id,
        customerName: base.name,
        type: 'PAYMENT_SETTLED',
        kind: 'VERSEMENT',
        amount: appliedAmount,
        balanceAfter: newDebt,
        receiptNumber: receiptNo,
        paymentMethod: method,
        notes:
          notes ||
          `Versement règlement de dette (${method}) — ${appliedAmount} DA appliqués` +
            (changeDue > 0
              ? overpayConvertedToCredit > 0
                ? ` (surplus ${overpayConvertedToCredit} DA en avoir, confirmé client)`
                : ` (monnaie rendue ${changeDue} DA)`
              : ''),
        createdAt: nowIso,
        recordedBy: settlerName,
        allocations: waterfall.allocations.length > 0 ? waterfall.allocations : undefined,
      };

      let newLedger = base.ledger || [];
      if (overpayConvertedToCredit > 0) {
        const creditLedgerEntry = createLedgerEntry(
          base.id,
          'conversion',
          0,
          base.loyaltyPoints,
          `Surplus versement dette (+${overpayConvertedToCredit} DA) crédité en Avoir Client, confirmé client (Réf ${receiptNo})`,
          undefined,
          overpayConvertedToCredit
        );
        newLedger = [creditLedgerEntry, ...newLedger];
      }

      // UPGRADE-11 (v126): persist the reliability score alongside the new
      // balance (the factor breakdown stays compute-on-read). Deterministic
      // for a given clock + ledger, so a clock jump re-scores, never rewrites.
      const score = computeReliabilityScore({
        nowIso,
        currentDebt: newDebt,
        debtLimit: getEffectiveDebtLimit(base),
        entries: [debtEntry, ...customerDebts.filter((d) => d.customerId === base.id)],
      });
      const updatedCustomer: Customer = {
        ...base,
        currentDebt: newDebt,
        storeCredit: updatedStoreCredit,
        ledger: newLedger,
        creditScore: score.score,
        creditScoreAt: nowIso,
      };
      return { baseDebt, appliedAmount, changeDue, newDebt, overpayConvertedToCredit, receiptNo, debtEntry, updatedCustomer };
    };

    // Conditional version-guarded save with ONE retry-on-conflict: adopt the
    // fresh balance when it moved under us (first recompute), persist; if the
    // persist itself races, re-read once more and retry a single time, else
    // return a conflict error so the cashier re-enters instead of double-settling.
    let base = customer;
    let conflictRetried = false;
    const freshFirst = await readFreshCustomer();
    if (freshFirst && Math.round(freshFirst.currentDebt || 0) !== Math.round(customer.currentDebt || 0)) {
      base = freshFirst;
      conflictRetried = true;
    }
    let built = buildPayment(base);
    if (built.baseDebt <= 0) {
      return { success: false, reason: 'NO_OUTSTANDING_DEBT', appliedAmount: 0, changeDue: tendered };
    }

    const persistPayment = async (): Promise<void> => {
        // P11.3: sqliteAdapter pulls the sync-enabled persistence layer; load on first write.
      // P11.3: write the money record (ledger row) BEFORE the customer aggregate.
      // If the process dies between the two writes, the ledger — the authoritative
      // money trail — survives and the debt can be reconciled from it. The reverse
      // order would silently lower a customer's debt with no matching ledger entry.
      const { sqliteAdapter } = await import('../../db/sqliteAdapter');
      await sqliteAdapter.saveCustomerDebt(built.debtEntry);
      await (await getCustomerRepo()).save(built.updatedCustomer);
      // UPGRADE-11 (v126): fill the customer's ACTIF installment plans from the
      // same applied amount (same write path as the balance update). Plan
      // metadata LAGS the money trail — the ledger row and balance are already
      // durable when this runs — so an aborted fill is continued by the next
      // payment instead of double-counting. Never fails the settled payment.
      try {
        const kredy = await import('../../db/sqlPluginAdapter');
        const plans = await kredy.listActiveDebtPlansForCustomer(built.debtEntry.customerId);
        if (plans.length > 0) {
          const planEntries = await kredy.listDebtPlanEntries(plans.map((p) => p.id));
          let remainder = built.appliedAmount;
          for (const plan of plans) {
            if (remainder <= 0) break;
            const applied = applyPaymentToPlanEntries(
              planEntries
                .filter((e) => e.planId === plan.id)
                .map((e) => ({ id: e.id, seq: e.seq, amount: e.amount, paidAmount: e.paidAmount })),
              remainder
            );
            remainder = applied.remaining;
            if (applied.updates.length > 0) {
              await kredy.updateDebtPlanEntries(
                applied.updates.map((u) => ({
                  id: u.id,
                  paidAmount: u.paidAmount,
                  paidAt: u.justPaid ? built.debtEntry.createdAt : null,
                }))
              );
            }
            if (applied.allPaid) {
              await kredy.setDebtPlanStatus(plan.id, 'SOLDE', built.debtEntry.createdAt);
            }
          }
        }
      } catch (planErr) {
        console.warn('[kredy] Plan fill after debt payment failed:', planErr);
      }
    };

    try {
      await persistPayment();
    } catch (err) {
      if (!conflictRetried) {
        const refetch = await readFreshCustomer();
        if (refetch && Math.round(refetch.currentDebt || 0) !== Math.round(base.currentDebt || 0)) {
          base = refetch;
          built = buildPayment(base);
          conflictRetried = true;
          if (built.baseDebt <= 0) {
            return { success: false, reason: 'NO_OUTSTANDING_DEBT', appliedAmount: 0, changeDue: tendered };
          }
          try {
            await persistPayment();
          } catch (err2) {
            console.error('Debt payment retry failed after conflict recompute:', err2);
            return { success: false, reason: 'DEBT_WRITE_CONFLICT' };
          }
        } else {
          console.error('Failed to save debt payment:', err);
          return { success: false, reason: 'DB_SAVE_FAILED' };
        }
      } else {
        console.error('Failed to save debt payment (already recomputed once):', err);
        return { success: false, reason: 'DEBT_WRITE_CONFLICT' };
      }
    }

    const { appliedAmount, changeDue, newDebt, overpayConvertedToCredit, receiptNo, debtEntry, updatedCustomer } = built;
    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    const updatedDebts = [debtEntry, ...customerDebts];

    // Auto-record drawer deposit if paid in cash during an active shift.
    // Only the APPLIED amount hits the drawer — change handed back to the
    // customer was never tendered into it.
    // B-035: commit UI state BEFORE the drawer step — debt is already durable
    // in SQLite; a failed deposit must not leave the store slice showing the
    // pre-settle balance (later saveCustomer would resurrect stale currentDebt).
    set({
      customers: updatedCustomers,
      currentCustomer: currentCustomer?.id === customerId ? updatedCustomer : currentCustomer,
      customerDebts: updatedDebts,
    });

    if (method === 'Espèces' && get().activeShift && appliedAmount > 0) {
      // P6: a failure here must not be silent — the debt ledger is already
      // written, so a lost drawer deposit would leave the books unbalanced
      // with no signal. Surface it to the caller via the result so the
      // cashier can re-record the deposit instead of discovering the gap at
      // shift close.
      // Idempotency: the movement id derives from the debt entry id, so a
      // double-submit race collapses via Dexie put-upsert + stable outbox key
      // instead of minting duplicate drawer rows (double-submit guard).
      const deposit = await get().logCashMovement(
        appliedAmount,
        'MANUAL_DEPOSIT',
        `Versement Règlement Dette: ${customer.name} (Ticket ${receiptNo})`,
        settlerName,
        debtDepositMovementId(debtEntry.id)
      );
      if (!deposit.success) {
        console.error('[debt] Drawer deposit failed after debt settlement:', deposit.reason);
        return { success: false, reason: 'DRAWER_DEPOSIT_FAILED', debtEntry, appliedAmount, changeDue };
      }
    }

    // P6: awaited — logSecurityAction now throws on a failed audit write.
    // Payout tag: debt settlements join the both-offline convergence
    // detector (payoutWatch) like refunds/voids. Entry-scoped id: two tills
    // settling the SAME debt create distinct entries (independent partial
    // payments are legitimate), so same-debt double-payment across tills
    // stays a known limitation — this tag makes every settlement traceable
    // and catches same-entry double-processing instead.
    // Audit idempotency (double-submit guard): same-entryId repeats are
    // replays — the native chain must never receive a second row for one
    // intent. Chain-safe: dedupe happens before append, chain bytes untouched.
    let debtPayoutTag = '';
    try {
      const { getStableDeviceId } = await import('../../sync/device');
      const { payoutTag } = await import('../../sync/payoutWatch');
      const devId = await getStableDeviceId().catch(() => 'default');
      debtPayoutTag = ` ${payoutTag(`DEBTPAY:${debtEntry.id}`, method, appliedAmount, devId)}`;
    } catch {
      // Tag best-effort — the settlement must never fail over a marker.
    }
    const { claimAuditKey } = await import('../../utils/auditIdempotency');
    if (claimAuditKey(`DEBT-SETTLE-${debtEntry.id}`)) {
      await logSecurityAction(
        'Règlement Dette Client Enregistré',
        `Client: ${customer.name} - Versement: ${appliedAmount} DA appliqués (${method})` +
          (changeDue > 0 ? ` - Monnaie rendue: ${changeDue} DA` : '') +
          ` - Dette restante: ${newDebt} DA${debtPayoutTag}`,
        settlerName,
        false,
        `DEBT-SETTLE-${debtEntry.id}`
      );
    }

    audioBus.emit('success');
    audioBus.emit('cashDrawer');

    // Convergence: re-derive the displayed debt from the ledger AFTER commit
    // so the number on screen always equals the durable trail — the same
    // derivation the peer device runs on pull (SyncManager step 2b).
    try {
      const { reconcileCustomerDebtFromLedger } = await import('../../db/sqlPluginAdapter');
      await reconcileCustomerDebtFromLedger([customerId]);
    } catch {
      // Display already updated above; reconcile is convergence hardening.
    }

    // Backward-compatible shape ({ success, debtEntry }) plus explicit
    // overpay info — old callers ignore the extra fields.
    return { success: true, debtEntry, appliedAmount, changeDue, overpayConvertedToCredit };
  },

  /**
   * UPGRADE-11 (v126): strictly 0 % / 0-fee integer-DZD installment plan,
   * bounded by the outstanding debt (Σ entries === total ≤ currentDebt).
   * Validation is the pure `buildInstallmentPlan` — this action only
   * persists. Plans are local-only operational rows (never synced).
   */
  createInstallmentPlan: async (customerId, input) => {
    const { customers, logSecurityAction, activeCashier } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) return { success: false, reason: 'CUSTOMER_NOT_FOUND' };
    const outstanding = Math.max(0, Math.round(customer.currentDebt || 0));
    if (outstanding <= 0) return { success: false, reason: 'NO_OUTSTANDING_DEBT' };
    const nowIso = new Date().toISOString();
    const built = buildInstallmentPlan({
      totalAmount: input.totalAmount,
      installments: input.installments,
      intervalDays: input.intervalDays,
      startIso: nowIso,
      outstandingDebt: outstanding,
    });
    if (!built.ok) return { success: false, reason: built.reason };
    const planId = newId('PLAN');
    const entries = built.plan.entries.map((e) => ({
      id: newId('DPE'),
      seq: e.seq,
      dueDate: e.dueDate,
      amount: e.amount,
    }));
    try {
      const { insertDebtPlanWithEntries } = await import('../../db/sqlPluginAdapter');
      await insertDebtPlanWithEntries(
        {
          id: planId,
          customerId: customer.id,
          totalAmount: built.plan.totalAmount,
          installments: built.plan.installments,
          intervalDays: built.plan.intervalDays,
          startDate: nowIso,
          notes: input.notes ?? null,
          createdAt: nowIso,
        },
        entries
      );
    } catch (err) {
      console.error(`[kredy] Failed to persist installment plan for [${customerId}]:`, err);
      return { success: false, reason: 'DB_SAVE_FAILED' };
    }
    const operator = activeCashier?.name || 'Caissier';
    await logSecurityAction(
      'Plan de Paiement Créé',
      `Client: ${customer.name} — ${built.plan.installments} versement(s), total ${built.plan.totalAmount} DA, tous les ${built.plan.intervalDays} j — 0 % sans frais`,
      operator,
      false
    );
    return { success: true, planId };
  },

  /**
   * UPGRADE-11 (v126): WhatsApp relance. `stage` = laddered dunning (quiet
   * hours + single-claim per stage); no stage = manual launch. Both require
   * the customer's WhatsApp opt-in. The launch log gets a row ONLY when the
   * launch actually resolved (`status: 'Lancé'`); a blocked popup releases
   * the claim and reports — the ledger never says "Envoyé".
   */
  launchDebtReminder: async (customerId, opts?: { stage?: 'R1' | 'R2' | 'R3' }) => {
    const { customers, customerDebts, receiptSettings, activeCashier, logSecurityAction } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) return { success: false, reason: 'CUSTOMER_NOT_FOUND' };
    const debt = Math.max(0, Math.round(customer.currentDebt || 0));
    if (debt <= 0) return { success: false, reason: 'NO_OUTSTANDING_DEBT' };
    if (customer.whatsappOptIn !== true) {
      return { success: false, reason: 'WHATSAPP_OPT_IN_REQUIRED', blocked: true };
    }
    const nowIso = new Date().toISOString();
    const stage = opts?.stage;
    const entries = customerDebts.filter((d) => d.customerId === customer.id);
    if (stage) {
      // Quiet hours (fail closed) + strict ladder: only the first un-launched
      // stage may fire, and only once eligible for its overdue age.
      const quiet = dunningLaunchGate(nowIso);
      if (!quiet.allowed) {
        return {
          success: false,
          reason: quiet.reason === 'INVALID_CLOCK' ? 'CLOCK_UNAVAILABLE' : 'QUIET_HOURS',
          blocked: true,
        };
      }
      const worstOverdue = outstandingItemsFromEntries(entries).reduce(
        (max, it) => Math.max(max, daysOverdue(it.dueDate, nowIso)),
        0
      );
      const kredy = await import('../../db/sqlPluginAdapter');
      const rows = await kredy.listDunningRows(customer.id);
      const launchedStages = rows.filter((r) => r.status === 'LANCEE').map((r) => r.stage);
      const eligible = nextDunningStage({ launchedStages, daysOverdue: worstOverdue });
      if (!eligible || eligible.id !== stage) {
        return { success: false, reason: 'STAGE_NOT_ELIGIBLE', blocked: true };
      }
      // Single-claim BEFORE opening WhatsApp: two taps can never double-send.
      const staleBeforeIso = new Date(Date.parse(nowIso) - KREDY_DUNNING_STALE_CLAIM_MS).toISOString();
      const claimed = await kredy.claimDunningLaunch({
        id: newId('DUN'),
        customerId: customer.id,
        stage,
        nowIso,
        staleBeforeIso,
      });
      if (!claimed) return { success: false, reason: 'STAGE_ALREADY_LAUNCHED', blocked: true };
    }
    const stageDef = stage ? DUNNING_STAGES.find((s) => s.id === stage) : null;
    const baseMessage = DebtNotificationEngine.generateDebtStatementMessage(
      customer,
      entries.slice(0, 3),
      receiptSettings
    );
    const message = stageDef ? `*${stageDef.label.toUpperCase()}*\n\n${baseMessage}` : baseMessage;
    const { openWhatsApp } = await import('../../utils/phoneUtils');
    const launchedOk = await openWhatsApp(customer.phone, message);
    if (!launchedOk) {
      if (stage) {
        const kredy = await import('../../db/sqlPluginAdapter');
        await kredy.releaseDunningLaunchClaim(customer.id, stage).catch(() => {});
      }
      return { success: false, reason: 'WHATSAPP_BLOCKED', blocked: true };
    }
    try {
      const kredy = await import('../../db/sqlPluginAdapter');
      if (stage) {
        // Claim → launched, with one inline retry: a stranded PLANIFIEE row
        // would re-allow the same stage after the staleness window.
        await kredy.finalizeDunningLaunch(customer.id, stage, nowIso).catch(async () => {
          await kredy.finalizeDunningLaunch(customer.id, stage, nowIso);
        });
      }
      await kredy.recordWhatsappLaunch({
        id: newId('WAL'),
        customerId: customer.id,
        phone: customer.phone || '',
        purpose: stage ? 'RELANCE' : 'MANUEL',
        stage: stage ?? null,
        messagePreview: message.slice(0, 160),
        status: KREDY_LAUNCH_STATUS,
        launchedAt: nowIso,
        operator: activeCashier?.name || 'Caissier',
      });
    } catch (logErr) {
      // The message already left the device; never claim less than what
      // happened, and never fail the launch over the log row.
      console.warn('[kredy] Launch record failed after WhatsApp open:', logErr);
    }
    const operator = activeCashier?.name || 'Caissier';
    await logSecurityAction(
      stage ? 'Relance WhatsApp (palier)' : 'Relance WhatsApp (manuelle)',
      `Client: ${customer.name} — encours ${debt} DA` +
        (stage ? ` — palier ${stage}` : '') +
        ` — statut ${KREDY_LAUNCH_STATUS}`,
      operator,
      false
    );
    return { success: true };
  },

  /** UPGRADE-11 (v126): WhatsApp consent toggle (launches refuse without it). */
  setWhatsappOptIn: async (customerId: string, optIn: boolean) => {
    return get().updateCustomer(customerId, { whatsappOptIn: optIn === true });
  },

  /**
   * UPGRADE-11 (v126): recompute + persist `creditScore`/`creditScoreAt` for
   * the given customers (default: every customer carrying debt). The pure
   * scorer is deterministic per (clock, ledger), so re-running is a no-op in
   * score terms; the factor breakdown is always compute-on-read.
   */
  refreshCreditScores: async (customerIds?: string[]) => {
    const { customers, customerDebts, updateCustomer } = get();
    const nowIso = new Date().toISOString();
    const targets = (customers || []).filter(
      (c) => (customerIds ? customerIds.includes(c.id) : true) && Math.round(c.currentDebt || 0) > 0
    );
    let updated = 0;
    for (const customer of targets) {
      const score = computeReliabilityScore({
        nowIso,
        currentDebt: customer.currentDebt || 0,
        debtLimit: getEffectiveDebtLimit(customer),
        entries: customerDebts.filter((d) => d.customerId === customer.id),
      });
      const res = await updateCustomer(customer.id, {
        creditScore: score.score,
        creditScoreAt: nowIso,
      });
      if (res?.success) updated += 1;
    }
    return { updated };
  },
});
