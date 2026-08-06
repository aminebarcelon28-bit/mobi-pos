// Standalone Node Test Runner for Loyalty Engine

const LOYALTY_TIERS = [
  { name: 'Bronze', minSpend: 0, pointsMultiplier: 1.0, discountPercent: 0 },
  { name: 'Silver', minSpend: 50000, pointsMultiplier: 1.25, discountPercent: 3 },
  { name: 'Gold', minSpend: 150000, pointsMultiplier: 1.5, discountPercent: 5 },
  { name: 'Platinum', minSpend: 300000, pointsMultiplier: 2.0, discountPercent: 8 },
  { name: 'VIP Diamond', minSpend: 600000, pointsMultiplier: 2.5, discountPercent: 12 },
];

const calculateCustomerTier = (totalSpent = 0) => {
  const safeSpend = Math.max(0, totalSpent);
  const sorted = [...LOYALTY_TIERS].sort((a, b) => b.minSpend - a.minSpend);
  return sorted.find(t => safeSpend >= t.minSpend) || LOYALTY_TIERS[0];
};

const calculateEarnedPoints = (saleTotal, pointsMultiplier = 1.0) => {
  if (saleTotal <= 0 || pointsMultiplier <= 0) return 0;
  const basePoints = Math.floor(saleTotal / 100);
  return Math.floor(basePoints * pointsMultiplier);
};

const convertPointsToCredit = (points) => {
  if (points <= 0) return { creditAmount: 0, ratePerPoint: 10 };
  const ratePerPoint = 10;
  return { creditAmount: Math.floor(points * ratePerPoint), ratePerPoint };
};

const calculateNextTierProgress = (totalSpent = 0) => {
  const currentTier = calculateCustomerTier(totalSpent);
  const currentTierIndex = LOYALTY_TIERS.findIndex(t => t.name === currentTier.name);
  if (currentTierIndex >= LOYALTY_TIERS.length - 1) {
    return { currentTier, nextTier: null, progressPercent: 100, remainingSpend: 0 };
  }
  const nextTier = LOYALTY_TIERS[currentTierIndex + 1];
  const spendInCurrentTier = Math.max(0, totalSpent - currentTier.minSpend);
  const tierSpan = nextTier.minSpend - currentTier.minSpend;
  const progressPercent = Math.min(100, Math.max(0, Math.round((spendInCurrentTier / tierSpan) * 100)));
  const remainingSpend = Math.max(0, nextTier.minSpend - totalSpent);
  return { currentTier, nextTier, progressPercent, remainingSpend };
};

const createLedgerEntry = (customerId, type, points, balanceAfter, description, referenceId) => {
  return {
    id: `LEDGER-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    customerId,
    timestamp: new Date().toISOString(),
    type,
    points,
    balanceAfter,
    description,
    referenceId,
  };
};

console.log('--------------------------------------------------------');
console.log('🧪 RUNNING COMPREHENSIVE END-TO-END LOYALTY ENGINE TESTS');
console.log('--------------------------------------------------------\n');

let passed = 0;
let failed = 0;

const assert = (condition, testName, errorDetails) => {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}${errorDetails ? ` - ${errorDetails}` : ''}`);
    failed++;
  }
};

// 1. Tier Resolution Tests
assert(calculateCustomerTier(0).name === 'Bronze', '0 DA spend -> Bronze Tier');
assert(calculateCustomerTier(50000).name === 'Silver', '50,000 DA spend -> Silver Tier');
assert(calculateCustomerTier(180000).name === 'Gold', '180,000 DA spend -> Gold Tier');
assert(calculateCustomerTier(350000).name === 'Platinum', '350,000 DA spend -> Platinum Tier');
assert(calculateCustomerTier(750000).name === 'VIP Diamond', '750,000 DA spend -> VIP Diamond Tier');

// 2. Points Earned Math Tests (with Tier Multipliers)
assert(calculateEarnedPoints(10000, 1.0) === 100, '10,000 DA @ Bronze (1.0x) -> 100 Points');
assert(calculateEarnedPoints(10000, 1.25) === 125, '10,000 DA @ Silver (1.25x) -> 125 Points');
assert(calculateEarnedPoints(10000, 1.5) === 150, '10,000 DA @ Gold (1.5x) -> 150 Points');
assert(calculateEarnedPoints(10000, 2.0) === 200, '10,000 DA @ Platinum (2.0x) -> 200 Points');
assert(calculateEarnedPoints(10000, 2.5) === 250, '10,000 DA @ VIP Diamond (2.5x) -> 250 Points');

// 3. Points-to-Credit Conversion Math Tests
assert(convertPointsToCredit(50).creditAmount === 500, '50 Points -> 500 DA Store Credit');
assert(convertPointsToCredit(100).creditAmount === 1000, '100 Points -> 1,000 DA Store Credit');
assert(convertPointsToCredit(0).creditAmount === 0, '0 Points -> 0 DA Store Credit');

// 4. Progress Math Tests
const prog = calculateNextTierProgress(100000);
assert(prog.currentTier.name === 'Silver', '100,000 DA spend current tier is Silver');
assert(prog.nextTier.name === 'Gold', '100,000 DA spend next tier is Gold');
assert(prog.progressPercent === 50, '100,000 DA spend progress is exactly 50%');
assert(prog.remainingSpend === 50000, '100,000 DA spend remaining spend is 50,000 DA');

// 5. Ledger Creation Test
const entry = createLedgerEntry('CUST-1', 'earn', 150, 270, 'Sale REC-123456', 'TXN-999');
assert(entry.points === 150 && entry.balanceAfter === 270 && entry.type === 'earn', 'Ledger entry created with valid payload');

console.log('\n--------------------------------------------------------');
console.log(`📊 TEST SUITE RESULT: ${passed}/${passed + failed} TESTS PASSED CLEANLY!`);
console.log('--------------------------------------------------------\n');

if (failed > 0) process.exit(1);
