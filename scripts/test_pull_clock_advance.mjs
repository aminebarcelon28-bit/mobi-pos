/**
 * H13 regression: the local version clock (`entity_keys.version`) is bumped on
 * PUSH (bumpEntityVersion) but NEVER advanced on PULL. So:
 *
 *   1. Device A pushes RO-1 three times  -> remote row is v3.
 *   2. Device B PULLS RO-1 v3            -> B's entity_keys clock for RO-1 is
 *                                           still the default 1 (pull never
 *                                           touches it).
 *   3. B edits RO-1 locally              -> bumpEntityVersion reads 1, emits v2.
 *   4. B pushes v2                       -> remote guard is
 *        `WHERE excluded.version >= <remote>.version`  ->  2 >= 3 is FALSE
 *      The upsert matches no rows, the batch still returns success, the outbox
 *      row is marked 'synced' — and B's edit is SILENTLY LOST (contract C6).
 *
 * The fix: applying a remote row must advance the local clock to at least the
 * pulled version (monotonically — never lower it).
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h13-pull-clock.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const ENTITY_KEYS = `CREATE TABLE entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_type, entity_id))`;

const REMOTE_KV = `CREATE TABLE repair_orders (id TEXT PRIMARY KEY, data_json TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'default', idempotency_key TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced', version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0)`;

/** The remote upsert guard, as shipped (toRemoteUpsert, generic lane). */
const REMOTE_UPSERT = `INSERT INTO repair_orders (id, data_json, device_id, idempotency_key,
  sync_status, version, updated_at, deleted)
  VALUES (?,?,?,?, 'synced', ?, ?, 0)
  ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
  updated_at=excluded.updated_at, sync_status='synced', deleted=0
  WHERE excluded.version >= repair_orders.version`;

/** bumpEntityVersion as shipped: read clock, +1, write back. */
async function bumpClock(db, entityType, entityId) {
  const rows = await db.execute(
    'SELECT version FROM entity_keys WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId],
  );
  const current = Number(rows.rows?.[0]?.version ?? 1);
  const next = current + 1;
  await db.execute(
    'UPDATE entity_keys SET version = ? WHERE entity_type = ? AND entity_id = ?',
    [next, entityType, entityId],
  );
  return next;
}

/** The H13 fix: advance the clock to the pulled version, monotonically. */
async function advanceClockOnPull(db, entityType, entityId, version) {
  await db.execute(
    `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
     VALUES (?,?,?,?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE
     SET version = MAX(excluded.version, entity_keys.version)`,
    [entityType, entityId, `pull-${entityType}-${entityId}`, version],
  );
}

async function remoteVersion(db, id) {
  const rows = await db.execute('SELECT version FROM repair_orders WHERE id = ?', [id]);
  return Number(rows.rows?.[0]?.version ?? 0);
}

async function localClock(db, entityType, entityId) {
  const rows = await db.execute(
    'SELECT version FROM entity_keys WHERE entity_type = ? AND entity_id = ?',
    [entityType, entityId],
  );
  return Number(rows.rows?.[0]?.version ?? 0);
}

async function main() {
  let db;
  try {
    // Self-healing startup cleanup: on Windows a rmSync at teardown can be
    // deferred while the handle is still open, leaving a stale DB for the
    // next run and corrupting every assertion. Delete BEFORE opening.
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`]) {
      try { rmSync(f, { force: true }); } catch { /* may still be locked */ }
    }
    db = createClient({ url: `file:${DB_FILE}` });
    await db.execute(ENTITY_KEYS);
    await db.execute(REMOTE_KV);

    const E = 'repair_order';
    const ID = 'RO-1';

    // ── Setup: device A pushed RO-1 three times; remote is v3 ──────────────
    for (let v = 1; v <= 3; v++) {
      await db.execute(REMOTE_UPSERT, [ID, JSON.stringify({ id: ID, status: `v${v}`, version: v }),
        'deviceA', 'idem-a', v, new Date().toISOString()]);
    }
    check('remote row is at v3 after three pushes', await remoteVersion(db, ID) === 3,
      `remote=${await remoteVersion(db, ID)}`);

    // ── 1. THE BUG: pull does not advance the local clock ──────────────────
    // (simulate: the pull applied the row to Dexie but never touched entity_keys)
    check('local clock is still the default 1 after pulling v3',
      await localClock(db, E, ID) === 0, `clock=${await localClock(db, E, ID)}`);

    // A local edit now reads the stale clock and emits v2 — LOWER than remote v3.
    await db.execute(
      `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES (?,?,?,?)`,
      [E, ID, 'idem-b', 1],
    );
    const buggyNext = await bumpClock(db, E, ID);
    check('a local edit after pull emits a version LOWER than remote',
      buggyNext === 2 && buggyNext < await remoteVersion(db, ID),
      `local emitted v${buggyNext} vs remote v${await remoteVersion(db, ID)}`);

    // The remote guard rejects it and the edit is lost.
    await db.execute(REMOTE_UPSERT, [ID, JSON.stringify({ id: ID, status: 'B-EDIT', version: buggyNext }),
      'deviceB', 'idem-b', buggyNext, new Date().toISOString()]);
    const afterBuggyPush = await db.execute(
      "SELECT json_extract(data_json, '$.status') AS s FROM repair_orders WHERE id = ?", [ID]);
    check('the remote guard SILENTLY REJECTED the edit (C6 violation)',
      afterBuggyPush.rows[0].s === 'v3', `remote status="${afterBuggyPush.rows[0].s}" (edit lost)`);

    // ── 2. THE FIX: pull advances the clock monotonically ──────────────────
    await advanceClockOnPull(db, E, ID, 3);
    check('the fix advances the local clock to the pulled version',
      await localClock(db, E, ID) === 3, `clock=${await localClock(db, E, ID)}`);

    // The same local edit now emits v4 — strictly higher than remote v3.
    const fixedNext = await bumpClock(db, E, ID);
    check('a local edit after the fix emits v4 (above remote v3)',
      fixedNext === 4, `emitted v${fixedNext}`);
    await db.execute(REMOTE_UPSERT, [ID, JSON.stringify({ id: ID, status: 'B-EDIT', version: fixedNext }),
      'deviceB', 'idem-b', fixedNext, new Date().toISOString()]);
    const afterFixedPush = await db.execute(
      "SELECT version, json_extract(data_json, '$.status') AS s FROM repair_orders WHERE id = ?", [ID]);
    check('the remote guard ACCEPTS the edit now',
      afterFixedPush.rows[0].version === 4 && afterFixedPush.rows[0].s === 'B-EDIT',
      `remote v${afterFixedPush.rows[0].version} status="${afterFixedPush.rows[0].s}"`);

    // ── 3. The advance is monotonic (an older echo never lowers the clock) ─
    await advanceClockOnPull(db, E, ID, 1);
    check('a stale v1 echo does not lower the clock',
      await localClock(db, E, ID) === 4, `clock=${await localClock(db, E, ID)}`);
    await advanceClockOnPull(db, E, ID, 4);
    check('an equal version is a no-op',
      await localClock(db, E, ID) === 4, `clock=${await localClock(db, E, ID)}`);
    await advanceClockOnPull(db, E, ID, 9);
    check('a higher version still advances',
      await localClock(db, E, ID) === 9, `clock=${await localClock(db, E, ID)}`);

    // ── 4. First-ever pull creates the clock row at the pulled version ─────
    await advanceClockOnPull(db, E, 'RO-NEW', 5);
    check('a first-ever pull seeds the clock at the pulled version',
      await localClock(db, E, 'RO-NEW') === 5, `clock=${await localClock(db, E, 'RO-NEW')}`);

    // ── 5. Clocks stay isolated per entity ─────────────────────────────────
    check('RO-1 keeps its own clock',
      await localClock(db, E, ID) === 9, `RO-1=${await localClock(db, E, ID)}`);
    check('RO-NEW keeps its own clock',
      await localClock(db, E, 'RO-NEW') === 5, `RO-NEW=${await localClock(db, E, 'RO-NEW')}`);
  } finally {
    if (db) { try { await db.close(); } catch { /* ignore */ } }
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
      try { rmSync(f, { force: true }); } catch { /* ignore */ } }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('='.repeat(60));
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
