/**
 * SCL-83 — restart with a deliberately large WAL (batch 23).
 *
 * Kept separate from the 1M/2M/10M scale spec so the WAL probe runs on a
 * small database and cannot be starved by the large fixture seeds.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { db, openDb, run, tx } from '../lib/db';
import { DB_PATH } from '../lib/env';
import { installPageShims, unlockIfNeeded } from '../lib/pos';
import { resetData } from '../lib/seed';

describe('SCL — batch 23 scale (large WAL)', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 300000, script: 300000 });
    await unlockIfNeeded();
    resetData();
  });

  it('[SCL-83] restart after a large WAL has no recovery progress UI', async () => {
    // Collapse any prior WAL so the measured WAL is the controlled one.
    try {
      db().pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* busy is acceptable; the seed below still grows a large WAL */
    }
    const w = openDb();
    w.pragma('wal_autocheckpoint = 0');
    w.pragma('synchronous = NORMAL');
    const t0 = Date.now();
    tx((d) => {
      d.exec('CREATE TABLE IF NOT EXISTS scl83_wal (id INTEGER PRIMARY KEY, payload TEXT)');
    });
    const ins = w
      .prepare(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?)
         INSERT INTO scl83_wal (id, payload)
         SELECT x, printf('%080d', x) FROM c`,
      )
      .run(1_000_000);
    const insertMs = Date.now() - t0;
    w.close();
    let walBytes = 0;
    try {
      walBytes = fs.statSync(`${DB_PATH}-wal`).size;
    } catch {
      walBytes = -1;
    }
    const dbBytes = fs.statSync(DB_PATH).size;
    console.log(
      `[SCL-83] inserted=${ins.changes} insertMs=${insertMs} dbBytes=${dbBytes} walBytes=${walBytes} ` +
        `expected=recovery-progress-ui`,
    );

    const bootT0 = Date.now();
    let refreshError = '';
    try {
      await browser.refresh();
    } catch (e) {
      refreshError = String((e as Error)?.message ?? e);
    }
    let ready = false;
    try {
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () =>
              !!document.querySelector(
                '[data-testid="lock-screen"], [data-testid="clients-button"], [data-testid="setup-pin-root"]',
              ),
          )) as boolean,
        { timeout: 180000, interval: 500 },
      );
      ready = true;
    } catch (e) {
      refreshError += ` :: ${String((e as Error)?.message ?? e)}`;
    }
    const bootMs = Date.now() - bootT0;
    await installPageShims();
    const progress = (await browser.execute(() => {
      const el = document.querySelector(
        'progress, [role="progressbar"], [data-testid*="progress"], [data-testid*="Progress"]',
      );
      return {
        hasProgress: !!el,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
      };
    })) as { hasProgress: boolean; text: string };
    console.log(
      `[SCL-83] bootMs=${bootMs} ready=${ready} refreshError=${JSON.stringify(refreshError)} ` +
        `progress=${JSON.stringify(progress)} expected=recovery-progress-ui`,
    );
    expect(walBytes).toBeGreaterThan(20 * 1024 * 1024);
    expect(ready).toBe(true);
    // Expected: recovery is measurable and shown as progress. Actual: the
    // splash is static text with no progress element.
    expect(progress.hasProgress).toBe(true);
  });

  after(() => {
    try {
      run('DROP TABLE IF EXISTS scl83_wal');
      db().pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* the sandbox is disposable */
    }
  });
});
