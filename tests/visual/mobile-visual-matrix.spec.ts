import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * MOBILE VISUAL & LAYOUT MATRIX SUITE — Phase P3/P5 (UI/UX Strike Team)
 *
 * Exercises `/tests/mobile-harness/index.html` across:
 *   - Viewports & Platforms:
 *       * Pixel 8 (`412×915`, `platform=android`)
 *       * iPhone 15 (`393×852`, `platform=ios`)
 *       * Tablet / Foldable (`840×1100`, `platform=android`)
 *       * Mobile Landscape (`852×393`, `platform=android`)
 *   - Themes: `dark`, `light`
 *   - Locales / Directions: `fr` (`dir="ltr"`), `ar` (`dir="rtl"`)
 *   - Screens: `activity`, `checkout`, `catalog`, `kredy`, `management`,
 *              `diagnostics`, `pairing`, `printer`, `scanner`,
 *              `cart-protection`, `lock-screen`
 *   - States: `populated`, `empty`, `loading`, `error`, `offline`,
 *             `sync-pending`, `degraded-tamper`, `degraded-unauthenticated`,
 *             `degraded-clock`
 *   - P5 Hardening Suites:
 *       * 200% Text / Large Font-Scale Spot Check (checkout & kredy)
 *       * `prefers-reduced-motion: reduce` Spot Check
 *       * Keyboard-Open (`visualViewport`) Bottom-Nav Hide & Input Accessibility
 *       * ADR-001 5-Tab Compact Nav, >=840px Rail + 2-Pane Split, and LIFO Back-Stack
 *
 * Writes current screenshots to `artifacts/ui-team/screens/current/` and enforces:
 *   1. Zero uncaught harness errors (`window.__harnessError === null`)
 *   2. Root platform & locale/direction invariants (`data-platform`, `lang`, `dir`)
 *   3. Zero horizontal overflow (`scrollWidth <= clientWidth + 1`)
 *   4. Mobile input font-size floor (`>= 16px` on `<640px` viewports per R-ERG-02)
 */

const HARNESS_BASE_URL =
  process.env.HARNESS_BASE_URL ?? 'http://127.0.0.1:1420/tests/mobile-harness/index.html';

const CURRENT_SCREENS_DIR = path.resolve(
  process.cwd(),
  'artifacts/ui-team/screens/current',
);

type DeviceProfileId = 'pixel8' | 'iphone15' | 'tablet' | 'landscape';

interface DeviceProfile {
  id: DeviceProfileId;
  width: number;
  height: number;
  platform: 'android' | 'ios';
}

const DEVICE_PROFILES: Record<DeviceProfileId, DeviceProfile> = {
  pixel8: { id: 'pixel8', width: 412, height: 915, platform: 'android' },
  iphone15: { id: 'iphone15', width: 393, height: 852, platform: 'ios' },
  tablet: { id: 'tablet', width: 840, height: 1100, platform: 'android' },
  landscape: { id: 'landscape', width: 852, height: 393, platform: 'android' },
};

interface MatrixCase {
  name: string;
  device: DeviceProfileId;
  theme: 'dark' | 'light';
  lang: 'fr' | 'ar';
  screen:
    | 'activity'
    | 'checkout'
    | 'catalog'
    | 'kredy'
    | 'management'
    | 'diagnostics'
    | 'pairing'
    | 'printer'
    | 'scanner'
    | 'cart-protection'
    | 'lock-screen';
  state:
    | 'populated'
    | 'empty'
    | 'loading'
    | 'error'
    | 'offline'
    | 'sync-pending'
    | 'degraded-tamper'
    | 'degraded-unauthenticated'
    | 'degraded-clock';
}

const CORE_TABS = [
  'activity',
  'checkout',
  'catalog',
  'kredy',
  'management',
  'diagnostics',
] as const;

const PIXEL8_CORE_CASES: MatrixCase[] = [
  ...CORE_TABS.map((screen) => ({
    name: `pixel8-dark-fr-${screen}`,
    device: 'pixel8' as const,
    theme: 'dark' as const,
    lang: 'fr' as const,
    screen,
    state: 'populated' as const,
  })),
  ...CORE_TABS.map((screen) => ({
    name: `pixel8-light-fr-${screen}`,
    device: 'pixel8' as const,
    theme: 'light' as const,
    lang: 'fr' as const,
    screen,
    state: 'populated' as const,
  })),
];

const IPHONE15_CORE_CASES: MatrixCase[] = [
  ...CORE_TABS.map((screen) => ({
    name: `iphone15-dark-fr-${screen}`,
    device: 'iphone15' as const,
    theme: 'dark' as const,
    lang: 'fr' as const,
    screen,
    state: 'populated' as const,
  })),
  ...CORE_TABS.map((screen) => ({
    name: `iphone15-light-ar-${screen}`,
    device: 'iphone15' as const,
    theme: 'light' as const,
    lang: 'ar' as const,
    screen,
    state: 'populated' as const,
  })),
];

const TABLET_AND_LANDSCAPE_CASES: MatrixCase[] = [
  {
    name: 'tablet-dark-fr-activity',
    device: 'tablet',
    theme: 'dark',
    lang: 'fr',
    screen: 'activity',
    state: 'populated',
  },
  {
    name: 'tablet-light-fr-checkout',
    device: 'tablet',
    theme: 'light',
    lang: 'fr',
    screen: 'checkout',
    state: 'populated',
  },
  {
    name: 'landscape-dark-fr-activity',
    device: 'landscape',
    theme: 'dark',
    lang: 'fr',
    screen: 'activity',
    state: 'populated',
  },
  {
    name: 'landscape-dark-fr-checkout',
    device: 'landscape',
    theme: 'dark',
    lang: 'fr',
    screen: 'checkout',
    state: 'populated',
  },
];

const MODAL_AND_OVERLAY_CASES: MatrixCase[] = [
  {
    name: 'pixel8-dark-fr-pairing',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'pairing',
    state: 'populated',
  },
  {
    name: 'iphone15-light-ar-pairing',
    device: 'iphone15',
    theme: 'light',
    lang: 'ar',
    screen: 'pairing',
    state: 'populated',
  },
  {
    name: 'pixel8-dark-fr-printer',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'printer',
    state: 'populated',
  },
  {
    name: 'pixel8-dark-fr-scanner',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'scanner',
    state: 'populated',
  },
  {
    name: 'pixel8-dark-fr-cart-protection',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'cart-protection',
    state: 'populated',
  },
  {
    name: 'iphone15-light-ar-cart-protection',
    device: 'iphone15',
    theme: 'light',
    lang: 'ar',
    screen: 'cart-protection',
    state: 'populated',
  },
  {
    name: 'pixel8-dark-fr-lock-screen',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'lock-screen',
    state: 'populated',
  },
];

const EMPTY_AND_OPERATIONAL_STATE_CASES: MatrixCase[] = [
  {
    name: 'pixel8-dark-fr-activity-empty',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'activity',
    state: 'empty',
  },
  {
    name: 'pixel8-dark-fr-checkout-empty',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'checkout',
    state: 'empty',
  },
  {
    name: 'pixel8-dark-fr-catalog-empty',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'catalog',
    state: 'empty',
  },
  {
    name: 'pixel8-dark-fr-kredy-empty',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'kredy',
    state: 'empty',
  },
  {
    name: 'pixel8-dark-fr-activity-loading',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'activity',
    state: 'loading',
  },
  {
    name: 'pixel8-dark-fr-diagnostics-error',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'diagnostics',
    state: 'error',
  },
  {
    name: 'pixel8-dark-fr-checkout-offline',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'checkout',
    state: 'offline',
  },
  {
    name: 'pixel8-dark-fr-diagnostics-sync-pending',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'diagnostics',
    state: 'sync-pending',
  },
];

const DEGRADED_TRUST_STATE_CASES: MatrixCase[] = [
  {
    name: 'pixel8-dark-fr-management-degraded-tamper',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'management',
    state: 'degraded-tamper',
  },
  {
    name: 'pixel8-dark-fr-management-degraded-unauthenticated',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'management',
    state: 'degraded-unauthenticated',
  },
  {
    name: 'pixel8-dark-fr-checkout-degraded-clock',
    device: 'pixel8',
    theme: 'dark',
    lang: 'fr',
    screen: 'checkout',
    state: 'degraded-clock',
  },
];

async function switchHarnessState(
  page: Page,
  cfg: {
    screen: MatrixCase['screen'];
    state: MatrixCase['state'];
    theme: MatrixCase['theme'];
    platform: 'android' | 'ios';
    lang: MatrixCase['lang'];
  },
): Promise<void> {
  const hasFastSwitch = await page
    .evaluate(
      () =>
        typeof (
          window as unknown as {
            __setHarnessConfig?: (c: Record<string, string>) => Promise<void>;
          }
        ).__setHarnessConfig === 'function',
    )
    .catch(() => false);

  if (hasFastSwitch) {
    await page.evaluate(
      (nextCfg) =>
        (
          window as unknown as {
            __setHarnessConfig: (c: Record<string, string>) => Promise<void>;
          }
        ).__setHarnessConfig(nextCfg),
      cfg,
    );
  } else {
    const url = new URL(HARNESS_BASE_URL);
    url.searchParams.set('screen', cfg.screen);
    url.searchParams.set('state', cfg.state);
    url.searchParams.set('theme', cfg.theme);
    url.searchParams.set('platform', cfg.platform);
    url.searchParams.set('lang', cfg.lang);
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: 90_000 });
  }

  await page.waitForFunction(
    () =>
      (window as unknown as { __harnessReady?: boolean; __harnessError?: string | null })
        .__harnessReady === true ||
      Boolean((window as unknown as { __harnessError?: string | null }).__harnessError),
    null,
    { timeout: 90_000 },
  );
}

async function verifyAndCaptureCase(page: Page, item: MatrixCase): Promise<void> {
  const profile = DEVICE_PROFILES[item.device];
  await page.setViewportSize({ width: profile.width, height: profile.height });

  await switchHarnessState(page, {
    screen: item.screen,
    state: item.state,
    theme: item.theme,
    platform: profile.platform,
    lang: item.lang,
  });

  // 1. Assert zero uncaught runtime/promise errors
  const harnessError = await page.evaluate(
    () => (window as unknown as { __harnessError?: string | null }).__harnessError ?? null,
  );
  expect(harnessError, `Uncaught harness error on ${item.name}`).toBeNull();

  // 2. Assert root platform, theme, language, and direction invariants
  const rootAttrs = await page.evaluate(() => {
    const el = document.documentElement;
    return {
      platform: el.dataset.platform,
      lang: el.lang,
      dir: el.dir,
      isDark: el.classList.contains('dark'),
      isLight: el.classList.contains('light'),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });

  expect(rootAttrs.platform, `platform mismatch on ${item.name}`).toBe(profile.platform);
  expect(rootAttrs.lang, `lang mismatch on ${item.name}`).toBe(item.lang);
  expect(rootAttrs.dir, `dir mismatch on ${item.name}`).toBe(
    item.lang === 'ar' ? 'rtl' : 'ltr',
  );
  if (item.theme === 'dark') {
    expect(rootAttrs.isDark, `dark class missing on ${item.name}`).toBe(true);
  } else {
    expect(rootAttrs.isLight, `light class missing on ${item.name}`).toBe(true);
  }

  // 3. Assert zero horizontal overflow at root document level
  expect(
    rootAttrs.scrollWidth,
    `Horizontal overflow detected on ${item.name}: scrollWidth=${rootAttrs.scrollWidth} > clientWidth=${rootAttrs.clientWidth}`,
  ).toBeLessThanOrEqual(rootAttrs.clientWidth + 1);

  // 4. Assert R-ERG-02 mobile input font-size floor (>= 16px on <640px viewports)
  if (profile.width < 640) {
    const undersizedInputs = await page.evaluate(() => {
      const selectors =
        'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="range"]):not([type="file"]), textarea, select';
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(selectors));
      const violations: Array<{ tag: string; placeholder: string; fontSize: number }> = [];
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (
          rect.width === 0 ||
          rect.height === 0 ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        ) {
          continue;
        }
        const fontSize = parseFloat(style.fontSize);
        if (fontSize < 16) {
          violations.push({
            tag: node.tagName.toLowerCase(),
            placeholder: (node as HTMLInputElement).placeholder || node.id || '',
            fontSize,
          });
        }
      }
      return violations;
    });

    expect(
      undersizedInputs,
      `Inputs < 16px on mobile viewport (${profile.width}px) in ${item.name}`,
    ).toEqual([]);
  }

  // 5. Capture deterministic screenshot to artifacts/ui-team/screens/current/
  const screenshotPath = path.join(CURRENT_SCREENS_DIR, `${item.name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  expect(fs.existsSync(screenshotPath)).toBe(true);
}

test.describe('Mobile Visual & Layout Matrix Suite', () => {
  let sharedContext: BrowserContext;
  let sharedPage: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    fs.mkdirSync(CURRENT_SCREENS_DIR, { recursive: true });
    sharedContext = await browser.newContext();
    await sharedContext.addInitScript(() => {
      // Shield harness page from external file-watcher full-reload broadcasts
      const OrigWebSocket = window.WebSocket;
      const PatchedWebSocket = function (
        this: WebSocket,
        url: string | URL,
        protocols?: string | string[],
      ) {
        const ws =
          protocols !== undefined
            ? new OrigWebSocket(url, protocols)
            : new OrigWebSocket(url);
        if (String(url).includes('1421')) {
          ws.addEventListener(
            'message',
            (ev: MessageEvent) => {
              try {
                const payload = JSON.parse(String(ev.data)) as { type?: string };
                if (payload && payload.type === 'full-reload') {
                  ev.stopImmediatePropagation();
                }
              } catch {
                // ignore non-JSON messages
              }
            },
            true,
          );
        }
        return ws;
      } as unknown as typeof WebSocket;
      Object.assign(PatchedWebSocket, OrigWebSocket);
      PatchedWebSocket.prototype = OrigWebSocket.prototype;
      window.WebSocket = PatchedWebSocket;
    });
    sharedPage = await sharedContext.newPage();
    await sharedPage.goto(HARNESS_BASE_URL, { waitUntil: 'commit', timeout: 120_000 });
    await sharedPage.waitForFunction(
      () =>
        (window as unknown as { __harnessReady?: boolean; __harnessError?: string | null })
          .__harnessReady === true ||
        Boolean((window as unknown as { __harnessError?: string | null }).__harnessError),
      null,
      { timeout: 120_000 },
    );
  });

  test.afterAll(async () => {
    await sharedContext?.close();
  });

  test('1. Pixel 8 (412×915 Android) — Dark & Light Core Screens (12 captures)', async () => {
    for (const item of PIXEL8_CORE_CASES) {
      await verifyAndCaptureCase(sharedPage, item);
    }
  });

  test('2. iPhone 15 (393×852 iOS) — Dark FR (LTR) & Light AR (RTL) Core Screens (12 captures)', async () => {
    for (const item of IPHONE15_CORE_CASES) {
      await verifyAndCaptureCase(sharedPage, item);
    }
  });

  test('3. Tablet (840×1100) & Landscape (852×393) Adaptive Layouts (4 captures)', async () => {
    for (const item of TABLET_AND_LANDSCAPE_CASES) {
      await verifyAndCaptureCase(sharedPage, item);
    }
  });

  test('4. Mobile Modals & Overlays — Pairing, Printer, Scanner, Cart Protection, Lock Screen (7 captures)', async () => {
    for (const item of MODAL_AND_OVERLAY_CASES) {
      await verifyAndCaptureCase(sharedPage, item);
    }
  });

  test('5. Empty, Loading, Error, Offline & Sync-Pending States (8 captures)', async () => {
    for (const item of EMPTY_AND_OPERATIONAL_STATE_CASES) {
      await verifyAndCaptureCase(sharedPage, item);
    }
  });

  test('6. Degraded Trust States — Tamper, Unauthenticated & Clock Regression (3 captures)', async () => {
    for (const item of DEGRADED_TRUST_STATE_CASES) {
      await verifyAndCaptureCase(sharedPage, item);
    }
  });

  test('7. P5 Hardening — 200% Text / Large Font-Scale Spot Check (checkout & kredy)', async () => {
    await sharedPage.setViewportSize({ width: 412, height: 915 });
    try {
      for (const screen of ['checkout', 'kredy'] as const) {
        await switchHarnessState(sharedPage, {
          screen,
          state: 'populated',
          theme: 'dark',
          platform: 'android',
          lang: 'fr',
        });

        await sharedPage.evaluate(() => {
          document.documentElement.style.fontSize = '24px';
        });

        const metrics = await sharedPage.evaluate(() => {
          const el = document.documentElement;
          const visibleButtons = Array.from(document.querySelectorAll('button')).filter(
            (b) => {
              const r = b.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            },
          );
          return {
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            rootFontSize: window.getComputedStyle(el).fontSize,
            visibleButtonCount: visibleButtons.length,
          };
        });

        expect(metrics.rootFontSize).toBe('24px');
        expect(metrics.visibleButtonCount).toBeGreaterThan(3);
        expect(
          metrics.scrollWidth,
          `200% text overflow on ${screen}: scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
        ).toBeLessThanOrEqual(metrics.clientWidth + 1);

        const shotPath = path.join(
          CURRENT_SCREENS_DIR,
          `pixel8-dark-fr-${screen}-200pct.png`,
        );
        await sharedPage.screenshot({ path: shotPath, fullPage: false });
        expect(fs.existsSync(shotPath)).toBe(true);
      }
    } finally {
      await sharedPage.evaluate(() => {
        document.documentElement.style.fontSize = '';
      });
    }
  });

  test('8. P5 Hardening — prefers-reduced-motion: reduce Spot Check', async () => {
    await sharedPage.setViewportSize({ width: 412, height: 915 });
    try {
      await sharedPage.emulateMedia({ reducedMotion: 'reduce' });
      await switchHarnessState(sharedPage, {
        screen: 'checkout',
        state: 'populated',
        theme: 'dark',
        platform: 'android',
        lang: 'fr',
      });

      const motionAudit = await sharedPage.evaluate(() => {
        const mediaMatches = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const harnessError =
          (window as unknown as { __harnessError?: string | null }).__harnessError ?? null;
        return { mediaMatches, harnessError };
      });

      expect(motionAudit.mediaMatches).toBe(true);
      expect(motionAudit.harnessError).toBeNull();
    } finally {
      await sharedPage.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });

  test('9. P5 Hardening — Keyboard-Open (visualViewport) Bottom-Nav Hide & Input Accessibility', async () => {
    await sharedPage.setViewportSize({ width: 412, height: 915 });
    await switchHarnessState(sharedPage, {
      screen: 'catalog',
      state: 'populated',
      theme: 'dark',
      platform: 'android',
      lang: 'fr',
    });

    // Verify bottom nav is initially rendered before soft keyboard opens
    const initialBottomNavCount = await sharedPage
      .locator('nav[role="tablist"]:visible')
      .count();
    expect(initialBottomNavCount).toBe(1);

    try {
      // Focus search input and simulate 280px soft keyboard inset on visualViewport
      const searchInput = sharedPage.locator('input[type="search"]').first();
      await searchInput.focus();

      await sharedPage.evaluate(() => {
        const vv = window.visualViewport;
        if (vv) {
          Object.defineProperty(vv, 'height', {
            configurable: true,
            get: () => window.innerHeight - 280,
          });
          vv.dispatchEvent(new Event('resize'));
        }
      });

      await sharedPage.waitForFunction(
        () =>
          document.documentElement.style.getPropertyValue('--keyboard-height') === '280px',
        null,
        { timeout: 5_000 },
      );

      // Bottom nav must hide when isKeyboardVisible is true, while input remains focused & visible
      const keyboardOpenNavCount = await sharedPage
        .locator('nav[role="tablist"]:visible')
        .count();
      expect(keyboardOpenNavCount).toBe(0);
      await expect(searchInput).toBeVisible();
      await expect(searchInput).toBeFocused();

      const shotPath = path.join(
        CURRENT_SCREENS_DIR,
        'pixel8-dark-fr-catalog-keyboard-open.png',
      );
      await sharedPage.screenshot({ path: shotPath, fullPage: false });
      expect(fs.existsSync(shotPath)).toBe(true);
    } finally {
      await sharedPage.evaluate(() => {
        const vv = window.visualViewport;
        if (vv) {
          Object.defineProperty(vv, 'height', {
            configurable: true,
            get: () => window.innerHeight,
          });
          vv.dispatchEvent(new Event('resize'));
        }
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
      await sharedPage.waitForFunction(
        () =>
          document.documentElement.style.getPropertyValue('--keyboard-height') === '0px',
        null,
        { timeout: 5_000 },
      );
    }
  });

  test('10. P5 Hardening — ADR-001 5-Tab Compact Nav, >=840px Rail + 2-Pane Split, and LIFO Back-Stack', async () => {
    // 10a. Compact (<600px): Bottom Navigation Bar has strictly 5 primary tabs
    await sharedPage.setViewportSize({ width: 412, height: 915 });
    await switchHarnessState(sharedPage, {
      screen: 'checkout',
      state: 'populated',
      theme: 'dark',
      platform: 'android',
      lang: 'fr',
    });

    const compactTabs = sharedPage.locator('nav[role="tablist"]:visible [role="tab"]');
    await expect(compactTabs).toHaveCount(5);

    // 10b. LIFO Back-Stack on Checkout: Escape closes open inline sheet BEFORE M3CartProtectionModal
    const directQtyBtn = sharedPage
      .locator('button[title="Modifier la quantité directement"]')
      .first();
    await directQtyBtn.click();

    const qtyDialog = sharedPage.locator('[role="dialog"][aria-labelledby="checkout-qty-edit-title"]');
    const cartProtectionDialog = sharedPage.locator(
      '[role="dialog"][aria-labelledby="cart-protection-title"]',
    );
    await expect(qtyDialog).toBeVisible();

    // First Escape pops QuantityEditSheet from activeBackStack without opening CartProtection
    await sharedPage.keyboard.press('Escape');
    await expect(qtyDialog).toHaveCount(0);
    await expect(cartProtectionDialog).toHaveCount(0);

    // Second Escape (with no inline sheet open and cart.length > 0) opens M3CartProtectionModal
    await sharedPage.keyboard.press('Escape');
    await expect(cartProtectionDialog).toBeVisible();

    // 10c. Expanded (>=840px): Navigation Rail (6 items: 5 primary + 1 utility) + 2-Pane Catalog/Checkout Split
    await sharedPage.setViewportSize({ width: 840, height: 1100 });
    await switchHarnessState(sharedPage, {
      screen: 'checkout',
      state: 'populated',
      theme: 'dark',
      platform: 'android',
      lang: 'fr',
    });

    const railTabs = sharedPage.locator('nav[role="tablist"]:visible [role="tab"]');
    await expect(railTabs).toHaveCount(6);
    // In 2-pane split on >=840px checkout, CatalogSearchTab's search input is visible alongside Checkout cart
    await expect(sharedPage.locator('input[type="search"]').first()).toBeVisible();
    const twoPaneShot = path.join(CURRENT_SCREENS_DIR, 'tablet-dark-fr-checkout-2pane.png');
    await sharedPage.screenshot({ path: twoPaneShot, fullPage: false });
    expect(fs.existsSync(twoPaneShot)).toBe(true);
  });
});
