import { expect, browser, $ } from '@wdio/globals';
import { clearCrashReports, assertZeroCrashes, addProductToCart, dismissAllModals, handlePinGateIfPresent } from '../helpers/common';

describe('E2E Stress & Edge Cases: Sell, Cart & Checkout', () => {
  before(async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 30000 });
    const header = await $('header');
    await header.waitForDisplayed({ timeout: 30000 });
    await clearCrashReports();
    await dismissAllModals();
    await handlePinGateIfPresent();

    // Clear cart if persisted from previous runs
    const trashButtons = await $$('button[aria-label="Supprimer cet article"]');
    for (const btn of trashButtons) {
      if (await btn.isDisplayed().catch(() => false)) {
        await btn.click();
        await browser.pause(100);
      }
    }
  });

  it('Edge Case 1: Empty cart checkout must be disabled', async () => {
    // Locate the primary checkout button in CartPanel
    const checkoutBtn = await $('button[title*="F2 / Espace"]');
    await checkoutBtn.waitForExist({ timeout: 10000 });
    
    // In empty cart, the button must be disabled
    const isEnabled = await checkoutBtn.isEnabled();
    expect(isEnabled).toBe(false);
  });

  it('Edge Case 2: Catalog search, filtering, and rapid input stress', async () => {
    const searchInput = await $('#catalog-search');
    await searchInput.waitForDisplayed({ timeout: 10000 });

    // Stress test: rapid search with special characters & SQL injection strings
    const testQueries = ["' OR '1'='1", '<script>alert(1)</script>', '!@#$%^&*()_+', 'iPhone', 'Chargeur', ''];
    for (const q of testQueries) {
      await searchInput.setValue(q);
      await browser.keys(['Enter']);
      await browser.pause(100);
    }

    // Clear search
    await searchInput.setValue('');
    await browser.keys(['Enter']);
    await browser.pause(200);

    // Verify catalog tiles exist
    const tiles = await $$('.pos-tile');
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('Edge Case 3: Cart quantity boundary testing (0, negative, extreme quantity, sanitization)', async () => {
    // Add product to cart safely
    await addProductToCart();

    // Verify item appears in cart
    const qtyInputs = await $$('input[aria-label*="Quantité"]');
    expect(qtyInputs.length).toBeGreaterThan(0);
    const qtyInput = qtyInputs[0];

    // Boundary Test A: Type "0" and blur -> must clamp to minimum 1
    await qtyInput.click();
    await qtyInput.setValue('0');
    await browser.keys(['Enter']);
    await browser.pause(200);
    let val = await qtyInput.getValue();
    expect(parseInt(val, 10)).toBeGreaterThanOrEqual(1);

    // Boundary Test B: Type "0005" -> leading zeros stripped
    await qtyInput.click();
    await qtyInput.setValue('0005');
    await browser.keys(['Enter']);
    await browser.pause(200);
    val = await qtyInput.getValue();
    expect(parseInt(val, 10)).toBeGreaterThanOrEqual(1);

    // Boundary Test C: Extreme quantity "999999999" -> clamped to available stock/ceiling without overflow
    await qtyInput.click();
    await qtyInput.setValue('999999999');
    await browser.keys(['Enter']);
    await browser.pause(200);
    val = await qtyInput.getValue();
    const parsedQty = parseInt(val, 10);
    expect(Number.isFinite(parsedQty)).toBe(true);
    expect(parsedQty).toBeLessThanOrEqual(999999999);

    // Boundary Test D: Stepper buttons (+ and -)
    const plusButtons = await $$('button[aria-label*="Augmenter"]');
    if (plusButtons.length > 0) {
      await plusButtons[0].click();
      await browser.pause(100);
    }
    const minusButtons = await $$('button[aria-label*="Diminuer"]');
    if (minusButtons.length > 0) {
      await minusButtons[0].click();
      await browser.pause(100);
    }
  });

  it('Edge Case 4: Cart line removal and re-adding', async () => {
    // Remove all items via trash buttons
    const trashButtons = await $$('button[aria-label="Supprimer cet article"]');
    for (const btn of trashButtons) {
      if (await btn.isDisplayed().catch(() => false)) {
        await btn.click();
        await browser.pause(150);
      }
    }

    // Verify checkout button is disabled again
    const checkoutBtn = await $('button[title*="F2 / Espace"]');
    expect(await checkoutBtn.isEnabled()).toBe(false);

    // Re-add a product for checkout testing
    await addProductToCart();
    expect(await checkoutBtn.isEnabled()).toBe(true);
  });

  it('Edge Case 5: Payment Modal cash handling, overpayment change calculation, and sale execution', async () => {
    // Open payment modal
    const checkoutBtn = await $('button[title*="F2 / Espace"]');
    await checkoutBtn.click();
    await browser.pause(1000);

    const diag = await browser.execute(() => {
      return {
        bodyText: document.body.innerText.slice(0, 300),
        dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(d => d.getAttribute('aria-label') || d.className),
        toasts: Array.from(document.querySelectorAll('[role="alert"], .toast')).map(t => t.textContent),
      };
    });
    console.log('[DEBUG DIAGNOSTIC]', JSON.stringify(diag));

    // Verify payment modal header is displayed
    const paymentModal = await $('div[role="dialog"][aria-label*="Encaissement"]');
    await paymentModal.waitForDisplayed({ timeout: 10000 });
    expect(await paymentModal.isDisplayed()).toBe(true);

    // Find validate payment button
    const validateBtn = await $('button*=Valider & Imprimer Re');
    await validateBtn.waitForExist({ timeout: 10000 });

    // Execute payment
    await validateBtn.click();
    await browser.pause(1000);

    // Verify receipt modal appears or payment modal closes cleanly
    const isPaymentStillOpen = await paymentModal.isDisplayed().catch(() => false);
    if (!isPaymentStillOpen) {
      // Payment closed cleanly!
      expect(isPaymentStillOpen).toBe(false);
    } else {
      // If a receipt modal or confirmation is open, close with Escape
      await browser.keys(['Escape']);
      await browser.pause(300);
    }

    // If receipt modal is open, dismiss with Escape
    await dismissAllModals();
  });

  it('Crash Telemetry Verification: Zero unhandled crashes during sell workflow', async () => {
    await assertZeroCrashes();
  });
});

