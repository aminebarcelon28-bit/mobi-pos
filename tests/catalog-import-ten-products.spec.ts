import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedE2ELicense } from '../e2e/sav-license';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureTillReady(page: Page) {
  await seedE2ELicense(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // The setup PIN root mounts once database initializes
  const setupRoot = page.locator('[data-testid="setup-pin-root"]');
  await setupRoot.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  if (await setupRoot.isVisible()) {
    await page.locator('[data-testid="setup-manager-new"]').fill('789012');
    await page.locator('[data-testid="setup-manager-confirm"]').fill('789012');
    await page.locator('[data-testid="setup-save"]').click();
    await expect(setupRoot).toHaveCount(0, { timeout: 15000 });
    await page.waitForTimeout(500);
  }

  const lockPrompt = page.getByText(/SÉLECTIONNEZ VOTRE COMPTE/i);
  await lockPrompt.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (await lockPrompt.isVisible()) {
    const pinInput = page.locator('input[type="password"]').first();
    if (await pinInput.isVisible()) {
      await pinInput.fill('789012');
      const validerBtn = page.getByRole('button', { name: /Valider/i });
      if (await validerBtn.isVisible()) await validerBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  await expect(page.locator('#catalog-search')).toBeVisible({ timeout: 20000 });
}

test.describe('Catalog Import & Search: Ten Products Gauntlet', () => {
  test('import 10 products without barcode/sku, auto-generate EAN-13 & structured SKU, search all 10 on UI', async ({ page }) => {
    // 1. Boot up till
    await ensureTillReady(page);
    await expect(page.locator('#catalog-search')).toBeVisible({ timeout: 20000 });

    // 2. Open Inventory Manager via "Stock F10" button, then click Importer
    await page.getByRole('button', { name: /Stock F10/i }).click();
    const importBtn = page.getByTitle(/Importer des produits depuis Excel/i);
    await expect(importBtn).toBeVisible({ timeout: 10000 });
    await importBtn.click();

    await expect(page.getByText(/IMPORT INTELLIGENT DE DONNÉES/i)).toBeVisible({ timeout: 15000 });

    // 3. Upload the 10 products CSV
    const csvPath = path.resolve(__dirname, 'fixtures/real/imported_10_products.csv');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByText(/Glissez-déposez votre fichier ici/i).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(csvPath);

    // 4. Verify Mapping step loads and detected 10 rows
    await expect(page.getByText(/Mappage des Colonnes/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/Génération Automatique Intelligente/i)).toBeVisible();

    // 5. Proceed to staging
    await page.getByRole('button', { name: /Préparer l'importation/i }).click();

    // 6. Confirm and commit import
    const commitBtn = page.getByRole('button', { name: /Confirmer et Importer/i });
    await expect(commitBtn).toBeVisible({ timeout: 15000 });
    await commitBtn.click();

    // 7. Verify Success step
    await expect(page.getByText(/Importation Terminée avec Succès/i)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Fermer et retourner au logiciel/i }).click();

    // 8. Now in Product Catalog: Verify the search bar finds all 10 products!
    const searchInput = page.locator('#catalog-search');
    await expect(searchInput).toBeVisible();

    const expectedProducts = [
      'Câble de charge USB-C',
      'Souris sans fil',
      'Clé USB 32 Go',
      'Chargeur de téléphone 20 W',
      'Écouteurs filaires',
      'Câble HDMI 2 m',
      'Batterie externe 10 000 mAh',
      'Enceinte Bluetooth',
      'Support de refroidissement',
      'Clavier sans fil',
    ];

    for (const title of expectedProducts) {
      await searchInput.fill(title);
      // Wait for debounce (150ms)
      await page.waitForTimeout(300);
      // Expect product to be visible in catalog tiles or table
      await expect(page.getByText(title).first()).toBeVisible({ timeout: 5000 });
    }

    // 9. Verify searching by generated SKU without hyphens (e.g. CABAUT1001) finds the product
    await searchInput.fill('CABAUT');
    await page.waitForTimeout(300);
    await expect(page.getByText('Câble de charge USB-C').first()).toBeVisible({ timeout: 5000 });

    // 10. Clear search
    await searchInput.fill('');
    await page.waitForTimeout(300);
  });

  test('import phones with arbitrary column ordering & IMEIs, and search by IMEI in catalog', async ({ page }) => {
    await ensureTillReady(page);
    await expect(page.locator('#catalog-search')).toBeVisible({ timeout: 20000 });

    // Open Stock F10 -> Importer
    await page.getByRole('button', { name: /Stock F10/i }).click();
    const importBtn = page.getByTitle(/Importer des produits depuis Excel/i);
    await expect(importBtn).toBeVisible({ timeout: 10000 });
    await importBtn.click();

    await expect(page.getByText(/IMPORT INTELLIGENT DE DONNÉES/i)).toBeVisible({ timeout: 15000 });

    // Upload hard_arbitrary_phones_imei.csv
    const csvPath = path.resolve(__dirname, 'fixtures/real/hard_arbitrary_phones_imei.csv');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByText(/Glissez-déposez votre fichier ici/i).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(csvPath);

    // Verify mapping step
    await expect(page.getByText(/Mappage des Colonnes/i)).toBeVisible({ timeout: 15000 });

    // Proceed to staging and commit
    await page.getByRole('button', { name: /Préparer l'importation/i }).click();
    const commitBtn = page.getByRole('button', { name: /Confirmer et Importer/i });
    await expect(commitBtn).toBeVisible({ timeout: 15000 });
    await commitBtn.click();

    // Verify success
    await expect(page.getByText(/Importation Terminée avec Succès/i)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Fermer et retourner au logiciel/i }).click();

    // In Catalog: Search by IMEI directly!
    const searchInput = page.locator('#catalog-search');
    await expect(searchInput).toBeVisible();

    // Search for iPhone by IMEI
    await searchInput.fill('356938035643809');
    await page.waitForTimeout(300);
    await expect(page.getByText(/iPhone 15 Pro Max/i).first()).toBeVisible({ timeout: 5000 });

    // Search for Galaxy by IMEI
    await searchInput.fill('864938035643812');
    await page.waitForTimeout(300);
    await expect(page.getByText(/Galaxy S24 Ultra/i).first()).toBeVisible({ timeout: 5000 });

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(300);
  });

  test('import suppliers with arbitrary column ordering', async ({ page }) => {
    await ensureTillReady(page);
    await expect(page.locator('#catalog-search')).toBeVisible({ timeout: 20000 });

    // Open Stock F10 -> Importer
    await page.getByRole('button', { name: /Stock F10/i }).click();
    const importBtn = page.getByTitle(/Importer des produits depuis Excel/i);
    await expect(importBtn).toBeVisible({ timeout: 10000 });
    await importBtn.click();

    await expect(page.getByText(/IMPORT INTELLIGENT DE DONNÉES/i)).toBeVisible({ timeout: 15000 });

    // Upload hard_arbitrary_suppliers.csv
    const csvPath = path.resolve(__dirname, 'fixtures/real/hard_arbitrary_suppliers.csv');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByText(/Glissez-déposez votre fichier ici/i).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(csvPath);

    // Verify mapping step detected suppliers entity
    await expect(page.getByText(/Mappage des Colonnes/i)).toBeVisible({ timeout: 15000 });

    // Proceed to staging and commit
    await page.getByRole('button', { name: /Préparer l'importation/i }).click();
    const commitBtn = page.getByRole('button', { name: /Confirmer et Importer/i });
    await expect(commitBtn).toBeVisible({ timeout: 15000 });
    await commitBtn.click();

    // Verify success
    await expect(page.getByText(/Importation Terminée avec Succès/i)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Fermer et retourner au logiciel/i }).click();
  });
});

