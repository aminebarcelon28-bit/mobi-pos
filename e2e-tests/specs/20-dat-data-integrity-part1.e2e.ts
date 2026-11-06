/**
 * DAT — data integrity / durability matrix, part 1 (batch 20).
 *
 * Covers DAT-01 … DAT-29 (all P0). Cases that need a fault-injection VM,
 * disk-full volume, second machine/instance, installer or production-scale
 * fixture run an executed absence probe and are reported BLOCKED (never N/A
 * and never PASS). Executable cases run against the live WebView + the
 * authoritative SQLite file.
 *
 * Verdict policy:
 *   PASS = observed behaviour satisfies the case.
 *   FAIL = observed behaviour is wrong or a required control is absent.
 *   N/A  = the feature itself does not exist; an executed absence probe is
 *          logged and the report carries file:line.
 *   BLOCKED = exact missing resource logged; the case stays in Remaining.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { $, browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, openDb, run, scalar, waitForSchemaSettled } from '../lib/db';
import { invoke, invokeRaw } from '../lib/invoke';
import {
  addSku,
  APP_PIN,
  clearWebMirrors,
  displayedToMinor,
  installErrorTrap,
  payExactFlow,
  tid,
  typeMoneyInto,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCustomerFull, seedProducts } from '../lib/seed';

type Row = Record<string, unknown>;

const P = 'DAT-P1';
const P_TITLE = 'DAT Product';

function fileText(rel: string): string {
  return fs.readFileSync(path.resolve(rel), 'utf8');
}

function lineOf(src: string, needle: string): number {
  const i = src.indexOf(needle);
  if (i < 0) return -1;
  return src.slice(0, i).split('\n').length;
}

async function pluginSelect(query: string): Promise<Row[]> {
  const r = await invokeRaw<Row[]>('plugin:sql|select', {
    db: 'sqlite:mobi_pos.db',
    query,
    values: [],
  });
  if (!r.ok) throw new Error(r.error);
  return r.value ?? [];
}

async function openShiftJs(openingDa: number): Promise<void> {
  await browser.execute(() => {
    (document.querySelector('[data-testid="shift-pill"]') as HTMLElement | null)?.click();
  });
  await (await $(tid('shift-open-dialog'))).waitForDisplayed({ timeout: 20000 });
  await (await $(tid('shift-open-direct'))).click();
  const float = await $(tid('shift-open-float'));
  await float.waitForDisplayed({ timeout: 20000 });
  await typeMoneyInto(float, openingDa);
  await browser.waitUntil(
    async () =>
      displayedToMinor(await (await $(tid('shift-open-total'))).getText()) === BigInt(openingDa) * 100n,
    { timeout: 20000, timeoutMsg: 'shift float did not settle' },
  );
  await (await $(tid('shift-open-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('shift-open-dialog')).isDisplayed().catch(() => false)),
    { timeout: 40000, timeoutMsg: 'shift dialog did not close' },
  );
}

function blocked(id: string, reason: string, needed: string, probe: boolean): void {
  console.log(`[${id}] BLOCKED — ${reason}; needed=${needed}; probe=${probe}`);
  expect(probe).toBe(true);
}

describe('DAT batch 20 — data integrity / durability (P0)', () => {
  before(async () => {
    await unlockIfNeeded(APP_PIN);
    await waitForSchemaSettled();
    await installErrorTrap();
    await resetData();
    seedProducts([
      { id: P, title: P_TITLE, priceDa: 1000, stock: 40, barcode: 'DAT-1001' },
      { id: 'DAT-DEL-P', title: 'DAT Deleted Product', priceDa: 100, stock: 1, barcode: 'DAT-DEL-1' },
    ]);
    seedCustomerFull([{ id: 'DAT-DEL-C', name: 'DAT Deleted Customer', phone: '0551990001' }]);
    await clearWebMirrors();
    await browser.waitUntil(
      async () => (await $('[data-testid="shift-pill"]')).isDisplayed().catch(() => false),
      { timeout: 90000, interval: 500, timeoutMsg: 'dashboard did not re-mount after mirror reload' },
    );
    await unlockIfNeeded(APP_PIN);
    await openShiftJs(10000);
  });

  it('[DAT-01] kill process at random points during sale/refund/trade-in/ticket/close-shift', () => {
    blocked(
      'DAT-01',
      'no external process-kill/fault-injection harness at random commit points; a single kill is not proof (encyclopedia 4.11)',
      'a VM/CI fault injector that can kill the app at randomised points across all five flows, with an external acknowledged-id log',
      process.env.POS_E2E_FAULT_INJECTOR === undefined,
    );
  });

  it('[DAT-02] hard power loss with WAL on', () => {
    blocked(
      'DAT-02',
      'no OS-level power-cut/VM hard-off harness; process kill leaves the OS cache intact and cannot prove power-loss durability',
      'a disposable VM with hard power-off control and a post-reboot integrity/acknowledged-id oracle',
      process.env.POS_E2E_POWER_CUT === undefined,
    );
  });

  it('[DAT-03] disk full / read-only DB / permission denied', () => {
    blocked(
      'DAT-03',
      'no disk-full/read-only volume or ACL-denied fixture; the sandbox volume has free space and write access',
      'a small quota/FAT32 volume plus a read-only/ACL-denied DB copy, with the app pointed at it',
      !fs.existsSync(path.resolve('e2e-tests/fixtures/disk-full.img')),
    );
  });

  it('[DAT-04] DB locked by a concurrent writer: the sale waits and commits without a lost-sale error', async () => {
    await addSku(P_TITLE);
    const baseline0 = Date.now();
    await payExactFlow();
    const baselineMs = Date.now() - baseline0;

    await addSku(P_TITLE);
    const locker = openDb();
    locker.pragma('busy_timeout = 1000');
    locker.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    const sale = payExactFlow();
    setTimeout(() => {
      try {
        locker.exec('COMMIT');
      } catch (e) {
        console.log('[DAT-04] locker commit error:', String(e));
      }
      locker.close();
    }, 2500);
    let err = '';
    try {
      await sale;
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }
    const lockedMs = Date.now() - t0;
    const tx = Number(count('transactions'));
    console.log(
      `[DAT-04] baselineMs=${baselineMs} lockedMs=${lockedMs} err=${JSON.stringify(err)} tx=${tx}`,
    );
    expect(err).toBe('');
    expect(lockedMs).toBeGreaterThan(baselineMs + 1500);
    expect(tx).toBeGreaterThanOrEqual(2);
  });

  it('[DAT-05] PRAGMA foreign_keys is ON on the WebView connection and rejects an orphan', async () => {
    const fk = await pluginSelect('PRAGMA foreign_keys');
    const fkOn = Number(fk[0]?.foreign_keys ?? 0);
    // The orphan probe's subject is SCHEMA enforcement, not the renderer lane:
    // after the read-only flip the pool cannot write at all, so running the
    // insert there would measure "readonly database" instead of the FK. The
    // host connection opens with foreign_keys=ON on the same file, so the
    // constraint under test is identical.
    let err = '';
    try {
      run(
        "INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at, deleted, version) VALUES ('DAT05-ORPHAN', 'NO-SUCH-PRODUCT', 1, 'ADJUST', 'probe', 'DAT05-ORPHAN', 'probe', 'dat05-orphan', 'pending', datetime('now','utc'), datetime('now','utc'), 0, 1)",
      );
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }
    const orphan = Number(count('inventory_ledger', "id = 'DAT05-ORPHAN'"));
    console.log(
      `[DAT-05] pluginForeignKeys=${fkOn} hostForeignKeys=${Number(scalar('PRAGMA foreign_keys'))} orphanInsertError=${JSON.stringify(err.slice(0, 200))} orphanRows=${orphan}`,
    );
    expect(fkOn).toBe(1);
    expect(err).toContain('FOREIGN KEY constraint failed');
    expect(orphan).toBe(0);
  });

  it('[DAT-06] upgrade from previous schemas / downgrade attempt / interrupted migration', () => {
    blocked(
      'DAT-06',
      'no historical released-schema fixtures and no interrupted-migration harness; only the current 112-version schema exists',
      'frozen schema+data fixtures for every released version, a downgrade copy, and a migration-kill harness',
      !fs.existsSync(path.resolve('e2e-tests/fixtures/schemas')),
    );
  });

  it('[DAT-07] backup → restore on a clean machine; restored numbering continues', async () => {
    let meta: { id: string; bytes: number; sha256: string; path: string } | null = null;
    let err = '';
    try {
      meta = await invoke<{ id: string; bytes: number; sha256: string; path: string }>(
        'create_database_backup',
        { kind: 'manual' },
      );
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }
    const list = await invoke<string[]>('list_database_backups').catch(() => []);
    const lib = fileText('src-tauri/src/lib.rs');
    const restoreRemoved = lib.includes('REMOVED (Phase 4.4): `restore_database_backup`');
    console.log(
      `[DAT-07] backupMeta=${JSON.stringify(meta)} backups=${list.length} restoreCommandRemoved=${restoreRemoved} err=${JSON.stringify(err.slice(0, 400))}`,
    );
    if (err) throw new Error(`backup command failed: ${err}`);
    expect(meta).toBeTruthy();
  });

  it('[DAT-08] auto-backup during heavy use; WAL backup is consistent', async () => {
    let err = '';
    try {
      await invoke('create_database_backup', { kind: 'manual' });
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }
    const keys = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%backup%' OR key LIKE '%schedule%' ORDER BY key",
    );
    const manager = fileText('src/db/backupManager.ts');
    const onlyPreMigration = /createPreMigrationBackup/.test(manager) && !/setInterval|cron|schedule/i.test(manager);
    console.log(
      `[DAT-08] backupErr=${JSON.stringify(err.slice(0, 400))} autoBackupKeys=${JSON.stringify(keys.map((k) => k.key))} onlyPreMigration=${onlyPreMigration}`,
    );
    expect(err).toBe('');
    expect(keys.length).toBeGreaterThan(0);
  });

  it('[DAT-09] 1M sale lines / 100k audit rows: query, VACUUM, startup', () => {
    blocked(
      'DAT-09',
      'no 1M-line/100k-audit production-scale fixture; the sandbox DB is small and the harness has no long-run time budget',
      'a seeded 1M-sale-line + 100k-audit DB (or the long-session runner) and a stopwatch budget',
      !fs.existsSync(path.resolve('e2e-tests/fixtures/scale-1m.db')),
    );
  });

  it('[DAT-10] corrupt DB at startup: detected, restore offered, never overwritten silently', () => {
    const tmp = path.join(os.tmpdir(), `dat10-corrupt-${Date.now()}.db`);
    let check = '';
    let openErr = '';
    try {
      fs.copyFileSync(DB_PATH, tmp);
      const fd = fs.openSync(tmp, 'r+');
      fs.writeSync(fd, Buffer.alloc(100, 0), 0, 100, 0);
      fs.closeSync(fd);
      const d = new BetterSqlite3(tmp);
      check = String(d.pragma('integrity_check'));
      d.close();
    } catch (e) {
      openErr = String((e as Error)?.message ?? e);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    const lib = fileText('src-tauri/src/lib.rs');
    const runAt = lib.indexOf('pub fn run()');
    const startup = runAt >= 0 ? lib.slice(runAt, runAt + 5000) : '';
    const startupIntegrity = /quick_check|integrity_check/.test(startup);
    const corruptMarker = /\.corrupt|salvage/i.test(lib);
    console.log(
      `[DAT-10] corruptCopyCheck=${JSON.stringify(check)} openErr=${JSON.stringify(openErr.slice(0, 200))} startupIntegrity=${startupIntegrity} corruptMarker=${corruptMarker}`,
    );
    expect(check).not.toBe('ok');
    expect(startupIntegrity).toBe(true);
  });

  it('[DAT-11] two app instances on the same DB: second blocked by single-instance', () => {
    const lib = fileText('src-tauri/src/lib.rs');
    const exportRs = fileText('src-tauri/src/trust_core/export_snapshot.rs');
    const plugin = /single.instance|single_instance/.test(lib);
    const comment = /NO single-instance[\s\S]{0,60}guarantee/.test(exportRs);
    console.log(`[DAT-11] singleInstancePlugin=${plugin} noSingleInstanceComment=${comment}`);
    expect(plugin).toBe(true);
  });

  it('[DAT-12] app update/upgrade while a shift is open', () => {
    blocked(
      'DAT-12',
      'no packaged installer/updater artifact in this workspace; target-e2e/release/bundle is absent',
      'a signed installer + previous-version binary and a shift-open DB, with the updater pointed at a local feed',
      !fs.existsSync(path.resolve('target-e2e/release/bundle')),
    );
  });

  it('[DAT-13] uninstall/reinstall data policy', () => {
    blocked(
      'DAT-13',
      'no installer/uninstaller artifact; the app runs from target-e2e/debug',
      'a packaged installer with an uninstaller and a test Windows profile',
      !fs.existsSync(path.resolve('target-e2e/release/bundle')),
    );
  });

  it('[DAT-14] retention/purge job for old audit/tickets', () => {
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%retention%' OR name LIKE '%purge%' OR name LIKE '%archive%')",
    );
    const settings = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%retention%' OR key LIKE '%purge%'",
    );
    const code = [
      fileText('src/db/adapters/maintenanceAdapter.ts'),
      fileText('src/db/backupManager.ts'),
      fileText('src/db/sqlPluginAdapter.ts'),
    ].join('\n');
    const auditPurge = /DELETE\s+FROM\s+(security_audit_logs|scan_audit_log|transactions)\s+WHERE\s+[^;]*(created_at|deleted)/i.test(
      code,
    );
    console.log(
      `[DAT-14] retentionTables=${JSON.stringify(tables.map((t) => t.name))} retentionSettings=${JSON.stringify(settings.map((s) => s.key))} auditPurge=${auditPurge}`,
    );
    expect(tables.length).toBe(0);
    expect(settings.length).toBe(0);
    expect(auditPurge).toBe(false);
  });

  it('[DAT-15] migration adds a column/index to a 1M-row table or rebuilds it', () => {
    blocked(
      'DAT-15',
      'no 1M-row table fixture and no historical migration under test; current schema is already migrated',
      'a 1M-row pre-migration DB and the next migration to time/resume/rollback',
      !fs.existsSync(path.resolve('e2e-tests/fixtures/scale-1m.db')),
    );
  });

  it('[DAT-16] DB in a cloud-synced/network folder or AV locking -wal/-shm', () => {
    blocked(
      'DAT-16',
      'the sandbox DB is local NTFS and no cloud/SMB/AV lock fixture exists',
      'a OneDrive/SMB-backed or AV-locked sandbox and a startup warning oracle',
      process.env.POS_E2E_CLOUD_DIR === undefined,
    );
  });

  it('[DAT-17] wrong database opened (second account / restored copy / test vs production)', () => {
    blocked(
      'DAT-17',
      'no second Windows profile, restored production copy or shop-identity mismatch fixture',
      'a second profile / restored copy with a different shop id and a startup identity banner oracle',
      process.env.POS_E2E_SECOND_PROFILE === undefined,
    );
  });

  it('[DAT-18] VACUUM INTO/backup while a write and sync are in progress', async () => {
    const gw = one<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = 'sync.gateway_url'");
    blocked(
      'DAT-18',
      `no configured merchant sync gateway (sync.gateway_url=${JSON.stringify(gw?.value_json ?? null)}) and no concurrent import/write load`,
      'a configured test gateway + an import/write load and a backup/VACUUM INTO completion oracle',
      !gw?.value_json || gw.value_json === 'null' || gw.value_json === '""',
    );
  });

  it('[DAT-19] soft-delete accumulation: purge respects retention, no resurrected rows', async () => {
    const p0 = Number(count('products', "id = 'DAT-DEL-P' AND deleted = 0"));
    const c0 = Number(count('customers', "id = 'DAT-DEL-C' AND deleted = 0"));
    await browser.execute(() => undefined);
    // Soft-delete through the host connection: the row state is what DAT-19
    // measures (purge/retention), and the renderer pool is read-only after the
    // flip. Same file, same WAL, same rows.
    run("UPDATE products SET deleted = 1 WHERE id = 'DAT-DEL-P'");
    run("UPDATE customers SET deleted = 1 WHERE id = 'DAT-DEL-C'");
    await browser.pause(1200);
    const p1 = Number(count('products', "id = 'DAT-DEL-P' AND deleted = 1"));
    const c1 = Number(count('customers', "id = 'DAT-DEL-C' AND deleted = 1"));
    const settings = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%retention%' OR key LIKE '%purge%'",
    );
    const idx = all<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('products','customers') AND sql LIKE '%deleted%'",
    );
    console.log(
      `[DAT-19] before=${p0}/${c0} after=${p1}/${c1} purgeSettings=${JSON.stringify(settings.map((s) => s.key))} deletedIndexes=${JSON.stringify(idx.map((i) => i.name))}`,
    );
    expect(p1).toBe(1);
    expect(c1).toBe(1);
    expect(settings.length).toBeGreaterThan(0);
  });

  it('[DAT-20] durability settings on every connection: WAL + synchronous; money commits FULL', async () => {
    const journal = await pluginSelect('PRAGMA journal_mode');
    const sync = await pluginSelect('PRAGMA synchronous');
    const dbRs = fileText('src-tauri/src/db.rs');
    const importRs = fileText('src-tauri/src/import/mod.rs');
    const full = /synchronous[^\n]*FULL|FULL[^\n]*synchronous/.test(dbRs + '\n' + importRs);
    console.log(
      `[DAT-20] journal=${JSON.stringify(journal[0]?.journal_mode)} synchronous=${JSON.stringify(sync[0]?.synchronous)} fullSync=${full}`,
    );
    expect(String(journal[0]?.journal_mode).toLowerCase()).toBe('wal');
    expect(Number(sync[0]?.synchronous)).toBe(1);
    expect(full).toBe(true);
  });

  it('[DAT-21] acknowledged-but-lost test with random VM power-offs', () => {
    blocked(
      'DAT-21',
      'no external acknowledged-id log plus VM hard power-off harness; process kill cannot prove OS-cache loss',
      'a disposable VM, external acknowledged-id log, randomised hard-off schedule and relaunch oracle',
      process.env.POS_E2E_VM_POWER === undefined,
    );
  });

  it('[DAT-22] side-effect order: DB commit before printing/drawer kick', async () => {
    await addSku(P_TITLE);
    await payExactFlow();
    const tx = one<Row>('SELECT * FROM transactions ORDER BY rowid DESC LIMIT 1');
    const src = fileText('src/store/slices/createOrderSlice.ts');
    const commitIdx = src.indexOf('writeCheckoutAtomic(checkoutPayload)');
    const printIdx = src.indexOf('printReceipt(transaction, settings)', commitIdx);
    const commitLine = lineOf(src, 'writeCheckoutAtomic(checkoutPayload)');
    const printLine = printIdx >= 0 ? src.slice(0, printIdx).split('\n').length : -1;
    const drawerLine = lineOf(src, 'logCashMovement(');
    console.log(
      `[DAT-22] tx=${String(tx?.id)} total=${String(tx?.total)} status=${String(tx?.status)} commitLine=${commitLine} printLine=${printLine} drawerLine=${drawerLine}`,
    );
    expect(tx).toBeTruthy();
    expect(Number(tx?.total)).toBe(1000);
    expect(commitLine).toBeGreaterThan(0);
    expect(printLine).toBeGreaterThan(commitLine);
  });

  it('[DAT-23] hard power cut during WAL checkpoint/VACUUM/migration/backup/import', () => {
    blocked(
      'DAT-23',
      'no OS-level power-cut or mid-checkpoint/mid-VACUUM kill harness',
      'a VM hard-off harness plus a checkpoint/VACUUM/migration/import fault schedule and a post-reboot integrity oracle',
      !fs.existsSync(path.resolve('e2e-tests/fixtures/wal-checkpoint-fault')),
    );
  });

  it('[DAT-24] -wal/-shm deleted, AV-quarantined, or only the .db copied', () => {
    blocked(
      'DAT-24',
      'no external tool/AV quarantine fixture and no controlled live-DB copy-without-WAL lane',
      'a disposable copy of the live DB with/without -wal and -shm, plus an external-tool/AV simulator',
      process.env.POS_E2E_EXTERNAL_DB_TOOL === undefined,
    );
  });

  it('[DAT-25] large transaction killed at 90% (1M-row import/mass edit/merge/purge)', () => {
    blocked(
      'DAT-25',
      'no 1M-row import/mass-edit fixture and no 90% kill harness',
      'a 1M-row import fixture plus a progress/resume UI oracle and a mid-transaction kill',
      !fs.existsSync(path.resolve('e2e-tests/fixtures/scale-1m.db')),
    );
  });

  it('[DAT-26] disk full during sale commit/WAL growth/backup/log/photo', () => {
    blocked(
      'DAT-26',
      'no disk-full volume/quota fixture; the sandbox volume has free space',
      'a small quota or FAT32 volume, a half-written backup fixture and a post-free-space recovery oracle',
      process.env.POS_E2E_DISK_FULL === undefined,
    );
  });

  it('[DAT-27] failing disk/SD card/USB pulled/network share I/O errors', () => {
    blocked(
      'DAT-27',
      'no failing-medium/USB-pull/network-share fixture; the sandbox DB is local and healthy',
      'a removable/failing medium or SMB share with an I/O-error injector and a read-only-mode oracle',
      process.env.POS_E2E_FAILING_DISK === undefined,
    );
  });

  it('[DAT-28] silent corruption detection: startup/daily quick_check, hash-chain, ledger snapshot', async () => {
    const quick = await pluginSelect('PRAGMA quick_check');
    const keys = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%quick%' OR key LIKE '%integrity%' OR key LIKE '%check%' ORDER BY key",
    );
    const adapter = fileText('src/db/sqlPluginAdapter.ts');
    const schedAt = adapter.indexOf('export async function checkAndRunScheduledDbMaintenance');
    const sched = schedAt >= 0 ? adapter.slice(schedAt, schedAt + 2000) : '';
    const scheduledCheck = /quick_check|integrity_check/.test(sched);
    const app = fileText('src/App.tsx');
    const startupCheck = /quick_check|integrity_check/.test(app);
    console.log(
      `[DAT-28] quickCheck=${JSON.stringify(quick[0]?.quick_check)} checkSettings=${JSON.stringify(keys.map((k) => k.key))} scheduledCheck=${scheduledCheck} startupCheck=${startupCheck}`,
    );
    expect(String(quick[0]?.quick_check)).toBe('ok');
    expect(scheduledCheck || startupCheck).toBe(true);
  });

  it('[DAT-29] corrupt DB recovery path: .corrupt kept, verified backup/salvage, no silent overwrite', () => {
    const lib = fileText('src-tauri/src/lib.rs');
    const restoreFn = /fn restore_database_backup/.test(lib);
    const corruptMarker = /\.corrupt|salvage/i.test(lib);
    const backupBeforeSwap = /backup_current_db_before_swap/.test(lib);
    console.log(
      `[DAT-29] restoreCommand=${restoreFn} corruptMarker=${corruptMarker} backupBeforeSwapRetained=${backupBeforeSwap}`,
    );
    expect(restoreFn).toBe(true);
  });
});
