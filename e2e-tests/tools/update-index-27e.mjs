/**
 * Apply the BATCH 27e verdicts to CASE_INDEX.csv (6 PRF rows).
 *
 *   node e2e-tests/tools/update-index-27e.mjs
 *
 * Verdicts are read from logs/part0-27e.log (single source of truth) and
 * cross-checked against the expected tally, so the CSV can never disagree with
 * the canonical log. Only `verdict`, `spec` and `evidence` are rewritten.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const LOG = path.join(ROOT, 'logs', 'part0-27e.log');
const SPEC = '27e-prf-checks.mts';

const EXPECTED = {
  'PRF-01': 'FAIL',
  'PRF-02': 'BLOCKED',
  'PRF-03': 'BLOCKED',
  'PRF-04': 'BLOCKED',
  'PRF-05': 'FAIL',
  'PRF-06': 'BLOCKED',
};

const EVIDENCE = {
  'PRF-01': [
    SPEC,
    'Add-to-cart is fast (300 shipped store adds: p95 < 0.1 ms, max 8.9 ms, 0 rejected) but search-as-you-type is far outside the case s 100 ms example budget: on 100 000 products the desktop pipeline (filter with matchProductSearch + sort by name_asc, ProductCatalog.tsx:475-507) is p50 825 ms / p95 968 ms, and the mobile pipeline does the same full scan after a 200 ms debounce (CatalogSearchTab.tsx:86-97,173-189) at p95 990 ms. A one-character query matches 100 000 rows and both sale surfaces render every row (ProductCatalog.tsx:856,885; CatalogSearchTab.tsx:478) - @tanstack/react-virtual is used only by CustomersModal/InventoryManagerModal, never by the catalog the cashier sells from. The catalog is fully materialised at boot (SELECT * with no LIMIT, productAdapter.ts:171).',
  ],
  'PRF-02': [
    SPEC,
    'BLOCKED - an 8-hour and a 72-hour session need 72 h of wall clock plus handle/memory sampling of the real Tauri WebView (G-16), and e2e-tests has no soak driver or handle-count instrumentation. A shortened soak would not assert the named durations, so nothing is claimed.',
  ],
  'PRF-03': [
    SPEC,
    'BLOCKED - no 2 GB / old-CPU machine exists here: the host is a Ryzen 5 8500G with 15.1 GiB RAM (12 cores) and Windows offers no reliable way to constrain the desktop app to 2 GB with CPU throttling. Measuring on this host would measure the wrong machine.',
  ],
  'PRF-04': [
    SPEC,
    'BLOCKED - no low-end Android device is attached and the mobile shell is only reachable as a WebView device-role switch, not as a phone with a camera. Scrolling 100 k customers, searching and capturing a photo simultaneously (ANR/memory budget, MOB-21) needs real hardware and the native camera path.',
  ],
  'PRF-05': [
    SPEC,
    'The customer lane is the only boot lane with no window: the exact query (customerAdapter.ts:221-224) selects every column of every live customer, ORDER BY name ASC with no supporting index (lib.rs:1023-1025 indexes phone/barcode/loyalty_card only) and no LIMIT, and the store awaits it in the boot Promise.all (createUISlice.ts:1990-2023) while transactions/expenses/shifts get bounded windows. Measured on 1 000 000 customers: SQL 3 747 ms + row/JSON mapping 899 ms = 4 646 ms lower bound (excludes tauri-plugin-sql IPC serialisation), 194.0 MiB payload, +858 MiB heap / +870 MiB RSS. The shell paints before wave 2 so the till is usable early, but every customer surface stays empty until this load finishes and the whole table stays resident.',
  ],
  'PRF-06': [
    SPEC,
    'BLOCKED - syncing 1 M customer changes plus 5 000 sales on mobile data needs a configured merchant gateway (sync.gateway_url is unset, the drain idles), a mobile-data link with measurable bandwidth/latency, and a second enrolled terminal for the peer/resume side (SYN-09/SYN-24). The loopback verifier proves the signed-lane protocol, not the case s bandwidth/time budgets.',
  ],
};

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

const log = fs.readFileSync(LOG, 'utf8');
const logVerdicts = {};
for (const line of log.split(/\r?\n/)) {
  const m = /^VERDICT=([A-Z0-9-]+) (\S+)/.exec(line);
  if (m) logVerdicts[m[1]] = m[2];
}
const drift = Object.keys(EXPECTED).filter((id) => logVerdicts[id] !== EXPECTED[id]);
if (drift.length) {
  console.error('[fail] log disagrees with the expected tally:');
  for (const id of drift) console.error(`  ${id} log=${logVerdicts[id] ?? '(absent)'} expected=${EXPECTED[id]}`);
  process.exit(1);
}

const updates = {};
for (const id of Object.keys(EXPECTED)) {
  const [spec, evidence] = EVIDENCE[id];
  updates[id] = [logVerdicts[id], spec, evidence];
}

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

fs.writeFileSync(CSV, [lines[0], ...body].join('\n') + '\n', 'utf8');

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
