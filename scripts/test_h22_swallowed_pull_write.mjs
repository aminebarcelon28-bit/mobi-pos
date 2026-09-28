// H22: a swallowed authority write on the pull path is reported as success,
// the cursor advances past the row, and it is never retried (C6 silent loss).
//
// `applyRemoteRow` mirrors `customers` / `customer_debts` rows into the local
// SQLite authority with `db.execute(...).catch(() => {})`. plugin-sql's
// `execute()` REJECTS on any error (primary source:
// node_modules/@tauri-apps/plugin-sql/dist-js/index.d.ts: `execute(query,
// bindValues?): Promise<QueryResult>` with `rowsAffected: number`). So a
// transient SQLITE_BUSY, an FK violation, or a missing table on a fresh device
// is silently dropped; the function then writes the Dexie replica and returns
// normally. `pullOnce` counts the row as applied and advances the keyset
// cursor past it. The row is lost forever from the authority while the UI
// shows it — a UI/authority split, the same failure shape as H19.
//
// The local FK chain is real (src-tauri/src/lib.rs):
//   customer_debts.customer_id TEXT NOT NULL
//     FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
// so a debt row whose customer is absent locally throws on the child insert.

import { createClient } from '@libsql/client';
import { unlinkSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? `  [${extra}]` : ''}`); }
}

const DB = `tmp-h22-${process.pid}.db`;
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { unlinkSync(f); } catch { /* noop */ } }

const local = createClient({ url: `file:${DB}` });
await local.execute('PRAGMA foreign_keys = ON;');

// This @libsql/client build exposes execute() but not select(); read .rows.
async function q(client, sql, args) {
  const r = await client.execute(sql, args);
  return r.rows ?? [];
}

// --- real local schema (src-tauri/src/lib.rs migrations 1 + sync columns) ---
await local.execute(`
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
    loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0,
    pricing_tier TEXT DEFAULT 'Retail', total_spent REAL DEFAULT 0,
    json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0
  )`);
await local.execute(`
  CREATE TABLE customer_debts (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
    type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
    receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT,
    created_at TEXT NOT NULL, json_payload TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  )`);
await local.execute(`
  CREATE TABLE entity_keys (
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (entity_type, entity_id)
  )`);

// --- the real clock helpers (src/sync/SyncManager.ts) ----------------------
const GENERIC_ENTITY_BY_TABLE = { customers: 'customer', customer_debts: 'customer_debt' };

async function appliedGenericVersion(db, table, id) {
  const entityType = GENERIC_ENTITY_BY_TABLE[table] ?? table;
  try {
    const rows = await db.select(
      'SELECT version FROM entity_keys WHERE entity_type = $1 AND entity_id = $2',
      [entityType, id],
    );
    return Number(rows?.[0]?.version ?? 0);
  } catch { return 0; }
}

async function advanceEntityClockOnPull(db, table, id, version) {
  const entityType = GENERIC_ENTITY_BY_TABLE[table] ?? table;
  const safeVersion = Number(version) || 1;
  await db.execute(
    `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(entity_type, entity_id) DO UPDATE
     SET version = MAX(excluded.version, entity_keys.version)`,
    [entityType, id, `pull-${entityType}-${id}`, safeVersion],
  );
}

// --- the two mirror writes, verbatim shapes from applyRemoteRow ------------
const CUSTOMERS_UPSERT = `INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit,
  pricing_tier, total_spent, json_payload, updated_at, deleted, version)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone,
    email=excluded.email, loyalty_points=excluded.loyalty_points,
    store_credit=excluded.store_credit, pricing_tier=excluded.pricing_tier,
    total_spent=excluded.total_spent, json_payload=excluded.json_payload,
    updated_at=excluded.updated_at, deleted=0, version=excluded.version
    WHERE excluded.version >= customers.version`;

const DEBT_PARENT = `INSERT INTO customers (id, name, phone, json_payload, updated_at)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT(id) DO NOTHING`;

const DEBT_CHILD = `INSERT INTO customer_debts (id, customer_id, customer_name, type, amount, balance_after,
  receipt_number, payment_method, notes, recorded_by, created_at, json_payload, version, updated_at, deleted)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0)
  ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,
   customer_name=excluded.customer_name, type=excluded.type, amount=excluded.amount,
   balance_after=excluded.balance_after, receipt_number=excluded.receipt_number,
   payment_method=excluded.payment_method, notes=excluded.notes,
   recorded_by=excluded.recorded_by, created_at=excluded.created_at,
   json_payload=excluded.json_payload, updated_at=excluded.updated_at,
   deleted=0, version=excluded.version
   WHERE excluded.version >= customer_debts.version`;

// A db wrapper that can be told to fail the NEXT write matching a substring.
// This models a transient SQLITE_BUSY / missing-table / FK failure on the
// authority store — exactly what plugin-sql's execute() REJECTS with.
function makeFailingDb(underlying) {
  const state = { failNext: null, threw: false };
  const db = {
    state,
    async select(sql, args) { return q(underlying, sql, args); },
    async execute(sql, args) {
      if (state.failNext && sql.includes(state.failNext)) {
        state.threw = true;
        const t = state.failNext;
        state.failNext = null;
        throw new Error(`SQLITE_BUSY: simulated authority write failure on ${t}`);
      }
      return underlying.execute(sql, args);
    },
  };
  return db;
}

// --- OLD applyRemoteRow (customers lane): the write is swallowed -----------
async function oldApplyCustomers(db, id, version, payload) {
  const applied = await appliedGenericVersion(db, 'customers', id);
  if (applied > 0 && applied > version) return { applied: false };
  await advanceEntityClockOnPull(db, 'customers', id, version);
  await db.execute(CUSTOMERS_UPSERT, [
    id, payload.name || 'Client', payload.phone || '', null, 0, 0, 'Retail', 0,
    JSON.stringify(payload), payload.updatedAt ?? '2026-01-01T00:00:00.000Z', version,
  ]).catch(() => {}); // <-- H22: the swallow
  return { applied: true };
}

// --- FIXED applyRemoteRow: the rejection propagates to the caller ----------
async function fixedApplyCustomers(db, id, version, payload) {
  const applied = await appliedGenericVersion(db, 'customers', id);
  if (applied > 0 && applied > version) return { applied: false };
  await advanceEntityClockOnPull(db, 'customers', id, version);
  await db.execute(CUSTOMERS_UPSERT, [
    id, payload.name || 'Client', payload.phone || '', null, 0, 0, 'Retail', 0,
    JSON.stringify(payload), payload.updatedAt ?? '2026-01-01T00:00:00.000Z', version,
  ]); // <-- H22: no swallow; pullOnce's catch freezes the cursor
  return { applied: true };
}

// --- FIXED applyRemoteRow for the debt lane (parent + child, no swallow) ---
async function fixedApplyDebt(db, id, version, d) {
  const applied = await appliedGenericVersion(db, 'customer_debts', id);
  if (applied > 0 && applied > version) return { applied: false };
  await advanceEntityClockOnPull(db, 'customer_debts', id, version);
  const now = '2026-01-01T00:00:00.000Z';
  await db.execute(DEBT_PARENT,
    [String(d.customerId ?? id), String(d.customerName ?? 'Client'), '', JSON.stringify({ id: String(d.customerId ?? id) }), now]);
  await db.execute(DEBT_CHILD, [
    id, String(d.customerId ?? ''), String(d.customerName ?? 'Client'),
    String(d.type ?? 'DEBT_ACQUIRED'), Number(d.amount ?? 0), Number(d.balanceAfter ?? 0),
    null, null, null, null, String(d.createdAt ?? now), JSON.stringify(d), version, now,
  ]);
  return { applied: true };
}

// --- the pullOnce cursor model (post-H21 contiguous watermark) -------------
async function pullPage(db, rows, applyFn) {
  let maxTime = '0000-00-00T00:00:00.000Z';
  let maxId = '';
  let rowFailed = false;
  let landed = 0;
  for (const r of rows) {
    try {
      await applyFn(db, r.id, Number(r.version ?? 1), r.payload);
      landed++;
      if (!rowFailed && (r.time > maxTime || (r.time === maxTime && r.id > maxId))) {
        maxTime = r.time; maxId = r.id;
      }
    } catch (e) {
      rowFailed = true; // H21: freeze the watermark at the last good row
    }
  }
  return { maxTime, maxId, rowFailed, landed };
}

function cursorGt(a, b) {
  if (a.time !== b.time) return a.time > b.time;
  return a.id > b.id;
}

async function reset() {
  await local.execute('DELETE FROM customer_debts');
  await local.execute('DELETE FROM customers');
  await local.execute('DELETE FROM entity_keys');
}

// ===========================================================================
console.log('\n=== H22: swallowed authority write on pull loses the row ===\n');

// --- Scenario 1: the customers write fails once, then a later row lands ----
{
  await reset();
  const db = makeFailingDb(local);
  const rows = [
    { id: 'cust-A', version: 2, time: '2026-01-01T00:00:01.000Z', payload: { name: 'Alice' } },
    { id: 'cust-B', version: 2, time: '2026-01-01T00:00:02.000Z', payload: { name: 'Bob' } },
    { id: 'cust-C', version: 2, time: '2026-01-01T00:00:03.000Z', payload: { name: 'Cara' } },
  ];
  db.state.failNext = 'INSERT INTO customers';

  const oldRes = await pullPage(db, rows, oldApplyCustomers);
  check('OLD: the authority write threw', db.state.threw === true);
  check('OLD: the row was still reported applied', oldRes.landed === 3);
  check('OLD: the cursor advanced past the failed row', cursorGt({ time: oldRes.maxTime, id: oldRes.maxId }, { time: rows[1].time, id: rows[1].id }));

  const after = await q(local, "SELECT id FROM customers WHERE name='Alice'");
  check('OLD: the failed row is absent from the authority', after.length === 0);
  const later = await q(local, "SELECT id FROM customers WHERE name='Cara'");
  check('OLD: a later row still landed', later.length === 1);
  check('OLD: the failed row is lost forever (cursor is past it)', cursorGt({ time: oldRes.maxTime, id: oldRes.maxId }, { time: rows[0].time, id: rows[0].id }));
}

// --- Scenario 2: FIXED — the same failure now freezes the cursor ----------
{
  await reset();
  const db = makeFailingDb(local);
  const rows = [
    { id: 'cust-A', version: 2, time: '2026-01-01T00:00:01.000Z', payload: { name: 'Alice' } },
    { id: 'cust-B', version: 2, time: '2026-01-01T00:00:02.000Z', payload: { name: 'Bob' } },
    { id: 'cust-C', version: 2, time: '2026-01-01T00:00:03.000Z', payload: { name: 'Cara' } },
  ];
  // Seed the clock for all three rows OUTSIDE the failing wrapper, so the
  // only intercepted write is the customers INSERT itself.
  for (const r of rows) await advanceEntityClockOnPull(local, 'customers', r.id, r.version);
  db.state.failNext = 'INSERT INTO customers';

  const res = await pullPage(db, rows, fixedApplyCustomers);
  check('FIXED: the failure propagated out of applyRemoteRow', res.rowFailed === true);
  check('FIXED: the cursor stopped before the failed row', res.maxTime === '0000-00-00T00:00:00.000Z');
  // The transient failure was consumed by row A, so B and C still land;
  // the fix guarantees the CURSOR did not jump past the failed row.
  check('FIXED: the later rows still landed (transient failure consumed)', res.landed === 2, `landed=${res.landed}`);

  // the next pull re-fetches from the frozen cursor: A retries and lands
  const retry = await fixedApplyCustomers(local, 'cust-A', 2, { name: 'Alice' });
  check('FIXED: the missed row lands on retry', retry.applied === true);
  const after = await q(local, "SELECT id FROM customers WHERE name='Alice'");
  check('FIXED: the row is now in the authority', after.length === 1);
}

// --- Scenario 3: the debt lane — FK violation on the child insert ----------
// The parent-provisioning insert is `ON CONFLICT DO NOTHING`, but the child
// insert carries a real FK. A debt whose customer is absent locally throws.
{
  await reset();

  let threw = false;
  try {
    // no customer 'cust-ghost' exists and we skip the parent insert
    await local.execute(DEBT_CHILD, [
      'debt-1', 'cust-ghost', 'Ghost', 'DEBT_ACQUIRED', 500, 500,
      null, null, null, null, '2026-01-01T00:00:00.000Z', JSON.stringify({ customerId: 'cust-ghost' }), 3, '2026-01-01T00:00:00.000Z',
    ]);
  } catch (e) { threw = true; }

  check('the debt lane really can throw (FK is enforced)', threw === true);
  const debts = await q(local, 'SELECT id FROM customer_debts');
  check('the throwing debt did not land', debts.length === 0);

  // the real lane provisions the parent first, so the retry succeeds
  const retry = await fixedApplyDebt(local, 'debt-1', 3, {
    customerId: 'cust-ghost', customerName: 'Ghost', amount: 500, balanceAfter: 500,
  });
  check('the retry lands the debt', retry.applied === true);
  const debts2 = await q(local, 'SELECT id FROM customer_debts');
  check('the debt is now in the authority', debts2.length === 1);
}

// --- Scenario 4: a guard-REJECTED echo still advances (no infinite loop) ---
{
  await reset();
  const db = makeFailingDb(local);
  // local clock is already at 5 for cust-X
  await advanceEntityClockOnPull(local, 'customers', 'cust-X', 5);

  const rows = [
    { id: 'cust-X', version: 2, time: '2026-01-01T00:00:01.000Z', payload: { name: 'Stale' } }, // rejected
    { id: 'cust-Y', version: 2, time: '2026-01-01T00:00:02.000Z', payload: { name: 'Fresh' } },
  ];
  const res = await pullPage(db, rows, fixedApplyCustomers);
  check('the stale echo did not throw', res.rowFailed === false);
  check('the stale echo did not land (clock still 5)', (await appliedGenericVersion(db, 'customers', 'cust-X')) === 5);
  check('the cursor still advanced past the rejected echo', cursorGt({ time: res.maxTime, id: res.maxId }, { time: rows[0].time, id: rows[0].id }));
  const fresh = await q(local, "SELECT id FROM customers WHERE name='Fresh'");
  check('the fresh row landed', fresh.length === 1);
}

// --- Scenario 5: the tombstone lane swallows too (customers deleted=1) -----
// `UPDATE customers SET deleted = 1 WHERE id = $1` is `.catch(() => {})` in
// applyRemoteRow. A swallowed failure there leaves the authority showing the
// customer as live while the UI replica was deleted — the H19 split shape.
{
  await reset();
  await local.execute("INSERT INTO customers (id,name,phone,json_payload,updated_at,version,deleted) VALUES ('cust-T','Tee','', '{}','2026-01-01T00:00:00.000Z',4,0)");

  const db = makeFailingDb(local);
  db.state.failNext = 'UPDATE customers SET deleted';

  // The clock row is created by the first push/pull of this entity; seed it
  // at the live version, as the real lane would have.
  await advanceEntityClockOnPull(local, 'customers', 'cust-T', 4);
  // OLD tombstone path: guard + clock advance, then the swallowed update
  const appliedDelete = await appliedGenericVersion(db, 'customers', 'cust-T');
  check('the tombstone guard read the live version', appliedDelete === 4, `clock=${appliedDelete}`);
  await advanceEntityClockOnPull(db, 'customers', 'cust-T', 5);
  let threw = false;
  try {
    await db.execute('UPDATE customers SET deleted = 1 WHERE id = $1', ['cust-T']);
  } catch (e) { threw = true; }
  check('the tombstone update really can throw', threw === true);
  const live = await q(local, "SELECT deleted FROM customers WHERE id='cust-T'");
  check('the authority still shows the customer live (split)', Number(live[0].deleted) === 0);
}

await local.close();
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { unlinkSync(f); } catch { /* noop */ } }

console.log(`\n=== SUMMARY: ${pass} PASSED, ${fail} FAILED ===`);
if (fail > 0) process.exit(1);
