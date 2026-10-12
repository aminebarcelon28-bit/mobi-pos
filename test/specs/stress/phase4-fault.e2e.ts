import { browser } from '@wdio/globals';
import { expect } from '@wdio/globals';
import {
  installErrorTrap,
  readErrors,
  unlockIfNeeded,
  clearWebMirrors,
  openShiftUi,
  clearCart,
  invoke,
  readOpenShiftDexie,
} from '../../helpers/pos';
import { assertLedgerClean } from '../../../e2e/lib/ledger';

/**
 * Phase 4 Tier D campaign worker: performs FAULT_N (default 3) hook-driven
 * sales then exits. The outer campaign (scripts/fault-campaign.mjs) kills
 * mobi-pos.exe at a random offset mid-run; a killed run aborts with a
 * session error (EXPECTED — counts as "kill landed", not a failure).
 * Survivors assert the ledger clean. Atomicity across kills is verified
 * out-of-band by scripts/check-atomicity.mjs after every cycle.
 * Env: FAULT_N (default 3), FAULT_TAG (default 'F').
 */
const FAULT_N = Number(process.env.FAULT_N ?? 3);
const FAULT_TAG = process.env.FAULT_TAG ?? 'F';
// FAULT_RESET=1 wipes+seeds (cycle 1 baseline only); later cycles continue
// the SAME container so kills accumulate crash-continuity evidence.
const FAULT_RESET = process.env.FAULT_RESET ?? '1';

describe('FAULT campaign worker (Phase 4)', function () {
  this.timeout(10 * 60_000);

  it(`[T-DW] ${FAULT_N} sales for kill cycle ${FAULT_TAG}`, async () => {
    await installErrorTrap();
    if (FAULT_RESET === '1') {
      await invoke('e2e_reset_and_seed', { fixture: 'stress' });
      await clearWebMirrors();
    }
    await unlockIfNeeded();
    if (!(await readOpenShiftDexie())) {
      await openShiftUi(100000);
    }
    const baskets = Array.from({ length: FAULT_N }, (_, i) => ({
      lines: [{ id: ['E2E-STR-A', 'E2E-STR-B', 'E2E-STR-C'][i % 3], qty: 1 }],
      tenderedDa: [500, 1500, 3000][i % 3],
    }));
    const res = (await browser.execute(async (b) => {
      const w = window as unknown as {
        __posStress?: {
          runBatch: (
            x: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
          ) => Promise<Array<{ ok: boolean; reason?: string }>>;
        };
      };
      return w.__posStress!.runBatch(b);
    }, baskets)) as Array<{ ok: boolean; reason?: string }>;
    const okCount = res.filter((r) => r.ok).length;
    console.log(`[fault] cycle ${FAULT_TAG}: ${okCount}/${FAULT_N} sales ok`);
    expect(okCount).toBe(FAULT_N);
    await assertLedgerClean();
    await clearCart();
    expect(await readErrors()).toEqual([]);
  });
});
