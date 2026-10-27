/**
 * UPGRADE-07 — freight landed-cost + supplier price-variance suite.
 *
 * Part 1 — allocation behavior (`src/utils/landedCost.ts`): integer-DZD
 * largest-remainder apportionment whose per-line shares ALWAYS sum to the
 * total; VALUE | QTY | WEIGHT methods; WEIGHT refused without per-line
 * weights (no silent downgrade); equal split only for all-zero value weights;
 * derived per-unit rates.
 *
 * Part 2 — variance detection: strictly >10% upward creep vs the previous
 * receipt from the same supplier; downward moves and first-time purchases
 * stay silent.
 *
 * Part 3 — landed-composition arithmetic: allocation → per-unit rates → the
 * same rounding boundary the FIFO lanes apply (`Math.round(unit_cost +
 * freight_per_unit)`), proving the exact COGS a receipt at that freight
 * produces.
 *
 * Part 4 — wiring pins: the freight column / evidence tables / landed
 * compositions must stay present across the native commit lane, the migration
 * and heal lanes, both FIFO depletion lanes, the valuation sums, and the
 * procurement slice.
 */
import { readFileSync } from 'node:fs';
import {
  allocateFreight,
  computePriceAlerts,
  PRICE_ALERT_THRESHOLD_PCT,
  type FreightLineInput,
} from '../src/utils/landedCost';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    failures.push(`${name}${extra ? ' :: ' + extra : ''}`);
    console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`);
  }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');

// ── Part 1: allocation behavior ────────────────────────────────────────────

{
  const lines: FreightLineInput[] = [
    { qty: 2, unitCost: 100 },
    { qty: 1, unitCost: 300 },
  ];
  const alloc = allocateFreight(1000, 'VALUE', lines);
  check('VALUE: ok', alloc.ok);
  if (alloc.ok) {
    check('VALUE: weights 200/300 → 400/600', alloc.perLineAmount[0] === 400 && alloc.perLineAmount[1] === 600);
    check('VALUE: per-unit rates 200/600', alloc.perUnitFreight[0] === 200 && alloc.perUnitFreight[1] === 600);
  }
}

{
  // 100 / 3 → largest remainder hands the single leftover dinar to line 1.
  const alloc = allocateFreight(100, 'VALUE', [
    { qty: 1, unitCost: 1 },
    { qty: 1, unitCost: 1 },
    { qty: 1, unitCost: 1 },
  ]);
  check('largest remainder: sum exact', alloc.ok && alloc.perLineAmount.reduce((a, b) => a + b, 0) === 100);
  check(
    'largest remainder: deterministic tie → first line',
    alloc.ok && alloc.perLineAmount[0] === 34 && alloc.perLineAmount[1] === 33 && alloc.perLineAmount[2] === 33
  );
}

{
  const alloc = allocateFreight(100, 'QTY', [
    { qty: 2, unitCost: 999 },
    { qty: 3, unitCost: 1 },
  ]);
  check('QTY: splits by quantity, not value', alloc.ok && alloc.perLineAmount[0] === 40 && alloc.perLineAmount[1] === 60);
}

{
  const refused = allocateFreight(100, 'WEIGHT', [{ qty: 2, unitCost: 100 }]);
  check('WEIGHT without weights: refused', !refused.ok && refused.reason === 'FREIGHT_WEIGHT_UNAVAILABLE');
  const weighted = allocateFreight(100, 'WEIGHT', [
    { qty: 1, unitCost: 0, weightKg: 3 },
    { qty: 1, unitCost: 0, weightKg: 1 },
  ]);
  check('WEIGHT with weights: 75/25', weighted.ok && weighted.perLineAmount[0] === 75 && weighted.perLineAmount[1] === 25);
}

{
  const alloc = allocateFreight(50, 'VALUE', [
    { qty: 2, unitCost: 0 },
    { qty: 2, unitCost: 0 },
  ]);
  check('all-zero value weights: equal split', alloc.ok && alloc.perLineAmount[0] === 25 && alloc.perLineAmount[1] === 25);
}

{
  const zero = allocateFreight(0, 'VALUE', [{ qty: 1, unitCost: 10 }]);
  check('zero amount: zero shares', zero.ok && zero.perLineAmount[0] === 0 && zero.perUnitFreight[0] === 0);
  const negative = allocateFreight(-1, 'VALUE', [{ qty: 1, unitCost: 10 }]);
  check('negative amount: refused', !negative.ok && negative.reason === 'FREIGHT_NEGATIVE');
  const empty = allocateFreight(10, 'VALUE', []);
  check('no lines: refused', !empty.ok && empty.reason === 'FREIGHT_EMPTY');
}

{
  // Sum invariant over an awkward set (irrational-ish shares).
  const lines: FreightLineInput[] = [
    { qty: 3, unitCost: 499 },
    { qty: 7, unitCost: 1499 },
    { qty: 1, unitCost: 29 },
    { qty: 5, unitCost: 850 },
  ];
  for (const method of ['VALUE', 'QTY'] as const) {
    const alloc = allocateFreight(7777, method, lines);
    check(`${method}: Σ shares === 7777 exactly`, alloc.ok && alloc.perLineAmount.reduce((a, b) => a + b, 0) === 7777);
  }
}

// ── Part 2: variance detection ─────────────────────────────────────────────

{
  const prev = new Map<string, number>([
    ['p1', 1000],
    ['p2', 1000],
    ['p3', 1000],
  ]);
  const alerts = computePriceAlerts(
    [
      { productId: 'p1', productName: 'A', unitCost: 1150 }, // +15% → alert
      { productId: 'p2', productName: 'B', unitCost: 1099 }, // +9.9% → silent
      { productId: 'p3', productName: 'C', unitCost: 850 }, // -15% → silent
      { productId: 'p4', productName: 'D', unitCost: 9999 }, // first-time → silent
    ],
    prev
  );
  check('variance: exactly one alert', alerts.length === 1);
  check(
    'variance: alert payload',
    alerts[0]?.productId === 'p1' && alerts[0]?.previousCost === 1000 && alerts[0]?.newCost === 1150 && alerts[0]?.variancePct === 15
  );
  check('variance: threshold is strictly-greater-than 10%', PRICE_ALERT_THRESHOLD_PCT === 10);
  const boundary = computePriceAlerts([{ productId: 'p5', unitCost: 1100 }], new Map([['p5', 1000]]));
  check('variance: exactly +10% is NOT an alert', boundary.length === 0);
  const rounding = computePriceAlerts([{ productId: 'p6', unitCost: 1123 }], new Map([['p6', 1000]]));
  check('variance: one-decimal rounding (12.3)', rounding[0]?.variancePct === 12.3);
}

// ── Part 3: landed composition arithmetic ──────────────────────────────────

{
  // QTY split of 100 over [3, 1] at 500/unit → 75/25 → per-unit 25/25 → all
  // four units land at 525; the exact COGS the FIFO lane books is 2100.
  const alloc = allocateFreight(100, 'QTY', [
    { qty: 3, unitCost: 500 },
    { qty: 1, unitCost: 500 },
  ]);
  check('composition: allocation ok', alloc.ok);
  if (alloc.ok) {
    const landed = alloc.perUnitFreight.map((rate) => Math.round(500 + rate));
    check('composition: landed units 525/525', landed[0] === 525 && landed[1] === 525);
    check('composition: exact COGS Σ qty×landed === 2100', landed[0] * 3 + landed[1] * 1 === 2100);
  }
  // Fractional per-unit rate rounds ONCE at composition: 100 over 3 units →
  // 33.333… per unit → 533 landed each (Σ line = 33 + 33 + 34 by share).
  const alloc2 = allocateFreight(100, 'QTY', [{ qty: 3, unitCost: 500 }]);
  if (alloc2.ok) {
    check(
      'composition: fractional rate rounds at composition (533)',
      Math.round(500 + alloc2.perUnitFreight[0]) === 533
    );
  }
}

// ── Part 4: wiring pins ────────────────────────────────────────────────────

{
  const libRs = src('src-tauri/src/lib.rs');
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const commands = src('src-tauri/src/commands.rs');
  const checkout = src('src-tauri/src/checkout.rs');
  const slice = src('src/store/slices/createProcurementSlice.ts');
  const review = src('src/components/PoReviewScreen.tsx');

  check('migration v122 present', libRs.includes('version: 122,'));
  // UPGRADE-09 bumped the ceiling to v124; the pin re-bumps with each upgrade
  // (v127 = refund root rebuild).
  check('EXPECTED_MAX_DB_USER_VERSION = 127', /EXPECTED_MAX_DB_USER_VERSION: u32 = 127;/.test(libRs));
  check('v122 adds freight_per_unit', libRs.includes('ALTER TABLE stock_batches ADD COLUMN freight_per_unit REAL NOT NULL DEFAULT 0;'));
  check('v122 creates po_freight', libRs.includes('CREATE TABLE IF NOT EXISTS po_freight'));
  check('v122 creates supplier_price_history', libRs.includes('CREATE TABLE IF NOT EXISTS supplier_price_history'));

  check('heal lane probes freight_per_unit', adapter.includes("SELECT freight_per_unit FROM stock_batches LIMIT 0;"));
  check('heal lane creates po_freight', adapter.includes('CREATE TABLE IF NOT EXISTS po_freight'));
  check('heal lane alters stock_batches', adapter.includes('ALTER TABLE stock_batches ADD COLUMN freight_per_unit REAL NOT NULL DEFAULT 0;'));
  check('TS FIFO composition carries landed unit', adapter.includes('Number(b.unit_cost) + Math.max(0, Number(b.freight_per_unit) || 0)'));
  check('TS outbox payload stays verbatim (raw unit_cost)', adapter.includes('unit_cost: rawUnitCost,'));
  check('valuation includes freight (both sums)', (adapter.match(/\(unit_cost \+ COALESCE\(freight_per_unit, 0\)\)/g) || []).length >= 2);
  check('insertStockBatch writes freight_per_unit', adapter.includes('freight_per_unit, received_at,'));

  check('native commit inserts freight_per_unit', commands.includes('freight_per_unit,'));
  check('native commit writes po_freight evidence', commands.includes('INSERT INTO po_freight'));
  check('native commit writes price history', commands.includes('INSERT INTO supplier_price_history'));

  check('native FIFO reads freight_per_unit', checkout.includes('freight_per_unit: r.get(3)?'));
  check('native FIFO composes landed unit', checkout.includes('let landed_unit = b.unit_cost + b.freight_per_unit.max(0.0);'));

  check('slice plans allocation before persistence', slice.includes('allocateFreight(freightAmountDzd, freightMethod, freightLines)'));
  check('slice lands freight on batch insert', slice.includes('freightPerUnit: freightPerUnitByProduct.get(vi.productId) ?? 0,'));
  check('slice writes po_freight evidence', slice.includes('insertPoFreightRecord'));
  check('slice computes price alerts', slice.includes('computePriceAlerts('));

  check('review screen sends freight_per_unit', review.includes('freight_per_unit: freightAlloc.ok ? freightAlloc.perUnitFreight[idx] ?? 0 : 0,'));
  check('review screen sends freight total', review.includes('freight_amount: freightDzd,'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('FAILURES:\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
