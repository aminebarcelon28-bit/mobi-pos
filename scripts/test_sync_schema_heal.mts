// Regression: sync schema drift that wedged pull/push lanes forever.
// Uses REAL node:sqlite databases + the REAL migration/heal/apply code:
//  1. Pre-v8 local customer_debts (no updated_at/deleted) heals cleanly.
//  2. Pulled customers + debts land without idempotency_key UNIQUE collisions.
//  3. Empty cloud DB migrates to LATEST_REMOTE_VERSION idempotently.
import { DatabaseSync } from 'node:sqlite';
import { CUSTOMER_DEBTS_COLUMN_HEAL_SQL } from '../src/utils/../db/schemaHeal.ts';
import { applyRemoteMigrations, LATEST_REMOTE_VERSION } from '../src/sync/remoteSchema.ts';
import { applyGenericRemoteRow } from '../src/sync/genericApply.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name}`); }
};

/** $1-style (plugin-sql) -> ?N-style (node:sqlite) shim. */
function toQmarks(sql: string): string {
  return sql.replace(/\$(\d+)/g, '?$1');
}

function makeLocalDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // v7-era customers: idempotency_key UNIQUE index present (the collision source).
  db.exec(`CREATE TABLE customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
    loyalty_points INTEGER DEFAULT 0, store_credit REAL DEFAULT 0,
    pricing_tier TEXT DEFAULT 'Retail', total_spent REAL DEFAULT 0,
    json_payload TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT DEFAULT '');`);
  db.exec('CREATE UNIQUE INDEX uq_customers_idem ON customers(idempotency_key);');
  db.exec(`INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
    VALUES ('c-old', 'Old', '0550', '{}', '2026-01-01', 'legacy-c-old');`);
  // Pre-v8 customer_debts: NO updated_at / deleted / device_id.
  db.exec(`CREATE TABLE customer_debts (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
    type TEXT NOT NULL, amount REAL NOT NULL, balance_after REAL NOT NULL,
    receipt_number TEXT, payment_method TEXT, notes TEXT, recorded_by TEXT,
    created_at TEXT NOT NULL, json_payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);`);
  db.exec(`CREATE TABLE entity_keys (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    idempotency_key TEXT, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id));`);
  return db;
}

const localShim = (db: DatabaseSync) => ({
  execute: async (sql: string, args: unknown[] = []) => {
    const st = db.prepare(toQmarks(sql));
    const info = st.run(...(args as never[]));
    return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) };
  },
  select: async (sql: string, args: unknown[] = []) => {
    const st = db.prepare(toQmarks(sql));
    return st.all(...(args as never[])) as Array<Record<string, unknown>>;
  },
});

// ── 1. Local heal ──
{
  const db = makeLocalDb();
  const colsBefore = db.prepare("SELECT name FROM pragma_table_info('customer_debts')").all() as Array<{ name: string }>;
  check('pre-v8 table lacks updated_at', !colsBefore.some((c) => c.name === 'updated_at'));
  for (const stmt of CUSTOMER_DEBTS_COLUMN_HEAL_SQL) {
    await localShim(db).execute(stmt).catch(() => undefined);
  }
  const colsAfter = db.prepare("SELECT name FROM pragma_table_info('customer_debts')").all() as Array<{ name: string }>;
  const names = new Set(colsAfter.map((c) => c.name));
  check('heal adds updated_at', names.has('updated_at'));
  check('heal adds deleted', names.has('deleted'));
  check('heal adds device_id', names.has('device_id'));
  // Idempotent: second run must not break the table.
  for (const stmt of CUSTOMER_DEBTS_COLUMN_HEAL_SQL) {
    await localShim(db).execute(stmt).catch(() => undefined);
  }
  const debtCount = (db.prepare('SELECT COUNT(*) AS n FROM customer_debts').get() as { n: number }).n;
  check('heal rerun harmless', debtCount === 0);
  db.close();
}

// ── 2. Pull apply without UNIQUE collisions ──
{
  const db = makeLocalDb();
  const shim = localShim(db) as never;
  for (const stmt of CUSTOMER_DEBTS_COLUMN_HEAL_SQL) {
    await (shim as { execute: (s: string) => Promise<unknown> }).execute(stmt).catch(() => undefined);
  }
  const custRow = (over: Record<string, unknown> = {}) => ({
    id: 'c-new', version: 2, updated_at: '2026-09-22T10:00:00.000Z', deleted: 0,
    data_json: JSON.stringify({ id: 'c-new', name: 'Yacine', phone: '0550', ...over }),
  });
  await applyGenericRemoteRow(shim, 'customers', custRow(), { skipDexie: true });
  const c1 = db.prepare('SELECT idempotency_key FROM customers WHERE id = ?').get('c-new') as { idempotency_key: string };
  check('pulled customer lands with non-empty key', Boolean(c1?.idempotency_key));

  const debtRow = (id: string, custId: string) => ({
    id, version: 2, updated_at: '2026-09-22T10:00:00.000Z', deleted: 0,
    data_json: JSON.stringify({ id, customerId: custId, customerName: 'Client', type: 'DEBT_ACQUIRED', amount: 5000, balanceAfter: 5000 }),
  });
  // Two debts for two NEW customers: pre-fix, the second stub died on UNIQUE.
  await applyGenericRemoteRow(shim, 'customer_debts', debtRow('d1', 'cx1'), { skipDexie: true });
  await applyGenericRemoteRow(shim, 'customer_debts', debtRow('d2', 'cx2'), { skipDexie: true });
  const stubs = db.prepare("SELECT id, idempotency_key FROM customers WHERE id IN ('cx1','cx2') ORDER BY id").all() as Array<{ id: string; idempotency_key: string }>;
  check('both stubs land', stubs.length === 2);
  check('stub keys unique + non-empty', stubs[0].idempotency_key !== stubs[1].idempotency_key && stubs.every((s) => Boolean(s.idempotency_key)));
  const debts = db.prepare('SELECT id, updated_at FROM customer_debts ORDER BY id').all() as Array<{ id: string; updated_at: string }>;
  check('both debts land with updated_at', debts.length === 2 && debts.every((d) => Boolean(d.updated_at)));
  // Re-apply (retry path): idempotent, no new collisions.
  await applyGenericRemoteRow(shim, 'customer_debts', debtRow('d1', 'cx1'), { skipDexie: true });
  const debtCount = (db.prepare('SELECT COUNT(*) AS n FROM customer_debts').get() as { n: number }).n;
  check('re-apply idempotent', debtCount === 2);
  db.close();
}

// ── 3. Remote migrations on an empty (pre-lane) cloud DB ──
{
  const remote = new DatabaseSync(':memory:');
  const client = {
    execute: async (q: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof q === 'string' ? q : q.sql;
      const args = (typeof q === 'string' ? [] : q.args ?? []) as never[];
      if (/^\s*select/i.test(sql)) {
        const st = remote.prepare(sql);
        return { rows: st.all(...args) as Record<string, unknown>[] };
      }
      remote.prepare(sql).run(...args);
      return { rows: [] as Record<string, unknown>[] };
    },
  };
  const applied = await applyRemoteMigrations(client as never);
  check('migrations apply on empty DB', applied > 0);
  const tables = new Set(
    (remote.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
  );
  check('stock_batches created remotely', tables.has('stock_batches'));
  check('credit_vouchers created remotely', tables.has('credit_vouchers'));
  const ver = (remote.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
  check(`remote reaches v${LATEST_REMOTE_VERSION}`, ver >= LATEST_REMOTE_VERSION);
  const appliedAgain = await applyRemoteMigrations(client as never);
  check('migrations idempotent on rerun', appliedAgain === 0);
  remote.close();
}

console.log(`SCHEMA-HEAL: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
