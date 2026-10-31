#!/usr/bin/env node
/**
 * run.mjs - run one or more specs, tee the output to a log, write a sidecar.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/run.mjs --spec e2e-tests/specs/00-harness-smoke.e2e.ts --wipe --tag smoke
 *   node .opencode/skills/e2e-testing/scripts/run.mjs --spec a.e2e.ts --spec b.e2e.ts
 *   node ... --all                      # whole suite
 *   node ... --build                    # npm run build:e2e first
 *   node ... --timeout 900000           # WDIO_MOCHA_TIMEOUT
 *
 * Writes e2e-tests/results/runs/<stamp>-<tag>.log and .json.
 *
 * Counts are SUMMED across every spec line: WDIO prints one `N passing` block
 * per spec file, so reading only the first block under-reports a multi-spec
 * run (and a green first spec hides a red second one).
 *
 * The sidecar also carries `caseVerdicts` (id -> verdict) harvested from
 * results/events.ndjson inside this run's window, overridden by any
 * `VERDICT=<ID> <VERDICT>` line in the log. repeat-run.mjs and prove-fix.mjs
 * read that field; without it they can only see exit codes.
 *
 * Exit code is the WDIO exit code (0 = green).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths, repoRoot, gitSha, stamp, parseArgs, bad, info, C, sumRunCounts } from './_lib.mjs';
import { parseVerdictLines, verdictsFromEvents, readNdjson } from './_results.mjs';

const args = parseArgs();
if (args.help) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const root = repoRoot();
const p = paths(root);
fs.mkdirSync(p.runs, { recursive: true });

const specs = args.spec ? [].concat(args.spec) : [];
if (!specs.length && !args.all) {
  bad('no --spec given (use --all for the whole suite)');
  process.exit(2);
}
for (const s of specs) {
  if (!fs.existsSync(path.resolve(root, s))) {
    bad(`spec not found: ${s}`);
    process.exit(2);
  }
}

const tag = String(args.tag || (args.all ? 'all' : path.basename(specs[0]).replace(/\.e2e\.ts$/, '')));
const ts = stamp();
const logFile = path.join(p.runs, `${ts}-${tag}.log`);
const sidecar = path.join(p.runs, `${ts}-${tag}.json`);

if (args.build) {
  info('building e2e flavor (npm run build:e2e) ...');
  const code = await runInherit('npm', ['run', 'build:e2e'], root, process.env);
  if (code !== 0) {
    bad(`build failed with exit ${code}`);
    process.exit(code);
  }
}

const env = { ...process.env };
if (args.wipe) env.POS_E2E_WIPE = '1';
if (args.timeout) env.WDIO_MOCHA_TIMEOUT = String(args.timeout);

const wdioArgs = [p.wdioBin, 'run', p.wdioConf];
for (const s of specs) wdioArgs.push('--spec', path.resolve(root, s));
// Mocha title filter. Needed for measurements that must repeat ONE case
// (the REF-28 wallet diagnostic) without paying for the whole spec's retry
// loops: `--grep "REF-28"`. Passing it through is a measurement tool, not a
// way to skip cases in a verdict run.
if (args.grep) wdioArgs.push('--mochaOpts.grep', String(args.grep));

info(`run     ${tag}`);
info(`specs   ${specs.length ? specs.join(', ') : '(all)'}`);
info(`wipe    ${args.wipe ? 'yes' : 'no'}`);
info(`log     ${path.relative(root, logFile)}`);

const started = Date.now();
const sha = gitSha(root);
const code = await tee(process.execPath, wdioArgs, root, env, logFile);
const durationMs = Date.now() - started;

const text = fs.readFileSync(logFile, 'utf8');
const counts = sumRunCounts(text);
const { passing, failing, skipped } = counts;

/* Per-case verdicts for this run only: events inside the window, then any
 * authored VERDICT= line in this log (the author's explicit statement wins). */
let caseVerdicts = {};
const eventsFile = path.join(p.results, 'events.ndjson');
if (fs.existsSync(eventsFile)) {
  try {
    const map = verdictsFromEvents(readNdjson(eventsFile), { since: started - 1000, until: Date.now() + 5000 });
    caseVerdicts = Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  } catch (err) {
    info(`events  ${err.message} (no caseVerdicts in the sidecar)`);
  }
}
try {
  for (const [id, v] of parseVerdictLines(text)) caseVerdicts[id] = v;
} catch (err) {
  bad(err.message);
}
const caseCount = Object.keys(caseVerdicts).length;

const record = {
  tag,
  specs: specs.length ? specs : ['(all)'],
  gitSha: sha,
  wipe: Boolean(args.wipe),
  startedAt: new Date(started).toISOString(),
  durationMs,
  exitCode: code,
  passing,
  failing,
  skipped,
  caseVerdicts,
  log: path.relative(root, logFile),
  node: process.version,
  binary: path.relative(root, p.binary),
};
/* Money conservation (owner P0 rule): the run's own database must balance.
 * Blocking by default; deliberate negative-control writes are excluded here (the
 * --audit-dbs audit mode reports them). */
let moneyFailure = null;
try {
  const sandboxDb = path.join(process.env.LOCALAPPDATA ?? '', 'Temp', 'opencode', 'pos-wdio-sandbox', 'home', 'AppData', 'Roaming', 'com.mobi.pos.e2e', 'mobi_pos.db');
  if (fs.existsSync(sandboxDb) && process.env.REFUND_VALUE_SKIP !== '1') {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'refund-value-check.mjs'), '--exclude-forge', sandboxDb], { encoding: 'utf8' });
    const line = String(res.stdout ?? '').trim().split('\n')[0];
    if (line) info(line);
    if (res.status !== 0) { moneyFailure = line || 'money conservation failed'; bad('money conservation FAILED (blocking)'); }
  }
} catch (err) {
  bad('money check unavailable :: ' + String(err.message ?? err));
}
if (moneyFailure) record.moneyViolation = moneyFailure;
fs.writeFileSync(sidecar, JSON.stringify(record, null, 2));

console.log('');
info(`duration ${(durationMs / 1000).toFixed(1)}s   passing ${passing}   failing ${failing}   skipped ${skipped}   cases ${caseCount}`);
info(`sidecar  ${path.relative(root, sidecar)}`);
const finalCode = code === 0 && !moneyFailure ? 0 : (code || 1);
if (code === 0 && failing === 0 && !moneyFailure) console.log(`${C.green}GREEN${C.reset} ${tag}`);
else console.log(`${C.red}RED${C.reset} ${tag} (exit ${finalCode}) - triage before editing code`);

process.exit(finalCode);

/* ------------------------------------------------------------------ */

function tee(cmd, argv, cwd, env, file) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(file, { flags: 'w' });
    const child = spawn(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (stream, target) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        target.write(chunk);
        out.write(chunk);
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('close', (code) => {
      out.end(() => resolve(code ?? 1));
    });
    child.on('error', (err) => {
      out.write(`\n[run.mjs] spawn error: ${err.message}\n`);
      out.end(() => resolve(1));
    });
  });
}

function runInherit(cmd, argv, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
