/**
 * DzPhoneInput keystroke regression gates — the three reported UX bugs:
 *  1. leading zero swallowed (typing `06…` impossible),
 *  2. cursor jumping mid-string during live formatting,
 *  3. over-typing past the digit ceiling.
 *
 * Mounts the real SAV intake modal through the tests/harness entry (same
 * components, same store, production styles) and drives it with genuine
 * key events (`pressSequentially`), so the keydown guard, the change
 * commit path and the rAF caret restore are all exercised — `fill()` alone
 * would bypass the guard.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

const HARNESS = '/tests/harness/index.html';
const PHONE_PLACEHOLDER = 'Ex: 0550 12 34 56';

async function openRepair(page: Page) {
  await page.goto(`${HARNESS}?modal=repair&theme=light`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30_000 });
}

function phone(page: Page): Locator {
  return page.getByPlaceholder(PHONE_PLACEHOLDER);
}

async function caret(page: Page): Promise<number> {
  return page.evaluate((placeholder) => {
    const el = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    return el?.selectionStart ?? -1;
  }, PHONE_PLACEHOLDER);
}

test.describe('DzPhoneInput keystroke behavior', () => {
  test('leading zero stays visible and sequential typing keeps caret at end', async ({ page }) => {
    await openRepair(page);
    const input = phone(page);
    await input.click();
    await input.pressSequentially('0', { delay: 15 });
    await expect(input).toHaveValue('0');
    expect(await caret(page)).toBe(1);

    await input.pressSequentially('550123456', { delay: 15 });
    await expect(input).toHaveValue('05 50 12 34 56');
    // Caret parked at the end — never stranded mid-string.
    expect(await caret(page)).toBe('05 50 12 34 56'.length);
    // Live operator badge for the 05 prefix.
    await expect(page.getByText('Ooredoo').first()).toBeVisible();
  });

  test('over-typing past the ceiling is visibly rejected', async ({ page }) => {
    await openRepair(page);
    const input = phone(page);
    await input.click();
    await input.pressSequentially('0550123456', { delay: 10 });
    await expect(input).toHaveValue('05 50 12 34 56');
    // Three extra digits: none may enter state OR the DOM.
    await input.pressSequentially('999', { delay: 10 });
    await expect(input).toHaveValue('05 50 12 34 56');
    expect(await caret(page)).toBe('05 50 12 34 56'.length);
  });

  test('mid-string insert preserves a sane caret (no jump to end/start)', async ({ page }) => {
    await openRepair(page);
    const input = phone(page);
    await input.fill('05501');
    await expect(input).toHaveValue('05 50 1');
    // Caret between `0` and `5 50 1`, then insert `6`.
    await input.evaluate((el: HTMLInputElement) => {
      el.focus();
      el.setSelectionRange(1, 1);
    });
    await page.keyboard.press('6');
    await expect(input).toHaveValue('06 55 01');
    // After the 2nd digit — where the keystroke landed — not 0, not end.
    expect(await caret(page)).toBe(2);
  });
});
