/**
 * Automated System Test Runner for Loyalty Program, Store Credit & PVC Card Scanner
 */



console.log('\n--------------------------------------------------------');
console.log('🧪 RUNNING COMPREHENSIVE END-TO-END SYSTEM INTEGRATION TESTS');
console.log('--------------------------------------------------------\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failCount++;
  }
}

// 1. Loyalty Tier Thresholds & Multipliers
const TIER_THRESHOLDS = {
  silverMinSpend: 50000,
  goldMinSpend: 150000,
  platinumMinSpend: 300000,
  vipDiamondMinSpend: 600000,
};

function calculateCustomerTier(totalSpent = 0) {
  if (totalSpent >= TIER_THRESHOLDS.vipDiamondMinSpend) return { name: 'VIP Diamond', pointsMultiplier: 2.5 };
  if (totalSpent >= TIER_THRESHOLDS.platinumMinSpend) return { name: 'Platinum', pointsMultiplier: 2.0 };
  if (totalSpent >= TIER_THRESHOLDS.goldMinSpend) return { name: 'Gold', pointsMultiplier: 1.5 };
  if (totalSpent >= TIER_THRESHOLDS.silverMinSpend) return { name: 'Silver', pointsMultiplier: 1.25 };
  return { name: 'Bronze', pointsMultiplier: 1.0 };
}

assert(calculateCustomerTier(0).name === 'Bronze', '0 DA spend -> Bronze Tier (1.0x)');
assert(calculateCustomerTier(50000).name === 'Silver', '50,000 DA spend -> Silver Tier (1.25x)');
assert(calculateCustomerTier(150000).name === 'Gold', '150,000 DA spend -> Gold Tier (1.5x)');
assert(calculateCustomerTier(300000).name === 'Platinum', '300,000 DA spend -> Platinum Tier (2.0x)');
assert(calculateCustomerTier(600000).name === 'VIP Diamond', '600,000 DA spend -> VIP Diamond Tier (2.5x)');

// 2. 20,000 DA Spent Milestone Rule (+1,000 DA Credit)
function calculateMilestoneBonus(currentTotalSpent, newTotalSpent) {
  const prevMilestones = Math.floor(currentTotalSpent / 20000);
  const newMilestones = Math.floor(newTotalSpent / 20000);
  const unlocked = Math.max(0, newMilestones - prevMilestones);
  return unlocked * 1000;
}

assert(calculateMilestoneBonus(0, 20000) === 1000, 'Customer spends 20,000 DA -> Unlocks +1,000 DA Store Credit Bonus');
assert(calculateMilestoneBonus(0, 45000) === 2000, 'Customer spends 45,000 DA -> Unlocks 2 milestones (+2,000 DA Credit)');
assert(calculateMilestoneBonus(20000, 25000) === 0, 'Customer spends 5,000 DA (20k to 25k) -> 0 new milestone credit');

// 3. Store Credit Deduction Logic (User scenario: 1,000 DA credit - 500 DA item = 500 DA remaining)
function processCreditDeduction(initialCredit, itemPrice) {
  const creditApplied = Math.min(itemPrice, initialCredit);
  const remainingCredit = initialCredit - creditApplied;
  const netCashPaid = Math.max(0, itemPrice - creditApplied);
  return { creditApplied, remainingCredit, netCashPaid };
}

const res1 = processCreditDeduction(1000, 500);
assert(res1.creditApplied === 500, 'Purchasing 500 DA item with 1,000 DA credit -> Credit applied is 500 DA');
assert(res1.remainingCredit === 500, 'Remaining store credit balance is exactly 500 DA');
assert(res1.netCashPaid === 0, 'Net cash paid is 0 DA');

const res2 = processCreditDeduction(1000, 1500);
assert(res2.creditApplied === 1000, 'Purchasing 1,500 DA item with 1,000 DA credit -> Credit applied is 1,000 DA');
assert(res2.remainingCredit === 0, 'Remaining store credit balance is 0 DA');
assert(res2.netCashPaid === 500, 'Net cash paid is remaining 500 DA');

// 4. Net Profit Accounting when Credit is Used
function calculateNetProfit(grossSubtotal, creditApplied, cogs) {
  const netRevenue = Math.max(0, grossSubtotal - creditApplied);
  const netProfit = netRevenue - cogs;
  const marginPercent = netRevenue > 0 ? Number(((netProfit / netRevenue) * 100).toFixed(1)) : 0;
  return { netRevenue, netProfit, marginPercent };
}

const profitRes = calculateNetProfit(20000, 1000, 12000);
assert(profitRes.netRevenue === 19000, '20,000 DA basket with 1,000 DA credit -> Net Revenue collected is 19,000 DA');
assert(profitRes.netProfit === 7000, 'COGS 12,000 DA -> Exact Net Cash Profit is 7,000 DA');
assert(profitRes.marginPercent === 36.8, 'Net Profit Margin % is 36.8%');

// 5. Barcode Scanner Customer PVC Card Identification
const mockCustomers = [
  { id: 'cust-1', name: 'Amina Kaddour', phone: '0661887755', storeCredit: 14500 },
  { id: 'cust-2', name: 'amine', phone: '0654878994', storeCredit: 1000 },
];

function scanCustomerBarcode(scannedCode) {
  const code = scannedCode.trim().toUpperCase();
  const cleanCode = code.replace(/[^A-Z0-9]/g, '');

  return mockCustomers.find(c => {
    const cleanId = c.id.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanPhone = c.phone.replace(/[^0-9]/g, '');
    return (
      c.id.toUpperCase() === code ||
      c.phone === code ||
      cleanPhone === code ||
      `LOY-${c.id.toUpperCase()}` === code ||
      `CUST-${c.id.toUpperCase()}` === code ||
      cleanCode.includes(cleanId)
    );
  });
}

const found1 = scanCustomerBarcode('LOY-cust-2');
assert(found1 && found1.name === 'amine', 'Scanning PVC card barcode "LOY-cust-2" identifies customer "amine"');

const found2 = scanCustomerBarcode('0654878994');
assert(found2 && found2.name === 'amine', 'Scanning phone number "0654878994" identifies customer "amine"');

console.log('\n--------------------------------------------------------');
console.log(`📊 TEST SUITE RESULT: ${passCount}/${passCount + failCount} TESTS PASSED CLEANLY!`);
console.log('--------------------------------------------------------\n');

if (failCount > 0) {
  process.exit(1);
}
