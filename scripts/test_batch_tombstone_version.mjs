/**
 * Orphan-batch tombstone version regression test.
 *
 * Root cause fixed in createCatalogSlice.deleteProduct + SyncManager.markGuardStale:
 *   BEFORE: the orphan-batch tombstone was enqueued as
 *           { batch_id, product_id, deleted: 1, updated_at } — NO version.
 *           toRemoteUpsert computes `version = Number(payload.version ?? 1)`,
 *           so the tombstone pushed as v1 and lost the remote guard
 *           (`excluded.version > stock_batches.version`) against ANY
 *           previously-synced remote row -> 10 wasted retries -> quarantine
 *           badge. Deterministic: every delete of a product with live,
 *           previously-synced batches quarantined. (Live incident 2026-10-05:
 *           sb-batch-trade-*-tombstone rows, "local v? rejected".)
 *   AFTER:  (1) the tombstone reads back the post-UPDATE row version (H27
 *           pattern) and stamps it into the payload, resetting strikes on
 *           re-enqueue like every other enqueue site;
 *           (2) markGuardStale self-heals legacy version-less payloads: when
 *           the local authority row carries a higher version, the payload is
 *           refreshed to the local clock strikeless instead of burning a
 *           quarantine strike. Genuinely-superseded payloads still count
 *           strikes (no inflation — the version always comes from the row).
 *
 * Run: node scripts/test_batch_tombstone_version.mjs
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const TEMP_FILES = [
  'tmp-btv-local.db', 'tmp-btv-local.db-wal', 'tmp-btv-local.db-journal',
  'tmp-btv-remote.db', 'tmp-btv-remote.db-wal', 'tmp-btv-remote.db-journal',
];
for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may be locked */ }
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail ?? ''}`); }
}

const BATCH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS stock_batches (
    batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    quantity_remaining REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0,
    received_at TEXT, purchase_order_id TEXT, device_id TEXT,
    idempotency_key TEXT NOT NULL DEFAULT '', sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
`;
const OUTBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_outbox (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
    payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  );
`;

/** Verbatim FIXED orphan-batch tombstone (createCatalogSlice.deleteProduct). */
async function tombstoneBatches(local, productId, batchIds, deviceId) {
  const now = 't10';
  await local.execute(
    `UPDATE stock_batches SET deleted = 1, version = version + 1, updated_at = ?, sync_status = 'pending' WHERE product_id = ? AND deleted = 0`,
    [now, productId]
  );
  const versed = (await local.execute(
    'SELECT batch_id, version FROM stock_batches WHERE product_id = ? AND deleted = 1', [productId]
  )).rows ?? [];
  const versionByBatch = new Map(versed.map((r) => [String(r.batch_id), Number(r.version)]));
  let skipped = 0;
  for (const bid of batchIds) {
    const bv = versionByBatch.get(bid);
    if (!Number.isFinite(bv)) { skipped++; continue; }
    await local.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES (?, 'stock_batches', ?, 'UPSERT', ?, 'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=?`,
      [`sb-${bid}-tombstone`, bid,
        JSON.stringify({ batch_id: bid, product_id: productId, deleted: 1, version: bv, updated_at: now }), now]
    );
  }
  return { skipped };
}

/** Verbatim OLD tombstone (no version, no strike reset) — the bug. */
async function tombstoneBatchesOld(local, productId, batchIds) {
  const now = 't10';
  await local.execute(
    `UPDATE stock_batches SET deleted = 1, version = version + 1, updated_at = ?, sync_status = 'pending' WHERE product_id = ? AND deleted = 0`,
    [now, productId]
  );
  for (const bid of batchIds) {
    await local.execute(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
       VALUES (?, 'stock_batches', ?, 'UPSERT', ?, 'pending')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=?`,
      [`sb-${bid}-tombstone`, bid,
        JSON.stringify({ batch_id: bid, product_id: productId, deleted: 1, updated_at: now }), now]
    );
  }
}

/** Verbatim stock_batches push upsert (SyncManager.toRemoteUpsert branch). */
async function pushBatch(remote, outboxRow, deviceId, now) {
  const payload = JSON.parse(outboxRow.payload_json);
  const version = Number(payload.version ?? 1);
  const batchDeleted = Number(payload.deleted ?? 0) === 1 ? 1 : 0;
  return remote.execute(
    `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost,
      received_at, purchase_order_id, device_id, idempotency_key, sync_status, version,
      created_at, updated_at, deleted)
     VALUES (?,?,?,?,?,?,?,'synced',?,?,?,?,?)
     ON CONFLICT(batch_id) DO UPDATE SET
       product_id=excluded.product_id, quantity_remaining=excluded.quantity_remaining,
       unit_cost=CASE WHEN excluded.unit_cost > 0 THEN excluded.unit_cost ELSE stock_batches.unit_cost END,
       device_id=excluded.device_id,
       idempotency_key=excluded.idempotency_key, sync_status='synced',
       version=excluded.version, updated_at=excluded.updated_at,
       deleted=excluded.deleted
     WHERE excluded.version > stock_batches.version
       OR (excluded.version = stock_batches.version
         AND COALESCE(excluded.device_id,'') >= COALESCE(stock_batches.device_id,''))`,
    [String(payload.batch_id ?? outboxRow.entity_id), String(payload.product_id ?? 'unknown'),
      Number(payload.quantity_remaining ?? 0), Number(payload.unit_cost ?? 0),
      payload.received_at ?? now, payload.purchase_order_id ?? null,
      payload.device_id ?? deviceId ?? 'default',
      outboxRow.idempotency_key, version || 1,
      payload.created_at ?? now, now, batchDeleted]
  );
}

/** Verbatim self-heal belt (SyncManager.markGuardStale stock_batches branch). */
async function selfHealBelt(local, outboxRow) {
  const payload = JSON.parse(outboxRow.payload_json);
  const pushed = Number(payload.version ?? 1);
  const rows = (await local.execute(
    'SELECT version FROM stock_batches WHERE batch_id=?', [outboxRow.entity_id]
  )).rows ?? [];
  const localV = Number(rows?.[0]?.version ?? NaN);
  if (Number.isFinite(localV) && localV > pushed) {
    const healed = { ...payload, version: localV };
    await local.execute(
      `UPDATE sync_outbox SET payload_json=?, status='pending', next_retry_at=NULL, last_error=?, updated_at=? WHERE idempotency_key=?`,
      [JSON.stringify(healed), `[SELF-HEAL] tombstone understated v${pushed} -> local v${localV}; retrying without strike`, 't11', outboxRow.idempotency_key]
    );
    return { healed: true, from: pushed, to: localV };
  }
  return { healed: false };
}

async function freshDbs() {
  const local = createClient({ url: 'file:tmp-btv-local.db' });
  const remote = createClient({ url: 'file:tmp-btv-remote.db' });
  for (const c of [local, remote]) {
    await c.execute(BATCH_SCHEMA);
    await c.execute(OUTBOX_SCHEMA);
    await c.execute('DELETE FROM stock_batches');
    await c.execute('DELETE FROM sync_outbox');
  }
  return { local, remote };
}

async function seedBatch(c, bid, pid, version, deviceId) {
  await c.execute(
    `INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, device_id, idempotency_key, sync_status, version, created_at, updated_at, deleted)
     VALUES (?,?,?,?,?,?,'synced',?,?,'t1',0)`,
    [bid, pid, 5, 1000, deviceId, `sb-${bid}`, version, 't1']
  );
}

async function outboxRow(c, entityId) {
  return (await c.execute('SELECT * FROM sync_outbox WHERE entity_id=?', [entityId])).rows[0];
}

// ---------------------------------------------------------------------------
console.log('\n[BTV-1] tombstone payload carries the post-UPDATE version');
{
  const { local, remote } = await freshDbs();
  await seedBatch(local, 'B1', 'P1', 3, 'devA');
  await seedBatch(remote, 'B1', 'P1', 3, 'devA');
  await tombstoneBatches(local, 'P1', ['B1'], 'devA');
  const row = (await local.execute('SELECT deleted, version FROM stock_batches WHERE batch_id=?', ['B1'])).rows[0];
  const out = await outboxRow(local, 'B1');
  const payload = JSON.parse(out.payload_json);
  check('row tombstoned at v4', Number(row.deleted) === 1 && Number(row.version) === 4, JSON.stringify(row));
  check('payload.version is 4', Number(payload.version) === 4, `got ${payload.version}`);
  check('payload matches the row clock', Number(payload.version) === Number(row.version));
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[BTV-2] versioned tombstone beats the pre-delete remote on push');
{
  const { local, remote } = await freshDbs();
  await seedBatch(local, 'B1', 'P1', 3, 'devA');
  await seedBatch(remote, 'B1', 'P1', 3, 'devA');
  await tombstoneBatches(local, 'P1', ['B1'], 'devA');
  const res = await pushBatch(remote, await outboxRow(local, 'B1'), 'devA', 't12');
  const after = (await remote.execute('SELECT deleted, version FROM stock_batches WHERE batch_id=?', ['B1'])).rows[0];
  check('push rowsAffected is 1 (guard accepted v4 > v3)', res.rowsAffected === 1, `got ${res.rowsAffected}`);
  check('remote tombstoned', Number(after.deleted) === 1, `deleted=${after.deleted}`);
  check('remote version is 4', Number(after.version) === 4, `got ${after.version}`);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[BTV-3] contrast — OLD version-less payload loses to any synced row');
{
  const { local, remote } = await freshDbs();
  await seedBatch(local, 'B1', 'P1', 3, 'devA');
  await seedBatch(remote, 'B1', 'P1', 3, 'devA');
  await tombstoneBatchesOld(local, 'P1', ['B1']);
  const out = await outboxRow(local, 'B1');
  check('OLD payload has no version', JSON.parse(out.payload_json).version === undefined);
  const res = await pushBatch(remote, out, 'devA', 't12');
  const after = (await remote.execute('SELECT deleted, version FROM stock_batches WHERE batch_id=?', ['B1'])).rows[0];
  check('OLD push rowsAffected is 0 (v1 rejected by v3)', res.rowsAffected === 0, `got ${res.rowsAffected}`);
  check('OLD remote row untouched (still live)', Number(after.deleted) === 0, `deleted=${after.deleted}`);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[BTV-4] self-heal belt refreshes a legacy version-less payload strikeless');
{
  const { local, remote } = await freshDbs();
  await seedBatch(local, 'B1', 'P1', 3, 'devA');
  await seedBatch(remote, 'B1', 'P1', 3, 'devA');
  await tombstoneBatchesOld(local, 'P1', ['B1']); // legacy row, no version
  await local.execute(`UPDATE sync_outbox SET retry_count=9 WHERE entity_id='B1'`); // one strike from quarantine
  const belt = await selfHealBelt(local, await outboxRow(local, 'B1'));
  const out = await outboxRow(local, 'B1');
  const payload = JSON.parse(out.payload_json);
  check('belt healed the row', belt.healed === true);
  check('payload.version refreshed to local v4', Number(payload.version) === 4, `got ${payload.version}`);
  check('no strike burned (retry_count still 9)', Number(out.retry_count) === 9, `got ${out.retry_count}`);
  const res = await pushBatch(remote, out, 'devA', 't12');
  check('healed push lands (v4 > v3)', res.rowsAffected === 1, `got ${res.rowsAffected}`);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[BTV-5] belt does NOT inflate a genuinely-superseded payload');
{
  const { local, remote } = await freshDbs();
  await seedBatch(local, 'B1', 'P1', 2, 'devA');   // local behind
  await seedBatch(remote, 'B1', 'P1', 5, 'devB');  // remote newer (peer edits)
  await tombstoneBatches(local, 'P1', ['B1'], 'devA'); // local v2 -> tombstone v3
  const belt = await selfHealBelt(local, await outboxRow(local, 'B1'));
  check('belt does not heal (local v3 < remote v5 is genuine staleness)', belt.healed === false);
  const res = await pushBatch(remote, await outboxRow(local, 'B1'), 'devA', 't12');
  check('superseded push still rejected (v3 < v5)', res.rowsAffected === 0, `got ${res.rowsAffected}`);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[BTV-6] fresh re-tombstone resets strikes (no instant re-quarantine)');
{
  const { local, remote } = await freshDbs();
  await seedBatch(local, 'B1', 'P1', 3, 'devA');
  await tombstoneBatches(local, 'P1', ['B1'], 'devA');
  await local.execute(`UPDATE sync_outbox SET retry_count=10, last_error='old', next_retry_at='t9' WHERE entity_id='B1'`);
  // resurrected then re-deleted: the UPDATE below re-arms the same batch
  await local.execute(`UPDATE stock_batches SET deleted=0, version=version+1 WHERE batch_id='B1'`);
  await tombstoneBatches(local, 'P1', ['B1'], 'devA');
  const out = await outboxRow(local, 'B1');
  check('retry_count reset to 0', Number(out.retry_count) === 0, `got ${out.retry_count}`);
  check('last_error cleared', out.last_error === null, `got ${out.last_error}`);
  check('fresh tombstone carries the newest clock (v6)', JSON.parse(out.payload_json).version === 6, `got ${JSON.parse(out.payload_json).version}`);
  await local.close(); await remote.close();
}

for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may be locked */ }
}

console.log(`\nBTV TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
if (failed > 0) process.exit(1);
process.exit(0);
