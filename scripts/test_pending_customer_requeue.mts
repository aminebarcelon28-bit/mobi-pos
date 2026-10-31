/**
 * Case 23 regression: the native `customers.sync_status = 'pending'` marker must
 * be CONSUMED at boot (re-enqueued + cleared), and a newer concurrent write must
 * stay pending rather than being cleared by a stale pass.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_pending_customer_requeue.mts
 */
import Database from 'better-sqlite3';
import {
  planPendingCustomerRequeue,
  requeuePendingCustomers,
  type PendingCustomerDb,
} from '../src/sync/pendingCustomerRequeue.ts';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`  FAIL ${name}: ${(err as Error).message}`);
    });
}
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT,
      json_payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function adapter(db: Database.Database): PendingCustomerDb {
  // The statements use numbered parameters ($1..$n), which better-sqlite3
  // treats as named; map them by index so the REAL SQL runs unmodified (sqlx
  // binds $N by digit, which is why production is unaffected).
  const bind = (args?: unknown[]) =>
    Object.fromEntries((args ?? []).map((value, i) => [String(i + 1), value]));
  return {
    async select(sql, args) {
      return db.prepare(sql).all(bind(args));
    },
    async execute(sql, args) {
      return db.prepare(sql).run(bind(args));
    },
  };
}

function seed(db: Database.Database, id: string, opts: { version?: number; deleted?: number; status?: string } = {}) {
  db.prepare(
    'INSERT INTO customers (id, version, deleted, sync_status, json_payload) VALUES (?, ?, ?, ?, ?)',
  ).run(
    id,
    opts.version ?? 3,
    opts.deleted ?? 0,
    opts.status ?? 'pending',
    JSON.stringify({ id, storeCredit: 500, loyaltyPoints: 10 }),
  );
}

function statusOf(db: Database.Database, id: string): string {
  return String(
    (db.prepare('SELECT sync_status FROM customers WHERE id = ?').get(id) as { sync_status: string })
      .sync_status,
  );
}

async function main(): Promise<void> {
  console.log('pending customer requeue — case 23');

  await check('a pending customer is enqueued once and its marker cleared', async () => {
    const db = makeDb();
    seed(db, 'C1');
    const calls: Array<{ Was: number; entity: string; id: string; payload: Record<string, unknown> }> = [];
    const n = await requeuePendingCustomers(adapter(db), async (entity, id, payload) => {
      calls.push({ Was: 0, entity, id, payload });
    });
    eq(n, 1, 'requeued count');
    eq(calls.length, 1, 'enqueue calls');
    eq(calls[0].entity, 'customer', 'entity');
    eq(calls[0].id, 'C1', 'entity id');
    eq(calls[0].payload.storeCredit, 500, 'payload carries the wallet');
    eq(calls[0].payload.version, 3, 'payload carries the version');
    eq(statusOf(db, 'C1'), 'synced', 'marker cleared');
  });

  await check('synced and deleted rows are untouched', async () => {
    const db = makeDb();
    seed(db, 'C1', { status: 'synced' });
    seed(db, 'C2', { status: 'pending', deleted: 1 });
    const calls: string[] = [];
    const n = await requeuePendingCustomers(adapter(db), async (_e, id) => {
      calls.push(id);
    });
    eq(n, 0, 'nothing requeued');
    eq(calls, [], 'no enqueue calls');
    eq(statusOf(db, 'C1'), 'synced', 'synced stays');
    eq(statusOf(db, 'C2'), 'pending', 'deleted stays untouched');
  });

  await check('a newer write during the pass stays pending (stale clear refused)', async () => {
    const db = makeDb();
    seed(db, 'C1', { version: 3 });
    const n = await requeuePendingCustomers(adapter(db), async () => {
      // A concurrent refund/void commits a newer version while we enqueue.
      db.prepare("UPDATE customers SET version = 4, sync_status = 'pending' WHERE id = 'C1'").run();
    });
    eq(n, 1, 'requeued count');
    eq(statusOf(db, 'C1'), 'pending', 'newer write must remain pending');
  });

  await check('duplicate rows for one customer dedupe to the newest version', () => {
    const plan = planPendingCustomerRequeue([
      { id: 'C1', version: 2, json_payload: '{"v":2}' },
      { id: 'C1', version: 5, json_payload: '{"v":5}' },
      { id: '  ', version: 1, json_payload: '{}' },
    ]);
    eq(plan.length, 1, 'one entry');
    eq(plan[0].version, 5, 'newest version wins');
    eq(plan[0].payload.v, 5, 'payload from the newest row');
  });

  await check('a malformed payload still enqueues the identity (never throws)', async () => {
    const db = makeDb();
    seed(db, 'C1');
    db.prepare("UPDATE customers SET json_payload = 'not-json' WHERE id = 'C1'").run();
    const calls: Array<Record<string, unknown>> = [];
    const n = await requeuePendingCustomers(adapter(db), async (_e, _id, payload) => {
      calls.push(payload);
    });
    eq(n, 1, 'requeued count');
    eq(calls[0].id, 'C1', 'identity present');
    eq(statusOf(db, 'C1'), 'synced', 'marker cleared');
  });

  await check('a select failure (column missing / busy) is swallowed with a warning', async () => {
    const warnings: string[] = [];
    const n = await requeuePendingCustomers(
      {
        select: async () => {
          throw new Error('no such column: sync_status');
        },
        execute: async () => undefined,
      },
      async () => undefined,
      (message) => warnings.push(message),
    );
    eq(n, 0, 'nothing requeued');
    ok(warnings.length === 1, 'one warning');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
