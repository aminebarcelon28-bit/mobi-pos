#!/usr/bin/env node
/**
 * risk-map.mjs - which specs must run for the code that just changed?
 *
 * Inputs:
 *   e2e-tests/fixtures/feature-map.json   feature -> file:line evidence
 *   e2e-tests/CASE_INDEX.csv              case -> domain / title / spec
 *   git                                   changed app files (or --files)
 *
 * A changed app file resolves to features (exact file match on the map's
 * evidence), then to cases: a case belongs to a feature when its title carries
 * one of the feature's significant words, or its domain prefix is the feature
 * word's first three letters. Cases give the domains and the specs.
 *
 * A changed app file that maps to nothing is printed as UNMAPPED and exits 1:
 * a new domain prefix has to exist in the feature map and the case index before
 * testing continues, otherwise "the suite is green" means nothing about it.
 *
 * Usage:
 *   node .../risk-map.mjs                        # git status + git diff HEAD
 *   node .../risk-map.mjs --files a.ts,b.ts      # explicit
 *   node .../risk-map.mjs --allow-unmapped       # report, do not block
 *   node .../risk-map.mjs --json
 *
 * Exit: 0 every changed app file is mapped, 1 unmapped app file, 2 bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot, parseArgs, readIndex, activeRows, APP_PATHS, C, bad, warn } from './_lib.mjs';

const args = parseArgs();
const root = repoRoot();
const E2E = path.join(root, 'e2e-tests');
const mapFile = path.join(E2E, 'fixtures', 'feature-map.json');

if (!fs.existsSync(mapFile)) {
  bad(`missing ${path.relative(root, mapFile)} (generate it first: it is the feature -> file:line map)`);
  process.exit(2);
}
let featureMap;
try {
  featureMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
} catch (err) {
  bad(`cannot parse ${path.relative(root, mapFile)}: ${err.message}`);
  process.exit(2);
}
const features = featureMap.features || {};

const index = readIndex(root);
for (const need of ['id', 'domain', 'title', 'spec']) {
  if (index.ix[need] === undefined) {
    bad(`CASE_INDEX.csv has no "${need}" column`);
    process.exit(2);
  }
}
const rows = activeRows(index);

/* ------------------------------------------------------------------ */
/* which files changed                                                 */
/* ------------------------------------------------------------------ */

function git(argv) {
  try {
    return execFileSync('git', argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function changedFromGit() {
  const out = new Set();
  for (const line of git(['status', '--porcelain']).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').pop().trim();
    file = file.replace(/^"|"$/g, '');
    if (file) out.add(file.replace(/\\/g, '/'));
  }
  for (const line of git(['diff', '--name-only', 'HEAD']).split(/\r?\n/)) {
    const f = line.trim();
    if (f) out.add(f.replace(/\\/g, '/'));
  }
  return [...out].sort();
}

const appPrefix = (f) => APP_PATHS.some((p) => f === p || f.startsWith(`${p}/`));
const isAppFile = (f) => appPrefix(f) && !/\.(md|png|jpg|jpeg|svg|ico)$/i.test(f);

const requested = args.files ? String(args.files).split(',').map((s) => s.trim()).filter(Boolean) : null;
const candidates = requested || changedFromGit();
const appFiles = candidates.filter(isAppFile);
const ignored = candidates.filter((f) => !isAppFile(f));

/* ------------------------------------------------------------------ */
/* map                                                                 */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s).toLowerCase();
const words = (name) => norm(name).split(/[^a-z0-9\u00c0-\u024f]+/).filter((w) => w.length >= 4);
const STOP = new Set(['with', 'from', 'into', 'that', 'this', 'when', 'each', 'must', 'every', 'mode', 'line', 'page', 'view']);

const featuresByFile = new Map();
for (const [name, meta] of Object.entries(features)) {
  for (const ev of meta.evidence || []) {
    const file = String(ev).split(':')[0].replace(/\\/g, '/');
    if (!featuresByFile.has(file)) featuresByFile.set(file, new Set());
    featuresByFile.get(file).add(name);
  }
}

function casesForFeature(name) {
  const tokens = words(name).filter((w) => !STOP.has(w));
  const out = [];
  for (const row of rows) {
    const title = norm(index.get(row, 'title'));
    const domain = index.get(row, 'domain');
    const hit = tokens.some((t) => title.includes(t) || domain.toLowerCase() === t.slice(0, 3));
    if (hit) out.push(row);
  }
  return out;
}

const report = [];
const unmapped = [];

for (const file of appFiles) {
  const names = [...(featuresByFile.get(file) || [])];
  if (!names.length) {
    unmapped.push(file);
    report.push({ file, features: [], domains: [], specs: [], cases: [] });
    continue;
  }
  const caseRows = new Map();
  for (const name of names) for (const row of casesForFeature(name)) caseRows.set(index.get(row, 'id'), row);
  const domains = [...new Set([...caseRows.values()].map((r) => index.get(r, 'domain')))].sort();
  const specs = [...new Set([...caseRows.values()].map((r) => index.get(r, 'spec'))
    .filter((s) => s && !['—', '-', '–'].includes(s)))].sort();
  report.push({ file, features: names.sort(), domains, specs, cases: [...caseRows.keys()].sort() });
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

if (args.json) {
  console.log(JSON.stringify({ changed: candidates, app: appFiles, ignored, report, unmapped, exit: unmapped.length && !args['allow-unmapped'] ? 1 : 0 }, null, 1));
} else {
  console.log(`${C.cyan}risk-map${C.reset} ${appFiles.length} changed app file(s)${ignored.length ? `, ${ignored.length} non-app ignored` : ''}`);
  console.log('');
  for (const entry of report) {
    if (!entry.features.length) {
      console.log(`${C.red}UNMAPPED${C.reset} ${entry.file}`);
      console.log(`${C.dim}         no feature in fixtures/feature-map.json claims this file.${C.reset}`);
      console.log(`${C.dim}         Add a feature (or its evidence line) and a case domain prefix before testing.${C.reset}`);
      continue;
    }
    console.log(`${C.green}mapped${C.reset}   ${entry.file}`);
    console.log(`         features: ${entry.features.join(', ')}`);
    console.log(`         domains : ${entry.domains.join(' ') || '(none - the feature has no cases yet)'}`);
    console.log(`         specs   : ${entry.specs.join(' ') || '(none)'}`);
    if (entry.domains.length) {
      console.log(`         run     : node .opencode/skills/e2e-testing/scripts/run.mjs ${entry.specs.map((s) => `--spec e2e-tests/specs/${s}`).join(' ')} --wipe`);
    }
  }
  if (!appFiles.length) {
    console.log(`${C.dim}no app file changed - nothing to map (docs, tests and fixtures do not select specs).${C.reset}`);
  }
}

if (unmapped.length) {
  console.log('');
  if (args['allow-unmapped']) {
    warn(`${unmapped.length} unmapped app file(s) - allowed by --allow-unmapped, but they are untested by construction.`);
  } else {
    console.log(`${C.red}RISK-MAP FAILED${C.reset} ${unmapped.length} app file(s) map to no feature: ${unmapped.slice(0, 8).join(', ')}${unmapped.length > 8 ? ' …' : ''}`);
    console.log(`${C.dim}A new domain prefix in CASE_INDEX.csv + a feature entry in fixtures/feature-map.json is required before testing continues.${C.reset}`);
    process.exit(1);
  }
}
