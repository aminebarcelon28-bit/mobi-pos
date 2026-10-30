#!/usr/bin/env node
/**
 * cluster.mjs - assign a FAIL (or flaky) case to a root-cause cluster.
 *
 * The cluster ledger (e2e-tests/FAIL-CLUSTERS.csv) is the root-cause map that
 * reconcile.mjs checks, so this script is its only writer:
 *
 *   node .../cluster.mjs --case REF-28 --key TENDER-CREDIT-OVERSTAMP \
 *        --priority P0 --evidence RUNTIME --money "money movement" \
 *        --catalog "blocked-by C01 ..." [--id C89] [--class env] [--dry-run]
 *
 * Rules:
 *  - the case must exist in CASE_INDEX.csv;
 *  - it must be FAIL, or PASS/PASS-PARTIAL whose evidence is marked FLAKY (an
 *    order-dependent pass is not a green and its cause still belongs here);
 *  - an existing row for the case is REPLACED (one case, one cluster);
 *  - the cluster id is --id when given, else the id already used by the same
 *    key (regrouping stays stable), else the next free C<nn>;
 *  - nothing is guessed: the id, key, class and priority are printed.
 *
 * Exit: 0 written (or dry-run), 2 refused / bad input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, parseArgs, readIndex, bad, ok, warn, C } from './_lib.mjs';

const args = parseArgs();
const die = (msg) => {
  bad(msg);
  process.exit(2);
};

if (!args.case || !args.key) die('usage: --case <ID> --key <CLUSTER_KEY> [--priority P0] [--id C89]');
const root = repoRoot();
const file = path.join(root, 'e2e-tests', 'FAIL-CLUSTERS.csv');
if (!fs.existsSync(file)) die(`missing ${file}`);

const index = readIndex(root);
const row = index.byId.get(String(args.case));
if (!row) die(`${args.case} is not in CASE_INDEX.csv`);
if (index.get(row, 'retired') === '1') die(`${args.case} is retired`);

const verdict = index.get(row, 'verdict');
const isFlakyPass = /(^|\W)FLAKY(\W|$)/i.test(index.get(row, 'evidence') ?? '');
if (verdict !== 'FAIL' && !isFlakyPass) {
  die(
    `${args.case} is ${verdict || '(none)'}, not FAIL and not marked FLAKY: a cluster row for a green case breaks reconcile`
  );
}

const text = fs.readFileSync(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const header = lines[0];
const rows = lines.slice(1);

const key = String(args.key).trim();
const priority = String(args.priority ?? 'P1');
const evidence = String(args.evidence ?? 'RUNTIME');
const money = String(args.money ?? 'none');
const catalog = String(args.catalog ?? 'NEW');
const klass = String(args.class ?? 'app');

let clusterId = null;
if (args.id) {
  clusterId = String(args.id).trim();
  if (!/^C\d{2}$/.test(clusterId)) die(`--id must look like C89 (got ${clusterId})`);
}
if (!clusterId) {
  for (const l of rows) {
    const p = l.split(',');
    if (p[2] === key) {
      clusterId = p[1];
      break;
    }
  }
}
if (!clusterId) {
  const used = rows
    .map((l) => /^C(\d+)$/.exec(l.split(',')[1] || ''))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  clusterId = `C${String((used.length ? Math.max(...used) : 0) + 1).padStart(2, '0')}`;
}

const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const nextRow = [String(args.case), clusterId, key, klass, evidence, money, priority, catalog].map(cell).join(',');
const kept = rows.filter((l) => l.split(',')[0] !== String(args.case));
const out = [header, ...kept, nextRow];

if (args['dry-run']) {
  ok(`dry-run: ${args.case} (${verdict}${isFlakyPass ? ', flaky' : ''}) -> ${clusterId} ${key}`);
  process.exit(0);
}
fs.writeFileSync(file, out.join(eol) + eol, 'utf8');
ok(`${args.case} (${verdict}${isFlakyPass ? ', flaky' : ''}) -> ${clusterId} ${key} (${klass}, ${priority})`);
if (!rows.some((l) => l.split(',')[1] === clusterId)) warn(`cluster ${clusterId} is new; link its RFC in docs/`);
void C;
