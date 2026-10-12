import { expect, browser, $, $$ } from '@wdio/globals';
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
} from '../../helpers/pos';
import { computeInvoice, toMinorFromDa } from '../../../e2e/lib/oracle';
import { assertLedgerClean } from '../../../e2e/lib/ledger';

/**
 * Phase 4 Tier C — UI bursts (isolated `.e2e`, HT-only integer DA).
 * Bounded for in-session execution: 30 scanner-burst UI checkouts + a
 * SOAK_MIN-minute mixed buy loop while scripts/sample-proc.mjs (started
 * separately, --image mobi-pos.exe) samples RSS/handles. Full 200-sale /
 * 60-minute soak is the nightly shape (same spec, POS_SOAK_MIN=60).
 *
 * Env: POS_SOAK_MIN (default 12), STRESS_SEED (default 20260410).
 */

const SOAK_MIN = Number(process.env.POS_SOAK_MIN ?? 12);
const SEED = Number(process.env.STRESS_SEED ?? 20260410);
const BURST_SALES = 30;
console.log(`POS_SOAK_MIN=${SOAK_MIN} STRESS_SEED=${SEED}`);

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKUS = [
  { sku: 'E2E-STR-A', priceDa: 500 },
  { sku: 'E2E-STR-B', priceDa: 1500 },
  { sku: 'E2E-STR-C', priceDa: 3000 },
];

async function scannerAdd(sku: string) {
  // Scanner-speed input: full code + Enter as one rapid key sequence.
  const search = await $(tid('catalog-search'));
  await search.waitForDisplayed({ timeout: 15000 });
  await search.setValue(sku);
  await browser.keys(['Enter']);
  await browser.waitUntil(
    async () => (await $$(tid('product-tile'))).length === 1,
    { timeout: 15000, timeoutMsg: `single tile for burst ${sku}` },
  );
  await (await $$(tid('product-tile')))[0].click();
  await search.setValue('');
  await browser.keys(['Enter']);
}

async function payExactUi() {
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

describe('SOAK Tier C (Phase 4)', function () {
  this.timeout(70 * 60_000);

  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_and_seed', { fixture: 'stress' });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
  });

  afterEach(async () => {
    await assertLedgerClean();
    await clearCart();
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  it(`[T-C1] UI burst: ${BURST_SALES} scanner-speed exact checkouts land exact`, async () => {
    const rnd = mulberry32(SEED);
    const tx0 =
      (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    let expectSum = 0n;
    for (let i = 0; i < BURST_SALES; i++) {
      const sku = SKUS[Math.floor(rnd() * SKUS.length)];
      const qty = 1 + Math.floor(rnd() * 2);
      await scannerAdd(sku.sku);
      if (qty === 2) {
        await scannerAdd(sku.sku);
      }
      const want = computeInvoice([{ unit: BigInt(sku.priceDa) * 100n, qty }]).total;
      expectSum += want;
      const before = (await ledger()).recentSales[0]?.id ?? null;
      await payExactUi();
      const sale = await getSale(await waitNewSale(before));
      expect(toMinorFromDa(sale.totalDa)).toBe(want);
      if ((i + 1) % 10 === 0) console.log(`[soak] T-C1 ${i + 1}/${BURST_SALES}`);
    }
    const tx1 =
      (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    expect(tx1 - tx0).toBe(BURST_SALES);
    console.log(`[soak] T-C1 done: ${BURST_SALES} sales, oracle sum=${expectSum}`);
  });

  it('[T-C2] soak loop: mixed buys for POS_SOAK_MIN with ledger clean', async () => {
    const deadline = Date.now() + SOAK_MIN * 60_000;
    let n = 0;
    let sales = 0;
    while (Date.now() < deadline) {
      const sku = SKUS[n % SKUS.length];
      await scannerAdd(sku.sku);
      // Every 4th cycle: overpay exact-change path instead of exact.
      if (n % 4 === 3) {
        await (await $(tid('checkout-button'))).click();
        await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
        await (await $(tid('tendered-input'))).setValue(String(sku.priceDa * 2));
        await browser.waitUntil(
          async () =>
            displayedToMinor(await (await $(tid('pay-change'))).getText()) ===
            BigInt(sku.priceDa) * 100n,
          { timeout: 15000, timeoutMsg: 'soak change did not settle' },
        );
        const before = (await ledger()).recentSales[0]?.id ?? null;
        await (await $(tid('pay-confirm'))).click();
        await browser.waitUntil(
          async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
          { timeout: 30000, timeoutMsg: 'soak pay dialog did not close' },
        );
        await getSale(await waitNewSale(before));
      } else {
        const before = (await ledger()).recentSales[0]?.id ?? null;
        await payExactUi();
        await waitNewSale(before);
      }
      sales++;
      n++;
      if (n % 5 === 0) {
        await assertLedgerClean();
        console.log(`[soak] T-C2 sales=${sales} elapsed=${((Date.now() - (deadline - SOAK_MIN * 60_000)) / 60000).toFixed(1)}min`);
      }
    }
    console.log(`[soak] T-C2 done: ${sales} soak sales in ${SOAK_MIN}min`);
    expect(sales).toBeGreaterThan(0);
  });
});
