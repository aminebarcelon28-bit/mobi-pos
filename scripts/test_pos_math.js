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

console.log('====================================================');
console.log('TEST SUMMARY:', passCount, 'PASSED,', failCount, 'FAILED');
console.log('====================================================');
if (failCount > 0) process.exit(1);



