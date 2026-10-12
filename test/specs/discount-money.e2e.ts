import { expect, browser, $, $$ } from '@wdio/globals';
import {
  tid,
  APP_PIN,
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
} from '../helpers/pos';

/**
 * Phase 3.1 — discount engine + rounding (HT-only, integer DA).
 * Independent oracle (BigInt, half-up) written from the implemented rule:
 * cart-% distributes per line as round(lineGross * pct / 100); the receipt
 * total is gross minus stored line discounts. Promo codes occupy the same
 * single discount slot (overwrite, never stack).
 *
 * Rule drift on record: receiptMath.ts documents a SINGLE-SHOT cart-%
 * rounding point, but applyCartDiscountPercent distributes per line. D2
 * quantifies the 1 DA difference (600 observed vs 599 single-shot).
 */

const pctOff = (baseDa: bigint, pct: number): bigint =>
  (baseDa * BigInt(pct) + 50n) / 100n;

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

async function cartTotalMinor() {
  const el = await $(tid('cart-total'));
  await el.waitForDisplayed({ timeout: 15000 });
  return displayedToMinor(await el.getText());
}

async function openDiscount() {
  await (await $(tid('discount-button'))).click();
  await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
}

async function applyPercentNoPin(pct: string) {
  await (await $(tid('discount-percent'))).setValue(pct);
  await (await $(tid('discount-apply'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
    { timeout: 15000, timeoutMsg: 'discount dialog did not apply' },
  );
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

describe('MONEY discounts', () => {
  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-D1', title: 'E2E Disc A', priceDa: 333, stock: 50, barcode: 'EDB1' },
          { id: 'E2E-D2', title: 'E2E Disc B', priceDa: 333, stock: 50, barcode: 'EDB2' },
          { id: 'E2E-D3', title: 'E2E Disc C', priceDa: 2500, stock: 50, barcode: 'EDB3', costDa: 2000 },
          { id: 'E2E-D4', title: 'E2E Disc D', priceDa: 1000, stock: 50, barcode: 'EDB4' },
          { id: 'E2E-D5', title: 'E2E Disc E', priceDa: 2000, stock: 50, barcode: 'EDB5' },
        ],
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
  });

  it('D1 10% needs no PIN and stores exact discount (4000 -> 3600)', async () => {
    await addSku('E2E-D5', 2); // one line, qty 2, gross 4000
    expect(await cartTotalMinor()).toBe(4000n * 100n);
    await openDiscount();
    await applyPercentNoPin('10');
    expect(await cartTotalMinor()).toBe(3600n * 100n);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(3600n * 100n);
    expect(BigInt(Math.round(sale.discountTotalDa * 100))).toBe(400n * 100n);
    expect(sale.lines[0]?.quantity).toBe(2);
  });

  it('D2 per-line rounding is observable (2x333 @10% -> 600, not 599)', async () => {
    await addSku('E2E-D1');
    await addSku('E2E-D2');
    // Independent oracle: per-line half-up 33 + 33 = 66 discount.
    // A single-shot rule would give round(666 * 10%) = 67.
    expect(pctOff(333n, 10) + pctOff(333n, 10)).toBe(66n);
    await openDiscount();
    await applyPercentNoPin('10');
    expect(await cartTotalMinor()).toBe(600n * 100n);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(600n * 100n);
    expect(BigInt(Math.round(sale.discountTotalDa * 100))).toBe(66n * 100n);
    console.log('[money] D2 documents per-line rounding: 600 stored (single-shot would be 599)');
  });

  it('D3 override markdown stacks under cart-% (2500 -> 2000 -> 1800)', async () => {
    await addSku('E2E-D3');
    // Exactly -20% and above cost: no gate expected.
    await (await $$(tid('price-override-open')))[0].click();
    const input = await $(tid('price-override-input'));
    await input.waitForDisplayed({ timeout: 10000 });
    await input.setValue('2000');
    await (await $(tid('price-override-apply'))).click();
    expect(await cartTotalMinor()).toBe(2000n * 100n);
    await openDiscount();
    await applyPercentNoPin('10');
    expect(await cartTotalMinor()).toBe(1800n * 100n);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(1800n * 100n);
    expect(BigInt(Math.round(sale.discountTotalDa * 100))).toBe(200n * 100n);
    expect(BigInt(Math.round(sale.lines[0]?.appliedPriceDa ?? -1))).toBe(2000n);
  });

  it('D4 100% discount tenders a 0-total without crashing', async () => {
    await addSku('E2E-D4');
    await openDiscount();
    await (await $(tid('discount-percent'))).setValue('100');
    const pin = await $(tid('discount-pin'));
    await pin.waitForDisplayed({ timeout: 10000 });
    await pin.setValue(APP_PIN);
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'discount dialog did not apply 100%' },
    );
    expect(await cartTotalMinor()).toBe(0n);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    // Either a clean 0-sale finalizes or the lane blocks it — both are
    // deterministic; a crash or a phantom positive total is not. The settle
    // window below is the sanctioned last resort (no signal exists for
    // "blocked", only the absence of a new sale).
    await browser.pause(2500);
    const dialogOpen = await $(tid('pay-dialog')).isDisplayed().catch(() => false);
    const afterId = (await ledger()).recentSales[0]?.id ?? null;
    if (!dialogOpen && afterId !== before) {
      const sale = await getSale(afterId!);
      console.log(`[money] D4 zero-total finalized: total=${sale.totalDa} change=${sale.changeDueDa}`);
      expect(BigInt(Math.round(sale.totalDa * 100))).toBe(0n);
      expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
    } else {
      console.log('[money] D4 zero-total blocked at tender (no sale written)');
      expect(afterId).toBe(before);
      await (await $(tid('pay-cancel'))).click();
      await browser.waitUntil(
        async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
        { timeout: 10000, timeoutMsg: 'pay dialog did not cancel' },
        );
    }
    await clearCart();
  });

  it('D5 percent above 100 clamps to a non-negative total', async () => {
    await addSku('E2E-D5');
    await openDiscount();
    await (await $(tid('discount-percent'))).setValue('150');
    // The LIVE modal total clamps at zero (safePercent <= 100); the cart
    // itself is untouched until Appliquer — assert the modal figure.
    const live = await $(tid('discount-live-total'));
    await live.waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(
      async () => displayedToMinor(await live.getText()) === 0n,
      { timeout: 10000, timeoutMsg: 'clamped live total did not reach 0' },
    );
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 10000, timeoutMsg: 'discount dialog did not cancel' },
    );
    expect(await cartTotalMinor()).toBe(2000n * 100n);
    await clearCart();
  });

  it('D6 below-cost and zero-price overrides gate on manager PIN', async () => {
    await addSku('E2E-D3'); // price 2500, cost 2000
    await (await $$(tid('price-override-open')))[0].click();
    const input = await $(tid('price-override-input'));
    await input.waitForDisplayed({ timeout: 10000 });
    await input.setValue('1500'); // below cost + 40% off: both gates
    await (await $(tid('price-override-apply'))).click();
    // Gate: price unchanged while PIN missing/wrong.
    expect(await cartTotalMinor()).toBe(2500n * 100n);
    const pin = await $(tid('price-override-pin'));
    await pin.waitForDisplayed({ timeout: 10000 });
    await pin.setValue('000000');
    await (await $(tid('price-override-apply'))).click();
    expect(await cartTotalMinor()).toBe(2500n * 100n);
    await pin.setValue(APP_PIN);
    await (await $(tid('price-override-apply'))).click();
    await browser.waitUntil(
      async () => (await cartTotalMinor()) === 1500n * 100n,
      { timeout: 10000, timeoutMsg: 'manager-approved override did not apply' },
    );
    // Stored below-cost line proves the gate does not corrupt the line.
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(1500n * 100n);
    expect(BigInt(Math.round(sale.lines[0]?.appliedPriceDa ?? -1))).toBe(1500n);
  });

  it('D7 double-tapping apply discounts exactly once', async () => {
    await addSku('E2E-D4');
    await openDiscount();
    await (await $(tid('discount-percent'))).setValue('10');
    const apply = await $(tid('discount-apply'));
    await apply.click();
    await apply.click().catch(() => {});
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'discount dialog did not close' },
    );
    expect(await cartTotalMinor()).toBe(900n * 100n);
    await clearCart();
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  // Belt-and-braces: a failing test must not poison the next one's cart.
  afterEach(async () => {
    await clearCart();
  });
});
