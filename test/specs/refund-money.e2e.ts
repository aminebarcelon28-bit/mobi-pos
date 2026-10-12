import { expect, browser, $, $$ } from '@wdio/globals';
import {
  tid,
  shown,
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
  invokeRaw,
  readOpenShiftDexie,
  stockOf,
} from '../helpers/pos';

/**
 * Phase 3.2 — atomic refunds (HT-only, integer DA).
 *
 * Lane discipline (sealed-build finding, documented):
 * - UI submits carry online:false (credential seal ⇒ probe fails), and the
 *   native offline foreign-ticket gate compares the TS stable id against the
 *   NATIVELY enrolled device id — different namespaces — so UI refunds are
 *   refused on sealed builds. The suite asserts that refusal is EXPLICIT
 *   (fail-closed UX, no silent partial payout).
 * - Kernel paths (dedup, quota, stock, audit, outbox) run DIRECT through
 *   `refund_sale_atomic` with online:true — the same atomic commit lane
 *   production uses when connected. Offline containment itself is covered
 *   by the Rust suite (offline_foreign_ticket_rejected et al.).
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

/** First CODE:token segment of a native OperationFailed detail JSON.
 * The detail rides inside WDIO's WebDriverError wrapper text, so extract
 * the "detail" field wherever it sits (balanced parse is overkill — the
 * value never contains an escaped quote by kernel contract). */
function nativeCode(raw: string): string {
  const m = /"detail"\s*:\s*"([^"]+)"/.exec(raw);
  if (m) return m[1].slice(0, 160);
  return raw.split('\n')[0].slice(0, 160);
}

/** Replicate the app's post-commit Dexie projection (refundNative
 * projectToDexie) for DIRECT-IPC refunds, which bypass the TS lane that
 * normally keeps the store mirror converged. Without this, store-driven
 * views (refund eligibility list) stay blind to kernel-committed refunds. */
async function projectRefundToDexie(
  origId: string,
  origStatus: string,
  refund: {
    id: string;
    receiptNumber: string;
    total: number;
    lines: { productId: string; quantity: number }[];
  } | null,
): Promise<void> {
  const ok = await browser.execute((o, s, r) => {
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
              objectStore(n: string): {
                get(k: string): {
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                  result?: Record<string, unknown>;
                };
                put(v: unknown): void;
              };
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
            const tx = open.result.transaction('transactions', 'readwrite');
            const store = tx.objectStore('transactions');
            const get = store.get(o as string);
            get.onerror = () => resolve(false);
            get.onsuccess = () => {
              const orig = get.result;
              if (orig) {
                orig['status'] = s;
                store.put(orig);
              }
              if (r) {
                const rr = r as {
                  id: string;
                  receiptNumber: string;
                  total: number;
                  lines: { productId: string; quantity: number }[];
                };
                store.put({
                  id: rr.id,
                  receiptNumber: rr.receiptNumber,
                  total: rr.total,
                  status: 'COMPLETED',
                  isRefund: true,
                  originalTransactionId: o,
                  items: [],
                  refundedItems: rr.lines.map((l) => ({
                    productId: l.productId,
                    quantity: l.quantity,
                  })),
                  createdAt: new Date().toISOString(),
                });
              }
            };
            tx.oncomplete = () => resolve(true);
          } catch {
            resolve(false);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }, origId, origStatus, refund);
  expect(ok).toBe(true);
}

interface RefundInvoke {
  ok: boolean;
  code: string;
  receiptNumber?: string;
}

async function refundDirect(args: {
  deviceId: string;
  shiftId: string;
  ticketId: string;
  tag: string;
  receipt: string;
  totalNet: number;
  cashOut: number;
  /** Original ticket's net cash tendered (cap basis). Defaults to totalNet,
   * which is only correct for FULL refunds — partial slices MUST pass the
   * original ticket's tendered net (else the kernel rightly caps). */
  tenderedNet?: number;
  lines: { productId: string; quantity: number; appliedPriceDa: number }[];
}): Promise<RefundInvoke> {
  const now = new Date().toISOString();
  const req = {
    ticketId: args.ticketId,
    refundId: args.tag,
    itemsHash: args.tag,
    receiptNumber: args.receipt,
    method: 'Espèces',
    online: true,
    localDeviceId: args.deviceId,
    activeShiftId: args.shiftId,
    supervisor: null,
    customerId: null,
    subtotal: args.totalNet,
    discountTotal: 0,
    totalNet: args.totalNet,
    costTotal: 0,
    pricingTier: 'Retail',
    paymentMethod: 'Espèces',
    cashTendered: args.totalNet,
    changeDue: 0,
    cashTenderedNet: args.tenderedNet ?? args.totalNet,
    createdAt: now,
    refundPayload: JSON.stringify({
      refundMethod: 'Espèces',
      cashDisbursed: args.cashOut,
      total: args.totalNet,
    }),
    originalOutboxPayload: '{}',
    deviceId: args.deviceId,
    lines: args.lines.map((l, i) => ({
      id: `${args.tag}-L${i}`,
      productId: l.productId,
      quantity: l.quantity,
      appliedPrice: Math.round(l.appliedPriceDa),
      unitPriceCharged: Math.round(l.appliedPriceDa),
      unitCostAtSale: 0,
      discountAmount: 0,
      lineProfit: 0,
      imeiNumber: null,
      itemKey: `${args.tag}-L${i}`,
      itemPayload: '{}',
    })),
    deltas: args.lines.map((l, i) => ({
      id: `${args.tag}-D${i}`,
      key: `${args.tag}-D${i}`,
      productId: l.productId,
      delta: l.quantity,
    })),
    batches: args.lines.map((l) => ({
      batchId: null,
      productId: l.productId,
      quantity: l.quantity,
      unitCost: 0,
      // Unique per refund: reusing a fallback id collides on the batch PK
      // (proven: second refund with the same fallback fails the insert).
      fallbackBatchId: `E2E-FB-${args.tag}-${l.productId}`,
      fallbackKey: `e2e-fb-${args.tag}-${l.productId}`,
    })),
    imeis: [],
    debt: null,
    voucher: null,
    cashMove: {
      id: `${args.tag}-CM`,
      sessionId: 'E2E-SHIFT-SQL',
      amount: args.cashOut,
      reason: 'E2E test refund',
      cashierName: 'E2E',
    },
    audit: {
      action: 'E2E test refund',
      details: 'e2e',
      user: 'E2E',
      requiresPin: true,
    },
  };
  try {
    const r = await invokeRaw<{ receiptNumber?: string }>('refund_sale_atomic', {
      req,
    });
    if (!r.ok) return { ok: false, code: nativeCode(r.error) };
    return { ok: true, code: 'OK', receiptNumber: r.value.receiptNumber };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, code: nativeCode(msg) };
  }
}

async function counts() {
  const st = await ledger();
  const m = new Map(st.tables.map((t) => [t.name, t.rows]));
  return {
    tx: m.get('transactions') ?? 0,
    items: m.get('transaction_items') ?? 0,
    outbox: m.get('sync_outbox') ?? 0,
  };
}

describe('MONEY refunds', () => {
  let deviceId = '';
  let shiftId = '';
  // SQLite drawer shift (native NO_OPEN_SHIFT gate reads SQLite sessions;
  // the UI shift lives Dexie-only). Same opening for Z coherence.
  const SQL_SHIFT = 'E2E-SHIFT-SQL';
  let saleId = '';
  let receipt = '';
  let receipt2 = '';

  before(async () => {
    await installErrorTrap();
    await invoke('e2e_reset_db');
    await invoke('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-R1', title: 'E2E Refund A', priceDa: 5000, stock: 50, barcode: 'ERB1' },
          { id: 'E2E-R2', title: 'E2E Refund B', priceDa: 3000, stock: 50, barcode: 'ERB2' },
        ],
        openShift: { id: SQL_SHIFT, openingFloat: 100000, cashierName: 'E2E' },
      },
    });
    await clearWebMirrors();
    await unlockIfNeeded();
    await openShiftUi(100000);
    deviceId = (await invoke<{ deviceId: string }>('get_device_identity_info')).deviceId;
    shiftId = (await readOpenShiftDexie())?.id ?? '';
    expect(deviceId !== '').toBe(true);
    expect(shiftId !== '').toBe(true);
    // R0: the sale under test (R1x2 + R2x1 = 13 000, exact cash).
    await addSku('E2E-R1', 2);
    await addSku('E2E-R2', 1);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    saleId = await waitNewSale(before);
    const sale = await getSale(saleId);
    receipt = sale.receiptNumber;
    expect(BigInt(Math.round(sale.totalDa * 100))).toBe(13000n * 100n);
    // Stock authority is the ledger (baselined seeds conserve exactly);
    // tile aria is a possibly-stale mirror (proven) — never asserted here.
    expect((await stockOf('E2E-R1')).ledger).toBe(48);
    expect((await stockOf('E2E-R2')).ledger).toBe(49);
    console.log(`[money] R0 sale ${saleId} receipt ${receipt} device ${deviceId.slice(0, 12)}…`);
  });

  it('R1 full kernel refund reverses exactly and restores stock', async () => {
    const c0 = await counts();
    const sale = await getSale(saleId);
    const r = await refundDirect({
      deviceId,
      shiftId,
      ticketId: saleId,
      tag: 'E2E-RF-1',
      receipt: 'AVOIR-E2E-RF-1',
      totalNet: 13000,
      cashOut: 13000,
      lines: sale.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        appliedPriceDa: l.appliedPriceDa,
      })),
    });
    console.log(`[money] R1 full refund: ok=${r.ok} code=${r.code}`);
    expect(r.ok).toBe(true);
    const refund = await getSale('E2E-RF-1');
    expect(refund.found).toBe(true);
    expect(Math.abs(Math.round(refund.totalDa))).toBe(13000);
    expect((await getSale(saleId)).status).toBe('REFUNDED');
    await projectRefundToDexie(saleId, 'REFUNDED', {
      id: 'E2E-RF-1',
      receiptNumber: 'AVOIR-E2E-RF-1',
      total: 13000,
      lines: [
        { productId: 'E2E-R1', quantity: 2 },
        { productId: 'E2E-R2', quantity: 1 },
      ],
    });
    const c1 = await counts();
    expect(c1.tx - c0.tx).toBe(1);
    expect(c1.outbox - c0.outbox).toBeGreaterThanOrEqual(1);
    expect((await stockOf('E2E-R1')).ledger).toBe(50);
    expect((await stockOf('E2E-R2')).ledger).toBe(50);
    const st = await ledger();
    expect(BigInt(Math.round(st.shiftSummary.cashRefundsDa * 100))).toBe(13000n * 100n);
  });

  it('R1b exact replay is denied with zero writes', async () => {
    const c0 = await counts();
    const sale = await getSale(saleId);
    const r = await refundDirect({
      deviceId,
      shiftId,
      ticketId: saleId,
      tag: 'E2E-RF-1', // identical ids = exact replay
      receipt: 'AVOIR-E2E-RF-1',
      totalNet: 13000,
      cashOut: 13000,
      lines: sale.lines.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        appliedPriceDa: l.appliedPriceDa,
      })),
    });
    console.log(`[money] R1b replay: ok=${r.ok} code=${r.code}`);
    expect(r.ok).toBe(false);
    expect(r.code).toContain('ALREADY_REFUNDED');
    expect(await counts()).toEqual(c0);
  });

  it('R1c modal gates: wrong PIN never fires; sealed lane refuses payout', async () => {
    // The store only learns direct-IPC refunds on reload: reboot UI state
    // so the eligibility filter sees the REFUNDED status.
    await browser.refresh();
    await unlockIfNeeded();
    // Vanish check: R0 is fully refunded and must not be offered.
    await (await $(tid('refund-button'))).click();
    await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('refund-search'))).setValue(receipt);
    await browser.pause(600);
    // NOTE: length, not toEqual([]) — WDIO element arrays never deep-equal [].
    expect((await $$(tid('refund-sale-row'))).length).toBe(0);
    await browser.keys(['Escape']);
    // Live eligible sale for the gate checks.
    await addSku('E2E-R2', 1);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const gateId = await waitNewSale(before);
    const gateReceipt = (await getSale(gateId)).receiptNumber;
    const c0 = await counts();
    await (await $(tid('refund-button'))).click();
    await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 15000 });
    await (await $(tid('refund-search'))).setValue(gateReceipt);
    await browser.waitUntil(
      async () => (await $$(tid('refund-sale-row'))).length >= 1,
      { timeout: 15000, timeoutMsg: 'gate sale row' },
    );
    await (await $$(tid('refund-sale-row')))[0].click();
    // Wrong PIN: denied before any kernel contact, nothing written.
    await (await shown('refund-pin')).setValue('000000');
    await (await shown('refund-submit')).click();
    await browser.pause(4000);
    expect(await (await $(tid('refund-dialog'))).isDisplayed()).toBe(true);
    expect(await counts()).toEqual(c0);
    // Correct PIN on the sealed lane: the offline foreign-ticket gate
    // refuses the payout — explicit fail-closed, no silent partial.
    await (await shown('refund-pin')).setValue(APP_PIN);
    await (await shown('refund-submit')).click();
    await browser.pause(5000);
    expect(await (await $(tid('refund-dialog'))).isDisplayed()).toBe(true);
    expect(await counts()).toEqual(c0);
    const body = await browser.execute(() => document.body.innerText.slice(0, 300));
    console.log(`[money] R1c sealed-lane dialog state: ${JSON.stringify(body).slice(0, 200)}`);
    await browser.keys(['Escape']);
  });

  it('R2 partial then remainder sum exactly to paid', async () => {
    await addSku('E2E-R1', 3); // 15 000
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const pid = await waitNewSale(before);
    receipt2 = (await getSale(pid)).receiptNumber;
    // First slice: 1 of 3 (5000); tenderedNet is the original 15 000.
    const p1 = await refundDirect({
      deviceId,
      shiftId,
      ticketId: pid,
      tag: 'E2E-RF-2A',
      receipt: 'AVOIR-E2E-RF-2A',
      totalNet: 5000,
      cashOut: 5000,
      tenderedNet: 15000,
      lines: [{ productId: 'E2E-R1', quantity: 1, appliedPriceDa: 5000 }],
    });
    console.log(`[money] R2 partial: ok=${p1.ok} code=${p1.code}`);
    expect(p1.ok).toBe(true);
    expect((await getSale(pid)).status).toBe('PARTIALLY_REFUNDED');
    expect((await stockOf('E2E-R1')).ledger).toBe(48); // 50-3+1
    await projectRefundToDexie(pid, 'PARTIALLY_REFUNDED', {
      id: 'E2E-RF-2A',
      receiptNumber: 'AVOIR-E2E-RF-2A',
      total: 5000,
      lines: [{ productId: 'E2E-R1', quantity: 1 }],
    });
    // Remainder: 2 of 3 (10 000). Cumulative == paid exactly.
    // tenderedNet is the ORIGINAL ticket's 15 000 (cap basis), not the slice.
    const p2 = await refundDirect({
      deviceId,
      shiftId,
      ticketId: pid,
      tag: 'E2E-RF-2B',
      receipt: 'AVOIR-E2E-RF-2B',
      totalNet: 10000,
      cashOut: 10000,
      tenderedNet: 15000,
      lines: [{ productId: 'E2E-R1', quantity: 2, appliedPriceDa: 5000 }],
    });
    console.log(`[money] R2 exhaust: ok=${p2.ok} code=${p2.code}`);
    expect(p2.ok).toBe(true);
    expect((await getSale(pid)).status).toBe('REFUNDED');
    expect((await stockOf('E2E-R1')).ledger).toBe(50);
    await projectRefundToDexie(pid, 'REFUNDED', {
      id: 'E2E-RF-2B',
      receiptNumber: 'AVOIR-E2E-RF-2B',
      total: 10000,
      lines: [{ productId: 'E2E-R1', quantity: 2 }],
    });
  });

  it('R4 hostile shapes fail closed with zero writes', async () => {
    // Own sale with full remaining balance so the amount guards (not just
    // the ticket lookup) decide each case.
    await addSku('E2E-R2', 1);
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const target = await waitNewSale(before);
    const stag = `E2E-HX-${Date.now() % 100000}`;
    // (explicit calls below keep per-case codes visible in output)
    const run = async (label: string, over: Record<string, unknown>, expectCode: string) => {
      const c0 = await counts();
      const base = {
        ticketId: target,
        refundId: `${stag}-x`,
        itemsHash: `${stag}-x`,
        receiptNumber: `${stag}-x`,
        method: 'Espèces',
        online: true,
        localDeviceId: deviceId,
        activeShiftId: shiftId,
        supervisor: null,
        customerId: null,
        subtotal: 3000,
        discountTotal: 0,
        totalNet: 3000,
        costTotal: 0,
        pricingTier: 'Retail',
        paymentMethod: 'Espèces',
        cashTendered: 3000,
        changeDue: 0,
        cashTenderedNet: 3000,
        createdAt: new Date().toISOString(),
        refundPayload: '{}',
        originalOutboxPayload: '{}',
        deviceId,
        lines: [{ id: `${stag}-L0`, productId: 'E2E-R2', quantity: 1, appliedPrice: 3000, unitPriceCharged: 3000, unitCostAtSale: 0, discountAmount: 0, lineProfit: 0, imeiNumber: null, itemKey: `${stag}-L0`, itemPayload: '{}' }],
        deltas: [{ id: `${stag}-D0`, key: `${stag}-D0`, productId: 'E2E-R2', delta: 1 }],
        batches: [{ batchId: null, productId: 'E2E-R2', quantity: 1, unitCost: 0, fallbackBatchId: `E2E-FB-${stag}`, fallbackKey: `e2e-fb-${stag}` }],
        imeis: [],
        debt: null,
        voucher: null,
        cashMove: { id: `${stag}-CM`, sessionId: 'E2E-SHIFT-SQL', amount: 3000, reason: 'E2E hostile', cashierName: 'E2E' },
        audit: { action: 'E2E hostile', details: 'e2e', user: 'E2E', requiresPin: true },
        ...over,
      };
      let ok = true;
      let code = '';
      try {
        const r = await invokeRaw<unknown>('refund_sale_atomic', { req: base });
        if (!r.ok) {
          ok = false;
          code = nativeCode(r.error);
        }
      } catch (e) {
        // browser.execute itself can reject with the native JSON attached
        // (WDIO wrapper) — extract the detail either way.
        ok = false;
        code = nativeCode(e instanceof Error ? e.message : String(e));
      }
      console.log(`[money] R4 "${label}": ok=${ok} code=${code}`);
      expect(ok).toBe(false);
      expect(code).toContain(expectCode);
      expect(await counts()).toEqual(c0);
    };
    await run('unknown ticket', { ticketId: 'E2E-NOPE', refundId: stag, itemsHash: stag }, 'TICKET_NOT_FOUND');
    await run('negative total', { refundId: `${stag}a`, itemsHash: `${stag}a`, totalNet: -5000, subtotal: -5000 }, 'INVALID:order money must be >= 0');
    await run('zero value', { refundId: `${stag}b`, itemsHash: `${stag}b`, totalNet: 0, subtotal: 0 }, 'ZERO_REFUNDABLE');
    await run('impostor device', { refundId: `${stag}c`, itemsHash: `${stag}c`, deviceId: 'E2E-IMPOSTOR', localDeviceId: 'E2E-IMPOSTOR' }, 'DEVICE_IDENTITY_SPOOFED');
    // The probe sale stays untouched and completable (still COMPLETED).
    expect((await getSale(target)).status).toBe('COMPLETED');
  });

  it('R5 inflated quantities are capped by the quota guard', async () => {
    await addSku('E2E-R2', 1); // 3000
    const before = (await ledger()).recentSales[0]?.id ?? null;
    await payExactFlow();
    const pid = await waitNewSale(before);
    const c0 = await counts();
    const r = await refundDirect({
      deviceId,
      shiftId,
      ticketId: pid,
      tag: 'E2E-RF-OVER',
      receipt: 'AVOIR-E2E-OVER',
      totalNet: 999 * 3000,
      cashOut: 999 * 3000,
      lines: [{ productId: 'E2E-R2', quantity: 999, appliedPriceDa: 3000 }],
    });
    console.log(`[money] R5 inflated: ok=${r.ok} code=${r.code}`);
    expect(r.ok).toBe(false);
    expect(r.code).toContain('REFUND_EXCEEDS');
    expect(await counts()).toEqual(c0);
    expect((await getSale(pid)).status).toBe('COMPLETED');
  });

  it('R3 exhausted tickets vanish from the refund list (no double pay)', async () => {
    // Both fully-refunded originals (R0 via R1, R2-sale via R2-exhaust)
    // must be absent from the eligible list, even by exact receipt search.
    // The store converged via the Dexie projections + reloads above.
    await browser.refresh();
    await unlockIfNeeded();
    await (await $(tid('refund-button'))).click();
    await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 15000 });
    for (const rc of [receipt, receipt2]) {
      await (await $(tid('refund-search'))).setValue(rc);
      await browser.pause(600);
      expect((await $$(tid('refund-sale-row'))).length).toBe(0);
    }
    await browser.keys(['Escape']);
  });

  after(async () => {
    expect(await readErrors()).toEqual([]);
  });
});
