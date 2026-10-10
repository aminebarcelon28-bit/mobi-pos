import { expect, browser, $, $$ } from '@wdio/globals';
import {
  tid,
  shown,
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
  stockOf,
} from '../helpers/pos';

/**
 * Phase 3.4b — numeric boundaries (HT-only, integer DA).
 * - C.1 documents DEFECT-CQTY-01: the quantity field strips non-digits, so
 *   typing "1.5" commits 15 units (no rejection, no truncation to integer).
 *   The STORAGE invariant (integer quantities, never floats) holds and is
 *   asserted; the mapping defect is reported, not enshrined.
 * - C.2 proves exact integer math at ~1e11 DA (well within i64, beyond
 *   casual float range) end to end: UI total == stored == oracle.
 */

async function addSku(sku: string, times = 1) {
  const search = await $(tid('catalog-search'));
  await search.waitForDisplayed({ timeout: 15000 });
  await search.setValue(sku);
  await browser.keys(['Enter']);
  await browser.waitUntil(
    async () => (await $$(tid('product-tile'))).length === 1,
    { timeout: 15000, timeoutMsg: `single tile for ${sku}` },
  );
  for (let i = 0; i < times; i++) {
    await (await $$(tid('product-tile')))[0].click();
  }
  await search.setValue('');
  await browser.keys(['Enter']);
}

async function payExactFlow() {
  await (await $(tid('checkout-button'))).click();
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
  await (await $(tid('pay-exact'))).click();
  await (await $(tid('pay-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
    { timeout: 30000, timeoutMsg: 'pay dialog did not close' },
  );
}

async function waitNewSale(beforeId: string | null) {
  let id = '';
  await browser.waitUntil(
    async () => {
      const st = await ledger();
      id = st.recentSales[0]?.id ?? '';
      return id !== '' && id !== beforeId;
    },
    { timeout: 30000, timeoutMsg: 'new sale did not land' },
  );
  return id;
}

describe('MONEY numeric boundaries', () => {
  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-N1', title: 'E2E Num A', priceDa: 1000, stock: 100, barcode: 'ENB1' },
          { id: 'E2E-N9', title: 'E2E Num Huge', priceDa: 999999999, stock: 200, barcode: 'ENB9' },
        ],
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
  });

  it('C1 fractional quantity input is rejected, never coerced', async () => {
    await addSku('E2E-N1');
    // Owner decision (hard reject): typing "1.5" must NOT commit any
    // quantity change — neither 15 (digits-stripped coercion, the old
    // behavior) nor a float. The line stays at 1 until a valid entry.
    // RED until the CartQtyInput mask lands (tripwire by design).
    const qty = await shown('cart-qty-input');
    await qty.click();
    await qty.setValue('1.5');
    await browser.keys(['Enter']);
    await browser.pause(1000);
    const lines = await $$(tid('cart-line'));
    expect(lines.length).toBe(1);
    // Storage invariant holds regardless: integers only, never floats.
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(Number.isInteger(sale.lines[0]?.quantity)).toBe(true);
    expect(sale.lines[0]?.quantity).toBe(1);
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(1000n * 100n);
    expect((await stockOf('E2E-N1')).ledger).toBe(100 - 1);
  });

  it('C2 nine-digit price stays exact end to end (~1e11 DA)', async () => {
    await addSku('E2E-N9'); // single line first
    // Commit the bulk quantity in one shot: 100 rapid tile clicks can lose
    // a click to re-renders (proven flaky once) — the qty field is the
    // deterministic path and exercises the same commit lane.
    const qty = await shown('cart-qty-input');
    await qty.click();
    await qty.setValue('100');
    await browser.keys(['Enter']);
    const oracle = 999999999n * 100n;
    const el = await $(tid('cart-total'));
    await el.waitForDisplayed({ timeout: 15000 });
    expect(displayedToMinor(await el.getText())).toBe(oracle * 100n);
    const safe = (await browser.execute(
      (v: string) => Number.isSafeInteger(Number(v)),
      oracle.toString(),
    )) as boolean;
    expect(safe).toBe(true);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(oracle * 100n);
    expect((await stockOf('E2E-N9')).ledger).toBe(200 - 100);
    console.log('[money] C2 exact at 99 999 999 900 DA through UI, tender and storage');
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  afterEach(async () => {
    await clearCart();
  });
});
