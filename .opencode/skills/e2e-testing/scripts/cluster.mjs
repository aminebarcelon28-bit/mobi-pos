#!/usr/bin/env node
/**
 * cluster.mjs - assign a FAIL case to a root-cause cluster through the pipeline.
 *
 * The cluster ledger (e2e-tests/FAIL-CLUSTERS.csv) is the root-cause map that
 * reconcile.mjs checks. Adding or moving a row by hand is how the ledger drifts
 * from the index, so this script is the only writer:
 *
 *   node .../cluster.mjs --case REF-28 --key TENDER-CREDIT-OVERSTAMP \
 *        --priority P0 --evidence RUNTIME --money "money movement" \
 *        --catalog "blocked-by C01: refund math unproven until the tender is fixed"
 *
 * Rules:
 *  - the case must exist in CASE_INDEX.csv and be a FAIL (or a derived row whose
 *    anchor is FAIL); assigning a green case is refused (reconcile would fail);
 *  - an existing row for the case is REPLACED (a case belongs to one cluster);
 *  - a new cluster id is the next free `C<nn>`; an existing key keeps its id, so
 *    regrouping several cases under one root cause is stable;
 *  - nothing is guessed: the id, the key and the priority are printed.
 *
 * Usage:
 *   node .../cluster.mjs --case ID --key KEY [--priority P0..P3] [--evidence X]
 *        [--money "text"] [--catalog "text"] [--dry-run]
 *
 * Exit: 0 written (or dry-run), 1 refused, 2 bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, parseArgs, readIndex, activeRows, bad, ok, warn, C } from './_lib.mjs';

const args = parseArgs();
const root = repoRoot();
const file = path.join(root, 'e2e-tests', 'FAIL-CLUSTERS.csv');
if (!args.case || !args.key) bad('usage: --case <ID> --key <CLUSTER_KEY> [--priority P0]');
if (!fs.existsSync(file)) bad(`missing ${file}`);

const index = readIndex(root);
const row = index.byId.get(String(args.case));
if (!row) bad(`${args.case} is not in CASE_INDEX.csv`);
if (index.get(row, 'retired') === '1') bad(`${args.case} is retired`);

const verdict = index.get(row, 'verdict');
if (verdict !== 'FAIL') {
  bad(`${args.case} is ${verdict || '(none)'}, not FAIL: a cluster row for a green case breaks reconcile`);
}

const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const header = lines[0];
const rows = lines.slice(1);
const cols = header.split(',');

const key = String(args.key).trim();
const priority = String(args.priority ?? 'P1');
const evidence = String(args.evidence ?? 'RUNTIME');
const money = String(args.money ?? 'none');
const catalog = String(args.catalog ?? 'NEW');

// Reuse the id of an existing key so regrouping stays stable, else next free.
let clusterId = null;
for (const l of rows) {
  const p = l.split(',');
  if (p[2] === key) {
    clusterId = p[1];
    break;
  }
}
if (!clusterId) {
  const used = rows
    .map((l) => /^C(\d+)$/.exec(l.split(',')[1] || ''))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  clusterId = `C${String(next).padStart(2, '0')}`;
}

const nextRow = [String(args.case), clusterId, key, 'app', evidence, money, priority, catalog];
const kept = rows.filter((l) => l.split(',')[0] !== String(args.case));
const out = [header, ...kept, nextRow.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')];

if (args['dry-run']) {
  ok(`dry-run: ${args.case} -> ${clusterId} ${key} (${verdict})`);
  process.exit(0);
}
fs.writeFileSync(file, out.join(eol) + eol, 'utf8');
ok(`${args.case} -> ${clusterId} ${key} (${priority}, ${evidence})`);
if (clusterId === 'C90' || Number(clusterId.slice(1)) > 89) {
  warn(`cluster ${clusterId} is new; link it to the RFC in docs/ and give it a test plan`);
}
