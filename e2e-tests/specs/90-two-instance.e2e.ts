/**
 * Two-instance harness spec (one app process per invocation).
 *
 * The runner (`tests/harness/two-instance/run.mjs`) starts two of these at the
 * same time with different sandbox dirs and driver ports. Each instance:
 *   - boots its own data dir (no shared DB),
 *   - seeds a catalogue and performs a REAL sale through the checkout UI,
 *   - records its fiscal number (device series), enrolled device id and the
 *     result file the runner compares.
 *
 * The gateway/signature half is proven by `npm run test:sync-e2e` and
 * `npm run test:sync-two-device` (real Ed25519, gaps, replay, revocation); this
 * spec is about two concurrent terminals with separate identities, which no
 * single-sandbox spec can show.
 */
import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { all, one } from '../lib/db';
import { APP_PIN, addSku, clearWebMirrors, ensureShiftOpen, installErrorTrap, payExactFlow, tid, unlockIfNeeded } from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

const INSTANCE = (process.env.POS_INSTANCE ?? 'A').trim() || 'A';
const RESULT_FILE = process.env.POS_RESULT_FILE ?? path.join(process.cwd(), `two-instance-${INSTANCE}.json`);
const PRODUCT = `TWO-P-${INSTANCE}`;

describe(`two-instance terminal ${INSTANCE}`, () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 120000, script: 120000 });
    await unlockIfNeeded(APP_PIN);
    await installErrorTrap();
    resetData();
    seedProducts([
      { id: PRODUCT, title: `Two Instance Product ${INSTANCE}`, priceDa: 1000, stock: 10, barcode: `6130000090${INSTANCE === 'A' ? '1' : '2'}`, costDa: 500 },
    ]);
    await clearWebMirrors();
    await browser.waitUntil(
      async () => (await $(tid('shift-pill'))).isDisplayed().catch(() => false),
      { timeout: 90000, interval: 500, timeoutMsg: 'dashboard did not re-mount' },
    );
    await unlockIfNeeded(APP_PIN);
    await ensureShiftOpen();
  });

  it('sells from its own data dir and records a distinct fiscal series', async () => {
    const startedAt = new Date().toISOString();
    // Fake clock: a terminal whose clock is off is exactly the multi-device case
    // the numbering seam must survive. Patching the WebView's Date proves the
    // fiscal number does NOT depend on the wall clock (series + counter only).
    const skewMs = Number(process.env.POS_FAKE_CLOCK_SKEW_MS ?? 0);
    if (skewMs !== 0) {
      await browser.execute((skew: number) => {
        // Forward ALL constructor forms: the previous subclass-only patch broke
        // WebView internals that call new Date(y, m, d) (session died with
        // ECONNREFUSED after the patch). Returning a real Date instance keeps
        // every overload intact.
        const RealDate = Date;
        const shifted = () => RealDate.now() + skew;
        function FakeDate(this: unknown, ...args: unknown[]) {
          if (args.length === 0) return new RealDate(shifted());
          return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
        }
        FakeDate.now = shifted;
        FakeDate.parse = RealDate.parse;
        FakeDate.UTC = RealDate.UTC;
        FakeDate.prototype = RealDate.prototype;
        (window as unknown as { Date: unknown }).Date = FakeDate;
      }, skewMs);
      console.log(`[two-instance] ${INSTANCE}: fake clock skew ${skewMs} ms`);
    }
    await addSku(`Two Instance Product ${INSTANCE}`, { expectTitle: `Two Instance Product ${INSTANCE}` });
    await payExactFlow();
    await browser.pause(800);

    const tx = one<{ receipt_number: string; id: string }>(
      'SELECT receipt_number, id FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    const receipts = all<{ receipt_number: string }>('SELECT receipt_number FROM transactions ORDER BY rowid').map(
      (r) => String(r.receipt_number),
    );
    const identity = one<{ device_id: string }>('SELECT device_id FROM device_identity LIMIT 1');
    const series = /^REC-([0-9A-Z]{4,8})-\d{6,}$/.exec(String(tx?.receipt_number ?? ''))?.[1] ?? '';
    const appClock = (await browser.execute(() => new Date().toISOString())) as string;
    const payload = {
      instance: INSTANCE,
      skewMs,
      appClock,
      startedAt,
      finishedAt: new Date().toISOString(),
      dbPath: process.env.POS_WDIO_SANDBOX ?? '',
      receipt: String(tx?.receipt_number ?? ''),
      receipts,
      series,
      deviceId: String(identity?.device_id ?? ''),
      txId: String(tx?.id ?? ''),
    };
    fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2));
    console.log(`[two-instance] ${INSTANCE}: ${JSON.stringify(payload)}`);

    expect(series.length).toBeGreaterThan(0);
    expect(receipts.length).toBe(1);
    expect(String(tx?.receipt_number)).toMatch(/^REC-[0-9A-Z]{4,8}-000001$/);
    expect(payload.deviceId.length).toBeGreaterThan(0);
  });
});
