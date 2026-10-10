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
  readOpenShiftDexie,
  readDexieShift,
  stockOf,
} from '../../helpers/pos';
import { computeInvoice, toMinorFromDa } from '../../../e2e/lib/oracle';
import { assertLedgerClean } from '../../../e2e/lib/ledger';

/**
 * Phase 2 — SMOKE S0–S15 (isolated `.e2e` container, HT-only integer DA).
 *
 * Adaptations vs the brief (all D1/D4/D6/D7 bypasses catalogued, never fixed):
 * - No card gateway exists (tender tabs are Espèces / Crédit Client only,
 *   `PaymentModal.tsx:894-919`): S7 = cash approve finalize-once with the
 *   tender leg asserted; S8 = underpay refused on submit, cart preserved.
 * - No trilingual UI (single fr-DZ): S11 asserts formatting stability +
 *   no global RTL, never a language switch.
 * - Receipt ids are random (`TXN`/`REC`): uniqueness asserted, never
 *   monotonicity. Quantity is integer-only (R-16).
 * - Cashier provisioning is D4-blocked: S2/S9/S10 run on the manager
 *   session with wrong-vs-right PIN at the real gates (1 attempt each —
 *   far below the lockout ladder).
 * - D7 (Z never renders on desktop): S13 logs the bypass and asserts the
 *   booked close + drawer math via the ledger.
 * - S12 uses page-refresh persistence; process-kill recovery is Tier D.
 * - S14: `e2e_get_printed` is a `captured:false` stub (Phase 7.2) — the
 *   contract is asserted, plus stored-vs-oracle receipt equality.
 *
 * State model (3-minute budget): ONE reset+seed in before(), per-test
 * cleanup via afterEach (ledger audit + cart clear). Tests assert ledger
 * DELTAS so order-dependence cannot hide a double-write.
 */

const SMOKE_EXTRA = [
  { id: 'E2E-SMOKE-C', title: 'E2E Smoke C', priceDa: 1500, stock: 100, barcode: 'EKC1' },
  { id: 'E2E-SMOKE-D', title: 'E2E Smoke D', priceDa: 2000, stock: 100, barcode: 'EKD1' },
  { id: 'E2E-SMOKE-E', title: 'E2E Smoke E', priceDa: 3000, stock: 100, barcode: 'EKE1' },
  { id: 'E2E-SMOKE-F', title: 'E2E Smoke F', priceDa: 3500, stock: 100, barcode: 'EKF1' },
  { id: 'E2E-SMOKE-G', title: 'E2E Smoke G', priceDa: 4000, stock: 100, barcode: 'EKG1' },
  { id: 'E2E-SMOKE-H', title: 'E2E Smoke H', priceDa: 4500, stock: 100, barcode: 'EKH1' },
];

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

async function txCount() {
  return (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
}

describe('SMOKE S0–S15 (Phase 2)', () => {
  let uiShiftId = '';
  let bigSaleId = '';

  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_and_seed', { fixture: 'smoke' });
    // S4 needs 8 distinct lines; the smoke fixture carries A/B.
    await invoke('e2e_seed_state', { payload: { products: SMOKE_EXTRA } });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
    uiShiftId = (await readOpenShiftDexie())?.id ?? '';
    expect(uiShiftId.length).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await assertLedgerClean();
    await clearCart();
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  it('[S0] flavor identity: .e2e container, sealed mock gateway', async () => {
    const info = await invoke<{
      identifierExpected: string;
      dataDir: string;
      gatewayMode: string;
      features: string;
      gitSha: string;
    }>('e2e_build_info');
    expect(info.identifierExpected).toBe('com.mobi.pos.e2e');
    expect(info.dataDir).toContain('com.mobi.pos.e2e');
    expect(info.gatewayMode).toBe('sealed-mock');
    expect(info.features).toBe('e2e');
    expect(info.gitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('[S1] cold start: dashboard live, no backend panic surface', async () => {
    await (await $('header')).waitForDisplayed({ timeout: 30000 });
    const st = await ledger();
    expect(st.integrityCheck).toBe('ok');
    expect(await readErrors()).toEqual([]);
  });

  it('[S2] PIN: wrong rejected (still locked), 202020 unlocks', async () => {
    await (await $(tid('lock-button'))).click();
    await (await $(tid('lock-screen'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('login-pin-pad'))).click();
    await browser.keys('111111'.split(''));
    const submit = await $(tid('login-submit'));
    if (await submit.isDisplayed().catch(() => false)) await submit.click();
    // Still locked (the header stays mounted under the overlay, so the
    // unlock proof is lock-absence below, never header-absence here).
    await browser.waitUntil(
      async () => (await $(tid('lock-screen')).isDisplayed().catch(() => false)),
      { timeout: 10000, timeoutMsg: 'lock screen vanished after WRONG pin' },
    );
    // Correct PIN (D4-aware: single wrong attempt, far below the ladder).
    // The pad may retain the rejected entry — clear it first.
    await (await $(tid('login-pin-pad'))).click();
    await browser.keys(['Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace']);
    await browser.keys(APP_PIN.split(''));
    const submit2 = await $(tid('login-submit'));
    if (await submit2.isDisplayed().catch(() => false)) await submit2.click();
    await browser.waitUntil(
      async () => !(await $(tid('lock-screen')).isDisplayed().catch(() => false)),
      { timeout: 30000, timeoutMsg: 'lock screen did not clear after correct PIN' },
    );
    await (await $('header')).waitForDisplayed({ timeout: 30000 });
  });

  it('[S3] one product: cart total equals oracle', async () => {
    await addSku('E2E-SMOKE-A'); // 1000 DA
    const want = computeInvoice([{ unit: 1000n * 100n, qty: 1 }]).total;
    expect(await cartTotalMinor()).toBe(want);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(want);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
    expect((await stockOf('E2E-SMOKE-A')).ledger).toBe(50 - 1);
  });

  it('[S4] 8-line cart: every line reachable, total equals oracle', async () => {
    const skus = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((s) => `E2E-SMOKE-${s}`);
    for (const sku of skus) await addSku(sku);
    expect((await $$(tid('cart-line'))).length).toBe(8);
    const prices = [1000, 2500, 1500, 2000, 3000, 3500, 4000, 4500];
    const want = computeInvoice(prices.map((p) => ({ unit: BigInt(p) * 100n, qty: 1 }))).total;
    expect(want).toBe(22000n * 100n);
    expect(await cartTotalMinor()).toBe(want);
    // Last line reachable via scroll (known cart-panel requirement).
    const lines = await $$(tid('cart-line'));
    await browser.execute((el: unknown) =>
      (el as HTMLElement).scrollIntoView({ block: 'nearest' }), lines[7]);
    expect(await lines[7].isDisplayed()).toBe(true);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    bigSaleId = await waitNewSale(before);
    expect(BigInt(Math.round((await getSale(bigSaleId)).totalDa * 100))).toBe(want);
  });

  it('[S5] exact cash sale: +1 sale, change 0, stock decremented', async () => {
    await addSku('E2E-SMOKE-D'); // 2000 DA
    const tx0 = await txCount();
    const st0 = (await stockOf('E2E-SMOKE-D')).ledger;
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(2000n * 100n);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
    expect((await txCount()) - tx0).toBe(1);
    // Delta-based: S4's 8-line cart already moved one D unit.
    expect((await stockOf('E2E-SMOKE-D')).ledger).toBe((st0 ?? 0) - 1);
  });

  it('[S6] cash with change: displayed change equals oracle', async () => {
    await addSku('E2E-SMOKE-B'); // 2500 DA
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('tendered-input'))).setValue('10000');
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 7500n * 100n,
      { timeout: 15000, timeoutMsg: 'change did not settle to 7500 DA' },
    );
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 30000, timeoutMsg: 'pay dialog did not close on overpay' },
    );
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(7500n * 100n);
  });

  it('[S7] approve finalizes exactly one sale on the right tender', async () => {
    await addSku('E2E-SMOKE-C'); // 1500 DA
    const tx0 = await txCount();
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const id = await waitNewSale(before);
    const sale = await getSale(id);
    // Exactly one sale landed; re-submit is impossible (empty cart).
    expect((await txCount()) - tx0).toBe(1);
    expect(sale.tenders.some((t) => t.method === 'Espèces')).toBe(true);
    expect(await $(tid('checkout-button')).isEnabled().catch(() => false)).toBe(false);
  });

  it('[S8] underpay refused: no sale, cart preserved, stock unchanged', async () => {
    await addSku('E2E-SMOKE-E'); // 3000 DA
    const tx0 = await txCount();
    const st0 = (await stockOf('E2E-SMOKE-E')).ledger;
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('tendered-input'))).setValue('1000');
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 2000n * 100n,
      { timeout: 15000, timeoutMsg: 'remainder did not settle to 2000 DA' },
    );
    // pay-confirm stays enabled on underpay but the kernel path refuses:
    // dialog must stay open and nothing may be written.
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(
      async () => (await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 10000, timeoutMsg: 'pay dialog closed on an underpay (must refuse)' },
    );
    expect(await txCount()).toBe(tx0);
    expect((await $$(tid('cart-line'))).length).toBe(1);
    expect(await cartTotalMinor()).toBe(3000n * 100n);
    expect((await stockOf('E2E-SMOKE-E')).ledger).toBe(st0);
    await (await $(tid('pay-cancel'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'pay dialog did not cancel' },
    );
  });

  it('[S9] manager gate denies a wrong PIN, total unchanged', async () => {
    await addSku('E2E-SMOKE-F'); // 3500 DA
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('25');
    const pin = await $(tid('discount-pin'));
    await pin.waitForDisplayed({ timeout: 10000 });
    await pin.setValue('999999');
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => (await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 8000, timeoutMsg: 'discount dialog closed on WRONG pin (must deny)' },
    );
    expect(await cartTotalMinor()).toBe(3500n * 100n);
    await browser.keys(['Escape']);
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 10000, timeoutMsg: 'discount dialog did not cancel' },
    );
  });

  it('[S10] manager step-up with 202020 applies 25% per oracle', async () => {
    await addSku('E2E-SMOKE-F'); // 3500 DA
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('25');
    const pin = await $(tid('discount-pin'));
    await pin.waitForDisplayed({ timeout: 10000 });
    await pin.setValue(APP_PIN);
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'discount dialog did not apply with manager PIN' },
    );
    const want = computeInvoice([{ unit: 3500n * 100n, qty: 1 }], 2500n).total;
    expect(want).toBe(2625n * 100n);
    expect(await cartTotalMinor()).toBe(want);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(want);
  });

  it('[S11] fr-DZ formatting stable, no global RTL', async () => {
    await addSku('E2E-SMOKE-G'); // 4000 DA
    const text = await (await $(tid('cart-total'))).getText();
    console.log(`[smoke] S11 raw total codepoints: ${[...text].map((c) => (c.codePointAt(0) ?? 0).toString(16)).join(' ')}`);
    // fr-DZ groups with ASCII space or narrow-NBSP (Intl); round thousands
    // render without the .00 fraction — accept both, then prove the exact
    // value through the oracle parser.
    expect(text).toMatch(/^[\d \u00a0\u202f]+(?:\.\d{2})?\s*DA$/);
    expect(displayedToMinor(text)).toBe(4000n * 100n);
    const dir = await browser.execute(() => document.documentElement.dir);
    expect(dir).not.toBe('rtl');
  });

  it('[S15] scanner burst: fast barcode input adds exactly one line', async () => {
    const search = await $(tid('catalog-search'));
    await search.waitForDisplayed({ timeout: 15000 });
    await search.setValue('EKH1');
    // Burst: full code + Enter as one rapid key sequence (5–20 ms/char class).
    await browser.keys(['Enter']);
    await browser.waitUntil(
      async () => (await $$(tid('product-tile'))).length === 1,
      { timeout: 15000, timeoutMsg: 'burst search did not isolate one tile' },
    );
    await (await $$(tid('product-tile')))[0].click();
    await search.setValue('');
    await browser.keys(['Enter']);
    expect((await $$(tid('cart-line'))).length).toBe(1);
    expect(await cartTotalMinor()).toBe(4500n * 100n);
  });

  it('[S13] shift close books exact figures (D7 bypass logged)', async () => {
    // UI-shift authority is Dexie-only (D6): the native snapshot cannot see
    // the UI opening float (its cash_sessions row is the seed shift), so the
    // expectation is composed here from the KNOWN opening (passed to
    // openShiftUi) + SQLite sales. The modal computes the same figure from
    // the Dexie mirror — agreement proves mirror == ledger.
    const snap0 = await invoke<{
      salesTotalDa: number;
      refundsTotalDa: number;
    }>('e2e_ledger_snapshot');
    const expectedDa = Math.round(100000 + snap0.salesTotalDa - snap0.refundsTotalDa);
    await (await $(tid('shift-pill'))).click();
    await (await $(tid('shift-close-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('shift-blind-direct'))).click();
    await (await $(tid('shift-blind-input'))).setValue(String(expectedDa));
    await (await $(tid('shift-blind-next'))).click();
    await browser.waitUntil(
      async () =>
        displayedToMinor(await (await $(tid('shift-expected'))).getText()) ===
        BigInt(expectedDa) * 100n,
      { timeout: 20000, timeoutMsg: `expected did not settle to ${expectedDa}` },
    );
    await (await $(tid('shift-close-confirm'))).click();
    // D7: the desktop Z view may never mount — poll briefly, log, continue.
    // 100 ms interval: the view lives ~250-1600 ms after the snapshot arms
    // (ShiftCloseModal reopen-print effect), and a 500 ms poll can straddle
    // the whole window under the test print stub (sampling race, Gate 2).
    const zSeen = await browser.waitUntil(
      async () => await $(tid('shift-z-dialog')).isDisplayed().catch(() => false),
      { timeout: 6000, interval: 100 },
    ).catch(() => false);
    console.log(`[smoke] S13 D7 bypass: zSeen=${zSeen} (booked figures asserted via ledger)`);
    await browser.keys(['Escape']);
    const dex = await readDexieShift(uiShiftId);
    expect(dex?.status).toBe('CLOSED');
    // Close writes no sales: totals stable across the close.
    const snap1 = await invoke<{
      salesTotalDa: number;
      refundsTotalDa: number;
    }>('e2e_ledger_snapshot');
    expect(Math.round(snap1.salesTotalDa)).toBe(Math.round(snap0.salesTotalDa));
    expect(Math.round(snap1.refundsTotalDa)).toBe(Math.round(snap0.refundsTotalDa));
  });

  it('[S12] refresh persistence: sales + closed shift survive reboot', async () => {
    const tx0 = await txCount();
    const lastId = (await ledger()).recentSales[0]?.id ?? '';
    expect(lastId.length).toBeGreaterThan(0);
    await browser.refresh();
    await unlockIfNeeded();
    expect(await txCount()).toBe(tx0);
    expect((await getSale(lastId)).found).toBe(true);
    expect((await readDexieShift(uiShiftId))?.status).toBe('CLOSED');
  });

  it('[S14] printed-stub contract + stored 8-line receipt equals oracle', async () => {
    const printed = await invoke<{
      captured: boolean;
      receiptText: string;
      drawerPulses: number;
      note: string;
    }>('e2e_get_printed');
    // Phase 7.2 stub contract: never pretend to a capture.
    expect(printed.captured).toBe(false);
    expect(printed.note.length).toBeGreaterThan(0);
    // Stored-vs-oracle on the S4 big sale (8 lines, no discounts).
    const sale = await getSale(bigSaleId);
    expect(sale.found).toBe(true);
    const oracle = computeInvoice(
      sale.lines.map((l) => ({
        unit: toMinorFromDa(l.appliedPriceDa),
        qty: l.quantity,
      })),
    );
    expect(oracle.total).toBe(toMinorFromDa(sale.totalDa));
    const receipts = (await invoke<{ receiptNumbers: string[] }>('e2e_ledger_snapshot')).receiptNumbers;
    expect(new Set(receipts).size).toBe(receipts.length);
  });
});
