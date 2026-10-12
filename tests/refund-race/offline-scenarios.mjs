/**
 * Offline containment scenarios (MOBI-OFFLINE-REFUND-CONTAINMENT).
 * Run from tests/refund-race:  node --no-warnings offline-scenarios.mjs
 *
 * Two disconnected terminals = two SEPARATE database files holding the same
 * replicated ticket (sync convergence pending). No contention here — each
 * node decides alone against its durable rows. `refundContain` mirrors
 * src-tauri/src/refund.rs gate order (affinity → dedup → quota → caps →
 * supervisor → commit); the Rust `cargo test` suite executes the real code.
 */
import { rmSync, copyFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { open, createLegacySchema, applyV109 } from './schema.mjs';

class Rej extends Error {
  constructor(code, extra = '') {
    super(extra ? `${code}:${extra}` : code);
    this.code = code;
  }
}
const isUnique = (e) => /UNIQUE constraint failed/.test(String(e?.message ?? e));
const POLICIES = { 'policy.offline_cash_refund_limit': 10_000, 'policy.offline_pin_threshold': 5_000 };
const policy = (db, k, dflt) => {
  try {
    const r = db.prepare('SELECT value_json v FROM app_settings WHERE key=?').get(k)?.v;
    if (r == null) return dflt;
    const v = JSON.parse(String(r));
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : dflt;
  } catch { return dflt; }
};
const cashPrior = (db, where, arg) =>
  db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN json_extract(json_payload,'$.refundMethod')='Espèces'
       THEN COALESCE(CAST(json_extract(json_payload,'$.cashDisbursed') AS INTEGER),
         CASE WHEN json_extract(json_payload,'$.cashDisbursed') IS NULL
           THEN COALESCE(CAST(json_extract(json_payload,'$.total') AS INTEGER),0) ELSE 0 END)
       ELSE 0 END),0) s FROM transactions WHERE ${where} AND is_refund=1`
  ).get(arg).s;

function refundContain(db, req) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    const t = db.prepare('SELECT status, version, device_id d, shift_id s FROM transactions WHERE id=?').get(req.ticketId);
    if (!t) throw new Rej('TICKET_NOT_FOUND');
    if (!req.online) {
      const ok = (t.d ?? '').trim() !== '' && (t.d ?? '').trim() === (req.localDeviceId ?? '').trim() &&
        (t.s ?? '').trim() !== '' && (t.s ?? '').trim() === (req.activeShiftId ?? '').trim();
      if (!ok) throw new Rej('OFFLINE_FOREIGN_TICKET', `${t.d ?? ''}:${req.localDeviceId ?? ''}`);
    }
    try {
      db.prepare('INSERT INTO refund_dedup(ticket_id,items_hash,refund_id,created_at) VALUES(?,?,?,?)')
        .run(req.ticketId, req.itemsHash, req.refundId, now);
    } catch (e) {
      if (isUnique(e)) throw new Rej('ALREADY_REFUNDED');
      throw e;
    }
    if (t.status === 'VOIDED') throw new Rej('ORIGINAL_VOIDED');
    const purchased = Object.fromEntries(db.prepare('SELECT product_id p, SUM(quantity) q FROM transaction_items WHERE transaction_id=? GROUP BY product_id').all(req.ticketId).map((r) => [r.p, r.q]));
    const refunded = Object.fromEntries(db.prepare(
      'SELECT i.product_id p, SUM(i.quantity) q FROM transactions x JOIN transaction_items i ON i.transaction_id=x.id WHERE x.original_transaction_id=? AND x.is_refund=1 GROUP BY i.product_id').all(req.ticketId).map((r) => [r.p, r.q]));
    const requested = {};
    for (const l of req.lines) requested[l.productId] = (requested[l.productId] ?? 0) + l.quantity;
    for (const [p, q] of Object.entries(requested)) {
      if (q > (purchased[p] ?? 0) - (refunded[p] ?? 0)) throw new Rej('REFUND_EXCEEDS');
    }
    if (req.totalNet <= 0) throw new Rej('ZERO_REFUNDABLE');
    const cash = req.method === 'Espèces' ? (req.cashOut ?? 0) : 0;
    if (cash > 0) {
      if (!req.cashMove) throw new Rej('INVALID');
      const prior = cashPrior(db, 'original_transaction_id=?', req.ticketId);
      if (cash > req.cashTenderedNet - prior) throw new Rej('CASH_CAP_EXCEEDED');
    }
    if (!req.online && cash > 0) {
      const bucket = cashPrior(db, "shift_id=? AND sync_status='pending'", req.activeShiftId);
      const cap = policy(db, 'policy.offline_cash_refund_limit', POLICIES['policy.offline_cash_refund_limit']);
      if (bucket + cash > cap) throw new Rej('OFFLINE_CASH_CAP_EXCEEDED', `${bucket}:${cap}:${cash}`);
    }
    if (!req.online && req.method === 'Espèces' && cash > 0) {
      const threshold = policy(db, 'policy.offline_pin_threshold', POLICIES['policy.offline_pin_threshold']);
      if (cash > threshold) {
        const s = req.supervisor;
        if (!s || !String(s.userId ?? '').trim() || String(s.verifiedAt ?? '').trim().length < 10) {
          throw new Rej('SUPERVISOR_PIN_REQUIRED');
        }
      }
    }
    const full = Object.keys(purchased).length > 0 &&
      Object.entries(purchased).every(([p, q]) => q - (refunded[p] ?? 0) - (requested[p] ?? 0) === 0);
    const ns = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const u = db.prepare("UPDATE transactions SET status=?, version=version+1, updated_at=? WHERE id=? AND version=? AND status<>'VOIDED'")
      .run(ns, now, req.ticketId, t.version);
    if (u.changes !== 1) throw new Rej('ALREADY_REFUNDED');
    const payload = JSON.stringify({
      id: req.refundId, isRefund: true, originalTransactionId: req.ticketId,
      refundMethod: req.method, cashDisbursed: req.method === 'Espèces' ? cash : 0, total: req.totalNet,
    });
    db.prepare(`INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,device_id,idempotency_key,sync_status,updated_at,version,deleted,shift_id,original_transaction_id,is_refund)
      VALUES(?,?,0,?,'COMPLETED',?,?,'d1',?,'pending',?,1,0,?,?,1)`)
      .run(req.refundId, req.receiptNumber, req.totalNet, now, payload, req.refundId, now, req.activeShiftId, req.ticketId);
    for (const [i, l] of req.lines.entries()) {
      db.prepare('INSERT INTO transaction_items(id,transaction_id,product_id,quantity,applied_price,json_payload,idempotency_key) VALUES(?,?,?,?,?,?,?)')
        .run(`${req.refundId}-item-${i}`, req.refundId, l.productId, l.quantity, 0, '{}', `${req.refundId}-k-${i}`);
      db.prepare('INSERT INTO inventory_ledger(id,product_id,delta,reason,ref_type,ref_id,device_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(`LED-${req.refundId}-${i}`, l.productId, l.quantity, 'REFUND', 'order', req.refundId, 'd1', `LEDK-${req.refundId}-${i}`, now, now);
    }
    for (const b of req.batches ?? []) {
      const up = db.prepare('UPDATE stock_batches SET quantity_remaining=quantity_remaining+? WHERE batch_id=?').run(b.quantity, b.batchId);
      if (up.changes !== 1) {
        db.prepare('INSERT INTO stock_batches(batch_id,product_id,quantity_remaining,unit_cost,received_at,device_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)')
          .run(b.fallbackBatchId, b.productId, b.quantity, 50, now, 'd1', b.fallbackKey, now, now);
      }
    }
    if (cash > 0) {
      const st = db.prepare('SELECT status s FROM cash_sessions WHERE id=?').get(req.activeShiftId)?.s;
      if (st !== 'OPEN') throw new Rej('NO_OPEN_SHIFT');
      db.prepare('INSERT INTO cash_movements(id,session_id,type,amount,reason,cashier_name,created_at,json_payload) VALUES(?,?,?,?,?,?,?,?)')
        .run(`MOV-${req.refundId}`, req.activeShiftId, 'ALLOCATION', cash, 'allocation', 'Manager', now, '{}');
    }
    let details = `Avoir ${req.refundId} pour ${req.ticketId}`;
    if (req.supervisor?.userId) details += ` Superviseur: ${req.supervisor.userId} (${req.supervisor.verifiedAt})`;
    const prev = db.prepare('SELECT entry_hash h FROM audit_chain ORDER BY rowid DESC LIMIT 1').get()?.h ?? 'GENESIS';
    db.prepare('INSERT INTO security_audit_logs(id,timestamp,user,action,details) VALUES(?,?,?,?,?)')
      .run(`AUD-${req.refundId}`, now, 'Manager', 'Remboursement', details);
    db.prepare('INSERT INTO audit_chain(event_id,prev_hash,entry_hash) VALUES(?,?,?)')
      .run(`AUD-${req.refundId}`, prev, `HASH-${req.refundId}`);
    db.exec('COMMIT');
    return { outcome: 'COMMIT', status: ns };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    if (e instanceof Rej) return { outcome: e.code, detail: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------- fixtures
const clean = (p) => ['', '-wal', '-shm', '-journal'].forEach((s) => rmSync(p + s, { force: true }));
const base = (over = {}) => ({
  ticketId: 'TKT-1', lines: [{ productId: 'P1', quantity: 2 }], method: 'Espèces',
  totalNet: 200, cashOut: 150, cashTenderedNet: 200, online: false, cashMove: { present: true },
  localDeviceId: 'dev-A', activeShiftId: 'S1', itemsHash: 'H', refundId: 'REF-H',
  receiptNumber: 'AVOIR-H', supervisor: null,
  batches: [{ batchId: 'B1', quantity: 2, fallbackBatchId: 'FB-H', fallbackKey: 'FBK-H' }],
  ...over,
});
function seedTerminal(path, { device = 'dev-A', shift = 'S1', policyLimit = null } = {}) {
  clean(path);
  const db = open(path);
  createLegacySchema(db);
  applyV109(db);
  db.prepare("INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,device_id,shift_id,idempotency_key) VALUES('TKT-1','REC-1',300,300,'COMPLETED','t','{}',?,?, 'k1')")
    .run(device, shift);
  db.prepare('INSERT INTO transaction_items(id,transaction_id,product_id,quantity,applied_price,json_payload,idempotency_key) VALUES(?,?,?,?,?,?,?)')
    .run('TI-P1', 'TKT-1', 'P1', 2, 100, '{}', 'TIK-P1');
  db.prepare("INSERT INTO stock_batches(batch_id,product_id,quantity_remaining,unit_cost,received_at,device_id,idempotency_key,created_at,updated_at) VALUES('B1','P1',10,50,'t','d1','bk1','t','t')").run();
  db.prepare("INSERT INTO cash_sessions(id,status) VALUES('S1','OPEN')").run();
  if (policyLimit != null) {
    db.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES('policy.offline_cash_refund_limit',?,'t')").run(String(policyLimit));
  }
  return db;
}
const snap = (db) => ({
  rows: db.prepare('SELECT COUNT(*) c FROM transactions WHERE is_refund=1').get().c,
  dedup: db.prepare('SELECT COUNT(*) c FROM refund_dedup').get().c,
  status: db.prepare("SELECT status s FROM transactions WHERE id='TKT-1'").get().s,
});
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// ---- T1: own terminal offline — allowed ----
{
  console.log('T1 offline own-ticket refund commits');
  const P = 'tmp-off-a.db';
  const db = seedTerminal(P);
  const r = refundContain(db, base());
  assert.equal(r.outcome, 'COMMIT');
  assert.deepEqual(snap(db), { rows: 1, dedup: 1, status: 'REFUNDED' });
  ok('same-device same-shift offline refund passes affinity + quota');
  db.close(); clean(P);
}

// ---- T2: foreign terminal offline — blocked, zero side effects ----
{
  console.log('T2 foreign-terminal offline replay blocked');
  const PA = 'tmp-off-b1.db', PB = 'tmp-off-b2.db';
  seedTerminal(PA).close();
  seedTerminal(PB).close(); // same replicated ticket (device dev-A)
  const dbB = open(PB);
  const r = refundContain(dbB, base({ localDeviceId: 'dev-B', itemsHash: 'HB', refundId: 'REF-HB', receiptNumber: 'AVOIR-HB' }));
  assert.equal(r.outcome, 'OFFLINE_FOREIGN_TICKET');
  assert.deepEqual(snap(dbB), { rows: 0, dedup: 0, status: 'COMPLETED' });
  ok('cross-station offline refund fails closed with no rows');
  // shift mismatch + legacy authorship variants
  const dbA = open(PA);
  assert.equal(refundContain(dbA, base({ activeShiftId: 'S9', itemsHash: 'H9', refundId: 'REF-H9', receiptNumber: 'AVOIR-H9' })).outcome, 'OFFLINE_FOREIGN_TICKET');
  dbA.exec("UPDATE transactions SET device_id='legacy' WHERE id='TKT-1'");
  assert.equal(refundContain(dbA, base({ itemsHash: 'HL', refundId: 'REF-HL', receiptNumber: 'AVOIR-HL' })).outcome, 'OFFLINE_FOREIGN_TICKET');
  assert.deepEqual(snap(dbA), { rows: 0, dedup: 0, status: 'COMPLETED' });
  ok('past-shift and legacy-authorship tickets deny the same way');
  dbA.close(); dbB.close(); clean(PA); clean(PB);
}

// ---- T3: shift bucket accumulates; synced rows leave it ----
{
  console.log('T3 offline shift cash cap accumulates toward the limit');
  const P = 'tmp-off-c.db';
  const db = seedTerminal(P, { policyLimit: 200 });
  const p1 = base({ lines: [{ productId: 'P1', quantity: 1 }], totalNet: 10000, cashTenderedNet: 10000, itemsHash: 'HC1', refundId: 'REF-HC1', receiptNumber: 'AVOIR-HC1', batches: [{ batchId: 'B1', quantity: 1, fallbackBatchId: 'FB-C1', fallbackKey: 'FBK-C1' }] });
  assert.equal(refundContain(db, p1).outcome, 'COMMIT');
  const p2 = base({ lines: [{ productId: 'P1', quantity: 1 }], totalNet: 10000, cashTenderedNet: 10000, itemsHash: 'HC2', refundId: 'REF-HC2', receiptNumber: 'AVOIR-HC2', batches: [{ batchId: 'B1', quantity: 1, fallbackBatchId: 'FB-C2', fallbackKey: 'FBK-C2' }] });
  const r2 = refundContain(db, p2);
  assert.equal(r2.outcome, 'OFFLINE_CASH_CAP_EXCEEDED');
  assert.deepEqual(snap(db), { rows: 1, dedup: 1, status: 'PARTIALLY_REFUNDED' });
  ok('150+150 > 200 bucket refuses with zero side effects');
  db.exec("UPDATE transactions SET sync_status='synced' WHERE id='REF-HC1'");
  const r3 = refundContain(db, p2);
  assert.equal(r3.outcome, 'COMMIT');
  assert.equal(snap(db).status, 'REFUNDED');
  ok('synced rows leave the bucket — retry fits after resync');
  db.close(); clean(P);
}

// ---- T4: supervisor gate + in-txn attribution ----
{
  console.log('T4 supervisor gate for large offline cash');
  const P = 'tmp-off-d.db';
  const db = seedTerminal(P);
  const big = base({ totalNet: 6000, cashOut: 6000, cashTenderedNet: 6000 });
  assert.equal(refundContain(db, big).outcome, 'SUPERVISOR_PIN_REQUIRED');
  assert.equal(refundContain(db, { ...big, supervisor: { userId: '', verifiedAt: '' } }).outcome, 'SUPERVISOR_PIN_REQUIRED');
  assert.deepEqual(snap(db), { rows: 0, dedup: 0, status: 'COMPLETED' });
  ok('missing/empty authorization fails closed with no rows');
  const r = refundContain(db, { ...big, itemsHash: 'HS', refundId: 'REF-HS', receiptNumber: 'AVOIR-HS', supervisor: { userId: 'mgr-1', verifiedAt: '2026-01-02T00:01:00Z' } });
  assert.equal(r.outcome, 'COMMIT');
  const details = db.prepare("SELECT details d FROM security_audit_logs WHERE id='AUD-REF-HS'").get().d;
  assert.ok(details.includes('mgr-1'), 'audit names the supervisor');
  ok('authorized refund commits with supervisor attribution in-txn');
  db.close(); clean(P);
}

// ---- T5: online foreign refund skips affinity (claim path governs) ----
{
  console.log('T5 online path skips offline affinity');
  const P = 'tmp-off-e.db';
  const db = seedTerminal(P);
  const r = refundContain(db, base({ online: true, localDeviceId: 'dev-B', itemsHash: 'HE', refundId: 'REF-HE', receiptNumber: 'AVOIR-HE' }));
  assert.equal(r.outcome, 'COMMIT');
  ok('online refunds are decided by quota/dedup, not terminal affinity');
  db.close(); clean(P);
}

// ---- T6: projection reads committed state (no stale hydration) ----
{
  console.log('T6 post-commit projection sees committed rows');
  const P = 'tmp-off-f.db';
  seedTerminal(P).close();
  const db = open(P);
  assert.equal(refundContain(db, base()).outcome, 'COMMIT');
  db.close();
  const db2 = open(P); // fresh connection, like a re-render hydration
  assert.deepEqual(snap(db2), { rows: 1, dedup: 1, status: 'REFUNDED' });
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM audit_chain").get().c, 1);
  ok('fresh read sees refund + status + single audit link');
  db2.close(); clean(P);
}

console.log(`\n${n} offline containment checks passed`);
