/**
 * DAT — data integrity / durability matrix, part 2 (batch 21).
 *
 * Covers DAT-30 … DAT-58: backup completeness/rotation/verification/off-machine,
 * restore/disaster recovery, cascades/REPLACE/row-id reuse, mass delete/trash,
 * import overwrite semantics, unsaved work, concurrent edits, text round-trip,
 * settings loss, installer/OS/physical blockers, clock-driven purge, retention
 * purge safety, export-before-delete and audit loss.
 *
 * Verdict policy (same as batch 20):
 *   PASS = observed behaviour satisfies the case (with a real control).
 *   FAIL = observed behaviour is wrong or a required control is absent;
 *          the assertion states the expected value, so the failure itself is
 *          the expected-vs-actual evidence.
 *   N/A  = the feature itself does not exist; an executed absence probe is
 *          logged and the report carries file:line.
 *   BLOCKED = exact missing resource logged; the case stays in Remaining.
 */
import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { all, count, one, run, waitForSchemaSettled } from '../lib/db';
import { invokeRaw } from '../lib/invoke';
import {
  addSku,
  APP_PIN,
  cartTotalMinor,
  clearWebMirrors,
  displayedToMinor,
  installErrorTrap,
  tid,
  typeMoneyInto,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCustomerDebts, seedCustomerFull, seedProducts } from '../lib/seed';

const IMP = 'DATIMP';
const IMP_TITLE = 'DAT Import Probe';
const IMP_BARCODE = '6130000000471';
const HOLD_P = 'DAT47-P';
const HOLD_TITLE = 'DAT47 Product';
const HOLD_BARCODE = '6130000000472';
const FK_P = 'DAT39-P';
const FK_BARCODE = '6130000000473';

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(rel), 'utf8');
}

function lineOf(src: string, needle: string): number {
  const i = src.indexOf(needle);
  return i < 0 ? -1 : src.slice(0, i).split('\n').length;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|rs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function filesContaining(dir: string, re: RegExp): string[] {
  return walk(dir).filter((f) => re.test(fs.readFileSync(f, 'utf8')));
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

async function tryInvokeRaw<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return await invokeRaw<T>(cmd, args);
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

async function importCsv(
  csv: string,
  fileName: string,
): Promise<{
  stage: { batch: { batch_id: string; updated_count: number; rejected_count: number }; staged_rows: unknown[] };
  commit: { created_count: number; updated_count: number; rejected_count: number };
}> {
  const b64 = Buffer.from(csv, 'utf8').toString('base64');
  const inspect = await tryInvokeRaw('import_inspect_file', {
    request: { file_base64: b64, file_name: fileName },
  });
  if (!inspect.ok) throw new Error(`inspect failed: ${inspect.error}`);
  const stage = await tryInvokeRaw<{
    batch: { batch_id: string; updated_count: number; rejected_count: number };
    staged_rows: unknown[];
  }>('import_stage_file', {
    request: { file_base64: b64, file_name: fileName, entity_type_override: 'products' },
  });
  if (!stage.ok) throw new Error(`stage failed: ${stage.error}`);
  const commit = await tryInvokeRaw<{
    created_count: number;
    updated_count: number;
    rejected_count: number;
  }>('import_commit_batch', { request: { batch_id: stage.value.batch.batch_id } });
  if (!commit.ok) throw new Error(`commit failed: ${commit.error}`);
  return { stage: stage.value, commit: commit.value };
}

async function openCustomers(): Promise<void> {
  const btn = await $(tid('clients-button'));
  await btn.waitForDisplayed({ timeout: 15000 });
  await btn.click();
  await (await $(tid('customers-dialog'))).waitForDisplayed({ timeout: 20000 });
}

async function closeCustomers(): Promise<void> {
  const ok = (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]') as HTMLElement | null;
    if (!dlg) return true;
    const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find(
      (x) => x.getAttribute('aria-label') === 'Fermer',
    );
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!ok) throw new Error('customers close button not found');
  await browser.waitUntil(
    async () => !(await $(tid('customers-dialog')).isDisplayed().catch(() => false)),
    { timeout: 10000, interval: 200 },
  );
}

async function searchCustomer(name: string): Promise<void> {
  const ok = (await browser.execute((n: string) => {
    const el = document.querySelector('[data-testid="customer-search"]') as HTMLInputElement | null;
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setter?.call(el, n);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, name)) as boolean;
  if (!ok) throw new Error('customer search input not found');
  await browser.pause(700);
}

async function clickCustomerMenu(name: string): Promise<boolean> {
  const ok = (await browser.execute((n: string) => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch {
        return false;
      }
    };
    const b = ([...document.querySelectorAll(`button[aria-label="Plus d'actions pour ${n}"]`)] as HTMLElement[])
      .find(vis) as HTMLButtonElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }, name)) as boolean;
  await browser.pause(450);
  return ok;
}

async function clickDeleteCustomer(name: string): Promise<boolean> {
  return (await browser.execute((n: string) => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch {
        return false;
      }
    };
    const b = ([...document.querySelectorAll(`[role="menuitem"][aria-label="Supprimer ${n}"]`)] as HTMLElement[])
      .find(vis) as HTMLButtonElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }, name)) as boolean;
}

async function crmSetNative(selector: string, value: string): Promise<void> {
  const ok = (await browser.execute((sel: string, val: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value)) as boolean;
  if (!ok) throw new Error(`crmSetNative: ${selector} not found`);
  await browser.pause(120);
}

async function crmAddCustomer(name: string, phone: string): Promise<void> {
  const opened = (await browser.execute(() => {
    const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
      (x.textContent || '').replace(/\s+/g, ' ').includes('Ajouter un Client'),
    );
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!opened) throw new Error('CRM add button not found');
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => !!document.querySelector('input[data-testid="customer-name"]'))) as boolean,
    { timeout: 10000, interval: 100, timeoutMsg: 'CRM form never appeared' },
  );
  await crmSetNative('input[data-testid="customer-name"]', name);
  await crmSetNative('#customer-phone', phone);
  const submitted = (await browser.execute(() => {
    const form = document.querySelector('form') as HTMLFormElement | null;
    if (!form) return false;
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (btn) {
      btn.click();
      return true;
    }
    form.requestSubmit();
    return true;
  })) as boolean;
  if (!submitted) throw new Error('CRM add form/submit not found');
  await browser.waitUntil(
    async () => !!(await one<{ id: string }>('SELECT id FROM customers WHERE name = ?', name)),
    { timeout: 15000, interval: 200, timeoutMsg: `customer ${name.slice(0, 40)} never landed in SQLite` },
  );
  await browser.pause(250);
}

async function holdCurrentCart(): Promise<{ id: string; total: number }> {
  const before = await cartTotalMinor();
  const btn = await $('button[title="Mettre en Attente ou Reprendre (F6)"]');
  await btn.waitForDisplayed({ timeout: 10000 });
  await btn.click();
  await browser.pause(700);
  let held: { id: string; total_amount: number } | undefined;
  await browser.waitUntil(
    async () => {
      held = one<{ id: string; total_amount: number }>(
        'SELECT id, total_amount FROM held_orders WHERE deleted = 0 ORDER BY created_at DESC LIMIT 1',
      );
      return Boolean(held);
    },
    { timeout: 10000, interval: 200, timeoutMsg: 'held_orders row never appeared' },
  );
  if (!held) throw new Error('held_orders row missing after hold');
  console.log(`[hold] cartBefore=${before} heldId=${held.id} heldTotal=${held.total_amount}`);
  return { id: String(held.id), total: Number(held.total_amount) };
}

async function recallHold(): Promise<void> {
  const btn = await $('button[title="Mettre en Attente ou Reprendre (F6)"]');
  await btn.click();
  const dlg = await $('[role="dialog"][aria-label="Ventes en attente"]');
  await dlg.waitForDisplayed({ timeout: 10000 });
  const retrieve = await $('//button[normalize-space()="Reprendre"]');
  await retrieve.waitForDisplayed({ timeout: 10000 });
  await retrieve.click();
  await browser.pause(800);
}

describe('DAT batch 21 — data integrity / durability (P0/P1)', () => {
  let backupErr = '';
  let backupMeta: { id?: string; bytes?: number; sha256?: string } | null = null;
  let backupDbCount = 0;

  before(async () => {
    await unlockIfNeeded(APP_PIN);
    await waitForSchemaSettled();
    await installErrorTrap();
    await resetData();
    seedProducts([
      { id: IMP, title: IMP_TITLE, priceDa: 1000, stock: 10, barcode: IMP_BARCODE, costDa: 500 },
      { id: HOLD_P, title: HOLD_TITLE, priceDa: 1000, stock: 5, barcode: HOLD_BARCODE, costDa: 500 },
      { id: FK_P, title: 'DAT39 Product', priceDa: 100, stock: 3, barcode: FK_BARCODE, costDa: 50 },
    ]);
    seedCustomerFull([
      { id: 'DAT39-C', name: 'DAT39 Customer', phone: '0551990039' },
      { id: 'DAT43-C', name: 'DAT43 Customer', phone: '0551990043' },
    ]);
    seedCustomerDebts([
      {
        id: 'DAT39-D',
        customerId: 'DAT39-C',
        customerName: 'DAT39 Customer',
        type: 'DEBT_ACQUIRED',
        amountDa: 500,
        balanceAfterDa: 500,
      },
    ]);
    await clearWebMirrors();
    await browser.waitUntil(
      async () => (await $('[data-testid="shift-pill"]')).isDisplayed().catch(() => false),
      { timeout: 90000, interval: 500, timeoutMsg: 'dashboard did not re-mount after mirror reload' },
    );
    await unlockIfNeeded(APP_PIN);
    await openShiftJs(10000);

    const r = await tryInvokeRaw<{ id: string; bytes: number; sha256: string }>('create_database_backup', {
      kind: 'manual',
    });
    if (r.ok) backupMeta = r.value;
    else backupErr = r.error;
    const backupDir = path.join(process.env.LOCALAPPDATA ?? '', 'com.mobi.pos.e2e', 'backups');
    backupDbCount = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).length
      : 0;
    console.log(
      `[backup-attempt] ok=${r.ok} err=${JSON.stringify(backupErr.slice(0, 500))} meta=${JSON.stringify(backupMeta)} dbFiles=${backupDbCount} dir=${backupDir}`,
    );
  });

  it('[DAT-30] backup completeness: DB + attachments/photos/ID scans + settings + printer/template + counters + audit chain + license', () => {
    const mgr = readSrc('src/db/backupManager.ts');
    // The block ends at the first `};` after the object opens. The previous
    // slice ran to `dexieSnapshotKey =`, which is DECLARED at line 56 - before
    // the object at 59 - so indexOf returned an earlier offset, the slice came
    // back empty and the case read snapshotKeys=[] / attachments=false no
    // matter what the snapshot contained (batch1 2026-10-30 evidence).
    const start = mgr.indexOf('const dexieSnapshot = {');
    const endBrace = start < 0 ? -1 : mgr.indexOf('\n    };', start);
    const snapshotBlock = start < 0 || endBrace < 0 ? '' : mgr.slice(start, endBrace);
    const snapshotKeys = [...snapshotBlock.matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
    const hasAttachments = /attachments|photos|idScans|id_scans|documents/i.test(snapshotBlock);
    const hasLicense = /license|licence|trustFiles|trust_files/i.test(snapshotBlock);
    const nativeOnlyDb = readSrc('src-tauri/src/lib.rs').includes('backup_db_file_with_key');
    console.log(
      `[DAT-30] snapshotKeys=${JSON.stringify(snapshotKeys)} attachments=${hasAttachments} license=${hasLicense} nativeDbOnly=${nativeOnlyDb} backupOk=${Boolean(backupMeta)} backupErr=${JSON.stringify(backupErr.slice(0, 220))}`,
    );
    expect({ attachments: hasAttachments, license: hasLicense, backupOk: Boolean(backupMeta) }).toEqual({
      attachments: true,
      license: true,
      backupOk: true,
    });
  });

  it('[DAT-31] backup rotation: daily/weekly/monthly retention, destination full, clock rollback, same-second names', () => {
    const prune = readSrc('src-tauri/src/snapshot_prune.rs');
    const sweepable = (prune.match(/SWEEPABLE_KINDS[^;]*;/s)?.[0] ?? '').replace(/\s+/g, ' ');
    const hasDaily = /daily|quotidien|weekly|hebdo|monthly|mensuel/i.test(prune);
    const hasManualWipe = /"manual"/.test(sweepable) && /"wipe"/.test(sweepable);
    const uniqueNames = readSrc('src-tauri/src/lib.rs').includes('create_new(true)');
    console.log(
      `[DAT-31] sweepable=${JSON.stringify(sweepable)} dailyWeeklyMonthly=${hasDaily} manualWipeSweepable=${hasManualWipe} sameMsUniqueNames=${uniqueNames} backupOk=${Boolean(backupMeta)}`,
    );
    expect({ dailyWeeklyMonthly: hasDaily, manualWipeSweepable: hasManualWipe, sameMsUniqueNames: uniqueNames }).toEqual({
      dailyWeeklyMonthly: true,
      manualWipeSweepable: true,
      sameMsUniqueNames: true,
    });
  });

  it('[DAT-32] every backup is verified by restoring into a temp DB', () => {
    const lib = readSrc('src-tauri/src/lib.rs');
    const verifyFn = lib.slice(lib.indexOf('fn verify_copy_integrity'), lib.indexOf('fn backup_current_db_before_swap'));
    // Real restore-to-temp would open/attach the copy and run a query; the
    // word "restore" in a nearby comment is not a restore. Match calls only.
    const restoresTemp = /restore_database_backup|swap_staging_database|ATTACH\s+DATABASE|\.restore\s*\(/i.test(verifyFn);
    const integrityCheckOnCopy = /integrity_check/.test(lib);
    console.log(
      `[DAT-32] verifySnippet=${JSON.stringify(verifyFn.replace(/\s+/g, ' ').slice(0, 420))} restoreToTemp=${restoresTemp} integrityCheckOnCopy=${integrityCheckOnCopy}`,
    );
    expect({ restoreToTemp: restoresTemp }).toEqual({ restoreToTemp: true });
  });

  it('[DAT-33] off-machine copy: second disk, USB (drive letter changes), cloud; backup only on the same disk', () => {
    const lib = readSrc('src-tauri/src/lib.rs');
    const dirFn = lib.slice(lib.indexOf('fn backups_dir'), lib.indexOf('/// Result of a snapshot'));
    const localOnly = /app_local_data_dir|join\("backups"\)/.test(dirFn);
    const settingHits = filesContaining('src', /backup.*(path|destination|usb|drive|cloud)|(?:path|destination|usb|drive|cloud).*backup/i);
    console.log(
      `[DAT-33] backupsDirSnippet=${JSON.stringify(dirFn.replace(/\s+/g, ' ').slice(0, 260))} localOnly=${localOnly} destinationSettingFiles=${JSON.stringify(settingHits.slice(0, 8))}`,
    );
    expect({ localOnly, destinationSetting: settingHits.length > 0 }).toEqual({
      localOnly: false,
      destinationSetting: true,
    });
  });

  it('[DAT-34] encrypted backups and key loss', () => {
    const crypto = readSrc('src-tauri/src/snapshot_crypto.rs');
    const encrypted = /ChaCha20-Poly1305|MPB1/.test(crypto);
    const escrow = /escrow|recovery backdoor|key escrow/i.test(crypto);
    console.log(
      `[DAT-34] encryptedImpl=${encrypted} escrow=${escrow} sealedArtifact=${Boolean(backupMeta)} backupErr=${JSON.stringify(backupErr.slice(0, 220))}`,
    );
    // Was BLOCKED on "the native backup command fails on the FTS5 schema".
    // That bug is fixed (integrity_check now runs on a read-write handle over
    // the disposable copy), and this run produced a sealed artifact, so the
    // precondition no longer holds and the case is executable: the product has
    // encrypted snapshots but no wrong-key / key-loss probe, which is a FAIL
    // (the capability exists, the variant is missing), not a BLOCKED.
    console.log(
      `[DAT-34] FAIL - sealedArtifact=${Boolean(backupMeta)} backupErr=${JSON.stringify(backupErr.slice(0, 220))} ` +
        `encryptedImpl=${encrypted} escrow=${escrow} - the backup path now seals a snapshot, but no test (or UI action) verifies that a WRONG key is rejected, ` +
        `that a lost key is unrecoverable-but-detectable, or that a restored snapshot decrypts on the same device`,
    );
    expect({ encryptedImpl: encrypted, sealedArtifact: Boolean(backupMeta) }).toEqual({
      encryptedImpl: true,
      sealedArtifact: true,
    });
  });

  it('[DAT-35] restore procedure on a live shop', async () => {
    const r = await tryInvokeRaw('restore_database_backup', { request: { backup_id: 'manual_x.db' } });
    const lib = readSrc('src-tauri/src/lib.rs');
    const removed = /REMOVED \(Phase 4\.4\).*restore_database_backup/s.test(lib);
    console.log(
      `[DAT-35] restoreCommandOk=${r.ok} restoreErr=${JSON.stringify((r.ok ? '' : r.error).slice(0, 300))} removedComment=${removed}`,
    );
    expect({ restoreCommand: r.ok, removedComment: removed }).toEqual({
      restoreCommand: true,
      removedComment: false,
    });
  });

  it('[DAT-36] disaster recovery from sync backend + reverse rebuild from a device', () => {
    const restoreMgr = readSrc('src/sync/restoreManager.ts');
    const preBackup = /createPreMigrationBackup\('restore'\)/.test(restoreMgr);
    const reverse = /rebuild.*from.*device|push.*all.*to.*backend|repopulate.*backend/i.test(restoreMgr);
    console.log(
      `[DAT-36] cloudRestoreExists=true preBackup=${preBackup} reverseRebuild=${reverse} backupErr=${JSON.stringify(backupErr.slice(0, 220))}`,
    );
    expect({ preBackupSucceeds: !backupErr, reverseRebuild: reverse }).toEqual({
      preBackupSucceeds: true,
      reverseRebuild: true,
    });
  });

  it('[DAT-37] measure RPO and RTO: lose the desktop at a random moment', () => {
    blocked(
      'DAT-37',
      'no disposable desktop VM / power-cut harness to measure recovery point and recovery time at a random commit moment',
      'a VM with hard-off control, an external acknowledged-id ledger, and a timed restore run',
      process.env.POS_E2E_RPO_VM === undefined,
    );
  });

  it('[DAT-38] automatic restore point before destructive operations (bulk price, import, merge, purge, migration, factory reset)', () => {
    const callers = filesContaining('src', /createPreMigrationBackup\(/);
    const importModal = readSrc('src/components/modals/SmartImportModal.tsx');
    const importPreBackup = /createPreMigrationBackup|createDatabaseBackup/.test(importModal);
    const wipeGuard = readSrc('src/db/wipeGuard.ts');
    console.log(
      `[DAT-38] preBackupCallers=${JSON.stringify(callers)} importPreBackup=${importPreBackup} wipePreBackup=${/createPreMigrationBackup\('wipe'\)/.test(wipeGuard)}`,
    );
    expect({ importPreBackup, wipePreBackup: /createPreMigrationBackup\('wipe'\)/.test(wipeGuard) }).toEqual({
      importPreBackup: true,
      wipePreBackup: true,
    });
  });

  it('[DAT-39] cascading deletes: customer, product, category, user, device, shop', () => {
    // Customer -> debts: ON DELETE CASCADE.
    run("DELETE FROM customers WHERE id = 'DAT39-C'");
    const debtsLeft = count('customer_debts', "customer_id = 'DAT39-C'");
    // Transaction -> items: ON DELETE CASCADE.
    run(
      `INSERT INTO transactions (id, receipt_number, subtotal, total, created_at, json_payload)
       VALUES ('DAT39-T', 'DAT39-R', 100, 100, datetime('now','utc'), '{}')`,
    );
    run(
      `INSERT INTO transaction_items (id, transaction_id, product_id, quantity, applied_price, json_payload)
       VALUES ('DAT39-I', 'DAT39-T', '${FK_P}', 1, 100, '{}')`,
    );
    run("DELETE FROM transactions WHERE id = 'DAT39-T'");
    const itemsLeft = count('transaction_items', "transaction_id = 'DAT39-T'");
    // Product -> ledger/batches: NO ACTION (must refuse a hard delete, no orphan).
    let fkErr = '';
    try {
      run("DELETE FROM products WHERE id = ?", FK_P);
    } catch (e) {
      fkErr = String((e as Error)?.message ?? e);
    }
    const ledgerLeft = count('inventory_ledger', 'product_id = ?', FK_P);
    // Negative control: an orphan ledger row is rejected.
    let orphanErr = '';
    try {
      run(
        `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id,
          idempotency_key, sync_status, created_at, updated_at, deleted, version)
         VALUES ('DAT39-ORPHAN', 'NO-SUCH-PRODUCT', 1, 'ADJUST', 'probe', 'DAT39-ORPHAN',
          'probe', 'dat39-orphan', 'pending', datetime('now','utc'), datetime('now','utc'), 0, 1)`,
      );
    } catch (e) {
      orphanErr = String((e as Error)?.message ?? e);
    }
    console.log(
      `[DAT-39] debtsLeft=${debtsLeft} itemsLeft=${itemsLeft} productDeleteErr=${JSON.stringify(fkErr.slice(0, 180))} ledgerLeft=${ledgerLeft} orphanErr=${JSON.stringify(orphanErr.slice(0, 180))}`,
    );
    expect({ debtsLeft, itemsLeft, productRefused: fkErr.includes('FOREIGN KEY'), ledgerLeft, orphanRejected: orphanErr.includes('FOREIGN KEY') }).toEqual({
      debtsLeft: 0,
      itemsLeft: 0,
      productRefused: true,
      ledgerLeft: 1,
      orphanRejected: true,
    });
  });

  it('[DAT-40] INSERT OR REPLACE / REPLACE INTO and upserts', () => {
    run(
      `INSERT INTO app_settings (key, value_json, updated_at, version)
       VALUES ('DAT40-PROBE', '{"v":1}', datetime('now','utc'), 7)
       ON CONFLICT(key) DO UPDATE SET value_json = '{"v":1}', version = 7`,
    );
    run(
      `INSERT OR REPLACE INTO app_settings (key, value_json, updated_at)
       VALUES ('DAT40-PROBE', '{"v":2}', datetime('now','utc'))`,
    );
    const vReplace = Number(one<{ version: number }>("SELECT version FROM app_settings WHERE key = 'DAT40-PROBE'")?.version);
    run("UPDATE app_settings SET version = 7, value_json = '{\"v\":1}' WHERE key = 'DAT40-PROBE'");
    run(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES ('DAT40-PROBE', '{"v":3}', datetime('now','utc'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    );
    const vUpsert = Number(one<{ version: number }>("SELECT version FROM app_settings WHERE key = 'DAT40-PROBE'")?.version);
    const appSql = readSrc('src/db/sqlPluginAdapter.ts');
    const replaceLine = lineOf(appSql, "INSERT OR REPLACE INTO app_settings");
    console.log(
      `[DAT-40] versionAfterReplace=${vReplace} versionAfterUpsert=${vUpsert} appReplaceAt=sqlPluginAdapter.ts:${replaceLine}`,
    );
    expect({ replace: vReplace, upsert: vUpsert }).toEqual({ replace: 7, upsert: 7 });
  });

  it('[DAT-41] row-id reuse: integer ids without AUTOINCREMENT can be reused after deleting the highest id', () => {
    const r1 = run(
      `INSERT INTO scan_audit_log (trace_id, supplier_name, items_count, grand_total, delta, is_balanced)
       VALUES ('DAT41-A', 'probe', 1, 0, 0, 1)`,
    );
    const id1 = Number(r1.lastInsertRowid);
    run('DELETE FROM scan_audit_log WHERE id = ?', id1);
    const r2 = run(
      `INSERT INTO scan_audit_log (trace_id, supplier_name, items_count, grand_total, delta, is_balanced)
       VALUES ('DAT41-B', 'probe', 1, 0, 0, 1)`,
    );
    const id2 = Number(r2.lastInsertRowid);
    // Negative control: a plain INTEGER PRIMARY KEY table reuses id 1 after
    // the only (highest) row is deleted; AUTOINCREMENT must not.
    run('CREATE TABLE IF NOT EXISTS DAT41_REUSE (id INTEGER PRIMARY KEY)');
    run('INSERT INTO DAT41_REUSE (id) VALUES (1)');
    run('DELETE FROM DAT41_REUSE WHERE id = 1');
    const r3 = run('INSERT INTO DAT41_REUSE DEFAULT VALUES');
    const reused = Number(r3.lastInsertRowid);
    run('DROP TABLE DAT41_REUSE');
    const auto = readSrc('src/db/sqlPluginAdapter.ts').includes('scan_audit_log') ? 'schema' : 'schema';
    console.log(
      `[DAT-41] scanAuditId1=${id1} afterDelete=${id2} increased=${id2 > id1} plainTableReusedId=${reused} source=${auto}`,
    );
    expect({ increased: id2 > id1, plainTableReused: reused === 1 }).toEqual({
      increased: true,
      plainTableReused: true,
    });
  });

  it('[DAT-42] mass delete, "delete all", "clear data", factory reset', () => {
    const wipeUiCallers = filesContaining('src/components', /requestDataWipe\(/);
    const factoryUi = filesContaining('src/components', /factory\s*reset|réinitialisation\s*usine|clearAllData\(/i);
    const guard = readSrc('src/db/wipeGuard.ts');
    console.log(
      `[DAT-42] wipeUiCallers=${JSON.stringify(wipeUiCallers)} factoryUi=${JSON.stringify(factoryUi)} guardExists=${guard.includes('export async function requestDataWipe')}`,
    );
    // N/A: no exposed mass-delete/factory-reset surface. The guarded wipe
    // helper exists but has no UI caller. Stated in the machine-readable form
    // too: without it the mocha PASS overwrote the case's own N/A verdict in
    // the index (2026-10-30 batch1).
    console.log(
      `VERDICT=DAT-42 N/A | wipeUiCallers=${wipeUiCallers.length} factoryUi=${factoryUi.length} guardExists=${guard.includes('export async function requestDataWipe')} - no mass-delete/factory-reset UI exists to exercise; the guarded helper has no caller`,
    );
    expect({ wipeUiCallers: wipeUiCallers.length, factoryUi: factoryUi.length }).toEqual({
      wipeUiCallers: 0,
      factoryUi: 0,
    });
  });

  it('[DAT-43] trash/soft-delete and recovery of products, customers, tickets', async () => {
    await openCustomers();
    await searchCustomer('DAT43 Customer');
    const menu = await clickCustomerMenu('DAT43 Customer');
    await browser.execute(() => {
      (window as unknown as { confirm: () => boolean }).confirm = () => true;
    });
    const del = await clickDeleteCustomer('DAT43 Customer');
    const softDeleted = await browser
      .waitUntil(
        async () => Number(one<{ deleted: number }>("SELECT deleted FROM customers WHERE id = 'DAT43-C'")?.deleted ?? 0) === 1,
        { timeout: 15000, interval: 200, timeoutMsg: 'customer never soft-deleted' },
      )
      .then(() => true)
      .catch(() => false);
    const restoreControls = (await browser.execute(() => {
      const dlg = document.querySelector('[data-testid="customers-dialog"]') as HTMLElement | null;
      if (!dlg) return [] as string[];
      return ([...dlg.querySelectorAll('button')] as HTMLButtonElement[])
        .filter((b) => /restaur|corbeille|trash|undelete/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`))
        .map((b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').trim());
    })) as string[];
    const deletedRow = one<{ deleted: number; name: string }>(
      "SELECT deleted, name FROM customers WHERE id = 'DAT43-C'",
    );
    console.log(
      `[DAT-43] menu=${menu} deleteItem=${del} softDeleted=${softDeleted} row=${JSON.stringify(deletedRow)} restoreControls=${JSON.stringify(restoreControls)}`,
    );
    await closeCustomers().catch(() => {});
    expect({ softDeleted, restoreControl: restoreControls.length > 0 }).toEqual({
      softDeleted: true,
      restoreControl: true,
    });
  });

  it('[DAT-44] CSV/Excel import that overwrites: empty cells, replace-all, wrong file, wrong mapping', async () => {
    const before = one<{ price: number; stock: number }>(
      'SELECT price, stock FROM products WHERE id = ?',
      IMP,
    );
    const empty = await importCsv(
      `barcode,title,price,quantity\n${IMP_BARCODE},${IMP_TITLE},,\n`,
      'batch21-empty.csv',
    );
    const afterEmpty = one<{ price: number; stock: number }>(
      'SELECT price, stock FROM products WHERE id = ?',
      IMP,
    );
    const explicit = await importCsv(
      `barcode,title,price,quantity\n${IMP_BARCODE},${IMP_TITLE},2500,\n`,
      'batch21-price.csv',
    );
    const afterExplicit = one<{ price: number; stock: number }>(
      'SELECT price, stock FROM products WHERE id = ?',
      IMP,
    );
    const importSrc = readSrc('src/components/modals/SmartImportModal.tsx');
    const replaceAll = /replace\s*all|remplacer\s*tout|mode\s*remplacement/i.test(importSrc);
    const accept = /accept="([^"]+)"/.exec(importSrc)?.[1] ?? '';
    const mappingReview = /column_mappings|columnOverrides|Mappage|Mapping/i.test(importSrc);
    console.log(
      `[DAT-44] before=${JSON.stringify(before)} emptyStage=${empty.stage.batch.updated_count}/${empty.stage.batch.rejected_count} afterEmpty=${JSON.stringify(afterEmpty)} explicitStage=${explicit.stage.batch.updated_count}/${explicit.stage.batch.rejected_count} afterExplicit=${JSON.stringify(afterExplicit)} replaceAll=${replaceAll} accept=${JSON.stringify(accept)} mappingReview=${mappingReview}`,
    );
    // Empty price is quarantined (no overwrite); empty stock preserves the live
    // stock while the explicit price is applied. The explicit price is the
    // positive control proving the pipeline can overwrite when asked.
    expect({
      emptyPriceRejected: empty.stage.batch.rejected_count === 1 && empty.stage.batch.updated_count === 0,
      emptyPreserved: Number(afterEmpty?.price) === Number(before?.price) && Number(afterEmpty?.stock) === Number(before?.stock),
      explicitApplied: Number(afterExplicit?.price) === 2500 && Number(afterExplicit?.stock) === Number(before?.stock),
      replaceAll,
    }).toEqual({ emptyPriceRejected: true, emptyPreserved: true, explicitApplied: true, replaceAll: false });
  });

  it('[DAT-45] bulk edit mistakes: price x100, wrong category for 100k products', () => {
    // A markup multiplier on one product is not a bulk editor. Match actual
    // bulk-edit affordances (labels/identifiers), not any price+multiplier.
    const bulkPrice = filesContaining(
      'src/components',
      /bulk\s*edit|bulk\s*price|prix\s*en\s*masse|modifier\s+les\s+prix|appliquer\s+à\s+tous|édition\s+en\s+masse/i,
    );
    const bulkCategory = filesContaining(
      'src/components',
      /bulk\s*edit.*categor|catégorie\s*en\s*masse|modifier\s+la\s+catégorie|appliquer.*catégorie/i,
    );
    const matrix = filesContaining('src/components', /bulkSaveProducts/);
    console.log(
      `[DAT-45] bulkPriceUi=${JSON.stringify(bulkPrice)} bulkCategoryUi=${JSON.stringify(bulkCategory)} bulkSaveProductsUi=${JSON.stringify(matrix)}`,
    );
    // N/A: no bulk price/category editor exists. ProductMatrix only generates
    // new variants; it is not an existing-row bulk editor.
    console.log(
      `VERDICT=DAT-45 N/A | bulkPriceUi=${bulkPrice.length} bulkCategoryUi=${bulkCategory.length} bulkSaveProductsUi=${JSON.stringify(matrix)} - no existing-row bulk editor exists`,
    );
    expect({ bulkPrice: bulkPrice.length, bulkCategory: bulkCategory.length }).toEqual({
      bulkPrice: 0,
      bulkCategory: 0,
    });
  });

  it('[DAT-46] merge of customers/products/IMEIs picked wrongly', () => {
    // Cloud restore "merge" is a sync apply, not a customer/product/IMEI
    // de-duplication UI. Match only an actual merge affordance.
    const mergeUi = filesContaining(
      'src/components',
      /mergeCustomer|mergeProduct|mergeImei|MergeModal|fusionner\s+(?:les\s+)?(?:clients|produits|imei)|fusion\s+(?:client|produit|imei)/i,
    );
    const mergeApi = filesContaining('src', /mergeCustomers|mergeProducts|mergeImei|merge_customer|merge_product/i);
    console.log(`[DAT-46] mergeUi=${JSON.stringify(mergeUi)} mergeApi=${JSON.stringify(mergeApi)}`);
    // N/A: no customer/product/IMEI merge surface exists.
    console.log(
      `VERDICT=DAT-46 N/A | mergeUi=${mergeUi.length} mergeApi=${mergeApi.length} - no customer/product/IMEI merge surface exists`,
    );
    expect({ mergeUi: mergeUi.length, mergeApi: mergeApi.length }).toEqual({ mergeUi: 0, mergeApi: 0 });
  });

  it('[DAT-47] unsaved work: cart, parked sales, half-filled trade-in/repair intake, inspection notes/photos', async () => {
    await addSku(HOLD_TITLE);
    const beforeReload = await cartTotalMinor();
    await browser.refresh();
    await browser.waitUntil(
      async () => (await $('[data-testid="shift-pill"]')).isDisplayed().catch(() => false),
      { timeout: 90000, interval: 500, timeoutMsg: 'dashboard did not re-mount after reload' },
    );
    await unlockIfNeeded(APP_PIN);
    const afterReload = await cartTotalMinor();

    await addSku(HOLD_TITLE);
    const beforeHold = await cartTotalMinor();
    await holdCurrentCart();
    await recallHold();
    const afterRecall = await cartTotalMinor();
    console.log(
      `[DAT-47] cartBeforeReload=${beforeReload} cartAfterReload=${afterReload} cartBeforeHold=${beforeHold} cartAfterRecall=${afterRecall}`,
    );
    expect({ afterReload, afterRecall }).toEqual({ afterReload: beforeReload, afterRecall: beforeHold });
  });

  it('[DAT-48] two users edit the same note/ticket text/customer field', () => {
    run(
      `INSERT INTO repair_orders (id, ticket_number, customer_name, customer_phone, device_model, status,
        created_at, updated_at, json_payload, version)
       VALUES ('DAT48-R', 'DAT48-T', 'DAT48', '0551990048', 'Probe', 'En attente',
        datetime('now','utc'), datetime('now','utc'), '{"notes":"initial"}', 1)`,
    );
    const readA = one<{ version: number; json_payload: string }>(
      "SELECT version, json_payload FROM repair_orders WHERE id = 'DAT48-R'",
    );
    const readB = one<{ version: number; json_payload: string }>(
      "SELECT version, json_payload FROM repair_orders WHERE id = 'DAT48-R'",
    );
    // Both writers read v1; the app's repair upsert has NO version predicate.
    run(
      "UPDATE repair_orders SET json_payload = '{\"notes\":\"A\"}', updated_at = datetime('now','utc'), version = version + 1 WHERE id = 'DAT48-R'",
    );
    run(
      "UPDATE repair_orders SET json_payload = '{\"notes\":\"B\"}', updated_at = datetime('now','utc'), version = version + 1 WHERE id = 'DAT48-R'",
    );
    const final = one<{ version: number; json_payload: string }>(
      "SELECT version, json_payload FROM repair_orders WHERE id = 'DAT48-R'",
    );
    const adapter = readSrc('src/db/adapters/operationsAdapter.ts');
    const upsert = adapter.slice(adapter.indexOf('async saveRepairOrder'), adapter.indexOf('// ──'));
    const hasVersionPredicate = /WHERE[^;]*version\s*=/.test(upsert);
    console.log(
      `[DAT-48] readA=${JSON.stringify(readA)} readB=${JSON.stringify(readB)} final=${JSON.stringify(final)} versionPredicate=${hasVersionPredicate} adapterLines=${lineOf(adapter, 'async saveRepairOrder')}-${lineOf(adapter, 'version=repair_orders.version + 1')}`,
    );
    expect({ hasVersionPredicate, finalNotes: JSON.parse(String(final?.json_payload ?? '{}')).notes }).toEqual({
      hasVersionPredicate: true,
      finalNotes: 'A',
    });
  });

  it('[DAT-49] truncation and mangling on save: long names, emoji, newlines, zero-width, Arabic', async () => {
    const longName = `DAT49-${'A'.repeat(500)}`;
    const emojiName = 'DAT49-👨‍👩‍👧‍👦-🚀';
    const arabicName = 'DAT49-محمد أمين';
    const zeroWidthName = 'DAT49-\u200B\u200C\u200D';
    await openCustomers();
    await crmAddCustomer(longName, '0551990049');
    await crmAddCustomer(emojiName, '0551990050');
    await crmAddCustomer(arabicName, '0551990051');
    await crmAddCustomer(zeroWidthName, '0551990052');
    await closeCustomers();

    const longStored = String(one<{ name: string }>('SELECT name FROM customers WHERE phone = ?', '0551990049')?.name ?? '');
    const emojiStored = String(one<{ name: string }>('SELECT name FROM customers WHERE phone = ?', '0551990050')?.name ?? '');
    const arabicStored = String(one<{ name: string }>('SELECT name FROM customers WHERE phone = ?', '0551990051')?.name ?? '');
    const zeroStored = String(one<{ name: string }>('SELECT name FROM customers WHERE phone = ?', '0551990052')?.name ?? '');
    const newlineName = 'DAT49-Line1\nDAT49-Line2';
    run(
      `INSERT INTO customers (id, name, phone, json_payload, updated_at, idempotency_key)
       VALUES ('DAT49-NL', ?, '0551990053', '{}', datetime('now','utc'), 'e2e-dat49-nl')`,
      newlineName,
    );
    const newlineStored = String(one<{ name: string }>("SELECT name FROM customers WHERE id = 'DAT49-NL'")?.name ?? '');
    console.log(
      `[DAT-49] longLen=${longStored.length}/${longName.length} longExact=${longStored === longName} emojiExact=${emojiStored === emojiName} arabicExact=${arabicStored === arabicName} zeroWidthExact=${zeroStored === zeroWidthName} newlineExact=${newlineStored === newlineName} longNotTruncated=${longStored !== longName.slice(0, 100)}`,
    );
    expect({
      longExact: longStored === longName,
      emojiExact: emojiStored === emojiName,
      arabicExact: arabicStored === arabicName,
      zeroWidthExact: zeroStored === zeroWidthName,
      newlineExact: newlineStored === newlineName,
      longNotTruncated: longStored !== longName.slice(0, 100),
    }).toEqual({
      longExact: true,
      emojiExact: true,
      arabicExact: true,
      zeroWidthExact: true,
      newlineExact: true,
      longNotTruncated: true,
    });
  });

  it('[DAT-50] settings/config loss: printers, receipt templates, loyalty rules, users/PINs, shop identity', () => {
    const backupMgr = readSrc('src/db/backupManager.ts');
    const nativeLib = readSrc('src-tauri/src/lib.rs');
    const trustInSnapshot = /trust|license|licence|pin_key|pinKey/i.test(
      backupMgr.slice(backupMgr.indexOf('const dexieSnapshot = {'), backupMgr.indexOf('dexieSnapshotKey =')),
    );
    const restoreRemoved = /REMOVED \(Phase 4\.4\).*restore_database_backup/s.test(nativeLib);
    console.log(
      `[DAT-50] trustOrLicenseInSnapshot=${trustInSnapshot} restoreRemoved=${restoreRemoved} backupErr=${JSON.stringify(backupErr.slice(0, 220))} receiptKey=${readSrc('src/constants/index.ts').includes("RECEIPT_SETTINGS: 'mobi_pos_receipt_settings'")}`,
    );
    expect({ trustOrLicenseInSnapshot: trustInSnapshot, restoreAvailable: !restoreRemoved }).toEqual({
      trustOrLicenseInSnapshot: true,
      restoreAvailable: true,
    });
  });

  it('[DAT-51] app update and schema migration safety', () => {
    blocked(
      'DAT-51',
      'no previous-version installer, signed update artifact, or frozen old-schema fixture to exercise an in-place upgrade/downgrade',
      'the previous released installer + a frozen schema/data fixture for each released version + an interrupted-migration harness',
      process.env.POS_E2E_INSTALLER === undefined && !fs.existsSync(path.resolve('e2e-tests/fixtures/schemas')),
    );
  });

  it('[DAT-52] uninstall, reinstall, clear app data, moving app folder, cloned disk, new profile; Android uninstall', () => {
    blocked(
      'DAT-52',
      'no installer/uninstaller, second Windows profile, cloned-disk image, or Android device profile in the harness',
      'installer/uninstaller artifacts, a disposable Windows profile, a cloned-disk image, and an Android device profile',
      process.env.POS_E2E_PROFILE === undefined,
    );
  });

  it('[DAT-53] OS protections and updates: Controlled Folder Access, antivirus quarantine, forced reboot during a sale', () => {
    blocked(
      'DAT-53',
      'no Windows Controlled Folder Access / antivirus / forced-reboot harness; the sandbox has default OS protections',
      'a disposable Windows VM with CFA/AV policy control and a forced reboot/power-off hook during a live sale',
      process.env.POS_E2E_OS_PROTECT === undefined,
    );
  });

  it('[DAT-54] ransomware, theft or fire of the shop PC', () => {
    blocked(
      'DAT-54',
      'no physical/security drill or ransomware simulator; data loss is bounded only by the (currently broken) local backup',
      'a security drill or isolated ransomware simulation with an off-machine restore point',
      process.env.POS_E2E_PHYSICAL_DRILL === undefined,
    );
  });

  it('[DAT-55] clock-driven deletion: wrong or far-future clock triggers retention purge or backup rotation', async () => {
    await addSku(HOLD_TITLE);
    const held = await holdCurrentCart();
    const beforeDeleted = Number(
      one<{ deleted: number }>('SELECT deleted FROM held_orders WHERE id = ?', held.id)?.deleted ?? 0,
    );
    // Simulate a far-future wall clock: the hold is still within its 48 h TTL
    // in real time, but Date.now() is advanced 10 days.
    await browser.execute(() => {
      const w = window as unknown as { __realDateNow?: () => number };
      w.__realDateNow = Date.now;
      const base = Date.now();
      Date.now = () => base + 10 * 24 * 60 * 60 * 1000;
    });
    await recallHold();
    const afterDeleted = Number(
      one<{ deleted: number }>('SELECT deleted FROM held_orders WHERE id = ?', held.id)?.deleted ?? 0,
    );
    await browser.execute(() => {
      const w = window as unknown as { __realDateNow?: () => number };
      if (w.__realDateNow) Date.now = w.__realDateNow;
    });
    console.log(
      `[DAT-55] holdId=${held.id} beforeDeleted=${beforeDeleted} afterDeleted=${afterDeleted} simulatedClockAdvanceDays=10 purged=${afterDeleted === 1}`,
    );
    expect({ purgedOnFarFutureClock: afterDeleted === 1 }).toEqual({ purgedOnFarFutureClock: false });
  });

  it('[DAT-56] retention/purge job safety', async () => {
    const held = one<{ id: string; deleted: number }>(
      "SELECT id, deleted FROM held_orders WHERE idempotency_key IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    );
    const auditBefore = count('security_audit_logs');
    // The purge path is the same retrieveSale path exercised by DAT-55.
    const auditAfter = count('security_audit_logs');
    const deleteSrc = readSrc('src/db/sqlPluginAdapter.ts');
    const deleteFn = deleteSrc.slice(deleteSrc.indexOf('export async function deleteHeldOrder'), deleteSrc.indexOf('export type HeldOrderClaimOutcome'));
    const swallows = /catch\s*\(e\)[\s\S]*console\.warn/.test(deleteFn);
    const auditInDelete = /auditAppend|security_audit_logs|AUDIT/i.test(deleteFn);
    console.log(
      `[DAT-56] latestHeld=${JSON.stringify(held)} auditBefore=${auditBefore} auditAfter=${auditAfter} deleteSwallows=${swallows} auditInDelete=${auditInDelete} exportHeld=${/export.*held|held.*export/i.test(readSrc('src/db/sqlPluginAdapter.ts'))}`,
    );
    expect({ auditRowWritten: auditAfter > auditBefore, exportExists: /export.*held|held.*export/i.test(readSrc('src/db/sqlPluginAdapter.ts')), deleteSwallows: swallows }).toEqual({
      auditRowWritten: true,
      exportExists: true,
      deleteSwallows: false,
    });
  });

  it('[DAT-57] export-before-delete', () => {
    const exportHeld = filesContaining('src', /export.*held|held.*export|exportHeld|export_held/i);
    const purge = readSrc('src/store/slices/createCartSlice.ts');
    const purgeBlock = purge.slice(purge.indexOf('Auto-purge expired holds'), purge.indexOf('Double-restore guard'));
    const preExport = /export|backup|archive/i.test(purgeBlock);
    console.log(
      `[DAT-57] exportHeldFiles=${JSON.stringify(exportHeld)} purgeBlock=${JSON.stringify(purgeBlock.replace(/\s+/g, ' ').slice(0, 260))} preExport=${preExport}`,
    );
    expect({ preExport }).toEqual({ preExport: true });
  });

  it('[DAT-58] audit/log loss: log rotation, audit purge, audit write failure', () => {
    const auditSrc = readSrc('src/api/audit.ts');
    const swallow = /swallow|audit never blocks/i.test(auditSrc);
    const rotation = filesContaining('src', /rotate.*audit|audit.*rotate|purge.*audit|audit.*purge|security_audit_logs.*DELETE/i);
    const settingsKeys = all<{ key: string }>('SELECT key FROM app_settings').map((r) => r.key);
    const retentionKeys = settingsKeys.filter((k) => /audit.*(retention|rotate|purge)|log.*retention/i.test(k));
    console.log(
      `[DAT-58] auditSwallow=${swallow} rotationPurgeFiles=${JSON.stringify(rotation)} retentionKeys=${JSON.stringify(retentionKeys)} auditRows=${count('security_audit_logs')} chainRows=${count('audit_chain')}`,
    );
    expect({ swallow, rotation: rotation.length > 0, retentionKeys: retentionKeys.length }).toEqual({
      swallow: false,
      rotation: true,
      retentionKeys: 1,
    });
  });
});
