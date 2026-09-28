/**
 * FIFO preview regression (reported issue):
 *   Unit 1 (Cost 500) + Unit 2 (Cost 400) sold @ 3500 each = 6100 profit.
 *   Bug: pre-checkout costing used the latest unit cost (400) for both units
 *   → (3500−400)×2 = 6200.
 *
 * Covers the pure preview core (src/utils/fifoPreview.ts) that feeds the
 * frozen checkout costs and the cart margin badges. The core must mirror the
 * durable depletion in writeCheckoutAtomicInner: oldest-first, overflow into
 * the next batch, shortfall at last-known (newest) cost, returns at caller
 * cost, integer-DA blending.
 */
import {
  simulateFifoAllocation,
  previewFifoCostsForLines,
} from '../src/utils/fifoPreview.ts';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// Batches oldest-first, as the preview DB wrapper orders them.
const batches = new Map([
  ['prodX', [
    { batchId: 'batch-A', quantityRemaining: 1, unitCost: 500 },
    { batchId: 'batch-B', quantityRemaining: 1, unitCost: 400 },
  ]],
]);

// 1. Reported scenario: 2 units @3500 → blended 450 → profit 6100.
{
  const [r] = previewFifoCostsForLines(batches, [
    { productId: 'prodX', qty: 2, fallbackCost: 400 },
  ]);
  check('reported case: blended unit cost 450', r.unitCost === 450, `got ${r.unitCost}`);
  check('reported case: fully covered', r.fullyCovered === true);
  const profit = (3500 - r.unitCost) * 2;
  check('reported case: profit 6100 (not 6200)', profit === 6100, `got ${profit}`);
}

// 2. Single unit takes the OLDEST batch cost (500), not the latest (400).
{
  const [r] = previewFifoCostsForLines(batches, [
    { productId: 'prodX', qty: 1, fallbackCost: 400 },
  ]);
  check('single unit costs oldest batch (500)', r.unitCost === 500, `got ${r.unitCost}`);
}

// 3. Overflow: qty 3 over 1+1 batches → short 1 at last-known (newest = 400).
{
  const [r] = previewFifoCostsForLines(batches, [
    { productId: 'prodX', qty: 3, fallbackCost: 400 },
  ]);
  check('overflow: short 1 unit', r.shortQty === 1 && r.coveredQty === 2, `covered=${r.coveredQty} short=${r.shortQty}`);
  check('overflow: not fully covered', r.fullyCovered === false);
  // (500 + 400 + 400) / 3 = 433.33 → 433 DA.
  check('overflow: blended (500+400+400)/3 = 433', r.unitCost === 433, `got ${r.unitCost}`);
}

// 4. No batches at all → caller (latest) cost, nothing covered.
{
  const [r] = previewFifoCostsForLines(new Map(), [
    { productId: 'prodX', qty: 2, fallbackCost: 400 },
  ]);
  check('no batches: falls back to latest cost (400)', r.unitCost === 400, `got ${r.unitCost}`);
  check('no batches: fully short', r.fullyCovered === false && r.shortQty === 2);
}

// 5. Two lines share one product: sequential allocation, no double-count.
//    Line 1 takes batch-A (500), line 2 takes batch-B (400).
{
  const [r1, r2] = previewFifoCostsForLines(batches, [
    { productId: 'prodX', qty: 1, fallbackCost: 400 },
    { productId: 'prodX', qty: 1, fallbackCost: 400 },
  ]);
  check('multi-line: line 1 costs 500', r1.unitCost === 500, `got ${r1.unitCost}`);
  check('multi-line: line 2 costs 400', r2.unitCost === 400, `got ${r2.unitCost}`);
  check('multi-line: combined profit 6100', (3500 - r1.unitCost) + (3500 - r2.unitCost) === 6100);
}

// 6. Return lines never deplete: caller cost, as the checkout restock leg.
{
  const [r] = previewFifoCostsForLines(batches, [
    { productId: 'prodX', qty: 2, isReturn: true, fallbackCost: 400 },
  ]);
  check('return line keeps caller cost', r.unitCost === 400 && r.fullyCovered === true);
}

// 7. allocate() primitive: oldest-first takes + totals.
{
  const a = simulateFifoAllocation(
    [
      { batchId: 'A', quantityRemaining: 1, unitCost: 500 },
      { batchId: 'B', quantityRemaining: 1, unitCost: 400 },
    ],
    2,
  );
  check('allocate: takes oldest first', a.allocations[0]?.batchId === 'A' && a.allocations[0]?.quantity === 1);
  check('allocate: total cost 900', a.totalCost === 900, `got ${a.totalCost}`);
  check('allocate: no shortfall', a.shortQty === 0 && a.coveredQty === 2);
}

// 8. Corrupt batch values never poison the math (no NaN bindings downstream).
{
  const [r] = previewFifoCostsForLines(
    new Map([['p', [{ batchId: 'x', quantityRemaining: NaN, unitCost: 'oops' }]]]),
    [{ productId: 'p', qty: 1, fallbackCost: 400 }],
  );
  check('corrupt batch: finite unit cost', Number.isFinite(r.unitCost), `got ${r.unitCost}`);
  // Corrupt newest cost mirrors lastKnownPurchaseCost: caller fallback wins.
  check('corrupt newest: shortfall at caller fallback (400)', r.unitCost === 400, `got ${r.unitCost}`);
}

console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
if (fail > 0) process.exit(1);
