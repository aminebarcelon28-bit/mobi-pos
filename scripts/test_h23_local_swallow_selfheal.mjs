// H23 probe: does a swallowed LOCAL (push-path) authority write self-heal?
//
// customerAdapter.saveCustomer / saveCustomerDebt / deleteCustomer write:
//   1. Dexie replica (UI store)
//   2. SQLite authority row   <-- .catch(() => {})  SWALLOWED
//   3. fireSync -> enqueueGenericSync -> sync_outbox row  (separate, NOT swallowed)
//
// H22 (pull path) was C6 because the cursor ADVANCED PAST the failed row, so
// nothing ever revisited it. Here the outbox write is independent, so the cloud
// should still receive the row and the PULL ECHO should heal the authority.
//
// This test proves or refutes that. If it self-heals, the swallows are a
// quality defect (AGENTS.md S4.2 "never swallow an error") but not C6.
// If it does NOT self-heal in some case, that case is the real bug.

// H26: delete tmp DBs left by a previous run so the suite is re-runnable
for (const f of readdirSync('.')) {
  if (f.startsWith('tmp-h23-') && f.endsWith('.db')) rmSync(f, { force: true });
}

import { createClient } from '@libsql/client';
import { rmSync, readdirSync } from 'node:fs';

const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` :: ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};

// libsql 0.18 has no .select(); route reads through execute().rows
const q = async (c, sql, args = []) => (await c.execute(sql, args)).rows;

// The real local schema (src-tauri/src/lib.rs), one statement per entry:
// libsql execute() runs only the FIRST statement of a multi-statement string.
const SCHEMA = [
  'CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0, pricing_tier TEXT DEFAULT \'Retail\', total_spent REAL DEFAULT 0, json_payload TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0, version INTEGER DEFAULT 1)',
  'CREATE TABLE customer_debts (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL, type TEXT, amount REAL, balance_after REAL, receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT, created_at TEXT, json_payload TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0, version INTEGER DEFAULT 1, FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)',
  'CREATE TABLE entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id))',
  'CREATE TABLE sync_outbox (idempotency_key TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)',
];

async function createAll(client) {
  for (const stmt of SCHEMA) await client.execute(stmt);
}

// The real clock helpers (sqlPluginAdapter.ts), minus the self-heal ALTERs
// (unnecessary here because the schema above already has the version column).
async function bumpEntityVersion(db, entity, id) {
  const rows = await q(db, 'SELECT version FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [entity, id]);
  const current = Number(rows?.[0]?.version ?? 1);
  const next = current + 1;
  await db.execute('UPDATE entity_keys SET version=$1 WHERE entity_type=$2 AND entity_id=$3', [next, entity, id]);
  return next;
}
async function stableEntityKey(db, entity, id) {
  const rows = await q(db, 'SELECT idempotency_key FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [entity, id]);
  if (rows?.[0]?.idempotency_key) return rows[0].idempotency_key;
  const key = 'key-' + entity + '-' + id;
  await db.execute('INSERT OR IGNORE INTO entity_keys (entity_type, entity_id, idempotency_key) VALUES ($1,$2,$3)', [entity, id, key]);
  return key;
}
async function appliedGenericVersion(db, table, id) {
  const rows = await q(db, 'SELECT version FROM entity_keys WHERE entity_type=$1 AND entity_id=$2', [table, id]);
  return Number(rows?.[0]?.version ?? 0);
}
async function advanceEntityClockOnPull(db, table, id, version) {
  await db.execute('INSERT INTO entity_keys (entity_type, entity_id, version, idempotency_key) VALUES ($1,$2,$3,$4) ON CONFLICT(entity_type, entity_id) DO UPDATE SET version = MAX(excluded.version, entity_keys.version)', [table, id, version, 'key-' + table + '-' + id]);
}

// A db wrapper that fails the NEXT write matching a substring.
function makeFailingDb(real) {
  const state = { failNext: null };
  return {
    state,
    execute: async (sql, args) => {
      if (state.failNext && sql.includes(state.failNext)) {
        state.failNext = null;
        throw new Error('SQLITE_BUSY (simulated transient)');
      }
      return real.execute(sql, args);
    },
    select: async (sql, args) => q(real, sql, args),
  };
}

// The post-H22 pull-path mirror: NO swallow; the cursor freeze is modelled by
// the caller stopping at the first throw.
async function applyRemoteRow(db, table, row) {
  const id = row.id;
  const version = Number(row.version ?? 1);
  const payload = row.data_json ?? row;
  if (Number(row.deleted ?? 0) === 1) {
    const appliedDelete = await appliedGenericVersion(db, table, id);
    if (appliedDelete > 0 && appliedDelete > version) return false;
    await advanceEntityClockOnPull(db, table, id, version);
    if (table === 'customers') await db.execute('UPDATE customers SET deleted = 1 WHERE id = $1', [id]);
    return true;
  }
  await advanceEntityClockOnPull(db, table, id, version);
  if (table === 'customers') {
    const c = payload;
    await db.execute(
      'INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0, version=excluded.version WHERE excluded.version >= customers.version',
      [id, String(c.name ?? 'Client'), String(c.phone ?? ''), JSON.stringify(c), row.updated_at, version],
    );
  }
  return true;
}

console.log('\n=== H23: does a swallowed LOCAL authority write self-heal? ===\n');

// ---------------------------------------------------------------------------
// Scenario A: saveCustomer's authority write fails; the outbox still written.
// ---------------------------------------------------------------------------
{
  const local = createClient({ url: 'file:tmp-h23-a-local.db' });
  const cloud = createClient({ url: 'file:tmp-h23-a-cloud.db' });
  await createAll(local);
  await createAll(cloud);

  const db = makeFailingDb(local);
  db.state.failNext = 'INSERT INTO customers';

  const rows = await q(db, 'SELECT version FROM customers WHERE id=$1', ['c1']);
  const nextVersion = Number(rows?.[0]?.version ?? 1) + 1;
  const withVersion = { id: 'c1', name: 'Alice', phone: '555', version: nextVersion };

  try {
    await db.execute(
      'INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0, version=excluded.version',
      ['c1', 'Alice', '555', JSON.stringify(withVersion), '2026-01-01T00:00:00.000Z', nextVersion],
    );
  } catch { /* SWALLOWED - this is the defect under test */ }

  ok('A: the authority write threw (defect reproduced)', !(await q(db, 'SELECT id FROM customers WHERE id=\'c1\'')).length);

  // fireSync -> enqueueGenericSync (a separate write, NOT swallowed)
  const key = await stableEntityKey(local, 'customer', 'c1');
  const outVersion = await bumpEntityVersion(local, 'customer', 'c1');
  await local.execute(
    'INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, updated_at) VALUES ($1,$2,$3,\'UPSERT\',$4,\'pending\',$5) ON CONFLICT(idempotency_key) DO UPDATE SET operation=\'UPSERT\', payload_json=excluded.payload_json, status=\'pending\'',
    [key, 'customer', 'c1', JSON.stringify({ ...withVersion, version: outVersion }), '2026-01-01T00:00:00.000Z'],
  );
  ok('A: the outbox row WAS written despite the swallowed authority write',
    (await q(local, 'SELECT entity_id FROM sync_outbox WHERE entity_id=\'c1\'')).length === 1);

  // push to cloud
  const pushed = JSON.parse((await q(local, 'SELECT payload_json FROM sync_outbox WHERE entity_id=\'c1\''))[0].payload_json);
  await cloud.execute(
    'INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, updated_at=excluded.updated_at',
    ['c1', pushed.name, '555', JSON.stringify(pushed), '2026-01-01T00:00:00.000Z', pushed.version],
  );
  ok('A: the cloud has the row', (await q(cloud, 'SELECT name FROM customers WHERE id=\'c1\''))[0].name === 'Alice');

  // pull echo back into the local authority
  const echo = await q(cloud, 'SELECT id, name, json_payload, version, updated_at, deleted FROM customers');
  let landed = 0;
  for (const r of echo) {
    if (await applyRemoteRow(local, 'customers', { ...r, data_json: JSON.parse(r.json_payload) })) landed++;
  }
  ok('A: the pull echo landed', landed === 1);
  ok('A: THE AUTHORITY SELF-HEALED via the pull echo',
    (await q(local, 'SELECT name FROM customers WHERE id=\'c1\''))[0]?.name === 'Alice');

  await local.close();
  await cloud.close();
}

// ---------------------------------------------------------------------------
// Scenario B: deleteCustomer's tombstone authority write fails.
// ---------------------------------------------------------------------------
{
  const local = createClient({ url: 'file:tmp-h23-b-local.db' });
  const cloud = createClient({ url: 'file:tmp-h23-b-cloud.db' });
  await createAll(local);
  await createAll(cloud);

  await local.execute('INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES (\'c2\',\'Bob\',\'666\',\'{}\',\'2026-01-01T00:00:00.000Z\',0,5)');
  await advanceEntityClockOnPull(local, 'customer', 'c2', 5);
  await cloud.execute('INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES (\'c2\',\'Bob\',\'666\',\'{}\',\'2026-01-01T00:00:00.000Z\',0,5)');

  const db = makeFailingDb(local);
  db.state.failNext = 'UPDATE customers SET deleted';

  try {
    await db.execute('UPDATE customers SET deleted = 1 WHERE id = $1', ['c2']);
  } catch { /* SWALLOWED */ }

  ok('B: the tombstone write threw (defect reproduced)',
    (await q(local, 'SELECT deleted FROM customers WHERE id=\'c2\''))[0].deleted === 0);

  const key = await stableEntityKey(local, 'customer', 'c2');
  const tombVersion = await bumpEntityVersion(local, 'customer', 'c2');
  await local.execute(
    'INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, updated_at) VALUES ($1,$2,$3,\'DELETE\',$4,\'pending\',$5) ON CONFLICT(idempotency_key) DO UPDATE SET operation=\'DELETE\', payload_json=excluded.payload_json, status=\'pending\'',
    [key, 'customer', 'c2', JSON.stringify({ id: 'c2', deleted: 1, version: tombVersion }), '2026-01-02T00:00:00.000Z'],
  );
  ok('B: the DELETE outbox row was written', (await q(local, 'SELECT operation FROM sync_outbox WHERE entity_id=\'c2\''))[0].operation === 'DELETE');

  await cloud.execute(
    'INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES (\'c2\',\'Bob\',\'666\',\'{}\',\'2026-01-02T00:00:00.000Z\',1,$1) ON CONFLICT(id) DO UPDATE SET deleted=1, version=excluded.version, updated_at=excluded.updated_at',
    [tombVersion],
  );

  const echo = await q(cloud, 'SELECT id, json_payload, version, updated_at, deleted FROM customers');
  let landed = 0;
  for (const r of echo) {
    if (await applyRemoteRow(local, 'customers', { ...r, data_json: JSON.parse(r.json_payload) })) landed++;
  }
  ok('B: the tombstone echo applied', landed === 1);
  ok('B: THE AUTHORITY SELF-HEALED (row now tombstoned)',
    (await q(local, 'SELECT deleted FROM customers WHERE id=\'c2\''))[0].deleted === 1);

  await local.close();
  await cloud.close();
}

// ---------------------------------------------------------------------------
// Scenario C: the case that does NOT self-heal - the device is OFFLINE.
// The outbox row is written but never pushed, so no echo ever comes back.
// The authority and the UI replica stay split until connectivity returns.
// ---------------------------------------------------------------------------
{
  const local = createClient({ url: 'file:tmp-h23-c-local.db' });
  await createAll(local);

  const db = makeFailingDb(local);
  db.state.failNext = 'INSERT INTO customers';

  try {
    await db.execute('INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES (\'c3\',\'Cara\',\'777\',\'{}\',\'2026-01-01T00:00:00.000Z\',0,2)');
  } catch { /* SWALLOWED */ }

  const dexieHas = true; // the Dexie replica write is unguarded and always lands
  const authorityHas = (await q(local, 'SELECT id FROM customers WHERE id=\'c3\'')).length === 1;

  ok('C: OFFLINE - the UI replica shows the customer', dexieHas);
  ok('C: OFFLINE - the authority does NOT have the customer (SPLIT)', !authorityHas);
  ok('C: the split persists with no echo (offline => no healing)', dexieHas !== authorityHas);

  await local.close();
}

console.log('\n=== SUMMARY: H23 probe complete ===');
