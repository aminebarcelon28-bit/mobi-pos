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
  PaymentTender,
  IMEIRecord,
} from '../../types/pos';
import { db as dexieDb } from '../../db/database';
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
import { directPrintReceipt } from '../../utils/escpos';

let isPaymentInFlight = false;

export const createOrderSlice: StateCreator<PosState, [], [], OrderSlice> = (set, get) => ({
  transactions: [],
  lastTransaction: null,
  cashTendered: 0,
  paymentMethod: 'Espèces',
  selectedTransactionForRefund: null,

  setCashTendered: (amount) => set({ cashTendered: amount }),
  setSelectedTransactionForRefund: (t) => set({ selectedTransactionForRefund: t }),

  reprintReceipt: (transaction) => {
    set({ lastTransaction: transaction });
    const settings = get().receiptSettings;
    void directPrintReceipt(transaction, settings);
  },

  processPayment: async (tenders?: PaymentTender[]) => {
    if (isPaymentInFlight) {
      return { success: false, reason: 'ALREADY_PROCESSING' };
    }
    isPaymentInFlight = true;

    try {
      const {
        cart,
        currentCustomer,
        cashTendered,
        products,
        transactions,
        pricingTier,
        storeCreditApplied,
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

      // Accounting Invariant: Gross Subtotal before discounts
      const grossSubtotal = cart.reduce((acc, item) => {
        const itemPrice =
          item.appliedPrice !== undefined
            ? item.appliedPrice
            : getProductPriceForTier(item.product, pricingTier);
        return acc + itemPrice * item.quantity;
      }, 0);

      const discountTotal = cart.reduce((acc, item) => acc + (item.discount || 0), 0);
      const subtotalAfterDiscount = Math.max(0, grossSubtotal - discountTotal);

      const actualStoreCreditApplied = tenders
        ? tenders.filter((t: PaymentTender) => t.method === 'Avoir Client').reduce((acc: number, t: PaymentTender) => acc + t.amount, 0)
        : storeCreditApplied;

      if (actualStoreCreditApplied > 0 && currentCustomer) {
        if (actualStoreCreditApplied > currentCustomer.storeCredit) {
          return { success: false, reason: 'INSUFFICIENT_STORE_CREDIT' };
        }
      }

      const total = Math.max(0, subtotalAfterDiscount - actualStoreCreditApplied);

      const creditTender = tenders?.find((t: PaymentTender) => t.method === 'Crédit Client');
      const creditDebtAmount = creditTender ? creditTender.amount : 0;

      if (creditDebtAmount > 0) {
        if (!currentCustomer) {
          return { success: false, reason: 'CUSTOMER_REQUIRED_FOR_CREDIT' };
        }
        const debtLimit = currentCustomer.debtLimit ?? 100000;
        const projectedDebt = (currentCustomer.currentDebt || 0) + creditDebtAmount;
        if (projectedDebt > debtLimit) {
          return { success: false, reason: `CREDIT_LIMIT_EXCEEDED:${debtLimit}` };
        }
      }

      // Validate cash is sufficient (excluding credit and store credit)
      const directTendered = tenders
        ? tenders
            .filter((t: PaymentTender) => t.method !== 'Avoir Client' && t.method !== 'Crédit Client')
            .reduce((acc: number, t: PaymentTender) => acc + t.amount, 0)
        : cashTendered;

      const remainingToPay = Math.max(0, total - creditDebtAmount);

      if (directTendered < remainingToPay) {
        return { success: false, reason: 'INSUFFICIENT_CASH' };
      }

      const changeDue = Math.max(0, directTendered - remainingToPay);

      // Capture immutable unit cost price at exact checkout time to protect historical profit margins
      const frozenCartItems: CartItem[] = cart.map((item) => ({
        ...item,
        unitCostPrice: getEffectiveCostPrice(item.product),
      }));

      // Cost & Profit calculations using immutable unit costs
      const costTotal = frozenCartItems.reduce(
        (acc, item) => acc + (item.unitCostPrice ?? 0) * item.quantity,
        0
      );
      const { profit, profitMargin } = calculateProfit(total, costTotal);

      // Unique Relational Identifiers (UUID/ULID compliant)
      const transactionId = `TXN-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const receiptNumber = `REC-${Date.now().toString().slice(-6)}`;

      // Stock deduction map
      const cartProductMap = new Map<string, number>();
      for (const item of frozenCartItems) {
        cartProductMap.set(
          item.product.id,
          (cartProductMap.get(item.product.id) || 0) + item.quantity
        );
      }

      const modifiedProducts: Product[] = [];
      const updatedProducts = products.map((product) => {
        const cartQty = cartProductMap.get(product.id);
        if (cartQty !== undefined) {
          const updated = { ...product, stock: Math.max(0, product.stock - cartQty) };
          modifiedProducts.push(updated);
          return updated;
        }
        return product;
      });

      // Customer update
      let updatedCustomer = currentCustomer;
      let updatedCustomers = customers;
      let newCustomerDebts = get().customerDebts;
      let debtEntry: CustomerDebtEntry | null = null;

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
              `Utilisation Avoir Client (${actualStoreCreditApplied} DA) sur Ticket #${receiptNumber}`,
              transactionId
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
              `Gain points (${earnedPoints} pts) sur Ticket #${receiptNumber}`,
              transactionId
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
              `Bonus Palier 20k DZD (+${earnedCreditBonus} DA d'Avoir) débloqué sur Ticket #${receiptNumber}`,
              transactionId
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
          currentDebt: newDebt,
          pointBuckets: finalBuckets,
          ledger: [...newEntries, ...existingLedger],
        };

        if (creditDebtAmount > 0) {
          debtEntry = {
            id: `DEBT-${Date.now()}`,
            customerId: currentCustomer.id,
            customerName: currentCustomer.name,
            type: 'DEBT_ACQUIRED',
            amount: creditDebtAmount,
            balanceAfter: newDebt,
            receiptNumber,
            paymentMethod: 'Crédit Client',
            notes: `Vente à Crédit #${receiptNumber} - Transaction #${transactionId}`,
            createdAt: new Date().toISOString(),
            recordedBy: activeShift?.cashierName || 'Caisse Principale',
          };
          newCustomerDebts = [debtEntry, ...newCustomerDebts];
        }

        const finalCust = updatedCustomer;
        updatedCustomers = customers.map((c) => (c.id === finalCust.id ? finalCust : c));
      }

      const transaction: SaleTransaction = {
        id: transactionId,
        receiptNumber: receiptNumber,
        customer: updatedCustomer,
        items: frozenCartItems,
        subtotal: grossSubtotal,
        discountTotal: discountTotal,
        total,
        costTotal,
        profit,
        profitMargin,
        pricingTier,
        paymentMethod: tenders && tenders.length > 0 ? tenders[0].method : 'Espèces',
        tenders,
        cashTendered: tenders ? tenders.reduce((acc: number, t: PaymentTender) => acc + t.amount, 0) : cashTendered,
        changeDue,
        createdAt: new Date().toISOString(),
        cashierName: activeShift?.cashierName || 'Caisse Principale',
        debtAdded: creditDebtAmount > 0 ? creditDebtAmount : undefined,
        debtRemainingTotal: updatedCustomer?.currentDebt,
      };

      const newTransactions = [transaction, ...transactions];

      // Synchronous Atomic Persistence (Contract C6: Zero Silent Data Loss)
      try {
        if (updatedCustomer) {
          await customerRepository.save(updatedCustomer).catch(console.error);
        }
        if (debtEntry) {
          await sqliteAdapter.saveCustomerDebt(debtEntry).catch(console.error);
        }
        await sqliteAdapter.processSaleTransactionAtomic(
          transaction,
          modifiedProducts,
          updatedCustomer || undefined,
          undefined
        );
        await writeCheckoutAtomic({
          orderRow: {
            id: transactionId,
            receipt_number: receiptNumber,
            customer_id: updatedCustomer?.id ?? null,
            subtotal: grossSubtotal,
            discount_total: discountTotal,
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
          items: frozenCartItems.map((ci, idx) => {
            const pId = ci.product?.id || `prod-${idx}`;
            return {
              id: `${transactionId}-item-${idx}`,
              product_id: pId,
              quantity: Number(ci.quantity || 1),
              applied_price: Number(ci.appliedPrice ?? ci.product?.price ?? 0),
              discount: Number(ci.discount ?? 0),
              imei_number: ci.imeiNumber ?? null,
              cost_price: Number(ci.unitCostPrice ?? ci.product?.costPrice ?? 0),
            };
          }),
          deltas: frozenCartItems.map((ci, idx) => ({
            productId: ci.product?.id || `prod-${idx}`,
            delta: -Math.abs(ci.quantity || 1),
            reason: 'SALE' as const,
            refType: 'order',
            refId: transactionId,
          })),
          productSnapshots: frozenCartItems.map((ci, idx) => ({
            id: ci.product?.id || `prod-${idx}`,
            sku: ci.product?.sku || '',
            barcode: ci.product?.barcode || '',
            title: ci.product?.title || 'Article',
            brand: ci.product?.brand || 'Autre',
            category: ci.product?.category || 'Tous les produits',
            price: Number(ci.product?.price ?? 0),
          })),
        });
        const { syncManager } = await import('../../sync/SyncManager');
        syncManager.notifyLocalWrite();
      } catch (e) {
        console.error('Checkout persistence failed (SQLite/Dexie write error):', e);
        return { success: false, reason: 'PERSISTENCE_FAILED' };
      }

      // Track sold serialized items in Dexie and store
      const soldImeis = frozenCartItems
        .filter((ci) => Boolean(ci.imeiNumber && ci.imeiNumber.trim()))
        .map((ci) => ({
          imei: ci.imeiNumber!.trim(),
          productId: ci.product?.id || '',
        }));

      let nextImeiRecords = get().imeiRecords || [];
      if (soldImeis.length > 0) {
        try {
          for (const si of soldImeis) {
            const existing = await dexieDb.imeiRecords.get(si.imei);
            const rec: IMEIRecord = existing || {
              imei: si.imei,
              productId: si.productId,
              receivedAt: transaction.createdAt,
            };
            rec.saleTransactionId = transaction.id;
            rec.soldAt = transaction.createdAt;
            await dexieDb.imeiRecords.put(rec);
          }
          nextImeiRecords = nextImeiRecords.map((r) => {
            const match = soldImeis.find((s) => s.imei === r.imei);
            return match ? { ...r, saleTransactionId: transaction.id, soldAt: transaction.createdAt } : r;
          });
        } catch (e) {
          console.warn('[completeSale] Failed to update imeiRecords in Dexie:', e);
        }
      }

      // State Update on Success
      set({
        products: updatedProducts,
        transactions: newTransactions,
        customers: updatedCustomers,
        currentCustomer: updatedCustomer,
        customerDebts: newCustomerDebts,
        imeiRecords: nextImeiRecords,
        cart: [],
        cashTendered: 0,
        storeCreditApplied: 0,
        activeModal: null,
        lastTransaction: transaction,
        hardwareStatus: { ...get().hardwareStatus, cashDrawerOpen: true },
      });

      // Audio Feedback
      audioBus.emit('success');
      audioBus.emit('cashDrawer');

      // Direct Silent Hardware Printing
      const settings = get().receiptSettings;
      if (settings?.autoPrintEnabled !== false) {
        void directPrintReceipt(transaction, settings);
      }

      return { success: true };
    } finally {
      isPaymentInFlight = false;
    }
  },

  quickCashPayment: async () => {
    const { cart, pricingTier, processPayment } = get();
    if (cart.length === 0) return { success: false, reason: 'EMPTY_CART' };

    const grossSubtotal = cart.reduce((acc, item) => {
      const itemPrice =
        item.appliedPrice !== undefined
          ? item.appliedPrice
          : getProductPriceForTier(item.product, pricingTier);
      return acc + itemPrice * item.quantity;
    }, 0);
    const lineDiscounts = cart.reduce((acc, item) => acc + (item.discount || 0), 0);
    const netTotal = Math.max(0, grossSubtotal - lineDiscounts);

    return await processPayment([{ method: 'Espèces', amount: netTotal }]);
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

    const nextImeiRecords = (get().imeiRecords || []).map((r) =>
      restoredImeis.includes(r.imei)
        ? { ...r, saleTransactionId: undefined, soldAt: undefined }
        : r
    );

    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      imeiRecords: nextImeiRecords,
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

    const nextImeiRecords = (get().imeiRecords || []).map((r) =>
      restoredImeis.includes(r.imei)
        ? { ...r, saleTransactionId: undefined, soldAt: undefined }
        : r
    );

    set({
      products: updatedProducts,
      transactions: updatedTransactions,
      customers: updatedCustomers,
      currentCustomer: updatedCustomer || get().currentCustomer,
      imeiRecords: nextImeiRecords,
      lastTransaction: refundTransaction,
      activeModal: null,
      hardwareStatus:
        refundMethod === 'Espèces' ? { ...get().hardwareStatus, cashDrawerOpen: true } : get().hardwareStatus,
    });

    const settings = get().receiptSettings;
    if (settings?.autoPrintEnabled !== false) {
      void directPrintReceipt(refundTransaction, settings);
    }

    return { success: true, refundTransaction };
  },
});
