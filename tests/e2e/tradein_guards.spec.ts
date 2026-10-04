/**
 * Trade-in edge cases & business guards (real UI, harness-mounted store).
 *
 * Runs against /tests/tradein-harness/index.html (TradeInBuybackModal +
 * CartPanel + PaymentModal on the real Zustand store + Dexie; no Tauri
 * native lane). Each test uses a fresh browser context (clean Dexie).
 *
 * Two deliberate deviations from the brief, both documented inline:
 *  - Brief IMEI 359871002345674 is NOT Luhn-valid (verified); the suite
 *    uses check-digit-corrected sibling 359871002345677 and asserts the
 *    brief string goes red.
 *  - CNI is warn-only by design (never stalls a sale); blank customer NAME
 *    is what blocks submission. Scenario 3 pins both halves.
 *  - Staged intake is single-slot: staging a second device REPLACES the
 *    first (no banner exists). Scenario 4 pins replacement semantics.
 */
import { test, expect, type Page } from '@playwright/test';

const HARNESS = '/tests/tradein-harness/index.html';
/** Check-digit-corrected sibling of the brief's vector (same prefix). */
const GHOST_IMEI = '359871002345677';
const BRIEF_IMEI = '359871002345674'; // brief claims valid — actually red
const ALPHA_IMEI = '490154203237518';
const BETA_IMEI = '358249005471926';

type Harness = {
  __harnessReady?: boolean;
  __harnessError?: string | null;
  __harnessSnapshot: () => { tradeIns: number; products: number; staged: unknown };
  __harnessOpenExchange: () => void;
  __harnessSeedCart: (u: number) => void;
  __harnessDexie: (table: string) => Promise<Array<Record<string, unknown>>>;
};

async function openHarness(page: Page) {
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
// resolved to the RESALE MARGIN spinner instead: these specs typed a price that
// never reached the model, `buybackValue` stayed 0, and the submit no-op'd on
// `if (buybackValue <= 0) return;` — which surfaced as "nothing staged", nowhere
// near the cause. The field now carries its own stable test id.
const buybackInput = (page: Page) => tradeInDialog(page).getByTestId('buyback-price');
/**
 * Never submit blind. `MoneyInput` commits ONLY a parseable amount and reports
 * what it parsed in its `aria-live` echo line, so a field can look filled while
 * the model still holds 0 — and the submit then no-ops with no visible error.
 * Asserting the echo before every submit makes that failure mode unreachable.
 */
const expectBuybackCommitted = async (page: Page) => {
  const echo = buybackInput(page).locator('xpath=../../span[@aria-live="polite"]');
  await expect(echo).toContainText('=', { timeout: 10_000 });
};
/** The echo line's counterpart for a REJECTED amount (negative, garbage). */
const expectBuybackNotCommitted = async (page: Page) => {
  const echo = buybackInput(page).locator('xpath=../../span[@aria-live="polite"]');
  await expect(echo).not.toContainText('=', { timeout: 10_000 });
};
const stagedOf = (page: Page) =>
  page.evaluate(() => (window as unknown as Harness).__harnessSnapshot().staged as unknown as {
    buybackValue: number; deviceModel: string; imei: string; stagedId: string; nationalIdNumber?: string;
  } | null);

test.describe('Scenario 1 — cart cancellation stages nothing (no ghost ingestion)', () => {
  test('stage Ghost Device, Vider le panier: cart empties, catalog clean, IMEI reusable', async ({ page }) => {
    await openHarness(page);
    // One cart line so Vider has something to clear (single item: no confirm dialog).
    await page.evaluate(() => (window as unknown as Harness).__harnessSeedCart(12000));
    await expect(page.getByText(/1 Article/)).toBeVisible();

    // Stage the Ghost Device in exchange mode (name required by the form).
    await page.evaluate(() => (window as unknown as Harness).__harnessOpenExchange());
    await expect(page.getByRole('button', { name: /Valider l’Échange/ })).toBeVisible();
    await nameInput(page).fill('Client Fantôme');
    await modelInput(page).fill('Ghost Device');
    await imeiInput(page).fill(GHOST_IMEI);
    await buybackInput(page).fill('15000');
    await expectBuybackCommitted(page);
    await cniInput(page).fill('1987-44-112233');
    await expect(page.getByText('Pièce manquante — à compléter')).toHaveCount(0);
    const dexBefore = await page.evaluate(async () => {
      const h = (window as unknown as Harness);
      return { trades: (await h.__harnessDexie('tradeIns')).length, products: (await h.__harnessDexie('products')).length };
    });
    await page.getByRole('button', { name: /Valider l’Échange/ }).click();
    await expect(page.getByText(/Reprise : Ghost Device/)).toBeVisible();
    const staged = await stagedOf(page);
    expect(staged?.deviceModel).toBe('Ghost Device');
    expect(staged?.buybackValue).toBe(15000);

    // Abort: Vider le panier (trash button, title tooltip).
    await page.getByTitle(/Vider le panier/).click();
    await expect(page.getByText(/0 Article/)).toBeVisible();
    // Staging is memory-only by design: chip intent survives cart clear
    // (explicit Retirer clears it); nothing was ever committed.
    const dexAfter = await page.evaluate(async () => {
      const h = (window as unknown as Harness);
      return {
        trades: await h.__harnessDexie('tradeIns'),
        products: await h.__harnessDexie('products'),
      };
    });
    expect(dexAfter.trades.length).toBe(dexBefore.trades);
    expect(dexAfter.products.some((p) => String(p['title']).includes('Ghost Device'))).toBe(false);

    // IMEI reusable: reopen, same IMEI shows green (imeiRecords untouched).
    await page.evaluate(() => (window as unknown as Harness).__harnessOpenExchange());
    await imeiInput(page).fill(GHOST_IMEI);
    await expect(page.getByText('IMEI valide (Luhn OK)')).toBeVisible();
    await expect(page.getByText(/existe déjà/)).toHaveCount(0);
    // The brief's example string is Luhn-invalid: documents red, not green.
    await imeiInput(page).fill(BRIEF_IMEI);
    await expect(page.getByText('IMEI valide (Luhn OK)')).toHaveCount(0);
    await expect(page.getByText(/IMEI invalide/).first()).toBeVisible();
  });
});

test.describe('Scenario 2 — buyback input sanitization', () => {
  test('negative / non-numeric input cannot corrupt pricing (no NaN, no submit)', async ({ page }) => {
    await openHarness(page);
    await nameInput(page).fill('Client Test');
    await modelInput(page).fill('Test Device');
    await imeiInput(page).fill(ALPHA_IMEI);

    // Negative value: submit is a silent no-op (guard buybackValue<=0).
    // MoneyInput refuses to COMMIT a negative amount, so the model still holds 0
    // and the echo line reports the error instead of a parsed value.
    await buybackInput(page).fill('-5000');
    await expectBuybackNotCommitted(page);
    const beforeNeg = await page.evaluate(() => (window as unknown as Harness).__harnessSnapshot());
    await page.getByRole('button', { name: /Racheter & Injecter/ }).click();
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION').first()).toBeVisible();
    expect(await stagedOf(page)).toBeNull();
    const afterNeg = await page.evaluate(() => (window as unknown as Harness).__harnessSnapshot());
    expect(afterNeg).toEqual(beforeNeg);

    // Non-numeric text: this field is `type="text"`, so Chromium does NOT refuse
    // it the way it refuses a number input. The invariant belongs to the model
    // instead: letters are never committed, nothing renders NaN, and the submit
    // still stages nothing.
    await buybackInput(page).fill('abc');
    await expect(tradeInDialog(page).getByText(/NaN/)).toHaveCount(0);
    await page.getByRole('button', { name: /Racheter & Injecter/ }).click();
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION').first()).toBeVisible();
    expect(await stagedOf(page)).toBeNull();

    // Empty input reverts to the last committed value on blur, never NaN.
    await buybackInput(page).fill('');
    await buybackInput(page).blur();
    await expect(tradeInDialog(page).getByText(/NaN/)).toHaveCount(0);
    await expect(tradeInDialog(page).getByText(/Infinity/)).toHaveCount(0);
  });
});

test.describe('Scenario 3 — identity policy: name blocks, CNI warns', () => {
  test('blank name + blank CNI blocks; name-only submits with CNI warning', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => (window as unknown as Harness).__harnessOpenExchange());
    await modelInput(page).fill('Orphan Device');
    await imeiInput(page).fill(ALPHA_IMEI);
    await buybackInput(page).fill('20000');
    await expectBuybackCommitted(page);
    // Both identity fields blank. The required name input blocks natively
    // (browser validation bubble, handler never runs): modal stays open,
    // nothing stages.
    await page.getByRole('button', { name: /Valider l’Échange/ }).click();
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION').first()).toBeVisible();
    expect(await stagedOf(page)).toBeNull();

    // Name filled, CNI still blank: warn-only, submission allowed.
    await nameInput(page).fill('Client Sans Papiers');
    await expect(page.getByText('Pièce manquante — à compléter')).toBeVisible();
    await page.getByRole('button', { name: /Valider l’Échange/ }).click();
    const staged = await stagedOf(page);
    expect(staged?.buybackValue).toBe(20000);
    expect(staged?.nationalIdNumber ?? undefined).toBeUndefined();
  });
});

test.describe('Scenario 4 — single-slot staging: second device replaces first', () => {
  test('staging Bêta after Alpha leaves exactly one staged payload (Bêta)', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => (window as unknown as Harness).__harnessOpenExchange());
    await nameInput(page).fill('Client A');
    await modelInput(page).fill('Alpha');
    await imeiInput(page).fill(ALPHA_IMEI);
    await buybackInput(page).fill('40000');
    await expectBuybackCommitted(page);
    await page.getByRole('button', { name: /Valider l’Échange/ }).click();
    await expect(page.getByText(/Reprise : Alpha/)).toBeVisible();
    expect((await stagedOf(page))?.deviceModel).toBe('Alpha');

    // Second intake through the CTA (not Modifier): full replace, no merge.
    await page.evaluate(() => (window as unknown as Harness).__harnessOpenExchange());
    await nameInput(page).fill('Client B');
    await modelInput(page).fill('Bêta');
    await imeiInput(page).fill(BETA_IMEI);
    await buybackInput(page).fill('30000');
    await expectBuybackCommitted(page);
    await page.getByRole('button', { name: /Valider l’Échange/ }).click();
    await expect(page.getByText(/Reprise : Bêta/)).toBeVisible();
    await expect(page.getByText(/Reprise : Alpha/)).toHaveCount(0);
    const staged = await stagedOf(page);
    expect(staged?.deviceModel).toBe('Bêta');
    expect(staged?.imei).toBe(BETA_IMEI);
    // No cart lines were ever created by staging (delta lives outside lines).
    const dex = await page.evaluate(async () => {
      const h = window as unknown as Harness;
      return (await h.__harnessDexie('products')).filter((p) =>
        ['Alpha', 'Bêta'].some((m) => String(p['title']).includes(m)));
    });
    expect(dex.length).toBe(0);
  });
});
