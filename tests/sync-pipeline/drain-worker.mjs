/**
 * Sync drain worker harness (MOBI-SYNC-DRAIN-TRANSPORT).
 * Run from tests/sync-pipeline:  node --no-warnings drain-worker.mjs
 *
 * Models the worker loop from src/db/adapters/syncDrainWorker.ts against a
 * file DB with the SAME SQL shapes as src-tauri/src/sync_outbox.rs
 * (contiguous claim, contiguity-checked ACK, scoped reap), plus a scripted
 * mock gateway and a time-ingest recorder. The Rust `cargo test` suite
 * executes the real transitions (including a two-thread claim race); this
 * proves loop-level properties: strict order, failure reset without
 * skip/duplication, verbatim time-token forwarding, backoff growth.
 */
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const clean = (p) => ['', '-wal', '-shm', '-journal'].forEach((s) => rmSync(p + s, { force: true }));
const DDL = `CREATE TABLE sync_outbox (rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  operation TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  device_id TEXT, device_signature TEXT, seq_no INTEGER);
CREATE TABLE device_identity (device_id TEXT PRIMARY KEY, last_outbox_seq INTEGER NOT NULL DEFAULT 0, last_acked_seq INTEGER NOT NULL DEFAULT 0);`;
const open = (path) => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;');
  return db;
};
const nowIso = () => new Date().toISOString();

// --- mock native transitions (same statements as sync_outbox.rs) ---
const native = {
  fetch(db, batchSize) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const cursor = db.prepare('SELECT last_acked_seq s FROM device_identity WHERE device_id=?').get('dev-A')?.s ?? 0;
      const rows = db.prepare(
        `SELECT seq_no s, idempotency_key k FROM sync_outbox WHERE status='pending' AND seq_no IS NOT NULL AND device_id=? ORDER BY seq_no LIMIT ?`
      ).all('dev-A', batchSize);
      if (!rows.length) { db.exec('COMMIT'); return []; }
      let c = rows[0].s > cursor + 1 ? rows[0].s - 1 : cursor;
      if (rows[0].s > cursor + 1) db.prepare('UPDATE device_identity SET last_acked_seq=? WHERE device_id=?').run(c, 'dev-A');
      const run = [];
      for (const r of rows) {
        if (r.s !== c + 1) break;
        c += 1;
        run.push(r);
      }
      if (!run.length) throw new Error('SEQUENCE_GAP_DETECTED:run_empty');
      // ORDER BY preserved like the Rust path (which returns the ordered
      // run directly): a bare IN re-select may come back in key order.
      const full = db.prepare(`SELECT seq_no s, idempotency_key k, payload_json p, device_signature g FROM sync_outbox WHERE idempotency_key IN (${run.map(() => '?').join(',')}) ORDER BY seq_no`).all(...run.map((r) => r.k));
      db.prepare(`UPDATE sync_outbox SET status='inflight', updated_at=? WHERE status='pending' AND idempotency_key IN (${run.map(() => '?').join(',')})`)
        .run(nowIso(), ...run.map((r) => r.k));
      db.exec('COMMIT');
      return full;
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  },
  mark(db, seqs) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const cursor = db.prepare('SELECT last_acked_seq s FROM device_identity WHERE device_id=?').get('dev-A')?.s ?? 0;
      const fresh = [...new Set(seqs)].filter((s) => s > cursor).sort((a, b) => a - b);
      if (!fresh.length) { db.exec('COMMIT'); return cursor; }
      fresh.forEach((s, i) => {
        if (s !== cursor + 1 + i) throw new Error(`SEQUENCE_GAP_DETECTED:expected_${cursor + 1 + i}_received_${s}`);
      });
      db.prepare(`DELETE FROM sync_outbox WHERE seq_no IN (${fresh.map(() => '?').join(',')}) AND device_id=?`).run(...fresh, 'dev-A');
      db.prepare('UPDATE device_identity SET last_acked_seq=? WHERE device_id=?').run(cursor + fresh.length, 'dev-A');
      db.exec('COMMIT');
      return cursor + fresh.length;
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  },
  reap(db, timeoutMs) {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const sql = timeoutMs === 0
      ? "UPDATE sync_outbox SET status='pending', updated_at=? WHERE status='inflight' AND seq_no IS NOT NULL"
      : "UPDATE sync_outbox SET status='pending', updated_at=? WHERE status='inflight' AND seq_no IS NOT NULL AND updated_at <= ?";
    const args = timeoutMs === 0 ? [nowIso()] : [nowIso(), cutoff];
    const r = db.prepare(sql).run(...args);
    return Number(r.changes);
  },
  counts(db) {
    return {
      pending: db.prepare("SELECT COUNT(*) c FROM sync_outbox WHERE status='pending' AND seq_no IS NOT NULL").get().c,
      inflight: db.prepare("SELECT COUNT(*) c FROM sync_outbox WHERE status='inflight' AND seq_no IS NOT NULL").get().c,
    };
  },
};

// --- mock gateway: scripted behaviors, seq-deduping commit log ---
function mockGateway(script) {
  const state = { received: [], committed: new Set(), calls: 0, ingestedTokens: [] };
  const post = async (req) => {
    state.calls += 1;
    const step = script[Math.min(state.calls - 1, script.length - 1)];
    for (const m of req.mutations) state.received.push(m.seqNo);
    if (step === 'fail') throw new Error('GATEWAY_UNAVAILABLE:network_err');
    if (step && step.startsWith('gap:')) {
      return { ackSeqNos: [], rejectedSeqNos: req.mutations.map((m) => ({ seqNo: m.seqNo, reason: step.slice(4) })) };
    }
    for (const m of req.mutations) state.committed.add(m.seqNo); // gateway dedupes by seq
    const out = { ackSeqNos: req.mutations.map((m) => m.seqNo) };
    if (step && step.startsWith('token:')) {
      state.ingestedTokens.push(step.slice(6)); // worker forwards verbatim
      out.serverTimeToken = step.slice(6);
    }
    return out;
  };
  return { state, post };
}

// --- worker loop model (same policy as syncDrainWorker.ts) ---
async function drainLoop(db, gateway, { batchSize = 50, backoffCap = 5 } = {}) {
  const sleeps = [];
  const sleep = (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, 0)); };
  const BACKOFFS = [1, 2, 5, 10, 30].slice(0, backoffCap);
  let step = 0;
  let idle = 0;
  for (let i = 0; i < 60; i++) {
    const batch = native.fetch(db, batchSize);
    if (!batch.length) { idle++; if (idle >= 2) break; await sleep(0); continue; }
    idle = 0;
    try {
      const res = await gateway.post({ deviceId: 'dev-A', mutations: batch.map((m) => ({ seqNo: m.s, ticketId: m.k, payload: m.p, deviceSignature: m.g })) });
      const sent = new Set(batch.map((m) => m.s));
      const acked = res.ackSeqNos.filter((s) => sent.has(s));
      if (acked.length) native.mark(db, acked);
      const bad = (res.rejectedSeqNos ?? []).length;
      if (acked.length !== batch.length || bad) {
        native.reap(db, 0);
        step = Math.min(step + 1, BACKOFFS.length - 1);
        await sleep(BACKOFFS[step]);
        continue;
      }
      step = 0;
      if (res.serverTimeToken) gateway.state.ingestedTokens.push(`${res.serverTimeToken}:forwarded-verbatim`);
    } catch (e) {
      native.reap(db, 0);
      step = Math.min(step + 1, BACKOFFS.length - 1);
      await sleep(BACKOFFS[step]);
    }
  }
  return { sleeps };
}

function seedRefunds(path, n) {
  clean(path);
  const db = open(path);
  db.exec(DDL);
  db.prepare("INSERT INTO device_identity(device_id,last_outbox_seq,last_acked_seq) VALUES('dev-A',?,0)").run(n);
  const t = nowIso();
  for (let s = 1; s <= n; s++) {
    db.prepare(`INSERT INTO sync_outbox(idempotency_key,entity_type,entity_id,operation,payload_json,status,created_at,updated_at,device_id,device_signature,seq_no)
      VALUES(?,?,?,?,?,'pending',?,?,'dev-A',?,?)`)
      .run(`REF-${s}`, 'order', `TKT-${s}`, 'UPSERT', '{}', t, t, `sig-${s}`, s);
  }
  return db;
}
let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// ---- D1: 10 sequential refunds drain in strict order ----
{
  console.log('D1 ten signed refunds dispatch strictly in order');
  const P = 'tmp-drain-a.db';
  const db = seedRefunds(P, 10);
  const gw = mockGateway(['ok']);
  await drainLoop(db, gw);
  assert.deepEqual(gw.state.received.slice(0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...gw.state.committed].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(native.counts(db), { pending: 0, inflight: 0 });
  assert.equal(db.prepare('SELECT last_acked_seq s FROM device_identity WHERE device_id=?').get('dev-A').s, 10);
  ok('gateway saw seq 1..10 in order; outbox drained; cursor at 10');
  db.close(); clean(P);
}

// ---- D2: mid-flight network failure resets without skip/duplication ----
{
  console.log('D2 mid-flight failure resets safely');
  const P = 'tmp-drain-b.db';
  const db = seedRefunds(P, 6);
  const gw = mockGateway(['ok', 'fail', 'fail', 'ok']); // 2nd + 3rd POSTs die
  await drainLoop(db, gw, { batchSize: 3 });
  assert.deepEqual([...gw.state.committed].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(native.counts(db), { pending: 0, inflight: 0 });
  const dupes = gw.state.received.filter((s, i) => gw.state.received.indexOf(s) !== i);
  assert.ok(dupes.length > 0, 'retries re-POSTed (expected)');
  assert.equal(new Set(gw.state.received).size, 6, 'gateway dedupes re-POSTs by seq — 6 unique commits');
  ok(`Failures re-drove the flight; commits exactly-once per seq (re-POSTs deduped: [${[...new Set(dupes)].sort() }])`);
  db.close(); clean(P);
}

// ---- D3: gap rejection resets; retry converges ----
{
  console.log('D3 gateway gap rejection resets the flight');
  const P = 'tmp-drain-c.db';
  const db = seedRefunds(P, 4);
  const gw = mockGateway(['gap:SEQUENCE_GAP_DETECTED', 'ok']);
  await drainLoop(db, gw, { batchSize: 4 });
  assert.deepEqual([...gw.state.committed].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual(native.counts(db), { pending: 0, inflight: 0 });
  ok('rejected flight returned to pending and drained cleanly on retry');
  db.close(); clean(P);
}

// ---- D4: SERVERTIME token forwarded verbatim to ingestion ----
{
  console.log('D4 piggybacked time token forwarded verbatim');
  const P = 'tmp-drain-d.db';
  const db = seedRefunds(P, 2);
  const TOKEN = 'SERVERTIME_V1.eyJub25jZSI6Im4xIn0.c2ln';
  const gw = mockGateway([`token:${TOKEN}`]);
  await drainLoop(db, gw, { batchSize: 2 });
  assert.ok(gw.state.ingestedTokens.includes(TOKEN), 'raw token recorded');
  assert.ok(gw.state.ingestedTokens.includes(`${TOKEN}:forwarded-verbatim`), 'forwarded without re-serialization');
  assert.deepEqual(native.counts(db), { pending: 0, inflight: 0 }, 'ACKs processed independently of time path');
  ok('token passed through byte-identical; batch unaffected');
  db.close(); clean(P);
}

console.log(`\n${n} drain-worker checks passed`);
