import type { StateCreator } from 'zustand';
import type { PosState, RepairSlice } from '../types';
import type { RepairOrder } from '../../types/pos';
import {
  appendRepairStatusHistory,
  REPAIR_SCHEMA_VERSION,
  computeWarrantyExpiryISO,
  isIntakeDraftFresh,
  isSchemaV2Order,
  repairFinancials,
} from '../../types/pos';
import { repairRemainingBalance } from '../../types/pos';
import { newId, newReceiptNumber } from '../../utils/ids';
import { utcNowIso } from '../../utils/dateUtils';
import {
  buildSavBalanceProduct,
  linkSavCartItem,
  savBalanceOf,
  savCartProductIdFor,
} from '../../utils/savSettlement';

// Broadcast when a completed repair still has an unpaid balance, so the UI
// can toast + route the cashier to an EXPLICIT caisse deposit
// (ShiftMovementModal → MANUAL_DEPOSIT). Listened to by whichever agent owns
// the repair UI; the shift/movement modals document the receiving end.
export const REPAIR_BALANCE_DUE_EVENT = 'repair:balance-due';

// Broadcast after checkout settles SAV balance line(s) to Livré, so the UI
// can offer an immediate [Imprimer Bon de Restitution] action.
// Detail: { repairIds: string[]; ticketNumbers: string[]; receiptNumber: string }.
export const REPAIR_DELIVERED_EVENT = 'repair:delivered';

export interface RepairCompletionResult {
  /** Remaining unpaid balance in integer DZD (> 0 means cash still owed). */
  remainingBalance: number;
}

/** Intake validation verdict: `ok` plus one human reason per missing item. */
export interface RepairIntakeValidationResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Strict intake validation for the CURRENT schema (v2). A new ticket must
 * carry the complete legal record: a customer signature, an explicit physical
 * damage constat, a strict warranty tier, the accepted CGV, and (when the
 * identifier is typed as an IMEI) a non-empty Luhn-validated number.
 *
 * Historical dossiers (no `schemaVersion`) are checked against the descriptive
 * minimum only and are never silently upgraded to a legal record.
 */
export function validateRepairIntake(order: RepairOrder): RepairIntakeValidationResult {
  const reasons: string[] = [];

  if (isSchemaV2Order(order)) {
    if (!order.signatureCustomerIntake) {
      reasons.push('Signature client obligatoire à la prise en charge (PV d\'état des lieux).');
    }
    if (!order.legalTermsAcceptedAt) {
      reasons.push('Acceptation des Conditions Générales SAV obligatoire.');
    }
    const dmg = order.intakeDamage;
    if (!dmg || !dmg.screenCondition) {
      reasons.push('Constat état écran manquant (choisir un état : intact, rayé, fissuré…).');
    }
    if (!dmg || !Array.isArray(dmg.chassisDamage) || dmg.chassisDamage.length === 0) {
      reasons.push('Constat châssis manquant (cocher au moins un état).');
    }
    if (!order.warrantyTier) {
      reasons.push('Niveau de garantie obligatoire (choisir une preset).');
    }
    if (order.imeiKind === 'imei' && !order.imei) {
      reasons.push('IMEI déclaré mais vide — corrigez l\'identifiant ou basculez sur « Sans ID ».');
    }
    if (!order.customerName || !order.customerName.trim()) {
      reasons.push('Nom client manquant.');
    }
    if (!order.deviceModel || !order.deviceModel.trim()) {
      reasons.push('Modèle appareil manquant.');
    }
    if (!order.problemDescription || !order.problemDescription.trim()) {
      reasons.push('Description de la panne manquante.');
    }
    return { ok: reasons.length === 0, reasons };
  }

  // Legacy (v1 / unmigrated): read-only record, only the descriptive minimum
  // is checked so an operator can still correct a typo without fabricating
  // legal evidence that never existed.
  if (!order.customerName || !order.customerName.trim()) reasons.push('Nom client manquant.');
  if (!order.deviceModel || !order.deviceModel.trim()) reasons.push('Modèle appareil manquant.');
  if (!order.problemDescription || !order.problemDescription.trim()) {
    reasons.push('Description de la panne manquante.');
  }
  return { ok: reasons.length === 0, reasons };
}

/** Legacy dossiers may only be edited, never promoted to a v2 legal record. */
export function canEditRepairOrder(order: RepairOrder): boolean {
  return isSchemaV2Order(order) || order.status === 'Diagnostic';
}

// P11.3: repairRepository pulls sqliteAdapter -> dexie + libsql into the entry.
async function getRepairRepo() {
  const { repairRepository } = await import('../../db/repositories/repairRepository');
  return repairRepository;
}

export const createRepairSlice: StateCreator<PosState, [], [], RepairSlice> = (set, get) => ({
  repairOrders: [],
  selectedRepairOrderForNotification: null,
  selectedRepairNotificationTemplate: null,
  pendingRepairPrint: null,
  intakeDraft: null,

  setSelectedRepairOrderForNotification: (order, template = 'READY_FOR_PICKUP') =>
    set({
      selectedRepairOrderForNotification: order,
      selectedRepairNotificationTemplate: order ? template ?? 'READY_FOR_PICKUP' : null,
    }),

  setPendingRepairPrint: (req) => set({ pendingRepairPrint: req }),

  // ── Inspector → SAV handoff ──────────────────────────────────────────────
  seedIntakeDraft: (draft) => set({ intakeDraft: draft }),

  /**
   * Atomic consume: reads AND clears in one step so a stale draft can never
   * hydrate a second ticket (double-submit / reopened modal). A draft older
   * than the TTL is discarded rather than applied — a two-hours-old dossier
   * is not evidence of what the operator saw.
   */
  consumeIntakeDraft: () => {
    const draft = get().intakeDraft;
    if (draft) set({ intakeDraft: null });
    return isIntakeDraftFresh(draft) ? draft : null;
  },

  clearIntakeDraft: () => set({ intakeDraft: null }),

  createRepairOrder: async (orderInput) => {
    const { repairOrders } = get();
    // B-033: single integer-DZD rounding source at the write boundary — drawer
    // movements round, so unrounded labor/parts/deposit drift SAV reports vs
    // the till. `balanceDue` stays derived (never persisted) so a stored
    // balance can never disagree with its own components.
    const money = repairFinancials(orderInput);
    // Fail closed at the WRITE boundary, not only in the form. The form already
    // validates, but any other caller (import, a future screen, a test fixture)
    // must not be able to mint a v2 ticket with no signature — that is exactly
    // the unenforceable record a restitution dispute turns on. The candidate is
    // stamped v2 HERE, so a caller cannot opt out of the new legal record by
    // omitting the field.
    const verdict = validateRepairIntake({
      ...orderInput,
      schemaVersion: REPAIR_SCHEMA_VERSION,
      laborCost: money.laborCost,
      partsCost: money.partsCost,
      depositAmount: money.depositAmount,
    } as unknown as RepairOrder);
    if (!verdict.ok) {
      throw new Error(`Dossier SAV incomplet: ${verdict.reasons.join(' • ')}`);
    }
    const createdAt = utcNowIso();
    const newOrder: RepairOrder = {
      ...orderInput,
      id: newId('rep'),
      // Collision-safe: ticketNumber is an indexed Dexie key, and the old
      // 4-random-digit form repeats every ~1e4 orders, which would silently
      // upsert-overwrite an existing repair ticket (C6).
      ticketNumber: newReceiptNumber('REP'),
      laborCost: money.laborCost,
      partsCost: money.partsCost,
      depositAmount: money.depositAmount,
      totalCost: money.totalCost,
      createdAt,
      // Phase 5: every new ticket is a full v2 legal record. Legacy rows keep
      // their absent schemaVersion and stay read-only.
      schemaVersion: REPAIR_SCHEMA_VERSION,
      // Phase 4.6: every new ticket carries an append-only status timeline
      // anchored at intake.
      statusHistory: [
        {
          status: orderInput.status || 'Diagnostic',
          timestamp: createdAt,
          updatedBy: get().activeCashier?.name || 'Caissier',
          note: 'Création du ticket SAV',
        },
      ],
    };
    const updated = [newOrder, ...repairOrders];
    // logCashMovement resets activeModal:null on success — capture the entry
    // modal so an intake-time deposit never slams the repair dossier shut.
    const entryModal = get().activeModal;
    try {
       await (await getRepairRepo()).save(newOrder);

      // Auto-record advance deposit in cash if shift is open
      const deposit = money.depositAmount;
      if (deposit > 0 && get().activeShift) {
        await get().logCashMovement(
          deposit,
          'MANUAL_DEPOSIT',
          `Acompte SAV Réparation: Ticket #${newOrder.ticketNumber} (${newOrder.customerName} - ${newOrder.deviceModel})`
        );
      }

      set({
        repairOrders: updated,
        ...(entryModal === 'repair_work_order' ? { activeModal: entryModal } : {}),
      });
    } catch (err) {
      console.error('Failed to create repair order:', err);
    }
  },

  updateRepairOrderStatus: async (orderId, newStatus) => {
    const { repairOrders } = get();
    const target = repairOrders.find((r) => r.id === orderId);
    const nowIso = utcNowIso();
    // Phase 4.6: append to the immutable status timeline on every transition.
    const withHistory = target
      ? { ...target, statusHistory: appendRepairStatusHistory(target, newStatus, get().activeCashier?.name || 'Caissier') }
      : target;
    // Repair warranty is locked to restitution (RESTITUE). The marker constant
    // is a LABEL, not a date — the anchor is the real delivery instant, so the
    // printed ticket carries an immutable calendar expiry. (Passing the label
    // itself produced an Invalid Date and silently expired every warranty.)
    const isDelivery = newStatus === 'Livré';
    const deliveryStamp = isDelivery ? target?.deliveredAt || nowIso : undefined;
    const updated = repairOrders.map((r) =>
      r.id === orderId
        ? {
            ...withHistory!,
            status: newStatus,
            updatedAt: nowIso,
            ...(isDelivery
              ? {
                  ...(deliveryStamp ? { deliveredAt: deliveryStamp } : {}),
                  ...(withHistory?.warrantyTier
                    ? {
                        warrantyExpiresAt: computeWarrantyExpiryISO(
                          deliveryStamp || nowIso,
                          withHistory.warrantyTier
                        ),
                      }
                    : {}),
                }
              : {}),
          }
        : r
    );
    // Integer-DZD balance still owed after completion. NEVER auto-logged as
    // drawer cash (that fabricated MANUAL_DEPOSIT entries for unpaid money);
    // returned below + broadcast so the UI prompts an explicit deposit.
    let remainingBalance = 0;
    if (target) {
      // Persist the SAME object that lands in the store — the previous version
      // saved a partial copy, so `deliveredAt` / warranty expiry existed only
      // in memory and vanished on reload.
      const updatedOrder = updated.find((r) => r.id === orderId)!;
      try {
         await (await getRepairRepo()).save(updatedOrder);

        if (newStatus === 'Prêt / Terminé') {
          remainingBalance = repairRemainingBalance(target);
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
    const updated = repairOrders.map((r) => {
      if (r.id !== orderId) return r;
      // Legal evidence is append-only: a v2 signature / photo evidence set may
      // never be cleared or replaced by a later plain edit. `warrantyTier` is
      // excluded — it is a live commercial choice the operator can change — but
      // the intake evidence (constat, signature, acceptance, photos) is a
      // record of what happened at a moment in time.
      const merged = { ...r, ...updates };
      const legalFields: Array<keyof RepairOrder> = [
        'signatureCustomerIntake',
        'signatureIntakeAt',
        'legalTermsAcceptedAt',
        'intakePhotos',
        'intakeDamage',
      ];
      for (const f of legalFields) {
        // Omitting the key is the "leave as-is" signal, and so is an explicit
        // null/empty: a later edit must not be able to erase what is on file,
        // whichever way the caller phrased the intent.
        const incoming = updates[f];
        const isErasing =
          incoming === undefined || incoming === null || incoming === '';
        if (isErasing && r[f] !== undefined && r[f] !== null) {
          (merged as Record<string, unknown>)[f as string] = r[f];
        }
      }
      // A v1 row must never be promoted to a v2 legal record by an edit that
      // forgot to carry `schemaVersion` forward — the absence IS the record.
      if (!isSchemaV2Order(r)) {
        (merged as Record<string, unknown>).schemaVersion = undefined;
      }
      // B-033: single integer-DZD rounding source.
      const money = repairFinancials(merged);
      return {
        ...merged,
        laborCost: money.laborCost,
        partsCost: money.partsCost,
        depositAmount: money.depositAmount,
        totalCost: money.totalCost,
        updatedAt: utcNowIso(),
      };
    });
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

  settleAndDeliverRepair: async (orderId) => {
    const order = get().repairOrders.find((r) => r.id === orderId);
    if (!order) return { action: 'deliverable', remainingBalance: 0 };
    if (order.status === 'Livré' || order.status === 'Annulé') {
      return { action: 'deliverable', remainingBalance: 0 };
    }
    const remaining = savBalanceOf(order);
    if (remaining <= 0) return { action: 'deliverable', remainingBalance: 0 };
    // Inject synthetic service product; delivery happens in processPayment.
    const savProduct = buildSavBalanceProduct(order);
    const cartProductId = savCartProductIdFor(order);
    const alreadyInCart = (get().cart || []).some((ci) => ci.product.id === cartProductId);
    if (!alreadyInCart) {
      get().addToCart(savProduct, true, 1, false);
    }
    linkSavCartItem(cartProductId, order.id);
    return { action: 'cart', remainingBalance: remaining, cartProductId };
  },

  markRepairDelivered: async (orderId) => {
    const order = get().repairOrders.find((r) => r.id === orderId);
    if (!order || order.status === 'Livré') return order?.status === 'Livré';
    // Gate: never jump straight to Livré with an unpaid balance.
    if (repairRemainingBalance(order) > 0) return false;
    await get().updateRepairOrderStatus(orderId, 'Livré');
    return true;
  },

  deleteRepairOrderGuarded: async (orderId) => {
    const order = get().repairOrders.find((r) => r.id === orderId);
    if (!order) return { success: false, reason: 'NOT_FOUND' };
    if (order.status !== 'Livré' && order.status !== 'Annulé' && repairRemainingBalance(order) > 0) {
      return { success: false, reason: 'BALANCE_DUE' };
    }
    try {
      const { repairRepository } = await import('../../db/repositories/repairRepository');
      // Repository exposes delete via sqlite adapter path; fall back to Dexie.
      const repo = repairRepository as unknown as { delete?: (id: string) => Promise<void> };
      if (typeof repo.delete === 'function') {
        await repo.delete(orderId);
      } else {
        const { dexieDb } = await import('../../db/database');
        await dexieDb.repairOrders.delete(orderId);
      }
      set({ repairOrders: get().repairOrders.filter((r) => r.id !== orderId) });
      return { success: true };
    } catch (err) {
      console.error(`Failed to delete repair order [${orderId}]:`, err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }
  },
});
