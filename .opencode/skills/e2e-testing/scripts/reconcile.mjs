#!/usr/bin/env node
/**
 * reconcile.mjs - prove the verdict dashboard is internally consistent, and
 * (with --close) that every verdict carries the evidence it claims.
 *
 * Reads:
 *   e2e-tests/COVERAGE.md        summary dashboard table
 *   e2e-tests/CASE_INDEX.csv     one row per catalog case
 *   e2e-tests/FAIL-CLUSTERS.csv  case_id -> cluster_id (root-cause map)
 *
 * Always checks:
 *   - every row is placeable (id present and well formed, retired 0/1, known verdict)
 *   - rows == active + retired
 *   - active rows == "Catalog cases (table rows)"
 *   - dashboard buckets sum to the total, and each equals the CSV count
 *   - case ids are unique
 *   - every FAIL row has exactly one cluster, and no cluster names a non-FAIL
 *   - verdict_run / verdict_sha columns exist (hint: verdicts.mjs --migrate)
 *
 * --close additionally enforces the evidence bar:
 *   - REMAIN == 0 (REMAIN is a queue, not a parking lot)
 *   - BLOCKED evidence names the missing dependency
 *   - FAIL evidence names an observation class (DB|BYTES|RUNTIME|SOURCE|UI) and
 *     either a `file:line` or the literal `SOURCE unknown`
 *   - PASS-PARTIAL evidence names the unasserted facet
 *   - --prev <csv>: a verdict that changed since that file needs a run
 *     reference (verdict_run + verdict_sha) on the row
 *
 * Usage: node .opencode/skills/e2e-testing/scripts/reconcile.mjs [--close] [--prev <csv>] [--json]
 * Exit:  0 consistent, 1 mismatch (prints the diff), 2 bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  repoRoot, parseArgs, readIndex, activeRows, indexCounts, readDashboard,
  ID_CATALOG_RE, VERDICTS, C, bad, warn,
} from './_lib.mjs';

const args = parseArgs();
const root = repoRoot();
const E2E = path.join(root, 'e2e-tests');

const coverageFile = path.join(E2E, 'COVERAGE.md');
const csvFile = path.join(E2E, 'CASE_INDEX.csv');
const clusterFile = path.join(E2E, 'FAIL-CLUSTERS.csv');
for (const f of [coverageFile, csvFile, clusterFile]) {
  if (!fs.existsSync(f)) {
    bad(`missing ${path.relative(root, f)}`);
    process.exit(2);
  }
}

const failures = [];
const fail = (label) => { failures.push(label); };

/* ------------------------------------------------------------------ */
/* index                                                               */
/* ------------------------------------------------------------------ */

const index = readIndex(root, csvFile);
for (const need of ['id', 'verdict', 'retired', 'evidence']) {
  if (index.ix[need] === undefined) {
    bad(`CASE_INDEX.csv has no "${need}" column`);
    process.exit(2);
  }
}

const active = activeRows(index);
const retired = index.rows.length - active.length;
const counts = indexCounts(index);

const unplaced = [];
const seen = new Map();
for (const row of index.rows) {
  const id = index.get(row, 'id');
  if (!id) { unplaced.push(`line without an id: ${JSON.stringify(row).slice(0, 100)}`); continue; }
  seen.set(id, (seen.get(id) || 0) + 1);
  if (!ID_CATALOG_RE.test(id)) unplaced.push(`${id}: id does not match ${ID_CATALOG_RE} (e.g. REF-03)`);
  const retiredFlag = index.get(row, 'retired');
  if (retiredFlag !== '0' && retiredFlag !== '1') unplaced.push(`${id}: retired="${retiredFlag}" (must be 0 or 1)`);
  if (retiredFlag === '1') continue;
  const v = index.get(row, 'verdict');
  if (!VERDICTS.includes(v)) unplaced.push(`${id}: unknown verdict "${v}"`);
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

const dash = readDashboard(coverageFile);
for (const key of ['TOTAL', 'PASS', 'PASS-PARTIAL', 'FAIL', 'N/A', 'REMAIN', 'BLOCKED']) {
  if (dash[key] === undefined) {
    bad(`COVERAGE.md dashboard has no row for ${key} (expected the label matched by _lib.DASH_KEYS)`);
    process.exit(2);
  }
}

const checks = [];
const check = (label, got, want) => {
  const same = got === want;
  checks.push({ label, got, want, same });
  console.log(`${same ? C.green + 'ok  ' : C.red + 'FAIL'}${C.reset} ${label.padEnd(34)} csv=${String(got).padStart(4)}  dashboard=${String(want).padStart(4)}`);
  if (!same) fail(label);
};

console.log(`${C.cyan}CASE_INDEX.csv${C.reset}  rows=${index.rows.length} = active ${counts.TOTAL} + retired ${retired}`);
console.log(`${C.cyan}COVERAGE.md${C.reset}    total=${dash.TOTAL}`);
console.log('');

if (index.rows.length !== counts.TOTAL + retired) {
  bad(`row arithmetic broken: rows=${index.rows.length} but active+retired=${counts.TOTAL + retired}`);
  fail('row arithmetic');
} else {
  console.log(`${C.green}ok  ${C.reset} rows = active + retired            ${index.rows.length} = ${counts.TOTAL} + ${retired}`);
}

check('PASS', counts.PASS, dash.PASS);
check('PASS-PARTIAL', counts['PASS-PARTIAL'], dash['PASS-PARTIAL']);
check('PASS-NONFLAKY', counts['PASS-NONFLAKY'], dash['PASS-NONFLAKY']);
check('FAIL', counts.FAIL, dash.FAIL);
check('N/A', counts['N/A'], dash['N/A']);
check('REMAIN', counts.REMAIN, dash.REMAIN);
check('BLOCKED', counts.BLOCKED, dash.BLOCKED);

const bucketSum = ['PASS', 'PASS-PARTIAL', 'FAIL', 'N/A', 'REMAIN', 'BLOCKED']
  .reduce((s, k) => s + (dash[k] || 0), 0);
check('dashboard buckets sum == total', bucketSum, dash.TOTAL);
check('active rows == total', counts.TOTAL, dash.TOTAL);

const dupes = [...seen.entries()].filter(([, n]) => n > 1);
if (dupes.length) {
  bad(`${dupes.length} duplicate id(s): ${dupes.slice(0, 8).map(([id, n]) => `${id}x${n}`).join(', ')}`);
  fail('unique ids');
} else {
  console.log(`${C.green}ok  ${C.reset} unique case ids                  ${seen.size}`);
}

if (index.ix.verdict_run === undefined || index.ix.verdict_sha === undefined) {
  bad('CASE_INDEX.csv is missing verdict_run/verdict_sha - run: node .opencode/skills/e2e-testing/scripts/verdicts.mjs --migrate');
  fail('verdict provenance columns');
} else {
  const missingRun = active.filter((r) => index.get(r, 'verdict') !== 'N/A' && index.get(r, 'verdict') !== 'BLOCKED'
    && !index.get(r, 'verdict_run'));
  console.log(`${C.dim}     verdict provenance columns present; ${missingRun.length} executable row(s) have no run reference yet${C.reset}`);
}

/* ------------------------------------------------------------------ */
/* FAIL -> root-cause cluster                                          */
/* ------------------------------------------------------------------ */

const failRows = active.filter((r) => index.get(r, 'verdict') === 'FAIL');
const failIds = new Set(failRows.map((r) => index.get(r, 'id')));
// Flaky rows: a PASS/PASS-PARTIAL whose evidence says FLAKY is not a green.
// They are excluded from the "PASS" headline, reported by id, and may keep a
// cluster row (their root cause is still open) — Q-C.
const flakyRows = active.filter(
  (r) =>
    ['PASS', 'PASS-PARTIAL'].includes(index.get(r, 'verdict')) &&
    /(^|\W)FLAKY(\W|$)/i.test(index.get(r, 'evidence') ?? '')
);
const flakyIds = new Set(flakyRows.map((r) => index.get(r, 'id')));
const clusterEligible = new Set([...failIds, ...flakyIds]);

const clusters = readIndex(root, clusterFile);
if (clusters.ix.case_id === undefined || clusters.ix.cluster_id === undefined) {
  bad('FAIL-CLUSTERS.csv must have case_id and cluster_id columns');
  process.exit(2);
}
const clustered = new Map();
const clusterProblems = [];
for (const row of clusters.rows) {
  const cid = clusters.get(row, 'case_id');
  const kid = clusters.get(row, 'cluster_id');
  if (!cid) continue;
  if (!kid) { clusterProblems.push(`${cid} has an empty cluster_id`); continue; }
  if (clustered.has(cid)) clusterProblems.push(`${cid} listed twice`);
  clustered.set(cid, kid);
}
const unclustered = [...failIds].filter((id) => !clustered.has(id));
const phantom = [...clustered.keys()].filter((id) => !clusterEligible.has(id));

if (unclustered.length || phantom.length || clusterProblems.length) {
  if (unclustered.length) {
    bad(`${unclustered.length} FAIL row(s) have no root-cause cluster:`);
    for (const id of unclustered.slice(0, 20)) console.log(`       - ${id}`);
    if (unclustered.length > 20) console.log(`       … ${unclustered.length - 20} more`);
  }
  if (phantom.length) {
    bad(`${phantom.length} cluster row(s) name a non-FAIL, non-flaky case:`);
    for (const id of phantom.slice(0, 20)) console.log(`       - ${id}`);
    if (phantom.length > 20) console.log(`       … ${phantom.length - 20} more`);
  }
  for (const p of clusterProblems.slice(0, 20)) bad(p);
  fail('FAIL rows clustered');
} else {
  console.log(`${C.green}ok  ${C.reset} every FAIL row has one cluster   ${failIds.size} cases / ${new Set(clustered.values()).size} clusters`);
}

// Flaky rows are reported separately and excluded from the PASS headline
// (Q-C): an order-dependent pass is not a green.
if (flakyRows.length) {
  const passes = active.filter((r) => ['PASS', 'PASS-PARTIAL'].includes(index.get(r, 'verdict'))).length;
  console.log(
    `${C.yellow}[flaky]${C.reset} ${flakyRows.length} row(s) pass but are order-dependent (excluded from the headline):`
  );
  for (const r of flakyRows) console.log(`       - ${index.get(r, 'id')} (${index.get(r, 'verdict')})`);
  console.log(`${C.dim}     PASS excluding flaky rows: ${passes - flakyRows.length} of ${passes}${C.reset}`);
}

if (unplaced.length) {
  bad(`${unplaced.length} row(s) cannot be placed in a bucket:`);
  for (const u of unplaced.slice(0, 20)) console.log(`       - ${u}`);
  if (unplaced.length > 20) console.log(`       … ${unplaced.length - 20} more`);
  fail('all rows placeable');
} else {
  console.log(`${C.green}ok  ${C.reset} every row placed in a bucket     ${index.rows.length}`);
}

/* ------------------------------------------------------------------ */
/* --close: the evidence bar                                           */
/* ------------------------------------------------------------------ */

const FAIL_CLASS_RE = /\b(DB|BYTES|RUNTIME|SOURCE|UI)\b/;
const FILE_LINE_RE = /\b[\w./\\-]+\.(?:ts|tsx|js|mjs|cjs|rs|css|scss|json|md|html|toml):\d+/;
const SOURCE_UNKNOWN_RE = /SOURCE\s+unknown/i;
// No trailing \b: the `no\s+[a-z]` alternative ends inside a word ("no random"),
// so a trailing boundary made that shape unmatchable - which is how 14 real
// BLOCKED rows that do name their dependency were reported as evidence debt.
const DEPENDENCY_RE = /\b(?:needs?|requires?|missing|absent|without|no\s+[a-z]|blocked\s+by|fails?\s+on|depends?\s+on|gateway|fixture|emulator|device|terminal)/i;
const FACET_RE = /(unasserted|un-asserted|not asserted)/i;

const closeProblems = [];
const closeRule = (label, offenders, hint) => {
  if (!offenders.length) {
    console.log(`${C.green}ok  ${C.reset} ${label}`);
    return;
  }
  bad(`${label} - ${offenders.length} row(s)`);
  for (const o of offenders.slice(0, 12)) console.log(`       - ${o}`);
  if (offenders.length > 12) console.log(`       … ${offenders.length - 12} more`);
  if (hint) console.log(`${C.dim}       ${hint}${C.reset}`);
  closeProblems.push(label);
  fail(label);
};

if (args.close) {
  console.log('');
  console.log(`${C.cyan}--close${C.reset} evidence bar`);

  closeRule('REMAIN must be 0', active
    .filter((r) => index.get(r, 'verdict') === 'REMAIN')
    .map((r) => `${index.get(r, 'id')} is REMAIN - execute it or make it BLOCKED with the dependency named`));

  closeRule('BLOCKED names the dependency', active
    .filter((r) => index.get(r, 'verdict') === 'BLOCKED')
    .filter((r) => {
      const e = index.get(r, 'evidence');
      return !(e.length >= 12 && DEPENDENCY_RE.test(e));
    })
    .map((r) => `${index.get(r, 'id')}: "${index.get(r, 'evidence').slice(0, 80)}"`),
  'evidence must name what is missing (e.g. "needs a configured merchant gateway")');

  closeRule('FAIL has class + file:line|SOURCE unknown', failRows
    .filter((r) => {
      const e = index.get(r, 'evidence');
      return !(FAIL_CLASS_RE.test(e) && (FILE_LINE_RE.test(e) || SOURCE_UNKNOWN_RE.test(e)));
    })
    .map((r) => `${index.get(r, 'id')}: "${index.get(r, 'evidence').slice(0, 80)}"`),
  'quote the observation class (DB|BYTES|RUNTIME|SOURCE|UI) and a file:line, or write "SOURCE unknown"');

  closeRule('PASS-PARTIAL names the unasserted facet', active
    .filter((r) => index.get(r, 'verdict') === 'PASS-PARTIAL')
    .filter((r) => !FACET_RE.test(index.get(r, 'evidence')))
    .map((r) => `${index.get(r, 'id')}: "${index.get(r, 'evidence').slice(0, 80)}"`),
  'say which facet was not asserted, e.g. "unasserted: drawer total after the replay"');
}

/* ------------------------------------------------------------------ */
/* --prev: a verdict change needs a run reference                      */
/* ------------------------------------------------------------------ */

if (args.prev) {
  const prevFile = path.resolve(root, String(args.prev));
  if (!fs.existsSync(prevFile)) {
    bad(`--prev ${args.prev} does not exist`);
    process.exit(2);
  }
  const prev = readIndex(root, prevFile);
  if (prev.ix.id === undefined || prev.ix.verdict === undefined) {
    bad(`${args.prev} needs id and verdict columns`);
    process.exit(2);
  }
  const noReference = [];
  for (const row of active) {
    const id = index.get(row, 'id');
    const prevRow = prev.byId.get(id);
    if (!prevRow) continue;
    const was = prev.get(prevRow, 'verdict');
    const now = index.get(row, 'verdict');
    if (was === now) continue;
    if (!index.get(row, 'verdict_run') || !index.get(row, 'verdict_sha')) {
      noReference.push(`${id}: ${was} -> ${now} with no verdict_run/verdict_sha (stamp it with verdicts.mjs --write-index --run <sidecar>)`);
    }
  }
  console.log('');
  closeRule('verdict changes carry a run reference', noReference,
    'a verdict that moved must name the run that moved it');
}

/* ------------------------------------------------------------------ */

if (args.json) {
  console.log(JSON.stringify({
    rows: index.rows.length,
    active: counts.TOTAL,
    retired,
    counts,
    dashboard: dash,
    checks: checks.filter((c) => !c.same),
    unplaced,
    unclustered,
    phantom,
    close: closeProblems,
    exit: failures.length ? 1 : 0,
  }, null, 1));
}

console.log('');
if (failures.length) {
  console.log(`${C.red}RECONCILE FAILED${C.reset} (${failures.length} check(s)): ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`${C.green}RECONCILED${C.reset} ${counts.TOTAL} active cases, all buckets match${args.close ? ', evidence bar met' : ''}.`);
