/**
 * Batch 26 — refresh COVERAGE.md from CASE_INDEX.csv (single source of truth).
 *
 * Rewrites, for the batch-26 IDs only:
 *   - the `## RCP (24)` / `## TIM (10)` table rows (Spec + Last state columns)
 *   - the `## Summary dashboard` numbers (from results/summary.json)
 *
 * Everything else in the file is left byte-identical (UTF-8, no BOM, CRLF
 * preserved as-is). Usage:
 *
 *   node tools/batch26-coverage.mjs [--write]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COV = path.join(ROOT, 'COVERAGE.md');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const SUMMARY = path.join(ROOT, 'results', 'summary.json');
const write = process.argv.includes('--write');

const BATCH26 = [
  'RCP-01', 'RCP-02', 'RCP-03', 'RCP-05', 'RCP-07', 'RCP-08', 'RCP-10', 'RCP-11',
  'RCP-12', 'RCP-13', 'RCP-14', 'RCP-15', 'RCP-16', 'RCP-17', 'RCP-18', 'RCP-19',
  'RCP-21', 'RCP-22', 'RCP-23', 'RCP-24', 'RCP-09',
  'TIM-02', 'TIM-03', 'TIM-04', 'TIM-05', 'TIM-06', 'TIM-07', 'TIM-09', 'TIM-10',
];

// --- CSV (minimal RFC4180 reader; every field in this file is quoted) -------
const csvText = fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '');
const rows = [];
let cur = '';
let inQ = false;
for (let i = 0; i < csvText.length; i += 1) {
  const c = csvText[i];
  if (inQ) {
    if (c === '"') {
      if (csvText[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQ = false;
    } else cur += c;
  } else if (c === '"') inQ = true;
  else if (c === ',') cur += '\u0001';
  else if (c === '\n') {
    if (cur.endsWith('\r')) cur = cur.slice(0, -1);
    rows.push(cur.split('\u0001'));
    cur = '';
  } else cur += c;
}
const header = rows.shift();
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const byId = new Map(rows.filter((r) => r.length >= header.length).map((r) => [r[col.id], r]));

// --- COVERAGE.md ------------------------------------------------------------
const cov = fs.readFileSync(COV, 'utf8');
const lines = cov.split('\n');
let touched = 0;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const m = /^\|\s*([A-Z]{3}-\d{2})\s*\|/.exec(line);
  if (!m || !BATCH26.includes(m[1])) continue;
  const row = byId.get(m[1]);
  if (!row) continue;
  const cells = line.split('|');
  // cells: ['', ' ID ', ' Prio ', ' Title ', ' Spec ', ' Last state ', '']
  if (cells.length < 7) continue;
  const verdict = row[col.verdict] || 'REMAIN';
  const spec = row[col.spec] || '—';
  const evidence = row[col.evidence] || '—';
  cells[4] = ` ${spec} `;
  cells[5] = ` ${evidence} `;
  lines[i] = cells.join('|');
  touched += 1;
}

// --- dashboard --------------------------------------------------------------
const s = JSON.parse(fs.readFileSync(SUMMARY, 'utf8')).dashboard;
// Each row below is disjoint: PASS + PARTIAL + FAIL + N/A + REMAIN + BLOCKED
// must equal 687, so REMAIN excludes BLOCKED (the old label said "includes
// BLOCKED" while the numbers were disjoint — a stale caption, not a count bug).
const dash = [
  [/^\|\s*Passed \(full\)\s*\|/, 'Passed (full)', s.passedFull],
  [/^\|\s*Passed \(partial/, 'Passed (partial — unasserted facets listed)', s.passPartial],
  [/^\|\s*\*\*FAILED\*\*\s*\|/, '**FAILED**', s.failed],
  [/^\|\s*N\/A \(absent/, 'N/A (absent or unobservable in harness)', s.na],
  [/^\|\s*Remaining/, 'Remaining (not covered yet / implemented-not-run)', s.remaining],
  [/^\|\s*BLOCKED \(environment/, 'BLOCKED (environment/device needed)', s.blocked],
];
for (let i = 0; i < lines.length; i += 1) {
  for (const [re, label, value] of dash) {
    if (re.test(lines[i])) lines[i] = `| ${label} | ${value} |`;
  }
}

console.log(`rows touched : ${touched}/${BATCH26.length}`);
const missing = BATCH26.filter((id) => !byId.has(id));
if (missing.length) console.log(`!! not in CSV: ${missing.join(', ')}`);
console.log(
  `dashboard    : ${s.passedFull} PASS + ${s.passPartial} PARTIAL + ${s.failed} FAIL + ` +
    `${s.na} N/A + ${s.remaining} REMAIN + ${s.blocked} BLOCKED = ` +
    `${s.passedFull + s.passPartial + s.failed + s.na + s.remaining + s.blocked} (catalog ${s.total})`,
);

if (!write) {
  console.log('(dry run — pass --write to persist)');
} else {
  fs.writeFileSync(COV, lines.join('\n'), 'utf8');
  console.log('wrote COVERAGE.md');
}
