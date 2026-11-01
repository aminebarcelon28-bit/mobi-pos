#!/usr/bin/env node
/**
 * selftest.mjs - fixture-only self-test for every script in this skill.
 *
 * No app, no driver, no sandbox: each test builds a throwaway "repo" under
 * %TEMP%\opencode\selftest\<test>\ (src-tauri/tauri.conf.json so repoRoot()
 * resolves, e2e-tests/ with the CSV/dashboard/clusters, specs and results) and
 * runs the real script against it. This is the gate that proves the scripts
 * themselves are not lying.
 *
 * Usage:
 *   node .opencode/skills/e2e-testing/scripts/selftest.mjs [--filter <text>] [--keep] [--verbose]
 *
 * Exit: 0 every test passed, 1 at least one failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, sumRunCounts, classifyId, csvLine, parseCsv, readIndex, writeIndex, indexCounts, readDashboard,
} from './_lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const FILTER = args.filter ? String(args.filter) : '';
const KEEP = Boolean(args.keep);
const VERBOSE = Boolean(args.verbose);
const ROOT = path.join(process.env.TEMP || os.tmpdir(), 'opencode', 'selftest');

const results = [];
const strip = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');

function check(name, cond, detail = '') {
  const pass = Boolean(cond);
  results.push({ name, pass, detail: String(detail).slice(0, 400) });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${!pass && detail ? `\n        ${String(detail).split('\n').join('\n        ').slice(0, 600)}` : ''}`);
  return pass;
}

function eq(name, got, want) {
  return check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const HEADER = 'id,domain,priority,conditional_p0,title,section,line,retired,verdict,spec,evidence,verdict_run,verdict_sha';

function defaultIndexRows() {
  return [
    ['REF-01', 'REF', 'P0', '', 'refund happy path on a cash sale', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', '**PASS**', '', ''],
    ['REF-02', 'REF', 'P0', '', 'refund refuses a negative quantity', 'REF', '11', '0', 'FAIL', '10-ref.e2e.ts', '**FAIL** — DB rows=0', '', ''],
    ['REF-03', 'REF', 'P1', '', 'refund replay writes once', 'REF', '12', '0', 'PASS', '10-ref.e2e.ts', '**PASS**', '', ''],
    ['BLK-01', 'BLK', 'P1', '', 'gateway round trip', 'BLK', '', '0', 'BLOCKED', '', 'BLOCKED — needs a configured merchant gateway', '', ''],
    ['NAP-01', 'NAP', 'P2', '', 'foreign currency tender', 'NAP', '', '0', 'N/A', '', 'N/A — no foreign-currency tender exists', '', ''],
  ];
}

function dashboardFor(rows) {
  const c = { PASS: 0, 'PASS-PARTIAL': 0, FAIL: 0, 'N/A': 0, REMAIN: 0, BLOCKED: 0 };
  let total = 0;
  for (const r of rows) {
    if (String(r[7]) === '1') continue;
    total++;
    if (c[r[8]] !== undefined) c[r[8]]++;
  }
  return `# COVERAGE

## Summary dashboard

| Metric | Count |
|---|---|
| Catalog cases (table rows) | ${total} |
| Passed (full) | ${c.PASS} |
| Passed (partial - unasserted facets listed) | ${c['PASS-PARTIAL']} |
| Passed (full, excluding flaky rows) | ${rows.filter((r) => String(r[7]) !== '1' && r[8] === 'PASS' && !/FLAKY/i.test(String(r[10] ?? ''))).length} |
| FLAKY (pass, order-dependent - excluded from the headline) | ${rows.filter((r) => String(r[7]) !== '1' && ['PASS', 'PASS-PARTIAL'].includes(r[8]) && /FLAKY/i.test(String(r[10] ?? ''))).length} |
| **FAILED** | ${c.FAIL} |
| N/A (absent or unobservable in harness) | ${c['N/A']} |
| Remaining (doable today, not yet executed) | ${c.REMAIN} |
| BLOCKED (missing dependency — see Evidence) | ${c.BLOCKED} |

trailing prose that must survive
`;
}

function clustersFor(rows) {
  const fails = rows.filter((r) => r[8] === 'FAIL');
  const lines = ['case_id,cluster_id,cluster_key,class,evidence,money,priority,catalog'];
  fails.forEach((r, i) => lines.push(csvLine([r[0], `C${String(i + 1).padStart(2, '0')}`, 'REF-NEGATIVE', 'app', 'SQLite', 'money movement', r[2], 'A'])));
  return lines.join('\n') + '\n';
}

const DEFAULT_SPEC = `import { expect } from '@wdio/globals';

describe('REF - refunds', () => {
  it('[REF-01] refund happy path on a cash sale', async () => {
    expect(1).toBe(1);
  });
  it('[REF-02] refund refuses a negative quantity', async () => {
    expect(1).toBe(1);
  });
  it('[REF-03] refund replay writes once', async () => {
    expect(1).toBe(1);
  });
});
`;

const FEATURE_MAP = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  scannedFiles: 2,
  features: {
    'refund': { exists: true, evidence: ['src/services/refundService.ts:12'] },
    'cart totals': { exists: true, evidence: ['src/components/CartPanel.tsx:44'] },
  },
};

function makeRepo(name, opts = {}) {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const e2e = path.join(dir, 'e2e-tests');
  fs.mkdirSync(path.join(dir, 'src-tauri'), { recursive: true });
  fs.mkdirSync(path.join(e2e, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(e2e, 'results', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(e2e, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src-tauri', 'tauri.conf.json'), '{"identifier":"com.mobi.pos.e2e"}\n');

  const rows = opts.rows || defaultIndexRows();
  fs.writeFileSync(path.join(e2e, 'CASE_INDEX.csv'), [HEADER, ...rows.map(csvLine)].join('\n') + '\n');
  fs.writeFileSync(path.join(e2e, 'COVERAGE.md'), opts.coverage || dashboardFor(rows));
  fs.writeFileSync(path.join(e2e, 'FAIL-CLUSTERS.csv'), opts.clusters || clustersFor(rows));
  fs.writeFileSync(path.join(e2e, 'specs', '10-ref.e2e.ts'), opts.spec || DEFAULT_SPEC);
  fs.writeFileSync(path.join(e2e, 'fixtures', 'feature-map.json'), JSON.stringify(opts.featureMap || FEATURE_MAP, null, 1));
  if (opts.exemptions) fs.writeFileSync(path.join(e2e, 'fixtures', 'lint-exemptions.json'), JSON.stringify(opts.exemptions, null, 1));
  return dir;
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function run(script, argv, cwd) {
  const file = path.isAbsolute(script) ? script : path.join(HERE, script);
  const r = spawnSync(process.execPath, [file, ...argv], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const out = strip(`${r.stdout || ''}${r.stderr || ''}`);
  if (VERBOSE) console.log(`        $ ${path.basename(file)} ${argv.join(' ')} -> ${r.status}\n${out.split('\n').map((l) => '        | ' + l).join('\n')}`);
  return { code: r.status, out };
}

/* ------------------------------------------------------------------ */
/* unit tests (no fixture)                                             */
/* ------------------------------------------------------------------ */

function unitTests() {
  const { parseArgs: pa } = { parseArgs };
  eq('parseArgs: a boolean flag does not swallow the positional', pa(['--json', 'out.json']), { _: ['out.json'], json: true });
  eq('parseArgs: a value flag still takes its value', pa(['--spec', 'a.e2e.ts', '--wipe']), { _: [], spec: 'a.e2e.ts', wipe: true });
  eq('parseArgs: --key=value', pa(['--tag=r1']), { _: [], tag: 'r1' });
  eq('parseArgs: repeated value flags become an array', pa(['--allow-loss', 'REF-01', '--allow-loss', 'REF-02']), { _: [], 'allow-loss': ['REF-01', 'REF-02'] });

  eq('sumRunCounts: sums across every spec line', sumRunCounts('1 passing\n0 failing\n1 passing\n2 failing\n'), { passing: 2, failing: 2, skipped: 0 });
  eq('sumRunCounts: pending counts as skipped', sumRunCounts('3 passing\n0 failing\n4 pending\n'), { passing: 3, failing: 0, skipped: 4 });

  eq('classifyId: catalog', classifyId('[REF-03]'), 'catalog');
  eq('classifyId: 3-digit number', classifyId('I18-101'), 'catalog');
  eq('classifyId: harness family', classifyId('[HARNESS-07]'), 'HARNESS');
  eq('classifyId: probe family', classifyId('[PROBE-07a]'), 'PROBE');
  eq('classifyId: unknown shape', classifyId('REF-1'), null);
}

/* ------------------------------------------------------------------ */
/* delta                                                               */
/* ------------------------------------------------------------------ */

function deltaTests() {
  const dir = makeRepo('delta');
  const results = path.join(dir, 'e2e-tests', 'results');

  const sidecar = write(dir, 'e2e-tests/results/runs/2026-01-01-x.json', JSON.stringify({
    tag: 'x', gitSha: 'abc1234', exitCode: 1, passing: 2, failing: 1, durationMs: 10, startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'],
  }));
  let r = run('delta.mjs', ['--results', sidecar], dir);
  check('delta: a run sidecar is rejected with exit 2', r.code === 2 && /sidecar/i.test(r.out), r.out);

  const events = write(dir, 'e2e-tests/results/events.ndjson', '{"ts":"2026-01-01T00:00:00Z","kind":"fail","fullTitle":"[REF-02] x","state":"fail"}\n');
  r = run('delta.mjs', ['--results', events], dir);
  check('delta: raw WDIO events are rejected with a verdicts.mjs hint', r.code === 2 && /verdicts\.mjs/.test(r.out), r.out);

  const bad = write(dir, 'e2e-tests/results/bad.ndjson', 'REF-01 PASS\n');
  r = run('delta.mjs', ['--results', bad], dir);
  check('delta: a non-JSON, non-VERDICT line is exit 2 (never skipped)', r.code === 2 && /neither JSON nor a VERDICT/.test(r.out), r.out);

  const unknownVerdict = write(dir, 'e2e-tests/results/uv.json', '{"REF-01":"MAYBE"}');
  r = run('delta.mjs', ['--results', unknownVerdict], dir);
  check('delta: unknown verdict is exit 2', r.code === 2 && /unknown verdict/i.test(r.out), r.out);

  const empty = write(dir, 'e2e-tests/results/empty.json', '{}');
  r = run('delta.mjs', ['--results', empty], dir);
  check('delta: empty result set is exit 2', r.code === 2, r.out);

  const notIds = write(dir, 'e2e-tests/results/foo.json', '{"foo":"bar"}');
  r = run('delta.mjs', ['--results', notIds], dir);
  check('delta: an object that is not case verdicts is exit 2', r.code === 2 && /not a case id/.test(r.out), r.out);

  const regression = write(dir, 'e2e-tests/results/reg.json', '{"REF-01":"FAIL","REF-02":"FAIL","REF-03":"PASS"}');
  r = run('delta.mjs', ['--results', regression], dir);
  check('delta: PASS -> FAIL is a regression (exit 1)', r.code === 1 && /regression/i.test(r.out), r.out);

  const loss = write(dir, 'e2e-tests/results/loss.json', '{"REF-01":"PASS-PARTIAL","REF-02":"FAIL","REF-03":"PASS"}');
  r = run('delta.mjs', ['--results', loss], dir);
  check('delta: PASS -> PASS-PARTIAL is coverage loss (exit 1)', r.code === 1 && /coverage loss/i.test(r.out), r.out);
  r = run('delta.mjs', ['--results', loss, '--allow-loss', 'REF-01'], dir);
  check('delta: --allow-loss clears the named coverage loss', r.code === 0, r.out);

  const blockedLoss = write(dir, 'e2e-tests/results/blk.json', '{"REF-01":"BLOCKED","REF-02":"FAIL","REF-03":"PASS"}');
  r = run('delta.mjs', ['--results', blockedLoss], dir);
  check('delta: PASS -> BLOCKED is coverage loss (exit 1)', r.code === 1 && /coverage loss/i.test(r.out), r.out);

  const fix = write(dir, 'e2e-tests/results/fix.json', '{"REF-01":"PASS","REF-02":"PASS","REF-03":"PASS"}');
  r = run('delta.mjs', ['--results', fix], dir);
  check('delta: FAIL -> PASS is a fix, not a failure (exit 0)', r.code === 0 && /fix/i.test(r.out), r.out);

  const verdictLines = write(dir, 'e2e-tests/results/vl.txt', '# author verdicts\nVERDICT=REF-01 PASS\nVERDICT=REF-02 FAIL\nVERDICT=REF-03 PASS\n');
  r = run('delta.mjs', ['--results', verdictLines], dir);
  check('delta: VERDICT=<ID> <VERDICT> lines are accepted', r.code === 0 && /executed=3/.test(r.out), r.out);

  const scopeOk = write(dir, 'e2e-tests/results/scope-ok.json', '{"REF-01":"PASS","REF-02":"FAIL","REF-03":"PASS"}');
  r = run('delta.mjs', ['--results', scopeOk, '--scope', 'spec=10-ref.e2e.ts'], dir);
  check('delta: --scope spec= passes when every in-scope case ran', r.code === 0, r.out);

  const scopeMiss = write(dir, 'e2e-tests/results/scope-miss.json', '{"REF-01":"PASS","REF-02":"FAIL"}');
  r = run('delta.mjs', ['--results', scopeMiss, '--scope', 'spec=10-ref.e2e.ts'], dir);
  check('delta: --scope exits 1 naming the in-scope case that did not run', r.code === 1 && /REF-03/.test(r.out), r.out);

  r = run('delta.mjs', ['--results', scopeMiss, '--scope', 'ids=REF-01,REF-02'], dir);
  check('delta: --scope ids= passes when all listed ids ran', r.code === 0, r.out);

  r = run('delta.mjs', ['--results', path.join(dir, 'nope.json')], dir);
  check('delta: missing results file is exit 2', r.code === 2, r.out);
}

/* ------------------------------------------------------------------ */
/* verdicts                                                            */
/* ------------------------------------------------------------------ */

function verdictsTests() {
  const dir = makeRepo('verdicts');
  const events = write(dir, 'e2e-tests/results/events.ndjson', [
    '{"ts":"2026-01-01T00:00:01Z","kind":"pass","fullTitle":"[REF-01] refund happy path","state":"pass"}',
    '{"ts":"2026-01-01T00:00:02Z","kind":"fail","fullTitle":"[REF-02] refund refuses","state":"fail"}',
    '{"ts":"2026-01-01T00:00:03Z","kind":"pass","fullTitle":"[REF-03] replay","state":"pass"}',
    '{"ts":"2026-01-01T00:00:04Z","kind":"pass","fullTitle":"not a case title","state":"pass"}',
  ].join('\n'));
  const log = write(dir, 'e2e-tests/results/runs/x.log', 'noise\nVERDICT=REF-02 FAIL\n');

  let r = run('verdicts.mjs', ['--events', events, '--log', log], dir);
  check('verdicts: events + VERDICT lines merge into a map', r.code === 0 && /"REF-01": "PASS"/.test(r.out) && /"REF-02": "FAIL"/.test(r.out), r.out);
  check('verdicts: titles without a case id are ignored, not invented', !/not a case title/.test(r.out), r.out);

  const out = path.join(dir, 'verdicts.json');
  r = run('verdicts.mjs', ['--events', events, '--out', out], dir);
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('verdicts: --out writes the map', r.code === 0 && parsed['REF-01'] === 'PASS', JSON.stringify(parsed));

  r = run('verdicts.mjs', ['--migrate'], dir);
  const header = fs.readFileSync(path.join(dir, 'e2e-tests', 'CASE_INDEX.csv'), 'utf8').split(/\r?\n/)[0];
  check('verdicts: --migrate leaves the verdict_run/verdict_sha columns in place', r.code === 0 && /verdict_run/.test(header) && /verdict_sha/.test(header), header);

  const sidecar = write(dir, 'e2e-tests/results/runs/2026-01-01-run1.json', JSON.stringify({
    tag: 'run1', gitSha: 'deadbee', exitCode: 1, passing: 2, failing: 1, durationMs: 10, startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'],
  }));
  r = run('verdicts.mjs', ['--run', sidecar, '--write-index'], dir);
  const idx = fs.readFileSync(path.join(dir, 'e2e-tests', 'CASE_INDEX.csv'), 'utf8');
  check('verdicts: --write-index stamps verdict + run reference', r.code === 0 && /REF-02.*2026-01-01-run1\.json.*deadbee/.test(idx.replace(/\r/g, '')), r.out);
  const cov = fs.readFileSync(path.join(dir, 'e2e-tests', 'COVERAGE.md'), 'utf8');
  check('verdicts: --write-index moves the dashboard with the verdicts', /\| \*\*FAILED\*\* \| 1 \|/.test(cov), cov);

  r = run('reconcile.mjs', [], dir);
  check('verdicts: reconcile stays green after an index write', r.code === 0, r.out);
}

/* ------------------------------------------------------------------ */
/* repeat-run                                                          */
/* ------------------------------------------------------------------ */

function repeatRunTests() {
  const dir = makeRepo('repeat');
  const mk = (name, cases, exitCode) => write(dir, `e2e-tests/results/runs/${name}.json`, JSON.stringify({
    tag: name, gitSha: 'abc1234', exitCode, passing: 0, failing: 0, durationMs: 10,
    startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'], caseVerdicts: cases,
  }));

  const a = mk('r1', { 'REF-01': 'PASS', 'REF-02': 'FAIL' }, 1);
  const b = mk('r2', { 'REF-01': 'PASS', 'REF-02': 'PASS' }, 0);
  let r = run('repeat-run.mjs', ['--from-sidecars', `${a},${b}`], dir);
  check('repeat-run: differing per-case outcomes are listed as flaky', r.code === 1 && /FLAKY/.test(r.out) && /REF-02/.test(r.out), r.out);

  const c = mk('r3', { 'REF-01': 'FAIL', 'REF-02': 'FAIL' }, 1);
  const d = mk('r4', { 'REF-01': 'FAIL', 'REF-02': 'FAIL' }, 1);
  r = run('repeat-run.mjs', ['--from-sidecars', `${c},${d}`], dir);
  check('repeat-run: same failures every run is deterministic, and lists the cases', r.code === 1 && /DETERMINISTIC/.test(r.out) && /REF-01/.test(r.out), r.out);

  const e = mk('r5', { 'REF-01': 'FAIL', 'REF-02': 'FAIL' }, 1);
  const f = mk('r6', { 'REF-01': 'FAIL', 'REF-03': 'FAIL' }, 1);
  r = run('repeat-run.mjs', ['--from-sidecars', `${e},${f}`], dir);
  check('repeat-run: same exit code but different failing cases is NOT deterministic', r.code === 1 && !/DETERMINISTIC/.test(r.out) && /FLAKY/.test(r.out), r.out);

  const g = mk('r7', { 'REF-01': 'PASS' }, 0);
  const h = mk('r8', { 'REF-01': 'PASS' }, 0);
  r = run('repeat-run.mjs', ['--from-sidecars', `${g},${h}`], dir);
  check('repeat-run: identical green runs are stable', r.code === 0 && /STABLE/.test(r.out), r.out);
}

/* ------------------------------------------------------------------ */
/* reconcile                                                           */
/* ------------------------------------------------------------------ */

function reconcileTests() {
  const dir = makeRepo('reconcile');
  let r = run('reconcile.mjs', [], dir);
  check('reconcile: the fixture corpus reconciles', r.code === 0, r.out);

  const closeOk = makeRepo('reconcile-close-ok', {
    rows: [
      ['REF-01', 'REF', 'P0', '', 'refund happy path', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', 'DB rows=1', 'run1.json', 'abc1234'],
      ['REF-02', 'REF', 'P0', '', 'refund refuses', 'REF', '11', '0', 'FAIL', '10-ref.e2e.ts', 'DB rows=0; SOURCE src/services/refundService.ts:44', 'run1.json', 'abc1234'],
      ['REF-03', 'REF', 'P1', '', 'replay', 'REF', '12', '0', 'PASS-PARTIAL', '10-ref.e2e.ts', 'unasserted facet: drawer total after the replay', 'run1.json', 'abc1234'],
      ['BLK-01', 'BLK', 'P1', '', 'gateway', 'BLK', '', '0', 'BLOCKED', '', 'BLOCKED — needs a configured merchant gateway', 'run1.json', 'abc1234'],
      ['NAP-01', 'NAP', 'P2', '', 'fx tender', 'NAP', '', '0', 'N/A', '', 'N/A — absent', 'run1.json', 'abc1234'],
    ],
  });
  r = run('reconcile.mjs', ['--close'], closeOk);
  check('reconcile --close: a complete corpus passes', r.code === 0, r.out);

  // The real corpus names most dependencies as "no <thing> harness" rather than
  // "needs <thing>". Both are plain English; both must satisfy the evidence bar.
  const blkNo = makeRepo('reconcile-close-blocked-no', {
    rows: [
      ['BLK-02', 'BLK', 'P1', '', 'fault injection', 'BLK', '', '0', 'BLOCKED', '', '**BLOCKED** - no random-point process-kill/fault-injection harness; batch20-dat.log', 'run1.json', 'abc1234'],
    ],
  });
  r = run('reconcile.mjs', ['--close'], blkNo);
  check('reconcile --close: "no <thing>" names the dependency', r.code === 0, r.out);

  const remain = makeRepo('reconcile-close-remain', {
    rows: [
      ['REF-01', 'REF', 'P0', '', 'refund', 'REF', '10', '0', 'REMAIN', '10-ref.e2e.ts', 'not queued', 'run1.json', 'abc1234'],
    ],
  });
  r = run('reconcile.mjs', ['--close'], remain);
  check('reconcile --close: REMAIN must be 0', r.code === 1 && /REMAIN/.test(r.out), r.out);

  const blk = makeRepo('reconcile-close-blocked', {
    rows: [
      ['BLK-01', 'BLK', 'P1', '', 'gateway', 'BLK', '', '0', 'BLOCKED', '', 'blocked', 'run1.json', 'abc1234'],
    ],
  });
  r = run('reconcile.mjs', ['--close'], blk);
  check('reconcile --close: BLOCKED without a named dependency fails', r.code === 1 && /BLOCKED/.test(r.out), r.out);

  const failNoClass = makeRepo('reconcile-close-fail', {
    rows: [
      ['REF-02', 'REF', 'P0', '', 'refund', 'REF', '11', '0', 'FAIL', '10-ref.e2e.ts', '**FAIL**', 'run1.json', 'abc1234'],
    ],
  });
  r = run('reconcile.mjs', ['--close'], failNoClass);
  check('reconcile --close: FAIL without class + file:line fails', r.code === 1 && /FAIL/.test(r.out), r.out);

  const partial = makeRepo('reconcile-close-partial', {
    rows: [
      ['REF-03', 'REF', 'P1', '', 'replay', 'REF', '12', '0', 'PASS-PARTIAL', '10-ref.e2e.ts', 'looks fine', 'run1.json', 'abc1234'],
    ],
  });
  r = run('reconcile.mjs', ['--close'], partial);
  check('reconcile --close: PASS-PARTIAL must name the unasserted facet', r.code === 1 && /PASS-PARTIAL/.test(r.out), r.out);

  const changed = makeRepo('reconcile-close-changed', {
    rows: [
      ['REF-01', 'REF', 'P0', '', 'refund', 'REF', '10', '0', 'FAIL', '10-ref.e2e.ts', 'DB rows=0; SOURCE src/x.ts:1', '', ''],
    ],
  });
  const prev = write(changed, 'prev.csv', [
    HEADER,
    csvLine(['REF-01', 'REF', 'P0', '', 'refund', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', '**PASS**', '', '']),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(changed, 'e2e-tests', 'FAIL-CLUSTERS.csv'), 'case_id,cluster_id,cluster_key,class,evidence,money,priority,catalog\nREF-01,C01,REF-NEG,app,SQLite,money,P0,A\n');
  r = run('reconcile.mjs', ['--close', '--prev', prev], changed);
  check('reconcile --close: a verdict change with no run reference fails', r.code === 1 && /run reference/i.test(r.out), r.out);

  const badId = makeRepo('reconcile-badid', {
    rows: [['REF-1', 'REF', 'P0', '', 'refund', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', 'x', '', '']],
  });
  r = run('reconcile.mjs', [], badId);
  check('reconcile: a malformed case id is caught', r.code === 1 && /REF-1/.test(r.out), r.out);
}

/* ------------------------------------------------------------------ */
/* lint-specs                                                          */
/* ------------------------------------------------------------------ */

function lintTests() {
  const dir = makeRepo('lint');
  let r = run('lint-specs.mjs', [], dir);
  check('lint: a clean fixture passes', r.code === 0, r.out);

  const orphan = makeRepo('lint-orphan', {
    spec: DEFAULT_SPEC.replace("it('[REF-03]", "it('[ZZZ-99]").replace("'[ZZZ-99] refund replay writes once'", "'[ZZZ-99] refund replay writes once'"),
  });
  r = run('lint-specs.mjs', [], orphan);
  check('lint: an it() id that is not in CASE_INDEX fails', r.code === 1 && /ZZZ-99/.test(r.out), r.out);

  const noId = makeRepo('lint-noid', {
    spec: DEFAULT_SPEC.replace("it('[REF-01] refund happy path on a cash sale'", "it('refund happy path on a cash sale'"),
  });
  r = run('lint-specs.mjs', [], noId);
  check('lint: an it() title with no id fails', r.code === 1 && /no case id/i.test(r.out), r.out);

  const noSpec = makeRepo('lint-nospec', {
    rows: [
      ['REF-01', 'REF', 'P0', '', 'refund happy path', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', 'x', '', ''],
      ['REF-02', 'REF', 'P0', '', 'refund negative', 'REF', '11', '0', 'FAIL', '', 'DB rows=0', '', ''],
    ],
  });
  r = run('lint-specs.mjs', [], noSpec);
  check('lint: an active FAIL with no spec fails', r.code === 1 && /REF-02/.test(r.out), r.out);

  const exempt = makeRepo('lint-exempt', {
    rows: [
      ['REF-01', 'REF', 'P0', '', 'refund happy path', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', 'x', '', ''],
      ['REF-02', 'REF', 'P0', '', 'refund negative', 'REF', '11', '0', 'FAIL', '', 'DB rows=0', '', ''],
      ['REF-03', 'REF', 'P1', '', 'refund replay writes once', 'REF', '12', '0', 'PASS', '10-ref.e2e.ts', 'x', '', ''],
    ],
    exemptions: {
      cases: [{ id: 'REF-02', reason: 'recorded from a manual batch; no spec anchors the id yet' }],
      files: [],
    },
  });
  r = run('lint-specs.mjs', [], exempt);
  check('lint: a baselined exemption is honoured and printed as debt', r.code === 0 && /REF-02/.test(r.out) && /debt/i.test(r.out), r.out);
  r = run('lint-specs.mjs', ['--strict'], exempt);
  check('lint --strict: exemptions do not hide debt', r.code === 1 && /REF-02/.test(r.out), r.out);

  const harness = makeRepo('lint-harness', {
    spec: DEFAULT_SPEC + "\ndescribe('smoke', () => {\n  it('[HARNESS-01] boot gate reachable', async () => {});\n});\n",
  });
  r = run('lint-specs.mjs', [], harness);
  check('lint: declared non-catalog id families pass', r.code === 0, r.out);
}

/* ------------------------------------------------------------------ */
/* collect-evidence                                                    */
/* ------------------------------------------------------------------ */

function evidenceTests() {
  const dir = makeRepo('evidence');
  write(dir, 'e2e-tests/results/runs/2026-01-01-x.json', JSON.stringify({
    tag: 'x', gitSha: 'abc1234', exitCode: 1, passing: 0, failing: 0, durationMs: 1000,
    startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'], log: 'e2e-tests/test-logs/x.log',
  }));
  write(dir, 'e2e-tests/results/events.ndjson', '');
  let r = run('collect-evidence.mjs', ['--run', path.join(dir, 'e2e-tests/results/runs/2026-01-01-x.json')], dir);
  const report = fs.readdirSync(path.join(dir, 'e2e-tests/results/evidence'))
    .map((d) => path.join(dir, 'e2e-tests/results/evidence', d, 'report.md'))
    .filter((f) => fs.existsSync(f)).pop();
  const md = report ? fs.readFileSync(report, 'utf8') : '';
  check('collect-evidence: exit != 0 with 0 tests ran prints NO TESTS EXECUTED', r.code === 0 && /NO TESTS EXECUTED/.test(r.out) && /NO TESTS EXECUTED/.test(md), r.out);

  const dir2 = makeRepo('evidence-fail');
  write(dir2, 'e2e-tests/results/runs/2026-01-01-y.json', JSON.stringify({
    tag: 'y', gitSha: 'abc1234', exitCode: 1, passing: 0, failing: 1, durationMs: 1000,
    startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'], log: 'e2e-tests/test-logs/y.log',
  }));
  const filler = Array.from({ length: 45 }, (_, i) => `log line ${i + 1}`).join('\n');
  write(dir2, 'e2e-tests/test-logs/y.log', `${filler}\nError in "[REF-02] refund refuses a negative quantity"\nassertion failed here\n`);
  write(dir2, 'e2e-tests/results/events.ndjson', JSON.stringify({
    ts: '2026-01-01T00:00:00.500Z', kind: 'fail', file: 'e2e-tests/specs/10-ref.e2e.ts',
    fullTitle: '[REF-02] refund refuses a negative quantity', state: 'fail', durationMs: 5,
    error: ['expect(received).toBe(expected)'], retries: { attempts: 0, limit: 0 },
  }) + '\n');
  r = run('collect-evidence.mjs', ['--run', path.join(dir2, 'e2e-tests/results/runs/2026-01-01-y.json')], dir2);
  const report2 = fs.readdirSync(path.join(dir2, 'e2e-tests/results/evidence'))
    .map((d) => path.join(dir2, 'e2e-tests/results/evidence', d, 'report.md'))
    .filter((f) => fs.existsSync(f)).pop();
  const md2 = report2 ? fs.readFileSync(report2, 'utf8') : '';
  check('collect-evidence: includes the last 40 log lines before a failure', r.code === 0 && /log line 45/.test(md2) && /assertion failed here/.test(md2) && /log line 6/.test(md2), md2.slice(-1200));
}

/* ------------------------------------------------------------------ */
/* scan-pii                                                            */
/* ------------------------------------------------------------------ */

function piiTests() {
  const dir = makeRepo('pii');
  write(dir, 'e2e-tests/results/evidence/a/report.md', 'clean report: REF-03 passed, 12 rows, no identifiers\n');
  let r = run('scan-pii.mjs', [], dir);
  check('scan-pii: a clean evidence tree passes', r.code === 0, r.out);

  const phone = ['0550', '123', '456'].join('');
  write(dir, 'e2e-tests/results/evidence/b/report.md', `customer phone ${phone}\n`);
  r = run('scan-pii.mjs', [], dir);
  check('scan-pii: a phone number is caught', r.code === 1 && /phone/i.test(r.out), r.out);
  check('scan-pii: the matched value is redacted, never printed', !r.out.includes(phone), r.out);

  fs.rmSync(path.join(dir, 'e2e-tests/results/evidence/b'), { recursive: true, force: true });
  write(dir, 'e2e-tests/fixtures/leak.json', JSON.stringify({ pin_hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash' }));
  r = run('scan-pii.mjs', [], dir);
  check('scan-pii: a PIN hash is caught', r.code === 1 && /pin hash/i.test(r.out), r.out);

  fs.rmSync(path.join(dir, 'e2e-tests/fixtures/leak.json'), { force: true });
  write(dir, 'e2e-tests/fixtures/ids.json', JSON.stringify({ device_id: 'a3f1c2d4-1111-4222-8333-944455556666', peer: '192.168.1.44' }));
  r = run('scan-pii.mjs', [], dir);
  check('scan-pii: device_id and a LAN IP are caught', r.code === 1 && /device/i.test(r.out) && /ip/i.test(r.out), r.out);
}

/* ------------------------------------------------------------------ */
/* risk-map                                                            */
/* ------------------------------------------------------------------ */

function riskMapTests() {
  const dir = makeRepo('risk');
  let r = run('risk-map.mjs', ['--files', 'src/services/refundService.ts'], dir);
  check('risk-map: a mapped file resolves to its domain and spec', r.code === 0 && /REF/.test(r.out) && /10-ref\.e2e\.ts/.test(r.out), r.out);

  r = run('risk-map.mjs', ['--files', 'src/services/refundService.ts,src/brand-new/thing.ts'], dir);
  check('risk-map: an unmapped file is reported and blocks (exit 1)', r.code === 1 && /UNMAPPED/.test(r.out) && /thing\.ts/.test(r.out), r.out);

  r = run('risk-map.mjs', ['--files', 'src/brand-new/thing.ts', '--allow-unmapped'], dir);
  check('risk-map: --allow-unmapped downgrades it', r.code === 0 && /UNMAPPED/.test(r.out), r.out);

  r = run('risk-map.mjs', ['--files', 'docs/notes.md'], dir);
  check('risk-map: non-app files are ignored, not unmapped', r.code === 0 && !/UNMAPPED/.test(r.out), r.out);
}

/* ------------------------------------------------------------------ */
/* prove-fix                                                           */
/* ------------------------------------------------------------------ */

function proveFixTests() {
  const dir = makeRepo('provefix');
  const git = (argv) => spawnSync('git', argv, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'selftest@example.invalid']);
  git(['config', 'user.name', 'selftest']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);

  let r = run('prove-fix.mjs', ['--dry-run', '--spec', 'e2e-tests/specs/10-ref.e2e.ts', '--case', 'REF-02'], dir);
  check('prove-fix: refuses when no app path changed (nothing to prove)', r.code === 2 && /nothing to prove/i.test(r.out), r.out);

  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const x = 2;\n');
  r = run('prove-fix.mjs', ['--dry-run', '--spec', 'e2e-tests/specs/10-ref.e2e.ts', '--case', 'REF-02'], dir);
  check('prove-fix: dry run prints a path-limited stash plan', r.code === 0 && /git stash push/.test(r.out) && /src/.test(r.out), r.out);
  check('prove-fix: the plan never uses -u or clean', !/stash push[^\n]*-u/.test(r.out) && !/git clean/.test(r.out), r.out);
}

/* ------------------------------------------------------------------ */
/* preflight helpers                                                   */
/* ------------------------------------------------------------------ */

async function preflightTests() {
  const dir = makeRepo('preflight');
  const cargo = write(dir, 'src-tauri/Cargo.lock', 'version = 3\n');
  // Backdate every other app source so Cargo.lock alone decides "newest".
  const t0 = new Date('2020-01-01T00:00:00Z');
  for (const rel of ['src-tauri/tauri.conf.json']) fs.utimesSync(path.join(dir, rel), t0, t0);
  fs.utimesSync(cargo, t0, t0);
  const { sourceNewest } = await import('./_lib.mjs');
  const before = sourceNewest(dir);
  const t1 = new Date('2021-01-01T00:00:00Z');
  fs.utimesSync(cargo, t1, t1);
  const after = sourceNewest(dir);
  check('preflight: Cargo.lock counts as app source for freshness', after > before && after >= t1.getTime() - 1000, `${before} -> ${after}`);
}

/* ------------------------------------------------------------------ */
/* harness source guards                                               */
/* ------------------------------------------------------------------ */

/**
 * These guard the REAL e2e harness (not a fixture): a silent "unlocked"
 * return is the difference between a test that proves a flow and one that
 * skips it. Regression: 2026-10-28, MNY-25 — unlockIfNeeded() waited on
 * `header`, which renders BEHIND the lock overlay, so it returned while the
 * PIN pad was still up and the Kredy tab was read while still locked.
 */
function harnessTests() {
  const posPath = path.resolve(HERE, '..', '..', '..', '..', 'e2e-tests', 'lib', 'pos.ts');
  if (!check('harness: e2e-tests/lib/pos.ts is present', fs.existsSync(posPath), posPath)) return;
  const src = fs.readFileSync(posPath, 'utf8').replace(/\r\n/g, '\n'); // CRLF-tolerant: git may check the file out with CRLF
  const at = src.indexOf('export async function unlockIfNeeded');
  if (!check('harness: unlockIfNeeded exists', at >= 0, 'function not found')) return;
  const rest = src.slice(at);
  const body = rest.slice(0, rest.indexOf('\n}\n') + 3);
  check(
    'harness: unlockIfNeeded proves unlock by the lock screen disappearing',
    /waitUntil\([\s\S]{0,400}lock-screen[\s\S]{0,200}isDisplayed/.test(body),
    'no lock-screen waitUntil inside unlockIfNeeded',
  );
  check(
    'harness: unlockIfNeeded never uses the header as proof of unlock',
    !/header'\)\)\.waitForDisplayed/.test(body),
    "header wait present — the shell renders behind the lock overlay",
  );

  /**
   * Invariant readers. Regression: 2026-10-29, MNY-26 — the desktop lane
   * stores wallet/avoir/reprise value as TENDER LEGS, not as
   * `voucherCreditApplied` stamps, so G-01/G-03 reported 1300 != 600 on a
   * perfectly conserved ticket (8 phantom violations). A reader that forgets
   * the legs turns every covered sale into noise, which is how a real
   * violation gets ignored.
   */
  const invPath = path.resolve(HERE, '..', '..', '..', '..', 'e2e-tests', 'lib', 'invariants.ts');
  if (check('harness: e2e-tests/lib/invariants.ts is present', fs.existsSync(invPath), invPath)) {
    const inv = fs.readFileSync(invPath, 'utf8');
    check(
      'harness: G-01 conservation excludes credit tender legs',
      /close\(\s*s\s*-\s*creditLegs\s*-\s*chg/.test(inv),
      'G-01 no longer subtracts creditLegs from the tender sum',
    );
    check(
      'harness: G-03 counts tender-leg credits (explicit stamps OR legs, never the sum)',
      /Math\.max\(\s*explicitCovered\s*,\s*creditLegsOf\(j\)\s*\)/.test(inv),
      'G-03 no longer reads creditLegsOf',
    );
    const legLine = (inv.match(/const CREDIT_TENDER_METHODS = \[([^\]]*)\]/) || [])[1] || '';
    check(
      'harness: credit legs are Avoir Client + Reprise only (debt stays revenue)',
      /'Avoir Client'/.test(legLine) && /'Reprise'/.test(legLine) && !/dit Client/.test(legLine),
      `credit method list: [${legLine}]`,
    );
    check(
      'harness: G-29 caps cumulative refunds at the value the customer gave',
      /const given = num\(r\.total\) \+ creditLegsOf\(parseJson\(r\.json_payload\)\)/.test(inv),
      'G-29 no longer adds the sale credit legs to the cap',
    );
  }
}

/**
 * Product-contract guards: each fix that changed OBSERVABLE money behaviour
 * gets a source-shape check here, so a later refactor cannot silently undo it.
 *
 * Every guard is MUTATION-CHECKED: the same predicate must stop matching once
 * the guarded token is replaced. A guard that passes on both the real and the
 * mutated source is a comment, not a test — that is exactly how the "discount
 * PIN field never appeared" helper survived: nothing asserted the refusal path.
 */
function contractTests() {
  const REPO = path.resolve(HERE, '..', '..', '..', '..');
  const read = (rel) => {
    const p = path.resolve(REPO, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  /** @param {string} name @param {string} src @param {RegExp} re
   *  @param {string} from @param {string} to */
  const guard = (name, src, re, from, to) => {
    if (!check(`${name}: file present`, src.length > 0, 'source file missing or empty')) return;
    const matches = re.test(src);
    const mutated = src.replace(from, to);
    const flipped = mutated !== src && !re.test(mutated);
    check(name, matches && flipped, `match=${matches} mutationFlips=${flipped} (mutation: ${from.slice(0, 40)})`);
  };

  /* ── [MNY-29] fat-finger tender guard ─────────────────────────────────── */
  const tender = read('src/utils/tenderGuard.ts');
  guard('contract: fat-finger ratio is 10× (owner-set)', tender, /FAT_FINGER_RATIO = 10;/, 'FAT_FINGER_RATIO = 10;', 'FAT_FINGER_RATIO = 100;');
  guard('contract: fat-finger floor is 5 000 DA (owner-set)', tender, /FAT_FINGER_FLOOR_DA = 5_000;/, 'FAT_FINGER_FLOOR_DA = 5_000;', 'FAT_FINGER_FLOOR_DA = 50_000;');
  guard(
    'contract: the floor is on the TENDERED amount, never on the ticket total',
    tender,
    /if \(tendered < FAT_FINGER_FLOOR_DA\) return false;/,
    'tendered < FAT_FINGER_FLOOR_DA',
    'total < FAT_FINGER_FLOOR_DA',
  );
  guard(
    'contract: the ratio is strict (10× exactly does not nag)',
    tender,
    /return tendered > total \* FAT_FINGER_RATIO;/,
    'return tendered > total * FAT_FINGER_RATIO;',
    'return tendered >= total * FAT_FINGER_RATIO;',
  );
  guard(
    'contract: zero/refund tickets are excluded from the guard',
    tender,
    /if \(tendered <= 0 \|\| total <= 0\) return false;/,
    'if (tendered <= 0 || total <= 0) return false;',
    'if (tendered < 0) return false;',
  );

  const pay = read('src/components/modals/PaymentModal.tsx');
  guard(
    'contract: the guard runs before any write and skips the refund-due path',
    pay,
    /submitRefundDue === 0 && isFatFingerTender\(submitCash, submitNet\)/,
    'submitRefundDue === 0 && ',
    '',
  );
  guard(
    'contract: Enter while the confirmation is up DISMISSES, it never commits',
    pay,
    /if \(fatFinger\) \{\s*setFatFinger\(null\);\s*return;\s*\}\s*handleProcessPayment\(\);/,
    'if (fatFinger) {',
    'if (false) {',
  );

  /* ── [MNY-25] ledger is the authority, the column is its cache ────────── */
  const cust = read('src/db/adapters/customerAdapter.ts');
  guard(
    'contract: getAllCustomers prefers the ledger over the stored column',
    cust,
    /const fromLedger = ledgerDebt\.get\(id\);/,
    'ledgerDebt.get(id)',
    'undefined',
  );
  guard(
    'contract: saveCustomer maintains current_debt (NULL keeps the stored value)',
    cust,
    /current_debt=COALESCE\(excluded\.current_debt, customers\.current_debt\)/,
    'current_debt=COALESCE(excluded.current_debt, customers.current_debt)',
    'name=excluded.name',
  );
  guard(
    'contract: the back-fill only rewrites rows that HAVE ledger history',
    cust,
    /WHERE EXISTS \(\s*SELECT 1 FROM customer_debts d\s*WHERE d\.customer_id = customers\.id AND d\.deleted = 0/,
    'WHERE EXISTS (',
    'WHERE 1 OR EXISTS (',
  );

  const sqlite = read('src/db/sqlPluginAdapter.ts');
  guard(
    'contract: the reconcile lane writes the projection to the column too',
    sqlite,
    /UPDATE customers SET current_debt = \?1 WHERE id = \?2/,
    'UPDATE customers SET current_debt = ?1',
    'UPDATE customers SET total_spent = ?1',
  );

  const ui = read('src/store/slices/createUISlice.ts');
  {
    const heal = ui.indexOf('await healCustomerDebtCacheOnce();');
    const firstRead = ui.indexOf('sqlite.getAllCustomers()');
    check(
      'contract: the debt-cache heal runs BEFORE the first customer read',
      heal > 0 && firstRead > 0 && heal < firstRead,
      `heal@${heal} firstRead@${firstRead}`,
    );
    const healed = ui.replace('await healCustomerDebtCacheOnce();', '');
    const healedHeal = healed.indexOf('await healCustomerDebtCacheOnce();');
    const healedOrder = healedHeal >= 0 && healedHeal < healed.indexOf('sqlite.getAllCustomers()');
    check(
      'contract: (mutation) removing the boot heal fails the ordering guard',
      healed !== ui && healedOrder === false,
      `heal still ordered before the read after removal: ${healedOrder}`,
    );
  }

  /* ── [CRT-04] a rejected percent never waits on the PIN gate ──────────── */
  const pos = read('e2e-tests/lib/pos.ts');
  guard(
    'contract: applyCartDiscountPercent has a refusal path (no blind PIN wait)',
    pos,
    /if \(opts\.expectRefused\) \{[\s\S]{0,400}discount-percent-error/,
    'discount-percent-error',
    'discount-pin-missing',
  );

  /* ── [G-05] serialized fixtures carry one IMEI row per unit ───────────── */
  const seed = read('e2e-tests/lib/seed.ts');
  guard(
    'contract: seedProducts derives one IMEI row per serialized unit',
    seed,
    /for \(let unit = 0; unit < p\.stock; unit \+= 1\)/,
    'for (let unit = 0; unit < p.stock; unit += 1)',
    'for (let unit = 0; unit < 1; unit += 1)',
  );
  guard(
    'contract: an IMEI-less serialized product is left alone (the G-05 negative control)',
    seed,
    /if \(p\.isSerialized && p\.stock > 0 && p\.imeiNumber\) \{/,
    'p.isSerialized && p.stock > 0 && p.imeiNumber',
    'p.isSerialized && p.stock > 0',
  );
}

/* ------------------------------------------------------------------ */
/* verdict protocol (the shapes the specs really emit)                  */
/* ------------------------------------------------------------------ */

/**
 * Guards the three regressions of 2026-10-30, each of which silently turned a
 * spec-recorded verdict into a mocha PASS:
 *   - WDIO prefixes every log line with "[0-0] " and specs append "| note"
 *   - some specs write "[ID] VERDICT=V ..." (id first) or "[ID] BLOCKED - ..."
 *   - `--run <sidecar>` must read the log the sidecar itself names
 *   - N/A has a slash, which the verdict token class must accept
 */
function verdictProtocolTests() {  const dir = makeRepo('verdicts-protocol');
  const events = write(dir, 'e2e-tests/results/events.ndjson', [
    '{"ts":"2026-01-01T00:00:01Z","kind":"pass","fullTitle":"[REF-02] refund refuses","state":"pass"}',
    '{"ts":"2026-01-01T00:00:02Z","kind":"pass","fullTitle":"[NAP-01] foreign currency","state":"pass"}',
    '{"ts":"2026-01-01T00:00:03Z","kind":"pass","fullTitle":"[REF-03] refund replay","state":"pass"}',
  ].join('\n'));

  // Control: the events alone say PASS for the case the spec really failed.
  let r = run('verdicts.mjs', ['--events', events], dir);
  check('verdicts: events alone report the mocha outcome (control)', r.code === 0 && /"REF-02": "PASS"/.test(r.out), r.out);

  write(dir, 'e2e-tests/results/runs/x.log', [
    '[0-0] VERDICT=REF-02 FAIL | collected 900 != committed 579',
    '[0-0] [REF-03] VERDICT=PASS-PARTIAL partial facet named',
    '[0-0] [BLK-01] BLOCKED - needs a configured merchant gateway',
    '[0-0] VERDICT=NAP-01 N/A | no foreign-currency tender exists',
  ].join('\n'));

  const sidecar = write(dir, 'e2e-tests/results/runs/2026-01-01-run2.json', JSON.stringify({
    tag: 'run2', gitSha: 'deadbef', exitCode: 0, passing: 3, failing: 0, durationMs: 10000,
    startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'],
    log: 'e2e-tests/results/runs/x.log',
  }));

  // --run with NO --log: the sidecar names the log, so the verdict lines must win.
  r = run('verdicts.mjs', ['--run', sidecar], dir);
  check('verdicts: --run reads the log the sidecar names (no --log flag)', r.code === 0 && /"REF-02": "FAIL"/.test(r.out), r.out);
  check('verdicts: the "[0-0] " prefix and "| note" suffix are parsed', /"REF-02": "FAIL"/.test(r.out), r.out);
  check('verdicts: "[ID] VERDICT=PASS-PARTIAL ..." (id first) is parsed', /"REF-03": "PASS-PARTIAL"/.test(r.out), r.out);
  check('verdicts: "[ID] BLOCKED - reason" is parsed', /"BLK-01": "BLOCKED"/.test(r.out), r.out);
  check('verdicts: N/A survives the verdict-token parser', /"NAP-01": "N\/A"/.test(r.out), r.out);
  check('verdicts: a N/A verdict line is not overwritten by the mocha PASS', /"NAP-01": "N\/A"/.test(r.out), r.out);

  // An unknown verdict word after a matched id is an error, never a silent drop.
  const bad = write(dir, 'e2e-tests/results/bad.txt', 'VERDICT=REF-01 MAYBE\n');
  r = run('verdicts.mjs', ['--events', events, '--log', bad], dir);
  check('verdicts: an unknown verdict word is exit 2', r.code === 2, r.out);

  // A PARTIAL run (one case, e.g. run.mjs --grep) must never move a verdict it
  // did not observe: only the cases in the run window may be stamped.
  {
    const dir2 = makeRepo('partial-run');
    const before = readIndex(dir2);
    const untouched = ['REF-02', 'REF-03'].map((id) => before.get(before.byId.get(id), 'verdict'));
    const ev = write(dir2, 'e2e-tests/results/events.ndjson',
      '{"ts":"2026-01-01T00:00:01Z","kind":"pass","fullTitle":"[REF-01] only this one ran","state":"pass"}\n');
    const sc = write(dir2, 'e2e-tests/results/runs/2026-01-01-partial.json', JSON.stringify({
      tag: 'partial', gitSha: 'deadbee', exitCode: 0, passing: 1, failing: 0, durationMs: 10,
      startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'],
    }));
    r = run('verdicts.mjs', ['--run', sc, '--events', ev, '--write-index'], dir2);
    const after = readIndex(dir2);
    const still = ['REF-02', 'REF-03'].map((id) => after.get(after.byId.get(id), 'verdict'));
    check('partial run: the observed case is stamped', after.get(after.byId.get('REF-01'), 'verdict') === 'PASS', r.out);
    check('partial run: unrun cases keep their verdicts', JSON.stringify(still) === JSON.stringify(untouched), `before=${before} after=${still}`);
    check('partial run: unrun cases keep their run reference', !after.get(after.byId.get('REF-02'), 'verdict_run'), r.out);
  }
}

/* ------------------------------------------------------------------ */
/* derived rows (D5): derived:<ANCHOR> follows the anchor, never launders   */
/* an unproven anchor into a green                                         */
/* ------------------------------------------------------------------ */

function derivedTests() {
  const rows = [
    ['REF-01', 'REF', 'P0', '', 'anchor case', 'REF', '10', '0', 'FAIL', '10-ref.e2e.ts', '**FAIL**', '', ''],
    ['CRT-01', 'CRT', 'P1', '', 'derived facet', 'CRT', '', '0', 'FAIL', 'derived:REF-01', '**FAIL** — derived', '', ''],
  ];
  const dir = makeRepo('derived', { rows });
  const events = write(dir, 'e2e-tests/results/events.ndjson',
    '{"ts":"2026-01-01T00:00:01Z","kind":"pass","fullTitle":"[REF-01] anchor case","state":"pass"}\n');
  const sidecar = write(dir, 'e2e-tests/results/runs/2026-01-01-run.json', JSON.stringify({
    tag: 'run', gitSha: 'deadbee', exitCode: 0, passing: 1, failing: 0, durationMs: 10,
    startedAt: '2026-01-01T00:00:00.000Z', specs: ['10-ref.e2e.ts'],
  }));

  let r = run('verdicts.mjs', ['--run', sidecar, '--write-index'], dir);
  let idx = readIndex(dir);
  check('derived: the anchor is stamped PASS', idx.byId.get('REF-01') && idx.get(idx.byId.get('REF-01'), 'verdict') === 'PASS', r.out);
  check('derived: the derived row follows a PASS anchor', idx.get(idx.byId.get('CRT-01'), 'verdict') === 'PASS', r.out);
  check('derived: the derived row carries the anchor run reference', idx.get(idx.byId.get('CRT-01'), 'verdict_run') === '2026-01-01-run.json', r.out);

  // Anchor marked UNPROVEN: the derived row must not stay green.
  const anchorRow = idx.byId.get('REF-01');
  anchorRow[idx.ix.evidence] = '**PASS (INTERMITTENT)** — 5/6 runs, not explained';
  writeIndex(idx);
  r = run('verdicts.mjs', ['--run', sidecar, '--write-index'], dir);
  idx = readIndex(dir);
  check('derived: an UNPROVEN anchor forces the derived row to FAIL', idx.get(idx.byId.get('CRT-01'), 'verdict') === 'FAIL', r.out);

  // Anchor FAIL: derived FAIL. A second run reports the anchor as failing.
  const eventsFail = write(dir, 'e2e-tests/results/events2.ndjson',
    '{"ts":"2026-01-01T00:00:09Z","kind":"fail","fullTitle":"[REF-01] anchor case","state":"fail"}\n');
  const sidecarFail = write(dir, 'e2e-tests/results/runs/2026-01-01-run2.json', JSON.stringify({
    tag: 'run2', gitSha: 'deadbee', exitCode: 1, passing: 0, failing: 1, durationMs: 10,
    startedAt: '2026-01-01T00:00:08.000Z', specs: ['10-ref.e2e.ts'],
  }));
  r = run('verdicts.mjs', ['--run', sidecarFail, '--events', eventsFail, '--write-index'], dir);
  idx = readIndex(dir);
  check('derived: a FAIL anchor keeps the derived row FAIL', idx.get(idx.byId.get('CRT-01'), 'verdict') === 'FAIL', r.out);

  const bad = write(dir, 'e2e-tests/CASE_INDEX.csv',
    fs.readFileSync(path.join(dir, 'e2e-tests', 'CASE_INDEX.csv'), 'utf8').replace('derived:REF-01', 'derived:REF-99'));
  r = run('verdicts.mjs', ['--run', sidecar, '--write-index'], dir);
  check('derived: an unknown anchor is exit 2', r.code === 2 && /REF-99/.test(r.out), r.out);
  void bad;
}

/* ------------------------------------------------------------------ */
/* dashboard buckets: PASS, PASS-PARTIAL and FLAKY are different things      */
/* ------------------------------------------------------------------ */

function dashboardCountTests() {
  const rows = [
    ['REF-01', 'REF', 'P0', '', 'full pass', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', '**PASS**', '', ''],
    ['REF-02', 'REF', 'P0', '', 'partial pass', 'REF', '11', '0', 'PASS-PARTIAL', '10-ref.e2e.ts', '**PASS-PARTIAL**', '', ''],
    ['REF-03', 'REF', 'P1', '', 'flaky pass', 'REF', '12', '0', 'PASS', '10-ref.e2e.ts', '**PASS (FLAKY)** - order dependent', '', ''],
    ['REF-04', 'REF', 'P0', '', 'red', 'REF', '13', '0', 'FAIL', '10-ref.e2e.ts', '**FAIL**', '', ''],
  ];
  const dir = makeRepo('dashcounts', { rows });
  const c = indexCounts(readIndex(dir));
  check('dashboard: PASS-NONFLAKY counts FULL passes only', c['PASS-NONFLAKY'] === 1, JSON.stringify(c));
  check('dashboard: a PASS-PARTIAL is not a full pass', c['PASS-NONFLAKY'] < c.PASS, JSON.stringify(c));
  check('dashboard: FLAKY is counted on its own', c.FLAKY === 1, JSON.stringify(c));
  const dash = readDashboard(path.join(dir, 'e2e-tests', 'COVERAGE.md'));
  check('dashboard: fixture carries the three buckets', dash['PASS-NONFLAKY'] === 1 && dash['PASS-PARTIAL'] === 1 && dash.FLAKY === 1, JSON.stringify(dash));
}

/* ------------------------------------------------------------------ */
/* cluster.mjs: the only writer of FAIL-CLUSTERS.csv                       */
/* ------------------------------------------------------------------ */

function clusterTests() {
  const rows = [
    ['REF-01', 'REF', 'P0', '', 'green case', 'REF', '10', '0', 'PASS', '10-ref.e2e.ts', '**PASS**', '', ''],
    ['REF-02', 'REF', 'P0', '', 'red case', 'REF', '11', '0', 'FAIL', '10-ref.e2e.ts', '**FAIL**', '', ''],
    ['REF-03', 'REF', 'P1', '', 'flaky case', 'REF', '12', '0', 'PASS', '10-ref.e2e.ts', '**PASS (FLAKY)** — order-dependent', '', ''],
  ];
  const dir = makeRepo('cluster', { rows, clusters: 'case_id,cluster_id,cluster_key,class,evidence,money,priority,catalog\n' });
  const ledger = () => fs.readFileSync(path.join(dir, 'e2e-tests', 'FAIL-CLUSTERS.csv'), 'utf8');

  let r = run('cluster.mjs', ['--case', 'REF-02', '--key', 'SOME-CAUSE', '--id', 'C05'], dir);
  check('cluster: a FAIL case gets a row', r.code === 0 && /REF-02,C05,SOME-CAUSE/.test(ledger()), r.out);

  const once = ledger();
  r = run('cluster.mjs', ['--case', 'REF-02', '--key', 'SOME-CAUSE', '--id', 'C05'], dir);
  check('cluster: re-running the same assignment is byte-identical', r.code === 0 && ledger() === once, r.out);

  r = run('cluster.mjs', ['--case', 'REF-02', '--key', 'OTHER-CAUSE', '--id', 'C06'], dir);
  const occurrences = ledger().split(/\r?\n/).filter((l) => l.startsWith('REF-02,')).length;
  check('cluster: re-assigning replaces the row (one cluster per case)', r.code === 0 && occurrences === 1 && /C06/.test(ledger()), ledger());

  r = run('cluster.mjs', ['--case', 'REF-01', '--key', 'NOPE'], dir);
  check('cluster: a green PASS case is refused (exit 2)', r.code === 2, r.out);
  check('cluster: the refusal writes nothing', !ledger().includes('REF-01'), ledger());

  r = run('cluster.mjs', ['--case', 'REF-03', '--key', 'FLAKY-CAUSE', '--id', 'C07'], dir);
  check('cluster: a FLAKY pass may keep a cluster row (blocked-by expression)', r.code === 0 && /REF-03,C07,FLAKY-CAUSE/.test(ledger()), r.out);

  const before = ledger();
  r = run('cluster.mjs', ['--case', 'REF-02', '--key', 'DRY', '--dry-run'], dir);
  check('cluster: --dry-run writes nothing', r.code === 0 && ledger() === before, r.out);

  r = run('cluster.mjs', ['--case', 'REF-99', '--key', 'X'], dir);
  check('cluster: an unknown case is exit 2', r.code === 2, r.out);
}

/* ------------------------------------------------------------------ */

const ALL = [
  ['unit', unitTests],
  ['delta', deltaTests],
  ['verdicts', verdictsTests],
  ['derived', derivedTests],
  ['cluster', clusterTests],
  ['dashboard', dashboardCountTests],
  ['verdict-protocol', verdictProtocolTests],
  ['repeat-run', repeatRunTests],
  ['reconcile', reconcileTests],
  ['lint-specs', lintTests],
  ['collect-evidence', evidenceTests],
  ['scan-pii', piiTests],
  ['risk-map', riskMapTests],
  ['prove-fix', proveFixTests],
  ['preflight', preflightTests],
  ['harness', harnessTests],
  ['contract', contractTests],
];

fs.mkdirSync(ROOT, { recursive: true });
for (const [name, fn] of ALL) {
  if (FILTER && !name.includes(FILTER)) continue;
  console.log(`\n== ${name} ==`);
  try {
    await fn();
  } catch (err) {
    check(`${name}: threw`, false, String(err && err.stack ? err.stack : err));
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`);
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
if (!KEEP) {
  for (const [name] of ALL) {
    if (FILTER && !name.includes(FILTER)) continue;
    fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  }
  for (const extra of ['reconcile-close-ok', 'reconcile-close-remain', 'reconcile-close-blocked', 'reconcile-close-fail', 'reconcile-close-partial', 'reconcile-close-changed', 'reconcile-badid', 'lint-orphan', 'lint-noid', 'lint-nospec', 'lint-exempt', 'lint-harness', 'evidence-fail']) {
    fs.rmSync(path.join(ROOT, extra), { recursive: true, force: true });
  }
}
console.log('SELFTEST OK');
