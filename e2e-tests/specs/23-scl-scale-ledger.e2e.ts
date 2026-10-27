/**
 * SCL-36 — 10M stock movements, on-hand recompute and product history.
 *
 * Run with the sandbox on a volume that can hold the ~4.5 GB fixture:
 *   $env:POS_WDIO_SANDBOX='D:\opencode\pos-wdio-sandbox-23ledger'
 *
 * The app's `appendInventoryDeltas` recomputes `products.stock` with
 * `SUM(delta)` over the whole product ledger on every sale. This spec seeds
 * 10M movements for one product, then measures the real checkout path and the
 * history query, and probes for a chunked/resumable recompute job.
 */
import fs from 'node:fs';
import path from 'node:path';
import { browser, expect } from '@wdio/globals';
import { all, count, db, run, scalar } from '../lib/db';
import { ROOT } from '../lib/env';
import { clearWebMirrors, ensureShiftOpen, unlockIfNeeded } from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

const P36 = 'SCL36-P';
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

describe('SCL — batch 23 scale (10M ledger)', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 300000, script: 600000 });
    await unlockIfNeeded();
    resetData();
    seedProducts([{ id: P36, title: 'SCL36 Ledger Phone', priceDa: 1000, stock: N_LEDGER }]);
    run("DELETE FROM inventory_ledger WHERE id = 'E2E-BASE-SCL36-P'");
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen();
  });

  it('[SCL-36] 10M-ledger sale recomputes SUM(delta) and has no chunked/resumable job', async () => {
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
      N_LEDGER,
      P36,
    );
    console.log(`[SCL-36] seedLedger=${res.changes} seedMs=${Date.now() - t0}`);
    expect(res.changes).toBe(N_LEDGER);

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
    const chunked = grepSrc(
      /(recompute|recalcul)[^\n]{0,80}(chunk|resum|job|snapshot|running.?balance)|(chunk|resum)[^\n]{0,80}(recompute|recalcul|on.?hand)/i,
    );
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
    expect(histMs).toBeLessThan(2000);
    expect(sale.ms).toBeLessThan(1000);
    expect(chunked.length).toBeGreaterThan(0);
  });

  after(() => {
    try {
      db().pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* the sandbox is disposable */
    }
  });
});
