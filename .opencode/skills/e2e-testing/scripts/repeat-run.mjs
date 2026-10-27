#!/usr/bin/env node
/**
 * repeat-run.mjs - flake check: run a spec N times, wiping between runs.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/repeat-run.mjs --spec e2e-tests/specs/30-ref-refunds.e2e.ts --times 3
 *   node ... --spec ... --times 5 --no-wipe      # state persists between runs (rarely what you want)
 *
 * Verdict:
 *   N/N green        -> stable
 *   1..N-1 green     -> FLAKY: treat as an app race until the log proves otherwise
 *   0/N green        -> deterministic failure: triage normally
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, repoRoot, parseArgs, bad, info, C } from './_lib.mjs';

const args = parseArgs();
const times = Number(args.times || 3);
const specs = args.spec ? [].concat(args.spec) : [];
if (!specs.length) {
  bad('--spec is required');
  process.exit(2);
}
if (!Number.isFinite(times) || times < 2) {
  bad('--times must be >= 2');
  process.exit(2);
}

const root = repoRoot();
const p = paths(root);
const runner = path.join(root, '.opencode', 'skills', 'e2e-testing', 'scripts', 'run.mjs');
const baseTag = String(args.tag || path.basename(specs[0]).replace(/\.e2e\.ts$/, ''));

const rows = [];
for (let i = 1; i <= times; i++) {
  const tag = `${baseTag}-r${i}`;
  info(`--- run ${i}/${times} (${tag}) ---`);
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const argv = [runner, '--spec', ...specs, '--tag', tag];
    if (!args['no-wipe']) argv.push('--wipe');
    if (args.timeout) argv.push('--timeout', String(args.timeout));
    const child = spawn(process.execPath, argv, { cwd: root, stdio: 'inherit' });
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  rows.push({ run: i, code, seconds: (Date.now() - started) / 1000, tag });
  // Stop early on the first red? No: a flake needs the full sample.
}

console.log('');
console.log('run  exit  seconds  tag');
for (const r of rows) {
  console.log(`${String(r.run).padStart(3)}  ${String(r.code).padStart(4)}  ${r.seconds.toFixed(1).padStart(7)}  ${r.tag}`);
}
const green = rows.filter((r) => r.code === 0).length;
console.log('');
if (green === times) {
  console.log(`${C.green}STABLE${C.reset} ${green}/${times} green`);
  process.exit(0);
}
if (green === 0) {
  console.log(`${C.red}DETERMINISTIC FAILURE${C.reset} 0/${times} green - triage normally, this is not a flake`);
  process.exit(1);
}
console.log(`${C.yellow}FLAKY${C.reset} ${green}/${times} green - find the race; do not add retries`);
process.exit(1);
