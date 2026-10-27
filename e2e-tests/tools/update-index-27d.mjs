/**
 * Apply the BATCH 27d verdicts to CASE_INDEX.csv (12 RPT rows).
 *
 *   node e2e-tests/tools/update-index-27d.mjs
 *
 * Verdicts are read from logs/part0-27d.log (single source of truth) and
 * cross-checked against the expected tally, so the CSV can never disagree with
 * the canonical log. Only `verdict`, `spec` and `evidence` are rewritten.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const LOG = path.join(ROOT, 'logs', 'part0-27d.log');
const SPEC = '27d-rpt-checks.mts';

const EXPECTED = {
  'RPT-01': 'FAIL',
  'RPT-03': 'PASS',
  'RPT-04': 'FAIL',
  'RPT-05': 'FAIL',
  'RPT-06': 'PASS-PARTIAL',
  'RPT-07': 'FAIL',
  'RPT-08': 'PASS',
  'RPT-09': 'FAIL',
  'RPT-10': 'FAIL',
  'RPT-11': 'FAIL',
  'RPT-12': 'FAIL',
  'RPT-13': 'FAIL',
};

const EVIDENCE = {
  'RPT-01': [
    SPEC,
    'Tender dimension reconciles exactly (payments sheet total 78 500 DA == CA Net) but the others do not: the product dimension sums line revenue 84 500 DA (no transaction-level discount, refund vouchers carry no items) vs 78 500 DA and the chart keeps only the top 5 (74 000 DA, leaving 10 500 DA invisible); the category donut renders integer % margin shares and silently drops non-positive categories (Services -1 000 DA, positives 26 300 vs all 25 300); day buckets cover only 7 calendar days (SalesAnalyticsCharts.tsx:101-108), leaving 2 fixture days outside; and no cashier dimension exists at all - SaleTransaction has cashierName only (src/types/pos.ts:584) and no source file groups by cashier. Fixture: 14 ledger rows, app code computeSalesMetrics vs an independent oracle (both 78 500 / 54 000 / 26 500).',
  ],
  'RPT-03': [
    SPEC,
    'Every named facet matches the oracle to the dinar on a 14-row ledger: discounts (discountTotal 1 000, CA Net uses net(total) not gross), refunds/restock (5 000 refunded, 2 000 recovered COGS credited -> profit 26 500), refund/write-off (no restoredCogs, the loss stays a burden), trade-in cost basis (the signed row cost 4 000 wins; an injected 9 999 allocation on the exchange row is ignored) and repair labour/parts (SAV row built exactly as RepairWorkOrderModal.tsx:890-940: charge 15 000 incl. labour - frozen parts basis 6 000 = profit 9 000). App metrics and the independent oracle agree on net/cost/restored/profit/basket.',
  ],
  'RPT-04': [
    SPEC,
    'Day-key boundaries are correct (today 00:00:00.000 and 23:59:59.999 map to the same key, tomorrow 00:00:00.000 does not) but the period definitions are not one: desktop "7 jours" is a rolling 168 h window (ReportsModal.tsx:241-247) while mobile is a calendar key range D-6..D (LiveActivityTab.tsx:208-230); on this run their start instants differ by 16.2 h and a day-7 sale worth 12 000 DA is counted by desktop and not by mobile. No business-day cutoff exists (dateUtils only exposes a timezone, src/utils/dateUtils.ts:11-19) and the range read has no upper bound (transactionAdapter.ts:528-533), so a future-dated 2 500 DA row sits inside 7j/30j/Tout but not inside Aujourd hui.',
  ],
  'RPT-05': [
    SPEC,
    'XLSX export does not equal the screen: the headline rows match (net/cost/profit 78 500/54 000/26 500) but the per-row columns do not - cost column 54 200 DA vs 54 000 (sheets.ts:151-159 ignores the materialized ledgerCogsTotal and the exchange signed-cost branch used by receiptMath.ts:187-202) and profit column 29 300 DA vs 26 500 (refund rows forced to profit=0, sheets.ts:160-161, so the refund/restored-Cogs credit never reaches the rows); the items sheet sums gross charged lines 84 500 DA vs 78 500. Scale facet measured: 100 000 rows -> 10.1 s, +479 MiB heap, 180.7 MiB XML, 100 000 sale rows, last receipt present, no truncation; 200 001 rows fail closed with the typed TOO_LARGE. PDF/CSV writers are not importable and were not executed.',
  ],
  'RPT-06': [
    SPEC,
    'Read path is snapshot-consistent: with the report SELECT open in a WAL read transaction the count stayed 100 while a concurrent writer committed 50 rows (invisible in the snapshot, visible after commit), and the report issues exactly one statement per open (transactionAdapter.ts:528-533), so a sale or pull landing mid-report cannot tear a page. Partial: the sync-in-progress facet is not exercisable (no gateway configured, drain idles) and the failure path is silent - a failed range read falls back to the bounded store window with only a console.warn (ReportsModal.tsx:207-210,230), so the same screen can show a truncated dataset without saying so.',
  ],
  'RPT-07': [
    SPEC,
    'The Kredy statement exists but cannot state the account: it prints 5 of 8 ledger movements (hard .slice(0, 5), debtStatementTicketBuilder.ts:55) and prints the denormalised customer.currentDebt instead of the ledger sum (13 450 vs 6 000 here, a 7 450 DA gap), and the amount itself is corrupted on paper - the fr-DZ separator U+202F is truncated to 0x2F by escpos text() (src/utils/escpos.ts:61-68), so 13 450 prints as "13/450". Loyalty points (480) and repairs are absent from the document entirely. Credit account header, Kredy label and seller line are present.',
  ],
  'RPT-08': [
    SPEC,
    'Dashboard KPIs equal the raw ledger: on the 14-row controlled ledger (1 voided, 2 refund vouchers, 1 exchange, 1 discount, 1 frozen-allocation override) computeSalesMetrics returns CA Net 78 500 DA, COGS 54 000 DA, profit 26 500 DA, basket 7 591 DA and the independent raw-ledger oracle returns the same five numbers; the voided row contributes 0 everywhere and the allocation override (24 000 vs stored 25 000) wins as the frozen ledger requires.',
  ],
  'RPT-09': [
    SPEC,
    'There is no cashier identity to group by: SaleTransaction carries cashierName only (src/types/pos.ts:584; the whole interface block 547-660 has no cashierId) and no source file groups documents by cashier. Attribution is by display string, so a rename re-writes history - the fixture totals "Ali"=47 500 DA, and after renaming to "Ali Benali" the same documents report 0 under "Ali" and 47 500 under the new name - and two different cashiers with the same name merge into one line. Refund vouchers are stamped with whoever processed the refund, so per-cashier refunds are not the seller s refunds.',
  ],
  'RPT-10': [
    SPEC,
    'Per-session variance is real and gated (variance = physical - expected, manager PIN at threshold, mandatory note: ShiftCloseModal.tsx:288,423-439; expectedCash = openingFloat + cashSales + deposits - expenses - cashRefunds, shiftAdapter.ts:834) but the report has no cashier/drawer/device dimension: ShiftZReportData carries one cashierName (src/types/pos.ts:1892-1905), no source file aggregates variances across sessions, and a mid-shift handover re-points the OPEN session s currentCashier (shiftAdapter.ts:952-989) so a drawer s variance belongs to whoever held it last and is never split between the two cashiers. No force-close path exists anywhere in the tree (0 hits for forceClose/FORCE_CLOSE).',
  ],
  'RPT-11': [
    SPEC,
    'No warranty/inspection report exists: the only warranty surfaces are the per-IMEI inspector (ImeiWarrantyInspectorModal) and the per-ticket supplier RMA block inside RepairWorkOrderModal (37 RMA references, create-only for the open ticket). A tree-wide search for a warranty report or a claim cost/revenue aggregate returns 0 hits, so claim cost vs revenue (WAR-22) cannot be read anywhere in the app.',
  ],
  'RPT-12': [
    SPEC,
    'Both shells call the same KPI formula (computeSalesMetrics; ReportsModal.tsx:289-292, LiveActivityTab.tsx:378) yet the same period label selects different documents: "7 derniers jours" is 78 500 DA on desktop (rolling 168 h) and 64 000 DA on mobile (calendar keys D-6..D), a 14 500 DA gap driven by 2 documents only desktop counts. The range sets also differ (mobile adds 90d, desktop has no 90d) and mobile caps the feed per period (feedLimit 30/50/100, LiveActivityTab.tsx:208-212) with no paging or streaming control, so "identical numbers" fails on the dataset even though the arithmetic agrees.',
  ],
  'RPT-13': [
    SPEC,
    'No segment model exists to run at 1 M rows: the customer surface offers a pricing-tier filter and a debts tab only (CustomersModal.tsx:29-42,1459), the single computed segment is vipCount = customers.filter(pricingTier===\'VIP\').length (CustomersModal.tsx:436) executed in memory over the whole array, and a tree-wide search for a customer inactivity/segment concept returns 0 hits. There is no SQL aggregate over customers and the debtors view is a separate ledger, so VIP/inactive/debtors cannot be produced as one segmented report; the 1 M-row scale facet is moot until a segment report exists.',
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
