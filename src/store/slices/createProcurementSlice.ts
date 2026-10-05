import type { StateCreator } from 'zustand';
import type { PosState, ProcurementSlice } from '../types';
import type { PurchaseOrder, POLineItem } from '../../types/pos';
import { formatDZD } from '../../types/pos';
// P11.3: sqliteAdapter is a barrel over six adapters that each statically pull
// Dexie + libsql. A static import here pins the whole DB graph into the entry
// chunk and defeats the lazy resolvers used by the other slices.
async function getSqlite() {
  const { sqliteAdapter } = await import('../../db/sqliteAdapter');
  return sqliteAdapter;
}
import { calculateStockAlerts, getDynamicThreshold } from '../../utils/alertEngine';
import { newId, newReceiptNumber } from '../../utils/ids';
import { utcNowIso } from '../../utils/dateUtils';

// P11.3: productRepository pulls sqliteAdapter -> dexie + libsql into the entry.
async function getProductRepo() {
  const { productRepository } = await import('../../db/repositories/productRepository');
  return productRepository;
}
import { audioBus } from '../../utils/audioEvents';
import { rebaseReconciledSales } from './rebaseReconciledSales';

/**
 * Same-window double-submit guard for PO receipts (mirrors voidInFlight /
 * refundInFlight): a double-tap on "Valider" must not run the same receipt
 * twice — the second call fails fast while the first is in flight.
 * Sequential duplicates are impossible (Completed guard above); BUSY
 * retries converge via the deterministic delta/batch identities below.
 * Entries carry a timestamp backstop so an unexpected throw between add and
 * release can never wedge the PO forever (stale entries expire).
 */
const receiveInFlight = new Map<string, number>();
const RECEIVE_FLIGHT_TTL_MS = 10 * 60_000;
import { getEffectiveCostPrice } from '../../utils/pricingEngine';
import { resolveReferenceCost } from '../../utils/referenceCost';
import { validateDeviceIdentifierForIntake } from '../../utils/savValidation';
import type { LedgerDeltaInput } from '../../db/sqlPluginAdapter';
import type { VendorDirectoryEntry } from '../../types/pos';

export const VENDOR_DIRECTORY_KEY = 'mobi_vendor_directory_v1';

function loadVendorDirectory(): Record<string, VendorDirectoryEntry> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(VENDOR_DIRECTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, VendorDirectoryEntry>;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveVendorDirectory(directory: Record<string, VendorDirectoryEntry>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VENDOR_DIRECTORY_KEY, JSON.stringify(directory));
  } catch {
    // Quota/private-mode — in-memory state still works for the session.
  }
}

export const createProcurementSlice: StateCreator<PosState, [], [], ProcurementSlice> = (set, get) => ({
  purchaseOrders: [],
  activeDraftPO: null,
  poDraftBuilderRequested: false,
  dismissedProcurementIds: [],
  customQtyMap: {},
  selectedItemsMap: {},
  extraVendorProducts: {},
  customActiveVendors: [],
  vendorMoqMap: {},
  vendorDirectory: loadVendorDirectory(),

  dismissProcurementProduct: (productId) => {
    const { dismissedProcurementIds } = get();
    if (!dismissedProcurementIds.includes(productId)) {
      set({ dismissedProcurementIds: [...dismissedProcurementIds, productId] });
    }
  },

  restoreDismissedProcurementProducts: () => {
    set({ dismissedProcurementIds: [] });
  },

  setCustomQty: (productId, qty) => {
    const validQty = Math.max(1, Number.isNaN(qty) ? 1 : Math.floor(qty));
    set((s) => ({ customQtyMap: { ...s.customQtyMap, [productId]: validQty } }));
  },

  setCustomQtyBatch: (entries) => {
    set((s) => ({ customQtyMap: { ...s.customQtyMap, ...entries } }));
  },

  removeCustomQtyForVendor: (productIds) => {
    set((s) => {
      const next = { ...s.customQtyMap };
      productIds.forEach((id) => {
        delete next[id];
      });
      return { customQtyMap: next };
    });
  },

  toggleProcurementItem: (productId) => {
    set((s) => ({
      selectedItemsMap: {
        ...s.selectedItemsMap,
        [productId]: s.selectedItemsMap[productId] === undefined ? false : !s.selectedItemsMap[productId],
      },
    }));
  },

  setProcurementItemsSelected: (productIds, selected) => {
    set((s) => {
      const next = { ...s.selectedItemsMap };
      productIds.forEach((id) => {
        next[id] = selected;
      });
      return { selectedItemsMap: next };
    });
  },

  addExtraVendorProduct: (vendorName, productId) => {
    set((s) => {
      const current = s.extraVendorProducts[vendorName] || [];
      if (current.includes(productId)) return s as Partial<PosState>;
      return {
        extraVendorProducts: { ...s.extraVendorProducts, [vendorName]: [...current, productId] },
        selectedItemsMap: { ...s.selectedItemsMap, [productId]: true },
      };
    });
  },

  removeExtraVendorProduct: (vendorName, productId) => {
    set((s) => ({
      extraVendorProducts: {
        ...s.extraVendorProducts,
        [vendorName]: (s.extraVendorProducts[vendorName] || []).filter((id) => id !== productId),
      },
    }));
  },

  setCustomActiveVendors: (vendors) => {
    set({ customActiveVendors: vendors });
  },

  addCustomActiveVendor: (vendorName) => {
    const trimmed = vendorName.trim();
    if (!trimmed) return;
    set((s) => (s.customActiveVendors.includes(trimmed) ? (s as Partial<PosState>) : { customActiveVendors: [...s.customActiveVendors, trimmed] }));
  },

  removeCustomActiveVendor: (vendorName) => {
    set((s) => ({ customActiveVendors: s.customActiveVendors.filter((v) => v !== vendorName) }));
  },

  setVendorMoq: (vendorName, target) => {
    if (!(target > 0)) return;
    set((s) => ({ vendorMoqMap: { ...s.vendorMoqMap, [vendorName]: Math.round(target) } }));
  },

  setVendorContact: (vendorName, contact) => {
    const trimmed = vendorName.trim();
    if (!trimmed) return;
    set((s) => {
      const next = {
        ...s.vendorDirectory,
        [trimmed]: { ...s.vendorDirectory[trimmed], ...contact, updatedAt: utcNowIso() },
      };
      saveVendorDirectory(next);
      return { vendorDirectory: next };
    });
  },

  clearProcurementDraft: () => {
    set({
      customQtyMap: {},
      selectedItemsMap: {},
      extraVendorProducts: {},
      customActiveVendors: [],
      vendorMoqMap: {},
    });
  },

  setActiveDraftPO: (po) => {
    set({ activeDraftPO: po });
  },

  requestPoDraftBuilder: () => {
    set({ poDraftBuilderRequested: true });
  },

  consumePoDraftBuilder: () => {
    set({ poDraftBuilderRequested: false });
  },

  // NOTE: declared `void` in ProcurementSlice (owned by another agent) but
  // implemented async returning { success, reason? } — old callers ignoring
  // the return still compile; new callers can await it to toast failures.
  createDraftPOForVendor: async (vendorName, customItems, status = 'Waiting List') => {
    const { products, purchaseOrders } = get();

    let lineItems: POLineItem[];

    if (customItems && customItems.length > 0) {
      lineItems = customItems.map((ci) => {
        const p = products.find((prod) => prod.id === ci.productId);
        // B-033: integer DZD unit cost — PO totals feed COGS/expenses.
        const unitCost = Math.max(
          0,
          Math.round(ci.unitCost !== undefined ? ci.unitCost : p ? getEffectiveCostPrice(p) : 0)
        );
        return {
          productId: ci.productId,
          title: p ? p.title : 'Produit',
          sku: p ? p.sku : 'SKU-N/A',
          currentStock: p ? p.stock : 0,
          suggestedQty: ci.qty,
          receivedQty: 0,
          unitCost,
          actualUnitCost: unitCost,
          totalCost: ci.qty * unitCost,
          actualTotalCost: 0,
          status: 'Pending',
        };
      });
    } else {
      const alerts = calculateStockAlerts(products).filter(
        (a) => (a.vendorName || 'Fournisseur Général') === vendorName
      );

      lineItems = alerts
        .map((a) => {
          const p = products.find((prod) => prod.id === a.productId);
          if (!p) return null;
          const suggestedQty = Math.max(1, getDynamicThreshold(p) * 2 - p.stock);
          const unitCost = getEffectiveCostPrice(p);
          return {
            productId: p.id,
            title: p.title,
            sku: p.sku,
            currentStock: p.stock,
            suggestedQty,
            receivedQty: 0,
            unitCost,
            actualUnitCost: unitCost,
            totalCost: suggestedQty * unitCost,
            actualTotalCost: 0,
            status: 'Pending' as const,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
    }

    const totalAmount = lineItems.reduce((acc, item) => acc + item.totalCost, 0);

    const newPO: PurchaseOrder = {
       id: newId('po'),
       poNumber: newReceiptNumber('PO'),
      vendorName,
      createdAt: utcNowIso(),
      items: lineItems,
      totalAmount,
      status: status || 'Waiting List',
    };

    // Persist FIRST: a memory-only draft whose save fails must never open the
    // PO modal as if it existed (the old fire-and-forget logged and showed
    // the draft anyway — a silent phantom order). Failure returns before any
    // set() and emits a loud failure signal (sound + console + toast event
    // for the UI layer to surface; no silent memory-only draft).
    try {
      await (await getSqlite()).savePurchaseOrder(newPO);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('Draft purchase order persistence FAILED — draft discarded:', err);
      audioBus.emit('error');
      try {
        window.dispatchEvent(
          new CustomEvent('mobi:toast', {
            detail: { message: `Brouillon non enregistré (${reason})`, type: 'error' },
          }),
        );
      } catch {
        // No event bus — console error above is the loud signal.
      }
      return { success: false, reason };
    }

    const updatedPOs = [newPO, ...purchaseOrders.filter((p) => p.id !== newPO.id)];
    set({
      activeDraftPO: newPO,
      purchaseOrders: updatedPOs,
      activeModal: 'purchase_order',
    });
    return { success: true };
  },

  createWaitingListPO: async (vendorName, customItems, notes) => {
    const { products, purchaseOrders, logSecurityAction } = get();

    let lineItems: POLineItem[];
    if (customItems && customItems.length > 0) {
      lineItems = customItems.map((ci) => {
        const p = products.find((prod) => prod.id === ci.productId);
        // B-033: integer DZD unit cost — PO totals feed COGS/expenses.
        const unitCost = Math.max(
          0,
          Math.round(ci.unitCost !== undefined ? ci.unitCost : p ? getEffectiveCostPrice(p) : 0)
        );
        return {
          productId: ci.productId,
          title: p ? p.title : 'Produit',
          sku: p ? p.sku : 'SKU-N/A',
          currentStock: p ? p.stock : 0,
          suggestedQty: ci.qty,
          receivedQty: 0,
          unitCost,
          actualUnitCost: unitCost,
          totalCost: ci.qty * unitCost,
          actualTotalCost: 0,
          status: 'Pending',
        };
      });
    } else {
      lineItems = [];
    }

    const totalAmount = lineItems.reduce((acc, item) => acc + item.totalCost, 0);
    const newPO: PurchaseOrder = {
       id: newId('po'),
       poNumber: newReceiptNumber('PO'),
      vendorName,
      createdAt: utcNowIso(),
      items: lineItems,
      totalAmount,
      status: 'Waiting List',
      notes,
    };

    const updated = [newPO, ...purchaseOrders];
    try {
      await (await getSqlite()).savePurchaseOrder(newPO);
    } catch (err) {
      // B-034: fail closed like createDraftPOForVendor — never set() a
      // memory-only waiting-list PO after a failed durable save.
      const reason = err instanceof Error ? err.message : String(err);
      console.error('Failed to save waiting list PO — discarded:', err);
      audioBus.emit('error');
      try {
        window.dispatchEvent(
          new CustomEvent('mobi:toast', {
            detail: { message: `Bon non enregistré (${reason})`, type: 'error' },
          }),
        );
      } catch {
        // No event bus — console error above is the loud signal.
      }
      return { success: false, reason } as unknown as PurchaseOrder;
    }

    logSecurityAction(
      'Création Bon de Commande (Liste d\'Attente)',
      `Bon #${newPO.poNumber} placé en attente pour ${vendorName} (${formatDZD(totalAmount)})`,
      'Admin',
      false
    );

    set({ purchaseOrders: updated, activeDraftPO: newPO });
    return newPO;
  },

  createManualPurchaseOrder: async (vendorName, items, notes) => {
    return get().createWaitingListPO(vendorName, items, notes);
  },

  validateAndReceivePO: async (payload) => {
    const { poId, verifiedItems, recordExpense = true, expensePaymentMethod = 'Espèces', notes } = payload;
    const { purchaseOrders, products, logSecurityAction, addStoreExpense } = get();

    const targetPO = purchaseOrders.find((p) => p.id === poId);
    if (!targetPO) return { success: false, isPartial: false, totalReceivedCost: 0 };
    // Terminal-state guard: a Completed PO already minted all of its stock,
    // batches, ledger deltas and expenses. Re-validating it (e.g. reopened
    // from history detail views where the verify grid is editable) would
    // mint unbounded duplicate stock. Partial receipts stay receivable by
    // design — remaining-qty defaults make them exact.
    if (targetPO.status === 'Completed') {
      return { success: false, isPartial: false, totalReceivedCost: 0, reason: 'PO_ALREADY_COMPLETED' };
    }
    const flightSince = receiveInFlight.get(poId);
    if (flightSince !== undefined && Date.now() - flightSince < RECEIVE_FLIGHT_TTL_MS) {
      return { success: false, isPartial: false, totalReceivedCost: 0, reason: 'PO_ALREADY_PROCESSING' };
    }
    receiveInFlight.set(poId, Date.now());
    // One operation nonce per receipt run: delta + batch identities derive
    // from it, so a BUSY-after-commit retry converges via ON CONFLICT
    // instead of doubling stock, while distinct receipts never collide.
    // Released at every exit below (success, fail-closed, or throw).
    const receiveNonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const releaseReceiveFlight = () => {
      receiveInFlight.delete(poId);
    };

    let totalReceivedCost = 0;
    let totalReceivedUnits = 0;
    const verifiedMap = new Map(verifiedItems.map((vi) => [vi.productId, vi]));

    // W-43 — a PO receipt is an ACQUISITION writer, so the scanned/pasted
    // identifiers get the same gate as the trade-in and the invoice import
    // before any stock, batch or expense is minted: a 15-digit Luhn failure is
    // REFUSED (a registry row nothing can resolve is worse than no row), a
    // serial passes, a duplicate is a WARNING.
    //
    // Fail-closed here, unlike the invoice import: a purchase order is a signed
    // commercial document, so a bad identifier must abort the receipt instead of
    // importing 40 good lines and dropping one — the operator re-scans and
    // re-submits the whole document. Blank entries are legitimate (a
    // non-serialized accessory line), so they are skipped, not refused.
    const { imeiRecords } = get();
    const knownIdentifiers = [
      ...(imeiRecords || []).map((r) => r.imei),
      // The PO's own earlier lines: two receipts of the same PO must not
      // collide with each other.
      ...verifiedItems.flatMap((vi) => vi.imeis || []),
    ];
    for (const vi of verifiedItems) {
      for (const raw of vi.imeis || []) {
        const candidate = String(raw ?? '').trim();
        if (!candidate) continue;
        const verdict = validateDeviceIdentifierForIntake(candidate, knownIdentifiers);
        if (!verdict.ok) {
          releaseReceiveFlight();
          return {
            success: false,
            isPartial: false,
            totalReceivedCost: 0,
            reason: `IDENTIFIER_REFUSED:${verdict.reason} (${candidate})`,
          };
        }
        if (verdict.warning) console.warn('[validateAndReceivePO]', verdict.warning);
      }
    }
    // Canonicalise before anything is written, so the line, the product and any
    // later registry row all carry one spelling of the device.
    const canonicalVerifiedItems = verifiedItems.map((vi) => ({
      ...vi,
      imeis: (vi.imeis || []).map((raw) => {
        const candidate = String(raw ?? '').trim();
        if (!candidate) return raw;
        return validateDeviceIdentifierForIntake(candidate).canonical;
      }),
    }));
    verifiedMap.clear();
    for (const vi of canonicalVerifiedItems) verifiedMap.set(vi.productId, vi);

    // 1. Update Product Stocks and Cost Reference (first-known cost only —
    // per-receipt costs live on stock_batches rows, never on the product).
    const updatedProducts = products.map((p) => {
      const verified = verifiedMap.get(p.id);
      if (verified && verified.receivedQty > 0) {
        const receivedQty = Math.max(0, verified.receivedQty);
        // B-033: integer DZD — received cost lands whole in product.costPrice.
        const actualCost = Math.max(
          0,
          Math.round(
            verified.actualUnitCost !== undefined && verified.actualUnitCost > 0
              ? verified.actualUnitCost
              : p.costPrice
          )
        );
        // Batch-based FIFO: the per-receipt actual cost lives on the new
        // stock_batches row minted below — NOT on the product. costPrice is a
        // catalog REFERENCE frozen at the first-known cost: overwriting it
        // with every invoice repriced prior inventory at the newest cost
        // (the 500/400 → 6200 bug). Manual edits (ProductEditor) and catalog
        // sync still manage it deliberately; a missing cost still initializes
        // from the first receipt.
        const referenceCost = resolveReferenceCost(p.costPrice, actualCost);

        return {
          ...p,
          stock: p.stock + receivedQty,
          costPrice: referenceCost,
          purchaseOrderId: targetPO.id,
        };
      }
      return p;
    });

    // 2. Update Purchase Order Line Items
    let allItemsFullyReceived = true;
    const updatedLineItems: POLineItem[] = targetPO.items.map((item) => {
      const verified = verifiedMap.get(item.productId);
      if (!verified) {
        if ((item.receivedQty || 0) < item.suggestedQty) {
          allItemsFullyReceived = false;
        }
        return item;
      }

      const receivedQty = (item.receivedQty || 0) + Math.max(0, verified.receivedQty);
      // B-033: integer DZD unit cost at receive boundary.
      const actualUnitCost = Math.max(
        0,
        Math.round(
          verified.actualUnitCost !== undefined && verified.actualUnitCost > 0
            ? verified.actualUnitCost
            : item.unitCost
        )
      );

      const lineReceivedCost = verified.receivedQty * actualUnitCost;
      totalReceivedCost += lineReceivedCost;
      totalReceivedUnits += verified.receivedQty;

      const isLineComplete = receivedQty >= item.suggestedQty;
      if (!isLineComplete) {
        allItemsFullyReceived = false;
      }

      let lineStatus: POLineItem['status'] = 'Pending';
      if (receivedQty >= item.suggestedQty) {
        lineStatus = 'Received';
      } else if (receivedQty > 0) {
        lineStatus = 'Partially Received';
      }

      if (verified.discrepancyReason && verified.discrepancyReason.trim()) {
        lineStatus = 'Discrepancy';
      }

      return {
        ...item,
        receivedQty,
        actualUnitCost,
        actualTotalCost: (item.actualTotalCost || 0) + lineReceivedCost,
        imeis: verified.imeis ? [...(item.imeis || []), ...verified.imeis] : item.imeis,
        status: lineStatus,
        discrepancyReason: verified.discrepancyReason || item.discrepancyReason,
      };
    });

    // Determine Final PO Status
    const newStatus: PurchaseOrder['status'] = allItemsFullyReceived ? 'Completed' : 'Partially Received';

    const updatedPO: PurchaseOrder = {
      ...targetPO,
      items: updatedLineItems,
      actualTotalAmount: (targetPO.actualTotalAmount || 0) + totalReceivedCost,
      status: newStatus,
      validatedAt: utcNowIso(),
      receivedAt: utcNowIso(),
      notes: notes || targetPO.notes,
      expenseRecorded: recordExpense ? true : targetPO.expenseRecorded,
    };

    const updatedPOs = purchaseOrders.map((p) => (p.id === poId ? updatedPO : p));

    // Build Inventory Ledger deltas for incoming stock. Identities derive
    // from the run nonce: a BUSY-after-commit retry converges via
    // ON CONFLICT instead of double-booking the receipt.
    const deltas: LedgerDeltaInput[] = [];
    for (const vi of verifiedItems) {
      if (vi.receivedQty > 0) {
        const deltaKey = `recv-${poId}-${vi.productId}-${receiveNonce}`;
        deltas.push({
          id: deltaKey,
          idempotencyKey: deltaKey,
          productId: vi.productId,
          delta: Math.max(0, vi.receivedQty),
          reason: 'RECEIVE',
          refType: 'PURCHASE_ORDER',
          refId: targetPO.id,
        });
      }
    }

    // Save to Database & SQLite Inventory Ledger (Atomic)
    try {
      if (deltas.length > 0) {
        // P11.3: sqlPluginAdapter pulls the libsql/Turso sync graph; load on first write.
        const { appendInventoryDeltas, insertStockBatch, ensureProductParents } = await import('../../db/sqlPluginAdapter');
        await appendInventoryDeltas(deltas);
        // FK-parent bridge: a Dexie-only product would abort the batch INSERT
        // below (FK) while the delta + stock bump persist — stranding
        // untracked stock. Best-effort, never fails the receipt.
        await ensureProductParents(verifiedItems.map((vi) => vi.productId));

        // Insert FIFO stock batches for verified received units
        for (const vi of verifiedItems) {
          if (vi.receivedQty > 0) {
            // B-033/integer-DA + CHECK hardening at the receipt boundary: the
            // raw verified cost must never reach the batch insert — a negative
            // value trips CHECK (unit_cost >= 0), the batch insert fails
            // warn-only while the ledger delta + stock bump above persist,
            // stranding untracked stock that later shadows at the latest cost.
            // Clamp once here so SQLite + Dexie mirrors stay identical.
            const actualCost = Math.max(
              0,
              Math.round(
                vi.actualUnitCost !== undefined
                  ? vi.actualUnitCost
                  : targetPO.items.find((i) => i.productId === vi.productId)?.unitCost ?? 0
              )
            );
            const batchId = `batch-po-${poId}-${vi.productId}-${receiveNonce}`;
            await insertStockBatch({
              batchId,
              productId: vi.productId,
              quantityRemaining: vi.receivedQty,
              unitCost: actualCost,
              purchaseOrderId: targetPO.id,
              idempotencyKey: `sb-${batchId}`,
            }).catch((err) => {
              console.warn('[procurement:batch] Failed to insert stock batch in SQLite:', err);
            });

            try {
              const { dexieDb } = await import('../../db/database');
              await dexieDb.stockBatches.put({
                batchId,
                productId: vi.productId,
                quantityRemaining: vi.receivedQty,
                unitCost: actualCost,
                receivedAt: utcNowIso(),
                purchaseOrderId: targetPO.id,
              });
            } catch (dexieErr) {
              console.warn('[procurement:batch] Failed to insert stock batch in Dexie:', dexieErr);
            }
          }
        }

        const { syncManager } = await import('../../sync/SyncManager');
        syncManager.notifyLocalWrite();
      }
      const changedProductIds = new Set(
        verifiedItems.filter((item) => item.receivedQty > 0).map((item) => item.productId)
      );
      const changedProducts = updatedProducts.filter((product) => changedProductIds.has(product.id));
      await (await getProductRepo()).bulkSave(changedProducts);
      await (await getSqlite()).savePurchaseOrder(updatedPO);
    } catch (err) {
      // B-034: fail closed — do not expense/set()/return success after a
      // failed durable save (that created phantom POs + phantom expenses).
      console.error('Failed to save validated PO & inventory deltas:', err);
      releaseReceiveFlight();
      return { success: false, isPartial: false, totalReceivedCost: 0, reason: 'PO_PERSISTENCE_FAILED' };
    }

    // 3. Automated Financial Expense Recording (Linked to EBITDA Reports & Cash Movements)
    if (recordExpense && totalReceivedCost > 0) {
      await addStoreExpense({
        category: 'Achat Marchandises / Fournisseur',
        title: `Achat Fournisseur : ${targetPO.vendorName} (Bon #${targetPO.poNumber})`,
        amount: totalReceivedCost,
        paymentMethod: expensePaymentMethod,
        paidTo: targetPO.vendorName,
        notes: `Réception marchandise validée (+${totalReceivedUnits} unités) - Statut: ${
          newStatus === 'Completed' ? 'Complète' : 'Partielle'
        }`,
        recordedBy: 'Admin (Réception Stock)',
      });
    }

    audioBus.emit('success');
    logSecurityAction(
      'Validation & Réception Bon Fournisseur',
      `Bon #${targetPO.poNumber} (${targetPO.vendorName}) validé: +${totalReceivedUnits} unités entrées en stock (${formatDZD(
        totalReceivedCost
      )}) - Statut: ${newStatus}`,
      'Admin (Stock)',
      false
    );
    // Fraud trail: reception is the trust anchor of every downstream COGS
    // number (FIFO math, gates, audit exports all inherit the typed cost).
    // Any line whose received cost was edited away from the PO-suggested
    // cost gets ONE consolidated audit entry (audit-only, no PIN friction).
    // Untouched lines resolve to the suggested cost by construction, so only
    // genuine human overrides land here. Fail-closed: logged only for the
    // committed receipt above, never for aborted ones.
    {
      const overrides: string[] = [];
      for (const item of targetPO.items) {
        const verified = verifiedMap.get(item.productId);
        if (!verified || !(Math.max(0, verified.receivedQty) > 0)) continue;
        const suggested = Math.max(0, Math.round(item.unitCost || 0));
        const actual = Math.max(
          0,
          Math.round(
            verified.actualUnitCost !== undefined && verified.actualUnitCost > 0
              ? verified.actualUnitCost
              : item.unitCost
          )
        );
        if (actual !== suggested) {
          const pct =
            suggested > 0
              ? ` (${((actual - suggested) / suggested) * 100 >= 0 ? '+' : ''}${(((actual - suggested) / suggested) * 100).toFixed(1)}%)`
              : '';
          overrides.push(`${item.sku || item.productId}: ${formatDZD(suggested)}/u → ${formatDZD(actual)}/u${pct}`);
        }
      }
      if (overrides.length > 0) {
        logSecurityAction(
          'Écart Coût Réception Fournisseur',
          `Bon #${targetPO.poNumber} (${targetPO.vendorName}) — coût corrigé à la réception sur ${overrides.length} ligne(s): ${overrides.join(' ; ')}`,
          'Admin (Stock)',
          false
        );
      }
    }

    set({
      products: updatedProducts,
      purchaseOrders: updatedPOs,
      activeDraftPO: updatedPO,
    });

    // Shadow reconcile runs inside the batch inserts above and may have
    // retro-corrected older sales — rebase the in-memory mirror so an open
    // ticket inspector converges now instead of at the next boot/pull.
    await rebaseReconciledSales(get, set);

    releaseReceiveFlight();
    return {
      success: true,
      isPartial: newStatus === 'Partially Received',
      totalReceivedCost,
    };
  },

  cancelPO: async (poId, reason) => {
    const { purchaseOrders, logSecurityAction } = get();
    const target = purchaseOrders.find((p) => p.id === poId);
    if (!target) return;

    // Received stock is already on the shelves (batches + ledger + expense
    // booked): cancelling the PO row would orphan it with no owning
    // document. Received POs can only be adjusted via new movements, never
    // by deleting their paper trail.
    const receivedUnits = (target.items || []).reduce((a, i) => a + Math.max(0, i.receivedQty || 0), 0);
    if (receivedUnits > 0) {
      audioBus.emit('error');
      try {
        window.dispatchEvent(
          new CustomEvent('mobi:toast', {
            detail: { message: `Bon #${target.poNumber} déjà partiellement réceptionné (${receivedUnits} unités) — annulation impossible.`, type: 'error' },
          }),
        );
      } catch {
        // No event bus — console error below is the signal.
      }
      console.error(`[procurement] Cancel refused for partially received PO [${poId}]: ${receivedUnits} units already in stock.`);
      return;
    }

    const cancelled: PurchaseOrder = {
      ...target,
      status: 'Cancelled',
      notes: reason ? `Annulé: ${reason}` : target.notes,
    };
    try {
      await (await getSqlite()).savePurchaseOrder(cancelled);
    } catch (err) {
      // B-034: fail closed — a failed durable cancel must not set() Cancelled.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Failed to cancel PO [${poId}]:`, err);
      audioBus.emit('error');
      try {
        window.dispatchEvent(
          new CustomEvent('mobi:toast', {
            detail: { message: `Annulation non enregistrée (${detail})`, type: 'error' },
          }),
        );
      } catch {
        // No event bus — console error above is the loud signal.
      }
      return;
    }

    logSecurityAction(
      'Annulation Bon de Commande',
      `Bon #${target.poNumber} (${target.vendorName}) annulé. Raison: ${reason || 'Non spécifiée'}`,
      'Admin',
      false
    );
    set({
      purchaseOrders: purchaseOrders.map((p) => (p.id === poId ? cancelled : p)),
      activeDraftPO: get().activeDraftPO?.id === poId ? cancelled : get().activeDraftPO,
    });
  },

  deletePO: async (poId) => {
    const { purchaseOrders } = get();
    // B-034: soft-delete through the same durable path as save — memory-only
    // filter resurrected the PO on next Dexie/SQLite hydrate.
    const target = purchaseOrders.find((p) => p.id === poId);
    // Same orphan-stock rule as cancelPO above: received rows keep their
    // batches, ledger deltas and booked expense — the paper trail stays.
    const receivedUnits = target
      ? (target.items || []).reduce((a, i) => a + Math.max(0, i.receivedQty || 0), 0)
      : 0;
    if (receivedUnits > 0) {
      audioBus.emit('error');
      try {
        window.dispatchEvent(
          new CustomEvent('mobi:toast', {
            detail: { message: `Bon #${target?.poNumber} déjà réceptionné — suppression impossible (archive uniquement).`, type: 'error' },
          }),
        );
      } catch {
        // No event bus — console error below is the signal.
      }
      console.error(`[procurement] Delete refused for received PO [${poId}]: stock already booked.`);
      return;
    }
    if (target) {
      try {
        const { fireSyncDelete, isTauriEnv } = await import('../../db/adapters/base');
        const { db: dexieDb } = await import('../../db/database');
        await dexieDb.purchaseOrders.delete(poId);
        if (isTauriEnv()) {
          const { getLocalDb } = await import('../../db/sqlPluginAdapter');
          const db = await getLocalDb();
          // Soft-delete for the sync lane (PO rows carry no `deleted` column —
          // hard DELETE + fireSyncDelete mirrors deleteRepairOrder/deleteBundle).
          await db.execute('DELETE FROM purchase_orders WHERE id = $1', [poId]).catch((err: unknown) => {
            // Table may not exist in some preview modes — Dexie already landed.
            console.warn('[procurement] SQLite PO delete skipped:', err);
          });
        }
        void fireSyncDelete('purchase_order', poId);
      } catch (err) {
        console.error(`Failed to delete PO [${poId}]:`, err);
        audioBus.emit('error');
        try {
          window.dispatchEvent(
            new CustomEvent('mobi:toast', {
              detail: { message: 'Suppression non enregistrée — le bon reste présent.', type: 'error' },
            }),
          );
        } catch {
          // No event bus — console error above is the loud signal.
        }
        return;
      }
    }
    const updated = purchaseOrders.filter((p) => p.id !== poId);
    set({
      purchaseOrders: updated,
      activeDraftPO: get().activeDraftPO?.id === poId ? null : get().activeDraftPO,
    });
  },

  directRestockVendor: async (vendorName, items) => {
    const { products, logSecurityAction } = get();
    if (!items || items.length === 0) return { success: false, count: 0 };

    const itemsMap = new Map(items.map((i) => [i.productId, i.qty]));
    let restockedUnits = 0;

    const updatedProducts = products.map((p) => {
      if (itemsMap.has(p.id)) {
        const addedQty = itemsMap.get(p.id) || 0;
        restockedUnits += addedQty;
        return { ...p, stock: p.stock + addedQty };
      }
      return p;
    });

    try {
      const changedProductIds = new Set(items.map((item) => item.productId));
      const changedProducts = updatedProducts.filter((product) => changedProductIds.has(product.id));
      await (await getProductRepo()).bulkSave(changedProducts);
      // Batch-tracked JIT stock: same FIFO ledger shape as PO receipts so
      // restocked units carry a cost basis (catalog reference cost — the only
      // cost known here) instead of landing untracked. Best-effort.
      try {
        const lines = items
          .map((item) => {
            const prod = updatedProducts.find((p) => p.id === item.productId);
            const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
            if (!prod || qty <= 0) return null;
            return { productId: item.productId, qty, unitCost: Math.max(0, Math.round(getEffectiveCostPrice(prod))) };
          })
          .filter((l): l is { productId: string; qty: number; unitCost: number } => l !== null);
        if (lines.length > 0) {
          const { appendInventoryDeltas, insertStockBatch } = await import('../../db/sqlPluginAdapter');
          await appendInventoryDeltas(
            lines.map((l) => ({
              productId: l.productId,
              delta: l.qty,
              reason: 'RECEIVE' as const,
              refType: 'JIT_RESTOCK',
              refId: vendorName,
            })),
          );
          for (const l of lines) {
            const batchId = newId('batch');
            await insertStockBatch({
              batchId,
              productId: l.productId,
              quantityRemaining: l.qty,
              unitCost: l.unitCost,
            }).catch((err) => {
              console.warn('[jit:batch] Failed to insert stock batch in SQLite:', err);
            });
            try {
              const { dexieDb } = await import('../../db/database');
              await dexieDb.stockBatches.put({
                batchId,
                productId: l.productId,
                quantityRemaining: l.qty,
                unitCost: l.unitCost,
                receivedAt: utcNowIso(),
              });
            } catch (dexieErr) {
              console.warn('[jit:batch] Failed to insert stock batch in Dexie:', dexieErr);
            }
          }
          try {
            const { syncManager } = await import('../../sync/SyncManager');
            syncManager.notifyLocalWrite();
          } catch {
            // Sync kick best-effort.
          }
        }
      } catch (batchErr) {
        console.warn('[jit:batch] Batch-tracked restock deferred:', batchErr);
      }
      audioBus.emit('success');
      logSecurityAction(
        'Réception Directe Fournisseur (JIT Restock)',
        `Entrée en stock rapide pour ${vendorName} : ${items.length} références (+${restockedUnits} unités)`,
        'Yacine (Admin)',
        false
      );
      set({ products: updatedProducts });
      return { success: true, count: restockedUnits };
    } catch (e) {
      console.error('Direct restock failed:', e);
      return { success: false, count: 0 };
    }
  },

  approvePurchaseOrder: async (poId) => {
    const { activeDraftPO, purchaseOrders, products } = get();
    if (!activeDraftPO || activeDraftPO.id !== poId) return;

    const approvedPO: PurchaseOrder = { ...activeDraftPO, status: 'Completed' };

    const updatedProducts = products.map((p) => {
      const poItem = approvedPO.items.find((item) => item.productId === p.id);
      if (poItem) {
        return { ...p, stock: p.stock + poItem.suggestedQty, purchaseOrderId: approvedPO.id };
      }
      return p;
    });

    const updatedPOs = [approvedPO, ...purchaseOrders.filter((p) => p.id !== approvedPO.id)];
    try {
      await (await getProductRepo()).bulkSave(updatedProducts);
      await (await getSqlite()).savePurchaseOrder(approvedPO);
      // Batch-tracked approval: approved quantities join the FIFO batches
      // ledger at the PO line cost (same shape as validated receipts) so
      // approved stock is never untracked. Best-effort.
      try {
        const lines = approvedPO.items
          .map((poItem) => {
            const qty = Math.max(0, Math.floor(Number(poItem.suggestedQty) || 0));
            if (!poItem.productId || qty <= 0) return null;
            return {
              productId: poItem.productId,
              qty,
              unitCost: Math.max(0, Math.round(Number(poItem.unitCost) || 0)),
            };
          })
          .filter((l): l is { productId: string; qty: number; unitCost: number } => l !== null);
        if (lines.length > 0) {
          const { appendInventoryDeltas, insertStockBatch } = await import('../../db/sqlPluginAdapter');
          await appendInventoryDeltas(
            lines.map((l) => ({
              productId: l.productId,
              delta: l.qty,
              reason: 'RECEIVE' as const,
              refType: 'PURCHASE_ORDER',
              refId: approvedPO.id,
            })),
          );
          for (const l of lines) {
            const batchId = newId('batch');
            await insertStockBatch({
              batchId,
              productId: l.productId,
              quantityRemaining: l.qty,
              unitCost: l.unitCost,
              purchaseOrderId: approvedPO.id,
            }).catch((err) => {
              console.warn('[procurement:batch] Failed to insert approval stock batch in SQLite:', err);
            });
            try {
              const { dexieDb } = await import('../../db/database');
              await dexieDb.stockBatches.put({
                batchId,
                productId: l.productId,
                quantityRemaining: l.qty,
                unitCost: l.unitCost,
                receivedAt: utcNowIso(),
                purchaseOrderId: approvedPO.id,
              });
            } catch (dexieErr) {
              console.warn('[procurement:batch] Failed to insert approval stock batch in Dexie:', dexieErr);
            }
          }
          try {
            const { syncManager } = await import('../../sync/SyncManager');
            syncManager.notifyLocalWrite();
          } catch {
            // Sync kick best-effort.
          }
        }
      } catch (batchErr) {
        console.warn('[procurement:batch] Approval batch tracking deferred:', batchErr);
      }
    } catch (err) {
      console.error(`Failed to approve purchase order [${poId}]:`, err);
    }

    set({
      products: updatedProducts,
      purchaseOrders: updatedPOs,
      activeDraftPO: null,
      activeModal: null,
    });
  },
});
