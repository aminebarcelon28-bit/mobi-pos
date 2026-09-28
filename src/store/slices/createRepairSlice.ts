import type { StateCreator } from 'zustand';
import type { PosState, RepairSlice } from '../types';
import type { RepairOrder } from '../../types/pos';
import { newId, newReceiptNumber } from '../../utils/ids';

// Broadcast when a completed repair still has an unpaid balance, so the UI
// can toast + route the cashier to an EXPLICIT caisse deposit
// (ShiftMovementModal → MANUAL_DEPOSIT). Listened to by whichever agent owns
// the repair UI; the shift/movement modals document the receiving end.
export const REPAIR_BALANCE_DUE_EVENT = 'repair:balance-due';

export interface RepairCompletionResult {
  /** Remaining unpaid balance in integer DZD (> 0 means cash still owed). */
  remainingBalance: number;
}

// P11.3: repairRepository pulls sqliteAdapter -> dexie + libsql into the entry.
async function getRepairRepo() {
  const { repairRepository } = await import('../../db/repositories/repairRepository');
  return repairRepository;
}

export const createRepairSlice: StateCreator<PosState, [], [], RepairSlice> = (set, get) => ({
  repairOrders: [],
  selectedRepairOrderForNotification: null,

  setSelectedRepairOrderForNotification: (order) => set({ selectedRepairOrderForNotification: order }),

  createRepairOrder: async (orderInput) => {
    const { repairOrders } = get();
    // B-033: integer DZD at the write boundary — drawer movements round.
    const labor = Math.max(0, Math.round(Number(orderInput.laborCost) || 0));
    const parts = Math.max(0, Math.round(Number(orderInput.partsCost) || 0));
    const totalCost = labor + parts;
    const newOrder: RepairOrder = {
      ...orderInput,
       id: newId('rep'),
        // Collision-safe: ticketNumber is an indexed Dexie key, and the old
        // 4-random-digit form repeats every ~1e4 orders, which would silently
        // upsert-overwrite an existing repair ticket (C6).
        ticketNumber: newReceiptNumber('REP'),
      totalCost,
      createdAt: new Date().toISOString(),
    };
    const updated = [newOrder, ...repairOrders];
    try {
       await (await getRepairRepo()).save(newOrder);

      // Auto-record advance deposit in cash if shift is open
      const deposit = Math.max(0, Math.round(Number(orderInput.depositAmount) || 0));
      if (deposit > 0 && get().activeShift) {
        await get().logCashMovement(
          deposit,
          'MANUAL_DEPOSIT',
          `Acompte SAV Réparation: Ticket #${newOrder.ticketNumber} (${newOrder.customerName} - ${newOrder.deviceModel})`
        );
      }

      set({ repairOrders: updated });
    } catch (err) {
      console.error('Failed to create repair order:', err);
    }
  },

  updateRepairOrderStatus: async (orderId, newStatus) => {
    const { repairOrders } = get();
    const target = repairOrders.find((r) => r.id === orderId);
    const updated = repairOrders.map((r) =>
      r.id === orderId ? { ...r, status: newStatus, updatedAt: new Date().toISOString() } : r
    );
    // Integer-DZD balance still owed after completion. NEVER auto-logged as
    // drawer cash (that fabricated MANUAL_DEPOSIT entries for unpaid money);
    // returned below + broadcast so the UI prompts an explicit deposit.
    let remainingBalance = 0;
    if (target) {
      const updatedOrder = { ...target, status: newStatus, updatedAt: new Date().toISOString() };
      try {
         await (await getRepairRepo()).save(updatedOrder);

        if (newStatus === 'Prêt / Terminé') {
          remainingBalance = Math.max(0, Math.round(target.totalCost) - Math.round(target.depositAmount || 0));
          if (remainingBalance > 0 && typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent(REPAIR_BALANCE_DUE_EVENT, {
                detail: {
                  orderId: target.id,
                  ticketNumber: target.ticketNumber,
                  customerName: target.customerName,
                  remainingBalance,
                },
              })
            );
          }
        }
      } catch (err) {
        console.error(`Failed to update repair order status [${orderId}]:`, err);
      }
    }
    set({ repairOrders: updated });
    // Runtime result for callers that await the action: the remaining unpaid
    // balance (integer DZD) after completion. The shared RepairSlice type
    // declares Promise<{ remainingBalance: number }>, so this flows typed.
    return { remainingBalance };
  },

  updateRepairOrder: async (orderId, updates) => {
    const { repairOrders } = get();
    const updated = repairOrders.map((r) =>
      r.id === orderId
        ? {
            ...r,
            ...updates,
            // B-033: integer DZD — unrounded labor/parts drifts totalCost vs drawer.
            totalCost:
              Math.max(0, Math.round(Number(updates.laborCost ?? r.laborCost) || 0)) +
              Math.max(0, Math.round(Number(updates.partsCost ?? r.partsCost) || 0)),
            updatedAt: new Date().toISOString(),
          }
        : r
    );
    const target = updated.find((r) => r.id === orderId);
    if (target) {
      try {
         await (await getRepairRepo()).save(target);
      } catch (err) {
        console.error(`Failed to update repair order [${orderId}]:`, err);
      }
    }
    set({ repairOrders: updated });
  },
});
