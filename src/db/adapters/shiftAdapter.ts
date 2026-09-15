import type {
  CashDropEntry,
  StoreExpense,
  CashSession,
  CashMovement,
  DenominationCount,
  InventoryValuation,
} from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete } from './base';

export const shiftAdapter = {
  // ── CASH DROPS & PAYOUTS ──
  async saveCashDrop(entry: CashDropEntry, isPayout = false): Promise<void> {
    if (isPayout) {
      await dexieDb.payouts.put(entry);
    } else {
      await dexieDb.cashDrops.put(entry);
    }
    void fireSync('cash_drop', entry.id, { ...entry, _isPayout: isPayout });
  },

  async getCashDrops(isPayout = false): Promise<CashDropEntry[]> {
    return isPayout ? await dexieDb.payouts.toArray() : await dexieDb.cashDrops.toArray();
  },

  // ── STORE EXPENSES (EBITDA) ──
  async saveStoreExpense(expense: StoreExpense): Promise<void> {
    await dexieDb.storeExpenses.put(expense);
    void fireSync('store_expense', expense.id, expense);
  },

  async getAllStoreExpenses(): Promise<StoreExpense[]> {
    return await dexieDb.storeExpenses.toArray();
  },

  async deleteStoreExpense(id: string): Promise<void> {
    await dexieDb.storeExpenses.delete(id);
    void fireSyncDelete('store_expense', id);
  },

  // ── CASH REGISTER SESSIONS & MOVEMENTS ──
  async startShift(
    openingFloat: number,
    cashierName?: string,
    openingNote?: string,
    denominations?: DenominationCount
  ): Promise<CashSession> {
    const newSession: CashSession = {
      id: `SHIFT-${Date.now()}`,
      openedAt: new Date().toISOString(),
      closedAt: null,
      openingFloat: Math.round(openingFloat),
      expectedCash: null,
      actualCash: null,
      status: 'OPEN',
      cashierName: cashierName || 'Caissier Principal',
      openingNote: openingNote || '',
      closingNote: null,
      discrepancy: 0,
      denominations: denominations || null,
      movements: [],
      updatedAt: new Date().toISOString(),
    };

    await dexieDb.cashSessions.put(newSession);
    void fireSync('cash_session', newSession.id, newSession);
    return newSession;
  },

  async logExpense(
    amount: number,
    movementType: 'EXPENSE' | 'MANUAL_DEPOSIT' = 'EXPENSE',
    reason: string,
    cashierName?: string,
    sessionId?: string
  ): Promise<CashMovement> {
    const fallbackSession = sessionId || (await dexieDb.cashSessions.where('status').equals('OPEN').first())?.id || 'DEFAULT_SHIFT';
    const movement: CashMovement = {
      id: `MOV-${Date.now()}`,
      sessionId: fallbackSession,
      type: movementType,
      amount: Math.round(amount),
      reason,
      cashierName: cashierName || 'Caissier',
      createdAt: new Date().toISOString(),
    };

    await dexieDb.cashMovements.put(movement);
    void fireSync('cash_movement', movement.id, movement);
    return movement;
  },

  async closeShift(
    blindCount: number,
    closingNote?: string,
    _cashierName?: string,
    sessionId?: string
  ): Promise<CashSession> {
    const openSession = sessionId
      ? await dexieDb.cashSessions.get(sessionId)
      : await dexieDb.cashSessions.where('status').equals('OPEN').first();

    const currentSessionId = openSession?.id || `SHIFT-${Date.now()}`;
    const movements = await dexieDb.cashMovements.where('sessionId').equals(currentSessionId).toArray();
    const deposits = movements.filter((m) => m.type === 'MANUAL_DEPOSIT').reduce((sum, m) => sum + m.amount, 0);
    const expenses = movements.filter((m) => m.type === 'EXPENSE').reduce((sum, m) => sum + m.amount, 0);

    const openingFloat = openSession?.openingFloat || 0;
    const txns = await dexieDb.transactions.toArray();
    const sessionTxns = txns.filter(
      (t) => (!openSession?.openedAt || t.createdAt >= openSession.openedAt) && t.status !== 'VOIDED' && !t.isRefund
    );
    const sessionRefunds = txns.filter(
      (t) => (!openSession?.openedAt || t.createdAt >= openSession.openedAt) && t.status !== 'VOIDED' && t.isRefund
    );

    const cashSales = sessionTxns.reduce((sum, t) => {
      if (t.tenders && Array.isArray(t.tenders) && t.tenders.length > 0) {
        const cashTenderTotal = t.tenders
          .filter((tender) => tender.method === 'Espèces')
          .reduce((acc, tender) => acc + tender.amount, 0);
        const netCash = Math.max(0, cashTenderTotal - (t.changeDue || 0));
        return sum + netCash;
      }
      return t.paymentMethod === 'Espèces' ? sum + Math.max(0, t.total) : sum;
    }, 0);

    const cashRefunds = sessionRefunds.reduce((sum, t) => {
      return (t.refundMethod === 'Espèces' || t.paymentMethod === 'Espèces') ? sum + t.total : sum;
    }, 0);

    const totalProfits = sessionTxns.reduce((sum, t) => sum + (t.profit || 0), 0);

    const expectedCash = openingFloat + cashSales + deposits - expenses - cashRefunds;
    const actualCash = Math.round(blindCount);
    const discrepancy = actualCash - expectedCash;

    const closedSession: CashSession = {
      ...(openSession || {
        id: currentSessionId,
        openedAt: new Date().toISOString(),
        openingFloat,
        status: 'OPEN',
        cashierName: 'Caissier',
        openingNote: '',
        denominations: null,
      }),
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
      expectedCash,
      actualCash,
      discrepancy,
      totalSalesCount: sessionTxns.length,
      totalSalesRevenue: sessionTxns.reduce((sum, t) => sum + t.total, 0),
      totalProfits,
      closingNote: closingNote || '',
      movements,
      updatedAt: new Date().toISOString(),
    };

    await dexieDb.cashSessions.put(closedSession);
    void fireSync('cash_session', closedSession.id, closedSession);
    return closedSession;
  },

  async getActiveShift(): Promise<CashSession | null> {
    const open = await dexieDb.cashSessions.where('status').equals('OPEN').first();
    if (!open) return null;
    const movements = await dexieDb.cashMovements.where('sessionId').equals(open.id).toArray();
    return { ...open, movements };
  },

  async getAllShifts(): Promise<CashSession[]> {
    return await dexieDb.cashSessions.orderBy('openedAt').reverse().toArray();
  },

  async getShiftDetails(sessionId: string): Promise<CashSession | null> {
    const session = await dexieDb.cashSessions.get(sessionId);
    if (!session) return null;
    const movements = await dexieDb.cashMovements.where('sessionId').equals(sessionId).toArray();
    return { ...session, movements };
  },

  async getInventoryValuation(): Promise<InventoryValuation> {
    const products = await dexieDb.products.toArray();
    const inStockProducts = products.filter((p) => (p.stock || 0) > 0);
    const totalSkus = inStockProducts.length;
    const totalUnits = inStockProducts.reduce((sum, p) => sum + p.stock, 0);
    const totalCostValue = Math.round(inStockProducts.reduce((sum, p) => sum + p.stock * (p.costPrice || 0), 0));
    const totalRetailValue = Math.round(inStockProducts.reduce((sum, p) => sum + p.stock * p.price, 0));
    const potentialProfitMargin = totalRetailValue - totalCostValue;

    return {
      totalSkus,
      totalUnits,
      totalCostValue,
      totalRetailValue,
      potentialProfitMargin,
    };
  },
};
