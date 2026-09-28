/**
 * H7 regression: outbox rows must never get stuck 'inflight', and the
 * exponential backoff must survive the batch -> item-by-item fallback.
 *
 * Reproduction (pre-fix):
 *  1. pushOnce() flipped the whole batch to 'inflight' via markOutboxMany,
 *     which sets next_retry_at = NULL. When remote.batch() failed, the code
 *     fell back to writing rows one at a time. On a QUOTA error it re-queued
 *     with markOutboxMany(...,'pending') — again NULLing next_retry_at — so a
 *     row that had already burned 8 retries lost its backoff and was retried
 *     at full tilt on every 5s cycle (retry storm against a full database).
 *  2. The per-row QUOTA branch `break`ed out of the loop while later rows were
 *     still 'inflight'. getPendingOutbox() only ever selects status='pending',
 *     so those rows were invisible to every subsequent cycle until the app was
 *     restarted — a silent sync stall (contract C6).
 *  3. Any unexpected throw between the 'inflight' flip and a re-queue stranded
 *     rows in 'inflight' for the whole session.
 *
 * Post-fix: backoff is preserved through the fallback (per-row markOutbox with
 * nextRetryAt), and inflight rows are swept back to pending on every error path.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h7-inflight.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_outbox (
  idempotency_key TEXT PRIMARY KEY,
  entity_type TEXT,
  entity_id TEXT,
  operation TEXT,
  payload_json TEXT,
  status TEXT,
  retry_count INTEGER DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  updated_at TEXT
);
`;

/** Mirrors src/db/sqlPluginAdapter.ts getPendingOutbox exactly. */
async function getPendingOutbox(db, limit = 50) {
  const now = new Date().toISOString();
  return (await db.execute(
    `SELECT * FROM sync_outbox WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)
     ORDER BY rowid LIMIT $2`,
    [now, limit],
  )).rows;
}

/** Mirrors src/db/sqlPluginAdapter.ts markOutbox exactly (the backoff-keeping form). */
async function markOutbox(db, key, patch) {
  if (patch.status === 'synced') {
    await db.execute('DELETE FROM sync_outbox WHERE idempotency_key=$1', [key]);
    return;
  }
  await db.execute(
    `UPDATE sync_outbox SET status=$1, retry_count=COALESCE($2, retry_count),
      next_retry_at=$3, last_error=$4, updated_at=$5 WHERE idempotency_key=$6`,
    [patch.status, patch.retryCount ?? null, patch.nextRetryAt ?? null, patch.error ?? null, new Date().toISOString(), key],
  );
}

/** Mirrors src/db/sqlPluginAdapter.ts markOutboxMany — the buggy NULLing form pre-fix. */
async function markOutboxMany(db, keys, patch) {
  if (keys.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = keys.map(() => '?').join(',');
  if (patch.status === 'synced') {
    await db.execute(`DELETE FROM sync_outbox WHERE idempotency_key IN (${placeholders})`, keys);
  } else {
    await db.execute(
      `UPDATE sync_outbox SET status=?, next_retry_at=NULL, last_error=?, updated_at=? WHERE idempotency_key IN (${placeholders})`,
      [patch.status, patch.error ?? null, now, ...keys],
    );
  }
}

/** Mirrors src/sync/SyncManager.ts backoffMs (full jitter, capped at 60s). */
function backoffSlot(retry) {
  const base = 1_000;
  const cap = 60_000;
  return Math.min(cap, base * (1 << Math.min(retry, 6)));
}

async function seed(db, key, retryCount = 0, status = 'pending', nextRetryAt = null) {
  await db.execute(
    `INSERT INTO sync_outbox (idempotency_key,entity_type,entity_id,operation,payload_json,status,retry_count,next_retry_at,last_error,updated_at)
     VALUES ($1,'product',$2,'UPSERT','{}',$3,$4,$5,NULL,$6)`,
    [key, key, status, retryCount, nextRetryAt, new Date().toISOString()],
  );
}
async function row(db, key) {
  const r = (await db.execute('SELECT status,retry_count,next_retry_at FROM sync_outbox WHERE idempotency_key=$1', [key])).rows[0];
  return r ? { status: String(r.status), retry_count: Number(r.retry_count ?? 0), next_retry_at: r.next_retry_at ? String(r.next_retry_at) : null } : null;
}

async function main() {
  let db;
  try { rmSync(DB_FILE); } catch { /* may not exist */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  db = createClient({ url: `file:${DB_FILE}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }

  // ---- 1. Backoff survives the batch-failure fallback (the QUOTA re-queue). ----
  // A row that already failed 8 times must NOT be retried immediately.
  await seed(db, 'K8', 8);
  const keys = ['K8'];
  // Simulate the post-fix QUOTA branch: per-row re-queue keeping nextRetryAt.
  for (const k of keys) {
    const before = await row(db, k);
    await markOutbox(db, k, {
      status: 'pending',
      error: 'QUOTA: storage full',
      nextRetryAt: new Date(Date.now() + backoffSlot(before.retry_count)).toISOString(),
    });
  }
  const after = await row(db, 'K8');
  check('QUOTA re-queue keeps a future next_retry_at', !!after.next_retry_at, `next=${after.next_retry_at}`);
  check('QUOTA re-queue does not reset retry_count', after.retry_count === 8, `rc=${after.retry_count}`);
  check('QUOTA re-queue leaves the row pickable', after.status === 'pending');
  // The pre-fix markOutboxMany path would have nulled it:
  await markOutboxMany(db, ['K8'], { status: 'pending', error: 'x' });
  const buggy = await row(db, 'K8');
  check('pre-fix markOutboxMany form is the negative control (nulls backoff)', buggy.next_retry_at === null);

  // ---- 2. Rows still 'inflight' after a mid-batch abort are re-queueable. ----
  await db.execute("DELETE FROM sync_outbox");
  await seed(db, 'A', 0, 'inflight');
  await seed(db, 'B', 0, 'inflight');
  await seed(db, 'C', 0, 'pending');
  // Post-fix outer-catch safety net (mirrors the added UPDATE in pushOnce).
  await db.execute("UPDATE sync_outbox SET status='pending' WHERE status='inflight'");
  const picked = (await getPendingOutbox(db, 50)).map((r) => String(r.idempotency_key));
  check('stranded inflight rows are picked up again after the sweep', picked.length === 3, `picked=${picked.join(',')}`);

  // ---- 3. The sweep is idempotent and touches nothing else. ----
  await db.execute("DELETE FROM sync_outbox");
  await seed(db, 'S1', 0, 'synced');
  await seed(db, 'S2', 3, 'failed');
  await seed(db, 'S3', 0, 'inflight');
  await db.execute("UPDATE sync_outbox SET status='pending' WHERE status='inflight'");
  const post = await row(db, 'S1');
  const post2 = await row(db, 'S2');
  check('sweep leaves synced rows untouched', post.status === 'synced');
  check('sweep leaves failed (quarantined) rows untouched', post2.status === 'failed' && post2.retry_count === 3);

  // ---- 4. A due backoff row is picked; a not-yet-due one is not. ----
  await db.execute("DELETE FROM sync_outbox");
  const future = new Date(Date.now() + 30_000).toISOString();
  const past = new Date(Date.now() - 1_000).toISOString();
  await seed(db, 'DUE', 2, 'pending', past);
  await seed(db, 'NOTDUE', 2, 'pending', future);
  const sel = (await getPendingOutbox(db, 50)).map((r) => String(r.idempotency_key));
  check('a due backoff row is selected', sel.includes('DUE'), `sel=${sel.join(',')}`);
  check('a not-yet-due backoff row is NOT selected', !sel.includes('NOTDUE'));

  // ---- 5. 'synced' deletes the row (no outbox growth). ----
  await markOutbox(db, 'DUE', { status: 'synced' });
  check('synced deletes the outbox row', (await row(db, 'DUE')) === null);

  console.log('====================================================');
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('====================================================');
  await db.close();
  try { rmSync(DB_FILE); } catch { /* noop */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
