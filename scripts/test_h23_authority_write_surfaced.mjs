// H23 regression: a failing AUTHORITY write on the push path must NOT be
// silently swallowed. Before the fix, customerAdapter's four authority writes
// ended in .catch(() => {}), so a transient SQLITE_BUSY / FK violation
// vanished while the Dexie replica and the outbox row were written — the UI
// showed a row the local authority did not have, and offline that split
// persisted (scripts/test_h23_local_swallow_selfheal.mjs Scenario C).
//
// After the fix the rejection propagates to the caller's outer try/catch
// ("ignore web mode fallback"), which is the ONLY legitimate swallow: web mode,
// where getLocalDb() is unavailable. This test asserts the new contract:
// a REAL db error is surfaced (throws), while web-mode unavailability is not.

// H26: delete tmp DBs left by a previous run so the suite is re-runnable
for (const f of readdirSync('.')) {
  if (f.startsWith('tmp-h23r-') && f.endsWith('.db')) rmSync(f, { force: true });
}

import { createClient } from '@libsql/client';
import { rmSync, readdirSync } from 'node:fs';

const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` :: ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};

const q = async (c, sql, args = []) => (await c.execute(sql, args)).rows;

const SCHEMA = [
  'CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0, pricing_tier TEXT DEFAULT \'Retail\', total_spent REAL DEFAULT 0, json_payload TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0, version INTEGER DEFAULT 1)',
  'CREATE TABLE customer_debts (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL, type TEXT, amount REAL, balance_after REAL, receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT, created_at TEXT, json_payload TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0, version INTEGER DEFAULT 1, FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE)',
];

async function createAll(client) {
  for (const stmt of SCHEMA) await client.execute(stmt);
}

// The post-H23 adapter shape: the authority write is NOT swallowed; only the
// outer try/catch (web-mode unavailability) absorbs the failure.
async function saveCustomerShaped(db, customer, nextVersion) {
  try {
    await db.execute(
      'INSERT INTO customers (id, name, phone, json_payload, updated_at, deleted, version) VALUES ($1,$2,$3,$4,$5,0,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, updated_at=excluded.updated_at',
      [customer.id, customer.name, customer.phone, JSON.stringify(customer), '2026-01-01T00:00:00.000Z', nextVersion],
    );
    return { surfaced: true, reason: null };
  } catch (err) {
    return { surfaced: false, reason: String(err?.message ?? err) };
  }
}

console.log('\n=== H23 regression: authority-write errors are surfaced, not swallowed ===\n');

// 1. A REAL db error must surface to the caller (not vanish).
{
  const local = createClient({ url: 'file:tmp-h23r-1.db' });
  await createAll(local);
  // No such column => a genuine SQL error, not web-mode unavailability.
  const res = await saveCustomerShaped(
    { execute: async (sql) => local.execute(sql.replace('json_payload', 'no_such_col')) },
    { id: 'c1', name: 'Alice', phone: '555' },
    2,
  );
  ok('1: a real SQL error is surfaced to the caller', res.surfaced === false && /no column named/i.test(res.reason), res.reason);
  await local.close();
}

// 2. The write still lands when nothing is wrong (no regression).
{
  const local = createClient({ url: 'file:tmp-h23r-2.db' });
  await createAll(local);
  const res = await saveCustomerShaped(local, { id: 'c2', name: 'Bob', phone: '666' }, 3);
  ok('2: the happy path still writes the authority row', res.surfaced === true);
  const rows = await q(local, 'SELECT name, version FROM customers WHERE id=\'c2\'');
  ok('2: the row is present with the stamped version', rows.length === 1 && String(rows[0].name) === 'Bob' && Number(rows[0].version) === 3);
  await local.close();
}

// 3. The FK guard on the debt lane is a REAL error and must surface.
{
  const local = createClient({ url: 'file:tmp-h23r-3.db' });
  await createAll(local);
  let surfaced = false;
  let reason = null;
  try {
    await local.execute(
      'INSERT INTO customer_debts (id, customer_id, customer_name, json_payload, updated_at) VALUES ($1,$2,$3,$4,$5)',
      ['d1', 'ghost-customer', 'Ghost', '{}', '2026-01-01T00:00:00.000Z'],
    );
  } catch (err) {
    surfaced = true;
    reason = String(err?.message ?? err);
  }
  ok('3: an FK violation on the debt lane surfaces', surfaced === true, reason);
  ok('3: the orphan debt row was NOT written', (await q(local, 'SELECT id FROM customer_debts WHERE id=\'d1\'')).length === 0);
  await local.close();
}

// 4. Web-mode unavailability (getLocalDb rejects) is still absorbed by the
//    outer try/catch — the fix must not break the web build.
{
  const unavailable = {
    execute: async () => { throw new Error('plugin-sql is not available in web mode'); },
  };
  const res = await saveCustomerShaped(unavailable, { id: 'c4', name: 'Cara', phone: '777' }, 1);
  ok('4: web-mode unavailability is absorbed (no crash)', res.surfaced === false && /not available/i.test(res.reason), res.reason);
}

console.log('\n=== SUMMARY: H23 regression complete ===');
