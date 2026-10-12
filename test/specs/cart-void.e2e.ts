import { expect, browser, $, $$ } from '@wdio/globals';
import {
  tid,
  displayedToMinor,
  installErrorTrap,
  readErrors,
  unlockIfNeeded,
  ledger,
  clearWebMirrors,
  openShiftUi,
  clearCart,
  selectCustomer,
  invoke,
} from '../helpers/pos';

/**
 * Phase 3 Block D — UI cart void (HT-only, integer DA).
 * An 8-line discounted cart with a customer attached is voided via the cart
 * trash control (window.confirm accepted). Asserts: zero sales/items/
 * payments/debt rows, shift totals frozen, cart empty. The void DOES write
 * one audit row ('Annulation Complète Panier') — deliberate accountability
 * design per the code comment at the call site, documented here instead of
 * the directive's zero-audit expectation.
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

/** Mirror the seeded void customer into Dexie (store reads customers there). */
async function projectCustomerToDexie() {
  const ok = await browser.execute(() => {
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
              id: 'E2E-CUST-V',
              name: 'E2E Client Void',
              phone: '0555000002',
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
  });
  expect(ok).toBe(true);
}

async function tableCounts() {  const st = await ledger();
  const m = new Map(st.tables.map((t) => [t.name, t.rows]));
  return {
    tx: m.get('transactions') ?? 0,
    items: m.get('transaction_items') ?? 0,
    debts: m.get('customer_debts') ?? 0,
    audit: m.get('security_audit_logs') ?? 0,
    cashSales: st.shiftSummary.cashSalesDa,
    cashRefunds: st.shiftSummary.cashRefundsDa,
  };
}

describe('MONEY cart void', () => {
  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-V1', title: 'E2E Void A', priceDa: 1200, stock: 50, barcode: 'EVB1' },
          { id: 'E2E-V2', title: 'E2E Void B', priceDa: 800, stock: 50, barcode: 'EVB2' },
          { id: 'E2E-V3', title: 'E2E Void C', priceDa: 2500, stock: 50, barcode: 'EVB3' },
          { id: 'E2E-V4', title: 'E2E Void D', priceDa: 500, stock: 50, barcode: 'EVB4' },
          { id: 'E2E-V5', title: 'E2E Void E', priceDa: 3000, stock: 50, barcode: 'EVB5' },
          { id: 'E2E-V6', title: 'E2E Void F', priceDa: 1500, stock: 50, barcode: 'EVB6' },
          { id: 'E2E-V7', title: 'E2E Void G', priceDa: 700, stock: 50, barcode: 'EVB7' },
          { id: 'E2E-V8', title: 'E2E Void H', priceDa: 900, stock: 50, barcode: 'EVB8' },
        ],
        customers: [{ id: 'E2E-CUST-V', name: 'E2E Client Void', phone: '0555000002' }],
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
  });

  it('D1 voiding a complex cart writes no money rows and freezes the shift', async () => {
    await projectCustomerToDexie();
    // Store reads customers at boot: reload so the projection lands.
    await browser.refresh();
    await unlockIfNeeded();
    for (let k = 1; k <= 8; k++) await addSku(`E2E-V${k}`);
    expect((await $$(tid('cart-line'))).length).toBe(8);
    // Discount + attached customer: the void must drop everything.
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('discount-percent'))).setValue('10');
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'discount dialog did not apply' },
    );
    await selectCustomer('E2E Client Void');
    const gross = 1200 + 800 + 2500 + 500 + 3000 + 1500 + 700 + 900; // 11 100
    const disc = Math.round((gross * 10) / 100); // 1110
    expect(displayedToMinor(await (await $(tid('cart-total'))).getText())).toBe(
      BigInt(gross - disc) * 100n,
    );
    const c0 = await tableCounts();
    // Void: 8 lines (>1 unit) -> native confirm dialog.
    await (await $(tid('cart-clear'))).click();
    await browser.waitUntil(
      async () => {
        try {
          await browser.getAlertText();
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10000, timeoutMsg: 'void confirm dialog did not appear' },
    );
    await browser.acceptAlert();
    await browser.waitUntil(
      async () => (await $$(tid('cart-line'))).length === 0,
      { timeout: 15000, timeoutMsg: 'cart did not empty after void' },
    );
    const c1 = await tableCounts();
    expect(c1.tx - c0.tx).toBe(0);
    expect(c1.items - c0.items).toBe(0);
    expect(c1.debts - c0.debts).toBe(0);
    expect(c1.cashSales).toBe(c0.cashSales);
    expect(c1.cashRefunds).toBe(c0.cashRefunds);
    // Accountability design: the void itself is audited (exactly one row).
    expect(c1.audit - c0.audit).toBe(1);
    expect(displayedToMinor(await (await $(tid('cart-total'))).getText())).toBe(0n);
    console.log('[money] D1 void clean: no money rows, shift frozen, 1 audit row');
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });

  afterEach(async () => {
    await clearCart();
  });
});
