/**
 * Extract every case-ID table row from the encyclopedia into
 * e2e-tests/fixtures/cases.json (id, domain, section, title, priority per §1.1).
 * Also extracts the G-01..G-36 invariant table. Pure text parsing of the spec
 * document — no app involvement.
 *
 * Usage: node e2e-tests/tools/extract-cases.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MD = process.env.POS_ENCYCLOPEDIA ?? 'POS_EDGE_CASE_ENCYCLOPEDIA_and_LONG_SESSION.md';
const OUT = path.join(__dirname, '..', 'fixtures', 'cases.json');

const text = fs.readFileSync(MD, 'utf8');
const lines = text.split(/\r?\n/);

/** Retired IDs per §0.2 item 6 (no tax in scope) — reported N/A. */
const RETIRED = new Set([
  'MNY-08', 'MNY-09', 'MNY-10', 'MNY-12', 'MNY-13', 'MNY-14', 'MNY-15',
  'REF-04', 'REP-17', 'RPT-02',
]);

/** §1.1 priority rules: domain default + explicit exceptions. */
const DOMAIN_DEFAULT = {
  MNY: 'P0', CRT: 'P1', PAY: 'P0', REF: 'P0', LOY: 'P1', TIN: 'P0', REP: 'P1',
  INV: 'P1', RCP: 'P1', LBL: 'P1', SYN: 'P0', SHF: 'P0', SEC: 'P0', TIM: 'P1',
  I18: 'P1', DAT: 'P0', RPT: 'P1', CRM: 'P1', PRF: 'P2', HW: 'P2', SCL: 'P1',
  DRW: 'P0', IDN: 'P0', WAR: 'P0', MOB: 'P1',
};
const expand = (spec) => {
  // "REF-18–19" / "SCL-36–38" en-dash ranges -> ["REF-18","REF-19", ...]
  const m = /^([A-Z][A-Z0-9]{1,2})-(\d{2})[–-](\d{2})$/.exec(spec.trim());
  if (!m) return [spec.trim()];
  const [, dom, a, b] = m;
  const out = [];
  for (let i = Number(a); i <= Number(b); i++) out.push(`${dom}-${String(i).padStart(2, '0')}`);
  return out;
};
const toP0 = new Set();
const toP1 = new Set();
for (const part of 'CRT-04, CRT-18'.split(',')) toP0.add(expand(part)[0]);
for (const part of 'REF-18–19, REF-56, REF-64, REF-73, REF-76, REF-85, REF-89, REF-91'.split(',')) expand(part).forEach((x) => toP1.add(x));
for (const part of 'REP-03, REP-05–07, REP-10–11, REP-13–14, REP-18, REP-21'.split(',')) expand(part).forEach((x) => toP0.add(x));
for (const part of 'INV-01, INV-03, INV-07, INV-13–14, INV-16–17'.split(',')) expand(part).forEach((x) => toP0.add(x));
for (const part of 'RCP-04, RCP-06, RCP-20'.split(',')) toP0.add(expand(part)[0]);
for (const part of 'TIM-01, TIM-08'.split(',')) toP0.add(expand(part)[0]);
toP0.add('I18-05');
for (const part of 'DAT-79, DAT-84'.split(',')) toP1.add(expand(part)[0]);
for (const part of 'PRF-05–06'.split(',')) expand(part).forEach((x) => toP1.add(x));
for (const part of 'SCL-07, SCL-12–14, SCL-23, SCL-26, SCL-36–38, SCL-43, SCL-45–48, SCL-58, SCL-77–79, SCL-83–84'.split(',')) expand(part).forEach((x) => toP0.add(x));
for (const part of 'IDN-07, IDN-18, IDN-22'.split(',')) toP1.add(expand(part)[0]);
for (const part of 'WAR-08–09, WAR-17–18, WAR-20, WAR-22, WAR-25–28'.split(',')) expand(part).forEach((x) => toP1.add(x));
for (const part of 'MOB-01–10, MOB-13–16, MOB-20, MOB-24'.split(',')) expand(part).forEach((x) => toP0.add(x));

/** Conditional-P0 IDs (owner-confirmation conditional; reported as P1 with note). */
const CONDITIONAL_P0 = new Set([
  ...['LOY-03', 'LOY-04', 'LOY-05', 'LOY-06', 'LOY-11', 'LOY-12'].map((x) => x),
  'CRM-04',
]);

const cases = [];
let section = '';
const seen = new Set();

// G-invariants
const invariants = [];
const invSeen = new Set();
for (const line of lines) {
  const m = /^\|\s*(G-\d{2})\s*\|\s*(.*?)\s*\|$/.exec(line);
  if (m && !invSeen.has(m[1])) {
    invSeen.add(m[1]);
    invariants.push({ id: m[1], text: m[2].replace(/\*\*/g, '') });
  }
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const h = /^### (?:\d+\.\d+ )?([A-Z][A-Z0-9]{1,2}) —/.exec(line);
  if (h) section = h[1];

  const m = /^\|\s*([A-Z][A-Z0-9]{1,2}-\d{2})\s*\|\s*(.*)$/.exec(line);
  if (!m) continue;
  const id = m[1];
  if (seen.has(id)) {
    console.log(`[extract] duplicate row for ${id} at line ${i + 1} — keeping first`);
    continue;
  }
  seen.add(id);
  const rest = m[2];
  const cells = rest.split('|').map((c) => c.trim());
  const title = cells[0] ?? '';
  const domain = id.split('-')[0];
  const retired = RETIRED.has(id);
  let priority = DOMAIN_DEFAULT[domain] ?? '';
  if (toP0.has(id)) priority = 'P0';
  if (toP1.has(id)) priority = 'P1';
  if (retired) priority = 'N/A';
  cases.push({
    id,
    domain,
    section,
    line: i + 1,
    title: title.replace(/\*\*/g, '').trim(),
    priority,
    conditionalP0: CONDITIONAL_P0.has(id),
    retired,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify(
    { source: MD, extractedAt: new Date().toISOString(), total: cases.length, invariants: invariants.length, cases, gInvariants: invariants },
    null,
    1,
  ),
);

// Report
const byDomain = {};
for (const c of cases) {
  const d = (byDomain[c.domain] = byDomain[c.domain] ?? { total: 0, retired: 0, P0: 0, P1: 0, P2: 0 });
  d.total++;
  if (c.retired) d.retired++;
  else if (c.priority === 'P0') d.P0++;
  else if (c.priority === 'P1') d.P1++;
  else if (c.priority === 'P2') d.P2++;
}
console.log(`[extract] cases=${cases.length} invariants=${invariants.length} written to ${OUT}`);
let tot = { P0: 0, P1: 0, P2: 0, retired: 0, total: 0 };
for (const [k, v] of Object.entries(byDomain).sort()) {
  console.log(`  ${k}: total=${v.total} P0=${v.P0} P1=${v.P1} P2=${v.P2} retired=${v.retired}`);
  tot.P0 += v.P0; tot.P1 += v.P1; tot.P2 += v.P2; tot.retired += v.retired; tot.total += v.total;
}
console.log(`  TOTAL: ${tot.total} P0=${tot.P0} P1=${tot.P1} P2=${tot.P2} retired=${tot.retired}`);
const emptyTitles = cases.filter((c) => !c.title).length;
console.log(`[extract] rows without title text: ${emptyTitles}; invariants found: ${invariants.length}`);
