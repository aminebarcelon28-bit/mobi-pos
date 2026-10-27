/**
 * SCL — scale matrix, customer-directory half (batch 23).
 *
 * Covers SCL-12 / SCL-13 / SCL-23 / SCL-47 on a real 1,000,000-customer
 * SQLite file, plus TIM-08's blocked cross-device business-day case.
 *
 * The seed is deliberately OUT-OF-BAND (better-sqlite3) and happens AFTER the
 * app has booted, so the first two probes (SCL-23/47) exercise the real IPC
 * lane against the large file without paying a 1M-row boot. SCL-13 then
 * reloads the WebView and measures the real cold boot; SCL-12 opens the real
 * customer directory and searches it.
 *
 * Verdict policy is the batch policy: the assertion states the expected
 * behaviour, so a failing assertion is the expected-vs-actual evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { count, db, run } from '../lib/db';
import { ROOT } from '../lib/env';
import { clearWebMirrors, ensureShiftOpen, installPageShims, unlockIfNeeded } from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

const P = 'SCL-SCALE-P';
const SCALE = 1_000_000;

let bootMs = -1;
let bootTimedOut = false;

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function blocked(id: string, reason: string, needed: string, probe: boolean): void {
  console.log(`[${id}] BLOCKED — ${reason}; needed=${needed}; probe=${probe}`);
  expect(probe).toBe(true);
}

function seedScaleCustomers(n: number): { ms: number; changes: number } {
  const t0 = Date.now();
  // One statement, one transaction. The app's own connection is in WAL mode;
  // NORMAL is enough for a disposable sandbox and keeps the seed in minutes.
  db().pragma('synchronous = NORMAL');
  db().pragma('temp_store = MEMORY');
  const res = run(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
     INSERT INTO customers
       (id, name, phone, json_payload, updated_at, idempotency_key, version, created_at, deleted)
     SELECT 'SCL-SCALE-' || x,
            'Scale Customer ' || x,
            printf('0550%07d', x),
            '{}',
            datetime('now','utc'),
            'scl-scale-' || x,
            1,
            datetime('now','utc'),
            0
       FROM c`,
    n,
  );
  return { ms: Date.now() - t0, changes: res.changes };
}

async function pagePluginProbe(): Promise<{
  ms: number;
  maxGap: number;
  frames: number;
  rows: number;
  bytes: number;
  error: string;
}> {
  return (await browser.execute(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
      };
    };
    const invoke = w.__TAURI_INTERNALS__?.invoke;
    if (!invoke) {
      return { ms: -1, maxGap: -1, frames: 0, rows: 0, bytes: 0, error: 'no __TAURI_INTERNALS__.invoke' };
    }
    let maxGap = 0;
    let frames = 0;
    let last = performance.now();
    let running = true;
    const tick = (t: number): void => {
      const gap = t - last;
      if (gap > maxGap) maxGap = gap;
      last = t;
      frames++;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    let rows: unknown[] = [];
    let error = '';
    try {
      rows = (await invoke('plugin:sql|select', {
        db: 'sqlite:mobi_pos.db',
        query:
          'SELECT id, name, phone, json_payload FROM customers ORDER BY id LIMIT 100000',
        values: [],
      })) as unknown[];
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
    const ms = performance.now() - t0;
    running = false;
    await new Promise((r) => setTimeout(r, 120));
    return {
      ms,
      maxGap,
      frames,
      rows: rows.length,
      bytes: JSON.stringify(rows).length,
      error,
    };
  })) as {
    ms: number;
    maxGap: number;
    frames: number;
    rows: number;
    bytes: number;
    error: string;
  };
}

async function bootReady(): Promise<boolean> {
  return (await browser.execute(
    () =>
      !!document.querySelector(
        '[data-testid="lock-screen"], [data-testid="clients-button"], [data-testid="setup-pin-root"]',
      ),
  )) as boolean;
}

describe('SCL — batch 23 scale (customers)', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 300000, script: 300000 });
    // A wiped sandbox has no DB until the app boots and runs its migrations.
    await unlockIfNeeded();
    resetData();
    seedProducts([
      { id: P, title: 'SCL Scale Phone', priceDa: 1000, stock: 1000 },
    ]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen();
  });

  it('[TIM-08] BLOCKED — business-day boundary across devices needs a second enrolled terminal', async () => {
    blocked(
      'TIM-08',
      'the case requires a drawer opened at 22:00 on one device and sales after midnight on a second (mobile) device; the sandbox has one enrolled desktop terminal and no mobile/peer writer',
      'a second enrolled terminal or Android/mobile build with the same merchant clock and a shared business-day setting',
      true,
    );
  });

  it('[SCL-23] a 100k-row IPC payload has no hard cap/paging', async () => {
    const seeded = seedScaleCustomers(SCALE);
    const rows = count('customers');
    console.log(
      `[SCL-23] seedMs=${seeded.ms} inserted=${seeded.changes} customers=${rows} ` +
        `sourceGetAllCustomers=src/db/adapters/customerAdapter.ts:217 (no LIMIT)`,
    );
    expect(rows).toBeGreaterThanOrEqual(SCALE);

    const probe = await pagePluginProbe();
    console.log(
      `[SCL-23] ipcRows=${probe.rows} payloadBytes=${probe.bytes} ipcMs=${Math.round(probe.ms)} ` +
        `maxFrameGapMs=${Math.round(probe.maxGap)} frames=${probe.frames} error=${JSON.stringify(probe.error)} ` +
        `expected=hard-cap-or-paging`,
    );
    // Expected: a hard cap/paging on a 100k-row response. Actual: every row
    // crosses the IPC boundary in one JSON payload.
    expect(probe.rows).toBeLessThanOrEqual(1000);
    expect(probe.bytes).toBeLessThanOrEqual(1_000_000);
  });

  it('[SCL-47] UI heartbeat during a 100k-row IPC payload', async () => {
    const probe = await pagePluginProbe();
    console.log(
      `[SCL-47] ipcRows=${probe.rows} payloadBytes=${probe.bytes} ipcMs=${Math.round(probe.ms)} ` +
        `maxFrameGapMs=${Math.round(probe.maxGap)} frames=${probe.frames} ` +
        `expected=heartbeat-under-250ms`,
    );
    // The SQL itself is async; the risk is the synchronous JSON materialisation
    // on the WebView main thread. A >250 ms gap is a visible freeze.
    expect(probe.maxGap).toBeLessThan(250);
  });

  it('[SCL-13] cold start eagerly loads the 1M-customer directory', async () => {
    const adapter = readSrc('src/db/adapters/customerAdapter.ts');
    const eager =
      /async getAllCustomers\(\)[\s\S]{0,900}?FROM customers WHERE deleted = 0 ORDER BY name ASC/.test(
        adapter,
      );
    const bootLoader = readSrc('src/App.tsx');
    const bootCallsAll =
      /getAllCustomers\s*\(/.test(bootLoader) || /refreshAfterPull\s*\(/.test(bootLoader);
    console.log(
      `[SCL-13] eagerGetAllCustomers=${eager} appBootMentionsLoader=${bootCallsAll} ` +
        `source=src/db/adapters/customerAdapter.ts:217-229`,
    );

    bootTimedOut = false;
    const t0 = Date.now();
    let refreshError = '';
    try {
      await browser.refresh();
    } catch (e) {
      refreshError = String((e as Error)?.message ?? e);
    }
    let ready = false;
    try {
      await browser.waitUntil(async () => bootReady(), {
        timeout: 180000,
        interval: 500,
        timeoutMsg: 'boot gate never appeared after 1M-customer reload',
      });
      ready = true;
    } catch (e) {
      bootTimedOut = true;
      refreshError += ` :: ${String((e as Error)?.message ?? e)}`;
    }
    bootMs = Date.now() - t0;
    await installPageShims();

    let body = '';
    try {
      body = (await browser.execute(() => (document.body.innerText || '').slice(0, 400))) as string;
    } catch (e) {
      body = `<execute failed: ${String((e as Error)?.message ?? e)}>`;
    }
    console.log(
      `[SCL-13] bootMs=${bootMs} ready=${ready} timedOut=${bootTimedOut} refreshError=${JSON.stringify(refreshError)} ` +
        `body=${JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 240))} expected=no-eager-load-and-fast-boot`,
    );

    // Expected: no eager load of the directory; time-to-interactive stays in
    // budget. Actual: getAllCustomers materialises every row and mirrors it
    // into Dexie on boot.
    expect(eager).toBe(false);
    expect(bootTimedOut).toBe(false);
    expect(bootMs).toBeLessThan(15000);
  });

  it('[SCL-12] customer directory opens/search on the 1M-row file', async () => {
    if (bootTimedOut) {
      console.log('[SCL-12] boot never became interactive after SCL-13 reload');
    } else {
      await unlockIfNeeded();
    }
    const t0 = Date.now();
    let opened = false;
    try {
      await browser.execute(() => {
        (document.querySelector('[data-testid="clients-button"]') as HTMLElement | null)?.click();
      });
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => !!document.querySelector('[data-testid="customers-dialog"]'),
          )) as boolean,
        { timeout: 60000, interval: 250, timeoutMsg: 'customers dialog never opened' },
      );
      opened = true;
    } catch {
      opened = false;
    }
    const openMs = Date.now() - t0;

    let headerCount = -1;
    let searchMs = -1;
    let searchHit = false;
    if (opened) {
      headerCount = (await browser.execute(() => {
        const txt = document.querySelector('[data-testid="customers-dialog"]')?.textContent ?? '';
        const m = txt.match(/Répertoire & Profils Clients \((\d+)\)/);
        return m ? Number(m[1]) : -1;
      })) as number;
      const input = await $('input[placeholder="Rechercher nom, tél, appareil..."]');
      const searchT0 = Date.now();
      await input.setValue('Scale Customer 999999');
      try {
        await browser.waitUntil(
          async () =>
            (await browser.execute(
              () =>
                (document.querySelector('[data-testid="customers-dialog"]')?.textContent ?? '').includes(
                  'Scale Customer 999999',
                ),
            )) as boolean,
          { timeout: 30000, interval: 250 },
        );
        searchHit = true;
      } catch {
        searchHit = false;
      }
      searchMs = Date.now() - searchT0;
      await browser.execute(() => {
        const close = Array.from(document.querySelectorAll('button')).find((b) =>
          /fermer|close/i.test(b.getAttribute('aria-label') || ''),
        ) as HTMLElement | undefined;
        close?.click();
      });
    }

    console.log(
      `[SCL-12] opened=${opened} openMs=${openMs} headerCount=${headerCount} searchMs=${searchMs} ` +
        `searchHit=${searchHit} sourcePreload=src/db/adapters/customerAdapter.ts:217 ` +
        `expected=instant-open-no-preload`,
    );
    // Expected: the dialog never pre-loads the list; opening and searching stay
    // instant. Actual: the store already holds every customer (header count),
    // so the directory is pre-loaded before the dialog opens.
    expect(opened).toBe(true);
    expect(headerCount).toBeLessThanOrEqual(100000);
    expect(openMs).toBeLessThan(5000);
    expect(searchMs).toBeLessThan(3000);
  });

  after(() => {
    try {
      run("DELETE FROM customers WHERE id LIKE 'SCL-SCALE-%'");
      db().pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* the sandbox is disposable */
    }
  });
});
