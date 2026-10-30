/**
 * Coverage accounting for the encyclopedia run.
 *
 * SINGLE SOURCE OF TRUTH for verdicts: `e2e-tests/CASE_INDEX.csv`
 * (one row per catalog case; `verdict` is the only place a verdict lives).
 * `fixtures/cases.json` is read for the G-invariant texts and to PROVE the
 * catalog id set still matches the CSV — it is never a verdict source.
 * `results/events.ndjson` is read only to annotate the G-invariant table
 * (which invariants the last batch actually asserted).
 *
 * Outputs:
 *  - e2e-tests/COVERAGE.md            (dashboard + per-domain tables + G table)
 *  - e2e-tests/results/summary.json   (machine summary, tagged with the batch)
 *
 * This is a BATCH-report generator, not a per-run tool: it refuses to run
 * without `--batch <tag>` so nobody regenerates the dashboard from a
 * half-finished or ad-hoc run and calls it coverage.
 *
 * Usage: node e2e-tests/tools/coverage.mjs --batch <tag>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const E2E = path.join(ROOT, 'e2e-tests');

/* ── 0. batch gate ─────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const batchIdx = argv.indexOf('--batch');
const batchTag = batchIdx >= 0 ? argv[batchIdx + 1] : undefined;
if (batchIdx < 0 || !batchTag || batchTag.startsWith('--')) {
  console.error(
    '[coverage] REFUSED: this generator rewrites COVERAGE.md and must run inside a batch.\n' +
      '           usage: node e2e-tests/tools/coverage.mjs --batch <tag>\n' +
      '           For a single run, use reconcile.mjs / collect-evidence.mjs instead.',
  );
  process.exit(1);
}

/* ── 1. CSV (verdict source of truth) ──────────────────────────────────── */
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
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvFile = path.join(E2E, 'CASE_INDEX.csv');
if (!fs.existsSync(csvFile)) {
  console.error(`[coverage] missing ${path.relative(ROOT, csvFile)} — it is the verdict source of truth`);
  process.exit(1);
}
const raw = parseCsv(fs.readFileSync(csvFile, 'utf8'));
const header = raw.shift().map((h) => h.trim());
const col = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['id', 'domain', 'priority', 'title', 'retired', 'verdict', 'spec']) {
  if (col[need] === undefined) {
    console.error(`[coverage] CASE_INDEX.csv has no "${need}" column`);
    process.exit(1);
  }
}
const csvRows = raw.filter((r) => r.length && String(r[col.id] ?? '').trim());
const active = csvRows.filter((r) => String(r[col.retired]).trim() !== '1');
const retired = csvRows.filter((r) => String(r[col.retired]).trim() === '1');

/* ── 2. catalog (G texts + id-set proof, never verdicts) ───────────────── */
const casesFile = path.join(E2E, 'fixtures', 'cases.json');
const catalog = fs.existsSync(casesFile)
  ? JSON.parse(fs.readFileSync(casesFile, 'utf8'))
  : { cases: [], gInvariants: [], source: 'unknown' };
const catalogIds = new Set(catalog.cases.map((c) => c.id));
const activeIds = new Set(active.map((r) => String(r[col.id]).trim()));
const retiredIds = new Set(retired.map((r) => String(r[col.id]).trim()));
const onlyCsv = [...activeIds].filter((id) => !catalogIds.has(id));
const onlyCatalog = [...catalogIds].filter((id) => !activeIds.has(id));
if (onlyCsv.length || onlyCatalog.length) {
  console.error(
    `[coverage] CASE_INDEX.csv and fixtures/cases.json disagree — fix the catalog first.\n` +
      `           active rows only in CSV: ${onlyCsv.slice(0, 10).join(', ') || '(none)'}\n` +
      `           cases only in cases.json: ${onlyCatalog.slice(0, 10).join(', ') || '(none)'}`,
  );
  process.exit(1);
}
const retiredInCatalog = [...retiredIds].filter((id) => catalogIds.has(id));
if (retiredInCatalog.length) {
  console.error(
    `[coverage] retired rows must sit OUTSIDE the 687-row catalog: ${retiredInCatalog.join(', ')}`,
  );
  process.exit(1);
}

/* ── 3. implemented IDs from specs (drift check on the CSV spec column) ── */
const specDir = path.join(E2E, 'specs');
const implemented = new Map();
const duplicate = new Map();
for (const f of fs.readdirSync(specDir).filter((x) => x.endsWith('.e2e.ts'))) {
  const text = fs.readFileSync(path.join(specDir, f), 'utf8');
  const re = /\bit\(\s*['"`]\[([A-Z][A-Z0-9]{1,3}-\d{2,3})\]/g;
  let m;
  while ((m = re.exec(text))) {
    const id = m[1];
    implemented.set(id, { spec: f, count: (implemented.get(id)?.count ?? 0) + 1 });
    if (implemented.get(id).count > 1) {
      duplicate.set(id, [...(duplicate.get(id) ?? []), f]);
    }
  }
}

/* ── 4. G-invariant execution evidence (informational only) ────────────── */
const lastState = new Map();
const eventsFile = path.join(E2E, 'results', 'events.ndjson');
if (fs.existsSync(eventsFile)) {
  for (const line of fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const idMatch = /\[([A-Z][A-Z0-9]{1,3}-\d{2,3})\]/.exec(rec.fullTitle ?? '');
    if (!idMatch) continue;
    const prev = lastState.get(idMatch[1]);
    if (!prev || prev.ts <= rec.ts) lastState.set(idMatch[1], { state: rec.state, ts: rec.ts });
  }
}
const invHarnessed = new Set();
const invFinalByLabel = new Map();
const invFile = path.join(E2E, 'results', 'invariant-events.ndjson');
if (fs.existsSync(invFile)) {
  for (const line of fs.readFileSync(invFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    for (const id of rec.checks ?? []) invHarnessed.add(id);
    const tag = String(rec.tag ?? '');
    if (!tag.startsWith('FINALIZE')) continue;
    const ids = new Set();
    for (const v of rec.violations ?? []) {
      const m = /^([A-Z][A-Z0-9]{1,3}-\d{2,3}):/.exec(String(v));
      if (m) ids.add(m[1]);
    }
    for (const v of rec.pending ?? []) {
      if (v?.check) ids.add(String(v.check));
      const m = /^([A-Z][A-Z0-9]{1,3}-\d{2,3}):/.exec(String(v?.violation ?? ''));
      if (m) ids.add(m[1]);
    }
    const label = tag.replace(/^FINALIZE\s*::\s*/, '');
    const prev = invFinalByLabel.get(label);
    if (!prev || prev.ts <= rec.ts) invFinalByLabel.set(label, { ts: rec.ts, ids });
  }
}
const invViolated = new Set();
for (const f of invFinalByLabel.values()) for (const id of f.ids) invViolated.add(id);

/* ── 5. reduce ─────────────────────────────────────────────────────────── */
const DASH = { total: active.length, PASS: 0, 'PASS-PARTIAL': 0, FAIL: 0, 'N/A': 0, BLOCKED: 0, REMAIN: 0 };
const unknown = new Map();
for (const r of active) {
  const v = String(r[col.verdict]).trim();
  if (DASH[v] === undefined) unknown.set(v, (unknown.get(v) ?? 0) + 1);
  else DASH[v]++;
}
if (unknown.size) {
  console.error(`[coverage] unknown verdict(s): ${[...unknown].map(([v, n]) => `"${v}"x${n}`).join(', ')}`);
  process.exit(1);
}
const byDomain = new Map();
for (const r of active) {
  const d = String(r[col.domain]).trim();
  byDomain.set(d, [...(byDomain.get(d) ?? []), r]);
}
const catalogById = new Map(catalog.cases.map((c) => [c.id, c]));

/* ── 6. emit COVERAGE.md ───────────────────────────────────────────────── */
const notesFile = path.join(E2E, 'COVERAGE_NOTES.md');
const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '';
const lines = [];
lines.push('# COVERAGE — POS Edge Case Encyclopedia vs. executed MobiPOS tests');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}  `);
lines.push(`Batch: \`${batchTag}\`  `);
lines.push('Verdict source: `e2e-tests/CASE_INDEX.csv` (single source of truth)  ');
// Never print the absolute path the catalog was extracted from: it embeds a
// local user profile and differs per machine. Basename is the stable identity.
const sourceLabel = catalog.source ? path.basename(catalog.source) : 'unknown';
lines.push(`Source cases: \`${sourceLabel}\` (local, not in repo)`);
lines.push('');
lines.push('## Summary dashboard');
lines.push('');
lines.push('| Metric | Count |');
lines.push('|---|---|');
lines.push(`| Catalog cases (table rows) | ${DASH.total} |`);
lines.push(`| Passed (full) | ${DASH.PASS} |`);
lines.push(`| Passed (partial — unasserted facets listed) | ${DASH['PASS-PARTIAL']} |`);
lines.push(`| Passed (excluding flaky rows) | ${DASH['PASS-NONFLAKY']} |`);
lines.push(`| **FAILED** | ${DASH.FAIL} |`);
lines.push(`| N/A (absent or unobservable in harness) | ${DASH['N/A']} |`);
lines.push(`| Remaining (doable today, not yet executed) | ${DASH.REMAIN} |`);
lines.push(`| BLOCKED (missing dependency — see Evidence) | ${DASH.BLOCKED} |`);
lines.push(`| Global invariants (G-01…G-36) executed | ${catalog.gInvariants.filter((g) => lastState.has(g.id) || invHarnessed.has(g.id)).length}/${catalog.gInvariants.length} |`);
lines.push('');
lines.push('> The catalog tables contain 687 active rows (incl. 15 I18 + 8 HW) + 36 G invariants.');
lines.push('> Additionally, 10 owner-retired tax IDs (§0.2.6) sit OUTSIDE the 687; they are the');
lines.push('> `retired=1` rows of `CASE_INDEX.csv` and are listed separately below.');
lines.push('');
if (notes) {
  lines.push(notes);
  lines.push('');
}

lines.push('## Retired / out-of-scope IDs (§0.2.6 — no tax in scope)');
lines.push('');
lines.push('| ID | Verdict |');
lines.push('|---|---|');
for (const r of retired) lines.push(`| ${r[col.id]} | ${r[col.verdict]} — removed (no tax) |`);
lines.push('');

for (const domain of [...byDomain.keys()].sort()) {
  const rows = byDomain.get(domain);
  lines.push(`## ${domain} (${rows.length})`);
  lines.push('');
  lines.push('| ID | Prio | Title | Spec | Verdict |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) {
    const id = String(r[col.id]).trim();
    const verdict = String(r[col.verdict]).trim();
    const evidence = String(r[col.evidence] ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    const short = verdict === 'BLOCKED' || verdict === 'N/A'
      ? `${verdict} — ${evidence.replace(/^(BLOCKED|N\/A)\s*[-—]\s*/, '').slice(0, 90)}`
      : verdict;
    const prio = `${r[col.priority]}${catalogById.get(id)?.conditionalP0 ? ' (cond. P0)' : ''}`;
    const spec = implemented.get(id)?.spec ?? String(r[col.spec] ?? '—') ?? '—';
    lines.push(
      `| ${id} | ${prio} | ${String(r[col.title]).replace(/\|/g, '\\|').slice(0, 90)} | ${spec} | ${short} |`,
    );
  }
  lines.push('');
}

lines.push('## G invariants');
lines.push('');
lines.push('> G-01…G-36 are asserted inside spec afterEach batches (`lib/invariants.ts` →');
lines.push('> `results/invariant-events.ndjson`); *fail* = the last finalize pass of a spec family');
lines.push('> recorded violations, *pass* = harnessed with none.');
lines.push('');
lines.push('| ID | Executed | Text |');
lines.push('|---|---|---|');
for (const g of catalog.gInvariants) {
  const st = lastState.get(g.id);
  const state = st
    ? st.state
    : invHarnessed.has(g.id)
      ? invViolated.has(g.id) ? '**fail**' : 'pass'
      : '—';
  lines.push(`| ${g.id} | ${state} | ${String(g.text).replace(/\|/g, '\\|').slice(0, 110)} |`);
}
lines.push('');

if (duplicate.size > 0) {
  lines.push('## Duplicate ID warnings');
  lines.push('');
  for (const [id, arr] of duplicate) lines.push(`- ${id} implemented in multiple spec files: ${arr.join(', ')}`);
  lines.push('');
}

fs.writeFileSync(path.join(E2E, 'COVERAGE.md'), lines.join('\n'));
fs.mkdirSync(path.join(E2E, 'results'), { recursive: true });
fs.writeFileSync(
  path.join(E2E, 'results', 'summary.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), batch: batchTag, dashboard: DASH, implementedCount: implemented.size }, null, 1),
);
console.log(
  `[coverage] batch=${batchTag} cases=${DASH.total} pass=${DASH.PASS} partial=${DASH['PASS-PARTIAL']} ` +
    `fail=${DASH.FAIL} na=${DASH['N/A']} blocked=${DASH.BLOCKED} remain=${DASH.REMAIN} retired=${retired.length}`,
);
console.log(`[coverage] wrote ${path.join(E2E, 'COVERAGE.md')}`);
