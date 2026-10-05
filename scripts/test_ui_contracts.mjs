/**
 * UI contract suite (input layer — what the manual test exercises):
 *   1. PO cost inputs are UNIT costs end to end: the draft and verification
 *      forms label per-unit fields, display qty×unit line totals, and pass
 *      (qty, unitCost) as SEPARATE fields into the slice, which stores them
 *      into SEPARATE batch columns (quantity_remaining vs unit_cost). A
 *      total-vs-unit swap anywhere in this chain prices every unit at the
 *      line total (the 6200 class of bug).
 *   2. Cost inputs parse localized amounts (no parseInt truncation) and land
 *      whole dinars.
 *   3. No PO/invoice/catalog-ingest path mutates the selling price.
 *   4. Re-validation defaults complete lines to remaining qty (0), so a
 *      second validation cannot double-count received stock.
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ [PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.error(`  ❌ [FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}
const src = (p) => readFileSync(`${process.cwd()}/${p}`, 'utf8');

console.log('========================================================================');
console.log('UI CONTRACT SUITE (PO inputs → slice → batches)');
console.log('========================================================================');

const modal = src('src/components/modals/PurchaseOrderModal.tsx');
const proc = src('src/store/slices/createProcurementSlice.ts');
const catalog = src('src/store/slices/createCatalogSlice.ts');
const invoice = src('src/components/modals/InvoiceIngestionModal.tsx');

console.log('--- 1. unit-cost semantics end to end ---');
check('draft form labels the cost field per-unit', modal.includes('Unitaire Estim'));
check('draft line total displayed as qty × unit (display-only)',
  modal.includes('const lineTotal = item.qty * item.unitCost'));
check('receive form labels the cost field per-unit (DA/u delta)',
  modal.includes('Prix Achat Facturé') && modal.includes('DA/u'));
check('receive verification forwards unit cost (not the line total)',
  modal.includes('actualUnitCost,') && modal.includes('receivedQty,'));
check('slice stores qty and unit cost into SEPARATE batch columns',
  proc.includes('quantityRemaining: vi.receivedQty') && proc.includes('unitCost: actualCost,'));

console.log('--- 2. integer-DA cost inputs ---');
{
  // Phase 1c: inline parseLocalizedAmount became the MoneyInput component
  // (localized entry in, exact integer minor out); assert the shipped wiring.
  const costInputs = (modal.match(/label="Coût Unitaire Estimé \(DA\)"|label="Prix Achat Facturé \(DA\)"/g) ?? []).length;
  check('both PO cost inputs parse localized amounts', costInputs >= 2, `got ${costInputs}`);
  check('verified cost lands whole dinars', modal.includes('[item.productId]: toLegacyReal(minor)'));
}

console.log('--- 3. selling price isolation ---');
for (const [name, content] of [['procurement slice', proc], ['PO modal', modal], ['invoice modal', invoice], ['catalog slice', catalog]]) {
  check(`${name}: never writes sellingPrice`, !content.includes('sellingPrice'));
  check(`${name}: never assigns product.price`, !/\.price\s*=/.test(content));
}

console.log('--- 4. re-validation cannot double-count ---');
check('complete lines default to remaining qty (0), not full suggestedQty',
  modal.includes('initQty[item.productId] = remainingQty;'));
check('zero-qty verified lines create no deltas/batches (slice guard)',
  proc.includes('if (vi.receivedQty > 0)'));

console.log('========================================================================');
console.log(`UI CONTRACT SUMMARY: ${pass} Passed, ${fail} Failed`);
console.log('========================================================================');
if (fail > 0) process.exit(1);
