/**
 * Adversarial race harness (MOBI-DEFECT-F). Run from tests/refund-race:
 *   node --no-warnings race.mjs
 *
 * Each "tab" is a worker thread with its OWN SQLite connection — timers on
 * one thread could never interleave two transactions, so single-threaded
 * harnesses cannot fail. The winner HOLDS its write lock (HOLD_MS) before
 * COMMIT, forcing the loser to genuinely block on BEGIN IMMEDIATE; the
 * loser's measured wait is asserted.
 *
 * `refundFixed` is a JS model of src-tauri/src/refund.rs (same statement
 * order, same gates); it validates the design + SQL. The Rust
 * `cargo test -p mobi-pos --lib refund::` suite executes the real code,
 * including a two-thread contention test.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { open, createLegacySchema, applyV109 } from './schema.mjs';

const HOLD_MS = 300;
assert.ok(HOLD_MS >= 100, 'HOLD_MS too small: loser would not genuinely contend');
const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class Rej extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    Object.assign(this, extra);
  }
}
const isUnique = (e) => /UNIQUE constraint failed/.test(String(e?.message ?? e));

// ---------------------------------------------------------------------------
// Fixed design: JS model of refund.rs (same order, same gates)
// ---------------------------------------------------------------------------
function refundFixed(db, req, holdMs = 0) {
  const t0 = performance.now();
  db.exec('BEGIN IMMEDIATE');
  const waited = performance.now() - t0;
  try {
    const now = new Date().toISOString();
    const t = db.prepare('SELECT status, version FROM transactions WHERE id=?').get(req.ticketId);
    if (!t) throw new Rej('TICKET_NOT_FOUND');
    try {
      db.prepare('INSERT INTO refund_dedup(ticket_id,items_hash,refund_id,created_at) VALUES(?,?,?,?)')
        .run(req.ticketId, req.itemsHash, req.refundId, now);
    } catch (e) {
      if (isUnique(e)) throw new Rej('ALREADY_REFUNDED');
      throw e;
    }
    if (t.status === 'VOIDED') throw new Rej('ORIGINAL_VOIDED');

    const sum = (sql) =>
      Object.fromEntries(
        db.prepare(sql).all(req.ticketId).map((r) => [r.p, r.q])
      );
    const purchased = sum('SELECT product_id p, SUM(quantity) q FROM transaction_items WHERE transaction_id=? GROUP BY product_id');
    const refunded = sum(
      `SELECT i.product_id p, SUM(i.quantity) q FROM transactions x JOIN transaction_items i ON i.transaction_id=x.id
        WHERE x.original_transaction_id=? AND x.is_refund=1 GROUP BY i.product_id`
    );
    const requested = {};
    for (const l of req.lines) requested[l.productId] = (requested[l.productId] ?? 0) + l.quantity;
    for (const [p, q] of Object.entries(requested)) {
      const remaining = (purchased[p] ?? 0) - (refunded[p] ?? 0);
      if (q > remaining) throw new Rej('REFUND_EXCEEDS', { productId: p });
    }
    if (req.totalNet <= 0) throw new Rej('ZERO_REFUNDABLE');
    if (req.method === 'Espèces' && req.cashOut > 0) {
      const prior = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN json_extract(json_payload,'$.refundMethod')='Espèces'
           THEN COALESCE(CAST(json_extract(json_payload,'$.cashDisbursed') AS REAL),
             CASE WHEN json_extract(json_payload,'$.cashDisbursed') IS NULL
               THEN COALESCE(CAST(json_extract(json_payload,'$.total') AS REAL),0) ELSE 0 END)
           ELSE 0 END),0) s FROM transactions WHERE original_transaction_id=? AND is_refund=1`
      ).get(req.ticketId).s;
      if (req.cashOut - (req.cashTenderedNet - prior) > 0) throw new Rej('CASH_CAP_EXCEEDED');
    }
    const full = Object.keys(purchased).length > 0 &&
      Object.entries(purchased).every(([p, q]) => q - (refunded[p] ?? 0) - (requested[p] ?? 0) === 0);
    const newStatus = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const n = db.prepare(
      `UPDATE transactions SET status=?, version=version+1, updated_at=?, sync_status='pending'
        WHERE id=? AND version=? AND status<>'VOIDED'`
    ).run(newStatus, now, req.ticketId, t.version).changes;
    if (n !== 1) {
      const s = db.prepare('SELECT status s FROM transactions WHERE id=?').get(req.ticketId)?.s;
      throw new Rej(s === 'VOIDED' ? 'ORIGINAL_VOIDED' : 'ALREADY_REFUNDED');
    }

    const payload = JSON.stringify({
      id: req.refundId, isRefund: true, originalTransactionId: req.ticketId,
      refundMethod: req.method, cashDisbursed: req.method === 'Espèces' ? req.cashOut : 0, total: req.totalNet,
    });
    db.prepare(
      `INSERT INTO transactions(id,receipt_number,customer_id,subtotal,total,status,created_at,json_payload,
        device_id,idempotency_key,sync_status,updated_at,version,deleted,original_transaction_id,is_refund)
       VALUES(?,?,NULL,?,?,? ,?,?, ?,?,?, ?,1,0,?,1)`
    ).run(req.refundId, req.receiptNumber, req.totalNet, req.totalNet, 'COMPLETED', now, payload, 'd1', req.refundId, 'pending', now, req.ticketId);
    for (const [i, l] of req.lines.entries()) {
      db.prepare('INSERT INTO transaction_items(id,transaction_id,product_id,quantity,applied_price,json_payload,idempotency_key) VALUES(?,?,?,?,?,?,?)')
        .run(`${req.refundId}-item-${i}`, req.refundId, l.productId, l.quantity, 0, '{}', `${req.refundId}-itemkey-${i}`);
      db.prepare('INSERT INTO inventory_ledger(id,product_id,delta,reason,ref_type,ref_id,device_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?,?)')
        .run(`LED-${req.refundId}-${i}`, l.productId, l.quantity, 'REFUND', 'order', req.refundId, 'd1', `LEDK-${req.refundId}-${i}`, now, now);
    }
    for (const b of req.batches ?? []) {
      const upd = db.prepare(
        'UPDATE stock_batches SET quantity_remaining=quantity_remaining+?, version=version+1, updated_at=? WHERE batch_id=? AND (deleted=0 OR deleted IS NULL)'
      ).run(b.quantity, now, b.batchId);
      if (upd.changes !== 1) {
        db.prepare(
          'INSERT INTO stock_batches(batch_id,product_id,quantity_remaining,unit_cost,received_at,device_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)'
        ).run(b.fallbackBatchId, b.productId, b.quantity, b.unitCost, now, 'd1', b.fallbackKey, now, now);
      }
    }
    if (req.debt) {
      db.prepare(
        `INSERT INTO customer_debts(id,customer_id,customer_name,type,amount,balance_after,receipt_number,payment_method,notes,recorded_by,created_at,json_payload,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.debt.entryId, 'C1', 'Salma', 'PAYMENT_SETTLED', req.debt.amount, req.debt.amount, 'VERS-x', 'Crédit Client', 'relief', 'Manager', now, '{}', now);
    }
    if (req.voucher) {
      const v = db.prepare('SELECT id, initial_amount i, remaining_amount r FROM credit_vouchers WHERE code=?').get(req.voucher.code);
      if (!v) throw new Rej('VOUCHER_MISSING');
      const target = Math.min(v.i, v.r + req.voucher.amount);
      const u = db.prepare('UPDATE credit_vouchers SET remaining_amount=?, updated_at=?, version=version+1 WHERE id=? AND remaining_amount=?')
        .run(target, now, v.id, v.r);
      if (u.changes !== 1) throw new Rej('VOUCHER_CHANGED');
    }
    if (req.cashOut > 0) {
      const st = db.prepare('SELECT status s FROM cash_sessions WHERE id=?').get(req.shiftId)?.s;
      if (st !== 'OPEN') throw new Rej('NO_OPEN_SHIFT');
      db.prepare('INSERT INTO cash_movements(id,session_id,type,amount,reason,cashier_name,created_at,json_payload) VALUES(?,?,?,?,?,?,?,?)')
        .run(`MOV-${req.refundId}`, req.shiftId, 'ALLOCATION', req.cashOut, 'allocation', 'Manager', now, '{}');
    }
    db.prepare("INSERT INTO sync_outbox(idempotency_key,entity_type,entity_id,operation,payload_json,status,created_at,updated_at) VALUES(?,'order',?,'UPSERT',?,'pending',?,?)")
      .run(req.refundId, req.refundId, payload, now, now);
    const prev = db.prepare('SELECT entry_hash h FROM audit_chain ORDER BY rowid DESC LIMIT 1').get()?.h ?? 'GENESIS';
    db.prepare('INSERT INTO security_audit_logs(id,timestamp,user,action,details) VALUES(?,?,?,?,?)')
      .run(`AUD-${req.refundId}`, now, 'Manager', 'Remboursement', `Avoir ${req.refundId}`);
    db.prepare('INSERT INTO audit_chain(event_id,prev_hash,entry_hash) VALUES(?,?,?)')
      .run(`AUD-${req.refundId}`, prev, `HASH-${req.refundId}`);

    sleep(holdMs); // hold the write lock so the peer truly contends
    db.exec('COMMIT');
    return { outcome: 'COMMIT', status: newStatus, waited };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    if (e instanceof Rej) return { outcome: e.code, waited };
    throw e;
  }
}

// Baseline (pre-fix split design): quota + status pre-read OUTSIDE the lock,
// per-call refund ids, plain inserts. Faithful to transactionAdapter.ts
// pre-v109 (Dexie pre-gates + LIKE-scan SQLite section + separate checkout).
function refundBaseline(db, req, tag) {
  const purchased = Object.fromEntries(
    db.prepare('SELECT product_id p, SUM(quantity) q FROM transaction_items WHERE transaction_id=? GROUP BY product_id')
      .all(req.ticketId).map((r) => [r.p, r.q]));
  // Old pre-read: Dexie rows parsed in JS (refundedItems), no durable bound.
  const prior = db.prepare(`SELECT json_payload j FROM transactions WHERE json_payload LIKE '%originalTransactionId%'`).all();
  const refunded = {};
  for (const r of prior) {
    try {
      const p = JSON.parse(String(r.j));
      if (p.originalTransactionId === req.ticketId && p.isRefund) {
        for (const it of p.refundedItems ?? []) {
          refunded[it.productId] = (refunded[it.productId] ?? 0) + it.quantity;
        }
      }
    } catch {}
  }
  const status = db.prepare('SELECT status s FROM transactions WHERE id=?').get(req.ticketId)?.s;
  if (status === 'VOIDED') return { outcome: 'ORIGINAL_VOIDED', waited: 0 };
  for (const l of req.lines) {
    if (l.quantity > (purchased[l.productId] ?? 0) - (refunded[l.productId] ?? 0)) {
      return { outcome: 'REFUND_EXCEEDS', waited: 0 };
    }
  }
  sleep(30); // TOCTOU window: the peer commits here
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    const id = `REF-${tag}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({ id, isRefund: true, originalTransactionId: req.ticketId, refundMethod: req.method, cashDisbursed: req.cashOut, total: req.totalNet, refundedItems: req.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
    // Legacy shape: no refund identity columns (pre-v109).
    db.prepare(
      `INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,idempotency_key)
       VALUES(?,? ,0,?,'COMPLETED',?,?,?)`
    ).run(id, `AVOIR-${tag}`, req.totalNet, now, payload, id);
    for (const l of req.lines) {
      db.prepare('INSERT INTO transaction_items(id,transaction_id,product_id,quantity,applied_price,json_payload,idempotency_key) VALUES(?,?,?,?,?,?,?)')
        .run(`${id}-item`, id, l.productId, l.quantity, 0, '{}', `${id}-k`);
      db.prepare('INSERT INTO inventory_ledger(id,product_id,delta,reason,ref_type,ref_id,device_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(`LED-${id}`, l.productId, l.quantity, 'REFUND', 'order', id, 'd1', `LEDK-${id}`, now, now);
    }
    for (const b of req.batches ?? []) {
      db.prepare('UPDATE stock_batches SET quantity_remaining=quantity_remaining+? WHERE batch_id=?').run(b.quantity, b.batchId);
    }
    db.exec('COMMIT');
    return { outcome: 'COMMIT', waited: 0 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function voidOp(db, ticketId, holdMs = 0) {
  const t0 = performance.now();
  db.exec('BEGIN IMMEDIATE');
  const waited = performance.now() - t0;
  try {
    const t = db.prepare('SELECT status, version FROM transactions WHERE id=?').get(ticketId);
    if (t.status !== 'COMPLETED') throw new Rej('NOT_VOIDABLE');
    db.prepare('UPDATE transactions SET status=?, version=version+1 WHERE id=? AND version=?')
      .run('VOIDED', ticketId, t.version);
    sleep(holdMs);
    db.exec('COMMIT');
    return { outcome: 'COMMIT', waited };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    if (e instanceof Rej) return { outcome: e.code, waited };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------
if (!isMainThread) {
  const { dbPath, kind, tag, delayMs, holdMs, req } = workerData;
  const db = open(dbPath);
  parentPort.postMessage({ ready: true });
  Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
  sleep(delayMs);
  let r;
  if (kind === 'baseline') r = refundBaseline(db, req, tag);
  else if (kind === 'void') r = voidOp(db, req.ticketId, holdMs);
  else r = refundFixed(db, req, holdMs);
  db.close();
  parentPort.postMessage({ tag, ...r });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main side
// ---------------------------------------------------------------------------
const FILE = fileURLToPath(import.meta.url);
const clean = (p) => ['', '-wal', '-shm', '-journal'].forEach((s) => rmSync(p + s, { force: true }));

const mkReq = ({ ticketId = 'TKT-1', lines, method = 'Espèces', net, cash = 0, tendered = 0, debt = null, voucher = null, hash = 'H', refund = 'REF-H' }) => ({
  ticketId, lines, method, totalNet: net, cashOut: cash, cashTenderedNet: tendered,
  debtRelief: debt, voucher, itemsHash: hash, refundId: refund, receiptNumber: `AVOIR-${hash}`, shiftId: 'S1',
  batches: lines.map((l) => ({ batchId: 'B1', quantity: l.quantity, fallbackBatchId: `FB-${hash}`, fallbackKey: `FBK-${hash}`, unitCost: 50 })),
});

function seed(path, items, migrated = true) {
  clean(path);
  const db = open(path);
  createLegacySchema(db);
  // S1 models the PRE-FIX world, so it seeds the legacy schema WITHOUT v109:
  // no dedup gate, no trigger, quota by stale pre-read — the bug reproduces.
  if (migrated) applyV109(db);
  db.prepare("INSERT INTO transactions(id,receipt_number,subtotal,total,status,created_at,json_payload,idempotency_key) VALUES('TKT-1','REC-1',300,300,'COMPLETED','t','{}','k1')").run();
  for (const [p, q] of items) {
    db.prepare("INSERT INTO transaction_items(id,transaction_id,product_id,quantity,applied_price,json_payload,idempotency_key) VALUES(?,?,?,?,?,?,?)")
      .run(`TI-${p}`, 'TKT-1', p, q, 100, '{}', `TIK-${p}`);
  }
  db.prepare("INSERT INTO stock_batches(batch_id,product_id,quantity_remaining,unit_cost,received_at,device_id,idempotency_key,created_at,updated_at) VALUES('B1','P1',10,50,'t','d1','bk1','t','t')").run();
  db.prepare("INSERT INTO customers(id,name,phone,json_payload,updated_at) VALUES('C1','Salma','','{}','t')").run();
  db.prepare("INSERT INTO credit_vouchers(id,code,initial_amount,remaining_amount,status,updated_at) VALUES('V1','BON1',1000,700,'ACTIVE','t')").run();
  db.prepare("INSERT INTO cash_sessions(id,status) VALUES('S1','OPEN')").run();
  return db;
}

function race(path, a, b) {
  return new Promise((resolve, reject) => {
    const barrier = new SharedArrayBuffer(4);
    const results = [];
    let ready = 0;
    const spawn = (spec) => {
      const w = new Worker(FILE, { workerData: { dbPath: path, barrier, holdMs: 0, ...spec } });
      w.on('message', (m) => {
        if (m.ready && ++ready === 2) {
          new Int32Array(barrier)[0] = 1;
          Atomics.notify(new Int32Array(barrier), 0, 2);
        } else if (!m.ready) {
          results.push(m);
          if (results.length === 2) resolve(results.sort((x, y) => x.tag.localeCompare(y.tag)));
        }
      });
      w.on('error', reject);
    };
    // Default <50 ms apart, like the field report; a spec may override
    // delayMs to place the peer inside a TOCTOU window deliberately.
    spawn({ tag: 'A', delayMs: 0, ...a });
    spawn({ tag: 'B', delayMs: 12, ...b });
  });
}

const snap = (db) => ({
  refundRows: db.prepare('SELECT COUNT(*) c FROM transactions WHERE is_refund=1').get().c,
  refundQty: db.prepare('SELECT COALESCE(SUM(i.quantity),0) s FROM transactions t JOIN transaction_items i ON i.transaction_id=t.id WHERE t.is_refund=1').get().s,
  invQty: db.prepare('SELECT COALESCE(SUM(delta),0) s FROM inventory_ledger').get().s,
  debts: db.prepare('SELECT COUNT(*) c FROM customer_debts').get().c,
  dedup: db.prepare('SELECT COUNT(*) c FROM refund_dedup').get().c,
  status: db.prepare("SELECT status s FROM transactions WHERE id='TKT-1'").get().s,
  version: db.prepare("SELECT version v FROM transactions WHERE id='TKT-1'").get().v,
  links: db.prepare('SELECT COUNT(*) c FROM audit_chain').get().c,
  forks: (() => {
    const r = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT prev_hash) d FROM audit_chain').get();
    return r.c - r.d;
  })(),
});
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// ---- S1a: BASELINE over-refund (same items, both tabs pass the stale gate) ----
{
  console.log('S1a baseline: same full refund from two tabs');
  const P = 'tmp-s1a.db';
  seed(P, [['P1', 2]], false).close();
  const req = { ticketId: 'TKT-1', lines: [{ productId: 'P1', quantity: 2 }], method: 'Espèces', totalNet: 200, cashOut: 0 };
  const [a, b] = await race(P, { kind: 'baseline', req }, { kind: 'baseline', req });
  const db = open(P);
  // Legacy shape: identify refunds the old way (JSON LIKE, no columns).
  const qty = db.prepare(
    `SELECT COALESCE(SUM(i.quantity),0) s FROM transactions t
      JOIN transaction_items i ON i.transaction_id=t.id
     WHERE t.json_payload LIKE '%"originalTransactionId":"TKT-1"%'`
  ).get().s;
  assert.deepEqual([a.outcome, b.outcome], ['COMMIT', 'COMMIT']);
  assert.equal(qty, 4);
  ok(`BUG REPRODUCED: ${a.outcome}/${b.outcome}, ${qty} units refunded of 2 purchased`);
  db.close();
  clean(P);
}

// ---- S1b: BASELINE refund lands on a voided ticket (status pre-read race) ----
{
  console.log('S1b baseline: refund racing void');
  const P = 'tmp-s1b.db';
  seed(P, [['P1', 1]], false).close();
  const req = { ticketId: 'TKT-1', lines: [{ productId: 'P1', quantity: 1 }], method: 'Espèces', totalNet: 100, cashOut: 0 };
  // Baseline pre-reads (COMPLETED), sleeps 30 ms, then writes: the void must
  // commit INSIDE that window, so it runs with a 15 ms delay.
  const [a, b] = await race(P, { kind: 'baseline', req, delayMs: 0 }, { kind: 'void', req: { ticketId: 'TKT-1' }, delayMs: 15 });
  const db = open(P);
  const status = db.prepare("SELECT status s FROM transactions WHERE id='TKT-1'").get().s;
  const rows = db.prepare(
    `SELECT COUNT(*) c FROM transactions WHERE json_payload LIKE '%"originalTransactionId":"TKT-1"%'`
  ).get().c;
  assert.equal(a.outcome, 'COMMIT'); // refund paid on a voided ticket anyway
  assert.equal(b.outcome, 'COMMIT'); // void committed mid-TOCTOU
  assert.equal(status, 'VOIDED');
  assert.equal(rows, 1);
  ok('BUG REPRODUCED: refund committed although the ticket was voided mid-flight');
  db.close();
  clean(P);
}

// ---- S2: FIXED identical refund — winner holds the lock, loser fails ----
{
  console.log('S2 fixed: same refund from two tabs, winner holds the lock');
  const P = 'tmp-s2.db';
  seed(P, [['P1', 2]]).close();
  const req = mkReq({ lines: [{ productId: 'P1', quantity: 2 }], net: 200 });
  const [a, b] = await race(P, { kind: 'fixed', req, holdMs: HOLD_MS }, { kind: 'fixed', req });
  assert.equal(a.outcome, 'COMMIT');
  assert.equal(b.outcome, 'ALREADY_REFUNDED');
  assert.ok(b.waited > HOLD_MS * 0.6, `loser must really block (waited ${b.waited.toFixed(0)}ms)`);
  ok(`A=COMMIT, B=ALREADY_REFUNDED after genuinely blocking ${b.waited.toFixed(0)}ms`);
  const db = open(P);
  const s = snap(db);
  assert.deepEqual(
    { rows: s.refundRows, qty: s.refundQty, inv: s.invQty, dedup: s.dedup, status: s.status, version: s.version, links: s.links, forks: s.forks },
    { rows: 1, qty: 2, inv: 2, dedup: 1, status: 'REFUNDED', version: 2, links: 1, forks: 0 }
  );
  ok('exactly one AVOIR, stock +2 once, status REFUNDED v2, linear audit chain');
  db.close();
  clean(P);
}

// ---- S3: FIXED different partials both succeed ----
{
  console.log('S3 fixed: two different partial refunds concurrently');
  const P = 'tmp-s3.db';
  seed(P, [['P1', 1], ['P2', 1]]).close();
  const ra = mkReq({ lines: [{ productId: 'P1', quantity: 1 }], net: 100, hash: 'HA', refund: 'REF-HA' });
  const rb = mkReq({ lines: [{ productId: 'P2', quantity: 1 }], net: 100, hash: 'HB', refund: 'REF-HB' });
  const [a, b] = await race(P, { kind: 'fixed', req: ra, holdMs: HOLD_MS }, { kind: 'fixed', req: rb });
  assert.deepEqual([a.outcome, b.outcome, a.status, b.status], ['COMMIT', 'COMMIT', 'PARTIALLY_REFUNDED', 'REFUNDED']);
  const db = open(P);
  assert.equal(snap(db).version, 3);
  ok('no false 409: blocked B sees A and lands on REFUNDED, version 3');
  db.close();
  clean(P);
}

// ---- S4: FIXED same items different method — quota stops it, dedup rolls back ----
{
  console.log('S4 fixed: same items, different payout method');
  const P = 'tmp-s4.db';
  seed(P, [['P1', 1]]).close();
  const ra = mkReq({ lines: [{ productId: 'P1', quantity: 1 }], net: 100, hash: 'HA', refund: 'REF-HA' });
  const rb = mkReq({ lines: [{ productId: 'P1', quantity: 1 }], method: 'Avoir Client', net: 100, hash: 'HB', refund: 'REF-HB' });
  const [a, b] = await race(P, { kind: 'fixed', req: ra, holdMs: HOLD_MS }, { kind: 'fixed', req: rb });
  assert.deepEqual([a.outcome, b.outcome], ['COMMIT', 'REFUND_EXCEEDS']);
  const db = open(P);
  const s = snap(db);
  assert.equal(s.refundRows, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM refund_dedup WHERE items_hash='HB'").get().c, 0);
  ok('loser rejected by in-transaction quota; its dedup row did not persist');
  db.close();
  clean(P);
}

// ---- S5: basis property — same basis collides, bumped basis distinguishes ----
{
  console.log('S5 identity: basis distinguishes duplicate from legitimate repeat');
  // FNV-1a 32-bit, same construction as deterministicId('REF', ...parts).
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return `REF-${(h >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
  };
  const idOf = (basis) => fnv(['TKT-1', 'P1:1:100:1', 'Espèces', 100, basis].join('|'));
  assert.equal(idOf(0), idOf(0), 'two tabs, same stale view → same id → ALREADY_REFUNDED');
  assert.notEqual(idOf(0), idOf(1), 'later legitimate partial (basis=1) → different id → quota decides');
  ok('same-basis duplicates converge; basis+1 repeats stay committable');
}

// ---- S6: FIXED void vs refund, both orders ----
{
  console.log('S6 fixed: void racing refund');
  let P = 'tmp-s6a.db';
  seed(P, [['P1', 1]]).close();
  const req = mkReq({ lines: [{ productId: 'P1', quantity: 1 }], net: 100 });
  let [a, b] = await race(P, { kind: 'void', req: { ticketId: 'TKT-1' }, holdMs: HOLD_MS }, { kind: 'fixed', req });
  assert.deepEqual([a.outcome, b.outcome], ['COMMIT', 'ORIGINAL_VOIDED']);
  let db = open(P);
  assert.deepEqual([snap(db).status, snap(db).refundRows, snap(db).dedup], ['VOIDED', 0, 0]);
  db.close();
  clean(P);
  ok('void first: refund gets ORIGINAL_VOIDED with zero side effects');
  P = 'tmp-s6b.db';
  seed(P, [['P1', 1]]).close();
  [a, b] = await race(P, { kind: 'fixed', req, holdMs: HOLD_MS }, { kind: 'void', req: { ticketId: 'TKT-1' } });
  assert.deepEqual([a.outcome, b.outcome], ['COMMIT', 'NOT_VOIDABLE']);
  db = open(P);
  assert.equal(snap(db).status, 'REFUNDED');
  db.close();
  clean(P);
  ok('refund first: void is rejected, ticket stays REFUNDED');
}

// ---- S7: FIXED late failure rolls back everything (atomicity needs no contention) ----
{
  console.log('S7 fixed: late failure (voucher) undoes every earlier step');
  const P = 'tmp-s7.db';
  seed(P, [['P1', 1]]).close();
  const db = open(P);
  const req = mkReq({ lines: [{ productId: 'P1', quantity: 1 }], net: 100 });
  req.voucher = { code: 'BON-MISSING', amount: 50 };
  assert.equal(refundFixed(db, req).outcome, 'VOUCHER_MISSING');
  assert.deepEqual(
    { ...snap(db), version: db.prepare("SELECT version v FROM transactions WHERE id='TKT-1'").get().v },
    { refundRows: 0, refundQty: 0, invQty: 0, debts: 0, dedup: 0, status: 'COMPLETED', version: 1, links: 0, forks: 0 }
  );
  ok('no refund row, no ledger, no stock move, no dedup row, ticket untouched');
  req.voucher = null; // recomputed retry after the failure
  const r2 = refundFixed(db, req);
  assert.equal(r2.outcome, 'COMMIT');
  assert.equal(snap(db).refundRows, 1);
  ok('retry after VOUCHER_MISSING succeeds — nothing was poisoned');
  db.close();
  clean(P);
}

console.log(`\n${n} race checks passed`);
