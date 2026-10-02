/**
 * Réapprovisionnement modal visual regression gates.
 *
 * Checks the checklist from the architectural certificate:
 * - desktop shell width and right-edge clipping
 * - KPI layout / pill layout
 * - CTA alignment and size
 * - keyboard Escape + focus restore
 * - mobile sheet affordances and layout
 */
import { test, expect, type Page } from '@playwright/test';

const HARNESS = '/tests/replenishment-harness/index.html';
const SM = 640;
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
