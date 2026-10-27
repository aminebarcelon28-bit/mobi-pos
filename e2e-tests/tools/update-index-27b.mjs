/**
 * Apply the BATCH 27b verdicts to CASE_INDEX.csv (21 rows: LBL 13 + HW 8).
 *
 *   node e2e-tests/tools/update-index-27b.mjs
 *
 * Rewrites only the `verdict`, `spec` and `evidence` fields of the listed ids;
 * everything else (quoting, column order, row order) is preserved. Validates
 * the file afterwards: 697 rows, 11 fields per row, no duplicate ids.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const NODE_SPEC = '27b-lbl-checks.mts';
const UI_SPEC = '27b-lbl-hw.e2e.ts';

const updates = {
  'LBL-01': ['PASS', NODE_SPEC, '204/204 EAN-13 check digits, 204/204 decode round-trip (independent L/G/R decoder over the app SVG), 200/200 unique'],
  'LBL-02': ['FAIL', NODE_SPEC, 'Code128 5/5 round-trip incl. 80-char value; symbology union is only code128|ean13 — no QR/DataMatrix/PDF417'],
  'LBL-03': ['BLOCKED', NODE_SPEC, 'needs label printer + >=2 label rolls; GAP hardcoded "2 mm, 0 mm", no dpi/offset calibration UI'],
  'LBL-04': ['FAIL', NODE_SPEC, 'price read at print time OK; no last-printed price, no stale/reprint prompt'],
  'LBL-05': ['FAIL', NODE_SPEC, '1/50/500 exact; 501/1000 silently clamp to 500 (TSPL), 51->50 (ESCPOS); printViaWindowsSpooler swallows failures so the batch always reports "N envoyees"; no cancel/progress/resume'],
  'LBL-06': ['FAIL', NODE_SPEC, '56-char FR title cut to 24; emoji split -> U+FFFD; no Arabic shaping/RTL/code page'],
  'LBL-07': ['N/A', NODE_SPEC, 'conditional [if used]; no variable-weight/embedded-price barcode support'],
  'LBL-08': ['FAIL', NODE_SPEC, 'active duplicate blocked; soft-deleted row invisible to the uniqueness check -> barcode reusable'],
  'LBL-09': ['FAIL', NODE_SPEC, 'no repair-ticket label builder (product-only: title/price/barcode/model)'],
  'LBL-10': ['N/A', NODE_SPEC, 'conditional [if any]; no label-template editor — layout fixed in productLabelBuilder'],
  'LBL-11': ['PASS-PARTIAL', UI_SPEC, 'cart intact (1 line, 1,200,000 minor) across print; no printer -> output unasserted; failed print reports success "envoyees au spooler"'],
  'LBL-12': ['FAIL', NODE_SPEC, 'no IMEI suffix/last-4 policy and no warranty type field in the label builder'],
  'LBL-13': ['FAIL', NODE_SPEC, 'no mobile->desktop label job/relay/idempotency; mobile uses its own Android print sheet'],
  'HW-01': ['FAIL', NODE_SPEC, 'Enter burst decodes and modal scans are parked, but a Tab-terminated burst is dropped (Enter-only terminator, useBarcodeScanner.ts:412-415)'],
  'HW-02': ['BLOCKED', NODE_SPEC, 'VFD path exists (hardware_update_vfd); no serial VFD/second screen on a COM port'],
  'HW-03': ['N/A', NODE_SPEC, 'no scale integration — weighingScale is only a discovered-device type'],
  'HW-04': ['BLOCKED', NODE_SPEC, 'no device-attach listener (hotplug hits=0); needs USB printer/scanner/drawer on the bench to unplug mid-sale'],
  'HW-05': ['PASS-PARTIAL', UI_SPEC, 'F1->type->Tab(66)->Enter adds a line; 800x600 label dialog not clipped; dpr/multi-monitor unasserted'],
  'HW-06': ['BLOCKED', NODE_SPEC, 'mobilePrinter BT/Wi-Fi code exists; needs Android + bonded BT/OTG printer (emulator has no BT/USB host)'],
  'HW-07': ['BLOCKED', NODE_SPEC, 'MobileCameraScanner exists; needs a phone camera + real barcodes (emulator camera is synthetic)'],
  'HW-08': ['N/A', NODE_SPEC, 'no cross-device drawer request channel'],
};

/** Minimal RFC4180 field splitter (handles "" escapes). */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;

const raw = fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
const header = splitCsv(lines[0]);
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const seen = new Set();
const moved = [];

const body = lines.slice(1).map((line) => {
  const f = splitCsv(line);
  const id = f[idx.id];
  const u = updates[id];
  if (!u) return line;
  seen.add(id);
  moved.push(`${id}: ${f[idx.verdict]} -> ${u[0]}`);
  f[idx.verdict] = u[0];
  f[idx.spec] = u[1];
  f[idx.evidence] = u[2];
  return f.map(quote).join(',');
});

const missing = Object.keys(updates).filter((id) => !seen.has(id));
if (missing.length) {
  console.error(`[fail] ids not found in the CSV: ${missing.join(', ')}`);
  process.exit(1);
}

const out = [lines[0], ...body].join('\n') + '\n';
fs.writeFileSync(CSV, out, 'utf8');

// --- validation -----------------------------------------------------------
const check = fs
  .readFileSync(CSV, 'utf8')
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .filter((l) => l.length > 0);
const ids = new Set();
let badFields = 0;
for (const line of check.slice(1)) {
  const f = splitCsv(line);
  if (f.length !== header.length) badFields += 1;
  if (ids.has(f[idx.id])) console.error(`[fail] duplicate id ${f[idx.id]}`);
  ids.add(f[idx.id]);
}
const tally = {};
for (const line of check.slice(1)) {
  const v = splitCsv(line)[idx.verdict];
  tally[v] = (tally[v] || 0) + 1;
}
console.log(`rows=${check.length - 1} fields=${header.length} bad_field_rows=${badFields} unique_ids=${ids.size}`);
console.log(`tally=${JSON.stringify(tally)}`);
console.log(`moved=${moved.length}`);
for (const m of moved) console.log(`  ${m}`);
