import {
  calculateCustomerTier,
  calculateEarnedPoints,
  convertPointsToCredit,
  calculateNextTierProgress,
  createLedgerEntry,
  syncCustomerLoyaltyState
} from './loyaltyEngine';
import type { Customer } from '../types/pos';

export const runLoyaltyEngineTests = () => {
  console.log('🧪 Starting End-to-End Loyalty Engine Test Suite...\n');
  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, testName: string, errorDetails?: string) => {
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${errorDetails ? ` - ${errorDetails}` : ''}`);
      failed++;
    }
  };

  // Test 1: Tier Resolution by Spend Thresholds
  const tierBronze = calculateCustomerTier(0);
  assert(tierBronze.name === 'Bronze' && tierBronze.pointsMultiplier === 1.0, '0 DA spend resolves to Bronze (1x multiplier)');

  const tierSilver = calculateCustomerTier(50000);
  assert(tierSilver.name === 'Silver' && tierSilver.pointsMultiplier === 1.25, '50,000 DA spend resolves to Silver (1.25x multiplier)');

  const tierGold = calculateCustomerTier(180000);
  assert(tierGold.name === 'Gold' && tierGold.pointsMultiplier === 1.5, '180,000 DA spend resolves to Gold (1.5x multiplier)');

  const tierPlatinum = calculateCustomerTier(350000);
  assert(tierPlatinum.name === 'Platinum' && tierPlatinum.pointsMultiplier === 2.0, '350,000 DA spend resolves to Platinum (2.0x multiplier)');

  const tierVIP = calculateCustomerTier(750000);
  assert(tierVIP.name === 'VIP Diamond' && tierVIP.pointsMultiplier === 2.5, '750,000 DA spend resolves to VIP Diamond (2.5x multiplier)');

  // Test 2: Points Earned Math with Tier Multipliers
  // Sale of 10,000 DA
  const pointsBronze = calculateEarnedPoints(10000, 1.0); // 100 * 1.0 = 100 pts
  assert(pointsBronze === 100, 'Bronze 10,000 DA sale earns 100 pts');

  const pointsGold = calculateEarnedPoints(10000, 1.5); // 100 * 1.5 = 150 pts
  assert(pointsGold === 150, 'Gold (1.5x) 10,000 DA sale earns 150 pts');

  const pointsVIP = calculateEarnedPoints(10000, 2.5); // 100 * 2.5 = 250 pts
  assert(pointsVIP === 250, 'VIP Diamond (2.5x) 10,000 DA sale earns 250 pts');

  // Test 3: Points to Store Credit Conversion Math
  const conversion50 = convertPointsToCredit(50); // 50 pts * 10 = 500 DA credit
  assert(conversion50.creditAmount === 500, '50 pts converts to 500 DA store credit');

  const conversionZero = convertPointsToCredit(0);
  assert(conversionZero.creditAmount === 0, '0 pts converts to 0 DA store credit');

  // Test 4: Next Tier Progress Progression Math
  // Spent 100,000 DA (Between Silver 50k and Gold 150k) -> 50,000 / 100,000 = 50%
  const progressMid = calculateNextTierProgress(100000);
  assert(
    progressMid.currentTier.name === 'Silver' &&
    progressMid.nextTier?.name === 'Gold' &&
    progressMid.progressPercent === 50 &&
    progressMid.remainingSpend === 50000,
    '100,000 DA spend shows Silver tier with 50% progress toward Gold (50,000 DA remaining)'
  );

  const progressMax = calculateNextTierProgress(1000000);
  assert(
    progressMax.currentTier.name === 'VIP Diamond' &&
    progressMax.nextTier === null &&
    progressMax.progressPercent === 100 &&
    progressMax.remainingSpend === 0,
    '1,000,000 DA spend shows VIP Diamond tier with 100% progress and no remaining spend'
  );

  // Test 5: Ledger Entry & Customer State Sync
  const mockCustomer: Customer = {
    id: 'CUST-001',
    name: 'Karim Hadj',
    phone: '0555123456',
    email: 'karim@test.dz',
    registeredDevice: 'iPhone 15',
    loyaltyPoints: 120,
    storeCredit: 500,
    pricingTier: 'Retail',
    totalSpent: 160000,
  };

  const synced = syncCustomerLoyaltyState(mockCustomer);
  assert(synced.loyaltyTier === 'Gold', 'Customer with 160,000 DA spent is synced to Gold tier');

  const ledgerEntry = createLedgerEntry(
    mockCustomer.id,
    'earn',
    150,
    synced.loyaltyPoints + 150,
    'Achat REC-123456',
    'TXN-999'
  );
  assert(
    ledgerEntry.points === 150 && ledgerEntry.balanceAfter === 270 && ledgerEntry.type === 'earn',
    'Ledger entry created with correct points and updated balance'
  );

  console.log(`\n📊 TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  return { passed, failed, total: passed + failed };
};
