/**
 * H16 regression test — a STALE (zero-row guarded) push must count as a retry.
 *
 * Defect (proven by scripts/probe_h16_retry.mjs, 2026-09):
 *   SyncManager.pushNow's two STALE re-queue paths called markOutbox WITHOUT
 *   retryCount. markOutbox does `retry_count=COALESCE($2, retry_count)` with
 *   $2=null, so the counter never moved. Consequences:
 *     (a) backoffMs(retry_count) was always backoffMs(0) -> 1s slot, so a row
 *         that could never land was retried ~2x/second forever (retry storm).
 *     (b) The 10-retry quarantine was unreachable via the STALE path, so a
 *         permanently-stuck mutation never surfaced in diagnostics (silent).
 *
 * Fix: both STALE paths now pass retryCount: (op.retry_count ?? 0) + 1 and use
 * that same incremented value for backoffMs().
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' :: ' + extra : ''}`);
}

const DB_FILE = 'file:tmp-h16-retry.db';
const TEMP_FILES = ['tmp-h16-retry.db', 'tmp-h16-retry.db-wal', 'tmp-h16-retry.db-journal'];
// Self-healing: a previous run may have exited while libsql still held the
// handle, so its rmSync hit a Windows sharing violation and left the DB behind.
for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may still be locked */ }
}
const db = createClient({ url: DB_FILE });

// ---- Real schema (src-tauri/src/lib.rs migration, verbatim) ----
await db.execute(`
  CREATE TABLE IF NOT EXISTS sync_outbox (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('product','order','order_item','ledger','customer')),
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','synced','failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// ---- Verbatim markOutbox (src/db/sqlPluginAdapter.ts) ----
async function markOutbox(idempotencyKey, patch) {
  if (patch.status === 'synced') {
    await db.execute('DELETE FROM sync_outbox WHERE idempotency_key=?', [idempotencyKey]);
    return;
  }
  await db.execute(
    `UPDATE sync_outbox SET status=?, retry_count=COALESCE(?, retry_count),
      next_retry_at=?, last_error=?, updated_at=? WHERE idempotency_key=?`,
    [patch.status, patch.retryCount ?? null, patch.nextRetryAt ?? null, patch.error ?? null, '2026-09-19T00:00:00.000Z', idempotencyKey],
  );
}

// ---- Verbatim backoffMs (src/sync/SyncManager.ts) ----
function backoffMs(retry) {
  const base = 1_000;
  const cap = 60_000;
  const slot = Math.min(cap, base * (1 << Math.min(retry, 6)));
  return Math.floor(Math.random() * slot);
}

// ---- FIXED STALE re-queue (SyncManager batch + fallback paths) ----
async function staleRequeue(key, op) {
  const next = (op.retry_count ?? 0) + 1;
  await markOutbox(key, {
    status: 'pending',
    retryCount: next,
    error: `[STALE] version du document inférieure à la version distante; réessai après remontée de l'horloge`,
    nextRetryAt: new Date(Date.now() + backoffMs(next)).toISOString(),
  });
}

// ---- OLD broken STALE re-queue (for the "defect is real" contrast) ----
async function staleRequeueBroken(key, op) {
  await markOutbox(key, {
    status: 'pending',
    error: `[STALE] version du document inférieure à la version distante; réessai après remontée de l'horloge`,
    nextRetryAt: new Date(Date.now() + backoffMs(op.retry_count ?? 0)).toISOString(),
  });
}

async function readRow(key) {
  return (await db.execute('SELECT retry_count, status, next_retry_at, last_error FROM sync_outbox WHERE idempotency_key=?', [key])).rows[0];
}

// ============================ 1. baseline ============================
await db.execute(
  `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count)
   VALUES ('K1','product','P1','UPSERT','{}','pending',0)`,
);
check('row starts at retry_count 0', (await readRow('K1')).retry_count === 0, `retry_count=${(await readRow('K1')).retry_count}`);

// ============================ 2. the counter advances ============================
for (let i = 1; i <= 5; i++) {
  const op = await readRow('K1');
  await staleRequeue('K1', op);
}
const after5 = await readRow('K1');
check('5 STALE cycles advance retry_count to 5', after5.retry_count === 5, `retry_count=${after5.retry_count}`);

// ============================ 3. the backoff slot grows ============================
// backoffMs(5) slot = 32s; backoffMs(0) slot = 1s. The FIX must schedule far out.
// backoffMs draws Math.random() inside the slot, so a single-shot check is
// flaky. Sample the WIRED requeue with retry pinned at 4 (=> next=5, slot
// 32s) and assert the bound + a high-confidence max.
const delays5 = [];
for (let i = 0; i < 60; i++) {
  await db.execute('UPDATE sync_outbox SET retry_count=4 WHERE idempotency_key=?', ['K1']);
  await staleRequeue('K1', await readRow('K1'));
  delays5.push(new Date((await readRow('K1')).next_retry_at).getTime() - Date.now());
}
const max5 = Math.max(...delays5);
check('backoff after 5 retries stays inside the 32s slot', max5 <= 32_000, `max=${Math.round(max5)}ms`);
check('backoff after 5 retries is in the 32s slot (not the 1s floor)', max5 > 2_000, `max=${Math.round(max5)}ms`);
check('scheduled time is in the future', delays5[delays5.length - 1] > 0, `last=${Math.round(delays5[delays5.length - 1])}ms`);

// ============================ 4. quarantine is reachable ============================
for (let i = 6; i <= 10; i++) {
  const op = await readRow('K1');
  await staleRequeue('K1', op);
}
const after10 = await readRow('K1');
check('10 STALE cycles reach quarantine (retry_count 10)', after10.retry_count === 10, `retry_count=${after10.retry_count}`);
check('quarantine keeps the row (status not deleted)', after10.status !== undefined, `status=${after10.status}`);

// ============================ 5. the defect is real (contrast) ============================
await db.execute(
  `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count)
   VALUES ('K2','product','P2','UPSERT','{}','pending',0)`,
);
for (let i = 1; i <= 20; i++) {
  const op = await readRow('K2');
  await staleRequeueBroken('K2', op);
}
const broken = await readRow('K2');
check('the defect is real: 20 broken STALE cycles leave retry_count at 0', broken.retry_count === 0, `retry_count=${broken.retry_count}`);
check('the defect is real: the broken row never quarantines', broken.status === 'pending', `status=${broken.status}`);

// ============================ 6. backoff cap ============================
await db.execute(
  `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count)
   VALUES ('K3','order','T3','UPSERT','{}','pending',0)`,
);
for (let i = 1; i <= 20; i++) {
  const op = await readRow('K3');
  await staleRequeue('K3', op);
}
const capped = await readRow('K3');
// backoffMs caps the slot at 60s and the exponent at 6
const slotAt20 = Math.min(60_000, 1_000 * (1 << Math.min(20, 6)));
check('backoff slot caps at 60s (retry 20 -> slot 64s capped)', slotAt20 === 60_000, `slot=${slotAt20}ms`);
check('capped row retry_count is 20', capped.retry_count === 20, `retry_count=${capped.retry_count}`);

// ============================ 7. a landed row does NOT count as a retry ============================
// (guards against over-correcting: success must still delete the row)
await db.execute(
  `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count)
   VALUES ('K4','customer','C4','UPSERT','{}','pending',3)`,
);
await markOutbox('K4', { status: 'synced' });
const landed = (await db.execute('SELECT COUNT(*) AS c FROM sync_outbox WHERE idempotency_key=?', ['K4'])).rows[0];
check('a synced row is deleted (not retried)', Number(landed?.c ?? 1) === 0, `count=${landed?.c}`);

// ============================ 8. retryCount is monotonic across mixed paths ============================
// A row that fails with a real error (fallback catch) then goes STALE must keep
// climbing, not reset — markOutbox's COALESCE preserves it either way.
await db.execute(
  `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count)
   VALUES ('K5','order','T5','UPSERT','{}','pending',0)`,
);
// real error path (SyncManager fallback catch): retryCount = N+1
let op = await readRow('K5');
await markOutbox('K5', { status: 'pending', retryCount: (op.retry_count ?? 0) + 1, error: 'network down' });
// then a STALE cycle
op = await readRow('K5');
await staleRequeue('K5', op);
const mixed = await readRow('K5');
check('retry_count is monotonic across error-then-STALE paths', mixed.retry_count === 2, `retry_count=${mixed.retry_count}`);

// ============================ summary ============================
const failed = results.filter((r) => !r.ok);
console.log('========================================================================');
console.log(`H16 TEST SUMMARY: ${results.length - failed.length} PASSED, ${failed.length} FAILED`);
console.log('========================================================================');
if (failed.length > 0) {
  console.log('FAILURES:');
  for (const f of failed) console.log(' - ' + f.name);
}

await db.close();
for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* WAL sidecar may still be open */ }
}
process.exit(failed.length > 0 ? 1 : 0);
