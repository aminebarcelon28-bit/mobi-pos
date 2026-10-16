// Targeted requeue: sync_outbox rows quarantined by the 2026-10-16
// sale_batch_allocations push defects (commit 3653e523).
//
// Two failure windows, both local to the SBA lane; the payloads never reached
// the cloud, so replaying them is the repair:
//   1. 14:47 → fix: push SQL built 13 placeholders for 14 columns —
//      "SQLITE_UNKNOWN: SQLite error: 13 values for 14 columns" (10 strikes
//      → status='failed').
//   2. Before 14:47: no structured mapping existed, toRemoteUpsert() returned
//      null — "Payload non sérialisable ou entité non reconnue" (status='failed',
//      retry_count 0).
//
// Default mode is READ-ONLY inspection. The write happens only with --apply:
//   node scripts/requeue_quarantined_sba_outbox.mjs                 # inspect
//   node scripts/requeue_quarantined_sba_outbox.mjs --apply        # requeue (backup first)
//   node scripts/requeue_quarantined_sba_outbox.mjs --db <path>    # non-default DB
//
// Safety rules baked in (fail closed):
//   - Only status='failed' rows whose entity is sale_batch_allocations AND
//     whose last_error matches one of the two known signatures are touched.
//   - Every candidate payload must parse as JSON and carry id/sale_id/batch_id
//     (else the whole run aborts — unknown rows are for human review).
//   - A consistent snapshot (VACUUM INTO) is written NEXT TO the DB before
//     any UPDATE; the timestamped file is printed.
//   - All updates run in one BEGIN IMMEDIATE transaction.
//   - Requires the FIXED build to be the one that will next process the
//     outbox. Requeueing while the old (buggy) build is running re-quarantines
//     the rows after 10 fresh strikes.
//   - Close the app first; a held write lock aborts the run.
//
// After --apply: start the fixed app, let sync drain, then verify (inspect
// mode) that no rows with these signatures remain.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const SIGNATURE_314 = '13 values for 14 columns';
const SIGNATURE_UNMAPPED = 'Payload non sérialisable ou entité non reconnue';

function defaultDbPath() {
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'com.mobi.pos', 'mobi_pos.db');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'com.mobi.pos', 'mobi_pos.db');
  }
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'com.mobi.pos', 'mobi_pos.db');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node scripts/requeue_quarantined_sba_outbox.mjs [--db <path>] [--apply]');
  process.exit(0);
}
const apply = args.includes('--apply');
const dbArgIdx = args.indexOf('--db');
const dbPath = dbArgIdx !== -1 ? args[dbArgIdx + 1] : defaultDbPath();
if (!dbPath || !existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(2);
}
console.log(`DB      : ${dbPath}`);
console.log(`mode    : ${apply ? 'APPLY (writes + backup)' : 'inspect (read-only)'}\n`);

const isCandidateError = (le) =>
  typeof le === 'string' && (le.includes(SIGNATURE_314) || le === SIGNATURE_UNMAPPED);

function collectCandidates(db) {
  const rows = db
    .prepare(
      `SELECT rowid, idempotency_key, entity_type, entity_id, operation, status, retry_count,
              next_retry_at, seq_no, last_error, payload_json, updated_at
       FROM sync_outbox
       WHERE status='failed'
         AND entity_type IN ('sale_batch_allocations','sale_batch_allocation')
         AND (last_error LIKE ? OR last_error = ?)
       ORDER BY updated_at`,
    )
    .all(`%${SIGNATURE_314}%`, SIGNATURE_UNMAPPED);
  return rows.map((r) => {
    const problems = [];
    let payload = null;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      problems.push('payload is not valid JSON');
    }
    if (payload && typeof payload === 'object') {
      for (const field of ['id', 'sale_id', 'batch_id']) {
        if (typeof payload[field] !== 'string' || payload[field].length === 0) {
          problems.push(`payload.${field} missing/empty`);
        }
      }
    } else if (payload !== null) {
      problems.push('payload is not an object');
    }
    if (!isCandidateError(r.last_error)) problems.push('last_error does not match a known signature');
    return { ...r, problems };
  });
}

function reportOthers(db) {
  const others = db
    .prepare(
      `SELECT entity_type, COUNT(*) n FROM sync_outbox
       WHERE status='failed' AND NOT (entity_type IN ('sale_batch_allocations','sale_batch_allocation')
         AND (last_error LIKE ? OR last_error = ?))
       GROUP BY entity_type ORDER BY n DESC`,
    )
    .all(`%${SIGNATURE_314}%`, SIGNATURE_UNMAPPED);
  if (others.length > 0) {
    console.log('Other quarantined rows (NOT touched by this tool):', JSON.stringify(others));
  }
}

const ro = new DatabaseSync(dbPath, { readOnly: true });
const hasTable = ro.prepare("SELECT name FROM sqlite_master WHERE name='sync_outbox' AND type='table'").get();
if (!hasTable) {
  console.error('sync_outbox table not found — wrong DB?');
  process.exit(2);
}
const candidates = collectCandidates(ro);
reportOthers(ro);
ro.close();

if (candidates.length === 0) {
  console.log('No quarantined sale_batch_allocations rows with the known signatures. Nothing to do.');
  process.exit(0);
}

console.log(`\nCandidates (${candidates.length}):`);
for (const c of candidates) {
  const state = c.problems.length === 0 ? 'OK' : `REFUSED: ${c.problems.join('; ')}`;
  const signed = c.seq_no === null || c.seq_no === undefined ? '' : ' [SIGNED-LANE row]';
  console.log(`  - ${c.idempotency_key}`);
  console.log(`      retries=${c.retry_count} next_retry_at=${c.next_retry_at} updated=${c.updated_at}${signed}`);
  console.log(`      ${String(c.last_error).slice(0, 120)}`);
  console.log(`      ${state}`);
}

const rejected = candidates.filter((c) => c.problems.length > 0);
if (rejected.length > 0) {
  console.error(`\n${rejected.length} candidate(s) failed validation — refusing to touch ANY row.`);
  process.exit(2);
}
if (!apply) {
  console.log(`\n${candidates.length} row(s) would be requeued (status='pending', retry_count=0).`);
  console.log('Re-run with --apply to execute. Close the app first.');
  process.exit(0);
}

// ---------------- apply ----------------
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');
const stamp = new Date().toISOString().replace(/[:.]/g, '');
const backupPath = join(join(dbPath, '..'), `${basename(dbPath)}.pre-requeue-${stamp}.db`);
if (existsSync(backupPath)) {
  console.error(`Backup target already exists: ${backupPath}`);
  process.exit(2);
}
try {
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`);
  console.log(`\nBackup written: ${backupPath}`);
} catch (e) {
  console.error(`Backup failed (${e.message}) — nothing was written. Close the app and retry.`);
  process.exit(2);
}

const now = new Date().toISOString();
try {
  db.exec('BEGIN IMMEDIATE;');
  let changed = 0;
  for (const c of candidates) {
    const res = db
      .prepare(
        `UPDATE sync_outbox
         SET status='pending', retry_count=0, next_retry_at=NULL,
             last_error = last_error || ' [requeued: SBA push lane fixed @' || ? || ']',
             updated_at = ?
         WHERE idempotency_key = ? AND status='failed'`,
      )
      .run(now, now, c.idempotency_key);
    changed += Number(res.changes);
  }
  if (changed !== candidates.length) {
    throw new Error(`updated ${changed} of ${candidates.length} rows`);
  }
  db.exec('COMMIT;');
  console.log(`Requeued ${changed} row(s) to 'pending'.`);
} catch (e) {
  try { db.exec('ROLLBACK;'); } catch { /* already rolled back */ }
  console.error(`Requeue FAILED and was rolled back: ${e.message}`);
  process.exit(2);
} finally {
  db.close();
}

console.log(
  [
    '',
    'Next steps:',
    '  1. Start the FIXED app build (with the sale_batch_allocations push fix).',
    '  2. Let sync run; the rows drain pending -> inflight -> synced (deleted).',
    '  3. Re-run this script (inspect mode): candidates must be 0.',
    '  Alternative built-in path: Sync Diagnostics / "Synchronisation complete"',
    "  (requeues ALL failed rows, including unrelated GUARD-STALE stubs).",
  ].join('\n'),
);
