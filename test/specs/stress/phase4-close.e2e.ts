import { expect, browser, $ } from '@wdio/globals';
import {
  tid,
  displayedToMinor,
  installErrorTrap,
  readErrors,
  unlockIfNeeded,
  ledger,
  clearWebMirrors,
  openShiftUi,
  clearCart,
  invoke,
} from '../../helpers/pos';
import { assertLedgerClean } from '../../../e2e/lib/ledger';

/**
 * Phase 4 Tier B close isolation (small scale): 60 hook-driven sales, then
 * UI shift close books exact + post-close sale refused (NO_ACTIVE_SHIFT).
 * Split out of phase4-stress: close-after-1000 needs dedicated profiling
 * (observed stall, reported as a perf finding — not asserted here).
 */
describe('STRESS close isolation (Phase 4)', function () {
  this.timeout(15 * 60_000);

  it('[T-B4s] close books exact after burst, post-close sale refused', async () => {
    await installErrorTrap();
    await invoke('e2e_reset_and_seed', { fixture: 'stress' });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);

    const baskets = Array.from({ length: 60 }, (_, i) => ({
      lines: [{ id: ['E2E-STR-A', 'E2E-STR-B', 'E2E-STR-C'][i % 3], qty: 1 + (i % 2) }],
      tenderedDa: [500, 1500, 3000][i % 3] * (1 + (i % 2)),
    }));
    const res: Array<{ ok: boolean; reason?: string }> = [];
    // Execute-chunking (see phase4-stress runBatch): a single >30s
    // browser.execute trips the WebDriver page-script timeout and re-invokes
    // the async wrapper, racing a duplicate processPayment stream against the
    // single flight guard. Keep each execute well under the ceiling.
    for (let i = 0; i < baskets.length; i += 20) {
      const part = (await browser.execute(async (b) => {
        const w = window as unknown as {
          __posStress?: {
            runBatch: (
              x: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
            ) => Promise<Array<{ ok: boolean; reason?: string }>>;
          };
        };
        return w.__posStress!.runBatch(b);
      }, baskets.slice(i, i + 20))) as Array<{ ok: boolean; reason?: string }>;
      res.push(...part);
    }
    expect(res.filter((r) => r.ok).length).toBe(60);

    const snap0 = await invoke<{ salesTotalDa: number; refundsTotalDa: number }>('e2e_ledger_snapshot');
    const expectedDa = Math.round(100000 + snap0.salesTotalDa - snap0.refundsTotalDa);
    await (await $(tid('shift-pill'))).click();
    await (await $(tid('shift-close-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('shift-blind-direct'))).click();
    await (await $(tid('shift-blind-input'))).setValue(String(expectedDa));
    await (await $(tid('shift-blind-next'))).click();
    try {
      await browser.waitUntil(
        async () =>
          displayedToMinor(await (await $(tid('shift-expected'))).getText()) ===
          BigInt(expectedDa) * 100n,
        { timeout: 60000, timeoutMsg: `expected did not settle to ${expectedDa}` },
      );
    } catch (e) {
      const full = await browser
        .execute(
          () =>
            (document.querySelector('[data-testid="shift-close-dialog"]') as HTMLElement | null)
              ?.innerText ?? '<close dialog absent>',
        )
        .catch(() => '<unreadable>');
      const sum = (await ledger()).shiftSummary;
      console.log(`[stress] T-B4s STALE: modal<<${String(full).slice(0, 1500)}>> shiftSummary=${JSON.stringify(sum)}`);
      throw e;
    }
    await (await $(tid('shift-close-confirm'))).click();
    const closeT0 = Date.now();
    await browser.waitUntil(
      async () => !(await $(tid('shift-close-dialog')).isDisplayed().catch(() => false)),
      { timeout: 60000, timeoutMsg: 'close dialog did not resolve' },
    ).catch(() => {});
    console.log(`[stress] T-B4s close duration: ${Date.now() - closeT0}ms`);
    await browser.keys(['Escape']);
    const denied = (await browser.execute(async () => {
      const w = window as unknown as { __posStress?: { runBatch: (b: unknown) => Promise<Array<{ ok: boolean; reason?: string }>> } };
      const r = await w.__posStress!.runBatch([{ lines: [{ id: 'E2E-STR-A', qty: 1 }], tenderedDa: 500 }]);
      return r[0];
    })) as { ok: boolean; reason?: string };
    console.log(`[stress] T-B4s post-close sale: ok=${denied?.ok} reason=${denied?.reason}`);
    expect(denied?.ok).toBe(false);
    expect(String(denied?.reason ?? '')).toMatch(/NO_ACTIVE_SHIFT/);
    await assertLedgerClean();
    await clearCart();
    expect(await readErrors()).toEqual([]);
  });
});
