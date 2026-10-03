/**
 * SAV settle-and-deliver live loop (desktop Chromium, licensed staging profile):
 *
 *   intake (RepairWorkOrderModal UI) → Prêt / Terminé (history card UI)
 *   → [Régler & Livrer] (UI) → SAV-<ticket> cart line (UI)
 *   → Encaisser → PaymentModal Exact → Valider (UI clicks)
 *   → ticket reactively shows Livré (UI, no reload) + linkage purged.
 *
 * Surfaces checked per step: UI text, Dexie mirror (MobiPosDB.repairOrders),
 * localStorage sidecar. SQLite authority assertions are Tauri-only and
 * skipped in plain Chromium with an explicit log entry.
 *
 * Requires: dev server on E2E_BASE_URL (default http://localhost:1420),
 * `npm i -D @playwright/test`. Licensing is seeded offline (see sav-license.ts).
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { seedE2ELicense, licenseGate, isLicenseGateVisible } from './sav-license';

interface StepLog {
  step: string;
  surface: 'ui' | 'dexie' | 'sidecar' | 'skipped';
  label: string;
  actual: unknown;
  expected: unknown;
  match: boolean;
}

const findings: StepLog[] = [];
function log(step: string, surface: StepLog['surface'], label: string, actual: unknown, expected: unknown) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  findings.push({ step, surface, label, actual, expected, match });
  if (!match) {
    // eslint-disable-next-line no-console
    console.log(`[SAV-E2E] ${step} :: ${surface}.${label} = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
  }
  return match;
}

async function dexieRepairs(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const info = dbs.find((d) => d.name === 'MobiPosDB');
    if (!info?.name) return [];
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open(info.name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!Array.from(db.objectStoreNames).includes('repairOrders')) return [];
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction('repairOrders', 'readonly').objectStore('repairOrders').getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
      return rows as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  });
}

const SIDECAR_KEY = 'sav_cart_linkage_v1';

function sidecarOf(page: Page) {
  return page.evaluate((key: string) => localStorage.getItem(key), SIDECAR_KEY);
}

const scopeSAV = (page: Page) =>
  page.locator('div.fixed.inset-0').filter({ hasText: 'RÉPARATIONS & TICKETS SAV' }).first();

/**
 * Complete the schema-v2 legal record on the open intake form.
 *
 * validateRepairIntake (createRepairSlice.ts:52) fails closed unless the intake
 * carries a screen constat, a warranty tier, an accepted CGV and a customer
 * signature. Without these the save is refused BY DESIGN, so the e2e has to
 * drive the same legal fields a real operator would. Every SAV intake in this
 * spec goes through here so the two ticket-creation paths cannot drift.
 */
async function completeV2Intake(
  page: Page,
  modal: ReturnType<typeof scopeSAV>,
  tag: string
): Promise<void> {
  await modal.getByRole('button', { name: 'Fissuré', exact: true }).click();
  log(tag, 'ui', 'screen constat chosen', await modal.getByRole('button', { name: 'Fissuré', exact: true }).getAttribute('aria-pressed'), 'true');

  // WarrantyTierSelector renders role="radio" (not button) inside a radiogroup.
  const tier = modal.getByRole('radio', { name: /Garantie réparation 30 jours/ }).first();
  await tier.click();
  log(tag, 'ui', 'warranty tier chosen', await tier.getAttribute('aria-checked'), 'true');

  // SignaturePad draws from pointer events; a short mouse stroke marks it dirty.
  // The pad sits below the fold inside the modal's scroller, so it MUST be
  // scrolled into view first — page.mouse dispatches viewport coordinates and
  // would otherwise land outside the canvas, leaving the signature empty and
  // the v2 gate correctly refusing the save.
  const canvas = modal.locator('canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await canvas.boundingBox();
  expect(box, 'signature canvas has no layout box').not.toBeNull();
  await page.mouse.move(box!.x + 20, box!.y + box!.height * 0.6);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(box!.x + 20 + i * 8, box!.y + box!.height * (0.6 - (i % 2) * 0.2));
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const inked = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!c) return 0;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  expect(inked, 'signature stroke left the canvas blank — the v2 gate will refuse the save').toBeGreaterThan(0);
  log(tag, 'ui', 'signature drawn (inked pixels)', inked > 0, true);

  // Clearing the pad resets the CGV (SignaturePad onClear), so accept the
  // terms AFTER the stroke.
  const cgv = modal.getByRole('checkbox').first();
  await cgv.check();
  log(tag, 'ui', 'CGV accepted', await cgv.isChecked(), true);
}

test.describe('SAV settle-and-deliver live loop', () => {
  test.afterAll(async () => {
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync(
      path.join('test-results', 'e2e-sav-settle-log.json'),
      JSON.stringify({ at: new Date().toISOString(), findings }, null, 2)
    );
    const bad = findings.filter(
      (f) => !f.match && f.surface !== 'skipped' && !f.step.startsWith('diag-')
    );
    // eslint-disable-next-line no-console
    console.log(`[SAV-E2E] ${findings.length - bad.length}/${findings.length} checks match; hard failures: ${bad.length}`);
  });

  test('intake → settle → pay → Livré (reactive, no reload)', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 300)));
    const dumpDiagnostics = async (tag: string) => {
      const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 1200);
      findings.push({
        step: `diag-${tag}`, surface: 'ui', label: 'body snapshot',
        actual: bodyText, expected: 'see-log',
      });
      if (consoleErrors.length > 0 || pageErrors.length > 0) {
        findings.push({
          step: `diag-${tag}`, surface: 'ui', label: 'console/page errors',
          actual: [...consoleErrors, ...pageErrors].slice(-10), expected: [],
        });
      }
    };
    await seedE2ELicense(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    log('boot', 'ui', 'license gate absent', await isLicenseGateVisible(page), false);
    await expect(licenseGate(page)).toHaveCount(0);

    // --- 0a. First-run team onboarding (fresh profile only) ---
    // NOTE: it mounts late (after license check + DB init), so wait for it
    // explicitly instead of racing a point-in-time count.
    const onboardingTitle = page.getByText('Configuration initiale');
    await onboardingTitle.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
    if ((await onboardingTitle.count()) > 0) {
      // Manager PIN must satisfy MANAGER_PIN_RE = /^\d{6,32}$/ (App.tsx:129) —
      // a 4-digit default is rejected outright by first-boot setup.
      await page.getByLabel('PIN gérant (6 chiffres minimum)', { exact: true }).fill('789012');
      await page.getByLabel('Confirmer le PIN', { exact: true }).fill('789012');
      for (const [name, pin] of [['Amine', '1212'], ['Karim', '3434']] as const) {
        const pinInput = page.getByLabel(`Code PIN de ${name}`, { exact: true });
        if ((await pinInput.count()) > 0) await pinInput.fill(pin);
      }
      await page.getByRole('button', { name: /Enregistrer l'équipe et déverrouiller/ }).click();
      await expect(onboardingTitle).toHaveCount(0, { timeout: 30000 });
    }
    log('onboarding', 'ui', 'team setup dismissed', await page.getByText('Configuration initiale').count(), 0);

    // --- 0a2. Lock screen (fresh profile locks after team setup) ---
    // Global key handler captures digits; auto-submit fires at the target
    // length for the selected profile (6 manager / 4 cashier).
    const lockPrompt = page.getByText('SÉLECTIONNEZ VOTRE COMPTE CAISSIER');
    await lockPrompt.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
    if ((await lockPrompt.count()) > 0) {
    // Native PIN field owns entry (autofocused) — the field auto-submits once
    // it reaches targetPinLength, which is 6 for a manager profile.
    await page.getByLabel('Code PIN de connexion').fill('789012');
      await expect(lockPrompt).toHaveCount(0, { timeout: 20000 });
    }
    log('lock', 'ui', 'till unlocked', await lockPrompt.count(), 0);

    // --- 0b. Shift must be open for checkout ---
    if ((await page.getByRole('button', { name: 'Ouvrir Caisse' }).count()) > 0) {
      await page.getByRole('button', { name: 'Ouvrir Caisse' }).click();
      await page.getByRole('button', { name: 'Montant Direct' }).click();
      await page.getByPlaceholder('20 000 DA').fill('20000');
      await page.getByRole('button', { name: 'Valider & Ouvrir la Session Caisse' }).click();
      await expect(page.getByRole('button', { name: 'Ouvrir Caisse' })).toHaveCount(0, { timeout: 20000 });
    }
    log('shift', 'ui', 'shift open (Ouvrir Caisse gone)', await page.getByRole('button', { name: 'Ouvrir Caisse' }).count(), 0);

    // --- 1. Intake via modal UI ---
    const uniqueName = `E2E SAV ${Date.now().toString(36).toUpperCase()}`;
    await page.getByTitle('Gestion des Réparations & Tickets SAV').click();
    const modal = scopeSAV(page);
    await expect(modal.getByText('Nouveau Ticket SAV')).toBeVisible({ timeout: 20000 });

    await modal.getByPlaceholder('Ex: Yacine Benali').fill(uniqueName);
    await modal.getByPlaceholder('Ex: 0550 12 34 56').fill('0555123456');
    log('intake', 'ui', 'phone live mask', await modal.getByPlaceholder('Ex: 0550 12 34 56').inputValue(), '05 55 12 34 56');
    await modal.getByPlaceholder('Ex: iPhone 15 Pro Max').fill('Galaxy E2E A55');
    const imeiInput = modal.getByPlaceholder('Scanner ou 15 chiffres…');
    await imeiInput.fill('490154203237518');
    await imeiInput.press('Tab'); // blur → Luhn + warranty lookup
    await expect(modal.getByText('IMEI valide')).toBeVisible({ timeout: 10000 });
    log('intake', 'ui', 'Luhn green badge', await modal.getByText('IMEI valide').count(), 1);
    await modal.getByPlaceholder('Ex: écran fissuré + connecteur de charge cassé').fill('Écran E2E fissuré');
    const numbers = modal.locator('input[type="number"]');
    await numbers.nth(0).fill('2000'); // labor
    await numbers.nth(1).fill('3000'); // parts
    await numbers.nth(2).fill('1500'); // deposit

    // --- 1b. Complete the schema-v2 legal record -------------------------
    await completeV2Intake(page, modal, 'intake');

    await modal.getByRole('button', { name: /Enregistrer le Ticket SAV/ }).click();
    // Durable signal (the success pill is transient ~3s): history count flips to 1.
    await expect(modal.getByRole('button', { name: /Historique Atelier \(1\)/ })).toBeVisible({ timeout: 20000 });
    log('intake', 'ui', 'ticket persisted (history count 1)', await modal.getByRole('button', { name: /Historique Atelier \(1\)/ }).count(), 1);

    // --- 2. History → capture ticket → Prêt / Terminé ---
    await modal.getByRole('button', { name: /Historique Atelier/ }).click();
    await modal.getByPlaceholder(/Rechercher par N° Ticket/).fill(uniqueName);
    const card = modal.locator('div.rounded-2xl', { hasText: uniqueName }).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    const cardText = (await card.innerText()) ?? '';
    const ticket = cardText.match(/REP-[A-Z0-9-]+/)?.[0] ?? '';
    log('intake', 'ui', 'ticket chip captured', typeof ticket === 'string' && ticket.startsWith('REP-'), true);
    expect(ticket.startsWith('REP-')).toBe(true);
    await card.locator('select').selectOption('Prêt / Terminé');
    await expect(card.getByRole('button', { name: 'Régler & Livrer' })).toBeVisible({ timeout: 10000 });

    // --- 3. Régler & Livrer → SAV- line lands in cart ---
    await card.getByRole('button', { name: 'Régler & Livrer' }).click();
    const cartLine = page.getByText(new RegExp(`Solde Réparation ${ticket.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`));
    await expect(cartLine.first()).toBeVisible({ timeout: 15000 });
    log('settle', 'ui', 'SAV- cart line visible', (await cartLine.count()) >= 1, true);
    const rawSidecar = await sidecarOf(page);
    const parsed = rawSidecar ? (JSON.parse(rawSidecar) as Record<string, string>) : null;
    const linkedIds = parsed ? Object.values(parsed) : [];
    log('settle', 'sidecar', 'linkage maps a cart line', parsed !== null && linkedIds.length > 0, true);
    expect(linkedIds.length).toBeGreaterThan(0);
    const dexiePre = (await dexieRepairs(page)).find((r) => r.ticketNumber === ticket);
    log('settle', 'dexie', 'status still Prêt before payment', dexiePre?.status, 'Prêt / Terminé');
    expect(dexiePre?.status).toBe('Prêt / Terminé');

    // --- 4. DISCARD: drop the SAV line → linkage purged, stays Prêt ---
    // (single line in cart → its remove button is unique on the page)
    await page.getByTitle('Supprimer cet article de la vente').first().click();
    await expect(cartLine.first()).toHaveCount(0, { timeout: 15000 });
    const afterDiscard = await sidecarOf(page);
    const afterDiscardParsed = afterDiscard ? (JSON.parse(afterDiscard) as Record<string, unknown>) : null;
    log('discard', 'sidecar', 'linkage purged on line removal', afterDiscardParsed === null || Object.keys(afterDiscardParsed).length === 0, true);
    expect(afterDiscardParsed === null || Object.keys(afterDiscardParsed).length === 0).toBe(true);
    const dexieKept = (await dexieRepairs(page)).find((r) => r.ticketNumber === ticket);
    log('discard', 'dexie', 'stays Prêt after discard (no phantom delivery)', dexieKept?.status, 'Prêt / Terminé');
    expect(dexieKept?.status).toBe('Prêt / Terminé');

    // --- 5. PAYMENT BOUNDARY (plain Chromium): SQLite authority is Tauri-only,
    // so writeCheckoutAtomic fail-closes. The invariant under test: a failed
    // payment must NOT deliver, must NOT clear the cart, must NOT purge linkage.
    await page.getByTitle('Gestion des Réparations & Tickets SAV').click();
    const modalSettle = scopeSAV(page);
    await modalSettle.getByRole('button', { name: /Historique Atelier/ }).click();
    await modalSettle.getByPlaceholder(/Rechercher par N° Ticket/).fill(uniqueName);
    const cardSettle = modalSettle.locator('div.rounded-2xl', { hasText: uniqueName }).first();
    await cardSettle.getByRole('button', { name: 'Régler & Livrer' }).click();
    await expect(cartLine.first()).toBeVisible({ timeout: 15000 });
    await page.getByTitle('Encaisser ou Rembourser en Espèces - F2 / Espace').click();
    const payModal = page
      .locator('div.fixed.inset-0')
      .filter({ hasText: 'Valider & Imprimer Reçu' })
      .first();
    await expect(payModal.getByRole('button', { name: 'Exact' })).toBeVisible({ timeout: 15000 });
    await payModal.getByRole('button', { name: 'Exact' }).click();
    await payModal.getByRole('button', { name: 'Valider & Imprimer Reçu' }).click();
    // Give the atomic write (+8× busy-retry) room to fail closed.
    // Failure toasts portal to document.body (outside the modal root).
    await expect(page.getByText(/Écriture SQLite en échec|Erreur d'écriture|Échec de validation/i).first()).toBeVisible({ timeout: 45000 });
    await dumpDiagnostics('post-valider-refused');
    const stillThere = await cartLine.count();
    log('pay-boundary', 'ui', 'cart intact after refused payment', stillThere >= 1, true);
    expect(stillThere).toBeGreaterThanOrEqual(1);
    const dexieRefused = (await dexieRepairs(page)).find((r) => r.ticketNumber === ticket);
    log('pay-boundary', 'dexie', 'still Prêt after refused payment', dexieRefused?.status, 'Prêt / Terminé');
    expect(dexieRefused?.status).toBe('Prêt / Terminé');
    const linkRefused = await sidecarOf(page);
    log('pay-boundary', 'sidecar', 'linkage intact after refused payment', linkRefused !== null && Object.keys(JSON.parse(linkRefused)).length > 0, true);
    await payModal.getByRole('button', { name: /Annuler/ }).click();
    log('pay-boundary', 'skipped', 'live payment→Livré (Tauri-only SQLite)', 'fail-closed in plain Chromium by design', 'run under Tauri/CI or on-device');

    // --- 6. ZERO-BALANCE: 100% deposit → 1-click direct Livré (no cart) ---
    page.on('dialog', (d) => void d.accept());
    const zeroName = `${uniqueName}-SOLDÉ`;
    await page.getByTitle('Gestion des Réparations & Tickets SAV').click();
    const modalZero = scopeSAV(page);
    await modalZero.getByPlaceholder('Ex: Yacine Benali').fill(zeroName);
    await modalZero.getByPlaceholder('Ex: 0550 12 34 56').fill('0555123456');
    await modalZero.getByPlaceholder('Ex: iPhone 15 Pro Max').fill('Galaxy E2E A55');
    await modalZero.getByPlaceholder('Scanner ou 15 chiffres…').fill('490154203237518');
    await modalZero.getByPlaceholder('Ex: écran fissuré + connecteur de charge cassé').fill('Écran E2E soldé');
    const numbersZero = modalZero.locator('input[type="number"]');
    await numbersZero.nth(0).fill('2000');
    await numbersZero.nth(1).fill('3000');
    await numbersZero.nth(2).fill('5000'); // 100% deposit → remaining 0
    await completeV2Intake(page, modalZero, 'zero-intake');
    await modalZero.getByRole('button', { name: /Enregistrer le Ticket SAV/ }).click();
    await expect(modalZero.getByRole('button', { name: /Historique Atelier \(2\)/ })).toBeVisible({ timeout: 20000 });
    await modalZero.getByRole('button', { name: /Historique Atelier/ }).click();
    await modalZero.getByPlaceholder(/Rechercher par N° Ticket/).fill(zeroName);
    const cardZero = modalZero.locator('div.rounded-2xl', { hasText: zeroName }).first();
    await expect(cardZero).toBeVisible({ timeout: 15000 });
    const zeroText = (await cardZero.innerText()) ?? '';
    const zeroTicket = zeroText.match(/REP-[A-Z0-9-]+/)?.[0] ?? '';
    expect(zeroTicket.startsWith('REP-')).toBe(true);
    await cardZero.locator('select').selectOption('Prêt / Terminé');
    await cardZero.getByRole('button', { name: 'Régler & Livrer' }).click(); // confirm() auto-accepted
    // History cards surface status through the per-card <select> (no badge span here).
    await expect(cardZero.locator('select')).toHaveValue('Livré', { timeout: 15000 });
    log('zero', 'ui', 'Livré status reactive, no cart, no reload', await cardZero.locator('select').inputValue(), 'Livré');
    const dexieZero = (await dexieRepairs(page)).find((r) => r.ticketNumber === zeroTicket);
    log('zero', 'dexie', 'status Livré (zero-balance bypass)', dexieZero?.status, 'Livré');
    expect(dexieZero?.status).toBe('Livré');
    log('zero', 'skipped', 'SQLite authority (Tauri-only)', 'plain Chromium: Dexie is the lane', 'run under Tauri/CI');
  }, { timeout: 300000 });
});
