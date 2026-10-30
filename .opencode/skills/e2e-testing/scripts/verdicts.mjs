#!/usr/bin/env node
/**
 * verdicts.mjs - turn a run into per-case verdicts, and stamp them into the index.
 *
 * One pipeline, no other way:
 *   run.mjs  ->  verdicts.mjs  ->  delta.mjs  ->  reconcile.mjs
 *   (executes)   (extracts)        (compares)     (accounts)
 *
 * Usage:
 *   node .../verdicts.mjs                                   # events.ndjson -> JSON map
 *   node .../verdicts.mjs --run <sidecar>                    # bound to that run's window + sha
 *   node .../verdicts.mjs --events a.ndjson --log b.log      # events + VERDICT= lines
 *   node .../verdicts.mjs --run <sidecar> --write-index      # stamp verdict + run reference
 *   node .../verdicts.mjs --migrate                          # add verdict_run/verdict_sha columns
 *
 * Sources, in precedence order (later wins, conflicts are reported):
 *   1. WDIO events (`kind`/`state` + `fullTitle` carrying a case id)
 *   2. `VERDICT=<ID> <VERDICT>` lines in the log or in any --events file
 *
 * --write-index never guesses: it refuses ids that are not in CASE_INDEX.csv,
 * refuses retired rows, and stamps `verdict_run` (sidecar file name) +
 * `verdict_sha` (the sidecar's gitSha) so `reconcile.mjs --close` can prove the
 * verdict came from a run. The dashboard is re-derived from the CSV, never typed.
 *
 * Exit: 0 ok, 2 bad input / refused, 1 write failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  repoRoot, parseArgs, readIndex, writeIndex, indexCounts, syncDashboard, ensureDir, C,
} from './_lib.mjs';
import {
  InputError, readNdjson, readSidecar, parseVerdictLines, verdictsFromEvents,
} from './_results.mjs';

const args = parseArgs();
const root = repoRoot();
const E2E = path.join(root, 'e2e-tests');
const COVERAGE = path.join(E2E, 'COVERAGE.md');

function die(code, msg) {
  console.error(`verdicts: ${msg}`);
  process.exit(code);
}

/* ---------- migrate ---------- */
if (args.migrate) {
  const index = readIndex(root);
  const missing = ['verdict_run', 'verdict_sha'].filter((c) => index.ix[c] === undefined);
  if (!missing.length) {
    console.log('verdicts: verdict_run/verdict_sha already present, nothing to migrate');
    process.exit(0);
  }
  for (const col of missing) {
    index.ix[col] = index.header.length;
    index.header.push(col);
    for (const row of index.rows) row.push('');
  }
  writeIndex(index);
  console.log(`${C.green}migrated${C.reset} CASE_INDEX.csv: added ${missing.join(', ')} (${index.rows.length} rows, empty)`);
  process.exit(0);
}

/* ---------- collect ---------- */
let since;
let until;
let sidecar = null;
if (args.run) {
  const file = path.resolve(root, String(args.run));
  try {
    sidecar = readSidecar(file);
  } catch (err) {
    die(2, err.message);
  }
  const started = new Date(sidecar.startedAt).getTime();
  if (!Number.isFinite(started)) die(2, `${file} has no usable startedAt`);
  since = started - 1000;
  until = started + Number(sidecar.durationMs || 0) + 5000;
  // The sidecar records the log run.mjs teed. Without reading it, `--run`
  // silently drops every `VERDICT=<ID> <VERDICT>` line and the mocha outcome
  // wins - a case the spec explicitly recorded FAIL (27c/27d/27e all do) would
  // be stamped PASS. Proven 2026-10-30: 27c-i18-ui sidecar read back I18-03
  // as PASS while its own log line said `VERDICT=I18-03 FAIL`.
  if (!args.log && sidecar.log) {
    const sidecarLog = path.resolve(root, String(sidecar.log));
    if (fs.existsSync(sidecarLog)) args.log = sidecarLog;
  }
}
if (args.since) {
  const t = new Date(String(args.since)).getTime();
  if (!Number.isFinite(t)) die(2, `--since is not a date: ${args.since}`);
  since = t;
}
if (args.until) {
  const t = new Date(String(args.until)).getTime();
  if (!Number.isFinite(t)) die(2, `--until is not a date: ${args.until}`);
  until = t;
}

const eventsFile = path.resolve(root, String(args.events || path.join(E2E, 'results', 'events.ndjson')));
const fromEvents = new Map();
if (fs.existsSync(eventsFile)) {
  let records;
  try {
    records = readNdjson(eventsFile);
  } catch (err) {
    die(2, err.message);
  }
  for (const [id, v] of verdictsFromEvents(records, { since, until })) fromEvents.set(id, v);
} else if (!args.log) {
  die(2, `no events file at ${eventsFile} (and no --log given)`);
}

/* VERDICT= lines: in the log and in any events file that is actually text. */
const authored = new Map();
const sources = [];
if (args.log) sources.push(path.resolve(root, String(args.log)));
if (fs.existsSync(eventsFile)) sources.push(eventsFile);
for (const src of sources) {
  let text;
  try {
    text = fs.readFileSync(src, 'utf8');
  } catch (err) {
    die(2, `cannot read ${src}: ${err.message}`);
  }
  let lines;
  try {
    lines = parseVerdictLines(text);
  } catch (err) {
    die(2, err.message);
  }
  for (const [id, v] of lines) authored.set(id, v);
}

const merged = new Map([...fromEvents]);
const conflicts = [];
for (const [id, v] of authored) {
  if (merged.has(id) && merged.get(id) !== v) conflicts.push(`${id}: events=${merged.get(id)} verdict-line=${v}`);
  merged.set(id, v);
}
if (!merged.size) die(2, 'no case verdicts found (events carry no case id and no VERDICT= lines were seen)');

const sorted = Object.fromEntries([...merged.entries()].sort(([a], [b]) => a.localeCompare(b)));

/* ---------- output ---------- */
if (args.out) {
  const out = path.resolve(root, String(args.out));
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, JSON.stringify(sorted, null, 1) + '\n', 'utf8');
  if (!args.quiet) console.log(`${C.green}wrote${C.reset} ${path.relative(root, out)}  (${merged.size} case verdicts)`);
}
if (conflicts.length) {
  console.log(`${C.yellow}${conflicts.length} conflict(s), the VERDICT line wins:${C.reset}`);
  for (const c of conflicts) console.log(`  ${c}`);
}

/* ---------- write into the index ---------- */
if (args['write-index']) {
  if (!sidecar) die(2, '--write-index needs --run <sidecar> so the verdict carries a run reference');
  const index = readIndex(root);
  for (const col of ['verdict', 'verdict_run', 'verdict_sha']) {
    if (index.ix[col] === undefined) die(2, `CASE_INDEX.csv has no "${col}" column; run verdicts.mjs --migrate first`);
  }
  const runRef = path.basename(path.resolve(root, String(args.run)));
  const sha = String(sidecar.gitSha || '').trim();
  if (!sha || sha === 'unknown') die(2, `${runRef} carries no gitSha - refusing to stamp a verdict without provenance`);

  const unknown = [...merged.keys()].filter((id) => !index.byId.has(id));
  if (unknown.length) die(2, `these ids are not in CASE_INDEX.csv: ${unknown.join(', ')}`);

  const changes = [];
  const skipped = [];
  for (const [id, verdict] of merged) {
    const row = index.byId.get(id);
    if (index.get(row, 'retired') === '1') { skipped.push(`${id} (retired)`); continue; }
    const was = index.get(row, 'verdict');
    if (was === verdict && index.get(row, 'verdict_run') === runRef && index.get(row, 'verdict_sha') === sha) continue;
    row[index.ix.verdict] = verdict;
    row[index.ix.verdict_run] = runRef;
    row[index.ix.verdict_sha] = sha;
    if (was !== verdict) changes.push(`${id}: ${was || '(none)'} -> ${verdict}`);
  }

  // Derived rows (D5): a row whose `spec` is `derived:<ANCHOR_ID>` has no case
  // of its own; its verdict is the anchor's. It is PASS/PASS-PARTIAL only when
  // the anchor is AND the anchor is not marked unproven: the anchor's evidence
  // carries UNPROVEN or INTERMITTENT when the observation is a low-rate flake
  // or has no confirmed root cause, and a derived row must not launder that
  // into a green.
  const DERIVED_MARK = /^derived:([A-Z][A-Z0-9]{1,3}-\d{2,3})$/;
  const isUnproven = (text) => /\b(UNPROVEN|INTERMITTENT)\b/i.test(String(text ?? ''));
  for (const row of index.rows) {
    if (index.get(row, 'retired') === '1') continue;
    const m = DERIVED_MARK.exec(index.get(row, 'spec'));
    if (!m) continue;
    const id = index.get(row, 'id');
    const anchor = index.byId.get(m[1]);
    if (!anchor) {
      die(2, `${id} derives from ${m[1]}, which is not in CASE_INDEX.csv`);
    }
    const anchorVerdict = index.get(anchor, 'verdict');
    const unproven = isUnproven(index.get(anchor, 'evidence'));
    const next = ['PASS', 'PASS-PARTIAL'].includes(anchorVerdict) && !unproven ? anchorVerdict : 'FAIL';
    const was = index.get(row, 'verdict');
    const nextRun = index.get(anchor, 'verdict_run');
    const nextSha = index.get(anchor, 'verdict_sha');
    if (was === next && index.get(row, 'verdict_run') === nextRun) continue;
    row[index.ix.verdict] = next;
    row[index.ix.verdict_run] = nextRun;
    row[index.ix.verdict_sha] = nextSha;
    changes.push(`${id}: ${was || '(none)'} -> ${next} (derived from ${m[1]}${unproven ? ', anchor UNPROVEN' : ''})`);
  }
  writeIndex(index);
  const dashboard = syncDashboard(COVERAGE, indexCounts(index));
  console.log(`${C.green}index${C.reset} ${changes.length} verdict change(s), run=${runRef} sha=${sha}`);
  for (const c of changes) console.log(`  ${c}`);
  for (const d of dashboard) console.log(`  dashboard ${d}`);
  if (skipped.length) console.log(`${C.yellow}skipped${C.reset} ${skipped.join(', ')}`);
  process.exit(0);
}

if (!args.out) {
  console.log(JSON.stringify(sorted, null, 1));
}
