/**
 * SYN — sync / multi-device matrix (batch 24, 30 P0 cases).
 *
 * Verdict policy (same as batches 20–23):
 *   PASS    = observed behaviour satisfies the case, with a real control.
 *   FAIL    = observed behaviour is wrong or a required control is absent;
 *             the assertion states the expected value.
 *   N/A     = the feature does not exist; an executed absence probe is logged.
 *   BLOCKED = exact missing resource logged (kept in Remaining).
 *
 * The sandbox is one desktop terminal. Cases that need a second enrolled
 * terminal, a configured merchant gateway, a mixed-version fleet, a fault
 * injector, a restored production copy or a licence server log the exact
 * missing resource and stay BLOCKED. Locally observable behaviour (idempotency,
 * receipt uniqueness, edit-vs-edit, read-your-writes, credential storage,
 * ordering, per-device settings) is exercised against the live sandbox DB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { all, columnNames, count, one, run, scalar, tableExists, tableNames } from '../lib/db';
import { invokeRaw } from '../lib/invoke';
import {
  APP_PIN,
  addSku,
  clearWebMirrors,
  ensureShiftOpen,
  installErrorTrap,
  payExactFlow,
  tid,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCustomerFull, seedProducts } from '../lib/seed';
import { ROOT } from '../lib/env';
import {
  activeNumberingScheme,
  newDocumentNumber,
  setDeviceSeries,
  setNumberingScheme,
  setSequenceStore,
} from '../../src/utils/numbering';

const P24 = 'SYN24-P';
const P04 = 'SYN24-P04';
const C04 = 'SYN24-C04';

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function grepSrc(pattern: RegExp, rels: string[] = ['src', 'src-tauri/src']): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!fs.existsSync(dir)) return out;
    if (fs.statSync(dir).isFile()) {
      if (/\.(ts|tsx|rs|mjs|cjs)$/.test(dir)) out.push(dir);
      return out;
    }
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (['node_modules', 'target', '.git', 'dist'].includes(ent.name)) continue;
        walk(p, out);
      } else if (/\.(ts|tsx|rs|mjs|cjs)$/.test(ent.name)) out.push(p);
    }
    return out;
  };
  for (const rel of rels) {
    for (const file of walk(path.join(ROOT, rel))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((text, i) => {
        if (pattern.test(text)) hits.push({ file: path.relative(ROOT, file), line: i + 1, text: text.trim() });
        pattern.lastIndex = 0;
      });
    }
  }
  return hits;
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

async function runStress(
  lines: Array<{ id: string; qty: number }>,
  tenderedDa: number,
): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const res = (await browser.execute(
    async (b: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>) => {
      const w = window as unknown as {
        __posStress?: {
          runBatch: (x: typeof b) => Promise<Array<{ ok: boolean; ms: number; reason?: string }>>;
        };
      };
      if (!w.__posStress) return [{ ok: false, ms: 0, reason: 'NO_STRESS_HOOK' }];
      return await w.__posStress.runBatch(b);
    },
    [{ lines, tenderedDa }],
  )) as Array<{ ok: boolean; ms: number; reason?: string }>;
  return res[0] ?? { ok: false, ms: 0, reason: 'NO_RESULT' };
}

function settingJson(key: string): string | null {
  const row = one<{ value_json: string }>('SELECT value_json FROM app_settings WHERE key = ?', key);
  return row?.value_json ?? null;
}

function gatewayUrl(): string | null {
  const raw = settingJson('sync.gateway_url');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return raw.trim() ? raw : null;
  }
}

function outboxEntityTypes(): string[] {
  return all<{ entity_type: string }>('SELECT DISTINCT entity_type FROM sync_outbox ORDER BY entity_type').map(
    (r) => r.entity_type,
  );
}

describe('SYN — sync / multi-device matrix (batch 24)', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 120000, script: 120000 });
    await unlockIfNeeded(APP_PIN);
    await installErrorTrap();
    await resetData();
    run('DELETE FROM sync_outbox');
    seedProducts([
      { id: P24, title: 'SYN24 Product', priceDa: 1000, stock: 10, barcode: '6130000024001', costDa: 500 },
      { id: P04, title: 'SYN24 P04 Product', priceDa: 1000, stock: 10, barcode: '6130000024004', costDa: 500 },
    ]);
    seedCustomerFull([{ id: C04, name: 'SYN24 Customer', phone: '0550000024' }]);
    await clearWebMirrors();
    await browser.waitUntil(
      async () => (await $(tid('shift-pill'))).isDisplayed().catch(() => false),
      { timeout: 90000, interval: 500, timeoutMsg: 'dashboard did not re-mount after mirror reload' },
    );
    await unlockIfNeeded(APP_PIN);
    await ensureShiftOpen();
  });

  it('[SYN-01] sync mode is documented and matches the shipped storage topology', async () => {
    const journal = String(scalar('PRAGMA journal_mode'));
    const tables = tableNames();
    const replicaTables = tables.filter((t) => /replica|turso_sync|sync_replica/i.test(t));
    const hasOutbox = tableExists('sync_outbox');
    const hasIdentity = tableExists('device_identity');
    const cargo = readSrc('src-tauri/Cargo.toml');
    const libsqlRust = /(^|\n)\s*libsql\s*=/m.test(cargo);
    const agents = readSrc('AGENTS.md');
    const documented =
      agents.includes('Storage topology') &&
      agents.includes('plain SQLite') &&
      agents.includes('remote sync transport');
    const libsqlClient = grepSrc(/@libsql\/client/, ['src']).length > 0;
    console.log(
      `[SYN-01] VERDICT=PASS mode=plain-sqlite-outbox journal=${journal} replicaTables=${JSON.stringify(replicaTables)} outbox=${hasOutbox} identity=${hasIdentity} libsqlRustCrate=${libsqlRust} libsqlClient=${libsqlClient} documented=${documented}`,
    );
    expect(journal).toBe('wal');
    expect(replicaTables).toEqual([]);
    expect(hasOutbox).toBe(true);
    expect(hasIdentity).toBe(true);
    expect(libsqlRust).toBe(false);
    expect(libsqlClient).toBe(true);
    expect(documented).toBe(true);
  });

  it('[SYN-02] two terminals mint distinct fiscal numbers from their own series (device-series seam)', async () => {
    // The contract (ADR-006, owner-provisional): a unique number per series,
    // continuous within the series. The sale path must mint this terminal's
    // series; two terminals must never share a number.
    await addSku('SYN24 Product', { expectTitle: 'SYN24 Product' });
    await payExactFlow();
    await browser.pause(600);
    const saleOk = Number(count('transactions')) > 0;
    const newest = one<{ receipt_number: string }>(
      'SELECT receipt_number FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    const printed = String(newest?.receipt_number ?? '');
    const seriesOfPrinted = /^REC-([0-9A-Z]{4,8})-\d{6,}$/.exec(printed)?.[1] ?? '';
    // The series the APP minted with lives in its own storage; the spec process
    // is a different module instance, so it is read from the page, not assumed.
    const appSeries = (await browser.execute(
      () => localStorage.getItem('mobipos_numbering_series_v1') || '',
    )) as string;
    const appUsesSeries = Boolean(seriesOfPrinted) && seriesOfPrinted === appSeries && activeNumberingScheme() === 'device-series-v1';

    // Two-terminal leg: independent stores, independent series, N draws each.
    const makeTerminal = (series: string) => {
      const map = new Map<string, number>();
      setSequenceStore({ read: (k) => map.get(k) ?? null, write: (k, v) => void map.set(k, v) });
      setDeviceSeries(series);
      return [1, 2, 3, 4, 5].map(() => newDocumentNumber('REC', Date.now()));
    };
    const tA = makeTerminal('T2A1');
    const tB = makeTerminal('T2B2');
    const disjoint = tA.filter((n) => tB.includes(n)).length === 0;
    const monotonic = (list: string[]) =>
      list.every((n, i) => i === 0 || Number(n.slice(-6)) === Number(list[i - 1].slice(-6)) + 1);
    const ordered = monotonic(tA) && monotonic(tB);

    // Negative control: the SAME series on the same store must reproduce the
    // first terminal's numbers — so the series is what separates terminals.
    const map = new Map<string, number>();
    setSequenceStore({ read: (k) => map.get(k) ?? null, write: (k, v) => void map.set(k, v) });
    setDeviceSeries('T2A1');
    const clone = [1, 2, 3, 4, 5].map(() => newDocumentNumber('REC', Date.now()));
    const collisionWhenShared = clone[0] === tA[0];

    // The legacy scheme stays swappable (characterisation, byte shape kept).
    setNumberingScheme('legacy-timestamp');
    const legacy = newDocumentNumber('REC', Date.now());
    const legacyShape = /^REC-\d{8}-[0-9A-Z]+-\d{2}-[0-9A-Z]{5}$/.test(legacy);
    setNumberingScheme('device-series-v1');

    console.log(
      `[SYN-02] VERDICT=${saleOk && appUsesSeries && disjoint && ordered && collisionWhenShared && legacyShape ? 'PASS' : 'FAIL'} ` +
        `saleOk=${saleOk} receipt=${printed} series=${seriesOfPrinted} appSeries=${appSeries} appUsesSeries=${appUsesSeries} ` +
        `A=${JSON.stringify(tA)} B=${JSON.stringify(tB)} disjoint=${disjoint} monotonic=${ordered} ` +
        `sharedSeriesControl=${collisionWhenShared} legacyShape=${legacyShape} ` +
        `(ADR-006: two terminals, a shared number collides by construction; PROVISIONAL - owner/accountant must confirm the fiscal numbering pre-production)`,
    );

    expect(saleOk).toBe(true);
    expect(appUsesSeries).toBe(true);
    expect(disjoint).toBe(true);
    expect(ordered).toBe(true);
    expect(collisionWhenShared).toBe(true);
    expect(legacyShape).toBe(true);
  });

  it('[SYN-03] retrying the same outbox idempotency key leaves one row', async () => {
    const key = 'SYN03-IDEM';
    run(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id)
       VALUES (?, 'sale', 'SYN03-SALE', 'UPSERT', '{"n":1}', 'pending', datetime('now','utc'), datetime('now','utc'), 'syn03-device')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
      key,
    );
    run(
      `INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status, created_at, updated_at, device_id)
       VALUES (?, 'sale', 'SYN03-SALE', 'UPSERT', '{"n":2}', 'pending', datetime('now','utc'), datetime('now','utc'), 'syn03-device')
       ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
      key,
    );
    const rows = all<{ payload_json: string; seq_no: number | null }>(
      'SELECT payload_json, seq_no FROM sync_outbox WHERE idempotency_key = ?',
      key,
    );
    const idemIdx = all<{ name: string; unique: number }>('PRAGMA index_list(sync_outbox)').find(
      (r) => r.unique === 1 && r.name.startsWith('sqlite_autoindex_sync_outbox'),
    );
    const txIdem = all<{ name: string; unique: number }>('PRAGMA index_list(transactions)').find(
      (r) => r.name === 'uq_transactions_idem',
    );
    console.log(
      `[SYN-03] VERDICT=PASS outboxRows=${rows.length} payload=${rows[0]?.payload_json ?? 'missing'} outboxUniqueAutoindex=${!!idemIdx} txIdemUnique=${txIdem?.unique === 1} seqNo=${rows[0]?.seq_no ?? 'null'}`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.payload_json).toBe('{"n":2}');
    expect(!!idemIdx).toBe(true);
    expect(txIdem?.unique).toBe(1);
    run('DELETE FROM sync_outbox WHERE idempotency_key = ?', key);
  });

  it('[SYN-04] product edit-vs-edit is last-write-wins with no compare-and-set', async () => {
    const before = one<{ title: string; version: number }>('SELECT title, version FROM products WHERE id = ?', P04);
    const readA = Number(before?.version ?? 0);
    const readB = Number(before?.version ?? 0);
    const a = run(
      "UPDATE products SET title = ?, version = ?, updated_at = datetime('now','utc') WHERE id = ?",
      'SYN04-A',
      readA + 1,
      P04,
    );
    const b = run(
      "UPDATE products SET title = ?, version = ?, updated_at = datetime('now','utc') WHERE id = ?",
      'SYN04-B',
      readB + 1,
      P04,
    );
    const after = one<{ title: string; version: number }>('SELECT title, version FROM products WHERE id = ?', P04);
    const src = readSrc('src/db/sqlPluginAdapter.ts');
    const start = src.indexOf('export async function syncProductUpsert');
    const end = src.indexOf('export async function', start + 20);
    const fn = src.slice(start, end > 0 ? end : undefined);
    const versionPredicate = /WHERE\s+products\.version\s*=/i.test(fn) || /WHERE\s+version\s*=/i.test(fn);
    const customerSrc = readSrc('src/db/adapters/customerAdapter.ts');
    const customerCas = /WHERE customers\.version = \$13/.test(customerSrc);
    console.log(
      `[SYN-04] VERDICT=FAIL readA=${readA} readB=${readB} writerAChanges=${a.changes} writerBChanges=${b.changes} finalTitle=${JSON.stringify(after?.title)} finalVersion=${after?.version} productVersionPredicate=${versionPredicate} customerCas=${customerCas}`,
    );
    // Expected: the second writer loses or is reported as a conflict. The
    // product upsert has no version predicate, so both writers land.
    expect(b.changes).toBe(0);
  });

  it('[SYN-05] same refund / loyalty redemption / last item on two devices', async () => {
    const gateway = gatewayUrl();
    const devices = count('device_identity');
    const signed = count('sync_outbox', 'seq_no IS NOT NULL');
    console.log(
      `[SYN-05] VERDICT=BLOCKED gatewayUrl=${JSON.stringify(gateway)} enrolledDevices=${devices} signedRows=${signed} needed=second-enrolled-terminal-and-configured-merchant-gateway`,
    );
    expect(gateway).toBeNull();
    expect(devices).toBe(1);
  });

  it('[SYN-06] stock counter vs ledger across two offline devices', async () => {
    const sale = await runStress([{ id: P24, qty: 1 }], 1000);
    const stock = Number(scalar<number>('SELECT stock FROM products WHERE id = ?', P24));
    const ledger = Number(
      scalar<number>('SELECT COALESCE(SUM(delta),0) FROM inventory_ledger WHERE product_id = ? AND deleted = 0', P24),
    );
    const gateway = gatewayUrl();
    const devices = count('device_identity');
    console.log(
      `[SYN-06] VERDICT=BLOCKED localSaleOk=${sale.ok} localStock=${stock} localLedgerSum=${ledger} localLedgerMatches=${stock === ledger} gatewayUrl=${JSON.stringify(gateway)} enrolledDevices=${devices} needed=second-enrolled-terminal`,
    );
    expect(sale.ok).toBe(true);
    expect(stock).toBe(ledger);
    expect(devices).toBe(1);
  });

  it('[SYN-07] product deleted on A while sold on B', async () => {
    const deleted = run("UPDATE products SET deleted = 1, version = version + 1, updated_at = datetime('now','utc') WHERE id = ?", P24);
    const sale = await runStress([{ id: P24, qty: 1 }], 1000);
    const gateway = gatewayUrl();
    const devices = count('device_identity');
    console.log(
      `[SYN-07] VERDICT=BLOCKED tombstoneChanges=${deleted.changes} deletedSaleOk=${sale.ok} deletedSaleReason=${JSON.stringify(sale.reason ?? '')} outOfBandTombstone=true gatewayUrl=${JSON.stringify(gateway)} enrolledDevices=${devices} needed=second-enrolled-terminal-and-a-real-stale-cart-on-peer (the local probe writes the tombstone out-of-band, so the mirror is deliberately stale; it is not a real app delete-path verdict)`,
    );
    expect(deleted.changes).toBe(1);
    // Probe: an out-of-band tombstone does not refresh the Dexie mirror, so a
    // fresh cart can still sell the row. This is the stale-mirror risk the
    // two-device case must exercise; it is NOT a verdict on the app delete path.
    expect(sale.ok).toBe(true);
    expect(devices).toBe(1);
    run("UPDATE products SET deleted = 0 WHERE id = ?", P24);
  });

  it('[SYN-08] sync interrupted at 50% (kill/network cut/sleep)', async () => {
    const gateway = gatewayUrl();
    const signed = count('sync_outbox', 'seq_no IS NOT NULL');
    const retrySource = grepSrc(/next_retry_at|retry_count|backoff/i, ['src/db/adapters/syncDrainWorker.ts']).length;
    console.log(
      `[SYN-08] VERDICT=BLOCKED gatewayUrl=${JSON.stringify(gateway)} signedRows=${signed} retryBackoffHits=${retrySource} needed=network-fault-injector-or-kill-at-50%-harness`,
    );
    expect(gateway).toBeNull();
    expect(retrySource).toBeGreaterThan(0);
  });

  it('[SYN-09] 5,000 offline sales then reconnect', async () => {
    const pending = count('sync_outbox', "status = 'pending'");
    const signed = count('sync_outbox', 'seq_no IS NOT NULL');
    const gateway = gatewayUrl();
    console.log(
      `[SYN-09] VERDICT=BLOCKED pendingOutbox=${pending} signedRows=${signed} gatewayUrl=${JSON.stringify(gateway)} needed=configured-gateway-plus-5000-signed-backlog`,
    );
    expect(gateway).toBeNull();
    expect(signed).toBe(0);
  });

  it('[SYN-10] clock skew between devices ±5 min / ±1 day', async () => {
    const devices = count('device_identity');
    const anchors = tableExists('time_anchor') ? count('time_anchor') : 0;
    console.log(
      `[SYN-10] VERDICT=BLOCKED enrolledDevices=${devices} timeAnchorRows=${anchors} needed=second-enrolled-terminal-with-independent-clock`,
    );
    expect(devices).toBe(1);
  });

  it('[SYN-11] schema/app version mismatch between devices', async () => {
    const head = Number(scalar<number>('SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations'));
    const appVersion = (() => {
      try {
        return JSON.parse(readSrc('package.json')).version as string;
      } catch {
        return 'unknown';
      }
    })();
    console.log(
      `[SYN-11] VERDICT=BLOCKED migrationHead=${head} appVersion=${JSON.stringify(appVersion)} fleetVersions=1 needed=second-app-build-at-a-different-schema-version`,
    );
    expect(head).toBeGreaterThan(100);
  });

  it('[SYN-12] auth token expired / revoked / offline for days', async () => {
    const gateway = gatewayUrl();
    const creds = await tryInvokeRaw<{ url?: string; token?: string } | null>('get_cloud_credentials');
    const hasCreds = creds.ok && creds.value != null;
    console.log(
      `[SYN-12] VERDICT=BLOCKED gatewayUrl=${JSON.stringify(gateway)} cloudCredsPresent=${hasCreds} credsError=${creds.ok ? 'none' : JSON.stringify(creds.error.slice(0, 80))} needed=configured-remote-with-expiring-or-revocable-token`,
    );
    expect(gateway).toBeNull();
  });

  it('[SYN-13] read-your-writes: sale, ledger and report are visible immediately', async () => {
    const before = count('transactions');
    const t0 = Date.now();
    const sale = await runStress([{ id: P24, qty: 1 }], 1000);
    const ms = Date.now() - t0;
    const tx = one<{ id: string; receipt_number: string; total: number; status: string }>(
      'SELECT id, receipt_number, total, status FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    const ledger = Number(
      scalar<number>('SELECT COALESCE(SUM(delta),0) FROM inventory_ledger WHERE product_id = ? AND deleted = 0', P24),
    );
    const stock = Number(scalar<number>('SELECT stock FROM products WHERE id = ?', P24));
    const after = count('transactions');
    console.log(
      `[SYN-13] VERDICT=PASS saleOk=${sale.ok} saleMs=${ms} txBefore=${before} txAfter=${after} txId=${JSON.stringify(tx?.id)} receipt=${JSON.stringify(tx?.receipt_number)} total=${tx?.total} status=${JSON.stringify(tx?.status)} ledgerSum=${ledger} stock=${stock} ledgerMatches=${ledger === stock}`,
    );
    expect(sale.ok).toBe(true);
    expect(after).toBe(before + 1);
    expect(tx?.status).toBe('COMPLETED');
    expect(ledger).toBe(stock);
  });

  it('[SYN-14] sync running during checkout/payment/printing', async () => {
    const gateway = gatewayUrl();
    const signed = count('sync_outbox', 'seq_no IS NOT NULL');
    console.log(
      `[SYN-14] VERDICT=BLOCKED gatewayUrl=${JSON.stringify(gateway)} signedRows=${signed} needed=configured-gateway-plus-signed-rows-plus-checkout-overlap-harness`,
    );
    expect(gateway).toBeNull();
    expect(signed).toBe(0);
  });

  it('[SYN-15] backend returns 500 / 429 / timeout / malformed / partial JSON', async () => {
    const gateway = gatewayUrl();
    const signed = count('sync_outbox', 'seq_no IS NOT NULL');
    const worker = readSrc('src/db/adapters/syncDrainWorker.ts');
    const errorPath = /response\.status|status\s*!==\s*200|serverTimeToken|rejectedSeqNos/.test(worker);
    console.log(
      `[SYN-15] VERDICT=BLOCKED gatewayUrl=${JSON.stringify(gateway)} signedRows=${signed} workerErrorPath=${errorPath} needed=signed-outbox-rows-and-fault-injecting-mock-gateway`,
    );
    expect(gateway).toBeNull();
    expect(errorPath).toBe(true);
  });

  it('[SYN-16] restore an old backup on one device then sync', async () => {
    const restore = await tryInvokeRaw('restore_database_backup', {});
    const selective = await tryInvokeRaw('restore_selective_backup', {});
    const absent = !restore.ok && /not found|unknown command/i.test(restore.error);
    console.log(
      `[SYN-16] VERDICT=N/A restoreCommandOk=${restore.ok} restoreError=${JSON.stringify(restore.ok ? '' : restore.error.slice(0, 100))} selectiveOk=${selective.ok} absent=${absent}`,
    );
    expect(absent).toBe(true);
  });

  it('[SYN-17] multi-shop isolation (shop A / shop B)', async () => {
    const tables = tableNames();
    const shopTables = tables.filter((t) => /shop|tenant|store_location/i.test(t));
    const shopCols = tables.flatMap((t) => {
      try {
        return columnNames(t)
          .filter((c) => /shop_id|tenant_id|store_id/i.test(c))
          .map((c) => `${t}.${c}`);
      } catch {
        return [];
      }
    });
    const shopSettings = all<{ key: string }>('SELECT key FROM app_settings')
      .map((r) => r.key)
      .filter((k) => /shop|tenant|store/i.test(k));
    console.log(
      `[SYN-17] VERDICT=N/A shopTables=${JSON.stringify(shopTables)} shopColumns=${JSON.stringify(shopCols)} shopSettings=${JSON.stringify(shopSettings)}`,
    );
    expect(shopTables).toEqual([]);
    expect(shopCols).toEqual([]);
  });

  it('[SYN-18] sync credentials/URL are stored securely and never logged', async () => {
    const creds = await tryInvokeRaw<{ url?: string; token?: string } | null>('get_cloud_credentials');
    const credsInDb = tableExists('app_settings')
      ? count('app_settings', "key LIKE '%token%' OR key LIKE '%credential%'")
      : 0;
    const pinRaw = settingJson('manager_pin') ?? '';
    let pinPrefix = '';
    try {
      const parsed = JSON.parse(pinRaw);
      pinPrefix = typeof parsed === 'string' ? parsed.slice(0, 3) : String(parsed ?? '').slice(0, 3);
    } catch {
      pinPrefix = pinRaw.slice(0, 3);
    }
    const identity = one<{ private_key_enc: string }>('SELECT private_key_enc FROM device_identity LIMIT 1');
    const sealed = String(identity?.private_key_enc ?? '').length > 0;
    const redaction = grepSrc(/redact|REDACTED|\*\*\*/i, ['src-tauri/src/lib.rs']).length > 0;
    const debugTest = readSrc('src-tauri/src/lib.rs').includes('test_cloud_credentials_redaction_and_serialization');
    let tokenLogHits = 0;
    let artifactTokenHits = 0;
    try {
      for (const f of fs.readdirSync(path.join(ROOT, 'e2e-tests', 'logs'))) {
        if (!/\.log$/i.test(f)) continue;
        const text = fs.readFileSync(path.join(ROOT, 'e2e-tests', 'logs', f), 'utf8');
        if (/eyJ[A-Za-z0-9_-]{10,}/.test(text) || /token\s*[=:]\s*["'][A-Za-z0-9._-]{20,}/.test(text)) artifactTokenHits++;
      }
      tokenLogHits = grepSrc(/console\.(log|info|warn|error)\([^\n]*token/i, ['src']).length;
    } catch {
      /* logs are optional */
    }
    console.log(
      `[SYN-18] VERDICT=PASS credsCommandOk=${creds.ok} credsPresent=${creds.ok && creds.value != null} credsInDb=${credsInDb} pinPrefix=${JSON.stringify(pinPrefix)} privateKeySealed=${sealed} redaction=${redaction} debugTest=${debugTest} tokenLogHits=${tokenLogHits} artifactTokenHits=${artifactTokenHits}`,
    );
    expect(credsInDb).toBe(0);
    expect(pinPrefix).toMatch(/^v[12]\$/);
    expect(sealed).toBe(true);
    expect(redaction).toBe(true);
    expect(debugTest).toBe(true);
    expect(artifactTokenHits).toBe(0);
  });

  it('[SYN-19] convergence G-12 after all devices settle', async () => {
    const devices = count('device_identity');
    const gateway = gatewayUrl();
    console.log(
      `[SYN-19] VERDICT=BLOCKED enrolledDevices=${devices} gatewayUrl=${JSON.stringify(gateway)} needed=second-enrolled-terminal-and-gateway-to-observe-convergence`,
    );
    expect(devices).toBe(1);
    expect(gateway).toBeNull();
  });

  it('[SYN-20] database file encryption and key rotation/loss (if used)', async () => {
    let cipher = '';
    try {
      cipher = String(scalar('PRAGMA cipher_version') ?? '');
    } catch {
      cipher = '';
    }
    const keyPragma = grepSrc(/PRAGMA\s+key\b|sqlcipher|SQLCipher/i, ['src', 'src-tauri/src']).length;
    console.log(
      `[SYN-20] VERDICT=N/A cipherVersion=${JSON.stringify(cipher)} keyPragmaHits=${keyPragma} journal=${JSON.stringify(String(scalar('PRAGMA journal_mode')))}`,
    );
    expect(cipher).toBe('');
    expect(keyPragma).toBe(0);
  });

  it('[SYN-21] propagation SLA (p95 minutes / max hours)', async () => {
    const gateway = gatewayUrl();
    const signed = count('sync_outbox', 'seq_no IS NOT NULL');
    console.log(
      `[SYN-21] VERDICT=BLOCKED gatewayUrl=${JSON.stringify(gateway)} signedRows=${signed} needed=second-terminal-and-configured-gateway-to-measure-propagation`,
    );
    expect(gateway).toBeNull();
  });

  it('[SYN-22] mutable state rows transition on two devices at once', async () => {
    const devices = count('device_identity');
    const gateway = gatewayUrl();
    console.log(
      `[SYN-22] VERDICT=BLOCKED enrolledDevices=${devices} gatewayUrl=${JSON.stringify(gateway)} needed=second-enrolled-terminal`,
    );
    expect(devices).toBe(1);
  });

  it('[SYN-23] tombstones and redirects (delete/merge on A, edit/sell on B)', async () => {
    const customerCols = columnNames('customers');
    const productCols = columnNames('products');
    const customerTombstone = customerCols.includes('deleted') && customerCols.includes('version');
    const productTombstone = productCols.includes('deleted') && productCols.includes('version');
    const mergedInto = customerCols.some((c) => /merged|redirect/i.test(c)) || productCols.some((c) => /merged|redirect/i.test(c));
    const mergeOutbox = outboxEntityTypes().some((t) => /merge|redirect/i.test(t));
    const deleteSrc = readSrc('src/db/sqlPluginAdapter.ts');
    const productDeleteBumps = /tombstoneVersion|deleted\s*=\s*1/.test(deleteSrc);
    const gateway = gatewayUrl();
    console.log(
      `[SYN-23] VERDICT=BLOCKED customerTombstone=${customerTombstone} productTombstone=${productTombstone} productDeleteBumps=${productDeleteBumps} mergedInto=${mergedInto} mergeOutbox=${mergeOutbox} gatewayUrl=${JSON.stringify(gateway)} needed=second-enrolled-terminal-and-a-merge/redirect-lane`,
    );
    expect(customerTombstone).toBe(true);
    expect(productTombstone).toBe(true);
    expect(mergedInto).toBe(false);
    expect(mergeOutbox).toBe(false);
  });

  it('[SYN-24] bandwidth budget: initial sync, 1M-row change set, photos', async () => {
    const gateway = gatewayUrl();
    const pendingBytes = Number(
      scalar<number>('SELECT COALESCE(SUM(LENGTH(payload_json)),0) FROM sync_outbox WHERE status = ?', 'pending'),
    );
    console.log(
      `[SYN-24] VERDICT=BLOCKED gatewayUrl=${JSON.stringify(gateway)} pendingOutboxBytes=${pendingBytes} initialSync=false needed=configured-remote-and-1M-row-change-set`,
    );
    expect(gateway).toBeNull();
  });

  it('[SYN-25] blobs (ID scans, photos) in the sync payload', async () => {
    const attachmentTable = tableExists('sav_attachments');
    const entityTypes = outboxEntityTypes();
    const blobEntity = entityTypes.some((t) => /attach|photo|image|blob/i.test(t));
    console.log(
      `[SYN-25] VERDICT=N/A attachmentTable=${attachmentTable} outboxEntityTypes=${JSON.stringify(entityTypes)} blobEntity=${blobEntity}`,
    );
    expect(blobEntity).toBe(false);
  });

  it('[SYN-26] replica exposure: what a stolen phone’s local DB contains', async () => {
    let cipher = '';
    try {
      cipher = String(scalar('PRAGMA cipher_version') ?? '');
    } catch {
      cipher = '';
    }
    const customers = count('customers');
    const transactions = count('transactions');
    const customerCols = columnNames('customers');
    const piiCols = customerCols.filter((c) => /name|phone|email|address/i.test(c));
    const credsInDb = count('app_settings', "key LIKE '%token%' OR key LIKE '%credential%'");
    const identity = one<{ private_key_enc: string }>('SELECT private_key_enc FROM device_identity LIMIT 1');
    const sealed = String(identity?.private_key_enc ?? '').length > 0;
    console.log(
      `[SYN-26] VERDICT=FAIL cipherVersion=${JSON.stringify(cipher)} customerRows=${customers} transactionRows=${transactions} piiColumns=${JSON.stringify(piiCols)} credsInDb=${credsInDb} privateKeySealed=${sealed}`,
    );
    // Expected: an at-rest control (encryption or field-level protection) for
    // the PII a stolen phone carries. The DB is plaintext SQLite.
    expect(cipher).not.toBe('');
  });

  it('[SYN-27] ordering by version/HLC, not wall clock', async () => {
    const eventRows = tableExists('event_log') ? count('event_log') : -1;
    const syncState = tableExists('sync_state') ? count('sync_state') : -1;
    const outboxCols = columnNames('sync_outbox');
    const hasSeq = outboxCols.includes('seq_no');
    const hasHlc = outboxCols.some((c) => /hlc|logical|lamport/i.test(c));
    const manager = readSrc('src/sync/SyncManager.ts');
    const pullCursorWallClock = /ORDER BY updated_at ASC, id ASC/.test(manager);
    const tiebreak = readSrc('src/sync/causalVersion.ts').includes('tiedVersionGuardSql');
    console.log(
      `[SYN-27] VERDICT=FAIL eventLogRows=${eventRows} syncStateRows=${syncState} outboxSeqNo=${hasSeq} outboxHlc=${hasHlc} pullCursorWallClock=${pullCursorWallClock} tiedVersionGuard=${tiebreak}`,
    );
    // Expected: HLC/logical ordering for the pull cursor. The cursor is
    // (updated_at, id) wall clock; the HLC event lane has zero rows.
    expect(pullCursorWallClock).toBe(false);
  });

  it('[SYN-28] echo / ping-pong: applying a remote change must not re-enqueue it', async () => {
    const manager = readSrc('src/sync/SyncManager.ts');
    const generic = readSrc('src/sync/genericApply.ts');
    const applyStart = manager.indexOf('private async applyRemoteRow');
    const applyEnd = manager.indexOf('private async', applyStart + 20);
    const applyBody = applyStart >= 0 ? manager.slice(applyStart, applyEnd > 0 ? applyEnd : undefined) : '';
    const enqueueOnApply = /enqueueGeneric|pushOutbox|sync_outbox|notifyLocalWrite/i.test(applyBody);
    const staleEchoGuard = /stale[- ]echo|staleEcho/i.test(generic + manager);
    const remoteConfigured = gatewayUrl() != null;
    console.log(
      `[SYN-28] VERDICT=BLOCKED remoteConfigured=${remoteConfigured} applyRemoteRowEnqueues=${enqueueOnApply} staleEchoGuard=${staleEchoGuard} needed=configured-remote-to-apply-a-real-remote-change`,
    );
    expect(enqueueOnApply).toBe(false);
    expect(staleEchoGuard).toBe(true);
    expect(remoteConfigured).toBe(false);
  });

  it('[SYN-29] schema migration offline for days / mixed versions', async () => {
    const head = Number(scalar<number>('SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations'));
    const offlineDays = 0;
    console.log(
      `[SYN-29] VERDICT=BLOCKED migrationHead=${head} offlineDays=${offlineDays} fleetVersions=1 needed=second-app-build-at-older-schema-plus-multi-day-offline-window`,
    );
    expect(head).toBeGreaterThan(100);
  });

  it('[SYN-30] per-device settings vs shop settings', async () => {
    const adapter = readSrc('src/db/sqlPluginAdapter.ts');
    const deviceKeys = ['manager_pin', 'cashier_users'].every((k) =>
      new RegExp(`['"]${k}['"]`).test(adapter),
    );
    const syncPrefix = adapter.includes("k.startsWith('sync.')");
    const printerStripped = /printerRouting:\s*_dropped/.test(adapter);
    const localeLocal = readSrc('src/i18n/index.ts').includes("localStorage.setItem(LOCALE_STORAGE_KEY");
    const themeLocal = readSrc('src/store/slices/createUISlice.ts').includes("localStorage.setItem('mobi_pos_theme'");
    const deviceIdInOutbox = count('sync_outbox', "entity_type = 'setting' AND payload_json LIKE '%device_id%'");
    console.log(
      `[SYN-30] VERDICT=PASS deviceLocalKeys=${deviceKeys} syncPrefix=${syncPrefix} printerRoutingStripped=${printerStripped} localeLocalStorage=${localeLocal} themeLocalStorage=${themeLocal} deviceIdInSettingOutbox=${deviceIdInOutbox}`,
    );
    expect(deviceKeys).toBe(true);
    expect(syncPrefix).toBe(true);
    expect(printerStripped).toBe(true);
    expect(localeLocal).toBe(true);
    expect(themeLocal).toBe(true);
    expect(deviceIdInOutbox).toBe(0);
  });
});
