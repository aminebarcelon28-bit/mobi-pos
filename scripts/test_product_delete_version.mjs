/**
 * H18b regression test — a soft-deleted product cannot be resurrected by a
 * stale same-version pull echo.
 *
 * Root cause fixed in sqlPluginAdapter.syncProductDelete:
 *   BEFORE: `UPDATE products SET deleted=1, updated_at=$1, sync_status='pending'`
 *           bumped NO version, so the local row stayed at vN. The pull guard
 *           `WHERE excluded.version >= products.version` then accepted a stale
 *           echo at vN (vN >= vN) and wrote deleted=0 — silently un-deleting
 *           the product and making it buyable again at the till.
 *   AFTER:  the delete bumps `version = version + 1` and stamps that value into
 *           the tombstone payload, so the stale echo is rejected (vN >= vN+1
 *           is false) and the delete survives until the tombstone is pushed.
 *
 * Run: node scripts/test_product_delete_version.mjs
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const TEMP_FILES = [
  'tmp-h18b-local.db', 'tmp-h18b-local.db-wal', 'tmp-h18b-local.db-journal',
  'tmp-h18b-remote.db', 'tmp-h18b-remote.db-wal', 'tmp-h18b-remote.db-journal',
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

const PRODUCTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL DEFAULT '', sync_status TEXT NOT NULL DEFAULT 'pending',
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0
  );
`;

/** Verbatim fixed syncProductDelete (the code under test). */
async function syncProductDelete(local, id) {
  const now = 't10';
  const safeId = String(id || '');
  if (!safeId) return;
  const rows = (await local.execute('SELECT * FROM products WHERE id=?', [safeId])).rows;
  const pkey = rows?.[0]?.idempotency_key || `legacy-${safeId}`;
  const tombstoneVersion = Number(rows?.[0]?.version ?? 0) + 1;
  const snapshot = { ...(rows?.[0] ?? { id: safeId }), deleted: 1, updated_at: now, version: tombstoneVersion };
  await local.execute(
    'UPDATE products SET deleted=1, version=version+1, updated_at=?, sync_status=\'pending\' WHERE id=?',
    [now, safeId],
  );
  await local.execute(
    `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
     VALUES (?,'product',?,'DELETE',?,'pending')
     ON CONFLICT(idempotency_key) DO UPDATE SET operation='DELETE', payload_json=excluded.payload_json,
       status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL, updated_at=?`,
    [pkey, safeId, JSON.stringify(snapshot), now],
  );
  return { tombstoneVersion, snapshot };
}

/** Verbatim products pull upsert guard (SyncManager.applyRemoteRow). */
async function pullProduct(local, remoteRow) {
  return local.execute(
    `INSERT INTO products (id, title, stock, idempotency_key, sync_status, version, updated_at, deleted)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted, version=excluded.version,
       title=excluded.title,
       updated_at=excluded.updated_at, sync_status='synced'
     WHERE excluded.version >= products.version`,
    [remoteRow.id, remoteRow.title, remoteRow.stock, remoteRow.idempotency_key, 'synced',
      remoteRow.version, remoteRow.updated_at, remoteRow.deleted],
  );
}

async function freshDbs() {
  const local = createClient({ url: 'file:tmp-h18b-local.db' });
  const remote = createClient({ url: 'file:tmp-h18b-remote.db' });
  for (const c of [local, remote]) {
    await c.execute(PRODUCTS_SCHEMA);
    await c.execute(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT,
        created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
      );
    `);
    // Self-healing: a prior group may still hold the file (a locked WAL sidecar
    // can survive rmSync on Windows), so truncate rather than rely on removal.
    await c.execute('DELETE FROM products');
    await c.execute('DELETE FROM sync_outbox');
  }
  return { local, remote };
}

async function seed(c, version, deleted) {
  await c.execute(
    `INSERT INTO products (id, title, stock, idempotency_key, sync_status, version, updated_at, deleted)
     VALUES ('P1','Widget',10,'K1','synced',?,?,?)`,
    [version, deleted ? 't5' : 't5', deleted ? 1 : 0],
  );
}

// ---------------------------------------------------------------------------
console.log('\n[H18b-1] delete bumps the local version clock');
{
  const { local, remote } = await freshDbs();
  for (const c of [local, remote]) await seed(c, 5, false);
  const before = Number((await local.execute('SELECT version FROM products WHERE id=?', ['P1'])).rows[0].version);
  const { tombstoneVersion } = await syncProductDelete(local, 'P1');
  const after = Number((await local.execute('SELECT version FROM products WHERE id=?', ['P1'])).rows[0].version);
  check('version before delete is 5', before === 5, `got ${before}`);
  check('version after delete is 6', after === 6, `got ${after}`);
  check('tombstone payload version is 6', tombstoneVersion === 6, `got ${tombstoneVersion}`);
  check('tombstone payload version matches the row', tombstoneVersion === after);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[H18b-2] a stale same-version echo does NOT resurrect the product');
{
  const { local, remote } = await freshDbs();
  for (const c of [local, remote]) await seed(c, 5, false);
  await syncProductDelete(local, 'P1');
  const echo = (await remote.execute('SELECT * FROM products WHERE id=?', ['P1'])).rows[0];
  const res = await pullProduct(local, echo);
  const after = (await local.execute('SELECT deleted, version FROM products WHERE id=?', ['P1'])).rows[0];
  check('stale echo rowsAffected is 0 (guard rejected it)', res.rowsAffected === 0, `got ${res.rowsAffected}`);
  check('product stays deleted', Number(after.deleted) === 1, `deleted=${after.deleted}`);
  check('version stays at 6', Number(after.version) === 6, `got ${after.version}`);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[H18b-3] a genuinely NEWER remote row still wins (LWW preserved)');
{
  const { local, remote } = await freshDbs();
  for (const c of [local, remote]) await seed(c, 5, false);
  await syncProductDelete(local, 'P1'); // local now v6 deleted
  // a peer edits the product after seeing the delete: remote v7, deleted=0
  await remote.execute(
    `UPDATE products SET title='Widget reborn', version=7, updated_at='t11', deleted=0 WHERE id='P1'`,
  );
  const newer = (await remote.execute('SELECT * FROM products WHERE id=?', ['P1'])).rows[0];
  const res = await pullProduct(local, newer);
  const after = (await local.execute('SELECT deleted, version, title FROM products WHERE id=?', ['P1'])).rows[0];
  check('newer remote row lands', res.rowsAffected === 1, `got ${res.rowsAffected}`);
  check('local version advances to 7', Number(after.version) === 7, `got ${after.version}`);
  check('the newer remote title is kept', after.title === 'Widget reborn', `got ${after.title}`);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[H18b-4] the DELETE outbox row carries the bumped version');
{
  const { local, remote } = await freshDbs();
  for (const c of [local, remote]) await seed(c, 5, false);
  await syncProductDelete(local, 'P1');
  const out = (await local.execute('SELECT operation, payload_json FROM sync_outbox WHERE entity_id=?', ['P1'])).rows[0];
  const payload = JSON.parse(out.payload_json);
  check('outbox operation is DELETE', out.operation === 'DELETE', `got ${out.operation}`);
  check('payload.deleted is 1', Number(payload.deleted) === 1, `got ${payload.deleted}`);
  check('payload.version is 6 (strictly above the pre-delete 5)', Number(payload.version) === 6, `got ${payload.version}`);
  // toRemoteUpsert's DELETE branch sends version + 1
  const pushedVersion = Number(payload.version) + 1;
  check('pushed tombstone version (payload.version+1) is 7', pushedVersion === 7, `got ${pushedVersion}`);
  // and it must beat the pre-delete remote version
  check('pushed tombstone beats the remote v5', pushedVersion > 5);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[H18b-5] contrast — the OLD behaviour resurrected the product');
{
  const local = createClient({ url: 'file:tmp-h18b-local.db' });
  const remote = createClient({ url: 'file:tmp-h18b-remote.db' });
  for (const c of [local, remote]) {
    await c.execute('DELETE FROM products WHERE id=?', ['P1']);
    await seed(c, 5, false);
  }
  // OLD broken delete: no version bump
  await local.execute('UPDATE products SET deleted=1, updated_at=?, sync_status=\'pending\' WHERE id=?', ['t10', 'P1']);
  const echo = (await remote.execute('SELECT * FROM products WHERE id=?', ['P1'])).rows[0];
  const res = await pullProduct(local, echo);
  const after = (await local.execute('SELECT deleted, version FROM products WHERE id=?', ['P1'])).rows[0];
  check('OLD: stale echo rowsAffected is 1 (guard accepted it)', res.rowsAffected === 1, `got ${res.rowsAffected}`);
  check('OLD: product was resurrected (deleted=0)', Number(after.deleted) === 0, `deleted=${after.deleted}`);
  check('OLD: version never moved (still 5)', Number(after.version) === 5, `got ${after.version}`);
  await local.close(); await remote.close();
}

// ---------------------------------------------------------------------------
console.log('\n[H18b-6] deleting a never-synced product (version default 1) still works');
{
  const { local, remote } = await freshDbs();
  await local.execute(
    `INSERT INTO products (id, title, stock, idempotency_key, sync_status, version, updated_at, deleted)
     VALUES ('P2','Gadget',3,'K2','pending',1,'t1',0)`,
  );
  const { tombstoneVersion } = await syncProductDelete(local, 'P2');
  const after = (await local.execute('SELECT deleted, version FROM products WHERE id=?', ['P2'])).rows[0];
  check('version bumped from 1 to 2', Number(after.version) === 2, `got ${after.version}`);
  check('tombstone version is 2', tombstoneVersion === 2, `got ${tombstoneVersion}`);
  check('product is deleted', Number(after.deleted) === 1);
  await local.close(); await remote.close();
}

for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may be locked */ }
}

console.log(`\nH18B TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
if (failed > 0) process.exit(1);
process.exit(0);
