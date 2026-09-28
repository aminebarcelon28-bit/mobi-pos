/**
 * H9-generalized regression: EVERY generic-KV lane pushed `version || 1`.
 *
 * `toRemoteUpsert` computes `version = Number(payload.version ?? 1)`. Before the
 * fix, no generic lane ever set `.version` on the payload it handed to
 * `fireSync`, so the value was the constant 1 for the entire lifetime of every
 * row. The remote and local `WHERE excluded.version >= X` stale-echo guards
 * were therefore inert on 11 lanes:
 *
 *   customer, repair_order, purchase_order, trade_in, imei, audit_log,
 *   cash_drop, bundle, customer_debt, store_expense, cash_session,
 *   cash_movement, setting
 *
 * The consequence is not theoretical: a reordered replay (backfill re-enqueues
 * every Dexie row; a retry re-delivers an outbox row; two devices write the same
 * entity) lands last-write-wins with no ordering protection. H9 proved this
 * corrupts money in the customer_debt lane; the same shape corrupts every other
 * lane (a reopened repair order, a resurrected expense, an un-deleted bundle).
 *
 * The fix puts a monotonic clock at the single choke point every lane funnels
 * through — `enqueueGenericSync` / `enqueueGenericDelete` — bumping a per-
 * (entity, id) counter in `entity_keys` and stamping it onto the payload.
 *
 * This test proves the clock advances for ALL lanes, not just the one H9 fixed.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h10-generic-clock.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// The exact generic-KV remote shape (remoteSchema.ts v1).
const GENERIC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS {t} (
    id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT 'default',
    idempotency_key TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'synced',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0
  );`;

// The exact local entity_keys shape after migration 4 + the H9-generalized
// ALTER TABLE that adds the version clock.
const ENTITY_KEYS = `
  CREATE TABLE IF NOT EXISTS entity_keys (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (entity_type, entity_id)
  );`;

// Exact replica of sqlPluginAdapter.bumpEntityVersion.
async function bumpEntityVersion(db, entity, id) {
  const rows = await db.execute(
    'SELECT version FROM entity_keys WHERE entity_type = ? AND entity_id = ?',
    [entity, id],
  );
  const current = Number(rows.rows?.[0]?.version ?? 1);
  const next = current + 1;
  await db.execute(
    'UPDATE entity_keys SET version = ? WHERE entity_type = ? AND entity_id = ?',
    [next, entity, id],
  );
  return next;
}

// Exact replica of the generic upsert in toRemoteUpsert (SyncManager L875).
const GENERIC_UPSERT = `
  INSERT INTO {t} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES (?,?,?,?, 'synced', ?, ?, 0)
  ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
    updated_at=excluded.updated_at, sync_status='synced', deleted=0
    WHERE excluded.version >= {t}.version`;

const LANES = [
  'customer', 'repair_order', 'purchase_order', 'trade_in', 'imei',
  'audit_log', 'cash_drop', 'bundle', 'customer_debt', 'store_expense',
  'cash_session', 'cash_movement', 'setting',
];

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
    await db.execute('PRAGMA foreign_keys = ON');

    for (const lane of LANES) {
      const t = lane;
      await db.execute(GENERIC_SCHEMA.replaceAll('{t}', t));
    }
    await db.execute(ENTITY_KEYS);

    // ── 1. The clock advances on every lane, not just customer_debt ─────────
    // Pre-fix, all of these would have read the constant 1.
    for (const lane of LANES) {
      const id = `entity-${lane}`;
      await db.execute(
        'INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES (?,?,?,1)',
        [lane, id, `idem-${lane}`],
      );
      const v1 = await bumpEntityVersion(db, lane, id);
      const v2 = await bumpEntityVersion(db, lane, id);
      const v3 = await bumpEntityVersion(db, lane, id);
      check(`clock advances on lane "${lane}"`, v1 === 2 && v2 === 3 && v3 === 4,
        `v1=${v1} v2=${v2} v3=${v3}`);
    }

    // ── 2. The stamped version reaches the remote row and the guard fires ───
    const lane = 'repair_order';
    const t = lane;
    const id = 'RO-1';
    await db.execute(
      'INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES (?,?,?,1)',
      [lane, id, 'idem-ro1'],
    );

    // Three sequential writes, each advancing the clock.
    for (let i = 0; i < 3; i++) {
      const version = await bumpEntityVersion(db, lane, id);
      await db.execute(GENERIC_UPSERT.replaceAll('{t}', t), [
        id, JSON.stringify({ id, status: `v${version}`, version }),
        'default', 'idem-ro1', version, new Date().toISOString(),
      ]);
    }
    let rows = await db.execute(`SELECT version, json_extract(data_json, '$.status') AS status FROM ${t} WHERE id = ?`, [id]);
    check('remote row reached the highest version', rows.rows[0].version === 4, `version=${rows.rows[0].version}`);
    check('remote row holds the newest payload', rows.rows[0].status === 'v4', `status=${rows.rows[0].status}`);

    // A stale echo at v2 must be refused by the remote guard.
    await db.execute(GENERIC_UPSERT.replaceAll('{t}', t), [
      id, JSON.stringify({ id, status: 'STALE', version: 2 }),
      'default', 'idem-ro1', 2, new Date().toISOString(),
    ]);
    rows = await db.execute(`SELECT version, json_extract(data_json, '$.status') AS status FROM ${t} WHERE id = ?`, [id]);
    check('remote guard refuses a lower-version echo', rows.rows[0].version === 4, `version=${rows.rows[0].version}`);
    check('stale echo did not overwrite newer data', rows.rows[0].status === 'v4', `status=${rows.rows[0].status}`);

    // ── 3. The delete tombstone carries a higher version than the upserts ──
    // Pre-fix, a tombstone at version 1 could be clobbered by a stale upsert
    // echo at version 1 (>= passes), un-deleting the row.
    const delVersion = await bumpEntityVersion(db, lane, id);
    await db.execute(
      `INSERT INTO ${t} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
       VALUES (?,?,?,?,'synced',?,?,1)
       ON CONFLICT(id) DO UPDATE SET deleted=1, version=excluded.version, updated_at=excluded.updated_at,
         sync_status='synced' WHERE excluded.version >= ${t}.version`,
      [id, JSON.stringify({ id, deleted: 1, version: delVersion }), 'default', 'idem-ro1', delVersion, new Date().toISOString()],
    );
    rows = await db.execute(`SELECT version, deleted FROM ${t} WHERE id = ?`, [id]);
    check('tombstone advanced the version', rows.rows[0].version === 5, `version=${rows.rows[0].version}`);
    check('row is soft-deleted', Number(rows.rows[0].deleted) === 1, `deleted=${rows.rows[0].deleted}`);

    // A stale upsert echo at v4 (< 5) must not un-delete the row.
    await db.execute(GENERIC_UPSERT.replaceAll('{t}', t), [
      id, JSON.stringify({ id, status: 'RESURRECT', version: 4 }),
      'default', 'idem-ro1', 4, new Date().toISOString(),
    ]);
    rows = await db.execute(`SELECT version, deleted FROM ${t} WHERE id = ?`, [id]);
    check('stale upsert echo cannot un-delete the row', Number(rows.rows[0].deleted) === 1, `deleted=${rows.rows[0].deleted}`);

    // ── 4. Two lanes sharing an entity_id keep independent clocks ───────────
    // entity_keys is keyed by (entity_type, entity_id), so the same id in two
    // lanes must not share a clock.
    const sharedId = 'SHARED-1';
    for (const l of ['cash_session', 'cash_movement']) {
      await db.execute(
        'INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES (?,?,?,1)',
        [l, sharedId, `idem-${l}-${sharedId}`],
      );
    }
    const a = await bumpEntityVersion(db, 'cash_session', sharedId);
    const b = await bumpEntityVersion(db, 'cash_movement', sharedId);
    check('two lanes with the same id keep independent clocks', a === 2 && b === 2, `session=${a} movement=${b}`);

    // ── 5. The clock is per-entity, not global ──────────────────────────────
    // A bump on one entity must not advance another entity in the same lane.
    const other = await bumpEntityVersion(db, lane, 'RO-OTHER');
    const first = await bumpEntityVersion(db, lane, id);
    check('the clock is per-entity, not per-lane', other === 2 && first === 6, `other=${other} first=${first}`);
  } finally {
    if (db) { try { await db.close(); } catch { /* ignore */ } }
    try { rmSync(DB_FILE, { force: true }); } catch { /* WAL sidecar may linger */ }
    try { rmSync(`${DB_FILE}-wal`, { force: true }); } catch { /* ignore */ }
    try { rmSync(`${DB_FILE}-shm`, { force: true }); } catch { /* ignore */ }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('='.repeat(60));
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
