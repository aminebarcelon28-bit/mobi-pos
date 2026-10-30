#!/usr/bin/env node
/**
 * delta.mjs - compare a run's per-case verdicts against the CASE_INDEX baseline.
 *
 * The baseline is the single verdict source (`e2e-tests/CASE_INDEX.csv`).
 * A run only has to prove what changed.
 *
 * Usage:
 *   node .../delta.mjs --results <file> [--baseline <csv>] [--scope spec=<file>|ids=A,B]
 *                      [--allow-loss <id>]... [--json] [--no-spec-change-check]
 *
 * --results accepts per-case verdicts only:
 *   - JSON object map            { "REF-03": "FAIL", ... }
 *   - JSON array of case rows    [ { "id": "REF-03", "verdict": "FAIL" }, ... ]
 *   - JSON array of suite rows   [ { "spec": "...", "cases": { "REF-03": "FAIL" } } ]
 *   - NDJSON                     one { "id": ..., "verdict": ... } per line
 *   - VERDICT lines              VERDICT=REF-03 FAIL   (may be mixed with NDJSON)
 * A run sidecar or a raw events.ndjson is REJECTED with exit 2: extract verdicts
 * with verdicts.mjs first (run -> verdicts -> delta -> reconcile).
 *
 * Exit:
 *   0  no regression, no coverage loss, every in-scope case executed
 *   1  regression | coverage loss | in-scope case not executed | suspect fix
 *   2  bad input, unreadable file, or an unexpected crash (never 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  repoRoot, parseArgs, readIndex, activeRows, GOOD_VERDICTS, C,
} from './_lib.mjs';
import { parseVerdicts, InputError } from './_results.mjs';

/* Anything unexpected is bad input from the caller's point of view: exit 2,
 * never 1, so a crash can never be read as "the suite has a regression". */
process.on('uncaughtException', (err) => {
  console.error(`delta: crashed (exit 2, not a verdict): ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
process.on('unhandledRejection', (err) => {
  console.error(`delta: crashed (exit 2, not a verdict): ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});

const args = parseArgs();
const root = repoRoot();
const baselineFile = args.baseline ? path.resolve(String(args.baseline)) : path.join(root, 'e2e-tests', 'CASE_INDEX.csv');
const resultsArg = args.results ? String(args.results) : '';
if (!resultsArg) {
  console.error('delta: --results <file> is required');
  process.exit(2);
}
const resultsFile = path.resolve(resultsArg);
for (const f of [baselineFile, resultsFile]) {
  if (!fs.existsSync(f)) {
    console.error(`delta: missing ${f}`);
    process.exit(2);
  }
}

/* ---------- baseline ---------- */
const index = readIndex(root, baselineFile);
for (const need of ['id', 'verdict', 'spec']) {
  if (index.ix[need] === undefined) {
    console.error(`delta: baseline needs "${need}" column`);
    process.exit(2);
  }
}
const baseline = new Map();
const specOf = new Map();
for (const row of activeRows(index)) {
  const id = index.get(row, 'id');
  baseline.set(id, index.get(row, 'verdict'));
  specOf.set(id, index.get(row, 'spec'));
}

/* ---------- results ---------- */
let run;
try {
  run = parseVerdicts(resultsFile);
} catch (err) {
  if (err instanceof InputError) {
    console.error(`delta: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

/* ---------- scope ---------- */
const allowLoss = new Set([].concat(args['allow-loss'] || []).map((s) => String(s).trim()).filter(Boolean));
const scope = args.scope ? String(args.scope) : null;
let inScope = null;
if (scope) {
  if (scope.startsWith('spec=')) {
    const want = path.basename(scope.slice(5).trim());
    inScope = [...baseline.keys()].filter((id) => path.basename(specOf.get(id) || '') === want);
    if (!inScope.length) {
      console.error(`delta: --scope spec=${want} matches no baseline case (check the spec column in CASE_INDEX.csv)`);
      process.exit(2);
    }
  } else if (scope.startsWith('ids=')) {
    inScope = scope.slice(4).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = inScope.filter((id) => !baseline.has(id));
    if (unknown.length) {
      console.error(`delta: --scope ids= names cases that are not in the baseline: ${unknown.join(', ')}`);
      process.exit(2);
    }
  } else {
    // A bare value is treated as a spec path.
    const want = path.basename(scope);
    inScope = [...baseline.keys()].filter((id) => path.basename(specOf.get(id) || '') === want);
    if (!inScope.length) {
      console.error(`delta: --scope ${scope} matches no baseline case; use spec=<file> or ids=A,B`);
      process.exit(2);
    }
  }
}

/* ---------- diff ---------- */
const regressions = [];
const fixes = [];
const losses = [];
const unchanged = [];
const changedOther = [];
const unknown = [];
const suspectFixes = [];

const specChanged = (spec) => {
  if (args['no-spec-change-check'] || !spec) return false;
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', path.join('e2e-tests', 'specs', spec)], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
};

for (const [id, was] of baseline) {
  if (!run.has(id)) continue;
  const now = run.get(id);
  if (!was || was === now) { unchanged.push({ id, was, now }); continue; }
  if (GOOD_VERDICTS.has(was) && now === 'FAIL') {
    regressions.push({ id, was, now });
  } else if (was === 'FAIL' && GOOD_VERDICTS.has(now)) {
    // A fix is only trustworthy when the assertion was not edited to match the
    // bug. If the spec file is dirty, the case is a suspect fix, not a fix.
    if (specChanged(specOf.get(id)) && !args['allow-spec-change']) {
      suspectFixes.push({ id, was, now, spec: specOf.get(id) });
    } else {
      fixes.push({ id, was, now });
    }
  } else if (GOOD_VERDICTS.has(was) && now !== 'FAIL' && now !== was) {
    // PASS -> PASS-PARTIAL / BLOCKED / N/A / REMAIN: the run stopped proving
    // what the baseline proved. That is coverage loss, not a neutral change.
    losses.push({ id, was, now, allowed: allowLoss.has(id) });
  } else if (was === 'FAIL' && now === 'FAIL') {
    unchanged.push({ id, was, now });
  } else {
    changedOther.push({ id, was, now });
  }
}
for (const id of run.keys()) if (!baseline.has(id)) unknown.push(id);

const notRun = [...baseline.keys()].filter((id) => !run.has(id));
const scopeMissed = inScope ? inScope.filter((id) => !run.has(id)) : [];
const unallowedLosses = losses.filter((l) => !l.allowed);

/* ---------- report ---------- */
if (args.json) {
  console.log(JSON.stringify({
    executed: run.size,
    baseline: baseline.size,
    regressions,
    fixes,
    suspectFixes,
    coverageLoss: losses,
    unknown,
    unchanged: unchanged.length,
    notRun: notRun.length,
    scope: scope ? { scope, missed: scopeMissed } : null,
    exit: (regressions.length || unallowedLosses.length || scopeMissed.length || suspectFixes.length) ? 1 : 0,
  }, null, 1));
} else {
  console.log(`${C.cyan}delta${C.reset} baseline=${path.relative(root, baselineFile)} results=${path.relative(root, resultsFile)}`);
  console.log(`executed=${run.size}  baseline=${baseline.size}  not-run=${notRun.length}${scope ? `  scope=${scope}` : ''}`);
  console.log('');
  console.log(`${regressions.length ? C.red : C.green}regressions${C.reset} ${regressions.length}`);
  for (const r of regressions) console.log(`  ${r.id}: ${r.was} -> ${r.now}`);
  console.log(`${C.green}fixes${C.reset} ${fixes.length}`);
  for (const r of fixes) console.log(`  ${r.id}: ${r.was} -> ${r.now}`);
  if (suspectFixes.length) {
    console.log(`${C.red}suspect fixes (spec file changed, assertion may have moved)${C.reset} ${suspectFixes.length}`);
    for (const r of suspectFixes) console.log(`  ${r.id}: ${r.was} -> ${r.now}  (${r.spec} is dirty; justify with --allow-spec-change)`);
  }
  if (losses.length) {
    console.log(`${unallowedLosses.length ? C.red : C.yellow}coverage loss${C.reset} ${losses.length}`);
    for (const l of losses) console.log(`  ${l.id}: ${l.was} -> ${l.now}${l.allowed ? '  (allowed)' : '  (--allow-loss <id> to accept)'}`);
  }
  if (changedOther.length) {
    console.log(`${C.yellow}changed (not a regression)${C.reset} ${changedOther.length}`);
    for (const r of changedOther) console.log(`  ${r.id}: ${r.was} -> ${r.now}`);
  }
  if (unknown.length) {
    console.log(`${C.yellow}not in baseline${C.reset} ${unknown.length}: ${unknown.slice(0, 12).join(' ')}${unknown.length > 12 ? ' …' : ''}`);
  }
  if (scopeMissed.length) {
    console.log(`${C.red}in-scope but not executed${C.reset} ${scopeMissed.length}: ${scopeMissed.join(' ')}`);
  }
  console.log(`${C.cyan}unchanged${C.reset} ${unchanged.length}`);
}

const problems = [];
if (regressions.length) problems.push(`${regressions.length} regression(s)`);
if (suspectFixes.length) problems.push(`${suspectFixes.length} suspect fix(es)`);
if (unallowedLosses.length) problems.push(`${unallowedLosses.length} coverage loss(es)`);
if (scopeMissed.length) problems.push(`${scopeMissed.length} in-scope case(s) not executed`);

if (problems.length) {
  console.log('');
  console.log(`${C.red}DELTA FAILED${C.reset} ${problems.join(', ')}`);
  process.exit(1);
}
console.log('');
console.log(`${C.green}DELTA OK${C.reset} no regression, no coverage loss (${fixes.length} fix(es), ${unchanged.length} unchanged).`);
