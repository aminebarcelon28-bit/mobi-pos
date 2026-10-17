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
import {
  buildSavBalanceProduct,
  linkSavCartItem,
  savBalanceOf,
  savCartProductIdFor,
} from '../../utils/savSettlement';
import { sanitizeDzPhone } from '../../utils/savValidation';
import {
  computeRepairCommission,
  resolveActiveCommissionRule,
} from '../../utils/technicianCommission';

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

async function consumeSparePartsInventory(
  order: RepairOrder,
  get: () => PosState,
  set: (state: Partial<PosState>) => void
): Promise<RepairOrder> {
  const parts = order.spareParts || [];
  const unconsumed = parts.filter((p) => !p.isConsumed);
  if (unconsumed.length === 0) return order;

  try {
    const { appendInventoryDeltas, depleteStockBatchesFifo } = await import('../../db/sqlPluginAdapter');

    // 1. Deplete FIFO stock batches in SQLite
    const depletionResults = await depleteStockBatchesFifo(
      unconsumed.map((p) => ({ productId: p.productId, quantity: p.quantity })),
      { refType: 'REPAIR_ORDER', refId: order.id }
    );

    // 2. Append inventory_ledger deltas with REPAIR_PARTS tracking
    const deltas = unconsumed.map((p) => ({
      productId: p.productId,
      delta: -Math.abs(Number(p.quantity) || 1),
      reason: 'ADJUST' as const,
      refType: 'REPAIR_PARTS',
      refId: order.id,
    }));
    await appendInventoryDeltas(deltas);

    // 3. Mirror stock adjustments to Dexie products
    try {
      const { dexieDb } = await import('../../db/database');
      for (const p of unconsumed) {
        const existing = await dexieDb.products.get(p.productId);
        if (existing) {
          await dexieDb.products.update(p.productId, {
            stock: Math.max(0, existing.stock - p.quantity),
          });
        }
      }
    } catch {
      /* dexie mirror best effort */
    }

    // 4. Update in-memory Zustand products
    const liveProducts = get().products || [];
    const updatedLiveProducts = liveProducts.map((prod) => {
      const consumed = unconsumed.find((u) => u.productId === prod.id);
      if (consumed) {
        return { ...prod, stock: Math.max(0, prod.stock - consumed.quantity) };
      }
      return prod;
    });
    set({ products: updatedLiveProducts });

    // 5. Update spare parts with FIFO cost basis and allocations
    const consumedTime = new Date().toISOString();
    let totalFifoPartsCost = 0;
    const updatedSpareParts = parts.map((p) => {
      if (p.isConsumed) {
        totalFifoPartsCost += (p.unitCost ?? p.unitPrice) * p.quantity;
        return p;
      }
      const dep = depletionResults.find((r) => r.productId === p.productId);
      const unitCost = dep ? dep.unitCost : (p.unitCost ?? p.unitPrice);
      totalFifoPartsCost += unitCost * p.quantity;
      return {
        ...p,
        isConsumed: true,
        consumedAt: consumedTime,
        unitCost,
        batchAllocations: dep?.allocations || [],
      };
    });

    // Compute partsCost from actual FIFO batch cost basis (permitting manual markup/external parts if greater)
    const newPartsCost = Math.max(order.partsCost || 0, Math.round(totalFifoPartsCost));
    // UPGRADE-06: freeze the TRUE cost basis alongside the charge. The basis
    // only accepts cost-grade inputs (FIFO batch cost, or the catalog cost
    // frozen at attach) — never the sell price. A part whose cost is unknown
    // contributes nothing, and any part without a batch trail marks the whole
    // basis 'mixed' (a lower bound, honestly labelled) — a fully FIFO-priced
    // ticket stamps 'fifo'. Single Math.round at this boundary; integer DZD
    // from here on, never re-derived later.
    let basisTotal = 0;
    let basisComplete = true;
    let basisHasInput = false;
    for (const p of updatedSpareParts) {
      if (typeof p.unitCost === 'number' && Number.isFinite(p.unitCost)) {
        basisHasInput = true;
        basisTotal += p.unitCost * p.quantity;
      } else {
        basisComplete = false;
      }
      if ((p.batchAllocations?.length ?? 0) === 0) basisComplete = false;
    }
    const partsCostBasis = basisHasInput ? Math.round(basisTotal) : undefined;
    const costingModel: RepairOrder['costingModel'] =
      partsCostBasis === undefined ? undefined : (basisComplete ? 'fifo' : 'mixed');
    const totalCost = (order.laborCost || 0) + newPartsCost;
    const updatedOrder: RepairOrder = {
      ...order,
      spareParts: updatedSpareParts,
      partsCost: newPartsCost,
      totalCost,
      ...(partsCostBasis !== undefined ? { partsCostBasis, costingModel } : {}),
    };
    await (await getRepairRepo()).save(updatedOrder);
    return updatedOrder;
  } catch (err) {
    console.error('Failed to deduct SAV spare parts inventory:', err);
    return order;
  }
}

async function restoreSparePartsInventory(
  order: RepairOrder,
  get: () => PosState,
  set: (state: Partial<PosState>) => void
): Promise<RepairOrder> {
  const parts = order.spareParts || [];
  const consumed = parts.filter((p) => p.isConsumed);
  if (consumed.length === 0) return order;

  try {
    const { appendInventoryDeltas, restituteStockBatches } = await import('../../db/sqlPluginAdapter');

    // 1. Restitute stock batches
    const allocationsToRestitute: Array<{ batchId?: string; productId: string; quantity: number; unitCost: number }> = [];
    for (const p of consumed) {
      if (p.batchAllocations && p.batchAllocations.length > 0) {
        for (const alloc of p.batchAllocations) {
          allocationsToRestitute.push({
            batchId: alloc.batchId,
            productId: p.productId,
            quantity: alloc.quantity,
            unitCost: alloc.unitCost,
          });
        }
      } else {
        allocationsToRestitute.push({
          productId: p.productId,
          quantity: p.quantity,
          unitCost: p.unitCost ?? p.unitPrice,
        });
      }
    }
    if (allocationsToRestitute.length > 0) {
      await restituteStockBatches(allocationsToRestitute, { batchKeySeed: `sav-${order.id}` });
    }

    // 2. Compensating inventory ledger deltas
    const deltas = consumed.map((p) => ({
      productId: p.productId,
      delta: Math.abs(Number(p.quantity) || 1),
      reason: 'ADJUST' as const,
      refType: 'REPAIR_PARTS_CANCEL',
      refId: order.id,
    }));
    await appendInventoryDeltas(deltas);

    // 3. Mirror to Dexie products
    try {
      const { dexieDb } = await import('../../db/database');
      for (const p of consumed) {
        const existing = await dexieDb.products.get(p.productId);
        if (existing) {
          await dexieDb.products.update(p.productId, {
            stock: existing.stock + p.quantity,
          });
        }
      }
    } catch {
      /* dexie mirror best effort */
    }

    // 4. Update Zustand products
    const liveProducts = get().products || [];
    const updatedLiveProducts = liveProducts.map((prod) => {
      const restored = consumed.find((u) => u.productId === prod.id);
      if (restored) {
        return { ...prod, stock: prod.stock + restored.quantity };
      }
      return prod;
    });
    set({ products: updatedLiveProducts });

    const updatedSpareParts = parts.map((p) => ({ ...p, isConsumed: false, batchAllocations: undefined }));
    // UPGRADE-06: the consumption was reversed, so the frozen cost basis is no
    // longer true and must not survive on a cancelled ticket — a later
    // re-delivery re-consumes the parts and re-stamps it from scratch.
    const updatedOrder = {
      ...order,
      spareParts: updatedSpareParts,
      partsCostBasis: undefined,
      costingModel: undefined,
    };
    await (await getRepairRepo()).save(updatedOrder);
    return updatedOrder;
  } catch (err) {
    console.error('Failed to restore SAV spare parts inventory:', err);
    return order;
  }
}

/**
 * UPGRADE-05: stamp the commission evaluation ONCE per settled ticket.
 * Resolves the assigned technician's active rule (specific beats default),
 * computes integer-DZD commission, persists, then publishes to memory — a
 * payroll projection must never fail or precede the settlement write.
 * No-op when the ticket has no assignment or was already evaluated.
 */
async function stampCommissionIfDue(order: RepairOrder, nowIso: string): Promise<void> {
  if (!order.assignedTechnicianId || order.commissionComputedAt) return;
  try {
    const { listCommissionRules } = await import('../../db/adapters/techniciansAdapter');
    const rules = await listCommissionRules();
    const rule = resolveActiveCommissionRule(rules, order.assignedTechnicianId);
    const evaluation = computeRepairCommission(rule, order);
    const fields = {
      commissionComputedAt: nowIso,
      commissionTechnicianId: order.assignedTechnicianId,
      commissionRuleId: evaluation.ruleId ?? undefined,
      commissionBasis: evaluation.basis,
      commissionBasisAmount: evaluation.basisAmount,
      commissionRatePercent: evaluation.ratePercent,
      commissionAmount: evaluation.amount,
    };
    await (await getRepairRepo()).save({ ...order, ...fields });
    Object.assign(order, fields);
  } catch (err) {
    console.warn('[UPGRADE-05] commission evaluation skipped:', err);
  }
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

    // UPGRADE-08 — blocked-device screen (fail-closed): intake of a flagged
    // device requires a fresh audited manager grant, burned here once the
    // ticket persists below. Under Tauri a read error denies too.
    const intakeIdentifier = String(orderInput.imei ?? '').trim();
    let blockedOverrideGranted = false;
    let blockedGrantKey: string | null = null;
    if (intakeIdentifier) {
      const { checkImeiBlocked } = await import('../../db/adapters/deviceTrustAdapter');
      const blockVerdict = await checkImeiBlocked(intakeIdentifier);
      if (blockVerdict.status === 'unknown') {
        throw new Error(`Vérification appareil impossible : ${blockVerdict.detail}`);
      }
      if (blockVerdict.status === 'blocked') {
        const { hasFreshBlockedDeviceGrant, pruneBlockedDeviceGrants, BlockedDeviceError } =
          await import('../../utils/deviceTrust');
        const grants = pruneBlockedDeviceGrants(get().blockedDeviceGrants, Date.now());
        if (!hasFreshBlockedDeviceGrant(grants, blockVerdict.imei, Date.now())) {
          throw new BlockedDeviceError(blockVerdict.imei, blockVerdict.reason);
        }
        blockedOverrideGranted = true;
        blockedGrantKey = blockVerdict.imei;
      }
    }
    const createdAt = new Date().toISOString();
    const cleanPhone = orderInput.customerPhone ? sanitizeDzPhone(orderInput.customerPhone) : '';
    const candidateCustomerId = orderInput.customerId ||
      get().customers.find(c => (c.phone && cleanPhone && sanitizeDzPhone(c.phone) === cleanPhone))?.id ||
      undefined;

    const newOrder: RepairOrder = {
      ...orderInput,
      customerId: candidateCustomerId,
      id: newId('rep'),
      // Collision-safe: ticketNumber is an indexed Dexie key, and the old
      // 4-random-digit form repeats every ~1e4 orders, which would silently
      // upsert-overwrite an existing repair ticket (C6).
      ticketNumber: newReceiptNumber('REP'),
      // UPGRADE-06: freeze the original ticket's number when this ticket is a
      // warranty redo — the badge must keep its meaning even if the original
      // is renumbered later.
      ...(orderInput.reworkOfRepairId
        ? {
            reworkOfTicketNumber:
              repairOrders.find((r) => r.id === orderInput.reworkOfRepairId)?.ticketNumber ??
              undefined,
          }
        : {}),
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
          note:
            'Création du ticket SAV' +
            (orderInput.reworkOfRepairId ? ' — reprise garantie' : ''),
        },
      ],
    };
    const updated = [newOrder, ...repairOrders];
    // logCashMovement resets activeModal:null on success — capture the entry
    // modal so an intake-time deposit never slams the repair dossier shut.
    const entryModal = get().activeModal;
    try {
       await (await getRepairRepo()).save(newOrder);

      // UPGRADE-08 — ownership ledger: the device entered the bench (custody
      // event; the customer keeps ownership, but the trace starts here).
      // Best-effort + idempotent, same posture as the trade-in lanes.
      if (intakeIdentifier) {
        try {
          const { appendImeiEvent } = await import('../../db/adapters/deviceTrustAdapter');
          await appendImeiEvent({
            imei: intakeIdentifier,
            kind: 'REPAIR_INTAKE',
            refType: 'repair_order',
            refId: newOrder.id,
            at: createdAt,
            actor: get().activeCashier?.name || 'Caissier',
            note: blockedOverrideGranted
              ? `Prise en charge SAV #${newOrder.ticketNumber} — dérogation appareil bloqué`
              : `Prise en charge SAV #${newOrder.ticketNumber}`,
          });
        } catch (err) {
          console.warn('[createRepairOrder] ownership ledger append skipped:', err);
        }
      }
      // Grant consumption: burn the one-shot override once the ticket is on
      // disk (a failed attempt above needed no re-grant).
      if (blockedOverrideGranted && blockedGrantKey) {
        const { consumeBlockedDeviceGrant } = await import('../../utils/deviceTrust');
        set({
          blockedDeviceGrants: consumeBlockedDeviceGrant(
            get().blockedDeviceGrants,
            blockedGrantKey,
            Date.now()
          ),
        });
      }

      // UPGRADE-06: a redo ticket opens its warranty claim right after the
      // ticket persists. Best-effort — the ticket itself is the legal record;
      // the claim row only makes the redo measurable (rate + absorbed bases).
      if (newOrder.reworkOfRepairId) {
        try {
          const { openWarrantyClaimIfRework } = await import('../../db/adapters/savRmaAdapter');
          await openWarrantyClaimIfRework(newOrder);
        } catch {
          /* claim bookkeeping is best-effort — never blocks intake */
        }
      }

      // Auto-record advance deposit in cash if shift is open
      const deposit = money.depositAmount;
      if (deposit > 0 && get().activeShift) {
        await get().logCashMovement(
          deposit,
          'MANUAL_DEPOSIT',
          `SAV_ACOMPTE: Acompte Réparation #${newOrder.ticketNumber} (${newOrder.customerName} - ${newOrder.deviceModel})`,
          get().activeCashier?.name || 'Caissier',
          undefined,
          'SAV_ACOMPTE',
          'REPAIR_ORDER',
          newOrder.id
        );
      }

      if (newOrder.status === 'Prêt / Terminé' || newOrder.status === 'Livré') {
        const orderWithDeductedParts = await consumeSparePartsInventory(newOrder, get, set);
        const idx = updated.findIndex((r) => r.id === newOrder.id);
        if (idx !== -1) updated[idx] = orderWithDeductedParts;
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
    const nowIso = new Date().toISOString();
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

        if (newStatus === 'Prêt / Terminé' || newStatus === 'Livré') {
          const orderWithDeductedParts = await consumeSparePartsInventory(updatedOrder, get, set);
          const idx = updated.findIndex((r) => r.id === orderId);
          if (idx !== -1) updated[idx] = orderWithDeductedParts;
          remainingBalance = repairRemainingBalance(orderWithDeductedParts);
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

        // UPGRADE-05: settlement hooks. Delivered = settled: stamp the
        // commission ONCE (payroll basis, from the assigned technician's
        // active rule) and end any running bench session. Cancelling ends
        // the session too — an open row after Annulé would inflate payroll
        // forever. Both are best-effort: bookkeeping must never block the
        // status change itself.
        if (newStatus === 'Livré') {
          const finalOrder = updated.find((r) => r.id === orderId);
          if (finalOrder) await stampCommissionIfDue(finalOrder, nowIso);
          // UPGRADE-06: a redo ticket delivered closes its warranty claim with
          // the absorbed bases — the labor it billed (0 on a fully-free redo)
          // and its own frozen parts cost basis (the real cost of the parts
          // the shop replaced under warranty). Best-effort: bookkeeping never
          // blocks the delivery itself.
          if (finalOrder?.reworkOfRepairId) {
            try {
              const { closeWarrantyClaimForRework } = await import('../../db/adapters/savRmaAdapter');
              await closeWarrantyClaimForRework(finalOrder.id, {
                laborBasis: Math.max(0, Number(finalOrder.laborCost) || 0),
                partsBasis: Math.max(0, Number(finalOrder.partsCostBasis) || 0),
                closedAt: nowIso,
              });
            } catch {
              /* best-effort */
            }
          }
        }
        if (newStatus === 'Livré' || newStatus === 'Annulé') {
          try {
            const { closeOpenTimeLogsForRepair } = await import('../../db/adapters/techniciansAdapter');
            await closeOpenTimeLogsForRepair(orderId, nowIso);
          } catch {
            /* timer close is best-effort — never blocks the status change */
          }
        }

        if (newStatus === 'Annulé' && target.status !== 'Annulé') {
          if (target.spareParts?.some((p) => p.isConsumed)) {
            const orderWithRestoredParts = await restoreSparePartsInventory(updatedOrder, get, set);
            const idx = updated.findIndex((r) => r.id === orderId);
            if (idx !== -1) updated[idx] = orderWithRestoredParts;
          }
          const depAmt = Number(target.depositAmount || 0);
          if (depAmt > 0 && get().activeShift) {
            await get().logCashMovement(
              depAmt,
              'EXPENSE',
              `SAV_ACOMPTE: Remboursement Acompte SAV Annulé #${target.ticketNumber} (${target.customerName} - ${target.deviceModel})`,
              get().activeCashier?.name || 'Caissier',
              undefined,
              'SAV_ACOMPTE_REFUND',
              'REPAIR_ORDER',
              target.id
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
    const targetBefore = repairOrders.find((r) => r.id === orderId);
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
        updatedAt: new Date().toISOString(),
      };
    });
    const target = updated.find((r) => r.id === orderId);
    if (target) {
      try {
        await (await getRepairRepo()).save(target);

        // Track deposit changes in cash movements
        if (targetBefore && updates.depositAmount !== undefined) {
          const delta = Number(target.depositAmount || 0) - Number(targetBefore.depositAmount || 0);
          if (delta !== 0 && get().activeShift) {
            if (delta > 0) {
              await get().logCashMovement(
                delta,
                'MANUAL_DEPOSIT',
                `SAV_ACOMPTE: Complément Acompte #${target.ticketNumber} (${target.customerName} - ${target.deviceModel})`,
                get().activeCashier?.name || 'Caissier',
                undefined,
                'SAV_ACOMPTE',
                'REPAIR_ORDER',
                target.id
              );
            } else {
              await get().logCashMovement(
                Math.abs(delta),
                'EXPENSE',
                `SAV_ACOMPTE: Remboursement Partiel Acompte #${target.ticketNumber} (${target.customerName} - ${target.deviceModel})`,
                get().activeCashier?.name || 'Caissier',
                undefined,
                'SAV_ACOMPTE_REFUND',
                'REPAIR_ORDER',
                target.id
              );
            }
          }
        }

        // If order is completed/delivered and has unconsumed spare parts, consume them
        if ((target.status === 'Prêt / Terminé' || target.status === 'Livré') && target.spareParts?.some((p) => !p.isConsumed)) {
          const orderWithDeductedParts = await consumeSparePartsInventory(target, get, set);
          const idx = updated.findIndex((r) => r.id === orderId);
          if (idx !== -1) updated[idx] = orderWithDeductedParts;
        }

        // UPGRADE-05: an edit landing the ticket on Livré (zero-balance
        // correction path) settles commissions + bench time exactly like the
        // status lane. Fresh reference: part consumption above may have
        // replaced the object in `updated`.
        if (target.status === 'Livré') {
          const finalTarget = updated.find((r) => r.id === orderId);
          const settledIso = new Date().toISOString();
          if (finalTarget) await stampCommissionIfDue(finalTarget, settledIso);
          // UPGRADE-06: same settlement semantics as the status lane — a redo
          // ticket settled through an edit closes its warranty claim too.
          if (finalTarget?.reworkOfRepairId) {
            try {
              const { closeWarrantyClaimForRework } = await import('../../db/adapters/savRmaAdapter');
              await closeWarrantyClaimForRework(finalTarget.id, {
                laborBasis: Math.max(0, Number(finalTarget.laborCost) || 0),
                partsBasis: Math.max(0, Number(finalTarget.partsCostBasis) || 0),
                closedAt: settledIso,
              });
            } catch {
              /* best-effort */
            }
          }
          try {
            const { closeOpenTimeLogsForRepair } = await import('../../db/adapters/techniciansAdapter');
            await closeOpenTimeLogsForRepair(orderId, settledIso);
          } catch {
            /* best-effort */
          }
        }
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

  assignRepairTechnician: async (orderId, technicianId) => {
    const { repairOrders } = get();
    const target = repairOrders.find((r) => r.id === orderId);
    if (!target) return { success: false, reason: 'NOT_FOUND' };
    const current = target.assignedTechnicianId ?? null;
    if ((technicianId ?? null) === current) return { success: true };

    let name: string | undefined;
    if (technicianId) {
      try {
        const { getTechnician } = await import('../../db/adapters/techniciansAdapter');
        const tech = await getTechnician(technicianId);
        if (!tech) return { success: false, reason: 'TECHNICIAN_NOT_FOUND' };
        name = tech.name;
      } catch {
        return { success: false, reason: 'TECHNICIAN_LOOKUP_FAILED' };
      }
    }

    const nowIso = new Date().toISOString();
    const actor = get().activeCashier?.name || 'Caissier';
    const updated = repairOrders.map((r) => {
      if (r.id !== orderId) return r;
      return {
        ...r,
        assignedTechnicianId: technicianId ?? undefined,
        // Frozen display name — slips stay readable after a roster rename.
        assignedTechnicianName: technicianId ? name : undefined,
        updatedAt: nowIso,
        // Reassignment is accountability evidence: append-only timeline note.
        statusHistory: appendRepairStatusHistory(
          r,
          r.status,
          actor,
          technicianId ? `Technicien assigné : ${name}` : 'Technicien retiré'
        ),
      } as RepairOrder;
    });
    const nextOrder = updated.find((r) => r.id === orderId);
    if (!nextOrder) return { success: false, reason: 'NOT_FOUND' };
    try {
      await (await getRepairRepo()).save(nextOrder);
    } catch (err) {
      console.error(`Failed to assign technician [${orderId}]:`, err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }
    set({ repairOrders: updated });
    // Late-assignment catch-up: a delivered ticket that never received its
    // evaluation (assigned after delivery as a records correction) settles
    // now, exactly as it would have at delivery.
    if (technicianId && nextOrder.status === 'Livré') {
      await stampCommissionIfDue(nextOrder, nowIso);
    }
    return { success: true };
  },

  startRepairTimer: async (orderId, technicianId) => {
    const order = get().repairOrders.find((r) => r.id === orderId);
    if (!order) return { success: false, reason: 'NOT_FOUND' };
    if (order.status === 'Livré' || order.status === 'Annulé') {
      return { success: false, reason: 'TICKET_CLOSED' };
    }
    try {
      const { getOpenTimeLogForRepair, getTechnician, startTimeLog } = await import(
        '../../db/adapters/techniciansAdapter'
      );
      const tech = await getTechnician(technicianId);
      if (!tech) return { success: false, reason: 'TECHNICIAN_NOT_FOUND' };
      const open = await getOpenTimeLogForRepair(orderId);
      if (open) {
        // One bench session per repair — a second concurrent row would
        // double-pay the same wall-clock minutes.
        return {
          success: false,
          reason: open.technicianId === technicianId ? 'ALREADY_RUNNING' : 'OTHER_SESSION_RUNNING',
        };
      }
      const id = await startTimeLog(orderId, technicianId, 'work');
      return id ? { success: true } : { success: false, reason: 'PERSISTENCE_FAILED' };
    } catch (err) {
      console.error(`Failed to start timer [${orderId}]:`, err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }
  },

  stopRepairTimer: async (orderId) => {
    try {
      const { closeOpenTimeLogsForRepair, getOpenTimeLogForRepair } = await import(
        '../../db/adapters/techniciansAdapter'
      );
      const open = await getOpenTimeLogForRepair(orderId);
      if (!open) return { success: false, reason: 'NO_RUNNING_SESSION' };
      const endedAt = new Date().toISOString();
      const closed = await closeOpenTimeLogsForRepair(orderId, endedAt);
      if (closed <= 0) return { success: false, reason: 'PERSISTENCE_FAILED' };
      const elapsedMs = Math.max(0, new Date(endedAt).getTime() - new Date(open.startedAt).getTime());
      return { success: true, elapsedMs };
    } catch (err) {
      console.error(`Failed to stop timer [${orderId}]:`, err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }
  },
});
