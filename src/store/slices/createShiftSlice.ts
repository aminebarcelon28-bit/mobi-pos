import type { StateCreator } from 'zustand';
import type { PosState, ShiftSlice } from '../types';
import type { CashDropEntry, CashSession } from '../../types/pos';
import { audioBus } from '../../utils/audioEvents';
import { newId } from '../../utils/ids';
import { utcNowIso } from '../../utils/dateUtils';

// P11.3: sqliteAdapter -> dexie + libsql graph; shift actions are all async and
// never run during cold start, so the adapter resolves on first use.
async function getSqlite() {
  const { sqliteAdapter } = await import('../../db/sqliteAdapter');
  return sqliteAdapter;
}

// Call-shape of closeShift INCLUDING the 4th managerPin passthrough (kept
// out of the shared ShiftSlice type — owned by another agent — so modals
// cast to this instead of widening the interface themselves).
export type CloseShiftWithPin = (
  blindCount: number,
  closingNote?: string,
  cashierName?: string,
  managerPin?: string
) => Promise<{ success: boolean; session?: CashSession; reason?: string }>;

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
       id: newId('drop'),
      timestamp: utcNowIso(),
    };
    const updated = [newDrop, ...cashDrops];
    try {
      await (await getSqlite()).saveCashDrop(newDrop, false);

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
    // Cashier default comes from the lock-screen cashier (createUISlice owns
    // `activeCashier`; it is absent from the shared PosState type so read it
    // via a structural cast — never fall back to a hardcoded name here).
    const lockScreenCashier = (get() as unknown as { activeCashier?: { name?: string } | null })
      .activeCashier?.name?.trim();
    const effectiveCashier = (cashierName || '').trim() || lockScreenCashier || 'Caissier Principal';
    try {
      const session = await (await getSqlite()).startShift(
        openingFloat,
        effectiveCashier,
        openingNote,
        denominations,
        lockScreenCashier || effectiveCashier
      );
      const allShifts = await (await getSqlite()).getAllShifts();
      logSecurityAction(
        'Ouverture Session Caisse (Shift Open)',
        `Fond de caisse initial: ${openingFloat} DA • Caissier: ${effectiveCashier} • ID: ${session.id}`,
        effectiveCashier,
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
      const code = (e as { code?: string } | null)?.code;
      const existingSession = (e as { existingSession?: CashSession } | null)?.existingSession;
      // Double-open: surface the already-open session so the modal can show
      // who/when instead of silently orphaning the first session's cash.
      if (code === 'SHIFT_ALREADY_OPEN' && existingSession) {
        const refreshed = await (await getSqlite()).getActiveShift().catch(() => null);
        set({ activeShift: refreshed || existingSession });
        return { success: false, reason: code, session: refreshed || existingSession };
      }
      return { success: false, reason: code || (e instanceof Error ? e.message : 'Erreur ouverture shift') };
    }
  },

  logCashMovement: async (amount, type, reason, cashierName) => {
    const { activeShift, logSecurityAction } = get();
    try {
      const movement = await (await getSqlite()).logExpense(amount, type, reason, cashierName, activeShift?.id);
      const refreshedActive = await (await getSqlite()).getActiveShift();
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

  // NOTE: 4th param `managerPin` is intentionally extra vs the shared
  // ShiftSlice type (store/types.ts, owned by another agent): callers pass it
  // positionally and the adapter enforces the variance gate. Extra trailing
  // OPTIONAL params keep this implementation assignable to the declared type.
  closeShift: async (blindCount, closingNote, cashierName, managerPin?: string) => {
    const { activeShift, logSecurityAction } = get();
    try {
      const closedSession = await (await getSqlite()).closeShift(
        blindCount,
        closingNote,
        cashierName,
        activeShift?.id,
        managerPin
      );
      const allShifts = await (await getSqlite()).getAllShifts();
      const inventoryValuation = await (await getSqlite()).getInventoryValuation();

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
      // Adapter throws coded errors (NO_OPEN_SHIFT, CLOSING_NOTE_REQUIRED,
      // MANAGER_PIN_REQUIRED / _INVALID) — propagate the CODE as reason so
      // the modal can render the matching message/PIN prompt.
      const code = (e as { code?: string } | null)?.code;
      return { success: false, reason: code || (e instanceof Error ? e.message : 'Erreur clôture shift') };
    }
  },

  // Mid-shift drawer handover: re-points the OPEN session's currentCashier
  // at the lock-screen cashier without closing the session. Called
  // fire-and-forget by switchCashier (createUISlice) so drawer attribution
  // follows the current user. Declared on the shared ShiftSlice interface.
  setShiftCashier: async (cashierName: string): Promise<{ success: boolean; reason?: string }> => {
    const { logSecurityAction } = get();
    try {
      const updated = await (await getSqlite()).setShiftCashier(cashierName);
      logSecurityAction(
        'Passation de Caisse (Mid-Shift)',
        `Tiroir-caisse repris par : ${updated.cashierName} • Session: ${updated.id}`,
        updated.cashierName || 'Caissier',
        false
      );
      audioBus.emit('success');
      set({ activeShift: updated });
      return { success: true };
    } catch (e: unknown) {
      console.error('Failed to hand over shift:', e);
      const code = (e as { code?: string } | null)?.code;
      return { success: false, reason: code || (e instanceof Error ? e.message : 'Erreur passation caisse') };
    }
  },

  fetchActiveShift: async () => {
    try {
      const activeShift = await (await getSqlite()).getActiveShift();
      set({ activeShift, shiftFloat: activeShift?.openingFloat || get().shiftFloat });
    } catch (e) {
      console.warn('Failed to fetch active shift:', e);
    }
  },

  fetchInventoryValuation: async () => {
    try {
      const inventoryValuation = await (await getSqlite()).getInventoryValuation();
      set({ inventoryValuation });
    } catch (e) {
      console.warn('Failed to fetch inventory valuation:', e);
    }
  },

  fetchAllShifts: async () => {
    try {
      const allShifts = await (await getSqlite()).getAllShifts();
      set({ allShifts });
    } catch (e) {
      console.warn('Failed to fetch all shifts:', e);
    }
  },

  printXReport: async () => {
    const { activeShift, receiptSettings, logSecurityAction, transactions, repairOrders } = get();
    if (!activeShift) {
      return false;
    }
    try {
      const openedAt = activeShift.openedAt;
      const sessionTxns = transactions.filter(
        (t) => (!openedAt || t.createdAt >= openedAt) && t.status !== 'VOIDED' && !t.isRefund
      );
      const sessionRefunds = transactions.filter(
        (t) => (!openedAt || t.createdAt >= openedAt) && t.status !== 'VOIDED' && t.isRefund
      );

      const cashSales = sessionTxns.reduce((sum, t) => {
        if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
          const cashTenderTotal = t.tenders
            .filter((tender) => tender.method === 'Espèces')
            .reduce((acc, tender) => acc + tender.amount, 0);
          return sum + Math.max(0, cashTenderTotal - (t.changeDue || 0));
        }
        return t.paymentMethod === 'Espèces' ? sum + Math.max(0, t.total) : sum;
      }, 0);

      const cashRefunds = sessionRefunds.reduce((sum, t) => {
        return (t.refundMethod === 'Espèces' || t.paymentMethod === 'Espèces') ? sum + t.total : sum;
      }, 0);

      const deposits = (activeShift.movements || [])
        .filter((m) => m.type === 'MANUAL_DEPOSIT')
        .reduce((sum, m) => sum + m.amount, 0);
      const expenses = (activeShift.movements || [])
        .filter((m) => m.type === 'EXPENSE')
        .reduce((sum, m) => sum + m.amount, 0);

      const liveExpectedCash = activeShift.openingFloat + cashSales + deposits - expenses - cashRefunds;
      // SAV atelier splits (informational only — never enter expected-cash math).
      const { savDepositsFromRepairs, savSettledFromTxns } = await import('../../utils/cashTerms');
      const xSavDeposits = savDepositsFromRepairs(
        (repairOrders || []).filter((r) => !openedAt || !r.createdAt || r.createdAt >= openedAt)
      );
      const xSavSettled = savSettledFromTxns(sessionTxns);
      const enrichedShift = {
        ...activeShift,
        expectedCash: liveExpectedCash,
        totalSalesCount: sessionTxns.length,
        totalSalesRevenue: sessionTxns.reduce((sum, t) => sum + t.total, 0),
        totalProfits: sessionTxns.reduce((sum, t) => sum + (t.profit || 0), 0),
        savDeposits: xSavDeposits,
        savSettled: xSavSettled,
      };

      const { directPrintXReport } = await import('../../utils/escpos');
      const success = await directPrintXReport(enrichedShift, receiptSettings);
      logSecurityAction(
        'Impression Rapport X (Mid-Shift)',
        `Session: ${activeShift.id} • Caissier: ${activeShift.cashierName} • Espèces Théoriques: ${liveExpectedCash} DA`,
        activeShift.cashierName || 'Caissier Principal',
        false
      );
      return success;
    } catch (err) {
      console.error('Failed to print X-Report:', err);
      return false;
    }
  },
});
