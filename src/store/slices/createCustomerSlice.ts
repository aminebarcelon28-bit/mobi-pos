import type { StateCreator } from 'zustand';
import type { PosState, CustomerSlice } from '../types';
import type { Customer, CustomerDebtEntry } from '../../types/pos';
import { customerRepository } from '../../db/repositories/customerRepository';
import { sqliteAdapter } from '../../db/sqliteAdapter';
import { convertPointsToCredit, createLedgerEntry } from '../../utils/loyaltyEngine';
import { audioBus } from '../../utils/audioEvents';

export const createCustomerSlice: StateCreator<PosState, [], [], CustomerSlice> = (set, get) => ({
  customers: [],
  currentCustomer: null,
  customerDebts: [],

  addCustomer: async (input) => {
    const { customers } = get();
    const newCustomer: Customer = {
      ...(input as Omit<Customer, 'id'>),
      id: input.id || `cust-${Date.now()}`,
    };
    const updated = [newCustomer, ...customers];
    try {
      await customerRepository.save(newCustomer);
      set({ customers: updated });
    } catch (err) {
      console.error('Failed to add customer:', err);
    }
  },

  updateCustomer: async (id, updates) => {
    const { customers, currentCustomer } = get();
    const updated = customers.map((c) => (c.id === id ? { ...c, ...updates } : c));
    const target = updated.find((c) => c.id === id);
    if (target) {
      try {
        await customerRepository.save(target);
      } catch (err) {
        console.error(`Failed to update customer [${id}]:`, err);
      }
    }
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === id) {
      newState.currentCustomer = { ...currentCustomer, ...updates };
      if (updates.pricingTier) newState.pricingTier = updates.pricingTier;
    }
    set(newState as PosState);
  },

  deleteCustomer: async (id) => {
    const { customers, currentCustomer, logSecurityAction } = get();
    const customerToDelete = customers.find((c) => c.id === id);
    if (customerToDelete && (customerToDelete.currentDebt || 0) > 0) {
      logSecurityAction(
        'Suppression Client Bloquée (Dette Active)',
        `Client: ${customerToDelete.name} possède une dette non soldée de ${customerToDelete.currentDebt} DA. Suppression refusée pour préserver l'intégrité comptable.`,
        'Système POS',
        true
      );
      return;
    }
    const updated = customers.filter((c) => c.id !== id);
    try {
      await customerRepository.delete(id);
      const newState: Partial<PosState> = { customers: updated };
      if (currentCustomer?.id === id) {
        newState.currentCustomer = null;
        newState.pricingTier = 'Retail';
      }
      set(newState as PosState);
    } catch (err) {
      console.error(`Failed to delete customer [${id}]:`, err);
    }
  },

  setCurrentCustomer: (customer) => {
    if (customer) {
      set({ currentCustomer: customer, pricingTier: customer.pricingTier || 'Retail' });
    } else {
      set({ currentCustomer: null, pricingTier: 'Retail' });
    }
  },

  issueStoreCredit: async (customerId, amount) => {
    const { customers, currentCustomer } = get();
    const updated = customers.map((c) =>
      c.id === customerId ? { ...c, storeCredit: c.storeCredit + amount } : c
    );
    const target = updated.find((c) => c.id === customerId);
    if (target) {
      try {
        await customerRepository.save(target);
      } catch (err) {
        console.error(`Failed to save store credit for customer [${customerId}]:`, err);
      }
    }
    const newState: Partial<PosState> = { customers: updated };
    if (currentCustomer?.id === customerId) {
      newState.currentCustomer = { ...currentCustomer, storeCredit: currentCustomer.storeCredit + amount };
    }
    set(newState as PosState);
  },

  redeemLoyaltyPoints: async (customerId, points) => {
    const { customers, currentCustomer } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer || customer.loyaltyPoints < points || points <= 0) {
      return { success: false, reason: 'INSUFFICIENT_POINTS' };
    }

    const { creditAmount } = convertPointsToCredit(points);
    const newPoints = customer.loyaltyPoints - points;
    const newCredit = customer.storeCredit + creditAmount;

    const ledgerEntry = createLedgerEntry(
      customerId,
      'conversion',
      -points,
      newPoints,
      `Échange de ${points} pts contre ${creditAmount} DA d'Avoir Client`
    );

    const existingLedger = customer.ledger || [];
    const updatedCustomer: Customer = {
      ...customer,
      loyaltyPoints: newPoints,
      storeCredit: newCredit,
      ledger: [ledgerEntry, ...existingLedger],
    };

    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    try {
      await customerRepository.save(updatedCustomer);
    } catch (err) {
      console.error(`Failed to save redeemed points for customer [${customerId}]:`, err);
      return { success: false, reason: 'DB_SAVE_FAILED' };
    }

    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
    return { success: true, creditAdded: creditAmount };
  },

  adjustCustomerPoints: async (customerId, points, description) => {
    const { customers, currentCustomer } = get();
    const customer = customers.find((c) => c.id === customerId);
    if (!customer || points === 0) return;

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

    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    try {
      await customerRepository.save(updatedCustomer);
    } catch (err) {
      console.error(`Failed to adjust points for customer [${customerId}]:`, err);
    }

    let updatedCurrentCustomer = currentCustomer;
    if (currentCustomer?.id === customerId) {
      updatedCurrentCustomer = updatedCustomer;
    }

    set({ customers: updatedCustomers, currentCustomer: updatedCurrentCustomer });
  },

  recordCustomerDebtPayment: async (customerId, amount, method, notes) => {
    const { customers, customerDebts, currentCustomer, logSecurityAction } = get();
    const customer = customers.find((c) => c.id === customerId);
    const validAmount = Math.max(0, isNaN(amount) ? 0 : amount);
    if (!customer || validAmount <= 0) return { success: false };

    const currentDebt = customer.currentDebt || 0;
    const newDebt = Math.max(0, currentDebt - validAmount);
    const excessCredit = Math.max(0, validAmount - currentDebt);
    const updatedStoreCredit = (customer.storeCredit || 0) + excessCredit;

    const receiptNo = `VERS-${Date.now().toString().slice(-6)}`;
    const debtEntry: CustomerDebtEntry = {
      id: `DEBT-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
      customerId: customer.id,
      customerName: customer.name,
      type: 'PAYMENT_SETTLED',
      amount: validAmount,
      balanceAfter: newDebt,
      receiptNumber: receiptNo,
      paymentMethod: method,
      notes:
        notes ||
        `Versement règlement de dette (${method})${excessCredit > 0 ? ` (surplus ${excessCredit} DA en avoir)` : ''}`,
      createdAt: new Date().toISOString(),
      recordedBy: 'Caisse 1 (Yacine)',
    };

    let newLedger = customer.ledger || [];
    if (excessCredit > 0) {
      const creditLedgerEntry = createLedgerEntry(
        customer.id,
        'conversion',
        0,
        customer.loyaltyPoints,
        `Surplus versement dette (+${excessCredit} DA) crédité en Avoir Client (Réf ${receiptNo})`
      );
      newLedger = [creditLedgerEntry, ...newLedger];
    }

    const updatedCustomer: Customer = {
      ...customer,
      currentDebt: newDebt,
      storeCredit: updatedStoreCredit,
      ledger: newLedger,
    };

    const updatedCustomers = customers.map((c) => (c.id === customerId ? updatedCustomer : c));
    const updatedDebts = [debtEntry, ...customerDebts];

    try {
      await customerRepository.save(updatedCustomer);
      await sqliteAdapter.saveCustomerDebt(debtEntry);
    } catch (err) {
      console.error('Failed to save debt payment:', err);
      return { success: false };
    }

    // Auto-record drawer deposit if paid in cash during an active shift
    if (method === 'Espèces' && get().activeShift) {
      await get().logCashMovement(
        validAmount,
        'MANUAL_DEPOSIT',
        `Versement Règlement Dette: ${customer.name} (Ticket ${receiptNo})`
      );
    }

    logSecurityAction(
      'Règlement Dette Client Enregistré',
      `Client: ${customer.name} - Versement: ${validAmount} DA (${method}) - Dette restante: ${newDebt} DA`,
      'Caissier (Yacine)',
      false
    );

    audioBus.emit('success');
    audioBus.emit('cashDrawer');

    set({
      customers: updatedCustomers,
      currentCustomer: currentCustomer?.id === customerId ? updatedCustomer : currentCustomer,
      customerDebts: updatedDebts,
    });

    return { success: true, debtEntry };
  },
});
