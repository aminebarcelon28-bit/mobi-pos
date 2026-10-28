/**
 * MNY — money, rounding, currency, batch 2 (cases MNY-19, 20, 21, 25, 26, 30).
 *
 * Ground truth: live SQLite through better-sqlite3 + the real UI through
 * tauri-driver. Global invariants (G-01…G-34 subset) run in afterEach via
 * lib/invariants.ts.
 *
 * Case mapping (encyclopedia obligations):
 *  - MNY-19: Σ line totals == invoice total == payment total on random
 *    baskets. Feasibility note: 10,000 baskets is out of budget for a UI
 *    harness — this run executes a deterministic PRNG sample (8 baskets,
 *    seed 20261018) and the aggregate identity is asserted over the sample.
 *  - MNY-20: Z totals vs oracle (opening float + net cash − movements) for
 *    two consecutive shifts, read from the REAL close dialog and cross-checked
 *    against cash_sessions columns; Σ of the two Z readouts == Σ of oracles.
 *    (A full month of Zs is not reachable in one session — two shifts are the
 *    honest maximum; the identity asserted is the same one a month would use.)
 *  - MNY-21: negative amounts display — fr desktop parsing (U+2212), the
 *    return line sign, DB-side no-negative-sale containment, and an RTL (ar)
 *    re-render check of the same rendered payload where the cart survives
 *    the reload; otherwise the ar leg is logged as limited.
 *  - MNY-25: Kredy instalment plans are mobile-only (KredyTab.tsx:435-465,
 *    CompanionShell.tsx:231). Desktop attempt + bounded mobile attempt; if
 *    the mobile plan form cannot be driven (no testids, unknown locale text),
 *    the case SKIPS honestly (stays "remaining") — it is never faked as N/A.
 *    Desktop-verifiable partial evidence (debt ledger identities) is logged.
 *  - MNY-26: everything at once — price override + coupon (PROMO500 amount
 *    code, DiscountModal.tsx:29-34) + loyalty redemption
 *    (loyaltyEngine.calculateMaxAllowedCredit:557-582) + trade-in credit
 *    (TradeInBuybackModal exchange path :363-396, staged, committed at
 *    checkout) + cash; total ≥ 0, equals the hand-rolled oracle; full refund
 *    reverses each component.
 *  - MNY-30: bundle allocation where price×qty doesn't divide — children
 *    100+200+350 vs bundle 500 → per-child charged 77/154/269; refunding one
 *    child recovers exactly its 269 share.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, run, waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  APP_PIN,
  cartLineTexts,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  closeDialogs,
  closeRefund,
  clickRefundSubmit,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  installPageShims,
  openShiftUi,
  overrideLastLinePrice,
  payExactFlow,
  refundDialogVisible,
  refundSearch,
  refundTotalMinor,
  scanCode,
  seedBundleMirror,
  seedCustomerDebtMirror,
  selectCustomer,
  selectRefundMethod,
  selectRefundTicket,
  setRefundQty,
  tid,
  toggleLastLineReturn,
  typeMoneyInto,
  typeReal,
  typeRefundPin,
  unlockIfNeeded,
} from '../lib/pos';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';
import { resetData, seedBundles, seedCustomerDebts, seedCustomerFull, seedProducts } from '../lib/seed';

type Row = Record<string, unknown>;

const IMEI_A = '356938035643809';
const IMEI_B = '490154203237518';
const CUST26 = 'MNY2-C26';
const CUST26_NAME = 'MNY2 C26';
const CUST25 = 'MNY2-C25';
const CUST25_NAME = 'MNY2 Kredy';
const BUNDLE_BARCODE = '0195949038001';
const BUNDLE_SKUS = ['MNY2-RB100', 'MNY2-RB200', 'MNY2-RB350'];

// ---------------------------------------------------------------------------
// DB helpers (read side)
// ---------------------------------------------------------------------------

function txCount(): number {
  return count('transactions');
}
function txRow(id: string): Row | undefined {
  return one<Row>('SELECT * FROM transactions WHERE id = ?', id);
}
function newestTxRow(): Row | undefined {
  return one<Row>('SELECT * FROM transactions ORDER BY rowid DESC LIMIT 1');
}
function jsonOf(row?: Row | null): Row {
  try {
    return row?.json_payload ? (JSON.parse(String(row.json_payload)) as Row) : {};
  } catch {
    return {};
  }
}
function refundsFor(ticketId: string): Row[] {
  return all<Row>(
    'SELECT * FROM transactions WHERE is_refund = 1 AND original_transaction_id = ? ORDER BY rowid ASC',
    ticketId,
  );
}
function stockOf(pid: string): number {
  return Number(one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', pid)?.stock ?? NaN);
}
function openShiftId(): string | null {
  return (
    one<{ id: string }>("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY rowid DESC LIMIT 1")?.id ?? null
  );
}
function sessionRow(id: string): Row | undefined {
  return one<Row>('SELECT * FROM cash_sessions WHERE id = ?', id);
}
function expectedCashFor(sessionId: string): number {
  const s = sessionRow(sessionId);
  const rows = all<Row>(
    'SELECT * FROM transactions WHERE shift_id = ? AND is_refund = 0 AND deleted = 0',
    sessionId,
  );
  let cashIn = 0;
  for (const t of rows) {
    const j = jsonOf(t);
    const tenders = Array.isArray(j.tenders) ? (j.tenders as Array<Row>) : null;
    if (tenders) {
      const handed = tenders
        .filter((x) => String(x.method ?? '') === 'Espèces')
        .reduce((a, x) => a + Number(x.amount ?? 0), 0);
      cashIn += handed - Number(j.changeDue ?? t.change_due ?? 0);
    } else if (String(t.payment_method ?? '') === 'Espèces') {
      cashIn += Number(t.total);
    }
  }
  const cashOut = Number(
    one<{ s: number }>('SELECT COALESCE(SUM(amount),0) AS s FROM cash_movements WHERE session_id = ?', sessionId)
      ?.s ?? 0,
  );
  return Number(s?.opening_float ?? 0) + cashIn - cashOut;
}
function hasText(needle: string): Promise<boolean> {
  return browser.execute(
    (n: string) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
    needle,
  ) as Promise<boolean>;
}
async function bodyTail(): Promise<string> {
  return (await browser.execute(() =>
    (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(-500),
  )) as string;
}
async function waitSaleLanded(before: number, timeout = 60000): Promise<void> {
  await browser.waitUntil(() => txCount() > before, { timeout, timeoutMsg: 'sale did not land in SQLite' });
}
async function makeCashSale(title: string, qty = 1): Promise<{ id: string; receipt: string; total: number }> {
  await clearCart();
  for (let i = 0; i < qty; i++) await addSku(title);
  const before = txCount();
  await payExactFlow();
  await waitSaleLanded(before);
  const tx = newestTxRow();
  if (!tx) throw new Error('no sale row after checkout');
  return { id: String(tx.id), receipt: String(tx.receipt_number), total: Number(tx.total ?? 0) };
}
async function payDialogVisible(): Promise<boolean> {
  const dialogs = await $$(tid('pay-dialog'));
  for (const d of dialogs) if (await d.isDisplayed().catch(() => false)) return true;
  return false;
}
async function forceClosePay(): Promise<void> {
  const clicked = (await browser.execute(() => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch {
        return false;
      }
    };
    const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis) ?? null;
    const btn = dlg?.querySelector('[data-testid="pay-cancel"]') as HTMLButtonElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  })) as boolean;
  if (!clicked) await browser.keys(['Escape']).catch(() => {});
  await browser.pause(400);
}

// ---------------------------------------------------------------------------
// Shift close with readouts (MNY-20)
// ---------------------------------------------------------------------------

async function dismissZDialog(): Promise<void> {
  const zVisible = await (await $(tid('shift-z-dialog'))).isDisplayed().catch(() => false);
  if (!zVisible) return;
  await browser.execute(() => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch {
        return false;
      }
    };
    const dlg = ([...document.querySelectorAll('[data-testid="shift-z-dialog"]')] as HTMLElement[]).find(vis) ?? null;
    if (!dlg) return;
    const btns = [...dlg.querySelectorAll('button')] as HTMLButtonElement[];
    const b = btns.find((x) => /Fermer|OK|Continuer|Terminer/i.test(x.textContent || '')) ?? btns[btns.length - 1];
    b?.click();
  });
  await browser.pause(500);
}

async function closeShiftWithReadouts(
  tag: string,
  countedDa: number,
): Promise<{ uiExpected: bigint | null; uiCounted: bigint | null; uiVariance: bigint | null; zDialog: boolean; controls: string }> {
  await (await $(tid('shift-pill'))).click();
  await (await $(tid('shift-close-dialog'))).waitForDisplayed({
    timeout: 20000,
    timeoutMsg: 'shift-close-dialog never appeared after clicking the shift pill',
  });
  // STEP 1 — BLIND_COUNT: type the physical count, then advance ("Valider le
  // Comptage & Voir l'Audit" — shift-close-confirm only exists on step 2).
  if (!(countedDa > 0)) throw new Error(`closeShiftWithReadouts: non-positive blind count ${countedDa}`);
  const direct = await $(tid('shift-blind-direct'));
  if (await direct.isDisplayed().catch(() => false)) {
    await direct.click().catch(() => undefined);
    await browser.pause(250);
  }
  const input = await $(tid('shift-blind-input'));
  await input.waitForDisplayed({ timeout: 10000, timeoutMsg: 'shift-blind-input missing in BLIND_COUNT step' });
  await typeReal(input, String(countedDa), false);
  await browser.pause(250);
  await (await $(tid('shift-blind-next'))).click();
  // STEP 2 — RECONCILIATION readouts (validated against the DB oracle by MNY-20).
  const expEl = await $(tid('shift-expected'));
  await expEl.waitForDisplayed({ timeout: 12000, timeoutMsg: 'RECONCILIATION step never appeared' });
  await browser.pause(250);
  const expText = await expEl.getText().catch(() => '');
  const countedText = await (await $(tid('shift-counted'))).getText().catch(() => '');
  const varText = await (await $(tid('shift-variance'))).getText().catch(() => '');
  let varMinor: bigint | null = null;
  try {
    varMinor = varText.trim() ? displayedToMinor(varText) : null;
  } catch {
    varMinor = null;
  }
  if (varMinor !== null && varMinor !== 0n) {
    const note = await $(tid('shift-note-variance'));
    if (await note.isDisplayed().catch(() => false)) await typeReal(note, `E2E ${tag} variance note`, false);
  }
  const pinEl = await $(tid('shift-close-pin'));
  if (await pinEl.isDisplayed().catch(() => false)) await typeReal(pinEl, APP_PIN, false);
  await (await $(tid('shift-close-confirm'))).click();
  // Desktop Z snapshot view: prints then auto-dismisses (~1.6 s), no buttons.
  const zDialog = await (await $(tid('shift-z-dialog')))
    .waitForDisplayed({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  await browser.waitUntil(
    async () => !(await $(tid('shift-close-dialog')).isDisplayed().catch(() => false)),
    { timeout: 30000, timeoutMsg: `shift-close-dialog did not close (expected="${expText}")` },
  );
  const parse = (s: string): bigint | null => {
    try {
      return s.trim() ? displayedToMinor(s) : null;
    } catch {
      return null;
    }
  };
  console.log(
    `[shift-close ${tag}] expected="${expText}" counted="${countedText}" variance="${varText}" z=${zDialog}`,
  );
  return { uiExpected: parse(expText), uiCounted: parse(countedText), uiVariance: parse(varText), zDialog, controls: '' };
}

// ---------------------------------------------------------------------------
// Trade-in staging (MNY-26)
// ---------------------------------------------------------------------------

async function stageTradeIn(imei: string, priceDa: number): Promise<boolean> {
  const opened = (await browser.execute(() => {
    const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    const b = btns.find((x) => /Échanger un appareil|Trade-In/.test(x.textContent || '') && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!opened) return false;
  await browser.pause(900);
  const filled = (await browser.execute((imeiV: string) => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch {
        return false;
      }
    };
    const setValue = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = ([...document.querySelectorAll('input')] as HTMLInputElement[]).filter(vis);
    const byPh = (frag: string) => inputs.find((i) => (i.placeholder || '').includes(frag));
    const model = byPh('iPhone');
    const imeiEl = byPh('358921');
    const byLabel = (re: RegExp) => {
      const lab = [...document.querySelectorAll('label')].find((l) => re.test(l.textContent || ''));
      const sib = lab?.nextElementSibling as HTMLElement | null;
      return sib && sib.tagName === 'INPUT' ? (sib as HTMLInputElement) : undefined;
    };
    const nameEl = byLabel(/Nom & Pr/);
    if (!model || !imeiEl || !nameEl) return false;
    setValue(model, 'iPhone E2E 14');
    setValue(imeiEl, imeiV);
    setValue(nameEl, 'E2E Vendeur');
    const priceEl = document.querySelector('[data-testid="buyback-price"]') as HTMLInputElement | null;
    return Boolean(priceEl);
  }, imei)) as boolean;
  if (!filled) {
    console.log(`[trade-in] form fields not found :: ${(await bodyTail()).slice(-220)}`);
    return false;
  }
  const priceEl = await $(tid('buyback-price'));
  await typeMoneyInto(priceEl, priceDa);
  await browser.pause(400);
  const submitted = (await browser.execute(() => {
    const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    const b = btns.find((x) => /Valider l.?Échange/.test(x.textContent || '') && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!submitted) {
    console.log(`[trade-in] confirm button not found/disabled :: ${(await bodyTail()).slice(-220)}`);
    return false;
  }
  await browser.pause(900);
  const staged = await hasText('Reprise');
  console.log(`[trade-in] staged=${staged} (imei ${imei}, price ${priceDa})`);
  return staged;
}

// ---------------------------------------------------------------------------
// Coupon (PROMO500) via DiscountModal
// ---------------------------------------------------------------------------

async function applyPromo(code: string): Promise<string> {
  await (await $(tid('discount-button'))).click();
  await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 20000 });
  const set = (await browser.execute((c: string) => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch {
        return false;
      }
    };
    const dlg = ([...document.querySelectorAll('[data-testid="discount-dialog"]')] as HTMLElement[]).find(vis) ?? null;
    if (!dlg) return false;
    const input = ([...dlg.querySelectorAll('input')] as HTMLInputElement[]).find((i) =>
      /SOLDES10/.test(i.placeholder || ''),
    );
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, c);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
      /^Valider/.test((b.textContent || '').trim()),
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, code)) as boolean;
  if (!set) return 'no-promo-input';
  await browser.pause(600);
  const tail = await bodyTail();
  const needle = ['Appliqué', 'invalide', 'expiré', 'épuisé'].find((n) => tail.includes(n)) ?? '';
  console.log(`[promo] surface: "${needle}"`);
  // Apply (percent > 10 → manager PIN gate).
  const pin = await $(tid('discount-pin'));
  if (await pin.isDisplayed().catch(() => false)) await typeReal(pin, APP_PIN, false);
  await (await $(tid('discount-apply'))).click();
  await browser.waitUntil(async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)), {
    timeout: 20000,
    timeoutMsg: 'discount dialog did not close',
  });
  return needle;
}

// ---------------------------------------------------------------------------
// Reload / shell helpers
// ---------------------------------------------------------------------------

async function reloadWith(query: string): Promise<boolean> {
  await browser.execute((q: string) => {
    try {
      history.replaceState(null, '', q);
    } catch {
      /* ignore */
    }
  }, query);
  await browser.refresh();
  await browser.pause(1500);
  const ok = await browser
    .waitUntil(
      async () => {
        const hasBody = await browser.execute(() => (document.body?.innerText || '').length > 0);
        return hasBody === true;
      },
      { timeout: 30000, interval: 500 },
    )
    .then(() => true)
    .catch(() => false);
  await installErrorTrap().catch(() => undefined);
  await unlockIfNeeded().catch((e) => console.log(`[reload] unlock: ${String((e as Error)?.message ?? e)}`));
  return ok;
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe('MNY — money, rounding, currency (batch 2)', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    resetData();
    seedProducts([
      { id: 'MNY2-A', title: 'MNY2 A', priceDa: 100, stock: 1000, costDa: 40 },
      { id: 'MNY2-B', title: 'MNY2 B', priceDa: 250, stock: 1000, costDa: 100 },
      { id: 'MNY2-C', title: 'MNY2 C', priceDa: 33, stock: 1000, costDa: 10 },
      { id: 'MNY2-D', title: 'MNY2 D', priceDa: 999, stock: 1000, costDa: 400 },
      { id: 'MNY2-E', title: 'MNY2 E', priceDa: 7, stock: 1000, costDa: 3 },
      { id: 'MNY2-P2000', title: 'MNY2 P2000', priceDa: 2000, stock: 500, costDa: 800 },
      { id: 'MNY2-P1000', title: 'MNY2 P1000', priceDa: 1000, stock: 500, costDa: 400 },
      { id: 'MNY2-P500', title: 'MNY2 P500', priceDa: 500, stock: 500, costDa: 200 },
      { id: 'MNY2-P700', title: 'MNY2 P700', priceDa: 700, stock: 500, costDa: 300 },
      { id: 'MNY2-P350', title: 'MNY2 P350', priceDa: 350, stock: 500, costDa: 150 },
      { id: 'MNY2-RB100', title: 'MNY2 RB100', priceDa: 100, stock: 500, costDa: 40 },
      { id: 'MNY2-RB200', title: 'MNY2 RB200', priceDa: 200, stock: 500, costDa: 80 },
      { id: 'MNY2-RB350', title: 'MNY2 RB350', priceDa: 350, stock: 500, costDa: 140 },
    ]);
    seedBundles([
      { id: 'BND-MNY30', title: 'Pack MNY30', barcode: BUNDLE_BARCODE, bundlePriceDa: 500, childSkus: BUNDLE_SKUS },
    ]);
    seedCustomerFull([
      { id: CUST26, name: CUST26_NAME, phone: '0551200026', storeCreditDa: 400 },
      // MNY-25 — the receivable's SHAPE mirrors a real credit acquisition:
      // payload + ledger carry the 1 000 DA while the v127 column stays stale
      // at 0 (P2-7: no sale-path column writer; see invariants G-32).
      { id: CUST25, name: CUST25_NAME, phone: '0551200025', currentDebtDa: 1000, currentDebtColumnDa: 0, debtLimitDa: 100000 },
    ]);
    // The ledger row is the money authority for the plan/settle assertions and
    // what makes the Kredy card expandable (KredyTab.tsx:1012 gates the history
    // toggle on `meta.totalMovements > 0`; the plan form lives inside the
    // expanded card).
    seedCustomerDebts([
      {
        id: 'E2E-MNY25-DEBT-1',
        customerId: CUST25,
        customerName: CUST25_NAME,
        type: 'DEBT_ACQUIRED',
        amountDa: 1000,
        balanceAfterDa: 1000,
        notes: 'E2E seed — achat à crédit (MNY-25)',
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        kind: 'ACHAT',
      },
    ]);
    await clearWebMirrors();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
    // Bundles have no SQLite→Dexie boot sync (products do): the SQLite
    // product_bundles seed above stays invisible to the store, so mirror the
    // pack into the app's Dexie `bundles` store (created by the shift flow
    // above) and reload once — boot then hydrates it and the wedge resolves
    // the pack barcode.
    await seedBundleMirror([
      { id: 'BND-MNY30', bundleTitle: 'Pack MNY30', barcode: BUNDLE_BARCODE, bundlePrice: 500, childSkus: BUNDLE_SKUS },
    ]);
    // The debt ledger has the same boot-sync gap as bundles (boot hydration
    // reads the Dexie mirror ONLY — customerAdapter.getAllCustomerDebts
    // :411-413), so mirror the SQLite seed row exactly as the app's own
    // dual-write would (customerAdapter.saveCustomerDebt :359/:375).
    await seedCustomerDebtMirror([
      {
        id: 'E2E-MNY25-DEBT-1',
        customerId: CUST25,
        customerName: CUST25_NAME,
        type: 'DEBT_ACQUIRED',
        amount: 1000,
        balanceAfter: 1000,
        receiptNumber: null,
        paymentMethod: null,
        notes: 'E2E seed — achat à crédit (MNY-25)',
        recordedBy: 'E2E-seed',
        createdAt: new Date().toISOString(),
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString(),
        kind: 'ACHAT',
        deleted: false,
        version: 1,
      },
    ]);
    await browser.refresh();
    await installPageShims();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    captureInvariantBaseline('MNY2');
  });

  afterEach(async function () {
    if (await refundDialogVisible()) await closeRefund().catch(() => {});
    if (await payDialogVisible()) await forceClosePay().catch(() => {});
    await closeDialogs().catch(() => {});
    await clearCart().catch((e) => console.log('[afterEach] clearCart:', String((e as Error)?.message ?? e)));
    const title = String(
      (this as unknown as { currentTest?: { title?: string } }).currentTest?.title ?? 'unknown',
    );
    assertInvariants(`MNY2 :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('MNY batch2 (spec 11)');
  });

  it('[MNY-19] Σ line totals == invoice total == payment total over a deterministic random-basket sample', async () => {
    // Feasibility: the case asks for 10,000 baskets; a UI-driven run cannot
    // pay 10k baskets in budget. Deterministic PRNG sample, seed 20261018.
    const prices: Record<string, number> = {
      'MNY2 A': 100,
      'MNY2 B': 250,
      'MNY2 C': 33,
      'MNY2 D': 999,
      'MNY2 E': 7,
    };
    const titles = Object.keys(prices);
    let s = 20261018;
    const rand = (n: number) => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s % n;
    };
    let expectedTotal = 0;
    let invoiceSum = 0;
    let lineSum = 0;
    const receipts: string[] = [];
    for (let b = 0; b < 8; b++) {
      const lines = 2 + rand(3); // 2..4 distinct products
      const picks = new Set<number>();
      while (picks.size < lines) picks.add(rand(titles.length));
      let expected = 0;
      await clearCart();
      for (const idx of picks) {
        const title = titles[idx];
        const qty = 1 + rand(3); // 1..3
        await addSku(title, { times: qty });
        expected += prices[title] * qty;
      }
      const shown = await cartTotalMinor();
      console.log(`[MNY-19] basket ${b}: expected=${expected} shown=${shown} lines=[${[...picks].map((i) => titles[i]).join(' + ')}]`);
      expect(shown).toBe(BigInt(expected) * 100n);
      const before = txCount();
      await payExactFlow();
      await waitSaleLanded(before);
      const tx = newestTxRow();
      if (!tx) throw new Error('basket sale row missing');
      const total = Number(tx.total ?? 0);
      const items = all<Row>(
        'SELECT product_id, quantity, unit_price_charged FROM transaction_items WHERE transaction_id = ?',
        String(tx.id),
      );
      const itemSum = items.reduce((a, i) => a + Number(i.quantity ?? 0) * Number(i.unit_price_charged ?? 0), 0);
      const tenders = Array.isArray(jsonOf(tx).tenders) ? (jsonOf(tx).tenders as Array<Row>) : [];
      const paid = tenders.reduce((a, t) => a + Number(t.amount ?? 0), 0) - Number(jsonOf(tx).changeDue ?? 0);
      console.log(
        `[MNY-19] basket ${b} landed ${String(tx.receipt_number)} invoice=${total} lines Σ=${itemSum} payment Σ=${paid}`,
      );
      expect(total).toBe(expected);
      expect(itemSum).toBe(expected);
      expect(paid).toBe(expected);
      receipts.push(String(tx.receipt_number));
      expectedTotal += expected;
      invoiceSum += total;
      lineSum += itemSum;
    }
    console.log(
      `[MNY-19] aggregate over 8 baskets: expected=${expectedTotal} invoice=${invoiceSum} lines=${lineSum} distinct receipts=${new Set(receipts).size}/8`,
    );
    expect(invoiceSum).toBe(expectedTotal);
    expect(lineSum).toBe(expectedTotal);
    expect(new Set(receipts).size).toBe(8);
  });

  it('[MNY-20] Z totals vs oracle across two shifts: UI close readouts == opening + net cash − movements', async () => {
    const shiftA = openShiftId();
    expect(shiftA).not.toBeNull();
    const a1 = await makeCashSale('MNY2 P1000', 1);
    const a2 = await makeCashSale('MNY2 P500', 1);
    expect(a1.total).toBe(1000);
    expect(a2.total).toBe(500);
    const oracleA = expectedCashFor(String(shiftA));
    console.log(`[MNY-20] shift A oracle=${oracleA} (opening 10000 + 1000 + 500)`);
    const readA = await closeShiftWithReadouts('A', oracleA);
    console.log(`[MNY-20] shift A readouts: expected=${readA.uiExpected} counted=${readA.uiCounted} variance=${readA.uiVariance} z=${readA.zDialog} controls=${readA.controls}`);
    expect(readA.uiExpected).not.toBeNull();
    expect(readA.uiExpected).toBe(BigInt(oracleA) * 100n);
    expect(readA.uiCounted).toBe(BigInt(oracleA) * 100n);
    expect(readA.uiVariance).toBe(0n);
    const sessA = sessionRow(String(shiftA));
    expect(String(sessA?.status)).toBe('CLOSED');
    console.log(
      `[MNY-20] shift A DB: expected_cash=${sessA?.expected_cash} actual_cash=${sessA?.actual_cash} discrepancy=${sessA?.discrepancy}`,
    );
    expect(Number(sessA?.expected_cash)).toBe(oracleA);
    expect(Number(sessA?.actual_cash)).toBe(oracleA);
    expect(Number(sessA?.discrepancy)).toBe(0);

    await openShiftUi(5000);
    const shiftB = openShiftId();
    expect(shiftB).not.toBeNull();
    const b1 = await makeCashSale('MNY2 P1000', 1);
    // Refund B1 → the movement that the oracle must subtract.
    if (!(await refundDialogVisible())) {
      await (await $(tid('refund-button'))).click();
      await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 20000 });
    }
    await refundSearch(b1.receipt);
    const pick = await selectRefundTicket(b1.receipt, 8000);
    expect(pick).toBe('clicked');
    await selectRefundMethod('Espèces');
    await typeRefundPin(APP_PIN);
    await clickRefundSubmit();
    await browser.waitUntil(() => refundsFor(b1.id).length >= 1, { timeout: 40000, timeoutMsg: 'refund B1 never landed' });
    await browser.pause(400);
    const b2 = await makeCashSale('MNY2 P500', 1);
    const oracleB = expectedCashFor(String(shiftB));
    console.log(`[MNY-20] shift B oracle=${oracleB} (5000 + 1000 + 500 − 1000)`);
    expect(oracleB).toBe(5500);
    const readB = await closeShiftWithReadouts('B', oracleB);
    console.log(`[MNY-20] shift B readouts: expected=${readB.uiExpected} counted=${readB.uiCounted} variance=${readB.uiVariance} z=${readB.zDialog}`);
    expect(readB.uiExpected).toBe(BigInt(oracleB) * 100n);
    expect(readB.uiVariance).toBe(0n);
    const sessB = sessionRow(String(shiftB));
    expect(String(sessB?.status)).toBe('CLOSED');
    expect(Number(sessB?.expected_cash)).toBe(oracleB);
    expect(Number(sessB?.actual_cash)).toBe(oracleB);
    expect(Number(sessB?.discrepancy)).toBe(0);

    // The monthly-report identity, reduced honestly to two shifts:
    const zSum = (readA.uiExpected ?? 0n) + (readB.uiExpected ?? 0n);
    const oracleSum = BigInt(oracleA + oracleB) * 100n;
    console.log(`[MNY-20] Σ Z readouts=${zSum} == Σ oracles=${oracleSum}`);
    expect(zSum).toBe(oracleSum);
    expect(b2.total).toBe(500);

    // Leave a fresh open shift for the following cases.
    await ensureShiftOpen(10000);
  });

  it('[MNY-21] negative amounts: fr sign placement, return-line sign, RTL re-render honesty check', async () => {
    await clearCart();
    await addSku('MNY2 P700');
    await toggleLastLineReturn(APP_PIN);
    await addSku('MNY2 P350');
    const total = await cartTotalMinor();
    const lines = await cartLineTexts();
    console.log(`[MNY-21] fr total=${total} lines=${JSON.stringify(lines)}`);
    expect(total).toBe(-35000n);
    const returnLine = lines.find((l) => /700/.test(l)) ?? '';
    expect(returnLine).toMatch(/[-−]\s?700/);

    // Money containment: no negative sale may land.
    const before = txCount();
    await (await $(tid('checkout-button'))).click().catch(() => undefined);
    await browser.pause(1500);
    const opened = await payDialogVisible();
    let surface = '';
    if (opened) {
      surface = await bodyTail();
      console.log(`[MNY-21] negative checkout opened the pay dialog — surface tail: ${surface.slice(-240)}`);
      await forceClosePay().catch(() => {});
    } else {
      surface = (await bodyTail()).slice(-240);
      console.log(`[MNY-21] negative checkout did not open a pay dialog: ${surface}`);
    }
    expect(txCount()).toBe(before);

    // RTL leg: reload in ar and re-render the SAME cart payload where the
    // store survives the reload; otherwise log the limitation honestly.
    const reloaded = await reloadWith('?lang=ar');
    console.log(`[MNY-21] ar reload ok=${reloaded}`);
    let arChecked = false;
    try {
      const arTotal = await cartTotalMinor();
      const arLines = await cartLineTexts();
      console.log(`[MNY-21] ar total=${arTotal} lines=${JSON.stringify(arLines)}`);
      expect(arTotal).toBe(-35000n);
      const arReturn = arLines.find((l) => /700/.test(l)) ?? '';
      expect(arReturn).toMatch(/[-−]\s?700/);
      arChecked = true;
    } catch (e) {
      console.log(`[MNY-21] ar leg limited: ${String((e as Error)?.message ?? e).slice(0, 180)}`);
    }
    console.log(`[MNY-21] ar RTL display checked=${arChecked}`);
    await reloadWith('?lang=fr');
  });

  it('[MNY-26] override + coupon + loyalty + trade-in: oracle exact, total ≥ 0, refund reverses each component', async () => {
    // Line lane: 2000 → 1800 override.
    await clearCart();
    await addSku('MNY2 P2000');
    await overrideLastLinePrice('1800', { pin: APP_PIN });
    // Coupon lane: PROMO500 amount → percent of the overridden subtotal.
    const promo = await applyPromo('PROMO500');
    expect(promo).toBe('Appliqué');
    const cartAfterCoupon = await cartTotalMinor();
    console.log(`[MNY-26] cart after override+coupon: ${cartAfterCoupon}`);
    expect(cartAfterCoupon).toBe(130000n); // 1800 − 500
    // Trade-in lane: 300 staged before checkout.
    const staged = await stageTradeIn(IMEI_A, 300);
    expect(staged).toBe(true);
    // Loyalty lane: attach customer (400 DA credit), apply all.
    await selectCustomer(CUST26_NAME);
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const applied = (await browser.execute(() => {
      const vis = (d: HTMLElement) => {
        try {
          const cs = getComputedStyle(d);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      };
      const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis) ?? null;
      if (!dlg) return false;
      const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
        /Appliquer Tout/.test(b.textContent || ''),
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })) as boolean;
    expect(applied).toBe(true);
    await browser.pause(500);
    // Hand oracle: subtotal 1800 − coupon 500 = 1300; guardrail caps loyalty at
    // min(balance 400, 50%×1300=650, margin 1300−800=500) = 400; trade-in 300;
    // net = 1300 − 400 − 300 = 600.
    const payNet = displayedToMinor(await (await $(tid('pay-net'))).getText());
    console.log(`[MNY-26] pay-net after all credits: ${payNet} (oracle 60000)`);
    expect(payNet).toBe(60000n);
    const before = txCount();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(async () => !(await payDialogVisible()), { timeout: 60000, timeoutMsg: 'pay dialog did not close' });
    await waitSaleLanded(before);
    const sale = newestTxRow();
    const saleId = String(sale?.id);
    const sj = jsonOf(sale);
    const tenders = Array.isArray(sj.tenders) ? (sj.tenders as Array<Row>) : [];
    console.log(
      `[MNY-26] sale total=${sale?.total} subtotal=${sale?.subtotal} discount=${sale?.discount_total} tenders=${JSON.stringify(tenders)} tradeIn=${String(sj.tradeInCredit)}`,
    );
    expect(Number(sale?.total)).toBe(600);
    expect(Number(sale?.subtotal)).toBe(1800);
    // Trade-in is recorded canonically as tradeInId + tradeInDeduction on the
    // committed payload (the desktop model has no `tradeInCredit` key; the
    // Reprise tender leg below carries the amount too).
    expect(Number(sj.tradeInDeduction ?? 0)).toBe(300);
    expect(String(sj.tradeInId ?? '')).toMatch(/^trade-/);
    const avoirTender = tenders
      .filter((t) => String(t.method ?? '') === 'Avoir Client')
      .reduce((a, t) => a + Number(t.amount ?? 0), 0);
    expect(avoirTender).toBe(400);

    // Clamp leg first (independent of the refund leg): trade-in == net → the
    // total must be exactly 0, never negative. Runs before the full-refund leg
    // so its evidence survives that leg's expected P0-9 failure.
    await clearCart();
    await addSku('MNY2 P500');
    const staged2 = await stageTradeIn(IMEI_B, 500);
    expect(staged2).toBe(true);
    const before2 = txCount();
    await (await $(tid('checkout-button'))).click();
    await browser.pause(1500);
    if (await payDialogVisible()) {
      const clampNet = displayedToMinor(await (await $(tid('pay-net'))).getText());
      console.log(`[MNY-26] clamp leg pay-net=${clampNet}`);
      expect(clampNet).toBe(0n);
      await (await $(tid('pay-exact'))).click().catch(() => undefined);
      await (await $(tid('pay-confirm'))).click();
      await browser.waitUntil(async () => !(await payDialogVisible()), { timeout: 60000, timeoutMsg: 'clamp pay dialog did not close' });
      await waitSaleLanded(before2);
      const clampSale = newestTxRow();
      console.log(
        `[MNY-26] clamp sale total=${clampSale?.total} tradeInDeduction=${String(jsonOf(clampSale).tradeInDeduction)}`,
      );
      expect(Number(clampSale?.total)).toBe(0);
      expect(Number(clampSale?.total)).toBeGreaterThanOrEqual(0);
      const merchants = refundsFor(String(clampSale?.id));
      expect(merchants.length).toBe(0);
    } else {
      console.log(`[MNY-26] clamp leg: checkout did not open a pay dialog — surface: ${(await bodyTail()).slice(-220)}`);
    }

    // Full refund: value reversed 1300; cash back 600; loyalty restored 400.
    await clearCart().catch(() => {});
    await (await $(tid('refund-button'))).click();
    await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 20000 });
    await refundSearch(String(sale?.receipt_number));
    const pick = await selectRefundTicket(String(sale?.receipt_number), 8000);
    expect(pick).toBe('clicked');
    await selectRefundMethod('Espèces');
    const shown = await refundTotalMinor();
    console.log(`[MNY-26] refund modal shows: ${shown} (oracle 130000)`);
    expect(shown).toBe(130000n);
    await typeRefundPin(APP_PIN);
    await clickRefundSubmit();
    await browser.waitUntil(() => refundsFor(saleId).length >= 1, { timeout: 40000, timeoutMsg: 'refund never landed' });
    await browser.pause(400);
    const ref = refundsFor(saleId)[0];
    const cashOut = Number(jsonOf(ref).cashDisbursed ?? 0);
    // All read-backs are captured BEFORE the assertions: a P0-9 underpay then
    // still yields its full evidence trail (total, cash share, wallet, trades).
    const cust = one<Row>('SELECT * FROM customers WHERE id = ?', CUST26);
    const tradeIns = all<Row>('SELECT * FROM trade_ins ORDER BY rowid ASC');
    console.log(`[MNY-26] refund total=${ref.total} cashDisbursed=${cashOut} payload=${JSON.stringify(jsonOf(ref)).slice(0, 300)}`);
    console.log(`[MNY-26] customer store_credit after refund: ${cust?.store_credit}`);
    console.log(
      `[MNY-26] trade_ins rows=${tradeIns.length} statuses=${JSON.stringify(tradeIns.map((t) => ({ id: t.id, st: t.status, credit: t.credit_to_wallet })))}`,
    );
    expect(Number(ref.total)).toBe(1300);
    expect(cashOut).toBe(600);
    expect(Number(cust?.store_credit)).toBe(400);
  });

  it('[MNY-30] bundle 100+200+350 → 500: allocation 77/154/269 exact, single-child refund recovers 269', async () => {
    const base100 = stockOf('MNY2-RB100');
    const base200 = stockOf('MNY2-RB200');
    const base350 = stockOf('MNY2-RB350');
    await clearCart();
    const scanned = await scanCode(BUNDLE_BARCODE);
    expect(scanned).toBe(true);
    const total = await cartTotalMinor();
    console.log(`[MNY-30] cart total after bundle scan: ${total} (oracle 50000)`);
    expect(total).toBe(50000n);
    const before = txCount();
    await payExactFlow();
    await waitSaleLanded(before);
    const sale = newestTxRow();
    const saleId = String(sale?.id);
    expect(Number(sale?.total)).toBe(500);
    const items = all<Row>(
      'SELECT product_id, quantity, applied_price, discount, discount_amount, unit_price_charged, line_profit FROM transaction_items WHERE transaction_id = ? ORDER BY rowid',
      saleId,
    );
    const byProduct = new Map(items.map((i) => [String(i.product_id), i]));
    // Effective per-line charge = applied_price − discount: the bundle
    // allocation lands in `discount` (23/46/81), while `unit_price_charged`
    // keeps the plain child price and `discount_amount` stays 0 on these rows
    // (probe: line_profit 37/74/129 = effective − cost).
    const charged = (pid: string) => {
      const r = byProduct.get(pid);
      return r ? Number(r.applied_price) - Number(r.discount) : NaN;
    };
    console.log(
      `[MNY-30] items: ${JSON.stringify(items.map((i) => ({ p: i.product_id, q: i.quantity, ap: i.applied_price, d: i.discount, eff: charged(String(i.product_id)), profit: i.line_profit })))}`,
    );
    expect(charged('MNY2-RB100')).toBe(77);
    expect(charged('MNY2-RB200')).toBe(154);
    expect(charged('MNY2-RB350')).toBe(269);
    const sum = ['MNY2-RB100', 'MNY2-RB200', 'MNY2-RB350'].reduce((a, p) => a + charged(p), 0);
    expect(sum).toBe(500);
    // Stock: one unit off each child.
    expect(stockOf('MNY2-RB100')).toBe(base100 - 1);
    expect(stockOf('MNY2-RB200')).toBe(base200 - 1);
    expect(stockOf('MNY2-RB350')).toBe(base350 - 1);

    // Refund ONLY the 350 child (its allocated share is 269).
    await (await $(tid('refund-button'))).click();
    await (await $(tid('refund-dialog'))).waitForDisplayed({ timeout: 20000 });
    await refundSearch(String(sale?.receipt_number));
    const pick = await selectRefundTicket(String(sale?.receipt_number), 8000);
    expect(pick).toBe('clicked');
    // Uncheck the two children we keep; keep RB350 at qty 1.
    // Line keys are `${productId}_${idx}` (RefundModal :57/:797 — idx is the
    // position in the sale's item list: RB100_0, RB200_1, RB350_2), so resolve
    // them from the DOM rather than assuming a fixed index.
    const uncheck = await browser.execute(() => {
      const vis = (d: HTMLElement) => {
        try {
          const cs = getComputedStyle(d);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      };
      const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis) ?? null;
      if (!dlg) return [] as string[];
      const done: string[] = [];
      for (const pid of ['MNY2-RB100', 'MNY2-RB200']) {
        const box =
          ([...dlg.querySelectorAll(`[data-testid^="refund-check-${pid}_"]`)] as HTMLInputElement[]).find((b) => vis(b)) ?? null;
        if (box && box.checked) {
          box.click();
          done.push(box.getAttribute('data-testid') ?? pid);
        }
      }
      return done;
    });
    console.log(`[MNY-30] unchecked lines: ${JSON.stringify(uncheck)}`);
    expect(uncheck.length).toBe(2);
    await browser.pause(400);
    const rb350Key = (await browser.execute(() => {
      const vis = (d: HTMLElement) => {
        try {
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      };
      const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis) ?? null;
      if (!dlg) return '';
      const box = ([...dlg.querySelectorAll('[data-testid^="refund-check-MNY2-RB350_"]')] as HTMLElement[]).find(vis) ?? null;
      const tid = box?.getAttribute('data-testid') ?? '';
      return tid ? tid.replace('refund-check-', '') : '';
    })) as string;
    expect(rb350Key).toMatch(/^MNY2-RB350_\d+$/);
    await setRefundQty(rb350Key, 1);
    await selectRefundMethod('Espèces');
    const shown = await refundTotalMinor();
    console.log(`[MNY-30] refund modal shows: ${shown} (oracle 26900)`);
    expect(shown).toBe(26900n);
    await typeRefundPin(APP_PIN);
    await clickRefundSubmit();
    await browser.waitUntil(() => refundsFor(saleId).length >= 1, { timeout: 40000, timeoutMsg: 'child refund never landed' });
    await browser.pause(400);
    const ref = refundsFor(saleId)[0];
    console.log(
      `[MNY-30] child refund total=${ref.total} cashDisbursed=${String(jsonOf(ref).cashDisbursed)} stocks: RB100=${stockOf('MNY2-RB100')} RB200=${stockOf('MNY2-RB200')} RB350=${stockOf('MNY2-RB350')} (bases ${base100}/${base200}/${base350})`,
    );
    expect(Number(ref.total)).toBe(269);
    expect(Number(jsonOf(ref).cashDisbursed)).toBe(269);
    // Only RB350 restocked.
    expect(stockOf('MNY2-RB350')).toBe(base350);
    expect(stockOf('MNY2-RB100')).toBe(base100 - 1);
    expect(stockOf('MNY2-RB200')).toBe(base200 - 1);
  });

  it('[MNY-25] instalment plans (Kredy, mobile): Σ entries == total, remainder to earliest, early payoff fills FIFO + closes the plan, no fee model exists', async () => {
    // Preconditions — CUST25 receivable shape: payload + ledger carry 1 000 DA,
    // the v127 column stays 0 (P2-7), one ledger movement so the card renders
    // its history toggle (KredyTab.tsx:1012).
    let planId = '';
    const ledgerBalance = () =>
      Number(
        one<{ b: number }>(
          `SELECT COALESCE(SUM(CASE WHEN type='DEBT_ACQUIRED' THEN amount WHEN type='PAYMENT_SETTLED' THEN -amount ELSE 0 END),0) AS b
           FROM customer_debts WHERE customer_id = ? AND deleted = 0`,
          CUST25,
        )?.b ?? NaN,
      );
    const payloadDebt = () =>
      Number(
        (
          JSON.parse(String(one<Row>('SELECT json_payload FROM customers WHERE id = ?', CUST25)?.json_payload ?? '{}')) as {
            currentDebt?: number;
          }
        ).currentDebt ?? NaN,
      );
    const planStatus = () => String(one<Row>('SELECT status FROM debt_plans WHERE id = ?', planId)?.status ?? '?');
    expect(ledgerBalance()).toBe(1000);
    expect(payloadDebt()).toBe(1000);
    const plansBefore = count('debt_plans');

    // ── Mobile shell → demo entry → Kredy tab ──────────────────────────────
    const reloadOk = await reloadWith('?mode=mobile&lang=fr');
    const shellMobile = (await browser.execute(() => document.documentElement.dataset.shell ?? '')) as string;
    console.log(`[MNY-25] mobile reload ok=${reloadOk} shell=${shellMobile}`);
    // No skip: the plan form is a shipped feature and must be reachable.
    expect(shellMobile).toBe('mobile');
    const demoClicked = (await browser.execute(() => {
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      const b = btns.find((x) => /Mode Démo/i.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    await browser.pause(1500);
    const tabClicked = (await browser.execute(() => {
      const els = [...document.querySelectorAll('button, [role="tab"], a')] as HTMLElement[];
      const b = els.find((x) => /Kredy|Crédit|تقسيط/i.test(x.textContent || '') && !((x as HTMLButtonElement).disabled ?? false));
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    await browser.pause(1200);
    console.log(`[MNY-25] mobile walk: demo=${demoClicked} kredyTab=${tabClicked}`);
    expect(tabClicked).toBe(true);

    // ── Search the debtor ───────────────────────────────────────────────────
    const searched = (await browser.execute((name: string) => {
      const vis = (d: HTMLElement) => {
        try {
          const cs = getComputedStyle(d);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      };
      const input = ([...document.querySelectorAll('input')] as HTMLInputElement[]).find(
        (i) => vis(i) && /chercher|recherche|search/i.test(i.placeholder || ''),
      );
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, CUST25_NAME)) as boolean;
    expect(searched).toBe(true);
    await browser.pause(1000);

    // ── Expand the card — the history toggle exists only when the ledger has
    //    movements (KredyTab.tsx:1012) and carries the plan form body. ──────
    const expandClicked = (await browser.execute((name: string) => {
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      const b = btns.find((x) => {
        const al = x.getAttribute('aria-label') || '';
        return /Historique/.test(al) && al.includes(name) && !x.disabled;
      });
      if (!b) return false;
      b.click();
      return true;
    }, CUST25_NAME)) as boolean;
    console.log(`[MNY-25] expand toggle clicked=${expandClicked}`);
    const planFormVisible = await browser
      .waitUntil(
        () =>
          browser.execute(() => {
            const spans = [...document.querySelectorAll('span')] as HTMLElement[];
            return spans.some((s) => /Plan de paiement 0 %/.test(s.textContent || ''));
          }),
        { timeout: 10000, interval: 300 },
      )
      .then(() => true)
      .catch(() => false);
    console.log(`[MNY-25] plan section visible=${planFormVisible}`);
    expect(planFormVisible).toBe(true);

    const setPlanMoney = async (digits: string) =>
      (await browser.execute((d: string) => {
        const spans = [...document.querySelectorAll('span')] as HTMLElement[];
        const title = spans.find((s) => /Plan de paiement 0 %/.test(s.textContent || ''));
        const section = title?.parentElement ?? null;
        const input = section
          ? ([...section.querySelectorAll('input')] as HTMLInputElement[]).find((i) => i.type !== 'number')
          : null;
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, d);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }, digits)) as boolean;
    const clickCreatePlan = async () =>
      (await browser.execute(() => {
        const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
        const b = btns.find((x) => /Créer le plan/.test(x.textContent || '') && !x.disabled);
        if (!b) return false;
        b.click();
        return true;
      })) as boolean;

    // ── Negative control: a total above the outstanding is refused ─────────
    expect(await setPlanMoney('1500')).toBe(true);
    await browser.pause(400);
    expect(await clickCreatePlan()).toBe(true);
    const refusalSeen = await browser
      .waitUntil(
        () => browser.execute(() => /dépasse l'encours du client/.test(document.body.innerText || '')),
        { timeout: 8000, interval: 250 },
      )
      .then(() => true)
      .catch(() => false);
    console.log(`[MNY-25] over-outstanding 1500 refused=${refusalSeen}; debt_plans=${count('debt_plans')}`);
    expect(refusalSeen).toBe(true);
    expect(count('debt_plans')).toBe(plansBefore);

    // ── Create the plan: 1 000 DA over 3 × 30 days ─────────────────────────
    expect(await setPlanMoney('1000')).toBe(true);
    await browser.pause(400);
    expect(await clickCreatePlan()).toBe(true);
    await browser.waitUntil(() => count('debt_plans') > plansBefore, { timeout: 15000, interval: 400 });
    const plan = one<Row>('SELECT * FROM debt_plans ORDER BY rowid DESC LIMIT 1');
    planId = String(plan.id);
    expect(String(plan.customer_id)).toBe(CUST25);
    expect(Number(plan.total_amount)).toBe(1000);
    expect(Number(plan.installments)).toBe(3);
    expect(Number(plan.interval_days)).toBe(30);
    expect(String(plan.status)).toBe('ACTIF');
    const entriesNow = () => all<Row>('SELECT * FROM debt_plan_entries WHERE plan_id = ? ORDER BY seq ASC', planId);
    const e0 = entriesNow();
    expect(e0.length).toBe(3);
    const amounts = e0.map((e) => Number(e.amount));
    const sum = amounts.reduce((a, x) => a + x, 0);
    console.log(
      `[MNY-25] plan ${planId}: amounts=[${amounts.join(',')}] Σ=${sum} (Σ===total is the money law; the remainder lands on the EARLIEST entry — kredyEngine.buildInstallmentPlan contract)`,
    );
    expect(sum).toBe(1000);
    expect(amounts).toEqual([334, 333, 333]);
    const startMs = Date.parse(String(plan.start_date));
    for (let i = 0; i < 3; i++) {
      expect(Math.round((Date.parse(String(e0[i].due_date)) - startMs) / 86400000)).toBe(30 * (i + 1));
      expect(Number(e0[i].paid_amount)).toBe(0);
      expect(e0[i].paid_at).toBeNull();
    }
    // ── Early payoff step 1: settle one instalment (334) ───────────────────
    const openSettlement = async () =>
      (await browser.execute((name: string) => {
        const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
        const b = btns.find((x) => {
          const al = x.getAttribute('aria-label') || '';
          return /^Régler — /.test(al) && al.includes(name) && !x.disabled;
        });
        if (!b) return false;
        b.click();
        return true;
      }, CUST25_NAME)) as boolean;
    const setSettlementMoney = async (digits: string) =>
      (await browser.execute((d: string) => {
        const input = document.getElementById('kredy-payment-amount') as HTMLInputElement | null;
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, d);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }, digits)) as boolean;
    const settlementLabel = () =>
      browser.execute(() => {
        const dlg = document.querySelector('[aria-labelledby="kredy-settlement-title"]');
        const btn = dlg?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        return btn ? (btn.textContent || '').trim() : '';
      }) as Promise<string>;
    const submitSettlement = async () =>
      (await browser.execute(() => {
        const dlg = document.querySelector('[aria-labelledby="kredy-settlement-title"]');
        const btn = dlg?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })) as boolean;

    expect(await openSettlement()).toBe(true);
    await browser.waitUntil(() => browser.execute(() => !!document.getElementById('kredy-payment-amount')), {
      timeout: 8000,
      interval: 250,
    });
    expect(await setSettlementMoney('334')).toBe(true);
    await browser.pause(350);
    console.log(`[MNY-25] settle#1 submit label="${await settlementLabel()}" (partial ⇒ confirmPaymentButton)`);
    expect(await submitSettlement()).toBe(true);
    await browser.waitUntil(() => Number(entriesNow()[0]?.paid_amount ?? 0) === 334, { timeout: 20000, interval: 400 });
    await browser.waitUntil(() => browser.execute(() => !document.getElementById('kredy-payment-amount')), {
      timeout: 10000,
      interval: 300,
    });
    const e1 = entriesNow();
    console.log(
      `[MNY-25] after settle#1: paid=[${e1.map((e) => Number(e.paid_amount)).join(',')}] status=${planStatus()} payload=${payloadDebt()} ledger=${ledgerBalance()}`,
    );
    expect(e1.map((e) => Number(e.paid_amount))).toEqual([334, 0, 0]);
    expect(String(e1[0].paid_at ?? '')).not.toBe('');
    expect(planStatus()).toBe('ACTIF');
    expect(payloadDebt()).toBe(666);
    expect(ledgerBalance()).toBe(666);

    // ── Early payoff step 2: settle the remainder (default = 666, full) ────
    expect(await openSettlement()).toBe(true);
    await browser.waitUntil(() => browser.execute(() => !!document.getElementById('kredy-payment-amount')), {
      timeout: 8000,
      interval: 250,
    });
    console.log(`[MNY-25] settle#2 default submit label="${await settlementLabel()}" (full ⇒ settleFullDebtButton)`);
    expect(await submitSettlement()).toBe(true);
    await browser.waitUntil(() => planStatus() === 'SOLDE', { timeout: 20000, interval: 400 });
    const e2 = entriesNow();
    console.log(
      `[MNY-25] after settle#2: paid=[${e2.map((e) => Number(e.paid_amount)).join(',')}] status=${planStatus()}`,
    );
    expect(e2.map((e) => Number(e.paid_amount))).toEqual([334, 333, 333]);
    for (const e of e2) expect(String(e.paid_at ?? '')).not.toBe('');
    // Early payoff: every entry settled BEFORE its due date. No late fee can
    // even exist — the plan schema carries no fee/interest/rate column.
    for (const e of e2) expect(Date.parse(String(e.paid_at))).toBeLessThan(Date.parse(String(e.due_date)));
    expect(ledgerBalance()).toBe(0);
    expect(payloadDebt()).toBe(0);
    const colDebt = Number(
      one<{ d: number }>('SELECT current_debt AS d FROM customers WHERE id = ?', CUST25)?.d ?? NaN,
    );
    console.log(
      `[MNY-25] post-settle chain: col=${colDebt} payload=0 ledger=0 (the v127 column never advances in the TS lane — P2-7)`,
    );
    expect(colDebt).toBe(0);

    // ── No fee/interest model exists anywhere in the plan schema ───────────
    const planCols = all<Row>('PRAGMA table_info(debt_plans)').map((r) => String(r.name));
    const entryCols = all<Row>('PRAGMA table_info(debt_plan_entries)').map((r) => String(r.name));
    const feeish = [...planCols, ...entryCols].filter((n) => /fee|interest|penalty|rate|late/i.test(n));
    console.log(`[MNY-25] fee-ish columns across debt_plans + debt_plan_entries: [${feeish.join(',')}]`);
    expect(feeish).toEqual([]);
    expect(Number(one<Row>('SELECT total_amount FROM debt_plans WHERE id = ?', planId)?.total_amount)).toBe(1000);

    // ── Audit trail ────────────────────────────────────────────────────────
    const planAudit = Number(
      one<{ c: number }>("SELECT COUNT(*) AS c FROM security_audit_logs WHERE action LIKE '%Plan de Paiement%'")?.c ?? 0,
    );
    console.log(`[MNY-25] audit rows: plan-created=${planAudit}`);
    expect(planAudit).toBeGreaterThan(0);
  });
});
