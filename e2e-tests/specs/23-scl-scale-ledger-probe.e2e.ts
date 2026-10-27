/**
 * SCL-36 probe on the already-seeded 10M-ledger sandbox.
 *
 * The seed is a ~22-minute synchronous insert; the first run timed out after
 * the insert committed. This spec reuses that sandbox (same
 * `POS_WDIO_SANDBOX`) and runs only the measurement half: history query,
 * real checkout, on-hand equality, and the chunked-job source probe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { browser, expect } from '@wdio/globals';
import { all, count, one, run, scalar } from '../lib/db';
import { ROOT } from '../lib/env';
import { ensureShiftOpen, unlockIfNeeded } from '../lib/pos';

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

describe('SCL — batch 23 scale (10M ledger probe)', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 300000, script: 600000 });
    await unlockIfNeeded();
    // The 10M seed run opened a shift in SQLite, but the WebView profile did
    // not retain the Dexie mirror (getActiveShift reads Dexie). The app then
    // refuses a second open while checkout sees NO_ACTIVE_SHIFT. Drop the
    // orphan row and open a fresh shift so the checkout path is reachable.
    const open = one<{ id: string }>(
      "SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
    );
    if (open) run('DELETE FROM cash_sessions WHERE id = ?', open.id);
    await ensureShiftOpen();
  });

  it('[SCL-36] 10M-ledger sale recomputes SUM(delta) and has no chunked/resumable job', async function () {
    this.timeout(3_600_000);
    const rows = count('inventory_ledger');
    const existingSales = rows - N_LEDGER;
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
    // The app's own sale already performed the full SUM(delta) recompute; do
    // not repeat that scan in the harness (it would only add wall-clock noise).
    const expectedAfter = ledgerSumBefore - 1;
    const chunked = grepSrc(
      /(recompute|recalcul)[^\n]{0,80}(chunk|resum|job|snapshot|running.?balance)|(chunk|resum)[^\n]{0,80}(recompute|recalcul|on.?hand)/i,
    );
    console.log(
      `[SCL-36] rows=${rows} seedRows=${N_LEDGER} existingSales=${existingSales} ` +
        `ledgerSumBefore=${ledgerSumBefore} stockBefore=${stockBefore} ` +
        `histRows=${hist.length} histMs=${histMs} histPlan=${JSON.stringify(histPlan)} ` +
        `saleOk=${sale.ok} saleMs=${Math.round(sale.ms)} reason=${JSON.stringify(sale.reason ?? '')} ` +
        `stockAfter=${stockAfter} expectedAfter=${expectedAfter} equal=${stockAfter === expectedAfter} ` +
        `chunkedJobHits=${JSON.stringify(chunked.map((h) => `${h.file}:${h.line}`))} ` +
        `expected=indexed-running-balance-and-chunked-recompute`,
    );
    expect(rows).toBeGreaterThanOrEqual(N_LEDGER);
    expect(stockBefore).toBe(ledgerSumBefore);
    expect(hist.length).toBe(50);
    expect(sale.ok).toBe(true);
    expect(stockAfter).toBe(expectedAfter);
    expect(histMs).toBeLessThan(2000);
    expect(sale.ms).toBeLessThan(1000);
    expect(chunked.length).toBeGreaterThan(0);
  });
});
