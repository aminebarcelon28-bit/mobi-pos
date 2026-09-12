import type { StateCreator } from 'zustand';
import type { PosState, OrderSlice } from '../types';
import type {
  CartItem,
  SaleTransaction,
  Customer,
  CustomerDebtEntry,
  LoyaltyLedgerEntry,
  SecurityAuditLogEntry,
  Product,
} from '../../types/pos';
import { sqliteAdapter } from '../../db/sqliteAdapter';
import { customerRepository } from '../../db/repositories/customerRepository';
import { writeCheckoutAtomic, appendInventoryDeltas } from '../../db/sqlPluginAdapter';
import {
  calculateCustomerTier,
  calculateEarnedPoints,
  calculateNetPaidEarnedPoints,
  depleteFifoPointBuckets,
  createDatedPointBucket,
  createLedgerEntry,
} from '../../utils/loyaltyEngine';
import {
  getProductPriceForTier,
  getEffectiveCostPrice,
  calculateProfit,
} from '../../utils/pricingEngine';
import { audioBus } from '../../utils/audioEvents';

export const createOrderSlice: StateCreator<PosState, [], [], OrderSlice> = (set, get) => ({
  transactions: [],
  lastTransaction: null,
  cashTendered: 0,
  paymentMethod: 'Espèces',
  selectedTransactionForRefund: null,

  setCashTendered: (amount) => set({ cashTendered: amount }),
  setSelectedTransactionForRefund: (t) => set({ selectedTransactionForRefund: t }),

  reprintReceipt: (transaction) => {
    set({
      lastTransaction: transaction,
      activeModal: 'receipt',
    });
  },

  processPayment: async (tenders) => {
    const {
      cart,
      currentCustomer,
      cashTendered,
      products,
      transactions,
      pricingTier,
      storeCreditApplied,
      logSecurityAction,
      customers,
      activeShift,
    } = get();

    if (cart.length === 0) return { success: false, reason: 'EMPTY_CART' };

    // IMEI enforcement for serialized items
    const missingIMEI = cart.find(
      (item) => item.product.isSerialized && (!item.imeiNumber || item.imeiNumber.trim() === '')
    );
    if (missingIMEI) {
      return { success: false, reason: `IMEI_REQUIRED:${missingIMEI.product.title}` };
    }

    // Guard against duplicate IMEI assignment in same sale
    const serializedItems = cart.filter((item) => item.product.isSerialized && item.imeiNumber);
    const seenImeis = new Set<string>();
    for (const item of serializedItems) {
      const imei = (item.imeiNumber || '').trim().toUpperCase();
      if (seenImeis.has(imei)) {
        return { success: false, reason: `DUPLICATE_IMEI:${imei}` };
      }
      seenImeis.add(imei);
    }

    const grossSubtotal = cart.reduce((acc, item) => {
      const itemPrice =
        item.appliedPrice !== undefined
          ? item.appliedPrice
          : getProductPriceForTier(item.product, pricingTier);
      return acc + itemPrice * item.quantity - (item.discount || 0);
    }, 0);

    const actualStoreCreditApplied = tenders
      ? tenders.filter((t) => t.method === 'Avoir Client').reduce((acc, t) => acc + t.amount, 0)
      : storeCreditApplied;

    if (actualStoreCreditApplied > 0 && currentCustomer) {
      if (actualStoreCreditApplied > currentCustomer.storeCredit) {
        return { success: false, reason: 'INSUFFICIENT_STORE_CREDIT' };
      }
    }

    const total = Math.max(0, grossSubtotal - actualStoreCreditApplied);

    const creditTender = tenders?.find((t) => t.method === 'Crédit Client');
    const creditDebtAmount = creditTender ? creditTender.amount : 0;

    if (creditDebtAmount > 0 && !currentCustomer) {
      return { success: false, reason: 'CUSTOMER_REQUIRED_FOR_CREDIT' };
    }

    // Validate cash is sufficient (excluding credit and store credit)
    const directTendered = tenders
      ? tenders
          .filter((t) => t.method !== 'Avoir Client' && t.method !== 'Crédit Client')
          .reduce((acc, t) => acc + t.amount, 0)
      : cashTendered;

    const remainingToPay = Math.max(0, total - creditDebtAmount);

    if (directTendered < remainingToPay) {
      return { success: false, reason: 'INSUFFICIENT_CASH' };
    }

    const changeDue = Math.max(0, directTendered - remainingToPay);

    // Capture immutable unit cost price at exact checkout time to protect historical profit margins
    const frozenCartItems: CartItem[] = cart.map((item) => ({
      ...item,
      unitCostPrice: item.unitCostPrice ?? getEffectiveCostPrice(item.product),
    }));

    const costTotal = frozenCartItems.reduce(
      (acc, item) => acc + (item.unitCostPrice || 0) * item.quantity,
      0
    );

    const { profit, profitMargin } = calculateProfit(total, costTotal);

    const cartQtyMap = new Map<string, number>();
    for (const item of cart) {
      cartQtyMap.set(item.product.id, (cartQtyMap.get(item.product.id) || 0) + item.quantity);
    }

    let hasSyncConflict = false;
    const modifiedProducts: Product[] = [];
    const updatedProducts = products.map((p) => {
      const cartQty = cartQtyMap.get(p.id);
      if (cartQty !== undefined) {
        const newStock = p.stock - cartQty;
        if (newStock < 0) hasSyncConflict = true;
        const updated = { ...p, stock: newStock };
        modifiedProducts.push(updated);
        return updated;
      }
      return p;
    });

    if (hasSyncConflict) {
      logSecurityAction(
        'Stock Négatif Synchronisé (Oversell)',
        'Vente enregistrée avec stock négatif — régulariser par réception/ajustement.',
        'Système Local',
        false
      );
    }

    const transactionId = `TXN-${Math.floor(100000 + Math.random() * 900000)}`;
    const receiptNumber = `REC-${Date.now().toString().slice(-6)}`;

    const { customerDebts } = get();
    let newCustomerDebts = customerDebts;

    let updatedCustomer = currentCustomer;
    let updatedCustomers = customers;
    if (currentCustomer) {
      const currentTotalSpent = currentCustomer.totalSpent || 0;
      const currentTier = calculateCustomerTier(currentTotalSpent);

      const earnedPoints =
        remainingToPay > 0
          ? calculateNetPaidEarnedPoints(cart, remainingToPay, grossSubtotal, currentTier.pointsMultiplier)
          : 0;

      const newTotalSpent = currentTotalSpent + remainingToPay;
      const newTier = calculateCustomerTier(newTotalSpent);

      const prev20kMilestones = Math.floor(currentTotalSpent / 20000);
      const new20kMilestones = Math.floor(newTotalSpent / 20000);
      const milestoneBonusUnlocked = Math.max(0, new20kMilestones - prev20kMilestones);
      const earnedCreditBonus = milestoneBonusUnlocked * 1000;

      const existingBuckets = currentCustomer.pointBuckets || [];
      const pointsToRedeem = Math.floor(actualStoreCreditApplied / 10);
      const { updatedBuckets } = depleteFifoPointBuckets(existingBuckets, pointsToRedeem);

      const finalBuckets = [...updatedBuckets];
      if (earnedPoints > 0) {
        finalBuckets.push(
          createDatedPointBucket(
            currentCustomer.id,
            receiptNumber,
            earnedPoints,
            remainingToPay,
            newTier.name
          )
        );
      }

      const newCredit = Math.max(0, currentCustomer.storeCredit - actualStoreCreditApplied) + earnedCreditBonus;
      const newPoints = Math.max(0, currentCustomer.loyaltyPoints - pointsToRedeem) + earnedPoints;
      const newDebt = (currentCustomer.currentDebt || 0) + creditDebtAmount;

      const newEntries: LoyaltyLedgerEntry[] = [];
      if (actualStoreCreditApplied > 0) {
        newEntries.push(
          createLedgerEntry(
            currentCustomer.id,
            'redeem',
            -pointsToRedeem,
            newPoints,
            `Déduction Avoir Client sur Ticket ${receiptNumber} (-${actualStoreCreditApplied} DA)`,
            transactionId,
            -actualStoreCreditApplied
          )
        );
      }

      if (earnedPoints > 0) {
        newEntries.push(
          createLedgerEntry(
            currentCustomer.id,
            'earn',
            earnedPoints,
            newPoints,
            `Gain sur paiement net de ${remainingToPay} DA (Ticket ${receiptNumber} - ${newTier.name} ${newTier.pointsMultiplier}x)`,
            transactionId,
            earnedPoints * 10
          )
        );
      }

      if (earnedCreditBonus > 0) {
        newEntries.push(
          createLedgerEntry(
            currentCustomer.id,
            'bonus',
            0,
            newPoints,
            `🎁 Bonus Palier 20 000 DA Atteint : +${earnedCreditBonus} DA Crédit Avoir Client`,
            transactionId,
            earnedCreditBonus
          )
        );
      }

      const existingLedger = currentCustomer.ledger || [];
      updatedCustomer = {
        ...currentCustomer,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        currentCreditBalanceDzd: newCredit,
        totalLifetimeSpentDzd: newTotalSpent,
        currentDebt: newDebt,
        pointBuckets: finalBuckets,
        ledger: [...newEntries, ...existingLedger],
      };

      if (updatedCustomer) {
        const savedCust: Customer = updatedCustomer;
        updatedCustomers = customers.map((c) => (c.id === currentCustomer.id ? savedCust : c));
      }
      try {
        await customerRepository.save(updatedCustomer);
      } catch (err) {
        console.error('Failed to save updated customer on payment:', err);
      }

      if (creditDebtAmount > 0) {
        const debtEntry: CustomerDebtEntry = {
          id: `DEBT-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
          customerId: currentCustomer.id,
          customerName: currentCustomer.name,
          type: 'DEBT_ACQUIRED',
          amount: creditDebtAmount,
          balanceAfter: newDebt,
          receiptNumber: receiptNumber,
          paymentMethod: 'Crédit Client',
          notes: `Vente à crédit - Ticket N° ${receiptNumber}`,
          createdAt: new Date().toISOString(),
          recordedBy: activeShift?.cashierName ? `Caisse (${activeShift.cashierName})` : 'Caisse Principale',
        };
        try {
          await sqliteAdapter.saveCustomerDebt(debtEntry);
          newCustomerDebts = [debtEntry, ...customerDebts];
        } catch (err) {
          console.error('Failed to save customer debt entry:', err);
        }
      }
    }

    const transaction: SaleTransaction = {
      id: transactionId,
      receiptNumber: receiptNumber,
      customer: updatedCustomer,
      items: frozenCartItems,
      subtotal: grossSubtotal,
      discountTotal: cart.reduce((acc, item) => acc + item.discount, 0),
      total,
      costTotal,
      profit,
      profitMargin,
      pricingTier,
      paymentMethod: tenders && tenders.length > 0 ? tenders[0].method : 'Espèces',
      tenders,
      cashTendered: tenders ? tenders.reduce((acc, t) => acc + t.amount, 0) : cashTendered,
      changeDue,
      createdAt: new Date().toISOString(),
      cashierName: activeShift?.cashierName || 'Caisse Principale',
      debtAdded: creditDebtAmount > 0 ? creditDebtAmount : undefined,
      debtRemainingTotal: updatedCustomer?.currentDebt,
    };

    const newTransactions = [transaction, ...transactions];

    try {
      await sqliteAdapter.processSaleTransactionAtomic(
        transaction,
        modifiedProducts,
        updatedCustomer || undefined,
        undefined
      );
    } catch (e) {
      console.error('Checkout atomic persistence failed:', e);
      audioBus.emit('error');
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }

    try {
      await writeCheckoutAtomic({
        orderRow: {
          id: transactionId,
          receipt_number: receiptNumber,
          customer_id: updatedCustomer?.id ?? null,
          subtotal: grossSubtotal,
          discount_total: transaction.discountTotal,
          total,
          cost_total: costTotal,
          profit,
          profit_margin: profitMargin,
          pricing_tier: pricingTier,
          payment_method: transaction.paymentMethod,
          cash_tendered: transaction.cashTendered,
          change_due: changeDue,
          status: 'COMPLETED',
          created_at: transaction.createdAt,
        },
        fullTx: transaction as unknown as Record<string, unknown>,
        items: frozenCartItems.map((ci, idx) => ({
          id: `${transactionId}-item-${idx}`,
          product_id: ci.product.id,
          quantity: ci.quantity,
          applied_price: ci.appliedPrice ?? ci.product.price,
          discount: ci.discount ?? 0,
          imei_number: ci.imeiNumber ?? null,
          cost_price: ci.unitCostPrice ?? 0,
        })),
        deltas: frozenCartItems.map((ci) => ({
          productId: ci.product.id,
          delta: -ci.quantity,
          reason: 'SALE' as const,
          refType: 'order',
          refId: transactionId,
        })),
        productSnapshots: frozenCartItems.map((ci) => ({
          id: ci.product.id,
          sku: ci.product.sku,
          barcode: ci.product.barcode,
          title: ci.product.title,
          brand: ci.product.brand,
          category: ci.product.category,
          price: ci.product.price,
        })),
      });
      const { syncManager } = await import('../../sync/SyncManager');
      syncManager.notifyLocalWrite();
    } catch (e) {
      console.warn('Ledger/outbox write skipped (plugin-sql unavailable):', e);
    }

    audioBus.emit('success');
    audioBus.emit('cashDrawer');

    set({
      products: updatedProducts,
      transactions: newTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer,
      customerDebts: newCustomerDebts,
      cart: [],
      cashTendered: 0,
      storeCreditApplied: 0,
      activeModal: 'receipt',
      lastTransaction: transaction,
      hardwareStatus: { ...get().hardwareStatus, cashDrawerOpen: true },
    });

    return { success: true };
  },

  quickCashPayment: async () => {
    const { cart, pricingTier, processPayment } = get();
    if (cart.length === 0) return { success: false, reason: 'EMPTY_CART' };

    const grossSubtotal = cart.reduce((acc, item) => {
      const itemPrice =
        item.appliedPrice !== undefined
          ? item.appliedPrice
          : getProductPriceForTier(item.product, pricingTier);
      return acc + itemPrice * item.quantity - (item.discount || 0);
    }, 0);

    return await processPayment([{ method: 'Espèces', amount: grossSubtotal }]);
  },

  voidTransaction: async (transactionId, reason, cashierName) => {
    const { transactions, products, customers, logSecurityAction } = get();
    const txn = transactions.find((t) => t.id === transactionId);
    if (!txn) {
      return { success: false, reason: 'TRANSACTION_NOT_FOUND' };
    }
    if (txn.status === 'VOIDED') {
      return { success: false, reason: 'ALREADY_VOIDED' };
    }

    // 1. Restore Product inventory (+qty for sold items)
    const soldQtyMap = new Map<string, number>();
    for (const item of txn.items) {
      soldQtyMap.set(item.product.id, (soldQtyMap.get(item.product.id) || 0) + item.quantity);
    }
    const restoredProducts: Product[] = [];
    const updatedProducts = products.map((p) => {
      const soldQty = soldQtyMap.get(p.id);
      if (soldQty !== undefined) {
        const restored = { ...p, stock: p.stock + soldQty };
        restoredProducts.push(restored);
        return restored;
      }
      return p;
    });

    // 2. Gather Serialized IMEIs to release
    const restoredImeis = txn.items
      .map((item) => item.imeiNumber?.trim())
      .filter((imei): imei is string => Boolean(imei && imei.length > 0));

    // 3. Customer loyalty & store credit rollback
    let updatedCustomer: Customer | undefined = undefined;
    let updatedCustomers = customers;
    const txnCustomer = txn.customer;
    if (txnCustomer) {
      const cust = customers.find((c) => c.id === txnCustomer.id) || txnCustomer;
      const currentTotalSpent = cust.totalSpent || 0;
      const newTotalSpent = Math.max(0, currentTotalSpent - txn.total);
      const newTier = calculateCustomerTier(newTotalSpent);

      const earnedPoints = calculateEarnedPoints(txn.total, newTier.pointsMultiplier);
      const newPoints = Math.max(0, cust.loyaltyPoints - earnedPoints);

      const storeCreditPaid = txn.tenders
        ? txn.tenders.filter((t) => t.method === 'Avoir Client').reduce((acc, t) => acc + t.amount, 0)
        : txn.paymentMethod === 'Avoir Client'
        ? txn.total
        : 0;
      const newCredit = (cust.storeCredit || 0) + storeCreditPaid;

      const creditDebtAmount = txn.tenders
        ? txn.tenders.filter((t) => t.method === 'Crédit Client').reduce((acc, t) => acc + t.amount, 0)
        : txn.paymentMethod === 'Crédit Client'
        ? txn.total
        : 0;
      const newDebt = Math.max(0, (cust.currentDebt || 0) - creditDebtAmount);

      if (creditDebtAmount > 0) {
        const voidDebtEntry: CustomerDebtEntry = {
          id: `DEBT-VOID-${Date.now()}`,
          customerId: cust.id,
          customerName: cust.name,
          type: 'PAYMENT_SETTLED',
          amount: creditDebtAmount,
          balanceAfter: newDebt,
          receiptNumber: txn.receiptNumber,
          paymentMethod: 'Crédit Client',
          notes: `Annulation Vente à Crédit #${txn.receiptNumber} (${reason}) - Créance annulée`,
          createdAt: new Date().toISOString(),
          recordedBy: cashierName || 'Manager',
        };
        try {
          await sqliteAdapter.saveCustomerDebt(voidDebtEntry);
          set({ customerDebts: [voidDebtEntry, ...get().customerDebts] });
        } catch (err) {
          console.error('Failed to save void debt entry:', err);
        }
      }

      const ledgerEntry = createLedgerEntry(
        cust.id,
        'adjustment',
        -earnedPoints,
        newPoints,
        `Annulation Ticket #${txn.receiptNumber} (${reason}) - Points & Crédit restaurés`,
        txn.id
      );

      const existingLedger = cust.ledger || [];
      updatedCustomer = {
        ...cust,
        currentDebt: newDebt,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        ledger: [ledgerEntry, ...existingLedger],
      };

      const finalCustomer = updatedCustomer;
      updatedCustomers = customers.map((c) => (c.id === finalCustomer.id ? finalCustomer : c));
    }

    const voidedTxn: SaleTransaction = {
      ...txn,
      status: 'VOIDED',
      voidReason: reason,
      voidedAt: new Date().toISOString(),
      voidedBy: cashierName || 'Manager',
    };

    const updatedTransactions = transactions.map((t) => (t.id === transactionId ? voidedTxn : t));

    const auditEntry: SecurityAuditLogEntry = {
      id: `AUDIT-${Date.now()}`,
      timestamp: new Date().toISOString(),
      user: cashierName || 'Manager',
      action: 'Annulation Vente (Erreur de Caisse)',
      details: `Ticket #${txn.receiptNumber} (${txn.total} DA) annulé. Motif: ${reason}`,
      requiresPin: true,
    };

    try {
      await sqliteAdapter.voidTransactionAtomic(
        transactionId,
        voidedTxn,
        restoredProducts,
        updatedCustomer,
        restoredImeis,
        auditEntry
      );
    } catch (err) {
      console.error('Failed to atomically void transaction:', err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }

    try {
      await appendInventoryDeltas(
        txn.items.map((i) => ({
          productId: i.product.id,
          delta: i.quantity,
          reason: 'VOID' as const,
          refType: 'order',
          refId: transactionId,
        }))
      );
      const { enqueueOrderSync } = await import('../../db/sqlPluginAdapter');
      await enqueueOrderSync(transactionId, {
        id: transactionId,
        receipt_number: voidedTxn.receiptNumber,
        total: voidedTxn.total,
        status: 'VOIDED',
        created_at: voidedTxn.createdAt,
      });
      const { syncManager } = await import('../../sync/SyncManager');
      syncManager.notifyLocalWrite();
    } catch (e) {
      console.warn('Void ledger write skipped:', e);
    }

    logSecurityAction(
      'Annulation Vente (Erreur)',
      `Ticket #${txn.receiptNumber} (${txn.total} DA) annulé. Motif: ${reason}`,
      cashierName || 'Manager',
      true
    );

    audioBus.emit('success');

    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      lastTransaction: voidedTxn,
    });

    return { success: true };
  },

  processRefund: async (payload) => {
    const { originalTransaction, refundItems, refundMethod, refundReason, cashierName } = payload;
    const { transactions, products, customers, logSecurityAction } = get();

    if (refundItems.length === 0) {
      return { success: false, reason: 'NO_ITEMS_SELECTED' };
    }

    const refundTotal = refundItems.reduce((acc, i) => acc + i.totalRefundAmount, 0);

    const refundQtyMap = new Map<string, number>();
    for (const item of refundItems) {
      if (item.restock) {
        refundQtyMap.set(item.productId, (refundQtyMap.get(item.productId) || 0) + item.quantity);
      }
    }

    const costRefundTotal = refundItems.reduce((acc, ri) => {
      const prod = products.find((p) => p.id === ri.productId);
      const unitCost = prod ? getEffectiveCostPrice(prod) : getEffectiveCostPrice({ price: ri.unitPrice });
      return acc + unitCost * ri.quantity;
    }, 0);

    const restockedProducts: Product[] = [];
    const updatedProducts = products.map((p) => {
      const restockQty = refundQtyMap.get(p.id);
      if (restockQty !== undefined) {
        const restocked = { ...p, stock: p.stock + restockQty };
        restockedProducts.push(restocked);
        return restocked;
      }
      return p;
    });

    const restoredImeis = refundItems
      .filter((i) => i.restock)
      .map((i) => i.imeiNumber?.trim())
      .filter((imei): imei is string => Boolean(imei && imei.length > 0));

    let updatedCustomer: Customer | undefined = undefined;
    let updatedCustomers = customers;

    const origCust = originalTransaction.customer;
    if (origCust) {
      const cust = customers.find((c) => c.id === origCust.id) || origCust;
      const currentTotalSpent = cust.totalSpent || 0;
      const newTotalSpent = Math.max(0, currentTotalSpent - refundTotal);
      const newTier = calculateCustomerTier(newTotalSpent);

      const pointsToDeduct = calculateEarnedPoints(refundTotal, newTier.pointsMultiplier);
      const newPoints = Math.max(0, cust.loyaltyPoints - pointsToDeduct);

      const creditToAdd = refundMethod === 'Avoir Client' ? refundTotal : 0;
      const newCredit = (cust.storeCredit || 0) + creditToAdd;

      const ledgerEntries: LoyaltyLedgerEntry[] = [];
      if (creditToAdd > 0) {
        ledgerEntries.push(
          createLedgerEntry(
            cust.id,
            'conversion',
            0,
            newPoints,
            `Émission Avoir Client (${refundTotal} DA) suite au retour Ticket #${originalTransaction.receiptNumber}`,
            originalTransaction.id
          )
        );
      }
      if (pointsToDeduct > 0) {
        ledgerEntries.push(
          createLedgerEntry(
            cust.id,
            'adjustment',
            -pointsToDeduct,
            newPoints,
            `Déduction points fidélité (${pointsToDeduct} pts) suite au remboursement Ticket #${originalTransaction.receiptNumber}`,
            originalTransaction.id
          )
        );
      }

      const existingLedger = cust.ledger || [];
      updatedCustomer = {
        ...cust,
        totalSpent: newTotalSpent,
        loyaltyTier: newTier.name,
        loyaltyPoints: newPoints,
        storeCredit: newCredit,
        ledger: [...ledgerEntries, ...existingLedger],
      };

      const finalCust = updatedCustomer;
      updatedCustomers = customers.map((c) => (c.id === finalCust.id ? finalCust : c));
    }

    const refundReceiptNumber = `AVOIR-${Date.now().toString().slice(-6)}`;
    const refundTxnId = `REF-${Math.floor(100000 + Math.random() * 900000)}`;

    const refundTransaction: SaleTransaction = {
      id: refundTxnId,
      receiptNumber: refundReceiptNumber,
      status: 'COMPLETED',
      isRefund: true,
      originalReceiptNumber: originalTransaction.receiptNumber,
      originalTransactionId: originalTransaction.id,
      refundReason,
      refundMethod,
      refundedItems: refundItems,
      customer: updatedCustomer || originalTransaction.customer,
      items: refundItems.map((ri) => {
        const origProd =
          products.find((p) => p.id === ri.productId) ||
          ({
            id: ri.productId,
            title: ri.title,
            sku: ri.sku,
            price: ri.unitPrice,
          } as Product);
        return {
          product: origProd,
          quantity: ri.quantity,
          discount: 0,
          appliedPrice: ri.unitPrice,
          imeiNumber: ri.imeiNumber,
        };
      }),
      subtotal: refundTotal,
      discountTotal: 0,
      total: refundTotal,
      costTotal: costRefundTotal,
      profit: 0,
      profitMargin: 0,
      pricingTier: originalTransaction.pricingTier,
      paymentMethod: refundMethod,
      cashTendered: refundMethod === 'Espèces' ? refundTotal : 0,
      changeDue: 0,
      createdAt: new Date().toISOString(),
    };

    const totalOrigItems = (originalTransaction.items || []).reduce((acc, i) => acc + i.quantity, 0);
    const totalRefundedItems = refundItems.reduce((acc, i) => acc + i.quantity, 0);
    const isFullyRefunded = totalRefundedItems >= totalOrigItems;

    const updatedOriginalTransaction: SaleTransaction = {
      ...originalTransaction,
      status: isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    };

    const updatedTransactions = [
      refundTransaction,
      ...transactions.map((t) => (t.id === originalTransaction.id ? updatedOriginalTransaction : t)),
    ];

    const auditEntry: SecurityAuditLogEntry = {
      id: `AUDIT-${Date.now()}`,
      timestamp: new Date().toISOString(),
      user: cashierName || 'Manager',
      action: 'Remboursement / Avoir Émis',
      details: `Avoir #${refundReceiptNumber} (${refundTotal} DA en ${refundMethod}) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}`,
      requiresPin: true,
    };

    try {
      await sqliteAdapter.processRefundAtomic(
        refundTransaction,
        updatedOriginalTransaction,
        restockedProducts,
        updatedCustomer,
        restoredImeis,
        auditEntry
      );
    } catch (err) {
      console.error('Failed to process refund atomically:', err);
      return { success: false, reason: 'PERSISTENCE_FAILED' };
    }

    try {
      const restocked = refundItems.filter((i) => i.restock && i.quantity > 0);
      if (restocked.length > 0) {
        await appendInventoryDeltas(
          restocked.map((i) => ({
            productId: i.productId,
            delta: i.quantity,
            reason: 'REFUND' as const,
            refType: 'order',
            refId: refundTxnId,
          }))
        );
      }
      const { enqueueOrderSync } = await import('../../db/sqlPluginAdapter');
      await enqueueOrderSync(originalTransaction.id, {
        id: originalTransaction.id,
        receipt_number: originalTransaction.receiptNumber,
        total: originalTransaction.total,
        status: updatedOriginalTransaction.status,
        created_at: originalTransaction.createdAt,
      });
      await writeCheckoutAtomic({
        orderRow: {
          id: refundTxnId,
          receipt_number: refundReceiptNumber,
          customer_id: updatedCustomer?.id ?? originalTransaction.customer?.id ?? null,
          subtotal: refundTotal,
          discount_total: 0,
          total: refundTotal,
          cost_total: costRefundTotal,
          profit: 0,
          profit_margin: 0,
          pricing_tier: originalTransaction.pricingTier,
          payment_method: refundMethod,
          cash_tendered: refundMethod === 'Espèces' ? refundTotal : 0,
          change_due: 0,
          status: 'COMPLETED',
          created_at: refundTransaction.createdAt,
        },
        fullTx: refundTransaction as unknown as Record<string, unknown>,
        items: refundItems.map((ri, idx) => ({
          id: `${refundTxnId}-item-${idx}`,
          product_id: ri.productId,
          quantity: ri.quantity,
          applied_price: ri.unitPrice,
          discount: 0,
          imei_number: ri.imeiNumber ?? null,
          cost_price: 0,
        })),
        deltas: [],
      });
      const { syncManager } = await import('../../sync/SyncManager');
      syncManager.notifyLocalWrite();
    } catch (e) {
      console.warn('Refund ledger write skipped:', e);
    }

    logSecurityAction(
      'Remboursement / Avoir Émis',
      `Avoir #${refundReceiptNumber} (${refundTotal} DA en ${refundMethod}) pour Ticket #${originalTransaction.receiptNumber}. Motif: ${refundReason}`,
      cashierName || 'Manager',
      true
    );

    audioBus.emit('success');
    if (refundMethod === 'Espèces') {
      audioBus.emit('cashDrawer');
    }

    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      lastTransaction: refundTransaction,
      activeModal: 'receipt',
      hardwareStatus:
        refundMethod === 'Espèces' ? { ...get().hardwareStatus, cashDrawerOpen: true } : get().hardwareStatus,
    });

    return { success: true, refundTransaction };
  },
});
