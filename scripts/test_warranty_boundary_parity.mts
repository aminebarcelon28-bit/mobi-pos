/**
 * Warranty lifecycle — Phase 1 boundary parity.
 *
 * Guards the BUG-WAR class where the WRITER and the READER normalize a device
 * identifier differently. The previous production-gauntlet forensics block
 * normalized with a local `.toUpperCase()`, i.e. it tested an idealized form
 * the product never produced, so the suite stayed green while every
 * hyphenated GSMA-scanned IMEI resolved as "non enregistré".
 *
 * This harness imports the PRODUCTION normalizers and asserts that the
 * ingestion boundary and the lookup boundary agree for every payload a real
 * barcode scanner can emit.
 */
import { normalizeDeviceKey, canonicalDeviceId, sanitizeDeviceIdentifier, lookupDeviceWarrantyByImei, resolveWarrantyDossier } from '../src/utils/warrantyResolver.ts';
import { luhnCheckImei, sanitizeImeiInput, imeiCheckState } from '../src/utils/savValidation.ts';
import * as codec from '../src/utils/deviceIdCodec.ts';

let failures = 0;
const ok = (cond, label, detail) => {
  if (!cond) { failures++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
  else console.log('  ok    ' + label);
};
const H = 1000 * 60 * 60 * 24;
const IMEI = '352099001761481'; // Luhn-valid
const SALE_ISO = '2026-10-01T09:00:00.000Z';

console.log('\n[1] Ingestion boundary (canonicalDeviceId) is idempotent + lossless for IMEI');
for (const form of [IMEI, '35-209900-176148-1', '35 209900 176148 1', '35.209900.176148.1', '35/209900/176148/1', IMEI.toLowerCase()]) {
  const c = canonicalDeviceId(form);
  ok(c === IMEI, 'canonical(' + JSON.stringify(form) + ') === digits', c);
  ok(canonicalDeviceId(c) === c, 'canonical is idempotent for ' + JSON.stringify(form));
}

console.log('\n[2] Alphanumeric serials survive ingestion (dead-device / tablet flow)');
for (const sn of ['ABC-123-XYZ', 'SN/2024/8891', 'RF9912-A', 'TAB7741']) {
  ok(canonicalDeviceId(sn).length > 0 && !/^\d{15}$/.test(sn), 'serial preserved: ' + sn, canonicalDeviceId(sn));
  ok(sanitizeDeviceIdentifier(sn, 'serial').isSearchable === true, 'serial still searchable: ' + sn);
}

console.log('\n[3] Ingested key === queried key for EVERY scanner payload');
const PAYLOADS = [
  IMEI, '35-209900-176148-1', '35 209900 176148 1', '35.209900.176148.1', '35/209900/176148/1',
  '*352099001761481*', IMEI.toLowerCase(),
];
for (const raw of PAYLOADS) {
  ok(normalizeDeviceKey(canonicalDeviceId(raw)) === normalizeDeviceKey(raw),
     'ingest/lookup agree: ' + JSON.stringify(raw),
     { stored: normalizeDeviceKey(canonicalDeviceId(raw)), queried: normalizeDeviceKey(raw) });
}

console.log('\n[4] GS1 Application Identifiers fail CLOSED (must NOT auto-extract)');
// AI (01) is a defined 14-digit GTIN, so auto-picking "the IMEI out of a GS1
// payload" is a guess: resolving the WRONG device's warranty grants free
// repairs on the wrong handset. Rejection is the correct posture.
for (const gs1 of ['(01)352099001761481', '>80135209900176148110', '(01)35-209900-176148-1']) {
  const s = sanitizeDeviceIdentifier(gs1, 'imei');
  ok(s.isSearchable === false, 'rejected: ' + JSON.stringify(gs1), { digitCount: s.digitCount, value: s.value });
  ok(luhnCheckImei(gs1) === false, 'Luhn rejects GS1 payload: ' + JSON.stringify(gs1));
}

console.log('\n[5] END-TO-END: a hyphenated sale resolves, and counts down');
const prod = { id: 'p1', sku: 'TEL-X', title: 'iPhone 13', isSerialized: true, warrantyMonths: 12 };
const txHyphen = {
  id: 'tx-1', receiptNumber: 'F-0001', createdAt: SALE_ISO, status: 'COMPLETED', isRefund: false,
  customer: { name: 'Ali', phone: '0555' },
  items: [{ imeiNumber: '35-209900-176148-1', product: prod, quantity: 1 }],
};
const deps = { transactions: [txHyphen], products: [prod], imeiRecords: [], repairOrders: [] };

for (const query of [IMEI, '35-209900-176148-1', '35 209900 176148 1', '*352099001761481*']) {
  const d = lookupDeviceWarrantyByImei(query, deps);
  ok(d.isSold === true, 'sold resolved for query ' + JSON.stringify(query), { title: d.productTitle });
  ok(d.originalReceiptNumber === 'F-0001', 'receipt found for query ' + JSON.stringify(query), d.originalReceiptNumber);
  ok(d.isWarrantyValid === true, 'warranty valid for query ' + JSON.stringify(query));
  ok(d.daysRemaining > 355 && d.daysRemaining <= 366, 'countdown active for query ' + JSON.stringify(query), d.daysRemaining);
}

console.log('\n[6] All spellings of one device agree on daysRemaining');
const byDigits = lookupDeviceWarrantyByImei(IMEI, deps);
const byHyphen = lookupDeviceWarrantyByImei('35-209900-176148-1', deps);
ok(byDigits.daysRemaining === byHyphen.daysRemaining, 'daysRemaining identical across spellings',
   { digits: byDigits.daysRemaining, hyphen: byHyphen.daysRemaining });
ok(byDigits.warrantyExpiresAt === byHyphen.warrantyExpiresAt, 'expiry identical across spellings');

console.log('\n[7] resolveWarrantyDossier (production entry point) resolves the hyphenated sale');
const res = resolveWarrantyDossier('35-209900-176148-1', 'imei', deps);
ok(res.ok === true, 'dossier ok', res.note);
ok(res.snapshot.dossier.isSold === true, 'dossier isSold');
ok(res.snapshot.dossier.daysRemaining > 0, 'dossier counts down', res.snapshot.dossier.daysRemaining);
// `suggestedTier` is a REPAIR-warranty choice (owner decision, Q1). A live
// STORE warranty must NOT auto-mint a repair tier: the old rule derived it from
// the store term, so a 12-month shop warranty silently stamped a repair ticket
// with `repair_180d`. Repair coverage is now billed as warranty work, and the
// tier itself is an operator choice.
ok(res.snapshot.suggestedTier === 'none',
   'a live STORE warranty suggests NO repair tier (repair coverage is not auto-minted)',
   res.snapshot.suggestedTier);
ok(res.snapshot.dossier.storeWarranty?.state !== undefined,
   'the dossier still exposes the STORE warranty that makes the device covered',
   res.snapshot.dossier.storeWarranty?.state);

console.log('\n[8] Cross-spelling dedupe: one device, one dossier (no double-listing)');
const depsBoth = {
  transactions: [txHyphen],
  products: [prod],
  imeiRecords: [{ imei: IMEI, productId: 'p1', receivedAt: SALE_ISO, soldAt: SALE_ISO, saleTransactionId: 'tx-1' }],
  repairOrders: [],
};
const d1 = lookupDeviceWarrantyByImei(IMEI, depsBoth);
const d2 = lookupDeviceWarrantyByImei('35-209900-176148-1', depsBoth);
ok(d1.soldAt === d2.soldAt && d1.daysRemaining === d2.daysRemaining, 'registry + transaction spellings agree');

console.log('\n[9] Unknown device still fails closed');
const miss = lookupDeviceWarrantyByImei('999999999999999', deps);
ok(miss.isWarrantyValid === false && miss.daysRemaining === 0, 'unknown device denied');
ok(miss.originalReceiptNumber === 'NON ENREGISTRÉ', 'unknown device labelled NON ENREGISTRÉ');

console.log('\n[10] Refund/void mirror reset clears BOTH spellings');
const releasedKeys = new Set(['35-209900-176148-1'].map(normalizeDeviceKey));
const mirror = [
  { imei: '35-209900-176148-1', productId: 'p1', receivedAt: SALE_ISO, soldAt: SALE_ISO, saleTransactionId: 'tx-1' },
  { imei: IMEI, productId: 'p1', receivedAt: SALE_ISO, soldAt: SALE_ISO, saleTransactionId: 'tx-1' },
];
const after = mirror.map((r) => releasedKeys.has(normalizeDeviceKey(r.imei)) ? { ...r, soldAt: undefined, saleTransactionId: undefined } : r);
ok(after.every((r) => r.soldAt === undefined), 'both spellings released by one void', after.map((r) => r.soldAt));

// ── Step B1: third-sanitizer convergence ────────────────────────────────────
console.log('\n[11] savValidation.sanitizeImeiInput delegates to the shared codec');
// It previously compacted only whitespace/zero-width/bidi/hyphen — NOT dots,
// slashes or `*` fences — making a third divergent spelling.
const DIVERGENT = ['35.209900.176148.1', '35/209900/176148/1', '*352099001761481*', 'RF 99 12', 'ABC 123 XYZ'];
for (const raw of DIVERGENT) {
  ok(sanitizeImeiInput(raw) === codec.canonicalDeviceId(raw),
     'trade-in sanitizer === codec: ' + JSON.stringify(raw),
     { tradeIn: sanitizeImeiInput(raw), codec: codec.canonicalDeviceId(raw) });
}
ok(codec.canonicalDeviceId === canonicalDeviceId, 'resolver re-export IS the codec function (single instance)');
ok(codec.normalizeDeviceKey === normalizeDeviceKey, 'resolver re-export IS the codec normalizer');

console.log('\n[12] Trade-in and checkout agree on every payload (was: divergent)');
for (const raw of [...PAYLOADS, ...DIVERGENT]) {
  const viaTradeIn = sanitizeImeiInput(raw);
  const viaCart = canonicalDeviceId(raw);
  const viaLookup = sanitizeDeviceIdentifier(raw, 'imei').value;
  ok(normalizeDeviceKey(viaTradeIn) === normalizeDeviceKey(viaCart) && normalizeDeviceKey(viaCart) === normalizeDeviceKey(viaLookup),
     'all three paths agree: ' + JSON.stringify(raw),
     { tradeIn: viaTradeIn, cart: viaCart, lookup: viaLookup });
}

console.log('\n[13] Convergence did not weaken Luhn warn-only semantics');
ok(imeiCheckState('35-209900-176148-1') === 'valid', 'hyphenated Luhn-valid → valid', imeiCheckState('35-209900-176148-1'));
ok(imeiCheckState('ABC-123-XYZ') === 'neutral', 'alphanumeric serial still neutral (never blocks save)');
ok(imeiCheckState('35.209900.176148.1') === 'valid', 'dotted IMEI now valid (was: neutral/ignored)', imeiCheckState('35.209900.176148.1'));
ok(luhnCheckImei('352099001761482') === false, 'wrong checksum still rejected');

console.log('\n[14] codec is a leaf module (no imports) — prevents cycle regressions');
const codecSrc = await (await import('node:fs/promises')).readFile(
  new URL('../src/utils/deviceIdCodec.ts', import.meta.url), 'utf8');
ok(!/^\s*import\s/m.test(codecSrc), 'deviceIdCodec.ts contains no import statements');
ok(!/from\s+['"]\.\.?\//.test(codecSrc), 'deviceIdCodec.ts imports nothing at all');

console.log('\n' + (failures === 0
  ? 'ALL WARRANTY BOUNDARY PARITY CHECKS PASSED'
  : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);