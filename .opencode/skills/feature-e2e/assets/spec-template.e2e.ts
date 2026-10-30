/**
 * SPEC TEMPLATE - copy to `e2e-tests/specs/NN-<dom>-<feature>.e2e.ts`, then rename
 * `FEAT` to the domain and fill the four numbered blocks. Delete nothing else:
 * the head (imports, `before`, `afterEach`, `after`) is the contract every
 * working spec in this harness shares, and the invariant hooks are what make a
 * green case mean "and nothing else broke".
 *
 * Placeholders: FEAT (domain prefix), NN (spec number), <Feature> (title).
 * Read `references/harness-map.md` first to pick the surface helper + oracle.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, scalar, waitForSchemaSettled } from '../lib/db';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';
import { resetData, seedProducts, seedShift } from '../lib/seed';
import {
  addSku,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  closeDialogs,
  ensureShiftOpen,
  installErrorTrap,
  payExactFlow,
  tid,
  unlockIfNeeded,
} from '../lib/pos';

// ---------------------------------------------------------------------------
// 1. Fixtures. Stable ids, never derived from the clock or from Math.random -
//    a case that cannot be re-run identically is not a regression test.
// ---------------------------------------------------------------------------
const P_A = 'FEAT-A';
const P_B = 'FEAT-B';
const PRODUCTS = [
  { id: P_A, title: 'FEAT A', priceDa: 500, stock: 50, costDa: 250, barcode: 'FEATA0000000001' },
  { id: P_B, title: 'FEAT B', priceDa: 100, stock: 10, costDa: 50, barcode: 'FEATB0000000002' },
];

// ---------------------------------------------------------------------------
// 2. Oracles. Small, named, DB-only. Every case decides its verdict here, not
//    from the screen it just drove. One function per fact being asserted.
// ---------------------------------------------------------------------------
function stockOf(productId: string): number {
  return Number(one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', productId)?.stock ?? NaN);
}
function txCount(): number {
  return count('transactions');
}
function newestTxPayload(): Record<string, unknown> {
  const row = one<{ json_payload: string }>('SELECT json_payload FROM transactions ORDER BY rowid DESC LIMIT 1');
  try {
    return row?.json_payload ? (JSON.parse(String(row.json_payload)) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
/** Poll an oracle instead of the clock: writes are async across the IPC boundary. */
async function waitForStock(productId: string, expected: number, timeoutMs = 15000): Promise<number> {
  let last = NaN;
  await browser.waitUntil(
    () => {
      last = stockOf(productId);
      return last === expected;
    },
    { timeout: timeoutMs, interval: 250, timeoutMsg: `stock ${productId} never reached ${expected} (last=${last})` },
  );
  return last;
}

// ---------------------------------------------------------------------------
// 3. Suite head. `before` seeds + captures the invariant baseline; `afterEach`
//    cleans up and asserts the invariants; `after` finalises the batch.
// ---------------------------------------------------------------------------
describe('FEAT - <feature title> (batch NN)', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    resetData();
    seedProducts(PRODUCTS);
    seedShift('SHIFT-FEAT', 10000);
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
    captureInvariantBaseline('FEAT');
  });

  afterEach(async function () {
    await closeDialogs().catch(() => undefined);
    await clearCart().catch(() => undefined);
    const title = String((this as unknown as { currentTest?: { title?: string } }).currentTest?.title ?? 'unknown');
    assertInvariants(`FEAT :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('FEAT batch NN (spec NN)');
  });

  // -------------------------------------------------------------------------
  // 4. Cases. One `it` per CASE_INDEX row, title prefixed with the exact id in
  //    brackets - `case-index.mjs add` anchors `line` on that string, and
  //    `delta.mjs` matches the id out of the failure list.
  // -------------------------------------------------------------------------
  it('[FEAT-01] behaviour: <given>, <when>, <then> is true in the database', async () => {
    // --- given: drive the UI through the shared helpers, not raw selectors
    await addSku('FEAT A');
    expect(await cartTotalMinor()).toBe(500);

    // --- when: the single action the feature adds
    const before = txCount();
    await payExactFlow();

    // --- then: the oracle. Wait on the effect, then assert the stored value.
    await browser.waitUntil(() => txCount() === before + 1, {
      timeout: 15000,
      interval: 250,
      timeoutMsg: 'sale never reached the transactions table',
    });
    expect(await waitForStock(P_A, 49)).toBe(49);
    expect(Number(newestTxPayload().total_da)).toBe(500);

    // --- and the screen agrees with the database (display case only)
    expect(await $(tid('cart-total')).getText()).toContain('500');
  });

  it('[FEAT-02] refusal: <the path that must not fall through> is refused with a typed code', async () => {
    // Negative cases are required. Assert the refusal AND the absence of the side
    // effect; a refusal that still writes is a FAIL, not a pass.
    await addSku('FEAT B');
    const before = txCount();
    // ... drive the refusing action here ...
    expect(txCount()).toBe(before);
    expect(await stockOf(P_B)).toBe(10);
  });

  it('[FEAT-03] <idempotency | boundary | invariant> case', async () => {
    // Pick the one that applies: replay must not double-write; the numeric edge
    // must round once; the invariant-level fact (G-01 conservation, G-04 stock
    // ledger) must hold after the new write path runs.
    const ledgerBefore = scalar<number>('SELECT COUNT(*) FROM inventory_ledger') ?? 0;
    await addSku('FEAT A');
    await payExactFlow();
    expect(scalar<number>('SELECT COUNT(*) FROM inventory_ledger') ?? 0).toBe(ledgerBefore + 1);
    const rows = all<{ product_id: string }>('SELECT product_id FROM inventory_ledger ORDER BY rowid DESC LIMIT 1');
    expect(rows[0]?.product_id).toBe(P_A);
  });
});
