import type { StateCreator } from 'zustand';
import type { PosState, RepairSlice } from '../types';
import type { RepairOrder } from '../../types/pos';
import { repairRepository } from '../../db/repositories/repairRepository';

export const createRepairSlice: StateCreator<PosState, [], [], RepairSlice> = (set, get) => ({
  repairOrders: [],
  selectedRepairOrderForNotification: null,

  setSelectedRepairOrderForNotification: (order) => set({ selectedRepairOrderForNotification: order }),

  createRepairOrder: async (orderInput) => {
    const { repairOrders } = get();
    const totalCost = orderInput.laborCost + orderInput.partsCost;
    const newOrder: RepairOrder = {
      ...orderInput,
      id: `rep-${Date.now()}`,
      ticketNumber: `REP-${Math.floor(1000 + Math.random() * 9000)}`,
      totalCost,
      createdAt: new Date().toISOString(),
    };
    const updated = [newOrder, ...repairOrders];
    try {
      await repairRepository.save(newOrder);

      // Auto-record advance deposit in cash if shift is open
      const deposit = orderInput.depositAmount || 0;
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
    if (target) {
      const updatedOrder = { ...target, status: newStatus, updatedAt: new Date().toISOString() };
      try {
        await repairRepository.save(updatedOrder);

        // If repair was marked finished/picked up and had a remaining unpaid balance, record in shift
        if (newStatus === 'Prêt / Terminé' && get().activeShift) {
          const remaining = Math.max(0, target.totalCost - (target.depositAmount || 0));
          if (remaining > 0) {
            await get().logCashMovement(
              remaining,
              'MANUAL_DEPOSIT',
              `Solde Restant SAV Réparation: Ticket #${target.ticketNumber} (${target.customerName})`
            );
          }
        }
      } catch (err) {
        console.error(`Failed to update repair order status [${orderId}]:`, err);
      }
    }
    set({ repairOrders: updated });
  },

  updateRepairOrder: async (orderId, updates) => {
    const { repairOrders } = get();
    const updated = repairOrders.map((r) =>
      r.id === orderId
        ? {
            ...r,
            ...updates,
            totalCost: (updates.laborCost ?? r.laborCost) + (updates.partsCost ?? r.partsCost),
            updatedAt: new Date().toISOString(),
          }
        : r
    );
    const target = updated.find((r) => r.id === orderId);
    if (target) {
      try {
        await repairRepository.save(target);
      } catch (err) {
        console.error(`Failed to update repair order [${orderId}]:`, err);
      }
    }
    set({ repairOrders: updated });
  },
});
