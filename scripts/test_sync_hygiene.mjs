/**
 * MOBI POS — P0 Payload-Hygiene Invariant Test Suite
 *
 * Guards the mobile freeze/crash fix (2026-09-17): synced payloads must carry
 * REFERENCES (url, hash), never BLOB bytes. Forensics baseline:
 * docs/sync/diagnostic-baseline-2026-09-17.md — one product row carried
 * 20,260,360 bytes of base64 in `json_payload`; 26 receipts embedding it
 * added 14.6 MB more.
 *
 * Failure modes asserted (not just the happy path):
 *  - 20 MB-style blobs are stripped at every nesting level
 *  - money/relational scalars are NEVER dropped, even over budget
 *  - oversized image references are blanked, normal URLs preserved
 *  - cyclic/deep inputs terminate instead of hanging the webview thread
 */

import {
  sanitizeSyncPayload,
  sanitizeImageField,
  toBoundedSyncJson,
  MAX_SYNC_PAYLOAD_BYTES,
} from '../src/sync/payloadHygiene.ts';

console.log('========================================================================');
console.log('MOBI POS — P0 PAYLOAD-HYGIENE INVARIANT SUITE');
console.log('========================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS ${message}`);
    passCount++;
  } else {
    console.log(`  FAIL ${message}`);
    failCount++;
  }
}

// Deterministic pseudo-base64 blob of ~size bytes (no randomness: stable CI).
function makeBlob(size) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = 'data:image/jpeg;base64,';
  while (out.length < size) out += alphabet;
  return out.slice(0, size);
}

// --- TEST 1: the exact forensic shape — product row with 20 MB json_payload blob ---
const bigImage = makeBlob(20_260_360);
const bloatedProductRow = {
  id: 'prod-1789591848585-909',
  title: 'Coque iPhone',
  price: 1500,
  stock: 42,
  vendor_name: 'Grossiste Tech',
  image_url: bigImage,
  json_payload: JSON.stringify({ id: 'prod-1789591848585-909', photos: [bigImage], notes: 'ok' }),
  device_id: 'dev-1',
  idempotency_key: 'key-1',
  version: 3,
};
const cleanRowJson = toBoundedSyncJson(bloatedProductRow);
assert(
  cleanRowJson.length <= MAX_SYNC_PAYLOAD_BYTES,
  `20MB product row bounded to ${(cleanRowJson.length / 1024).toFixed(1)}KB (<= 64KB)`
);
const cleanRow = JSON.parse(cleanRowJson);
assert(cleanRow.title === 'Coque iPhone', 'product title preserved after stripping');
assert(cleanRow.price === 1500 && cleanRow.stock === 42, 'product price/stock preserved after stripping');
assert(cleanRow.vendor_name === 'Grossiste Tech', 'supplier vendor_name preserved after stripping');
assert(cleanRow.image_url === '', 'oversized image_url blanked (reference slot kept)');
assert(!cleanRowJson.includes('data:image'), 'no base64 residue left in cleaned product row');

// --- TEST 2: receipt embedding the blob (14.6 MB across 26 receipts shape) ---
const receipt = {
  id: 'TXN-1',
  receiptNumber: 'R-1',
  total: 1500,
  subtotal: 1500,
  tax: 0,
  status: 'COMPLETED',
  items: [
    { id: 'TXN-1-item-0', product_id: bloatedProductRow.id, quantity: 1, applied_price: 1500, product: bloatedProductRow },
  ],
  customer: { id: 'c1', name: 'Amine' },
  device_id: 'dev-1',
  idempotency_key: 'ord-1',
};
const cleanReceiptJson = toBoundedSyncJson(receipt);
const cleanReceipt = JSON.parse(cleanReceiptJson);
assert(cleanReceiptJson.length <= MAX_SYNC_PAYLOAD_BYTES, 'bloated receipt bounded to budget');
assert(cleanReceipt.total === 1500 && cleanReceipt.status === 'COMPLETED', 'receipt money/status intact');
assert(
  Array.isArray(cleanReceipt.items) && cleanReceipt.items.length === 1
  && cleanReceipt.items[0].quantity === 1 && cleanReceipt.items[0].applied_price === 1500,
  'receipt line items (qty/price) intact — money never dropped'
);
assert(!cleanReceiptJson.includes('data:image'), 'no base64 residue in cleaned receipt');

// --- TEST 3: media keys dropped, scalar siblings kept ---
const withMedia = sanitizeSyncPayload({
  id: 'p1', title: 'X', photos: ['a'], photo: 'b', receipt_image: 'c', scan_image: 'd', price: 100,
});
assert(withMedia.photos === undefined && withMedia.photo === undefined, 'photos/photo keys dropped');
assert(withMedia.receipt_image === undefined && withMedia.scan_image === undefined, 'receipt/scan image keys dropped');
assert(withMedia.title === 'X' && withMedia.price === 100, 'scalar siblings untouched');

// --- TEST 4: normal image URLs preserved ---
assert(
  sanitizeImageField('https://cdn.example.com/p/123.jpg') === 'https://cdn.example.com/p/123.jpg',
  'normal https image URL preserved'
);
assert(sanitizeImageField(makeBlob(5000)) === '', 'oversized data-URL image blanked');
assert(sanitizeImageField(null) === null, 'null image stays null');
assert(sanitizeImageField('') === '', 'empty image stays empty (falsy, renders nothing)');

// --- TEST 5: legit huge receipt (many lines, NO blobs) passes through INTACT ---
const manyItems = Array.from({ length: 300 }, (_, i) => ({
  id: `TXN-BIG-item-${i}`, product_id: `prod-${i}`, quantity: 2, applied_price: 500 + i,
}));
const bigLegitReceipt = { id: 'TXN-BIG', total: 999999, subtotal: 999999, items: manyItems, status: 'COMPLETED' };
const bigLegitJson = toBoundedSyncJson(bigLegitReceipt);
const bigLegit = JSON.parse(bigLegitJson);
assert(
  Array.isArray(bigLegit.items) && bigLegit.items.length === 300,
  'legit 300-line receipt keeps ALL line items (protected keys never shed)'
);
assert(bigLegit.total === 999999, 'legit receipt total intact');

// --- TEST 6: hostile inputs terminate ---
const cyclic = { id: 'cyc' };
cyclic.self = cyclic;
let cyclicOk = false;
try {
  const out = toBoundedSyncJson(cyclic);
  cyclicOk = typeof out === 'string' && JSON.parse(out).id === 'cyc';
} catch { cyclicOk = false; }
assert(cyclicOk, 'cyclic payload terminates with id preserved (no webview hang)');
assert(sanitizeSyncPayload(null) === null, 'null passes through');
assert(sanitizeSyncPayload(42) === 42, 'numbers pass through');
const proseNote = 'Livraison partielle reçue. Facture #2026-0917 — 40 pièces Anker, contrôle qualité OK. Reste à solder: 12 pièces (délai 7 jours).';
assert(
  sanitizeSyncPayload({ notes: proseNote }).notes === proseNote,
  'long natural-language notes preserved (spaces/punctuation are not base64)'
);
assert(
  sanitizeSyncPayload({ blob: 'x'.repeat(100000) }).blob === '',
  'long pure-base64-alphabet run treated as encoded blob and stripped'
);

// --- TEST 7: outbox product snapshot (SELECT * row shape) bounded ---
const dbRow = {
  ...bloatedProductRow, created_at: '2026-09-17T00:00:00.000Z', updated_at: '2026-09-17T00:00:00.000Z',
  sync_status: 'pending', deleted: 0,
};
assert(toBoundedSyncJson(dbRow).length <= MAX_SYNC_PAYLOAD_BYTES, 'DB-row snapshot bounded for outbox');

console.log('\n========================================================================');
console.log(`HYGIENE RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log('========================================================================');
if (failCount > 0) {
  console.error('Payload-hygiene invariant VIOLATED.');
  process.exit(1);
}
console.log('Payload-hygiene invariant holds: blobs stripped, money intact.');
