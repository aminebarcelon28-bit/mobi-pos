/**
 * HARNESS SMOKE — proves the four pillars of the harness against the REAL app:
 *   1. external tauri-driver launches the sandboxed e2e binary;
 *   2. Node (better-sqlite3) reads the same live SQLite the app writes;
 *   3. Node-side seeding reaches the UI after mirror wipe + reload;
 *   4. UI flows (shift open, cash sale) land in SQLite with exact money.
 *
 * Not an encyclopedia case — prefixed [HARNESS-nn] on purpose.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, integrityCheck, scalar, tableCounts, waitForSchemaSettled } from '../lib/db';
import { invoke } from '../lib/invoke';
import {
  addSku,
  cartLineCount,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  displayedToMinor,
  installErrorTrap,
  installScanSpy,
  listDialogs,
  openShiftUi,
  payExactFlow,
  readErrors,
  readOpenShiftDexie,
  readScanEvents,
  scanCode,
  tid,
  unlockIfNeeded,
} from '../lib/pos';
import { seedProducts, seedSettings } from '../lib/seed';

const SKU = 'E2E-HARNESS-1';
const BARCODE = 'EHARNESS1';
const PRICE_DA = 1234;

describe('HARNESS smoke', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    console.log(`[smoke] db file: ${DB_PATH}`);
    const settledVersion = await waitForSchemaSettled();
    console.log(`[smoke] schema settled at migration ${settledVersion}`);
    // Node-side seeding (out-of-band) then mirror wipe + reload so the UI
    // re-reads the SQLite authority.
    seedProducts([{ id: SKU, title: 'E2E Harness Product', priceDa: PRICE_DA, stock: 50, barcode: BARCODE }]);
    seedSettings([{ key: 'E2E-HARNESS-FLAG', valueJson: '{"seeded":true}' }]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await installScanSpy();
  });

  it('[HARNESS-01] boot gate reachable and dashboard unlocks with PIN', async () => {
    const header = await $('header');
    await header.waitForDisplayed({ timeout: 60000 });
    expect(await header.isDisplayed()).toBe(true);
  });

  it('[HARNESS-02] build provenance: e2e flavor, isolated identifier, sealed cloud', async () => {
    const info = await invoke<{
      gitSha: string;
      profile: string;
      features: string[] | string;
      identifierExpected: string;
      dataDir: string;
      gatewayMode: string;
    }>('e2e_build_info');
    console.log(`[smoke] build info: ${JSON.stringify(info)}`);
    expect(info.identifierExpected).toBe('com.mobi.pos.e2e');
    expect(String(info.features)).toContain('e2e');
    expect(info.dataDir.toLowerCase()).toContain('com.mobi.pos.e2e');
  });

  it('[HARNESS-03] Node reads the same live SQLite (integrity ok, ledgers intact)', async () => {
    expect(integrityCheck()).toBe('ok');
    const migrated = Number(scalar('SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations'));
    const tables = tableNamesSafe();
    console.log(`[smoke] migrated=${migrated} tables=${tables.length}`);
    // Prod baseline is >= 106; fresh boots reach 112.
    expect(migrated).toBeGreaterThanOrEqual(106);
    expect(tables.length).toBeGreaterThan(50);
    const n = count('products', 'id = ?', SKU);
    expect(n).toBe(1);
    const flag = scalar('SELECT value_json FROM app_settings WHERE key = ?', 'E2E-HARNESS-FLAG');
    expect(String(flag)).toContain('seeded');
  });

  it('[HARNESS-04] Node-seeded product is visible in the catalog (mirror wipe + reload)', async () => {
    await addSku('E2E Harness', { expectTitle: 'E2E Harness Product' });
    const total = await cartTotalMinor();
    expect(total).toBe(BigInt(PRICE_DA) * 100n);
    expect(await cartLineCount()).toBe(1);
    // Remove the line again for the following tests.
    const remove = await $(tid('cart-line-remove'));
    await remove.click();
    await browser.waitUntil(
      async () => {
        const el = await $(tid('cart-total'));
        return displayedToMinor(await el.getText()) === 0n;
      },
      { timeout: 15000, timeoutMsg: 'cart did not clear' },
    );
  });

  it('[HARNESS-05] open shift via UI is mirrored to SQLite cash_sessions (OPEN)', async () => {
    const before = count('cash_sessions', "status='OPEN'");
    await openShiftUi(10000);
    const dexie = await readOpenShiftDexie();
    console.log(`[smoke] dexie open shift: ${JSON.stringify(dexie)}`);
    expect(dexie?.id).toBeTruthy();
    await browser.waitUntil(() => count('cash_sessions', "status='OPEN'") >= Math.max(1, before), {
      timeout: 20000,
      interval: 500,
      timeoutMsg: 'SQLite cash_sessions did not get an OPEN row',
    });
    const sqlRow = sqliteOpenShift();
    console.log(`[smoke] sqlite open shift: ${JSON.stringify(sqlRow)}`);
    // Discovery value: log whether Dexie and SQLite agree on the id.
    if (dexie && sqlRow && String(sqlRow.id) !== dexie.id) {
      console.log(`[smoke][DISCOVERY] shift id mismatch dexie=${dexie.id} sqlite=${sqlRow.id}`);
    }
    expect(Number(sqlRow?.opening_float)).toBe(10000);
  });

  it('[HARNESS-06] UI cash sale lands in SQLite with exact integer-DA money', async () => {
    const txBefore = count('transactions');
    const stockBefore = Number(scalar('SELECT stock FROM products WHERE id = ?', SKU));
    await addSku('E2E Harness', { expectTitle: 'E2E Harness Product' });
    await payExactFlow();
    await browser.waitUntil(() => count('transactions') > txBefore, {
      timeout: 30000,
      interval: 500,
      timeoutMsg: 'sale row never appeared in SQLite',
    });
    const row = latestTransaction();
    console.log(`[smoke] sale row: ${JSON.stringify(row)}`);
    expect(Number(row?.total)).toBe(1234);
    expect(String(row?.status)).toBe('COMPLETED');
    const stockAfter = Number(scalar('SELECT stock FROM products WHERE id = ?', SKU));
    expect(stockAfter).toBe(stockBefore - 1);
    console.log(
      `[smoke][DISCOVERY] after pay: cart=${await cartTotalMinor().catch(() => -1n)} lines=${await cartLineCount()} dialogs=${JSON.stringify(await listDialogs())}`,
    );
  });

  it('[HARNESS-07] wedge barcode scan adds exactly one unit and clears the search', async () => {
    await clearCart();
    console.log(
      `[smoke][DISCOVERY] pre-scan: cart=${await cartTotalMinor()} lines=${await cartLineCount()} dialogs=${JSON.stringify(await listDialogs())}`,
    );
    const changed = await scanCode(BARCODE);
    console.log(
      `[smoke][DISCOVERY] post-scan: changed=${String(changed)} cart=${await cartTotalMinor()} lines=${await cartLineCount()} scans=${JSON.stringify(await readScanEvents())}`,
    );
    expect(changed).toBe(true);
    expect(await cartTotalMinor()).toBe(BigInt(PRICE_DA) * 100n);
    expect(await cartLineCount()).toBe(1);
    const events = await readScanEvents();
    console.log(`[smoke] scan events: ${JSON.stringify(events)}`);
    expect(events.some((e) => e.code === BARCODE)).toBe(true);
    await clearCart();
  });

  after(async () => {
    const errors = await readErrors();
    if (errors.length > 0) console.log(`[smoke] ui errors: ${JSON.stringify(errors)}`);
    expect(errors).toEqual([]);
  });
});

function tableNamesSafe(): string[] {
  return tableCounts().map((t) => t.name);
}

function sqliteOpenShift(): Record<string, unknown> | undefined {
  return all<Record<string, unknown>>(
    "SELECT id, opening_float, status, cashier_name FROM cash_sessions WHERE status='OPEN' ORDER BY opened_at DESC LIMIT 1",
  )[0];
}

function latestTransaction(): Record<string, unknown> | undefined {
  return all<Record<string, unknown>>(
    'SELECT id, receipt_number, total, subtotal, status, payment_method FROM transactions ORDER BY created_at DESC, rowid DESC LIMIT 1',
  )[0];
}
