import type { StateCreator } from 'zustand';
import type { PosState, CustomerSlice } from '../types';
import type { Customer, CustomerDebtEntry } from '../../types/pos';
import {
  convertPointsToCredit,
  createLedgerEntry,
  canRedeemPoints,
  depleteFifoPointBuckets,
  normalizeLoyaltyConfig,
  isRedeemAllowed,
  STORE_CREDIT_PIN_THRESHOLD_DZD,
} from '../../utils/loyaltyEngine';
import { audioBus } from '../../utils/audioEvents';
import { newId, newReceiptNumber } from '../../utils/ids';
import { utcNowIso } from '../../utils/dateUtils';
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
    const check = canRedeemPoints(customer?.loyaltyPoints ?? 0, want, saleTotal, loyaltyCfg);
    if (!customer || !check.allowed) {
      return { success: false, reason: !customer ? 'CUSTOMER_NOT_FOUND' : check.reason };
    }

    const { creditAmount } = convertPointsToCredit(want, loyaltyCfg);
    const newPoints = customer.loyaltyPoints - want;
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

  adjustCustomerPoints: async (customerId, points, description) => {
    // NOTE: manual manager adjustments intentionally bypass the program
    // master switch — they are operator corrections, not program earn.
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
    const { customers, customerDebts, currentCustomer, logSecurityAction } = get();
    const customer = customers.find((c) => c.id === customerId);
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
      const debtEntry: CustomerDebtEntry = {
        // Deterministic when the caller passes entryId (refund debt-relief):
        // same logical relief converges instead of doubling across devices.
        id: opts?.entryId || newId('DEBT'),
        customerId: base.id,
        customerName: base.name,
        type: 'PAYMENT_SETTLED',
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
        createdAt: utcNowIso(),
        recordedBy: 'Caisse 1 (Yacine)',
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

      const updatedCustomer: Customer = {
        ...base,
        currentDebt: newDebt,
        storeCredit: updatedStoreCredit,
        ledger: newLedger,
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
      const deposit = await get().logCashMovement(
        appliedAmount,
        'MANUAL_DEPOSIT',
        `Versement Règlement Dette: ${customer.name} (Ticket ${receiptNo})`
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
    let debtPayoutTag = '';
    try {
      const { getStableDeviceId } = await import('../../sync/device');
      const { payoutTag } = await import('../../sync/payoutWatch');
      const devId = await getStableDeviceId().catch(() => 'default');
      debtPayoutTag = ` ${payoutTag(`DEBTPAY:${debtEntry.id}`, method, appliedAmount, devId)}`;
    } catch {
      // Tag best-effort — the settlement must never fail over a marker.
    }
    await logSecurityAction(
      'Règlement Dette Client Enregistré',
      `Client: ${customer.name} - Versement: ${appliedAmount} DA appliqués (${method})` +
        (changeDue > 0 ? ` - Monnaie rendue: ${changeDue} DA` : '') +
        ` - Dette restante: ${newDebt} DA${debtPayoutTag}`,
      'Caissier (Yacine)',
      false
    );

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
});
