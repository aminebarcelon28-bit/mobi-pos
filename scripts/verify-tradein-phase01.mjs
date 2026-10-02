/**
 * Phase 0+1 verification: trade-in settlement + cart tradeInCredit + SKU + Luhn.
 * Run: node scripts/verify-tradein-phase01.mjs
 */
const ROOT = process.cwd();
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✅ [PASS] ${name}`); }
  else { fail += 1; console.log(`  ❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('=== Phase 0: computeTradeInSettlement ===');
const ts = await import('typescript');
const fs = await import('node:fs');
const toDataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const transpileFile = (p) => {
  const source = fs.readFileSync(p, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: p,
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

// Scenario A: customer owes
const a = rm.computeTradeInSettlement(120000, 50000);
check('A: net +70000 CUSTOMER_PAYS', a.netBalance === 70000 && a.direction === 'CUSTOMER_PAYS' && a.customerOwes === 70000 && a.shopOwes === 0, JSON.stringify(a));
// Scenario B: soulte
const b = rm.computeTradeInSettlement(40000, 55000);
check('B: net -15000 SOULTE_SHOP_PAYS', b.netBalance === -15000 && b.direction === 'SOULTE_SHOP_PAYS' && b.shopOwes === 15000 && b.customerOwes === 0, JSON.stringify(b));
// Even
const e = rm.computeTradeInSettlement(50000, 50000);
check('Even: net 0 EVEN', e.netBalance === 0 && e.direction === 'EVEN', JSON.stringify(e));
// Rounding / clamp of NaN
const z = rm.computeTradeInSettlement(NaN, undefined);
check('NaN-safe: zeros EVEN', z.netBalance === 0 && z.direction === 'EVEN', JSON.stringify(z));

console.log('=== Phase 0: computeCartTotals tradeInCredit ===');
const prod = (price) => ({ price });
const line = (price, qty = 1) => ({ product: prod(price), appliedPrice: price, quantity: qty });
const t1 = rm.computeCartTotals([line(120000)], { vatRate: 0, tradeInCredit: 50000 });
check('cart 120k - tradeIn 50k = net 70k', t1.net === 70000 && t1.total === 70000 && t1.tradeInCreditApplied === 50000, JSON.stringify({ net: t1.net, total: t1.total, c: t1.tradeInCreditApplied }));
// Legacy parity: no tradeInCredit behaves exactly as before
const t0 = rm.computeCartTotals([line(120000)], { vatRate: 0 });
check('no tradeInCredit: net 120k, applied 0', t0.net === 120000 && t0.tradeInCreditApplied === 0, JSON.stringify(t0));
// Clamp: tradeIn > subtotal never over-covers
const t2 = rm.computeCartTotals([line(120000)], { vatRate: 0, tradeInCredit: 200000 });
check('clamp: 200k credit on 120k cart -> applied 120k, net 0', t2.tradeInCreditApplied === 120000 && t2.net === 0, JSON.stringify(t2));
// Combined with avoir + voucher
const t3 = rm.computeCartTotals([line(120000)], { vatRate: 0, storeCreditApplied: 10000, voucherCreditApplied: 5000, tradeInCredit: 50000 });
check('stacked credits: 120k-10k-5k-50k = 55k', t3.net === 55000, JSON.stringify(t3));
// VAT base invariance: tradeIn is payment, not discount
const v0 = rm.computeCartTotals([line(100000)], { vatRate: 19 });
const v1 = rm.computeCartTotals([line(100000)], { vatRate: 19, tradeInCredit: 40000 });
check('VAT base unchanged by tradeIn (ht/tva equal)', v0.ht === v1.ht && v0.tva === v1.tva, JSON.stringify({ v0, v1 }));
check('VAT ttc reduced by credit', v1.ttc === Math.max(0, v0.ht + v0.tva - 40000), JSON.stringify(v1));

console.log('=== Phase 1: generateUniqueSku OCC ===');
const bcSrc = fs.readFileSync(`${ROOT}/src/utils/barcodeGenerator.ts`, 'utf8');
const bcOut = ts.transpileModule(bcSrc, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  fileName: 'barcodeGenerator.ts',
});
const bc = await import(toDataUrl(bcOut.outputText));
const sku1 = bc.generateUniqueSku([], "Téléphones d'Occasion (Reprise)", 'Apple');
check("OCC prefix for reprise/Apple", sku1.startsWith('OCC-APP-'), sku1);
const sku2 = bc.generateUniqueSku([{ sku: sku1 }], "Téléphones d'Occasion (Reprise)", 'Apple');
check('collision avoided (unique vs existing)', sku2 !== sku1 && sku2.startsWith('OCC-APP-'), `${sku1} vs ${sku2}`);
const sku3 = bc.generateUniqueSku([], "Téléphones d'Occasion (Reprise)", 'Samsung');
check('Samsung maps OCC-SAM', sku3.startsWith('OCC-SAM-'), sku3);

console.log('=== Phase 1: luhnCheckImei ===');
const savSrc = fs.readFileSync(`${ROOT}/src/utils/savValidation.ts`, 'utf8');
const savOut = ts.transpileModule(savSrc, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  fileName: 'savValidation.ts',
});
const sav = await import(toDataUrl(savOut.outputText));
// Known-good IMEI (passes Luhn): 490154203237518 is the canonical example
check('valid IMEI passes', sav.luhnCheckImei('490154203237518') === true);
check('bad checksum fails', sav.luhnCheckImei('490154203237519') === false);
check('short string fails', sav.luhnCheckImei('1234567890') === false);
check('neutral for S/N', sav.imeiCheckState('SN-ABC-123') === 'neutral');
check('valid state', sav.imeiCheckState('490154203237518') === 'valid');
check('invalid state', sav.imeiCheckState('490154203237519') === 'invalid');

console.log('=== Phase 1: wiring (static) ===');
const sliceSrc = fs.readFileSync(`${ROOT}/src/store/slices/createUISlice.ts`, 'utf8');
check('slice mints TRADE- batch', sliceSrc.includes('batch-trade-${newTradeIn.id}') && sliceSrc.includes("purchaseOrderId: `TRADE-${newTradeIn.id}`"));
check('slice writes RECEIVE TRADE_IN ledger', sliceSrc.includes("refType: 'TRADE_IN'") && sliceSrc.includes('appendInventoryDeltas'));
check('slice uses OCC generator', sliceSrc.includes("generateUniqueSku(products, \"Téléphones d'Occasion (Reprise)\""));
check('slice Luhn-hardened validateIMEI', sliceSrc.includes('luhnCheckImei(imei)'));
check('slice surfaces TRADE_BATCH_FAILED', sliceSrc.includes('TRADE_BATCH_FAILED'));
const modalSrc = fs.readFileSync(`${ROOT}/src/components/modals/TradeInBuybackModal.tsx`, 'utf8');
check('modal imports Luhn', modalSrc.includes("from '../../utils/savValidation'"));
check('modal CNI warn badge (no required)', modalSrc.includes('Pièce manquante — à compléter') && !/nationalIdNumber[^}]*required/.test(modalSrc));
check('modal IMEI hard-block + neutral hint', modalSrc.includes('IMEI valide (Luhn OK)') && modalSrc.includes('N° série accepté'));
check('modal handles TRADE_BATCH_FAILED', modalSrc.includes('TRADE_BATCH_FAILED'));
const posSrc = fs.readFileSync(`${ROOT}/src/types/pos.ts`, 'utf8');
check("pos has 'Reprise' tender", posSrc.includes("'Reprise'"));
check('pos has StagedTradeIn/TradeInSettlement', posSrc.includes('StagedTradeIn') && posSrc.includes('TradeInSettlement'));
check('pos SaleTransaction carries tradeInId', posSrc.includes('tradeInId'));

console.log(`\nSUMMARY: ${pass} PASSED, ${fail} FAILED`);
process.exit(fail > 0 ? 1 : 0);
