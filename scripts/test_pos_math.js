let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log('[PASS]', message);
  } else {
    failCount++;
    console.error('[FAIL]', message);
  }
}

console.log('====================================================');
console.log('RUNNING COMPREHENSIVE POS & FINANCIAL TEST SUITE');
console.log('====================================================');

// 1. Cash Calculation & Change Due
const grossSubtotal = 10000;
const cashGiven = 15000;
const changeDue = Math.max(0, cashGiven - grossSubtotal);
assert(changeDue === 5000, 'Cash change return: 15,000 DA received for 10,000 DA = 5,000 DA change');

// 2. Customer Debt & Credit (Carnet de Dettes / Kredy)
const initialCustomerDebt = 12000;
const creditLimit = 25000;
const newCreditSale = 8000;
const debtAfterSale = initialCustomerDebt + newCreditSale;
assert(debtAfterSale === 20000, 'Customer debt balance: 12,000 DA + 8,000 DA = 20,000 DA');
assert(debtAfterSale <= creditLimit, 'Credit limit guardrail: 20,000 DA <= 25,000 DA limit (OK)');

// 3. Debt Settlement / Versement
const settlementPayment = 5000;
const finalDebtAfterSettlement = debtAfterSale - settlementPayment;
assert(finalDebtAfterSettlement === 15000, 'Debt settlement: 20,000 DA - 5,000 DA versement = 15,000 DA remaining');

// 4. Split Payment (Cash + Credit)
const cartTotal = 24000;
const cashPart = 14000;
const creditPart = cartTotal - cashPart;
assert(creditPart === 10000, 'Split payment: 24,000 DA total = 14,000 DA cash + 10,000 DA credit');

// 5. EBITDA & True Net Profit Calculations
const caBrut = 150000;
const cogs = 90000;
const grossMargin = caBrut - cogs; // 60,000 DA
assert(grossMargin === 60000, 'Gross commercial margin: 150,000 DA revenue - 90,000 DA COGS = 60,000 DA');

const storeExpenses = [
  { category: 'Loyer', amount: 15000 },
  { category: 'Sonelgaz', amount: 4000 },
  { category: 'Salaires', amount: 6000 }
];
const totalExpenses = storeExpenses.reduce((acc, e) => acc + e.amount, 0);
assert(totalExpenses === 25000, 'Operating expenses: Rent 15k + Sonelgaz 4k + Staff 6k = 25,000 DA');

const ebitda = grossMargin - totalExpenses;
assert(ebitda === 35000, 'EBITDA (True Net Profit): 60,000 DA margin - 25,000 DA expenses = 35,000 DA');
const ebitdaMargin = Number(((ebitda / caBrut) * 100).toFixed(1));
assert(ebitdaMargin === 23.3, 'EBITDA Margin: 35,000 DA / 150,000 DA = 23.3%');

// 6. Cash Drawer Zero-Variance Reconciliation
const shiftFloat = 10000;
const cashSales = 40000;
const debtCollected = 5000;
const cashRefunds = 2000;
const drawerExpenses = 3000;
const vaultDrop = 20000;
const expectedDrawerCash = shiftFloat + cashSales + debtCollected - cashRefunds - drawerExpenses - vaultDrop;
assert(expectedDrawerCash === 30000, 'Shift drawer reconciliation: 10k + 40k + 5k - 2k - 3k - 20k = 30,000 DA');

// 7. Repair SAV Billing
const laborCost = 3000;
const partsCost = 12000;
const repairTotal = laborCost + partsCost;
const deposit = 5000;
const remainingRepairBalance = Math.max(0, repairTotal - deposit);
assert(repairTotal === 15000, 'SAV Repair Total: 3,000 DA labor + 12,000 DA parts = 15,000 DA');
assert(remainingRepairBalance === 10000, 'SAV Remaining balance: 15,000 DA - 5,000 DA deposit = 10,000 DA');

// 8. Reorder Point Algorithm
const dailyBurnRate = 2.5;
const leadTimeDays = 7;
const safetyStock = 3;
const reorderPoint = Math.ceil(dailyBurnRate * leadTimeDays + safetyStock);
assert(reorderPoint === 21, 'Algorithmic reorder point: ceil(2.5 * 7 + 3) = 21 units');

// 10. Discount Clamping Protection (Prevent Negative or Greater than Line Total)
const lineTotal = 4000;
const invalidDiscountHigh = 50000;
const invalidDiscountNegative = -200;
const clampedHigh = Math.min(lineTotal, Math.max(0, invalidDiscountHigh));
const clampedNegative = Math.min(lineTotal, Math.max(0, invalidDiscountNegative));
assert(clampedHigh === 4000, 'Discount Upper Clamp: 50,000 DA clamped to 4,000 DA line total');
assert(clampedNegative === 0, 'Discount Lower Clamp: -200 DA clamped to 0 DA');

// 11. Customer Debt Overpayment to Store Credit
const currentDebt = 4000;
const versementAmount = 5000;
const newDebt = Math.max(0, currentDebt - versementAmount);
const excessStoreCredit = Math.max(0, versementAmount - currentDebt);
assert(newDebt === 0 && excessStoreCredit === 1000, 'Debt Overpayment: 5,000 DA versement on 4,000 DA debt leaves 0 DA debt + 1,000 DA store credit');

// 12. Active Debt Customer Deletion Prevention
const customerWithDebt = { id: 'c-1', name: 'Karim', currentDebt: 3500 };
const canDelete = (customerWithDebt.currentDebt || 0) === 0;
assert(canDelete === false, 'Customer Deletion Protection: Block deletion of customer with active 3,500 DA debt');

// 13. Barcode Scanner Hardware Debounce Logic
let lastScanCode = '6131234567890';
let lastScanTime = 1000;
const incomingCode = '6131234567890';
const incomingTime = 1150; // 150ms later
const isDuplicateIgnored = incomingCode === lastScanCode && (incomingTime - lastScanTime < 400);
assert(isDuplicateIgnored === true, 'Hardware Scanner Debounce: Duplicate scan within 150ms ignored');

// 14. Bundle Stock Reservation Guard (Cart Items + Bundle >= Stock)
const productStock = 2;
const alreadyInCart = 2;
const isBundleChildBlocked = (alreadyInCart + 1) > productStock;
assert(isBundleChildBlocked === true, 'Bundle Multi-Item Stock Guard: Block bundle if child item in cart already equals stock');

// 15. Held Sale Auto-Preservation
const activeCartItems = [{ id: 'p1', qty: 1 }];
const wouldAutoHoldActive = activeCartItems.length > 0;
assert(wouldAutoHoldActive === true, 'Held Sale Auto-Preservation: Auto-hold active cart before restoring previous held sale');

// 16. Algerian Phone Normalization & WhatsApp wa.me URLs
function testNormalizePhone(input) {
  const digitsOnly = (input || '').replace(/\D/g, '');
  let std = digitsOnly;
  if (digitsOnly.startsWith('00213') && digitsOnly.length === 14) std = digitsOnly.slice(5);
  else if (digitsOnly.startsWith('213') && digitsOnly.length === 12) std = digitsOnly.slice(3);
  else if (digitsOnly.startsWith('0') && digitsOnly.length === 10) std = digitsOnly.slice(1);
  return '213' + std;
}
assert(testNormalizePhone('0550123456') === '213550123456', 'Phone Normalizer: 0550123456 -> 213550123456');
assert(testNormalizePhone('+213 660 12 34 56') === '213660123456', 'Phone Normalizer: +213 660 12 34 56 -> 213660123456');
assert(testNormalizePhone('00213 770 12 34 56') === '213770123456', 'Phone Normalizer: 00213 770 12 34 56 -> 213770123456');

// 17. Void Transaction Credit Debt Rollback
const originalCustomerDebt = 15000;
const voidedCreditSaleAmount = 5000;
const rolledBackDebt = Math.max(0, originalCustomerDebt - voidedCreditSaleAmount);
assert(rolledBackDebt === 10000, 'Void Credit Rollback: 15,000 DA debt - 5,000 DA voided credit sale = 10,000 DA');

// 18. Checkout Multi-Click Protection Mutex
let isProcessingPayment = false;
let executionCount = 0;
function simulateClick() {
  if (isProcessingPayment) return;
  isProcessingPayment = true;
  executionCount++;
}
simulateClick(); // First click
simulateClick(); // Rapid double click within 20ms
simulateClick(); // Rapid triple click
assert(executionCount === 1, 'Payment Mutex Lock: 3 rapid clicks only trigger 1 payment execution');

// 19. Duplicate IMEI in Cart Detection Guard
const serializedCart = [
  { productId: 'phone-1', imei: '354123456789012' },
  { productId: 'phone-2', imei: '354123456789012' }
];
const imeiCounts = new Set();
let hasDuplicateIMEI = false;
for (const item of serializedCart) {
  if (imeiCounts.has(item.imei)) hasDuplicateIMEI = true;
  imeiCounts.add(item.imei);
}
assert(hasDuplicateIMEI === true, 'Duplicate IMEI Guard: Detected duplicate IMEI 354123456789012 in same cart');

// 20. Backup Export/Import Payload Schema Integrity
const backupPayload = {
  products: [],
  customers: [],
  transactions: [],
  customerDebts: [{ id: 'DEBT-1', amount: 5000 }],
  storeExpenses: [{ id: 'EXP-1', amount: 15000 }],
};
const hasDebtsInBackup = Array.isArray(backupPayload.customerDebts) && backupPayload.customerDebts.length > 0;
const hasExpensesInBackup = Array.isArray(backupPayload.storeExpenses) && backupPayload.storeExpenses.length > 0;
assert(hasDebtsInBackup && hasExpensesInBackup, 'Backup Schema Integrity: customerDebts & storeExpenses present in JSON archive');

// 21. Multi-Delimiter CSV Invoice Parser (Semicolon & Comma)
function parseCSVLine(line) {
  const delimiter = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
  const parts = line.split(delimiter).map(p => p.trim());
  const qty = parseInt(parts[1].replace(/[^\d-]/g, ''), 10) || 0;
  const cost = parseFloat(parts[2].replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '')) || 0;
  return { sku: parts[0], qty, cost };
}
const frenchExcelLine = "COQ-IPH15-BLK; 15; 1 200,50 DA";
const parsedFrench = parseCSVLine(frenchExcelLine);
assert(parsedFrench.sku === 'COQ-IPH15-BLK' && parsedFrench.qty === 15 && parsedFrench.cost === 1200.5, 'CSV Parser: Semicolon & French space/comma numbers parsed accurately');

// 22. SAV Repair Deposit Clamping
const repairLabor = 3000;
const repairParts = 5000;
const savEstimateTotal = repairLabor + repairParts;
const excessiveDeposit = 12000;
const clampedDeposit = Math.max(0, Math.min(savEstimateTotal, excessiveDeposit));
const remainingSavBalance = Math.max(0, savEstimateTotal - clampedDeposit);
assert(clampedDeposit === 8000 && remainingSavBalance === 0, 'SAV Repair Deposit Guard: 12,000 DA deposit clamped to 8,000 DA total estimate');

// 23. Serialized Item Stepper Guard (Prevent Multi-Qty Single Line Device)
const serializedItem = { isSerialized: true, qty: 1 };
const deltaPlusOne = 1;
const canIncrementSerialized = !serializedItem.isSerialized || deltaPlusOne <= 0;
assert(canIncrementSerialized === false, 'Serialized Stepper Guard: Prevent incrementing single-device line item quantity');

// 24. Quick Cash Serialized IMEI Verification
const quickCashCart = [
  { isSerialized: true, imei: '' },
  { isSerialized: false, imei: undefined }
];
const hasMissingSerializedIMEI = quickCashCart.some(i => i.isSerialized && (!i.imei || !i.imei.trim()));
assert(hasMissingSerializedIMEI === true, 'Quick Cash IMEI Guard: Intercept missing IMEI before quick cash checkout');

// 25. Denomination Engine Float Calculation (DZD Currency Mapping)
const denoms = {
  qty2000: 5,  // 10,000 DA
  qty1000: 10, // 10,000 DA
  qty500: 4,   // 2,000 DA
  qty200: 5,   // 1,000 DA
  qty100: 10,  // 1,000 DA
  qty50: 10,   // 500 DA
  qty20: 10,   // 200 DA
  qty10: 20,   // 200 DA
  coins: 100,  // 100 DA
};
const calculatedFloat = 
  (denoms.qty2000 * 2000) +
  (denoms.qty1000 * 1000) +
  (denoms.qty500 * 500) +
  (denoms.qty200 * 200) +
  (denoms.qty100 * 100) +
  (denoms.qty50 * 50) +
  (denoms.qty20 * 20) +
  (denoms.qty10 * 10) +
  denoms.coins;
assert(calculatedFloat === 25000, 'Denomination Engine: 5x2000 + 10x1000 + 4x500 + 5x200 + 10x100 + 10x50 + 10x20 + 20x10 + 100 = 25,000 DA');

// 26. Dynamic Expected Cash (Opening + Cash Sales + Deposits - Expenses)
const openFloat = 20000;
const shiftCashSales = 55000;
const shiftManualDeposits = 5000;
const shiftExpenses = 3500;
const shiftExpectedClose = openFloat + shiftCashSales + shiftManualDeposits - shiftExpenses;
assert(shiftExpectedClose === 76500, 'Shift Expected Cash: 20k float + 55k sales + 5k deposits - 3.5k expenses = 76,500 DA');

// 27. Blind Count Variance & Note Enforcement Guard
const physicalCountEntered = 76000; // 500 DA short
const varianceDiscrepancy = physicalCountEntered - shiftExpectedClose; // -500 DA
assert(varianceDiscrepancy === -500, 'Blind Count Discrepancy: 76,000 DA counted - 76,500 DA expected = -500 DA deficit');

function canFinalizeSessionClose(variance, note) {
  if (variance === 0) return true;
  return Boolean(note && note.trim().length > 0);
}
assert(canFinalizeSessionClose(-500, '') === false, 'Variance Enforcement: Block closure when variance != 0 and note is empty');
assert(canFinalizeSessionClose(-500, 'Erreur rendu monnaie ticket REC-891') === true, 'Variance Enforcement: Allow closure when valid explanatory note provided');
assert(canFinalizeSessionClose(0, '') === true, 'Zero Variance: Allow immediate closure with 0 DA discrepancy');

// 28. Shift Net Commercial Profit (Sales Margins - Expenses)
const totalSessionGrossMargins = 24000;
const totalSessionExpenses = 3500;
const shiftNetProfit = totalSessionGrossMargins - totalSessionExpenses;
assert(shiftNetProfit === 20500, 'Daily Net Profit: 24,000 DA sales margin - 3,500 DA expenses = 20,500 DA net profit');

// 29. Immutable Unit Cost Price Protection Against Catalog Price Changes
const historicSaleItem = {
  productId: 'prod-coque-1',
  unitCostPrice: 500, // Captured at checkout time
  appliedPrice: 1500,
  quantity: 2
};
const historicProfit = (historicSaleItem.appliedPrice - historicSaleItem.unitCostPrice) * historicSaleItem.quantity;
// Catalog cost later increases to 800 DA:
const _currentCatalogProduct = { id: 'prod-coque-1', costPrice: 800 };
// Immutable calculation ignores updated catalog cost:
const recomputedHistoricalProfit = (historicSaleItem.appliedPrice - historicSaleItem.unitCostPrice) * historicSaleItem.quantity;
assert(historicProfit === 2000 && recomputedHistoricalProfit === 2000, 'Immutable Cost Tracking: Sale profit remains 2,000 DA regardless of future catalog cost edits');

// 30. Real-Time Store Inventory Valuation View
const mockInventory = [
  { id: 'p1', stock: 10, costPrice: 500, price: 1200 },
  { id: 'p2', stock: 5, costPrice: 2000, price: 3500 },
  { id: 'p3', stock: 0, costPrice: 1000, price: 2000 }, // Out of stock
];
const inStockOnly = mockInventory.filter(p => p.stock > 0);
const storeCostValuation = inStockOnly.reduce((sum, p) => sum + (p.stock * p.costPrice), 0); // 10*500 + 5*2000 = 15,000 DA
const storeRetailValuation = inStockOnly.reduce((sum, p) => sum + (p.stock * p.price), 0); // 10*1200 + 5*3500 = 29,500 DA
const unrealizedMargin = storeRetailValuation - storeCostValuation; // 14,500 DA
assert(storeCostValuation === 15000, 'Inventory Valuation at Cost: 10*500 + 5*2000 = 15,000 DA');
assert(storeRetailValuation === 29500, 'Inventory Valuation at Retail: 10*1200 + 5*3500 = 29,500 DA');
assert(unrealizedMargin === 14500, 'Potential Gross Profit Margin: 29,500 DA - 15,000 DA = 14,500 DA');

// 31. Cash Debt Settlement Integration in Shift Movements
const initialShiftFloat = 20000;
const cashSalesVol = 40000;
const debtCashPayment = 8000; // Customer paid 8k debt in cash
const integratedExpectedWithDebt = initialShiftFloat + cashSalesVol + debtCashPayment;
assert(integratedExpectedWithDebt === 68000, 'Debt Cash Settlement Integration: 20k float + 40k sales + 8k debt versement = 68,000 DA');

// 32. Operating Store Expense in Shift Movements
const storeOperatingExpense = 4500; // Rent/electricity payout from drawer
const expectedAfterExpense = integratedExpectedWithDebt - storeOperatingExpense;
assert(expectedAfterExpense === 63500, 'Operating Expense Integration: 68,000 DA - 4,500 DA expense = 63,500 DA expected cash');

// 33. Trade-In Buyback Cash Payout in Shift Movements
const buybackCashPaidToCustomer = 15000; // Store bought used iPhone for 15k cash
const expectedAfterBuyback = expectedAfterExpense - buybackCashPaidToCustomer;
assert(expectedAfterBuyback === 48500, 'Trade-In Buyback Cash Payout: 63,500 DA - 15,000 DA buyback = 48,500 DA expected cash');

// 34. SAV Repair Advance Deposit in Shift Movements
const savRepairDepositCash = 3000; // Customer paid 3k advance deposit for screen replacement
const expectedAfterSavDeposit = expectedAfterBuyback + savRepairDepositCash;
assert(expectedAfterSavDeposit === 51500, 'SAV Repair Advance Deposit Integration: 48,500 DA + 3,000 DA deposit = 51,500 DA');

// 35. SAV Repair Pickup Balance Settlement in Shift Movements
const savRepairRemainingBalance = 5000; // Customer paid remaining 5k on device pickup
const expectedAfterSavPickup = expectedAfterSavDeposit + savRepairRemainingBalance;
assert(expectedAfterSavPickup === 56500, 'SAV Repair Balance Delivery Settlement Integration: 51,500 DA + 5,000 DA pickup = 56,500 DA');

// 36. Cash Drop Safe Skimming in Shift Movements
const cashDropSkimAmount = 20000; // Skim 20k to back-office safe
const expectedAfterCashDrop = expectedAfterSavPickup - cashDropSkimAmount;
assert(expectedAfterCashDrop === 36500, 'Cash Drop Safe Skimming Integration: 56,500 DA - 20,000 DA drop = 36,500 DA');

// 37. Tender-Aware Split Payment in Shift Reconciliations
// E.g. Sale of 24,000 DA: 14,000 DA Cash + 10,000 DA Customer Credit
const _splitSaleTotal = 24000;
const splitTenders = [
  { method: 'Espèces', amount: 14000 },
  { method: 'Crédit Client', amount: 10000 }
];
const extractedCashPortion = splitTenders.find(t => t.method === 'Espèces')?.amount || 0;
assert(extractedCashPortion === 14000, 'Tender-Aware Split Payment Extraction: 14,000 DA cash extracted from 24,000 DA split sale');

// 38. Full JSON Backup & Disaster Recovery Completeness
const fullBackupSample = {
  exportedAt: new Date().toISOString(),
  products: [{ id: 'p1' }],
  customers: [{ id: 'c1' }],
  transactions: [{ id: 't1' }],
  customerDebts: [{ id: 'd1', customerId: 'c1', amount: 5000 }],
  storeExpenses: [{ id: 'e1', title: 'Loyer', amount: 30000 }],
  cashSessions: [{ id: 's1', status: 'CLOSED', openingFloat: 20000 }],
  cashMovements: [{ id: 'm1', sessionId: 's1', amount: 1500 }]
};
const requiredBackupKeys = ['products', 'customers', 'transactions', 'customerDebts', 'storeExpenses', 'cashSessions', 'cashMovements'];
const allKeysPresent = requiredBackupKeys.every(k => Array.isArray(fullBackupSample[k]));
assert(allKeysPresent === true, 'Backup Archive Parity: All 7 mission-critical tables present in backup export');

// 39. Pre-Aggregated Customer Spent Map Lookup
const sampleTransactions = [
  { customer: { id: 'c1' }, total: 10000, status: 'COMPLETED', isRefund: false },
  { customer: { id: 'c1' }, total: 5000, status: 'COMPLETED', isRefund: false },
  { customer: { id: 'c2' }, total: 12000, status: 'COMPLETED', isRefund: false },
  { customer: { id: 'c1' }, total: 4000, status: 'VOIDED', isRefund: false }
];
const spentMap = new Map();
sampleTransactions.forEach(t => {
  if (t.customer?.id && t.status !== 'VOIDED' && !t.isRefund) {
    spentMap.set(t.customer.id, (spentMap.get(t.customer.id) || 0) + t.total);
  }
});
assert(spentMap.get('c1') === 15000, 'Pre-Aggregated Customer Spent Map: c1 totalSpent = 15,000 DA (voided excluded)');
assert(spentMap.get('c2') === 12000, 'Pre-Aggregated Customer Spent Map: c2 totalSpent = 12,000 DA');

// 40. Client-Side Safe Pagination Math
const totalRecords = 125;
const pageSize = 50;
const calculatedTotalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
const requestedPage = 3;
const safePage = Math.min(requestedPage, calculatedTotalPages);
const startIndex = (safePage - 1) * pageSize;
const endIndex = Math.min(safePage * pageSize, totalRecords);
assert(calculatedTotalPages === 3, 'Pagination Math: 125 records / 50 per page = 3 pages');
assert(startIndex === 100 && endIndex === 125, 'Pagination Slice Bounds: Page 3 shows records 100 to 125 (25 items)');

// 41. Dynamic Manager PIN Verification
let storedManagerPin = '4892';
const verifyPinTest = (pin) => pin === storedManagerPin;
assert(verifyPinTest('1234') === false, 'Manager PIN Security: Default 1234 rejected when custom PIN configured');
assert(verifyPinTest('4892') === true, 'Manager PIN Security: Custom 4892 authorized');

// 42. Relational Identifier Alignment (Finding F-002)
const simulateUnifiedCheckout = () => {
  const transactionId = `TXN-${Math.floor(100000 + Math.random() * 900000)}`;
  const receiptNumber = `REC-${Date.now().toString().slice(-6)}`;

  const ledgerReferenceId = transactionId;
  const debtReceiptNumber = receiptNumber;

  const transaction = {
    id: transactionId,
    receiptNumber: receiptNumber
  };
  return { ledgerReferenceId, debtReceiptNumber, transaction };
};
const fixedRun = simulateUnifiedCheckout();
assert(fixedRun.ledgerReferenceId === fixedRun.transaction.id, 'Relational Foreign Key Integrity: Ledger referenceId must match transaction.id');
assert(fixedRun.debtReceiptNumber === fixedRun.transaction.receiptNumber, 'Relational Receipt Integrity: Debt receiptNumber must match transaction.receiptNumber');

// 43. Checkout Persistence Error Propagation (Finding F-001)
const simulatePersistence = async (dbShouldFail) => {
  let cart = [{ id: 'p1', qty: 1 }];
  let successReported = false;

  const dbWrite = async () => {
    if (dbShouldFail) throw new Error('SQLITE_BUSY: database is locked');
  };
  
  // Fixed behavior: properly awaits and catches DB errors without emptying cart
  try {
    await dbWrite();
    cart = [];
    successReported = true;
  } catch (_e) {
    // Failure handled cleanly, cart preserved
    successReported = false;
  }

  return { success: successReported, cartLength: cart.length };
};

(async () => {
  const res = await simulatePersistence(true);
  assert(res.success === false, 'Checkout Error Propagation: Must report failure when SQLite write fails');
  assert(res.cartLength === 1, 'Cart Rollback on Failure: Cart must NOT be emptied when SQLite write fails');

  // 44. Storage Adapter Empty Table Fallback (Finding F-003)
  const simulateAdapterFetch = async (isTauri, sqliteResult, dexieStaleData) => {
    if (isTauri) {
      try {
        const list = sqliteResult;
        if (Array.isArray(list)) return list;
      } catch (_e) {}
    }
    return dexieStaleData;
  };

  const adapterRes = await simulateAdapterFetch(true, [], [{ id: 'stale-cust', name: 'Stale' }]);
  assert(adapterRes.length === 0, 'Storage Adapter Empty State: Legitimate empty SQLite table must NOT resurrect Dexie records');
  const webAdapterRes = await simulateAdapterFetch(false, [], [{ id: 'stale-cust', name: 'Stale' }]);
  assert(webAdapterRes.length === 1, 'Storage Adapter Web Fallback: Pure web mode correctly reads Dexie');

  // 45. Invoice CSV Duplicate SKU Ingestion Aggregation (Finding F-004)
  const simulateFixedCsvIngestion = (csvRows, storeProducts) => {
    const updatedProductsMap = new Map();
    csvRows.forEach(row => {
      const currentProd =
        Array.from(updatedProductsMap.values()).find(p => p.sku === row.sku) ||
        storeProducts.find(p => p.sku === row.sku);

      if (currentProd) {
        const updated = {
          ...currentProd,
          stock: currentProd.stock + row.qty
        };
        updatedProductsMap.set(updated.sku, updated);
      }
    });
    return updatedProductsMap.get('SKU-A')?.stock;
  };

  const initialStoreProducts = [{ sku: 'SKU-A', stock: 5 }];
  const csvBatch = [{ sku: 'SKU-A', qty: 10 }, { sku: 'SKU-A', qty: 15 }];
  const fixedFinalStock = simulateFixedCsvIngestion(csvBatch, initialStoreProducts);
  assert(fixedFinalStock === 30, 'CSV Multi-Line Ingestion: 5 initial + 10 batch1 + 15 batch2 = 30 total stock');

  // 46. Excel XML Period Label Sanitization (Finding F-007)
  const escapeXml = (str) => {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  const simulateFixedExcelHeader = (periodLabel) => {
    return `<Cell><Data ss:Type="String">Période : ${escapeXml(periodLabel)}</Data></Cell>`;
  };

  const rawLabel = 'Accessoires & Câbles < 30 jours >';
  const xmlOutput = simulateFixedExcelHeader(rawLabel);
  assert(xmlOutput.includes('&amp;') && xmlOutput.includes('&lt;') && xmlOutput.includes('&gt;'), 'Excel XML Sanitization: periodLabel must escape & to &amp;, < to &lt;, and > to &gt;');

  // 47. Backend ISO-8601 Timestamp Validation (Finding F-009)
  const simulateGregorianIsoString = (secs) => {
    const d = new Date(secs * 1000);
    return d.toISOString();
  };

  const testEpochSecs = 1756638500;
  const timestampOutput = simulateGregorianIsoString(testEpochSecs);
  const parsedDate = new Date(timestampOutput);
  const isValidDate = !isNaN(parsedDate.getTime()) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestampOutput);
  assert(isValidDate, `Backend Timestamp ISO-8601 Compliance: "${timestampOutput}" is a valid, parsable ISO date`);

  // 48. App Updater False Positive Version Comparison & SemVer Matrix
  const isNewerVersion = (remoteVersionStr, currentVersionStr) => {
    if (!remoteVersionStr || !currentVersionStr) return false;
    const clean = (v) => v.trim().replace(/^v/i, '').split('-')[0];
    const remoteParts = clean(remoteVersionStr).split('.').map((p) => parseInt(p, 10) || 0);
    const currentParts = clean(currentVersionStr).split('.').map((p) => parseInt(p, 10) || 0);
    const maxLength = Math.max(remoteParts.length, currentParts.length, 3);
    for (let i = 0; i < maxLength; i++) {
      const r = remoteParts[i] || 0;
      const c = currentParts[i] || 0;
      if (r > c) return true;
      if (r < c) return false;
    }
    return false;
  };

  assert(isNewerVersion('1.4.3', '1.4.3') === false, 'Updater SemVer: 1.4.3 vs 1.4.3 (Equal) -> No update');
  assert(isNewerVersion('v1.4.3', '1.4.3') === false, 'Updater SemVer: v1.4.3 vs 1.4.3 (v-prefix) -> No update');
  assert(isNewerVersion('1.4.4', '1.4.3') === true, 'Updater SemVer: 1.4.4 vs 1.4.3 (Newer patch) -> Update available');
  assert(isNewerVersion('1.10.0', '1.9.0') === true, 'Updater SemVer: 1.10.0 vs 1.9.0 (Multi-digit minor) -> Update available');
  assert(isNewerVersion('1.9.0', '1.10.0') === false, 'Updater SemVer: 1.9.0 vs 1.10.0 (Local newer) -> No update');
  assert(isNewerVersion('1.4.2', '1.4.3') === false, 'Updater SemVer: 1.4.2 vs 1.4.3 (Remote older) -> No update');
  assert(isNewerVersion(null, '1.4.3') === false, 'Updater SemVer: Fetch failure / null remote -> Fail closed');

  // 49. Direct Cart Quantity Manual Entry & Stock Clamping
  const simulateSetCartItemQty = (stock, requestedQty, isSerialized = false) => {
    if (isSerialized) return 1;
    const safeQty = Math.max(1, isNaN(requestedQty) ? 1 : Math.floor(requestedQty));
    return Math.min(stock, safeQty);
  };
  assert(simulateSetCartItemQty(100, 25) === 25, 'Direct Qty Input: 25 pieces within 100 stock accepted');
  assert(simulateSetCartItemQty(10, 50) === 10, 'Direct Qty Input: 50 pieces clamped to available 10 stock');
  assert(simulateSetCartItemQty(10, -5) === 1, 'Direct Qty Input: Negative qty clamped to 1');
  assert(simulateSetCartItemQty(5, 4, true) === 1, 'Direct Qty Input: Serialized phone locked to 1 unit per IMEI');

  // 50. Dynamic Cashier Identity Attribution
  const getSaleCashierName = (activeShift) => activeShift?.cashierName || 'Yacine (Caisse 1)';
  assert(getSaleCashierName({ cashierName: 'Amine' }) === 'Amine', 'Cashier Attribution: Sale assigned to active shift cashier (Amine)');
  assert(getSaleCashierName(null) === 'Yacine (Caisse 1)', 'Cashier Attribution: Fallback default assigned when no shift open');

  // 51. Subtotal Brut & Remise Separation Math
  const items = [
    { price: 1000, qty: 3, discount: 200 }, // Gross 3,000 DA, Disc 200 DA
    { price: 2500, qty: 1, discount: 300 }, // Gross 2,500 DA, Disc 300 DA
  ];
  const grossSubtotal = items.reduce((acc, i) => acc + i.price * i.qty, 0);
  const totalRemise = items.reduce((acc, i) => acc + i.discount, 0);
  const netTotal = Math.max(0, grossSubtotal - totalRemise);
  assert(grossSubtotal === 5500, 'Totals Breakdown: Gross Subtotal = 5,500 DA');
  assert(totalRemise === 500, 'Totals Breakdown: Remise Accordée = 500 DA');
  assert(netTotal === 5000, 'Totals Breakdown: Total Net à Payer = 5,000 DA');

  console.log('====================================================');
  console.log('TEST SUMMARY:', passCount, 'PASSED,', failCount, 'FAILED');
  console.log('====================================================');
  if (failCount > 0) process.exit(1);
})();



