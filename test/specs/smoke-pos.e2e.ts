import { expect, browser, $, $$ } from '@wdio/globals';
import {
  tid,
  APP_PIN,
  DA,
  displayedToMinor,
  installErrorTrap,
  readErrors,
  unlockIfNeeded,
  ledger,
  getSale,
  openShiftUi,
  readOpenShiftDexie,
  seedSmoke,
  clearWebMirrors,
  SMOKE_PRICES,
  SMOKE_SHIFT_OPENING,
} from '../helpers/pos';

/**
 * Phase 2 smoke on the real till (owner direction 2026-10-08, pre-launch).
 * Safety: wdio.conf.ts snapshots the live DB pre-run and restores it
 * post-run (pass or fail) unless PRESERVE_TEST_DB=1.
 *
 * Conventions: no browser.pause (waits only), no retries, testid locators
 * only, money asserted as integer minor units from the rule (HT-only,
 * no VAT: total = sum of lines), deltas (not absolutes) wherever sales
 * accumulate, three-way check (oracle vs UI vs stored) on every sale.
 */

async function cartLines() {
  return await $$(tid('cart-line'));
}

async function cartTotalMinor() {
  const el = await $(tid('cart-total'));
  await el.waitForDisplayed({ timeout: 15000 });
  return displayedToMinor(await el.getText());
}

async function searchCatalog(q: string, expectTiles: number) {
  const search = await $(tid('catalog-search'));
  await search.waitForDisplayed({ timeout: 15000 });
  await search.setValue(q);
  await browser.keys(['Enter']);
  await browser.waitUntil(
    async () => (await $$(tid('product-tile'))).length === expectTiles,
    { timeout: 15000, timeoutMsg: `catalog search "${q}" -> ${expectTiles} tiles` },
  );
}

async function clearSearch() {
  const search = await $(tid('catalog-search'));
  await search.setValue('');
  await browser.keys(['Enter']);
}

async function addTileByIndex(i: number) {
  const tiles = await $$(tid('product-tile'));
  await tiles[i].scrollIntoView();
  await tiles[i].click();
}

/** Click pay-confirm and wait for close; on failure log the dialog text
 * (rejection reason, e.g. NO_ACTIVE_SHIFT) before rethrowing. */
async function confirmPay(label: string) {
  await (await $(tid('pay-confirm'))).click();
  try {
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 30000, timeoutMsg: `pay dialog did not close (${label})` },
    );
  } catch (e) {
    const text = await $(tid('pay-dialog'))
      .getText()
      .catch(() => '<dialog gone>');
    console.log(`[smoke] ${label} dialog stuck open, text: ${text.slice(0, 400)}`);
    throw e;
  }
}

async function waitNewSale(beforeId: string | null) {  let id = '';
  await browser.waitUntil(
    async () => {
      const st = await ledger();
      id = st.recentSales[0]?.id ?? '';
      return id !== '' && id !== beforeId;
    },
    { timeout: 30000, timeoutMsg: 'new sale did not land in ledger' },
  );
  return id;
}

describe('SMOKE real till', () => {
  before(async () => {
    await installErrorTrap();
    await seedSmoke();
    // Reboot UI state AFTER seeding: the store init re-reads SQLite
    // authority (seeded products). clearWebMirrors first so stale Dexie
    // mirrors cannot shadow the seeded rows.
    await clearWebMirrors();
    await unlockIfNeeded();
    // S0: open the shift through the real UI (Dexie authority for the
    // processPayment lane — a SQLite-only seed is invisible to it).
    await openShiftUi(SMOKE_SHIFT_OPENING);
    await searchCatalog('E2E-K', 8);
    await clearSearch();
  });

  it('S1 cold start lands on a working till', async () => {
    const header = await $('header');
    await header.waitForDisplayed({ timeout: 30000 });
    await expect(await $(tid('shift-pill')).isDisplayed()).toBe(true);
    // Shift authority for the UI lane is the Dexie mirror (startShift
    // writes Dexie-only); the SQLite oracle only sees sync/close rows.
    const shift = await readOpenShiftDexie();
    expect(shift?.status).toBe('OPEN');
    expect(Math.round(shift?.openingFloat ?? -1)).toBe(SMOKE_SHIFT_OPENING);
    console.log(`[smoke] shift pill: ${await (await $(tid('shift-pill'))).getText()}`);
  });

  it('S2 wrong PIN is rejected once; right PIN unlocks', async () => {
    await (await $(tid('lock-button'))).click();
    const lock = await $(tid('lock-screen'));
    await lock.waitForDisplayed({ timeout: 15000 });
    await (await $(tid('login-pin-pad'))).click();
    await browser.keys('731946'.split(''));
    await browser.waitUntil(
      async () => (await $(tid('lock-screen')).isDisplayed().catch(() => false)),
      { timeout: 5000, timeoutMsg: 'lock screen vanished without valid PIN' },
    );
    // Still locked after one wrong attempt (single attempt: ladder-safe).
    expect(await (await $(tid('lock-screen'))).isDisplayed()).toBe(true);
    await (await $(tid('login-pin-pad'))).click();
    await browser.keys(APP_PIN.split(''));
    const submit = await $(tid('login-submit'));
    if (await submit.isDisplayed().catch(() => false)) await submit.click();
    await (await $('header')).waitForDisplayed({ timeout: 90000 });
  });

  it('S3 one product lands in cart at oracle total', async () => {
    await searchCatalog('E2E-K1', 1);
    await addTileByIndex(0);
    await clearSearch();
    expect((await cartLines()).length).toBe(1);
    expect(await cartTotalMinor()).toBe(DA(SMOKE_PRICES[0]));
  });

  it('S4 eight lines are all reachable and total is exact', async () => {
    // K1 is already in the cart from S3; add K2..K8 by single-result SKU
    // search (order-independent — never relies on catalog sort).
    for (let k = 2; k <= 8; k++) {
      await searchCatalog(`E2E-K${k}`, 1);
      await addTileByIndex(0);
    }
    await clearSearch();
    const lines = await cartLines();
    expect(lines.length).toBe(8);
    await lines[7].scrollIntoView();
    expect(await lines[7].isDisplayed()).toBe(true);
    const expected = SMOKE_PRICES.reduce((a, p) => a + DA(p), 0n);
    expect(await cartTotalMinor()).toBe(expected); // 18 000 DA
  });

  it('S11 fr-DZ total renders sane (DA, no NaN, LTR)', async () => {
    const text = await (await $(tid('cart-total'))).getText();
    expect(text).toMatch(/DA/);
    expect(text).not.toMatch(/NaN|undefined/);
    expect(displayedToMinor(text)).toBe(18000n * 100n);
    const dir = await browser.execute(() => document.documentElement.dir || 'ltr');
    expect(dir).not.toBe('rtl');
  });

  it('S5 exact cash sale writes exactly one sale, change 0', async () => {
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    expect(displayedToMinor(await (await $(tid('pay-net'))).getText())).toBe(18000n * 100n);
    await (await $(tid('pay-exact'))).click();
    await confirmPay('S5 exact');
    const id = await waitNewSale(before);
    const sale = await getSale(id);
    expect(sale.found).toBe(true);
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(18000n * 100n);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
    expect(sale.paymentMethod).toBe('Espèces');
    expect(sale.lines.length).toBe(8);
    expect((await cartLines()).length).toBe(0);
  });

  it('S6 cash with change shows and stores oracle change', async () => {
    await searchCatalog('E2E-K2', 1);
    await addTileByIndex(0);
    await clearSearch();
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    const tendered = await $(tid('tendered-input'));
    await tendered.waitForDisplayed({ timeout: 15000 });
    await tendered.setValue('1500');
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 500n * 100n,
      { timeout: 15000, timeoutMsg: 'change did not settle to 500 DA' },
    );
    await confirmPay('S6 change');
    const id = await waitNewSale(before);
    const sale = await getSale(id);
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(1000n * 100n);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(500n * 100n);
  });

  it('S7 cancelling mid-sale writes nothing and keeps the cart', async () => {
    await searchCatalog('E2E-K3', 1);
    await addTileByIndex(0);
    await clearSearch();
    const beforeId = (await ledger()).recentSales[0]?.id ?? null;
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 10000, timeoutMsg: 'pay dialog did not cancel' },
    );
    expect(((await ledger()).recentSales[0]?.id ?? null)).toBe(beforeId);
    expect((await cartLines()).length).toBe(1);
    // cleanup: remove the line for a clean next test
    await (await $$(tid('cart-line-remove')))[0].click();
    expect((await cartLines()).length).toBe(0);
  });

  it('S8 double-tapping pay finalizes exactly once', async () => {
    await searchCatalog('E2E-K4', 1);
    await addTileByIndex(0);
    await clearSearch();
    const st0 = await ledger();
    const n0 = st0.tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('pay-exact'))).click();
    const confirm = await $(tid('pay-confirm'));
    await confirm.click();
    await confirm.click().catch(() => {});
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 30000, timeoutMsg: 'pay dialog did not close after double-tap' },
    );
    const n1 = (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    expect(n1 - n0).toBe(1);
  });

  it('S9 refund surface opens read-only (cashier-role matrix deferred)', async () => {
    // Full cashier-role matrix needs a provisioned cashier (unknown 4-digit
    // PINs on real data + single-attempt lockout safety) — Phase 3.
    // Here: the surface exists and opens/closes without moving money.
    const n0 = (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    await (await $(tid('refund-button'))).click();
    await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 15000 });
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => !(await $(tid('refund-dialog')).isDisplayed().catch(() => false)),
      { timeout: 10000, timeoutMsg: 'refund dialog did not close' },
    );
    const n1 = (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    expect(n1).toBe(n0);
  });

  it('S10 manager step-up: wrong PIN denies, right PIN halves the total', async () => {
    await searchCatalog('E2E-K5', 1);
    await addTileByIndex(0);
    await clearSearch();
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('50');
    const pin = await $(tid('discount-pin'));
    await pin.waitForDisplayed({ timeout: 10000 });
    await pin.setValue('000000');
    await (await $(tid('discount-apply'))).click();
    // Denied: dialog stays open and the total is untouched (2500 DA).
    expect(await (await $(tid('discount-dialog'))).isDisplayed()).toBe(true);
    expect(await cartTotalMinor()).toBe(DA(2500));
    await pin.setValue(APP_PIN);
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'discount dialog did not apply with manager PIN' },
    );
    expect(await cartTotalMinor()).toBe(DA(1250));
    await (await $$(tid('cart-line-remove')))[0].click();
    expect((await cartLines()).length).toBe(0);
  });

  it('S12 finalized sale survives a session reload', async () => {
    const target = (await ledger()).recentSales[0]?.id ?? '';
    expect(target !== '').toBe(true);
    await browser.reloadSession();
    await (await $('#root')).waitForExist({ timeout: 90000 });
    const sale = await getSale(target);
    expect(sale.found).toBe(true);
    expect(sale.status).toBe('COMPLETED');
  });

  it('S13 shift Z-math equals the oracle', async () => {
    // S5 18000 + S6 1000 + S8 2000, all Espèces, no refunds.
    // Authorities: opening lives in Dexie (UI lane), cash lanes in SQLite.
    const st = await ledger();
    const shift = await readOpenShiftDexie();
    expect(shift?.status).toBe('OPEN');
    const opening = BigInt(Math.round((shift?.openingFloat ?? -1) * 100));
    expect(opening).toBe(BigInt(SMOKE_SHIFT_OPENING) * 100n);
    const expectedSales = DA(18000 + 1000 + 2000);
    expect(BigInt(Math.round(st.shiftSummary.cashSalesDa * 100))).toBe(expectedSales);
    expect(BigInt(Math.round(st.shiftSummary.cashRefundsDa * 100))).toBe(0n);
    // Till cash position composes both authorities.
    const expectedCash = BigInt(SMOKE_SHIFT_OPENING) * 100n + expectedSales;
    const actualCash =
      opening +
      BigInt(Math.round(st.shiftSummary.cashSalesDa * 100)) -
      BigInt(Math.round(st.shiftSummary.cashRefundsDa * 100));
    expect(actualCash).toBe(expectedCash);
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });
});
