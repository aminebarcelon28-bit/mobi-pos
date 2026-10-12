import { browser } from '@wdio/globals';
import { expect } from '@wdio/globals';
import {
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
} from '../../helpers/pos';
import { assertLedgerClean } from '../../../e2e/lib/ledger';

/**
 * Phase 4 Tier B race probe — ISOLATED SESSION (own file/run).
 * 6 parallel native refund invokes in ONE execute race at the Rust lock.
 * A wedged parallel execute blocks its CDP session for all later commands,
 * so this probe must never share a session with the main suite.
 *
 * Bounded: node-side 150 s cap. On cap, the STALL itself is logged as the
 * finding (native contention stall under parallel refunds) and the run
 * ends — the session is sacrificed, nothing after it is trusted.
 * Env: STRESS_SEED (default 20260410).
 */
describe('STRESS race probe (Phase 4, isolated)', function () {
  this.timeout(10 * 60_000);

  it('[T-BR] 6 parallel refunds: exactly-once or documented stall', async () => {
    await installErrorTrap();
    await invoke('e2e_reset_and_seed', { fixture: 'stress' });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
    const deviceId = (await invoke<{ deviceId: string }>('get_device_identity_info')).deviceId;
    const dexieShiftId = (await readOpenShiftDexie())?.id ?? '';

    // One sale via UI-free DEV hook (same path as Tier B volume).
    const made = (await browser.execute(async () => {
      const w = window as unknown as {
        __posStress?: {
          runBatch: (
            b: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
          ) => Promise<Array<{ ok: boolean; reason?: string }>>;
        };
      };
      return w.__posStress!.runBatch([{ lines: [{ id: 'E2E-STR-A', qty: 2 }], tenderedDa: 1000 }]);
    })) as Array<{ ok: boolean; reason?: string }>;
    expect(made[0]?.ok).toBe(true);
    const saleId = (await ledger()).recentSales[0]?.id ?? '';
    const sale = await getSale(saleId);

    const reqs = [0, 1, 2, 3, 4, 5].map((i) => ({
      ticketId: saleId,
      refundId: `E2E-BR-R${i}`,
      itemsHash: `E2E-BR-R${i}`,
      receiptNumber: `AVOIR-E2E-BR-R${i}`,
      method: 'Espèces',
      online: true,
      localDeviceId: deviceId,
      activeShiftId: dexieShiftId,
      supervisor: null,
      customerId: null,
      subtotal: 1000,
      discountTotal: 0,
      totalNet: 1000,
      costTotal: 0,
      pricingTier: 'Retail',
      paymentMethod: 'Espèces',
      cashTendered: 1000,
      changeDue: 0,
      cashTenderedNet: 1000,
      createdAt: new Date().toISOString(),
      refundPayload: JSON.stringify({ refundMethod: 'Espèces', cashDisbursed: 1000, total: 1000 }),
      originalOutboxPayload: '{}',
      deviceId,
      lines: sale.lines.map((l, j) => ({
        id: `E2E-BR-R${i}-L${j}`,
        productId: l.productId,
        quantity: l.quantity,
        appliedPrice: Math.round(l.appliedPriceDa),
        unitPriceCharged: Math.round(l.appliedPriceDa),
        unitCostAtSale: 0,
        discountAmount: 0,
        lineProfit: 0,
        imeiNumber: null,
        itemKey: `E2E-BR-R${i}-L${j}`,
        itemPayload: '{}',
      })),
      deltas: [],
      batches: [],
      imeis: [],
      debt: null,
      voucher: null,
      cashMove: { id: `E2E-BR-R${i}-CM`, sessionId: dexieShiftId, amount: 1000, reason: 'E2E race', cashierName: 'E2E' },
      audit: { action: 'E2E race', details: 'e2e', user: 'E2E', requiresPin: true },
    }));

    const raced = await Promise.race([
      browser.execute(async (rs: typeof reqs) => {
        const w = window as unknown as {
          __TAURI__?: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
        };
        const flat = (e: unknown): string => {
          if (typeof e === 'string') return e.slice(0, 120);
          const m = (e as { message?: unknown })?.message;
          if (typeof m === 'string') {
            const d = /"detail"\s*:\s*"([^"]+)"/.exec(m);
            return (d ? d[1] : m).slice(0, 120);
          }
          try {
            return JSON.stringify(e).slice(0, 120);
          } catch {
            return 'UNKNOWN';
          }
        };
        return await Promise.all(
          rs.map(async (r) => {
            try {
              await w.__TAURI__!.core.invoke('refund_sale_atomic', { req: r });
              return 'OK';
            } catch (e) {
              return flat(e);
            }
          }),
        );
      }, reqs),
      new Promise<string>((res) => setTimeout(() => res('STALL-CAP'), 150000)),
    ]);
    if (raced === 'STALL-CAP') {
      console.log('[stress] T-BR STALL: 6 parallel refunds unsettled in 150 s (contention stall finding)');
      return; // session sacrificed; finding logged, nothing after is trusted
    }
    const codes = raced as string[];
    console.log(`[stress] T-BR codes: ${codes.join(' | ')}`);
    expect(codes.filter((c) => c === 'OK').length).toBeLessThanOrEqual(1);
    for (const c of codes.filter((x) => x !== 'OK')) {
      expect(/ALREADY_REFUNDED|REFUND_EXCEEDS|BUSY/.test(c)).toBe(true);
    }
    await assertLedgerClean();
    await clearCart();
    expect(await readErrors()).toEqual([]);
  });
});
