/**
 * EXTREME CHAOS suite — two-way exchange pushed to its breaking point.
 *
 * Runs against the local harness (real UI + real Zustand store + Dexie;
 * NO Tauri SQLite lane in a harness browser). Environment contract:
 *  - Standalone intake, staging, settlement math, validation, refund
 *    PREVIEWS and pre-write guards execute for real and are asserted live.
 *  - Durable checkout writes (writeCheckoutAtomic / processRefundAtomic /
 *    batch depletion) need the native lane: attempted where the flow reaches
 *    them and asserted fail-closed, never fiction-passed. Depletion SQL is
 *    proven live in scripts/test_tradein_exchange.mjs (Suite 2.2, node:sqlite
 *    on the mirrored schema).
 *
 * IMEI vectors: the brief's `...482` / `...923` strings are NOT Luhn-valid
 * (pinned red in tests/tradein-exchange.spec.ts). The loops below use
 * check-digit-corrected siblings (`...481` / `...926`, same prefixes) and
 * assert the brief's exact strings are rejected.
 */
import { test, expect, type Page } from '@playwright/test';

const HARNESS = '/tests/tradein-harness/index.html';
/** Check-digit-corrected siblings of the brief's vectors (same prefixes). */
const IMEI_A = '352099001761481'; // iPhone 13 intake (brief: ...482, invalid)
const IMEI_B = '358249005471926'; // Samsung S21 intake (brief: ...923, invalid)
const IMEI_BRIEF_A = '352099001761482';
const IMEI_BRIEF_B = '358249005471923';

type Harness = {
  __harnessReady?: boolean;
  __harnessError?: string | null;
  __harnessSnapshot: () => { tradeIns: number; products: number; staged: unknown };
  __harnessSetShift: (openingFloat: number) => void;
  __harnessSeedCartLines: (lines: Array<{ price: number; discount?: number; title?: string }>) => void;
  __harnessSetAvoirAndVoucher: (storeCredit: number, voucherCredit: number) => void;
  __harnessSetVatRate: (rate: number) => void;
  __harnessSeedCustomer: (storeCredit: number) => void;
  __harnessDexie: (table: string) => Promise<Array<Record<string, unknown>>>;
  __harnessBlastPayment: (n: number) => Promise<Array<string>>;
  __harnessOpenRefund: (txn: Record<string, unknown>) => void;
  __harnessProcessRefund: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  __harnessOpenMatrix: () => void;
  __harnessOpenExchange: () => void;
  __harnessStageTradeIn: (b: number) => void;
  __harnessOpenPayment: () => void;
  __harnessSeedCart: (u: number) => void;
  __harnessAddProductToCart: (productId: string, imei?: string) => boolean;
  __harnessApplyCartDiscount: (pct: number) => void;
};
async function openTradeIn(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true);
  const err = await page.evaluate(() => (window as unknown as { __harnessError?: string | null }).__harnessError);
  expect(err, `harness boot error: ${err}`).toBeNull();
  await expect(page.getByText('REPRISE & TRADE-IN OCCASION').first()).toBeVisible();
}

const imeiInput = (page: Page) => page.getByPlaceholder('358921004812345');
const nameInput = (page: Page) => page.getByPlaceholder('Ex: Karim Hadj');
const modelInput = (page: Page) => page.getByPlaceholder('ex: iPhone 14 Pro Max');
const cniInput = (page: Page) => page.getByPlaceholder('Ex: 1987-44-112233');
const tradeInDialog = (page: Page) => page.locator('div.fixed.inset-0').filter({ hasText: 'REPRISE & TRADE-IN' });
// The buyback price is a `MoneyInput` (`type="text"`), so `input[type="number"].first()`
// resolved to the RESALE MARGIN spinner instead: the price never reached the
// model, `buybackValue` stayed 0, and the submit no-op'd on
// `if (buybackValue <= 0) return;` — surfacing as "no product minted", nowhere
// near the cause. The field now carries its own stable test id.
const buybackInput = (page: Page) => tradeInDialog(page).getByTestId('buyback-price');
/**
 * MoneyInput commits only a parseable amount and reports it in its `aria-live`
 * echo line. Assert it before every submit so a silent no-op can never pass.
 */
const expectBuybackCommitted = async (page: Page) => {
  const echo = buybackInput(page).locator('xpath=../../span[@aria-live="polite"]');
  await expect(echo).toContainText('=', { timeout: 10_000 });
};
const intakeSubmit = (page: Page) => page.getByRole('button', { name: /Racheter & Injecter/ });

async function standaloneIntake(
  page: Page,
  opts: { name: string; model: string; imei: string; buyback: string; cni?: string }
) {
  await nameInput(page).fill(opts.name);
  await modelInput(page).fill(opts.model);
  await imeiInput(page).fill(opts.imei);
  await imeiInput(page).blur();
  await buybackInput(page).fill(opts.buyback);
  await expectBuybackCommitted(page);
  if (opts.cni !== undefined) await cniInput(page).fill(opts.cni);
  await intakeSubmit(page).click();
  // Standalone success closes the modal (slice sets activeModal null).
  await expect(page.getByText('REPRISE & TRADE-IN OCCASION')).toHaveCount(0, { timeout: 20000 });
}

test.describe('Test 1 — chained intake loop (back-to-back, zero reload)', () => {
  test('two intakes mint distinct batches/products/ledger rows + OCC SKUs immediately sellable', async ({ page }) => {
    await openTradeIn(page);

    // Intake A: iPhone 13, 45 000 DA, +30% => 58 500 DA resale.
    await standaloneIntake(page, { name: 'Client A', model: 'iPhone 13', imei: IMEI_A, buyback: '45000', cni: 'CNI-A-001' });
    const dexA = await page.evaluate(async () => {
      const h = (window as unknown as Harness);
      return {
        trades: await h.__harnessDexie('tradeIns'),
        products: await h.__harnessDexie('products'),
        batches: await h.__harnessDexie('stockBatches'),
        ledger: await h.__harnessDexie('inventoryLedger'),
      };
    });
    const tradeA = dexA.trades.find((t) => t['imei'] === IMEI_A) as Record<string, unknown>;
    expect(tradeA, 'intake-A trade row in Dexie').toBeTruthy();
    const tradeId1 = String(tradeA['id']);
    const prodA = dexA.products.find((p) => String(p['title']).includes('iPhone 13') && String(p['sku']).startsWith('OCC-'));
    expect(prodA, 'OCC product row, stock 1').toBeTruthy();
    expect(prodA!['stock']).toBe(1);
    expect(prodA!['price']).toBe(58500);
    const batchA = dexA.batches.find((b) => b['purchaseOrderId'] === `TRADE-${tradeId1}`);
    expect(batchA, 'TRADE batch row').toBeTruthy();
    expect(batchA!['quantityRemaining']).toBe(1);
    expect(batchA!['unitCost']).toBe(45000);
    const ledA = dexA.ledger.filter((l) => l['refType'] === 'TRADE_IN' && l['refId'] === tradeId1);
    expect(ledA.length).toBe(1);
    expect(ledA[0]['delta']).toBe(1);
    expect(ledA[0]['reason']).toBe('RECEIVE');

    // Catalog visibility: the OCC SKU is in the live catalog (the matrix
    // modal is a variant builder, not a product list — no text to find).
    const catalogHit = await page.evaluate(
      (sku: string) =>
        (window as unknown as Harness)
          .__harnessDexie('products')
          .then((rows) => rows.some((p) => String(p['sku']) === sku && Number(p['stock']) === 1)),
      String(prodA!['sku'])
    );
    expect(catalogHit, 'OCC SKU live in catalog, stock 1').toBe(true);

    // Immediately sellable: add the OCC unit to the cart in the next second.
    const added = await page.evaluate(
      ([pid, imei]: Array<string>) => {
        const h = window as unknown as Harness;
        return h.__harnessAddProductToCart(pid, imei);
      },
      [String(prodA!['id']), IMEI_A]
    );
    expect(added, 'OCC unit addable to cart (sellable asset)').toBe(true);

    // Intake B (zero reload): Samsung S21, 30 000 DA.
    await page.evaluate(() => {
      const w = window as unknown as { __harnessOpenTradeIn: () => void };
      w.__harnessOpenTradeIn();
    });
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION').first()).toBeVisible();
    await standaloneIntake(page, { name: 'Client B', model: 'Samsung S21', imei: IMEI_B, buyback: '30000' });
    const dexB = await page.evaluate(async () => {
      const h = (window as unknown as Harness);
      return {
        trades: await h.__harnessDexie('tradeIns'),
        batches: await h.__harnessDexie('stockBatches'),
        ledger: await h.__harnessDexie('inventoryLedger'),
      };
    });
    const tradeB = dexB.trades.find((t) => t['imei'] === IMEI_B) as Record<string, unknown>;
    expect(tradeB).toBeTruthy();
    const tradeId2 = String(tradeB['id']);
    expect(tradeId2, 'distinct trade ids (distinct folios)').not.toBe(tradeId1);
    const batchB = dexB.batches.find((b) => b['purchaseOrderId'] === `TRADE-${tradeId2}`);
    expect(batchB!['quantityRemaining']).toBe(1);
    expect(batchB!['unitCost']).toBe(30000);
    expect(dexB.ledger.filter((l) => l['refType'] === 'TRADE_IN').length).toBe(2);
    // Batch-A untouched by intake-B (no sequence corruption).
    const batchA2 = dexB.batches.find((b) => b['purchaseOrderId'] === `TRADE-${tradeId1}`);
    expect(batchA2!['quantityRemaining']).toBe(1);
  });

  test('brief vectors rejected: ...482 / ...923 are not Luhn-valid', async ({ page }) => {
    await openTradeIn(page);
    await imeiInput(page).fill(IMEI_BRIEF_A);
    await expect(page.getByText('IMEI valide (Luhn OK)')).toHaveCount(0);
    await expect(page.getByText(/IMEI invalide/).first()).toBeVisible();
    await imeiInput(page).fill(IMEI_BRIEF_B);
    await expect(page.getByText(/IMEI invalide/).first()).toBeVisible();
  });
});

test.describe('Test 2 — cart mutator soulte flip + overdraft block', () => {
  test('CUSTOMER_PAYS +80k flips to SOULTE -65k; 20k float blocks cash, wallet unblocks CTA', async ({ page }) => {
    await openTradeIn(page);
    await page.evaluate(() => {
      const h = window as unknown as Harness;
      h.__harnessSeedCartLines([{ price: 180000, title: 'MacBook Air' }]);
      h.__harnessStageTradeIn(100000);
    });
    await expect(page.getByText(/Reprise : iPhone 13 Pro/)).toBeVisible();
    await expect(page.getByText(/Reste à payer/)).toBeVisible();

    // Mutation: MacBook out, AirPods in.
    await page.evaluate(() => {
      const h = window as unknown as Harness;
      h.__harnessSeedCartLines([{ price: 35000, title: 'AirPods Pro' }]);
    });
    await expect(page.getByText(/Soulte boutique/).first()).toBeVisible();

    // Float exhaustion: 20 000 DA drawer vs 65 000 DA soulte.
    await page.evaluate(() => (window as unknown as Harness).__harnessSetShift(20000));
    await page.evaluate(() => (window as unknown as Harness).__harnessOpenPayment());
    await expect(page.getByText(/Montant à Verser au Client :/)).toBeVisible();
    await page.getByRole('radio', { name: /Décaisser Espèces/ }).click();
    await page.getByRole('button', { name: /Valider & Imprimer Reçu/ }).click();
    await expect(page.getByText(/Tiroir insuffisant/).first()).toBeVisible({ timeout: 20000 });
    // Zero drawer movement + zero intake writes pre-guard (guard is pre-write).
    const dex = await page.evaluate(async () => {
      const h = (window as unknown as Harness);
      return { movs: await h.__harnessDexie('cashMovements'), trades: await h.__harnessDexie('tradeIns') };
    });
    expect(dex.movs.length).toBe(0);
    expect(dex.trades.length).toBe(0);

    // Recovery: wallet pill unblocks the CTA instantly.
    await page.getByRole('radio', { name: /Créditer Portefeuille Avoir/ }).click();
    await expect(page.getByRole('button', { name: /Valider & Imprimer Reçu/ })).toBeEnabled();
  });
});

test.describe('Test 3 — tender hydra (discounts + avoir + voucher + trade-in)', () => {
  // Engine truths: (1) applyCartDiscountPercent DISTRIBUTES onto lines,
  // replacing the seeded 7k with 5% of gross — base is 95 000 (the 88 350
  // stack lives in pure math via cartDiscountPercent, node battery);
  // (2) VAT is HT-additive, so EVEN-0 holds at 0% VAT; at 19% the customer
  // owes exactly the VAT slice (18 050), never a manufactured refund.
  test('95k base, 15k+10k+70k credits = EVEN 0 (0% VAT); VAT base pinned at 19%', async ({ page }) => {
    await openTradeIn(page);
    await page.evaluate(() => {
      const h = window as unknown as Harness;
      h.__harnessSeedCartLines([{ price: 100000, discount: 7000, title: 'Phone Hydra' }]);
      h.__harnessApplyCartDiscount(5);
      h.__harnessSeedCustomer(200000);
      h.__harnessSetAvoirAndVoucher(15000, 10000);
      h.__harnessStageTradeIn(70000);
      h.__harnessSetVatRate(0);
      h.__harnessOpenPayment();
    });
    await expect(page.getByText(/Reste à Encaisser : 0[\s\u00a0\u202f]*DA/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Reprise:/).first()).toBeVisible();
    // 100%-covered label variant ('Valider Paiement Avoir (100%)').
    await expect(page.getByRole('button', { name: /Valider/ }).first()).toBeEnabled();

    // Phase 2: same stack at 19% VAT — VAT base stays 95 000, reste = VAT only.
    await page.evaluate(() => (window as unknown as Harness).__harnessSetVatRate(19));
    await expect(page.getByText(/TVA/).first()).toBeVisible();
    await expect(page.getByText(/Reste à Encaisser : 18[\s\u00a0\u202f]*050[\s\u00a0\u202f]*DA/)).toBeVisible();
  });
});

test.describe('Test 4 — concurrency hammer (10x simultaneous submit)', () => {
  test('held flight rejects all ten; released flight fails closed solo; shell survives', async ({ page }) => {
    await openTradeIn(page);
    await page.keyboard.press('Escape');
    const held = await page.evaluate(async () => {
      const h = window as unknown as Harness & {
        __harnessHoldFlight: () => Promise<boolean>;
        __harnessReleaseFlight: () => Promise<void>;
      };
      h.__harnessSeedCartLines([{ price: 50000, title: 'Hammer Phone' }]);
      h.__harnessSetShift(500000);
      const acquired = await h.__harnessHoldFlight();
      const reasons = await h.__harnessBlastPayment(10);
      await h.__harnessReleaseFlight();
      const soloCash = await (
        window as unknown as { __harnessPayCash: (amount: number) => Promise<string> }
      ).__harnessPayCash(50000);
      return { acquired, reasons, solo: [soloCash] };
    });
    expect(held.acquired, 'harness holds the mutex first').toBe(true);
    expect(held.reasons.length).toBe(10);
    expect(
      held.reasons.every((r) => r === 'ALREADY_PROCESSING'),
      `all ten hammer blows rejected, got [${held.reasons.join(', ')}]`
    ).toBe(true);
    expect(held.solo.length).toBe(1);
    expect(held.solo[0].startsWith('PERSISTENCE_FAILED'), `released flight fails closed past the lock (${held.solo[0]})`).toBe(true);
    // Shell alive: store readable, modal openable, no crash, no lock leak.
    // (snapshot().products is already a count — typeof-check it.)
    const alive = await page.evaluate(() => {
      const h = window as unknown as Harness;
      const s = h.__harnessSnapshot();
      return typeof s.products === 'number' && typeof s.tradeIns === 'number';
    });
    expect(alive).toBe(true);
    await page.evaluate(() => (window as unknown as { __harnessOpenTradeIn: () => void }).__harnessOpenTradeIn());
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION').first()).toBeVisible();
  });
});

const EXCHANGE_TXN = {
  id: 'txn-chaos-5',
  receiptNumber: 'T-CHAOS-5',
  status: 'COMPLETED',
  customer: { id: 'cust-harness', name: 'Client Harness', phone: '0550000000' },
  items: [
    { product: { id: 'alpha', title: 'Phone Alpha', sku: 'ALPHA', price: 60000 }, quantity: 1, appliedPrice: 60000, discount: 0 },
    { product: { id: 'beta', title: 'Phone Beta', sku: 'BETA', price: 40000 }, quantity: 1, appliedPrice: 40000, discount: 0 },
  ],
  subtotal: 100000,
  discountTotal: 0,
  total: 60000,
  tenders: [
    { method: 'Espèces', amount: 60000 },
    { method: 'Reprise', amount: 40000 },
  ],
  tradeInId: 'trade-chaos-5',
  tradeInDeduction: 40000,
  paymentMethod: 'Espèces',
  cashTendered: 60000,
  changeDue: 0,
  pricingTier: 'Retail',
  createdAt: new Date().toISOString(),
};

test.describe('Test 5 — asymmetric pro-rata refund (60/40 split, exhaustion)', () => {
  test('full-ticket preview caps cash at 60k (never 100k gross)', async ({ page }) => {
    await openTradeIn(page);
    await page.keyboard.press('Escape');
    await page.evaluate((txn) => (window as unknown as Harness).__harnessOpenRefund(txn), EXCHANGE_TXN);
    await expect(page.getByText(/Net reversé : 60[\s\u00a0\u202f]*000/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Espèces décaissées : 60[\s\u00a0\u202f]*000/)).toBeVisible();
  });

  test('leg 1 (Alpha only): 36k cash + 24k wallet share, never 60k cash', async ({ page }) => {
    await openTradeIn(page);
    await page.keyboard.press('Escape');
    await page.evaluate((txn) => (window as unknown as Harness).__harnessOpenRefund(txn), EXCHANGE_TXN);
    await expect(page.getByText(/Net reversé : 60[\s\u00a0\u202f]*000/)).toBeVisible({ timeout: 20000 });
    // Deselect Beta: only Alpha's 60k gross is reversed.
    await page.locator('tr', { hasText: 'Phone Beta' }).locator('input[type="checkbox"]').uncheck();
    await expect(page.getByText(/Net reversé : 36[\s\u00a0\u202f]*000/)).toBeVisible();
    await expect(page.getByText(/Espèces décaissées : 36[\s\u00a0\u202f]*000/)).toBeVisible();
  });

  test('leg 3 exploit: over-claim on fully-covered lines fails closed pre-write', async ({ page }) => {
    await openTradeIn(page);
    const res = await page.evaluate(async (txn) => {
      const h = window as unknown as Harness;
      return h.__harnessProcessRefund({
        originalTransaction: txn,
        refundItems: [
          { productId: 'alpha', title: 'Phone Alpha', sku: 'ALPHA', unitPrice: 60000, quantity: 2, totalRefundAmount: 120000, restock: true },
        ],
        refundMethod: 'Espèces',
        refundReason: 'Exploit attempt',
        cashierName: 'Harness',
      });
    }, EXCHANGE_TXN);
    expect(String(res['reason'] || res['success']), JSON.stringify(res)).toBe('REFUND_EXCEEDS_PURCHASED');
  });
});

test.describe('Test 6 — adversarial payload matrix', () => {
  test('bidi/zero-width IMEI compacts; XSS stored verbatim + escaped; CNI hostile but harmless', async ({ page }) => {
    await openTradeIn(page);
    const XSS_MODEL = '<script>alert("XSS")</script><b>Galaxy</b>';
    const XSS_NAME = 'محمد بن سالم / D\'Angelo; DROP TABLE trade_ins;--';
    const HOSTILE_CNI = '<![CDATA[CNI-9988<<>>&&]]>';
    await nameInput(page).fill(XSS_NAME);
    await modelInput(page).fill(XSS_MODEL);
    // Valid vector shredded with tabs/newlines/RTL override/zero-width space.
    await imeiInput(page).fill('\u202E4901 \t5420 \n3237 \r518\u200B');
    await imeiInput(page).blur();
    await expect(imeiInput(page)).toHaveValue('490154203237518');
    await expect(page.getByText('IMEI valide (Luhn OK)')).toBeVisible();
    // Invalid vector with spaces compacts then fails Luhn (no crash).
    await imeiInput(page).fill(' 3589 2100 4812 345 ');
    await imeiInput(page).blur();
    await expect(imeiInput(page)).toHaveValue('358921004812345');
    await expect(page.getByText(/IMEI invalide/).first()).toBeVisible();
    // Submit with the valid vector + hostile identity strings.
    await imeiInput(page).fill('490154203237518');
    await buybackInput(page).fill('45000');
    await expectBuybackCommitted(page);
    await cniInput(page).fill(HOSTILE_CNI);
    await expect(page.getByText('Pièce manquante — à compléter')).toHaveCount(0);
    const before = await page.evaluate(async () => {
      const h = (window as unknown as Harness);
      return (await h.__harnessDexie('tradeIns')).length;
    });
    await intakeSubmit(page).click();
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION')).toHaveCount(0, { timeout: 20000 });
    const rows = await page.evaluate(async () => {
      const h = (window as unknown as Harness);
      return h.__harnessDexie('tradeIns');
    });
    expect(rows.length).toBe(before + 1);
    const row = rows.find((r) => r['imei'] === '490154203237518') as Record<string, unknown>;
    expect(row['deviceModel']).toBe(XSS_MODEL);
    expect(row['customerName']).toContain('DROP TABLE');
    expect(row['nationalIdNumber']).toBe(HOSTILE_CNI);
    // Rendered as inert text in history (React escaping — no script runs).
    await page.evaluate(() => (window as unknown as { __harnessOpenTradeIn: () => void }).__harnessOpenTradeIn());
    await page.getByRole('button', { name: /Journal des Reprises/ }).click();
    await expect(page.getByText(XSS_MODEL).first()).toBeVisible();
  });
});
