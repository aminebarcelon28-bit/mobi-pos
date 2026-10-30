#!/usr/bin/env node
/**
 * case-index.mjs — keep `e2e-tests/CASE_INDEX.csv` and the `COVERAGE.md`
 * dashboard in step when a new feature adds cases.
 *
 * Why this exists: the reconcile gate (`e2e-testing/scripts/reconcile.mjs`)
 * compares the CSV bucket counts against the dashboard and refuses to pass
 * when they drift, and it refuses any FAIL row without a cluster. Both are
 * easy to get wrong by hand, and a re-serialised CSV churns 697 rows of diff.
 * This script appends, never rewrites, and derives the counts instead of
 * asking you to type them.
 *
 * Usage
 *   node case-index.mjs next REF 3              # print the next 3 REF ids
 *   node case-index.mjs add cases.json          # dry run: validate + show
 *   node case-index.mjs add cases.json --write  # append rows, sync dashboard
 *   node case-index.mjs check                   # ids, verdicts, dashboard parity
 *
 * `cases.json` is an array of rows; `id` is optional (allocated per domain,
 * in array order). See references/case-index.md for the field contract.
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---------- locate the repo ---------- */
function findRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'e2e-tests', 'CASE_INDEX.csv'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  console.error('case-index: no e2e-tests/CASE_INDEX.csv above ' + process.cwd());
  process.exit(1);
}
const ROOT = findRoot();
const E2E = path.join(ROOT, 'e2e-tests');
const CSV_PATH = path.join(E2E, 'CASE_INDEX.csv');
const COV_PATH = path.join(E2E, 'COVERAGE.md');

const VERDICTS = ['PASS', 'PASS-PARTIAL', 'FAIL', 'N/A', 'REMAIN', 'BLOCKED'];
const PRIORITIES = ['P0', 'P1', 'P2', 'N/A'];
// Domains are 2-4 chars starting with a letter; digits are legal inside the
// prefix (the corpus already carries `I18-01`…`I18-15` for the i18n cases).
const DOMAIN_RE = /^[A-Z][A-Z0-9]{1,3}$/;
const ID_RE = /^[A-Z][A-Z0-9]{1,3}-\d+$/;

/* ---------- csv ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((f) => String(f).trim()));
}
function cell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const raw = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(raw);
const header = rows.shift().map((h) => h.trim());
const ix = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['id', 'domain', 'verdict', 'retired']) {
  if (ix[need] === undefined) {
    console.error(`case-index: CASE_INDEX.csv has no "${need}" column`);
    process.exit(1);
  }
}

/* ---------- id allocation ---------- */
function maxNumeric(domain) {
  let max = 0;
  for (const r of rows) {
    const id = String(r[ix.id] ?? '').trim();
    const m = new RegExp(`^${domain}-(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
const pad = (n) => String(n).padStart(2, '0');
function nextIds(domain, n, from) {
  const start = from ?? maxNumeric(domain);
  return Array.from({ length: n }, (_, k) => `${domain}-${pad(start + k + 1)}`);
}

/* ---------- dashboard ---------- */
const DASH_KEYS = [
  ['TOTAL', /^Catalog cases/],
  ['PASS', /^Passed \(full\)/],
  ['PASS-PARTIAL', /^Passed \(partial/],
  ['FAIL', /^FAILED/],
  ['N/A', /^N\/A/],
  ['REMAIN', /^Remaining/],
  ['BLOCKED', /^BLOCKED/],
];
function bucketOf(list) {
  const out = { TOTAL: 0, PASS: 0, 'PASS-PARTIAL': 0, FAIL: 0, 'N/A': 0, REMAIN: 0, BLOCKED: 0 };
  for (const r of list) {
    if (String(r[ix.retired]).trim() === '1') continue;
    out.TOTAL++;
    const v = String(r[ix.verdict] ?? '').trim();
    if (out[v] !== undefined) out[v]++;
  }
  return out;
}
function readDashboard() {
  const out = {};
  for (const line of fs.readFileSync(COV_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*(.+?)\s*\|\s*([\d/]+)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const label = m[1].replace(/\*/g, '');
    const hit = DASH_KEYS.find(([, re]) => re.test(label));
    if (hit) out[hit[0]] = Number(m[2]);
  }
  return out;
}
function syncDashboard(next) {
  // Rewrite by line, matching labels exactly the way readDashboard does (bold
  // markers stripped), so `| **FAILED** | 251 |` updates as happily as
  // `| Passed (full) | 178 |`. A regex built from the key name alone misses
  // the bolded rows and silently leaves the dashboard half-synced.
  const text = fs.readFileSync(COV_PATH, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\|\s*)(.+?)(\s*\|\s*)([\d/]+)(\s*\|\s*)$/.exec(lines[i]);
    if (!m) continue;
    const label = m[2].replace(/\*/g, '');
    const hit = DASH_KEYS.find(([, re]) => re.test(label));
    if (!hit || next[hit[0]] === undefined) continue;
    lines[i] = `${m[1]}${m[2]}${m[3]}${next[hit[0]]}${m[5]}`;
  }
  fs.writeFileSync(COV_PATH, lines.join(eol), 'utf8');
}

/* ---------- commands ---------- */
const [, , cmd, ...rest] = process.argv;

if (cmd === 'next') {
  const domain = rest[0];
  const n = Number(rest[1] ?? 1);
  if (!domain || !Number.isInteger(n) || n < 1) {
    console.error('usage: case-index.mjs next <DOMAIN> [count]');
    process.exit(1);
  }
  console.log(nextIds(domain.toUpperCase(), n).join('\n'));
  process.exit(0);
}

if (cmd === 'check') {
  const ids = new Map();
  const problems = [];
  for (const r of rows) {
    const id = String(r[ix.id] ?? '').trim();
    if (!ID_RE.test(id)) problems.push(`bad id: "${id}"`);
    if (ids.has(id)) problems.push(`duplicate id: ${id}`);
    ids.set(id, true);
    const retired = String(r[ix.retired] ?? '').trim();
    if (!['0', '1'].includes(retired)) problems.push(`${id}: retired "${r[ix.retired]}"`);
    const v = String(r[ix.verdict] ?? '').trim();
    if (!VERDICTS.includes(v)) problems.push(`${id}: verdict "${v}"`);
    if (!PRIORITIES.includes(String(r[ix.priority] ?? '').trim())) problems.push(`${id}: priority "${r[ix.priority]}"`);
    // Retired rows are owner-removed placeholders: they keep their id and
    // verdict so the id is never reused, but they legitimately carry no title
    // or evidence (10 tax rows did exactly that). Don't demand content.
    if (retired === '1') continue;
    if (!String(r[ix.title] ?? '').trim()) problems.push(`${id}: empty title`);
    if (!String(r[ix.evidence] ?? '').trim()) problems.push(`${id}: empty evidence`);
  }
  const bucket = bucketOf(rows);
  const dash = readDashboard();
  for (const [k] of DASH_KEYS) {
    if (dash[k] !== bucket[k]) problems.push(`dashboard ${k}: file=${dash[k]} csv=${bucket[k]}`);
  }
  if (problems.length) {
    console.log(`case-index: ${problems.length} problem(s)`);
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
  }
  console.log(`case-index: ok (${rows.length} rows, ${bucket.TOTAL} active, dashboard in sync)`);
  process.exit(0);
}

if (cmd === 'add') {
  const file = rest[0];
  const write = rest.includes('--write');
  if (!file) {
    console.error('usage: case-index.mjs add <cases.json> [--write]');
    process.exit(1);
  }
  const incoming = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(incoming) || !incoming.length) {
    console.error('case-index: expected a non-empty JSON array');
    process.exit(1);
  }

  const existing = new Set(rows.map((r) => String(r[ix.id] ?? '').trim()));
  const allocated = {};
  const problems = [];
  const prepared = incoming.map((c, k) => {
    const domain = String(c.domain ?? '').trim().toUpperCase();
    if (!DOMAIN_RE.test(domain)) problems.push(`row ${k}: domain "${c.domain}"`);
    let id = String(c.id ?? '').trim();
    if (!id) {
      if (allocated[domain] === undefined) allocated[domain] = maxNumeric(domain);
      allocated[domain] += 1;
      id = `${domain}-${pad(allocated[domain])}`;
    }
    if (!ID_RE.test(id)) problems.push(`row ${k}: id "${id}"`);
    if (existing.has(id)) problems.push(`row ${k}: id ${id} already in the index`);
    existing.add(id);

    const priority = String(c.priority ?? '').trim();
    if (!PRIORITIES.includes(priority)) problems.push(`${id}: priority "${priority}"`);
    const verdict = String(c.verdict ?? '').trim();
    if (!VERDICTS.includes(verdict)) problems.push(`${id}: verdict "${verdict}"`);
    const title = String(c.title ?? '').trim();
    if (!title) problems.push(`${id}: empty title`);
    if (/[\r\n]/.test(title)) problems.push(`${id}: title must be one line`);
    const evidence = String(c.evidence ?? '').trim();
    if (!evidence) problems.push(`${id}: empty evidence`);
    const spec = String(c.spec ?? '').trim();
    if (spec && !fs.existsSync(path.join(E2E, 'specs', spec))) problems.push(`${id}: spec not found: ${spec}`);

    // Anchor `line` on the case's own `it('[ID]')` when the spec has one; the
    // field is informational and a stale body line is worse than no line.
    let line = Number(c.line ?? 0);
    if (!line && spec && fs.existsSync(path.join(E2E, 'specs', spec))) {
      const src = fs.readFileSync(path.join(E2E, 'specs', spec), 'utf8').split(/\r?\n/);
      const at = src.findIndex((l) => l.includes(`[${id}]`));
      line = at >= 0 ? at + 1 : 0;
    }

    return {
      id,
      domain,
      priority,
      conditional_p0: String(c.conditional_p0 ?? '').trim(),
      title,
      section: String(c.section ?? domain).trim(),
      line,
      retired: String(c.retired ?? 0),
      verdict,
      spec,
      evidence,
    };
  });

  if (problems.length) {
    console.log(`case-index: ${problems.length} problem(s), nothing written`);
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
  }

  const lines = prepared.map((r) => header.map((h) => cell(r[h])).join(','));
  const nextRows = [...rows, ...prepared.map((r) => header.map((h) => String(r[h] ?? '')))];
  const before = bucketOf(rows);
  const after = bucketOf(nextRows);

  console.log(`${write ? 'adding' : 'would add'} ${prepared.length} row(s):`);
  for (const r of prepared) console.log(`  ${r.id}  ${r.verdict.padEnd(12)} ${r.domain}  ${r.title.slice(0, 70)}`);
  const changed = DASH_KEYS.filter(([k]) => before[k] !== after[k]);
  if (changed.length) {
    console.log('dashboard:');
    for (const [k] of changed) console.log(`  ${k}: ${before[k]} -> ${after[k]}`);
  } else {
    console.log('dashboard: unchanged');
  }
  if (!write) {
    console.log('\ndry run — re-run with --write to append');
    process.exit(0);
  }

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const sep = raw.endsWith('\n') ? '' : eol;
  fs.writeFileSync(CSV_PATH, raw + sep + lines.join(eol) + eol, 'utf8');
  syncDashboard(after);
  console.log(`\nappended to CASE_INDEX.csv; COVERAGE.md dashboard synced`);
  process.exit(0);
}

console.error('usage: case-index.mjs <next|add|check> ...');
process.exit(1);
