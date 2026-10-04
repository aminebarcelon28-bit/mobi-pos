/**
 * SAV + IMEI Inspector UI regression gates.
 *
 * Two properties that a human smoke-check catches but CI otherwise forgets:
 *
 *  1. MOBILE INPUT FONT-SIZE FLOOR. iOS Safari scales the viewport in when a
 *     focused control computes < 16px, so a technician typing an IMEI gets
 *     yanked out of the form. Only WebKit implements this, which is why the
 *     `webkit-mobile` project in playwright.config.ts exists. The floor is a
 *     MOBILE-ONLY rule — at >= sm the design deliberately drops to text-xs for
 *     density, so the assertion is gated on a sub-640px viewport.
 *
 *  2. THEME CONTRAST. Typography deflation in these modals moved a lot of text
 *     from `font-black` + high-chroma color to `font-medium` + muted tokens.
 *     That is exactly the change that can quietly push a label under WCAG AA,
 *     so every rendered text node is measured against its real composited
 *     background in BOTH themes.
 *
 * These mount the modals through tests/harness (a second Vite entry), not the
 * app shell: App.tsx mounts a fail-closed license gate first, and the E2E seed
 * key is SUSPENDED in CI, so the till never renders. The harness does not
 * touch licensing — it mounts the same components against the same store and
 * the same Tailwind output, so computed styles are production styles.
 *
 * Thermal 80mm paper output is NOT covered here: it needs real hardware and
 * stays a manual check at the counter.
 */
import { test, expect, type Page } from '@playwright/test';

const HARNESS = '/tests/harness/index.html';
const MOBILE_FLOOR_PX = 16;
const SM_BREAKPOINT_PX = 640;

/**
 * Installed in-page. Tailwind v4 emits `oklch()` for its palette, so a
 * getComputedStyle value cannot be parsed with a regex expecting `rgb()` —
 * doing that silently yields alpha 0 and every color reads as "unmeasurable".
 * A 1x1 canvas is the reliable way to make the engine resolve ANY CSS color
 * notation to real sRGB bytes, and getImageData returns non-premultiplied
 * alpha, which is what the background walk needs.
 */
const CONTRAST_UTIL = () => {
  type RGBA = [number, number, number, number];

  const cv = document.createElement('canvas');
  cv.width = 1;
  cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;

  const toRGBA = (value: string): RGBA => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };

  const over = (fg: RGBA, bg: RGBA): RGBA => {
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
  };
  const lum = (c: RGBA): number => {
    const ch = [c[0], c[1], c[2]].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const ratio = (a: RGBA, b: RGBA): number => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /** Composite the effective background by walking ancestors to an opaque one. */
  const effectiveBg = (el: Element): RGBA => {
    const stack: RGBA[] = [];
    let node: Element | null = el;
    while (node) {
      const bg = toRGBA(getComputedStyle(node).backgroundColor);
      if (bg[3] > 0) {
        stack.push(bg);
        if (bg[3] >= 1) break;
      }
      node = node.parentElement;
    }
    if (stack.length === 0) return [255, 255, 255, 1];
    let base = stack[stack.length - 1];
    for (let i = stack.length - 2; i >= 0; i--) base = over(stack[i], base);
    return base;
  };

  interface Row {
    text: string;
    cls: string;
    fg: string;
    bg: string;
    ratio: number;
    required: number;
    fontSize: number;
    fontWeight: number;
  }

  const measure = (el: Element): Row => {
    const cs = getComputedStyle(el);
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent || '').trim())
      .join(' ')
      .trim();
    const bg = effectiveBg(el);
    const fgRaw = toRGBA(cs.color);
    const fg = over(fgRaw, bg);
    const fontSize = parseFloat(cs.fontSize);
    const fontWeight = parseInt(cs.fontWeight, 10) || 400;
    const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    return {
      text: own.slice(0, 60),
      cls: (el.className || '').toString().slice(0, 120),
      fg: cs.color,
      bg: `rgb(${bg.slice(0, 3).map((n) => Math.round(n)).join(', ')})`,
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      required: isLarge ? 3 : 4.5,
      fontSize,
      fontWeight,
    };
  };

  const audit = (): { rows: Row[]; skipped: number; reason: string } => {
    const rows: Row[] = [];
    let skipped = 0;
    let reason = '';
    const nodes = document.querySelectorAll<HTMLElement>(
      'p, span, label, a, button, li, td, th, h1, h2, h3, h4, h5, h6, strong'
    );
    for (const el of nodes) {
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent || '').trim())
        .join(' ')
        .trim();
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (parseFloat(cs.opacity) < 0.99) {
        skipped++;
        reason ||= 'opacity<1 (contrast not modeled)';
        continue;
      }
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        skipped++;
        reason ||= 'gradient/image background (not flat)';
        continue;
      }
      if (toRGBA(cs.color)[3] === 0) {
        skipped++;
        reason ||= 'fully transparent text color';
        continue;
      }
      rows.push(measure(el));
    }
    return { rows, skipped, reason };
  };

  const measureByText = (needle: string): (Row & { found: boolean }) | null => {
    const el = [...document.querySelectorAll('p, span, td, li, label')].find((e) =>
      (e.textContent || '').includes(needle)
    );
    if (!el) return null;
    return { found: true, ...measure(el) };
  };

  (window as unknown as Record<string, unknown>).__contrast = { audit, measureByText };
};

async function openHarness(page: Page, modal: 'inspector' | 'repair', theme: 'light' | 'dark') {
  // Emulate BEFORE navigating so prefers-color-scheme is correct from first paint.
  await page.emulateMedia({ colorScheme: theme });
  // Theme travels in the URL: the harness applies it only AFTER zustand
  // rehydration and then flips `html.dark`, so `__harnessReady` genuinely means
  // "the requested theme is painted". Setting the theme from the test after
  // ready raced rehydration and made the `light` audit measure dark colors.
  await page.goto(`${HARNESS}?modal=${modal}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 30_000 });

  // Cheap post-condition: the audited palette is the requested one. A contrast
  // audit that silently measures the wrong theme is worse than no audit.
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.classList.contains('dark')),
      { timeout: 15_000, message: `harness never settled into the "${theme}" theme` },
    )
    .toBe(theme === 'dark');

  const err = await page.evaluate(() => window.__harnessError);
  expect(err, `harness failed to mount: ${err}`).toBeNull();
}

/** Open the repair modal's second tab so history-only inputs are measured too. */
async function openHistoryTab(page: Page) {
  const tab = page.getByRole('button', { name: /Historique Atelier/ });
  if ((await tab.count()) > 0) {
    await tab.first().click();
    await page.waitForTimeout(400);
  }
}

test.describe('SAV + inspector mobile input font-size floor', () => {
  test.beforeEach(async ({ page }) => {
    // Touch-zoom is a sub-sm phenomenon; skip the floor where it does not apply.
    const size = page.viewportSize();
    test.skip(
      !size || size.width >= SM_BREAKPOINT_PX,
      `16px floor is mobile-only (viewport ${size?.width}px >= sm ${SM_BREAKPOINT_PX}px)`
    );
  });

  for (const modal of ['inspector', 'repair'] as const) {
    test(`${modal}: every input/select/textarea computes >= ${MOBILE_FLOOR_PX}px`, async ({
      page,
    }) => {
      await openHarness(page, modal, 'light');

      const collect = () =>
        page.evaluate((floor) => {
          const bad: Array<{ tag: string; fontSize: number; cls: string; ph: string }> = [];
          let measured = 0;
          for (const el of document.querySelectorAll<HTMLElement>('input, select, textarea')) {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue; // hidden / not rendered
            measured++;
            const fs = parseFloat(getComputedStyle(el).fontSize);
            if (fs < floor) {
              bad.push({
                tag: el.tagName,
                fontSize: fs,
                cls: (el.className || '').toString().slice(0, 140),
                ph: el.getAttribute('placeholder') ?? el.id ?? '',
              });
            }
          }
          return { bad, measured };
        }, MOBILE_FLOOR_PX);

      // The repair modal's two tabs are MUTUALLY EXCLUSIVE — switching to
      // Historique unmounts the whole intake form. Auditing only the visible
      // tab silently skips every intake control, so both are swept.
      const intake = await collect();
      let history = { bad: [] as typeof intake.bad, measured: 0 };
      if (modal === 'repair') {
        await openHistoryTab(page);
        history = await collect();
      }
      const bad = [...intake.bad, ...history.bad];
      const measured = intake.measured + history.measured;

      // A vacuous pass is worse than a failure: refuse to "pass" on zero coverage.
      expect(measured, 'no controls found — assertion would be vacuous').toBeGreaterThan(0);
      expect(
        bad,
        `Sub-${MOBILE_FLOOR_PX}px controls would trigger iOS focus zoom:\n` +
          bad.map((u) => `  ${u.tag} ${u.fontSize}px — ${u.ph} — ${u.cls}`).join('\n')
      ).toEqual([]);
    });
  }
});

test.describe('SAV + inspector WCAG AA contrast', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(CONTRAST_UTIL);
  });

  for (const modal of ['inspector', 'repair'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${modal} / ${theme}: text meets WCAG AA`, async ({ page }) => {
        await openHarness(page, modal, theme);


        const { rows, skipped, reason } = await page.evaluate(() =>
          (window as unknown as { __contrast: { audit: () => unknown } }).__contrast.audit()
        ) as { rows: Array<{ text: string; cls: string; fg: string; bg: string; ratio: number; required: number; fontSize: number; fontWeight: number }>; skipped: number; reason: string };

        // Guard against a silently-blind audit (e.g. a color parser that fails
        // to resolve the palette and skips everything).
        expect(rows.length, `audit measured nothing — skipped ${skipped} (${reason})`).toBeGreaterThan(10);

        const violations = rows.filter((r) => r.ratio < r.required);
        const seen = new Set<string>();
        const detail = violations
          .filter((v) => {
            const k = `${v.cls}|${v.ratio}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map(
            (v) =>
              `  ${v.ratio}:1 (need ${v.required}) ${v.fontSize}px/${v.fontWeight} fg=${v.fg} bg=${v.bg}\n` +
              `    text: "${v.text}"\n    cls:  ${v.cls}`
          )
          .join('\n');

        expect(
          violations.length,
          `${violations.length}/${rows.length} contrast violation(s) in ${modal}/${theme}` +
            ` (${skipped} unmeasurable: ${reason}):\n${detail}`
        ).toBe(0);
      });
    }
  }

  test('validation hints keep AA after the amber correction', async ({ page }) => {
    // The specific regression this pass fixed: `text-amber-400` on a light
    // card washed out under workshop lighting. Measure the real rendered
    // contrast of both hints rather than asserting a class name.
    await openHarness(page, 'repair', 'light');

    const phone = page.getByPlaceholder('Ex: 0550 12 34 56');
    await phone.fill('123'); // fails isValidDzPhone
    await phone.blur();

    const imei = page.getByPlaceholder('Scanner ou 15 chiffres…');
    // 15 digits that FAIL Luhn — imeiCheckState only reports 'invalid' for a
    // full 15-digit value; shorter input is 'neutral' (tablets / S/N).
    await imei.fill('490154203237519');
    await imei.blur();
    await page.waitForTimeout(500);

    for (const needle of ['Format DZ attendu', 'Clé de contrôle IMEI invalide']) {
      await expect(page.getByText(new RegExp(needle)), `hint "${needle}" should render`).toBeVisible();
    }

    for (const needle of ['Format DZ attendu', 'Clé de contrôle IMEI invalide']) {
      const m = (await page.evaluate(
        (n) =>
          (
            window as unknown as {
              __contrast: { measureByText: (s: string) => unknown };
            }
          ).__contrast.measureByText(n),
        needle
      )) as { found: boolean; ratio: number; required: number; fg: string } | null;

      expect(m, `hint "${needle}" not found`).not.toBeNull();
      // Both hints are 10px normal text → AA demands 4.5:1.
      expect(
        m!.ratio,
        `hint "${needle}" resolved to ${m!.fg} at ${m!.ratio}:1 (need ${m!.required})`
      ).toBeGreaterThanOrEqual(4.5);
      // Guard the exact regression: light amber-400 (#fbbf24) on white ≈ 1.7:1.
      expect(m!.fg).not.toMatch(/rgb\(251, 191, 36\)|rgb\(250, 204, 21\)/);
    }
  });
});

declare global {
  interface Window {
    __harnessReady: boolean;
    __harnessError: string | null;
    __harnessSetTheme: (mode: 'light' | 'dark') => void;
    __harnessOpen: (which: 'inspector' | 'repair') => void;
  }
}

// ---------------------------------------------------------------------------
// Focus retention (regression: inputs froze mid-typing in the SAV + IMEI
// modals). ModalShell moved focus into the dialog from an effect keyed on
// `[open, onClose]`; callers pass unstable handlers (RepairWorkOrderModal's
// `handleRequestClose` depends on customerName/deviceModel/imei/
// problemDescription), so focus was re-stolen on EVERY keystroke and the caret
// was reset to position 0. Typed characters vanished or landed reversed.
// ---------------------------------------------------------------------------
test.describe('SAV + inspector input focus retention', () => {
  test('SAV customer name keeps focus and character order across keystrokes', async ({ page }) => {
    await openHarness(page, 'repair', 'light');
    const name = page.locator('#sav-customer');
    await expect(name).toBeVisible();
    await name.click();

    // pressSequentially fires one key event per character, which is exactly the
    // cadence that used to trigger the re-focus.
    await name.pressSequentially('Yacine Benali', { delay: 30 });

    await expect(name).toHaveValue('Yacine Benali');
    await expect(name).toBeFocused();
  });

  test('IMEI field keeps focus and accumulates digits in order', async ({ page }) => {
    await openHarness(page, 'inspector', 'light');
    // The inspector's IMEI input IS the [data-modal-autofocus] target, so it
    // was the worst case: focus() collapsed its own caret on each keystroke.
    const imei = page.locator('[data-modal-autofocus]');
    await expect(imei).toBeVisible();
    await imei.click();

    await imei.pressSequentially('351234567890123', { delay: 30 });

    await expect(imei).toHaveValue('351234567890123');
    await expect(imei).toBeFocused();
  });
});