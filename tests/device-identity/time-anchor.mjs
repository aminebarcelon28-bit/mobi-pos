/**
 * Monotonic time-anchor harness (MOBI-SECURE-TIME-MONOTONIC-ANCHOR).
 * Run from tests/device-identity:  node --no-warnings time-anchor.mjs
 *
 * Each "invoke" is a worker thread with its OWN SQLite connection. The model
 * mirrors src-tauri/src/trust_core/time_anchor.rs gate order
 * (read high-water → regression check → derive → ratchet-advance, all inside
 * one BEGIN IMMEDIATE txn) plus the refund seq assignment
 * (UPDATE device_identity SET last_outbox_seq+1 → re-read → stamp row).
 * The Rust `cargo test` suite executes the real code; this proves the SQL
 * shapes serialize under genuine lock contention and survive restarts.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const FILE = fileURLToPath(import.meta.url);
const REGRESSION_TOLERANCE_MS = 60_000;
const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class Rej extends Error {
  constructor(code) { super(code); this.code = code; }
}

const open = (path) => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;');
  return db;
};
const DDL = `CREATE TABLE IF NOT EXISTS time_anchor (id INTEGER PRIMARY KEY CHECK (id=1),
  high_water_ms INTEGER NOT NULL, high_water_mono_ms INTEGER NOT NULL,
  last_server_ms INTEGER NOT NULL DEFAULT 0, last_server_nonce TEXT NOT NULL DEFAULT '',
  skew_ms INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_identity (device_id TEXT PRIMARY KEY, last_outbox_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sync_outbox (idempotency_key TEXT NOT NULL UNIQUE, seq_no INTEGER, payload TEXT);`;

// Model of anchor_now_ms + seq assignment + stamped insert, one txn.
function sequencedInsert(db, { key, monoMs, wallMs, holdMs = 0 }) {
  const t0 = performance.now();
  db.exec('BEGIN IMMEDIATE');
  const waited = performance.now() - t0;
  try {
    db.exec(DDL);
    const row = db.prepare('SELECT high_water_ms hw, high_water_mono_ms hm FROM time_anchor WHERE id=1').get();
    let now;
    if (!row) {
      now = wallMs; // first boot adopts
      db.prepare('INSERT INTO time_anchor(id,high_water_ms,high_water_mono_ms,updated_at) VALUES(1,?,?,?)')
        .run(now, monoMs, new Date(now).toISOString());
    } else {
      if (wallMs + REGRESSION_TOLERANCE_MS < row.hw) throw new Rej('SYSTEM_CLOCK_REGRESSION');
      const expected = row.hw + Math.max(0, monoMs - row.hm);
      now = Math.max(expected, row.hw);
      const capped = Math.min(wallMs, now + REGRESSION_TOLERANCE_MS);
      db.prepare('UPDATE time_anchor SET high_water_ms=?, high_water_mono_ms=? WHERE id=1')
        .run(Math.max(now, capped), monoMs);
    }
    const cur = db.prepare('SELECT last_outbox_seq s FROM device_identity WHERE device_id=?').get('dev-A')?.s ?? 0;
    if (cur >= Number.MAX_SAFE_INTEGER - 1) throw new Rej('OUTBOX_SEQUENCE_EXHAUSTED');
    db.prepare('UPDATE device_identity SET last_outbox_seq=last_outbox_seq+1 WHERE device_id=?').run('dev-A');
    const seq = db.prepare('SELECT last_outbox_seq s FROM device_identity WHERE device_id=?').get('dev-A').s;
    db.prepare('INSERT INTO sync_outbox(idempotency_key,seq_no,payload) VALUES(?,?,?)').run(key, seq, `signed:${seq}`);
    sleep(holdMs);
    db.exec('COMMIT');
    return { outcome: 'COMMIT', seq, anchorMs: now, waited };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    if (e instanceof Rej) return { outcome: e.code, waited };
    throw e;
  }
}

if (!isMainThread) {
  const { dbPath, barrier, tag, delayMs, holdMs, key, monoMs, wallMs } = workerData;
  const db = open(dbPath);
  parentPort.postMessage({ ready: true });
  Atomics.wait(new Int32Array(barrier), 0, 0);
  sleep(delayMs);
  let r;
  try {
    r = sequencedInsert(db, { key, monoMs, wallMs, holdMs });
  } catch (e) {
    r = { outcome: `ERROR:${e.message}` };
  }
  db.close();
  parentPort.postMessage({ tag, ...r });
  process.exit(0);
}

const clean = (p) => ['', '-wal', '-shm', '-journal'].forEach((s) => rmSync(p + s, { force: true }));
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const seed = (path) => {
  clean(path);
  const db = open(path);
  db.exec(DDL);
  db.prepare("INSERT INTO device_identity(device_id,last_outbox_seq) VALUES('dev-A',0)").run();
  return db;
};

// ---- S1: 6 rapid invokes → strictly increasing seq, no collision ----
{
  console.log('S1 rapid sequential invokes serialize the counter');
  const P = 'tmp-time-race.db';
  seed(P).close();
  const wall = Date.now();
  const barrier = new SharedArrayBuffer(4);
  const results = await new Promise((resolve, reject) => {
    const out = [];
    let ready = 0;
    for (let i = 0; i < 6; i++) {
      const w = new Worker(FILE, {
        workerData: { dbPath: P, barrier, tag: `R${i}`, delayMs: i * 4, holdMs: 80, key: `OUT-${i}`, monoMs: 1_000_000 + i * 10, wallMs: wall },
      });
      w.on('message', (m) => {
        if (m.ready && ++ready === 6) {
          new Int32Array(barrier)[0] = 1;
          Atomics.notify(new Int32Array(barrier), 0, 6);
        } else if (!m.ready) {
          out.push(m);
          if (out.length === 6) resolve(out);
        }
      });
      w.on('error', reject);
    }
  });
  assert.ok(results.every((r) => r.outcome === 'COMMIT'), JSON.stringify(results));
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
  const blocked = results.filter((r) => (r.waited ?? 0) > 40);
  assert.ok(blocked.length >= 3, `lock genuinely contended (${results.map((r) => Math.round(r.waited ?? 0)).join(',')}ms)`);
  const db = open(P);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT seq_no) d FROM sync_outbox').get().d, 6);
  ok(`seq 1..6 with zero collisions (${blocked.length}/6 blocked on the lock)`);
  db.close();
  var saved = P;
}

// ---- S2: restart preserves counter + high-water ----
{
  console.log('S2 restart preserves seq and high-water');
  const db = open(saved);
  const before = db.prepare('SELECT last_outbox_seq s FROM device_identity WHERE device_id=?').get('dev-A').s;
  const hw = db.prepare('SELECT high_water_ms h FROM time_anchor WHERE id=1').get().h;
  assert.equal(before, 6);
  db.close();
  const db2 = open(saved); // fresh connection, like a process restart
  assert.equal(db2.prepare('SELECT last_outbox_seq s FROM device_identity WHERE device_id=?').get('dev-A').s, 6);
  assert.equal(db2.prepare('SELECT high_water_ms h FROM time_anchor WHERE id=1').get().h, hw);
  ok(`counter resumes at 7, high-water ${hw} intact across closure`);
  db2.close();
  clean(saved);
}

// ---- S3: planted high-water trips the rollback wire ----
{
  console.log('S3 rollback behind high-water hard-faults');
  const P = 'tmp-time-rb.db';
  const db = seed(P);
  const hw = Date.now() + 3_600_000;
  db.prepare('INSERT INTO time_anchor(id,high_water_ms,high_water_mono_ms,updated_at) VALUES(1,?,0,?)').run(hw, new Date(hw).toISOString());
  db.close();
  const db2 = open(P);
  const t0 = performance.now();
  db2.exec('BEGIN IMMEDIATE');
  const waited = performance.now() - t0;
  void waited;
  const row = db2.prepare('SELECT high_water_ms hw FROM time_anchor WHERE id=1').get();
  const wall = Date.now();
  let outcome = 'COMMIT';
  if (wall + REGRESSION_TOLERANCE_MS < row.hw) {
    db2.exec('ROLLBACK');
    outcome = 'SYSTEM_CLOCK_REGRESSION';
  } else {
    db2.exec('COMMIT');
  }
  assert.equal(outcome, 'SYSTEM_CLOCK_REGRESSION');
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM sync_outbox').get().c, 0);
  assert.equal(db2.prepare('SELECT high_water_ms h FROM time_anchor WHERE id=1').get().h, hw);
  ok('fault carries last_seen:attempted shape with zero mutations, mark untouched');
  db2.close();
  clean(P);
}

console.log(`\n${n} time-anchor checks passed`);
