/**
 * Apply the BATCH 27c verdicts to CASE_INDEX.csv (16 rows: I18 14 + DAT 2).
 *
 *   node e2e-tests/tools/update-index-27c.mjs
 *
 * The verdict for each id is read from the canonical log (single source of
 * truth) and cross-checked against the expected tally below, so the CSV can
 * never disagree with logs/part0-27c.log. Only `verdict`, `spec` and
 * `evidence` are rewritten; quoting, column order and row order are preserved.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const LOG = path.join(ROOT, 'logs', 'part0-27c.log');
const NODE_SPEC = '27c-i18-checks.mts';
const UI_SPEC = '27c-i18-ui.e2e.ts';

// verdict expected from the log -> guard against a silent re-run drift
const EXPECTED = {
  'I18-01': 'FAIL',
  'I18-02': 'PASS',
  'I18-03': 'FAIL',
  'I18-04': 'FAIL',
  'I18-06': 'FAIL',
  'I18-07': 'FAIL',
  'I18-08': 'FAIL',
  'I18-09': 'FAIL',
  'I18-10': 'PASS-PARTIAL',
  'I18-11': 'FAIL',
  'I18-12': 'FAIL',
  'I18-13': 'FAIL',
  'I18-14': 'BLOCKED',
  'I18-15': 'FAIL',
  'DAT-79': 'FAIL',
  'DAT-84': 'FAIL',
};

const EVIDENCE = {
  'I18-01': [
    UI_SPEC,
    'Companion shell (the only surface importing src/i18n): FR/AR toggle flips dir ltr<->rtl, <html lang> fr<->ar and all six nav labels live, and the sale survives it — cart badge "Caisse — 1"/"الصندوق — 1"/"Caisse — 1", all 5 controls referencing the product title, and the typed search "PROBE" are identical across fr->ar->fr. FAIL on two named facets: (a) mid-payment switch is impossible — with the cash sheet open the backdrop covers the only language control (elementFromPoint = DIV fixed inset-0 bg-black/80, real click = "element click intercepted"); (b) EN is not a shipped locale (isSupportedLocale accepts fr/ar/pseudo, src/i18n/index.ts:52-54) and mid-ticket printing needs a printer. Also observed: the desktop till has no locale of its own and inherits the last companion dir/lang.',
  ],
  'I18-02': [
    UI_SPEC,
    'Companion shell RTL geometry at 1280x749: no horizontal overflow in either direction (scrollW 1280 = innerW 1280), the bottom-nav rail mirrors (first tab l=4 -> l=1204), the cart pane control mirrors to the opposite half (l=1194 -> l=32), the cash sheet stays inside the viewport (416..864) with its Arabic title "تحصيل نقدي" inside and close button on the flipped side, and the visible DA amounts are the same multiset in both directions. Measured vacuous rather than unasserted: 0 <table>/[role=table|grid] and 0 custom tooltip layer on this screen.',
  ],
  'I18-03': [
    UI_SPEC,
    'Display/storage keep logical order end to end: customer "أحمد بن علي iPhone 15" stored byte-exact (DB string == DOM string), phone 0555000000, product tile "غلاف iPhone 15 Pro 128GB" with dir=ltr/unicode-bidi=isolate and the Latin+digit run not reordered. FAIL on the print facet: ESC/POS text() truncates every UTF-16 unit to its low byte and never selects a code page (src/utils/escpos.ts:61-68), so this name reaches a thermal receipt as "#-E/ (F 9DJ" (FACT=I18-03_PRINT). Export facet measured by I18-08.',
  ],
  'I18-04': [
    NODE_SPEC,
    'Product omnisearch fold covers 8/10 of the case list (0 misses among harakat, hamza-alef forms, ta marbuta, alef maqsura, Latin accents) but misses tatweel and Arabic-Indic digits. Customer directory fold is a different inline NFD+lowercase helper: 2/10 pairs fold equal (only the two Latin-accent ones), 8 duplicate foldForSearch definitions across the app (src/utils/catalogSearch.ts:58, CustomersModal.tsx:23, KredyTab.tsx:49, DebtLedgerModal.tsx:4, KittingBundleModal.tsx:5, LabelPrinterModal.tsx:23, PriceBooksModal.tsx:40, RefundModal.tsx:3), so the same typed name finds a product and misses the customer.',
  ],
  'I18-06': [
    NODE_SPEC,
    '18 localeCompare call sites, 0 pass an explicit locale and 0 use Intl.Collator, so ordering follows the host default rather than the UI language; case-insensitive Latin and Arabic alphabetical order are therefore not language-driven.',
  ],
  'I18-07': [
    UI_SPEC,
    'Storage and rendering are safe: XSS payload, RLO/ZWSP name and the 229-char emoji+Arabic product title are stored byte-exactly, React renders them as text (0 <img>, 0 <script>, no handler ran), no horizontal break (scrollW 1280 = innerW 1280) and the catalog tile keeps the full logical string. FAIL on the print facet: the ESC/POS encoder emits low bytes with no escaping and no code page, so "🔛@X" becomes 3d 1b 40 58 — a raw "ESC @" (printer reset) injected into the receipt stream (FACT=I18-07_PRINT).',
  ],
  'I18-08': [
    NODE_SPEC,
    'Export writes a UTF-8 BOM, ";" separators and quoted fields, but decimals use "."; the importer does not undo locale grouping — "1 234,56" imports as 123456 and "12,5" as 125, so a round-trip through Excel in fr-DZ or ar-DZ corrupts amounts by 100x.',
  ],
  'I18-09': [
    UI_SPEC,
    'The HID wedge accumulates e.key verbatim (src/hooks/useBarcodeScanner.ts:412-415), so it is layout-dependent: a US-HID burst sells (+1200000 minor) and the same characters with a bogus e.code still sell (e.code ignored), but an Arabic-Indic-digit burst emits scan event "٦١٣٢٧٠٠٠٠٠٠١٧" and an AZERTY top row emits "-&\\"éèàààààà&è", both with 0 cart delta. A US-configured scanner on an AZERTY or Arabic machine cannot sell.',
  ],
  'I18-10': [
    UI_SPEC,
    'Dictionaries are key-identical: 822/822/822 keys fr/ar/pseudo, 0 missing in ar, 0 interpolation-placeholder mismatches (FACT=I18-10_DICT). Four Arabic screens walked (checkout, activity, management, cash sheet) show 0 raw i18n keys and 0 horizontal overflow. Partial because the case says "scan all screens" and reports/labels/refund/settings sub-tabs were not walked.',
  ],
  'I18-11': [
    NODE_SPEC,
    'Five Mohamed spellings (the Latin transliterations mohamed/mohammed/muhammad/mhamed/mohamad, plus the Arabic form with and without diacritics) resolve to 5 distinct search keys, and the Arabic query folds to the EMPTY string because cleanAlphanumeric keeps only a-z0-9; there is no name-synonym table (the only synonym list is the product cluster table in utils/catalogSearch.ts:20-36), so the same person typed two ways is two customers. The 1M-row ranking half of the case is NEEDS-LONG and is not asserted.',
  ],
  'I18-12': [
    NODE_SPEC,
    'The customer record has a single free-text `name` field — no title/honorific and no family-name split — so salutation, first name and surname cannot be stored or printed separately.',
  ],
  'I18-13': [
    UI_SPEC,
    'The field is good: 9 written variants of one mobile collapse to +213550123456 and 4/14 invalid inputs report isValid=false; a 9-digit entry shows the amber "Format DZ attendu" hint and aria-invalid=true. FAIL at the save path: cleanPhone falls back to digitsOnly when !isValid (src/components/modals/CustomersModal.tsx:550-551) and showSuccess fires anyway, so "055012345" is written to the CRM with no rejection (FACT=I18-13_CANONICAL).',
  ],
  'I18-14': [
    NODE_SPEC,
    'needs a real Android soft keyboard (Gboard ar/fr) with a learned dictionary and cloud suggestions, to observe whether composition events mutate IMEI/phone/amount fields and whether suggestions leak other customers names; the emulator AOSP keyboard has no learned dictionary and driving the IME composition protocol over CDP is not equivalent.',
  ],
  'I18-15': [
    UI_SPEC,
    'Phone field owns a paste handler (preventDefault + clean + formatDzPhone): "+213<NBSP>770<RLM>111222" lands as "+213 770 11 12 22" and stores as 0770111222; the NBSP-grouped tender "1 000" parses as 1000 with change "11 000 DA". FAIL on the name field: no paste handler (synthetic ClipboardEvent not cancelled), so "  أحمد<NBSP>بن<RLM> علي\\n" is stored verbatim with the NBSP and RLM intact — exactly the invisible characters a WhatsApp paste carries and the search fold does not strip (I18-04).',
  ],
  'DAT-79': [
    NODE_SPEC,
    'Near-zero-RPO transport is not implemented: replica_hits=24, standby_hits=3, RPO_hits=0, promote_hits=5, 0 lag/drill evidence. Turso is a remote sync transport only (no embedded replica, no replica sync() semantics), and no standby/promotion drill exists.',
  ],
  'DAT-84': [
    NODE_SPEC,
    '3/10 required data-safety signals are present and there is no alert channel: no backup-age/verified/off-machine panel, no last-restore line, no threshold warning, so the owner cannot see backup health from the app.',
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

// --- verdicts from the canonical log --------------------------------------
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
