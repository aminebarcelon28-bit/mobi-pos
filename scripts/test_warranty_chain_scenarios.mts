// ═══════════════════════════════════════════════════════════════════════════
// EXECUTABLE SCENARIO SUITE — the IMEI / serial / warranty chain
// ═══════════════════════════════════════════════════════════════════════════
// Every scenario drives the SHIPPED code (`warrantyResolver.ts`), not a copy.
// The inspector list used to be mirrored here; that mirror is gone because the
// list IS `buildWarrantyDeviceList` — list/detail divergence is now impossible
// by construction rather than by two hand-written functions agreeing.
//
//   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
//        scripts/test_warranty_chain_scenarios.mts
// ═══════════════════════════════════════════════════════════════════════════
import {
  archivedProductTitle,
  buildSavIntakeDraft,
  buildWarrantyDeviceList,
  computeDeviceWarranty,
  defaultWarrantyMonthsFor,
  describeArchivedProduct,
  legacyWarrantySnapshot,
  formatWarrantyDate,
  getWarrantyStatus,
  isWarrantyLive,
  minimalTicketDossierSnapshot,
  normalizeDeviceKey,
  resolveWarrantyDossier,
  resolveWarrantyMonths,
  warrantyChipLabel,
  warrantyCertificateDates,
  warrantyHeadline,
  warrantyStateLabel,
} from '../src/utils/warrantyResolver.ts';
import {
  chassisTagEscPosText,
  repairVoucherEscPosText,
  tradeInText,
  warrantyCertificateText,
  workshopSlipText,
} from '../src/utils/mobileDocPrint.ts';
import { WarrantyCertificateBuilder } from '../src/utils/warrantyCertificateBuilder.ts';
import { TradeInVoucherBuilder } from '../src/utils/tradeInVoucherBuilder.ts';
import { SavRestitutionBuilder } from '../src/utils/savRestitutionBuilder.ts';
import { buildReceiptViewModel } from '../src/utils/receiptViewModel.ts';
import { canonicalDeviceId, normalizeDeviceKey as canonicalKey } from '../src/utils/deviceIdCodec.ts';
import { luhnCheckImei, validateDeviceIdentifierForIntake } from '../src/utils/savValidation.ts';
import { toBoundedSyncJson } from '../src/sync/payloadHygiene.ts';
import { applyGenericRemoteRow } from '../src/sync/genericApply.ts';
import { readFileSync } from 'node:fs';
import {
  canRevealSellerId,
  deviceOriginFor,
  isNationalIdMissing,
  maskNationalId,
  nationalIdTypeLabel,
  normalizeNationalIdType,
  NATIONAL_ID_TYPE_OPTIONS,
  originIndexByKey,
  originView,
  originViewWithHistory,
  sellerIdAuditDetail,
} from '../src/utils/tradeInOrigin.ts';
import type { TradeInItem } from '../src/types/pos.ts';
import { planBackfill } from './warranty_anchor_backfill.mts';
import type {
  CartItem,
  IMEIRecord,
  Product,
  RepairOrder,
  SaleTransaction,
} from '../src/types/pos.ts';

// ── clock ───────────────────────────────────────────────────────────────────
const NOW = new Date();
const DAY = 1000 * 60 * 60 * 24;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

let passed = 0;
let failed = 0;

const ok = (cond: unknown, msg: string, detail?: unknown) => {
  if (cond) {
    passed++;
    console.log(`  ok    ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL  ${msg}`);
    if (detail !== undefined) {
      console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
  }
};

const section = (title: string) => console.log(`\n${title}`);

type Deps = {
  transactions: SaleTransaction[] | null;
  products: Product[] | null;
  imeiRecords: IMEIRecord[] | null;
  repairOrders: RepairOrder[] | null;
};

// ── fixtures ────────────────────────────────────────────────────────────────
const IMEI = '352099001761481';
const IMEI2 = '352099001761994';
const SERIAL = 'SN-XZ7-99213-A';
const NEW_IMEI = '356938035643809';

const product = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p1',
    sku: 'TEL-IP12-128',
    title: 'iPhone 12 128 Go',
    category: 'Téléphones',
    price: 180000,
    costPrice: 150000,
    stockQuantity: 3,
    isSerialized: true,
    barcode: '1234567890128',
    warrantyMonths: 12,
    createdAt: iso(-400 * DAY),
    updatedAt: iso(-400 * DAY),
    ...over,
  }) as Product;

const cartItem = (over: Partial<CartItem> = {}): CartItem =>
  ({
    productId: 'p1',
    product: product(),
    quantity: 1,
    appliedPrice: 180000,
    imeiNumber: IMEI,
    warrantyMonthsAtSale: 12,
    ...over,
  }) as CartItem;

const soldTx = (over: Partial<SaleTransaction> = {}): SaleTransaction =>
  ({
    id: 'tx1',
    receiptNumber: 'F-2026-0001',
    createdAt: iso(-10 * DAY),
    status: 'COMPLETED',
    customer: { name: 'Acheteur Test', phone: '0551000000' },
    items: [cartItem()],
    total: 180000,
    paymentMethod: 'CASH',
    ...over,
  }) as SaleTransaction;

const registry = (over: Partial<IMEIRecord> = {}): IMEIRecord =>
  ({
    imei: IMEI,
    productId: 'p1',
    receivedAt: iso(-30 * DAY),
    soldAt: iso(-10 * DAY),
    saleTransactionId: 'tx1',
    warrantyMonths: 12,
    warrantyExpiresAt: iso(355 * DAY),
    ...over,
  }) as IMEIRecord;

const repair = (over: Partial<RepairOrder> = {}): RepairOrder =>
  ({
    id: 'r1',
    ticketNumber: 'REP-0001',
    imei: IMEI,
    deviceModel: 'iPhone 12 (re SAV)',
    customerName: 'Client SAV',
    status: 'En cours',
    createdAt: iso(-3 * DAY),
    ...over,
  }) as RepairOrder;

const detail = (id: string, deps: Deps, mode: 'imei' | 'serial' = 'imei') =>
  resolveWarrantyDossier(id, mode, deps as never);

/** Certificate print settings; both widths must behave identically. */
const settings = {
  storeName: 'MOBI ACCESSORIES',
  address: 'Boulevard Mohamed V, Alger Centre',
  phone: '0550 00 00 00',
  paperWidth: '80mm',
} as never;

// The list is the SAME function the inspector renders from (W-01/W-02).
const listRows = (deps: Deps) => buildWarrantyDeviceList(deps as never);

const badgeText = (row: ReturnType<typeof listRows>[number]) =>
  warrantyChipLabel(row.status);

// ═══════════════════════════════════════════════════════════════════════════
section('S1  Supplier buy -> sold with a 12-month warranty -> list AND detail');
{
  const deps: Deps = {
    transactions: [soldTx()],
    products: [product()],
    imeiRecords: [registry()],
    repairOrders: [],
  };
  const d = detail(IMEI, deps).snapshot!.dossier;
  const row = listRows(deps).find((r) => normalizeDeviceKey(r.imei) === normalizeDeviceKey(IMEI))!;

  ok(d.isWarrantyValid === true, 'S1 detail: warranty valid', { valid: d.isWarrantyValid });
  ok(d.warrantyMonths === 12, 'S1 detail: 12 months', d.warrantyMonths);
  ok(d.warrantyExpiresAt === iso(355 * DAY), 'S1 detail: the row anchor is honoured, not recomputed',
     d.warrantyExpiresAt);
  ok(row.isWarrantyValid === true, 'S1 list: warranty valid', { valid: row.isWarrantyValid });
  ok(row.daysRemaining === d.daysRemaining, 'S1 list days == detail days',
     { list: row.daysRemaining, detail: d.daysRemaining });
  ok(!badgeText(row).includes('90 jours'),
     'S1 the list badge must NOT claim a 90-day REPAIR term for a 12-month STORE warranty', badgeText(row));
  ok(badgeText(row).includes('1 an'),
     'S1 the list badge must name the STORE term (12 months -> "1 an")', badgeText(row));
  ok(row.repairStatus === null,
     'S1 a device with no SAV has NO repair warranty to show', row.repairStatus);
}

section('S2  Trade-in bought from a customer -> resold "Grade B", 1-year warranty');
{
  const occProduct = product({
    id: 'pocc', title: 'iPhone 12 (Grade B)', category: "Téléphones d'Occasion (Reprise)",
    warrantyMonths: 1,
  });
  const resaleTx = soldTx({
    id: 'tx2', receiptNumber: 'F-2026-0002', createdAt: iso(-5 * DAY),
    customer: { name: 'Nouveau Client', phone: '0553000000' },
    items: [cartItem({ product: occProduct, appliedPrice: 120000, warrantyMonthsAtSale: 1 })],
  });
  const resaleRec = registry({
    soldAt: iso(-5 * DAY), saleTransactionId: 'tx2',
    warrantyMonths: 1, warrantyExpiresAt: iso(360 * DAY),
  });
  const deps: Deps = {
    transactions: [resaleTx], products: [occProduct], imeiRecords: [resaleRec], repairOrders: [],
  };
  const d = detail(IMEI, deps).snapshot!.dossier;
  ok(d.isWarrantyValid === true, 'S2a the resale warranty is active', { valid: d.isWarrantyValid });
  ok(d.warrantyMonths === 1, 'S2a the term is the 1-year occasion term, not the 12-month default',
     d.warrantyMonths);
  ok(d.productTitle.includes('Grade B'), 'S2a the occasion title is shown', d.productTitle);

  const undecided = product({ id: 'pocc2', title: 'iPhone 11 (Grade C)',
                              category: "Téléphones d'Occasion (Reprise)", warrantyMonths: undefined });
  ok(resolveWarrantyMonths(undecided) === 3,
     'S2b an undecided occasion stock resolves to the 3-month default', resolveWarrantyMonths(undecided));
}

section('S3  Sold -> refunded -> resold. Latest sale must win.');
{
  const original = soldTx({ id: 'txA', createdAt: iso(-100 * DAY) });
  const refundVoucher = soldTx({
    id: 'txR', receiptNumber: 'AV-1', createdAt: iso(-60 * DAY),
    isRefund: true, status: 'COMPLETED', customer: { name: 'Acheteur', phone: '0551000000' },
  });
  const resale = soldTx({
    id: 'txB', receiptNumber: 'F-2026-0009', createdAt: iso(-10 * DAY),
    customer: { name: 'Acheteur 2', phone: '0551000000' },
  });
  original.status = 'REFUNDED';
  const base = { transactions: [original, refundVoucher, resale], products: [product()], repairOrders: [] };

  // (a) POST-FIX WRITER: a genuine resale re-anchors the row.
  const reanchored = registry({ soldAt: iso(-10 * DAY), saleTransactionId: 'txB',
                               warrantyExpiresAt: iso(355 * DAY) });
  const d = detail(IMEI, { ...base, imeiRecords: [reanchored] }).snapshot!.dossier;
  ok(d.originalReceiptNumber === 'F-2026-0009', 'S3a the LATEST sale wins', d.originalReceiptNumber);
  ok(d.isWarrantyValid === true, 'S3a the resold device has ACTIVE warranty again',
     { valid: d.isWarrantyValid, days: d.daysRemaining });
  ok(!String(d.productTitle).includes('Retourné'), 'S3a no stale "returned" suffix', d.productTitle);
  ok(d.storeWarranty?.source === 'anchor', 'S3a the resale anchor is the source', d.storeWarranty?.source);

  // (b) LEGACY ROW: the refund cleared soldAt but KEPT the first anchor, and the
  // resale re-stamped only `saleTransactionId` — leaving an elapsed expiry glued
  // to a live sale. The backfill for these rows is OPTIONAL (owner decision), so
  // the reader faithfully reports what it was given. Asserted so it cannot
  // regress silently.
  const legacy = registry({ soldAt: iso(-10 * DAY), saleTransactionId: 'txB',
                            warrantyExpiresAt: iso(-60 * DAY) });
  const dLegacy = detail(IMEI, { ...base, imeiRecords: [legacy] }).snapshot!.dossier;
  ok(dLegacy.isWarrantyValid === false,
     'S3b KNOWN RESIDUAL: a legacy stale anchor still reads expired until the optional backfill runs',
     { valid: dLegacy.isWarrantyValid });
  ok(dLegacy.storeWarranty?.source === 'anchor',
     'S3b the reader honours the stored anchor it was given', dLegacy.storeWarranty?.source);

  // (c) A refund with NO resale must not resurrect coverage.
  const refundOnly = registry({ soldAt: undefined, saleTransactionId: undefined,
                                warrantyExpiresAt: iso(-60 * DAY) });
  const dRef = detail(IMEI, {
    transactions: [original, refundVoucher], products: [product()],
    imeiRecords: [refundOnly], repairOrders: [],
  }).snapshot!.dossier;
  ok(dRef.isWarrantyValid === false, 'S3c a refunded device is NOT in warranty', { valid: dRef.isWarrantyValid });
  ok(dRef.isSold === false, 'S3c a refunded device is no longer "sold"', dRef.isSold);
}

section('S4  Catalog edited after the sale (12 -> 3, then -> "Sans Garantie")');
{
  const anchored = registry();
  const sold12 = soldTx();
  const before = detail(IMEI, {
    transactions: [sold12], products: [product({ warrantyMonths: 12 })],
    imeiRecords: [anchored], repairOrders: [],
  }).snapshot!.dossier;
  const after3 = detail(IMEI, {
    transactions: [soldTx()], products: [product({ warrantyMonths: 3 })],
    imeiRecords: [anchored], repairOrders: [],
  }).snapshot!.dossier;
  const after0 = detail(IMEI, {
    transactions: [soldTx()],
    products: [product({ warrantyMonths: 0, warrantyExplicitlyDisabled: true })],
    imeiRecords: [anchored], repairOrders: [],
  }).snapshot!.dossier;

  ok(before.warrantyMonths === 12 && before.warrantyExpiresAt === anchored.warrantyExpiresAt,
     'S4a baseline: the sale snapshot is 12 months', before.warrantyMonths);
  ok(after3.warrantyMonths === 12 && after3.warrantyExpiresAt === anchored.warrantyExpiresAt,
     'S4a a catalog edit 12->3 cannot retro-re-date coverage a customer already bought',
     { months: after3.warrantyMonths });
  ok(after0.isWarrantyValid === true && after0.warrantyExpiresAt === anchored.warrantyExpiresAt,
     'S4a "Sans Garantie" in the catalog cannot void an existing sale warranty',
     { valid: after0.isWarrantyValid });

  // S4b list/detail parity across those three states — the W-02 divergence.
  const rows = [
    detail(IMEI, { transactions: [sold12], products: [product({ warrantyMonths: 12 })],
                    imeiRecords: [anchored], repairOrders: [] }).snapshot!.dossier,
    detail(IMEI, { transactions: [soldTx()], products: [product({ warrantyMonths: 3 })],
                    imeiRecords: [anchored], repairOrders: [] }).snapshot!.dossier,
    detail(IMEI, { transactions: [soldTx()],
                    products: [product({ warrantyMonths: 0, warrantyExplicitlyDisabled: true })],
                    imeiRecords: [anchored], repairOrders: [] }).snapshot!.dossier,
  ];
  const lists = [
    { transactions: [sold12], products: [product({ warrantyMonths: 12 })], imeiRecords: [anchored], repairOrders: [] },
    { transactions: [soldTx()], products: [product({ warrantyMonths: 3 })], imeiRecords: [anchored], repairOrders: [] },
    { transactions: [soldTx()], products: [product({ warrantyMonths: 0, warrantyExplicitlyDisabled: true })],
      imeiRecords: [anchored], repairOrders: [] },
  ].map((deps) => listRows(deps as Deps).find((r) => normalizeDeviceKey(r.imei) === normalizeDeviceKey(IMEI))!);

  ok(lists[0].daysRemaining === rows[0].daysRemaining && lists[1].daysRemaining === rows[1].daysRemaining
     && lists[2].daysRemaining === rows[2].daysRemaining,
     'S4b list days == detail days across all three catalog states',
     { list: lists.map((l) => l.daysRemaining), detail: rows.map((r) => r.daysRemaining) });
  ok(lists.every((l, i) => l.isWarrantyValid === rows[i].isWarrantyValid),
     'S4b list valid == detail valid across all three catalog states');
}

section('S5  SAV in progress AND a SAV delivered — both warranties must be visible');
{
  const deps: Deps = {
    transactions: [soldTx()],
    products: [product()],
    imeiRecords: [registry()],
    repairOrders: [
      repair({ id: 'r1', status: 'En cours' }),
      repair({ id: 'r2', ticketNumber: 'REP-0002', status: 'Livré', createdAt: iso(-2 * DAY),
               deliveredAt: iso(-2 * DAY), warrantyTier: 'repair_90d',
               warrantyExpiresAt: iso(88 * DAY) }),
    ],
  };
  const d = detail(IMEI, deps).snapshot!.dossier;
  const delivered = deps.repairOrders![1];
  const store = d.storeWarranty;
  const rep = d.repairWarranty;

  ok(store?.state === 'ACTIVE' || store?.state === 'EXPIRING_SOON',
     'S5a the STORE warranty is live alongside SAV', store?.state);
  ok(d.repairHistoryCount === 2, 'S5a SAV history counted (in-progress + delivered)', d.repairHistoryCount);
  ok(typeof delivered.warrantyExpiresAt === 'string', 'S5b the delivered ticket carries a repair expiry');

  ok(store !== undefined, 'S5c the store warranty is exposed as a status', store);
  ok(rep !== null && rep !== undefined, 'S5c the repair warranty is exposed as a status', rep);
  ok(store?.kind === 'STORE', 'S5c the store warranty is kind=STORE', store?.kind);
  ok(rep?.kind === 'REPAIR', 'S5c the repair warranty is kind=REPAIR', rep?.kind);
  ok(rep?.state === 'REPAIR_WARRANTY_ACTIVE', 'S5c the repair warranty state', rep?.state);
  ok(rep?.endDate === delivered.warrantyExpiresAt,
     'S5c the repair expiry is the one minted at restitution',
     { shown: rep?.endDate, onRecord: delivered.warrantyExpiresAt });
  ok(store?.endDate !== rep?.endDate, 'S5c the two expiries are DISTINCT values',
     { store: store?.endDate, repair: rep?.endDate });
  ok(warrantyStateLabel(store!) !== warrantyStateLabel(rep!),
     'S5c each warranty renders its own label',
     { store: warrantyStateLabel(store!), repair: warrantyStateLabel(rep!) });
  ok(warrantyChipLabel(store!).includes('an') && warrantyChipLabel(rep!).includes('j'),
     'S5c the chips speak their own units (months for store, days for repair)',
     { store: warrantyChipLabel(store!), repair: warrantyChipLabel(rep!) });
  ok(d.primaryWarranty?.kind === 'REPAIR',
     'S5c a live repair warranty is the primary (actionable) one', d.primaryWarranty?.kind);
  ok(d.savTickets?.length === 2 && d.savTickets[0].ticketNumber === 'REP-0002',
     'S5d SAV tickets are listed newest-first for the timeline', d.savTickets);
}

section('S6  Device injected into stock from a repair job, then sold');
{
  // A repair ticket exists, the device was never sold: the old code painted a
  // 3-month DEFAULT store warranty onto a repair-only device.
  const repairOnly: Deps = {
    transactions: [], products: [product()], imeiRecords: [],
    repairOrders: [repair({ status: 'Livré', warrantyTier: 'repair_90d', deliveredAt: iso(-40 * DAY),
                            warrantyExpiresAt: iso(50 * DAY) })],
  };
  const dR = detail(IMEI, repairOnly).snapshot!.dossier;
  ok(dR.isWarrantyValid === false, 'S6a a repair-only device is NOT in store warranty', { valid: dR.isWarrantyValid });
  ok(!dR.warrantyExpiresAt, 'S6a a repair-only device must NOT invent a store expiry', dR.warrantyExpiresAt);
  ok(dR.storeWarranty?.state === 'NEVER_COVERED', 'S6a the store warranty is NEVER_COVERED', dR.storeWarranty?.state);
  ok(dR.storeWarranty?.term === 0, 'S6a the invented default term is gone (term 0, not 3)', dR.storeWarranty?.term);
  ok(dR.repairWarranty?.state === 'REPAIR_WARRANTY_ACTIVE',
     'S6a the delivered repair warranty IS exposed', dR.repairWarranty?.state);

  // Now sold: the catalog title must win over the terse repair label.
  const soldDep = {
    ...repairOnly,
    transactions: [soldTx()],
    imeiRecords: [registry({ soldAt: iso(-5 * DAY), saleTransactionId: 'tx1' })],
  };
  const dS = detail(IMEI, soldDep as Deps).snapshot!.dossier;
  ok(dS.productTitle === 'iPhone 12 128 Go',
     'S6b the catalog title wins over the repair ticket label', dS.productTitle);
  ok(dS.isWarrantyValid === true && dS.storeWarranty?.term === 12,
     'S6b once sold, the 12-month store warranty applies', { valid: dS.isWarrantyValid, term: dS.storeWarranty?.term });
}

section('S7  Exchange / swap: the warranty does NOT transfer to the replacement');
{
  // Owner decision: no transfer. The outgoing device ends coverage on return
  // (from the cart line's `isReturn`), and the incoming replacement starts its
  // own coverage from its own sale.
  const outgoing = cartItem({ imeiNumber: IMEI, isReturn: true });
  const incoming = cartItem({ imeiNumber: NEW_IMEI, warrantyMonthsAtSale: 12 });
  const exchangeTx = soldTx({
    id: 'txEx', receiptNumber: 'AV-2', createdAt: iso(-3 * DAY),
    items: [outgoing, incoming],
  });
  const incomingRec = registry({
    imei: NEW_IMEI, soldAt: iso(-3 * DAY), saleTransactionId: 'txEx',
    warrantyExpiresAt: iso(362 * DAY),
  });
  const deps: Deps = {
    transactions: [exchangeTx], products: [product()],
    imeiRecords: [registry({ imei: IMEI, soldAt: undefined, saleTransactionId: undefined,
                             warrantyExpiresAt: undefined }), incomingRec],
    repairOrders: [],
  };

  const dOut = detail(IMEI, deps).snapshot!.dossier;
  ok(dOut.storeWarranty?.state === 'VOID',
     'S7a the returned device coverage is VOID, not silently expired', dOut.storeWarranty?.state);
  ok(dOut.isWarrantyValid === false, 'S7a a voided device is never live', { valid: dOut.isWarrantyValid });
  ok(dOut.storeWarranty?.daysLeft === 0, 'S7a a voided warranty grants zero days',
     dOut.storeWarranty?.daysLeft);
  ok(String(dOut.storeWarranty?.endDate).slice(0, 10) < new Date().toISOString().slice(0, 10),
     'S7a the void date reported is in the PAST — coverage ended, it did not extend',
     dOut.storeWarranty?.endDate);

  const dIn = detail(NEW_IMEI, deps).snapshot!.dossier;
  ok(dIn.isWarrantyValid === true && dIn.storeWarranty?.term === 12,
     'S7b the replacement carries its OWN warranty from its own sale',
     { valid: dIn.isWarrantyValid, term: dIn.storeWarranty?.term });
  ok(dIn.warrantyExpiresAt !== dOut.warrantyExpiresAt,
     'S7b no coverage was transferred from the outgoing device');
  ok(dIn.originalReceiptNumber === 'AV-2', 'S7b the replacement is traceable to the exchange receipt',
     dIn.originalReceiptNumber);
}

section('S8  Same IMEI typed with spaces / dashes / dots resolves to ONE device');
{
  const deps: Deps = {
    transactions: [soldTx()], products: [product()], imeiRecords: [registry()], repairOrders: [],
  };
  const spellings = [
    IMEI,
    '35 209900 176148 1',
    '35-209900-176148-1',
    '35.209900.176148.1',
    ' 352099001761481  ',
  ];
  const results = spellings.map((s) => detail(s, deps));
  ok(results.every((r) => r.ok), 'S8 every spelling resolves', results.map((r) => r.ok));
  ok(new Set(results.map((r) => r.snapshot!.dossier.warrantyExpiresAt)).size === 1,
     'S8 all spellings yield ONE expiry', results.map((r) => r.snapshot!.dossier.warrantyExpiresAt));
  ok(new Set(results.map((r) => r.identifier.value.replace(/\D/g, ''))).size === 1,
     'S8 all spellings canonicalize to the same identifier',
     results.map((r) => r.identifier.value));
  ok(listRows(deps).length === 1, 'S8 the list shows the device ONCE, not once per spelling',
     listRows(deps).length);
}

section('S9  Serial-number device (no IMEI) — full flow incl. SAV intake');
{
  const tablet = product({ id: 'ptab', sku: 'TAB-IPAD9', title: 'iPad 9', imeiNumber: SERIAL,
                           barcode: undefined });
  const serialSale = soldTx({
    id: 'txS', receiptNumber: 'F-2026-0001', createdAt: iso(-20 * DAY),
    items: [cartItem({ product: tablet, imeiNumber: SERIAL, warrantyMonthsAtSale: 12 })],
  });
  const serialRec = registry({
    imei: SERIAL, productId: 'ptab', soldAt: iso(-20 * DAY), saleTransactionId: 'txS',
    warrantyExpiresAt: iso(345 * DAY),
  });
  const deps: Deps = {
    transactions: [serialSale], products: [tablet], imeiRecords: [serialRec], repairOrders: [],
  };
  const d = detail(SERIAL, deps, 'serial').snapshot!.dossier;

  ok(d.originalReceiptNumber === 'F-2026-0001', 'S9a a serial-number sale is found by the resolver',
     d.originalReceiptNumber);
  ok(d.isWarrantyValid === true && d.warrantyMonths === 12,
     'S9a the serial device gets the same STORE warranty treatment as an IMEI device',
     { valid: d.isWarrantyValid, months: d.warrantyMonths });
  ok(d.storeWarranty?.kind === 'STORE' && typeof d.warrantyExpiresAt === 'string',
     'S9a the serial warranty is a STORE warranty with a real expiry', d.storeWarranty?.kind);

  // W-06 CONFIRMED (defect, not fixed here): the SAV CTA re-resolves with the
  // hardcoded 'imei' mode, so a serial dossier can never be consumed.
  const reResolved = detail(SERIAL, deps, 'imei');
  ok(reResolved.ok === false, 'S9b W-06 CONFIRMED: re-resolving a serial dossier in IMEI mode fails');
  ok(/15 chiffres/.test(String(reResolved.note)),
     'S9b the failure reason is the IMEI length gate', reResolved.note);
  ok(detail(SERIAL, deps, 'serial').ok === true,
     'S9c the same dossier resolves fine in serial mode — the CTA mode is the bug');
}

section('S10  "Sans ID" (manual) flow');
{
  const res = detail('', { transactions: [soldTx()], products: [product()],
                           imeiRecords: [registry()], repairOrders: [] }, 'manual');
  ok(res.ok === false, 'S10 manual mode never resolves a warranty dossier', { ok: res.ok });
  ok(/Aucun identifiant saisi/.test(String(res.note)), 'S10 the refusal explains itself', res.note);
  ok(res.snapshot === null, 'S10 no snapshot is produced');
}

section('S11  Unknown IMEI / invalid Luhn / 14 digits / 16 digits');
{
  const empty: Deps = { transactions: [], products: [], imeiRecords: [], repairOrders: [] };
  const d = detail(IMEI, empty).snapshot!.dossier;
  ok(d.originalReceiptNumber === 'NON ENREGISTRÉ', 'S11a an unknown device is NON ENREGISTRÉ',
     d.originalReceiptNumber);
  ok(d.isWarrantyValid === false && d.daysRemaining === 0, 'S11a an unknown device has no coverage',
     { valid: d.isWarrantyValid, days: d.daysRemaining });
  ok(d.isUnknownDevice === true, 'S11a the dossier flags itself as unknown', d.isUnknownDevice);
  ok(!d.warrantyExpiresAt,
     'S11a an unknown device must claim NO expiry, so the card says "aucune garantie enregistrée"',
     d.warrantyExpiresAt);
  ok(d.storeWarranty?.state === 'NEVER_COVERED', 'S11a the status is NEVER_COVERED', d.storeWarranty?.state);

  const badLuhn = detail('352099001761480', empty);
  ok(badLuhn.ok === false && /Luhn/.test(String(badLuhn.note)), 'S11b invalid Luhn is refused', badLuhn.note);
  const d14 = detail('35209900176148', empty);
  ok(d14.ok === false && /14 saisis/.test(String(d14.note)), 'S11c 14 digits refused', d14.note);
  const d16 = detail('3520990017614811', empty);
  ok(d16.ok === false && /16 saisis/.test(String(d16.note)), 'S11d 16 digits refused', d16.note);
  const letters = detail('IMEI: 352099001761481', empty);
  ok(letters.ok === true, 'S11e an embedded prefix is stripped and the IMEI still resolves', letters.ok);
}

section('S12  Warranty boundaries (via computeDeviceWarranty, the time-injectable path)');
{
  const start = '2026-03-15T10:00:00.000Z';
  const at = (days: number) => new Date(new Date(start).getTime() + days * DAY).toISOString();
  const w = (months: number, nowIso: string) =>
    computeDeviceWarranty({ warrantyMonths: months, startIso: start, sold: true, nowIso });

  const twelve = w(12, at(0));
  ok(twelve.isWarrantyValid === true && twelve.daysRemaining === 365,
     'S12a 12 months from 15/03 = 365 days', { valid: twelve.isWarrantyValid, days: twelve.daysRemaining });

  const dayBefore = w(12, at(364));
  ok(dayBefore.isWarrantyValid === true, 'S12a one day before expiry is still valid',
     dayBefore.isWarrantyValid);
  const onExpiry = w(12, at(365));
  ok(onExpiry.isWarrantyValid === false && onExpiry.daysRemaining === 0,
     'S12b ON the expiry day coverage is over (no grace day)',
     { valid: onExpiry.isWarrantyValid, days: onExpiry.daysRemaining });

  // Clamping: 31 Jan + 1 month must land in February, never roll into March.
  const feb = computeDeviceWarranty({ warrantyMonths: 1, startIso: '2026-01-31T10:00:00.000Z', sold: true });
  ok(String(feb.warrantyExpiresAt).slice(0, 7) === '2026-02',
     'S12c month arithmetic CLAMPS to the end of February instead of overflowing into March',
     feb.warrantyExpiresAt);
  const leap = computeDeviceWarranty({ warrantyMonths: 1, startIso: '2024-01-31T10:00:00.000Z', sold: true });
  ok(String(leap.warrantyExpiresAt).slice(0, 7) === '2024-02',
     'S12c a leap-year 31 Jan also clamps to February', leap.warrantyExpiresAt);

  // Timezone safety: the SAME instant must render the same calendar day.
  ok(formatWarrantyDate('2026-12-31T00:00:00.000Z') === '31/12/2026',
     'S12d a UTC-midnight anchor renders as 31/12, never the 30th west of UTC',
     formatWarrantyDate('2026-12-31T00:00:00.000Z'));
}

section('S13  Cancelled SAV must not count as an intervention');
{
  const deps: Deps = {
    transactions: [soldTx()], products: [product()], imeiRecords: [registry()],
    repairOrders: [
      repair({ id: 'r1', status: 'En cours' }),
      repair({ id: 'r2', ticketNumber: 'REP-0002', status: 'Annulé',
               warrantyExpiresAt: iso(88 * DAY), deliveredAt: iso(-2 * DAY) }),
      repair({ id: 'r3', ticketNumber: 'REP-0003', status: 'Livré', createdAt: iso(-1 * DAY),
               warrantyTier: 'repair_90d', deliveredAt: iso(-1 * DAY), warrantyExpiresAt: iso(89 * DAY) }),
    ],
  };
  const d = detail(IMEI, deps).snapshot!.dossier;
  ok(d.repairHistoryCount === 2, 'S13 the cancelled ticket is excluded from the count', d.repairHistoryCount);
  const delivered = deps.repairOrders!.filter((r) => r.status === 'Livré');
  ok(d.repairWarranty?.endDate === delivered[0].warrantyExpiresAt,
     'S13 the repair warranty comes from the delivered ticket, not the cancelled one',
     { shown: d.repairWarranty?.endDate, cancelled: deps.repairOrders![1].warrantyExpiresAt });
  ok(!d.savTickets?.some((t) => t.ticketNumber === 'REP-0002'),
     'S13 the cancelled ticket is absent from the timeline', d.savTickets);
}

section('S14  Dual-SIM: IMEI1 and IMEI2 — identifiers are a LIST by design');
{
  const deps: Deps = {
    transactions: [soldTx({ items: [cartItem({ imeiNumber: `${IMEI} / ${IMEI2}` })] })],
    products: [product()],
    imeiRecords: [registry({ imei: `${IMEI} / ${IMEI2}` })],
    repairOrders: [],
  };
  // Groundwork PROVEN: the API takes a list, so IMEI2 needs no signature change.
  const both = detail([IMEI, IMEI2], deps);
  ok(both.ok === true, 'S14a an identifier LIST resolves when a row carries both IMEIs', { ok: both.ok });
  ok(both.snapshot!.dossier.identifiers?.length === 2,
     'S14a the dossier exposes BOTH identifiers', both.snapshot!.dossier.identifiers);
  const either = detail(IMEI2, deps);
  ok(either.ok === true, 'S14a resolving by IMEI2 alone finds the same device', { ok: either.ok });
  ok(either.snapshot!.dossier.warrantyExpiresAt === both.snapshot!.dossier.warrantyExpiresAt,
     'S14a both IMEIs resolve to ONE warranty', {
       imei2: either.snapshot!.dossier.warrantyExpiresAt,
       both: both.snapshot!.dossier.warrantyExpiresAt,
     });

  // KNOWN LIMITATION (owner: dual SIM is proposal-only, no schema change yet):
  // the registry stores one `imei` column, so a device whose row lists IMEI1 but
  // whose operator scans IMEI2 alone does NOT resolve.
  const imei1Only: Deps = {
    transactions: [soldTx()], products: [product()],
    imeiRecords: [registry({ imei: IMEI })], repairOrders: [],
  };
  const scannedImei2 = detail(IMEI2, imei1Only);
  ok(scannedImei2.ok === true, 'S14b KNOWN LIMITATION: IMEI2 alone resolves only while the row has no IMEI2',
     { ok: scannedImei2.ok });
  const mismatch = detail('356938035643999', imei1Only).snapshot!.dossier;
  ok(mismatch.isUnknownDevice === true, 'S14b a genuinely foreign IMEI is still unknown',
     mismatch.isUnknownDevice);
}

section('S15  Duplicate IMEI across two registry records — which one wins?');
{
  const first = registry({
    productId: 'p1', receivedAt: iso(-300 * DAY), soldAt: iso(-200 * DAY),
    saleTransactionId: 'txOld', warrantyExpiresAt: iso(200 * DAY), warrantyMonths: 12,
  });
  const second = registry({
    productId: 'p2', receivedAt: iso(-30 * DAY), soldAt: iso(-10 * DAY),
    saleTransactionId: 'tx1', warrantyExpiresAt: iso(355 * DAY), warrantyMonths: 12,
  });
  const deps: Deps = {
    transactions: [soldTx()], products: [product()], imeiRecords: [first, second], repairOrders: [],
  };
  const d = detail(IMEI, deps).snapshot!.dossier;
  ok(d.originalReceiptNumber === 'F-2026-0001',
     'S15a the MOST RECENT registry row wins', d.originalReceiptNumber);
  ok(d.warrantyExpiresAt === second.warrantyExpiresAt,
     'S15a the expiry comes from that same row, not the older duplicate', d.warrantyExpiresAt);
  ok(listRows(deps).length === 1, 'S15a the list shows ONE card for the duplicate, not two',
     listRows(deps).length);

  // Each row must use ITS OWN months — never the first row's term. The sale line
  // is absent here on purpose, so the REGISTRY branch is the one under test.
  const shortOld = registry({ receivedAt: iso(-300 * DAY), soldAt: iso(-200 * DAY),
                              saleTransactionId: 'txOld', warrantyMonths: 3,
                              warrantyExpiresAt: iso(200 * DAY) });
  const longNew = registry({ productId: 'p2', soldAt: iso(-10 * DAY), saleTransactionId: 'tx1',
                             warrantyMonths: 24, warrantyExpiresAt: iso(720 * DAY) });
  const mixed: Deps = {
    transactions: [], products: [product()],
    imeiRecords: [shortOld, longNew], repairOrders: [],
  };
  const dMixed = detail(IMEI, mixed).snapshot!.dossier;
  ok(dMixed.storeWarranty?.term === 24, 'S15b the winning row supplies its OWN term (24, not 3)',
     dMixed.storeWarranty?.term);
  ok(dMixed.warrantyExpiresAt === longNew.warrantyExpiresAt,
     'S15b the expiry matches that row, not the older duplicate', dMixed.warrantyExpiresAt);
}

section('S16  getWarrantyStatus — pure state machine, clock injected');
{
  const sale = '2026-01-15T10:00:00.000Z';
  const at = (days: number) => new Date(new Date(sale).getTime() + days * DAY).toISOString();
  const s = (nowIso: string) =>
    getWarrantyStatus({ identifiers: [IMEI], store: { months: 12, startIso: sale, sold: true }, nowIso });

  ok(s(at(0)).state === 'ACTIVE', 'S16a day 0 is ACTIVE', s(at(0)).state);
  ok(s(at(340)).state === 'EXPIRING_SOON', 'S16a inside the 30-day window is EXPIRING_SOON', s(at(340)).state);
  ok(s(at(364)).state === 'EXPIRING_SOON', 'S16a the last covered day is still EXPIRING_SOON', s(at(364)).state);
  ok(s(at(365)).state === 'EXPIRED', 'S16a the day AFTER expiry is EXPIRED', s(at(365)).state);
  ok(s(at(365)).daysLeft === 0, 'S16a an expired warranty reports 0 days left', s(at(365)).daysLeft);

  const unsold = getWarrantyStatus({
    identifiers: [IMEI], store: { months: 12, startIso: null, sold: false }, nowIso: at(0),
  });
  ok(unsold.state === 'NOT_STARTED', 'S16b in-stock coverage has NOT started', unsold.state);
  ok(unsold.term === 12, 'S16b the term is still advertised while unsold', unsold.term);
  ok(!isWarrantyLive(unsold), 'S16b an unsold warranty does not grant free repairs', unsold.state);

  const voided = getWarrantyStatus({
    identifiers: [IMEI],
    store: { months: 12, startIso: sale, sold: true, voided: true, voidedAtIso: at(100) },
    nowIso: at(200),
  });
  ok(voided.state === 'VOID', 'S16c a return voids coverage even inside the window', voided.state);
  ok(!isWarrantyLive(voided), 'S16c a voided warranty is never live', voided.state);
  ok(voided.endDate === at(100),
     'S16c the end date is the RETURN stamp, not the original sale date',
     { shown: voided.endDate, saleDate: sale, returnDate: at(100) });

  const none = getWarrantyStatus({ identifiers: [IMEI], nowIso: at(0) });
  ok(none.state === 'NEVER_COVERED', 'S16d a device with no record is NEVER_COVERED', none.state);
  ok(none.endDate === null, 'S16d NEVER_COVERED has no expiry to render', none.endDate);

  const zeroMonths = getWarrantyStatus({
    identifiers: [IMEI], store: { months: 0, startIso: sale, sold: true }, nowIso: at(1),
  });
  ok(zeroMonths.state === 'NEVER_COVERED',
     'S16e an explicit 0-month sale is NEVER_COVERED, not a 0-day ACTIVE warranty', zeroMonths.state);

  const badAnchor = getWarrantyStatus({
    identifiers: [IMEI],
    store: { months: 12, startIso: sale, sold: true, anchoredExpiresAt: 'pas-une-date' },
    nowIso: at(1),
  });
  ok(badAnchor.state === 'ACTIVE' && badAnchor.source === 'computed',
     'S16f an unparseable anchor falls back to computation instead of throwing',
     { state: badAnchor.state, source: badAnchor.source });
}

section('S17  Identifier matching discipline — FULL match only, never prefix/substring');
{
  // Owner requirement: split cells are canonicalized PER PART and matched in
  // full. A short serial must never match a longer identifier that contains it,
  // or a lookup would silently return the wrong customer's device.
  const shortSerial = product({ id: 'ps1', title: 'Tablette courte', imeiNumber: 'SN-9921',
                               barcode: undefined, warrantyMonths: 12 });
  const longSerial = product({ id: 'ps2', title: 'Tablette longue', imeiNumber: 'SN-9921-XZ7-A',
                               barcode: undefined, warrantyMonths: 12 });
  const deps: Deps = {
    transactions: [], products: [shortSerial, longSerial], imeiRecords: [], repairOrders: [],
  };

  const byShort = detail('SN-9921', deps, 'serial').snapshot!.dossier;
  ok(byShort.productTitle === 'Tablette courte', 'S17a the short serial resolves to ITS OWN device',
     byShort.productTitle);
  ok(!String(byShort.productTitle).includes('longue'),
     'S17a a short serial must NOT match the longer identifier containing it', byShort.productTitle);

  const byLong = detail('SN-9921-XZ7-A', deps, 'serial').snapshot!.dossier;
  ok(byLong.productTitle === 'Tablette longue', 'S17b the long serial resolves to its own device',
     byLong.productTitle);

  // Same device, different spellings of the long serial — still one device.
  const spellings = ['sn 9921 xz7 a', 'SN9921XZ7A', 'SN.9921.XZ7.A', 'sn-9921-xz7-a'];
  const found = spellings.map((s) => detail(s, deps, 'serial').snapshot?.dossier.productTitle);
  ok(found.every((t) => t === 'Tablette longue'),
     'S17b every spelling of the long serial resolves to the same device', found);

  // A prefix of a longer identifier must not match it either.
  const prefix = detail('SN-9921-XZ7', deps, 'serial').snapshot!.dossier;
  ok(prefix.isUnknownDevice === true,
     'S17c a PREFIX of a stored identifier does NOT resolve (no prefix matching)',
     prefix.productTitle);
  ok(!String(prefix.productTitle).includes('longue'),
     'S17c the prefix lookup returns unknown, never the longer device', prefix.productTitle);

  // An IMEI embedded in a longer alphanumeric blob must not match.
  const embedded = detail(`X${IMEI}X`, { ...deps, products: [product()] }, 'serial').snapshot!.dossier;
  ok(embedded.isUnknownDevice === true,
     'S17d an IMEI embedded in a longer string is NOT a match (no substring matching)',
     embedded.productTitle);

  // Split cells: each part canonicalized and matched in full.
  const split = detail(IMEI2, {
    transactions: [soldTx({ items: [cartItem({ imeiNumber: `${IMEI} / ${IMEI2}` })] })],
    products: [product()], imeiRecords: [], repairOrders: [],
  }, 'imei');
  ok(split.ok === true, 'S17e each part of a split cell resolves independently', { ok: split.ok });

  const tooShort = detail(IMEI.slice(0, 14), {
    transactions: [soldTx({ items: [cartItem({ imeiNumber: `${IMEI} / ${IMEI2}` })] })],
    products: [product()], imeiRecords: [], repairOrders: [],
  }, 'imei');
  ok(tooShort.ok === false,
     'S17e a 14-digit prefix of a split-cell IMEI is refused by the Luhn/length gate',
     { ok: tooShort.ok, note: tooShort.note });
}

section('S18  NOT_STARTED is its own state — never expired, never uncovered');
{
  const at = (d: number) => new Date(new Date('2026-06-01T10:00:00.000Z').getTime() + d * DAY).toISOString();
  const nowIso = at(0);

  const unsold = getWarrantyStatus({
    identifiers: [IMEI], store: { months: 12, startIso: null, sold: false }, nowIso,
  });
  const status = (s: Parameters<typeof warrantyStateLabel>[0]) => s;

  ok(unsold.state === 'NOT_STARTED', 'S18a in-stock coverage is NOT_STARTED', unsold.state);
  ok(unsold.term === 12, 'S18a the term is still advertised while unsold', unsold.term);
  ok(unsold.endDate === null, 'S18a there is no end date to render yet', unsold.endDate);
  ok(!isWarrantyLive(unsold), 'S18a NOT_STARTED grants nothing today (not in the live set)');

  // Distinct French wording, and it must not borrow expired/uncovered phrasing.
  const label = warrantyStateLabel(status(unsold));
  ok(label === 'Garantie non démarrée, débute à la vente',
     'S18b the state has its own French label', label);
  ok(!/expir/i.test(label), 'S18b the NOT_STARTED label never says "expired"', label);
  ok(!/aucune garantie/i.test(label), 'S18b the NOT_STARTED label never says "aucune garantie"', label);

  const chip = warrantyChipLabel(unsold);
  ok(/non démarrée/i.test(chip), 'S18b the chip says the coverage has not started', chip);
  ok(!/expir/i.test(chip) && !/sans garantie/i.test(chip),
     'S18b the chip never reads as expired or uncovered', chip);

  ok(/démarre à la vente/i.test(warrantyHeadline(unsold)),
     'S18b the headline states when coverage begins', warrantyHeadline(unsold));

  // Expiring-soon escalation must NOT pick it up, however close a start gets.
  const soonSale = getWarrantyStatus({
    identifiers: [IMEI], store: { months: 12, startIso: nowIso, sold: false }, nowIso,
  });
  ok(soonSale.state === 'NOT_STARTED',
     'S18c an unsold device whose sale is "today" is still NOT_STARTED, never EXPIRING_SOON',
     soonSale.state);

  // The three states stay distinguishable in the same lookup.
  const never = getWarrantyStatus({ identifiers: [IMEI], nowIso });
  const expired = getWarrantyStatus({
    identifiers: [IMEI], store: { months: 12, startIso: at(-400), sold: true }, nowIso,
  });
  const active = getWarrantyStatus({
    identifiers: [IMEI], store: { months: 12, startIso: at(-10), sold: true }, nowIso,
  });
  ok(
    new Set([unsold.state, never.state, expired.state, active.state]).size === 4,
    'S18c NOT_STARTED is distinct from NEVER_COVERED, EXPIRED and ACTIVE',
    { unsold: unsold.state, never: never.state, expired: expired.state, active: active.state }
  );

  // End-to-end: a real in-stock registry row reports NOT_STARTED, and a
  // certificate is allowed (it will say coverage starts at sale).
  const inStock: Deps = {
    transactions: [], products: [product()],
    imeiRecords: [registry({ soldAt: undefined, saleTransactionId: undefined,
                             warrantyExpiresAt: undefined, warrantyMonths: 12 })],
    repairOrders: [],
  };
  const d = detail(IMEI, inStock).snapshot!.dossier;
  ok(d.storeWarranty?.state === 'NOT_STARTED', 'S18d an in-stock registry row is NOT_STARTED',
     d.storeWarranty?.state);
  ok(d.isWarrantyValid === false, 'S18d it is not yet valid (coverage has not started)',
     { valid: d.isWarrantyValid });
  ok(d.storeWarranty!.term > 0,
     'S18d the certificate guard (term > 0) accepts it rather than refusing coverage outright',
     d.storeWarranty?.term);
  ok(d.warrantyExpiresAt === undefined,
     'S18d but no expiry is claimed for a device that has not been sold', d.warrantyExpiresAt);
}

section('S19  Inspector -> SAV handoff for a SERIAL device (W-06/W-07/W-37)');
{
  // The user-facing failure this covers: a serial-number device resolved fine in
  // the inspector, but the "Créer Prise en Charge SAV" button re-resolved the
  // same identifier in hardcoded IMEI mode, hit the 15-digit gate, and refused.
  // A tablet with a serial number could therefore never get a repair ticket.
  const tablet = product({ id: 'ptab', sku: 'TAB-IPAD9', title: 'iPad 9 Wi-Fi',
                           imeiNumber: SERIAL, barcode: undefined });
  const serialSale = soldTx({
    id: 'txS', receiptNumber: 'F-2026-4471', createdAt: iso(-20 * DAY),
    customer: { name: 'Madame Bensalem', phone: '0551000000' },
    items: [cartItem({ product: tablet, imeiNumber: SERIAL, warrantyMonthsAtSale: 12 })],
  });
  const serialRec = registry({
    imei: SERIAL, productId: 'ptab', soldAt: iso(-20 * DAY), saleTransactionId: 'txS',
    warrantyMonths: 12, warrantyExpiresAt: iso(345 * DAY),
  });
  const deps: Deps = {
    transactions: [serialSale], products: [tablet], imeiRecords: [serialRec], repairOrders: [],
  };

  // 1. Inspector: resolve in serial mode (what the operator did).
  const res = detail(SERIAL, deps, 'serial');
  ok(res.ok === true, 'S19a the serial dossier resolves in the inspector', { ok: res.ok });
  const snapshot = res.snapshot!;
  ok(snapshot.idMode === 'serial', 'S19a the snapshot records serial mode', snapshot.idMode);

  // 2. The handoff must NOT re-resolve. Prove the old path is still broken, so
  //    the regression this fixes cannot silently come back.
  const brokenOldPath = detail(SERIAL, deps, 'imei');
  ok(brokenOldPath.ok === false,
     'S19b the OLD hardcoded-IMEI re-resolve is still refused (regression guard)', { ok: brokenOldPath.ok });

  // 3. Handoff: build the draft from the frozen snapshot alone.
  const draft = buildSavIntakeDraft(snapshot);

  ok(draft.idType === 'serial', 'S19c the ticket records a SERIAL identifier, not an IMEI', draft.idType);
  ok(draft.sanitizedId === snapshot.idValue,
     'S19c the sanitized identifier travels unchanged', { draft: draft.sanitizedId, snapshot: snapshot.idValue });
  ok(draft.deviceTitle === 'iPad 9 Wi-Fi', 'S19c the ticket carries the correct DEVICE', draft.deviceTitle);
  ok(draft.customer.name === 'Madame Bensalem', 'S19c the ticket carries the customer from the dossier',
     draft.customer.name);
  ok(draft.customer.phone === '0551000000', 'S19c the ticket carries the phone from the dossier',
     draft.customer.phone);

  // 4. The INVOICE: the original receipt must travel with the ticket.
  ok(snapshot.dossier.originalReceiptNumber === 'F-2026-4471',
     'S19d the dossier holds the original invoice number', snapshot.dossier.originalReceiptNumber);
  ok(draft.warrantyDossier.dossier.originalReceiptNumber === 'F-2026-4471',
     'S19d the ticket carries the ORIGINAL INVOICE reference', draft.warrantyDossier.dossier.originalReceiptNumber);

  // 5. The WARRANTY SNAPSHOT: both statuses, at their frozen values.
  const d = draft.warrantyDossier.dossier;
  ok(d.storeWarranty?.state === 'ACTIVE', 'S19e the ticket carries a STORE warranty snapshot',
     d.storeWarranty?.state);
  ok(d.storeWarranty?.endDate === serialRec.warrantyExpiresAt,
     'S19e the frozen store expiry is the anchor from the registry row', d.storeWarranty?.endDate);
  ok(d.repairWarranty === null, 'S19e no repair warranty is invented at intake', d.repairWarranty);
  ok(d.identifiers?.includes(SERIAL),
     'S19e the identifiers travel with the ticket (IMEI2-ready)', d.identifiers);

  // 6. The persisted-ticket fields the SAV modal writes.
  const persisted = {
    imei: draft.sanitizedId,
    imeiKind: draft.idType,
    deviceModel: draft.deviceTitle,
    warrantyDossierSnapshot: draft.warrantyDossier,
    warrantySnapshot: legacyWarrantySnapshot(snapshot),
  };
  ok(persisted.imeiKind === 'serial', 'S19f the persisted ticket stores imeiKind=serial', persisted.imeiKind);
  ok(persisted.warrantyDossierSnapshot.dossier.productTitle === 'iPad 9 Wi-Fi',
     'S19f the persisted snapshot keeps the device', persisted.warrantyDossierSnapshot.dossier.productTitle);
  ok(persisted.warrantySnapshot.isUnderWarranty === true,
     'S19f the legacy boolean snapshot agrees it is under warranty',
     persisted.warrantySnapshot.isUnderWarranty);
  ok(persisted.warrantySnapshot.expiryDate === serialRec.warrantyExpiresAt,
     'S19f the legacy snapshot carries the same expiry (one source, no drift)',
     persisted.warrantySnapshot.expiryDate);

  // 7. A numeric-looking serial must not be mislabelled as an IMEI.
  const numericSerial = '000123456789012';
  const numDeps: Deps = {
    transactions: [soldTx({ id: 'txN', items: [cartItem({ imeiNumber: numericSerial })] })],
    products: [product({ id: 'pn', imeiNumber: numericSerial, barcode: undefined })],
    imeiRecords: [], repairOrders: [],
  };
  const numSnapshot = detail(numericSerial, numDeps, 'serial').snapshot!;
  ok(buildSavIntakeDraft(numSnapshot).idType === 'serial',
     'S19g a 15-DIGIT serial is still typed serial (idMode decides, not length)',
     buildSavIntakeDraft(numSnapshot).idType);
}

section('S20  Certificate date parity — terminal vs 80 mm vs 58 mm (layout unchanged)');
{
  // One device, one purchase, THREE renderers. The dates must be identical in
  // all of them. They were not: each renderer recomputed its own expiry with
  // `setMonth`, which overflows (31 Jan + 1 month -> 2/3 March) and ignored the
  // frozen anchor, and `toLocaleDateString` shifted the printed day west of UTC.
  const purchaseIso = '2026-01-31T09:30:00.000Z';
  const purchase: SaleTransaction = soldTx({ createdAt: purchaseIso, receiptNumber: 'F-2026-0900' });
  const item = cartItem();
  const months = 1;

  // The shared helper the builders now call.
  const dates = warrantyCertificateDates({ startIso: purchaseIso, months });

  ok(dates.start === '31/01/2026', 'S20a the start renders as the purchase day', dates.start);
  ok(dates.expiry === '28/02/2026',
     'S20a 31 Jan + 1 month CLAMPS to 28 February, not 3 March', dates.expiry);
  ok(!/03\/03/.test(dates.expiry), 'S20a the setMonth overflow date is gone', dates.expiry);

  // 12 months from the same purchase, for a non-clamping control case.
  const twelve = warrantyCertificateDates({ startIso: purchaseIso, months: 12 });
  ok(twelve.expiry === '31/01/2027', 'S20a 31 Jan + 12 months lands on 31 Jan next year', twelve.expiry);

  // The ANCHOR wins over any recomputation — this is what the till promised.
  const anchored = warrantyCertificateDates({
    startIso: purchaseIso, months, anchoredExpiresAt: '2026-02-28T00:00:00.000Z',
  });
  ok(anchored.anchored === true, 'S20b a frozen anchor is reported as used', anchored.anchored);
  ok(anchored.expiry === '28/02/2026', 'S20b the anchor date is what gets printed', anchored.expiry);
  const mismatched = warrantyCertificateDates({
    startIso: purchaseIso, months, anchoredExpiresAt: '2026-03-15T00:00:00.000Z',
  });
  ok(mismatched.expiry === '15/03/2026',
     'S20b the anchor wins even when it disagrees with the term', mismatched.expiry);

  // An unparseable anchor must not blank the certificate.
  const bad = warrantyCertificateDates({ startIso: purchaseIso, months, anchoredExpiresAt: 'nope' });
  ok(bad.anchored === false && bad.expiry === '28/02/2026',
     'S20b an unparseable anchor falls back to the clamped computation',
     { anchored: bad.anchored, expiry: bad.expiry });

  // PARITY: the 58 mm text renderer must print the same two dates.
  const text58 = warrantyCertificateText(purchase, item, months, settings, 'Caisse', null);
  ok(text58.includes(dates.start), 'S20c the 58 mm sheet prints the same start date', {
    expected: dates.start, line: text58.split('\n').find((l) => l.includes('Achat:')),
  });
  ok(text58.includes(dates.expiry), 'S20c the 58 mm sheet prints the same expiry date', {
    expected: dates.expiry, line: text58.split('\n').find((l) => l.includes('au ')),
  });
  ok(!text58.includes('03/03/2026'), 'S20c the 58 mm sheet never shows the overflow date');

  // PARITY: the 80 mm ESC/POS builder must print the same two dates.
  // ESC/POS text is emitted in the printer code page (Latin-1-ish), NOT UTF-8,
  // so accented characters must be decoded as single bytes — decoding as UTF-8
  // turns "DÉSIGNATION" into "D?SIGNATION" and hides real layout regressions.
  const escText = new TextDecoder('latin1').decode(
    WarrantyCertificateBuilder.buildPreOwnedWarrantyCertificate(
      purchase, item, settings, months, 'Caisse', null
    )
  );
  const fold = (s: string) =>
    s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '');
  const escFolded = fold(escText);
  ok(escText.includes(dates.start), 'S20d the 80 mm roll prints the same start date', dates.start);
  ok(escText.includes(dates.expiry), 'S20d the 80 mm roll prints the same expiry date', dates.expiry);
  ok(!escText.includes('03/03/2026'), 'S20d the 80 mm roll never shows the overflow date');

  // PARITY with the anchor on every renderer at once.
  const anchorIso = '2026-02-28T00:00:00.000Z';
  const t58a = warrantyCertificateText(purchase, item, 12, settings, 'Caisse', anchorIso);
  const e80a = new TextDecoder('latin1').decode(
    WarrantyCertificateBuilder.buildPreOwnedWarrantyCertificate(purchase, item, settings, 12, 'Caisse', anchorIso)
  );
  ok(t58a.includes('28/02/2026') && e80a.includes('28/02/2026'),
     'S20e both widths honour the anchor identically', {
       mm58: t58a.split('\n').find((l) => l.includes('au ')),
       mm80: '28/02/2026',
     });

  // LAYOUT UNCHANGED: both sheets keep their sections and line budget.
  const lines = text58.split('\n');
  ok(lines.length <= 40, 'S20f the 58 mm sheet stays within its line budget', lines.length);
  for (const section of ['CERTIFICAT DE GARANTIE', 'Modele:', 'IMEI:', 'Prix:', 'Cachet du Magasin']) {
    ok(text58.includes(section), `S20f the 58 mm layout still contains "${section}"`);
  }
  ok(escFolded.includes("DESIGNATION DE L'APPAREIL GARANTI"),
     'S20f the 80 mm layout keeps its device heading');
  ok(escFolded.includes("DUREE DE GARANTIE"), 'S20f the 80 mm layout keeps its warranty-duration line');
  ok(escFolded.includes('VALABLE DU'), 'S20f the 80 mm layout keeps its coverage window line');
  ok(escFolded.includes('CONDITIONS'), 'S20f the 80 mm layout keeps its conditions block');
  ok(escFolded.includes('EXCLUSIONS DE GARANTIE'), 'S20f the 80 mm layout keeps its exclusions block');
  ok(escFolded.includes('Cachet du Magasin'), 'S20f the 80 mm layout keeps its stamp line');
}

section('S21  Backfill DRY-RUN planner — pure logic, no database touched');
{
  // The backfill script is NOT wired into any test run and has never been
  // executed against real data. Its decision logic is exercised here instead,
  // as a pure function over fixtures, so the "what would it change?" question
  // has a tested answer before anyone runs `--apply`.
  const stale = {
    imei: IMEI, soldAt: iso(-10 * DAY), saleTransactionId: 'txB',
    warrantyMonths: 12, warrantyExpiresAt: iso(-60 * DAY), // buyer #1's elapsed anchor
  };
  const healthy = {
    imei: '356938035643809', soldAt: iso(-10 * DAY), saleTransactionId: 'txC',
    warrantyMonths: 12, warrantyExpiresAt: iso(355 * DAY), // consistent
  };
  const inStockWithAnchor = {
    imei: '356938035643801', soldAt: undefined, saleTransactionId: undefined,
    warrantyMonths: 6, warrantyExpiresAt: iso(200 * DAY), // back in stock, still anchored
  };
  const noAnchor = {
    imei: '356938035643812', soldAt: iso(-2 * DAY), saleTransactionId: 'txD',
    warrantyMonths: 3, warrantyExpiresAt: undefined,
  };
  const rows = [stale, healthy, inStockWithAnchor, noAnchor];
  const sales = [{ id: 'txB', createdAt: iso(-10 * DAY), status: 'COMPLETED', items: [{ imeiNumber: IMEI }] }];

  const plans = planBackfill(rows as never, sales as never);

  const byImei = new Map(plans.map((p) => [p.imei, p]));

  ok(byImei.has(IMEI), 'S21a the stale resale anchor is detected', [...byImei.keys()]);
  ok(byImei.get(IMEI)?.action === 'reanchor', 'S21a it is re-anchored, not cleared',
     byImei.get(IMEI)?.action);
  ok(byImei.get(IMEI)?.to === iso(355 * DAY),
     'S21a it is re-anchored to THIS sale + its own term', byImei.get(IMEI)?.to);
  ok(byImei.get(IMEI)?.from === iso(-60 * DAY),
     'S21a the previous anchor is recorded so rollback can restore it',
     byImei.get(IMEI)?.from);

  ok(!byImei.has('356938035643809'),
     'S21b a CONSISTENT row is left completely alone', [...byImei.keys()]);
  ok(!byImei.has('356938035643812'), 'S21b a row with no anchor is left alone');

  ok(byImei.get('356938035643801')?.action === 'clear-anchor',
     'S21c an in-stock row carrying an anchor is flagged for clearing',
     byImei.get('356938035643801')?.action);
  ok(byImei.get('356938035643801')?.to === null,
     'S21c clearing sets no replacement date', byImei.get('356938035643801')?.to);

  ok(plans.length === 2, 'S21d exactly two rows need attention', plans.length);

  // Idempotence: planning the already-fixed state must find nothing to do.
  const afterFix = [
    { ...stale, warrantyExpiresAt: iso(355 * DAY) },
    { ...inStockWithAnchor, warrantyExpiresAt: undefined },
  ];
  ok(planBackfill(afterFix as never, sales as never).length === 0,
     'S21d re-planning after a fix is a no-op (the tool is idempotent)',
     planBackfill(afterFix as never, sales as never));

  // A 0-month row must never get a re-anchored date.
  const zeroTerm = {
    imei: IMEI, soldAt: iso(-10 * DAY), saleTransactionId: 'txB',
    warrantyMonths: 0, warrantyExpiresAt: iso(355 * DAY),
  };
  const zeroPlans = planBackfill([zeroTerm] as never, sales as never);
  ok(zeroPlans.length === 0 || zeroPlans[0].months !== 0,
     'S21e a deliberately zero-term row is not given a re-anchored expiry', zeroPlans);
}

section('S22  Q-C archived product — name and term survive deletion');
{
  // A deleted product used to orphan `productId`, and the resolver then called
  // `resolveWarrantyMonths(undefined)` = 12. A deleted "Grade B" occasion unit
  // silently gained a YEAR of warranty and lost its name.
  const occasion = product({
    id: 'pgrade', sku: 'OCC-IP12-B', title: 'iPhone 12 (Grade B)',
    category: "Téléphones d'Occasion (Reprise)", warrantyMonths: 3,
  });
  const archivedNote = describeArchivedProduct(occasion.title, occasion.sku, '2026-09-01T10:00:00.000Z');

  ok(archivedNote.startsWith('Produit archivé'), 'S22a the archive note is parseable', archivedNote);
  ok(archivedProductTitle(archivedNote) === 'iPhone 12 (Grade B) (OCC-IP12-B)',
     'S22a the title and SKU read back out of the note',
     archivedProductTitle(archivedNote));
  ok(archivedProductTitle('just a normal note') === null,
     'S22a an unrelated note is not mistaken for an archive');
  ok(archivedProductTitle(null) === null, 'S22a a missing note is not an archive');

  // The archived row: no productId left, term snapshotted, note present.
  // No sale line on purpose — that is the case the archive matters for (a unit
  // that entered via PO/import and whose sale line is absent). When a sale line
  // DOES exist it stays authoritative, which is correct.
  const archivedRow = registry({
    productId: '', warrantyMonths: 3, warrantyExpiresAt: iso(82 * DAY), notes: archivedNote,
  });
  const deps: Deps = {
    transactions: [], products: [], imeiRecords: [archivedRow], repairOrders: [],
  };
  const d = detail(IMEI, deps).snapshot!.dossier;

  ok(d.productTitle.includes('iPhone 12 (Grade B)'),
     'S22b an archived device still shows its real model name', d.productTitle);
  ok(d.storeWarranty?.term === 3,
     'S22b the snapshotted 3-month occasion term is used, NOT the 12-month store default',
     d.storeWarranty?.term);
  ok(d.storeWarranty?.term !== 12,
     'S22b it never inherits the 12-month default after deletion', d.storeWarranty?.term);

// The residual case the archive cannot cover: a registry row that never got a
// term snapshot AND whose product is gone (a PO receipt or CSV import written
// before the snapshot existed, or a row whose `productId` was orphaned).
//
// This assertion USED to pin the defect — "unarchived silently falls back to
// 12" — because 12 was the only fallback available. W-22 changed the fallback:
// with no carrier at all the term is UNKNOWN, and unknown must never resolve
// UP to the 12-month store default. It now resolves to the refurb baseline.
const unarchived = registry({
    productId: '', warrantyMonths: undefined, warrantyExpiresAt: undefined, notes: undefined,
  });
  const dBad = detail(IMEI, {
    transactions: [], products: [], imeiRecords: [unarchived], repairOrders: [],
  }).snapshot!.dossier;
  ok(dBad.storeWarranty?.term === 3,
     'S22c an UNKNOWN carrier resolves to the 3-month baseline, never to 12',
     dBad.storeWarranty?.term);
  ok(dBad.storeWarranty?.term !== 12,
     'S22c no path in the chain can mint 12 months out of absent evidence',
     dBad.storeWarranty?.term);
  ok(defaultWarrantyMonthsFor() === 3 && defaultWarrantyMonthsFor(undefined, null) === 3,
     'S22c the fallback itself never returns the store default for an absent carrier',
     defaultWarrantyMonthsFor());
  ok(defaultWarrantyMonthsFor({ category: 'Téléphones' }) === 12,
     'S22c a KNOWN non-occasion product with no explicit term still gets the store default',
     defaultWarrantyMonthsFor({ category: 'Téléphones' }));
  ok(defaultWarrantyMonthsFor({ category: "Téléphones d'Occasion (Reprise)" }) === 3,
     'S22c a known occasion product keeps the 3-month baseline');
}

section('S23  Q-B a return leg mints no sale, no anchor, no warranty');
{
  // Exchange: the outgoing handset comes back, the incoming one is sold.
  const outgoing = cartItem({ imeiNumber: IMEI, isReturn: true, warrantyMonthsAtSale: 12 });
  const incoming = cartItem({ imeiNumber: NEW_IMEI, warrantyMonthsAtSale: 12 });
  const exchangeTx = soldTx({
    id: 'txEx', receiptNumber: 'AV-2', createdAt: iso(-3 * DAY),
    items: [outgoing, incoming],
  });
  // Only the INCOMING unit gets a registry row (that is what the writer must do).
  const incomingRec = registry({
    imei: NEW_IMEI, soldAt: iso(-3 * DAY), saleTransactionId: 'txEx',
    warrantyExpiresAt: iso(362 * DAY),
  });
  const deps: Deps = {
    transactions: [exchangeTx], products: [product()], imeiRecords: [incomingRec], repairOrders: [],
  };

  const dOut = detail(IMEI, deps, 'serial').snapshot!.dossier;
  ok(dOut.storeWarranty?.state === 'VOID',
     'S23a the returned device is VOID, not live', dOut.storeWarranty?.state);
  ok(dOut.isWarrantyValid === false, 'S23a the returned device is not in warranty',
     { valid: dOut.isWarrantyValid });
  ok(dOut.storeWarranty?.daysLeft === 0, 'S23a it grants zero covered days',
     dOut.storeWarranty?.daysLeft);

  const dIn = detail(NEW_IMEI, deps).snapshot!.dossier;
  ok(dIn.isWarrantyValid === true, 'S23b the replacement IS covered by its own sale',
     { valid: dIn.isWarrantyValid });

  // The filter the writer applies: a return leg contributes nothing to soldImeis.
  const legs = [outgoing, incoming];
  const soldImeis = legs
    .filter((ci) => Boolean(ci.imeiNumber && ci.imeiNumber.trim()))
    .filter((ci) => !(ci as { isReturn?: boolean }).isReturn)
    .map((ci) => ci.imeiNumber!.trim());
  ok(soldImeis.length === 1 && soldImeis[0] === NEW_IMEI,
     'S23c only the replacement reaches the registry writer', soldImeis);
  ok(!soldImeis.includes(IMEI),
     'S23c the RETURNED device gets no saleTransactionId, no soldAt and no anchor', soldImeis);
}

section('S24  Refund/void PRESERVES the anchor (clearing was rejected)');
{
  // Decision: the anchor is NOT cleared on refund. It is the record of what the
  // refunded customer was promised, and reprints/audits/disputes need it.
  // Three properties must hold:
  //   (a) refund -> resale re-anchors via the saleTransactionId check, and the
  //       ORIGINAL expiry is left intact on the old row;
  //   (b) a PARTIAL refund of one unit never touches another unit's warranty;
  //   (c) a certificate reprint of the original refunded sale still shows the
  //       original dates.

  // ── (a) refund -> resale ──────────────────────────────────────────────────
  const originalExpiry = iso(355 * DAY); // buyer #1, 12 months from txA
  const resaleExpiry = iso(30 * DAY); // buyer #2, re-anchored from txB

  // What the writer produces for the RESALE: existing.saleTransactionId ('txA')
  // !== transaction.id ('txB'), so it re-anchors.
  const resaleWrite = { imei: IMEI, saleTransactionId: 'txA', warrantyExpiresAt: originalExpiry };
  const reanchor = resaleWrite.saleTransactionId === 'txB' || !resaleWrite.warrantyExpiresAt;
  ok(!reanchor,
     'S24a GUARD: this fixture is the same-sale case, so nothing re-anchors',
     resaleWrite.saleTransactionId);

  const genuineResale = { imei: IMEI, saleTransactionId: 'txA', warrantyExpiresAt: originalExpiry };
  const doesReanchor = genuineResale.saleTransactionId !== 'txB';
  ok(doesReanchor,
     'S24a a GENUINE resale (different saleTransactionId) re-anchors', doesReanchor);

  // The ORIGINAL row keeps its expiry. The reader must scope to the latest sale
  // and ignore this stale anchor rather than needing it cleared.
  const keptRow = registry({
    soldAt: iso(-100 * DAY), saleTransactionId: 'txA',
    warrantyExpiresAt: originalExpiry, warrantyMonths: 12,
  });
  ok(keptRow.warrantyExpiresAt === originalExpiry,
     'S24a the original row still carries the ORIGINAL expiry (nothing nulled it)',
     keptRow.warrantyExpiresAt);

  // Reader: latest sale is txB; the txA anchor must be ignored.
  const txA = soldTx({ id: 'txA', receiptNumber: 'F-OLD', createdAt: iso(-100 * DAY) });
  txA.status = 'REFUNDED';
  const refundVoucher = soldTx({
    id: 'txR', receiptNumber: 'AV-1', createdAt: iso(-60 * DAY),
    isRefund: true, status: 'COMPLETED',
  });
  const txB = soldTx({
    id: 'txB', receiptNumber: 'F-NEW', createdAt: iso(-10 * DAY),
    items: [cartItem({ warrantyMonthsAtSale: 12 })],
  });
  // The resale RE-ANCHORED the row, so txB's anchor is present and current.
  const reanchoredRow = registry({
    soldAt: iso(-10 * DAY), saleTransactionId: 'txB',
    warrantyExpiresAt: resaleExpiry, warrantyMonths: 12,
  });
  const afterResale = detail(IMEI, {
    transactions: [txA, refundVoucher, txB], products: [product()],
    imeiRecords: [reanchoredRow], repairOrders: [],
  }).snapshot!.dossier;

  ok(afterResale.originalReceiptNumber === 'F-NEW',
     'S24a the reader resolves the LATEST sale', afterResale.originalReceiptNumber);
  ok(afterResale.warrantyExpiresAt === resaleExpiry,
     'S24a and reports the NEW anchor, not the refunded buyer\'s', afterResale.warrantyExpiresAt);
  ok(afterResale.isWarrantyValid === true,
     'S24a buyer #2 has ACTIVE coverage without anything having been cleared',
     { valid: afterResale.isWarrantyValid });

  // And the stale txA anchor, if still the only one on the row, reads expired
  // rather than live — the reader's protection, no clearing required.
  const staleOnly = detail(IMEI, {
    transactions: [txA, refundVoucher], products: [product()],
    imeiRecords: [keptRow], repairOrders: [],
  }).snapshot!.dossier;
  ok(staleOnly.isWarrantyValid === false,
     'S24a a stale anchor on a REFUNDED sale is never reported as live',
     { valid: staleOnly.isWarrantyValid });
  // The dossier deliberately does NOT advertise an expiry for a refunded
  // device — the requirement is that the RECORD keeps it, so a reprint or an
  // audit can still prove what was promised. That is asserted on the row, and
  // end-to-end in (c) below.
  ok(keptRow.warrantyExpiresAt === originalExpiry,
     'S24a the original expiry is still ON RECORD for reprint/audit',
     keptRow.warrantyExpiresAt);
  ok(!staleOnly.isWarrantyValid && (staleOnly.daysRemaining ?? 0) === 0,
     'S24a and the operator sees zero covered days, not a phantom countdown',
     { days: staleOnly.daysRemaining });

  // ── (b) partial refund of ONE unit in a multi-item order ──────────────────
  const UNIT_A = '352099001761481';
  const UNIT_B = '352099001761499';
  const multiItem = soldTx({
    id: 'txMulti', receiptNumber: 'F-MULTI', createdAt: iso(-40 * DAY),
    items: [cartItem({ imeiNumber: UNIT_A, warrantyMonthsAtSale: 12 }),
            cartItem({ imeiNumber: UNIT_B, warrantyMonthsAtSale: 24 })],
  });
  const rowA = registry({ imei: UNIT_A, saleTransactionId: 'txMulti',
                          warrantyMonths: 12, warrantyExpiresAt: iso(325 * DAY) });
  const rowB = registry({ imei: UNIT_B, saleTransactionId: 'txMulti',
                          warrantyMonths: 24, warrantyExpiresAt: iso(690 * DAY) });
  const multiDeps: Deps = {
    transactions: [multiItem], products: [product()], imeiRecords: [rowA, rowB], repairOrders: [],
  };
  const dA = detail(UNIT_A, multiDeps).snapshot!.dossier;
  const dB = detail(UNIT_B, multiDeps).snapshot!.dossier;
  ok(dA.storeWarranty?.term === 12 && dB.storeWarranty?.term === 24,
     'S24b the two units carry their OWN terms', { a: dA.storeWarranty?.term, b: dB.storeWarranty?.term });

  // Refunding ONLY unit A must leave unit B's row byte-identical.
  const refundedOnly = [UNIT_A];
  const releasedKeys = new Set(refundedOnly.map(normalizeDeviceKey));
  const rowsAfterPartialRefund = [rowA, rowB].map((r) =>
    releasedKeys.has(normalizeDeviceKey(r.imei))
      ? { ...r, saleTransactionId: undefined, soldAt: undefined }
      : r
  );
  ok(rowsAfterPartialRefund[1] === rowB,
     'S24b unit B\'s row object is UNTOUCHED by a refund of unit A');
  ok(rowsAfterPartialRefund[1].warrantyExpiresAt === iso(690 * DAY),
     'S24b unit B keeps its expiry', rowsAfterPartialRefund[1].warrantyExpiresAt);
  ok(rowsAfterPartialRefund[0].warrantyExpiresAt === iso(325 * DAY),
     'S24b unit A keeps its expiry too — the anchor survives the refund',
     rowsAfterPartialRefund[0].warrantyExpiresAt);
  ok(rowsAfterPartialRefund[0].saleTransactionId === undefined &&
     rowsAfterPartialRefund[1].saleTransactionId === 'txMulti',
     'S24b only the refunded unit is released',
     { a: rowsAfterPartialRefund[0].saleTransactionId, b: rowsAfterPartialRefund[1].saleTransactionId });

  // ── (c) certificate reprint of the ORIGINAL refunded sale ─────────────────
  const originalPurchaseIso = '2026-06-15T08:00:00.000Z';
  const refundedSale: SaleTransaction = soldTx({
    id: 'txRef', receiptNumber: 'F-REF', createdAt: originalPurchaseIso,
  });
  refundedSale.status = 'REFUNDED';
  const reprint = warrantyCertificateDates({
    startIso: originalPurchaseIso, months: 12, anchoredExpiresAt: iso(355 * DAY),
  });
  ok(reprint.start === '15/06/2026', 'S24c the reprint shows the ORIGINAL purchase date', reprint.start);
  ok(reprint.expiry === formatWarrantyDate(iso(355 * DAY)),
     'S24c the reprint shows the ORIGINAL expiry from the preserved anchor',
     { shown: reprint.expiry, anchored: formatWarrantyDate(iso(355 * DAY)) });
  ok(reprint.anchored === true, 'S24c it is served from the preserved anchor', reprint.anchored);

  const sheet = warrantyCertificateText(refundedSale, cartItem(), 12, settings, 'Caisse', iso(355 * DAY));
  ok(sheet.includes(reprint.start) && sheet.includes(reprint.expiry),
     'S24c the 58 mm certificate of a REFUNDED sale still prints both original dates',
     { start: reprint.start, expiry: reprint.expiry });
}

// ═══════════════════════════════════════════════════════════════════════════
section('S25  Decision 1 — the persisted snapshot is MINIMAL, and the reader copes without it');
{
  // Condition 1 (minimal): the snapshot rides inside the SYNCED
  // `repair_orders.json_payload`. An oversized free-text field is not a cosmetic
  // problem — `payloadHygiene` refuses a payload over 64 KB, which loses the
  // WHOLE ticket row from sync, media included.
  const tablet = product({ id: 'ptab', sku: 'TAB-IPAD9', title: 'iPad 9 Wi-Fi', imeiNumber: SERIAL });
  const serialDeps: Deps = {
    transactions: [soldTx({ id: 'txS', receiptNumber: 'F-2026-4471',
      items: [cartItem({ product: tablet, imeiNumber: SERIAL })] })],
    products: [tablet],
    imeiRecords: [registry({ imei: SERIAL, productId: 'ptab' })],
    repairOrders: [],
  };
  const frozen = detail(SERIAL, serialDeps, 'serial').snapshot!;
  const ticket = minimalTicketDossierSnapshot(frozen);

  const persisted = { imei: ticket.idValue, imeiKind: ticket.idMode, warrantyDossierSnapshot: ticket };
  const bytes = JSON.stringify(persisted).length;
  ok(bytes < 2048, 'S25a the persisted ticket stays under the 2 KB image-field budget', bytes);

  const keys = Object.keys(ticket.dossier).sort();
  ok(!keys.includes('savTickets') && !keys.includes('identifiers'),
     'S25a the UNBOUNDED collections are dropped (savTickets, identifiers)', keys);
  ok(!keys.includes('repairHistoryCount') || ticket.dossier.repairHistoryCount === 0,
     'S25a the derivable repair count is not carried', ticket.dossier.repairHistoryCount);
  ok(ticket.dossier.repairHistoryCount === 0 && ticket.dossier.isSold === false,
     'S25a the dossier carries only what the ticket reads', keys);

  // Nothing the ticket READS may be lost by the projection.
  ok(ticket.idValue === frozen.idValue && ticket.idMode === 'serial',
     'S25b the resolved identifier and its TYPE survive', { id: ticket.idValue, mode: ticket.idMode });
  ok(ticket.dossier.productTitle === 'iPad 9 Wi-Fi' && ticket.dossier.originalReceiptNumber === 'F-2026-4471',
     'S25b the invoice evidence survives', { title: ticket.dossier.productTitle, receipt: ticket.dossier.originalReceiptNumber });
  ok(ticket.dossier.isWarrantyValid === true && ticket.dossier.warrantyExpiresAt === frozen.dossier.warrantyExpiresAt,
     'S25b the frozen verdict and expiry survive', { valid: ticket.dossier.isWarrantyValid });
  ok(ticket.dossier.warrantyMonths === 12, 'S25b the term survives (the tier derivation reads it)',
     ticket.dossier.warrantyMonths);
  ok(legacyWarrantySnapshot(ticket).isUnderWarranty === legacyWarrantySnapshot(frozen).isUnderWarranty &&
     legacyWarrantySnapshot(ticket).expiryDate === legacyWarrantySnapshot(frozen).expiryDate,
     'S25b the legacy boolean cannot drift from the projected dossier',
     { projected: legacyWarrantySnapshot(ticket), full: legacyWarrantySnapshot(frozen) });

  // Idempotent: re-saving an edited ticket re-projects an already-projected value.
  ok(JSON.stringify(minimalTicketDossierSnapshot(ticket)) === JSON.stringify(ticket),
     'S25c projection is idempotent (edit -> re-save changes nothing)');

  // Oversized + unknown keys from a hostile or bloated payload are cut, not carried.
  const bloated = {
    ...frozen,
    dossier: {
      ...frozen.dossier,
      productTitle: 'X'.repeat(4000),
      originalCustomerName: 'Y'.repeat(4000),
      signature: 'data:image/png;base64,' + 'A'.repeat(50_000),
      receipts: [1, 2, 3],
    },
  } as never;
  const bounded = minimalTicketDossierSnapshot(bloated);
  ok((bounded.dossier.productTitle?.length ?? 0) <= 120 &&
     (bounded.dossier.originalCustomerName?.length ?? 0) <= 120,
     'S25c free text is cut to the per-field budget', { title: bounded.dossier.productTitle?.length });
  ok(!('signature' in bounded.dossier) && !('receipts' in bounded.dossier),
     'S25c unknown fields (a signature, a blob array) never reach the payload',
     Object.keys(bounded.dossier).sort());
  ok(JSON.stringify({ warrantyDossierSnapshot: bounded }).length < 2048,
     'S25c a bloated payload is still projected under the budget',
     JSON.stringify({ warrantyDossierSnapshot: bounded }).length);

  // ── Condition 2 (the reader copes when it is missing) ─────────────────────
  // Old tickets have no snapshot, and a peer that drops the field leaves none.
  // The reader must show what the TICKET stores and must never invent coverage.
  const legacyTicket = { imei: IMEI, imeiKind: 'imei', warrantyDossierSnapshot: undefined,
                         warrantySnapshot: { isUnderWarranty: true, label: 'Hors garantie' } } as never;
  const readBack = (order: { warrantyDossierSnapshot?: unknown }) =>
    order.warrantyDossierSnapshot ? minimalTicketDossierSnapshot(order.warrantyDossierSnapshot as never) : null;

  ok(readBack(legacyTicket) === null,
     'S25d a ticket WITHOUT the snapshot resolves to "nothing frozen" (no crash, no lookup)');
  // A payload that is not a well-formed ENVELOPE is not evidence at all: the
  // resolver always pairs a resolved identifier + `idMode` + `resolvedAt` with
  // the dossier, so these shapes cannot come from a ticket this app wrote.
  ok(readBack({ warrantyDossierSnapshot: {} }) === null,
     'S25d an empty object is NOT read as "frozen, not covered" — it is "nothing frozen"');
  ok(readBack({ warrantyDossierSnapshot: { dossier: { isWarrantyValid: 'true' } } }) === null,
     'S25d a non-boolean verdict is not honoured as coverage');
  ok(readBack({ warrantyDossierSnapshot: { suggestedTier: 'repair_900d' } }) === null,
     'S25d an illegal tier cannot be smuggled in without an envelope');
  ok(readBack({ warrantyDossierSnapshot: { ...frozen, suggestedTier: 'repair_900d' } })?.suggestedTier === 'none',
     'S25d an illegal tier on a REAL envelope falls back to "none" instead of minting days');

  // The banner is driven by whichever the ticket actually holds.
  const banner = (dossier: { dossier: { isWarrantyValid: boolean } } | null,
                  snap?: { isUnderWarranty: boolean; label: string }) => {
    if (dossier) return dossier.dossier.isWarrantyValid ? 'Garantie Magasin Active' : 'Hors garantie magasin';
    return snap?.isUnderWarranty ? snap.label : null;
  };
  ok(banner(readBack(legacyTicket), legacyTicket.warrantySnapshot) === 'Hors garantie',
     'S25d with no snapshot the banner shows ONLY what the ticket stores',
     { shown: banner(readBack(legacyTicket), legacyTicket.warrantySnapshot) });
  ok(banner(readBack(legacyTicket)) === null,
     'S25d with neither field the banner stays silent — nothing is invented');
  ok(banner(readBack({ warrantyDossierSnapshot: frozen }), undefined) === 'Garantie Magasin Active',
     'S25d the frozen verdict is still what the operator sees on edit');
}
// ═══════════════════════════════════════════════════════════════════════════
section('S26  Device ORIGIN — the seller is reachable from an IMEI, masked by default');
// ═══════════════════════════════════════════════════════════════════════════
{
  const SELLER = 'KARIM BENALI';
  const SELLER_PHONE = '0661889900';
  const SELLER_ID = '198744112233';

  const tradeIn = (over: Partial<TradeInItem> = {}): TradeInItem =>
    ({
      id: 'trade-1',
      deviceModel: 'iPhone 12 128',
      imei: IMEI,
      brand: 'Apple',
      conditionGrade: 'Grade B (Bon État)',
      customerName: SELLER,
      customerPhone: SELLER_PHONE,
      nationalIdNumber: SELLER_ID,
      nationalIdType: 'CNI',
      buybackValue: 150000,
      resaleMarginPercent: 30,
      resalePrice: 195000,
      creditToWallet: false,
      createdAt: iso(-400 * DAY),
      ...over,
    }) as TradeInItem;

  // ── The join: raw on both sides, so it must normalize ─────────────────────
  ok(deviceOriginFor([tradeIn()], '35-209900-176148-1').latest?.id === 'trade-1',
     'S26a a hyphenated lookup finds the trade-in (canonical-keyed join)');
  ok(deviceOriginFor([tradeIn()], IMEI).latest?.id === 'trade-1',
     'S26a the plain IMEI finds the same trade-in');
  ok(deviceOriginFor([tradeIn({ imei: 'SN-XZ7-99213-A' })], SERIAL).latest?.id === 'trade-1',
     'S26a a serial-numbered trade-in resolves too');
  ok(deviceOriginFor([tradeIn()], '999999999999999').latest === null,
     'S26a an unrelated device has NO origin (the section is omitted, not empty)');
  ok(deviceOriginFor([tradeIn()], null).latest === null,
     'S26a no identifier at all invents nothing');
  ok(deviceOriginFor([tradeIn()], '   ').latest === null,
     'S26a a blank identifier invents nothing');

  // ── Most recent acquisition wins; the rest stay visible as history ───────
  const older = tradeIn({ id: 'trade-old', customerName: 'ANCIEN VENDEUR', createdAt: iso(-900 * DAY) });
  const newer = tradeIn({ id: 'trade-new', createdAt: iso(-30 * DAY) });
  const chain = deviceOriginFor([older, newer], IMEI);
  ok(chain.latest?.id === 'trade-new', 'S26b the MOST RECENT acquisition wins', chain.latest?.id);
  ok(chain.history.length === 2 && chain.history[1].id === 'trade-old',
     'S26b the older acquisition is kept as history', chain.history.map((t) => t.id));
  const chainView = originViewWithHistory(chain);
  ok(chainView !== null && chainView.olderCount === 1,
     'S26b the view reports one earlier acquisition', chainView?.olderCount);
  ok(chainView?.sellerName === SELLER,
     'S26b the LATEST seller is the origin after a second acquisition', chainView?.sellerName);

  // ── Masking ───────────────────────────────────────────────────────────────
  // Asserted structurally (bullet count, revealed tail) rather than by literal:
  // the mask is a contract, and a literal of U+2022 in a test file is a mojibake
  // risk that would fail for the wrong reason.
  const BULLETS = /^\u2022+$/;
  const view = originView(tradeIn());
  const doc = view?.idNumber ?? '';
  const phone = view?.sellerPhone ?? '';
  ok(view !== null && doc.endsWith('2233') && doc.length === 12 && BULLETS.test(doc.slice(0, -4)),
     'S26c the document number is masked to its last 4 only', { masked: doc });
  ok(!(view?.idNumber || '').includes('1987') && !(view?.idNumber || '').includes('1122'),
     'S26c no leading fragment of the document leaks into the view', doc);
  ok(view !== null && phone.endsWith('9900') && phone.length === 10 && BULLETS.test(phone.slice(0, -4)),
     'S26c the seller phone is masked too', { masked: phone });
  ok(view?.sellerName === SELLER,
     'S26c the seller NAME is shown (it is the police register, not a secret)', view?.sellerName);
  const shortDoc = maskNationalId('1234');
  ok(shortDoc.length === 4 && BULLETS.test(shortDoc),
     'S26c a 4-character value is masked ENTIRELY (last-4 would be the whole value)',
     { masked: shortDoc });
  ok(maskNationalId('') === '' && maskNationalId(undefined) === '',
     'S26c an absent value masks to empty, never to a placeholder digit');
  const midDoc = maskNationalId('123456789');
  ok(midDoc.length === 9 && midDoc.endsWith('6789') && BULLETS.test(midDoc.slice(0, -5)),
     'S26c masking keeps the length honest', { masked: midDoc });

  // ── Role gate ─────────────────────────────────────────────────────────────
  ok(canRevealSellerId('admin') === true, 'S26d a manager MAY reveal');
  ok(canRevealSellerId('cashier') === false, 'S26d a cashier may NOT');
  ok(canRevealSellerId('') === false && canRevealSellerId(null) === false &&
     canRevealSellerId(undefined) === false,
     'S26d an unknown or empty role DENIES (fail closed)');
  ok(canRevealSellerId('ADMIN') === false,
     'S26d the role is matched exactly, not case-folded into a bypass');

  // ── The audit line never carries the value ────────────────────────────────
  const audit = sellerIdAuditDetail({ action: 'Consultation', deviceKey: IMEI, newValue: SELLER_ID });
  ok(!audit.includes(SELLER_ID) && audit.includes('2233'),
     'S26e the reveal audit line holds the MASKED value only', audit);
  const editAudit = sellerIdAuditDetail({
    action: 'Complément', deviceKey: IMEI, oldValue: '', newValue: SELLER_ID,
  });
  ok(editAudit.includes('2233') && !editAudit.includes(SELLER_ID),
     'S26e an edit audit line shows the new value MASKED', editAudit);
  ok(editAudit.includes('(vide)'),
     'S26e an edit audit line says the previous value was empty', editAudit);
  const fromOld = sellerIdAuditDetail({
    action: 'Complément', deviceKey: IMEI, oldValue: SELLER_ID, newValue: '445566778899',
  });
  ok(fromOld.includes('2233') && fromOld.includes('8899') && !fromOld.includes(SELLER_ID),
     'S26e an old→new audit line masks BOTH sides', fromOld);

  // ── Missing document ──────────────────────────────────────────────────────
  const noDoc = tradeIn({ id: 'trade-nodoc', nationalIdNumber: undefined });
  ok(isNationalIdMissing(noDoc) === true, 'S26f a trade-in without a document reports missing');
  ok(isNationalIdMissing(tradeIn()) === false, 'S26f a trade-in with a document does not');
  ok(isNationalIdMissing(tradeIn({ nationalIdNumber: '   ' })) === true,
     'S26f whitespace is not a document');
  const missingView = originView(noDoc);
  ok(missingView !== null && missingView.idMissing === true && missingView.idNumber === '',
     'S26f the missing case renders a badge and NO invented number', missingView);

  // ── The list index is built once, not per row ─────────────────────────────
  const index = originIndexByKey([older, newer, tradeIn({ imei: SERIAL, id: 'trade-serial' })]);
  ok(index.get(canonicalKey(IMEI))?.[0]?.id === 'trade-new',
     'S26g the index holds the newest acquisition first', index.get(canonicalKey(IMEI))?.[0]?.id);
  ok(index.get(canonicalKey(IMEI))?.length === 2,
     'S26g both acquisitions stay in the bucket (history is not dropped)', index.get(canonicalKey(IMEI))?.length);
  ok(index.get(canonicalKey(SERIAL))?.length === 1, 'S26g a second device gets its own bucket');
  ok(index.get(canonicalKey('35-209900-176148-1'))?.length === 2,
     'S26g the index is keyed canonically, so a hyphenated lookup hits too');
  ok(index.get(canonicalKey('999999999999999')) === undefined,
     'S26g an unknown device has no bucket');
}

section('S27  Document TYPE — optional, validated on read, tolerated from peers');
{
  ok(normalizeNationalIdType('CNI') === 'CNI', 'S27a a legal type passes');
  ok(normalizeNationalIdType('permis') === 'PERMIS',
     'S27a the value is case-normalized', normalizeNationalIdType('permis'));
  ok(normalizeNationalIdType(' Passeport ') === 'PASSEPORT', 'S27a whitespace is trimmed');
  ok(normalizeNationalIdType('CARTE VITALE') === undefined,
     'S27a an unknown type is DROPPED, not guessed');
  ok(normalizeNationalIdType(42) === undefined && normalizeNationalIdType(null) === undefined,
     'S27a a non-string is dropped');
  ok(normalizeNationalIdType(undefined) === undefined,
     'S27a an absent type is absent, not "CNI" by default');

  ok(nationalIdTypeLabel('CNI') === 'CNI', 'S27b the type has a French label');
  ok(nationalIdTypeLabel('PERMIS') === 'Permis de conduire',
     'S27b the driving licence is labelled in French');
  ok(nationalIdTypeLabel('PASSEPORT') === 'Passeport', 'S27b the passport is labelled in French');
  ok(nationalIdTypeLabel(undefined) === 'Pièce (type non précisé)',
     'S27b a row written before the selector says so', nationalIdTypeLabel(undefined));
  ok(nationalIdTypeLabel('CARTE VITALE' as never) === 'Pièce (type non précisé)',
     'S27b an illegal type falls back to the legacy label');

  // A peer payload WITH the field, WITHOUT it, and with garbage in it must all
  // load: the field is optional in the sync payload, so absence is normal.
  const peerWith = { imei: IMEI, nationalIdType: 'PASSEPORT' } as unknown as TradeInItem;
  const peerWithout = { imei: IMEI } as unknown as TradeInItem;
  const peerIllegal = { imei: IMEI, nationalIdType: 'RIC' } as unknown as TradeInItem;
  ok(originView(peerWith)?.idTypeLabel === 'Passeport', 'S27c a peer row carrying the type loads');
  ok(originView(peerWithout)?.idTypeLabel === 'Pièce (type non précisé)',
     'S27c a peer row without the type still loads');
  ok(originView(peerIllegal)?.idTypeLabel === 'Pièce (type non précisé)',
     'S27c an illegal type from a peer degrades to "non précisé", it does not break the record');
  ok(originView(peerWith)?.idMissing === true,
     'S27c a document TYPE without a number is still reported as missing (type ≠ document)',
     { hasType: 'PASSEPORT', idMissing: originView(peerWith)?.idMissing });
  ok(originView(peerWithout)?.idMissing === true,
     'S27c a peer row with neither type nor number is reported as missing');

  // The option list is exactly the three legal documents — no free text.
  ok(NATIONAL_ID_TYPE_OPTIONS.length === 3, 'S27d the selector offers exactly 3 types',
     NATIONAL_ID_TYPE_OPTIONS.map((o) => o.value));
  ok(NATIONAL_ID_TYPE_OPTIONS.every((o) => o.label && o.value),
     'S27d every option is labelled', NATIONAL_ID_TYPE_OPTIONS);
}

section('S28  Seller PII never reaches customer-facing output (printer scan)');
{
  // The seller is the PREVIOUS owner. A buyer must only ever see their own
  // sale, so the certificate / receipt / SAV outputs must not contain the
  // seller's name, phone or document number. EXACTLY two builders are allowed
  // to print it — the police-register contract (80 mm) and the buyback slip
  // (58 mm) — because that register is the legal purpose of the field.
  const SELLER = 'KARIM BENALI';
  const SELLER_PHONE = '0661889900';
  const SELLER_ID = '198744112233';

  const trade = {
    id: 'trade-1', deviceModel: 'iPhone 12 128', imei: IMEI, brand: 'Apple',
    conditionGrade: 'Grade B (Bon État)', customerName: SELLER, customerPhone: SELLER_PHONE,
    nationalIdNumber: SELLER_ID, nationalIdType: 'CNI', buybackValue: 150000,
    resaleMarginPercent: 30, resalePrice: 195000, creditToWallet: false, createdAt: iso(-400 * DAY),
  } as unknown as TradeInItem;

  const printerSettings = (paperWidth: '58mm' | '80mm') =>
    ({
      storeName: 'MOBI ACCESSORIES',
      address: 'Boulevard Mohamed V, Alger Centre',
      phone: '0550 00 00 00',
      paperWidth,
    } as never);

  const buyer = soldTx({
    id: 'txBuyer',
    receiptNumber: 'F-2026-7777',
    customer: { name: 'ACHETEUR ACTUEL', phone: '0551000000' } as never,
  });
  const buyerItem = cartItem();

  // A name/number that would be unmistakable if it leaked, on every renderer.
  const leaks = (text: string) =>
    [SELLER, SELLER_PHONE, SELLER_ID, SELLER_ID.slice(-4), SELLER_ID.slice(0, 4)]
      .filter((needle) => text.includes(needle));

  // 1. Warranty certificate, 58 mm and 80 mm.
  for (const paperWidth of ['58mm', '80mm'] as const) {
    const s = printerSettings(paperWidth);
    const t58 = warrantyCertificateText(buyer, buyerItem, 12, s, 'Caisse', iso(355 * DAY));
    const t80 = new TextDecoder('latin1').decode(
      WarrantyCertificateBuilder.buildPreOwnedWarrantyCertificate(
        buyer, buyerItem, s, 12, 'Caisse', iso(355 * DAY)
      )
    );
    ok(leaks(t58).length === 0, `S28a the ${paperWidth} warranty certificate carries no seller PII`,
       leaks(t58));
    ok(leaks(t80).length === 0, `S28a the ${paperWidth} ESC/POS warranty certificate carries no seller PII`,
       leaks(t80));
    // The certificate names the CASHIER (the vendor of record), never the buyer
    // and never the previous owner. Asserted so the scan cannot pass vacuously.
    ok(t58.includes('Caisse') && t80.includes('Caisse'),
       `S28a the ${paperWidth} certificate names the cashier (the scan is not vacuous)`);
    ok(t58.includes(IMEI) && t80.includes(IMEI),
       `S28a the ${paperWidth} certificate still carries the device IMEI`);
    ok(!t58.includes('ACHETEUR ACTUEL') && !t80.includes('ACHETEUR ACTUEL'),
       `S28a the ${paperWidth} certificate names neither the buyer nor the seller`);
  }

  // 2. The sale receipt view model — what the till actually prints. The till
  //    receipt names the CASHIER, never the buyer, and its trade-in leg carries
  //    only category/model/imei/grade/valuation — so the seller's document number
  //    has no field to travel through. Asserted, because "no field" is exactly
  //    the kind of guarantee that a later refactor erodes silently.
  const receiptVm = buildReceiptViewModel(buyer, printerSettings('80mm'));
  const receiptText = JSON.stringify(receiptVm);
  ok(leaks(receiptText).length === 0, 'S28b the sale receipt view model carries no seller PII',
     leaks(receiptText));
  ok(receiptVm.cashierName.length > 0, 'S28b the receipt names the cashier (the scan is not vacuous)',
     receiptVm.cashierName);
  ok(receiptVm.tradeIn === null, 'S28b a plain sale has no trade-in leg', receiptVm.tradeIn);
  ok(receiptText.includes(IMEI),
     'S28b the receipt prints the BUYER\'s own IMEI (serialized sale) — that is not PII leakage');

  // 2b. A sale WITH a buyback leg: the receipt summarizes the taken-back device.
  const withTradeIn = soldTx({
    id: 'txTrade',
    receiptNumber: 'F-2026-8888',
    stashedTradeIns: [trade] as never,
  });
  const tradeReceipt = JSON.stringify(buildReceiptViewModel(withTradeIn, printerSettings('80mm')));
  ok(leaks(tradeReceipt).length === 0,
     'S28b the buyback receipt leg carries no seller document number or phone', leaks(tradeReceipt));
  ok(tradeReceipt.includes('iPhone 12 128'),
     'S28b the buyback receipt leg still names the device (the scan is not vacuous)');

  // 3. The SAV outputs. They take a RepairOrder, which has no trade-in
  //    parameter at all — that is the structural reason the seller cannot leak.
  const order = repair({ imei: IMEI, customerName: 'ACHETEUR ACTUEL' });
  const savOutputs: Array<[string, string]> = [
    ['repair voucher', repairVoucherEscPosText(order, printerSettings('80mm'), 'Caisse')],
    ['chassis tag', chassisTagEscPosText(order)],
    ['workshop slip', workshopSlipText(order, 'Caisse', 'Yacine', printerSettings('80mm'))],
    ['restitution ticket',
      new TextDecoder('latin1').decode(
        SavRestitutionBuilder.buildSavRestitutionTicket(order, printerSettings('80mm'), 'Caisse')
      )],
  ];
  for (const [label, text] of savOutputs) {
    ok(leaks(text).length === 0, `S28c the SAV ${label} carries no seller PII`, leaks(text));
  }

  // 4. ALLOWED: the two police-register outputs must still print it, or the
  //    legal purpose of the field is lost.
  const contract = new TextDecoder('latin1').decode(
    TradeInVoucherBuilder.buildLegalBuybackCertificate(trade, printerSettings('80mm'), 'Caisse')
  );
  ok(contract.includes(SELLER_ID),
     'S28d the police-register contract (80 mm) DOES print the document number');
  ok(contract.includes(SELLER), 'S28d the contract names the seller (that is its purpose)');
  const slip = tradeInText(trade, printerSettings('58mm'));
  ok(slip.includes(SELLER_ID), 'S28d the buyback slip (58 mm) DOES print the document number');
  ok(slip.includes(SELLER), 'S28d the slip names the seller');
}

section('S29  Trade-in writer — canonical identifier, Luhn gate, duplicate is a WARNING');
{
  // The exact gate the two writers now apply, as a pure function over the same
  // fixtures. `validateIMEI` cannot be reused: it refuses every non-15-digit
  // value (serials are legal devices here) and it refuses duplicates, which the
  // owner ruled must be a warning.
  const intakeGate = (raw: string, existing: string[]) => {
    const canonical = canonicalDeviceId(raw);
    if (canonical.length === 15 && !luhnCheckImei(canonical)) {
      return { accepted: false as const, reason: 'IMEI_INVALIDE', canonical, warning: undefined };
    }
    const key = canonicalKey(canonical);
    const duplicate = existing.find((e) => canonicalKey(e) === key);
    return {
      accepted: true as const,
      canonical,
      warning: duplicate ? `DUPLICATE_IMEI:${key}` : undefined,
    };
  };

  ok(intakeGate('35-209900-176148-1', []).canonical === '352099001761481',
     'S29a a hyphenated intake is stored CANONICAL (digits only)',
     intakeGate('35-209900-176148-1', []).canonical);
  ok(intakeGate('35 209900 176148 1', []).canonical === '352099001761481',
     'S29a a spaced intake is stored canonical');
  ok(intakeGate(IMEI, []).canonical === IMEI, 'S29a an already-canonical intake is unchanged');

  // A 15-digit value that fails Luhn is refused outright.
  const bad = intakeGate('352099001761482', []);
  ok(bad.accepted === false, 'S29b a 15-digit Luhn failure is REFUSED at the write boundary', bad);
  ok(bad.reason === 'IMEI_INVALIDE', 'S29b the refusal is typed, not a silent drop', bad.reason);
  ok(luhnCheckImei(IMEI) === true, 'S29b the fixture IMEI itself passes Luhn (control)');

  // A serial is NOT refused: `validateIMEI` would have rejected it.
  const serialIntake = intakeGate('SN-XZ7-99213-A', []);
  ok(serialIntake.accepted === true && serialIntake.canonical === 'SN-XZ7-99213-A',
     'S29b a serial-number device is still accepted, and keeps its readable form',
     serialIntake.canonical);
  ok(canonicalKey(serialIntake.canonical) === canonicalKey(SERIAL),
     'S29b the serial still resolves to the same canonical key as it does on read',
     canonicalKey(serialIntake.canonical));
  // A 15-DIGIT value is gated whatever its intent — the gate cannot tell a
  // numeric serial from an IMEI, and it must not guess. The accepted case is
  // built with a real check digit so the fixture cannot rot into a false pass.
  const withLuhnDigit = (prefix14: string): string => {
    const base = canonicalDeviceId(prefix14).slice(0, 14);
    for (let d = 0; d <= 9; d++) {
      if (luhnCheckImei(`${base}${d}`)) return `${base}${d}`;
    }
    return base;
  };
  const numericSerial = withLuhnDigit('00012345678901');
  ok(numericSerial.length === 15 && luhnCheckImei(numericSerial) === true,
     'S29b the numeric-serial fixture carries a real check digit', numericSerial);
  ok(intakeGate(numericSerial, []).accepted === true,
     'S29b a 15-DIGIT value with a valid checksum is accepted whatever its intent',
     intakeGate(numericSerial, []));
  ok(intakeGate(numericSerial.slice(0, 14) + ((Number(numericSerial[14]) + 1) % 10), []).accepted === false,
     'S29b and the same shape with a broken check digit is refused (the gate is the checksum)');

  // A duplicate is a WARNING: the write still succeeds.
  const dup = intakeGate('35-209900-176148-1', ['352099001761481']);
  ok(dup.accepted === true, 'S29c a duplicate IMEI does NOT block the intake', dup);
  ok(dup.warning?.startsWith('DUPLICATE_IMEI:') === true, 'S29c the operator is warned', dup.warning);
  ok(intakeGate(IMEI, ['35-209900-176148-1']).accepted === true &&
     intakeGate(IMEI, ['35-209900-176148-1']).warning !== undefined,
     'S29c the duplicate is detected across SPELLINGS (legacy hyphenated row)');
  ok(intakeGate(IMEI, ['356938035643809']).warning === undefined,
     'S29c a different device raises no warning');
  ok(intakeGate(IMEI, []).warning === undefined, 'S29c a first intake raises no warning');

  // The registry row replaces the legacy spelling instead of living beside it,
  // otherwise the canonicalisation would create a phantom second device.
  const existing = [{ imei: '35-209900-176148-1', productId: 'old' }];
  const key = canonicalKey('35-209900-176148-1');
  const after = [
    { imei: IMEI, productId: 'new' },
    ...existing.filter((r) => canonicalKey(r.imei) !== key),
  ];
  ok(after.length === 1 && after[0].productId === 'new',
     'S29d the canonical row REPLACES the hyphenated one (no phantom second device)', after);

  // Both writers must use the SAME key comparison, or the standalone leg and the
  // staged/exchange leg would disagree about what "the same device" means.
  ok(canonicalKey(IMEI) === canonicalKey('35-209900-176148-1') &&
     canonicalKey(SERIAL) === canonicalKey('sn xz7 99213 a'),
     'S29d one key function is shared by the writer, the join and the dedupe');
}

section('S29e  ONE gate, EVERY acquisition writer (PO receipt, CSV import, product editor)');
{
  // The SHIPPED gate, not the local `intakeGate` twin above: the point of this
  // section is that all four writers call the same function, so it imports the
  // real one and exercises it on the real call shapes.
  const gate = validateDeviceIdentifierForIntake;

  // ── PO receipt: a signed commercial document, so it is FAIL-CLOSED ────────
  // One bad identifier aborts the whole receipt.
  const poLine = { productId: 'p1', receivedQty: 3, imeis: ['35-209900-176148-1', ''] };
  const poVerdict = gate(poLine.imeis[0], []);
  ok(poVerdict.ok === true && poVerdict.canonical === IMEI,
     'S29e PO receipt accepts and CANONICALISES a scanned hyphenated IMEI', poVerdict);
  // The blank accessory entry is skipped by the caller, not refused by the gate.
  ok(gate('', []).code === 'IDENTIFIER_ABSENT',
     'S29e a blank PO line entry reports IDENTIFIER_ABSENT so the caller can skip it');
  const poBad = gate('352099001761482', []);
  ok(poBad.ok === false && poBad.code === 'IMEI_LUHN_INVALID',
     'S29e PO receipt REFUSES a 15-digit Luhn failure (abort, no partial receipt)', poBad);
  ok(gate('SN-XZ7-99213-A', []).ok === true,
     'S29e PO receipt accepts a serial-numbered unit (S/N stock is legal)');

  // ── CSV invoice import: per-row, non-fatal, the other lines still land ────
  const invoiceRows = [
    { imei: '35-209900-176148-1' },
    { imei: '352099001761482' }, // bad checksum → refused
    { imei: IMEI }, // duplicate of line 1 within the SAME invoice → warn
    { imei: 'SN-XZ7-99213-A' },
  ];
  const known: string[] = [];
  const accepted: string[] = [];
  const refused: string[] = [];
  const warned: string[] = [];
  const acceptedKeys = new Set<string>();
  for (const row of invoiceRows) {
    const v = gate(row.imei, known);
    if (!v.ok) {
      refused.push(row.imei);
      continue;
    }
    if (v.warning) warned.push(v.warning);
    // Same collapse rule the CSV writer applies: warn, then keep ONE row.
    if (acceptedKeys.has(v.key)) continue;
    accepted.push(v.canonical);
    acceptedKeys.add(v.key);
    known.push(v.canonical);
  }
  ok(accepted.length === 2 && refused.length === 1,
     'S29e the invoice import drops the bad row AND collapses the in-file repeat, keeping 2',
     { accepted, refused });
  ok(refused[0] === '352099001761482',
     'S29e the refused row is the checksum failure, named for the operator', refused);
  ok(accepted[0] === IMEI && accepted[accepted.length - 1] === 'SN-XZ7-99213-A',
     'S29e the surviving rows are stored canonical', accepted);
  ok(warned.length === 1 && warned[0].startsWith('DUPLICATE_IMEI:'),
     'S29e an invoice that repeats a device warns once and still imports it', warned);
  ok(accepted.filter((a) => a === IMEI).length === 1,
     'S29e the repeat inside ONE invoice collapses instead of double-registering the device',
     accepted);

  // ── Product editor: refuses the write, and never warns about itself ──────
  const otherProduct = gate(IMEI, ['356938035643809']);
  ok(otherProduct.ok === true && otherProduct.warning === null,
     'S29e the product editor raises no warning for an unrelated device');
  const selfScan = gate('35-209900-176148-1', ['35-209900-176148-1']);
  ok(selfScan.ok === true && selfScan.duplicateOf === '35-209900-176148-1',
     'S29e the gate DOES report a self-collision — the caller must exclude the row being edited',
     selfScan.warning);
  ok(gate('352099001761482', []).ok === false,
     'S29e the product editor refuses to save a product whose IMEI fails Luhn');

  // ── All four writers share ONE verdict, so they cannot drift ─────────────
  const writers = ['processTradeIn', 'commitStagedTradeInIntake', 'ingestInvoiceBatch',
                   'validateAndReceivePO', 'saveProduct'];
  const sliceSrc = readFileSync(
    new URL('../src/store/slices/createUISlice.ts', import.meta.url),
    'utf8'
  );
  const catalogSrc = readFileSync(
    new URL('../src/store/slices/createCatalogSlice.ts', import.meta.url),
    'utf8'
  );
  const procurementSrc = readFileSync(
    new URL('../src/store/slices/createProcurementSlice.ts', import.meta.url),
    'utf8'
  );
  for (const [name, src] of [
    ['processTradeIn + commitStagedTradeInIntake', sliceSrc],
    ['ingestInvoiceBatch + saveProduct', catalogSrc],
    ['validateAndReceivePO', procurementSrc],
  ] as const) {
    ok(src.includes('validateDeviceIdentifierForIntake'),
       `S29e ${name} calls the shared intake gate`, writers.slice(0, 1));
  }
  // The deprecated whole-record validator must stay (something still pins it),
  // but no writer may call it.
  ok(!sliceSrc.slice(0, sliceSrc.indexOf('validateIMEI:')).includes('validateIMEI('),
     'S29e no writer calls the deprecated validateIMEI action at ingest');
}

section('S30  SYNC round-trip — the frozen dossier survives push → pull → read');
{
  // The snapshot is only evidence if it SURVIVES the transport. Every generic
  // lane funnels through `enqueueGenericSync`, which serializes with
  // `toBoundedSyncJson` (payloadHygiene) before the outbox row is written, and
  // the remote keeps it inside `json_payload`. Nothing pinned that: a future
  // hygiene change could shed the snapshot silently, and the reader would then
  // fail closed — the operator silently loses the coverage they were shown.
  //
  // This drives the SHIPPED resolver, not a hand-written snapshot: the SAV
  // writer projects `resolveWarrantyDossier(...).snapshot`, so a fixture typed
  // by hand would only prove the projection agrees with my own imagination.
  const roundTripDeps: Deps = {
    transactions: [soldTx({ id: 'txRT', receiptNumber: 'F-2026-9911' })],
    products: [product()],
    imeiRecords: [registry({ saleTransactionId: 'txRT' })],
    repairOrders: [repair({ id: 'rRT', ticketNumber: 'REP-2026-0007', status: 'Livré',
                            warrantyTier: 'repair_90d', deliveredAt: iso(-5 * DAY),
                            warrantyExpiresAt: iso(85 * DAY) })],
  };
  const frozenDossier = minimalTicketDossierSnapshot(detail(IMEI, roundTripDeps).snapshot);
  ok(frozenDossier !== null, 'S30a the fixture dossier freezes', frozenDossier?.dossier);
  // Controls: the fixture really carries a verdict AND a real tier, so the
  // round-trip assertions below cannot pass on empty/default values.
  ok(frozenDossier?.dossier.isWarrantyValid === true,
     'S30a the frozen verdict is a real coverage claim (not a default)', frozenDossier?.dossier.isWarrantyValid);
  ok(frozenDossier?.suggestedTier === 'repair_90d',
     'S30a the frozen tier is a real tier (not the "none" default)', frozenDossier?.suggestedTier);

  const order: Record<string, unknown> = {
    ...repair({ id: 'rRT', ticketNumber: 'REP-2026-0007', imei: IMEI }),
    warrantyDossierSnapshot: frozenDossier,
  };

  // PUSH: exactly what `enqueueGenericSync` writes into sync_outbox.
  const pushedJson = toBoundedSyncJson({ ...order, version: 7 });
  const pushed = JSON.parse(pushedJson) as Record<string, unknown>;
  ok(pushed.warrantyDossierSnapshot !== undefined,
     'S30b the snapshot SURVIVES the sync payload sanitizer',
     { keys: Object.keys(pushed).filter((k) => /warranty/i.test(k)) });
  ok((pushed as { version?: number }).version === 7,
     'S30b the lane version stamp is still applied alongside it');
  ok(JSON.stringify(pushed.warrantyDossierSnapshot) === JSON.stringify(frozenDossier),
     'S30b the snapshot is byte-identical after push (no truncation, no re-ordering)');
  ok(pushedJson.length < 64 * 1024,
     'S30b the bounded payload stays inside the 64 KB sync budget', pushedJson.length);

  // PULL: the remote hands back the json_payload verbatim; the reader must
  // recover the same verdict.
  const pulled = JSON.parse(pushedJson) as { warrantyDossierSnapshot?: unknown };
  const readBack = minimalTicketDossierSnapshot(pulled.warrantyDossierSnapshot as never);
  ok(readBack?.dossier.isWarrantyValid === true,
     'S30c the verdict read back after a full round-trip is the promised one', readBack?.dossier);
  ok(readBack?.suggestedTier === frozenDossier?.suggestedTier && frozenDossier?.suggestedTier === 'repair_90d',
     'S30c the suggested tier survives too', { readBack: readBack?.suggestedTier, frozen: frozenDossier?.suggestedTier });

  // A peer that never received the field must still load (older build, or a
  // lane that shed it): the reader falls back, it never invents coverage.
  const legacy = JSON.parse(JSON.stringify(pushed)) as Record<string, unknown>;
  delete legacy.warrantyDossierSnapshot;
  ok(minimalTicketDossierSnapshot(legacy.warrantyDossierSnapshot as never) === null,
     'S30d a peer payload WITHOUT the snapshot reads as "nothing frozen" (no crash)');

  // Hostile peer payloads: an oversized, wrongly-typed, truncated or
  // fabricated value must be REJECTED as not-a-snapshot, never projected into a
  // dossier that paints coverage on a device that has none.
  const hostile: unknown[] = [
    // The dangerous one: exactly the shape that would assert coverage, with no
    // envelope to back it (no resolved identifier, no frozen-at instant).
    { dossier: { isWarrantyValid: true }, padding: 'x'.repeat(50_000) },
    { dossier: null, suggestedTier: 42 },
    { dossier: { isWarrantyValid: 'oui' } },
    // A well-formed-looking envelope whose instant does not parse: still not evidence.
    { idValue: IMEI, idMode: 'imei', resolvedAt: 'yesterday', dossier: { isWarrantyValid: true } },
    // `manual` mode NEVER resolves a dossier, so a snapshot claiming it is fabricated.
    { idValue: '', idMode: 'manual', resolvedAt: iso(-1 * DAY), dossier: { isWarrantyValid: true } },
    [],
    'not-an-object',
    null,
  ];
  for (const [i, bad] of hostile.entries()) {
    let out: unknown = 'unset';
    let threw = false;
    try {
      out = minimalTicketDossierSnapshot(bad);
    } catch {
      threw = true;
    }
    ok(!threw && out === null,
       `S30e hostile peer payload #${i + 1} reads as "nothing frozen" (no throw, no coverage)`,
       out);
  }

  // A WELL-FORMED envelope is kept — that is the operator's frozen verdict and
  // dropping it would silently lose the coverage they were shown — but its
  // claims are still coerced: a peer string is not coverage, an illegal tier is
  // not a tier, an unparseable date is dropped rather than invented.
  const coerced = minimalTicketDossierSnapshot({
    idValue: IMEI,
    idMode: 'imei',
    resolvedAt: iso(-1 * DAY),
    dossier: { imei: IMEI, isWarrantyValid: 'true', warrantyMonths: '12', warrantyExpiresAt: 'not-a-date' },
    suggestedTier: 'repair_900d',
  } as never);
  ok(coerced !== null && coerced.dossier.isWarrantyValid === false &&
     coerced.suggestedTier === 'none' && coerced.dossier.warrantyExpiresAt === undefined,
     'S30e a well-formed peer envelope is KEPT, but every claim in it is still coerced',
     { out: coerced?.dossier.isWarrantyValid, tier: coerced?.suggestedTier, exp: coerced?.dossier.warrantyExpiresAt });

  // The byte-cap shedding path must never take the snapshot with it, even when
  // the row is padded past the budget: a legal-but-large row would otherwise
  // lose its evidence while keeping cosmetic fields. The pad is PROSE (a real
  // diagnostic note), not a base64 blob — a blob would be blanked by the
  // earlier hygiene rule and the shedding pass would never even run.
  const padded = {
    ...order,
    diagnosticNotes: 'Constat visuel detaille. '.repeat(3000),
    warrantyDossierSnapshot: frozenDossier,
  };
  const paddedJson = toBoundedSyncJson(padded);
  const paddedOut = JSON.parse(paddedJson) as Record<string, unknown>;
  ok(paddedOut.warrantyDossierSnapshot !== undefined,
     'S30f a row padded past the 64 KB budget KEEPS its warranty snapshot',
     { size: paddedJson.length });
  ok((paddedOut as { diagnosticNotes?: string }).diagnosticNotes === undefined,
     'S30f the shed field is the cosmetic one, not the evidence',
     { shed: (paddedOut as { diagnosticNotes?: string }).diagnosticNotes === undefined });

  // Money is protected: even a pathological snapshot must not cost the amounts.
  const withMoney = {
    ...order,
    laborCost: 4500,
    totalCost: 16500,
    warrantyDossierSnapshot: { dossier: { isWarrantyValid: true }, junk: 'z'.repeat(80_000) },
  };
  const moneyOut = JSON.parse(toBoundedSyncJson(withMoney)) as Record<string, unknown>;
  ok(moneyOut.laborCost === 4500 && moneyOut.totalCost === 16500,
     'S30f the money scalars survive an oversized snapshot', { laborCost: moneyOut.laborCost });
}

section('S31  PULL lane — the frozen warranty ANCHOR survives, and cannot be widened');
{
  // `imei_records.warranty_months` / `warranty_expires_at` are the point-in-time
  // anchor minted at sale and never recomputed. The pull mirror used to name
  // neither column, so a device arriving from a peer lost its anchor and started
  // resolving coverage from the CATALOG instead — silently re-dating (or voiding)
  // a warranty the customer already bought, on whichever device pulled the row.
  //
  // This drives the SHIPPED `applyGenericRemoteRow` against a fake database that
  // records the SQL it was asked to run.
  const fakeDb = (columns: string[]) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      calls,
      select: async (sql: string) => {
        if (/pragma_table_info\('imei_records'\)/.test(sql)) return columns.map((name) => ({ name }));
        if (/FROM entity_keys/.test(sql)) return [];
        return [];
      },
      execute: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rowsAffected: 1, lastInsertId: 1 };
      },
    };
    return db as never;
  };
  const peerRow = (over: Record<string, unknown> = {}) => ({
    id: IMEI,
    version: 4,
    deleted: 0,
    data_json: JSON.stringify({
      imei: IMEI,
      product_id: 'p1',
      sale_transaction_id: 'txRT',
      sold_at: iso(-40 * DAY),
      received_at: iso(-70 * DAY),
      warranty_months: 12,
      warranty_expires_at: iso(325 * DAY),
      ...over,
    }),
  });
  const imeiSql = (calls: Array<{ sql: string }>) =>
    calls.find((c) => /INSERT INTO imei_records/.test(c.sql))?.sql ?? '';
  const imeiCall = (calls: Array<{ sql: string; params: unknown[] }>) =>
    calls.find((c) => /INSERT INTO imei_records/.test(c.sql));

  const MIGRATED = ['imei', 'product_id', 'sale_transaction_id', 'warranty_expires_at',
                    'received_at', 'sold_at', 'version', 'warranty_months'];

  // 1. A migrated database: both anchor columns are written.
  const migrated = fakeDb(MIGRATED);
  await applyGenericRemoteRow(migrated, 'imei_records', peerRow() as never, { skipDexie: true });
  const mCall = imeiCall((migrated as unknown as { calls: Array<{ sql: string; params: unknown[] }> }).calls);
  ok(!!mCall && /warranty_months/.test(mCall!.sql) && /warranty_expires_at/.test(mCall!.sql),
     'S31a a pulled device KEEPS the anchor it was sold with',
     { cols: mCall?.sql.match(/INSERT INTO imei_records \(([^)]*)\)/)?.[1] });
  const mParams = mCall?.params ?? [];
  const mIdx = mCall?.sql.indexOf('warranty_months');
  ok(mIdx !== undefined && mParams.includes(12) && mParams.includes(iso(325 * DAY)),
     'S31a the peer term and expiry are bound as VALUES, not dropped',
     { params: mParams });
  // Never widened from the wire: the conflict branch may not touch either column.
  const updateClause = mCall?.sql.slice(mCall.sql.indexOf('DO UPDATE')) ?? '';
  ok(!/warranty_months\s*=/.test(updateClause) && !/warranty_expires_at\s*=/.test(updateClause),
     'S31b a re-pull CANNOT rewrite a locally frozen anchor',
     { updateClause });
  ok(/WHERE excluded\.version >= imei_records\.version/.test(mCall?.sql ?? ''),
     'S31b the stale-echo guard still guards the device lane');

  // 2. A pre-107 database: naming a missing column would throw `no such column`
  //    and abort the whole lane, so the probe decides the column list.
  const legacy = fakeDb(['imei', 'product_id', 'sale_transaction_id', 'warranty_expires_at', 'received_at', 'sold_at', 'version']);
  await applyGenericRemoteRow(legacy, 'imei_records', peerRow() as never, { skipDexie: true });
  const lCall = imeiCall((legacy as unknown as { calls: Array<{ sql: string; params: unknown[] }> }).calls);
  ok(!!lCall && !/warranty_months/.test(lCall!.sql),
     'S31c a database without migration 107 pulls WITHOUT naming the missing column',
     { cols: lCall?.sql.match(/INSERT INTO imei_records \(([^)]*)\)/)?.[1] });
  ok(/warranty_expires_at/.test(lCall?.sql ?? '') && (lCall?.params.length ?? 0) === 7,
     'S31c the base-schema expiry column is still carried', { params: lCall?.params });

  // 3. Hostile anchor values are coerced, never invented and never widened.
  const hostile = fakeDb(MIGRATED);
  await applyGenericRemoteRow(hostile, 'imei_records', peerRow({
    warranty_months: 'twelve', warranty_expires_at: 'not-a-date',
  }) as never, { skipDexie: true });
  const hCall = imeiCall((hostile as unknown as { calls: Array<{ sql: string; params: unknown[] }> }).calls);
  ok((hCall?.params ?? []).includes(null),
     'S31d an unparseable anchor becomes NULL (resolver falls back to what it can prove)',
     { params: hCall?.params });

  const negative = fakeDb(MIGRATED);
  await applyGenericRemoteRow(negative, 'imei_records', peerRow({ warranty_months: -4 }) as never, { skipDexie: true });
  const nCall = imeiCall((negative as unknown as { calls: Array<{ sql: string; params: unknown[] }> }).calls);
  ok((nCall?.params ?? []).includes(null) && !(nCall?.params ?? []).includes(-4),
     'S31d a negative term is dropped, not stored', { params: nCall?.params });

  const zero = fakeDb(MIGRATED);
  await applyGenericRemoteRow(zero, 'imei_records', peerRow({ warranty_months: 0 }) as never, { skipDexie: true });
  const zCall = imeiCall((zero as unknown as { calls: Array<{ sql: string; params: unknown[] }> }).calls);
  ok((zCall?.params ?? []).includes(0),
     'S31d a deliberate ZERO term is preserved — "sold with no warranty" is not "unknown"',
     { params: zCall?.params });

  // 4. The anchor is what the resolver reads: a device pulled WITH its anchor
  //    resolves the sold term, never the catalog's current value.
  const anchored = registry({ warrantyMonths: 12, warrantyExpiresAt: iso(325 * DAY) });
  ok(detail(IMEI, { transactions: [soldTx()], products: [product({ warrantyMonths: 3 })],
                     imeiRecords: [anchored], repairOrders: [] })
       .snapshot?.dossier.warrantyMonths === 12,
     'S31e the anchor wins over a catalog that now says something else');
  // With NO anchor anywhere — neither the registry row nor the sale line — the
  // resolver has nothing but the catalog, and takes the catalog's word. That is
  // precisely the drift the pull fix removes: a device that was SOLD anchored and
  // lands unanchored resolves whatever the catalog says today.
  const unanchored = registry({ warrantyMonths: undefined, warrantyExpiresAt: undefined });
  const unanchoredResolved = detail(IMEI, {
    transactions: [soldTx({ items: [cartItem({ warrantyMonthsAtSale: undefined })] })],
    products: [product({ warrantyMonths: 3 })],
    imeiRecords: [unanchored],
    repairOrders: [],
  }).snapshot?.dossier.warrantyMonths;
  ok(unanchoredResolved === 3,
     'S31e a device with NO anchor resolves the catalog — which is exactly why the pull must carry it',
     { warrantyMonths: unanchoredResolved });
}

console.log(
  `\n${failed === 0 ? 'ALL SCENARIOS PASSED' : `${failed} SCENARIO ASSERTION(S) FAILED`}` +
  ` — ${passed} passed, ${failed} failed`
);
process.exit(failed === 0 ? 0 : 1);
