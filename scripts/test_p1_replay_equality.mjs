/**
 * MOBI POS — Phase P1 Replay-Equality & Shadow Event Log Verification Suite
 * Implements Authority ③ §20.2, Authority ③ §9 (P1 Gate), and AGENTS.md Contract C6
 *
 * Keystone Invariant: Live Projections Reduced by Interceptor == Projections Replayed from Event Log
 */

import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

import { initClock, recordShadowEvent } from '../src/sync/eventInterceptor.ts';
import { backfillExistingProducts, replayProjections } from '../src/sync/snapshotBackfill.ts';

console.log('========================================================================');
console.log('⚡ MOBI POS — PHASE P1: SHADOW EVENT LOG & REPLAY-EQUALITY SUITE');
console.log('========================================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passCount++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failCount++;
  }
}

const DB_FILE = path.resolve('test_p1_shadow.db');

// Ensure clean slate
if (fs.existsSync(DB_FILE)) {
  try { fs.unlinkSync(DB_FILE); } catch {}
}

const client = createClient({ url: `file:${DB_FILE}` });

const db = {
  async execute(sql, params = []) {
    return await client.execute({ sql, args: params });
  },
  async select(sql, params = []) {
    const res = await client.execute({ sql, args: params });
    return res.rows;
  },
};

async function run() {
  try {
    // ------------------------------------------------------------------------
    // Step 1: Initialize Migrations 100 & 101 Schema + Legacy Products Table
    // ------------------------------------------------------------------------
    console.log('[STEP 1] Setting up SQLite Schema (Migrations 100 & 101):');

    await db.execute(`
      CREATE TABLE IF NOT EXISTS event_log (
        event_id    TEXT PRIMARY KEY,
        aggregate   TEXT NOT NULL,
        hlc         TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        schema_v    INTEGER NOT NULL,
        event_type  TEXT NOT NULL,
        data_json   TEXT NOT NULL,
        synced_to_cloud INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
    `);
    await db.execute('CREATE INDEX IF NOT EXISTS ix_log_hlc ON event_log(hlc);');
    await db.execute('CREATE INDEX IF NOT EXISTS ix_log_agg ON event_log(aggregate, hlc);');
    await db.execute('CREATE INDEX IF NOT EXISTS ix_log_unsynced ON event_log(synced_to_cloud) WHERE synced_to_cloud = 0;');

    await db.execute(`
      CREATE TABLE IF NOT EXISTS projection_cursor (
        projection_name TEXT PRIMARY KEY,
        last_event_id   TEXT NOT NULL,
        last_hlc        TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key             TEXT PRIMARY KEY,
        value           TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS p_products (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        stock       INTEGER NOT NULL DEFAULT 0,
        deleted     INTEGER NOT NULL DEFAULT 0,
        row_hlc     TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS p_transactions (
        id          TEXT PRIMARY KEY,
        total_cents INTEGER NOT NULL,
        ts          TEXT NOT NULL,
        row_hlc     TEXT NOT NULL,
        device_id   TEXT NOT NULL
      );
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS p_transaction_items (
        tx_id       TEXT NOT NULL,
        product_id  TEXT NOT NULL,
        qty         INTEGER NOT NULL,
        unit_cents  INTEGER NOT NULL,
        PRIMARY KEY (tx_id, product_id)
      );
    `);
    await db.execute('CREATE INDEX IF NOT EXISTS ix_p_stock ON p_products(deleted, stock);');

    // Legacy table for backfill testing
    await db.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT,
        price REAL,
        stock INTEGER,
        deleted INTEGER DEFAULT 0
      );
    `);

    assert(true, 'Projections, event_log, and legacy schema initialized successfully');

    // ------------------------------------------------------------------------
    // Step 2: Shadow Event Interceptor Verification
    // ------------------------------------------------------------------------
    console.log('\n[STEP 2] Intercepting Domain Writes & Appending to Event Log:');
    initClock('till-desktop-1');

    // A. Product Created
    const e1 = await recordShadowEvent(
      db,
      {
        type: 'product_created',
        data: {
          id: 'prod-001',
          name: 'Chargeur Rapide 65W GaN',
          price_cents: 450000, // 4,500.00 DZD in minor units
          sku: 'CHG-65W-GAN',
        },
      },
      'product:prod-001',
      'till-desktop-1'
    );
    assert(e1 !== null, 'ProductCreated shadow event recorded');

    let prodRow = (await db.select('SELECT * FROM p_products WHERE id = ?', ['prod-001']))[0];
    assert(prodRow.name === 'Chargeur Rapide 65W GaN', 'Projection p_products name matches');
    assert(prodRow.price_cents === 450000, 'Projection p_products price_cents matches');
    assert(prodRow.stock === 0, 'Initial stock is 0');

    // B. Stock Received (+50)
    await recordShadowEvent(
      db,
      {
        type: 'stock_received',
        data: {
          product_id: 'prod-001',
          qty: 50,
          supplier: 'Fournisseur Anker',
        },
      },
      'product:prod-001',
      'till-desktop-1'
    );
    prodRow = (await db.select('SELECT stock FROM p_products WHERE id = ?', ['prod-001']))[0];
    assert(prodRow.stock === 50, 'Stock received increments stock (+50 -> 50)');

    // C. Product Renamed
    await recordShadowEvent(
      db,
      {
        type: 'product_renamed',
        data: {
          id: 'prod-001',
          new_name: 'Chargeur Ultra-Rapide 65W GaN Pro',
        },
      },
      'product:prod-001',
      'till-desktop-1'
    );
    prodRow = (await db.select('SELECT name FROM p_products WHERE id = ?', ['prod-001']))[0];
    assert(prodRow.name === 'Chargeur Ultra-Rapide 65W GaN Pro', 'Product rename reflected in projection');

    // D. Price Changed (450000 -> 420000)
    await recordShadowEvent(
      db,
      {
        type: 'price_changed',
        data: {
          id: 'prod-001',
          old_cents: 450000,
          new_cents: 420000,
        },
      },
      'product:prod-001',
      'till-desktop-1'
    );
    prodRow = (await db.select('SELECT price_cents FROM p_products WHERE id = ?', ['prod-001']))[0];
    assert(prodRow.price_cents === 420000, 'Price change reflected in projection');

    // E. Checkout Completed (Sell 2 units)
    await recordShadowEvent(
      db,
      {
        type: 'checkout_completed',
        data: {
          transaction_id: 'tx-test-01',
          lines: [
            {
              product_id: 'prod-001',
              qty: 2,
              unit_cents: 420000,
            },
          ],
          total_cents: 840000,
          payment: {
            method: 'cash',
            tendered_cents: 1000000,
            change_cents: 160000,
          },
        },
      },
      'tx:tx-test-01',
      'till-desktop-1'
    );
    await recordShadowEvent(
      db,
      {
        type: 'stock_sold',
        data: {
          product_id: 'prod-001',
          qty: 2,
          transaction_id: 'tx-test-01',
        },
      },
      'product:prod-001',
      'till-desktop-1'
    );

    const txRow = (await db.select('SELECT * FROM p_transactions WHERE id = ?', ['tx-test-01']))[0];
    assert(txRow.total_cents === 840000, 'Transaction total matches in projection');

    const itemRow = (await db.select('SELECT * FROM p_transaction_items WHERE tx_id = ?', ['tx-test-01']))[0];
    assert(itemRow.product_id === 'prod-001' && itemRow.qty === 2, 'Transaction item saved');

    prodRow = (await db.select('SELECT stock FROM p_products WHERE id = ?', ['prod-001']))[0];
    assert(prodRow.stock === 48, 'Stock sold decrements stock (50 - 2 -> 48)');

    // ------------------------------------------------------------------------
    // Step 3: Snapshot Backfill
    // ------------------------------------------------------------------------
    console.log('\n[STEP 3] Snapshot Backfill from Legacy Catalog:');
    await db.execute(`
      INSERT INTO products (id, name, price, stock, deleted)
      VALUES
        ('legacy-01', 'Câble USB-C 1m', 1500, 100, 0),
        ('legacy-02', 'Écouteurs TWS Bluetooth', 3200, 25, 0);
    `);

    const backfilled = await backfillExistingProducts(db, 'till-desktop-1');
    assert(backfilled === 2, `Backfilled 2 legacy products into shadow log (got ${backfilled})`);

    const pLegacy1 = (await db.select('SELECT * FROM p_products WHERE id = ?', ['legacy-01']))[0];
    assert(pLegacy1 && pLegacy1.stock === 100, 'Backfilled product stock matches legacy truth');
    assert(pLegacy1 && pLegacy1.price_cents === 150000, 'Backfilled product price matches in minor units');

    // Idempotency check: running backfill again does nothing
    const backfilledSecond = await backfillExistingProducts(db, 'till-desktop-1');
    assert(backfilledSecond === 0, 'Backfill is strictly idempotent (second run backfills 0)');

    // ------------------------------------------------------------------------
    // Step 4: Replay-Equality Proof (The Keystone Gate)
    // ------------------------------------------------------------------------
    console.log('\n[STEP 4] Replay-Equality Invariant (Replay Log vs Live Projections):');

    // 1. Snapshot live projections
    const liveProducts = await db.select('SELECT id, name, price_cents, stock, deleted FROM p_products ORDER BY id ASC;');
    const liveTransactions = await db.select('SELECT id, total_cents FROM p_transactions ORDER BY id ASC;');
    const liveItems = await db.select('SELECT tx_id, product_id, qty, unit_cents FROM p_transaction_items ORDER BY tx_id, product_id ASC;');

    const totalEventsInLog = (await db.select('SELECT COUNT(*) as c FROM event_log;'))[0].c;
    console.log(`  [INFO] Total events recorded in event_log: ${totalEventsInLog}`);

    // 2. Wipe projections and replay from event_log
    const replayedEvents = await replayProjections(db);
    assert(replayedEvents === totalEventsInLog, `Replay executed all ${totalEventsInLog} events`);

    // 3. Snapshot replayed projections
    const replayedProducts = await db.select('SELECT id, name, price_cents, stock, deleted FROM p_products ORDER BY id ASC;');
    const replayedTransactions = await db.select('SELECT id, total_cents FROM p_transactions ORDER BY id ASC;');
    const replayedItems = await db.select('SELECT tx_id, product_id, qty, unit_cents FROM p_transaction_items ORDER BY tx_id, product_id ASC;');

    // 4. Assert 100% Byte/Field Parity
    assert(
      JSON.stringify(liveProducts) === JSON.stringify(replayedProducts),
      'KEYSTONE INVARIANT: Live p_products == Replayed p_products (100% equality)'
    );
    assert(
      JSON.stringify(liveTransactions) === JSON.stringify(replayedTransactions),
      'KEYSTONE INVARIANT: Live p_transactions == Replayed p_transactions (100% equality)'
    );
    assert(
      JSON.stringify(liveItems) === JSON.stringify(replayedItems),
      'KEYSTONE INVARIANT: Live p_transaction_items == Replayed p_transaction_items (100% equality)'
    );

    // ------------------------------------------------------------------------
    // Results Summary
    // ------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log(`PHASE P1 REPLAY-EQUALITY RESULTS: ${passCount} Passed, ${failCount} Failed`);
    console.log('========================================================================\n');

    client.close();
    if (fs.existsSync(DB_FILE)) {
      try { fs.unlinkSync(DB_FILE); } catch {}
    }

    if (failCount > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('\n❌ Unhandled error in P1 verification:', err);
    client.close();
    if (fs.existsSync(DB_FILE)) {
      try { fs.unlinkSync(DB_FILE); } catch {}
    }
    process.exit(1);
  }
}

run();

