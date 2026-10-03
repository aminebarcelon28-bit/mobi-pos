/**
 * One-shot reconciliation for the trade-in double-count (stock=2) bug.
 * For each affected intake product: guard that its ledger is EXACTLY
 * [ADJUST/manual +1 (ref = product id)] + [RECEIVE/TRADE_IN +1] with no
 * SALE/REFUND/VOID rows and batch qty 1; then tombstone the spurious ADJUST
 * (deleted=1, sync-visible, reversible) and set products.stock = 1.
 * Resold units (with SALE rows) are skipped — their books already balance.
 * Run: node scripts/reconcile-trade-stock.mjs [--apply]
 * Default is DRY RUN. --apply writes inside one IMMEDIATE transaction.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(process.env.APPDATA || '', 'com.mobi.pos', 'mobi_pos.db');
const APPLY = process.argv.includes('--apply');

const db = new DatabaseSync(DB); // read-write (dry run never writes)
const all = (sql, p = []) => db.prepare(sql).all(...p);

const candidates = all(`
  SELECT p.id, p.title, p.stock,
         (SELECT COUNT(*) FROM inventory_ledger l WHERE l.product_id = p.id AND COALESCE(l.deleted,0)=0) AS live_rows
  FROM products p
  WHERE p.category LIKE '%Reprise%' AND p.stock = 2`);
console.log(`candidates (stock=2, OCC): ${candidates.length}`);

const plan = [];
for (const c of candidates) {
  const rows = all(`SELECT id, delta, reason, ref_type, ref_id FROM inventory_ledger WHERE product_id = ? AND COALESCE(deleted,0)=0 ORDER BY created_at`, [c.id]);
  const ok =
    rows.length === 2 &&
    rows.some((r) => r.reason === 'ADJUST' && r.ref_type === 'manual' && r.ref_id === c.id && Number(r.delta) === 1) &&
    rows.some((r) => r.reason === 'RECEIVE' && r.ref_type === 'TRADE_IN' && Number(r.delta) === 1) &&
    !rows.some((r) => ['SALE', 'REFUND', 'VOID'].includes(r.reason));
  const batch = all(`SELECT quantity_remaining FROM stock_batches WHERE product_id = ? AND COALESCE(deleted,0)=0`, [c.id]);
  const batchOk = batch.length === 1 && Number(batch[0].quantity_remaining) === 1;
  console.log(`${ok && batchOk ? 'FIX ' : 'SKIP '} ${c.id} rows=${rows.length} batch=${JSON.stringify(batch)} :: ${String(c.title).slice(0, 44)}`);
  if (ok && batchOk) {
    plan.push({ productId: c.id, adjustId: rows.find((r) => r.reason === 'ADJUST').id });
  }
}

/**
 * Phase 2 — Dexie invalidation. The boot mirror (backfill.ts remirrorToDexie,
 * called every launch from App.tsx) is a BLIND full bulkPut gated by the
 * one-shot app_settings flag `sync.remirror_v3` — it compares NO watermark,
 * so an updated_at bump alone changes nothing. Forcing the re-pull means:
 *   1. stamp products.updated_at (ISO UTC, matches existing rows) — marks
 *      the rows touched for any present/future watermark reader, and
 *   2. DELETE the sync.remirror_v3 flag — next boot re-runs the FULL product
 *      mirror (bulkPut from SQLite truth) + refreshAfterPull() into the UI.
 * Targets: products reconciled by THIS fix = Reprise rows carrying a
 * tombstoned (deleted=1) ADJUST/manual ledger row. Idempotent.
 */
function dexieInvalidationTargets() {
  return all(`
    SELECT DISTINCT p.id, p.title, p.stock, p.updated_at
    FROM products p
    JOIN inventory_ledger l ON l.product_id = p.id
    WHERE p.category LIKE '%Reprise%'
      AND l.reason = 'ADJUST' AND l.ref_type = 'manual'
      AND COALESCE(l.deleted, 0) = 1`);
}

const stampTargets = dexieInvalidationTargets();
console.log(`dexie-invalidation targets (tombstoned ADJUST rows): ${stampTargets.length}`);
for (const t of stampTargets) {
  console.log(`  STAMP ${t.id} :: ${String(t.title).slice(0, 44)}`);
}

if (!APPLY) {
  console.log(`DRY RUN — ${plan.length} rows would be reconciled, ${stampTargets.length} stamped + remirror flag reset. Re-run with --apply.`);
  process.exit(0);
}
const needsWork = plan.length > 0 || stampTargets.length > 0;
if (!needsWork) { console.log('Nothing to reconcile or stamp.'); process.exit(0); }

// File-level backup first (db + wal + shm, crash-consistent set).
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bdir = path.join(process.env.APPDATA || '', 'com.mobi.pos', 'backups');
for (const suffix of ['', '-wal', '-shm']) {
  const src = DB + suffix;
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(bdir, `mobi_pos_pretradefix_${stamp}.db${suffix}`));
}
console.log(`backup written: mobi_pos_pretradefix_${stamp}.db[,-wal,-shm]`);

db.exec('BEGIN IMMEDIATE');
try {
  for (const p of plan) {
    db.prepare(`UPDATE inventory_ledger SET deleted = 1 WHERE id = ?`).run(p.adjustId);
    db.prepare(`UPDATE products SET stock = 1 WHERE id = ?`).run(p.productId);
  }
  if (plan.length > 0) console.log(`RECONCILED ${plan.length} products (ADJUST tombstoned, stock=1).`);
  // Dexie invalidation: stamp updated_at (ISO UTC, matches existing rows)
  // and reset the one-shot remirror flag so the next boot re-pulls the full
  // SQLite product truth into Dexie (+ refreshAfterPull into the UI).
  // CRITICAL second half: the remirror merges `{...rowEssentials, ...json}`,
  // so a stale json_payload blob (stock:2 from the buggy era) would CLOBBER
  // the fixed row. Repair the blob's stock to 1 as well.
  const nowIso = new Date().toISOString();
  let stamped = 0;
  let blobsFixed = 0;
  for (const t of stampTargets) {
    const r = db.prepare(`UPDATE products SET updated_at = ? WHERE id = ?`).run(nowIso, t.id);
    stamped += Number(r.changes || 0);
    const row = db.prepare(`SELECT json_payload FROM products WHERE id = ?`).get(t.id);
    try {
      const blob = JSON.parse(String(row?.json_payload ?? '{}'));
      if (Number(blob.stock) !== 1) {
        blob.stock = 1;
        db.prepare(`UPDATE products SET json_payload = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(blob), nowIso, t.id);
        blobsFixed += 1;
      }
    } catch (e) {
      console.warn(`blob parse skipped for ${t.id}: ${e.message}`);
    }
  }
  console.log(`BLOBS repaired (json stock→1): ${blobsFixed}.`);
  const flag = db.prepare(`DELETE FROM app_settings WHERE key = 'sync.remirror_v3'`).run();
  console.log(`STAMPED ${stamped} products updated_at=${nowIso}; remirror flag reset (${flag.changes} row(s) deleted).`);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('ROLLBACK:', e.message);
  process.exit(1);
}
// Verify.
for (const p of plan) {
  const s = db.prepare(`SELECT stock FROM products WHERE id = ?`).get(p.productId);
  const sum = db.prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM inventory_ledger WHERE product_id = ? AND COALESCE(deleted,0)=0`).get(p.productId);
  console.log(`verify ${p.productId.slice(0, 18)}… stock=${s.stock} ledger_sum=${sum.s} ${s.stock === 1 && sum.s === 1 ? 'OK' : 'MISMATCH'}`);
}
