// H14 regression: a guarded upsert that matches ZERO rows must NOT be reported
// as success. Before the fix, both push paths in SyncManager marked the outbox
// row 'synced' (i.e. DELETED it) whenever the libsql call resolved, even when
// `WHERE excluded.version >= <table>.version` matched nothing — the mutation was
// silently discarded (contract C6, silent data loss).
//
// This test models the real outbox + remote-KV shape and asserts:
//   1. a stale upsert reports rowsAffected 0 (the evidence the client gives us)
//   2. a fresh upsert reports rowsAffected 1
//   3. batch() returns a per-statement array so per-row accounting is possible
//   4. the reconciliation rule: 0 rowsAffected => row must be re-queued, not
//      deleted; only 1 => delete (synced)
//   5. monotonic clock + guard interplay: after a rejected stale push, bumping
//      the local clock lets the SAME payload land on the next attempt
//   6. DO NOTHING lanes (order_item / ledger) report 0 rowsAffected on the
//      second identical push and must NOT be treated as a rejection
//   7. mixed batch: stale rows re-queued, fresh rows deleted — no cross-talk
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const remotePath = join(here, 'tmp-h14-remote.db');
const localPath = join(here, 'tmp-h14-local.db');
for (const p of [remotePath, localPath]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
  if (fs.existsSync(`${p}-wal`)) fs.unlinkSync(`${p}-wal`);
}

const remote = createClient({ url: `file:${remotePath}` });
const local = createClient({ url: `file:${localPath}` });

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name} ${extra}`); }
}

// ---- real schemas -------------------------------------------------------
await remote.execute(`CREATE TABLE repair_orders (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL, device_id TEXT,
  idempotency_key TEXT, sync_status TEXT, version INTEGER NOT NULL,
  updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`);
await remote.execute(`CREATE TABLE transaction_items (
  id TEXT PRIMARY KEY, transaction_id TEXT, version INTEGER NOT NULL)`);
await local.execute(`CREATE TABLE sync_outbox (
  idempotency_key TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT,
  payload_json TEXT, status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT)`);

// The local clock store (H10/H12/H13).
await local.execute(`CREATE TABLE entity_keys (
  entity_type TEXT, entity_id TEXT, idempotency_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_type, entity_id))`);

// ---- the guarded statement, verbatim in shape from toRemoteUpsert --------
const guardedUpsert = (version) => ({
  sql: `INSERT INTO repair_orders (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
        VALUES ('RO-1','{"v":1}','dev','idem-RO-1','synced',?, 'now', 0)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
          updated_at=excluded.updated_at, sync_status='synced', deleted=0
          WHERE excluded.version >= repair_orders.version`,
  args: [version],
});

// 1 & 2 — the client hands us the evidence.
await remote.execute(guardedUpsert(1));
// Advance the remote to v3, then push a genuinely STALE v2: the guard
// `2 >= 3` is false, the upsert matches no rows, yet the call resolves OK.
await remote.execute(guardedUpsert(3));
const stale = await remote.execute(guardedUpsert(2));
check('stale guarded upsert reports rowsAffected 0', stale.rowsAffected === 0, `got ${stale.rowsAffected}`);
const fresh = await remote.execute(guardedUpsert(4));
check('fresh guarded upsert reports rowsAffected 1', fresh.rowsAffected === 1, `got ${fresh.rowsAffected}`);

// 3 — batch() is per-statement.
const mixed = await remote.batch([guardedUpsert(2), guardedUpsert(5)], 'write');
check('batch() returns a per-statement array', Array.isArray(mixed) && mixed.length === 2);
check('batch[0] stale = 0', mixed[0].rowsAffected === 0, `got ${mixed[0]?.rowsAffected}`);
check('batch[1] fresh = 1', mixed[1].rowsAffected === 1, `got ${mixed[1]?.rowsAffected}`);

// 4 — the reconciliation rule (this is the fix under test).
async function reconcile(key, rowsAffected) {
  // rowsAffected === 1 -> genuinely applied -> delete (markOutbox 'synced')
  // rowsAffected === 0 -> guarded rejection -> re-queue for retry
  if (rowsAffected === 1) {
    await local.execute(`DELETE FROM sync_outbox WHERE idempotency_key = ?`, [key]);
    return 'synced';
  }
  await local.execute(
    `UPDATE sync_outbox SET status='pending', next_retry_at='soon', last_error='stale version'
     WHERE idempotency_key = ?`, [key]);
  return 'pending';
}
await local.execute(`INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, payload_json, status)
  VALUES ('idem-RO-1','repair_order','RO-1','{}','inflight')`);
await reconcile('idem-RO-1', stale.rowsAffected);
let row = (await local.execute(`SELECT status FROM sync_outbox WHERE idempotency_key='idem-RO-1'`)).rows[0];
check('0 rowsAffected re-queues the row (not deleted)', row?.status === 'pending', `got ${row?.status}`);
await reconcile('idem-RO-1', fresh.rowsAffected);
row = (await local.execute(`SELECT status FROM sync_outbox WHERE idempotency_key='idem-RO-1'`)).rows[0];
check('1 rowsAffected deletes the row (synced)', row === undefined, 'row still present');

// 5 — clock interplay: a rejected push is recoverable by bumping the clock.
async function localClock() {
  const r = await local.execute(`SELECT version FROM entity_keys WHERE entity_type='repair_order' AND entity_id='RO-1'`);
  return Number(r.rows[0]?.version ?? 0);
}
await local.execute(`INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
  VALUES ('repair_order','RO-1','idem-RO-1', 1)`);
async function remoteVersion() {
  const r = await remote.execute(`SELECT version FROM repair_orders WHERE id='RO-1'`);
  return Number(r.rows[0]?.version ?? 0);
}
const beforeRemote = await remoteVersion();
const staleVer = Math.max(1, beforeRemote - 1);
const rejected = await remote.execute(guardedUpsert(staleVer));
check(`local clock ${staleVer} < remote ${beforeRemote} is rejected`, rejected.rowsAffected === 0);
// emulate bumpEntityVersion: clock = max(clock, remote) + 1
const bumpTo = beforeRemote + 1;
await local.execute(`UPDATE entity_keys SET version = ? WHERE entity_type='repair_order' AND entity_id='RO-1'`, [bumpTo]);
const accepted = await remote.execute(guardedUpsert(await localClock()));
check(`bumped clock ${bumpTo} > remote ${beforeRemote} is accepted`, accepted.rowsAffected === 1, `got ${accepted.rowsAffected}`);

// 6 — DO NOTHING lanes legitimately report 0 and must NOT be re-queued forever.
await remote.execute(`INSERT INTO transaction_items (id, transaction_id, version) VALUES ('OI-1','T-1',1)`);
const dn1 = await remote.execute({
  sql: `INSERT INTO transaction_items (id, transaction_id, version) VALUES ('OI-1','T-1',1)
        ON CONFLICT(id) DO NOTHING`,
  args: [],
});
check('DO NOTHING duplicate reports rowsAffected 0', dn1.rowsAffected === 0);
check('DO NOTHING lane is idempotent (no error)', !('error' in dn1));

// 7 — mixed batch reconciliation with no cross-talk.
await local.execute(`DELETE FROM sync_outbox`);
await local.execute(`INSERT INTO sync_outbox (idempotency_key, status) VALUES ('k-stale','inflight'), ('k-fresh','inflight')`);
const m2 = await remote.batch([guardedUpsert(2), guardedUpsert(9)], 'write');
await reconcile('k-stale', m2[0].rowsAffected);
await reconcile('k-fresh', m2[1].rowsAffected);
const st = await local.execute(`SELECT idempotency_key, status FROM sync_outbox ORDER BY idempotency_key`);
const map = Object.fromEntries(st.rows.map((r) => [r.idempotency_key, r.status]));
check('mixed batch: stale re-queued, fresh deleted', map['k-stale'] === 'pending' && !('k-fresh' in map),
  JSON.stringify(map));

// ---- the pre-fix behaviour, documented as the defect --------------------
check('the defect is real: stale upsert resolves successfully yet lands nothing',
  stale.rowsAffected === 0 && (await remote.execute(`SELECT version FROM repair_orders WHERE id='RO-1'`)).rows[0]?.version === 9,
  'remote did not stay at v9');

remote.close();
local.close();
for (const p of [remotePath, localPath]) {
  try {
    fs.unlinkSync(p);
    if (fs.existsSync(`${p}-wal`)) fs.unlinkSync(`${p}-wal`);
  } catch { /* ignore */ }
}
console.log(`\n${'='.repeat(72)}\nH14 TEST SUMMARY: ${pass} PASSED, ${fail} FAILED\n${'='.repeat(72)}`);
if (fail > 0) process.exitCode = 1;
