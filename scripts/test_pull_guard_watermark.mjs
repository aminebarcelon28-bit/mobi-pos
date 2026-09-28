/**
 * H11 regression: the pull-side stale-echo guard reads the version from DEXIE,
 * but the push-side clock (H10) writes it to the SYNC_OUTBOX payload and the
 * SQLite row. For the 11 lanes that never mirror into SQLite on pull
 * (repair_orders, purchase_orders, trade_ins, imei_records,
 * security_audit_logs, cash_drops, product_bundles, store_expenses,
 * cash_sessions, cash_movements, app_settings) the guard reads
 * `local.version ?? 1` from a Dexie row that was written WITHOUT a version
 * field, so it evaluates to the constant 1 and can never reject anything.
 *
 * The concrete failure: device A writes RO-1 (v1). Device B writes RO-1 (v2).
 * Both push. The pull cursor delivers v1 AFTER v2 (keyset order is
 * updated_at ASC, and A's row can have a later server updated_at than B's
 * despite carrying the older version). The guard should reject the stale v1 —
 * it accepts it, and B's newer repair status is clobbered.
 *
 * The fix: the pull guard must compare against the version that the H10 clock
 * actually produces. Since `enqueueGenericSync` stamps the payload and the
 * payload round-trips through `data_json`, the pulled row's own `version`
 * column is the authority — and the guard's job is to refuse a row whose
 * version is OLDER than the version already applied to the same id. The
 * applied-version watermark is what was missing; this test models it.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h11-pull-guard.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const LANES = [
  'repair_orders', 'purchase_orders', 'trade_ins', 'imei_records',
  'security_audit_logs', 'cash_drops', 'product_bundles', 'store_expenses',
  'cash_sessions', 'cash_movements', 'app_settings',
];

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

const GENERIC_UPSERT = `
  INSERT INTO {t} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES (?,?,?,?, 'synced', ?, ?, 0)
  ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
    updated_at=excluded.updated_at, sync_status='synced', deleted=0
    WHERE excluded.version >= {t}.version`;

/**
 * The applied-version watermark: the highest version ever written to the local
 * replica for a given (table, id). This is what the pull guard must compare
 * against — NOT the version field of the Dexie row, which may be absent.
 */
async function appliedVersion(db, table, id) {
  const rows = await db.execute(
    `SELECT version FROM ${table} WHERE id = ?`, [id],
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
    await db.execute('PRAGMA foreign_keys = ON');
    for (const t of LANES) await db.execute(GENERIC_SCHEMA.replaceAll('{t}', t));

    // ── 1. The watermark tracks the highest applied version per (table, id) ─
    const t = 'repair_orders';
    const id = 'RO-1';
    for (let v = 1; v <= 3; v++) {
      await db.execute(GENERIC_UPSERT.replaceAll('{t}', t), [
        id, JSON.stringify({ id, status: `v${v}`, version: v }),
        'default', 'idem-ro1', v, new Date().toISOString(),
      ]);
      check(`watermark advances to v${v}`, await appliedVersion(db, t, id) === v,
        `applied=${await appliedVersion(db, t, id)}`);
    }

    // ── 2. A stale echo (v1, delivered after v3) is refused by the guard ────
    // This is the exact reorder that clobbers a newer repair status.
    const applied = await appliedVersion(db, t, id);
    const staleVersion = 1;
    check('the guard sees the stale echo as older',
      staleVersion < applied, `stale=${staleVersion} applied=${applied}`);

    // Applying it anyway (the bug) would regress the row.
    await db.execute(GENERIC_UPSERT.replaceAll('{t}', t), [
      id, JSON.stringify({ id, status: 'STALE', version: staleVersion }),
      'default', 'idem-ro1', staleVersion, new Date().toISOString(),
    ]);
    const rows = await db.execute(
      `SELECT version, json_extract(data_json, '$.status') AS status FROM ${t} WHERE id = ?`, [id]);
    check('the remote guard refused the stale echo', rows.rows[0].version === 3, `version=${rows.rows[0].version}`);
    check('the newer status survived', rows.rows[0].status === 'v3', `status=${rows.rows[0].status}`);

    // ── 3. The watermark is per-(table, id), not global ─────────────────────
    await db.execute(GENERIC_UPSERT.replaceAll('{t}', t), [
      'RO-2', JSON.stringify({ id: 'RO-2', status: 'other', version: 1 }),
      'default', 'idem-ro2', 1, new Date().toISOString(),
    ]);
    check('a different id has its own watermark',
      await appliedVersion(db, t, 'RO-2') === 1, `applied=${await appliedVersion(db, t, 'RO-2')}`);
    check('the first id is untouched',
      await appliedVersion(db, t, id) === 3, `applied=${await appliedVersion(db, t, id)}`);

    // ── 4. Every lane has a watermark path (no lane is unguarded) ───────────
    for (const lane of LANES) {
      const lid = `entity-${lane}`;
      await db.execute(GENERIC_UPSERT.replaceAll('{t}', lane), [
        lid, JSON.stringify({ id: lid, version: 2 }),
        'default', `idem-${lane}`, 2, new Date().toISOString(),
      ]);
      check(`watermark readable on lane "${lane}"`,
        await appliedVersion(db, lane, lid) === 2, `applied=${await appliedVersion(db, lane, lid)}`);
    }

    // ── 5. A first-ever write (no prior row) has watermark 0, so v1 applies ─
    check('a first-ever write has watermark 0',
      await appliedVersion(db, t, 'NEVER-SEEN') === 0, `applied=${await appliedVersion(db, t, 'NEVER-SEEN')}`);
  } finally {
    if (db) { try { await db.close(); } catch { /* ignore */ } }
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
      try { rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('='.repeat(60));
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
