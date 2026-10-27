#!/usr/bin/env node
/**
 * reconcile.mjs - prove the verdict dashboard is internally consistent.
 *
 * Reads:
 *   e2e-tests/COVERAGE.md        summary dashboard table
 *   e2e-tests/CASE_INDEX.csv     one row per catalog case (verdict, retired flag)
 *   e2e-tests/FAIL-CLUSTERS.csv  case_id -> cluster_id (root-cause map)
 *
 * Checks:
 *   - every CSV row is placed (id present, retired 0/1, known verdict)
 *   - rows == active + retired (697 = 687 active + 10 owner-retired)
 *   - active rows (retired=0) == "Catalog cases (table rows)"
 *   - dashboard buckets sum to the total
 *   - each dashboard bucket equals the CSV count for that verdict
 *   - case ids are unique
 *   - every FAIL row has exactly one cluster, and no cluster names a non-FAIL
 *
 * The CSV is the only verdict source; there are no bucket JSON files to drift.
 *
 * Usage: node .opencode/skills/e2e-testing/scripts/reconcile.mjs
 * Exit:  0 consistent, 1 mismatch (prints the diff).
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, parseArgs, ok, bad, warn, info, C } from './_lib.mjs';

const root = repoRoot();
const E2E = path.join(root, 'e2e-tests');
const args = parseArgs();

const coverageFile = path.join(E2E, 'COVERAGE.md');
const csvFile = path.join(E2E, 'CASE_INDEX.csv');
const clusterFile = path.join(E2E, 'FAIL-CLUSTERS.csv');
for (const f of [coverageFile, csvFile, clusterFile]) {
  if (!fs.existsSync(f)) {
    bad(`missing ${path.relative(root, f)}`);
    process.exit(1);
  }
}

/* ---------- dashboard ---------- */
const dash = {};
for (const line of fs.readFileSync(coverageFile, 'utf8').split(/\r?\n/)) {
  const m = /^\|\s*(.+?)\s*\|\s*([\d/]+)\s*\|\s*$/.exec(line);
  if (!m) continue;
  const label = m[1].replace(/\*/g, '');
  const value = m[2];
  if (/^Catalog cases/.test(label)) dash.TOTAL = Number(value);
  else if (/^Passed \(full\)/.test(label)) dash.PASS = Number(value);
  else if (/^Passed \(partial/.test(label)) dash['PASS-PARTIAL'] = Number(value);
  else if (/^FAILED/.test(label)) dash.FAIL = Number(value);
  else if (/^N\/A/.test(label)) dash['N/A'] = Number(value);
  else if (/^Remaining/.test(label)) dash.REMAIN = Number(value);
  else if (/^BLOCKED/.test(label)) dash.BLOCKED = Number(value);
}

/* ---------- CSV ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = parseCsv(fs.readFileSync(csvFile, 'utf8'));
const header = raw.shift().map((h) => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['id', 'verdict', 'retired']) {
  if (idx[need] === undefined) {
    bad(`CASE_INDEX.csv has no "${need}" column`);
    process.exit(1);
  }
}

const counts = { PASS: 0, 'PASS-PARTIAL': 0, FAIL: 0, 'N/A': 0, REMAIN: 0, BLOCKED: 0 };
const ids = new Map();
let active = 0;
let retired = 0;
let dataRows = 0;
const unplaced = []; // rows this script cannot place in a bucket

for (const r of raw) {
  if (!r.length || r.every((f) => !String(f).trim())) continue;
  dataRows++;
  const id = String(r[idx.id] ?? '').trim();
  if (!id) {
    unplaced.push(`line without an id: ${JSON.stringify(r).slice(0, 120)}`);
    continue;
  }
  ids.set(id, (ids.get(id) || 0) + 1);
  const retiredFlag = String(r[idx.retired]).trim();
  if (retiredFlag !== '0' && retiredFlag !== '1') {
    unplaced.push(`${id}: retired="${retiredFlag}" (must be 0 or 1)`);
    continue;
  }
  if (retiredFlag === '1') { retired++; continue; }
  active++;
  const v = String(r[idx.verdict]).trim();
  if (counts[v] === undefined) unplaced.push(`${id}: unknown verdict "${v}"`);
  else counts[v]++;
}

/* ---------- checks ---------- */
const failures = [];
const check = (label, got, want) => {
  const same = got === want;
  console.log(`${same ? C.green + 'ok  ' : C.red + 'FAIL'}${C.reset} ${label.padEnd(34)} csv=${String(got).padStart(4)}  dashboard=${String(want).padStart(4)}`);
  if (!same) failures.push(label);
};

console.log(`${C.cyan}CASE_INDEX.csv${C.reset}  rows=${dataRows} = active ${active} + retired ${retired}`);
console.log(`${C.cyan}COVERAGE.md${C.reset}    total=${dash.TOTAL}`);
console.log('');

if (dataRows !== active + retired) {
  bad(`row arithmetic broken: rows=${dataRows} but active+retired=${active + retired}`);
  failures.push('row arithmetic');
} else {
  console.log(`${C.green}ok  ${C.reset} rows = active + retired            ${dataRows} = ${active} + ${retired}`);
}

check('PASS', counts.PASS, dash.PASS);
check('PASS-PARTIAL', counts['PASS-PARTIAL'], dash['PASS-PARTIAL']);
check('FAIL', counts.FAIL, dash.FAIL);
check('N/A', counts['N/A'], dash['N/A']);
check('REMAIN', counts.REMAIN, dash.REMAIN);
check('BLOCKED', counts.BLOCKED, dash.BLOCKED);

const bucketSum = ['PASS', 'PASS-PARTIAL', 'FAIL', 'N/A', 'REMAIN', 'BLOCKED'].reduce((s, k) => s + (dash[k] || 0), 0);
check('dashboard buckets sum == total', bucketSum, dash.TOTAL);
check('active rows == total', active, dash.TOTAL);

const dupes = [...ids.entries()].filter(([, n]) => n > 1);
if (dupes.length) {
  bad(`${dupes.length} duplicate id(s): ${dupes.slice(0, 8).map(([id, n]) => `${id}x${n}`).join(', ')}`);
  failures.push('unique ids');
} else {
  console.log(`${C.green}ok  ${C.reset} unique case ids                  ${ids.size}`);
}

/* ---------- FAIL -> root-cause cluster ---------- */
// Every FAIL row must name exactly one cluster; a cluster must not name a
// non-FAIL row. This is what keeps FAIL-CLUSTERS.md from drifting away from
// the verdict source.
const failIds = new Set();
for (const r of raw) {
  if (!r.length || r.every((f) => !String(f).trim())) continue;
  const id = String(r[idx.id] ?? '').trim();
  if (!id) continue;
  if (String(r[idx.retired]).trim() === '1') continue;
  if (String(r[idx.verdict]).trim() === 'FAIL') failIds.add(id);
}

const cRaw = parseCsv(fs.readFileSync(clusterFile, 'utf8'));
const cHeader = cRaw.shift().map((h) => h.trim());
const cIdx = Object.fromEntries(cHeader.map((h, i) => [h, i]));
if (cIdx.case_id === undefined || cIdx.cluster_id === undefined) {
  bad('FAIL-CLUSTERS.csv must have case_id and cluster_id columns');
  process.exit(1);
}
const clustered = new Map();
const clusterDupes = [];
for (const r of cRaw) {
  if (!r.length || r.every((f) => !String(f).trim())) continue;
  const cid = String(r[cIdx.case_id] ?? '').trim();
  const kid = String(r[cIdx.cluster_id] ?? '').trim();
  if (!cid) continue;
  if (!kid) { clusterDupes.push(`${cid} has an empty cluster_id`); continue; }
  if (clustered.has(cid)) clusterDupes.push(`${cid} listed twice`);
  clustered.set(cid, kid);
}
const unclustered = [...failIds].filter((id) => !clustered.has(id));
const phantom = [...clustered.keys()].filter((id) => !failIds.has(id));

if (unclustered.length || phantom.length || clusterDupes.length) {
  if (unclustered.length) {
    bad(`${unclustered.length} FAIL row(s) have no root-cause cluster:`);
    for (const id of unclustered.slice(0, 20)) console.log(`       - ${id}`);
    if (unclustered.length > 20) console.log(`       … ${unclustered.length - 20} more`);
  }
  if (phantom.length) {
    bad(`${phantom.length} cluster row(s) name a non-FAIL case:`);
    for (const id of phantom.slice(0, 20)) console.log(`       - ${id}`);
    if (phantom.length > 20) console.log(`       … ${phantom.length - 20} more`);
  }
  for (const d of clusterDupes.slice(0, 20)) bad(d);
  failures.push('FAIL rows clustered');
} else {
  const nClusters = new Set(clustered.values()).size;
  console.log(`${C.green}ok  ${C.reset} every FAIL row has one cluster   ${failIds.size} cases / ${nClusters} clusters`);
}

if (unplaced.length) {
  bad(`${unplaced.length} row(s) cannot be placed in a bucket:`);
  for (const u of unplaced.slice(0, 20)) console.log(`       - ${u}`);
  if (unplaced.length > 20) console.log(`       … ${unplaced.length - 20} more`);
  failures.push('all rows placeable');
} else {
  console.log(`${C.green}ok  ${C.reset} every row placed in a bucket     ${dataRows}`);
}

console.log('');
if (failures.length) {
  console.log(`${C.red}RECONCILE FAILED${C.reset} (${failures.length} check(s)): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`${C.green}RECONCILED${C.reset} ${dash.TOTAL} cases, all buckets match.`);
