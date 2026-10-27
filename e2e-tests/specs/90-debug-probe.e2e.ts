/**
 * HARNESS PROBE — temporary diagnostic spec (not encyclopedia coverage).
 *
 * [PROBE-06] Step-wise replication of `scanCode()` on the E2E-HARNESS-1
 * product, with dumps after EVERY step (cart total, search value, scan-decode
 * events with timestamps, window keydown log). Canvass: is a machine burst
 * decoded once, twice, or not at all — and does the synthetic fallback double
 * with a late real decode?
 *
 * Titles are [PROBE-nn] on purpose — excluded from case coverage counting.
 */
import fs from 'node:fs';
import { browser, $ } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { count } from '../lib/db';
import { seedProducts } from '../lib/seed';
import {
  cartLineCount,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  installErrorTrap,
  installScanSpy,
  readScanEvents,
  selectAllNoKeys,
  tid,
  unlockIfNeeded,
} from '../lib/pos';

const SKU = 'E2E-HARNESS-1';
const BARCODE = 'EHARNESS1';

describe('PROBE', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await browser.waitUntil(
      () => {
        try {
          return count('_sqlx_migrations') > 0;
        } catch {
          return false;
        }
      },
      { timeout: 180000, interval: 1000, timeoutMsg: 'migrations did not converge' },
    );
    seedProducts([{ id: SKU, title: 'E2E Harness Product', priceDa: 1234, stock: 50, barcode: BARCODE }]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await installScanSpy();
    await installSpies();
  });

  it('[PROBE-06] step-wise scanCode replication (decode count / key log / timings)', async () => {
    await resetSpies();
    await clearCart();
    await browser.pause(300);
    await dump('step0 after clearCart');

    const search = await $(tid('catalog-search'));
    await search.waitForDisplayed({ timeout: 20000 });
    await selectAllNoKeys(search);
    await dump('step1 after selectAllNoKeys');

    await browser.keys(BARCODE.split(''));
    await dump('step2 after chars (no Enter)');

    await browser.keys(['Enter']);
    await browser.pause(120);
    await dump('step3 Enter+120ms');
    await browser.pause(600);
    await dump('step4 Enter+720ms');
    await browser.pause(900);
    await dump('step5 Enter+1620ms');

    const decode1 = await readScanEvents();
    if (decode1.length === 0) {
      console.log('[probe-06] real typed burst did NOT decode; dispatching synthetic burst');
      await syntheticBurst(BARCODE);
      await browser.pause(150);
      await dump('step6 synthetic+150ms');
      await browser.pause(700);
      await dump('step7 synthetic+850ms');
    } else {
      console.log('[probe-06] real typed burst decoded; no synthetic dispatched');
    }

    const finalTotal = await cartTotalMinor().catch(() => -1n);
    const lines = await cartLineCount();
    console.log(`[probe-06] FINAL total=${String(finalTotal)} lines=${lines}`);

    await clearCart();
    await browser.pause(200);
  });
});

async function syntheticBurst(code: string): Promise<void> {
  await browser.execute((c: string) => {
    const el = document.querySelector('[data-testid="catalog-search"]') as HTMLInputElement | null;
    const target: HTMLElement = el ?? document.body;
    el?.focus();
    for (const ch of c) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    }
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }, code);
}

async function dump(label: string): Promise<void> {
  const started = Date.now();
  const total = await cartTotalMinor().catch((e) => `err:${String(e)}`);
  const events = await readDetailedScanEvents();
  const keyLog = await readKeyLog();
  const value = await (await $(tid('catalog-search'))).getValue().catch(() => '<err>');
  console.log(
    `[probe-06] ${label} [t+${Date.now() - started}ms] total=${String(total)} searchValue=${JSON.stringify(value)} scans=${JSON.stringify(events)} keys=${JSON.stringify(keyLog)}`,
  );
}

async function installSpies(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __keySpy?: boolean; __keyLog?: unknown[]; __scanSpy2?: boolean; __scanLog?: unknown[] };
    if (!w.__keySpy) {
      w.__keySpy = true;
      w.__keyLog = [];
      window.addEventListener(
        'keydown',
        (e) => {
          const t = e.target as HTMLElement | null;
          const rec = { key: e.key, target: t?.getAttribute?.('data-testid') ?? t?.tagName ?? '?', ts: Date.now() };
          const log = w.__keyLog as unknown[];
          log.push(rec);
          if (log.length > 120) log.splice(0, log.length - 120);
        },
        true,
      );
    }
    if (!w.__scanSpy2) {
      w.__scanSpy2 = true;
      w.__scanLog = [];
      window.addEventListener('pos:barcode-scanned', (e) => {
        const log = w.__scanLog as unknown[];
        log.push({ detail: (e as CustomEvent).detail, ts: Date.now() });
      });
    }
  });
}

async function resetSpies(): Promise<void> {
  await installScanSpy(); // lib helper resets its array on re-install
  await browser.execute(() => {
    const w = window as unknown as { __keyLog?: unknown[]; __scanLog?: unknown[] };
    if (w.__keyLog) w.__keyLog.length = 0;
    if (w.__scanLog) w.__scanLog.length = 0;
  });
}

async function readDetailedScanEvents(): Promise<unknown[]> {
  return (await browser.execute(() => (window as unknown as { __scanLog?: unknown[] }).__scanLog ?? [])) as unknown[];
}

async function readKeyLog(): Promise<unknown[]> {
  const log = (await browser.execute(() => (window as unknown as { __keyLog?: unknown[] }).__keyLog ?? [])) as unknown[];
  return log.slice(-25);
}
