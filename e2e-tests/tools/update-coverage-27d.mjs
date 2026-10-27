/**
 * Refresh COVERAGE.md from CASE_INDEX.csv for BATCH 27d: the 12 RPT rows and
 * the summary dashboard. Read-only against the CSV; only COVERAGE.md is written.
 *
 *   node e2e-tests/tools/update-coverage-27d.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const COV = path.join(ROOT, 'COVERAGE.md');
const LOG_REF = 'logs/part0-27d.log';

const IDS = [
  'RPT-01', 'RPT-03', 'RPT-04', 'RPT-05', 'RPT-06', 'RPT-07',
  'RPT-08', 'RPT-09', 'RPT-10', 'RPT-11', 'RPT-12', 'RPT-13',
];

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

const csv = fs
  .readFileSync(CSV, 'utf8')
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(splitCsv);
const head = csv[0];
const ix = Object.fromEntries(head.map((h, i) => [h, i]));
const rows = csv.slice(1);
const byId = new Map(rows.map((r) => [r[ix.id], r]));

const active = rows.filter((r) => r[ix.retired] !== '1');
const tally = {};
for (const r of active) tally[r[ix.verdict]] = (tally[r[ix.verdict]] || 0) + 1;
const dash = {
  catalog: active.length,
  pass: tally.PASS ?? 0,
  partial: tally['PASS-PARTIAL'] ?? 0,
  fail: tally.FAIL ?? 0,
  na: tally['N/A'] ?? 0,
  remain: tally.REMAIN ?? 0,
  blocked: tally.BLOCKED ?? 0,
};
const sum = dash.pass + dash.partial + dash.fail + dash.na + dash.remain + dash.blocked;
if (sum !== dash.catalog) {
  console.error(`[fail] tally does not sum to the catalog: ${sum} vs ${dash.catalog}`);
  process.exit(1);
}

let cov = fs.readFileSync(COV, 'utf8');
const setDash = (label, value) => {
  const re = new RegExp(`^(\\| ${label} \\| )\\d+( \\|)$`, 'm');
  if (!re.test(cov)) throw new Error(`dashboard row not found: ${label}`);
  cov = cov.replace(re, `$1${value}$2`);
};
setDash('Catalog cases \\(table rows\\)', dash.catalog);
setDash('Passed \\(full\\)', dash.pass);
setDash('Passed \\(partial [^|]*', dash.partial);
setDash('\\*\\*FAILED\\*\\*', dash.fail);
setDash('N/A \\(absent or unobservable in harness\\)', dash.na);
setDash('Remaining \\(not covered yet / implemented-not-run\\)', dash.remain);
setDash('BLOCKED \\(environment/device needed\\)', dash.blocked);

const stateFor = (row) => {
  const verdict = row[ix.verdict];
  const evidence = row[ix.evidence].replace(/\s+/g, ' ').trim();
  const short = evidence.length > 460 ? `${evidence.slice(0, 457)}...` : evidence;
  return `${verdict}: ${short} (${LOG_REF}).`;
};

const lines = cov.split(/\r?\n/);
let touched = 0;
const missing = new Set(IDS);
const out = lines.map((line) => {
  if (!line.startsWith('| ')) return line;
  const parts = line.split('|');
  if (parts.length !== 7) return line;
  const id = parts[1].trim();
  if (!IDS.includes(id)) return line;
  const row = byId.get(id);
  if (!row) throw new Error(`id ${id} not in CASE_INDEX.csv`);
  parts[4] = ` ${row[ix.spec]} `;
  parts[5] = ` ${stateFor(row)} `;
  touched += 1;
  missing.delete(id);
  return parts.join('|');
});
if (missing.size) {
  console.error(`[fail] rows not found in COVERAGE.md: ${[...missing].join(', ')}`);
  process.exit(1);
}
fs.writeFileSync(COV, out.join('\n'), 'utf8');

console.log(`dashboard=${JSON.stringify(dash)} sum=${sum}`);
console.log(`rows_updated=${touched} (expected ${IDS.length})`);
