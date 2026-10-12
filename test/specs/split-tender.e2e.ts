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
  selectCustomer,
  debtOf,
  invoke,
} from '../helpers/pos';
/**
 * Phase 3.3 — split tender (HT-only, integer DA).
 * Desktop split = Espèces leg + Crédit Client leg (Vente Mixte). Rule:
 * change = max(0, cashLegs - (total - creditLeg)) — change comes ONLY from
 * cash; the debt leg records the exact remainder; C + D == T always.
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

async function payTendered(amountDa: number) {
  await (await $(tid('checkout-button'))).click();
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 15000 });
  const tendered = await $(tid('tendered-input'));
  await tendered.waitForDisplayed({ timeout: 15000 });
  await tendered.setValue(String(amountDa));
}

async function waitDialogGone(testid: string, msg: string) {
  await browser.waitUntil(
    async () => !(await $(tid(testid)).isDisplayed().catch(() => false)),
    { timeout: 30000, timeoutMsg: msg },
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

/** Synthetic fixture customer (the specs seed their own customer anyway). */
const CUST_PHONE = '0550987654';

/** Mirror a seeded customer into Dexie (the store reads customers from the
 * mirror; SQLite-only seeds are invisible to selection — same gap class as
 * refund projections, same remedy). */
async function projectCustomerToDexie(c: { id: string; name: string; phone: string }) {
  const ok = await browser.execute((cust) => {
    const w = window as unknown as {
      indexedDB: {
        open(n: string): {
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
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

async function debtCount() {
  const st = await ledger();
  return st.tables.find((t) => t.name === 'customer_debts')?.rows ?? 0;
}

describe('MONEY split tender', () => {
  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-T1', title: 'E2E Split A', priceDa: 4000, stock: 50, barcode: 'ETB1' },
          { id: 'E2E-T2', title: 'E2E Split B', priceDa: 2000, stock: 50, barcode: 'ETB2' },
        ],
        customers: [{ id: 'E2E-CUST-1', name: 'E2E Client Split', phone: '0555000001' }],
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
  });

  it('T1 mixed cash+debt splits exactly, change 0, ledger +4000', async () => {
    await projectCustomerToDexie({ id: 'E2E-CUST-1', name: 'E2E Client Split', phone: '0555000001' });
    // The store reads customers once at boot: reload so the projection lands.
    await browser.refresh();
    await unlockIfNeeded();
    await addSku('E2E-T1');
    await addSku('E2E-T2'); // total 6000
    await selectCustomer('E2E Client Split');
    const debts0 = await debtCount();
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payTendered(2000);
    // Reste 4000 shown; mixed confirm appears only while a remainder stands.
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 4000n * 100n,
      { timeout: 15000, timeoutMsg: 'remainder did not settle to 4000 DA' },
    );
    const mixed = await $(tid('pay-mixed-confirm'));
    await mixed.waitForDisplayed({ timeout: 10000 });
    await mixed.click();
    await waitDialogGone('pay-dialog', 'pay dialog did not close after mixed sale');
    const id = await waitNewSale(before);
    const sale = await getSale(id);
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(6000n * 100n);
    // Two discrete tender legs summing exactly to the total (SQLite has no
    // payments table — legs live in the receipt JSON).
    expect(sale.tenders.length).toBe(2);
    const cashLeg = sale.tenders.find((t) => t.method === 'Espèces');
    const debtLeg = sale.tenders.find((t) => t.method === 'Crédit Client');
    expect(Math.round(cashLeg?.amountDa ?? -1)).toBe(2000);
    expect(Math.round(debtLeg?.amountDa ?? -1)).toBe(4000);
    // Stored cash_tendered is the legs sum by construction
    // (createOrderSlice: all non-Reprise legs), NOT drawer cash.
    expect(BigInt(Math.round(sale.cashTenderedDa * 100))).toBe(6000n * 100n);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(0n);
    // Debt leg: exactly the remainder, balance +4000 from zero.
    const book = await debtOf('E2E-CUST-1');
    expect(book.foundCustomer).toBe(true);
    expect(book.entries.length).toBe(1);
    expect(BigInt(Math.round(book.entries[0].amountDa))).toBe(4000n);
    expect(BigInt(Math.round(book.entries[0].balanceAfterDa))).toBe(4000n);
    // Drawer-cash rule (app: legs minus change): 2000 collected. The 4000
    // lives in the debt ledger, never the till — recorded, by construction.
    const drawerCash =
      BigInt(Math.round((cashLeg?.amountDa ?? 0) - sale.changeDueDa));
    expect(drawerCash).toBe(2000n);
    expect((await debtCount()) - debts0).toBe(1);
    console.log(`[money] T1 mixed sale ${id}: cash 2000 + debt 4000 = 6000, change 0`);
  });

  it('T2 mid-split cancel writes nothing and keeps the cart', async () => {
    await addSku('E2E-T1'); // 4000
    await selectCustomer('E2E Client Split');
    const st0 = await ledger();
    const tx0 = st0.tables.find((t) => t.name === 'transactions')?.rows ?? 0;
    const debts0 = st0.tables.find((t) => t.name === 'customer_debts')?.rows ?? 0;
    const book0 = await debtOf('E2E-CUST-1');
    const bal0 = book0.entries.length > 0 ? book0.entries[book0.entries.length - 1].balanceAfterDa : 0;
    await payTendered(1000);
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 3000n * 100n,
      { timeout: 15000, timeoutMsg: 'remainder did not settle to 3000 DA' },
    );
    // Back out with cash staged but debt never applied.
    await (await $(tid('pay-cancel'))).click();
    await waitDialogGone('pay-dialog', 'pay dialog did not cancel');
    const st1 = await ledger();
    expect((st1.tables.find((t) => t.name === 'transactions')?.rows ?? 0)).toBe(tx0);
    expect((st1.tables.find((t) => t.name === 'customer_debts')?.rows ?? 0)).toBe(debts0);
    const book1 = await debtOf('E2E-CUST-1');
    const bal1 = book1.entries.length > 0 ? book1.entries[book1.entries.length - 1].balanceAfterDa : 0;
    expect(bal1).toBe(bal0);
    // Cart intact for the cashier to continue or re-tender.
    expect((await $$(tid('cart-line'))).length).toBe(1);
    expect(displayedToMinor(await (await $(tid('cart-total'))).getText())).toBe(4000n * 100n);
    await clearCart();
  });

  it('T3 covered tender hides mixed and changes from cash only', async () => {
    await addSku('E2E-T2'); // 2000, no customer attached
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payTendered(7000);
    // Reste <= 0: no mixed split exists; overpay changes from the cash leg.
    await browser.waitUntil(
      async () => displayedToMinor(await (await $(tid('pay-change'))).getText()) === 5000n * 100n,
      { timeout: 15000, timeoutMsg: 'change did not settle to 5000 DA' },
    );
    // Reste <= 0: no mixed split can exist (it requires a remainder).
    const mixedVisible = await $(tid('pay-mixed-confirm')).isDisplayed().catch(() => false);
    expect(mixedVisible).toBe(false);
    await (await $(tid('pay-confirm'))).click();
    await waitDialogGone('pay-dialog', 'pay dialog did not close on overpay');
    const sale = await getSale(await waitNewSale(before));
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(2000n * 100n);
    expect(BigInt(Math.round(sale.changeDueDa * 100))).toBe(5000n * 100n);
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  afterEach(async () => {
    await clearCart();
  });
});
