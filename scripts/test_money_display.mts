/**
 * Money display math (UI-005) — tests for addReceiptLineCost(),
 * averageReceiptUnitCost() and debtLimitGauge() in
 * src/utils/receiptMath.ts.
 *
 * Proves: single-rounding blended costs (no per-line dust); zero-safe
 * averages; debt gauge sane at zero/missing limits (no Infinity%, no
 * false over-limit on empty debt); clamping behavior preserved.
 */
import {
  addReceiptLineCost,
  averageReceiptUnitCost,
  debtLimitGauge,
} from '../src/utils/receiptMath.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// 1. Single rounding beats double rounding on fractional costs.
{
  // 3 units @ 1000/3 DA: old code rounded per line (333*3=999) then averaged;
  // single-round keeps the exact sum and rounds once (1000/3*3 = 1000).
  let sum = 0;
  sum = addReceiptLineCost(sum, 3, 1000 / 3);
  check('exact extension preserved', sum === 1000);
  check('average rounds once', averageReceiptUnitCost(sum, 3) === 333);
  // Old path for contrast: per-line round loses a dinar here.
  const oldPath = Math.round((3 * Math.round(1000 / 3)) / 3);
  check('documents the dust removed', oldPath === 333 && sum === 1000);
}
{
  // Mixed lines: exact total, integer average.
  let sum = 0;
  sum = addReceiptLineCost(sum, 2, 1500);
  sum = addReceiptLineCost(sum, 3, 1000);
  check('multi-line exact sum', sum === 6000);
  check('multi-line average', averageReceiptUnitCost(sum, 5) === 1200);
}

// 2. Hostile inputs never poison.
check('negative qty ignored', addReceiptLineCost(100, -2, 50) === 100);
check('negative cost ignored', addReceiptLineCost(100, 2, -50) === 100);
check('NaN inputs ignored', addReceiptLineCost(100, Number.NaN, 50) === 100);
check('zero qty → zero average', averageReceiptUnitCost(500, 0) === 0);
check('NaN sum → zero average', averageReceiptUnitCost(Number.NaN, 2) === 0);

// 3. Debt gauge: normal, boundaries, zero-limit.
{
  const normal = debtLimitGauge(2500, 10000);
  check('normal ratio + flag', normal.ratio === 25 && normal.isOver === false);
  check('clamped at 100', debtLimitGauge(15000, 10000).ratio === 100);
  const over = debtLimitGauge(10000, 10000);
  check('at-limit counts over', over.isOver === true && over.ratio === 100);
}
{
  const zeroDebt = debtLimitGauge(0, 0);
  check('zero debt + zero limit: clean, not over',
    zeroDebt.ratio === 0 && zeroDebt.isOver === false);
  const someDebt = debtLimitGauge(500, 0);
  check('debt + zero limit: full bar + over (no credit allowed)',
    someDebt.ratio === 100 && someDebt.isOver === true);
  const missing = debtLimitGauge(300, null);
  check('missing limit never Infinity%', Number.isFinite(missing.ratio));
  const neg = debtLimitGauge(-50, 1000);
  check('negative debt treated as zero', neg.ratio === 0 && neg.isOver === false);
}

console.log(`\nmoney-display: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
