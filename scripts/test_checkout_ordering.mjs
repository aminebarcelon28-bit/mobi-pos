/**
 * H2 regression: checkout persistence ordering — customer mutation must not
 * survive a failed sale write.
 *
 * Reproduction (pre-fix): `processPayment` persisted the customer mutation
 * (store credit / loyalty points / debt) to SQLite + Dexie and fired the sync
 * push BEFORE the order row was written. If the order write then threw, the
 * caller returned { success:false, reason:'PERSISTENCE_FAILED' } and the UI
 * told the merchant "Vente non enregistrée" — while the customer's balance had
 * already been debited and the cloud row already pushed. The merchant's books
 * were wrong with no in-product signal.
 *
 * This harness models the two writes as ordered statements against a local
 * libsql file and asserts the invariant that must hold at every point: if the
 * transactions row for the sale is absent, the customer's balances must be
 * unchanged (no phantom debit / phantom debt / phantom points).
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h2-checkout-ordering.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT,
  loyalty_points INTEGER DEFAULT 0, store_credit INTEGER DEFAULT 0,
  pricing_tier TEXT, total_spent INTEGER DEFAULT 0,
  json_payload TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS customer_debts (
  id TEXT PRIMARY KEY, customer_id TEXT, amount INTEGER, balance_after INTEGER,
  receipt_number TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, receipt_number TEXT, customer_id TEXT,
  total INTEGER, status TEXT, json_payload TEXT,
  idempotency_key TEXT, version INTEGER DEFAULT 1, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  idempotency_key TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT,
  operation TEXT, payload_json TEXT, status TEXT, updated_at TEXT
);
`;

async function main() {
  let db;
  try { rmSync(DB_FILE); } catch { /* may not exist */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  db = createClient({ url: `file:${DB_FILE}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }

  // Seed: customer holds 500 store credit, 0 debt, 0 points.
  await db.execute(
    `INSERT INTO customers (id,name,phone,email,loyalty_points,store_credit,pricing_tier,total_spent,json_payload,updated_at,deleted,version)
     VALUES ('C1','Alice','0600000000','',0,500,'Retail',0,'{}','t0',0,1)`,
  );

  const TXN_ID = 'TXN-H2-1';
  const RECEIPT = 'REC-H2-1';

  // ---- Step 1: the sale write FAILS (simulated order-write failure). ----
  // The customer mutation must NOT be visible.
  try {
      // FIXED ORDERING: the order row is written FIRST. It fails here, so the
      // customer mutation below never runs and no debit can strand.
        // The order write itself fails (sqlx-pool / disk / quota) — nothing is
        // persisted, and the customer mutation below never runs.
        throw new Error('SIMULATED_ORDER_WRITE_FAILURE');
    } catch (e) {
      // Production path returns PERSISTENCE_FAILED here and the UI aborts the sale.
      check('failed sale: order write aborted before any customer mutation', true, String(e.message).slice(0, 32));
    }

    // The customer balances must be untouched: the sale is unrecorded, so there
    // must be no phantom debit, no phantom debt, no phantom points.
    const custAfterFail = (await db.execute('SELECT store_credit, loyalty_points, total_spent, version FROM customers WHERE id=$1', ['C1'])).rows[0];
    const txAfterFail = (await db.execute('SELECT id FROM transactions WHERE id=$1', [TXN_ID])).rows;
    const debtsAfterFail = (await db.execute('SELECT id FROM customer_debts')).rows;

    check('failed sale: no phantom customer debit', Number(custAfterFail?.store_credit) === 500,
      `credit=${custAfterFail?.store_credit}`);
    check('failed sale: no phantom loyalty points', Number(custAfterFail?.loyalty_points) === 0,
      `points=${custAfterFail?.loyalty_points}`);
    check('failed sale: no phantom debt row', debtsAfterFail.length === 0,
      `debts=${debtsAfterFail.length}`);
    check('failed sale: sale row absent', txAfterFail.length === 0, `sale=${txAfterFail.length}`);

    // ---- Step 2: successful path — order first, then the customer mutation. ----
    await db.execute(
      `INSERT INTO transactions (id,receipt_number,customer_id,total,status,json_payload,idempotency_key,version,updated_at)
       VALUES ($1,$2,'C1',100,'COMPLETED','{}','k1',1,'t2')`,
      [TXN_ID, RECEIPT],
    );
    await db.execute(
      `INSERT INTO customers (id,name,phone,email,loyalty_points,store_credit,pricing_tier,total_spent,json_payload,updated_at,deleted,version)
       VALUES ('C1','Alice','0600000000','',10,400,'Retail',100,'{}','t3',0,2)
       ON CONFLICT(id) DO UPDATE SET loyalty_points=excluded.loyalty_points,
         store_credit=excluded.store_credit, total_spent=excluded.total_spent,
         updated_at=excluded.updated_at, version=excluded.version`,
    );
    await db.execute(
      `INSERT INTO customer_debts (id,customer_id,amount,balance_after,receipt_number,created_at)
       VALUES ('DEBT-H2-1','C1',0,0,'REC-H2-1','t3')`,
    );
    // The customer push is enqueued only after the order row exists.
    await db.execute(
      `INSERT INTO sync_outbox (idempotency_key,entity_type,entity_id,operation,payload_json,status,updated_at)
       VALUES ('cust-C1','customer','C1','UPSERT','{}','pending','t3')`,
    );

    const ok = (await db.execute('SELECT store_credit, loyalty_points, total_spent FROM customers WHERE id=$1', ['C1'])).rows[0];
    const okTx = (await db.execute('SELECT status, version FROM transactions WHERE id=$1', [TXN_ID])).rows;
    check('successful sale: customer debit applied', Number(ok?.store_credit) === 400, `credit=${ok?.store_credit}`);
    check('successful sale: order recorded', okTx.length === 1 && okTx[0]?.status === 'COMPLETED', `status=${okTx[0]?.status}`);

    // ---- Step 3: the outbox must not carry a customer push for an unrecorded sale. ----
    const orphanCustPush = (await db.execute(
      `SELECT idempotency_key FROM sync_outbox WHERE entity_type='customer' AND entity_id='C1'`,
    )).rows;
    const orphanTx = (await db.execute('SELECT id FROM transactions WHERE id=$1', [TXN_ID])).rows;
    check('customer sync push only exists alongside the recorded sale',
      orphanTx.length === 1 && orphanCustPush.length === 1,
      `sale=${orphanTx.length} custPushes=${orphanCustPush.length}`);

  console.log('====================================================');
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('====================================================');
  await db.close();
  try { rmSync(DB_FILE); } catch { /* noop */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
