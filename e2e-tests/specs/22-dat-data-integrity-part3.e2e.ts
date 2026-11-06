/**
 * DAT — data integrity / durability matrix, part 3 (batch 22).
 *
 * Covers DAT-59 … DAT-89: connection-pool hygiene, multi-connection sales,
 * sync-loss / tombstone / last-copy risks, recovery reconciliation, files
 * outside the DB, canaries, full export, backup destinations, online backup,
 * cross-version restore, multi-file atomicity, external tools, image copies,
 * cloned identities, owner lockout, licence lapse, retention, selective
 * restore, external witnesses, mass wipe, ledger immutability, destructive
 * migrations, staff-error/power, Android, bit rot and identifier round-trip.
 *
 * Verdict policy (same as batches 20/21):
 *   PASS = observed behaviour satisfies the case (with a real control).
 *   FAIL = observed behaviour is wrong or a required control is absent;
 *          the assertion states the expected value, so the failure itself is
 *          the expected-vs-actual evidence.
 *   N/A  = the feature itself does not exist; an executed absence probe is
 *          logged and the report carries file:line.
 *   BLOCKED = exact missing resource logged; the case stays in Remaining.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import BetterSqlite3 from 'better-sqlite3';
import { all, count, one, openDb, run, waitForSchemaSettled } from '../lib/db';
import { invokeRaw } from '../lib/invoke';
import {
  APP_PIN,
  clearWebMirrors,
  displayedToMinor,
  installErrorTrap,
  tid,
  typeMoneyInto,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCustomerFull, seedProducts } from '../lib/seed';
import { SANDBOX_LOCAL, SANDBOX_ROAMING } from '../lib/env';

const P59 = 'DAT59-P';
const P60 = 'DAT60-P';
const P82 = 'DAT82-P';
const P88 = 'DAT88-P';
const C88 = '9007199254740993';

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(rel), 'utf8');
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

async function sqlExec(query: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await tryInvokeRaw('plugin:sql|execute', {
    db: 'sqlite:mobi_pos.db',
    query,
    values: [],
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

async function sqlSelect<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const r = await tryInvokeRaw<T[]>('plugin:sql|select', {
    db: 'sqlite:mobi_pos.db',
    query,
    values: [],
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
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

async function clickByText(text: string): Promise<boolean> {
  return (await browser.execute((t: string) => {
    const el = Array.from(document.querySelectorAll('button')).find((b) =>
      ((b.textContent || '').trim() || '').includes(t),
    );
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, text)) as boolean;
}

async function waitForText(text: string, timeout = 15000): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => (await browser.execute((t: string) => document.body.innerText.includes(t), text)) as boolean,
      { timeout, interval: 250 },
    );
    return true;
  } catch {
    return false;
  }
}

async function runStressBatch(productId: string, qty: number, tenderedDa: number): Promise<{
  ok: boolean;
  ms: number;
  reason?: string;
}> {
  const res = (await browser.execute(
    async (id: string, q: number, t: number) => {
      const w = window as unknown as {
        __posStress?: {
          runBatch: (
            b: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
          ) => Promise<Array<{ ok: boolean; ms: number; reason?: string }>>;
        };
      };
      if (!w.__posStress) return [{ ok: false, ms: 0, reason: 'NO_STRESS_HOOK' }];
      return await w.__posStress.runBatch([{ lines: [{ id, qty: q }], tenderedDa: t }]);
    },
    productId,
    qty,
    tenderedDa,
  )) as Array<{ ok: boolean; ms: number; reason?: string }>;
  return res[0] ?? { ok: false, ms: 0, reason: 'NO_RESULT' };
}

describe('DAT-59…DAT-89 — data integrity, part 3', () => {
  before(async () => {
    await unlockIfNeeded(APP_PIN);
    await waitForSchemaSettled();
    await installErrorTrap();
    await resetData();
    seedProducts([
      { id: P59, title: 'DAT59 Product', priceDa: 1000, stock: 20, barcode: '6130000000591', costDa: 500 },
      { id: P60, title: 'DAT60 Product', priceDa: 1000, stock: 20, barcode: '6130000000601', costDa: 500 },
      { id: P82, title: 'DAT82 Product', priceDa: 100, stock: 5, barcode: '6130000000821', costDa: 50 },
      {
        id: P88,
        title: 'DAT88 Product',
        priceDa: 1000,
        stock: 10,
        barcode: '0001234567890',
        costDa: 500,
        isSerialized: true,
        imeiNumber: '000123456789012',
      },
    ]);
    seedCustomerFull([{ id: C88, name: 'DAT88 Client', phone: '0555000000' }]);
    await clearWebMirrors();
    await browser.waitUntil(
      async () => (await $('[data-testid="shift-pill"]')).isDisplayed().catch(() => false),
      { timeout: 90000, interval: 500, timeoutMsg: 'dashboard did not re-mount after mirror reload' },
    );
    await unlockIfNeeded(APP_PIN);
    await openShiftJs(10000);
  });

  it('[DAT-59] connection-pool hygiene: an error mid-transaction leaves no open transaction', async () => {
    const errors: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await tryInvokeRaw('checkout_sale_atomic', {});
      errors.push(r.ok ? 'OK_UNEXPECTED' : r.error.slice(0, 120));
    }
    const sale = await runStressBatch(P59, 1, 1000);
    // Transactions live on the native side after the flip, so hygiene is
    // measured there: a failed command must not leave the native connection in
    // an open transaction. A leaked BEGIN shows up as this write failing with
    // "cannot start a transaction within a transaction" (or being refused).
    const probeId = `DAT59-PROBE-${Date.now()}`;
    const writeAfter = await tryInvokeRaw('upsert_store_expense', {
      request: {
        id: probeId,
        category: 'Test',
        title: 'DAT-59 hygiene probe',
        amount: 1,
        paymentMethod: 'Espèces',
        paidTo: null,
        notes: null,
        recordedBy: 'e2e',
        createdAt: new Date().toISOString(),
        jsonPayload: JSON.stringify({ id: probeId }),
      },
    });
    const selectAfter = await sqlSelect('SELECT 1 AS one');
    const wrote = Number(count('store_expenses', 'id = ?', probeId));
    if (wrote > 0) run('DELETE FROM store_expenses WHERE id = ?', probeId);
    const leaked = !writeAfter.ok || wrote !== 1;
    console.log(
      `[DAT-59] invalidCalls=5 errors=${JSON.stringify(errors)} validSaleOk=${sale.ok} saleMs=${Math.round(sale.ms)} ` +
        `writeAfterFailures=${JSON.stringify(writeAfter)} probeRows=${wrote} selectAfter=${JSON.stringify(selectAfter)} leaked=${leaked}`,
    );
    expect(leaked).toBe(false);
    expect(sale.ok).toBe(true);
  });

  it('[DAT-60] sale under a held write lock waits and commits as one transaction', async () => {
    const locker = openDb();
    const before = Number(count('transactions'));
    locker.exec('BEGIN IMMEDIATE');
    locker
      .prepare(
        "INSERT INTO app_settings (key, value_json, updated_at, version) VALUES ('dat60_lock', '1', datetime('now'), 1) ON CONFLICT(key) DO UPDATE SET value_json='1'",
      )
      .run();
    const salePromise = runStressBatch(P60, 1, 1000);
    await new Promise((r) => setTimeout(r, 1200));
    locker.exec('COMMIT');
    const sale = await salePromise;
    const after = Number(count('transactions'));
    const partial = Number(
      count('transactions', "id NOT IN (SELECT DISTINCT transaction_id FROM transaction_items WHERE transaction_id IS NOT NULL)"),
    );
    locker.close();
    console.log(
      `[DAT-60] saleOk=${sale.ok} saleMs=${Math.round(sale.ms)} reason=${JSON.stringify(sale.reason ?? '')} txBefore=${before} txAfter=${after} partialTx=${partial}`,
    );
    expect(sale.ok).toBe(true);
    expect(after).toBe(before + 1);
    expect(partial).toBe(0);
  });

  it('[DAT-61] sync loss: remote overwrite of unsynced local rows / re-bootstrap with non-empty outbox', () => {
    const gw = one<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = 'sync.gateway_url'");
    const pending = Number(count('sync_outbox', "status IN ('pending','inflight')"));
    const gateway = gw?.value_json ?? null;
    blocked(
      'DAT-61',
      `no configured merchant gateway (sync.gateway_url=${JSON.stringify(gateway)}) and no second device/remote replica to overwrite local rows; local outbox pending=${pending}`,
      'a configured test gateway + a remote replica that can be re-bootstrapped while the local outbox is non-empty',
      !gateway || gateway === 'null' || gateway === '""' || gateway === '',
    );
  });

  it('[DAT-62] mass deletes / corrupted tombstones propagating to every device', () => {
    const pending = Number(count('sync_outbox', "status IN ('pending','inflight')"));
    const gw = one<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = 'sync.gateway_url'");
    blocked(
      'DAT-62',
      `single-device sandbox (outbox pending=${pending}, gateway=${JSON.stringify(gw?.value_json ?? null)}); no second enrolled device to receive a mass delete/tombstone batch`,
      'two enrolled terminals plus a gateway that can fan out a mass-delete/tombstone batch',
      true,
    );
  });

  it('[DAT-63] last-copy risk: days of unsynced sales warn before the 500-mutation threshold', async () => {
    const allPending = Number(count('sync_outbox', "status IN ('pending','inflight')"));
    const seedOutbox = (n: number, signed: boolean): void => {
      run("DELETE FROM sync_outbox WHERE status IN ('pending','inflight')");
      const db = openDb();
      const stmt = db.prepare(
        "INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, retry_count, created_at, updated_at, device_id, seq_no) VALUES (?,?,?,?,?,'pending',0,datetime('now'),datetime('now'),'e2e',?)",
      );
      const tx = db.transaction(() => {
        for (let i = 0; i < n; i++) {
          const key = `dat63-${signed ? 's' : 'u'}-${i}`;
          stmt.run(key, 'order', key, 'UPSERT', '{}', signed ? i + 1 : null);
        }
      });
      tx();
      db.close();
    };
    const reload = async (): Promise<void> => {
      await clearWebMirrors();
      await browser.waitUntil(
        async () => (await $('[data-testid="shift-pill"]')).isDisplayed().catch(() => false),
        { timeout: 90000, interval: 500 },
      );
      await unlockIfNeeded(APP_PIN);
    };

    // Control: 501 SIGNED rows (the drain lane) must raise the banner.
    seedOutbox(501, true);
    await reload();
    const signedBanner = await waitForText('Backlog sync', 30000);

    // Risk: 501 UNSIGNED rows (legacy Turso lane when the drain is unarmed)
    // are the same unsynced sales but are invisible to the banner.
    seedOutbox(501, false);
    await reload();
    const unsignedBanner = await waitForText('Backlog sync', 20000);

    const bottomSrc = readSrc('src/components/BottomBar.tsx');
    const ageWarning = /outboxPendingCount[\s\S]{0,400}(jour|day|age|ancien)/i.test(bottomSrc);
    const backupOk = (await tryInvokeRaw('create_database_backup', { kind: 'manual' })).ok;
    console.log(
      `[DAT-63] pendingBefore=${allPending} signedBanner=${signedBanner} unsignedBanner=${unsignedBanner} ageWarning=${ageWarning} backupOk=${backupOk}`,
    );
    expect({ signedBanner, unsignedBanner, ageWarning, backupOk }).toEqual({
      signedBanner: true,
      unsignedBanner: true,
      ageWarning: true,
      backupOk: true,
    });
  });

  it('[DAT-64] reconciliation after any recovery (restore, salvage, resync)', () => {
    const restore = fs.readFileSync(path.resolve('src-tauri/src/lib.rs'), 'utf8');
    const removed = restore.includes('REMOVED (Phase 4.4): `restore_database_backup`');
    const recon = fs.readFileSync(path.resolve('src/sync/restoreManager.ts'), 'utf8');
    blocked(
      'DAT-64',
      `restore/swap is removed from the native handler (removed=${removed}); no recovery event exists to reconcile (restoreManager has no post-restore reconciliation report: ${recon.includes('reconcil')})`,
      'a working restore/salvage path plus a reconciliation report (row counts, missing ids, ledger deltas)',
      removed,
    );
  });

  it('[DAT-65] files outside the DB (photos, ID scans, PDFs): backup, restore, orphan cleanup', async () => {
    const attDir = path.join(SANDBOX_ROAMING, 'com.mobi.pos.e2e', 'sav_attachments');
    fs.mkdirSync(attDir, { recursive: true });
    const file = path.join(attDir, 'dat65-photo.webp');
    fs.writeFileSync(file, Buffer.from('RIFF....WEBPVP8 ', 'utf8'));
    const attachmentTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%attachment%' OR name LIKE '%photo%')",
    ).map((r) => r.name);
    const backup = await tryInvokeRaw('create_database_backup', { kind: 'manual' });
    const list = await tryInvokeRaw<string[]>('list_database_backups', {});
    const backupDbFiles = fs.existsSync(path.join(SANDBOX_LOCAL, 'com.mobi.pos.e2e', 'backups'))
      ? fs
          .readdirSync(path.join(SANDBOX_LOCAL, 'com.mobi.pos.e2e', 'backups'))
          .filter((n) => n.endsWith('.db'))
      : [];
    fs.rmSync(file, { force: true });
    console.log(
      `[DAT-65] attachmentFile=true attachmentTables=${JSON.stringify(attachmentTables)} backupOk=${backup.ok} backupErr=${JSON.stringify(backup.ok ? '' : backup.error.slice(0, 140))} listed=${list.ok ? list.value.length : 'ERR'} backupDbFiles=${backupDbFiles.length}`,
    );
    expect(backup.ok).toBe(true);
    expect(backupDbFiles.length).toBeGreaterThan(0);
  });

  it('[DAT-66] canary records: a synthetic sale/product with a known id written daily', () => {
    const canaryTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%canary%'",
    ).map((r) => r.name);
    const canarySettings = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%canary%' OR value_json LIKE '%canary%'",
    ).map((r) => r.key);
    const schemaHeal = readSrc('src/db/schemaHeal.ts');
    const businessCanary = /canary/i.test(schemaHeal) && /(INSERT INTO (products|transactions)|synthetic sale)/i.test(schemaHeal);
    console.log(
      `[DAT-66] canaryTables=${JSON.stringify(canaryTables)} canarySettings=${JSON.stringify(canarySettings)} businessCanary=${businessCanary}`,
    );
    expect(canaryTables.length).toBe(0);
    expect(canarySettings.length).toBe(0);
    expect(businessCanary).toBe(false);
  });

  it('[DAT-67] full export on demand (SQL dump or CSV, open format)', async () => {
    // Capture the real export blob without writing a browser download: patch
    // URL.createObjectURL + anchor click, then drive the real settings UI.
    await clickByText('Paramètres');
    const tabOk = await waitForText('Base de Données & Sauvegarde', 20000);
    if (tabOk) await clickByText('Base de Données & Sauvegarde');
    const exportBtnOk = await waitForText('Télécharger Sauvegarde JSON', 20000);
    await browser.execute(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__dat67Text = null;
      w.__dat67Name = null;
      const origCreate = URL.createObjectURL.bind(URL);
      w.__dat67OrigCreate = origCreate;
      URL.createObjectURL = (blob: Blob) => {
        blob
          .text()
          .then((t) => {
            w.__dat67Text = t;
          })
          .catch(() => {});
        return 'blob:dat67-captured';
      };
      const origClick = HTMLAnchorElement.prototype.click;
      w.__dat67OrigClick = origClick;
      HTMLAnchorElement.prototype.click = function () {
        w.__dat67Name = (this as HTMLAnchorElement).download || null;
      };
    });
    if (exportBtnOk) await clickByText('Télécharger Sauvegarde JSON');
    await (await $(tid('pin-gate-input'))).waitForDisplayed({ timeout: 20000 });
    await (await $(tid('pin-gate-input'))).setValue(APP_PIN);
    await (await $(tid('pin-gate-submit'))).click();
    let text: string | null = null;
    try {
      await browser.waitUntil(
        async () => {
          text = (await browser.execute(() => {
            const w = window as unknown as Record<string, unknown>;
            return (w.__dat67Text as string | null) ?? null;
          })) as string | null;
          return Boolean(text);
        },
        { timeout: 30000, interval: 500 },
      );
    } catch {
      text = null;
    }
    const name = (await browser.execute(() => {
      const w = window as unknown as Record<string, unknown>;
      return (w.__dat67Name as string | null) ?? null;
    })) as string | null;
    await browser.execute(() => {
      const w = window as unknown as Record<string, unknown>;
      if (typeof w.__dat67OrigCreate === 'function') URL.createObjectURL = w.__dat67OrigCreate as typeof URL.createObjectURL;
      if (typeof w.__dat67OrigClick === 'function') HTMLAnchorElement.prototype.click = w.__dat67OrigClick as () => void;
    });
    await browser.keys(['Escape']);
    await browser.keys(['Escape']);
    const keys = text ? Object.keys(JSON.parse(text)) : [];
    const hasBusiness =
      keys.includes('products') &&
      keys.includes('customers') &&
      keys.includes('transactions') &&
      keys.includes('repairOrders') &&
      keys.includes('settings');
    const excludesCredentials = text ? !text.includes('manager_pin') && !text.includes('cashier_users') : false;
    const outboxRowsIncluded = text ? text.includes('"outboxRows"') : false;
    console.log(
      `[DAT-67] settingsTab=${tabOk} exportBtn=${exportBtnOk} downloadName=${JSON.stringify(name)} bytes=${text?.length ?? 0} keys=${JSON.stringify(keys)} hasBusiness=${hasBusiness} excludesCredentials=${excludesCredentials} outboxRowsIncluded=${outboxRowsIncluded} sqlDump=false`,
    );
    expect(hasBusiness).toBe(true);
    expect(excludesCredentials).toBe(true);
  });

  it('[DAT-68] backup destination limits: FAT32/exFAT/NTFS, long paths, Arabic names, read-only/full media, network share', () => {
    const destKeys = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%backup%' OR key LIKE '%destination%' OR key LIKE '%usb%' OR key LIKE '%network%'",
    ).map((r) => r.key);
    const backupSrc = readSrc('src-tauri/src/lib.rs');
    const localOnly = /app_local_data_dir\(\)[\s\S]{0,80}join\("backups"\)/.test(backupSrc);
    console.log(
      `[DAT-68] destinationKeys=${JSON.stringify(destKeys)} localOnly=${localOnly} mediaProbe=${JSON.stringify(process.env.POS_E2E_BACKUP_MEDIA ?? null)}`,
    );
    expect(destKeys.length).toBe(0);
    expect(localOnly).toBe(true);
  });

  it('[DAT-69] online backup of a busy DB (backup API restart / VACUUM INTO snapshot)', async () => {
    const locker = openDb();
    locker.exec('BEGIN IMMEDIATE');
    locker
      .prepare(
        "INSERT INTO app_settings (key, value_json, updated_at, version) VALUES ('dat69_lock', '1', datetime('now'), 1) ON CONFLICT(key) DO UPDATE SET value_json='1'",
      )
      .run();
    const backup = await tryInvokeRaw('create_database_backup', { kind: 'manual' });
    locker.exec('COMMIT');
    locker.close();
    const backupsDir = path.join(SANDBOX_LOCAL, 'com.mobi.pos.e2e', 'backups');
    const dbFiles = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter((n) => n.endsWith('.db'))
      : [];
    console.log(
      `[DAT-69] backupOk=${backup.ok} backupErr=${JSON.stringify(backup.ok ? '' : backup.error.slice(0, 180))} dbFiles=${dbFiles.length}`,
    );
    expect(backup.ok).toBe(true);
    expect(dbFiles.length).toBeGreaterThan(0);
  });

  it('[DAT-70] cross-version restore (old backup on new app / new backup on old app)', () => {
    const backupsDir = path.join(SANDBOX_LOCAL, 'com.mobi.pos.e2e', 'backups');
    const dbFiles = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter((n) => n.endsWith('.db'))
      : [];
    blocked(
      'DAT-70',
      `no previous-version installer or frozen old-schema backup artifact (backups=${dbFiles.length})`,
      'the previous released installer, a frozen old-schema backup fixture, and a cross-version restore harness',
      dbFiles.length === 0,
    );
  });

  it('[DAT-71] multi-file atomicity: two DBs / ATTACH / separate audit DB', () => {
    const attached = all<{ name: string }>("SELECT name FROM pragma_database_list");
    const dbFiles = fs
      .readdirSync(path.join(SANDBOX_ROAMING, 'com.mobi.pos.e2e'))
      .filter((n) => n.endsWith('.db'));
    const attachSrc = readSrc('src-tauri/src/lib.rs').includes('ATTACH DATABASE');
    console.log(
      `[DAT-71] databases=${JSON.stringify(attached)} dbFiles=${JSON.stringify(dbFiles)} attachInSource=${attachSrc}`,
    );
    expect(attached.map((d) => d.name)).toEqual(['main']);
    expect(attachSrc).toBe(false);
  });

  it('[DAT-72] external tools on a copy (DB Browser, Recuva, WAL forensics)', () => {
    blocked(
      'DAT-72',
      'no DB Browser/Recuva/WAL-forensics harness in the sandbox; the harness only opens copies with better-sqlite3',
      'a disposable copy of the data dir plus DB Browser, Recuva and a WAL-forensics tool run against it',
      process.env.POS_E2E_EXTERNAL_TOOLS === undefined,
    );
  });

  it('[DAT-73] image-level copies (VSS, VM snapshot, disk clone) taken during a sale', () => {
    blocked(
      'DAT-73',
      'no VSS/VM snapshot or disk-clone harness; the sandbox is a single directory, not a block device',
      'a disposable VM/volume with VSS or snapshot control taken during a live sale',
      process.env.POS_E2E_VSS === undefined,
    );
  });

  it('[DAT-74] duplicate device identity: cloned disk/VM carries the same device_id', async () => {
    const native = one<{ device_id: string }>('SELECT device_id FROM device_identity LIMIT 1');
    const setting = one<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = 'sync.device_id'");
    const adopted = setting ? (JSON.parse(setting.value_json) as string) : null;
    const cols = all<{ name: string }>('PRAGMA table_info(device_identity)').map((c) => c.name);
    const machineCols = cols.filter((c) => /machine|host|hardware|uuid|serial/i.test(c));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dat74-'));
    const clone = path.join(tmp, 'mobi_pos_clone.db');
    const src = openDb();
    await src.backup(clone);
    src.close();
    const cloned = openDb(clone);
    const cloneRow = cloned.prepare('SELECT device_id FROM device_identity LIMIT 1').get() as
      | { device_id: string }
      | undefined;
    const cloneSetting = cloned
      .prepare("SELECT value_json FROM app_settings WHERE key = 'sync.device_id'")
      .get() as { value_json: string } | undefined;
    cloned.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    const cloneId = cloneRow?.device_id ?? null;
    const cloneAdopted = cloneSetting ? (JSON.parse(cloneSetting.value_json) as string) : null;
    const sameAfterClone = native?.device_id === cloneId;
    const cloneDetected = sameAfterClone === false;
    console.log(
      `[DAT-74] nativeId=${JSON.stringify(native?.device_id ?? null)} adopted=${JSON.stringify(adopted)} cloneId=${JSON.stringify(cloneId)} cloneAdopted=${JSON.stringify(cloneAdopted)} sameAfterClone=${sameAfterClone} cloneDetected=${cloneDetected} identityCols=${JSON.stringify(cols)} machineCols=${JSON.stringify(machineCols)}`,
    );
    expect(cloneDetected).toBe(true);
  });

  it('[DAT-75] owner/admin lockout: forgotten PIN, lost recovery code, departed admin, unreachable licence server', () => {
    const src = readSrc('src/utils/technicianRecovery.ts');
    const hardcoded = /TECHNICIAN_MASTER_SECRET\s*=\s*['"]/.test(src);
    const exportedOtp = /export\s+async\s+function\s+computeTechnicianOtp/.test(src);
    const lockUi = readSrc('src/components/LockScreenOverlay.tsx').includes('generateTechnicianChallenge');
    const offline = /100% offline-compatible|zero internet required/i.test(src);
    console.log(
      `[DAT-75] challengeUi=${lockUi} offline=${offline} hardcodedSecret=${hardcoded} exportedOtp=${exportedOtp}`,
    );
    expect(hardcoded).toBe(false);
  });

  it('[DAT-76] licence/subscription/backend lapse', async () => {
    const licUrl = (await browser.execute(() => {
      const w = window as unknown as { __MOBI_LICENSING_URL__?: string };
      return w.__MOBI_LICENSING_URL__ ?? null;
    })) as string | null;
    const licenceSettings = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%licen%' OR key LIKE '%subscription%'",
    ).map((r) => r.key);
    blocked(
      'DAT-76',
      `no licence server/provider configured (url=${JSON.stringify(licUrl)}, settings=${JSON.stringify(licenceSettings)}); no subscription state to expire`,
      'a test licence server/provider with expiry, offline grace and reactivation scenarios',
      licenceSettings.length === 0,
    );
  });

  it('[DAT-77] retention shorter than the offline period (tombstones / idempotency keys / outbox acks)', () => {
    const retentionKeys = all<{ key: string }>(
      "SELECT key FROM app_settings WHERE key LIKE '%retention%' OR key LIKE '%purge%' OR key LIKE '%ttl%'",
    ).map((r) => r.key);
    const bootPurge = readSrc('src/db/sqlPluginAdapter.ts').includes(
      "DELETE FROM sync_outbox WHERE status = 'synced'",
    );
    const ackPurge = readSrc('src-tauri/src/sync_outbox.rs').includes('DELETE FROM sync_outbox WHERE seq_no IN');
    const tombstoneRetention = readSrc('src/db/sqlPluginAdapter.ts').includes('tombstone_retention');
    console.log(
      `[DAT-77] retentionKeys=${JSON.stringify(retentionKeys)} bootPurge=${bootPurge} ackPurge=${ackPurge} tombstoneRetention=${tombstoneRetention}`,
    );
    expect(retentionKeys.length).toBe(0);
    expect(tombstoneRetention).toBe(false);
  });

  it('[DAT-78] selective restore (one product / customer / period) without replacing everything', async () => {
    const restore = await tryInvokeRaw('restore_database_backup', {});
    const selectiveUi = fs
      .readdirSync(path.resolve('src/components'), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => /restore|import/i.test(n));
    const selectiveApi = readSrc('src/db/adapters/maintenanceAdapter.ts').includes('restoreSelected');
    console.log(
      `[DAT-78] restoreOk=${restore.ok} restoreErr=${JSON.stringify(restore.ok ? '' : restore.error.slice(0, 160))} selectiveUi=${JSON.stringify(selectiveUi)} selectiveApi=${selectiveApi}`,
    );
    expect(restore.ok).toBe(true);
    expect(selectiveApi).toBe(true);
  });

  it('[DAT-80] external witnesses (card terminal, bank, gateway settlement files)', () => {
    blocked(
      'DAT-80',
      'no card terminal, bank or gateway settlement file in the sandbox; only local transactions exist',
      'external settlement files/witnesses (SATIM/CIB/Edahabia/BaridiMob) and a reconciliation harness',
      process.env.POS_E2E_SETTLEMENT_WITNESS === undefined,
    );
  });

  it('[DAT-81] mass wipe by update (1M rows, bad WHERE, migration)', () => {
    const products = Number(count('products'));
    blocked(
      'DAT-81',
      `sandbox has ${products} products, not a 1M-row fixture; no migration/update harness to run a bad WHERE against production-scale data`,
      'a 1M-row fixture and a migration/update harness with a bad-WHERE injection point',
      products < 1000000,
    );
  });

  it('[DAT-82] ledger immutability: DELETE/UPDATE without a proper WHERE, or search/import reaching SQL', () => {
    run(
      "INSERT OR REPLACE INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, sync_status, created_at, updated_at) VALUES ('DAT82-L', ?, 1, 'ADJUST', 'test', 'DAT82', 'e2e', 'DAT82', 'pending', datetime('now'), datetime('now'))",
      P82,
    );
    const triggers = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='inventory_ledger'",
    ).map((r) => r.name);
    const upd = run("UPDATE inventory_ledger SET delta = 999 WHERE id = 'DAT82-L'");
    const del = run("DELETE FROM inventory_ledger WHERE id = 'DAT82-L'");
    run("DELETE FROM inventory_ledger WHERE id = 'DAT82-L'");
    console.log(
      `[DAT-82] updateChanges=${upd.changes} deleteChanges=${del.changes} triggers=${JSON.stringify(triggers)}`,
    );
    expect({ updateChanges: upd.changes, deleteChanges: del.changes }).toEqual({
      updateChanges: 0,
      deleteChanges: 0,
    });
  });

  it('[DAT-83] destructive migrations (type change, rename, drop/rebuild)', () => {
    const migrations = all<{ version: string; description: string }>(
      'SELECT version, description FROM _sqlx_migrations ORDER BY version',
    );
    const oldSchemaFixture = fs.existsSync(path.resolve('e2e-tests/fixtures/old-schemas'));
    blocked(
      'DAT-83',
      `only the current migration chain exists (${migrations.length} rows); no frozen historical schema or destructive-migration fixture (oldSchemaFixture=${oldSchemaFixture})`,
      'frozen schemas for each released version plus a migration harness that can run type-change/rename/drop-rebuild steps',
      oldSchemaFixture === false && process.env.POS_E2E_OLD_SCHEMA === undefined,
    );
  });

  it('[DAT-85] staff-error scenarios: wrong DB file, wrong folder, interrupted copy, closed laptop, UPS off', () => {
    blocked(
      'DAT-85',
      'no OS-level lid/power/UPS harness and no second data-dir profile; the sandbox runs one process with one DB',
      'a disposable Windows VM with lid/power/UPS control and a second data-dir profile',
      process.env.POS_E2E_POWER_HARNESS === undefined,
    );
  });

  it('[DAT-86] Android-specific: force-stop, clear data, uninstall, low storage, app standby', () => {
    blocked(
      'DAT-86',
      'no Android device/emulator or adb harness; the app under test is the Windows desktop build',
      'an Android device/emulator with adb (force-stop, pm clear, uninstall, storage fill, app standby)',
      process.env.POS_E2E_ANDROID === undefined,
    );
  });

  it('[DAT-87] bit rot / partial copies: a corrupted backup is detected before restore', async () => {
    const backupsDir = path.join(SANDBOX_LOCAL, 'com.mobi.pos.e2e', 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const fake = path.join(backupsDir, 'manual_mobi_pos_backup_e2e_corrupt.db');
    fs.writeFileSync(fake, Buffer.from('not a sqlite database', 'utf8'));
    let integrityOk = true;
    let db: BetterSqlite3.Database | null = null;
    try {
      db = new BetterSqlite3(fake, { readonly: true });
      const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      integrityOk = r?.integrity_check === 'ok';
    } catch {
      integrityOk = false;
    } finally {
      db?.close();
    }
    const list = await tryInvokeRaw<string[]>('list_database_backups', {});
    const listed = Boolean(list.ok && list.value.some((p) => p.includes('e2e_corrupt')));
    const verify = await tryInvokeRaw('verify_database_backup', {});
    fs.rmSync(fake, { force: true, maxRetries: 5, retryDelay: 100 });
    console.log(
      `[DAT-87] corruptIntegrityOk=${integrityOk} listedAsBackup=${listed} listCount=${list.ok ? list.value.length : 'ERR'} verifyCommandOk=${verify.ok}`,
    );
    expect(listed).toBe(false);
    expect(integrityOk).toBe(false);
  });

  it('[DAT-88] identifiers as text end to end (leading zeros, >2^53 ids, receipt/ticket strings, dates)', async () => {
    const cust = one<{ id: string; phone: string }>('SELECT id, phone FROM customers WHERE id = ?', C88);
    const prod = one<{ barcode: string; imei_number: string }>(
      'SELECT barcode, imei_number FROM products WHERE id = ?',
      P88,
    );
    const txId = '9007199254740993';
    const receipt = '0000000000000001';
    const createdAt = '2026-10-24T00:00:00.000Z';
    run(
      `INSERT OR REPLACE INTO transactions
       (id, receipt_number, subtotal, total, status, created_at, json_payload, version, is_refund, updated_at)
       VALUES (?, ?, 100, 100, 'COMPLETED', ?, '{}', 1, 0, ?)`,
      txId,
      receipt,
      createdAt,
      createdAt,
    );
    const tx = one<{ id: string; receipt_number: string; created_at: string }>(
      'SELECT id, receipt_number, created_at FROM transactions WHERE id = ?',
      txId,
    );
    const exact = {
      customerId: cust?.id === C88,
      phone: cust?.phone === '0555000000',
      barcode: prod?.barcode === '0001234567890',
      imei: prod?.imei_number === '000123456789012',
      transactionId: tx?.id === txId,
      receipt: tx?.receipt_number === receipt,
      dateString: tx?.created_at === createdAt,
    };
    console.log(
      `[DAT-88] custId=${JSON.stringify(cust?.id)} phone=${JSON.stringify(cust?.phone)} barcode=${JSON.stringify(prod?.barcode)} imei=${JSON.stringify(prod?.imei_number)} txId=${JSON.stringify(tx?.id)} receipt=${JSON.stringify(tx?.receipt_number)} date=${JSON.stringify(tx?.created_at)} exact=${JSON.stringify(exact)}`,
    );
    expect(exact).toEqual({
      customerId: true,
      phone: true,
      barcode: true,
      imei: true,
      transactionId: true,
      receipt: true,
      dateString: true,
    });
  });

  it('[DAT-89] gap finder: what is missing, what is corrupt, what is unsynced', () => {
    const gapTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%gap%' OR name LIKE '%missing%')",
    ).map((r) => r.name);
    const gapUi = fs
      .readdirSync(path.resolve('src/components'), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => /gap|missing|reconcil/i.test(n));
    console.log(`[DAT-89] gapTables=${JSON.stringify(gapTables)} gapUi=${JSON.stringify(gapUi)}`);
    expect(gapTables.length).toBe(0);
    expect(gapUi.length).toBe(0);
  });
});
