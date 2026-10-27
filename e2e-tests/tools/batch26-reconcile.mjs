/**
 * Batch 26 reconciliation — CASE_INDEX.csv + results/summary.json.
 *
 * Verdicts and evidence are parsed from the canonical run log, so the index can
 * never disagree with what the run actually printed. Usage:
 *
 *   node tools/batch26-reconcile.mjs logs/batch26-rcp-tim.log [--write]
 *
 * Without --write it only prints the diff and the recomputed dashboard.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const SUMMARY = path.join(ROOT, 'results', 'summary.json');
const SPEC = '26-rcp-tim.e2e.ts';

const args = process.argv.slice(2);
const logPath = path.resolve(ROOT, args.find((a) => !a.startsWith('--')) ?? 'logs/batch26-rcp-tim.log');
const write = args.includes('--write');

// ---------------------------------------------------------------------------
// log -> verdicts
// ---------------------------------------------------------------------------

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

const VERDICT_RE = /^\[([A-Z]{3}-\d{2})\] VERDICT=(PASS-PARTIAL|PASS|FAIL|N\/A|BLOCKED) ([\s\S]*)$/;
const verdicts = new Map();
for (const raw of readText(logPath).split(/\r?\n/)) {
  const line = raw.replace(/^\[[^\]]*\]\s*/, '').trimEnd();
  const m = VERDICT_RE.exec(line);
  if (!m) continue;
  const [, id, verdict, evidence] = m;
  // A retried case logs again: the last line wins (reruns are the authority).
  verdicts.set(id, { verdict, evidence: evidence.trim() });
}

// ---------------------------------------------------------------------------
// CSV (RFC4180, every field quoted in this file)
// ---------------------------------------------------------------------------

const csvText = fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '');
const rows = [];
let cur = '';
let inQ = false;
for (let i = 0; i < csvText.length; i += 1) {
  const c = csvText[i];
  if (inQ) {
    if (c === '"') {
      if (csvText[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQ = false;
    } else cur += c;
  } else if (c === '"') inQ = true;
  else if (c === ',') cur += '\u0001';
  else if (c === '\n') {
    if (cur.endsWith('\r')) cur = cur.slice(0, -1);
    rows.push(cur.split('\u0001'));
    cur = '';
  } else cur += c;
}
if (cur) rows.push(cur.split('\u0001'));
const header = rows.shift();
const col = Object.fromEntries(header.map((h, i) => [h, i]));

const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const lineOf = (r) => r.map(cell).join(',');

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

const changed = [];
const expected = rows
  .filter((r) => r.length >= header.length && r[col.retired] !== '1' && ['RCP', 'TIM'].includes(r[col.domain]) && (r[col.verdict] === 'REMAIN' || r[col.verdict] === ''))
  .map((r) => r[col.id]);
const notLogged = expected.filter((id) => !verdicts.has(id));
for (const r of rows) {
  if (r.length < header.length) continue;
  const hit = verdicts.get(r[col.id]);
  if (!hit) continue;
  const nextEvidence = `${hit.verdict}: ${hit.evidence} (e2e-tests/logs/batch26-rcp-tim.log)`;
  const before = { verdict: r[col.verdict], spec: r[col.spec], evidence: r[col.evidence] };
  r[col.verdict] = hit.verdict;
  r[col.spec] = SPEC;
  r[col.evidence] = nextEvidence;
  changed.push({ id: r[col.id], from: before.verdict, to: hit.verdict });
}

const counts = {};
let active = 0;
for (const r of rows) {
  if (r.length < header.length) continue;
  if (r[col.retired] === '1') continue;
  active += 1;
  const v = r[col.verdict] || 'REMAIN';
  counts[v] = (counts[v] ?? 0) + 1;
}

const total = active;
const passedFull = counts.PASS ?? 0;
const passPartial = counts['PASS-PARTIAL'] ?? 0;
const failed = counts.FAIL ?? 0;
const na = counts['N/A'] ?? 0;
const remaining = counts.REMAIN ?? 0;
const blocked = counts.BLOCKED ?? 0;
const sum = passedFull + passPartial + failed + na + remaining + blocked;

console.log(`log        : ${path.relative(ROOT, logPath)}`);
console.log(`verdicts   : ${verdicts.size} ids`);
console.log(`expected   : ${expected.length} RCP/TIM ids still REMAIN`);
if (notLogged.length) console.log(`!! no VERDICT line for: ${notLogged.join(', ')}`);
console.log(`csv rows   : ${rows.length} (active ${total}, retired ${rows.length - total})`);
console.log(`changed    : ${changed.length}`);
for (const c of changed) console.log(`  ${c.id}: ${c.from} -> ${c.to}`);
console.log(
  `dashboard  : ${passedFull} PASS + ${passPartial} PASS-PARTIAL + ${failed} FAIL + ${na} N/A + ` +
    `${remaining} REMAIN + ${blocked} BLOCKED = ${sum} (expected ${total})`,
);
if (sum !== total) console.log('!! MATH MISMATCH');

const missing = [...verdicts.keys()].filter((id) => !rows.some((r) => r[col.id] === id));
if (missing.length) console.log(`!! ids not in CASE_INDEX: ${missing.join(', ')}`);

if (!write) {
  console.log('(dry run — pass --write to persist)');
  process.exit(0);
}

const out = '\uFEFF' + [header, ...rows].map(lineOf).join('\r\n') + '\r\n';
fs.writeFileSync(CSV, out, 'utf8');

const prev = fs.existsSync(SUMMARY) ? JSON.parse(fs.readFileSync(SUMMARY, 'utf8')) : {};
const invariants = prev.dashboard?.invariants ?? 36;
const invariantsCovered = prev.dashboard?.invariantsCovered ?? 0;
const summary = {
  generatedAt: new Date().toISOString(),
  dashboard: {
    total,
    passed: passedFull + passPartial,
    passedFull,
    passPartial,
    failed,
    na,
    remaining,
    blocked,
    invariants,
    invariantsCovered,
  },
  implementedCount: passedFull + passPartial + failed + na,
  lastStateCount: passedFull + passPartial + failed + na,
};
fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(`wrote ${path.relative(ROOT, CSV)} + ${path.relative(ROOT, SUMMARY)}`);
