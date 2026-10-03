/**
 * Shared e2e bootstrap: drive a fresh browser profile to a usable till.
 *
 * A clean Playwright context has empty localStorage, so the app always comes
 * up through the same first-run sequence: license gate → team onboarding →
 * lock screen → closed shift. Every spec that needs to reach real UI must walk
 * that path, and the steps encode policy that changes (the manager PIN minimum
 * is 6 digits, App.tsx:129), so they live in ONE place rather than drifting
 * per spec.
 *
 * Each step is guarded because a context may be reused or partially onboarded:
 * an absent step is already satisfied.
 */
import { expect, type Page } from '@playwright/test';
import { seedE2ELicense, isLicenseGateVisible } from './sav-license';

/** Satisfies MANAGER_PIN_RE = /^\d{6,32}$/ (App.tsx:129). */
export const E2E_MANAGER_PIN = '789012';

export async function bootstrapUnlockedTill(page: Page): Promise<void> {
  await seedE2ELicense(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // The licensing stub answers 200, so the fail-closed gate must stay away.
  await expect
    .poll(() => isLicenseGateVisible(page), { timeout: 30000 })
    .toBe(false);

  // First-run team onboarding. Mounts late (after license + DB init), so wait
  // for it rather than racing a point-in-time count.
  const onboardingTitle = page.getByText('Configuration initiale');
  await onboardingTitle.waitFor({ state: 'visible', timeout: 45000 }).catch(() => {});
  if ((await onboardingTitle.count()) > 0) {
    await page.getByLabel('PIN gérant', { exact: true }).fill(E2E_MANAGER_PIN);
    await page.getByLabel('Confirmer le PIN gérant', { exact: true }).fill(E2E_MANAGER_PIN);
    for (const [name, pin] of [['Amine', '1212'], ['Karim', '3434']] as const) {
      const pinInput = page.getByLabel(`Code PIN de ${name}`, { exact: true });
      if ((await pinInput.count()) > 0) await pinInput.fill(pin);
    }
    await page.getByRole('button', { name: /Enregistrer l'équipe et déverrouiller/ }).click();
    await expect(onboardingTitle).toHaveCount(0, { timeout: 30000 });
  }

  // Lock screen: cashiers auto-submit at fixed length, but managers MUST
  // confirm with Valider (variable 6–8 digit PINs never auto-submit —
  // LockScreenOverlay.tsx:64-68). Filling without clicking leaves the
  // overlay mounted forever.
  const lockPrompt = page.getByText('SÉLECTIONNEZ VOTRE COMPTE CAISSIER');
  await lockPrompt.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  if ((await lockPrompt.count()) > 0) {
    await page.getByLabel('Code PIN de connexion').fill(E2E_MANAGER_PIN);
    await page.getByRole('button', { name: /Valider/ }).click();
    await expect(lockPrompt).toHaveCount(0, { timeout: 20000 });
  }

  // Checkout requires an open shift.
  if ((await page.getByRole('button', { name: 'Ouvrir Caisse' }).count()) > 0) {
    await page.getByRole('button', { name: 'Ouvrir Caisse' }).click();
    await page.getByRole('button', { name: 'Montant Direct' }).click();
    await page.getByPlaceholder('20 000 DA').fill('20000');
    await page.getByRole('button', { name: 'Valider & Ouvrir la Session Caisse' }).click();
    await expect(page.getByRole('button', { name: 'Ouvrir Caisse' })).toHaveCount(0, { timeout: 20000 });
  }
}
