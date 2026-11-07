/**
 * PROBE-08 — settles the two open questions from MNY batch 1 (diagnostic spec;
 * NOT encyclopedia coverage: [PROBE-08*] titles are excluded from counting).
 *
 *  a) MNY-16: is `window.__setMobiLocale` even exposed in the DESKTOP shell?
 *     `src/App.tsx:14` lazy-loads CompanionShell, so the i18n module — which
 *     defines the hook and syncs `<html dir/lang>` at `src/i18n/index.ts:94-102`
 *     and `:158` — may never evaluate on desktop boot (batch-1: dir stayed "").
 *     Then boot the REAL localized shell with the supported boot params
 *     `?mode=mobile&lang=ar` (`src/utils/platform.ts:270-276`,
 *     `src/i18n/index.ts:62-66`) and observe dir/lang/dataset/locale + money
 *     text inside the mobile shell, plus hook flips ar↔fr.
 *
 *  b) MNY-06: at 999 999 999,99 × 99 999 (~1e14 DA) the pay dialog never
 *     opened. The run-2 screenshot shows the modal error boundary with
 *     `[Money] dinarsToMinor: magnitude exceeds safe minor range`
 *     (`src/utils/money.ts:282-286`). Characterize: qty-1 sale (display vs DB),
 *     qty-99 999 refusal (visible message? toasts? real JS errors? sale
 *     created?), retry behavior, and the open/refuse threshold.
 */
import fs from 'node:fs';
import { browser, $ } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, waitForSchemaSettled } from '../lib/db';
import {
  clickControl,
  addSku,
  cartLineTexts,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  ensureShiftOpen,
  installErrorTrap,
  lastQtyInput,
  payExactFlow,
  readErrors,
  tid,
  typeReal,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

/** The [Money] guard threshold: MAX_SAFE_INTEGER / 100 ≈ 9.0072e13 DA. */
const SAFE_LIMIT_DA = Number.MAX_SAFE_INTEGER / 100;

describe('PROBE-08 max-magnitude + locale', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    await resetData();
    seedProducts([
      { id: 'P8-MAX', title: 'P8 Max', priceDa: 999999999.99, stock: 200000 },
      { id: 'P8-FRAC', title: 'P8 Frac', priceDa: 33.33, stock: 100 },
    ]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
  });

  it('[PROBE-08a] locale hook + dir audit: desktop vs ?mode=mobile&lang=ar', async () => {
    const dump = () =>
      browser.execute(() => {
        const de = document.documentElement;
        const w = window as unknown as {
          __setMobiLocale?: unknown;
          __getMobiLocale?: () => string;
        };
        const money = ((document.body.innerText || '').match(/[\d\u00a0\u202f ]+[.,]?\d*\s*DA/g) || []).slice(0, 8);
        return {
          shell: de.dataset.shell ?? null,
          dir: de.getAttribute('dir'),
          dirProp: de.dir,
          lang: de.getAttribute('lang'),
          datasetLocale: de.dataset.locale ?? null,
          computedDir: getComputedStyle(de).direction,
          setter: typeof w.__setMobiLocale,
          getter: typeof w.__getMobiLocale,
          locale: w.__getMobiLocale ? w.__getMobiLocale() : null,
          stored: localStorage.getItem('mobi_pos_locale'),
          href: location.href.slice(0, 140),
          money,
        };
      });

    console.log(`[probe8a] desktop baseline: ${JSON.stringify(await dump())}`);
    const callRes = await browser.execute(() => {
      const w = window as unknown as {
        __setMobiLocale?: (l: string) => void;
        __getMobiLocale?: () => string;
      };
      if (typeof w.__setMobiLocale !== 'function') return { called: false, reason: 'hook undefined' };
      w.__setMobiLocale('ar');
      return {
        called: true,
        locale: w.__getMobiLocale ? w.__getMobiLocale() : null,
        dir: document.documentElement.getAttribute('dir'),
      };
    });
    console.log(`[probe8a] desktop __setMobiLocale('ar'): ${JSON.stringify(callRes)}`);
    await browser.pause(400);
    console.log(`[probe8a] desktop after call: ${JSON.stringify(await dump())}`);

    // ---- boot the REAL localized shell: ?mode=mobile&lang=ar ----
    await browser.execute(() => {
      history.replaceState(null, '', '?mode=mobile&lang=ar');
      location.reload();
    });
    await browser.pause(2500);
    await unlockIfNeeded().catch((e) => console.log(`[probe8a] mobile unlock note: ${String(e)}`));
    await browser
      .waitUntil(
        async () =>
          ((await browser.execute(
            () => document.documentElement.dataset.shell ?? '',
          )) as string) === 'mobile',
        { timeout: 60000, interval: 500, timeoutMsg: 'mobile shell never mounted' },
      )
      .catch((e) => console.log(`[probe8a] ${String(e)}`));
    await installErrorTrap();
    await browser.pause(800);
    console.log(`[probe8a] mobile boot (?mode=mobile&lang=ar): ${JSON.stringify(await dump())}`);
    const testids = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid]'))
        .map((e) => e.getAttribute('data-testid'))
        .filter((v, i, a) => !!v && a.indexOf(v) === i)
        .slice(0, 40),
    );
    console.log(`[probe8a] mobile testids: ${JSON.stringify(testids)}`);
    const body = await browser.execute(() =>
      (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    );
    console.log(`[probe8a] mobile body: ${JSON.stringify(body)}`);

    const flip = (loc: string) =>
      browser.execute((l: string) => {
        const w = window as unknown as {
          __setMobiLocale?: (x: string) => void;
          __getMobiLocale?: () => string;
        };
        if (typeof w.__setMobiLocale !== 'function') return { called: false };
        w.__setMobiLocale(l);
        return {
          called: true,
          locale: w.__getMobiLocale ? w.__getMobiLocale() : null,
          dir: document.documentElement.getAttribute('dir'),
          lang: document.documentElement.getAttribute('lang'),
          datasetLocale: document.documentElement.dataset.locale ?? null,
        };
      }, loc);
    console.log(`[probe8a] mobile flip ar→fr: ${JSON.stringify(await flip('fr'))}`);
    await browser.pause(300);
    console.log(`[probe8a] mobile flip fr→ar: ${JSON.stringify(await flip('ar'))}`);
    await browser.pause(300);

    // ---- restore desktop shell ----
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
    await unlockIfNeeded().catch((e) => console.log(`[probe8a] desktop re-unlock note: ${String(e)}`));
    await installErrorTrap();
    await browser.pause(600);
    console.log(`[probe8a] back on desktop: ${JSON.stringify(await dump())}`);
  });

  it('[PROBE-08b] qty-1 max-unit sale (display vs DB), then qty 99 999 refusal characterization', async () => {
    await clearCart().catch(() => {});
    // ---- qty-1: display total vs the committed DB row ----
    await addSku('P8 Max', { expectTitle: 'P8 Max' });
    const t1 = await cartTotalMinor();
    const lines1 = await cartLineTexts();
    const txBefore1 = count('transactions');
    let saleErr = '';
    try {
      await payExactFlow();
    } catch (e) {
      saleErr = String(e);
    }
    const tx = one<Record<string, unknown>>(
      'SELECT id, total, status, cash_tendered, change_due FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    const items = all<Record<string, unknown>>(
      'SELECT unit_price_charged, applied_price, quantity FROM transaction_items WHERE transaction_id = ?',
      String(tx?.id ?? ''),
    );
    console.log(
      `[probe8b] qty1: lines=${JSON.stringify(lines1)} t1Display=${t1} txBefore=${txBefore1} saleErr=${JSON.stringify(saleErr)} tx=${JSON.stringify(tx)} items=${JSON.stringify(items)}`,
    );

    // ---- qty 99 999: refusal characterization ----
    await clearCart().catch(() => {});
    await addSku('P8 Max', { expectTitle: 'P8 Max' });
    const qty = await lastQtyInput();
    await typeReal(qty, '99999', true);
    await browser.pause(500);
    const t2 = await cartTotalMinor();
    const lines2 = await cartLineTexts();
    const errsBefore = (await readErrors()).filter((e) => !/wdio\.log_frontend/.test(e));
    const txBefore2 = count('transactions');
    await clickControl('checkout-button');
    let payOpen = false;
    let refused = false;
    await browser
      .waitUntil(
        async () => {
          payOpen = await $(tid('pay-dialog'))
            .isDisplayed()
            .catch(() => false);
          refused = (await browser.execute(() =>
            /dinarsToMinor|magnitude exceeds/i.test(document.body.innerText || ''),
          )) as boolean;
          return payOpen || refused;
        },
        { timeout: 20000, interval: 250 },
      )
      .catch(() => {});
    const errsAfterAll = await readErrors();
    const errsAfter = errsAfterAll.filter((e) => !/wdio\.log_frontend/.test(e));
    const noise = errsAfterAll.length - errsAfter.length;
    const dump = (await browser.execute(() => {
      const body = document.body.innerText || '';
      const lines = body
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const interesting = lines
        .filter((s) => /erreur|error|invalide|impossible|dépasse|trop|limite|magnitude|dinarsToMinor/i.test(s))
        .slice(0, 12);
      const toasts = Array.from(
        document.querySelectorAll('[role="alert"], [data-testid*="toast"], [class*="toast"]'),
      )
        .filter((el) => {
          const h = el as HTMLElement;
          return h.offsetWidth > 0 || h.offsetHeight > 0 || h.getClientRects().length > 0;
        })
        .map((el) => (el.textContent || '').trim().slice(0, 160))
        .filter(Boolean)
        .slice(0, 10);
      return {
        interesting,
        toasts,
        boundary: /Erreur d[’']Affichage du Modal/i.test(body),
        bodyHead: body.replace(/\s+/g, ' ').slice(0, 320),
        dir: document.documentElement.getAttribute('dir'),
      };
    })) as Record<string, unknown>;
    const txAfter2 = count('transactions');
    await browser.saveScreenshot('e2e-tests/results/probe8b-refusal.png').catch(() => {});
    console.log(
      `[probe8b] qty99999: lines=${JSON.stringify(lines2)} t2Display=${t2} payOpen=${payOpen} refused=${refused} noise=${noise} errs=${JSON.stringify(errsAfter.slice(0, 6))} txBefore=${txBefore2} txAfter=${txAfter2} dump=${JSON.stringify(dump)}`,
    );

    // ---- retry button behavior ----
    let afterRetry = 'n/a';
    if (!payOpen) {
      const retry = await $('//button[contains(., "Réessayer")]');
      if (await retry.isDisplayed().catch(() => false)) {
        await retry.click().catch(() => {});
        await browser.pause(1500);
        const again = (await browser.execute(() =>
          /dinarsToMinor|magnitude exceeds/i.test(document.body.innerText || ''),
        )) as boolean;
        const openNow = await $(tid('pay-dialog'))
          .isDisplayed()
          .catch(() => false);
        afterRetry = `boundaryAgain=${again} payOpenNow=${openNow}`;
      }
    }
    console.log(`[probe8b] retry: ${afterRetry}`);

    // ---- clean recovery (the modal boundary offers "Recharger l'App") ----
    const reloadBtn = await $('//button[contains(., "Recharger l\'App")]');
    if (await reloadBtn.isDisplayed().catch(() => false)) {
      await reloadBtn.click().catch(() => {});
      await browser.pause(2500);
      await unlockIfNeeded().catch(() => {});
      await installErrorTrap();
    } else if (payOpen) {
      const close = await $('//div[@data-testid="pay-dialog"]//button[@aria-label="Fermer"]');
      await close.click().catch(() => {});
      await browser.pause(300);
    }
    await clearCart().catch(() => {});
  });

  it('[PROBE-08c] checkout open/refuse threshold sweep around MAX_SAFE_INTEGER/100', async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const q of [1000, 90071, 90072, 90073]) {
      await clearCart().catch(() => {});
      await addSku('P8 Max', { expectTitle: 'P8 Max' });
      const qty = await lastQtyInput();
      await typeReal(qty, String(q), true);
      await browser.pause(400);
      const tDisp = await cartTotalMinor();
      await clickControl('checkout-button');
      let payOpen = false;
      let refused = false;
      await browser
        .waitUntil(
          async () => {
            payOpen = await $(tid('pay-dialog'))
              .isDisplayed()
              .catch(() => false);
            refused = (await browser.execute(() =>
              /dinarsToMinor|magnitude exceeds/i.test(document.body.innerText || ''),
            )) as boolean;
            return payOpen || refused;
          },
          { timeout: 15000, interval: 250 },
        )
        .catch(() => {});
      const expectedProduct = 1000000000n * BigInt(q);
      results.push({ q, tDisp: String(tDisp), expectedProduct: String(expectedProduct), payOpen, refused });
      console.log(
        `[probe8c] qty=${q} tDisp=${tDisp} expected=${expectedProduct} payOpen=${payOpen} refused=${refused} limitDA=${SAFE_LIMIT_DA}`,
      );
      if (payOpen) {
        const close = await $('//div[@data-testid="pay-dialog"]//button[@aria-label="Fermer"]');
        await close.click().catch(() => {});
        await browser.pause(300);
      } else if (refused) {
        const reloadBtn = await $('//button[contains(., "Recharger l\'App")]');
        if (await reloadBtn.isDisplayed().catch(() => false)) {
          await reloadBtn.click().catch(() => {});
          await browser.pause(2500);
          await unlockIfNeeded().catch(() => {});
          await installErrorTrap();
        }
      }
    }
    console.log(`[probe8c] sweep results: ${JSON.stringify(results)}`);
    await clearCart().catch(() => {});
  });
});
