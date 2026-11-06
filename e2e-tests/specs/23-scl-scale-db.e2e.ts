/**
 * SCL — scale matrix, database half (batch 23).
 *
 * Covers SCL-36 / SCL-37 / SCL-38 / SCL-83 on real 1M-transaction,
 * 2M-IMEI and 10M-ledger files, plus a deliberately large WAL restart.
 *
 * All seeds are OUT-OF-BAND (better-sqlite3) into the disposable e2e
 * sandbox. The app store is hydrated before the seeds; the checkout probes
 * then drive the real `__posStress.runBatch` bridge (the same processPayment
 * path as the UI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { browser, expect } from '@wdio/globals';
import { all, count, db, one, openDb, run, scalar, tx } from '../lib/db';
import { DB_PATH, ROOT } from '../lib/env';
import { clearWebMirrors, ensureShiftOpen, installPageShims, unlockIfNeeded } from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

const P36 = 'SCL36-P';
const P37 = 'SCL37-P';
const P38 = 'SCL38-P';
const N_TX = 1_000_000;
const N_IMEI = 2_000_000;
const N_LEDGER = 10_000_000;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else if (/\.(ts|tsx|rs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function grepSrc(pattern: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const file of [
    ...walkFiles(path.join(ROOT, 'src')),
    ...walkFiles(path.join(ROOT, 'src-tauri', 'src')),
  ]) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      if (pattern.test(text)) {
        hits.push({ file: path.relative(ROOT, file), line: i + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

async function runStressBatch(
  id: string,
  qty: number,
  tenderedDa: number,
): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const res = (await browser.execute(
    async (productId: string, q: number, t: number) => {
      const w = window as unknown as {
        __posStress?: {
          runBatch: (
            b: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
          ) => Promise<Array<{ ok: boolean; ms: number; reason?: string }>>;
        };
      };
      if (!w.__posStress) return [{ ok: false, ms: 0, reason: 'NO_STRESS_BRIDGE' }];
      return await w.__posStress.runBatch([{ lines: [{ id: productId, qty: q }], tenderedDa: t }]);
    },
    id,
    qty,
    tenderedDa,
  )) as Array<{ ok: boolean; ms: number; reason?: string }>;
  return res[0] ?? { ok: false, ms: 0, reason: 'EMPTY_RESULT' };
}

function p95(values: number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

function seedTransactions(n: number): number {
  const t0 = Date.now();
  db().pragma('synchronous = NORMAL');
  const res = run(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
     INSERT INTO transactions
       (id, receipt_number, subtotal, total, status, created_at, json_payload,
        idempotency_key, updated_at, version)
     SELECT 'SCL38-TX-' || x,
            'SCL38-R-' || x,
            1000, 1000, 'COMPLETED',
            '2026-01-01T00:00:00.000Z',
            '{}',
            'scl38-tx-' || x,
            '2026-01-01T00:00:00.000Z',
            1
       FROM c`,
    n,
  );
  console.log(`[SCL-38] seedTransactions=${res.changes} ms=${Date.now() - t0}`);
  return res.changes;
}

function seedImei(n: number): number {
  const t0 = Date.now();
  const res = run(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
     INSERT INTO imei_records (imei, product_id, received_at, status, version)
     SELECT printf('SCL37-%010d', x), ?, datetime('now','utc'), 'IN_STOCK', 1
       FROM c`,
    n,
    P37,
  );
  console.log(`[SCL-37] seedImei=${res.changes} ms=${Date.now() - t0}`);
  return res.changes;
}

function seedLedger(n: number): number {
  const t0 = Date.now();
  const res = run(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
     INSERT INTO inventory_ledger
       (id, product_id, delta, reason, ref_type, ref_id, device_id,
        idempotency_key, sync_status, created_at, updated_at, deleted, version)
     SELECT printf('SCL36-L-%d', x), ?, 1, 'SEED', 'scale', 'SCL36',
            'e2e-scale', printf('scl36-l-%d', x), 'pending',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 1
       FROM c`,
    n,
    P36,
  );
  console.log(`[SCL-36] seedLedger=${res.changes} ms=${Date.now() - t0}`);
  return res.changes;
}

describe('SCL — batch 23 scale (database)', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 300000, script: 600000 });
    // A wiped sandbox has no DB until the app boots and runs its migrations.
    await unlockIfNeeded();
    await resetData();
    seedProducts([
      { id: P36, title: 'SCL36 Ledger Phone', priceDa: 1000, stock: N_LEDGER },
      { id: P37, title: 'SCL37 IMEI Phone', priceDa: 1000, stock: N_IMEI },
      { id: P38, title: 'SCL38 Tx Phone', priceDa: 1000, stock: 1000 },
    ]);
    // The base ledger row would double-count the 10M synthetic movements.
    run("DELETE FROM inventory_ledger WHERE id = 'E2E-BASE-SCL36-P'");
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen();
  });

  it('[SCL-38] checkout commit p95 on a 1M-sale DB (200-line cart is the UI lane; stress uses 1 line)', async () => {
    const beforeMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await runStressBatch(P38, 1, 1000);
      if (r.ok) beforeMs.push(r.ms);
      else console.log(`[SCL-38] baseline fail i=${i} reason=${r.reason}`);
    }
    const beforeP95 = p95(beforeMs);

    const inserted = seedTransactions(N_TX);
    expect(inserted).toBe(N_TX);
    expect(count('transactions')).toBeGreaterThanOrEqual(N_TX);

    const afterMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await runStressBatch(P38, 1, 1000);
      if (r.ok) afterMs.push(r.ms);
      else console.log(`[SCL-38] after-seed fail i=${i} reason=${r.reason}`);
    }
    const afterP95 = p95(afterMs);
    const triggers = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='transactions'",
    ).map((r) => r.name);
    console.log(
      `[SCL-38] rows=${count('transactions')} beforeOk=${beforeMs.length}/20 beforeP95=${Math.round(beforeP95)}ms ` +
        `afterOk=${afterMs.length}/20 afterP95=${Math.round(afterP95)}ms ` +
        `triggers=${JSON.stringify(triggers)} expected=stable-p95-no-table-scan`,
    );
    // Expected: commit p95 stays in the same order of magnitude on a 1M-sale
    // table. Actual is reported above; the threshold is 1s and 3x baseline.
    expect(afterMs.length).toBeGreaterThanOrEqual(19);
    expect(afterP95).toBeLessThan(1000);
    expect(afterP95).toBeLessThanOrEqual(Math.max(1000, beforeP95 * 3));
  });

  it('[SCL-37] 2M IMEI lookup/update is indexed, but the app upsert lets a second terminal overwrite the first', async () => {
    const inserted = seedImei(N_IMEI);
    expect(inserted).toBe(N_IMEI);
    expect(count('imei_records')).toBeGreaterThanOrEqual(N_IMEI);

    const imei = 'SCL37-0000000001';
    const t0 = Date.now();
    const row = one<{ imei: string; product_id: string; status: string }>(
      'SELECT imei, product_id, status FROM imei_records WHERE imei = ?',
      imei,
    );
    const lookupMs = Date.now() - t0;
    const plan = all<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT imei, product_id, status FROM imei_records WHERE imei = ?',
      imei,
    ).map((r) => r.detail);
    const upd = run(
      "UPDATE imei_records SET status = 'SOLD', sold_at = ?, version = version + 1 WHERE imei = ?",
      '2026-01-01T00:00:00.000Z',
      imei,
    );
    const evtId = 'SCL37-EVT-1';
    run(
      `INSERT OR IGNORE INTO imei_events (id, imei, kind, ref_type, ref_id, at, actor, note)
       VALUES (?, ?, 'SOLD', 'sale', 'SCL37-TX', ?, 'e2e', 'scale')`,
      evtId,
      imei,
      '2026-01-01T00:00:00.000Z',
    );
    const evt = one<{ n: number }>('SELECT COUNT(*) AS n FROM imei_events WHERE imei = ?', imei);

    // Two autocommit upserts with the app's own saveIMEIRecord shape. Both
    // "succeed"; the second overwrites product_id/version.
    const a = openDb();
    const b = openDb();
    const dup = 'SCL37-DUP-1';
    const upsert = `INSERT INTO imei_records
        (imei, product_id, purchase_order_id, sale_transaction_id, warranty_expires_at,
         received_at, sold_at, warranty_months, status)
      VALUES (?, ?, NULL, NULL, NULL, ?, NULL, NULL, 'IN_STOCK')
      ON CONFLICT(imei) DO UPDATE SET
        product_id=excluded.product_id,
        sale_transaction_id=excluded.sale_transaction_id,
        received_at=COALESCE(excluded.received_at, imei_records.received_at),
        status=COALESCE(excluded.status, imei_records.status),
        version=imei_records.version + 1`;
    let aChanges = -1;
    let bChanges = -1;
    let aErr = '';
    let bErr = '';
    try {
      aChanges = a.prepare(upsert).run(dup, 'SCL37-A', '2026-01-01T00:00:00.000Z').changes;
    } catch (e) {
      aErr = String((e as Error)?.message ?? e);
    }
    try {
      bChanges = b.prepare(upsert).run(dup, 'SCL37-B', '2026-01-01T00:00:01.000Z').changes;
    } catch (e) {
      bErr = String((e as Error)?.message ?? e);
    }
    const final = one<{ product_id: string; version: number }>(
      'SELECT product_id, version FROM imei_records WHERE imei = ?',
      dup,
    );
    a.close();
    b.close();
    console.log(
      `[SCL-37] rows=${count('imei_records')} lookupMs=${lookupMs} found=${JSON.stringify(row)} ` +
        `plan=${JSON.stringify(plan)} updateChanges=${upd.changes} eventRows=${evt?.n} ` +
        `raceA=${aChanges}${aErr ? ` err=${aErr}` : ''} raceB=${bChanges}${bErr ? ` err=${bErr}` : ''} ` +
        `final=${JSON.stringify(final)} expected=one-writer-wins`,
    );
    expect(row?.imei).toBe(imei);
    expect(plan.some((p) => /USING (INTEGER )?PRIMARY KEY|USING INDEX|USING COVERING INDEX/i.test(p))).toBe(true);
    expect(upd.changes).toBe(1);
    expect(evt?.n).toBe(1);
    // Expected: the second terminal loses (0 changes or an error) and the
    // first assignment survives. Actual: both upserts return 1 and the last
    // writer wins.
    expect(bChanges === 0 || !!bErr).toBe(true);
    expect(final?.product_id).toBe('SCL37-A');
  });

  it('[SCL-36] 10M-ledger sale recomputes SUM(delta) and has no chunked/resumable job', async () => {
    const inserted = seedLedger(N_LEDGER);
    expect(inserted).toBe(N_LEDGER);
    run('UPDATE products SET stock = ? WHERE id = ?', N_LEDGER, P36);
    const ledgerSumBefore = Number(
      scalar<number>('SELECT COALESCE(SUM(delta),0) FROM inventory_ledger WHERE product_id = ? AND deleted = 0', P36),
    );
    const stockBefore = Number(scalar<number>('SELECT stock FROM products WHERE id = ?', P36));

    const histT0 = Date.now();
    const hist = all<{ id: string; delta: number }>(
      `SELECT id, delta FROM inventory_ledger
       WHERE product_id = ? AND deleted = 0
       ORDER BY created_at DESC LIMIT 50`,
      P36,
    );
    const histMs = Date.now() - histT0;
    const histPlan = all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id, delta FROM inventory_ledger
       WHERE product_id = ? AND deleted = 0
       ORDER BY created_at DESC LIMIT 50`,
      P36,
    ).map((r) => r.detail);

    const sale = await runStressBatch(P36, 1, 1000);
    const stockAfter = Number(scalar<number>('SELECT stock FROM products WHERE id = ?', P36));
    const ledgerSumAfter = Number(
      scalar<number>('SELECT COALESCE(SUM(delta),0) FROM inventory_ledger WHERE product_id = ? AND deleted = 0', P36),
    );
    const chunked = grepSrc(/chunk(ed)?[^\n]{0,60}(recompute|recalcul|ledger)|recompute[^\n]{0,60}(chunk|resum)/i);
    console.log(
      `[SCL-36] rows=${count('inventory_ledger')} ledgerSumBefore=${ledgerSumBefore} stockBefore=${stockBefore} ` +
        `histRows=${hist.length} histMs=${histMs} histPlan=${JSON.stringify(histPlan)} ` +
        `saleOk=${sale.ok} saleMs=${Math.round(sale.ms)} reason=${JSON.stringify(sale.reason ?? '')} ` +
        `stockAfter=${stockAfter} ledgerSumAfter=${ledgerSumAfter} equal=${stockAfter === ledgerSumAfter} ` +
        `chunkedJobHits=${JSON.stringify(chunked.map((h) => `${h.file}:${h.line}`))} ` +
        `expected=indexed-running-balance-and-chunked-recompute`,
    );
    expect(ledgerSumBefore).toBe(N_LEDGER);
    expect(stockBefore).toBe(N_LEDGER);
    expect(hist.length).toBe(50);
    expect(sale.ok).toBe(true);
    expect(stockAfter).toBe(ledgerSumAfter);
    // Expected: on-hand from an indexed running balance and a chunked,
    // resumable recompute job. Actual: every sale scans the full 10M-row
    // ledger via SUM(delta), and no chunked job exists.
    expect(sale.ms).toBeLessThan(1000);
    expect(chunked.length).toBeGreaterThan(0);
  });

  it('[SCL-83] restart with a large WAL has no progress UI', async () => {
    // Collapse the seed WAL first so the measured WAL is the controlled one.
    try {
      db().pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* busy is acceptable; the next probe still measures a large WAL */
    }
    const w = openDb();
    w.pragma('wal_autocheckpoint = 0');
    w.pragma('synchronous = NORMAL');
    const t0 = Date.now();
    tx((d) => {
      d.exec('CREATE TABLE IF NOT EXISTS scl83_wal (id INTEGER PRIMARY KEY, payload TEXT)');
    });
    w.prepare(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
       INSERT INTO scl83_wal (id, payload)
       SELECT x, printf('%080d', x) FROM c`,
    ).run(1_000_000);
    const insertMs = Date.now() - t0;
    w.close();
    let walBytes = 0;
    try {
      walBytes = fs.statSync(`${DB_PATH}-wal`).size;
    } catch {
      walBytes = -1;
    }

    const bootT0 = Date.now();
    let refreshError = '';
    try {
      await browser.refresh();
    } catch (e) {
      refreshError = String((e as Error)?.message ?? e);
    }
    let ready = false;
    try {
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () =>
              !!document.querySelector(
                '[data-testid="lock-screen"], [data-testid="clients-button"], [data-testid="setup-pin-root"]',
              ),
          )) as boolean,
        { timeout: 180000, interval: 500 },
      );
      ready = true;
    } catch (e) {
      refreshError += ` :: ${String((e as Error)?.message ?? e)}`;
    }
    const bootMs = Date.now() - bootT0;
    await installPageShims();
    const progress = (await browser.execute(() => {
      const el = document.querySelector(
        'progress, [role="progressbar"], [data-testid*="progress"], [data-testid*="Progress"]',
      );
      return {
        hasProgress: !!el,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
      };
    })) as { hasProgress: boolean; text: string };
    console.log(
      `[SCL-83] walBytes=${walBytes} insertMs=${insertMs} bootMs=${bootMs} ready=${ready} ` +
        `refreshError=${JSON.stringify(refreshError)} progress=${JSON.stringify(progress)} ` +
        `expected=recovery-progress-ui`,
    );
    expect(walBytes).toBeGreaterThan(20 * 1024 * 1024);
    expect(ready).toBe(true);
    // Expected: recovery is measurable and shown as progress. Actual: the
    // splash is static text with no progress element.
    expect(progress.hasProgress).toBe(true);
  });

  after(() => {
    try {
      run('DROP TABLE IF EXISTS scl83_wal');
      db().pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* the sandbox is disposable */
    }
  });
});
