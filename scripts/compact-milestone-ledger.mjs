/**
 * D6 migration — compact per-tranche milestone ledger rows into RANGE rows.
 *
 * The code reads BOTH forms (legacy single rows are ranges of one), so this is a
 * size migration, not a correctness one. It is therefore dry-run by default and
 * refuses to write without an explicit --apply plus a backup copy.
 *
 * Usage:
 *   node scripts/compact-milestone-ledger.mjs <db> [--apply]
 *
 * Safety: with --apply the DB file (+ -wal/-shm) is copied to
 *   <db>.backup-<utc> BEFORE any write, and every customer row is updated in a
 *   single transaction per customer.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error('usage: compact-milestone-ledger.mjs <db> [--apply]');
  process.exit(2);
}

const RANGE = /^(.+):tranche:(\d+)(:clawback:(.+))?$/;

function groupRuns(ledger) {
  // Walk the ledger in order; compact maximal runs of single-tranche entries that
  // share (milestoneId, clawback-txn) and are consecutive.
  const out = [];
  let i = 0;
  let compacted = 0;
  while (i < ledger.length) {
    const e = ledger[i];
    const ref = String(e?.referenceId ?? '');
    const m = ref.match(RANGE);
    if (!m) {
      out.push(e);
      i += 1;
      continue;
    }
    const prefix = m[1];
    const claw = m[3] ? m[4] : null;
    let j = i;
    let count = 0;
    let last = Number(m[2]);
    let first = last;
    let credit = 0;
    let points = 0;
    while (j < ledger.length) {
      const c = ledger[j];
      const r = String(c?.referenceId ?? '').match(RANGE);
      if (!r) break;
      if (r[1] !== prefix) break;
      const cClaw = r[3] ? r[4] : null;
      if (cClaw !== claw) break;
      const n = Number(r[2]);
      if (j > i && n !== last + 1) break;
      count += 1;
      last = n;
      credit += Number(c.creditDeltaDzd ?? 0);
      points += Number(c.points ?? 0);
      j += 1;
    }
    if (count <= 1) {
      out.push(e);
      i += 1;
      continue;
    }
    const head = { ...e };
    head.referenceId = `${prefix}:tranches:${first}-${last}${claw ? `:clawback:${claw}` : ''}`;
    head.creditDeltaDzd = credit;
    if (Number.isFinite(points)) head.points = points;
    head.description = String(e.description ?? '').replace(
      /Tranche \d+/,
      `Tranches ${first} a ${last}`,
    );
    out.push(head);
    compacted += count - 1;
    i = j;
  }
  return { ledger: out, compacted };
}

const backupSuffix = `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const db = new Database(dbPath, { readonly: !apply });
const customers = db.prepare("SELECT id, json_payload, LENGTH(json_payload) AS len FROM customers WHERE deleted = 0").all();

let rowsBefore = 0;
let rowsAfter = 0;
let customersTouched = 0;
let bytesBefore = 0;
let bytesAfter = 0;
const planned = [];

for (const c of customers) {
  let payload;
  try {
    payload = JSON.parse(String(c.json_payload ?? '{}'));
  } catch {
    continue;
  }
  const ledger = Array.isArray(payload.ledger) ? payload.ledger : [];
  if (ledger.length === 0) continue;
  const { ledger: compacted, compacted: removed } = groupRuns(ledger);
  if (removed === 0) continue;
  const next = { ...payload, ledger: compacted };
  const json = JSON.stringify(next);
  rowsBefore += ledger.length;
  rowsAfter += compacted.length;
  bytesBefore += Number(c.len ?? 0);
  bytesAfter += json.length;
  customersTouched += 1;
  planned.push({ id: c.id, json, removed, before: ledger.length, after: compacted.length });
}

console.log(`[compact] db=${dbPath} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`[compact] customers touched: ${customersTouched}`);
console.log(`[compact] ledger rows: ${rowsBefore} -> ${rowsAfter} (removed ${rowsBefore - rowsAfter})`);
console.log(`[compact] payload bytes: ${bytesBefore} -> ${bytesAfter}`);
console.log(`[compact] roughly ${(bytesBefore / 1048576).toFixed(1)} MB -> ${(bytesAfter / 1048576).toFixed(1)} MB`);

if (!apply) {
  console.log('[compact] dry run only - re-run with --apply to write (a backup is taken first)');
  process.exit(0);
}

const backup = `${dbPath}${backupSuffix}`;
fs.copyFileSync(dbPath, backup);
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(`${dbPath}${suffix}`)) fs.copyFileSync(`${dbPath}${suffix}`, `${backup}${suffix}`);
}
console.log(`[compact] backup written: ${backup}`);

const update = db.prepare('UPDATE customers SET json_payload = ?, version = version + 1, updated_at = ? WHERE id = ?');
const now = new Date().toISOString();
const tx = db.transaction((items) => {
  for (const it of items) update.run(it.json, now, it.id);
});
tx(planned);
db.close();
console.log(`[compact] applied to ${planned.length} customer(s)`);
