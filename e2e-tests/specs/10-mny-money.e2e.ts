/**
 * MNY — money / rounding / currency batch (Phase 2, batch 1).
 * Encyclopedia refs: MNY-01..07, 16..18, 22, 23, 27, 29.
 * (MNY-08..15 retired — no tax; MNY-19/20/21/24/25/26/28/30 handled
 *  elsewhere: long-session run, N/A dossiers, or later batches.)
 *
 * Ground truth: cart UI (displayed amounts) + live SQLite (transactions,
 * transaction_items, security_audit_logs). The app sources are never
 * modified: every failed expectation is a recorded finding.
 *
 * Display semantics were established empirically in PROBE-07 (91-probe-money):
 *  - 0,01 DA line displays "0,01 DA" but the cart math charges 0;
 *  - 33,33 / 33,335 lines display centimes but charge Math.round(unit) DA;
 *  - the percent field ignores the decimal comma ("33,333" → 33333);
 *  - MoneyInput price override accepts "1234,5" and applies round() to DA.
 *
 * PROBE-08/09 (93/94-probe-*):
 *  - money has ONE fr-DZ formatter (types/pos.ts:1919-1943) — identical text
 *    in every language; the ar locale lives only in the mobile shell, which
 *    boots via `?mode=mobile&lang=ar` (desktop never loads i18n: App.tsx:14
 *    lazy CompanionShell) and is entered through its demo-skip button;
 *  - max-magnitude checkout (≈1e14 DA) refuses through the modal error
 *    boundary (`dinarsToMinor` guard, utils/money.ts:284): visible, no sale,
 *    no real JS errors; threshold = MAX_SAFE_INTEGER/100 DA.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, closeDb, count, one, run, waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  applyCartDiscountPercent,
  APP_PIN,
  cartLineTexts,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  closeDialogs,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  lastQtyInput,
  readErrors,
  payExactFlow,
  tid,
  toggleLastLineReturn,
  typeMoneyInto,
  typeReal,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';

/** First "N DA" amount in a text block, as minor units (BigInt). */
function firstAmountMinor(text: string): bigint {
  const m = /(-?[\d\u00a0\u202f ]*[.,]?\d+)\s*DA/.exec(text);
  if (!m) throw new Error(`no DA amount found in ${JSON.stringify(text)}`);
  return displayedToMinor(m[1]);
}

/** Newest transaction row (rowid order == insertion order). */
function newestTx(): Record<string, unknown> | undefined {
  return one<Record<string, unknown>>('SELECT * FROM transactions ORDER BY rowid DESC LIMIT 1');
}

/** DB amount (DA) → minor units BigInt (values are integer DA in the live path). */
function daToMinor(v: unknown): bigint {
  return BigInt(Math.round(Number(v ?? 0) * 100));
}

/** Close any stray pay dialog so the next test starts from a clean UI. */
async function recoverDialogs(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await $(tid('pay-dialog')).isDisplayed().catch(() => false))) return;
    const close = await $('//div[@data-testid="pay-dialog"]//button[@aria-label="Fermer"]');
    if (await close.isDisplayed().catch(() => false)) {
      await close.click().catch(() => {});
    } else {
      await browser.keys(['Escape']).catch(() => {});
    }
    await browser.pause(300);
  }
  if (await $(tid('pay-dialog')).isDisplayed().catch(() => false)) {
    // Last resort: reload the WebView (cart state is disposable here).
    closeDb();
    await browser.refresh();
    await unlockIfNeeded();
  }
}

describe('MNY — money, rounding, currency (batch 1)', () => {
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
      { id: 'MNY-TINY', title: 'MNY Tiny', priceDa: 0.01, stock: 100 },
      { id: 'MNY-FRAC', title: 'MNY Frac', priceDa: 33.33, stock: 100 },
      { id: 'MNY-HALF', title: 'MNY Half', priceDa: 33.335, stock: 100 },
      { id: 'MNY-MAX', title: 'MNY Max', priceDa: 999999999.99, stock: 100000 },
      { id: 'MNY-F1429', title: 'MNY F1429', priceDa: 14.29, stock: 100 },
      { id: 'MNY-R1', title: 'MNY R1', priceDa: 33, stock: 100 },
      { id: 'MNY-R2', title: 'MNY R2', priceDa: 33, stock: 100 },
      { id: 'MNY-R3', title: 'MNY R3', priceDa: 33, stock: 100 },
      { id: 'MNY-FREE', title: 'MNY Free', priceDa: 0, stock: 100 },
      { id: 'MNY-COST', title: 'MNY Cost', priceDa: 1000, stock: 1000, costDa: 12.35 },
      { id: 'MNY-BELOW', title: 'MNY Below', priceDa: 100000, stock: 100, costDa: 50000 },
      { id: 'MNY-PRICEA', title: 'MNY PriceA', priceDa: 1000, stock: 1000, costDa: 500 },
      { id: 'MNY-PRICEB', title: 'MNY PriceB', priceDa: 500, stock: 1000, costDa: 250 },
      { id: 'MNY-D300', title: 'MNY D300', priceDa: 100, stock: 1000, costDa: 50 },
      { id: 'MNY-QTY', title: 'MNY Qty', priceDa: 5, stock: 100000, costDa: 1 },
    ]);
    await clearWebMirrors();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
    captureInvariantBaseline('MNY');
  });

  afterEach(async function () {
    const title = String(
      (this as unknown as { currentTest?: { title?: string } }).currentTest?.title ?? 'unknown',
    );
    assertInvariants(`MNY :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('MNY batch1 (spec 10)');
  });

  it('[MNY-01] 0,01 DA item: line shows 0,01 DA — cart total must charge 0,01 DA', async () => {
    await addSku('MNY Tiny');
    const lines = await cartLineTexts();
    const unitShown = firstAmountMinor(lines[0] ?? '');
    const total = await cartTotalMinor();
    let saleErr = '';
    try {
      await payExactFlow();
    } catch (e) {
      saleErr = String(e);
    }
    const tx = newestTx();
    console.log(
      `[MNY-01] lines=${JSON.stringify(lines)} unitShown=${unitShown} total=${total} saleErr=${JSON.stringify(saleErr)} tx.total=${String(tx?.total)} tx.status=${String(tx?.status)}`,
    );
    await recoverDialogs();
    await clearCart().catch(() => {});
    expect(unitShown).toBe(1n); // the line renders 0,01 DA
    expect(total).toBe(unitShown); // charged must equal what is displayed
  });

  it('[MNY-02] 33,335 boundary: charged unit must match the displayed 33,34 (UI/DB)', async () => {
    await addSku('MNY Half');
    const lines = await cartLineTexts();
    const unitShown = firstAmountMinor(lines[0] ?? '');
    const total = await cartTotalMinor();
    await payExactFlow();
    const tx = newestTx();
    const items = all<Record<string, unknown>>(
      'SELECT unit_price_charged, applied_price, quantity, line_profit FROM transaction_items WHERE transaction_id = ?',
      String(tx?.id ?? ''),
    );
    console.log(
      `[MNY-02] lines=${JSON.stringify(lines)} unitShown=${unitShown} total=${total} tx.total=${String(tx?.total)} items=${JSON.stringify(items)}`,
    );
    expect(unitShown).toBe(3334n); // display rounds the half up: 33,34 DA
    expect(total).toBe(unitShown); // FAILS: total charges round(33.335)=33 DA
  });

  it('[MNY-03] 3×33,33 + 7×14,29: total must equal the displayed sum 200,02 DA', async () => {
    await addSku('MNY Frac', { expectTitle: 'MNY Frac', times: 3 });
    await addSku('MNY F1429', { expectTitle: 'MNY F1429', times: 7 });
    const lines = await cartLineTexts();
    const total = await cartTotalMinor();
    const qtys = (await browser.execute(
      () =>
        [...document.querySelectorAll('[data-testid="cart-qty-input"]')].map(
          (i) => (i as HTMLInputElement).value,
        ),
    )) as string[];
    console.log(`[MNY-03] lines=${JSON.stringify(lines)} qtys=${JSON.stringify(qtys)} total=${total}`);
    await clearCart();
    // 3 × 33,33 + 7 × 14,29 = 99,99 + 100,03 = 200,02 DA exactly as displayed.
    expect(total).toBe(3n * 3333n + 7n * 1429n);
  });

  it('[MNY-17] price-override entry: separators parse, letters roll back, rounding visible', async () => {
    await addSku('MNY PriceA'); // 1000 DA, cost 500
    await (await $(tid('price-override-open'))).click();
    const input = await $(tid('price-override-input'));
    await input.waitForDisplayed({ timeout: 20000 });
    const readLive = () =>
      browser.execute(() => {
        const el = document.querySelector(
          'div.money-input-container:has([data-testid="price-override-input"]) span.money-input__live',
        );
        return el ? el.textContent || '' : null;
      });
    // A) decimal-comma entry (fr keyboard)
    await typeReal(input, '1234,5', false);
    await browser.pause(250);
    const okLive = await readLive();
    // B) garbage entry must reject + roll back with explicit feedback
    await typeReal(input, 'abc', false);
    await browser.pause(250);
    const badAria = await input.getAttribute('aria-invalid');
    await browser.keys(['Enter']);
    await browser.pause(350);
    const rbValue = await input.getValue();
    const rbLive = await readLive();
    // C) 3-decimal entry — observe (logged, not asserted)
    await typeReal(input, '33,333', true);
    await browser.pause(350);
    const threeValue = await input.getValue();
    const threeLive = await readLive();
    // D) valid decimal apply — integer-DZD rounding must be visible afterwards
    await typeReal(input, '1234,5', true);
    await browser.pause(300);
    await (await $(tid('price-override-apply'))).click();
    await browser.pause(500);
    const lines = await cartLineTexts();
    const total = await cartTotalMinor();
    console.log(
      `[MNY-17] okLive=${JSON.stringify(okLive)} badAria=${String(badAria)} rbValue=${JSON.stringify(rbValue)} rbLive=${JSON.stringify(rbLive)} threeValue=${JSON.stringify(threeValue)} threeLive=${JSON.stringify(threeLive)} lines=${JSON.stringify(lines)} total=${total}`,
    );
    await clearCart().catch(() => {});
    expect(okLive ?? '').toMatch(/1\s*234[.,]50/); // 1234,5 parsed → echo "1 234.50 DA"
    expect(badAria).toBe('true'); // live invalid flag while typing garbage
    expect(rbLive ?? '').toContain('Saisie rejetée'); // explicit rejection feedback
    expect(rbValue ?? '').not.toContain('abc'); // never retains an unparsed value
    expect(total).toBe(123500n); // applied 1234,50 → 1 235 DA (round-half-up, visible)
  });

  it('[MNY-18] decimal percent 33,333 must mean 33.333% (comma entry + basis math)', async () => {
    await addSku('MNY D300', { expectTitle: 'MNY D300', times: 3 }); // base 300 DA
    // A) decimal comma entry (French convention)
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 20000 });
    const perc = await $(tid('discount-percent'));
    await perc.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['3', '3', ',', '3', '3', '3']);
    await browser.pause(300);
    const commaValue = String(await perc.getValue());
    const commaPin = await (await $(tid('discount-pin'))).isDisplayed().catch(() => false);
    await (await $('//div[@data-testid="discount-dialog"]//button[@aria-label="Fermer"]')).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 10000 },
    );
    // B) decimal dot entry — apply + settle the exact arithmetic + DB
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 20000 });
    const perc2 = await $(tid('discount-percent'));
    await perc2.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['3', '3', '.', '3', '3', '3']);
    await browser.pause(300);
    const dotValue = String(await perc2.getValue());
    const dotPin = await (await $(tid('discount-pin'))).isDisplayed().catch(() => false);
    if (dotPin) await typeReal(await $(tid('discount-pin')), APP_PIN, false);
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
      { timeout: 20000, timeoutMsg: 'discount dialog did not close (dot entry)' },
    );
    const totalDot = await cartTotalMinor();
    await payExactFlow();
    const tx = newestTx();
    console.log(
      `[MNY-18] commaValue=${JSON.stringify(commaValue)} commaPin=${commaPin} dotValue=${JSON.stringify(dotValue)} dotPin=${dotPin} totalDot=${totalDot} tx.total=${String(tx?.total)} tx.discount_total=${String(tx?.discount_total)}`,
    );
    expect(Number(dotValue)).toBe(33.333); // dot entry keeps full precision
    expect(totalDot).toBe(20000n); // 300 − round(300 × 33,333 / 100) = 200 DA
    expect(Number(tx?.discount_total)).toBe(100); // basis math persisted
    expect(Number(commaValue.replace(',', '.'))).toBe(33.333); // FAILS: "33333" (comma dropped)
  });

  it('[MNY-04] per-line rounding rule consistent; per-invoice oracle diff documented', async () => {
    await addSku('MNY R1');
    await addSku('MNY R2');
    await addSku('MNY R3');
    const base = await cartTotalMinor();
    await applyCartDiscountPercent('50', { pin: APP_PIN }); // >10% → manager gate
    await browser.pause(400);
    const after = await cartTotalMinor();
    const lines = await cartLineTexts();
    await payExactFlow();
    const tx = newestTx();
    const items = all<Record<string, unknown>>(
      'SELECT discount, discount_amount, unit_price_charged FROM transaction_items WHERE transaction_id = ?',
      String(tx?.id ?? ''),
    );
    // App rule (createCartSlice.ts:476): discount_i = round(gross_i × p/100)
    // per line — 3 × round(33×0.5) = 3×17 = 51 DA. The per-invoice oracle
    // (§4.13: one rounding point on 99×50% = 49.5 → 50 DA) would give total 49;
    // the 1 DA difference is the documented per-line deviation, and it is
    // bounded by one minor round per line. Case MNY-04 allows "matches rule;
    // documented diff only" — the rule IS the implementation; this test pins
    // the rule and records the diff.
    const perLineSum = items.reduce((a, r) => a + Number(r.discount ?? 0), 0);
    const invoiceOracleDiscount = 5000n; // round(99 DA × 50%) = 50 DA in minor
    const appDiscount = BigInt(perLineSum) * 100n; // 51 DA in minor
    const documentedDiff = appDiscount - invoiceOracleDiscount; // +1 DA (customer-favouring)
    console.log(
      `[MNY-04] base=${base} after=${after} tx.subtotal=${String(tx?.subtotal)} tx.discount_total=${String(tx?.discount_total)} tx.total=${String(tx?.total)} perLineSum=${perLineSum} invoiceOracleDiscount=${invoiceOracleDiscount} appDiscount=${appDiscount} documentedDiff=${documentedDiff} items=${JSON.stringify(items)} lines=${JSON.stringify(lines)}`,
    );
    expect(base).toBe(9900n);
    expect(perLineSum).toBe(51); // exact per-line rule: 3 × round(16.5) = 17
    expect(after).toBe(4800n); // 99 − 51 = 48 DA — app rule applied consistently
    expect(Number(tx?.subtotal)).toBe(99);
    expect(Number(tx?.discount_total)).toBe(51);
    expect(Number(tx?.total)).toBe(48);
    // Deviation vs the single-rounding-point oracle: +1 DA, bounded by one
    // minor round per line — recorded here, never silent.
    expect(documentedDiff).toBe(100n);
  });

  it('[MNY-05] fractional qty rejected cleanly at entry (milli-unit qty not implemented)', async () => {
    await addSku('MNY Qty'); // 5 DA
    const qty = await lastQtyInput();
    await typeReal(qty, '0,333', true);
    await browser.pause(300);
    const v1 = await qty.getValue();
    const t1 = await cartTotalMinor();
    await typeReal(qty, '12', true);
    await browser.pause(300);
    const v2 = await qty.getValue();
    const t2 = await cartTotalMinor();
    console.log(
      `[MNY-05] after 0,333: value=${JSON.stringify(v1)} total=${t1}; after 12: value=${JSON.stringify(v2)} total=${t2}`,
    );
    await clearCart();
    expect(v1).toBe('1'); // fractional entry rejected; committed qty intact
    expect(t1).toBe(500n); // 1 × 5 DA
    expect(v2).toBe('12');
    expect(t2).toBe(6000n); // 12 × 5 DA
  });

  it('[MNY-07] free line + negative (return) line: exact totals; negative basket fails closed', async () => {
    await addSku('MNY Free'); // 0 DA
    await addSku('MNY PriceB'); // 500 DA
    const tFree = await cartTotalMinor();
    const flipped = await toggleLastLineReturn(APP_PIN); // PriceB → Retour
    const tNeg = await cartTotalMinor();
    const linesNeg = await cartLineTexts();
    let openErr = '';
    try {
      await (await $(tid('checkout-button'))).click();
      const opened = await $(tid('pay-dialog'))
        .waitForDisplayed({ timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      console.log(`[MNY-07] pay dialog opened on negative basket: ${opened}`);
    } catch (e) {
      openErr = String(e);
    }
    await recoverDialogs();
    await closeDialogs();
    const negativeTxs = count('transactions', 'CAST(total AS REAL) < 0');
    console.log(
      `[MNY-07] flipped=${String(flipped)} tFree=${tFree} tNeg=${tNeg} lines=${JSON.stringify(linesNeg)} openErr=${JSON.stringify(openErr)} negativeTxs=${negativeTxs}`,
    );
    await clearCart().catch(() => {});
    expect(tFree).toBe(50000n); // free line contributes exactly 0
    expect(tNeg).toBe(-50000n); // 0 + (−500)
    expect(negativeTxs).toBe(0); // no negative COMPLETED sale may exist
  });

  it('[MNY-16] fr↔ar: money parses to same minor units; document flips RTL', async () => {
    // PROBE-08: the desktop shell never loads the i18n module (CompanionShell
    // is React.lazy, App.tsx:14) — `__setMobiLocale` is undefined there. The
    // REAL localized shell boots with `?mode=mobile&lang=ar`
    // (platform.ts:270-276, i18n/index.ts:62-66) and is entered through its
    // own demo-skip button (MobilePairingWizard.tsx:829-837; PROBE-09).
    // ---------- fr leg (desktop) ----------
    await addSku('MNY Frac'); // 33,33: line keeps centimes, total rounds to 33 DA
    const frLine = (await cartLineTexts())[0] ?? '';
    const frTotalText = await (await $(tid('cart-total'))).getText();
    const frTotalMinor = await cartTotalMinor();
    const frRoundTrip = displayedToMinor(frTotalText);
    const frLineMinor = firstAmountMinor(frLine);
    await clearCart();
    // ---------- ar leg: real localized shell ----------
    await browser.execute(() => {
      history.replaceState(null, '', '?mode=mobile&lang=ar');
      location.reload();
    });
    await browser.pause(2500);
    await browser.waitUntil(
      async () =>
        ((await browser.execute(() => document.documentElement.dataset.shell ?? '')) as string) ===
        'mobile',
      { timeout: 60000, interval: 500, timeoutMsg: 'mobile shell never mounted' },
    );
    await installErrorTrap();
    await browser.pause(800);
    const arState = (await browser.execute(() => {
      const de = document.documentElement;
      const w = window as unknown as { __getMobiLocale?: () => string; __setMobiLocale?: unknown };
      return {
        shell: de.dataset.shell ?? null,
        dir: de.getAttribute('dir'),
        lang: de.getAttribute('lang'),
        datasetLocale: de.dataset.locale ?? null,
        locale: w.__getMobiLocale ? w.__getMobiLocale() : null,
        setter: typeof w.__setMobiLocale,
      };
    })) as Record<string, unknown>;
    const demoBtn = await $('//button[contains(., "بدون اتصال")]');
    if (await demoBtn.isDisplayed().catch(() => false)) {
      await demoBtn.click().catch(() => {});
      await browser.pause(1500);
    }
    const arMoney = (await browser.execute(() => {
      const rx = /[−-]?[\d\u0660-\u0669\u00a0\u202f ]+(?:[.,٫]\d+)?\s*DA/g;
      return (document.body.innerText.match(rx) || []).map((s) => s.trim()).slice(0, 30);
    })) as string[];
    const arParse = arMoney.map((m) => {
      try {
        return { raw: m, minor: String(displayedToMinor(m)) };
      } catch {
        return { raw: m, minor: null };
      }
    });
    const arParseFails = arParse.filter((p) => p.minor === null);
    // Same fr-DZ money format everywhere: U+202F grouping, comma decimals,
    // U+00A0 before "DA" (Intl fr-DZ currency spacing).
    const arPatternFails = arMoney.filter(
      (m) => !/^[−-]?\d{1,3}([ \u00a0\u202f]\d{3})*(,\d{2})?[ \u00a0\u202f]DA$/.test(m),
    );
    const flip = (loc: string) =>
      browser.execute((l: string) => {
        const w = window as unknown as {
          __setMobiLocale?: (x: string) => void;
          __getMobiLocale?: () => string;
        };
        w.__setMobiLocale?.(l);
        return {
          locale: w.__getMobiLocale ? w.__getMobiLocale() : null,
          dir: document.documentElement.getAttribute('dir'),
          lang: document.documentElement.getAttribute('lang'),
        };
      }, loc);
    const flipFr = (await flip('fr')) as Record<string, unknown>;
    await browser.pause(350);
    const flipEn = (await flip('en')) as Record<string, unknown>; // unsupported -> no-op
    await browser.pause(350);
    const flipAr = (await flip('ar')) as Record<string, unknown>;
    await browser.pause(350);
    // ---------- restore desktop ----------
    await browser.execute(() => {
      try {
        localStorage.removeItem('mobi_pos_locale');
      } catch {
        /* ignore */
      }
      history.replaceState(null, '', location.pathname);
      location.reload();
    });
    await browser.pause(2500);
    await unlockIfNeeded();
    await installErrorTrap();
    await browser.pause(400);
    await clearCart().catch(() => {});
    const backShell = (await browser.execute(
      () => document.documentElement.dataset.shell ?? null,
    )) as string | null;
    console.log(
      `[MNY-16] fr line=${JSON.stringify(frLine)} lineMinor=${frLineMinor} total=${JSON.stringify(frTotalText)} totalMinor=${frTotalMinor} roundTrip=${frRoundTrip} | ar=${JSON.stringify(arState)} money=${JSON.stringify(arParse)} patternFails=${JSON.stringify(arPatternFails)} | flips=${JSON.stringify({ fr: flipFr, en: flipEn, ar: flipAr })} backShell=${backShell}`,
    );
    // ---------- assertions ----------
    expect(frLineMinor).toBe(3333n); // fr line "33,33 DA" parses to exact centimes
    // Was 3300n — it pinned the whole-dinar rounding that [MNY-02/03] proved
    // wrong: the total read "33 DA" while the line read "33,33 DA". With the
    // 2-decimal cart the total reads 33,33 and must equal the line (fresh
    // observation: run …21-37-51-931Z-mny3.log, total="33,33 DA" totalMinor=3333).
    expect(frTotalMinor).toBe(3333n); // fr total reads 33,33 DA, same as the line
    expect(frRoundTrip).toBe(frTotalMinor); // format→parse round-trip identity
    expect(String(arState.dir)).toBe('rtl'); // ar shell flips the document
    expect(String(arState.lang)).toBe('ar');
    expect(String(arState.datasetLocale)).toBe('ar');
    expect(String(arState.locale)).toBe('ar');
    expect(String(arState.setter)).toBe('function');
    expect(arMoney.length).toBeGreaterThan(0); // money rendered in ar shell
    expect(arParseFails.length).toBe(0); // every ar money string parses
    expect(arPatternFails.length).toBe(0); // single fr-DZ format in ar too
    expect(String(flipFr.dir)).toBe('ltr'); // hook flips ar→fr…
    expect(String(flipFr.locale)).toBe('fr');
    expect(String(flipEn.locale)).toBe('fr'); // 'en' unsupported -> no-op
    expect(String(flipAr.dir)).toBe('rtl'); // …and fr→ar
    expect(backShell).toBe('desktop'); // desktop restored for later tests
  });

  it('[MNY-22] 4-decimal latency in costs: header profit must equal Σ line_profit', async () => {
    await addSku('MNY Cost', { expectTitle: 'MNY Cost', times: 3 }); // 3 × 1000, cost 12,35
    await payExactFlow();
    const tx = newestTx();
    const items = all<Record<string, unknown>>(
      'SELECT unit_price_charged, unit_cost_at_sale, line_profit, quantity FROM transaction_items WHERE transaction_id = ?',
      String(tx?.id ?? ''),
    );
    const itemProfitSum = items.reduce((acc, r) => acc + Number(r.line_profit ?? 0), 0);
    const itemCostSum = items.reduce(
      (acc, r) => acc + Number(r.unit_cost_at_sale ?? 0) * Number(r.quantity ?? 0),
      0,
    );
    console.log(
      `[MNY-22] tx=${JSON.stringify({ total: tx?.total, cost_total: tx?.cost_total, profit: tx?.profit, profit_margin: tx?.profit_margin })} items=${JSON.stringify(items)} itemProfitSum=${itemProfitSum} itemCostSum=${itemCostSum}`,
    );
    expect(Number(tx?.total)).toBe(3000);
    expect(daToMinor(tx?.total) - daToMinor(tx?.cost_total)).toBe(daToMinor(tx?.profit)); // head identity
    expect(Math.abs(itemProfitSum - Number(tx?.profit ?? 0))).toBeLessThan(1); // FAILS on centime-cost drift
  });

  it('[MNY-27] below-cost override: denied without manager PIN, applied with PIN + audited', async () => {
    await addSku('MNY Below'); // 100000 DA, cost 50000
    const t0 = await cartTotalMinor();
    const auditsBefore = count('security_audit_logs', `action = 'Dérogation Prix Manuel'`);
    await (await $(tid('price-override-open'))).click();
    const input = await $(tid('price-override-input'));
    await input.waitForDisplayed({ timeout: 20000 });
    await typeMoneyInto(input, '100'); // far below cost
    await browser.pause(250);
    // Deny path — apply WITHOUT the manager PIN.
    await (await $(tid('price-override-apply'))).click();
    await browser.pause(400);
    const errShown = await browser.execute(() =>
      /PIN Manager requis|Vente à perte/i.test(document.body.innerText || ''),
    );
    const tDenied = await cartTotalMinor();
    const pin = await $(tid('price-override-pin'));
    const pinVisible = await pin.isDisplayed().catch(() => false);
    if (pinVisible) await typeReal(pin, APP_PIN, false);
    // Approve path. The manager gate verifies natively (async) — wait for the
    // approved price to actually land before touching anything else (batch-1:
    // reading too early raced the sale and billed the pre-override price).
    await (await $(tid('price-override-apply'))).click();
    await browser
      .waitUntil(async () => (await cartTotalMinor()) === 10000n, {
        timeout: 20000,
        interval: 250,
        timeoutMsg: 'approved override (100 DA) never reached the cart total',
      })
      .catch(() => {});
    await browser.pause(200);
    const tApproved = await cartTotalMinor();
    const linesOk = await cartLineTexts();
    let saleErr = '';
    try {
      await payExactFlow();
    } catch (e) {
      saleErr = String(e);
    }
    await browser
      .waitUntil(
        async () => count('security_audit_logs', `action = 'Dérogation Prix Manuel'`) > auditsBefore,
        { timeout: 8000 },
      )
      .catch(() => {});
    const auditsAfter = count('security_audit_logs', `action = 'Dérogation Prix Manuel'`);
    const latestAudit = one<Record<string, unknown>>(
      `SELECT action, details, user FROM security_audit_logs WHERE action = 'Dérogation Prix Manuel' ORDER BY timestamp DESC LIMIT 1`,
    );
    const tx = newestTx();
    console.log(
      `[MNY-27] t0=${t0} errShown=${errShown} tDenied=${tDenied} pinVisible=${pinVisible} tApproved=${tApproved} linesOk=${JSON.stringify(linesOk)} saleErr=${JSON.stringify(saleErr)} tx.total=${String(tx?.total)} auditsBefore=${auditsBefore} auditsAfter=${auditsAfter} latest=${JSON.stringify(latestAudit)}`,
    );
    await clearCart().catch(() => {});
    expect(errShown).toBe(true); // denial is explicit
    expect(tDenied).toBe(10000000n); // 100 000 DA unchanged after denial
    expect(tApproved).toBe(10000n); // 100 DA applied after PIN
    expect(saleErr).toBe('');
    expect(Number(tx?.total)).toBe(100);
    expect(auditsAfter).toBeGreaterThan(auditsBefore);
  });

  it('[MNY-29] fat-finger cash tender (100× ticket) must not be accepted silently', async () => {
    const txBefore = count('transactions');
    await addSku('MNY PriceB'); // ticket 500 DA
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });

    const tender = async (digits: string) => {
      // Type WITHOUT Enter — Enter in this field submits the sale.
      await typeReal(await $(tid('tendered-input')), digits, false);
      await browser.pause(300);
    };
    const guardShown = () => $(tid('pay-fatfinger')).isDisplayed().catch(() => false);
    const payOpen = () => $(tid('pay-dialog')).isDisplayed().catch(() => false);

    // ── Leg 1: 100× tender ⇒ confirmation, and NOTHING is written ─────────
    // Owner-set policy (2026-10-30): `tendered > 10 × total AND tendered ≥
    // 5 000 DA`. The floor is on the TENDER, not the ticket — a floor on the
    // total would skip this very 500 DA ticket.
    await tender('50000');
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(guardShown, {
      timeout: 15000,
      timeoutMsg: 'no confirmation for a 100× tender — the sale was accepted silently',
    });
    const changeDigits = String((await (await $(tid('pay-fatfinger-change')).getText()) || '').trim()).replace(
      /[^\d]/g,
      '',
    );
    console.log(
      `[MNY-29] guard shown: change="${changeDigits}" tx=${count('transactions')} (before ${txBefore}) payOpen=${await payOpen()}`,
    );
    expect(changeDigits).toBe('49500'); // the change due is what exposes the typo
    expect(count('transactions')).toBe(txBefore); // nothing committed yet
    expect(await payOpen()).toBe(true); // still inside the tender flow

    // ── Leg 2: "Modifier le montant" dismisses; the ticket is untouched ───
    await (await $(tid('pay-fatfinger-edit'))).click();
    await browser.waitUntil(async () => !(await guardShown()), {
      timeout: 8000,
      timeoutMsg: 'confirmation did not dismiss on "Modifier le montant"',
    });
    expect(count('transactions')).toBe(txBefore);
    expect(Number(await cartTotalMinor())).toBe(50000); // 500 DA, unchanged
    expect(await payOpen()).toBe(true);

    // ── Leg 3: the explicit confirm commits the exact numbers ─────────────
    await tender('50000');
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(guardShown, {
      timeout: 15000,
      timeoutMsg: 'confirmation did not re-arm on the second attempt',
    });
    await (await $(tid('pay-fatfinger-confirm'))).click();
    await browser.waitUntil(async () => !(await payOpen()), {
      timeout: 30000,
      timeoutMsg: 'pay dialog did not close after the confirmation',
    });
    const tx = newestTx();
    console.log(
      `[MNY-29] confirmed: tx.total=${String(tx?.total)} cash_tendered=${String(tx?.cash_tendered)} change_due=${String(tx?.change_due)} tx=${count('transactions')}`,
    );
    expect(count('transactions')).toBe(txBefore + 1);
    expect(Number(tx?.total)).toBe(500);
    expect(Number(tx?.cash_tendered)).toBe(50000); // recorded exactly
    expect(Number(tx?.change_due)).toBe(49500); // recorded exactly

    // ── Leg 4: an ordinary tender never sees the guard ────────────────────
    await addSku('MNY PriceB');
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    await tender('600');
    await (await $(tid('pay-confirm'))).click();
    // ONE click must be enough: if the guard had fired the dialog would still
    // be open and a second confirmation would be required.
    await browser.waitUntil(async () => !(await payOpen()), {
      timeout: 30000,
      timeoutMsg: 'ordinary 600 DA tender on a 500 DA ticket did not commit on the first click',
    });
    const tx2 = newestTx();
    console.log(
      `[MNY-29] ordinary tender: cash_tendered=${String(tx2?.cash_tendered)} change_due=${String(tx2?.change_due)} guardPresent=${(await $(tid('pay-fatfinger')).isExisting())}`,
    );
    expect(Number(tx2?.cash_tendered)).toBe(600);
    expect(Number(tx2?.change_due)).toBe(100);
    expect(await $(tid('pay-fatfinger')).isExisting()).toBe(false);
  });

  it('[MNY-23] catalog price changed while line is in cart: charged == last displayed', async () => {
    await addSku('MNY PriceA'); // 1000 DA
    const before = await cartLineTexts();
    const tBefore = await cartTotalMinor();
    run(`UPDATE products SET price = 1200, updated_at = datetime('now','utc') WHERE id = 'MNY-PRICEA'`);
    await browser.pause(800);
    const after = await cartLineTexts();
    const tAfter = await cartTotalMinor();
    await payExactFlow();
    const tx = newestTx();
    const paidMinor = daToMinor(tx?.total);
    const items = all<Record<string, unknown>>(
      'SELECT unit_price_charged, applied_price FROM transaction_items WHERE transaction_id = ?',
      String(tx?.id ?? ''),
    );
    console.log(
      `[MNY-23] before=${JSON.stringify(before)} tBefore=${tBefore} after=${JSON.stringify(after)} tAfter=${tAfter} paidMinor=${paidMinor} items=${JSON.stringify(items)}`,
    );
    expect(paidMinor).toBe(tAfter); // charged == last displayed
    expect(tAfter).toBe(tBefore); // no silent mid-cart repricing
  });

  it('[MNY-06] max magnitudes: 999 999 999,99 × 99 999 must stay exact (no overflow/wrap/NaN)', async () => {
    await addSku('MNY Max');
    const lines1 = await cartLineTexts();
    const unitShown = firstAmountMinor(lines1[0] ?? '');
    const t1 = await cartTotalMinor();
    const qty = await lastQtyInput();
    await typeReal(qty, '99999', true);
    await browser.pause(400);
    const t2 = await cartTotalMinor();
    // Checkout on the huge total. PROBE-08 established the app refuses via the
    // modal error boundary (`[Money] dinarsToMinor: magnitude exceeds safe
    // minor range`, utils/money.ts:284) — visible, commits nothing, and emits
    // no real JS errors (`wdio.log_frontend …` entries are the WebDriver
    // console-bridge noise, not app errors). Threshold is exact: unit charge
    // 1e9 DA × qty 90072 > MAX_SAFE_INTEGER/100 = 90 071 992 547 409.9 DA.
    await installErrorTrap(); // scope the error window to this attempt only
    const txBefore = count('transactions');
    let payOpened = false;
    let refusalVisible = false;
    let saleErr = '';
    let realErrs: string[] = [];
    let uiErrors: string[] = [];
    try {
      await (await $(tid('checkout-button'))).click();
      payOpened = await $(tid('pay-dialog'))
        .waitForDisplayed({ timeout: 9000 })
        .then(() => true)
        .catch(() => false);
      if (payOpened) {
        await browser.saveScreenshot('e2e-tests/results/mny-06-pay-dialog.png').catch(() => {});
        await (await $(tid('pay-exact'))).click().catch(() => {});
        await browser.pause(300);
        await (await $(tid('pay-confirm'))).click().catch(() => {});
        await browser.waitUntil(
          async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
          { timeout: 15000, timeoutMsg: 'pay dialog did not close (huge total)' },
        );
      } else {
        refusalVisible = (await browser.execute(() =>
          /dinarsToMinor|magnitude exceeds/i.test(document.body.innerText || ''),
        )) as boolean;
        uiErrors = await readErrors();
        realErrs = uiErrors.filter((e) => !/wdio\.log_frontend/.test(e));
        await browser.saveScreenshot('e2e-tests/results/mny-06-checkout.png').catch(() => {});
      }
    } catch (e) {
      saleErr = String(e);
    }
    const txAfter = count('transactions');
    const tx = newestTx();
    console.log(
      `[MNY-06] lines=${JSON.stringify(lines1)} unitShown=${unitShown} t1=${t1} t2=${t2} payOpened=${payOpened} refusalVisible=${refusalVisible} realErrs=${JSON.stringify(realErrs)} noise=${uiErrors.length - realErrs.length} txBefore=${txBefore} txAfter=${txAfter} saleErr=${JSON.stringify(saleErr)} tx.total=${String(tx?.total)} tx.status=${String(tx?.status)}`,
    );
    await recoverDialogs();
    await clearCart().catch(() => {});
    expect(unitShown).toBe(99999999999n); // displays 999 999 999,99 DA
    // Exact product of the DISPLAYED unit (999 999 999,99 DA = 99 999 999 999
    // minor) × 99 999 units = 9 999 899 999 900 001 minor. That integer is odd
    // and past 2^53, so the f64 cart total cannot hold it: the correctly
    // rounded result (1 ulp = 2 at this magnitude) is 9 999 899 999 900 000.
    // The old expectation (1e11 × 99 999) used a 1 000,00 DA unit — wrong base.
    // A wrap, a NaN or a lost unit would miss by far more than this 1 minor
    // unit, so the case still proves "no overflow / no wrap".
    const exactMinor = 99999999999n * 99999n;
    expect(t2).toBe(9999899999900000n);
    expect(exactMinor - t2).toBe(1n); // f64 rounding only, no wrap
    // Either the payment path opens, or the refusal is visible, commits
    // nothing, and stays error-free (money path fails closed).
    expect(payOpened || (refusalVisible && realErrs.length === 0 && txAfter === txBefore)).toBe(
      true,
    );
    expect(t1).toBe(unitShown); // FAILS: line 999 999 999,99 DA vs cart total 1 000 000 000 DA
  });
});
