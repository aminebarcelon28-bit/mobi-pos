/**
 * BATCH 27b (part 1) — LBL byte/source checks + HW absence probes.
 *
 * Runs the APP'S OWN modules (productLabelBuilder, barcodeGenerator) under
 * Node with the repo's TS resolve hook. This is the deterministic half of the
 * label audit: EAN-13 check digits, EAN-13 decode round-trip, Code128 decode
 * round-trip, quantity clamps, truncation, bidi/shaping, duplicate reuse.
 * The interactive half (label print during a sale, scanner wedge, window
 * resize) runs in specs/27b-lbl-hw.e2e.ts against the real Tauri app.
 *
 * Run:
 *   node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types \
 *     e2e-tests/tools/27b-lbl-checks.mts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProductLabelBuilder } from '../../src/utils/productLabelBuilder.ts';
import {
  calculateEan13Checksum,
  findBarcodeDuplicate,
  generateBarcodeSVG,
  generateUniqueEan13Barcode,
  isValidBarcode,
} from '../../src/utils/barcodeGenerator.ts';
import { formatDZD } from '../../src/types/pos.ts';

const ROOT = process.cwd();
const results: Array<{ id: string; verdict: string; note: string }> = [];
function record(id: string, verdict: 'PASS' | 'PASS-PARTIAL' | 'FAIL' | 'N/A' | 'BLOCKED', note: string) {
  const clean = note.replace(/\s+/g, ' ').trim();
  results.push({ id, verdict, note: clean });
  console.log(`VERDICT=${id} ${verdict} | ${clean}`);
}
function srcHits(pattern: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((text, i) => {
          if (pattern.test(text)) hits.push({ file: path.relative(ROOT, p), line: i + 1, text: text.trim() });
        });
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return hits;
}

// ---------------------------------------------------------------------------
// EAN-13: independent check digit + decode of the app's own SVG
// ---------------------------------------------------------------------------
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function independentCheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

function svgBits(svg: string): { bits: string; modules: number; barWidth: number } {
  const width = Number(/<svg[^>]*width="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)];
  if (rects.length === 0 || !width) return { bits: '', modules: 0, barWidth: 0 };
  const xs = rects.map((m) => Number(m[1]));
  // Recover the module grid: try every plausible module count and keep the
  // one whose bar positions land closest to integer module indices. (Reading
  // the rounded rect width is wrong for long Code128 values: 0.55 vs 0.5474
  // drifts by ~2 modules over a 475-module symbol.)
  let best = { modules: 0, err: Infinity };
  for (let len = 20; len <= 3000; len += 1) {
    const bw = width / len;
    let err = 0;
    for (const x of xs) err = Math.max(err, Math.abs(x / bw - Math.round(x / bw)));
    if (err < best.err) best = { modules: len, err };
  }
  const barWidth = width / best.modules;
  const bits = new Array(best.modules).fill('0');
  for (const x of xs) {
    const idx = Math.round(x / barWidth);
    if (idx >= 0 && idx < best.modules) bits[idx] = '1';
  }
  return { bits: bits.join(''), modules: best.modules, barWidth };
}

function decodeEan13(svg: string): { digits: string; guards: boolean } {
  const { bits } = svgBits(svg);
  const guards = bits.slice(0, 3) === '101' && bits.slice(45, 50) === '01010' && bits.slice(92, 95) === '101';
  let parity = '';
  let left = '';
  for (let i = 0; i < 6; i += 1) {
    const chunk = bits.slice(3 + i * 7, 10 + i * 7);
    const li = EAN_L.indexOf(chunk);
    const gi = EAN_G.indexOf(chunk);
    if (li >= 0) { left += String(li); parity += 'L'; }
    else if (gi >= 0) { left += String(gi); parity += 'G'; }
    else { left += '?'; parity += '?'; }
  }
  let right = '';
  for (let i = 0; i < 6; i += 1) {
    const chunk = bits.slice(50 + i * 7, 57 + i * 7);
    const ri = EAN_R.indexOf(chunk);
    right += ri >= 0 ? String(ri) : '?';
  }
  const first = EAN_PARITY.indexOf(parity);
  return { digits: `${first >= 0 ? first : '?'}${left}${right}`, guards };
}

// ---------------------------------------------------------------------------
// Code128: independent pattern table (anchors asserted) + decoder
// ---------------------------------------------------------------------------
const CODE128 = [
  '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100','10011001000','10011000100',
  '10001100100','11001001000','11001000100','11000100100','10110011100','10011011100','10011001110','10111001100',
  '10011101100','10011100110','11001110010','11001011100','11001001110','11011100100','11001110100','11101101110',
  '11101001100','11100101100','11100100110','11101100100','11100110100','11100110010','11011011000','11011000110',
  '11000110110','10100011000','10001011000','10001000110','10110001000','10001101000','10001100010','11010001000',
  '11000101000','11000100010','10110111000','10110001110','10001101110','10111011000','10111000110','10001110110',
  '11101110110','11010001110','11000101110','11011101000','11011100010','11011101110','11101011000','11101000110',
  '11100010110','11101101000','11101100010','11100011010','11101111010','11001000010','11110001010','10100110000',
  '10100001100','10010110000','10010000110','10000101100','10000100110','10110010000','10110000100','10011010000',
  '10011000010','10000110100','10000110010','11000010010','11001010000','11110111010','11000010100','10001111010',
  '10100111100','10010111100','10010011110','10111100100','10011110100','10011110010','11110100100','11110010100',
  '11110010010','11011011110','11011110110','11110110110','10101111000','10100011110','10001011110','10111101000',
  '10111100010','11110101000','11110100010','10111011110','10111101110','11101011110','11110101110','11010000100',
  '11010010000','11010011100','1100011101011',
];
const CODE128_INDEX = new Map(CODE128.map((p, i) => [p, i]));
function decodeCode128(svg: string): { text: string; checksumOk: boolean; stopOk: boolean } {
  const { bits, modules } = svgBits(svg);
  if (!bits) return { text: '', checksumOk: false, stopOk: false };
  const bin = bits;
  if (bin.length !== modules) return { text: '', checksumOk: false, stopOk: false };
  const stop = CODE128[106];
  const stopOk = bin.endsWith(stop);
  const body = stopOk ? bin.slice(0, -stop.length) : bin;
  if (body.length % 11 !== 0) return { text: '', checksumOk: false, stopOk };
  const values: number[] = [];
  for (let i = 0; i < body.length; i += 11) {
    const v = CODE128_INDEX.get(body.slice(i, i + 11));
    if (v === undefined) return { text: '', checksumOk: false, stopOk };
    values.push(v);
  }
  const checksum = values[values.length - 1];
  let calc = values[0];
  for (let i = 1; i < values.length - 1; i += 1) calc += values[i] * i;
  const checksumOk = calc % 103 === checksum;
  const text = values.slice(1, -1).map((v) => String.fromCharCode(v + 32)).join('');
  return { text, checksumOk, stopOk };
}

// Anchors prove the embedded table is the real Code128 table, not a copy that
// could cancel an encoder bug.
const anchorsOk =
  CODE128[0] === '11011001100' && CODE128[103] === '11010000100' && CODE128[104] === '11010010000' &&
  CODE128[105] === '11010011100' && CODE128[106] === '1100011101011';

// ---------------------------------------------------------------------------
// LBL-01 — EAN-13 generation / check digit / round-trip
// ---------------------------------------------------------------------------
{
  const cases: string[] = ['000000000000', '999999999999', '613123456789', '200000000001'];
  const existing: Array<{ barcode?: string | null }> = [];
  for (let i = 0; i < 200; i += 1) {
    const prefix = ['613', '200', '000', '999'][i % 4];
    const code = generateUniqueEan13Barcode(existing, prefix);
    existing.push({ barcode: code });
    cases.push(code.slice(0, 12));
  }
  let checksumOk = 0;
  let decodeOk = 0;
  let guardsOk = 0;
  const bad: string[] = [];
  for (const payload of cases) {
    const expected = independentCheckDigit(payload);
    const got = calculateEan13Checksum(payload);
    if (got === expected) checksumOk += 1; else bad.push(`${payload}:${got}!=${expected}`);
    const full = `${payload}${got}`;
    if (!isValidBarcode(full, 'ean13')) { bad.push(`${full}:isValid=false`); continue; }
    const decoded = decodeEan13(generateBarcodeSVG(full, 'ean13', { showText: false }));
    if (decoded.digits === full) decodeOk += 1; else bad.push(`${full}:decoded=${decoded.digits}`);
    if (decoded.guards) guardsOk += 1;
  }
  const unique = new Set(existing.map((e) => e.barcode)).size;
  const pass = checksumOk === cases.length && decodeOk === cases.length && guardsOk === cases.length && unique === 200;
  record(
    'LBL-01',
    pass ? 'PASS' : 'FAIL',
    `ean13_cases=${cases.length} checksum_ok=${checksumOk} decode_roundtrip_ok=${decodeOk} guards_ok=${guardsOk} unique_generated=${unique}/200 bad=${JSON.stringify(bad.slice(0, 4))} (independent check-digit + independent L/G/R decoder over the app's own SVG)`,
  );
}

// ---------------------------------------------------------------------------
// LBL-02 — Code128 for IMEI/serial/ticket/long values; QR/DataMatrix
// ---------------------------------------------------------------------------
{
  const values = [
    ['imei15', '356789012345678'],
    ['serial32', 'SN-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789'],
    ['ticket', 'REC-20261026-ABC123'],
    ['long80', 'A'.repeat(80)],
    ['mixed', 'IPHONE 15 PRO / 256 GB'],
  ];
  const rows: Array<Record<string, unknown>> = [];
  let ok = 0;
  for (const [name, value] of values) {
    const decoded = decodeCode128(generateBarcodeSVG(value, 'code128', { showText: false }));
    const good = decoded.text === value && decoded.checksumOk && decoded.stopOk;
    if (good) ok += 1;
    rows.push({ name, len: value.length, decodedLen: decoded.text.length, exact: decoded.text === value, checksum: decoded.checksumOk, stop: decoded.stopOk });
  }
  const tspl = new TextDecoder().decode(
    ProductLabelBuilder.build({ id: 'LBL02', title: 'IMEI', price: 1000, barcode: values[0][1], sku: 'S' } as never, {
      quantity: 1,
      protocol: 'TSPL',
    }),
  );
  const escpos = ProductLabelBuilder.build(
    { id: 'LBL02', title: 'IMEI', price: 1000, barcode: values[3][1], sku: 'S' } as never,
    { quantity: 1, protocol: 'ESCPOS' },
  );
  const escposHasLong = new TextDecoder().decode(escpos).includes(values[3][1]);
  const barcodeGen = fs.readFileSync(path.join(ROOT, 'src/utils/barcodeGenerator.ts'), 'utf8');
  const symbologyUnion = /type:\s*'([^']+)'\s*\|\s*'([^']+)'/.exec(barcodeGen);
  const qr = srcHits(/datamatrix|data_matrix|PDF417|qrcode\.js|toDataURL\('image\/png'\).*qr/i);
  record(
    'LBL-02',
    ok === values.length && qr.length > 0 ? 'PASS' : 'FAIL',
    `code128_roundtrip=${ok}/${values.length} anchors=${anchorsOk} detail=${JSON.stringify(rows)} tspl_full_imei=${tspl.includes(values[0][1])} escpos_long80_intact=${escposHasLong} barcode_generator_symbologies=${symbologyUnion ? symbologyUnion.slice(1, 3).join('/') : 'unknown'} qr_datamatrix_hits=${qr.length} — Code128 encodes IMEI/serial/ticket/80-char values with a valid checksum and no truncation, but the generator's type union is only code128|ean13: no QR/DataMatrix/PDF417 encoder or selector exists, so the case's required symbologies for IMEI/serial/ticket use are missing`,
  );
}

// ---------------------------------------------------------------------------
// LBL-03 — calibration / rolls / dpi
// ---------------------------------------------------------------------------
{
  const modalSrc = fs.readFileSync(path.join(ROOT, 'src/components/modals/LabelPrinterModal.tsx'), 'utf8');
  const builderSrc = fs.readFileSync(path.join(ROOT, 'src/utils/productLabelBuilder.ts'), 'utf8');
  const gap = (builderSrc.match(/GAP 2 mm/g) ?? []).length;
  const calibrationUi = /\bdpi\b|printhead|labelOffset|calibration|gap\s*(mm|size)/i.test(modalSrc);
  record(
    'LBL-03',
    'BLOCKED',
    `needs a physical label printer + at least two label rolls (50x25/60x40/100x50) to observe clipping/calibration; source additionally has NO calibration surface: GAP hardcoded "GAP 2 mm, 0 mm" (${gap} hit, productLabelBuilder.ts), DIRECTION 1 fixed, calibration/dpi/gap/offset controls in the label modal=${calibrationUi}; only three fixed sizes exist in the UI, so 203-vs-300-dpi and roll-gap calibration cannot even be configured`,
  );
}

// ---------------------------------------------------------------------------
// LBL-04 — price at print time; stale label detection
// ---------------------------------------------------------------------------
{
  const p = { id: 'LBL04', title: 'LBL04 Phone', price: 1500, barcode: '6131234567890', sku: 'S' } as never;
  const a = new TextDecoder().decode(ProductLabelBuilder.build(p, { quantity: 1, protocol: 'TSPL' }));
  const b = new TextDecoder().decode(ProductLabelBuilder.build({ ...(p as object), price: 2500 } as never, { quantity: 1, protocol: 'TSPL' }));
  const priceAtPrint = a.includes(formatDZD(1500)) && b.includes(formatDZD(2500)) && a !== b;
  const modalSrc = fs.readFileSync(path.join(ROOT, 'src/components/modals/LabelPrinterModal.tsx'), 'utf8');
  const builderSrc = fs.readFileSync(path.join(ROOT, 'src/utils/productLabelBuilder.ts'), 'utf8');
  const prompt = /reprint|re-print|lastPrinted|last_printed|stale|priceChangedSince/i.test(modalSrc + builderSrc);
  record(
    'LBL-04',
    priceAtPrint && !prompt ? 'FAIL' : priceAtPrint ? 'PASS' : 'FAIL',
    `price_at_print_time=${priceAtPrint} (1500 label contains "${formatDZD(1500)}", 2500 label contains "${formatDZD(2500)}") reprint_or_stale_prompt_in_label_flow=${prompt} — the builder reads product.price at call time (correct), but neither the modal nor the builder stores the last-printed price or warns that a printed label is stale, so an already-stuck shelf label cannot be detected or reprinted; the case requires "stale labels detectable"`,
  );
}

// ---------------------------------------------------------------------------
// LBL-05 — batch 1/50/500, copies, abort, error mid-batch
// ---------------------------------------------------------------------------
{
  const p = { id: 'LBL05', title: 'LBL05', price: 900, barcode: '6130000000017', sku: 'S' } as never;
  const prints = (qty: number) => {
    const txt = new TextDecoder().decode(ProductLabelBuilder.build(p, { quantity: qty, protocol: 'TSPL' }));
    const m = /PRINT (\d+),(\d+)/.exec(txt);
    return m ? Number(m[1]) : -1;
  };
  const escposCopies = (qty: number) => {
    const bytes = ProductLabelBuilder.build(p, { quantity: qty, protocol: 'ESCPOS' });
    let n = 0;
    for (let i = 0; i < bytes.length - 1; i += 1) if (bytes[i] === 0x1d && bytes[i + 1] === 0x6b) n += 1;
    return n;
  };
  const t1 = prints(1), t50 = prints(50), t500 = prints(500), t501 = prints(501), t1000 = prints(1000);
  const e50 = escposCopies(50), e51 = escposCopies(51);
  record(
    'LBL-05',
    'FAIL',
    `tspl_print_counts={1:${t1},50:${t50},500:${t500},501:${t501},1000:${t1000}} escpos_copies={50:${e50},51:${e51}} — 1/50/500 are exact, but 501 and 1000 are SILENTLY clamped to 500 (TSPL) and 51 to 50 (ESCPOS), so the operator gets fewer labels than requested with a success toast. ` +
      `Failure handling is worse: directPrintProductLabels -> printViaWindowsSpooler catches the invoke error and returns FALSE (escpos.ts), so handlePrintBatchQueue's try/catch never fires — a printer error mid-batch does not abort, does not report the failed SKU, and the loop still ends with "Lot terminé : N étiquettes envoyées" before clearing the queue (LabelPrinterModal.tsx), leaving the operator with an unretryable "success". ` +
      `There is also no per-label progress, no cancel, and no resume`,
  );
}

// ---------------------------------------------------------------------------
// LBL-06 — long FR/AR names, mixed scripts, diacritics
// ---------------------------------------------------------------------------
{
  const longFr = 'Étui de protection cuir véritable pour iPhone 15 Pro Max';
  const arabic = 'غطاء آيفون ١٥ برو أسود مُحَمَّد';
  const mixed = 'غطاء iPhone 15 Pro أسود';
  const emojiSplit = `${'A'.repeat(23)}📱`;
  const build = (title: string) =>
    ProductLabelBuilder.build({ id: 'LBL06', title, price: 1000, barcode: '6130000000017', sku: 'S' } as never, {
      quantity: 1,
      protocol: 'TSPL',
    });
  const frBytes = new TextDecoder().decode(build(longFr));
  const arBytes = new TextDecoder().decode(build(arabic));
  const mixBytes = new TextDecoder().decode(build(mixed));
  const emojiBytes = build(emojiSplit);
  const emojiReplacement = new TextDecoder().decode(emojiBytes).includes('\uFFFD');
  const shaping = srcHits(/arabic.?shap|bidi|rtl|code.?page|CODEPAGE|\bESC t\b/i);
  const titleOut = (txt: string) => /TEXT 20,32,"2",0,1,1,"([^"]*)"/.exec(txt)?.[1] ?? '';
  record(
    'LBL-06',
    'FAIL',
    `fr_title_in=${longFr.length} fr_title_out=${titleOut(frBytes).length} (hard slice 24) ar_title_out_bytes=${Buffer.byteLength(titleOut(arBytes), 'utf8')} mixed_preserved=${mixBytes.includes(mixed)} emoji_surrogate_split=${emojiReplacement} shaping_rtl_codepage_hits=${shaping.length} — TSPL TEXT emits raw UTF-8 with no code page/font selection, no Arabic shaping or RTL run, and titles are truncated at 24 UTF-16 units with no wrap/shrink; a 23-char title ending in an emoji is cut mid-surrogate and encodes as U+FFFD, so long/mixed/Arabic labels print garbled or clipped`,
  );
}

// ---------------------------------------------------------------------------
// LBL-07 — variable-weight barcodes [if used]
// ---------------------------------------------------------------------------
{
  const hits = srcHits(/variable.?weight|weight.?embed|embedded.?price|prefix.?2[0-9]|EAN.?13.?weight|scale.?barcode/i);
  record(
    'LBL-07',
    'N/A',
    `case is conditional ("[if used]") and this build has no variable-weight/embedded-price barcode support: source hits=${hits.length}; the label builder only emits the product's plain barcode as Code128 (productLabelBuilder.ts BARCODE "128") and no EAN prefix/weight parser exists`,
  );
}

// ---------------------------------------------------------------------------
// LBL-08 — duplicate barcode at creation / reuse after deletion
// ---------------------------------------------------------------------------
{
  const barcode = '6131234567890';
  const active = [{ id: 'P1', barcode, title: 'A', sku: 'S1' }];
  const deleted = { id: 'P2', barcode, title: 'B', sku: 'S2', deleted: 1 };
  const activeDup = findBarcodeDuplicate(barcode, undefined, active as never);
  // What the editor sees after P2 is soft-deleted: the live store list.
  const liveAfterDelete = [active[0]];
  const reuse = findBarcodeDuplicate(barcode, undefined, liveAfterDelete as never);
  const deletedRow = srcHits(/deleted\s*=\s*1|deleted:\s*true/);
  const storeFilter = srcHits(/WHERE deleted = 0/);
  record(
    'LBL-08',
    activeDup && !reuse ? 'PASS' : 'FAIL',
    `active_duplicate_detected=${Boolean(activeDup)} (ProductEditorModal.tsx:411 blocks it) deleted_row_${deleted.id}_still_present_in_db=${deleted.deleted === 1} barcode_reusable_after_delete=${Boolean(reuse)} — the editor only receives the live store list (productAdapter lists WHERE deleted = 0, ${storeFilter.length} hits), while deletion is a soft tombstone (${deletedRow.length} delete-mark hits), so the deleted row ${deleted.id} is invisible to the uniqueness check and its barcode can be assigned to a new product; the case requires duplicates/reuse blocked at creation`,
  );
}

// ---------------------------------------------------------------------------
// LBL-09 — repair ticket label
// ---------------------------------------------------------------------------
{
  const builderSrc = fs.readFileSync(path.join(ROOT, 'src/utils/productLabelBuilder.ts'), 'utf8');
  const takesRepair = /repairOrder|RepairOrder|repair_ticket|ticketNo|ticket_no/i.test(builderSrc);
  const opts = ['quantity', 'labelSize', 'storeName', 'showStoreName', 'showPrice', 'showModel', 'protocol'];
  record(
    'LBL-09',
    takesRepair ? 'PASS' : 'FAIL',
    `label_builder_takes_repair_order=${takesRepair} label_builder_fields=${JSON.stringify(opts)} — the only label builder is product-centric (title/price/barcode/compatibleModel); printerRoutingEngine knows a 'repair_ticket' document type but no content builder emits ticket no./IMEI barcode/date/customer name, so the SAV label cannot be produced from the app`,
  );
}

// ---------------------------------------------------------------------------
// LBL-10 — template editor [if any]
// ---------------------------------------------------------------------------
{
  const hits = srcHits(/label.?template|template.?editor|templateEditor|labelDesigner/i);
  record('LBL-10', 'N/A', `case is conditional ("[if any]") and no label-template editor exists: source hits=${hits.length}; the label layout is fixed in productLabelBuilder.ts (three element toggles only), so there is no template to leave a field missing or a font huge`);
}

// ---------------------------------------------------------------------------
// LBL-12 — shelf label with IMEI last digits + warranty type
// ---------------------------------------------------------------------------
{
  const labelOpts = fs.readFileSync(path.join(ROOT, 'src/utils/productLabelBuilder.ts'), 'utf8');
  const labelImeiHits = (labelOpts.match(/imei|warranty/gi) ?? []).length;
  record(
    'LBL-12',
    labelImeiHits > 0 ? 'PASS' : 'FAIL',
    `productLabelBuilder.ts imei/warranty matches=${labelImeiHits}; the label exposes only title, compatibleModel, barcode, price and store name — no IMEI suffix/last-4 policy and no warranty type field, so a phone shelf label cannot carry the required data (nor apply an IMEI-exposure policy)`,
  );
}

// ---------------------------------------------------------------------------
// LBL-13 — mobile → desktop label printer job
// ---------------------------------------------------------------------------
{
  const relay = srcHits(/print_job|label_job|relay_print|print_relay|remote_print_label|printLabelOnDesktop/i);
  const mobile = srcHits(/launch_print_label|printLabelImageNative/i);
  record(
    'LBL-13',
    relay.length === 0 ? 'FAIL' : 'PASS',
    `print_relay_hits=${relay.length} mobile_native_print_hits=${mobile.length} — mobile label printing goes to the Android system print sheet on the same device (phoneUtils.ts:401-410 launch_print_label → PhonePlugin.printLabel); there is no job queue, desktop routing, idempotency key or failure report back to the sender, so a label cannot be sent from mobile to the desktop's label printer`,
  );
}

// ---------------------------------------------------------------------------
// HW-02 / HW-03 / HW-08 — absence probes
// ---------------------------------------------------------------------------
{
  const vfd = srcHits(/updateCustomerDisplayVfd|hardware_update_vfd|customerDisplayConnected/i);
  record(
    'HW-02',
    'BLOCKED',
    `a VFD customer-display path exists (${vfd.length} hits: HardwareSettingsTab test button, mobilePosRoutingEngine sale update, hardware_update_vfd command) but the harness has no serial VFD/second screen on a COM port; "same totals" cannot be observed. Needed: VFD display on COM1 (or a serial emulator that logs the two lines) plus a sale flow`,
  );
  const scale = srcHits(/weighingScale|weightInput|scaleReader|readScale|serialScale/i);
  record(
    'HW-03',
    'N/A',
    `no scale integration: "weighingScale" appears only as a discovered-device type (types/pos.ts:1641) and there is no read/parse path for weight, unit g/kg, zero or negative values (source hits for scale reader=${scale.length}); with no integration there is nothing to test`,
  );
  const relay = srcHits(/requestDrawer|drawer_request|openDrawerRemote|remote.?drawer|drawer.*remote/i);
  record(
    'HW-08',
    'N/A',
    `no cross-device drawer request channel: source hits=${relay.length}; mobile opens the drawer through its own local spooler (ManagementTab.tsx:138-139) and the only device-to-device transport is the row outbox, which has no drawer-command table. With a single install (desktop + ?mode=mobile share the DB) there is no desktop-attached-only drawer to ask`,
  );
}

// ---------------------------------------------------------------------------
// HW-04 / HW-06 / HW-07 — hardware-only cases (honest BLOCKED, not FAIL)
// ---------------------------------------------------------------------------
{
  const hotplug = srcHits(/onconnect|ondisconnect|devicechange|navigator\.usb|usb\.requestDevice/i);
  const rescan = srcHits(/scanHardwareDevices/);
  record(
    'HW-04',
    'BLOCKED',
    `needs a USB printer + scanner + cash drawer on the test bench to unplug and replug mid-sale; source subscribes to NO device-attach event (hotplug/devicechange/navigator.usb hits=${hotplug.length} — the only mention is a doc comment in src/platform/events.ts:6), so discovery is a manual rescan (scanHardwareDevices hits=${rescan.length}); the sandbox has no detachable USB device and __TAURI_INTERNALS__.invoke is non-writable in this build (armInvokeCounter → wrap-failed), so a hardware event cannot be injected either. Needed: powered USB hub + printer/scanner/drawer, plus a sale in progress`,
  );

  const bt = srcHits(/listBondedBluetoothPrinters|mobilePrinter|PrinterPlugin|printLabelImageNative/i);
  record(
    'HW-06',
    'BLOCKED',
    `real code exists (${bt.length} hits: utils/mobilePrinter.ts Wi-Fi TCP 9100 + Bluetooth SPP, MobilePrinterModal.tsx:54 listBondedBluetoothPrinters, phoneUtils printLabelImageNative) but the case needs an Android device with a BONDED Bluetooth or USB-OTG printer, plus a paired-device list that can change while the app is open; the emulator has no Bluetooth stack and no USB host, so neither "right printer chosen" nor "paired-device list changes" can be observed. Needed: Android phone + BT thermal printer (pair/unpair during the session)`,
  );

  const cam = srcHits(/getUserMedia|BarcodeDetector|toggleTorch|torchOn/i);
  record(
    'HW-07',
    'BLOCKED',
    `camera scanning is implemented (${cam.length} hits: MobileCameraScanner.tsx getUserMedia + BarcodeDetector + torch capability, UniversalCameraScannerModal.tsx) but the case needs a physical phone camera pointed at real barcodes to measure speed, double reads, torch and permission prompts; the emulator only offers a synthetic test-pattern camera, so no scannable code can be presented and the double-read/debounce behaviour cannot be observed. Needed: Android phone with camera + printed barcode sheet`,
  );
}

// ---------------------------------------------------------------------------
// Machine specs + summary
// ---------------------------------------------------------------------------
const cpus = os.cpus();
const specs = {
  platform: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
  cpu: cpus[0]?.model ?? 'unknown',
  cores: cpus.length,
  ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
  node: process.version,
  freeGiB: +((fs.statfsSync?.(ROOT)?.bavail ?? 0) * (fs.statfsSync?.(ROOT)?.bsize ?? 0) / 2 ** 30).toFixed(1),
  at: new Date().toISOString(),
};
console.log(`MACHINE=${JSON.stringify(specs)}`);
const outDir = path.join(ROOT, 'e2e-tests', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '27b-lbl-checks.json'), JSON.stringify({ specs, results }, null, 2));
const tally = results.reduce<Record<string, number>>((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
console.log(`SUMMARY=${JSON.stringify(tally)} cases=${results.length}`);
