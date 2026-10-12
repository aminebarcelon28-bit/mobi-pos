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
  selectCustomer,
  invoke,
  readOpenShiftDexie,
  readDexieShift,
  APP_PIN,
  stubPrint,
} from '../helpers/pos';

/**
 * Phase 4 — shift lifecycle (HT-only, integer DA).
 * Per cycle: open(10 000) -> 2 cash sales (4 000) + split (2 000 cash +
 * 4 000 debt) + saleD (1 500 cash, then fully refunded in cash) +
 * deposit (5 000) + expense (3 000).
 * Oracle: 10 000 + 7 500 + 5 000 − 3 000 − 1 500 = 18 000 expected.
 * Closures: counted 18 000 / 17 500 / 18 500 (variance 0/−500/+500).
 *
 * Authority notes: shifts + movements live in Dexie on the UI lane
 * (SQLite mirrors only via sync); money lanes assert on SQLite deltas,
 * shift math on the Dexie closed row + the modal's own expected figure.
 * The refund goes through the REAL RefundModal (production path: native
 * commit + Dexie projection + store append) — a raw native invoke would
 * bypass the store append and the close modal would never deduct it.
 * The desktop Z visual is a known gap (D7, DISCOVERY §11): the suite
 * asserts the booked close (Dexie CLOSED + figures) when the Z never
 * renders, and says so out loud per cycle.
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

async function moveCash(kind: 'deposit' | 'expense', amount: number, reason: string) {
  await (await $(tid('tools-menu-button'))).click();
  await (await $(tid('shift-move-open'))).click();
  await (await $(tid('shift-move-dialog'))).waitForDisplayed({ timeout: 15000 });
  await (await $(tid(kind === 'deposit' ? 'shift-move-deposit' : 'shift-move-expense'))).click();
  const amountInput = await $(tid('shift-move-amount'));
  await amountInput.waitForDisplayed({ timeout: 15000 });
  await amountInput.setValue(String(amount));
  await (await $(tid('shift-move-reason'))).setValue(reason);
  await (await $(tid('shift-move-save'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('shift-move-dialog')).isDisplayed().catch(() => false)),
    { timeout: 15000, timeoutMsg: 'movement dialog did not close' },
  );
}

async function closeShift(counted: number, note: string, expectedDa: number, shiftId: string) {
  await (await $(tid('shift-pill'))).click();
  await (await $(tid('shift-close-dialog'))).waitForDisplayed({ timeout: 15000 });
  // Direct-amount mode (the default is denomination tally).
  await (await $(tid('shift-blind-direct'))).click();
  const blind = await $(tid('shift-blind-input'));
  await blind.waitForDisplayed({ timeout: 15000 });
  await blind.setValue(String(counted));
  // Commit verification: MoneyInput parses keystrokes live; read back the
  // DOM value + echo to prove the amount reached React state.
  const blindEcho = await browser
    .execute(() => {
      const el = document.querySelector(
        '[data-testid="shift-blind-input"]',
      ) as HTMLInputElement | null;
      const live = el?.parentElement?.parentElement?.querySelector(
        '[aria-live]',
      )?.textContent;
      return `value=${el?.value ?? '<absent>'} echo=${live ?? '<none>'}`;
    })
    .catch(() => '<unreadable>');
  console.log(`[money] blind commit check: ${blindEcho}`);
  await (await $(tid('shift-blind-next'))).click();
  // The close modal reads the store's movement mirror, which converges
  // asynchronously after saves: wait for the expected figure to settle
  // (the modal recomputes live when the store updates).
  try {
    await browser.waitUntil(
      async () =>
        (await $(tid('shift-expected')).isDisplayed().catch(() => false)) &&
        displayedToMinor(await (await $(tid('shift-expected'))).getText()) ===
          BigInt(expectedDa) * 100n,
      { timeout: 20000, timeoutMsg: `expected did not settle to ${expectedDa}` },
    );
  } catch (e) {
    const full = await browser
      .execute(
        () =>
          (document.querySelector('[data-testid="shift-close-dialog"]') as HTMLElement | null)
            ?.innerText ?? '<close dialog absent>',
      )
      .catch(() => '<unreadable>');
    console.log(`[money] STALE BREAKDOWN:\n${String(full).slice(0, 3000)}`);
    throw e;
  }
  const expected = displayedToMinor(await (await $(tid('shift-expected'))).getText());
  const countedShown = displayedToMinor(await (await $(tid('shift-counted'))).getText());
  const varianceText = await (await $(tid('shift-variance'))).getText();
  if (counted !== expectedDa) {
    const noteInput = await $(tid('shift-note-variance'));
    await noteInput.waitForDisplayed({ timeout: 10000 });
    await noteInput.setValue(note);
  }
  await stubPrint();
  await (await $(tid('shift-close-confirm'))).click();
  // D7 proof: the Z print view MUST mount (the modal stays mounted until its
  // own print-then-dismiss timer runs ~1.6 s later). No bypass branch.
  await browser.waitUntil(
    async () => await $(tid('shift-z-dialog')).isDisplayed().catch(() => false),
    { timeout: 20000, interval: 200, timeoutMsg: 'D7 regression: Z report never displayed' },
  );
  const zSeen = true;
  const zText = await (await $(tid('shift-z-dialog'))).getText();
  await browser.waitUntil(
    async () => !(await $(tid('shift-z-dialog')).isDisplayed().catch(() => false)),
    { timeout: 15000, timeoutMsg: 'Z dialog did not dismiss' },
  );
  // The close must be booked in SQLite as well (kernel authority), with
  // the same figures the modal showed.
  await browser.waitUntil(
    async () =>
      (await invoke<{ status: string }>('e2e_get_shift', { id: shiftId })).status === 'CLOSED',
    { timeout: 20000, timeoutMsg: 'shift never booked CLOSED in SQLite' },
  );
  const sqlRow = await invoke<{ expectedCashDa: number | null; discrepancyDa: number | null }>(
    'e2e_get_shift',
    { id: shiftId },
  );
  expect(Math.round(Number(sqlRow.expectedCashDa ?? -1))).toBe(expectedDa);
  expect(Math.round(Number(sqlRow.discrepancyDa ?? NaN))).toBe(counted - expectedDa);
  return { expected, countedShown, varianceText, zText, zSeen };
}

/**
 * Full production refund through the RefundModal (own-ledger current-shift
 * ticket, so the sealed offline lane allows it): native commit + Dexie
 * projection + store append. Items pre-select fully with restock on;
 * the manager PIN authorizes. Success drains the ticket from the eligible
 * list (status -> REFUNDED).
 */
async function refundViaModal(receipt: string) {
  await (await $(tid('refund-button'))).click();
  await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 15000 });
  await (await $(tid('refund-search'))).setValue(receipt);
  await browser.waitUntil(
    async () => (await $$(tid('refund-sale-row'))).length >= 1,
    { timeout: 15000, timeoutMsg: `refund row for ${receipt}` },
  );
  await (await $$(tid('refund-sale-row')))[0].click();
  expect(await (await $(tid('refund-submit'))).isEnabled()).toBe(true);
  await (await shown('refund-pin')).setValue(APP_PIN);
  await (await $(tid('refund-submit'))).click();
  // Early toast capture: failure toasts auto-dismiss in ~5 s, long before
  // the commit wait below times out. Snapshot the body tail while fresh.
  await browser.pause(4000);
  if ((await $$(tid('refund-sale-row'))).length !== 0) {
    const early = await browser
      .execute(() => document.body.innerText.slice(-700))
      .catch(() => '');
    console.log(`[money] REFUND EARLY tail=${JSON.stringify(early).slice(0, 500)}`);
  }
  try {
    await browser.waitUntil(
      async () => (await $$(tid('refund-sale-row'))).length === 0,
      { timeout: 30000, timeoutMsg: 'refund did not commit' },
    );
  } catch (e) {
    const dlg = await browser
      .execute(
        () =>
          (document.querySelector('[data-testid="refund-dialog"]') as HTMLElement | null)
            ?.innerText ?? '<refund dialog absent>',
      )
      .catch(() => '<unreadable>');
    const s1 = await ledger().catch(() => null);
    console.log(
      `[money] REFUND STUCK dialog:\n${String(dlg).slice(0, 2000)}\nrefunds=${JSON.stringify(s1?.shiftSummary?.cashRefundsDa)} errors=${JSON.stringify(await readErrors())}`,
    );
    throw e;
  }
  await browser.keys(['Escape']);
  await browser.waitUntil(
    async () => !(await $(tid('refund-dialog')).isDisplayed().catch(() => false)),
    { timeout: 15000, timeoutMsg: 'refund dialog did not close' },
  );
}

describe('MONEY shift lifecycle', () => {
  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-H1', title: 'E2E Shift A', priceDa: 2000, stock: 200, barcode: 'EHB1' },
          { id: 'E2E-H2', title: 'E2E Shift B', priceDa: 2000, stock: 200, barcode: 'EHB2' },
          { id: 'E2E-H3', title: 'E2E Shift C', priceDa: 1500, stock: 200, barcode: 'EHB3' },
        ],
        customers: [{ id: 'E2E-CUST-SH', name: 'E2E Client Shift', phone: '0555000003' }],
        openShift: { id: 'E2E-SHIFT-SQL', openingFloat: 100000, cashierName: 'E2E' },
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    // Customer mirror for store reads. Projected only once the app has
    // booted and constructed Dexie — projecting earlier hits a storeless
    // DB and the put hangs (proven). Then reboot onto the mirror.
    await browser.execute(() => {
      const w = window as unknown as {
        indexedDB: {
          open(n: string): {
            onsuccess: (() => void) | null;
            result: {
              transaction(
                n: string,
                m: string,
              ): {
                objectStore(n: string): { put(v: unknown): void };
                oncomplete: (() => void) | null;
              };
            };
          };
        };
      };
      return new Promise<boolean>((resolve) => {
        const open = w.indexedDB.open('MobiPosDB');
        open.onsuccess = () => {
          const tx = open.result.transaction('customers', 'readwrite');
          tx.objectStore('customers').put({
            id: 'E2E-CUST-SH',
            name: 'E2E Client Shift',
            phone: '0555000003',
            pricingTier: 'Retail',
            currentDebt: 0,
          });
          tx.oncomplete = () => resolve(true);
        };
      });
    });
    await browser.refresh();
    await unlockIfNeeded();
  });

  const counts = [18000, 17500, 18500];
  const notes = ['', 'E2E manque 500', 'E2E excédent 500'];
  const markers = ['Parfait', 'Déficit', 'Excédent'];

  for (let cycle = 0; cycle < 3; cycle++) {
    const counted = counts[cycle];
    const note = notes[cycle];
    const tag = `H${cycle}`;

    it(`H${cycle} full ops close at ${counted} with exact Z math`, async () => {
      await unlockIfNeeded();
      await openShiftUi(10000);
      const shiftId = (await readOpenShiftDexie())?.id ?? '';
      expect(shiftId !== '').toBe(true);
      // D-SHIFT-01 proof: the PRODUCTION shift adapter must have written the
      // UI-opened shift into SQLite cash_sessions (SQLite-first dual write).
      // No harness mirror — if this row is missing, the native refund gate
      // would fail NO_OPEN_SHIFT, and the spec must say so here.
      const sqlShift = await invoke<{ found: boolean; status: string; openingFloatDa: number }>(
        'e2e_get_shift',
        { id: shiftId },
      );
      expect(sqlShift.found).toBe(true);
      expect(sqlShift.status).toBe('OPEN');
      expect(Math.round(sqlShift.openingFloatDa)).toBe(10000);
      const s0 = await ledger();
      const sales0 = s0.shiftSummary.cashSalesDa;
      const refunds0 = s0.shiftSummary.cashRefundsDa;
      // Two cash sales (+4 000).
      await addSku('E2E-H1');
      let before = (await ledger()).recentSales[0]?.id ?? null;
      await payExactFlow();
      const saleA = await waitNewSale(before);
      await addSku('E2E-H2');
      before = (await ledger()).recentSales[0]?.id ?? null;
      await payExactFlow();
      const saleB = await waitNewSale(before);
      // Split (+2 000 cash, +4 000 debt).
      await addSku('E2E-H1', 2);
      await addSku('E2E-H2', 1);
      await selectCustomer('E2E Client Shift');
      before = (await ledger()).recentSales[0]?.id ?? null;
      await (await $(tid('checkout-button'))).click();
      await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
      const tendered = await $(tid('tendered-input'));
      await tendered.waitForDisplayed({ timeout: 15000 });
      await tendered.setValue('2000');
      await (await $(tid('pay-mixed-confirm'))).click();
      await browser.waitUntil(
        async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
        { timeout: 30000, timeoutMsg: 'mixed dialog did not close' },
      );
      const saleC = await waitNewSale(before);
      // saleD (+1 500 cash), then fully refunded in cash via the REAL
      // RefundModal (production path).
      await addSku('E2E-H3');
      before = (await ledger()).recentSales[0]?.id ?? null;
      await payExactFlow();
      const refundTarget = await waitNewSale(before);
      const dReceipt =
        (await ledger()).recentSales.find((s) => s.id === refundTarget)?.receiptNumber ?? '';
      expect(dReceipt !== '').toBe(true);
      await refundViaModal(dReceipt);
      // Drawer movements (+5 000 / −3 000).
      await moveCash('deposit', 5000, `E2E apport ${tag}`);
      await moveCash('expense', 3000, `E2E depense ${tag}`);
      // Oracle lanes (SQLite deltas for this cycle). NOTE: cash_sales here
      // is method-gross (mixed sales count fully); drawer cash comes from
      // tender legs (asserted sale-by-sale below).
      const s1 = await ledger();
      expect(BigInt(Math.round((s1.shiftSummary.cashSalesDa - sales0) * 100))).toBe(
        10000n * 100n,
      );
      expect(BigInt(Math.round((s1.shiftSummary.cashRefundsDa - refunds0) * 100))).toBe(
        1500n * 100n,
      );
      // Drawer cash for the cycle, legs-based (app rule: Espèces legs
      // minus change; mixed sales contribute only their cash leg).
      // saleD's 1 500 cash counts (paid in, then refunded out separately).
      let drawerCash = 0n;
      for (const sid of [saleA, saleB, saleC, refundTarget]) {
        const s = await getSale(sid);
        const cashLegs = s.tenders.length > 0
          ? s.tenders
              .filter((t) => t.method === 'Espèces')
              .reduce((a, t) => a + BigInt(Math.round(t.amountDa)), 0n)
          : s.paymentMethod === 'Espèces'
            ? BigInt(Math.round(s.totalDa - s.changeDueDa))
            : 0n;
        drawerCash += cashLegs - BigInt(Math.round(s.changeDueDa));
      }
      expect(drawerCash).toBe(7500n);
      console.log(`[money] ${tag} drawer cash legs-based = 7500 (net-method oracle reads 10000)`);
      // Close: modal expected must equal the rule, then the counted figure.
      const closed = await closeShift(counted, note, 18000, shiftId);
      expect(closed.expected).toBe(18000n * 100n);
      expect(closed.countedShown).toBe(BigInt(counted) * 100n);
      expect(closed.varianceText).toContain(markers[cycle]);
      console.log(`[money] ${tag} closed counted=${counted} expected=18000 zSeen=${closed.zSeen}`);
      // Closed row frozen with the right discrepancy (Dexie authority).
      const row = await readDexieShift(shiftId);
      expect(row?.status).toBe('CLOSED');
      expect(Math.round(Number((row as unknown as { expectedCash?: number })?.expectedCash ?? -1))).toBe(
        18000,
      );
      expect(
        Math.round(Number((row as unknown as { discrepancy?: number })?.discrepancy ?? NaN)),
      ).toBe(counted - 18000);
      // Frozen till refuses new sales until reopen.
      await addSku('E2E-H1');
      const nBefore = (await ledger()).recentSales[0]?.id ?? null;
      await (await $(tid('checkout-button'))).click();
      await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
      await (await $(tid('pay-exact'))).click();
      await (await $(tid('pay-confirm'))).click();
      await browser.pause(3000);
      expect((await ledger()).recentSales[0]?.id ?? null).toBe(nBefore);
      await browser.keys(['Escape']);
      await clearCart();
    });
  }

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  afterEach(async () => {
    await clearCart();
  });
});
