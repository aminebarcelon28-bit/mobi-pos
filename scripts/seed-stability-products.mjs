// Stability-test seeder: bulk-inserts N realistic products + outbox rows.
// Usage:
//   node scripts/seed-stability-products.mjs [--count 1000] [--remove] [--repair]
//
// Modes:
//   seed (default)  Insert N products (device_id='stability-test',
//                   deterministic ids prod-test-0001..N) + one pending outbox
//                   UPSERT each, then clear the sync.remirror_v2 flag so the
//                   NEXT app boot mirrors the rows into the Dexie UI mirror.
//   --remove        Delete seeded products (+FTS via delete trigger + their
//                   outbox rows). NOTE: Dexie UI ghosts remain (browser
//                   IndexedDB is unreachable from here) — clear site data
//                   after --remove for a pristine UI.
//   --repair        Re-write ALL product columns + FULL outbox payloads for
//                   existing seeded rows (recovery from thin-payload
//                   round-trip blanking), bumped to version 2 so push/pull
//                   converge on the repaired values.
//
// Payload contract (learned 2026-09-23): the push lane serializes the OUTBOX
// payload_json to the remote row and the pull lane overwrites local columns
// from it field-by-field (`payload.sku ?? ''`, ...). A MINIMAL payload
// round-trips as data loss (remote + local sku/barcode/category blanked).
// Payloads here therefore carry the FULL canonical product shape.
//
// Safety:
//   - Backs up mobi_pos.db (+WAL) before every write mode.
//   - Refuses to seed twice (aborts if stability-test rows exist).
//   - PRAGMA busy_timeout=15000; the whole write is one short transaction.
//   - Untouched: ledger (the checkout guard lazily materializes an idempotent
//     SEED baseline from products.stock on the first tracked sale, so leaving
//     the ledger empty is safe — do NOT hand-write baselines here).
//     transactions, customers, settings (except the remirror flag reset).
//   - First sync after seeding pushes ~N product UPSERTs to Turso (quota/time).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const APP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'com.mobi.pos');
const DB_PATH = path.join(APP_DIR, 'mobi_pos.db');
const DEVICE_TAG = 'stability-test';
const VENDOR = 'Fournisseur Général';

const args = process.argv.slice(2);
const removing = args.includes('--remove');
const repairing = args.includes('--repair');
let countRaw = '';
const eqArg = args.find((a) => a.startsWith('--count='));
if (eqArg) {
  countRaw = eqArg.split('=')[1] || '';
} else {
  const spIdx = args.indexOf('--count');
  if (spIdx >= 0 && spIdx + 1 < args.length) countRaw = args[spIdx + 1];
}
const COUNT = Math.max(1, Math.min(5000, Number(countRaw) || 1000));

// Deterministic PRNG (same catalog every run).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Valid EAN-13 (Algeria GS1 prefix 613 + sequential + check digit).
function ean13(seq) {
  const base = '613' + String(seq).padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  return base + String((10 - (sum % 10)) % 10);
}

const BRANDS = ['Apple', 'Samsung', 'Anker', 'Belkin', 'JBL', 'Xiaomi', 'Huawei', 'Oraimo', 'LDNIO', 'Baseus', 'Remax', 'Hoco'];
const LINES = [
  ['Coque Silicone', 1200, 3500], ['Coque Transparente', 900, 2800], ['Verre Trempé 9H', 500, 1800],
  ['Chargeur Rapide 25W', 1800, 4500], ['Chargeur GaN 65W', 3500, 8500], ['Câble USB-C Tressé 2m', 700, 2200],
  ['Câble Lightning 1m', 800, 2500], ['Écouteurs Bluetooth', 2500, 7500], ['Kit Piéton Jack', 400, 1200],
  ['Batterie Externe 10000mAh', 2800, 6500], ['Batterie Externe 20000mAh', 3500, 8500], ['Support Téléphone Voiture', 900, 2600],
  ['Adaptateur Secteur 20W', 1500, 4200], ['Hub USB-C 6-en-1', 4000, 9800], ['Souris Sans Fil', 1500, 3900],
  ['Clavier Bluetooth', 2800, 6900], ['Enceinte Portable', 3200, 7900], ['Montre Connectée', 5500, 12900],
  ['Coque Cuir Premium', 2200, 5900], ['Film Hydrogel', 300, 900],
];
const MODELS = ['Pro Max', 'Ultra', 'Lite', 'Plus', 'SE', 'Air', 'Max', 'Mini', 'X9', 'Note 13', 'A54', 'S24'];
const CATS = ['Coques', 'Chargeurs', 'Câbles', 'Écouteurs', 'Verre trempé', 'Batteries', 'Accessoires'];

function buildCatalog(n, rand) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const brand = BRANDS[Math.floor(rand() * BRANDS.length)];
    const [kind, lo, hi] = LINES[Math.floor(rand() * LINES.length)];
    const model = MODELS[Math.floor(rand() * MODELS.length)];
    const price = lo + Math.floor(rand() * (hi - lo + 1));
    const cost = Math.round(price * (0.55 + rand() * 0.2));
    const stock = rand() < 0.05 ? 0 : 1 + Math.floor(rand() * 60);
    const id = `prod-test-${String(i).padStart(4, '0')}`;
    const title = `${kind} ${brand} ${model} #${i}`;
    rows.push({
      id,
      sku: `TST-${brand.slice(0, 3).toUpperCase()}-${String(i).padStart(4, '0')}`,
      barcode: ean13(i),
      title,
      brand,
      category: CATS[Math.floor(rand() * CATS.length)],
      price, cost, stock,
      key: `seed-${id}`,
    });
  }
  return rows;
}

// FULL canonical payload — every key the push/pull lanes consume.
function fullPayload(r, createdAt, now, version) {
  return JSON.stringify({
    id: r.id, sku: r.sku, barcode: r.barcode, title: r.title, brand: r.brand,
    compatible_model: '', category: r.category, price: r.price,
    wholesale_price: r.price, cost_price: r.cost, stock: r.stock,
    image_url: null, is_serialized: 0, imei_number: null,
    vendor_name: VENDOR, lead_time_days: 7,
    daily_sales_velocity: 0, reorder_point: 5,
    device_id: DEVICE_TAG, idempotency_key: r.key, version,
    created_at: createdAt, updated_at: now, deleted: 0,
  });
}

function backup(tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakDir = path.join(APP_DIR, 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const bakPath = path.join(bakDir, `${tag}-${stamp}.db`);
  fs.copyFileSync(DB_PATH, bakPath);
  try { fs.copyFileSync(DB_PATH + '-wal', bakPath + '-wal'); } catch { /* no WAL */ }
  console.log('Backup: ' + bakPath);
}

function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error('DB not found: ' + DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec('PRAGMA busy_timeout = 15000');
    const existing = db.prepare('SELECT COUNT(*) n FROM products WHERE device_id = ?').get(DEVICE_TAG).n;

    if (removing) {
      if (existing === 0) { console.log('Nothing to remove (no stability-test rows).'); return; }
      backup('pre-seed-remove');
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = db.prepare("DELETE FROM sync_outbox WHERE entity_type = 'product' AND entity_id LIKE 'prod-test-%'").run();
        const del = db.prepare('DELETE FROM products WHERE device_id = ?').run(DEVICE_TAG);
        db.exec('COMMIT');
        console.log(`Removed ${del.changes} products (+FTS via trigger) and ${out.changes} outbox rows.`);
        console.log('NOTE: Dexie UI ghosts remain until site data is cleared; restart the app.');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return;
    }

    if (repairing) {
      if (existing === 0) throw new Error('Nothing to repair (no stability-test rows). Seed first.');
      backup('pre-seed-repair');
      const rand = mulberry32(42);
      const rows = buildCatalog(existing, rand);
      const created = new Map(
        db.prepare('SELECT id, created_at FROM products WHERE device_id = ?').all(DEVICE_TAG)
          .map((r) => [r.id, r.created_at])
      );
      const now = new Date().toISOString();
      const t0 = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const upd = db.prepare(`UPDATE products SET sku=?, barcode=?, title=?, brand=?,
          compatible_model='', category=?, price=?, wholesale_price=?, cost_price=?, stock=?,
          image_url=NULL, is_serialized=0, imei_number=NULL, vendor_name=?, lead_time_days=7,
          daily_sales_velocity=0, reorder_point=5, json_payload=?, device_id=?, version=2,
          updated_at=?, deleted=0 WHERE id=?`);
        const upO = db.prepare(`INSERT INTO sync_outbox
          (idempotency_key, entity_type, entity_id, operation, payload_json, status)
          VALUES (?, 'product', ?, 'UPSERT', ?, 'pending')
          ON CONFLICT(idempotency_key) DO UPDATE SET operation='UPSERT',
            payload_json=excluded.payload_json, status='pending', retry_count=0,
            next_retry_at=NULL, last_error=NULL, updated_at=?`);
        for (const r of rows) {
          const payload = fullPayload(r, created.get(r.id) || now, now, 2);
          // 14 placeholders: sku, barcode, title, brand, category, price,
          // wholesale, cost, stock, vendor, payload, device, updated_at, id.
          // node:sqlite NULL-fills a missing trailing binding (WHERE id=NULL
          // = silent no-op), so arg count is asserted, not assumed.
          const runArgs = [r.sku, r.barcode, r.title, r.brand, r.category, r.price, r.price,
            r.cost, r.stock, VENDOR, payload, DEVICE_TAG, now, r.id];
          if (runArgs.length !== 14) throw new Error(`binding drift: ${runArgs.length}/14`);
          const res = upd.run(...runArgs);
          if (res.changes !== 1) throw new Error(`repair missed ${r.id}`);
          upO.run(r.key, r.id, payload, now);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      console.log(`Repaired ${rows.length} rows (v2, full payloads) in ${Date.now() - t0}ms.`);
      console.log('Next sync pushes v2 (overwrites thin remote rows); pull converges back.');
      return;
    }

    if (existing > 0) throw new Error(`Already seeded (${existing} stability-test rows). Run with --remove first.`);
    const rand = mulberry32(42);
    const rows = buildCatalog(COUNT, rand);
    const now = new Date().toISOString();
    backup('pre-seed');

    const t0 = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const insP = db.prepare(`INSERT INTO products
        (id, sku, barcode, title, brand, compatible_model, category, price, wholesale_price, cost_price,
         stock, image_url, is_serialized, imei_number, vendor_name, lead_time_days, daily_sales_velocity,
         reorder_point, json_payload, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, NULL, 0, NULL, ?, 7, 0, 5, ?, ?, ?, 'pending', ?, ?, 0, 1)`);
      const insO = db.prepare(`INSERT INTO sync_outbox
        (idempotency_key, entity_type, entity_id, operation, payload_json, status)
        VALUES (?, 'product', ?, 'UPSERT', ?, 'pending')`);
      for (const r of rows) {
        const payload = fullPayload(r, now, now, 1);
        // 16 placeholders (see INSERT above); node:sqlite NULL-fills a missing
        // trailing binding into a silent no-op, so assert the count + change.
        const insArgs = [r.id, r.sku, r.barcode, r.title, r.brand, r.category, r.price,
          r.price, r.cost, r.stock, VENDOR, payload, DEVICE_TAG, r.key, now, now];
        if (insArgs.length !== 16) throw new Error(`binding drift: ${insArgs.length}/16`);
        const res = insP.run(...insArgs);
        if (res.changes !== 1) throw new Error(`seed missed ${r.id}`);
        insO.run(r.key, r.id, payload);
      }
      // Force next boot to mirror SQLite -> Dexie (flag-gated, runs once per era).
      db.prepare("DELETE FROM app_settings WHERE key IN ('sync.remirror_v2', 'sync.remirror_v3')").run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    const fts = db.prepare("SELECT COUNT(*) n FROM products_fts WHERE id LIKE 'prod-test-%'").get().n;
    const out = db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE entity_id LIKE 'prod-test-%'").get().n;
    console.log(`Seeded ${COUNT} products in ${Date.now() - t0}ms (FTS rows: ${fts}, outbox rows: ${out}).`);
    console.log('Next steps: restart the app (boot remirror brings them into the catalog).');
    console.log(`First sync will push ~${COUNT} product UPSERTs to Turso (quota/time).`);
  } finally {
    db.close();
  }
}

main();
