#!/usr/bin/env node
/**
 * TEST-ONLY checkout latency baseline (Phase 4.4 W4).
 *
 * Measures p50/p95 of a checkout-shaped statement batch against a scratch
 * file DB: BEGIN IMMEDIATE + representative reads + representative writes +
 * COMMIT, N samples. No production code is touched, imported, or modified
 * by this script — it uses @libsql/client against tmp files only.
 *
 * What this measures: storage + loop cost of the statement SHAPE of a
 * checkout (order header + items + ledger deltas + outbox rows).
 * What it does NOT measure (stated, not hidden): Tauri IPC round trips,
 * Dexie mirror writes, FIFO math, Zustand, or UI render. True in-app numbers
 * need the hooks listed in REQUIRED PRODUCTION HOOKS below — proposed, not
 * added here per the audit-only latency rule.
 *
 * Usage: node scripts/bench-checkout.mjs [samples=200]
 * Exit: 0 always (prints numbers); non-zero on harness failure.
 */
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLES = Number(process.argv[2] || 200);
const WARMUP = 20;
// Representative small-basket checkout: 1 order + 3 items + 3 ledger deltas
// + 2 outbox rows + version read, mirroring writeCheckoutAtomic's shape.
const ITEMS = 3;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'mobi-bench-'));
  const dbPath = join(dir, 'bench.db');
  const db = createClient({ url: `file:${dbPath}` });
  try {
    await db.execute('PRAGMA journal_mode=WAL;');
    await db.batch([
      'CREATE TABLE transactions (id TEXT PRIMARY KEY, receipt_number TEXT, total REAL, version INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0)',
      'CREATE TABLE transaction_items (id TEXT PRIMARY KEY, transaction_id TEXT, product_id TEXT, quantity INTEGER, applied_price REAL)',
      'CREATE TABLE inventory_ledger (id TEXT PRIMARY KEY, product_id TEXT, delta INTEGER, reason TEXT)',
      'CREATE TABLE sync_outbox (idempotency_key TEXT PRIMARY KEY, entity_type TEXT, payload_json TEXT, status TEXT)',
    ]);
    const run = async (n) => {
      // NOTE: this @libsql/client file build cannot hold an interactive
      // transaction across execute() calls (each call gets its own context —
      // the same multiplexing class as the pooled plugin; see
      // verify_atomic_cogs_materialization.mts:126). The batch below is one
      // implicit transaction with the identical statement SHAPE (1 version
      // read + header + 3 items + 3 ledger deltas + 1 outbox row), which is
      // also the shape the future single-call gateway will take.
      const t0 = performance.now();
      const id = `TXN-${n}`;
      const stmts = [
        { sql: 'SELECT version FROM transactions WHERE id = ?', args: [id] },
        {
          sql: 'INSERT INTO transactions (id, receipt_number, total, version, deleted) VALUES (?,?,?,?,0)',
          args: [id, `R-${n}`, 119.0, 1],
        },
      ];
      for (let i = 0; i < ITEMS; i++) {
        stmts.push({
          sql: 'INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price) VALUES (?,?,?,?,?)',
          args: [`${id}-I${i}`, id, `prod-${i}`, 2, 50.0],
        });
        stmts.push({
          sql: 'INSERT INTO inventory_ledger (id, product_id, delta, reason) VALUES (?,?,?,?)',
          args: [`${id}-L${i}`, `prod-${i}`, -2, 'SALE'],
        });
      }
      stmts.push({
        sql: 'INSERT INTO sync_outbox (idempotency_key, entity_type, payload_json, status) VALUES (?,?,?,?)',
        args: [`order-${id}`, 'order', '{"id":"x"}', 'pending'],
      });
      await db.batch(stmts);
      return performance.now() - t0;
    };
    for (let i = 0; i < WARMUP; i++) await run(`w${i}`);
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) samples.push(await run(`s${i}`));
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log('========================================================================');
    console.log('MOBIPOS — CHECKOUT SHAPE BASELINE (test-only, scratch file DB)');
    console.log('========================================================================');
    console.log(`  samples: ${SAMPLES} (warmup ${WARMUP} discarded), items per sale: ${ITEMS}`);
    console.log(`  mean: ${mean.toFixed(2)} ms, p50: ${p50.toFixed(2)} ms, p95: ${p95.toFixed(2)} ms`);
    console.log('  SCOPE: statement shape only — excludes IPC, Dexie, FIFO math, UI.');
    console.log('');
    console.log('REQUIRED PRODUCTION HOOKS (proposed, NOT added — audit-only rule):');
    console.log('  1. BENCH-gated performance.now() marks around writeCheckoutAtomicInner');
    console.log('     in src/db/sqlPluginAdapter.ts (env flag, default off, zero-cost when off).');
    console.log('  2. Same marks around the native db_select/db_execute IPC path once the');
    console.log('     gateway exists, to split IPC cost from storage cost.');
    console.log('  3. Proposed cap after real numbers: no p95 regression vs this baseline;');
    console.log('     single-call checkout is expected to beat it (N-1 fewer IPC trips).');
  } finally {
    try { db.close(); } catch { /* ignore */ }
    // Windows keeps file-DB handles briefly after close; retry removal.
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
        if (i === 9) console.warn(`[bench] scratch dir left behind: ${dir}`);
      }
    }
  }
}

main().catch((e) => {
  console.error('[bench] harness failure:', e?.message || e);
  process.exit(1);
});
