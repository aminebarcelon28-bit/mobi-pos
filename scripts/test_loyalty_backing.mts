/**
 * REF-15 / G-07 regression: pure rules extracted from the conversion and
 * checkout money paths.
 *
 *  1. A loyalty headline must be backed by buckets; legacy unbacked points get
 *     ONE deterministic genesis bucket (idempotent).
 *  2. Credit minted by a points->Avoir conversion must not redeem points a
 *     second time at checkout (the double-burn).
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_loyalty_backing.mts
 */
import {
  healUnbackedHeadline,
  splitCreditRedemption,
  redeemablePointBalance,
  depleteFifoPointBuckets,
  isPointBucketExpired,
} from '../src/utils/loyaltyEngine.ts';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

const NOW = '2026-11-01T00:00:00.000Z';
const bucket = (id: string, remaining: number) => ({
  id,
  customerId: 'C1',
  initialPoints: remaining,
  remainingPoints: remaining,
  isFullyConsumed: false,
  creditValueDzd: remaining * 10,
  earnedOnNetSpendDzd: 0,
  originTransactionId: 'SEED',
  createdAt: NOW,
  expiresAt: null,
});

console.log('loyalty backing + credit redemption — REF-15');

check('an unbacked headline is healed with one genesis bucket', () => {
  const r = healUnbackedHeadline('C1', 500, [], 10, NOW);
  eq(r.healed, true, 'healed');
  eq(r.unbacked, 500, 'unbacked points');
  eq(r.buckets.length, 1, 'one bucket');
  eq(r.buckets[0].remainingPoints, 500, 'backing equals the headline');
  eq(r.buckets[0].originTransactionId, 'LEGACY-GENESIS', 'provenance');
});

check('healing is idempotent (second pass changes nothing)', () => {
  const first = healUnbackedHeadline('C1', 500, [], 10, NOW);
  const second = healUnbackedHeadline('C1', 500, first.buckets, 10, NOW);
  eq(second.healed, false, 'second pass healed=false');
  eq(second.buckets.length, 1, 'no extra bucket');
  eq(second.buckets[0].remainingPoints, 500, 'unchanged');
});

check('an already-backed headline is untouched', () => {
  const r = healUnbackedHeadline('C1', 120, [bucket('B1', 120)], 10, NOW);
  eq(r.healed, false, 'not healed');
  eq(r.buckets.length, 1, 'one bucket');
});

check('a partially backed headline heals only the remainder', () => {
  const r = healUnbackedHeadline('C1', 500, [bucket('B1', 200)], 10, NOW);
  eq(r.healed, true, 'healed');
  eq(r.unbacked, 300, 'remainder');
  const legacy = r.buckets.find((b) => b.id === 'BUCKET-LEGACY-C1');
  eq(legacy?.remainingPoints, 300, 'legacy bucket carries the remainder');
});

check('a fully spent customer (headline 0) is left alone', () => {
  const r = healUnbackedHeadline('C1', 0, [bucket('B1', 0)], 10, NOW);
  eq(r.healed, false, 'not healed');
  eq(r.buckets.length, 1, 'no bucket added');
});

check('points-backed credit does not redeem points again (no double burn)', () => {
  const s = splitCreditRedemption(400, 400, 10);
  eq(s.pointsToRedeem, 0, 'no second deduction');
  eq(s.pointsBackedUsed, 400, 'all backed credit consumed');
  eq(s.pointsBackedRemaining, 0, 'marker cleared');
});

check('unmarked credit still redeems points at the configured rate', () => {
  const s = splitCreditRedemption(400, 0, 10);
  eq(s.pointsToRedeem, 40, '40 points for 400 DA at 10 DA/pt');
  eq(s.pointsBackedRemaining, 0, 'nothing backed');
});

check('mixed credit splits between backed and redeemable', () => {
  const s = splitCreditRedemption(1000, 400, 10);
  eq(s.pointsToRedeem, 60, 'only the 600 unbacked redeems');
  eq(s.pointsBackedUsed, 400, 'backed portion consumed');
  eq(s.pointsBackedRemaining, 0, 'marker cleared');
});

check('partial spend leaves the rest of the marker for later', () => {
  const s = splitCreditRedemption(100, 400, 10);
  eq(s.pointsToRedeem, 0, 'no points burned');
  eq(s.pointsBackedRemaining, 300, 'marker reduced, not cleared');
});

check('a custom redemption rate is honoured on the unbacked slice', () => {
  const s = splitCreditRedemption(900, 0, 20);
  eq(s.pointsToRedeem, 45, '900 DA at 20 DA/pt');
});

check('zero/negative inputs are clamped (never negative points)', () => {
  const s = splitCreditRedemption(-50, -10, 10);
  eq(s.pointsToRedeem, 0, 'no points');
  eq(s.pointsBackedRemaining, 0, 'no negative marker');
});

// ── LOY-07: expired buckets are dead stock ──────────────────────────────────
const NOW_MS = new Date(NOW).getTime();
const dated = (id: string, remaining: number, expiresAt: string | null) => ({
  ...bucket(id, remaining),
  expiresAt,
});

check('an expired bucket is not redeemable even though the headline still shows it', () => {
  const expired = dated('B-OLD', 100, '2025-02-05T00:00:00.000Z');
  eq(redeemablePointBalance([expired], 100, NOW_MS), 0, 'nothing spendable');
  eq(redeemablePointBalance([expired], 100), 0, 'same verdict on the real clock');
});

check('live stock is spendable and clamped by the headline', () => {
  const buckets = [dated('B-LIVE', 60, '2027-01-01T00:00:00.000Z'), dated('B-OLD', 40, '2025-02-05T00:00:00.000Z')];
  eq(redeemablePointBalance(buckets, 100, NOW_MS), 60, 'only the live bucket');
  eq(redeemablePointBalance(buckets, 25, NOW_MS), 25, 'headline is the lower bound');
});

check('a customer with no buckets keeps the legacy headline', () => {
  eq(redeemablePointBalance([], 120, NOW_MS), 120, 'legacy headline');
  eq(redeemablePointBalance(undefined, 120, NOW_MS), 120, 'missing array');
});

check('a corrupt expiry fails closed (unparsable = expired)', () => {
  const corrupt = dated('B-BAD', 90, 'not-a-date');
  eq(isPointBucketExpired(corrupt, NOW_MS), true, 'corrupt is expired');
  eq(redeemablePointBalance([corrupt], 90, NOW_MS), 0, 'corrupt stock is not spendable');
});

check('FIFO depletion never consumes an expired bucket', () => {
  const buckets = [dated('B-OLD', 100, '2025-02-05T00:00:00.000Z'), dated('B-LIVE', 40, '2027-01-01T00:00:00.000Z')];
  const r = depleteFifoPointBuckets(buckets, 50, NOW_MS);
  eq(r.consumedPoints, 40, 'only live points consumed');
  eq(r.remainingPointsToRedeem, 10, 'shortfall is reported, not invented');
  const old = r.updatedBuckets.find((b) => b.id === 'B-OLD');
  const live = r.updatedBuckets.find((b) => b.id === 'B-LIVE');
  eq(old?.remainingPoints, 100, 'expired bucket untouched');
  eq(live?.remainingPoints, 0, 'live bucket drained');
});

check('FIFO depletion still consumes lifetime and far-future buckets', () => {
  const buckets = [dated('B-LIFE', 30, null), dated('B-FUTURE', 30, '2027-01-01T00:00:00.000Z')];
  const r = depleteFifoPointBuckets(buckets, 40, NOW_MS);
  eq(r.consumedPoints, 40, 'both are live');
  eq(r.remainingPointsToRedeem, 0, 'fully covered');
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
