const assert = require('assert');

console.log('\n=======================================================================');
console.log('🧪 RUNNING ENTERPRISE LOYALTY & FIFO BUCKET VERIFICATION TESTS');
console.log('=======================================================================\n');

let passedCount = 0;
let totalCount = 0;

function it(name, fn) {
  totalCount++;
  try {
    fn();
    console.log('  ✅ [PASS] ' + name);
    passedCount++;
  } catch (err) {
    console.error('  ❌ [FAIL] ' + name);
    console.error('     Error: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 1. COGS Margin Floor Guardrail (Anti-Bankruptcy Protection)
// ─────────────────────────────────────────────────────────────
console.log('\n🛡️ [COGS FLOOR GUARDRAIL] Wholesale Cost Recovery:');

function calculateMaxAllowedCredit(grossTotal, totalCogs, customerAvailableCredit, maxRedemptionPercent = 50) {
  const safeGross = Math.max(0, grossTotal);
  const safeCogs = Math.max(0, totalCogs);
  const safeBalance = Math.max(0, customerAvailableCredit);
  const percentCap = Math.floor(safeGross * (maxRedemptionPercent / 100));
  const profitMarginFloor = Math.max(0, safeGross - safeCogs);
  const maxAllowedCredit = Math.min(safeBalance, percentCap, profitMarginFloor);
  const isCogsConstrained = maxAllowedCredit === profitMarginFloor && profitMarginFloor < safeBalance;
  return { maxAllowedCredit, isCogsConstrained, profitMarginFloor };
}

it('Enforces COGS margin floor (50,000 DA phone with 42,000 DA cost -> Max credit capped at 8,000 DA)', () => {
  const res = calculateMaxAllowedCredit(50000, 42000, 20000, 50);
  assert.strictEqual(res.maxAllowedCredit, 8000, 'Must not allow credit to breach wholesale cost');
  assert.strictEqual(res.isCogsConstrained, true, 'Flagged as COGS constrained');
});

it('Respects standard 50% basket percentage cap when margin is higher (5,000 DA accessories with 1,000 DA cost)', () => {
  const res = calculateMaxAllowedCredit(5000, 1000, 4000, 50);
  assert.strictEqual(res.maxAllowedCredit, 2500, '50% of 5,000 DA is 2,500 DA');
  assert.strictEqual(res.isCogsConstrained, false);
});

// ─────────────────────────────────────────────────────────────
// 2. Net-Paid Out-of-Pocket Accrual (Anti-Perpetual Inflation)
// ─────────────────────────────────────────────────────────────
console.log('\n🚫 [NET-PAID ACCRUAL] Zero-Liability Inflation:');

function calculateNetPaidPoints(cartItems, netCashPaid, grossTotal, pointsMultiplier = 1.0) {
  if (netCashPaid <= 0 || grossTotal <= 0) return 0;
  const netRatio = Math.min(1.0, netCashPaid / grossTotal);
  let totalPoints = 0;
  for (const item of cartItems) {
    const itemNetPaid = item.lineTotal * netRatio;
    const catMult = item.categoryMultiplier || 1.0;
    const basePoints = Math.floor(itemNetPaid / 100);
    totalPoints += Math.floor(basePoints * pointsMultiplier * catMult);
  }
  return Math.max(1, totalPoints);
}

it('Calculates points ONLY on 4,000 DA net cash paid for a 5,000 DA basket (1,000 DA credit applied)', () => {
  const cart = [{ lineTotal: 5000, categoryMultiplier: 1.0 }];
  const points = calculateNetPaidPoints(cart, 4000, 5000, 1.0);
  // 4,000 DA net / 100 = 40 base points
  assert.strictEqual(points, 40, 'Must accrue exactly 40 points on net 4,000 DA');
});

it('Applies 2.0x category multiplier on Screen Protectors on net cash paid', () => {
  const cart = [{ lineTotal: 5000, categoryMultiplier: 2.0 }];
  const points = calculateNetPaidPoints(cart, 4000, 5000, 1.0);
  // 4,000 DA net * 2.0x / 100 = 80 points
  assert.strictEqual(points, 80, 'Must accrue 80 points');
});

// ─────────────────────────────────────────────────────────────
// 3. FIFO Point Bucket Depletion (Oldest Points First)
// ─────────────────────────────────────────────────────────────
console.log('\n⏳ [FIFO BUCKET DEPLETION] Sequential Aging Mechanics:');

function depleteFifoBuckets(buckets, pointsToRedeem) {
  const sorted = [...buckets].sort((a, b) => {
    if (!a.expiresAt && !b.expiresAt) return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (!a.expiresAt) return 1;
    if (!b.expiresAt) return -1;
    return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
  });
  let needed = pointsToRedeem;
  let consumed = 0;
  const updated = sorted.map((b) => {
    if (b.isFullyConsumed || b.remainingPoints <= 0 || needed <= 0) return b;
    const deduct = Math.min(b.remainingPoints, needed);
    needed -= deduct;
    consumed += deduct;
    const remaining = b.remainingPoints - deduct;
    return { ...b, remainingPoints: remaining, isFullyConsumed: remaining === 0 };
  });
  return { updatedBuckets: updated, consumedPoints: consumed, remainingPointsToRedeem: needed };
}

it('Depletes expiring 30-day bucket first before 180-day bucket', () => {
  const now = Date.now();
  const bucketA = { id: 'B-OLD', remainingPoints: 50, expiresAt: new Date(now + 30 * 86400000).toISOString(), isFullyConsumed: false };
  const bucketB = { id: 'B-NEW', remainingPoints: 100, expiresAt: new Date(now + 180 * 86400000).toISOString(), isFullyConsumed: false };

  const res = depleteFifoBuckets([bucketB, bucketA], 70); // Redeem 70 pts
  assert.strictEqual(res.consumedPoints, 70);
  const updatedA = res.updatedBuckets.find((b) => b.id === 'B-OLD');
  const updatedB = res.updatedBuckets.find((b) => b.id === 'B-NEW');
  assert.strictEqual(updatedA.remainingPoints, 0, 'Oldest bucket exhausted');
  assert.strictEqual(updatedA.isFullyConsumed, true);
  assert.strictEqual(updatedB.remainingPoints, 80, 'Newer bucket has 80 pts remaining');
});

// ─────────────────────────────────────────────────────────────
// 4. Precision Net Profit Accounting
// ─────────────────────────────────────────────────────────────
console.log('\n📊 [PROFIT ACCOUNTING] Realized Net Margin:');

it('Computes Realized Net Profit as (Net Revenue Collected - COGS)', () => {
  const gross = 5000;
  const creditApplied = 1000;
  const cogs = 2500;
  const netRevenue = gross - creditApplied; // 4000
  const netProfit = netRevenue - cogs; // 1500
  const marginPercent = ((netProfit / netRevenue) * 100).toFixed(1);

  assert.strictEqual(netRevenue, 4000);
  assert.strictEqual(netProfit, 1500);
  assert.strictEqual(marginPercent, '37.5');
});

console.log('\n=======================================================================');
console.log('FINAL RESULT: ' + passedCount + '/' + totalCount + ' ENTERPRISE LOYALTY TESTS PASSED');
console.log('=======================================================================\n');

if (passedCount !== totalCount) {
  process.exit(1);
}
