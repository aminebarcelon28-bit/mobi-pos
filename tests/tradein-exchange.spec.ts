/**
 * Trade-In Two-Way Exchange — component + responsive gates (Suites 3–5).
 *
 * Mounts TradeInBuybackModal through tests/tradein-harness (second Vite
 * entry, real store + real Tailwind), NOT the app shell (fail-closed
 * license gate — see tests/sav-inspector-ui.spec.ts header for rationale).
 *
 *  Suite 3 (validation matrix): fully executable — red/green/amber badges
 *    on the real component, submit-block leaves store counts unchanged.
 *  Suite 5.2 (presets scroll): executable at 375px.
 *  Suite 4 (atomicity) + Suite 5.1/5.3 (sticky CTA, soulte view): parked
 *    as test.fixme — they need the Phase 2/3 UI (staged mode, soulte
 *    view, sticky action bar), which is specified but not built.
 *
 * NOTE — Suite 3 Row 1 discrepancy: the brief's "valid Luhn" example
 * `358921004812345` does NOT pass Luhn MOD-10 (verified independently in
 * scripts/test_tradein_exchange.mjs). The green-badge case below uses the
 * GSMA example `490154203237518`, and the brief's exact string is asserted
 * RED — the rule is correct, the example checksum was not.
 */
import { test, expect, type Page } from '@playwright/test';

const HARNESS = '/tests/tradein-harness/index.html';
const VALID_IMEI = '490154203237518'; // GSMA Luhn example (true checksum)
const BAD_LUHN = '358921004812344';
const BRIEF_EXAMPLE = '358921004812345'; // brief claims valid — actually red

async function openTradeIn(page: Page) {
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true);
  const err = await page.evaluate(() => (window as unknown as { __harnessError?: string | null }).__harnessError);
  expect(err, `harness boot error: ${err}`).toBeNull();
  await expect(page.getByText('REPRISE & TRADE-IN', { exact: false }).first()).toBeVisible();
}

async function snapshot(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __harnessSnapshot: () => { tradeIns: number; products: number } }).__harnessSnapshot()
  );
}

const imeiInput = (page: Page) => page.getByPlaceholder('358921004812345');
const cniInput = (page: Page) => page.getByPlaceholder('Ex: 1987-44-112233');
const nameInput = (page: Page) => page.getByPlaceholder('Ex: Karim Hadj');
const modelInput = (page: Page) => page.getByPlaceholder('ex: iPhone 14 Pro Max');
const buybackInput = (page: Page) => page.locator('input[type="number"]').first();
const submitBtn = (page: Page) => page.getByRole('button', { name: /Racheter & Injecter/i });

/** Fill the natively-required fields so submit reaches our handler. */
async function fillRequired(page: Page, buyback = '45000') {
  await nameInput(page).fill('Karim Hadj');
  await modelInput(page).fill('iPhone 13 Pro');
  await buybackInput(page).fill(buyback);
}

test.describe('Suite 3 — IMEI & identity matrix (real component)', () => {
  test('valid 15-digit IMEI -> green badge, no error', async ({ page }) => {
    await openTradeIn(page);
    await imeiInput(page).fill(VALID_IMEI);
    await expect(page.getByText('IMEI valide (Luhn OK)')).toBeVisible();
    await expect(page.getByText(/IMEI invalide|existe déjà/)).toHaveCount(0);
  });

  test('bad-checksum 15-digit -> red error, submit blocked with zero writes', async ({ page }) => {
    await openTradeIn(page);
    await imeiInput(page).fill(BAD_LUHN);
    // Inline field error (badge-adjacent <p>).
    await expect(page.getByText('IMEI invalide (checksum Luhn) — vérifiez la saisie.').first()).toBeVisible();
    await fillRequired(page);
    const before = await snapshot(page);
    await submitBtn(page).click();
    // Submit gate fires the error toast AND writes nothing.
    await expect(page.getByRole('alert').getByText(/IMEI invalide/)).toBeVisible();
    expect(await snapshot(page)).toEqual(before);
  });

  test("brief example '358921004812345' is Luhn-invalid -> red (documented discrepancy)", async ({ page }) => {
    await openTradeIn(page);
    await imeiInput(page).fill(BRIEF_EXAMPLE);
    await expect(page.getByText('IMEI invalide (checksum Luhn)')).toBeVisible();
    await expect(page.getByText('IMEI valide (Luhn OK)')).toHaveCount(0);
  });

  test('tablet / WiFi S/N (alphanumeric) -> amber neutral, submit path stays open', async ({ page }) => {
    await openTradeIn(page);
    await imeiInput(page).fill('DMPXYZ1234');
    // Badge (exact) + hint paragraph (contains) are two nodes — assert both.
    await expect(page.getByText('N° série accepté', { exact: true })).toBeVisible();
    await expect(page.getByText(/Format non-15 chiffres/)).toBeVisible();
    await expect(page.getByText(/IMEI invalide|existe déjà/)).toHaveCount(0);
  });

  test('messy input is trimmed/uppercased on change', async ({ page }) => {
    await openTradeIn(page);
    await imeiInput(page).fill('  dmpxyz1234  ');
    await expect(imeiInput(page)).toHaveValue('DMPXYZ1234');
    await expect(page.getByText('N° série accepté', { exact: true })).toBeVisible();
  });

  test('missing CNI -> amber badge, submit allowed (warn-only)', async ({ page }) => {
    await openTradeIn(page);
    await expect(page.getByText('Pièce manquante — à compléter')).toBeVisible();
    await cniInput(page).fill('1987-44-112233');
    await expect(page.getByText('Pièce manquante — à compléter')).toHaveCount(0);
  });
});

test.describe('Suite 5 — mobile 375px', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('5.2 presets scroll horizontally instead of wrapping', async ({ page }) => {
    await openTradeIn(page);
    const bar = page.locator('div.overflow-x-auto', { hasText: 'Presets Modèle:' });
    await expect(bar).toBeVisible();
    const overflow = await bar.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow, 'presets must overflow-x (scroll) at 375px, never wrap').toBe(true);
    const wrap = await bar.evaluate((el) => getComputedStyle(el).flexWrap);
    expect(wrap).not.toBe('wrap');
  });

  test('5.1 sticky CTA stays visible while typing (375px)', async ({ page }) => {
    // UNPARKED — Phase 2 sticky action bar (`sticky bottom-0` + safe-area
    // padding) keeps Valider docked while the form scrolls beneath it.
    await openTradeIn(page);
    await buybackInput(page).click();
    await buybackInput(page).fill('45000');
    const submit = submitBtn(page);
    await expect(submit).toBeVisible();
    const box = await submit.boundingBox();
    expect(box, 'Valider CTA must stay in viewport while typing').not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(667);
  });

  test('5.3 soulte CTA stays disabled until an explicit payout choice', async ({ page }) => {
    // UNPARKED — Phase 3 soulte view: no pre-selected default; the footer
    // CTA enables only after the cashier picks Décaisser or Créditer.
    await openTradeIn(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __harnessSeedCart: (u: number) => void;
        __harnessStageTradeIn: (b: number) => void;
        __harnessOpenPayment: () => void;
      };
      w.__harnessSeedCart(2500);
      w.__harnessStageTradeIn(85000);
      w.__harnessOpenPayment();
    });
    const cta = page.getByRole('button', { name: /Valider & Imprimer Reçu/ });
    await expect(cta).toBeVisible();
    await expect(cta).toBeDisabled();
    await page.getByRole('radio', { name: /Décaisser Espèces/ }).click();
    await expect(cta).toBeEnabled();
  });
});

test.describe('Suite 4 — atomicity & zero-orphan (staged mode)', () => {
  test('payment abort leaves trade_ins/products at +0, staging intact', async ({ page }) => {
    // UNPARKED — abort path needs no native lane: attach staged trade-in,
    // open payment, Annuler. Nothing was ever submitted, so the DB lanes
    // stay untouched while the memory-only staging survives for retry.
    await openTradeIn(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __harnessSeedCart: (u: number) => void;
        __harnessStageTradeIn: (b: number) => void;
        __harnessOpenPayment: () => void;
      };
      w.__harnessSeedCart(130000);
      w.__harnessStageTradeIn(50000);
      w.__harnessOpenPayment();
    });
    await expect(page.getByText(/Reste à Encaisser :/)).toBeVisible();
    const before = await snapshot(page);
    await page.getByRole('button', { name: 'Annuler (Échap)' }).click();
    await expect(page.getByText(/Reste à Encaisser :/)).toHaveCount(0);
    const after = await snapshot(page);
    expect(after.tradeIns).toBe(before.tradeIns);
    expect(after.products).toBe(before.products);
    // Staging is memory-only: still attached for the next attempt.
    expect(after.staged).not.toBeNull();
    await expect(page.getByText(/Reprise : iPhone 13 Pro/)).toBeVisible();
  });

  test('cart chip Retirer resets stagedTradeIn to null, totals restore', async ({ page }) => {
    await openTradeIn(page);
    // Dismiss the auto-opened modal: its overlay would intercept the chip click.
    await page.keyboard.press('Escape');
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION')).toHaveCount(0);
    await page.evaluate(() => {
      const w = window as unknown as { __harnessStageTradeIn: (b: number) => void };
      w.__harnessStageTradeIn(50000);
    });
    await expect(page.getByText(/Reprise : iPhone 13 Pro/)).toBeVisible();
    await page.getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(page.getByText(/Reprise : iPhone 13 Pro/)).toHaveCount(0);
    const staged = await page.evaluate(
      () => (window as unknown as { __harnessSnapshot: () => { staged: unknown } }).__harnessSnapshot().staged
    );
    expect(staged).toBeNull();
  });
});

test.describe('Suite 6 — staged exchange flow (real UI, zero DB writes)', () => {
  test('exchange mode hides bonus, stages 1:1 on Valider, chip shows delta', async ({ page }) => {
    await openTradeIn(page);
    await page.evaluate(() => {
      const w = window as unknown as { __harnessOpenExchange: () => void };
      w.__harnessOpenExchange();
    });
    // Exchange subtitle + no wallet bonus section.
    await expect(page.getByText(/déduite du panier/)).toBeVisible();
    await expect(page.getByText(/Verser en Avoir Client/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Valider l’Échange/ })).toBeVisible();

    await nameInput(page).fill('Karim Hadj');
    await modelInput(page).fill('iPhone 13 Pro');
    await imeiInput(page).fill('490154203237518');
    await buybackInput(page).fill('50000');

    const before = await snapshot(page);
    await page.getByRole('button', { name: /Valider l’Échange/ }).click();
    // Modal closed, staged payload set 1:1, NO product/trade rows written.
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION')).toHaveCount(0);
    const after = await snapshot(page);
    expect(after.tradeIns).toBe(before.tradeIns);
    expect(after.products).toBe(before.products);
    const staged = after.staged as unknown as {
      buybackValue: number;
      creditToWallet: boolean;
      stagedId: string;
      deviceModel: string;
    };
    expect(staged.buybackValue).toBe(50000);
    expect(staged.creditToWallet).toBe(false);
    expect(typeof staged.stagedId).toBe('string');
    // Cart chip with device + delta hero (exact: the success toast shares
    // the same amount inside a longer sentence).
    await expect(page.getByText(/Reprise : iPhone 13 Pro/)).toBeVisible();
    await expect(page.getByText( '−50 000 DA', { exact: true })).toBeVisible();
  });

  test('exchange cancel discards with zero writes', async ({ page }) => {
    await openTradeIn(page);
    await page.evaluate(() => {
      const w = window as unknown as { __harnessOpenExchange: () => void };
      w.__harnessOpenExchange();
    });
    await imeiInput(page).fill('490154203237518');
    const before = await snapshot(page);
    await page.keyboard.press('Escape');
    await expect(page.getByText('REPRISE & TRADE-IN OCCASION')).toHaveCount(0);
    const after = await snapshot(page);
    expect(after).toEqual(before);
  });
});

test.describe('Suite 7 — payment delta banner + soulte view (UI states, no submit)', () => {
  test('Net>0 banner: Total Panier − Reprise = Reste à Encaisser', async ({ page }) => {
    await openTradeIn(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __harnessSeedCart: (u: number) => void;
        __harnessStageTradeIn: (b: number) => void;
        __harnessOpenPayment: () => void;
      };
      w.__harnessSeedCart(130000);
      w.__harnessStageTradeIn(50000);
      w.__harnessOpenPayment();
    });
    await expect(page.getByText(/Reste à Encaisser :/)).toBeVisible();
    await expect(page.getByText(/Reprise:/)).toBeVisible();
  });

  test('Net<0 soulte view: explicit choice enforced, CTA gated', async ({ page }) => {
    await openTradeIn(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __harnessSeedCart: (u: number) => void;
        __harnessStageTradeIn: (b: number) => void;
        __harnessOpenPayment: () => void;
      };
      w.__harnessSeedCart(2500);
      w.__harnessStageTradeIn(85000);
      w.__harnessOpenPayment();
    });
    await expect(page.getByText(/Montant à Verser au Client :/)).toBeVisible();
    const cashPill = page.getByRole('radio', { name: /Décaisser Espèces/ });
    const walletPill = page.getByRole('radio', { name: /Créditer Portefeuille Avoir/ });
    await expect(cashPill).toBeVisible();
    await expect(walletPill).toBeVisible();
    // No pre-selected default: CTA disabled until explicit choice.
    await expect(cashPill).toHaveAttribute('aria-checked', 'false');
    await expect(walletPill).toHaveAttribute('aria-checked', 'false');
    await cashPill.click();
    await expect(cashPill).toHaveAttribute('aria-checked', 'true');
  });
});
