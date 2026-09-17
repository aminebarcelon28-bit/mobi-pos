/**
 * MOBI POS — Full ES-LFP Lifecycle & Integration Test Suite
 * Validates Phases P2 through P7 End-to-End:
 * - P2 Domain Commands
 * - P3 Projection Direct-Reads
 * - P4 Multi-Device Event Replication & Causal Convergence
 * - P5 Cloud Cutover
 * - P7 Point-in-Time Time Travel & Disaster Rebuild
 */

import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

import {
  adjustStock,
  receiveStock,
  upsertProduct,
  renameProduct,
  checkout,
  deleteProduct,
} from '../src/domain/commands.ts';
import { pushEventBatch, pullRemoteEventBatch } from '../src/sync/eventSyncEngine.ts';
import { ensureCloudEventLogSchema } from '../src/sync/cloudCutover.ts';
import { queryStateAtHlc, rebuildFromEventLog } from '../src/domain/timeTravel.ts';
import { initClock } from '../src/sync/eventInterceptor.ts';

console.log('========================================================================');
console.log('⚡ MOBI POS — FULL ES-LFP LIFECYCLE & INTEGRATION SUITE (P2 - P7)');
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

const DEV_A_DB = path.resolve('test_dev_a.db');
const DEV_B_DB = path.resolve('test_dev_b.db');
const CLOUD_DB = path.resolve('test_cloud.db');

// Cleanup any leftovers
for (const f of [DEV_A_DB, DEV_B_DB, CLOUD_DB]) {
  if (fs.existsSync(f)) {
    try { fs.unlinkSync(f); } catch {}
  }
}

function makeDb(client) {
  return {
    async execute(sql, params = []) {
      return await client.execute({ sql, args: params });
    },
    async select(sql, params = []) {
      const res = await client.execute({ sql, args: params });
      return res.rows;
    },
  };
}

async function initSchema(db) {
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
}

async function run() {
  const clientA = createClient({ url: `file:${DEV_A_DB}` });
  const clientB = createClient({ url: `file:${DEV_B_DB}` });
  const clientCloud = createClient({ url: `file:${CLOUD_DB}` });

  const dbA = makeDb(clientA);
  const dbB = makeDb(clientB);

  try {
    console.log('[1. SETUP] Initializing SQLite nodes & Turso Cloud mock...');
    await initSchema(dbA);
    await initSchema(dbB);
    await ensureCloudEventLogSchema(clientCloud);
    assert(true, 'Device A, Device B, and Cloud initialized');

    // ------------------------------------------------------------------------
    // PHASE P2: Domain Commands on Device A
    // ------------------------------------------------------------------------
    console.log('\n[2. PHASE P2] Executing Domain Commands on Device A:');
    initClock('desktop-till-1');

    // Upsert product
    const upRes = await upsertProduct(
      dbA,
      {
        id: 'prod-gan-100',
        name: 'Chargeur GaN 100W',
        priceCents: 650000,
        sku: 'GAN-100W',
        initialStock: 10,
      },
      'desktop-till-1'
    );
    assert(upRes.success, 'Command upsertProduct succeeded');

    // Receive stock (+20)
    const recRes = await receiveStock(
      dbA,
      { productId: 'prod-gan-100', qty: 20, supplier: 'Anker Direct' },
      'desktop-till-1'
    );
    assert(recRes.success && recRes.data?.newStock === 30, 'Command receiveStock updated stock to 30');

    // Rename product
    const renRes = await renameProduct(
      dbA,
      { id: 'prod-gan-100', newName: 'Chargeur GaN 100W Dual Pro' },
      'desktop-till-1'
    );
    assert(renRes.success, 'Command renameProduct succeeded');

    // Intermediate checkpoint HLC for Time-Travel testing
    const intermediateHlcRows = await dbA.select('SELECT MAX(hlc) as m FROM event_log;');
    const checkpointHlc = intermediateHlcRows[0].m;

    // Checkout (Sell 4 units)
    const coRes = await checkout(
      dbA,
      {
        transactionId: 'tx-gan-sale-1',
        lines: [{ product_id: 'prod-gan-100', qty: 4, unit_cents: 650000 }],
        payment: { method: 'cash', tendered_cents: 3000000, change_cents: 400000 },
      },
      'desktop-till-1'
    );
    assert(coRes.success && coRes.data?.totalCents === 2600000, 'Command checkout completed (total: 2,600,000 cents)');

    const prodA = (await dbA.select('SELECT * FROM p_products WHERE id = ?', ['prod-gan-100']))[0];
    assert(prodA.stock === 26, `Stock decremented accurately from 30 to 26 (got ${prodA.stock})`);

    // ------------------------------------------------------------------------
    // PHASE P4: Multi-Device Event Replication
    // ------------------------------------------------------------------------
    console.log('\n[3. PHASE P4] Pushing Events from Device A to Cloud:');
    const pushedCount = await pushEventBatch(dbA, clientCloud);
    assert(pushedCount >= 4, `Device A pushed ${pushedCount} events to Cloud`);

    const cloudEvents = await clientCloud.execute('SELECT COUNT(*) as c FROM event_log;');
    assert(Number(cloudEvents.rows[0].c) === pushedCount, 'Cloud event_log holds exact pushed count');

    console.log('\n[4. PHASE P4] Pulling Events from Cloud to Device B (Mobile Companion):');
    initClock('phone-companion-1');
    const pulledCount = await pullRemoteEventBatch(dbB, clientCloud, 'phone-companion-1');
    assert(pulledCount === pushedCount, `Device B pulled all ${pulledCount} events from Cloud`);

    // Convergence verification on Device B
    const prodB = (await dbB.select('SELECT * FROM p_products WHERE id = ?', ['prod-gan-100']))[0];
    assert(prodB && prodB.name === 'Chargeur GaN 100W Dual Pro', 'Device B converged to renamed product name');
    assert(prodB && prodB.stock === 26, 'Device B converged to identical stock (26)');

    const txB = (await dbB.select('SELECT * FROM p_transactions WHERE id = ?', ['tx-gan-sale-1']))[0];
    assert(txB && txB.total_cents === 2600000, 'Device B holds synchronized transaction');

    // ------------------------------------------------------------------------
    // PHASE P7: Point-in-Time Time Travel & Disaster Rebuild
    // ------------------------------------------------------------------------
    console.log('\n[5. PHASE P7] Time-Travel Query (State Before Checkout):');
    const historicalProducts = await queryStateAtHlc(dbA, checkpointHlc);
    const historicalGan = historicalProducts.get('prod-gan-100');
    assert(
      historicalGan && historicalGan.stock === 30,
      `Time travel query accurately reconstructs pre-checkout stock: 30 (got ${historicalGan?.stock})`
    );

    console.log('\n[6. PHASE P7] Disaster Recovery Rebuild on Device B:');
    const rebuildRes = await rebuildFromEventLog(dbB);
    assert(rebuildRes.replayedCount === pulledCount, `Rebuild replayed all ${pulledCount} events`);

    const rebuiltProdB = (await dbB.select('SELECT stock FROM p_products WHERE id = ?', ['prod-gan-100']))[0];
    assert(rebuiltProdB.stock === 26, 'Post-rebuild projection stock matches perfectly: 26');

    // ------------------------------------------------------------------------
    // Summary
    // ------------------------------------------------------------------------
    console.log('\n========================================================================');
    console.log(`FULL ES-LFP LIFECYCLE RESULTS: ${passCount} Passed, ${failCount} Failed`);
    console.log('========================================================================\n');

    clientA.close();
    clientB.close();
    clientCloud.close();

    for (const f of [DEV_A_DB, DEV_B_DB, CLOUD_DB]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }

    if (failCount > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('\n❌ Unhandled error in lifecycle test:', err);
    clientA.close();
    clientB.close();
    clientCloud.close();
    for (const f of [DEV_A_DB, DEV_B_DB, CLOUD_DB]) {
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
    process.exit(1);
  }
}

run();

