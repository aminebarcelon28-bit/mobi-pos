/**
 * Receipt subtotal / discount reconciliation regression test.
 *
 * Reproduces the reported bug:
 *   Adaptateur Secteur 20W USB-C Original, catalog 4 200 DA, qty 1,
 *   remise produit -1 000 DA, line net 3 200 DA.
 * The ticket printed "SOUS-TOTAL BRUT 5 200" (4200 + 1000) instead of 4 200,
 * so the ticket was internally inconsistent (5200 - 1000 != 3200).
 *
 * Contract: for every receipt, daily summary and export view,
 *   SOUS-TOTAL BRUT   = sum(catalog unit price x qty)          -> 4 200
 *   REMISE ACCORDÉE   = sum(discounts)                        -> 1 000
 *   TOTAL NET A PAYER = gross - discount - store credit        -> 3 200
 */
import { pathToFileURL } from 'node:url';
import { pathToFileURL as toUrl } from 'node:url';

const ROOT = process.cwd();

async function loadReceiptMath() {
  // receiptMath.ts imports ./pricingEngine + ./taxEngine (value imports), and
  // a data: URL module cannot resolve relative specifiers — so transpile each
  // dependency to its own data: URL first, then rewrite the specifiers to
  // point at them. Type-only imports (../types/pos) are elided by the
  // transpiler and need no handling.
  const ts = await import('typescript');
  const fs = await import('node:fs');
  const transpileFile = (absPath) => {
    const source = fs.readFileSync(absPath, 'utf8');
    return ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      fileName: absPath,
    }).outputText;
  };
  const toDataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  const taxUrl = toDataUrl(transpileFile(`${ROOT}/src/utils/taxEngine.ts`));
  const pricingUrl = toDataUrl(transpileFile(`${ROOT}/src/utils/pricingEngine.ts`));
  let src = fs.readFileSync(`${ROOT}/src/utils/receiptMath.ts`, 'utf8');
  src = src.replace(/from\s+(['"])\.\/pricingEngine\1/g, `from '${pricingUrl}'`);
  src = src.replace(/from\s+(['"])\.\/taxEngine\1/g, `from '${taxUrl}'`);
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'receiptMath.ts',
  });
  return import(toDataUrl(out.outputText));
}

// Minimal stand-ins for the pos types the helpers consume.
function mkTx({ subtotal, discountTotal, total, isRefund = false, status = 'COMPLETED' }) {
  return { subtotal, discountTotal, total, isRefund, status };
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

const results = [];
const { grossFromTransaction, discountsFromTransaction, netFromTransaction, isValidSale } =
  await loadReceiptMath();

console.log('========================================================================');
console.log('🧾 RECEIPT SUBTOTAL & DISCOUNT RECONCILIATION TEST');
console.log('========================================================================');

// ── The exact reported case ─────────────────────────────────────────────
const CATALOG = 4200;
const DISCOUNT = 1000;
const NET = 3200;
const tx = mkTx({ subtotal: CATALOG, discountTotal: DISCOUNT, total: NET });

console.log('\n--- TEST 1: Reported reproduction case (4 200 DA item, -1 000 DA remise) ---');
const grossShown = grossFromTransaction(tx);
check(
  'SOUS-TOTAL BRUT equals the catalog total (4 200, not 5 200)',
  grossShown === 4200,
  `got ${grossShown}`
);
check(
  'REMISE ACCORDÉE equals the discount granted (1 000)',
  discountsFromTransaction(tx) === 1000,
  `got ${discountsFromTransaction(tx)}`
);
check(
  'TOTAL NET A PAYER equals gross - discount (3 200)',
  netFromTransaction(tx) === 3200,
  `got ${netFromTransaction(tx)}`
);
check(
  'Ticket reconciles: gross - discount === net',
  grossFromTransaction(tx) - discountsFromTransaction(tx) === netFromTransaction(tx),
  `${grossFromTransaction(tx)} - ${discountsFromTransaction(tx)} != ${netFromTransaction(tx)}`
);
check(
  'Old buggy formula (subtotal + discountTotal) is NOT what we print',
  tx.subtotal + tx.discountTotal !== grossFromTransaction(tx),
  'regression guard against re-introducing the double-count'
);

// ── Multi-line + store credit ───────────────────────────────────────────
console.log('\n--- TEST 2: Multi-line sale with store credit applied ---');
// 100 000 gross, 15 000 remise, 10 000 avoir redeemed -> 75 000 collected
const CREDIT = 10000;
const tx2 = mkTx({ subtotal: 100000, discountTotal: 15000, total: 75000 });
check('gross is the pre-discount catalog value', grossFromTransaction(tx2) === 100000);
check('discounts total is 15 000', discountsFromTransaction(tx2) === 15000);
check('net collected is 75 000 (after discount + avoir)', netFromTransaction(tx2) === 75000);
check(
  'waterfall reconciles with credit: gross - discount - credit === net',
  grossFromTransaction(tx2) - discountsFromTransaction(tx2) - CREDIT === netFromTransaction(tx2)
);

// ── Legacy rows missing subtotal ────────────────────────────────────────
console.log('\n--- TEST 3: Legacy rows where subtotal was never persisted ---');
const legacy = mkTx({ subtotal: 0, discountTotal: 0, total: 9000 });
check('gross falls back to total when subtotal is absent', grossFromTransaction(legacy) === 9000);
check('net is still correct', netFromTransaction(legacy) === 9000);

// ── Voided / refund rows are excluded from valid sales ─────────────────
console.log('\n--- TEST 4: Valid-sale classification for daily metrics ---');
check('a completed sale is valid', isValidSale(mkTx({ subtotal: 1, discountTotal: 0, total: 1 })) === true);
check('a voided sale is excluded', isValidSale(mkTx({ subtotal: 1, discountTotal: 0, total: 1, status: 'VOIDED' })) === false);
check('a refund is excluded', isValidSale(mkTx({ subtotal: 1, discountTotal: 0, total: 1, isRefund: true })) === false);

// ── Daily summary aggregation (the Reports waterfall) ───────────────────
console.log('\n--- TEST 5: Daily revenue waterfall matches the ticket breakdown ---');
const day = [
  // credit-free rows so the two-term waterfall closes exactly
  mkTx({ subtotal: 4200, discountTotal: 1000, total: 3200 }),
  mkTx({ subtotal: 100000, discountTotal: 15000, total: 85000 }),
  mkTx({ subtotal: 5000, discountTotal: 0, total: 5000 }),
  mkTx({ subtotal: 3000, discountTotal: 0, total: 3000, status: 'VOIDED' }),
  mkTx({ subtotal: 2000, discountTotal: 0, total: 2000, isRefund: true }),
];
const valid = day.filter((t) => isValidSale(t));
const grossRevenue = valid.reduce((a, t) => a + grossFromTransaction(t), 0);
const discountsGiven = valid.reduce((a, t) => a + discountsFromTransaction(t), 0);
const netRevenue = valid.reduce((a, t) => a + netFromTransaction(t), 0);
check('gross revenue = 109 200 (void + refund excluded)', grossRevenue === 109200, `got ${grossRevenue}`);
check('discounts granted = 16 000', discountsGiven === 16000, `got ${discountsGiven}`);
check('net revenue = 93 200', netRevenue === 93200, `got ${netRevenue}`);
check(
  'waterfall reconciles: gross - discounts === net',
  grossRevenue - discountsGiven === netRevenue,
  `${grossRevenue} - ${discountsGiven} != ${netRevenue}`
);

console.log('\n========================================================================');
console.log(`🧾 RECEIPT MATH TEST: ${pass} PASSED, ${fail} FAILED`);
console.log('========================================================================');
process.exit(fail === 0 ? 0 : 1);
