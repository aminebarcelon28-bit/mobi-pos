/**
 * Batch 26 — refresh fixtures/{fail,na,blocked}-cases.json from CASE_INDEX.csv.
 *
 * For the 29 batch-26 IDs: drop any previous entry, then re-add from the
 * reconciled CSV row (verdict + evidence line captured from the run log).
 * Existing entries for other batches are preserved in order.
 *
 *   node tools/batch26-fixtures.mjs [--write]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV = path.join(ROOT, 'CASE_INDEX.csv');
const write = process.argv.includes('--write');
const LOG = 'e2e-tests/logs/batch26-rcp-tim.log';
const SPEC = 'e2e-tests/specs/26-rcp-tim.e2e.ts';

const BATCH26 = [
  'RCP-01', 'RCP-02', 'RCP-03', 'RCP-05', 'RCP-07', 'RCP-08', 'RCP-10', 'RCP-11',
  'RCP-12', 'RCP-13', 'RCP-14', 'RCP-15', 'RCP-16', 'RCP-17', 'RCP-18', 'RCP-19',
  'RCP-21', 'RCP-22', 'RCP-23', 'RCP-24', 'RCP-09',
  'TIM-02', 'TIM-03', 'TIM-04', 'TIM-05', 'TIM-06', 'TIM-07', 'TIM-09', 'TIM-10',
];

/** What each BLOCKED case actually needs (owner-facing). */
const NEEDS = {
  'RCP-19':
    'A healthy Android install (fresh install stops on the unscriptable first-boot PIN gate; the restored ' +
    'snapshot boots with an empty catalogue while SQLite holds 1,307 products — P1-67) plus a Bluetooth ESC/POS printer.',
  'RCP-24':
    'A second enrolled terminal (or a healthy Android build) and the data-plane gateway; no cross-device print-job ' +
    'transport exists today.',
  'TIM-09':
    'A healthy Android build (P1-67) plus a second timezone/VPN profile; the emulator is Africa/Lagos with auto-time forced on.',
  'TIM-10':
    'A multi-day sleep window on the mobile build plus a token-refresh endpoint; the desktop run cannot suspend the machine for days.',
};

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
const header = rows.shift();
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const byId = new Map(rows.filter((r) => r.length >= header.length).map((r) => [r[col.id], r]));

const files = {
  FAIL: path.join(ROOT, 'fixtures', 'fail-cases.json'),
  'N/A': path.join(ROOT, 'fixtures', 'na-cases.json'),
  BLOCKED: path.join(ROOT, 'fixtures', 'blocked-cases.json'),
};
const data = Object.fromEntries(
  Object.entries(files).map(([k, f]) => [k, JSON.parse(fs.readFileSync(f, 'utf8'))]),
);

const before = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
for (const k of Object.keys(data)) data[k] = data[k].filter((e) => !BATCH26.includes(e.id));

const added = { FAIL: 0, 'N/A': 0, BLOCKED: 0 };
const skipped = [];
for (const id of BATCH26) {
  const row = byId.get(id);
  if (!row) {
    skipped.push(`${id} (no CSV row)`);
    continue;
  }
  const verdict = row[col.verdict];
  const evidence = (row[col.evidence] || '').replace(/ \(e2e-tests\/logs\/batch26-rcp-tim\.log\)$/, '');
  const citation = `${SPEC} [${id}]; ${LOG}`;
  if (verdict === 'FAIL') {
    data.FAIL.push({ id, reason: `FAIL: ${evidence}`, citation });
    added.FAIL += 1;
  } else if (verdict === 'N/A') {
    data['N/A'].push({ id, reason: `N/A - ${evidence}`, citation });
    added['N/A'] += 1;
  } else if (verdict === 'BLOCKED') {
    data.BLOCKED.push({ id, reason: evidence, needs: NEEDS[id] ?? '(see log)', citation });
    added.BLOCKED += 1;
  } else {
    skipped.push(`${id} (${verdict})`);
  }
}

for (const [k, f] of Object.entries(files)) {
  console.log(`${k.padEnd(8)} ${before[k]} -> ${data[k].length} (+${added[k]})`);
  if (write) fs.writeFileSync(f, JSON.stringify(data[k], null, 1) + '\n', 'utf8');
}
if (skipped.length) console.log(`not fixtures: ${skipped.join(', ')}`);
console.log(write ? 'wrote fixtures' : '(dry run — pass --write to persist)');
