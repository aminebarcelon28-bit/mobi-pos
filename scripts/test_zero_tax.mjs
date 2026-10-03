/**
 * Test E (rescoped) — Zero-Tax Consistency Proof (Gate Addendum A).
 *
 * Owner-confirmed product truth: this software has NO TVA/VAT feature.
 * Any rate passed via `vatRate` must be ignored — every sale is HT-only.
 *
 * Asserts:
 *  E1. computeTax ignores the rate (tva 0, ttc == ht) for 0/1/9/19/100.
 *  E2. computeCartTotals yields tax/tva 0 and total == net for vatRate 0/9/19,
 *      across plain, discounted, credit-stacked and refund shapes.
 *  E3. tvaSplitFromTotal always returns null (receipt/print paths stay HT-only).
 *  E4. Static CI gate: no TVA rate math remains in money paths
 *      (gate.rs hints, taxEngine/receiptMath rate literals).
 *  E5. Discounts are untouched by the removal (discount math still exact).
 */
const ROOT = process.cwd();

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ts = await import('typescript');
const fs = await import('node:fs');
const toDataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const transpileFile = (absPath) => {
  const source = fs.readFileSync(absPath, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: absPath,
  }).outputText;
};
const taxUrl = toDataUrl(transpileFile(`${ROOT}/src/utils/taxEngine.ts`));
const pricingUrl = toDataUrl(transpileFile(`${ROOT}/src/utils/pricingEngine.ts`));
let rmSrc = fs.readFileSync(`${ROOT}/src/utils/receiptMath.ts`, 'utf8');
rmSrc = rmSrc.replace(/from\s+(['"])\.\/pricingEngine\1/g, `from '${pricingUrl}'`);
rmSrc = rmSrc.replace(/from\s+(['"])\.\/taxEngine\1/g, `from '${taxUrl}'`);
const rmOut = ts.transpileModule(rmSrc, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  fileName: 'receiptMath.ts',
});
const rm = await import(toDataUrl(rmOut.outputText));
const { computeCartTotals, tvaSplitFromTotal } = rm;
const taxMod = await import(taxUrl);
const { computeTax } = taxMod;

console.log('========================================================================');
console.log('TEST E (RESCOPED) — ZERO-TAX CONSISTENCY PROOF (Gate Addendum A)');
console.log('========================================================================');

console.log('\n--- E1: computeTax ignores the rate ---');
for (const rate of [0, 1, 9, 19, 100]) {
  const r = computeTax(10000, rate);
  check(`computeTax(10000, ${rate}) → tva 0, ttc == ht == 10000`, r.tva === 0 && r.ttc === 10000 && r.ht === 10000 && r.vatRate === 0, JSON.stringify(r));
}
check('computeTax clamps negative net to 0', computeTax(-500, 19).ht === 0 && computeTax(-500, 19).ttc === 0, JSON.stringify(computeTax(-500, 19)));

console.log('\n--- E2: computeCartTotals tax/tva 0 at every rate ---');
const line = (price, qty = 1, extra = {}) => ({ product: { price }, appliedPrice: price, quantity: qty, ...extra });
for (const rate of [0, 9, 19]) {
  const t = computeCartTotals([line(10000)], { vatRate: rate });
  check(`plain 10k @vatRate ${rate}: tax 0, tva 0, total 10000`, t.tax === 0 && t.tva === 0 && t.total === 10000, JSON.stringify({ tax: t.tax, tva: t.tva, total: t.total }));
}
{
  const t = computeCartTotals([line(100000)], { vatRate: 19, cartDiscountPercent: 10, storeCreditApplied: 10000, voucherCreditApplied: 5000, tradeInCredit: 20000 });
  check('stacked discounts+credits @19: tva 0, total = 90000-35000 = 55000', t.tva === 0 && t.tax === 0 && t.total === 55000, JSON.stringify({ tva: t.tva, total: t.total }));
  check('stacked ht equals pre-credit base 90000', t.ht === 90000, String(t.ht));
}
{
  // 3 lines @ 33.33 analogue in DA integers: 3333 x3 with no tax — exact, no split policy needed.
  const t = computeCartTotals([line(3333), line(3333), line(3334)], { vatRate: 19 });
  check('3-line 10 000 @19: total exactly 10000, tva 0', t.total === 10000 && t.tva === 0, JSON.stringify({ total: t.total }));
}
{
  // Refund shape: return line refunds exactly what was charged, no tax involved.
  // Sale would charge 9000−1000 = 8000; the symmetric return refunds 8000.
  const t = computeCartTotals([{ product: { price: 9000 }, appliedPrice: 9000, quantity: 1, isReturn: true, discount: 1000 }], { vatRate: 19 });
  check('return of discounted line refunds charged 8000 (symmetric, tva 0)', t.net === -8000 && t.tva === 0 && t.refundDue === 8000, JSON.stringify({ net: t.net, rd: t.refundDue }));
}

console.log('\n--- E3: tvaSplitFromTotal always null ---');
check('null at rate 0', tvaSplitFromTotal(10000, 0) === null);
check('null at rate 19', tvaSplitFromTotal(10000, 19) === null);
check('null at rate undefined', tvaSplitFromTotal(10000) === null);

console.log('\n--- E4: static gate — no TVA rate math in money paths ---');
const gateSrc = fs.readFileSync(`${ROOT}/src-tauri/src/gate.rs`, 'utf8');
check('gate.rs: no 0.19 literal', !gateSrc.includes('0.19'), 'found 0.19');
check('gate.rs: no 0.09 literal', !gateSrc.includes('0.09'), 'found 0.09');
check('gate.rs: no tva_19/tva_9 identifiers', !/tva_19|tva_9/.test(gateSrc), 'found tva_*');
check('gate.rs: no TVA hint strings', !/TVA l\u00e9gale|TVA r\u00e9duite|droit de timbre/.test(gateSrc), 'found hint');
const taxSrc = fs.readFileSync(`${ROOT}/src/utils/taxEngine.ts`, 'utf8');
check('taxEngine.ts: no rate multiplication', !/ht \* rate|rate \*| \/ 100\)/.test(taxSrc), 'found rate math');
check('taxEngine.ts: documents the removal', /Gate Addendum A/.test(taxSrc));
const cartSliceSrc = fs.readFileSync(`${ROOT}/src/store/slices/createCartSlice.ts`, 'utf8');
check('createCartSlice readVatRate forced 0', /export function readVatRate\(_s: PosState\): number \{\s*\n?\s*return 0;/.test(cartSliceSrc));
const settingsSrc = fs.readFileSync(`${ROOT}/src/components/modals/SettingsModal.tsx`, 'utf8');
check('SettingsModal: no vatRate editor left', !settingsSrc.includes('Taux TVA'));

console.log('\n--- E5: discounts untouched ---');
{
  const t = computeCartTotals([line(100000)], { vatRate: 19, cartDiscountPercent: 10 });
  check('10% cart discount still exact: total 90000', t.total === 90000 && t.cartDiscountTotal === 10000, JSON.stringify({ total: t.total }));
  const tl = computeCartTotals([{ product: { price: 1000 }, appliedPrice: 1000, quantity: 2, discount: 200 }], { vatRate: 19 });
  check('line discount still exact: total 1800', tl.total === 1800, String(tl.total));
}

console.log('\n========================================================================');
console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
if (fail > 0) process.exit(1);
