import { expect, browser, $ } from '@wdio/globals';
import {
  tid,
  displayedToMinor,
  installErrorTrap,
  readErrors,
  unlockIfNeeded,
  ledger,
  getSale,
  clearWebMirrors,
  openShiftUi,
  clearCart,
  invoke,
  readOpenShiftDexie,
  readDexieShift,
  stockOf,
  refundDirect,
} from '../../helpers/pos';
import { computeInvoice, toMinorFromDa } from '../../../e2e/lib/oracle';
import { assertLedgerClean } from '../../../e2e/lib/ledger';

/**
 * Phase 4 Tier B — IPC/backend stress (isolated `.e2e`, HT-only integer DA).
 *
 * Volume runs through the REAL checkout path via the DEV-only
 * `window.__posStress.runBatch` hook (store addToCart + processPayment,
 * one execute per chunk so round-trips don't dominate). Concurrency runs
 * where shared state allows it:
 * - Sales share one store cart by construction (single till) — burst
 *   oversell is a GUARD test (STOCK_EMPTY denial), not a race.
 * - Refunds carry explicit state — N parallel native invokes in ONE
 *   execute race for real at the Rust lock (BEGIN IMMEDIATE / pool).
 *
 * Env: STRESS_SEED (default 20260410), STRESS_SALES (default 1000).
 * Timings are DEBUG-profile (dev server) — functional signal only, never
 * reported as performance data (release-profile numbers need POS_E2E_PROFILE=release).
 */

const SEED = Number(process.env.STRESS_SEED ?? 20260410);
const N = Number(process.env.STRESS_SALES ?? 1000);
console.log(`STRESS_SEED=${SEED} STRESS_SALES=${N}`);

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = [
  { id: 'E2E-STR-A', priceDa: 500 },
  { id: 'E2E-STR-B', priceDa: 1500 },
  { id: 'E2E-STR-C', priceDa: 3000 },
];

interface Basket {
  lines: Array<{ id: string; qty: number }>;
  tenderedDa: number;
  expectMinor: string;
}

function genBaskets(n: number, seed: number): Basket[] {
  const rnd = mulberry32(seed);
  const out: Basket[] = [];
  for (let i = 0; i < n; i++) {
    const nLines = 1 + Math.floor(rnd() * 3);
    const lines = Array.from({ length: nLines }, () => {
      const p = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)];
      return { id: p.id, qty: 1 + Math.floor(rnd() * 3) };
    });
    const total = computeInvoice(
      lines.map((l) => ({
        unit: BigInt(PRODUCTS.find((p) => p.id === l.id)!.priceDa) * 100n,
        qty: l.qty,
      })),
    ).total;
    out.push({ lines, tenderedDa: Number(total / 100n), expectMinor: total.toString() });
  }
  return out;
}

async function runBatch(
  baskets: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
): Promise<Array<{ ok: boolean; ms: number; reason?: string }>> {
  // Execute-chunking: a >30s single `browser.execute` trips the WebDriver page
  // "script" timeout, which re-invokes the same async wrapper while the ORIGINAL
  // is still running in the page (observed: identical `Object.runBatch ← async
  // <anonymous>` entry stacks ~30s apart, CALL1 + CALL2 racing the single flight
  // guard → deterministic ALREADY_PROCESSING/INSUFFICIENT_CASH storm after sale
  // ~60 of 100). Chunking keeps every execute well under the ceiling so one
  // processPayment stream reaches the guard at a time. Order is preserved by
  // concatenation.
  const EXEC = 20;
  const out: Array<{ ok: boolean; ms: number; reason?: string }> = [];
  for (let i = 0; i < baskets.length; i += EXEC) {
    const chunk = baskets.slice(i, i + EXEC);
    const part = (await browser.execute(async (b) => {
      const w = window as unknown as {
        __posStress?: {
          runBatch: (
            x: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
          ) => Promise<Array<{ ok: boolean; ms: number; reason?: string }>>;
        };
      };
      if (!w.__posStress) throw new Error('__posStress hook missing (VITE_E2E e2e build?)');
      return w.__posStress.runBatch(b);
    }, chunk)) as Array<{ ok: boolean; ms: number; reason?: string }>;
    out.push(...part);
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

describe('STRESS Tier B (Phase 4)', function () {
  // NOTE: mocha ignores per-test timeout args in this runner (observed) —
  // suite-level wins. Keep every `it` under ~3 min: long single tests
  // invite timeout-driven duplication pathologies (Gate 4 lesson). Volume
  // is therefore split into 100-sale blocks with a trailing aggregate.
  this.timeout(10 * 60_000);
  let deviceId = '';
  let dexieShiftId = '';

  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_and_seed', { fixture: 'stress' });
    await invoke('e2e_seed_state', {
      payload: {
        products: [{ id: 'E2E-RACE', title: 'E2E Race', priceDa: 2000, stock: 5, barcode: 'ERB9' }],
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
    deviceId = (await invoke<{ deviceId: string }>('get_device_identity_info')).deviceId;
    dexieShiftId = (await readOpenShiftDexie())?.id ?? '';
    expect(deviceId !== '').toBe(true);
    expect(dexieShiftId !== '').toBe(true);
  });

  afterEach(async () => {
    await assertLedgerClean();
    await clearCart();
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  // T-B1 volume, split into 100-sale blocks (each < ~2 min): one long `it`
  // proved timeout-fragile in this runner. Shared state via describe-scope.
  const blockResults: Array<{ ok: number; failed: number; ms: number[]; firstErr: string }> = [];
  let tB1Baskets: Basket[] = [];
  let tB1Expected = 0n;
  let tB1BeforeCount = 0;
  let tB1BeforeTotal = 0n;

  it('[T-B1-setup] generate baskets + baseline', async () => {
    tB1Baskets = genBaskets(N, SEED);
    tB1Expected = tB1Baskets.reduce((a, b) => a + BigInt(b.expectMinor), 0n);
    const before = await invoke<{ salesCount: number; salesTotalDa: number }>('e2e_ledger_snapshot');
    tB1BeforeCount = before.salesCount;
    tB1BeforeTotal = toMinorFromDa(before.salesTotalDa);
  });

  const BLOCK = 100;
  const blocks = Math.ceil(N / BLOCK);
  for (let g = 0; g < blocks; g++) {
    const slice = { g };
    it(`[T-B1-block ${slice.g + 1}/${blocks}] 100 exact sales`, async () => {
      const chunk = tB1Baskets.slice(slice.g * BLOCK, slice.g * BLOCK + BLOCK);
      const res = await runBatch(chunk.map(({ lines, tenderedDa }) => ({ lines, tenderedDa })));
      const ms = res.map((r) => r.ms);
      const failed = res.filter((r) => !r.ok).length;
      const firstErr = res.find((r) => !r.ok)?.reason ?? '';
      console.log(`[stress] T-B1 block ${slice.g + 1}/${blocks}: ${res.length - failed}/${res.length} ok p50=${pct(ms, 0.5).toFixed(1)}ms firstErr=${firstErr}`);
      // Slow-sale signature: ONE sale eating the full busy_timeout window (WAL
      // write-lock contention) followed by a fast ALREADY_PROCESSING storm —
      // vs a stuck holder (no such slow sale). Dump the slowest 3 here.
      const byMs = res
        .map((r, i) => ({ i, ...r }))
        .sort((a, b) => Number(b.ms) - Number(a.ms))
        .slice(0, 3);
      console.log(`[stress] T-B1 block ${slice.g + 1}/${blocks} slowest: ${byMs.map((s) => `#${s.i} ok=${s.ok} ms=${Math.round(s.ms)} re=${s.reason ?? ''}`).join(' | ')}`);
      console.log(`[stress] T-B1 block ${slice.g + 1}/${blocks} ms>5000=${ms.filter((m) => m > 5000).length}`);
      blockResults.push({ ok: res.length - failed, failed, ms, firstErr });
      expect(failed).toBe(0);
    });
  }

  it('[T-B1-aggregate] volume sales balance to the minor unit', async () => {
    const ok = blockResults.reduce((a, r) => a + r.ok, 0);
    const failed = blockResults.reduce((a, r) => a + r.failed, 0);
    const ms = blockResults.flatMap((r) => r.ms);
    const firstErr = blockResults.find((r) => r.firstErr)?.firstErr ?? '';
    console.log(`[stress] T-B1 total: ${ok}/${N} ok p50=${pct(ms, 0.5).toFixed(1)}ms p95=${pct(ms, 0.95).toFixed(1)}ms p99=${pct(ms, 0.99).toFixed(1)}ms firstErr=${firstErr}`);
    expect(failed).toBe(0);
    expect(ok).toBe(N);
    const snap = await invoke<{
      salesCount: number;
      salesTotalDa: number;
      receiptNumbers: string[];
      auditChainOk: boolean;
    }>('e2e_ledger_snapshot');
    expect(snap.salesCount - tB1BeforeCount).toBe(N);
    expect(toMinorFromDa(snap.salesTotalDa) - tB1BeforeTotal).toBe(tB1Expected);
    expect(new Set(snap.receiptNumbers).size).toBe(snap.receiptNumbers.length);
    expect(snap.auditChainOk).toBe(true);
    for (const p of PRODUCTS) {
      expect((await stockOf(p.id)).ledger ?? -1).toBeGreaterThanOrEqual(0);
    }
  });

  it('[T-B2] oversell guard: stock-5 product sells at most 5 under burst', async () => {
    const attempts = Array.from({ length: 8 }, () => ({ lines: [{ id: 'E2E-RACE', qty: 1 }], tenderedDa: 2000 }));
    const res = await runBatch(attempts);
    const okCount = res.filter((r) => r.ok).length;
    const reasons = res.filter((r) => !r.ok).map((r) => r.reason ?? '');
    console.log(`[stress] T-B2: ${okCount}/8 sold, denials=[${[...new Set(reasons)].join('|')}]`);
    expect(okCount).toBeLessThanOrEqual(5);
    // Non-vacuous: at least one sale must land (0/8 passing is a wedged
    // session, not a guard proof — Gate 4 lesson).
    expect(okCount).toBeGreaterThanOrEqual(1);
    for (const reason of reasons) {
      expect(['STOCK_EMPTY', 'ALREADY_PROCESSING'].some((k) => reason.includes(k))).toBe(true);
    }
    const st = await stockOf('E2E-RACE');
    expect(st.ledger).toBe(5 - okCount);
    expect((st.ledger ?? -1) >= 0).toBe(true);
  });

  it('[T-B3] refund contention: 6 sequential full refunds yield exactly one', async () => {
    // Sequential multi-caller case (deterministic): the first full refund
    // takes the whole tender; the rest must be refused with zero writes.
    // True-parallel contention is probed in isolation (phase4-race.e2e.ts):
    // an unsettled parallel execute wedges the CDP session for all later
    // commands, so it must never share a session with the main suite.
    const saleRes = await runBatch([{
      lines: [{ id: 'E2E-STR-B', qty: 2 }],
      tenderedDa: 3000,
    }]);
    expect(saleRes[0]?.ok).toBe(true);
    const saleId = (await ledger()).recentSales[0]?.id ?? '';
    expect(saleId.length).toBeGreaterThan(0);
    const sale = await getSale(saleId);
    const tx0 = (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await refundDirect({
        deviceId,
        shiftId: dexieShiftId,
        sqlShiftId: dexieShiftId,
        ticketId: saleId,
        tag: `E2E-B3-R${i}`,
        receipt: `AVOIR-E2E-B3-R${i}`,
        totalNet: 3000,
        cashOut: 3000,
        tenderedNet: 3000,
        lines: sale.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          appliedPriceDa: l.appliedPriceDa,
        })),
      });
      codes.push(r.ok ? 'OK' : r.code);
    }
    console.log(`[stress] T-B3 codes: ${codes.join(' | ')}`);
    expect(codes.filter((c) => c === 'OK').length).toBe(1);
    for (const c of codes.filter((x) => x !== 'OK')) {
      expect(/ALREADY_REFUNDED|REFUND_EXCEEDS|BUSY/.test(c)).toBe(true);
    }
    expect((await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0).toBe(tx0 + 1);
    const snap = await invoke<{ refundsTotalDa: number }>('e2e_ledger_snapshot');
    expect(Math.round(Math.abs(snap.refundsTotalDa))).toBeLessThanOrEqual(
      Math.round(Math.abs((await getSale(saleId)).totalDa)) + 0,
    );
    // Production-faithful mirror (refundNative projects committed rows to
    // Dexie; kernel-direct calls bypass it). The modal reads the STORE
    // mirror: it needs BOTH the flipped original (status accuracy) AND the
    // refund row itself (isRefund, for the cashRefunds deduction) —
    // otherwise the close overstates by exactly the refunded amount
    // (observed +3000 phantom). Reboot after so the store rehydrates.
    const refundRow = {
      id: 'E2E-B3-R0',
      receiptNumber: 'AVOIR-E2E-B3-R0',
      status: 'COMPLETED',
      isRefund: true,
      total: 3000,
      paymentMethod: 'Espèces',
      refundMethod: 'Espèces',
      createdAt: new Date().toISOString(),
    };
    const putOk = await browser.execute(
      async (args: { saleId: string; refund: Record<string, unknown> }) => {
        const idb = (window as unknown as { indexedDB: IDBFactory }).indexedDB;
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const open = idb.open('MobiPosDB');
          open.onsuccess = () => res(open.result);
          open.onerror = () => rej(new Error('idb open failed'));
        });
        const store = db.transaction('transactions', 'readwrite').objectStore('transactions');
        const get = (k: string) =>
          new Promise<Record<string, unknown> | undefined>((res, rej) => {
            const rq = store.get(k);
            rq.onsuccess = () => res((rq.result as Record<string, unknown> | undefined) ?? undefined);
            rq.onerror = () => rej(new Error('get failed'));
          });
        const put = (v: Record<string, unknown>) =>
          new Promise<void>((res, rej) => {
            const rq = store.put(v);
            rq.onsuccess = () => res();
            rq.onerror = () => rej(new Error('put failed'));
          });
        const orig = await get(args.saleId);
        if (orig) await put({ ...orig, status: 'REFUNDED' });
        await put(args.refund);
        return { flipped: Boolean(orig), refundPut: true };
      },
      { saleId, refund: refundRow },
    );
    console.log(`[stress] T-B3 mirror project: ${JSON.stringify(putOk)}`);
    await browser.refresh();
    await unlockIfNeeded();
  });

  it('[T-B4] close resilience: shift closes after burst, post-close sale refused', async () => {
    // Root causes (Gate 4 + re-probe evidence):
    //  (a) The modal computes expected LIVE from the store transactions
    //      mirror (ShiftCloseModal:131-168,224) — after a burst, background
    //      mirror maintenance can REPLACE that array mid-close (observed
    //      swing 6709500 -> 20000). Entering a snapshot-derived count then
    //      disagrees with the modal.
    //  (b) Any disagreement arms the variance gates (note + manager PIN at
    //      >=1000 DA) and the old test filled neither -> disabled submit ->
    //      25-min hang. Backend aggregation itself is fast (121 ms resolve
    //      on a 1050-sale DB), so no indices/aggregates were added.
    // Policy: book ONLY on agreement (ecart 0). Auto-filling gates to book
    // an unexplained variance would falsify the Z. Persistent disagreement
    // fails LOUDLY with the full series (defect data, never a hang).
    const snap0 = await invoke<{ salesTotalDa: number; refundsTotalDa: number }>('e2e_ledger_snapshot');
    const enteredDa = Math.round(100000 + snap0.salesTotalDa - snap0.refundsTotalDa);
    await (await $(tid('shift-pill'))).click();
    await (await $(tid('shift-close-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('shift-blind-direct'))).click();
    await (await $(tid('shift-blind-input'))).setValue(String(enteredDa));
    await (await $(tid('shift-blind-next'))).click();
    const series: string[] = [];
    let agreed = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const v = displayedToMinor(await (await $(tid('shift-expected'))).getText());
      const s = (v / 100n).toString();
      if (series[series.length - 1] !== s) {
        series.push(s);
        console.log(`[stress] T-B4 series: modal=${s} entered=${enteredDa}`);
      }
      if (v === BigInt(enteredDa) * 100n) {
        agreed = true;
        break;
      }
      await browser.pause(2000);
    }
    if (!agreed) {
      // Mirror-side forensics (live Dexie aggregates) before failing: tells
      // whether the mirror overcounts (stale/duplicated rows) or the
      // snapshot undercounts.
      const dex = await browser.execute(async () => {
        const idb = (window as unknown as { indexedDB: IDBFactory }).indexedDB;
        const open = idb.open('MobiPosDB');
        const db = await new Promise<IDBDatabase>((res, rej) => {
          open.onsuccess = () => res(open.result);
          open.onerror = () => rej(new Error('idb open failed'));
        });
        const rows = await new Promise<Array<Record<string, unknown>>>((res, rej) => {
          const rq = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
          rq.onsuccess = () => res((rq.result ?? []) as Array<Record<string, unknown>>);
          rq.onerror = () => rej(new Error('getAll failed'));
        });
        const byStatus: Record<string, number> = {};
        const byReceipt: Record<string, number> = {};
        let sum = 0;
        for (const r of rows) {
          byStatus[String(r.status ?? '?')] = (byStatus[String(r.status ?? '?')] ?? 0) + 1;
          byReceipt[String(r.receiptNumber ?? r.receipt_number ?? '?')] =
            (byReceipt[String(r.receiptNumber ?? r.receipt_number ?? '?')] ?? 0) + 1;
          if (r.status !== 'VOIDED' && !r.isRefund) sum += Number(r.total ?? 0);
        }
        const dups = Object.entries(byReceipt).filter(([, c]) => c > 1);
        return { rows: rows.length, sum, byStatus, dupReceipts: dups.slice(0, 5) };
      }).catch((e: unknown) => ({ dexError: String(e).slice(0, 200) }));
      console.log(`[stress] T-B4 DEXIE-DUMP: ${JSON.stringify(dex).slice(0, 1000)}`);
    }
    expect({ agreed, series, enteredDa }).toEqual({
      agreed: true,
      series,
      enteredDa,
    });
    // Race guard: the modal recomputes live, so confirm may be transiently
    // disabled at click time (variance mid-update) — clicking a disabled
    // button is a silent no-op that mimics a hang. Wait for enabled first.
    const confirmBtn = await $(tid('shift-close-confirm'));
    await browser.waitUntil(async () => await confirmBtn.isEnabled().catch(() => false), {
      timeout: 30000,
      timeoutMsg: 'confirm never enabled after agreement',
    });
    // Moving-target guard: live recompute can shift layout between the
    // enabled check and a native click (no-op on miss, no error). JS-click a
    // FRESH query up to 3 times; stop at the first dialog-gone.
    let confirmed = false;
    for (let attempt = 1; attempt <= 3 && !confirmed; attempt++) {
      await browser.execute((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest' });
        el?.click();
      }, tid('shift-close-confirm'));
      try {
        await browser.waitUntil(
          async () => !(await $(tid('shift-close-dialog')).isDisplayed().catch(() => false)),
          { timeout: 15000, timeoutMsg: `confirm attempt ${attempt} did not resolve` },
        );
        confirmed = true;
      } catch {
        console.log(`[stress] T-B4 confirm attempt ${attempt} no effect, retrying`);
      }
    }
    if (!confirmed) {
      // Dialog text + toasts + close-path trace for the diagnosis.
      const txt = await browser
        .execute(() => (document.querySelector('[data-testid="shift-close-dialog"]') as HTMLElement | null)?.innerText ?? '<absent>')
        .catch(() => '<unreadable>');
      const toasts = await browser
        .execute(() => Array.from(document.querySelectorAll('[role="alert"], .toast')).map((t) => (t as HTMLElement).innerText).join(' || '))
        .catch(() => '<unreadable>');
      console.log(`[stress] T-B4 CLOSE-FAIL dialog<<${String(txt).slice(0, 1200)}>> toasts<<${String(toasts).slice(0, 500)}>>`);
      throw new Error('close did not resolve after 3 confirm attempts (see CLOSE-FAIL dump above)');
    }
    await browser.keys(['Escape']);
    // Booked figures: CLOSED with zero discrepancy (agreement proven above).
    const dex = await readDexieShift(dexieShiftId);
    expect(dex?.status).toBe('CLOSED');
    const booked = await invoke<{
      found: boolean;
      status: string;
      discrepancyDa: number | null;
      expectedCashDa: number | null;
    }>('e2e_get_shift', { id: dexieShiftId });
    expect(booked.found).toBe(true);
    expect(booked.status).toBe('CLOSED');
    expect(Math.round(booked.discrepancyDa ?? NaN)).toBe(0);
    console.log(`[stress] T-B4 booked: expected=${booked.expectedCashDa} counted=${enteredDa} variance=0`);
    // Closed-shift sale refused at the app gate (no throw, clean denial).
    const denied = await browser.execute(async () => {
      const w = window as unknown as { __posStress?: { runBatch: (b: unknown) => Promise<Array<{ ok: boolean; reason?: string }>> } };
      const r = await w.__posStress!.runBatch([{ lines: [{ id: 'E2E-STR-A', qty: 1 }], tenderedDa: 500 }]);
      return r[0];
    });
    console.log(`[stress] T-B4 post-close sale: ok=${denied?.ok} reason=${denied?.reason}`);
    expect(denied?.ok).toBe(false);
  });
});
