/**
 * Batch 24 probe — schema and sync-surface facts for SYN-01..SYN-30.
 * Read-only except the normal boot; logs facts only, no secrets.
 */
import { browser } from '@wdio/globals';
import { all, columnNames, count, one, scalar, tableExists, tableNames } from '../lib/db';
import { APP_PIN, ensureShiftOpen, unlockIfNeeded } from '../lib/pos';

describe('SYN batch 24 probe', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 120000, script: 120000 });
    await unlockIfNeeded(APP_PIN);
    await ensureShiftOpen();
  });

  it('[SYN-PROBE] dump sync surface', () => {
    const tables = tableNames();
    const syncTables = tables.filter((t) => /sync|outbox|event|clock|replica|identity|entity_key/i.test(t));
    console.log(`[SYN-PROBE] tables=${JSON.stringify(syncTables)}`);
    for (const t of syncTables) {
      try {
        const cols = columnNames(t);
        const n = count(t);
        console.log(`[SYN-PROBE] table=${t} rows=${n} cols=${JSON.stringify(cols)}`);
      } catch (e) {
        console.log(`[SYN-PROBE] table=${t} unreadable=${String(e)}`);
      }
    }
    const outboxIdx = all<{ name: string; unique: number; origin: string; partial: number }>(
      'PRAGMA index_list(sync_outbox)',
    );
    console.log(`[SYN-PROBE] outboxIndexes=${JSON.stringify(outboxIdx)}`);
    const txIdx = all<{ name: string; unique: number; origin: string; partial: number }>(
      'PRAGMA index_list(transactions)',
    );
    console.log(`[SYN-PROBE] transactionIndexes=${JSON.stringify(txIdx)}`);
    const txCols = columnNames('transactions');
    console.log(`[SYN-PROBE] transactionCols=${JSON.stringify(txCols)}`);
    const productCols = columnNames('products');
    console.log(`[SYN-PROBE] productCols=${JSON.stringify(productCols)}`);
    const settingKeys = all<{ key: string }>('SELECT key FROM app_settings ORDER BY key').map((r) => r.key);
    console.log(`[SYN-PROBE] settingKeys=${JSON.stringify(settingKeys)}`);
    const syncState = tableExists('sync_state')
      ? all<{ key: string; value: string }>('SELECT key, value FROM sync_state ORDER BY key')
      : [];
    console.log(`[SYN-PROBE] syncState=${JSON.stringify(syncState)}`);
    let cipherVersion = '';
    try {
      cipherVersion = String(scalar('PRAGMA cipher_version') ?? '');
    } catch {
      cipherVersion = '';
    }
    console.log(`[SYN-PROBE] cipherVersion=${JSON.stringify(cipherVersion)} journal=${JSON.stringify(scalar('PRAGMA journal_mode'))}`);
    const fk = all<{ table: string; from: string; to: string }>('PRAGMA foreign_key_list(transactions)');
    console.log(`[SYN-PROBE] txForeignKeys=${JSON.stringify(fk)}`);
    const trig = all<{ name: string; tbl_name: string }>(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY name",
    );
    console.log(`[SYN-PROBE] triggers=${JSON.stringify(trig)}`);
    const eventCount = tableExists('event_log') ? count('event_log') : -1;
    console.log(`[SYN-PROBE] eventLogRows=${eventCount}`);
    const identityCols = tableExists('device_identity') ? columnNames('device_identity') : [];
    console.log(`[SYN-PROBE] deviceIdentityCols=${JSON.stringify(identityCols)}`);
    const identityCount = tableExists('device_identity') ? count('device_identity') : -1;
    console.log(`[SYN-PROBE] deviceIdentityRows=${identityCount}`);
    const pinCols = tableExists('users') ? columnNames('users') : [];
    console.log(`[SYN-PROBE] userCols=${JSON.stringify(pinCols)}`);
  });
});
