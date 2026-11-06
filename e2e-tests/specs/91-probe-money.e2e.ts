/**
 * PROBE-07 — money display semantics discovery (NOT an encyclopedia case).
 * Gathers, against the real app:
 *   a) tile / cart-line / cart-total rendering for fractional prices
 *      (0.01, 33.33, 33.335, 999999999.99);
 *   b) cart-qty fractional entry settle behavior;
 *   c) discount-modal percent decimals + manager-PIN gate visibility;
 *   d) price-override MoneyInput echo / aria-invalid / reject-rollback flow.
 * Results feed the precise assertions of the MNY batch (spec 10).
 */
import fs from 'node:fs';
import { browser } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { count, waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  cartLineTexts,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  ensureShiftOpen,
  findTile,
  installErrorTrap,
  lastQtyInput,
  setSearchText,
  tid,
  typeReal,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

const P = {
  tiny: 'Probe7 Tiny',
  round: 'Probe7 Round',
  half: 'Probe7 Half',
  max: 'Probe7 Max',
  qty: 'Probe7 Qty',
};

describe('PROBE-07 money semantics', () => {
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
      { id: 'P7-TINY', title: P.tiny, priceDa: 0.01, stock: 100 },
      { id: 'P7-ROUND', title: P.round, priceDa: 33.33, stock: 100 },
      { id: 'P7-HALF', title: P.half, priceDa: 33.335, stock: 100 },
      { id: 'P7-MAX', title: P.max, priceDa: 999999999.99, stock: 100 },
      { id: 'P7-QTY', title: P.qty, priceDa: 5, stock: 1000 },
    ]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
  });

  it('[PROBE-07a] tile/line/total rendering for fractional prices', async () => {
    for (const token of [P.tiny, P.round, P.half, P.max]) {
      await setSearchText(token);
      const tile = await findTile(token);
      console.log(`[probe7] tile "${token}": ${JSON.stringify(await tile.getText())}`);
      await tile.click();
      await browser.pause(300);
      console.log(
        `[probe7] after add "${token}": lines=${JSON.stringify(await cartLineTexts())} total=${await cartTotalMinor()}`,
      );
      await clearCart().catch((e) => console.log(`[probe7] clearCart failed: ${String(e)}`));
      await setSearchText('', false);
    }
    console.log(`[probe7] tx rows so far: ${count('transactions')}`);
  });

  it('[PROBE-07b] qty fractional entry settle', async () => {
    await addSku(P.qty, { expectTitle: P.qty });
    const qty = await lastQtyInput();
    console.log(`[probe7] qty initial: value=${JSON.stringify(await qty.getValue())}`);
    await typeReal(qty, '0,333', true);
    await browser.pause(250);
    console.log(
      `[probe7] qty after 0,333: value=${JSON.stringify(await qty.getValue())} total=${await cartTotalMinor()} lines=${JSON.stringify(await cartLineTexts())}`,
    );
    await typeReal(qty, '12', true);
    await browser.pause(250);
    console.log(
      `[probe7] qty after 12: value=${JSON.stringify(await qty.getValue())} total=${await cartTotalMinor()}`,
    );
    await clearCart();
  });

  it('[PROBE-07c] discount percent decimals + gate visibility', async () => {
    await addSku(P.round, { expectTitle: P.round });
    try {
      await (await $(tid('discount-button'))).click();
      await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 20000 });
      const perc = await $(tid('discount-percent'));
      await typeReal(perc, '33,333', false);
      await browser.pause(300);
      const pinVisible = await (await $(tid('discount-pin'))).isDisplayed().catch(() => 'err');
      const liveTotal = await (await $(tid('discount-live-total'))).getText().catch(() => 'n/a');
      console.log(
        `[probe7] percent value=${JSON.stringify(await perc.getValue())} pinVisible=${String(pinVisible)} liveTotal=${JSON.stringify(liveTotal)}`,
      );
      await (
        await $('//div[@data-testid="discount-dialog"]//button[@aria-label="Fermer"]')
      ).click();
      await browser.waitUntil(
        async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)),
        { timeout: 10000 },
      );
    } catch (e) {
      console.log(`[probe7] discount probe failed: ${String(e)}`);
    }
    await clearCart();
  });

  it('[PROBE-07d] price override MoneyInput echo + invalid reject', async () => {
    await addSku(P.round, { expectTitle: P.round });
    try {
      await (await $(tid('price-override-open'))).click();
      const input = await $(tid('price-override-input'));
      await input.waitForDisplayed({ timeout: 20000 });
      const readLive = () =>
        browser.execute(() => {
          const c = document.querySelector(
            'div.money-input-container:has([data-testid="price-override-input"]) span.money-input__live',
          );
          return c ? (c.textContent || '') : null;
        });
      console.log(
        `[probe7] override idle echo: value=${JSON.stringify(await input.getValue())} live=${JSON.stringify(await readLive())}`,
      );
      await typeReal(input, '1234,5', false);
      await browser.pause(250);
      console.log(
        `[probe7] after 1234,5: value=${JSON.stringify(await input.getValue())} live=${JSON.stringify(await readLive())}`,
      );
      await typeReal(input, 'abc', false);
      await browser.pause(250);
      console.log(
        `[probe7] after abc: value=${JSON.stringify(await input.getValue())} ariaInvalid=${await input.getAttribute('aria-invalid')} live=${JSON.stringify(await readLive())}`,
      );
      await browser.keys(['Enter']);
      await browser.pause(350);
      console.log(
        `[probe7] after Enter(abc): value=${JSON.stringify(await input.getValue())} ariaInvalid=${await input.getAttribute('aria-invalid')} live=${JSON.stringify(await readLive())}`,
      );
      await typeReal(input, '1234,5', true);
      await browser.pause(300);
      await (await $(tid('price-override-apply'))).click();
      await browser.pause(450);
      console.log(
        `[probe7] after apply 1234,5: lines=${JSON.stringify(await cartLineTexts())} total=${await cartTotalMinor()}`,
      );
    } catch (e) {
      console.log(`[probe7] override probe failed: ${String(e)}`);
    }
    await clearCart();
  });
});
