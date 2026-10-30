#!/usr/bin/env node
/**
 * prove-fix.mjs - the only acceptable proof that a fix is a fix.
 *
 * A green run after an edit proves nothing: the assertion may have moved with
 * the bug. This script builds the pre-fix tree, shows the case is RED there,
 * restores the fix, rebuilds, and shows the case is GREEN 3/3.
 *
 * Safety (binding):
 *   - the pre-fix tree is built with a PATH-LIMITED stash of app paths only:
 *       git stash push -m prove-fix-prefix -- <app paths>
 *   - it never uses `git stash -u`/`--include-untracked` and never `git clean`:
 *     untracked files (your notes, new specs, evidence) are never touched.
 *   - the stash is popped in a finally block, even if a run throws.
 *
 * Modes:
 *   --case <ID> --spec <file>          fix mode: red without the fix, 3/3 green with it
 *   --case <ID> --spec <file> --finding finding mode: same verdict twice = a real finding
 *   --dry-run                          print the plan, touch nothing
 *
 * Exit:
 *   0  the proof holds (fix: red -> 3/3 green; finding: same verdict twice)
 *   1  the proof failed (case green without the fix, any post-fix run red, verdict changed)
 *   2  bad input / nothing to prove / git refused
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  repoRoot, parseArgs, paths, gitSha, stamp, APP_PATHS, C, bad, warn, info, ok,
} from './_lib.mjs';

const RUN_MJS = fileURLToPath(new URL('./run.mjs', import.meta.url));

const args = parseArgs();
const root = repoRoot();
const p = paths(root);

const spec = args.spec ? String(args.spec) : '';
const caseId = args.case ? String(args.case).toUpperCase() : '';
const findingMode = Boolean(args.finding);
const dryRun = Boolean(args['dry-run']);
const times = Number(args.times || 3);

if (!spec || !caseId) {
  bad('--spec <file> and --case <ID> are required');
  process.exit(2);
}
if (!fs.existsSync(path.resolve(root, spec))) {
  bad(`spec not found: ${spec}`);
  process.exit(2);
}
if (!findingMode && (!Number.isFinite(times) || times < 3)) {
  bad('--times must be >= 3 (3/3 green is the bar)');
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* what changed in the app (the thing the fix is)                       */
/* ------------------------------------------------------------------ */

function git(argv, opts = {}) {
  const r = spawnSync('git', argv, { cwd: root, encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || '').trim();
    if (opts.optional) return null;
    bad(`git ${argv.join(' ')} failed: ${msg.split('\n')[0]}`);
    process.exit(2);
  }
  return String(r.stdout || '');
}

git(['rev-parse', '--is-inside-work-tree']);
const changed = git(['status', '--porcelain', '--', ...APP_PATHS])
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => l.slice(3).trim())
  .filter(Boolean);

if (!changed.length) {
  bad('nothing to prove: no app path changed (src/, src-tauri/src/, Cargo.toml, tauri.conf.json, ...)');
  info('a fix that touches no app path is a test change - that is a suspect fix, not a proven one');
  process.exit(2);
}

const stashMsg = `prove-fix-prefix-${stamp()}`;

/* ------------------------------------------------------------------ */
/* dry run                                                             */
/* ------------------------------------------------------------------ */

if (dryRun) {
  console.log(`${C.cyan}prove-fix${C.reset} dry run - nothing is stashed, rebuilt or run`);
  console.log('');
  console.log(`case              ${caseId} in ${spec}`);
  console.log(`changed app paths ${changed.join(', ')}`);
  console.log(`stash             git stash push -m ${stashMsg} -- ${APP_PATHS.join(' ')}`);
  console.log(`step 1  build the pre-fix tree (path-limited stash above)`);
  console.log(`step 2  run ${caseId} once - it MUST be RED (a case that passes without the fix proves nothing)`);
  console.log(`step 3  restore    git stash pop`);
  console.log(`step 4  rebuild    npm run build:e2e`);
  console.log(`step 5  run ${caseId} ${times}x - all ${times} MUST be GREEN`);
  console.log('');
  console.log(`${C.dim}never: an untracked-inclusive stash, and never a tree wipe - untracked files are yours.${C.reset}`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* running the case                                                    */
/* ------------------------------------------------------------------ */

function runCase(tag) {
  const sidecarDir = p.runs;
  const before = fs.existsSync(sidecarDir) ? new Set(fs.readdirSync(sidecarDir)) : new Set();
  const r = spawnSync(process.execPath, [RUN_MJS, '--spec', spec, '--wipe', '--tag', tag], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  const code = r.status ?? 1;
  let verdict = null;
  if (fs.existsSync(sidecarDir)) {
    const added = fs.readdirSync(sidecarDir).filter((f) => !before.has(f) && f.endsWith('.json')).sort();
    const file = added.length ? path.join(sidecarDir, added[added.length - 1]) : null;
    if (file) {
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        verdict = meta.caseVerdicts ? meta.caseVerdicts[caseId] ?? null : null;
        return { code, verdict, sidecar: path.relative(root, file), meta };
      } catch { /* fall through */ }
    }
  }
  return { code, verdict, sidecar: null, meta: null };
}

const isRed = (r) => r.verdict === 'FAIL' || (r.verdict === null && r.code !== 0);
const isGreen = (r) => r.verdict === 'PASS' || (r.verdict === null && r.code === 0);

/* ------------------------------------------------------------------ */
/* finding mode                                                        */
/* ------------------------------------------------------------------ */

if (findingMode) {
  console.log(`${C.cyan}prove-fix${C.reset} finding mode: ${caseId} in ${spec}, twice`);
  const a = runCase(`prove-fix-find-1-${caseId}`);
  const b = runCase(`prove-fix-find-2-${caseId}`);
  const va = a.verdict ?? (a.code === 0 ? 'PASS' : 'FAIL');
  const vb = b.verdict ?? (b.code === 0 ? 'PASS' : 'FAIL');
  console.log('');
  console.log(`run 1: ${va}   run 2: ${vb}`);
  if (va === vb) {
    console.log(`${C.green}FINDING CONFIRMED${C.reset} the same verdict twice (${va}). This is not a flake - triage it.`);
    process.exit(0);
  }
  console.log(`${C.red}FLAKY${C.reset} the verdict changed between two runs (${va} -> ${vb}).`);
  console.log('  Do not triage the case yet: fix the race or the harness first.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* fix mode                                                            */
/* ------------------------------------------------------------------ */

console.log(`${C.cyan}prove-fix${C.reset} ${caseId} in ${spec}`);
console.log(`changed app paths: ${changed.join(', ')}`);
console.log(`git ${gitSha(root)}`);
console.log('');

let stashed = false;
let result = 1;
try {
  info(`stashing app paths only (${stashMsg}) ...`);
  git(['stash', 'push', '-m', stashMsg, '--', ...APP_PATHS]);
  stashed = true;

  info('building the pre-fix tree (npm run build:e2e) ...');
  const build1 = spawnSync('npm', ['run', 'build:e2e'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if ((build1.status ?? 1) !== 0) {
    bad('the pre-fix build failed - cannot prove anything from a tree that does not compile');
    result = 2;
  } else {
    info(`pre-fix run: ${caseId} must be RED ...`);
    const red = runCase(`prove-fix-red-${caseId}`);
    console.log('');
    console.log(`pre-fix: ${red.verdict ?? '(no case verdict)'}  exit ${red.code}`);
    if (!isRed(red)) {
      bad('the case is GREEN without the fix - it does not exercise the bug (or the "fix" is elsewhere)');
      result = 1;
    } else {
      info('restoring the fix ...');
      git(['stash', 'pop']);
      stashed = false;

      info('rebuilding with the fix ...');
      const build2 = spawnSync('npm', ['run', 'build:e2e'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
      if ((build2.status ?? 1) !== 0) {
        bad('the post-fix build failed');
        result = 1;
      } else {
        const greens = [];
        for (let i = 1; i <= times; i++) {
          info(`post-fix run ${i}/${times} ...`);
          const r = runCase(`prove-fix-green-${i}-${caseId}`);
          greens.push(r);
          if (!isGreen(r)) break;
        }
        console.log('');
        console.log(`post-fix: ${greens.map((g) => g.verdict ?? (g.code === 0 ? 'PASS(exit)' : 'FAIL(exit)')).join(' ')}`);
        if (greens.length === times && greens.every(isGreen)) {
          ok(`PROVEN: ${caseId} red without the fix, green ${times}/${times} with it`);
          result = 0;
        } else {
          bad(`NOT PROVEN: ${greens.filter((g) => !isGreen(g)).length} red run(s) after the fix`);
          result = 1;
        }
      }
    }
  }
} finally {
  if (stashed) {
    warn('restoring the stash (the run ended early) ...');
    const r = spawnSync('git', ['stash', 'pop'], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) {
      console.log(`${C.red}could not pop ${stashMsg}: run "git stash list" and "git stash pop" yourself${C.reset}`);
    }
  }
}

if (result !== 0) {
  console.log('');
  console.log(`${C.red}PROVE-FIX FAILED${C.reset} (exit ${result}). Do not report this as a fix.`);
  process.exit(result);
}
console.log(`${C.dim}record this in the verdict evidence: red pre-fix, ${times}/${times} green post-fix, ${gitSha(root)}${C.reset}`);
