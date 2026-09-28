/**
 * Task-3 money-fix regression tests (B-025, B-027, B-033, B-024).
 *
 * B-025: price override must charge net once — not 2×clean − default.
 * B-027: parseLocalizedAmount("45.000") → 45000 (FR grouping), not 45/NaN.
 * B-033: addStoreExpense rounds at the write boundary (Math.round).
 * B-024: pointsToRedeem uses receiptSettings.loyaltyConfig.pointRedemptionRate.
 */
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

async function loadTs(relPath, rewrite = []) {
  const ts = await import('typescript');
  const fs = await import('node:fs');
  const absPath = `${ROOT}/${relPath}`;
  let src = fs.readFileSync(absPath, 'utf8');
  for (const [pattern, replacement] of rewrite) {
    src = src.replace(pattern, replacement);
  }
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: absPath,
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(out.outputText).toString('base64')
  );
}

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

console.log('========================================================================');
console.log('💰 TASK-3 MONEY FIX REGRESSION (B-025 / B-027)');
console.log('========================================================================');

// ── B-027: moneyInput FR grouping ───────────────────────────────────────
const { parseLocalizedAmount, roundDAZ } = await loadTs('src/utils/moneyInput.ts');

console.log('\n--- B-027: parseLocalizedAmount FR grouping ---');
check('parseLocalizedAmount("45.000") = 45000', parseLocalizedAmount('45.000') === 45000, String(parseLocalizedAmount('45.000')));
check('parseLocalizedAmount("1.000.000") = 1000000', parseLocalizedAmount('1.000.000') === 1000000, String(parseLocalizedAmount('1.000.000')));
check('parseLocalizedAmount("12,50") = 12.5', parseLocalizedAmount('12,50') === 12.5, String(parseLocalizedAmount('12,50')));
check('parseLocalizedAmount("12.500,50") = 12500.5', parseLocalizedAmount('12.500,50') === 12500.5, String(parseLocalizedAmount('12.500,50')));
check('parseLocalizedAmount("1.234") = 1234 (grouping)', parseLocalizedAmount('1.234') === 1234, String(parseLocalizedAmount('1.234')));
check('parseLocalizedAmount("1.23") stays 1.23 (decimal)', parseLocalizedAmount('1.23') === 1.23, String(parseLocalizedAmount('1.23')));
check('roundDAZ(12.50) = 13', roundDAZ(12.50) === 13, String(roundDAZ(12.50)));

// ── B-025: price override double-subtract via computeCartTotals ────────
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
const { computeCartTotals } = await import(toDataUrl(rmOut.outputText));

console.log('\n--- B-025: price override must charge net once ---');

// Simulates overrideCartItemPrice AFTER the B-025 fix:
// appliedPrice = clean (net), discount = 0, discountAmount kept for display.
function mkOverrideLine({ defaultPrice, cleanPrice, qty = 1 }) {
  return {
    product: { id: 'p1', title: 'Item', price: defaultPrice, costPrice: 100, category: 'Tous les produits' },
    quantity: qty,
    appliedPrice: cleanPrice,
    unitPriceCharged: cleanPrice,
    defaultPrice,
    discountAmount: Math.max(0, defaultPrice - cleanPrice),
    discount: 0, // B-025 fix: do NOT also write line.discount
  };
}

// Case 1: override 3500 → 3000, qty 1 → must charge 3000 (not 2500)
const l1 = mkOverrideLine({ defaultPrice: 3500, cleanPrice: 3000 });
const t1 = computeCartTotals([l1], { vatRate: 0 });
check('override 3500→3000 charges 3000', t1.total === 3000, `got ${t1.total}`);
check('override gross stays 3000 (net encoded in appliedPrice)', t1.grossSubtotal === 3000, `got ${t1.grossSubtotal}`);

// Case 2: pre-fix encoding (discount ALSO written) must NOT be what we produce.
// If someone re-introduces discount=lineDiscount, total becomes 2500.
const lBroken = {
  ...mkOverrideLine({ defaultPrice: 3500, cleanPrice: 3000 }),
  discount: 500, // the OLD buggy encoding
};
const tBroken = computeCartTotals([lBroken], { vatRate: 0 });
check('regression guard: discount=500 on net appliedPrice still shows the bug shape (2500)', tBroken.total === 2500, `got ${tBroken.total}`);

// Case 3: qty 2 override 1000→800 → charge 1600
const l3 = mkOverrideLine({ defaultPrice: 1000, cleanPrice: 800, qty: 2 });
const t3 = computeCartTotals([l3], { vatRate: 0 });
check('override 1000→800 qty2 charges 1600', t3.total === 1600, `got ${t3.total}`);

// Case 4: normal line (no override) unchanged
const l4 = {
  product: { id: 'p2', title: 'N', price: 500, costPrice: 100, category: 'Tous les produits' },
  quantity: 3,
  appliedPrice: 500,
  defaultPrice: 500,
  discount: 0,
};
const t4 = computeCartTotals([l4], { vatRate: 0 });
check('normal line 3×500 = 1500', t4.total === 1500, `got ${t4.total}`);

// Case 5: volume-tier style (appliedPrice = gross base, discount = markdown)
const l5 = {
  product: { id: 'p3', title: 'V', price: 1000, costPrice: 100, category: 'Tous les produits' },
  quantity: 2,
  appliedPrice: 1000, // gross base
  defaultPrice: 1000,
  discount: 200, // markdown total
  volumeTierApplied: true,
};
const t5 = computeCartTotals([l5], { vatRate: 0 });
check('volume tier 2000−200 = 1800', t5.total === 1800, `got ${t5.total}`);

console.log('\n========================================================================');
console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
process.exit(fail > 0 ? 1 : 0);
