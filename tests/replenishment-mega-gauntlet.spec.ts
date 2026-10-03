/**
 * ULTRA-MEGA GAUNTLET — adversarial chaos suite for the Réapprovisionnement
 * modal (Directive #014 §8).
 *
 * Forensic corrections applied to the mandated spec (each verified against
 * the live code before writing):
 *  - GAUNTLET-01: the pageerror listener is registered ONCE in beforeEach.
 *    The mandated version registered it inside the payload loop and asserted
 *    immediately — vacuous, because pageerror fires asynchronously, after
 *    the assertion has already run.
 *  - GAUNTLET-02: Locator.click() accepts no `delay` option (Playwright
 *    throws "Unknown option"); rapid clicks are issued back-to-back.
 *  - GAUNTLET-03: the harness seeds one waiting-list PO (PO-2026-0147), so
 *    the draft count is baselined before the double-click and must grow by
 *    exactly one — validating the createPO in-flight guard (§4.3). The
 *    double-click is simulated as two synchronous click dispatches: two
 *    awaited Locator.click() calls race with the registry-mounted modal
 *    unmount (the activeModal switch to 'purchase_order' unmounts this
 *    instance), which would detach the button mid-second-click.
 *  - GAUNTLET-04: the mandated premise (empty selection ⇒ PO blocked)
 *    contradicts the shipped architecture: the selection maps are an
 *    optional refinement and an empty selection deliberately falls back to
 *    the complete alert-derived set (disabling the CTA on empty selection
 *    would brick the primary flow, where the operator never opens "Voir
 *    détails"). The test asserts the designed behavior. Also: the KPI
 *    tiles are <article> elements, so the card locator is scoped to the
 *    supplier-list <main> — the mandated `page.locator('article').first()`
 *    matches a KPI tile, not a supplier card.
 *  - GAUNTLET-06: added — covers the accent-insensitive search vector
 *    (§2.3) implemented via stripAccents ("ecran" must match "Écran").
 */
import { test, expect } from '@playwright/test';

interface ReplDraftPO {
  id: string;
  poNumber: string;
  status: string;
  items: unknown[];
}

interface ReplState {
  purchaseOrders: ReplDraftPO[];
  activeDraftPO: ReplDraftPO | null;
}

test.describe('ULTRA-MEGA-HARD REPLENISHMENT CHAOS GAUNTLET', () => {
  const pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0;
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/tests/replenishment-harness/index.html?theme=light');
    await page.waitForFunction(
      () => (window as unknown as { __replReady?: boolean }).__replReady === true,
      null,
      { timeout: 30000 },
    );
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('GAUNTLET-01: Malicious & adversarial search injections never crash', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Grossiste, Produit, SKU/i);
    const adversarialPayloads = [
      '[.*+?^${}()|[]', // raw regex metacharacters — literal scan only, never compiled
      '<script>alert("xss")</script>', // XSS — rendered as escaped React text children
      '   Fournisseur   ', // trimmable whitespace
      'موزع الهواتف', // RTL Arabic script
      'Écran & Verre Trempé', // heavy French diacritics
      '0000000000', // barcode sequence boundary
      '\\', // dangling backslash
      'A'.repeat(128), // buffer boundary string
    ];

    for (const payload of adversarialPayloads) {
      await searchInput.fill(payload);
      await page.waitForTimeout(400); // 300ms debounce + useDeferredValue settlement
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(pageErrors).toHaveLength(0);
    }
  });

  test('GAUNTLET-02: Rapid-fire tab thrashing while debouncing', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Grossiste, Produit, SKU/i);
    await searchInput.fill('Anker');

    const pills = [
      page.getByRole('tab', { name: /Toutes/i }),
      page.getByRole('tab', { name: /Ruptures/i }),
      page.getByRole('tab', { name: /En attente/i }),
      page.getByRole('tab', { name: /Commandes/i }),
    ];

    for (let i = 0; i < 3; i += 1) {
      for (const pill of pills) {
        await pill.click();
      }
    }

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#supplier-count-announcer')).toBeAttached();
    expect(pageErrors).toHaveLength(0);
  });

  test('GAUNTLET-03: Double-click race on "Créer PO" mints exactly one draft', async ({ page }) => {
    const readCount = () =>
      page.evaluate(
        () =>
          (window as unknown as { __replStore: { getState: () => ReplState } }).__replStore
            .getState().purchaseOrders.length,
      );
    const baseline = await readCount();

    const poBtn = page
      .locator('main[aria-label="Liste des fournisseurs"] article')
      .first()
      .locator('button', { hasText: /créer po/i })
      .first();
    await expect(poBtn).toBeVisible();

    // Two synchronous click dispatches: the second is swallowed by the
    // in-flight draft guard (§4.3) — no twin PO.
    await poBtn.evaluate((el) => {
      el.click();
      el.click();
    });

    await expect(page.getByText(/Contrôle Réception #PO/)).toBeVisible();
    expect(await readCount()).toBe(baseline + 1);
    expect(pageErrors).toHaveLength(0);
  });

  test('GAUNTLET-04: Deselecting every line item still yields the full alert-derived draft', async ({ page }) => {
    const firstCard = page.locator('main[aria-label="Liste des fournisseurs"] article').first();
    await firstCard.getByRole('button', { name: /voir détails de/i }).click();
    await firstCard.getByRole('button', { name: /Tout décocher/i }).click();

    await firstCard.getByRole('button', { name: /créer po/i }).click();

    // Selection is an optional refinement: an empty selection falls back
    // to the complete alert-derived set — never an empty PO.
    await expect(page.getByText(/Contrôle Réception #PO/)).toBeVisible();
    const draft = await page.evaluate(
      () =>
        (window as unknown as { __replStore: { getState: () => ReplState } }).__replStore
          .getState().activeDraftPO,
    );
    expect(draft).not.toBeNull();
    expect(draft!.items).toHaveLength(3);
    expect(pageErrors).toHaveLength(0);
  });

  test('GAUNTLET-05: Strict boundary & zero horizontal overflow at 1024px', async ({ page }) => {
    const toolbar = page.locator('div[role="tablist"]').locator('..');
    const nouveauBonBtn = page.getByRole('button', { name: /Nouveau bon de commande/i });

    await expect(nouveauBonBtn).toBeVisible();

    const toolbarBox = await toolbar.boundingBox();
    const btnBox = await nouveauBonBtn.boundingBox();

    expect(toolbarBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    // + Nouveau Bon never breaches the toolbar's right edge…
    expect(btnBox!.x + btnBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width + 1);
    // …and holds the WCAG 2.1 AA touch-target floor.
    expect(btnBox!.height).toBeGreaterThanOrEqual(44);
  });

  test('GAUNTLET-06: Accent-insensitive search ("ecran" matches "Écran")', async ({ page }) => {
    const search = page.getByLabel('Filtrer par Grossiste, Produit, SKU');
    await search.fill('ecran'); // unaccented, lowercase

    const cards = page.locator('main[aria-label="Liste des fournisseurs"] article');
    // Distributeur Officiel carries "Protège-Écran Verre Trempé" and
    // Fournisseur Général carries "Kit Nettoyage Ecran".
    await expect(cards).toHaveCount(2);
    await expect(page.getByText('Distributeur Officiel')).toBeVisible();
    await expect(page.getByText('Fournisseur Général')).toBeVisible();
  });
});
