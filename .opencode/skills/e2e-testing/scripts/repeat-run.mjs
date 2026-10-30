#!/usr/bin/env node
/**
 * repeat-run.mjs - flake check that compares per-case outcomes, not exit codes.
 *
 * Usage:
 *   node .../repeat-run.mjs --spec e2e-tests/specs/30-ref-refunds.e2e.ts --times 3
 *   node .../repeat-run.mjs --spec a.e2e.ts --spec b.e2e.ts --times 3 --no-wipe
 *   node .../repeat-run.mjs --from-sidecars a.json,b.json      # analyse existing runs
 *
 * Verdict:
 *   STABLE              every run green, every case identical
 *   FLAKY               at least one case changed verdict between runs (listed)
 *   DETERMINISTIC       the SAME cases failed in every run (listed)
 *   UNCLASSIFIABLE      a run produced no per-case verdicts (infrastructure), so
 *                       "deterministic" would be a lie - fix the harness first
 *
 * A spec is never called a deterministic failure from its exit code alone: that
 * needs the same failing case set in every run.
 *
 * Exit: 0 stable, 1 anything else, 2 bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, repoRoot, parseArgs, bad, info, C } from './_lib.mjs';

const RUN_MJS = fileURLToPath(new URL('./run.mjs', import.meta.url));

const args = parseArgs();
const root = repoRoot();
const p = paths(root);

function readSidecar(file) {
  const obj = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
  if (!obj || typeof obj !== 'object' || !('exitCode' in obj)) {
    bad(`${file} is not a run sidecar`);
    process.exit(2);
  }
  return { file, ...obj };
}

let runs = [];
if (args['from-sidecars']) {
  const files = String(args['from-sidecars']).split(',').map((s) => s.trim()).filter(Boolean);
  if (files.length < 2) {
    bad('--from-sidecars needs at least two sidecars (a,b)');
    process.exit(2);
  }
  runs = files.map(readSidecar);
} else {
  const times = Number(args.times || 3);
  const specs = args.spec ? [].concat(args.spec) : [];
  if (!specs.length) {
    bad('--spec is required (or --from-sidecars for an existing set of runs)');
    process.exit(2);
  }
  if (!Number.isFinite(times) || times < 2) {
    bad('--times must be >= 2');
    process.exit(2);
  }
  const baseTag = String(args.tag || path.basename(specs[0]).replace(/\.e2e\.ts$/, ''));
  for (let i = 1; i <= times; i++) {
    const tag = `${baseTag}-r${i}`;
    info(`--- run ${i}/${times} (${tag}) ---`);
    const argv = [RUN_MJS, '--spec', ...specs, '--tag', tag];
    if (!args['no-wipe']) argv.push('--wipe');
    if (args.timeout) argv.push('--timeout', String(args.timeout));
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, argv, { cwd: root, stdio: 'inherit' });
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    const sidecarFile = path.join(p.runs, fs.readdirSync(p.runs).filter((f) => f.endsWith(`-${tag}.json`)).sort().pop() || '');
    if (!fs.existsSync(sidecarFile)) {
      runs.push({ file: '(missing sidecar)', tag, exitCode: code, caseVerdicts: null });
    } else {
      runs.push(readSidecar(sidecarFile));
    }
  }
}

/* ---------- per-case matrix ---------- */
const perRun = runs.map((r) => (r.caseVerdicts && typeof r.caseVerdicts === 'object' ? r.caseVerdicts : null));
const withoutCases = runs.filter((r, i) => !perRun[i] || !Object.keys(perRun[i]).length);

console.log('');
console.log('run  exit  cases  seconds  tag');
runs.forEach((r, i) => {
  const n = perRun[i] ? Object.keys(perRun[i]).length : 0;
  console.log(`${String(i + 1).padStart(3)}  ${String(r.exitCode).padStart(4)}  ${String(n).padStart(5)}  ${String(((r.durationMs || 0) / 1000).toFixed(1)).padStart(7)}  ${r.tag || path.basename(r.file)}`);
});

if (withoutCases.length) {
  console.log('');
  console.log(`${C.red}UNCLASSIFIABLE${C.reset} ${withoutCases.length}/${runs.length} run(s) recorded no per-case verdicts.`);
  console.log('  A run with no per-case data cannot be called a deterministic failure - fix the harness/run first.');
  process.exit(1);
}

const ids = [...new Set(perRun.flatMap((m) => Object.keys(m)))].sort();
const differing = [];
const alwaysFail = [];
for (const id of ids) {
  // '-' = the case did not report in that run. It is NOT the same as FAIL:
  // a case that fails in one run and never reports in the next has not been
  // shown to fail deterministically.
  const row = perRun.map((m) => m[id] ?? '-');
  const distinct = [...new Set(row)];
  if (distinct.length > 1) differing.push({ id, seen: row });
  else if (row.every((v) => v === 'FAIL')) alwaysFail.push(id);
}

const allGreen = runs.every((r) => r.exitCode === 0) && !alwaysFail.length && !differing.length;

console.log('');
if (allGreen) {
  console.log(`${C.green}STABLE${C.reset} ${runs.length}/${runs.length} green, ${ids.length} case(s) identical across runs`);
  process.exit(0);
}

if (differing.length) {
  console.log(`${C.yellow}FLAKY${C.reset} ${differing.length} case(s) changed verdict between runs:`);
  for (const d of differing.slice(0, 15)) console.log(`  ${d.id}: ${d.seen.join(' -> ')}`);
  if (differing.length > 15) console.log(`  … ${differing.length - 15} more`);
  console.log('  Find the race (wait on state, not time). Do not add retries.');
  process.exit(1);
}

if (alwaysFail.length) {
  console.log(`${C.red}DETERMINISTIC FAILURE${C.reset} the same ${alwaysFail.length} case(s) failed in all ${runs.length} runs:`);
  for (const id of alwaysFail.slice(0, 15)) console.log(`  ${id}`);
  if (alwaysFail.length > 15) console.log(`  … ${alwaysFail.length - 15} more`);
  console.log('  Triage normally: this is not a flake.');
  process.exit(1);
}

console.log(`${C.red}UNSTABLE${C.reset} red runs but no case-level difference was found (setup/teardown or infra failure).`);
console.log('  Read the logs; this is not a case result and must not be reported as one.');
process.exit(1);
