import type { StateCreator } from 'zustand';
import type { PosState, ProcurementSlice } from '../types';
import type { PurchaseOrder, POLineItem } from '../../types/pos';
import { formatDZD } from '../../types/pos';
import { sqliteAdapter } from '../../db/sqliteAdapter';
import { productRepository } from '../../db/repositories/productRepository';
import { calculateStockAlerts } from '../../utils/alertEngine';
import { audioBus } from '../../utils/audioEvents';
import { getEffectiveCostPrice } from '../../utils/pricingEngine';

export const createProcurementSlice: StateCreator<PosState, [], [], ProcurementSlice> = (set, get) => ({
  purchaseOrders: [],
  activeDraftPO: null,
  dismissedProcurementIds: [],

  dismissProcurementProduct: (productId) => {
    const { dismissedProcurementIds } = get();
    if (!dismissedProcurementIds.includes(productId)) {
      set({ dismissedProcurementIds: [...dismissedProcurementIds, productId] });
    }
  },

  restoreDismissedProcurementProducts: () => {
    set({ dismissedProcurementIds: [] });
  },

  createDraftPOForVendor: (vendorName, customItems, status = 'Waiting List') => {
    const { products, purchaseOrders } = get();

    let lineItems: POLineItem[];

    if (customItems && customItems.length > 0) {
      lineItems = customItems.map((ci) => {
        const p = products.find((prod) => prod.id === ci.productId);
        const unitCost = ci.unitCost !== undefined ? ci.unitCost : p ? p.costPrice : 1500;
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
          const suggestedQty = Math.max(1, (p.reorderPoint || 10) * 2 - p.stock);
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
      id: `po-${Date.now()}`,
      poNumber: `PO-${Date.now().toString().slice(-6)}`,
      vendorName,
      createdAt: new Date().toISOString(),
      items: lineItems,
      totalAmount,
      status: status || 'Waiting List',
    };

    const updatedPOs = [newPO, ...purchaseOrders.filter((p) => p.id !== newPO.id)];
    sqliteAdapter.savePurchaseOrder(newPO).catch((err) => {
      console.error('Failed to save draft purchase order:', err);
    });

    set({
      activeDraftPO: newPO,
      purchaseOrders: updatedPOs,
      activeModal: 'purchase_order',
    });
  },

  createWaitingListPO: async (vendorName, customItems, notes) => {
    const { products, purchaseOrders, logSecurityAction } = get();

    let lineItems: POLineItem[];
    if (customItems && customItems.length > 0) {
      lineItems = customItems.map((ci) => {
        const p = products.find((prod) => prod.id === ci.productId);
        const unitCost = ci.unitCost !== undefined ? ci.unitCost : p ? p.costPrice : 1500;
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
      id: `po-${Date.now()}`,
      poNumber: `PO-${Date.now().toString().slice(-6)}`,
      vendorName,
      createdAt: new Date().toISOString(),
      items: lineItems,
      totalAmount,
      status: 'Waiting List',
      notes,
    };

    const updated = [newPO, ...purchaseOrders];
    try {
      await sqliteAdapter.savePurchaseOrder(newPO);
    } catch (err) {
      console.error('Failed to save waiting list PO:', err);
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

  validateAndReceivePO: async (payload) => {
    const { poId, verifiedItems, recordExpense = true, expensePaymentMethod = 'Espèces', notes } = payload;
    const { purchaseOrders, products, logSecurityAction, addStoreExpense } = get();

    const targetPO = purchaseOrders.find((p) => p.id === poId);
    if (!targetPO) return { success: false, isPartial: false, totalReceivedCost: 0 };

    let totalReceivedCost = 0;
    let totalReceivedUnits = 0;
    const verifiedMap = new Map(verifiedItems.map((vi) => [vi.productId, vi]));

    // 1. Update Product Stocks and Cost Prices (Price Fluctuation Handling)
    const updatedProducts = products.map((p) => {
      const verified = verifiedMap.get(p.id);
      if (verified && verified.receivedQty > 0) {
        const receivedQty = Math.max(0, verified.receivedQty);
        const actualCost =
          verified.actualUnitCost !== undefined && verified.actualUnitCost > 0
            ? verified.actualUnitCost
            : p.costPrice;

        return {
          ...p,
          stock: p.stock + receivedQty,
          costPrice: actualCost,
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
      const actualUnitCost =
        verified.actualUnitCost !== undefined && verified.actualUnitCost > 0
          ? verified.actualUnitCost
          : item.unitCost;

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
      validatedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      notes: notes || targetPO.notes,
      expenseRecorded: recordExpense ? true : targetPO.expenseRecorded,
    };

    const updatedPOs = purchaseOrders.map((p) => (p.id === poId ? updatedPO : p));

    // Save to Database
    try {
      await productRepository.bulkSave(updatedProducts);
      await sqliteAdapter.savePurchaseOrder(updatedPO);
    } catch (err) {
      console.error('Failed to save validated PO:', err);
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

    set({
      products: updatedProducts,
      purchaseOrders: updatedPOs,
      activeDraftPO: updatedPO,
    });

    return {
      success: true,
      isPartial: newStatus === 'Partially Received',
      totalReceivedCost,
    };
  },

  cancelPO: async (poId, reason) => {
    const { purchaseOrders, logSecurityAction } = get();
    const updatedPOs = purchaseOrders.map((po) =>
      po.id === poId
        ? { ...po, status: 'Cancelled' as const, notes: reason ? `Annulé: ${reason}` : po.notes }
        : po
    );
    const target = purchaseOrders.find((p) => p.id === poId);
    if (target) {
      try {
        await sqliteAdapter.savePurchaseOrder({ ...target, status: 'Cancelled', notes: reason });
      } catch (err) {
        console.error(`Failed to cancel PO [${poId}]:`, err);
      }
      logSecurityAction(
        'Annulation Bon de Commande',
        `Bon #${target.poNumber} (${target.vendorName}) annulé. Raison: ${reason || 'Non spécifiée'}`,
        'Admin',
        false
      );
    }
    set({ purchaseOrders: updatedPOs });
  },

  deletePO: async (poId) => {
    const { purchaseOrders } = get();
    const updated = purchaseOrders.filter((p) => p.id !== poId);
    set({ purchaseOrders: updated });
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
      await productRepository.bulkSave(updatedProducts);
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
      await productRepository.bulkSave(updatedProducts);
      await sqliteAdapter.savePurchaseOrder(approvedPO);
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
