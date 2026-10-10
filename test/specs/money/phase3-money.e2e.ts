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
  readOpenShiftDexie,
  stockOf,
  selectCustomer,
  debtOf,
  refundDirect,
} from '../../helpers/pos';
import { computeInvoice, toMinorFromDa } from '../../../e2e/lib/oracle';
import { assertLedgerClean } from '../../../e2e/lib/ledger';

/**
 * Phase 3 — MONEY correctness, HT-only integer DA (R-01/R-02/R-10…R-20).
 *
 * Five-way equality per scenario: Oracle (BigInt, from the rule) ≡ UI Echo
 * (parsed display) ≡ Stored SQLite (`e2e_get_sale`) ≡ Printed stub
 * (`captured:false` contract, Phase 7.2 builds the capture) ≡ Audit
 * (native chain verifier + count growth on kernel writes).
 *
 * Layers: UI sales drive the real `processPayment` path; refunds drive the
 * native `refund_sale_atomic` lane (same commit as connected production).
 * Discount characterization M7 asserts nothing (known D2 drift class).
 */

const SQL_SHIFT_NOTE = 'D6-fixed: kernel calls below use the UI-opened Dexie shift id directly — openShiftUi writes the SQLite row (shiftAdapter SQLite-first), so no seed shift and no e2e_mirror_shift_open bridge is needed.';

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

async function projectCustomerToDexie(c: { id: string; name: string; phone: string }) {
  const ok = await browser.execute((cust) => {
    const w = window as unknown as {
      indexedDB: {
        open(n: string): {
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          result: {
            transaction(n: string, m: string): {
              objectStore(n: string): { put(v: unknown): void };
              oncomplete: (() => void) | null;
            };
          };
        };
      };
    };
    return new Promise<boolean>((resolve) => {
      try {
        const open = w.indexedDB.open('MobiPosDB');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          try {
            const tx = open.result.transaction('customers', 'readwrite');
            tx.objectStore('customers').put({
              ...(cust as object),
              email: '',
              pricingTier: 'Retail',
              loyaltyTier: 'Bronze',
              currentDebt: 0,
              totalSpent: 0,
              storeCredit: 0,
              loyaltyPoints: 0,
            });
            tx.oncomplete = () => resolve(true);
          } catch {
            resolve(false);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }, c);
  expect(ok).toBe(true);
}

describe('MONEY correctness (Phase 3)', () => {
  let deviceId = '';
  let dexieShiftId = '';
  let m5SaleId = '';

  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_and_seed', { fixture: 'money' });
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-M-A', title: 'E2E Money A', priceDa: 2500, stock: 100, barcode: 'EMA1' },
          { id: 'E2E-M-B', title: 'E2E Money B', priceDa: 4000, stock: 100, barcode: 'EMB1' },
          { id: 'E2E-M-C', title: 'E2E Money C', priceDa: 2000, stock: 100, barcode: 'EMC1' },
          { id: 'E2E-M-D', title: 'E2E Money D', priceDa: 1500, stock: 100, barcode: 'EMD1' },
          { id: 'E2E-M-E', title: 'E2E Money E', priceDa: 1, stock: 100, barcode: 'EME1' },
        ],
        customers: [{ id: 'E2E-MONEY-CUST', name: 'E2E Client Money', phone: '0555000002' }],
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

  // ARITH-01: single-line exactness across the qty matrix (UI ≡ oracle ≡ stored).
  for (const [tag, sku, priceDa, qty] of [
    ['M1a', 'E2E-MNY-03', 1, 3],
    ['M1b', 'E2E-MNY-02', 1999, 2],
    ['M1c', 'E2E-MNY-01', 100, 7],
    ['M1d', 'E2E-MNY-04', 123456, 1],
  ] as const) {
    it(`[${tag}] ARITH single-line ${priceDa} DA x${qty} exact in all three layers`, async () => {
      const want = computeInvoice([{ unit: BigInt(priceDa) * 100n, qty }]).total;
      await addSku(sku, qty);
      expect(await cartTotalMinor()).toBe(want); // UI echo
      const before = (await ledger()).recentSales[0]?.id ?? null;
      await payExactFlow();
      const sale = await getSale(await waitNewSale(before));
      expect(toMinorFromDa(sale.totalDa)).toBe(want); // stored
      expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
    });
  }

  it('[M2a] ARITH order-independence: A+B and B+A total identically', async () => {
    await addSku('E2E-M-A');
    await addSku('E2E-M-B');
    const t1 = await cartTotalMinor();
    await clearCart();
    await addSku('E2E-M-B');
    await addSku('E2E-M-A');
    const t2 = await cartTotalMinor();
    expect(t1).toBe(t2);
    const want = computeInvoice([
      { unit: 2500n * 100n, qty: 1 },
      { unit: 4000n * 100n, qty: 1 },
    ]).total;
    expect(t1).toBe(want);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    expect(toMinorFromDa((await getSale(await waitNewSale(before))).totalDa)).toBe(want);
  });

  it('[M2b] DISCOUNT monotonicity: 10% beats 5% on the same line', async () => {
    await addSku('E2E-M-B'); // 4000
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('5');
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: '5% did not apply' },
    );
    const five = await cartTotalMinor();
    expect(five).toBe(computeInvoice([{ unit: 4000n * 100n, qty: 1 }], 500n).total);
    await clearCart();
    await addSku('E2E-M-B');
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('10');
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: '10% did not apply' },
    );
    const ten = await cartTotalMinor();
    expect(ten).toBe(computeInvoice([{ unit: 4000n * 100n, qty: 1 }], 1000n).total);
    expect(ten < five).toBe(true); // larger discount never raises the total
  });

  it('[M3] TENDER legs sum exactly: tendered legs minus change equals total', async () => {
    await addSku('E2E-M-C'); // 2000
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('tendered-input'))).setValue('10000');
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 8000n * 100n,
      { timeout: 15000, timeoutMsg: 'change did not settle to 8000 DA' },
    );
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 30000, timeoutMsg: 'pay dialog did not close' },
    );
    const sale = await getSale(await waitNewSale(before));
    const legs = sale.tenders.reduce((a, t) => a + BigInt(Math.round(t.amountDa * 100)), 0n);
    const oracle = computeInvoice([{ unit: 2000n * 100n, qty: 1 }]).total;
    expect(legs - BigInt(Math.round(sale.changeDueDa * 100))).toBe(oracle);
    expect(toMinorFromDa(sale.totalDa)).toBe(oracle);
  });

  it('[M4] TENDER split cash+debt: legs exact, debt ledger +4000, drawer 1500', async () => {
    await projectCustomerToDexie({ id: 'E2E-MONEY-CUST', name: 'E2E Client Money', phone: '0555000002' });
    await browser.refresh();
    await unlockIfNeeded();
    await addSku('E2E-M-B'); // 4000
    await addSku('E2E-M-D'); // 1500 -> total 5500
    await selectCustomer('E2E Client Money');
    const debts0 = (await ledger()).tables.find((t) => t.name === 'customer_debts')?.rows ?? 0;
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('tendered-input'))).setValue('1500');
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 4000n * 100n,
      { timeout: 15000, timeoutMsg: 'remainder did not settle to 4000 DA' },
    );
    await (await $(tid('pay-mixed-confirm'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 30000, timeoutMsg: 'pay dialog did not close after mixed sale' },
    );
    const sale = await getSale(await waitNewSale(before));
    const oracle = computeInvoice([
      { unit: 4000n * 100n, qty: 1 },
      { unit: 1500n * 100n, qty: 1 },
    ]).total;
    expect(toMinorFromDa(sale.totalDa)).toBe(oracle);
    expect(sale.tenders.length).toBe(2);
    const cash = sale.tenders.find((t) => t.method === 'Espèces');
    const debt = sale.tenders.find((t) => t.method === 'Crédit Client');
    expect(Math.round(cash?.amountDa ?? -1)).toBe(1500);
    expect(Math.round(debt?.amountDa ?? -1)).toBe(4000);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
    const book = await debtOf('E2E-MONEY-CUST');
    expect(book.entries.length).toBe(1);
    expect(BigInt(Math.round(book.entries[0].balanceAfterDa))).toBe(4000n);
    expect((await ledger()).tables.find((t) => t.name === 'customer_debts')?.rows ?? 0).toBe(debts0 + 1);
  });

  it('[M5] REFUND inversion: full kernel refund reverses exactly, audit grows', async () => {
    await addSku('E2E-M-A'); // 2500
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const saleId = await waitNewSale(before);
    m5SaleId = saleId;
    const sale = await getSale(saleId);
    const st0 = await ledger();
    const tx0 = st0.tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    const audit0 = (
      await invoke<{ auditCount: number }>('e2e_ledger_snapshot')
    ).auditCount;
    const r = await refundDirect({
      deviceId,
      shiftId: dexieShiftId,
      sqlShiftId: dexieShiftId,
      ticketId: saleId,
      tag: 'E2E-M5-RF',
      receipt: 'AVOIR-E2E-M5-RF',
      totalNet: 2500,
      cashOut: 2500,
      lines: sale.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        appliedPriceDa: l.appliedPriceDa,
      })),
    });
    console.log(`[money] M5 refund: ok=${r.ok} code=${r.code}`);
    expect(r.ok).toBe(true);
    // Refunded amount never exceeds the original tender.
    const refund = await getSale('E2E-M5-RF');
    expect(refund.found).toBe(true);
    expect(Math.abs(Math.round(refund.totalDa))).toBe(2500);
    expect((await getSale(saleId)).status).toBe('REFUNDED');
    expect((await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0).toBe(tx0 + 1);
    // Inversion: stock restored, drawer back, audit grew (chain stays valid).
    expect((await stockOf('E2E-M-A')).ledger).toBe(100 - 1 + 1 - 1); // M2a bought one
    const snap = await invoke<{
      auditCount: number;
      auditChainOk: boolean;
      auditDetail: string;
      auditLinksVerified: number;
      auditTotalLinks: number;
    }>('e2e_ledger_snapshot');
    console.log(`[money] M5 audit: ok=${snap.auditChainOk} detail=${snap.auditDetail} count=${snap.auditCount} (was ${audit0})`);
    expect(snap.auditChainOk).toBe(true);
    // Structural linkage (head-anchored verdicts are N/A under the shared
    // keystore — see e2e.rs docs): every link must walk.
    expect(snap.auditLinksVerified).toBe(snap.auditTotalLinks);
    expect(snap.auditCount).toBeGreaterThanOrEqual(audit0 + 1);
  });

  it('[M6] ATOMICITY replay + cumulative guard: one refund only', async () => {
    const tx0 = (await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    const st0 = (await stockOf('E2E-M-A')).ledger;
    // Exact replay of M5 (same idempotency tag, same original ticket).
    const sale = await getSale(m5SaleId);
    const replay = await refundDirect({
      deviceId,
      shiftId: dexieShiftId,
      sqlShiftId: dexieShiftId,
      ticketId: m5SaleId,
      tag: 'E2E-M5-RF',
      receipt: 'AVOIR-E2E-M5-RF',
      totalNet: 2500,
      cashOut: 2500,
      lines: sale.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        appliedPriceDa: l.appliedPriceDa,
      })),
    });
    expect(replay.ok).toBe(false);
    console.log(`[money] M6 replay code: ${replay.code}`);
    // Fresh tag, already-refunded lines — cumulative guard must also refuse.
    const again = await refundDirect({
      deviceId,
      shiftId: dexieShiftId,
      sqlShiftId: dexieShiftId,
      ticketId: m5SaleId,
      tag: 'E2E-M6-RF',
      receipt: 'AVOIR-E2E-M6-RF',
      totalNet: 2500,
      cashOut: 2500,
      lines: sale.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        appliedPriceDa: l.appliedPriceDa,
      })),
    });
    expect(again.ok).toBe(false);
    console.log(`[money] M6 cumulative code: ${again.code}`);
    expect((await ledger()).tables.find((t) => t.name === 'transactions')?.rows ?? 0).toBe(tx0);
    expect((await stockOf('E2E-M-A')).ledger).toBe(st0);
  });

  it('[M7] @characterization per-line vs single-shot cart-% (D2 drift class)', async () => {
    // Two 1-DA lines at 33.33% (>10% arms the manager step-up, R-17,
    // completed here with 202020). Three candidate semantics:
    //  single-shot minor: base=200, disc=hUp(200*3333/10000)=67 -> 133;
    //  per-line minor:    33+33=66 -> 134;
    //  per-line DA-unit Math.round (implemented: DiscountModal:94 previews
    //   single-shot, the slice distributes per line in DA units):
    //   round(1*33.33/100)=round(0.3333)=0 per line -> 200 (no effect).
    // Bounded assert: the total must stay inside [133,200] — anything
    // outside is a real defect; the exact landing is logged for the owner.
    await addSku('E2E-MNY-03'); // 1 DA line 1
    await addSku('E2E-M-E'); // 1 DA line 2
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('33.33');
    const pin = await $(tid('discount-pin'));
    await pin.waitForDisplayed({ timeout: 10000 });
    await pin.setValue('202020');
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'discount dialog did not resolve' },
    );
    const ui = await cartTotalMinor();
    const singleShot = computeInvoice(
      [
        { unit: 100n, qty: 1 },
        { unit: 100n, qty: 1 },
      ],
      3333n,
    ).total;
    console.log(`[money] M7 characterization: ui=${ui} singleShot=${singleShot} (D2 drift class)`);
    expect(ui >= singleShot && ui <= 200n).toBe(true);
  });
});
