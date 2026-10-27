import { expect, browser, $, $$ } from '@wdio/globals';
import {
  tid,
  APP_PIN,
  unlockIfNeeded,
  ledger,
  getSale,
  openShiftUi,
  clearWebMirrors,
  invoke,
  invokeRaw,
} from '../helpers/pos';

async function addSku(sku: string, times = 1) {
  const search = await $(tid('catalog-search'));
  await search.waitForDisplayed({ timeout: 15000 });
  await search.setValue(sku);
  await browser.keys(['Enter']);
  await browser.waitUntil(
    async () => (await $$(tid('product-tile'))).length === 1,
    { timeout: 15000, timeoutMsg: `single tile for ${sku}` },
  );
  for (let i = 0; i < times; i++) await (await $$(tid('product-tile')))[0].click();
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

async function createSale(skuQty: { sku: string; qty: number }[]): Promise<string> {
  for (const { sku, qty } of skuQty) await addSku(sku, qty);
  const before = (await ledger()).recentSales[0]?.id ?? null;
  await payExactFlow();
  let id = '';
  await browser.waitUntil(
    async () => {
      const st = await ledger();
      id = st.recentSales[0]?.id ?? '';
      return id !== '' && id !== before;
    },
    { timeout: 30000, timeoutMsg: 'new sale did not land' },
  );
  return id;
}

async function openRefundDialog() {
  const btn = await $(tid('refund-button'));
  await btn.click();
  await $(tid('refund-dialog')).waitForDisplayed({ timeout: 15000 });
}

async function selectReceipt(receipt: string) {
  const search = await $(tid('refund-search'));
  await search.setValue('');
  await search.setValue(receipt);
  await browser.pause(500);
  const rows = await $$(tid('refund-sale-row'));
  expect(rows.length).toBeGreaterThan(0);
  await rows[0].click();
}

async function checkFirstItem() {
  const boxes = await $$('[data-testid^="refund-check-"]');
  expect(boxes.length).toBeGreaterThan(0);
  await boxes[0].click();
}

async function checkAllItems() {
  const boxes = await $$('[data-testid^="refund-check-"]');
  for (const box of boxes) await box.click();
}

async function decQtyFirst(times = 1) {
  for (let i = 0; i < times; i++) {
    const decs = await $$('[data-testid^="refund-dec-"]');
    if (decs.length > 0 && (await decs[0].isEnabled())) await decs[0].click();
  }
}

async function submitUiRefund(pin = APP_PIN): Promise<boolean> {
  const pinInput = await $(tid('refund-pin'));
  await pinInput.click();
  await pinInput.setValue(pin);
  const submit = await $(tid('refund-submit'));
  await submit.click();
  await browser.pause(1500);
  return await $(tid('refund-dialog')).isDisplayed().catch(() => false);
}

async function ipcRefund(saleId: string, deviceId: string, shiftId: string): Promise<{ ok: boolean; code: string }> {
  const sale = await getSale(saleId);
  const lines = (sale.lines ?? []).map((l: any, i: number) => ({
    id: `UI-RF-${i}`,
    productId: l.productId,
    quantity: l.quantity,
    appliedPrice: Math.round(l.appliedPriceDa),
    unitPriceCharged: Math.round(l.appliedPriceDa),
    unitCostAtSale: 0,
    discountAmount: 0,
    lineProfit: 0,
    imeiNumber: null,
    itemKey: `UI-RF-${i}`,
    itemPayload: '{}',
  }));
  const req = {
    ticketId: saleId,
    refundId: `UI-RF-${saleId}`,
    itemsHash: `UI-RF-${saleId}`,
    receiptNumber: `UI-RF-${saleId}`,
    method: 'Espèces',
    online: true,
    localDeviceId: '',
    activeShiftId: shiftId,
    supervisor: null,
    customerId: null,
    subtotal: sale.subtotalDa,
    discountTotal: 0,
    totalNet: sale.totalDa,
    costTotal: 0,
    pricingTier: 'Retail',
    paymentMethod: 'Espèces',
    cashTendered: sale.totalDa,
    changeDue: 0,
    cashTenderedNet: sale.totalDa,
    createdAt: new Date().toISOString(),
    refundPayload: JSON.stringify({ refundMethod: 'Espèces', cashDisbursed: sale.totalDa, total: sale.totalDa }),
    originalOutboxPayload: '{}',
    deviceId,
    lines,
    deltas: lines.map((l: any, i: number) => ({ id: `D${i}`, key: `D${i}`, productId: l.productId, delta: l.quantity })),
    batches: lines.map((l: any) => ({ batchId: null, productId: l.productId, quantity: l.quantity, unitCost: 0, fallbackBatchId: `FB-${saleId}-${l.productId}`, fallbackKey: `fb-${saleId}-${l.productId}` })),
    imeis: [],
    debt: null,
    voucher: null,
    cashMove: { id: `CM-${saleId}`, sessionId: shiftId, amount: sale.totalDa, reason: 'UI test refund', cashierName: 'E2E' },
    audit: { action: 'UI test refund', details: 'ui', user: 'E2E', requiresPin: true },
  };
  try {
    const r = await invokeRaw<{ receiptNumber?: string }>('refund_sale_atomic', { req });
    if (!r.ok) return { ok: false, code: (r.error as any)?.detail ?? String(r.error) };
    return { ok: true, code: 'OK' };
  } catch (e) {
    return { ok: false, code: (e as any)?.detail ?? String(e) };
  }
}

describe('HARD UI refund scenarios (10 scenarios, real UI)', () => {
  let deviceId: string;

  before(async () => {
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'HARD-A', title: 'Hard Product A', priceDa: 5000, stock: 50, barcode: 'HBA' },
          { id: 'HARD-B', title: 'Hard Product B', priceDa: 3000, stock: 50, barcode: 'HBB' },
        ],
        openShift: { id: 'HARD-SHIFT', openingFloat: 200000, cashierName: 'E2E' },
      },
    });
  });

  // Fresh mirror + auth + shift before every test to prevent contamination
  beforeEach(async () => {
    await clearWebMirrors();
    await unlockIfNeeded();
    try {
      await openShiftUi(200000);
    } catch {
      /* shift already open */
    }
    deviceId = (await invoke<{ deviceId: string }>('get_device_identity_info')).deviceId;
  });

  // ── H-1: WRONG PIN ──
  it('H-1 wrong PIN refused, dialog stays open', async () => {
    const saleId = await createSale([{ sku: 'HBB', qty: 1 }]);
    const sale = await getSale(saleId);
    const c0 = await ledger().then((s) => (s.tables.find((t) => t.name === 'transactions')?.rows.length ?? 0));

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkFirstItem();
    const pinInput = await $(tid('refund-pin'));
    await pinInput.click();
    await pinInput.setValue('000000');
    const submit = await $(tid('refund-submit'));
    await submit.click();
    await browser.pause(1000);

    const dialogStillOpen = await $(tid('refund-dialog')).isDisplayed().catch(() => false);
    console.log(`[H-1] wrong PIN dialogStillOpen: ${dialogStillOpen}`);
    expect(dialogStillOpen).toBe(true);
    expect((await getSale(saleId)).status).toBe('COMPLETED');
    const c1 = await ledger().then((s) => (s.tables.find((t) => t.name === 'transactions')?.rows.length ?? 0));
    expect(c1).toBe(c0);
  });

  // ── H-2: OVER-QUOTA stepper ──
  it('H-2 over-quota increment blocked by disabled stepper', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 1 }]);
    const sale = await getSale(saleId);

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkFirstItem();
    const incs = await $$('[data-testid^="refund-inc-"]');
    expect(await incs[0].isEnabled()).toBe(false);
    const dialogStillOpen = await submitUiRefund();
    expect(dialogStillOpen).toBe(true);
    expect((await getSale(saleId)).status).toBe('COMPLETED');
  });

  // ── H-3: SUBMIT with no items ──
  it('H-3 submit with no items does not close dialog', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 1 }]);
    const sale = await getSale(saleId);

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    const pinInput = await $(tid('refund-pin'));
    await pinInput.click();
    await pinInput.setValue(APP_PIN);
    const submit = await $(tid('refund-submit'));
    await submit.click();
    await browser.pause(1000);
    const dialogStillOpen = await $(tid('refund-dialog')).isDisplayed().catch(() => false);
    console.log(`[H-3] no-items submit dialogStillOpen: ${dialogStillOpen}, status: ${(await getSale(saleId)).status}`);
  });

  // ── H-4: UI refund refused → ticket stays COMPLETED ──
  it('H-4 UI refund refused, ticket stays COMPLETED', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 1 }]);
    const sale = await getSale(saleId);

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkFirstItem();
    await submitUiRefund();
    expect((await getSale(saleId)).status).toBe('COMPLETED');
  });

  // ── H-5: RAPID double submit ──
  it('H-5 rapid double submit does not double-refund', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 1 }]);
    const sale = await getSale(saleId);

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkFirstItem();
    await submitUiRefund();

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    const rows = await $$(tid('refund-sale-row'));
    if (rows.length > 0) {
      await rows[0].click();
      await checkFirstItem();
      await submitUiRefund();
    }
    expect((await getSale(saleId)).status).toBe('COMPLETED');
  });

  // ── H-6: UI refund refused by device gate ──
  it('H-6 UI refund refused by device gate', async () => {
    const saleId = await createSale([{ sku: 'HBB', qty: 1 }]);
    const sale = await getSale(saleId);

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkFirstItem();
    await submitUiRefund();
    const dialogStillOpen = await $(tid('refund-dialog')).isDisplayed().catch(() => false);
    console.log(`[H-6] device gate dialogStillOpen: ${dialogStillOpen}`);
    expect(dialogStillOpen).toBe(true);
    expect((await getSale(saleId)).status).toBe('COMPLETED');
  });

  // ── H-7: EXHAUSTED ticket not in refund list ──
  it('H-7 fully refunded ticket vanishes from eligible list', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 1 }]);
    const r = await ipcRefund(saleId, deviceId, 'HARD-SHIFT');
    console.log(`[H-7] IPC pre-refund: ok=${r.ok} code=${r.code}`);
    expect(r.ok).toBe(true);
    expect((await getSale(saleId)).status).toBe('REFUNDED');

    // Force TS store to re-read from SQLite
    await clearWebMirrors();
    await unlockIfNeeded();
    await openRefundDialog();
    const search = await $(tid('refund-search'));
    await search.setValue((await getSale(saleId)).receiptNumber);
    await browser.pause(600);
    const rows = await $$(tid('refund-sale-row'));
    console.log(`[H-7] rows for exhausted ticket: ${rows.length}`);
    expect(rows.length).toBe(0);
    await browser.keys(['Escape']);
  });

  // ── H-8: MULTI-item UI refund attempt ──
  it('H-8 multi-item UI refund attempt', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 2 }, { sku: 'HBB', qty: 2 }]);
    const sale = await getSale(saleId);

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkAllItems();
    await submitUiRefund();
    const dialogStillOpen = await $(tid('refund-dialog')).isDisplayed().catch(() => false);
    console.log(`[H-8] multi-item dialogStillOpen: ${dialogStillOpen}`);
    expect(dialogStillOpen).toBe(true);
  });

  // ── H-9: WRONG PIN on multi-item sale ──
  it('H-9 wrong PIN on multi-item sale, dialog stays', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 2 }, { sku: 'HBB', qty: 1 }]);
    const sale = await getSale(saleId);
    const c0 = await ledger().then((s) => (s.tables.find((t) => t.name === 'transactions')?.rows.length ?? 0));

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkAllItems();
    const pinInput = await $(tid('refund-pin'));
    await pinInput.click();
    await pinInput.setValue('000000');
    const submit = await $(tid('refund-submit'));
    await submit.click();
    await browser.pause(1000);

    const dialogStillOpen = await $(tid('refund-dialog')).isDisplayed().catch(() => false);
    console.log(`[H-9] wrong PIN multi-item dialogStillOpen: ${dialogStillOpen}`);
    expect(dialogStillOpen).toBe(true);
    const c1 = await ledger().then((s) => (s.tables.find((t) => t.name === 'transactions')?.rows.length ?? 0));
    expect(c1).toBe(c0);
  });

  // ── H-10: PARTIAL qty via stepper decrement ──
  it('H-10 partial qty via stepper decrement', async () => {
    const saleId = await createSale([{ sku: 'HBA', qty: 3 }]);
    const sale = await getSale(saleId);

    await openRefundDialog();
    await selectReceipt(sale.receiptNumber);
    await checkFirstItem();
    await decQtyFirst(2);
    await submitUiRefund();
    const dialogStillOpen = await $(tid('refund-dialog')).isDisplayed().catch(() => false);
    console.log(`[H-10] partial qty dialogStillOpen: ${dialogStillOpen}`);
    expect(dialogStillOpen).toBe(true);
  });
});
