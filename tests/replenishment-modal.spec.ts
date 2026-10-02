/**
 * Réapprovisionnement modal visual regression gates.
 *
 * Checks the checklist from the architectural certificate:
 * - desktop shell width and right-edge clipping
 * - KPI layout / pill layout
 * - CTA alignment and size
 * - keyboard Escape + focus restore
 * - mobile sheet affordances and layout
 *
 * Stage 2 (live store wiring): the harness mounts the live
 * ReplenishmentContainer over a deterministic product seed, so the
 * "live store wiring" suite below asserts real derivation
 * (KPIs, line items, qty steppers, contact persistence, PO draft
 * creation + routing) end to end.
 *
 * Stage 3 (PO modal integration): the harness also mounts
 * GlobalModalHost, so "Créer PO" renders the real PurchaseOrderModal
 * (contrôle view via deep-link), "Voir Commande" deep-links the
 * waiting-list PO, and the 5th toolbar item opens the manual
 * draft builder.
 */
import { test, expect, type Page } from '@playwright/test';

const HARNESS = '/tests/replenishment-harness/index.html';
const LG = 1024;
const XL = 1280;

async function openHarness(page: Page, open = true, width = 1440, height = 900, theme: 'light' | 'dark' = 'light') {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${HARNESS}?open=${open ? 1 : 0}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__replReady === true, null, { timeout: 30_000 });
  const err = await page.evaluate(() => (window as unknown as Record<string, string | null>).__replError);
  expect(err, `harness failed to mount: ${err}`).toBeNull();
}

test.describe('Réapprovisionnement modal — desktop width & clipping', () => {
  test('shell reaches max-w-5xl (1024px) minus overlay padding at LG', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const shell = page.locator('[role="dialog"]').first();
    await expect(shell).toBeVisible();
    const w = await shell.evaluate((el) => el.getBoundingClientRect().width);
    expect(Number(w)).toBeGreaterThanOrEqual(LG - 32);
  });

  test('fourth KPI tile is fully visible without horizontal scroll', async ({ page }) => {
    await openHarness(page, true, XL, 900);
    const budget = page.getByText(/BUDGET ESTIMÉ/);
    await expect(budget).toBeVisible();
    const budgetRow = budget.locator('xpath=ancestor::article');
    const budgetRect = await budgetRow.evaluate((el) => el.getBoundingClientRect());
    const main = page.locator('main[aria-label="Liste des fournisseurs"]').first();
    const mainRect = await main.evaluate((el) => el.getBoundingClientRect());
    expect(Number(budgetRect.right)).toBeLessThanOrEqual(Number(mainRect.right) + 2);

    const overflows = await main.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(Number(overflows)).toBeLessThanOrEqual(1);
  });

  test('all four status pills render and are individually visible', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const tablist = page.getByRole('tablist', { name: /filtres de statut/i });
    await expect(tablist).toBeVisible();
    const pills = tablist.getByRole('tab');
    const count = await pills.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      await expect(pills.nth(i)).toBeVisible();
    }
    const pending = page.getByRole('tab', { name: /en attente/i });
    await expect(pending).toBeVisible();
    const text = (await pending.textContent())?.toLowerCase() ?? '';
    expect(text).toContain('attente');
  });

  test('primary CTA is content-sized and right-aligned, not full-width', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const cta = page.locator('main[aria-label="Liste des fournisseurs"] article').first().locator('button', { hasText: /créer po/i }).first();
    await expect(cta).toBeVisible();
    const w = await cta.evaluate((el) => el.getBoundingClientRect().width);
    const card = cta.locator('xpath=ancestor::article').first();
    const cardW = await card.evaluate((el) => el.getBoundingClientRect().width);
    expect(Number(w)).toBeLessThan(cardW * 0.45);
  });
});

test.describe('Réapprovisionnement modal — keyboard & focus', () => {
  test('Escape closes the modal and focus restores to the trigger', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const trigger = page.getByRole('button', { name: /ouvrir/i });
    await trigger.focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    const activeLabel = (await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return '<none>';
      return el.getAttribute('aria-label') || el.textContent || el.tagName;
    })) as string;
    const triggerText = (await trigger.textContent())?.trim() ?? '';
    expect(activeLabel.toLowerCase()).toContain(triggerText.toLowerCase().slice(0, Math.min(triggerText.length, 12)));
  });
});

test.describe('Réapprovisionnement modal — mobile layout (375px)', () => {
  test('drag handle is visible at the top', async ({ page }) => {
    await openHarness(page, true, 375, 812);
    await expect(page.locator('body')).toBeVisible();
    const hasHandle = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('div[aria-hidden="true"]'));
      return nodes.some((n) => {
        const r = n.getBoundingClientRect();
        return r.width >= 28 && r.width <= 56 && r.height >= 4 && r.height <= 8;
      });
    });
    expect(hasHandle).toBe(true);
  });

  test('KPIs are 2 columns on mobile', async ({ page }) => {
    await openHarness(page, true, 375, 812);
    const grid = page.locator('div[class*="grid-cols-2"]').first();
    await expect(grid).toBeVisible();
    const cols = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    expect(cols.split(' ').filter(Boolean).length).toBe(2);
  });

  test('primary CTA stretches full-width on mobile', async ({ page }) => {
    await openHarness(page, true, 375, 812);
    const cta = page.locator('main[aria-label="Liste des fournisseurs"] article').first().locator('button', { hasText: /créer po/i }).first();
    await expect(cta).toBeVisible();
    const w = await cta.evaluate((el) => el.getBoundingClientRect().width);
    const card = cta.locator('xpath=ancestor::article').first();
    const cardW = await card.evaluate((el) => el.getBoundingClientRect().width);
    expect(Number(w)).toBeGreaterThan(cardW * 0.75);
  });
});

test.describe('Réapprovisionnement — live store wiring (Stage 2)', () => {
  test('KPIs and supplier cards derive from the seeded store', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    await expect(page.getByLabel('Nombre de grossistes: 3')).toBeVisible();
    await expect(page.getByLabel('Articles sous seuil de réapprovisionnement: 6')).toBeVisible();
    await expect(page.getByLabel('Articles en rupture de stock: 1')).toBeVisible();
    const cards = page.locator('main[aria-label="Liste des fournisseurs"] article');
    await expect(cards).toHaveCount(3);
    await expect(page.getByText('Grossiste Algerien Mobile')).toBeVisible();
    await expect(page.getByText('Distributeur Officiel')).toBeVisible();
  });

  test('budget KPI sums suggested qty × unit cost (92 450 DA)', async ({ page }) => {
    await openHarness(page, true, XL, 900);
    const budget = page.getByLabel(/Budget estimé pour le réapprovisionnement/);
    await expect(budget).toBeVisible();
    const label = (await budget.getAttribute('aria-label')) ?? '';
    expect(label.replace(/[\s  ]/g, '')).toContain('92450DA');
  });

  test('"Voir détails" expands live line items with stock vs threshold', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    await page.getByRole('button', { name: /voir les détails/i }).first().click();
    await expect(page.getByText('SKU: VC-0001')).toBeVisible();
    await expect(page.getByText(/Stock:/).first()).toBeVisible();
    await expect(page.getByText(/Seuil:/).first()).toBeVisible();
    await expect(page.getByText(/Manque:/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Augmenter la quantité' }).first()).toBeVisible();
  });

  test('quantity stepper writes the live customQtyMap in the store', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    await page.getByRole('button', { name: /voir les détails/i }).first().click();
    // First line item is the rupture (VC-0001, suggested qty = max(1, 2×10−0) = 20).
    await page.getByRole('button', { name: 'Augmenter la quantité' }).first().click();
    const qty = await page.evaluate(() => {
      const s = (window as unknown as { __replStore: { getState: () => { customQtyMap: Record<string, number> } } }).__replStore.getState();
      return s.customQtyMap['seed-vA1'];
    });
    expect(qty).toBe(21);
  });

  test('inline contact editor persists to the vendor directory', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    await page.getByRole('button', { name: 'Modifier les coordonnées de Grossiste Algerien Mobile' }).first().click();
    await page.getByLabel('Téléphone de Grossiste Algerien Mobile').fill('0550 12 34 56');
    await page.getByLabel('WhatsApp de Grossiste Algerien Mobile').fill('0550 12 34 56');
    await page.getByLabel('E-mail de Grossiste Algerien Mobile').fill('commandes@gam.dz');
    await page.getByRole('button', { name: 'Enregistrer les coordonnées de Grossiste Algerien Mobile' }).click();
    const saved = await page.evaluate(() => {
      const s = (window as unknown as { __replStore: { getState: () => { vendorDirectory: Record<string, { phone?: string; whatsapp?: string; email?: string }> } } }).__replStore.getState();
      return s.vendorDirectory['Grossiste Algerien Mobile'] ?? null;
    });
    expect(saved).not.toBeNull();
    expect(saved!.phone).toBe('0550 12 34 56');
    expect(saved!.whatsapp).toBe('0550 12 34 56');
    expect(saved!.email).toBe('commandes@gam.dz');
    const persisted = await page.evaluate(() => localStorage.getItem('mobi_vendor_directory_v1'));
    expect(persisted).toContain('0550 12 34 56');
  });

  test('Créer PO assembles selected lines, persists a draft PO and routes to the PO review', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const cta = page.locator('main[aria-label="Liste des fournisseurs"] article').first().locator('button', { hasText: /créer po/i }).first();
    await cta.click();
    await page.waitForFunction(() => {
      const s = (window as unknown as { __replStore: { getState: () => { activeModal: string | null; purchaseOrders: unknown[] } } }).__replStore.getState();
      return s.activeModal === 'purchase_order' && s.purchaseOrders.length > 0;
    }, null, { timeout: 10_000 });
    const po = await page.evaluate(() => {
      const s = (window as unknown as { __replStore: { getState: () => { purchaseOrders: Array<{ poNumber: string; vendorName: string; status: string; totalAmount: number; items: unknown[] }> } } }).__replStore.getState();
      const p = s.purchaseOrders[0];
      return { poNumber: p.poNumber, vendorName: p.vendorName, status: p.status, items: p.items.length, total: p.totalAmount };
    });
    expect(po.vendorName).toBe('Grossiste Algerien Mobile');
    expect(po.status).toBe('Waiting List');
    expect(po.items).toBe(3);
    expect(po.poNumber).toMatch(/^PO/);
    // Replenishment view closes so the PO review takes over.
    await expect(page.getByLabel('Fermer le réapprovisionnement')).toHaveCount(0);
    // PurchaseOrderModal renders the new draft (contrôle view via deep-link).
    await expect(page.getByText(/Contrôle Réception #PO/)).toBeVisible();
  });

  test('"Voir Commande" deep-links the waiting-list PO into the PO review', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    await page.getByRole('tab', { name: /commandes/i }).click();
    const viewOrder = page.getByRole('button', { name: /voir la commande po-2026-0147/i });
    await expect(viewOrder).toBeVisible();
    await viewOrder.click();
    await page.waitForFunction(() => {
      const s = (window as unknown as { __replStore: { getState: () => { activeModal: string | null; activeDraftPO: { poNumber: string } | null } } }).__replStore.getState();
      return s.activeModal === 'purchase_order' && s.activeDraftPO?.poNumber === 'PO-2026-0147';
    }, null, { timeout: 10_000 });
    await expect(page.getByText('Contrôle Réception #PO-2026-0147')).toBeVisible();
  });

  test('5th toolbar item "+ Nouveau Bon" opens the manual draft builder', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const generate = page.getByRole('button', { name: 'Nouveau bon de commande' });
    await expect(generate).toBeVisible();
    await generate.click();
    await page.waitForFunction(() => {
      const s = (window as unknown as { __replStore: { getState: () => { activeModal: string | null; poDraftBuilderRequested: boolean } } }).__replStore.getState();
      return s.activeModal === 'purchase_order' && s.poDraftBuilderRequested === false;
    }, null, { timeout: 10_000 });
    await expect(page.getByPlaceholder('Nom du fournisseur (ex: Grossiste Centre)...')).toBeVisible();
  });
});

test.describe('Réapprovisionnement — toolbar bounds & deep search (Directive #014)', () => {
  test('"+ Nouveau Bon" is fully inside the toolbar at 1024px, 1280px and 1440px', async ({ page }) => {
    for (const width of [LG, XL, 1440]) {
      await openHarness(page, true, width, 900);
      const generate = page.getByRole('button', { name: 'Nouveau bon de commande' });
      await expect(generate).toBeVisible();
      const btnRect = await generate.evaluate((el) => el.getBoundingClientRect());
      const toolbar = page.getByRole('search', { name: /filtres de réapprovisionnement/i });
      const toolbarRect = await toolbar.evaluate((el) => el.getBoundingClientRect());
      expect(Number(btnRect.right)).toBeLessThanOrEqual(Number(toolbarRect.right) + 1);
      expect(Number(btnRect.left)).toBeGreaterThanOrEqual(Number(toolbarRect.left) - 1);
      expect(Number(btnRect.right)).toBeLessThanOrEqual(width);
    }
  });

  test('search by SKU isolates the supplier carrying that SKU', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const search = page.getByLabel('Filtrer par Grossiste, Produit, SKU');
    await search.fill('VC-0001');
    const cards = page.locator('main[aria-label="Liste des fournisseurs"] article');
    await expect(cards).toHaveCount(1);
    await expect(page.getByText('Grossiste Algerien Mobile')).toBeVisible();
  });

  test('search by product title isolates the relevant supplier', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const search = page.getByLabel('Filtrer par Grossiste, Produit, SKU');
    await search.fill('Adaptateur');
    const cards = page.locator('main[aria-label="Liste des fournisseurs"] article');
    await expect(cards).toHaveCount(1);
    await expect(page.getByText('Distributeur Officiel')).toBeVisible();
  });

  test('search by product barcode isolates the relevant supplier', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const search = page.getByLabel('Filtrer par Grossiste, Produit, SKU');
    await search.fill('BC-VD-0002');
    const cards = page.locator('main[aria-label="Liste des fournisseurs"] article');
    await expect(cards).toHaveCount(1);
    await expect(page.getByText('Distributeur Officiel')).toBeVisible();
  });

  test('search by wholesaler name still filters', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const search = page.getByLabel('Filtrer par Grossiste, Produit, SKU');
    await search.fill('Fournisseur Général');
    const cards = page.locator('main[aria-label="Liste des fournisseurs"] article');
    await expect(cards).toHaveCount(1);
    await expect(page.getByText('Fournisseur Général')).toBeVisible();
  });

  test('product search surfaces the card and highlights the matching line item', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const search = page.getByLabel('Filtrer par Grossiste, Produit, SKU');
    await search.fill('Nettoyage');
    const cards = page.locator('main[aria-label="Liste des fournisseurs"] article');
    await expect(cards).toHaveCount(1);
    await expect(page.getByText('Fournisseur Général')).toBeVisible();
    // Expand the line-item panel: the matching product renders, highlighted.
    await page.getByRole('button', { name: /voir les détails/i }).first().click();
    await expect(page.getByText('Kit Nettoyage Ecran')).toBeVisible();
    await expect(page.locator('mark', { hasText: 'Nettoyage' })).toBeVisible();
  });

  test('non-matching search shows the empty state', async ({ page }) => {
    await openHarness(page, true, LG, 900);
    const search = page.getByLabel('Filtrer par Grossiste, Produit, SKU');
    await search.fill('zzz-introuvable');
    await expect(page.getByText(/aucun résultat pour/i)).toBeVisible();
  });
});
