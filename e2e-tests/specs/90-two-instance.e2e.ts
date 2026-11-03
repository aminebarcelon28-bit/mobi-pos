/**
 * Two-instance harness, instance spec (one app process per invocation; the
 * runner starts A, then B — sequential so the suite cannot race itself).
 *
 * Each instance proves the things only a real app process can: its own data dir,
 * its own enrolled device identity, its own fiscal series starting at 000001,
 * and (for B) that a +90 s wall clock does not leak into the number.
 *
 * Gateway/signature faults live in the runner (`run.mjs`), which owns the
 * loopback merchant gateway, injects partition/heal/drop/duplicate/reorder/
 * crash-replay/revocation between and around these runs, and signs the test
 * mutations with the enrolled test keys. That split is deliberate: the app
 * contributes identity + numbering + isolation; the runner contributes the
 * fault schedule, so the suite is deterministic instead of racing two drivers.
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
      {
        id: PRODUCT,
        title: `Two Instance Product ${INSTANCE}`,
        priceDa: 1000,
        stock: 10,
        barcode: `6130000090${INSTANCE === 'A' ? '1' : '2'}`,
        costDa: 500,
      },
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
    // the numbering seam must survive. Every Date overload is forwarded so the
    // WebView's own internals keep working.
    const skewMs = Number(process.env.POS_FAKE_CLOCK_SKEW_MS ?? 0);
    if (skewMs !== 0) {
      await browser.execute((skew: number) => {
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
    const receipts = all<{ receipt_number: string }>('SELECT receipt_number FROM transactions ORDER BY rowid').map((r) =>
      String(r.receipt_number),
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
