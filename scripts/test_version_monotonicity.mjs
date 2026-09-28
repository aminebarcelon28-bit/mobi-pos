// Adversarial test: does the local upsert's `WHERE excluded.version >= X`
// guard actually reject stale writes, or does version non-monotonicity let a
// stale row overwrite a newer one (lost update)?
//
// Simulates: Device A sells (v1 -> v2). A queued STALE product row (v1) is then
// applied. Does the newer v2 survive?
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' :: ' + extra : ''}`);
}

// Local file DB (repo test convention); only the upsert semantics matter.
const DB_FILE = 'file:tmp-version-monotonicity.db';
// Self-healing: a previous run may have exited while libsql still held the
// file handle, so its rmSync hit a Windows sharing violation and left the DB
// behind. Delete BEFORE opening the client, otherwise this test is not
// re-runnable (a stale products row makes the plain INSERT below throw
// SQLITE_CONSTRAINT_PRIMARYKEY on every subsequent run).
const TEMP_DB_FILES = ['tmp-version-monotonicity.db', 'tmp-version-monotonicity.db-wal', 'tmp-version-monotonicity.db-journal'];
for (const f of TEMP_DB_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may still be locked; CREATE TABLE IF NOT EXISTS keeps us safe */ }
}
const db = createClient({ url: DB_FILE });

await db.execute(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
`);

// v1 baseline
await db.execute(
  `INSERT INTO products (id, title, stock, version, updated_at, deleted)
   VALUES ('P1','Phone',10,1,'t1',0)`,
);

// Newer write lands first (v2, stock 5)
await db.execute(
  `INSERT INTO products (id, title, stock, version, updated_at, deleted)
   VALUES ('P1','Phone',5,2,'t2',0)
   ON CONFLICT(id) DO UPDATE SET stock=excluded.stock, version=excluded.version,
     updated_at=excluded.updated_at, deleted=excluded.deleted
   WHERE excluded.version >= products.version`,
);

// Stale write arrives later (v1, stock 999) — must NOT clobber v2
await db.execute(
  `INSERT INTO products (id, title, stock, version, updated_at, deleted)
   VALUES ('P1','Phone',999,1,'t3',0)
   ON CONFLICT(id) DO UPDATE SET stock=excluded.stock, version=excluded.version,
     updated_at=excluded.updated_at, deleted=excluded.deleted
   WHERE excluded.version >= products.version`,
);

const rows = (await db.execute('SELECT stock, version FROM products WHERE id = ?', ['P1'])).rows;
check('stale v1 row does not clobber newer v2 (stock stays 5)', rows[0]?.stock === 5, `got stock=${rows[0]?.stock} v=${rows[0]?.version}`);

// --- Equal-version tie: two devices both write v2 ---
await db.execute(
  `INSERT INTO products (id, title, stock, version, updated_at, deleted)
   VALUES ('P1','Phone',7,2,'t4',0)
   ON CONFLICT(id) DO UPDATE SET stock=excluded.stock, version=excluded.version,
     updated_at=excluded.updated_at, deleted=excluded.deleted
   WHERE excluded.version >= products.version`,
);
const rows2 = (await db.execute('SELECT stock, version FROM products WHERE id = ?', ['P1'])).rows;
check('equal-version (>=) tie is last-writer-wins, stock=7', rows2[0]?.stock === 7, `got stock=${rows2[0]?.stock}`);

// --- The customer lane: version is COALESCE(version,1)+1, so it is monotonic ---
await db.execute(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    store_credit INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  );
`);
await db.execute(
  `INSERT INTO customers (id, name, store_credit, version, updated_at)
   VALUES ('C1','Alice',100,1,'t1')`,
);
// saveCustomer() shape: version = COALESCE(customers.version,1)+1
for (const [credit, expectedVersion] of [[90, 2], [80, 3], [70, 4]]) {
  await db.execute(
    `INSERT INTO customers (id, name, store_credit, version, updated_at)
     VALUES ('C1','Alice',${credit},2,'t2')
     ON CONFLICT(id) DO UPDATE SET store_credit=excluded.store_credit,
       version = COALESCE(customers.version, 1) + 1`,
  );
  const r = (await db.execute('SELECT store_credit, version FROM customers WHERE id = ?', ['C1'])).rows;
  check(`customer save #${expectedVersion - 1} bumps version monotonically`, r[0]?.version === expectedVersion, `credit=${r[0]?.store_credit} v=${r[0]?.version}`);
}

// --- The transactions lane: local write never bumps version at all ---
await db.execute(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    total INTEGER NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  );
`);
// Local checkout upsert (writeCheckoutAtomic): no version in the column list
await db.execute(
  `INSERT INTO transactions (id, total, status, version, updated_at)
   VALUES ('T1', 500, 'COMPLETED', 1, 't1')
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total, updated_at=excluded.updated_at`,
);
// Remote pull of the same id (applyRemoteRow): version=1 again
await db.execute(
  `INSERT INTO transactions (id, total, status, version, updated_at)
   VALUES ('T1', 500, 'COMPLETED', 1, 't2')
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total,
     version=excluded.version, updated_at=excluded.updated_at
   WHERE excluded.version >= transactions.version`,
);
const t = (await db.execute('SELECT version FROM transactions WHERE id = ?', ['T1'])).rows;
check('transaction version stays 1 after local write + remote echo', t[0]?.version === 1, `v=${t[0]?.version}`);

// Consequence probe: a later REMOTE update (v1) vs a later LOCAL void.
// REGRESSION (un-voiding bug): a local void now bumps the version clock
// (writeCheckoutAtomic / enqueueOrderSync). A queued remote echo of the
// ORIGINAL sale (v1, COMPLETED) must then be rejected by the `>=` guard.
await db.execute(
  `INSERT INTO transactions (id, total, status, version, updated_at)
   VALUES ('T2', 500, 'COMPLETED', 1, 't1')
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total, updated_at=excluded.updated_at`,
);
// local void (FIXED): status flips AND version bumps
await db.execute(`UPDATE transactions SET status='VOIDED', updated_at='t2', version=2 WHERE id='T2'`);
// remote echo of the pre-void sale, same version 1
await db.execute(
  `INSERT INTO transactions (id, total, status, version, updated_at)
   VALUES ('T2', 500, 'COMPLETED', 1, 't3')
   ON CONFLICT(id) DO UPDATE SET status=excluded.status, total=excluded.total,
     version=excluded.version, updated_at=excluded.updated_at
   WHERE excluded.version >= transactions.version`,
);
const t2 = (await db.execute('SELECT status, version FROM transactions WHERE id = ?', ['T2'])).rows;
check('VOIDED sale survives a stale same-version COMPLETED echo', t2[0]?.status === 'VOIDED' && t2[0]?.version === 2, `status=${t2[0]?.status} v=${t2[0]?.version}`);

const failed = results.filter((r) => !r.ok);
console.log('====================================================');
console.log(`TEST SUMMARY: ${results.length - failed.length} PASSED, ${failed.length} FAILED`);
console.log('====================================================');
if (failed.length > 0) {
  console.log('FAILURES:');
  for (const f of failed) console.log(' - ' + f.name);
}
await db.close();
for (const f of TEMP_DB_FILES) {
  try { rmSync(f, { force: true }); } catch { /* WAL sidecar may still be open */ }
}
process.exit(failed.length > 0 ? 1 : 0);
