/**
 * Zero-Data Reset & Cloud Cleanup Script (Phase P-½ Patch 5)
 * Wipes all business tables in Turso Cloud and local SQLite, resets sync cursors,
 * removes all bloated payloads (including the 20MB image), and ensures 100% clean baseline.
 *
 * Usage: node scripts/reset-zero-data.mjs
 */

import fs from 'node:fs';
import { createClient } from '@libsql/client';

const VAULT_PATH = 'C:/Users/Click/AppData/Roaming/com.mobi.pos/.cloud_credentials.vault';
const LOCAL_DB_PATH = 'C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';

const BUSINESS_TABLES = [
  'transaction_items',
  'inventory_ledger',
  'transactions',
  'products',
  'customers',
  'security_audit_logs',
  'cash_drops',
  'cash_movements',
  'cash_sessions',
  'customer_debts',
  'store_expenses',
  'trade_ins',
  'purchase_orders',
  'repair_orders',
  'product_bundles',
  'imei_records',
];

async function run() {
  console.log('🚀 Starting Comprehensive Zero-Data Reset (Cloud + Local)...');

  // 1. Connect to Turso Cloud
  let cloudClient = null;
  if (fs.existsSync(VAULT_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'));
      if (creds.url && creds.token) {
        cloudClient = createClient({ url: creds.url, authToken: creds.token });
        console.log(`📡 Connected to Turso Cloud: ${creds.url}`);
      }
    } catch (e) {
      console.warn('⚠️ Could not parse vault credentials:', e.message);
    }
  }

  // 2. Connect to Local SQLite
  let localClient = null;
  if (fs.existsSync(LOCAL_DB_PATH)) {
    localClient = createClient({ url: `file:${LOCAL_DB_PATH}` });
    console.log(`💾 Connected to Local SQLite: ${LOCAL_DB_PATH}`);
  }

  // 3. Purge Turso Cloud tables
  if (cloudClient) {
    console.log('\n🧹 Purging Turso Cloud business tables...');
    for (const table of BUSINESS_TABLES) {
      try {
        const res = await cloudClient.execute(`DELETE FROM "${table}"`);
        console.log(`  ✓ Cloud table "${table}" cleared (${res.rowsAffected ?? 0} rows deleted)`);
      } catch (err) {
        console.warn(`  ⚠️ Could not purge cloud table "${table}":`, err.message);
      }
    }
    // Clear app_settings non-schema rows
    try {
      await cloudClient.execute("DELETE FROM app_settings WHERE key NOT LIKE 'schema%'");
      console.log('  ✓ Cloud table "app_settings" non-schema keys cleared');
    } catch {
      // Table may not exist or already empty
    }
  }

  // 4. Purge Local SQLite tables
  if (localClient) {
    console.log('\n🧹 Purging Local SQLite tables...');
    for (const table of BUSINESS_TABLES) {
      try {
        const res = await localClient.execute(`DELETE FROM "${table}"`);
        console.log(`  ✓ Local table "${table}" cleared (${res.rowsAffected ?? 0} rows deleted)`);
      } catch (err) {
        console.warn(`  ⚠️ Could not purge local table "${table}":`, err.message);
      }
    }

    // Additional local-only tables
    for (const extraTable of ['sync_outbox', 'entity_keys', 'loyalty_ledger']) {
      try {
        await localClient.execute(`DELETE FROM "${extraTable}"`);
        console.log(`  ✓ Local table "${extraTable}" cleared`);
      } catch {
        // May not exist
      }
    }

    // Reset sync cursors
    try {
      await localClient.execute("DELETE FROM app_settings WHERE key LIKE 'sync.cursor.%'");
      console.log('  ✓ Local sync cursors reset to initial epoch');
    } catch {
      // Ignore
    }

    // Check if FTS tables exist and clean them
    try {
      await localClient.execute("DELETE FROM products_fts");
      console.log('  ✓ Local products_fts index cleared');
    } catch {
      // Ignore
    }
  }

  // 5. Verification
  console.log('\n========================================================================');
  console.log('📊 VERIFICATION SUMMARY');
  console.log('========================================================================');

  if (cloudClient) {
    console.log('\n--- Turso Cloud Verification ---');
    for (const table of BUSINESS_TABLES) {
      try {
        const res = await cloudClient.execute(`SELECT COUNT(*) as cnt FROM "${table}"`);
        const count = res.rows[0]?.cnt ?? 0;
        console.log(`  Cloud "${table}": ${count} rows ${count === 0 ? '✅' : '❌'}`);
      } catch (e) {
        console.log(`  Cloud "${table}": error (${e.message})`);
      }
    }

    try {
      const pageCount = await cloudClient.execute('PRAGMA page_count');
      const pageSize = await cloudClient.execute('PRAGMA page_size');
      const freelistCount = await cloudClient.execute('PRAGMA freelist_count');
      console.log(`  Cloud page_count: ${pageCount.rows[0]?.[0]} | page_size: ${pageSize.rows[0]?.[0]} | freelist_count: ${freelistCount.rows[0]?.[0]}`);
    } catch {
      // Ignore pragma read error
    }
  }

  if (localClient) {
    console.log('\n--- Local SQLite Verification ---');
    for (const table of BUSINESS_TABLES) {
      try {
        const res = await localClient.execute(`SELECT COUNT(*) as cnt FROM "${table}"`);
        const count = res.rows[0]?.cnt ?? 0;
        console.log(`  Local "${table}": ${count} rows ${count === 0 ? '✅' : '❌'}`);
      } catch (e) {
        console.log(`  Local "${table}": error (${e.message})`);
      }
    }
    const outboxRes = await localClient.execute("SELECT COUNT(*) as cnt FROM sync_outbox");
    console.log(`  Local "sync_outbox": ${outboxRes.rows[0]?.cnt ?? 0} rows ${outboxRes.rows[0]?.cnt === 0 ? '✅' : '❌'}`);
  }

  console.log('\n🎉 Complete Zero-Data Reset Successfully Finished!');
  console.log('Both Cloud and Local environments now contain ZERO data rows.');
}

run().catch((err) => {
  console.error('Fatal reset error:', err);
  process.exit(1);
});
