#!/usr/bin/env node
/**
 * delta.mjs - compare a run's per-case verdicts against the CASE_INDEX baseline.
 *
 * The baseline is the single verdict source (`e2e-tests/CASE_INDEX.csv`).
 * A run only has to prove what changed: this prints regressions, fixes and
 * unchanged cases, and exits non-zero ONLY on a regression.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/delta.mjs --results <file> [--baseline <csv>] [--json]
 *
 * --results accepts any of:
 *   - JSON object map            { "REF-03": "FAIL", ... }
 *   - JSON array of case rows    [ { "id": "REF-03", "verdict": "FAIL" }, ... ]
 *   - JSON array of suite rows   [ { "spec": "...", "cases": { "REF-03": "FAIL" } }, ... ]
 *   - NDJSON                     one { "id": ..., "verdict": ... } per line
 *
 * Exit: 0 no regression, 1 at least one regression, 2 bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, parseArgs, C } from './_lib.mjs';

const root = repoRoot();
const args = parseArgs();
const baselineFile = args.baseline
  ? path.resolve(String(args.baseline))
  : path.join(root, 'e2e-tests', 'CASE_INDEX.csv');
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

/* ---------- CSV ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
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

const raw = parseCsv(fs.readFileSync(baselineFile, 'utf8'));
const header = raw.shift().map((h) => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
if (idx.id === undefined || idx.verdict === undefined) {
  console.error('delta: baseline needs id and verdict columns');
  process.exit(2);
}
const baseline = new Map();
for (const r of raw) {
  if (!r.length || r.every((f) => !String(f).trim())) continue;
  const id = String(r[idx.id] ?? '').trim();
  if (!id) continue;
  if (String(r[idx.retired] ?? '0').trim() === '1') continue;
  baseline.set(id, String(r[idx.verdict] ?? '').trim());
}

/* ---------- results ---------- */
const text = fs.readFileSync(resultsFile, 'utf8');
let run = new Map();
const add = (id, v) => {
  const k = String(id ?? '').trim();
  if (!k) return;
  run.set(k, String(v ?? '').trim().toUpperCase());
};
const trimmed = text.trim();
if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
  const j = JSON.parse(trimmed);
  if (Array.isArray(j)) {
    for (const row of j) {
      if (row && typeof row === 'object' && row.cases && typeof row.cases === 'object') {
        for (const [k, v] of Object.entries(row.cases)) add(k, v);
      } else if (row && typeof row === 'object') {
        add(row.id, row.verdict ?? row.status);
      }
    }
  } else {
    for (const [k, v] of Object.entries(j)) {
      if (v && typeof v === 'object') add(k, v.verdict ?? v.status);
      else add(k, v);
    }
  }
} else {
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      add(o.id, o.verdict ?? o.status);
    } catch { /* not ndjson */ }
  }
}

if (!run.size) {
  console.error('delta: no case verdicts parsed from the results file');
  process.exit(2);
}

/* ---------- diff ---------- */
const GOOD = new Set(['PASS', 'PASS-PARTIAL']);
const regressions = [];
const fixes = [];
const unchanged = [];
const changedOther = [];
const unknown = [];

for (const [id, was] of baseline) {
  if (!run.has(id)) continue; // not executed this run: neither delta nor regression
  const now = run.get(id);
  if (!was || was === now) { unchanged.push({ id, was, now }); continue; }
  if (GOOD.has(was) && now === 'FAIL') regressions.push({ id, was, now });
  else if (was === 'FAIL' && GOOD.has(now)) fixes.push({ id, was, now });
  else if (was === 'FAIL' && now === 'FAIL') unchanged.push({ id, was, now });
  else changedOther.push({ id, was, now });
}
for (const id of run.keys()) if (!baseline.has(id)) unknown.push(id);

const notRun = [...baseline.keys()].filter((id) => !run.has(id));

if (args.json) {
  console.log(JSON.stringify({ regressions, fixes, changedOther, unknown, unchanged: unchanged.length, notRun: notRun.length }, null, 1));
} else {
  console.log(`${C.cyan}delta${C.reset} baseline=${path.relative(root, baselineFile)} results=${path.relative(root, resultsFile)}`);
  console.log(`executed=${run.size}  baseline=${baseline.size}  not-run=${notRun.length}`);
  console.log('');
  console.log(`${regressions.length ? C.red : C.green}regressions${C.reset} ${regressions.length}`);
  for (const r of regressions) console.log(`  ${r.id}: ${r.was} -> ${r.now}`);
  console.log(`${C.green}fixes${C.reset} ${fixes.length}`);
  for (const r of fixes) console.log(`  ${r.id}: ${r.was} -> ${r.now}`);
  if (changedOther.length) {
    console.log(`${C.yellow}changed (not a regression)${C.reset} ${changedOther.length}`);
    for (const r of changedOther) console.log(`  ${r.id}: ${r.was} -> ${r.now}`);
  }
  if (unknown.length) {
    console.log(`${C.yellow}not in baseline${C.reset} ${unknown.length}: ${unknown.slice(0, 12).join(' ')}${unknown.length > 12 ? ' …' : ''}`);
  }
  console.log(`${C.cyan}unchanged${C.reset} ${unchanged.length}`);
}

if (regressions.length) {
  console.log('');
  console.log(`${C.red}DELTA: ${regressions.length} regression(s)${C.reset}`);
  process.exit(1);
}
console.log('');
console.log(`${C.green}DELTA OK${C.reset} no regression (${fixes.length} fix(es), ${unchanged.length} unchanged).`);
