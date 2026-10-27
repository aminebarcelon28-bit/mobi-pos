/**
 * Read-only reconciliation check for the 27c deliverables:
 * CASE_INDEX.csv vs logs/part0-27c.log vs the COVERAGE dashboard.
 *
 *   node e2e-tests/tools/verify-27c.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

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

const csvLines = fs
  .readFileSync(path.join(ROOT, 'CASE_INDEX.csv'), 'utf8')
  .replace(/^\uFEFF/, '')
  .split(/\r?\n/)
  .filter(Boolean);
const header = splitCsv(csvLines[0]);
const ix = Object.fromEntries(header.map((h, i) => [h, i]));
const rows = csvLines.slice(1).map(splitCsv);
const retired = rows.filter((r) => r[ix.retired] === '1');
const active = rows.filter((r) => r[ix.retired] !== '1');
const tally = {};
for (const r of active) tally[r[ix.verdict]] = (tally[r[ix.verdict]] || 0) + 1;
console.log(`csv rows=${rows.length} retired=${retired.length} active=${active.length}`);
console.log(`csv active tally=${JSON.stringify(tally)} sum=${Object.values(tally).reduce((a, b) => a + b, 0)}`);

const log = fs.readFileSync(path.join(ROOT, 'logs', 'part0-27c.log'), 'utf8');
const verdicts = log
  .split(/\r?\n/)
  .map((l) => /^VERDICT=([A-Z0-9-]+) (\S+)/.exec(l))
  .filter(Boolean)
  .map((m) => ({ id: m[1], verdict: m[2] }));
const logTally = {};
for (const v of verdicts) logTally[v.verdict] = (logTally[v.verdict] || 0) + 1;
const ids = verdicts.map((v) => v.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
console.log(
  `log verdicts=${verdicts.length} unique=${new Set(ids).size} tally=${JSON.stringify(logTally)} duplicates=${JSON.stringify(dupes)}`,
);

const EXPECTED = [
  'I18-01', 'I18-02', 'I18-03', 'I18-04', 'I18-06', 'I18-07', 'I18-08',
  'I18-09', 'I18-10', 'I18-11', 'I18-12', 'I18-13', 'I18-14', 'I18-15',
  'DAT-79', 'DAT-84',
];
const missingIds = EXPECTED.filter((id) => !ids.includes(id));
const extraIds = ids.filter((id) => !EXPECTED.includes(id));
console.log(`expected_ids=16 missing=${JSON.stringify(missingIds)} extra=${JSON.stringify(extraIds)}`);

let mismatch = 0;
for (const v of verdicts) {
  const row = rows.find((r) => r[ix.id] === v.id);
  if (!row) {
    console.log(`[miss] ${v.id} not in CASE_INDEX`);
    mismatch += 1;
  } else if (row[ix.verdict] !== v.verdict) {
    console.log(`[drift] ${v.id} log=${v.verdict} csv=${row[ix.verdict]}`);
    mismatch += 1;
  } else if (!row[ix.spec] || !row[ix.evidence]) {
    console.log(`[empty] ${v.id} spec/evidence not filled`);
    mismatch += 1;
  }
}
console.log(`log-vs-csv mismatches=${mismatch}`);

const facts = log.split(/\r?\n/).filter((l) => /^FACT=/.test(l));
const factTags = facts.map((l) => /^FACT=(\S+)/.exec(l)?.[1]);
console.log(`fact_lines=${facts.length} tags=${JSON.stringify(factTags)}`);

const cov = fs.readFileSync(path.join(ROOT, 'COVERAGE.md'), 'utf8');
const grab = (label) => {
  const m = new RegExp(`\\| ${label} \\| (\\d+) \\|`).exec(cov);
  return m ? Number(m[1]) : null;
};
const dash = {
  catalog: grab('Catalog cases \\(table rows\\)'),
  pass: grab('Passed \\(full\\)'),
  partial: grab('Passed \\(partial — unasserted facets listed\\)'),
  fail: grab('\\*\\*FAILED\\*\\*'),
  na: grab('N/A \\(absent or unobservable in harness\\)'),
  remain: grab('Remaining \\(not covered yet / implemented-not-run\\)'),
  blocked: grab('BLOCKED \\(environment/device needed\\)'),
};
console.log(`dashboard=${JSON.stringify(dash)} sum=${dash.pass + dash.partial + dash.fail + dash.na + dash.remain + dash.blocked}`);
const expect = {
  pass: tally.PASS,
  partial: tally['PASS-PARTIAL'],
  fail: tally.FAIL,
  na: tally['N/A'],
  remain: tally.REMAIN,
  blocked: tally.BLOCKED,
};
console.log(`expected =${JSON.stringify(expect)}`);
const drift = Object.entries(expect).filter(([k, v]) => dash[k] !== v);
console.log(drift.length ? `DASHBOARD DRIFT: ${JSON.stringify(drift)}` : 'dashboard matches CASE_INDEX');

const probes = fs.readdirSync(path.join(ROOT, 'specs')).filter((f) => f.startsWith('_probe'));
console.log(`probe specs left=${JSON.stringify(probes)}`);
