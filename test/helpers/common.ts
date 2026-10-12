import { browser, $ } from '@wdio/globals';

export const APP_PIN = '202020';

/**
 * Ensures any open modal or overlay is dismissed via Escape
 */
export async function dismissAllModals(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await browser.keys(['Escape']);
    await browser.pause(150);
  }
}

/**
 * Clear existing crash telemetry logs from previous runs
 */
export async function clearCrashReports(): Promise<void> {
  await browser.execute(() => {
    const fn = (window as unknown as { __mobipos_clearCrashReports?: () => void }).__mobipos_clearCrashReports;
    if (typeof fn === 'function') fn();
  });
}

/**
 * Handle PIN dialog or lock screen if presented using 202020
 */
/**
 * Handle PIN dialog or lock screen if presented using 202020
 */
export async function handlePinGateIfPresent(): Promise<void> {
  // Check PinDialog (manager authorization / forced sale / shift)
  const pinInput = await $('input[aria-label*="Code PIN"], input[aria-label*="PIN manager"]');
  if (await pinInput.isDisplayed().catch(() => false)) {
    await pinInput.setValue(APP_PIN);
    const validerBtn = await $('button=Valider');
    if (await validerBtn.isDisplayed().catch(() => false)) {
      await validerBtn.click();
    } else {
      await browser.keys(['Enter']);
    }
    await browser.pause(400);
  }

  // Check LockScreenOverlay
  const lockInput = await $('input[placeholder="••••"]');
  if (await lockInput.isDisplayed().catch(() => false)) {
    await lockInput.setValue(APP_PIN);
    await browser.keys(['Enter']);
    await browser.pause(400);
  }
}

/**
 * Add an available in-stock product to cart, handling PIN gate if out-of-stock
 */
export async function addProductToCart(): Promise<void> {
  // Directly target an in-stock tile to avoid slow multi-element iterations
  const inStockTile = await $('.pos-tile:not([aria-label*="Rupture"])');
  if (await inStockTile.isDisplayed().catch(() => false)) {
    await inStockTile.click();
  } else {
    const anyTile = await $('.pos-tile');
    await anyTile.click();
  }
  await browser.pause(300);
  await handlePinGateIfPresent();
}

/**
 * Check crash reports via telemetry buffer
 */
export async function assertZeroCrashes(): Promise<void> {
  const reports = await browser.execute(() => {
    const fn = (window as unknown as { __mobipos_getCrashReports?: () => unknown[] }).__mobipos_getCrashReports;
    return typeof fn === 'function' ? fn() : [];
  });
  if (reports && reports.length > 0) {
    throw new Error(`Crash telemetry captured unhandled errors: ${JSON.stringify(reports)}`);
  }
}
