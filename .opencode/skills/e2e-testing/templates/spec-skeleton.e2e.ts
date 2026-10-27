/**
 * SPEC SKELETON - copy to e2e-tests/specs/NN-<domain>-<topic>.e2e.ts
 *
 * Rules baked in (see references/conventions-and-templates.md):
 *  - the `it()` title starts with [DOMAIN-NN] or tools/coverage.mjs will not see it
 *  - the pass condition is written before the run, in the test comment
 *  - state is seeded out-of-band, then mirrors are wiped so the UI re-reads SQLite
 *  - waits poll state, never time
 *  - money is BigInt minor units parsed from the display text
 *  - an error trap turns a silent render failure into a finding
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, integrityCheck, waitForSchemaSettled } from '../lib/db';
import { invoke } from '../lib/invoke';
import {
  addSku,
  cartLineCount,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  installErrorTrap,
  listDialogs,
  openShiftUi,
  payExactFlow,
  readErrors,
  unlockIfNeeded,
} from '../lib/pos';
import { seedProducts, seedSettings } from '../lib/seed';

const SKU = 'E2E-SKELETON-1';
const PRICE_DA = 1500;

describe('DOMAIN - <topic>', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();

    // Out-of-band seed. Explicit price/stock/barcode - defaults hide rounding bugs.
    seedProducts([{ id: SKU, title: 'E2E Skeleton Product', priceDa: PRICE_DA, stock: 10, barcode: 'ESKEL1' }]);
    seedSettings([{ key: 'E2E-SKELETON-FLAG', valueJson: '{"seeded":true}' }]);

    // The UI caches; drop the mirrors and let it re-read the authority.
    await clearWebMirrors();
    await unlockIfNeeded();
  });

  beforeEach(async () => {
    await clearCart();
  });

  it('[DOM-01] <case title>', async () => {
    // PASS CONDITION (written before measuring):
    //   cart total == 1500 DA and exactly one line, and the transaction row stores 1500.
    await openShiftUi(10000);
    await addSku('E2E Skeleton', { expectTitle: 'E2E Skeleton Product' });

    expect(await cartLineCount()).toBe(1);
    expect(await cartTotalMinor()).toBe(BigInt(PRICE_DA) * 100n);

    const before = count('transactions');
    await payExactFlow();
    await browser.waitUntil(() => count('transactions') > before, {
      timeout: 30000,
      interval: 500,
      timeoutMsg: 'sale row never appeared in SQLite',
    });

    const row = all<Record<string, unknown>>(
      'SELECT total, status FROM transactions ORDER BY rowid DESC LIMIT 1',
    )[0];
    console.log(`[DOM-01] row=${JSON.stringify(row)}`);
    expect(Number(row?.total)).toBe(PRICE_DA);
    expect(String(row?.status)).toBe('COMPLETED');
  });

  it('[DOM-02] <edge case from the matrix>', async () => {
    // PASS CONDITION: ...
    const dialogs = await listDialogs();
    console.log(`[DOM-02] dialogs=${JSON.stringify(dialogs)}`);
    expect(integrityCheck()).toBe('ok');
  });

  it('[DOM-03] <negative / permission case>', async () => {
    // PASS CONDITION: the IPC call is refused with a typed code, and no row is written.
    const res = await invoke('some_command', { amount: -1 }).then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, e: String(e) }),
    );
    console.log(`[DOM-03] result=${JSON.stringify(res)}`);
    expect(res.ok).toBe(false);
  });

  after(async () => {
    const errors = await readErrors();
    if (errors.length) console.log(`[DOMAIN] ui errors: ${JSON.stringify(errors)}`);
    expect(errors).toEqual([]);
  });
});
