/**
 * Step A — point-in-time warranty anchoring.
 *
 * Two properties are asserted:
 *   (1) Temporal immutability: a later catalog `warrantyMonths` edit must NOT
 *       change the expiry of a sale that already happened.
 *   (2) No retroactive grant: anchoring a historical sale FREEZES what today's
 *       resolver already computes. A zero-warranty product must still read
 *       "SANS GARANTIE" after anchoring — Step A must not pre-empt the Step C
 *       policy sign-off.
 */
import {
  addMonthsClamped,
  warrantyAnchorFor,
  computeDeviceWarranty,
  lookupDeviceWarrantyByImei,
  resolveWarrantyWithFallback,
  normalizeDeviceKey,
} from '../src/utils/warrantyResolver.ts';

let failures = 0;
const ok = (c, label, detail) => {
  if (!c) { failures++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
  else console.log('  ok    ' + label);
};
const SALE = '2026-10-01T09:00:00.000Z';
const NOW = '2026-10-04T00:00:00.000Z';
const tx = (warrantyMonths, imei) => ({
  id: 'tx-1', receiptNumber: 'F-1', createdAt: SALE, status: 'COMPLETED', isRefund: false,
  customer: { name: 'Ali', phone: '0' },
  items: [{ imeiNumber: imei, product: { id: 'p1', title: 'X', warrantyMonths }, quantity: 1 }],
});

console.log('\n[1] addMonthsClamped — month-end never overflows');
ok(addMonthsClamped('2026-01-31T10:00:00.000Z', 1) === '2026-02-28T10:00:00.000Z', 'Jan 31 + 1m → Feb 28',
   addMonthsClamped('2026-01-31T10:00:00.000Z', 1));
ok(addMonthsClamped('2026-08-31T10:00:00.000Z', 12) === '2027-08-31T10:00:00.000Z', 'Aug 31 + 12m → Aug 31',
   addMonthsClamped('2026-08-31T10:00:00.000Z', 12));
ok(addMonthsClamped('2026-03-31T10:00:00.000Z', 1) === '2026-04-30T10:00:00.000Z', 'Mar 31 + 1m → Apr 30',
   addMonthsClamped('2026-03-31T10:00:00.000Z', 1));
ok(addMonthsClamped('2024-02-29T10:00:00.000Z', 12) === '2025-02-28T10:00:00.000Z', 'leap Feb 29 + 12m → Feb 28',
   addMonthsClamped('2024-02-29T10:00:00.000Z', 12));
ok(addMonthsClamped(SALE, 0) === SALE, '0 months → same instant');

console.log('\n[2] warrantyAnchorFor');
ok(warrantyAnchorFor({ soldAt: SALE, warrantyMonths: 12 }) === '2027-10-01T09:00:00.000Z', '12m anchor',
   warrantyAnchorFor({ soldAt: SALE, warrantyMonths: 12 }));
ok(warrantyAnchorFor({ soldAt: SALE, warrantyMonths: 0 }) === SALE, '0m anchor == sold_at (expired, not undecided)',
   warrantyAnchorFor({ soldAt: SALE, warrantyMonths: 0 }));

console.log('\n[3] TEMPORAL IMMUTABILITY — catalog edit cannot re-date a past sale');
// Sale happened at 12 months. Catalog is later reduced to 3.
const anchoredRec = { imei: '352099001761481', productId: 'p1', receivedAt: SALE, soldAt: SALE,
                      saleTransactionId: 'tx-1', warrantyMonths: 12, warrantyExpiresAt: '2027-10-01T09:00:00.000Z' };
const nowThreeMonths = { id: 'p1', sku: 'S', title: 'X', isSerialized: true, warrantyMonths: 3 };
const d = lookupDeviceWarrantyByImei('352099001761481', {
  transactions: [tx(12, '352099001761481')], products: [nowThreeMonths],
  imeiRecords: [anchoredRec], repairOrders: [],
});
ok(d.warrantyExpiresAt === '2027-10-01T09:00:00.000Z', 'expiry still the SOLD-TIME value despite catalog 12→3', d.warrantyExpiresAt);
ok(d.daysRemaining > 355, 'countdown reflects the 12 months actually sold', d.daysRemaining);
ok(d.isWarrantyValid === true, 'coverage NOT retroactively shortened to 3 months');

console.log('\n[4] Catalog INCREASE also cannot retroactively grant coverage');
const anchored3 = { ...anchoredRec, warrantyMonths: 3, warrantyExpiresAt: '2026-11-01T09:00:00.000Z' };
const now24 = { id: 'p1', sku: 'S', title: 'X', isSerialized: true, warrantyMonths: 24 };
const d2 = lookupDeviceWarrantyByImei('352099001761481', {
  transactions: [tx(3, '352099001761481')], products: [now24],
  imeiRecords: [anchored3], repairOrders: [],
});
ok(d2.warrantyExpiresAt === '2026-11-01T09:00:00.000Z', 'expiry stays at sold-time 3 months', d2.warrantyExpiresAt);

console.log('\n[5] NO RETROACTIVE GRANT — Step A preserves today\'s zero-warranty reading');
// BUG-WAR-03 / Step B2: a deliberate zero is expressed by the sentinel, NOT by a
// bare `warrantyMonths: 0` — that value was the ProductEditorModal form default,
// so it carries no intent. The property under test is unchanged: a device sold
// as-is must not silently gain coverage from anchoring or from the store default.
const zeroProd = { id: 'p1', sku: 'S', title: 'X', isSerialized: true, warrantyMonths: 0, warrantyExplicitlyDisabled: true };
// Anchored the way Step A would anchor it: sold_at + 0 months.
const zeroAnchor = warrantyAnchorFor({ soldAt: SALE, warrantyMonths: resolveWarrantyWithFallback(zeroProd, null) });
const d3 = lookupDeviceWarrantyByImei('352099001761481', {
  transactions: [tx(0, '352099001761481')], products: [zeroProd],
  imeiRecords: [{ imei: '352099001761481', productId: 'p1', receivedAt: SALE, soldAt: SALE,
                  saleTransactionId: 'tx-1', warrantyMonths: 0, warrantyExpiresAt: zeroAnchor }],
  repairOrders: [],
});
ok(zeroAnchor === SALE, 'zero-warranty anchor == sold_at', zeroAnchor);
ok(d3.isWarrantyValid === false, 'still SANS GARANTIE after anchoring (no silent grant)', d3.isWarrantyValid);
ok(d3.warrantyMonths === 0, 'warrantyMonths stays 0, not defaulted to 12', d3.warrantyMonths);
ok(d3.daysRemaining === 0, 'daysRemaining 0');

console.log('\n[6] Unanchored legacy rows still resolve (backward compatible)');
const d4 = lookupDeviceWarrantyByImei('352099001761481', {
  transactions: [tx(12, '352099001761481')], products: [{ id: 'p1', sku: 'S', title: 'X', warrantyMonths: 12 }],
  imeiRecords: [{ imei: '352099001761481', productId: 'p1', receivedAt: SALE, soldAt: SALE, saleTransactionId: 'tx-1' }],
  repairOrders: [],
});
ok(d4.isWarrantyValid === true && d4.daysRemaining > 355, 'legacy unanchored row still counts down', d4.daysRemaining);
ok(d4.warrantyExpiresAt === '2027-10-01T09:00:00.000Z', 'legacy expiry computed as before', d4.warrantyExpiresAt);

console.log('\n[7] Registry branch honours the anchor (and clamps month ends)');
const legacy = lookupDeviceWarrantyByImei('352099001761481', {
  transactions: [], products: [{ id: 'p1', sku: 'S', title: 'X', warrantyMonths: 1 }],
  imeiRecords: [{ imei: '352099001761481', productId: 'p1', receivedAt: '2026-01-31T10:00:00.000Z',
                  soldAt: '2026-01-31T10:00:00.000Z' }], repairOrders: [],
});
ok(legacy.warrantyExpiresAt === '2026-02-28T10:00:00.000Z', 'registry branch clamps Jan 31 + 1m', legacy.warrantyExpiresAt);

console.log('\n[8] computeDeviceWarranty honours an explicit anchor over months');
const withAnchor = computeDeviceWarranty({ warrantyMonths: 12, startIso: SALE, sold: true, nowIso: NOW,
                                           anchoredExpiresAt: '2026-10-02T09:00:00.000Z' });
ok(withAnchor.warrantyExpiresAt === '2026-10-02T09:00:00.000Z', 'anchor wins over +12m', withAnchor.warrantyExpiresAt);
ok(withAnchor.daysRemaining === 0, 'already-expired anchor → 0 days', withAnchor.daysRemaining);
ok(withAnchor.isWarrantyValid === false, 'expired anchor → invalid');
const noAnchor = computeDeviceWarranty({ warrantyMonths: 12, startIso: SALE, sold: true, nowIso: NOW });
ok(noAnchor.warrantyExpiresAt === '2027-10-01T09:00:00.000Z', 'no anchor → computed', noAnchor.warrantyExpiresAt);
const garbageAnchor = computeDeviceWarranty({ warrantyMonths: 12, startIso: SALE, sold: true, nowIso: NOW,
                                              anchoredExpiresAt: 'not-a-date' });
ok(garbageAnchor.warrantyExpiresAt === '2027-10-01T09:00:00.000Z', 'invalid anchor ignored, falls back', garbageAnchor.warrantyExpiresAt);

console.log('\n[9] Bad anchors never produce a live warranty');
const nanAnchor = computeDeviceWarranty({ warrantyMonths: 12, startIso: 'garbage', sold: true, nowIso: NOW });
ok(nanAnchor.daysRemaining === 0 && nanAnchor.isWarrantyValid === false, 'garbage startIso fails closed');
ok(normalizeDeviceKey('35-209900-176148-1') === '352099001761481', 'boundary key still intact');

console.log('\n' + (failures === 0 ? 'ALL STEP-A ANCHORING CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
