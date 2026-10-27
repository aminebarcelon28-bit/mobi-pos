/**
 * PROBE-09 — can a test enter the localized mobile shell without pairing
 * credentials, and does money render there? (Diagnostic; not coverage.)
 *
 * Path under test (all real app paths):
 *   1. `?mode=mobile&lang=ar` boot  (platform.ts:270-276, i18n/index.ts:62-66)
 *   2. pairing wizard -> "المتابعة في الوضع التجريبي بدون اتصال" skip button
 *      (`MobilePairingWizard.tsx:829-837`, `App.tsx:1188` onSkipDemo)
 *   3. CompanionShell -> LiveActivityTab (default tab) renders formatDZD money
 *      (`LiveActivityTab.tsx:623,660,679,954`).
 */
import fs from 'node:fs';
import { browser, $ } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  clearCart,
  clearWebMirrors,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  payExactFlow,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

const MONEY_RE = /[−-]?[\d\u0660-\u0669\u00a0\u202f ]+(?:[.,٫]\d+)?\s*DA/g;

describe('PROBE-09 mobile demo shell', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    resetData();
    seedProducts([{ id: 'P9-FRAC', title: 'P9 Frac', priceDa: 1234.5, stock: 100 }]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
  });

  it('[PROBE-09] ?mode=mobile&lang=ar -> demo skip -> shell money dump', async () => {
    // One sale so the live tab has real amounts to render.
    await addSku('P9 Frac', { expectTitle: 'P9 Frac' });
    await payExactFlow().catch((e) => console.log(`[probe9] sale note: ${String(e)}`));

    await browser.execute(() => {
      history.replaceState(null, '', '?mode=mobile&lang=ar');
      location.reload();
    });
    await browser.pause(2500);
    await browser
      .waitUntil(
        async () =>
          ((await browser.execute(
            () => document.documentElement.dataset.shell ?? '',
          )) as string) === 'mobile',
        { timeout: 60000, interval: 500, timeoutMsg: 'mobile shell never mounted' },
      )
      .catch((e) => console.log(`[probe9] ${String(e)}`));
    await installErrorTrap();
    await browser.pause(800);

    const state = await browser.execute(() => {
      const de = document.documentElement;
      const w = window as unknown as { __getMobiLocale?: () => string };
      return {
        shell: de.dataset.shell ?? null,
        dir: de.getAttribute('dir'),
        lang: de.getAttribute('lang'),
        datasetLocale: de.dataset.locale ?? null,
        locale: w.__getMobiLocale ? w.__getMobiLocale() : null,
      };
    });
    console.log(`[probe9] mobile state: ${JSON.stringify(state)}`);

    const demoBtn = await $('//button[contains(., "بدون اتصال")]');
    const demoVisible = await demoBtn.isDisplayed().catch(() => false);
    console.log(`[probe9] demo button visible=${demoVisible}`);
    if (demoVisible) {
      await demoBtn.click().catch((e) => console.log(`[probe9] demo click failed: ${String(e)}`));
      await browser.pause(1800);
    }

    const dump = (await browser.execute((re: string) => {
      const rx = new RegExp(re, 'g');
      const body = (document.body.innerText || '').replace(/\s+/g, ' ');
      return {
        shell: document.documentElement.dataset.shell ?? null,
        bodyHead: body.slice(0, 500),
        money: (document.body.innerText.match(rx) || []).map((s) => s.trim()).slice(0, 30),
        buttons: Array.from(document.querySelectorAll('button'))
          .map((b) => (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40))
          .filter(Boolean)
          .slice(0, 40),
      };
    }, MONEY_RE.source)) as {
      shell: string | null;
      bodyHead: string;
      money: string[];
      buttons: string[];
    };
    console.log(`[probe9] after demo: shell=${dump.shell} money=${JSON.stringify(dump.money)}`);
    const moneyParsed: Array<{ raw: string; minor: string | null }> = [];
    for (const m of dump.money) {
      try {
        moneyParsed.push({ raw: m, minor: String(displayedToMinor(m)) });
      } catch {
        moneyParsed.push({ raw: m, minor: null });
      }
    }
    console.log(`[probe9] money parsed: ${JSON.stringify(moneyParsed)}`);
    console.log(`[probe9] bodyHead: ${JSON.stringify(dump.bodyHead)}`);
    console.log(`[probe9] buttons: ${JSON.stringify(dump.buttons)}`);

    // restore desktop
    await browser.execute(() => {
      try {
        localStorage.removeItem('mobi_pos_locale');
      } catch {
        /* ignore */
      }
      history.replaceState(null, '', location.pathname);
      location.reload();
    });
    await browser.pause(2500);
    await unlockIfNeeded().catch((e) => console.log(`[probe9] restore note: ${String(e)}`));
    await installErrorTrap();
    await clearCart().catch(() => {});
    const back = await browser.execute(() => document.documentElement.dataset.shell ?? null);
    console.log(`[probe9] restored shell=${JSON.stringify(back)}`);
  });
});
