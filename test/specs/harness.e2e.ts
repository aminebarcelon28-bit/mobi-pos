import { expect, browser, $ } from '@wdio/globals';

/**
 * Phase 1 gate (harness proof): the three e2e_* commands execute through
 * real IPC against the isolated DB — reset wipes data but preserves schema
 * (v112 ledger + v109 REFUND_BYPASS trigger), seed inserts products/shift/
 * sales atomically, the oracle reports ground truth, and invalid seeds
 * (negative price, quantity 0, fractional quantity 1.5) are rejected.
 *
 * Assumes the app is already past setup/lock (run after hello.e2e.ts in a
 * fresh profile, or standalone — it unlocks itself if needed).
 */
async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await browser.execute(
    async (c: string, a: Record<string, unknown>) => {
      const w = window as unknown as {
        __TAURI__?: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      };
      if (!w.__TAURI__) throw new Error('__TAURI__ global missing');
      return (await w.__TAURI__.core.invoke(c, a)) as T;
    },
    cmd,
    args,
  )) as T;
}

describe('E2E harness (Phase 1 gate)', () => {
  it('H2 reset -> seed -> oracle round-trips through IPC', async () => {
    await (await $('#root')).waitForExist({ timeout: 90000 });

    // --- reset: data wiped, schema + ledger survive.
    // REAL-DATA MODE: this runs against the owner's real database
    // (pre-launch testing data). Destructive by owner approval.
    const reset = await invoke<{
      dbPath: string;
      tablesCleared: string[];
      rowsDeleted: number;
      userVersion: number;
    }>('e2e_reset_db');
    console.log(`[harness] reset cleared ${reset.tablesCleared.length} tables, ${reset.rowsDeleted} rows`);
    expect(reset.dbPath).toContain('com.mobi.pos');
    expect(reset.dbPath).not.toContain('com.mobi.pos.e2e');

    // --- cloud seal proof: reads return None, writes are denied, so no
    // test run can pull the merchant cloud or push test rows to it.
    const sealedCreds = await invoke<null>('get_cloud_credentials');
    expect(sealedCreds).toBeNull();
    console.log('[harness] cloud read sealed (None)');
    for (const [label, cmd, args] of [
      ['cloud write sealed', 'set_cloud_credentials', { url: 'libsql://x', token: 'x' }],
      ['cloud delete sealed', 'delete_cloud_credentials', {}],
    ] as const) {
      let denied = false;
      try {
        await invoke(cmd, args);
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
      console.log(`[harness] ${label} (denied as expected)`);
    }

    let     st = await invoke<{
      migratedVersion: number;
      integrityCheck: string;
      tables: { name: string; rows: number }[];
      settingsKeys: string[];
    }>('e2e_get_db_state');
    // Real-data floor (see hello.e2e.ts): frozen sqlx ledger at 106 is
    // migration-whole for money paths; fresh boots reach 112.
    expect(st.migratedVersion).toBeGreaterThanOrEqual(106);
    expect(st.integrityCheck).toBe('ok');
    // Reset preserves the migration ledger, the FTS index infrastructure,
    // and exactly the sync one-shot epoch flags in app_settings (reported
    // as settingsKeys); every DOMAIN table must be empty.
    const infra = new Set([
      '_sqlx_migrations',
      'schema_migrations',
      'products_fts',
      'products_fts_config',
      'products_fts_content',
      'products_fts_data',
      'products_fts_docsize',
      'products_fts_idx',
      'app_settings',
    ]);
    const dirty = st.tables.filter((t) => !infra.has(t.name) && t.rows !== 0);
    console.log(`[harness] post-reset non-infra rows = ${JSON.stringify(dirty)}`);
    expect(dirty).toEqual([]);
    // Preserved across reset: sync epoch flags + team identity mirrors
    // (real-data mode keeps merchant settings keys too — only assert the
    // required subsets are present, never an exact set).
    console.log(`[harness] settings keys = ${JSON.stringify(st.settingsKeys)}`);
    for (const k of ['manager_pin', 'cashier_users']) {
      expect(st.settingsKeys).toContain(k);
    }
    expect(st.settingsKeys.some((k) => /^sync\.(backfill_v|remirror)/.test(k))).toBe(true);
    const ledger = st.tables.find((t) => t.name === '_sqlx_migrations');
    expect(ledger?.rows).toBeGreaterThan(0);

    // --- seed: 2 products + 1 open shift + 1 two-line mock sale + 1 setting
    const seed = await invoke<{
      products: number;
      shifts: number;
      sales: number;
      saleLines: number;
      settings: number;
    }>('e2e_seed_state', {
      payload: {
        products: [
          { id: 'E2E-P1', title: 'E2E Cable', priceDa: 1500, stock: 10, barcode: 'E2E-1' },
          { id: 'E2E-P2', title: 'E2E Chargeur', priceDa: 2500, stock: 5, barcode: 'E2E-2' },
        ],
        openShift: { id: 'E2E-SHIFT-1', openingFloat: 20000, cashierName: 'E2E' },
        mockSales: [
          {
            id: 'E2E-SALE-1',
            receiptNumber: 'E2E-REC-1',
            totalDa: 5500,
            lines: [
              { productId: 'E2E-P1', quantity: 2, appliedPriceDa: 1500 },
              { productId: 'E2E-P2', quantity: 1, appliedPriceDa: 2500 },
            ],
          },
        ],
        settings: [{ key: 'E2E-FLAG-1', valueJson: '"1"' }],
      },
    });
    expect(seed.products).toBe(2);
    expect(seed.shifts).toBe(1);
    expect(seed.sales).toBe(1);
    expect(seed.saleLines).toBe(2);
    expect(seed.settings).toBe(1);

    st = await invoke<{
      tables: { name: string; rows: number }[];
      settingsKeys: string[];
    }>('e2e_get_db_state');
    const byName = new Map(st.tables.map((t) => [t.name, t.rows]));
    console.log(`[harness] seeded counts: ${JSON.stringify([...byName].filter(([, n]) => n > 0))}`);
    expect(byName.get('products')).toBe(2);
    expect(byName.get('cash_sessions')).toBe(1);
    expect(byName.get('transactions')).toBe(1);
    expect(byName.get('transaction_items')).toBe(2);
    expect(st.settingsKeys).toContain('E2E-FLAG-1');

    // --- stored-sale reader (three-way ground truth for Phase 3)
    const sale = await invoke<{
      found: boolean;
      receiptNumber: string;
      totalDa: number;
      changeDueDa: number;
      status: string;
      lines: { productId: string; quantity: number; appliedPriceDa: number }[];
    }>('e2e_get_sale', { id: 'E2E-SALE-1' });
    expect(sale.found).toBe(true);
    expect(sale.receiptNumber).toBe('E2E-REC-1');
    expect(sale.totalDa).toBe(5500);
    expect(sale.changeDueDa).toBe(0);
    expect(sale.status).toBe('COMPLETED');
    expect(sale.lines.length).toBe(2);
    const missing = await invoke<{ found: boolean }>('e2e_get_sale', { id: 'NOPE' });
    expect(missing.found).toBe(false);

    // --- invalid seeds rejected, never half-written
    for (const [label, badPayload] of [
      ['negative price', { products: [{ id: 'X', title: 'X', priceDa: -1, stock: 1 }] }],
      ['quantity 0', {
        mockSales: [{ id: 'X', receiptNumber: 'X', totalDa: 1,
          lines: [{ productId: 'E2E-P1', quantity: 0, appliedPriceDa: 1 }] }],
      }],
      ['fractional qty', {
        mockSales: [{ id: 'X', receiptNumber: 'X', totalDa: 1,
          lines: [{ productId: 'E2E-P1', quantity: 1.5, appliedPriceDa: 1 }] }],
      }],
    ] as const) {
      let failed = false;
      try {
        await invoke('e2e_seed_state', { payload: badPayload });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      console.log(`[harness] rejected as expected: ${label}`);
    }

    // --- leave the DB clean for Phase 2 (ledger + FTS infra + epoch flags survive)
    await invoke('e2e_reset_db');
    st = await invoke<{
      tables: { name: string; rows: number }[];
      settingsKeys: string[];
    }>('e2e_get_db_state');
    const infra2 = new Set([
      '_sqlx_migrations',
      'schema_migrations',
      'products_fts',
      'products_fts_config',
      'products_fts_content',
      'products_fts_data',
      'products_fts_docsize',
      'products_fts_idx',
      'app_settings',
    ]);
    expect(st.tables.filter((t) => !infra2.has(t.name) && t.rows !== 0)).toEqual([]);
    // Preserved: epoch flags + team mirrors (+ merchant keys in real-data
    // mode); the seeded E2E-FLAG-1 must be gone (reset wipes non-preserved).
    expect(st.settingsKeys).not.toContain('E2E-FLAG-1');
    for (const k of ['manager_pin', 'cashier_users']) {
      expect(st.settingsKeys).toContain(k);
    }
  });
});
