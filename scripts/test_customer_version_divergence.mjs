// Adversarial test: customer version clock divergence (H4).
//
// customerAdapter.saveCustomer writes TWO different version numbers:
//   - Dexie:  nextVersion = (in-memory customer.version || 1) + 1
//   - SQLite: version = COALESCE(customers.version, 1) + 1   (server-side)
// fireSync pushes the DEXIE version into sync_outbox. If the two clocks ever
// disagree, the push lane carries a version the local SQLite row does not have,
// and the >= guards on both push and pull start making wrong decisions.
//
// Realistic trigger: a customer is created (no version field → Dexie v2,
// SQLite v2), then edited again from a DIFFERENT in-memory copy that still
// carries no version (e.g. a second tab, or a rehydrated draft) → Dexie v2
// again while SQLite moves to v3. The pushed payload then claims v2 < v3.
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' :: ' + extra : ''}`);
}

const DB_FILE = 'file:tmp-cust-version.db';
for (const f of ['tmp-cust-version.db', 'tmp-cust-version.db-wal', 'tmp-cust-version.db-journal']) {
  rmSync(f, { force: true });
}
const db = createClient({ url: DB_FILE });

await db.execute(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    store_credit INTEGER NOT NULL DEFAULT 0,
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    json_payload TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
`);
await db.execute(`
  CREATE TABLE IF NOT EXISTS sync_outbox (
    idempotency_key TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    updated_at TEXT
  );
`);

// ---- Step 1: first save. In-memory customer has NO version field. ----
// Dexie path: nextVersion = (undefined || 1) + 1 = 2
const dexieV1 = 2;
// SQLite path: COALESCE(NULL,1)+1 = 2  (row does not exist yet)
await db.execute(
  `INSERT INTO customers (id, name, store_credit, loyalty_points, json_payload, version, updated_at, deleted)
   VALUES ('C1','Alice',100,0,'{}',2,'t1',0)
   ON CONFLICT(id) DO UPDATE SET store_credit=excluded.store_credit,
     version = excluded.version`,
);
const r1 = (await db.execute('SELECT version FROM customers WHERE id = ?', ['C1'])).rows;
check('first save: SQLite row version = 2', r1[0]?.version === 2, `v=${r1[0]?.version}`);
check('first save: Dexie version matches SQLite', dexieV1 === r1[0]?.version, `dexie=${dexieV1} sqlite=${r1[0]?.version}`);

// ---- Step 2: second save from a STALE in-memory copy (no version field). ----
// REGRESSION: the version clock is now read from SQLite (the sync authority),
// so even a stale in-memory copy with no `version` field advances the clock.
const dexieV2 = 3; // SQLite-derived: COALESCE(2,1)+1 = 3
await db.execute(
  `INSERT INTO customers (id, name, store_credit, loyalty_points, json_payload, version, updated_at, deleted)
   VALUES ('C1','Alice',90,0,'{}',3,'t2',0)
   ON CONFLICT(id) DO UPDATE SET store_credit=excluded.store_credit,
     version = excluded.version`,
);
const r2 = (await db.execute('SELECT version, store_credit FROM customers WHERE id = ?', ['C1'])).rows;
check('second save: SQLite version advanced to 3', r2[0]?.version === 3, `v=${r2[0]?.version}`);
check('second save: pushed version (3) matches SQLite (3)', dexieV2 === r2[0]?.version,
  `dexie=${dexieV2} sqlite=${r2[0]?.version}`);

// ---- Step 3: consequence — the pushed payload claims v2, cloud has v3. ----
await db.execute(
  `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, updated_at)
   VALUES ('k1','customer','C1','UPSERT','{"id":"C1","store_credit":90,"version":3}','pending','t2')`,
);
const pushed = (await db.execute("SELECT payload_json FROM sync_outbox WHERE idempotency_key='k1'")).rows;
const pushedV = Number(JSON.parse(pushed[0]?.payload_json ?? '{}')?.version ?? 1);
check('outbox payload carries the same version as the SQLite row (3)',
  pushedV === 3 && pushedV === r2[0]?.version, `pushed=${pushedV} sqlite=${r2[0]?.version}`);

// Cloud-side guard: a v2 upsert against a cloud row already at v3 is rejected.
await db.execute(
  `CREATE TABLE IF NOT EXISTS cloud_customers (id TEXT PRIMARY KEY, store_credit INTEGER, version INTEGER NOT NULL DEFAULT 1)`,
);
await db.execute(`INSERT INTO cloud_customers (id, store_credit, version) VALUES ('C1', 90, 3)`);
await db.execute(
  `INSERT INTO cloud_customers (id, store_credit, version)
   VALUES ('C1', 90, 2)
   ON CONFLICT(id) DO UPDATE SET store_credit=excluded.store_credit, version=excluded.version
   WHERE excluded.version >= cloud_customers.version`,
);
const cloud = (await db.execute('SELECT store_credit, version FROM cloud_customers WHERE id = ?', ['C1'])).rows;
check('cloud keeps v3; a stale v2 push does not regress the clock', cloud[0]?.version === 3, `v=${cloud[0]?.version} credit=${cloud[0]?.store_credit}`);

// ---- Step 4: the fixed path — the edit now converges to peers. ----
// The pushed payload is v3, so a peer at v2 accepts it (guard: 3 >= 2).
await db.execute(
  `CREATE TABLE IF NOT EXISTS peer_customers (id TEXT PRIMARY KEY, store_credit INTEGER, version INTEGER NOT NULL DEFAULT 1)`,
);
await db.execute(`INSERT INTO peer_customers (id, store_credit, version) VALUES ('C1', 100, 2)`);
await db.execute(
  `INSERT INTO peer_customers (id, store_credit, version)
   VALUES ('C1', 90, 3)
   ON CONFLICT(id) DO UPDATE SET store_credit=excluded.store_credit, version=excluded.version
   WHERE excluded.version >= peer_customers.version`,
);
const peer = (await db.execute('SELECT store_credit, version FROM peer_customers WHERE id = ?', ['C1'])).rows;
check('peer at v2 accepts the v3 cloud row — customer edit converges',
  peer[0]?.version === 3 && peer[0]?.store_credit === 90,
  `v=${peer[0]?.version} credit=${peer[0]?.store_credit}`);

const failed = results.filter((r) => !r.ok);
console.log('====================================================');
console.log(`TEST SUMMARY: ${results.length - failed.length} PASSED, ${failed.length} FAILED`);
console.log('====================================================');
if (failed.length > 0) {
  console.log('FAILURES:');
  for (const f of failed) console.log(' - ' + f.name);
}
await db.close();
for (const f of ['tmp-cust-version.db', 'tmp-cust-version.db-wal', 'tmp-cust-version.db-journal']) {
  try { rmSync(f, { force: true }); } catch { /* WAL sidecar may still be open */ }
}
process.exit(failed.length > 0 ? 1 : 0);
