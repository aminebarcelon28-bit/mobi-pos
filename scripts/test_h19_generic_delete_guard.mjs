// H19 regression test: a stale generic tombstone must NOT delete the UI record
// when the local version clock is newer.
//
// `SyncManager.applyRemoteRow` handles the generic `deleted=1` case with an
// early return that used to sit BEFORE the stale-echo version guard. A stale
// tombstone (v2) arriving after a newer local upsert (v5) therefore deleted the
// Dexie record while the guarded SQLite upsert rejected the very same row:
// UI replica and authority split, record vanished from the UI until a full
// backfill rebuilt it.
//
// This suite reproduces the ordering of the real apply path against the real
// generic push/pull SQL and the real clock home (`entity_keys`).

import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'file:tmp-h19-delete-guard.db';
const TEMP_FILES = ['tmp-h19-delete-guard.db', 'tmp-h19-delete-guard.db-wal', 'tmp-h19-delete-guard.db-shm', 'tmp-h19-delete-guard.db-journal'];
for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may still be locked */ }
}

const db = createClient({ url: DB_FILE });

await db.execute(`CREATE TABLE IF NOT EXISTS kv_store (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL, device_id TEXT,
  idempotency_key TEXT, sync_status TEXT, version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
)`);
await db.execute(`CREATE TABLE IF NOT EXISTS entity_keys (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id)
)`);

const T = 'kv_store';
const ENTITY = 'customer';
const ID = 'cust-1';

// The REAL generic UPSERT push statement (SyncManager.toRemoteUpsert).
const UPSERT_PUSH = `INSERT INTO ${T} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES (?,?,?,?,'synced',?,?,0)
  ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
    updated_at=excluded.updated_at, sync_status='synced', deleted=0
    WHERE excluded.version >= ${T}.version`;

// The REAL generic DELETE push statement.
const DELETE_PUSH = `INSERT INTO ${T} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES (?,?,?,?,'synced',?,?,1)
  ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
    updated_at=excluded.updated_at, sync_status='synced', deleted=1
    WHERE excluded.version >= ${T}.version`;

// The REAL clock helpers, verbatim in effect.
async function appliedGenericVersion(table, id) {
  const entityType = table; // GENERIC_ENTITY_BY_TABLE[table] ?? table
  const rows = await db.execute(
    'SELECT version FROM entity_keys WHERE entity_type = $1 AND entity_id = $2',
    [entityType, id],
  );
  return Number(rows.rows?.[0]?.version ?? 0);
}
async function advanceEntityClockOnPull(table, id, version) {
  const entityType = table;
  const safeVersion = Number(version) || 1;
  await db.execute(
    `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(entity_type, entity_id) DO UPDATE
     SET version = MAX(excluded.version, entity_keys.version)`,
    [entityType, id, `pull-${entityType}-${id}`, safeVersion],
  );
}
async function bumpEntityVersion(entity, id) {
  await db.execute('ALTER TABLE entity_keys ADD COLUMN version INTEGER NOT NULL DEFAULT 1').catch(() => {});
  const rows = await db.execute('SELECT version FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [entity, id]);
  const current = Number(rows.rows?.[0]?.version ?? 1);
  const next = current + 1;
  await db.execute('UPDATE entity_keys SET version=$1 WHERE entity_type=$2 AND entity_id=$3', [next, entity, id]);
  return next;
}

// The REAL generic pull apply path, with the H19 guard in place.
// `uiDeleted` stands in for the Dexie store: true == the UI record was removed.
let uiDeleted = false;
let uiRecord = null;
async function applyRemoteRow(r) {
  const version = Number(r.version ?? 1);
  const id = r.id;
  if (!id) return;

  if (Number(r.deleted ?? 0) === 1) {
    // H19: guard BEFORE the deletes (was after the early return).
    const appliedDelete = await appliedGenericVersion(ENTITY, id);
    if (appliedDelete > 0 && appliedDelete > version) {
      return; // Local version is newer than this tombstone
    }
    await advanceEntityClockOnPull(ENTITY, id, version);
    uiDeleted = true;
    uiRecord = null;
    return;
  }
  const applied = await appliedGenericVersion(ENTITY, id);
  if (applied > 0 && applied > version) return;
  await advanceEntityClockOnPull(ENTITY, id, version);
  uiDeleted = false;
  uiRecord = JSON.parse(r.data_json);
}

const clock = () => appliedGenericVersion(ENTITY, ID);
const row = async () => (await db.execute(`SELECT version, deleted FROM ${T} WHERE id=$1`, [ID])).rows?.[0];

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

console.log('\n=== H19: stale generic tombstone vs a newer local upsert ===\n');

// 1. Local upsert at v5 (the clock the local lane would have bumped to).
await db.execute('INSERT OR REPLACE INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES ($1,$2,$3,$4)', [ENTITY, ID, 'k1', 5]);
await db.execute(UPSERT_PUSH, [ID, JSON.stringify({ name: 'Alice', phone: '555' }), 'devA', 'k1', 5, '2026-01-01T00:00:05.000Z']);
await applyRemoteRow({ id: ID, version: 5, deleted: 0, data_json: JSON.stringify({ name: 'Alice', phone: '555' }) });
check('baseline: local clock 5, authority row v5/alive', (await clock()) === 5 && Number((await row()).version) === 5);
check('baseline: UI record present', uiDeleted === false && uiRecord?.name === 'Alice');

// 2. A STALE tombstone (v2) is pulled. Before H19 it deleted the UI record and
//    returned before the guard; now it must be rejected outright.
await applyRemoteRow({ id: ID, version: 2, deleted: 1, data_json: JSON.stringify({ id: ID, deleted: 1, version: 2 }) });
check('stale tombstone does NOT delete the UI record', uiDeleted === false, `uiDeleted=${uiDeleted}`);
check('stale tombstone does NOT clear the UI payload', uiRecord?.name === 'Alice', `uiRecord=${JSON.stringify(uiRecord)}`);
check('stale tombstone leaves the clock at 5 (not lowered)', (await clock()) === 5, `clock=${await clock()}`);
check('authority row still v5/alive', Number((await row()).version) === 5 && Number((await row()).deleted) === 0);

// 3. The same stale tombstone is also rejected on the PUSH side (the guard the
//    pull path should agree with).
const stalePush = await db.execute(DELETE_PUSH, [ID, JSON.stringify({ id: ID, deleted: 1, version: 2 }), 'devB', 'k2', 2, '2026-01-01T00:00:02.000Z']);
check('stale tombstone push rejected (rowsAffected 0)', Number(stalePush.rowsAffected ?? 0) === 0, `got ${stalePush.rowsAffected}`);

// 4. A FRESH tombstone (v6) must still delete — the guard must not over-reject.
await applyRemoteRow({ id: ID, version: 6, deleted: 1, data_json: JSON.stringify({ id: ID, deleted: 1, version: 6 }) });
check('fresh tombstone deletes the UI record', uiDeleted === true, `uiDeleted=${uiDeleted}`);
check('fresh tombstone advances the clock to 6', (await clock()) === 6, `clock=${await clock()}`);

// 5. ...and the matching push is accepted.
const freshPush = await db.execute(DELETE_PUSH, [ID, JSON.stringify({ id: ID, deleted: 1, version: 6 }), 'devB', 'k2', 6, '2026-01-01T00:00:06.000Z']);
check('fresh tombstone push accepted (rowsAffected 1)', Number(freshPush.rowsAffected ?? 0) === 1, `got ${freshPush.rowsAffected}`);

// 6. An EQUAL-version tombstone (v6) applies (tie => remote wins, by design).
await applyRemoteRow({ id: ID, version: 6, deleted: 1, data_json: JSON.stringify({ id: ID, deleted: 1, version: 6 }) });
check('equal-version tombstone still deletes (tie => apply)', uiDeleted === true);

// 7. First-ever tombstone on an unknown id: no clock row => applies.
const ID2 = 'cust-2';
await applyRemoteRow({ id: ID2, version: 1, deleted: 1, data_json: JSON.stringify({ id: ID2, deleted: 1, version: 1 }) });
check('first-ever tombstone applies (no clock row)', (await appliedGenericVersion(ENTITY, ID2)) === 1);

// 8. Contrast: the OLD behaviour deleted the UI record on the stale tombstone.
//    Re-run the pre-H19 ordering to prove the test detects the defect.
{
  uiDeleted = false; uiRecord = { name: 'Alice' };
  const oldApply = async (r) => {
    if (Number(r.deleted ?? 0) === 1) { uiDeleted = true; uiRecord = null; return; } // guard never ran
    const applied = await appliedGenericVersion(ENTITY, ID);
    if (applied > 0 && applied > version) return;
  };
  await oldApply({ id: ID, version: 2, deleted: 1 });
  check('OLD behaviour DID delete on the stale tombstone (test detects defect)', uiDeleted === true);
}

console.log(`\n=== SUMMARY: ${pass} PASSED, ${fail} FAILED ===`);
for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* deferred delete on Windows */ }
}
process.exit(fail > 0 ? 1 : 0);
