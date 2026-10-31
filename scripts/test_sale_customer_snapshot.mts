/**
 * D6 regression: the sale payload must carry the customer's identity and scalar
 * loyalty state, never the whole loyalty book.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_sale_customer_snapshot.mts
 */
import { saleCustomerSnapshot } from '../src/utils/saleCustomerSnapshot.ts';

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
function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

const bigCustomer = {
  id: 'C1',
  name: 'Salma',
  phone: '0551000000',
  email: 's@example.dz',
  loyaltyPoints: 1234,
  loyaltyTier: 'Or',
  storeCredit: 500,
  currentDebt: 250,
  totalSpent: 4_000_000_000,
  pricingTier: 'Retail',
  registeredDevice: 'dev-1',
  whatsappOptIn: true,
  // The unbounded parts: 200 000 milestone tranches + buckets.
  ledger: Array.from({ length: 200_000 }, (_, i) => ({
    id: `L${i}`,
    points: 1,
    creditDeltaDzd: 0,
    referenceId: `C1:milestone:ms-20k:tranche:${i + 1}`,
    description: 'Palier 20k',
  })),
  pointBuckets: Array.from({ length: 500 }, (_, i) => ({
    id: `B${i}`,
    initialPoints: 10,
    remainingPoints: 10,
    originTransactionId: `REC-${i}`,
  })),
} as unknown as Parameters<typeof saleCustomerSnapshot>[0];

console.log('sale customer snapshot — D6');

check('drops the unbounded arrays', () => {
  const snap = saleCustomerSnapshot(bigCustomer) as Record<string, unknown>;
  ok(snap !== undefined, 'snapshot exists');
  ok(!('ledger' in snap), 'ledger dropped');
  ok(!('pointBuckets' in snap), 'pointBuckets dropped');
});

check('keeps identity and scalar loyalty state', () => {
  const snap = saleCustomerSnapshot(bigCustomer) as Record<string, unknown>;
  ok(snap.id === 'C1', 'id');
  ok(snap.name === 'Salma', 'name');
  ok(snap.phone === '0551000000', 'phone');
  ok(snap.loyaltyPoints === 1234, 'loyaltyPoints');
  ok(snap.loyaltyTier === 'Or', 'loyaltyTier');
  ok(snap.storeCredit === 500, 'storeCredit');
  ok(snap.totalSpent === 4_000_000_000, 'totalSpent');
});

check('the serialized payload is bounded (a 4e9 ticket no longer explodes)', () => {
  const before = JSON.stringify(bigCustomer).length;
  const after = JSON.stringify(saleCustomerSnapshot(bigCustomer)).length;
  ok(before > 10_000_000, `fixture must be big (was ${before})`);
  ok(after < 5_000, `snapshot must be small (was ${after})`);
  console.log(`       payload ${before} B -> ${after} B`);
});

check('null/undefined stay undefined', () => {
  ok(saleCustomerSnapshot(null) === undefined, 'null');
  ok(saleCustomerSnapshot(undefined) === undefined, 'undefined');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
