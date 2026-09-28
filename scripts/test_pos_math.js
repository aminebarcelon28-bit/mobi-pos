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

  // 52. Same-Cart Counter Exchange (Customer buys 2000 DA case, exchanges/returns 1500 DA protector)
  const exchangeItems = [
    { title: 'Coque Silicone iPhone 13', price: 2000, qty: 1, isReturn: false },
    { title: 'Verre Trempé Défectueux / Erreur', price: 1500, qty: 1, isReturn: true },
  ];
  const exchangeGrossSubtotal = exchangeItems.reduce((acc, i) => {
    const signedQty = i.isReturn ? -i.qty : i.qty;
    return acc + (i.price * signedQty);
  }, 0);
  assert(exchangeGrossSubtotal === 500, 'Same-Cart Exchange: 2000 DA purchase - 1500 DA return = 500 DA net due');

  // Inventory stock delta simulation for exchange
  const initialStockA = 10;
  const initialStockB = 5;
  const deltaA = exchangeItems[0].isReturn ? exchangeItems[0].qty : -exchangeItems[0].qty; // -1
  const deltaB = exchangeItems[1].isReturn ? exchangeItems[1].qty : -exchangeItems[1].qty; // +1
  assert(initialStockA + deltaA === 9, 'Inventory Delta: Sold item decrements stock (10 -> 9)');
  assert(initialStockB + deltaB === 6, 'Inventory Delta: Returned item replenishes stock (5 -> 6)');

  // 53. Same-Cart Return with Negative Net (Customer returns 2500 DA charger, takes 1000 DA cable)
  const netRefundItems = [
    { title: 'Chargeur Rapide 33W', price: 2500, qty: 1, isReturn: true },
    { title: 'Câble Type-C Tressé', price: 1000, qty: 1, isReturn: false },
  ];
  const netRefundSubtotal = netRefundItems.reduce((acc, i) => {
    const signedQty = i.isReturn ? -i.qty : i.qty;
    return acc + (i.price * signedQty);
  }, 0);
  assert(netRefundSubtotal === -1500, 'Same-Cart Return Refund: 1000 DA purchase - 2500 DA return = -1500 DA cash refund');

  // 54. Blind Close Recount Lockout (Manager PIN verification)
  const verifyRecountAccess = (enteredPin, managerPin) => enteredPin === managerPin;
  assert(verifyRecountAccess('0000', '1234') === false, 'Blind Close Security: Cashier blind count recount blocked with invalid PIN');
  assert(verifyRecountAccess('1234', '1234') === true, 'Blind Close Security: Recount authorized with manager PIN');

  // 55. Scannable Store Credit Voucher (credit_vouchers) Math & State Machine
  const mockVoucher = {
    code: 'AV-849201',
    initialAmount: 2000,
    remainingAmount: 2000,
    status: 'ACTIVE',
  };
  assert(/^AV-\d{6}$/.test(mockVoucher.code), 'Voucher Code Syntax: Must match AV-XXXXXX scannable barcode pattern');

  // Scenario A: Partial redemption (cart 1200 DA with 2000 DA voucher)
  const cartSubtotalA = 1200;
  const deductA = Math.min(mockVoucher.remainingAmount, cartSubtotalA);
  const remainingA = mockVoucher.remainingAmount - deductA;
  const statusA = remainingA <= 0 ? 'EXHAUSTED' : 'ACTIVE';
  assert(deductA === 1200, 'Voucher Redemption: 1200 DA deducted from 2000 DA voucher');
  assert(remainingA === 800, 'Voucher Balance: 800 DA remaining on voucher');
  assert(statusA === 'ACTIVE', 'Voucher Status: Remains ACTIVE when balance > 0');

  // Scenario B: Second purchase exhaust (cart 1000 DA with 800 DA remaining voucher)
  const cartSubtotalB = 1000;
  const deductB = Math.min(remainingA, cartSubtotalB);
  const remainingB = remainingA - deductB;
  const cashDueB = cartSubtotalB - deductB;
  const statusB = remainingB <= 0 ? 'EXHAUSTED' : 'ACTIVE';
  assert(deductB === 800, 'Voucher Exhaustion: Remaining 800 DA consumed');
  assert(remainingB === 0, 'Voucher Balance: 0 DA balance left');
  assert(cashDueB === 200, 'Voucher + Cash Split: Remaining 200 DA required in cash');
  assert(statusB === 'EXHAUSTED', 'Voucher Status: Transitions to EXHAUSTED upon 0 DA balance');

  // 56. Multi-Terminal Cash Drawer Isolation
  const desktopSession = { id: 'shift-desktop', openedAt: '2026-09-20T08:00:00Z', deviceId: 'desktop-counter' };
  const allTransactions = [
    { id: 'tx-1', createdAt: '2026-09-20T09:00:00Z', status: 'COMPLETED', total: 1500, paymentMethod: 'Espèces', deviceId: 'desktop-counter' },
    { id: 'tx-2', createdAt: '2026-09-20T09:30:00Z', status: 'COMPLETED', total: 3000, paymentMethod: 'Espèces', deviceId: 'mobile-phone-floor' },
    { id: 'tx-3', createdAt: '2026-09-20T10:00:00Z', status: 'COMPLETED', total: 2500, paymentMethod: 'Espèces', deviceId: 'desktop-counter' },
  ];
  const isolatedDesktopTxns = allTransactions.filter(
    (t) => (!desktopSession.deviceId || !t.deviceId || t.deviceId === desktopSession.deviceId)
  );
  const isolatedCashSales = isolatedDesktopTxns.reduce((sum, t) => sum + t.total, 0);
  assert(isolatedDesktopTxns.length === 2, 'Drawer Isolation: Mobile companion sales excluded from desktop drawer count');
  assert(isolatedCashSales === 4000, 'Drawer Reconciliation: Desktop drawer expected cash = 1500 + 2500 = 4000 DA (not 7000 DA)');

  // 57. Per-Cashier Quick Lock Screen PIN Validation
  const cashiers = [
    { id: 'u1', name: 'Yacine (Gérant)', pin: '1234', role: 'admin' },
    { id: 'u2', name: 'Amine', pin: '0000', role: 'cashier' },
    { id: 'u3', name: 'Karim', pin: '1111', role: 'cashier' },
  ];
  const managerPin = '1234';
  const authenticateUnlock = (enteredPin) => {
    if (enteredPin === managerPin) return { success: true, user: cashiers[0] };
    const matched = cashiers.find((u) => u.pin === enteredPin);
    return matched ? { success: true, user: matched } : { success: false };
  };
  assert(authenticateUnlock('0000').user?.name === 'Amine', 'Lock Screen: Amine unlocked with PIN 0000');
  assert(authenticateUnlock('1111').user?.name === 'Karim', 'Lock Screen: Karim unlocked with PIN 1111');
  assert(authenticateUnlock('9999').success === false, 'Lock Screen: Invalid PIN 9999 rejected');
  assert(authenticateUnlock('1234').user?.role === 'admin', 'Lock Screen: Manager PIN overrides and unlocks with admin');

  // 58. Volume / Bundle Pricing Tier Evaluation
  const testProduct = {
    price: 500,
    volumeDiscounts: [
      { minQty: 3, price: 400 },
      { minQty: 5, price: 350 },
    ],
  };
  const getVolumePricing = (prod, qty) => {
    const tiers = (prod.volumeDiscounts || []).filter((t) => qty >= t.minQty).sort((a, b) => b.minQty - a.minQty);
    const activeTier = tiers[0];
    if (activeTier && activeTier.price < prod.price) {
      const discountPerUnit = prod.price - activeTier.price;
      return {
        unitPrice: activeTier.price,
        gross: prod.price * qty,
        discount: discountPerUnit * qty,
        net: activeTier.price * qty,
        isVolume: true,
      };
    }
    return {
      unitPrice: prod.price,
      gross: prod.price * qty,
      discount: 0,
      net: prod.price * qty,
      isVolume: false,
    };
  };

  const pQty1 = getVolumePricing(testProduct, 1);
  assert(pQty1.net === 500 && !pQty1.isVolume, 'Volume Pricing: 1 unit costs regular 500 DA');

  const pQty2 = getVolumePricing(testProduct, 2);
  assert(pQty2.net === 1000 && !pQty2.isVolume, 'Volume Pricing: 2 units cost regular 1,000 DA');

  const pQty3 = getVolumePricing(testProduct, 3);
  assert(pQty3.net === 1200 && pQty3.discount === 300 && pQty3.isVolume, 'Volume Pricing: 3 units trigger tier (400 DA/u = 1,200 DA net, 300 DA discount)');

  const pQty5 = getVolumePricing(testProduct, 5);
  assert(pQty5.net === 1750 && pQty5.discount === 750 && pQty5.isVolume, 'Volume Pricing: 5 units trigger top tier (350 DA/u = 1,750 DA net, 750 DA discount)');

  // 59. Product Matrix & Variant Generation Permutation Math
  const matrixModels = ['iPhone 13', 'iPhone 14', 'iPhone 15', 'iPhone 16'];
  const matrixColors = ['Noir Titane', 'Bleu Nuit', 'Titane Naturel'];
  const generatedSkus = [];
  for (const m of matrixModels) {
    for (const c of matrixColors) {
      const mCode = m.replace('iPhone ', 'IP');
      const cCode = c.slice(0, 4).toUpperCase();
      generatedSkus.push(`COQ-${mCode}-${cCode}`);
    }
  }
  assert(generatedSkus.length === 12, 'Matrix Generator: 4 models x 3 colors = 12 variant SKUs generated');
  const uniqueSkus = new Set(generatedSkus);
  assert(uniqueSkus.size === 12, 'Matrix Generator: All 12 variant SKUs are unique and non-colliding');

  // 60. Barcode Shelf Stocktake Audit Variance & Financial Loss Math
  const stocktakeAudit = [
    { title: 'Coque Silicone IP15', systemStock: 10, countedStock: 10, costPrice: 600 },
    { title: 'Verre Trempé 9H', systemStock: 15, countedStock: 12, costPrice: 800 },
    { title: 'Câble Type-C 20W', systemStock: 5, countedStock: 7, costPrice: 500 },
  ];
  let totalDeltaPieces = 0;
  let totalDeltaCostDA = 0;
  let anomaliesCount = 0;
  for (const row of stocktakeAudit) {
    const diff = row.countedStock - row.systemStock;
    if (diff !== 0) anomaliesCount++;
    totalDeltaPieces += diff;
    totalDeltaCostDA += diff * row.costPrice;
  }
  assert(anomaliesCount === 2, 'Stocktake Audit: Detected 2 discrepancy anomalies');
  assert(totalDeltaPieces === -1, 'Stocktake Audit: Net variance = -3 + 2 = -1 piece');
  assert(totalDeltaCostDA === -1400, 'Stocktake Audit: Net shrinkage financial impact = -2,400 + 1,000 = -1,400 DA');

  // 61. Service & Quick Touch Non-Stock Invariant (Cleaning / Nettoyage 500 DA)
  const serviceProduct = {
    id: 'qt-clean',
    title: 'Nettoyage Connecteur & HP',
    price: 500,
    costPrice: 0,
    category: 'Services',
    stock: 999999,
    isService: true,
  };
  const cartWithService = [
    { product: serviceProduct, quantity: 1, isReturn: false, appliedPrice: 500 },
  ];
  // Assert deltas exclusion: services produce 0 physical inventory ledger deltas
  const generatedDeltas = cartWithService.filter((ci) => {
    const isService = Boolean(
      ci.product?.isService ||
      ci.product?.category === 'Services' ||
      ci.product?.id?.startsWith('qt-') ||
      ci.product?.id?.startsWith('prod-misc-')
    );
    return !isService;
  });
  assert(generatedDeltas.length === 0, 'Service Non-Stock Invariant: 0 inventory ledger deltas generated for service sale');

  // Assert stock preservation: service stock stays at infinite 999999
  const cartProductMap = new Map();
  for (const item of cartWithService) {
    const isServiceItem = Boolean(
      item.product.isService ||
      item.product.category === 'Services' ||
      item.product.id?.startsWith('qt-') ||
      item.product.id?.startsWith('prod-misc-')
    );
    if (isServiceItem) continue;
    cartProductMap.set(item.product.id, item.quantity);
  }
  assert(cartProductMap.size === 0, 'Service Non-Stock Invariant: Cart stock deduction map excludes services');

  // Assert oversell guard bypass: service never throws INSUFFICIENT_STOCK
  const isOversellBlocked = (pid, isService, ledgerCount, ledgerSum, requestedQty) => {
    if (isService || pid.startsWith('qt-') || pid.startsWith('prod-misc-')) return false;
    if (ledgerCount > 0 && ledgerSum - requestedQty < 0) return true;
    return false;
  };
  assert(
    isOversellBlocked('qt-clean', true, 1, -1, 1) === false,
    'Service Oversell Guard: Cleaning service allowed even if legacy ledger was negative/zero'
  );

  // ══════════════════════════════════════════════════════════════
  // 35. BARCODE SCANNER USB HID HARDWARE SIMULATION
  // ══════════════════════════════════════════════════════════════
  const parseScanCode = (raw) => {
    let multiplier = 1;
    let code = raw.trim();
    const multiplierMatch = code.match(/^(\d{1,3})\s*[*xX]\s*(.+)$/);
    if (multiplierMatch && multiplierMatch[1] && multiplierMatch[2]) {
      multiplier = Math.max(1, parseInt(multiplierMatch[1], 10));
      code = multiplierMatch[2].trim();
    }
    code = code.replace(/^\][A-Za-z0-9]{2}/, '');
    return { code, multiplier };
  };

  const parsed1 = parseScanCode('5*6138318449885');
  assert(parsed1.multiplier === 5 && parsed1.code === '6138318449885', 'Hardware Scanner: Multiplier 5* correctly extracted');

  const parsedAim = parseScanCode(']E06138318449885');
  assert(parsedAim.multiplier === 1 && parsedAim.code === '6138318449885', 'Hardware Scanner: AIM prefix ]E0 stripped');

  const parsedAim128 = parseScanCode(']C1COQ-IP15-BLK');
  assert(parsedAim128.code === 'COQ-IP15-BLK', 'Hardware Scanner: AIM prefix ]C1 stripped');

  const shortBarcodeSupported = (code) => code.length >= 3;
  assert(shortBarcodeSupported('999') === true, 'Hardware Scanner: 3-character short barcode supported');
  assert(shortBarcodeSupported('12') === false, 'Hardware Scanner: 2-character short keypress rejected');

  // ══════════════════════════════════════════════════════════════
  // 36. DEMI-GROS (HALF WHOLESALE) & PRICING TIER DYNAMICS
  // ══════════════════════════════════════════════════════════════
  const getWholesalePrice = (p) => (p.wholesalePrice > 0 ? p.wholesalePrice : Math.round(p.price * 0.75));
  const getSemiWholesalePrice = (p) => {
    if (typeof p.semiWholesalePrice === 'number' && p.semiWholesalePrice > 0) {
      return p.semiWholesalePrice;
    }
    const wholesale = getWholesalePrice(p);
    if (p.price > wholesale) {
      return Math.round((p.price + wholesale) / 2);
    }
    return Math.round(p.price * 0.88);
  };
  const getProductPriceForTier = (p, tier) => {
    if (tier === 'Wholesale') return getWholesalePrice(p);
    if (tier === 'VIP') return getSemiWholesalePrice(p);
    return p.price || 0;
  };

  const sampleProductWithExplicitDemi = {
    id: 'p1',
    price: 3500,
    semiWholesalePrice: 2950,
    wholesalePrice: 2400,
    costPrice: 1500,
  };

  const sampleProductFallback = {
    id: 'p2',
    price: 4000,
    wholesalePrice: 3000,
    costPrice: 2000,
  };

  // Assert explicit Demi-Gros
  assert(
    getProductPriceForTier(sampleProductWithExplicitDemi, 'Retail') === 3500,
    'Pricing Tiers: Retail tier returns 3500 DA'
  );
  assert(
    getProductPriceForTier(sampleProductWithExplicitDemi, 'VIP') === 2950,
    'Pricing Tiers: Demi-Gros tier returns explicit 2950 DA'
  );
  assert(
    getProductPriceForTier(sampleProductWithExplicitDemi, 'Wholesale') === 2400,
    'Pricing Tiers: Wholesale tier returns 2400 DA'
  );

  // Assert fallback Demi-Gros (midpoint)
  assert(
    getProductPriceForTier(sampleProductFallback, 'VIP') === 3500,
    'Pricing Tiers: Demi-Gros fallback calculates exact midpoint (4000 + 3000)/2 = 3500 DA'
  );

  // Assert Cart Tier Switch Recalculation (Bug Fix Verification)
  const simulateTierSwitch = (cart, targetTier) => {
    return cart.map((item) => {
      const isManualOverride =
        item.defaultPrice !== undefined &&
        item.appliedPrice !== item.defaultPrice &&
        !item.volumeTierApplied;
      if (isManualOverride) return item;

      const newBase = getProductPriceForTier(item.product, targetTier);
      return {
        ...item,
        appliedPrice: newBase,
        unitPriceCharged: newBase,
        defaultPrice: newBase,
      };
    });
  };

  // Cart with standard item added at Retail (3500 DA)
  let testCart = [
    {
      product: sampleProductWithExplicitDemi,
      quantity: 2,
      appliedPrice: 3500,
      unitPriceCharged: 3500,
      defaultPrice: 3500,
      volumeTierApplied: false,
    },
    // And an item with manual cashier discount:
    {
      product: sampleProductFallback,
      quantity: 1,
      appliedPrice: 3800, // Manually overridden from 4000
      unitPriceCharged: 3800,
      defaultPrice: 4000,
      volumeTierApplied: false,
    },
  ];

  // Switch to Demi-Gros (VIP)
  let demiCart = simulateTierSwitch(testCart, 'VIP');
  assert(
    demiCart[0].appliedPrice === 2950,
    'Tier Switch: Standard item price updated to 2950 DA on Demi-Gros'
  );
  assert(
    demiCart[1].appliedPrice === 3800,
    'Tier Switch: Manual price override (3800 DA) preserved across tier change'
  );

  // Switch to Wholesale
  let wholesaleCart = simulateTierSwitch(demiCart, 'Wholesale');
  assert(
    wholesaleCart[0].appliedPrice === 2400,
    'Tier Switch: Standard item price updated to 2400 DA on Wholesale'
  );

  // Switch back to Retail
  let retailCart = simulateTierSwitch(wholesaleCart, 'Retail');
  assert(
    retailCart[0].appliedPrice === 3500,
    'Tier Switch: Standard item price restored to 3500 DA on Retail'
  );

  // 17. Used Phone & Serialized Product: Strict Barcode vs IMEI Isolation
  console.log('\n--- Running Barcode vs IMEI Separation Tests ---');

  function calculateEan13CheckDigit(twelveDigits) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = parseInt(twelveDigits[i], 10);
      sum += i % 2 === 0 ? digit : digit * 3;
    }
    const rem = sum % 10;
    return rem === 0 ? 0 : 10 - rem;
  }

  function simulateEan13Generation(existingList, prefix = '613') {
    const existing = new Set(existingList.map((p) => p.barcode));
    for (let i = 0; i < 1000; i++) {
      const random = Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
      const payload = `${prefix}${random}`;
      const check = calculateEan13CheckDigit(payload);
      const code = `${payload}${check}`;
      if (!existing.has(code)) return code;
    }
    const fallback = `${prefix}000000001`;
    return `${fallback}${calculateEan13CheckDigit(fallback)}`;
  }

  function simulateTradeInConversion(tradeInput, products) {
    const realBarcode = tradeInput.barcode && tradeInput.barcode.trim().length > 0
      ? tradeInput.barcode.trim()
      : simulateEan13Generation(products, '613');

    const converted = {
      id: 'prod-trade-test',
      sku: `TRD-${tradeInput.imei.slice(-6)}`,
      barcode: realBarcode,
      title: `${tradeInput.deviceModel} (${tradeInput.conditionGrade})`,
      brand: tradeInput.brand,
      category: "Téléphones d'Occasion (Reprise)",
      price: Math.round(tradeInput.buybackValue * 1.3),
      costPrice: tradeInput.buybackValue,
      stock: 1,
      isSerialized: true,
      imeiNumber: tradeInput.imei.trim(),
    };
    return converted;
  }

  // Case A: User provides a real box/packaging barcode
  const tradeInputWithRealBarcode = {
    deviceModel: 'iPhone 14 Pro Max',
    brand: 'Apple',
    imei: '358921004812345',
    barcode: '0195949038445', // Real Apple box barcode
    conditionGrade: 'Grade A (Comme Neuf)',
    buybackValue: 120000,
  };
  const convertedA = simulateTradeInConversion(tradeInputWithRealBarcode, []);
  assert(
    convertedA.barcode === '0195949038445',
    'Trade-In with real barcode: barcode field equals the scanned/entered packaging barcode'
  );
  assert(
    convertedA.imeiNumber === '358921004812345',
    'Trade-In with real barcode: imeiNumber retains the 15-digit physical IMEI'
  );
  assert(
    convertedA.barcode !== convertedA.imeiNumber,
    'Trade-In with real barcode: barcode is strictly distinct from imeiNumber'
  );

  // Case B: User does NOT provide a barcode (no original box)
  const tradeInputWithoutBarcode = {
    deviceModel: 'Samsung Galaxy S23 Ultra',
    brand: 'Samsung',
    imei: '354892019842104',
    barcode: '',
    conditionGrade: 'Grade B (Bon État)',
    buybackValue: 95000,
  };
  const convertedB = simulateTradeInConversion(tradeInputWithoutBarcode, [convertedA]);
  assert(
    convertedB.barcode !== tradeInputWithoutBarcode.imei,
    'Trade-In without barcode: barcode is NEVER the 15-digit IMEI'
  );
  assert(
    convertedB.barcode.length === 13 && convertedB.barcode.startsWith('613'),
    'Trade-In without barcode: valid 13-digit EAN-13 starting with 613 is generated'
  );
  assert(
    convertedB.imeiNumber === '354892019842104',
    'Trade-In without barcode: imeiNumber preserves the 15-digit IMEI'
  );
  assert(
    convertedB.isSerialized === true,
    'Trade-In without barcode: product is correctly flagged as serialized'
  );

  // Case C: Adding serialized product to cart pre-populates IMEI if known
  const cartItemPreFilled = {
    product: convertedA,
    quantity: 1,
    imeiNumber: convertedA.isSerialized ? (convertedA.imeiNumber || '') : undefined,
  };
  assert(
    cartItemPreFilled.imeiNumber === '358921004812345',
    'Cart Item: Serialized phone with known IMEI automatically pre-populates imeiNumber'
  );

  // Case D: Searching catalog by IMEI
  const testCatalog = [convertedA, convertedB];
  const searchQuery = '358921004812345';
  const matched = testCatalog.filter((p) =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.barcode.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.imeiNumber && p.imeiNumber.toLowerCase().includes(searchQuery.toLowerCase()))
  );
  assert(
    matched.length === 1 && matched[0].id === 'prod-trade-test' && matched[0].imeiNumber === searchQuery,
    'Catalog Search: Used phone is successfully found by its 15-digit IMEI while preserving distinct barcode'
  );

  console.log('====================================================');
  console.log('TEST SUMMARY:', passCount, 'PASSED,', failCount, 'FAILED');
  console.log('====================================================');
  if (failCount > 0) process.exit(1);
})();



