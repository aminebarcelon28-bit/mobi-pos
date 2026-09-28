/**
 * H12 regression: the H11 pull guard reads the applied version with
 *   `SELECT version FROM <table> WHERE id = $1`
 * but that query is only valid for lanes whose LOCAL SQLite table has an `id`
 * PRIMARY KEY column. Two lanes do not:
 *   - imei_records  -> PK is `imei`, there is NO `id` column
 *   - app_settings  -> PK is `key`, there is NO `id` column
 * On those lanes the query throws "no such column: id", the helper's catch
 * returns 0, and the guard degenerates to "always apply" — a stale echo can
 * silently clobber a newer IMEI sale record or a newer setting.
 *
 * Worse: for the 11 lanes that never mirror into SQLite on pull, no local row
 * is ever written at all, so the watermark is 0 even when the query parses.
 * The authoritative clock for ALL 13 lanes is `entity_keys.version`
 * (bumped by bumpEntityVersion on every push). This test proves the guard must
 * read THAT clock, and that the table-specific query is not a reliable
 * substitute.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h12-guard-clock.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// The real production schema for the two lanes with a non-`id` primary key,
// plus the generic KV shape for a lane that never mirrors on pull.
const SCHEMAS = {
  imei_records: `CREATE TABLE imei_records (imei TEXT PRIMARY KEY, product_id TEXT,
    purchase_order_id TEXT, sale_transaction_id TEXT, warranty_expires_at TEXT,
    received_at TEXT, sold_at TEXT, version INTEGER NOT NULL DEFAULT 1)`,
  app_settings: `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT,
    updated_at TEXT, version INTEGER NOT NULL DEFAULT 1)`,
  repair_orders: `CREATE TABLE repair_orders (id TEXT PRIMARY KEY, ticket_number TEXT,
    status TEXT, version INTEGER NOT NULL DEFAULT 1)`,
  entity_keys: `CREATE TABLE entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (entity_type, entity_id))`,
};

/** The H11 helper as shipped — reads the lane table by `id`. */
async function h11AppliedVersion(db, table, id) {
  try {
    const rows = await db.execute(`SELECT version FROM ${table} WHERE id = ?`, [id]);
    return Number(rows.rows?.[0]?.version ?? 0);
  } catch { return 0; }
}

/** The H12 fix — reads the authoritative clock for every lane. */
async function h12AppliedVersion(db, entityType, id) {
  try {
    const rows = await db.execute(
      'SELECT version FROM entity_keys WHERE entity_type = ? AND entity_id = ?',
      [entityType, id],
    );
    return Number(rows.rows?.[0]?.version ?? 0);
  } catch { return 0; }
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
    for (const [name, ddl] of Object.entries(SCHEMAS)) await db.execute(ddl);

    // ── 1. The H11 query is INVALID on imei_records (PK is `imei`) ──────────
    await db.execute(
      `INSERT INTO imei_records (imei, product_id, sold_at, version) VALUES (?,?,?,?)`,
      ['356938035643809', 'P-1', '2026-09-19', 5],
    );
      await db.execute(
        `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES (?,?,?,?)`,
        ['imei', '356938035643809', 'idem-imei-1', 5],
      );
    check('imei_records has no `id` column (H11 query throws)',
      await h11AppliedVersion(db, 'imei_records', '356938035643809') === 0,
      'H11 returned 0 -> guard inert');
    check('H12 reads the imei clock correctly',
      await h12AppliedVersion(db, 'imei', '356938035643809') === 5,
      'H12 read 5 from entity_keys');

    // ── 2. The H11 query is INVALID on app_settings (PK is `key`) ───────────
    await db.execute(
      `INSERT INTO app_settings (key, value_json, updated_at, version) VALUES (?,?,?,?)`,
      ['store.name', '"Clobbered"', '2026-09-19', 4],
    );
      await db.execute(
        `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES (?,?,?,?)`,
        ['setting', 'store.name', 'idem-setting-1', 4],
      );
    check('app_settings has no `id` column (H11 query throws)',
      await h11AppliedVersion(db, 'app_settings', 'store.name') === 0,
      'H11 returned 0 -> guard inert');
    check('H12 reads the setting clock correctly',
      await h12AppliedVersion(db, 'setting', 'store.name') === 4,
      'H12 read 4 from entity_keys');

    // ── 3. On a lane that never mirrors, H11 sees no row at all ─────────────
    await db.execute(
      `INSERT INTO repair_orders (id, ticket_number, status, version) VALUES (?,?,?,?)`,
      ['RO-1', 'T-100', 'REPAIRED', 3],
    );
    // Simulate the pull path: the row is applied to Dexie only, so the SQLite
    // watermark the H11 helper looks for does not exist.
    await db.execute(`DELETE FROM repair_orders WHERE id = 'RO-1'`);
      await db.execute(
        `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES (?,?,?,?)`,
        ['repair_order', 'RO-1', 'idem-ro1', 3],
      );
    check('an unmirrored lane has no SQLite watermark (H11 = 0)',
      await h11AppliedVersion(db, 'repair_orders', 'RO-1') === 0,
      'H11 returned 0 -> guard inert');
    check('H12 still reads the clock for an unmirrored lane',
      await h12AppliedVersion(db, 'repair_order', 'RO-1') === 3,
      'H12 read 3 from entity_keys');

    // ── 4. The guard rejects a stale echo only with the H12 clock ───────────
    // A v1 echo arrives after v3 was already applied. H11 (inert) accepts it;
    // H12 (correct) refuses it.
    const staleV = 1;
    const h11Watermark = await h11AppliedVersion(db, 'repair_orders', 'RO-1');
    const h12Watermark = await h12AppliedVersion(db, 'repair_order', 'RO-1');
    check('H11 would accept the stale echo (watermark 0 < nothing)',
      h11Watermark === 0 && staleV >= h11Watermark, `h11=${h11Watermark}`);
    check('H12 rejects the stale echo (watermark 3 > 1)',
      h12Watermark === 3 && staleV < h12Watermark, `h12=${h12Watermark}`);

    // ── 5. A first-ever write has clock 0, so v1 applies ────────────────────
    check('a first-ever write has H12 clock 0',
      await h12AppliedVersion(db, 'repair_order', 'NEVER-SEEN') === 0,
      'clock=0 -> first write applies');

    // ── 6. The clock is per-(entity, id) and monotonic ──────────────────────
    for (let v = 2; v <= 4; v++) {
      await db.execute(
        `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
         VALUES ('repair_order', 'RO-2', 'idem-ro2', ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET version = excluded.version`,
        [v],
      );
      check(`clock advances to v${v}`,
        await h12AppliedVersion(db, 'repair_order', 'RO-2') === v,
        `clock=${await h12AppliedVersion(db, 'repair_order', 'RO-2')}`);
    }
    check('a different id keeps its own clock',
      await h12AppliedVersion(db, 'repair_order', 'RO-1') === 3,
      `RO-1 clock=${await h12AppliedVersion(db, 'repair_order', 'RO-1')}`);
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
