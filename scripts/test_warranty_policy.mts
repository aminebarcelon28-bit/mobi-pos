/**
 * Step B2 + B3 — semantic conflation of 0/unset, and the parallel-engine kill.
 *
 * Two properties:
 *
 *  B2  A bare `warrantyMonths: 0` is UNDECIDED (resolves to the store default);
 *      only `warrantyExplicitlyDisabled` expresses a deliberate zero. The
 *      ProductEditorModal used to seed 0 as its untouched form default, so every
 *      product nobody edited silently resolved to zero coverage.
 *
 *  B3  The receipt renders the Step A snapshot and nothing else. It previously
 *      ran its own heuristic (occasion → 3 months) that disagreed with
 *      `warrantyResolver` (12 months) on 129 of 131 real devices.
 */
import {
  resolveWarrantyWithFallback,
  resolveWarrantyMonths,
  hasExplicitWarranty,
  isWarrantyExplicitlyDisabled,
  isOccasionCategory,
  defaultWarrantyMonthsFor,
  extractWarrantyMonths,
  lookupDeviceWarrantyByImei,
  warrantyAnchorFor,
  DEFAULT_WARRANTY_MONTHS,
  OCCASION_DEFAULT_WARRANTY_MONTHS,
} from '../src/utils/warrantyResolver.ts';
import { buildReceiptViewModel } from '../src/utils/receiptViewModel.ts';

let failures = 0;
const ok = (c, label, detail) => {
  if (!c) { failures++; console.log('  FAIL  ' + label + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
  else console.log('  ok    ' + label);
};
const OCCASION = "Téléphones d'Occasion (Reprise)";
const IMEI = '352099001761481';
const SALE = '2026-10-01T09:00:00.000Z';
const D = DEFAULT_WARRANTY_MONTHS;
const OCC = OCCASION_DEFAULT_WARRANTY_MONTHS;

console.log('\n[1] B2 — undecided is NOT zero');
ok(resolveWarrantyMonths({}) === D, 'no field → store default', resolveWarrantyMonths({}));
ok(resolveWarrantyMonths({ warrantyMonths: null }) === D, 'null → store default', resolveWarrantyMonths({ warrantyMonths: null }));
ok(resolveWarrantyMonths({ warrantyMonths: undefined }) === D, 'undefined → store default', resolveWarrantyMonths({ warrantyMonths: undefined }));
// The BUG-WAR-03 trigger: the editor's old form default.
ok(resolveWarrantyMonths({ warrantyMonths: 0 }) === D,
   'bare 0 (old form default) → store default, NOT zero', resolveWarrantyMonths({ warrantyMonths: 0 }));
ok(hasExplicitWarranty({ warrantyMonths: 0 }) === false, 'bare 0 is not an explicit decision');
ok(isWarrantyExplicitlyDisabled({ warrantyMonths: 0 }) === false, 'bare 0 is not the sentinel');

console.log('\n[2] B2 — deliberate zero is honoured');
const asIs = { warrantyMonths: 0, warrantyExplicitlyDisabled: true };
ok(isWarrantyExplicitlyDisabled(asIs) === true, 'sentinel detected');
ok(hasExplicitWarranty(asIs) === true, 'sentinel counts as explicit');
ok(resolveWarrantyMonths(asIs) === 0, 'sentinel → 0 months', resolveWarrantyMonths(asIs));
ok(extractWarrantyMonths(asIs) === 0, 'extract → 0');
ok(resolveWarrantyWithFallback(asIs, { warrantyMonths: 24 }) === 0,
   'sentinel beats a POSITIVE fallback — no accidental rescue', resolveWarrantyWithFallback(asIs, { warrantyMonths: 24 }));
ok(resolveWarrantyWithFallback({ warrantyMonths: 24 }, asIs) === 0,
   'sentinel on the fallback also wins', resolveWarrantyWithFallback({ warrantyMonths: 24 }, asIs));

console.log('\n[3] B2 — explicit positive terms still win');
ok(resolveWarrantyMonths({ warrantyMonths: 6 }) === 6, '6 months respected');
ok(resolveWarrantyMonths({ warrantyMonths: 3 }) === 3, '3 months respected');
ok(resolveWarrantyWithFallback({ warrantyMonths: 6 }, null) === 6, 'fallback resolver respects 6');
ok(resolveWarrantyWithFallback(null, { warrantyMonths: 3 }) === 3, 'line snapshot respected');

console.log('\n[4] B2 — legacy blob sentinel (SQLite camel/snake)');
ok(resolveWarrantyMonths({ json_payload: '{"warrantyExplicitlyDisabled":true,"warrantyMonths":6}' }) === 0,
   'camelCase sentinel inside json_payload → 0');
ok(resolveWarrantyMonths({ json_payload: '{"warranty_explicitly_disabled":true}' }) === 0,
   'snake_case sentinel inside json_payload → 0');
ok(resolveWarrantyMonths({ warranty_explicitly_disabled: 1 }) === 0, 'numeric sentinel → 0');

console.log('\n[5] B3 — the receipt renders the SNAPSHOT, not a heuristic');
const mkTx = (line) => ({
  id: 'tx-1', receiptNumber: 'F-1', createdAt: SALE, status: 'COMPLETED', isRefund: false,
  customer: { name: 'Ali' }, items: [line], total: 1000, subtotal: 1000,
});
const settings = { storeName: 'M', footerMessage: '' };
const occasionProduct = { id: 'p1', title: 'Occasion X', category: OCCASION, price: 1000 };

// Snapshot says 12 → paper must say 12, even though the category heuristic
// would have said 3. This is the exact divergence the audit measured.
const withSnapshot = buildReceiptViewModel(
  mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI, warrantyMonthsAtSale: 12 }),
  settings
);
ok(withSnapshot.items[0].warrantyMonths === 12,
   'snapshot 12 wins over the occasion→3 heuristic', withSnapshot.items[0].warrantyMonths);

// Snapshot says 3 → paper must say 3 (Option A policy, once ratified).
const snapshot3 = buildReceiptViewModel(
  mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI, warrantyMonthsAtSale: 3 }),
  settings
);
ok(snapshot3.items[0].warrantyMonths === 3, 'snapshot 3 prints 3 (no heuristic override)', snapshot3.items[0].warrantyMonths);

// Deliberate as-is with a snapshot of 0 → prints no warranty line.
const snapshot0 = buildReceiptViewModel(
  mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI, warrantyMonthsAtSale: 0 }),
  settings
);
ok(snapshot0.items[0].warrantyMonths === 0, 'snapshot 0 prints no warranty');

console.log('\n[6] B3 — paper and terminal AGREE for every snapshot value');
// Build the product exactly as checkout would: a deliberate zero carries the
// sentinel, a positive term carries the number, and an undecided product
// carries neither. The snapshot is then minted by the same resolver checkout
// uses, so this exercises the real pipeline rather than a hand-built line.
for (const snap of [0, 1, 3, 6, 12, 24]) {
  const soldProduct = snap === 0
    ? { ...occasionProduct, warrantyMonths: 0, warrantyExplicitlyDisabled: true }
    : { ...occasionProduct, warrantyMonths: snap, warrantyExplicitlyDisabled: false };
  const minted = resolveWarrantyWithFallback(null, soldProduct);
  ok(minted === snap, `checkout mints snapshot ${snap} (got ${minted})`);

  const paper = buildReceiptViewModel(
    mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI, warrantyMonthsAtSale: minted }),
    settings
  ).items[0].warrantyMonths;
  // Terminal side: the SAV resolver must honour the snapshot, not re-derive.
  const dossier = lookupDeviceWarrantyByImei(IMEI, {
    transactions: [{ id: 'tx-1', receiptNumber: 'F-1', createdAt: SALE, status: 'COMPLETED', isRefund: false,
                     customer: { name: 'Ali' },
                     items: [{ imeiNumber: IMEI, product: soldProduct, quantity: 1, warrantyMonthsAtSale: minted }] }],
    products: [], imeiRecords: [], repairOrders: [],
  });
  ok(paper === dossier.warrantyMonths && paper === snap,
     `snapshot ${snap}: paper=${paper} terminal=${dossier.warrantyMonths}`);
}

console.log('\n[6b] B3 — a later catalog edit CANNOT re-date a sold device');
// The device was sold as-is (0 months). The owner later sets the product to 12.
// The snapshot on the line still governs.
const dossierEdited = lookupDeviceWarrantyByImei(IMEI, {
  transactions: [{ id: 'tx-3', receiptNumber: 'F-3', createdAt: SALE, status: 'COMPLETED', isRefund: false,
                   customer: { name: 'Ali' },
                   items: [{ imeiNumber: IMEI, warrantyMonthsAtSale: 0,
                             product: { ...occasionProduct, warrantyMonths: 0, warrantyExplicitlyDisabled: true } }] }],
  products: [{ id: 'p1', title: 'Occasion X', category: OCCASION, warrantyMonths: 12 }],
  imeiRecords: [], repairOrders: [],
});
ok(dossierEdited.warrantyMonths === 0,
   'catalog raised to 12 → sold device stays at its 0-month snapshot', dossierEdited.warrantyMonths);
ok(dossierEdited.isWarrantyValid === false, 'and remains uncovered', dossierEdited.isWarrantyValid);

// Legacy line with NO snapshot still re-derives (pre-Step-A sales). Under
// Option A the re-derived value for an occasion line is the 3-month baseline.
const legacyTerminal = lookupDeviceWarrantyByImei(IMEI, {
  transactions: [{ id: 'tx-4', receiptNumber: 'F-4', createdAt: SALE, status: 'COMPLETED', isRefund: false,
                   customer: { name: 'Ali' },
                   items: [{ imeiNumber: IMEI, product: occasionProduct }] }],
  products: [], imeiRecords: [], repairOrders: [],
});
ok(legacyTerminal.warrantyMonths === 3,
   'legacy unsnapshotted occasion line re-derives to the 3-month baseline',
   legacyTerminal.warrantyMonths);
// Same fallback path, non-occasion: proves re-derivation still reaches the
// 12-month default and Option A has not leaked outside its category.
const legacyTerminalNew = lookupDeviceWarrantyByImei(IMEI, {
  transactions: [{ id: 'tx-5', receiptNumber: 'F-5', createdAt: SALE, status: 'COMPLETED', isRefund: false,
                   customer: { name: 'Ali' },
                   items: [{ imeiNumber: IMEI, product: { id: 'p9', title: 'Neuf', category: 'Smartphones Neufs' } }] }],
  products: [], imeiRecords: [], repairOrders: [],
});
ok(legacyTerminalNew.warrantyMonths === D,
   'legacy unsnapshotted NON-occasion line re-derives to 12', legacyTerminalNew.warrantyMonths);

console.log('\n[7] B3 — legacy reprint (no snapshot) preserves the historical document');
const legacy = buildReceiptViewModel(
  mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI }),
  settings
);
ok(legacy.items[0].warrantyMonths === 3,
   'pre-Step-A occasion line still reprints 3 months (fidelity to paper the customer holds)',
   legacy.items[0].warrantyMonths);
const legacyNonOcc = buildReceiptViewModel(
  mkTx({ product: { id: 'p2', title: 'Coque', category: 'Coques iPhone', price: 1000 }, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI }),
  settings
);
ok(legacyNonOcc.items[0].warrantyMonths === 0, 'legacy non-occasion line still reprints 0');

console.log('\n[8] A line with no IMEI never gets a warranty, snapshot or not');
const noImei = buildReceiptViewModel(
  mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, warrantyMonthsAtSale: 12 }),
  settings
);
ok(noImei.items[0].warrantyMonths === 0, 'accessory prints no warranty even with a snapshot', noImei.items[0].warrantyMonths);

console.log('\n[9] Undecided product now resolves to a REAL term at the terminal');
const dossier = lookupDeviceWarrantyByImei(IMEI, {
  transactions: [{ id: 'tx-2', receiptNumber: 'F-2', createdAt: SALE, status: 'COMPLETED', isRefund: false,
                   customer: { name: 'Ali' },
                   items: [{ imeiNumber: IMEI, product: { id: 'p3', title: 'New', category: 'Tous les produits' }, quantity: 1 }] }],
  products: [], imeiRecords: [], repairOrders: [],
});
ok(dossier.warrantyMonths === D, 'undecided product grants the store default', dossier.warrantyMonths);
ok(dossier.isWarrantyValid === true, 'and the warranty is actually live', dossier.isWarrantyValid);

// ---------------------------------------------------------------------------
// Step D — Option A (owner-ratified): undecided PRE-OWNED stock is 3 months.
// ---------------------------------------------------------------------------
console.log('\n[10] Option A — undecided occasion stock mints 3, not 12');
ok(OCC === 3, 'the ratified baseline constant is 3 months', OCC);
ok(resolveWarrantyMonths({ category: OCCASION }) === 3,
   'undecided occasion product → 3', resolveWarrantyMonths({ category: OCCASION }));
ok(resolveWarrantyWithFallback({ category: OCCASION }, null) === 3,
   'fallback resolver → 3', resolveWarrantyWithFallback({ category: OCCASION }, null));
ok(resolveWarrantyMonths({ category: 'Tous les produits' }) === D,
   'undecided NON-occasion still 12 — Option A is scoped', resolveWarrantyMonths({ category: 'Tous les produits' }));
ok(resolveWarrantyMonths({}) === D, 'absent category still 12');

console.log('\n[11] Option A — category variants and robustness');
ok(resolveWarrantyMonths({ category: "Téléphones d'Occasion" }) === 3, 'without the "(Reprise)" suffix');
ok(resolveWarrantyMonths({ category: 'Reprise' }) === 3, 'bare "Reprise"');
ok(resolveWarrantyMonths({ category: "téléphones d'occasion (reprise)" }) === 3, 'lowercased');
ok(resolveWarrantyMonths({ category: 'Coques iPhone' }) === D, 'accessories unaffected');
ok(resolveWarrantyMonths({ category: 'Chargeurs' }) === D, 'chargers unaffected');

console.log('\n[12] Option A — explicit owner decisions STILL win over the category rule');
ok(resolveWarrantyMonths({ category: OCCASION, warrantyMonths: 12 }) === 12,
   'explicit 12 beats the 3-month baseline', resolveWarrantyMonths({ category: OCCASION, warrantyMonths: 12 }));
ok(resolveWarrantyMonths({ category: OCCASION, warrantyMonths: 24 }) === 24,
   'premium Grade A+ 24-month term is honoured', resolveWarrantyMonths({ category: OCCASION, warrantyMonths: 24 }));
ok(resolveWarrantyMonths({ category: OCCASION, warrantyMonths: 0, warrantyExplicitlyDisabled: true }) === 0,
   'as-is clearance still beats the baseline', resolveWarrantyMonths({ category: OCCASION, warrantyMonths: 0, warrantyExplicitlyDisabled: true }));
ok(resolveWarrantyWithFallback({ warrantyMonths: 12 }, { category: OCCASION }) === 12,
   'explicit catalog term beats an occasion line', resolveWarrantyWithFallback({ warrantyMonths: 12 }, { category: OCCASION }));
ok(resolveWarrantyWithFallback(null, { category: OCCASION, warrantyMonths: 6 }) === 6,
   'explicit line term beats the occasion baseline', resolveWarrantyWithFallback(null, { category: OCCASION, warrantyMonths: 6 }));

console.log('\n[13] Option A — end to end: the ratified 3 months reach paper AND terminal');
const checkoutMints = resolveWarrantyWithFallback(null, { category: OCCASION });
ok(checkoutMints === 3, 'checkout mints the 3-month baseline', checkoutMints);
const paperA = buildReceiptViewModel(
  mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI,
          warrantyMonthsAtSale: checkoutMints }),
  settings
);
ok(paperA.items[0].warrantyMonths === 3, 'receipt prints 3', paperA.items[0].warrantyMonths);
// Anchor is sold_at + 3 months, per the memo's deterministic snapshot.
const anchorA = warrantyAnchorFor({ soldAt: SALE, warrantyMonths: checkoutMints });
ok(anchorA === '2027-01-01T09:00:00.000Z', 'warranty_expires_at = sold_at + 3 months', anchorA);
const termA = lookupDeviceWarrantyByImei(IMEI, {
  transactions: [{ id: 'tx-a', receiptNumber: 'F-A', createdAt: SALE, status: 'COMPLETED', isRefund: false,
                   customer: { name: 'Ali' },
                   items: [{ imeiNumber: IMEI, product: occasionProduct, quantity: 1, warrantyMonthsAtSale: checkoutMints }] }],
  products: [], imeiRecords: [], repairOrders: [],
});
ok(termA.warrantyMonths === 3, 'SAV terminal resolves 3', termA.warrantyMonths);
ok(termA.warrantyExpiresAt === '2027-01-01T09:00:00.000Z', 'terminal expiry matches the anchor', termA.warrantyExpiresAt);

console.log('\n[14] Option A — the 129 LEGACY occasion sales lose their phantom 12 months');
// Pre-Step-A line: no snapshot, undecided occasion catalog row. This is the
// live exposure the memo closes — the receipt said 3, the SAV screen said 12.
const legacyResolves = resolveWarrantyWithFallback(
  { id: 'p1', title: 'Occasion X', category: OCCASION },
  { title: 'Occasion X', category: OCCASION }
);
ok(legacyResolves === 3, 'legacy occasion line now resolves 3, not 12', legacyResolves);
const legacyDossier = lookupDeviceWarrantyByImei(IMEI, {
  transactions: [{ id: 'tx-legacy', receiptNumber: 'F-L', createdAt: SALE, status: 'COMPLETED', isRefund: false,
                   customer: { name: 'Ali' },
                   items: [{ imeiNumber: IMEI, product: occasionProduct, quantity: 1 }] }],
  products: [{ id: 'p1', title: 'Occasion X', category: OCCASION }], imeiRecords: [], repairOrders: [],
});
ok(legacyDossier.warrantyMonths === 3,
   'legacy device held to its printed receipt term', legacyDossier.warrantyMonths);
const legacyPaper = buildReceiptViewModel(
  mkTx({ product: occasionProduct, quantity: 1, discount: 0, appliedPrice: 1000, imeiNumber: IMEI }),
  settings
);
ok(legacyPaper.items[0].warrantyMonths === 3, 'legacy reprint still says 3');
ok(legacyPaper.items[0].warrantyMonths === legacyDossier.warrantyMonths,
   'legacy paper and terminal now AGREE — the divergence is closed for old sales too');
// At month 5 the legacy device must read as expired, which is the whole point.
const monthFive = lookupDeviceWarrantyByImei(IMEI, {
  transactions: [{ id: 'tx-legacy', receiptNumber: 'F-L', createdAt: '2026-03-01T09:00:00.000Z',
                   status: 'COMPLETED', isRefund: false, customer: { name: 'Ali' },
                   items: [{ imeiNumber: IMEI, product: occasionProduct, quantity: 1 }] }],
  products: [{ id: 'p1', title: 'Occasion X', category: OCCASION }], imeiRecords: [], repairOrders: [],
});
ok(monthFive.isWarrantyValid === false,
   'a legacy occasion device at month 5 is expired (was wrongly live at 12)', monthFive.isWarrantyValid);

console.log('\n' + (failures === 0 ? 'ALL WARRANTY POLICY CHECKS PASSED (B2/B3 + Option A)' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
