/**
 * Input hardening — cart quantity masking + money-input blur rejection.
 *
 * Mounts CartPanel through tests/tradein-harness (second Vite entry, real
 * store + real Tailwind), NOT the app shell (fail-closed license gate — see
 * tests/sav-inspector-ui.spec.ts header for the rationale).
 *
 * Suite A — cart quantity (BUG-CART-QTY-01): the field used to be a controlled
 * `type="number"` bound straight to `item.quantity`, so every keystroke the
 * store refused was written back by React and select-all + "0005" walked
 * "1" → "10" → "100" → "1005": 1005 units instead of 5.
 *
 * Suite B — money input blur (BUG-MONEY-06/07): a rejected entry used to be
 * canonicalized on blur into a valid-looking amount the cashier never typed,
 * and the STORE kept the parseable prefix of their own corrupt input, so
 * "Valider" committed it to the cart line.
 *
 * Assertions read the STORE, not rendered text: the defect was precisely a
 * display that disagreed with the model.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

const HARNESS = '/tests/tradein-harness/index.html';
const UNIT_PRICE = 1800;

interface CartSnapshot {
  id: string;
  title: string;
  quantity: number;
  appliedPrice: number;
  unitPriceCharged: number | undefined;
}

interface Harness {
  __harnessReady?: boolean;
  __harnessError?: string | null;
  __harnessSeedCartLines: (lines: Array<{ price: number; title?: string; stock?: number }>) => void;
  __harnessCloseModals: () => void;
  __harnessCartSnapshot: () => CartSnapshot[];
}

const DEFAULT_STOCK = 10;

async function openCart(page: Page, stock = DEFAULT_STOCK): Promise<void> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as unknown as Harness).__harnessReady === true);
  const err = await page.evaluate(() => (window as unknown as Harness).__harnessError);
  expect(err, `harness boot error: ${err}`).toBeNull();
  await page.evaluate(
    ([s]) => {
      const h = window as unknown as Harness;
      h.__harnessCloseModals();
      h.__harnessSeedCartLines([{ price: 1800, title: 'Coque Silicone (Harness)', stock: s as number }]);
    },
    [stock]
  );
  await expect(page.getByRole('option')).toHaveCount(1);
}

const cartOf = (page: Page) =>
  page.evaluate(() => (window as unknown as Harness).__harnessCartSnapshot());

/** The quantity field is named by its (glyph-only) visible content + context. */
const qtyField = (page: Page) =>
  page.getByRole('textbox', { name: /Quantité Coque Silicone \(Harness\)/i });

test.describe('Suite A — cart quantity input', () => {
  test('leading zeros commit 5 units, not 1005', async ({ page }) => {
    await openCart(page, 5000);
    const field = qtyField(page);
    await expect(field).toHaveValue('1');

    // The reported repro: select all, type "0005".
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('0005');

    // Store is the source of truth: 5 units, never 1005 (which would have been
    // a 1 809 000 DA line on a 1 800 DA product).
    expect((await cartOf(page))[0]?.quantity).toBe(5);
    await expect(field).toHaveValue('5');

    // Canonicalized on blur (unchanged value).
    await field.blur();
    await expect(field).toHaveValue('5');
    expect((await cartOf(page))[0]?.quantity).toBe(5);
  });

  test('pending entry stays typable; the fallback lands on blur, not mid-keystroke', async ({ page }) => {
    await openCart(page);
    const field = qtyField(page);

    // Leading zeros are PENDING, not rejected: the field keeps them on screen
    // and the committed quantity is untouched while typing.
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('000');
    await expect(field).toHaveValue('000');
    expect((await cartOf(page))[0]?.quantity).toBe(1);

    // Backspacing to empty is allowed too (never a rejected fill('')).
    await field.press('Backspace');
    await field.press('Backspace');
    await field.press('Backspace');
    await expect(field).toHaveValue('');
    expect((await cartOf(page))[0]?.quantity).toBe(1);

    // Enter resolves the pending field to the documented fallback (1 unit).
    await field.press('Enter');
    await expect(field).toHaveValue('1');
    expect((await cartOf(page))[0]?.quantity).toBe(1);
  });

  test('blurring a half-typed quantity commits what was typed', async ({ page }) => {
    await openCart(page);
    const field = qtyField(page);
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('007');
    // Blur (no Enter) is the other commit point.
    await field.blur();
    await expect(field).toHaveValue('7');
    expect((await cartOf(page))[0]?.quantity).toBe(7);
  });

  test('a store clamp is mirrored into the field (no display/model split)', async ({ page }) => {
    await openCart(page, 10);
    const field = qtyField(page);
    // The seeded line has stock 10: the cart clamps to stock, and the field
    // must show the clamped value rather than keeping the typed digits.
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('999');
    expect((await cartOf(page))[0]?.quantity).toBe(10);
    await expect(field).toHaveValue('10');
  });

  test('non-numeric characters never reach the model', async ({ page }) => {
    await openCart(page, 5000);
    const field = qtyField(page);
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('1a2b');
    expect((await cartOf(page))[0]?.quantity).toBe(12);
    await field.blur();
    await expect(field).toHaveValue('12');
  });

  test('ArrowUp/ArrowDown still step the quantity (native spinner replacement)', async ({ page }) => {
    await openCart(page, 10);
    const field = qtyField(page);
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('3');
    // `type="number"` used to step via the native spinner; the text field has
    // none, and cart key-nav bails while an input holds focus — so the step
    // must be re-implemented or arrow keys go dead on the quantity field.
    await field.press('ArrowUp');
    await expect(field).toHaveValue('4');
    expect((await cartOf(page))[0]?.quantity).toBe(4);
    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await expect(field).toHaveValue('2');
    expect((await cartOf(page))[0]?.quantity).toBe(2);
    // Clamped at the same bounds the field enforces: 1 … stock.
    await field.press('ArrowDown');
    await expect(field).toHaveValue('1');
    await field.press('ArrowDown');
    await expect(field).toHaveValue('1');
    expect((await cartOf(page))[0]?.quantity).toBe(1);
    // And at the top: stock 10, not an unbounded climb.
    for (let i = 0; i < 15; i++) await field.press('ArrowUp');
    await expect(field).toHaveValue('10');
    expect((await cartOf(page))[0]?.quantity).toBe(10);
  });
});

test.describe('Suite B — price override money input', () => {
  const overrideField = (page: Page) => page.getByRole('textbox', { name: /Nouveau Prix Vendu/i });

  /**
   * Types character by character. `fill()` delivers the whole string in ONE
   * change event, so it CANNOT reproduce the reported vector: the live commit
   * of the PARSEABLE PREFIX ("9500" → 950 000, "12." → 12 000) before the
   * corrupt characters arrive. Only real keystrokes do.
   */
  async function typeOver(field: Locator, text: string): Promise<void> {
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially(text);
  }

  async function openOverride(page: Page): Promise<void> {
    await openCart(page, 5000);
    // Visible label is "Prix" (glyph-only Tag icon beside it).
    await page.getByRole('button', { name: 'Prix', exact: true }).click();
    await expect(overrideField(page)).toBeVisible();
  }

  test('rejected entry is never canonicalized into a valid-looking price', async ({ page }) => {
    await openOverride(page);
    const field = overrideField(page);
    const echo = field.locator('xpath=../following-sibling::span[@aria-live="polite"]');

    // The reported garbage, typed: "12." commits live, "12.a" invalidates.
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('12.');
    // The prefix IS visible in the echo while typing (entry-echo contract)…
    await expect(echo).toContainText('= 12.00 DA');
    await field.pressSequentially('a501500'); // corrupt tail
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    await field.blur();

    // …but neither it nor a value parsed out of the rejected text survives the
    // rollback (the 121 500.00 DA deception): the field returns to 1 800.00 DA.
    await expect(field).not.toHaveValue(/121/);
    await expect(field).toHaveValue('1 800.00');
    await expect(field.locator('xpath=following-sibling::span[@class="money-input__unit"]')).toBeVisible();
    await expect(field.locator('xpath=following-sibling::span[@class="money-input__unit"]')).toHaveText('DA');
    // The rejection stays visible instead of being silently swallowed.
    await expect(echo).toHaveText(/Saisie rejetée/);
    await expect(echo).not.toContainText('=');
  });

  test('revert lands on the pre-edit baseline, never on the rejected text or its prefix', async ({
    page,
  }) => {
    await openOverride(page);
    const field = overrideField(page);
    const echo = field.locator('xpath=../following-sibling::span[@aria-live="polite"]');

    // A valid amount commits live (the entry-echo contract the specs probe).
    await typeOver(field, '3500');
    await expect(echo).toContainText('= ');

    // Then garbage: blur must roll back to what the field held BEFORE this edit
    // (1 800 DA) — not to the parseable prefix of the rejected string (12.00).
    await typeOver(field, '12.a501500');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await field.blur();
    await expect(field).toHaveValue('1 800.00');
    await expect(field.locator('xpath=following-sibling::span[@class="money-input__unit"]')).toBeVisible();
    await expect(echo).toHaveText(/Saisie rejetée/);
  });

  test('a rejected entry can never reach the cart through "Valider"', async ({ page }) => {
    await openCart(page, 5000);
    await page.getByRole('button', { name: 'Prix', exact: true }).click();
    const field = page.getByRole('textbox', { name: /Nouveau Prix Vendu/i });
    const echo = field.locator('xpath=../following-sibling::span[@aria-live="polite"]');
    await expect(field).toHaveValue('1 800.00');
    await expect(field.locator('xpath=following-sibling::span[@class="money-input__unit"]')).toBeVisible();

    // The prefix "9500" DOES parse, so the live commit path takes it — the
    // corruption vector: 9 500 DA is above cost, and "discount" clamps to 0%,
    // so the manager gate never fires and "Valider" would have applied it.
    await field.click();
    await field.press('Control+a');
    await field.pressSequentially('9500');
    await expect(echo).toContainText('= 9 500.00 DA'); // prefix really did commit
    await field.pressSequentially('.abc'); // corrupt tail
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    // Blur: the store rolls back with the display.
    await field.blur();
    await expect(field).toHaveValue('1 800.00');
    await expect(echo).toHaveText(/Saisie rejetée/);

    // Apply: the cart line keeps its original price — not 9 500 DA.
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    const cart = await cartOf(page);
    expect(cart[0]?.appliedPrice).toBe(UNIT_PRICE);
    expect(cart[0]?.unitPriceCharged ?? cart[0]?.appliedPrice).toBe(UNIT_PRICE);
  });

  test('a field that never committed anything rolls back to the amount it displayed', async ({
    page,
  }) => {
    // The trade-in buyback price is the zero case: the harness boots with the
    // modal open and the field shows 0.00 DA. A rejected entry must return
    // there — never to a value parsed out of the rejected text.
    await page.goto(HARNESS);
    await page.waitForFunction(() => (window as unknown as Harness).__harnessReady === true);
    const field = page.getByTestId('buyback-price');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('0.00');
    await expect(field.locator('xpath=following-sibling::span[@class="money-input__unit"]')).toBeVisible();
    const echo = field.locator('xpath=../following-sibling::span[@aria-live="polite"]');

    await typeOver(field, '12.a501500');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await field.blur();

    await expect(field).toHaveValue('0.00');
    await expect(echo).toHaveText(/Saisie rejetée/);
    await expect(echo).not.toContainText('=');
  });
});