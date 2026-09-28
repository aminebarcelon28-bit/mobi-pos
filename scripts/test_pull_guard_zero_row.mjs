// H15 regression â€” the pull-side twin of H14.
//
// The 4 non-generic pull lanes (products, transactions, transaction_items,
// inventory_ledger) guard their local upsert with
// `WHERE excluded.version >= <table>.version`. libsql/plugin-sql resolves a
// guarded upsert that matches ZERO rows successfully (rowsAffected: 0) â€” it does
// NOT throw. The pull loop therefore sees a clean apply and advances the keyset
// cursor past the rejected row. That remote change is silently skipped on this
// device forever â†’ contract C6 (silent data loss).
//
// This test reproduces the failure mode against a real libsql local DB using
// the VERBATIM products upsert from applyRemoteRow, and models the fix: the
// apply must report whether it landed, and the cursor may only advance when it
// did.
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = join(here, 'tmp-h15-local.db');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(p)) fs.unlinkSync(p);

const db = createClient({ url: `file:${dbPath}` });
let pass = 0, fail = 0;
const check = (n, c, e = '') => c ? (pass++, console.log(`[PASS] ${n}`)) : (fail++, console.log(`[FAIL] ${n} ${e}`));

await db.execute(`CREATE TABLE products (
  id TEXT PRIMARY KEY, sku TEXT, barcode TEXT, title TEXT, brand TEXT,
  compatible_model TEXT, category TEXT, price REAL, wholesale_price REAL,
  cost_price REAL, stock INTEGER, image_url TEXT, is_serialized INTEGER,
  imei_number TEXT, vendor_name TEXT, lead_time_days INTEGER,
  daily_sales_velocity REAL, reorder_point INTEGER, json_payload TEXT,
  device_id TEXT, idempotency_key TEXT, sync_status TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT, deleted INTEGER NOT NULL DEFAULT 0)`);

// VERBATIM products upsert from applyRemoteRow (SyncManager.ts ~L1604), with
// the non-version/stock columns defaulted. Placeholder order matters:
// index 10 = stock, index 22 = version.
function pullProduct(id, version, stock) {
  return {
    sql: `INSERT INTO products (id, sku, barcode, title, brand, compatible_model, category, price, wholesale_price,
          cost_price, stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days,
          daily_sales_velocity, reorder_point, json_payload, device_id, idempotency_key, sync_status,
          version, created_at, updated_at, deleted)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, title=excluded.title,
           brand=excluded.brand, compatible_model=excluded.compatible_model, category=excluded.category,
           price=excluded.price, wholesale_price=excluded.wholesale_price, cost_price=excluded.cost_price,
           stock=excluded.stock, image_url=excluded.image_url, is_serialized=excluded.is_serialized,
           imei_number=excluded.imei_number, vendor_name=excluded.vendor_name,
           lead_time_days=excluded.lead_time_days, daily_sales_velocity=excluded.daily_sales_velocity,
           reorder_point=excluded.reorder_point, json_payload=excluded.json_payload,
           version=excluded.version, updated_at=excluded.updated_at,
           deleted=excluded.deleted, sync_status='synced'
           WHERE excluded.version >= products.version`,
    args: [
      id, 'SKU', '', 'Widget', 'Autre', '', 'Tous les produits',
      10, 0, 0, stock, null, 0, null, null, 7, 0, 5, '{}', 'remote', `idem-${id}`,
      version, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0,
    ],
  };
}
const readRow = async (id) => (await db.execute({ sql: `SELECT version, stock, title FROM products WHERE id = ?`, args: [id] })).rows[0];

// 1 â€” a local write bumps the version clock (as the checkout stock path does).
await db.execute(pullProduct('P-1', 1, 5));
await db.execute({ sql: `UPDATE products SET stock = 3, version = version + 1 WHERE id = 'P-1'`, args: [] });
let local = await readRow('P-1');
check('local write bumped the version clock to 2', Number(local?.version) === 2, `got ${local?.version}`);

// 2 â€” a pulled row at a LOWER version (reordered echo of an older remote edit).
const pulledLower = await db.execute(pullProduct('P-1', 1, 9));
check('pulled v1 vs local v2 does NOT throw', pulledLower && typeof pulledLower === 'object');
check('pulled v1 vs local v2 reports rowsAffected 0', pulledLower.rowsAffected === 0, `got ${pulledLower.rowsAffected}`);
local = await readRow('P-1');
check('the rejected pull left local stock untouched (3)', Number(local?.stock) === 3, `got ${local?.stock}`);
check('the rejected pull left local version at 2', Number(local?.version) === 2, `got ${local?.version}`);

// 3 â€” THE DEFECT: the pull loop advances the cursor on a non-throwing apply.
// Model the fix: only advance when the apply actually landed.
async function applyAndAdvance(id, version, stock, cursor) {
  const res = await db.execute(pullProduct(id, version, stock));
  const landed = res.rowsAffected > 0;
  return { landed, nextCursor: landed ? { time: 'now', id } : cursor };
}
const cursor = { time: 't0', id: '' };
let r = await applyAndAdvance('P-1', 1, 9, cursor);
check('rejected apply reports landed=false', r.landed === false);
check('cursor does NOT advance past a rejected apply', r.nextCursor === cursor);

// 4 â€” an accepted apply DOES advance the cursor.
r = await applyAndAdvance('P-1', 3, 12, cursor);
check('fresh v3 vs local v2 is accepted', r.landed === true);
check('cursor advances past an accepted apply', r.nextCursor.id === 'P-1');
local = await readRow('P-1');
check('accepted apply wrote stock 12', Number(local?.stock) === 12, `got ${local?.stock}`);
check('accepted apply wrote version 3', Number(local?.version) === 3, `got ${local?.version}`);

// 5 â€” the tie case: equal versions pass the >= guard, so a same-version remote
// edit lands (correct LWW). This is why the local clock must be bumped past it
// on apply, or the next local write re-emits the same version.
r = await applyAndAdvance('P-1', 3, 20, cursor);
check('tie (v3 vs v3) passes the >= guard', r.landed === true);
local = await readRow('P-1');
check('tie apply wrote stock 20', Number(local?.stock) === 20, `got ${local?.stock}`);

// 6 â€” the H13-analogue for non-generic lanes: after a pull lands version N, the
// next LOCAL write must emit N+1, not a stale lower number.
const afterPull = Number((await readRow('P-1')).version);
await db.execute({ sql: `UPDATE products SET stock = 21, version = version + 1 WHERE id = 'P-1'`, args: [] });
const afterLocal = Number((await readRow('P-1')).version);
check('next local write emits version N+1', afterLocal === afterPull + 1, `got ${afterLocal} after ${afterPull}`);

// 7 â€” a first-ever row (no local clock) always applies.
const first = await db.execute(pullProduct('P-NEW', 1, 7));
check('first-ever row applies', first.rowsAffected === 1, `got ${first.rowsAffected}`);

// 8 â€” a deleted-flag pull at a lower version is also rejected (tombstones must
// not resurrect a newer live row).
await db.execute({
  sql: `INSERT INTO products (id, sku, title, stock, version, updated_at, deleted)
        VALUES ('P-2','SKU','Ghost',1,1,'t',0)
        ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted, version=excluded.version
        WHERE excluded.version >= products.version`,
  args: [],
});
await db.execute({ sql: `UPDATE products SET version = 5 WHERE id = 'P-2'`, args: [] });
const tombRej = await db.execute({
  sql: `INSERT INTO products (id, sku, title, stock, version, updated_at, deleted)
        VALUES ('P-2','SKU','Ghost',1,2,'t',1)
        ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted, version=excluded.version
        WHERE excluded.version >= products.version`,
  args: [],
});
check('stale tombstone (v2 vs local v5) is rejected', tombRej.rowsAffected === 0, `got ${tombRej.rowsAffected}`);
check('live row survives a stale tombstone', Number((await db.execute({ sql: `SELECT deleted FROM products WHERE id='P-2'`, args: [] })).rows[0]?.deleted) === 0);

// 9 â€” THE C6 DEFECT (proven by scripts/probe_h15_clock.mjs): a catalog edit
// (syncProductUpsert) must bump the version clock AND stamp it into the pushed
// payload, or toRemoteUpsert sends `version || 1` = 1 and the remote guard
// rejects the edit forever. Model the FIXED local upsert (version column
// present and bumped) and the FIXED payload (version field present).
const beforeCatalogEdit = Number((await readRow('P-1')).version);
await db.execute({
  sql: `INSERT INTO products (id, sku, title, price, stock, version, updated_at, deleted)
        VALUES ('P-1','SKU','RENAMED',12,1,?,'t3',0)
        ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, title=excluded.title, price=excluded.price,
          updated_at=excluded.updated_at, deleted=0, version=excluded.version`,
  args: [beforeCatalogEdit + 1],
});
const afterCatalogEdit = await readRow('P-1');
check('catalog edit bumps the version clock', Number(afterCatalogEdit.version) === beforeCatalogEdit + 1, `got ${afterCatalogEdit.version} after ${beforeCatalogEdit}`);
check('catalog edit writes its title', String(afterCatalogEdit.title) === 'RENAMED', `got ${afterCatalogEdit.title}`);

// 10 â€” the payload the outbox row carries must include that bumped version, so
// toRemoteUpsert's `v(version || 1)` sends the clock, not a hardcoded 1.
const pushedPayload = { id: 'P-1', sku: 'SKU', title: 'RENAMED', price: 12, version: Number(afterCatalogEdit.version) };
const pushedVersion = Number(pushedPayload.version ?? 1);
check('pushed payload carries the bumped version', pushedVersion === beforeCatalogEdit + 1, `got ${pushedVersion}`);
// Simulate the REMOTE row at v1 (a fresh row the cloud has only seen once),
// then push the bumped catalog edit at it: the guard must accept.
await db.execute({
  sql: `INSERT INTO products (id, sku, title, price, stock, version, updated_at, deleted)
        VALUES ('P-3','SKU','REMOTE-OLD',9,1,1,'t0',0)`,
  args: [],
});
const remoteRes = await db.execute({
  sql: `INSERT INTO products (id, sku, title, price, stock, version, updated_at, deleted)
        VALUES ('P-3','SKU',?, ?,1, ?,'t4',0)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price,
          version=excluded.version, updated_at=excluded.updated_at
          WHERE excluded.version >= products.version`,
  args: [pushedPayload.title, pushedPayload.price, pushedVersion],
});
const remoteRow = await readRow('P-3');
check('a v1 remote row accepts the bumped catalog edit', remoteRes.rowsAffected === 1, `got ${remoteRes.rowsAffected}`);
check('the bumped catalog edit lands its title on the remote', String(remoteRow?.title) === 'RENAMED', `got ${remoteRow?.title}`);

db.close();
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
console.log(`\n${'='.repeat(72)}\nH15 TEST SUMMARY: ${pass} PASSED, ${fail} FAILED\n${'='.repeat(72)}`);
if (fail > 0) process.exitCode = 1;
