/**
 * v109 migration test (MOBI-DEFECT-F).
 * Run from tests/refund-race:  node --no-warnings migration.test.mjs
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { open, createLegacySchema, applyV109, backfillMissed } from './schema.mjs';

const clean = (p) => ['', '-wal', '-shm', '-journal'].forEach((s) => rmSync(p + s, { force: true }));
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// ---- 1. Historic refunds backfill; trigger guards; idempotent re-run ----
{
  const P = 'tmp-mig-1.db';
  clean(P);
  const db = open(P);
  createLegacySchema(db);
  const ins = db.prepare(
    'INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,idempotency_key) VALUES(?,?,?,?,?,?,?,?)'
  );
  ins.run('TKT-1', 'REC-1', 25000, 25000, 'PARTIALLY_REFUNDED', '2026-01-01T00:00:00Z', '{"total":25000}', 'k-tkt-1');
  ins.run(
    'REF-a', 'AVOIR-a', 10000, 10000, 'COMPLETED', '2026-01-02T00:00:00Z',
    '{"isRefund":true,"originalTransactionId":"TKT-1","refundMethod":"Espèces","cashDisbursed":10000,"total":10000}',
    'k-ref-a'
  );
  ins.run('TKT-2', 'REC-2', 5000, 5000, 'COMPLETED', '2026-01-01T00:00:00Z', '{"originalTransactionId":null}', 'k-tkt-2');
  ins.run('TKT-3', 'REC-3', 100, 100, 'COMPLETED', '2026-01-01T00:00:00Z', 'not json', 'k-tkt-3');

  applyV109(db);
  const row = (id) => db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  assert.equal(row('REF-a').original_transaction_id, 'TKT-1');
  assert.equal(row('REF-a').is_refund, 1);
  assert.equal(row('TKT-2').original_transaction_id, null);
  assert.equal(row('TKT-2').is_refund, 0);
  assert.equal(row('TKT-3').is_refund, 0);
  ok('historic refund backfilled from canonical JSON; null/invalid payloads untouched');

  assert.equal(backfillMissed(db).length, 0);
  ok('no backfill misses on canonical data');

  assert.throws(
    () =>
      db.prepare(
        `INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,is_refund,idempotency_key,sync_status)
         VALUES('REF-evil','AVOIR-evil',1,1,'COMPLETED','t','{}',1,'e1','pending')`
      ).run(),
    /REFUND_BYPASS/
  );
  db.prepare(
    `INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,is_refund,idempotency_key,sync_status)
     VALUES('REF-repl','AVOIR-repl',1,1,'COMPLETED','t','{}',1,'e2','synced')`
  ).run();
  ok('direct refund insert without dedup aborts; synced (replicated) rows exempt');

  const before = JSON.stringify(db.prepare('SELECT * FROM transactions ORDER BY id').all());
  applyV109(db);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM transactions ORDER BY id').all()), before);
  ok('re-running the migration is a no-op (guarded ADD COLUMNs, IF NOT EXISTS)');

  db.close();
  clean(P);
}

// ---- 2. Non-canonical payload shape is REPORTED, migration stays green ----
{
  const P = 'tmp-mig-2.db';
  clean(P);
  const db = open(P);
  createLegacySchema(db);
  db.prepare(
    'INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,idempotency_key) VALUES(?,?,?,?,?,?,?,?)'
  ).run('REF-n', 'AVOIR-n', 5, 5, 'COMPLETED', 't', '{"meta":{"originalTransactionId":"TKT-9"}}', 'n1');
  applyV109(db); // must not brick boot on unexpected shapes
  const missed = backfillMissed(db);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].id, 'REF-n');
  ok('nested-path payload reported by diagnostic (known residual: quota reads canonical path only)');
  db.close();
  clean(P);
}

console.log(`\n${n} migration checks passed`);
