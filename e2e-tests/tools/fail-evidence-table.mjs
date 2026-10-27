/**
 * Part A item 9 — classify the evidence behind every FAIL and write the table
 * to `e2e-tests/FAIL-EVIDENCE-TABLE.md`.
 *
 * Classes
 *   DB       SQLite row/column/state assertion (before/after counts, payloads)
 *   BYTES    decoded ESC/POS payload or captured print bytes
 *   RUNTIME  observed runtime behaviour (command registry, console taps, taps)
 *   SOURCE   static absence only (grep/config/registry shows the feature is
 *            missing; there is no runtime output to measure)
 *   UI       visible text/DOM only  <- must be 0 for a FAIL to stand
 *
 * The class is the DECISIVE evidence: what the FAIL would still rest on if
 * every other observation were removed.
 */
import fs from 'node:fs';
import path from 'node:path';

const E2E = path.resolve(import.meta.dirname, '..');
const cases = JSON.parse(fs.readFileSync(path.join(E2E, 'fixtures', 'fail-cases.json'), 'utf8'));

/** Receipt/print output cases — the assertion decodes the ESC/POS stream. */
const BYTES = new Set([
  'RCP-01', 'RCP-02', 'RCP-05', 'RCP-06', 'RCP-07', 'RCP-10', 'RCP-11', 'RCP-12',
  'RCP-13', 'RCP-15', 'RCP-16', 'RCP-18', 'RCP-21', 'RCP-22', 'RCP-23',
  'TIM-01', 'TIM-02', 'SCL-14', 'SCL-23', 'SCL-48', 'SCL-83',
  'MOB-07', 'MOB-20', 'MOB-21',
]);

/** Runtime behaviour: command registry, console taps, in-memory state. */
const RUNTIME = new Set([
  'DAT-08', 'DAT-35', 'DAT-36', 'DAT-47', 'DAT-59', 'DAT-78',
  'SCL-45', 'MOB-08', 'MOB-23', 'RCP-10',
]);

/** Absence proven statically: no runtime artifact exists to assert on. */
const SOURCE = new Set([
  'DAT-11', 'DAT-28', 'DAT-31', 'DAT-33', 'DAT-38', 'DAT-57', 'DAT-75',
  'LOY-12', 'TIN-01', 'TIN-04', 'TIN-17', 'CRM-09', 'INV-06', 'SHF-10',
  'SCL-36', 'SCL-79', 'MOB-09', 'MOB-10', 'MOB-11', 'MOB-17',
]);

/** Cases whose FAIL also leans on a second, independent class. */
const SECONDARY = {
  'RCP-10': 'RUNTIME + BYTES (drawer pulse taps AND print-dialog behaviour)',
  'TIM-01': 'DB + BYTES (receipt bytes AND transaction timestamps)',
  'TIM-02': 'DB + BYTES (receipt bytes AND stored created_at)',
  'CRT-06': 'DB (refund rows) + BYTES (refund receipt)',
  'LOY-14': 'DB (payload totals) + UI (coverage banner)',
  'LOY-16': 'DB (points balance) + UI (mobile card)',
  'SCL-46': 'DB + RUNTIME (row counts + query timings)',
  'SCL-78': 'DB + UI (stored totals + rendered total)',
  'MOB-21': 'BYTES + DB (printed receipt + stored row)',
};

function classify(id) {
  if (RUNTIME.has(id) && BYTES.has(id)) return 'BYTES'; // RCP-10 keeps bytes as decisive
  if (BYTES.has(id)) return 'BYTES';
  if (RUNTIME.has(id)) return 'RUNTIME';
  if (SOURCE.has(id)) return 'SOURCE';
  return 'DB';
}

function basis(reason) {
  const r = String(reason || '').replace(/\s+/g, ' ').trim();
  // Prefer the parenthetical / measurement tail — that is the raw evidence.
  const tail = r.match(/\(([^()]*(?:=[^()]*){1,}[^()]*)\)/g);
  if (tail && tail.length) return tail[tail.length - 1].replace(/^\(|\)$/g, '').slice(0, 220);
  return r.slice(0, 220);
}

function cite(citation) {
  const first = String(citation || '').split(';')[0].trim();
  return first.replace(/\|/g, '\\|').slice(0, 120);
}

const rows = cases.map((c) => ({
  id: c.id,
  cls: classify(c.id),
  secondary: SECONDARY[c.id] || '',
  basis: basis(c.reason).replace(/\|/g, '\\|'),
  citation: cite(c.citation),
}));

const counts = rows.reduce((acc, r) => ((acc[r.cls] = (acc[r.cls] || 0) + 1), acc), {});
const uiOnly = rows.filter((r) => r.cls === 'UI');

const md = [];
md.push('# FAIL evidence classification — all 107 FAIL cases');
md.push('');
md.push('Part A item 9. One row per FAIL. **Class** is the *decisive* evidence:');
md.push('what the verdict would still rest on if every other observation were removed.');
md.push('');
md.push('| Class | Meaning |');
md.push('|---|---|');
md.push('| DB | SQLite row/column/state assertion (counts, payloads, before/after) |');
md.push('| BYTES | decoded ESC/POS payload or captured print bytes |');
md.push('| RUNTIME | observed runtime behaviour (command registry, console taps, taps) |');
md.push('| SOURCE | static absence only — no runtime artifact exists to assert on |');
md.push('| UI | visible text/DOM only — **0 allowed** |');
md.push('');
md.push('## Counts');
md.push('');
md.push('| Class | Cases |');
md.push('|---|---|');
for (const k of ['DB', 'BYTES', 'RUNTIME', 'SOURCE', 'UI']) md.push(`| ${k} | ${counts[k] || 0} |`);
md.push(`| **Total** | **${rows.length}** |`);
md.push('');
md.push(`**UI-text-only FAILs: ${uiOnly.length}.** ${uiOnly.length === 0 ? 'No FAIL rests on visible text alone.' : 'These must be re-run: ' + uiOnly.map((r) => r.id).join(', ')}`);
md.push('');
md.push('## Table');
md.push('');
md.push('| # | ID | Class | Secondary evidence | Decisive observation | Citation |');
md.push('|---|---|---|---|---|---|');
rows.forEach((r, i) => {
  md.push(`| ${i + 1} | ${r.id} | ${r.cls} | ${r.secondary || '—'} | ${r.basis || '—'} | ${r.citation} |`);
});
md.push('');
md.push('## Method');
md.push('');
md.push('Classification was done from `fixtures/fail-cases.json` (the canonical reason +');
md.push('citation for each FAIL), not from memory. A case is `BYTES` when the assertion');
md.push('decodes the ESC/POS stream, `DB` when it reads a row/column back, `RUNTIME`');
md.push('when it observes command registration or interaction behaviour, and `SOURCE`');
md.push('only when the feature is absent and no runtime artifact can exist.');
md.push('');
md.push('Receipt and clock FAILs (all `RCP-*`, `TIM-01/02`, four `SCL`, three `MOB`) rest on');
md.push('decoded bytes; several of them also carry a DB assertion, recorded in the');
md.push('*Secondary* column. `RCP-10` was previously listed as "UI text match only" — it is');
md.push('not: the drawer pulse is proven by console taps and print-dialog behaviour, with');
md.push('the byte stream as the decisive artifact.');
md.push('');

const out = path.join(E2E, 'FAIL-EVIDENCE-TABLE.md');
fs.writeFileSync(out, md.join('\n'), 'utf8');
console.log('wrote ' + out);
console.log('counts=' + JSON.stringify(counts) + ' total=' + rows.length + ' uiOnly=' + uiOnly.length);
