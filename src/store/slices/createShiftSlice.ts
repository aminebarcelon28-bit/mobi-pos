import type { StateCreator } from 'zustand';
import type { PosState, ShiftSlice } from '../types';
import type { CashDropEntry } from '../../types/pos';
import { sqliteAdapter } from '../../db/sqliteAdapter';
import { audioBus } from '../../utils/audioEvents';

export const createShiftSlice: StateCreator<PosState, [], [], ShiftSlice> = (set, get) => ({
  activeShift: null,
  allShifts: [],
  shiftFloat: 20000,
  cashDrops: [],
  payouts: [],
  inventoryValuation: null,

  addCashDrop: async (entry: Omit<CashDropEntry, 'id' | 'timestamp'>) => {
    const { cashDrops } = get();
    const newDrop: CashDropEntry = {
      ...entry,
      id: `drop-${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
    const updated = [newDrop, ...cashDrops];
    try {
      await sqliteAdapter.saveCashDrop(newDrop, false);

      // Auto-record drawer skimming into active shift movements
      if (get().activeShift) {
        await get().logCashMovement(
          newDrop.amount,
          'EXPENSE',
          `Prélèvement Coffre (Cash Drop): ${newDrop.reason || 'Délestage caisse'}`
        );
      }

      set({ cashDrops: updated });
    } catch (err) {
      console.error('Failed to add cash drop:', err);
    }
  },

  startShift: async (openingFloat, cashierName, openingNote, denominations) => {
    const { logSecurityAction } = get();
    try {
      const session = await sqliteAdapter.startShift(openingFloat, cashierName, openingNote, denominations);
      const allShifts = await sqliteAdapter.getAllShifts();
      logSecurityAction(
        'Ouverture Session Caisse (Shift Open)',
        `Fond de caisse initial: ${openingFloat} DA • Caissier: ${cashierName || 'Caissier Principal'} • ID: ${session.id}`,
        cashierName || 'Caissier',
        false
      );
      audioBus.emit('success');
      set({
        activeShift: session,
        allShifts,
        shiftFloat: openingFloat,
        activeModal: null,
      });
      return { success: true, session };
    } catch (e: unknown) {
      console.error('Failed to start shift:', e);
      return { success: false, reason: e instanceof Error ? e.message : 'Erreur ouverture shift' };
    }
  },

  logCashMovement: async (amount, type, reason, cashierName) => {
    const { activeShift, logSecurityAction } = get();
    try {
      const movement = await sqliteAdapter.logExpense(amount, type, reason, cashierName, activeShift?.id);
      const refreshedActive = await sqliteAdapter.getActiveShift();
      logSecurityAction(
        type === 'EXPENSE' ? 'Décaissement / Dépense Caisse' : 'Apport de Caisse / Dépôt Manuel',
        `Montant: ${amount} DA • Motif: ${reason} • Shift: ${activeShift?.id || 'Actif'}`,
        cashierName || 'Caissier',
        false
      );
      audioBus.emit('cashDrawer');
      set({
        activeShift: refreshedActive,
        activeModal: null,
      });
      return { success: true, movement };
    } catch (e: unknown) {
      console.error('Failed to log cash movement:', e);
      return { success: false, reason: e instanceof Error ? e.message : 'Erreur mouvement caisse' };
    }
  },

  closeShift: async (blindCount, closingNote, cashierName) => {
    const { activeShift, logSecurityAction } = get();
    try {
      const closedSession = await sqliteAdapter.closeShift(blindCount, closingNote, cashierName, activeShift?.id);
      const allShifts = await sqliteAdapter.getAllShifts();
      const inventoryValuation = await sqliteAdapter.getInventoryValuation();

      logSecurityAction(
        'Clôture Caisse & Rapport Z (Blind Count)',
        `Montant compté: ${blindCount} DA • Théorique: ${closedSession.expectedCash} DA • Écart: ${closedSession.discrepancy} DA • Profit Net: ${closedSession.dailyNetProfit} DA`,
        cashierName || 'Caissier Principal',
        Boolean(closedSession.discrepancy && closedSession.discrepancy !== 0)
      );

      audioBus.emit('success');
      set({
        activeShift: null,
        allShifts,
        inventoryValuation,
        activeModal: null,
      });
      return { success: true, session: closedSession };
    } catch (e: unknown) {
      console.error('Failed to close shift:', e);
      return { success: false, reason: e instanceof Error ? e.message : 'Erreur clôture shift' };
    }
  },

  fetchActiveShift: async () => {
    try {
      const activeShift = await sqliteAdapter.getActiveShift();
      set({ activeShift, shiftFloat: activeShift?.openingFloat || get().shiftFloat });
    } catch (e) {
      console.warn('Failed to fetch active shift:', e);
    }
  },

  fetchInventoryValuation: async () => {
    try {
      const inventoryValuation = await sqliteAdapter.getInventoryValuation();
      set({ inventoryValuation });
    } catch (e) {
      console.warn('Failed to fetch inventory valuation:', e);
    }
  },

  fetchAllShifts: async () => {
    try {
      const allShifts = await sqliteAdapter.getAllShifts();
      set({ allShifts });
    } catch (e) {
      console.warn('Failed to fetch all shifts:', e);
    }
  },
});
