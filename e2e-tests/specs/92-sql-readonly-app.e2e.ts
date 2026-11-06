/**
 * SEC-01 increment 2 — hardened native read-only lane, proven from the app.
 *
 * Every guard in `src-tauri/src/sql_ro.rs` gets an app-path probe here, and each
 * probe is paired with a control proving the database itself is writable (so a
 * refusal cannot be blamed on a broken DB or a locked file):
 *
 *   - PRAGMA query_only=0 (same call, and a follow-up write on a new call)
 *   - ATTACH / VACUUM INTO / PRAGMA writable_schema
 *   - multi-statement smuggling
 *   - INSERT ... RETURNING and WITH ... INSERT
 *   - SELECT from a credential-bearing table (app_settings) and sqlite_master
 *   - row cap
 *
 * The lane's normal use is also asserted: a parameterised SELECT returns rows,
 * and 200-sample latency is recorded (native lane vs the plugin pool) plus a real
 * checkout, so the cost stays a number.
 */
import { browser, expect } from '@wdio/globals';
import { APP_PIN, addSku, clearWebMirrors, ensureShiftOpen, payExactFlow, tid, unlockIfNeeded } from '../lib/pos';
    import { deleteBulkProducts, resetData, seedBulkProducts, seedProducts } from '../lib/seed';

type Call = { ok: true; value: unknown } | { ok: false; error: string };

const invoke = async (cmd: string, args: Record<string, unknown>): Promise<Call> => {
  try {
    const value = await browser.execute(
      (c: string, a: Record<string, unknown>) =>
        (
          window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).__TAURI_INTERNALS__.invoke(c, a),
      cmd,
      args,
    );
    return { ok: true, value };
  } catch (e) {
    let msg: string;
    try {
      msg = typeof e === 'object' && e !== null ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : String(e);
    } catch {
      msg = String(e);
    }
    return { ok: false, error: msg };
  }
};

const ro = (query: string, params: unknown[] = []) => invoke('sql_select_ro', { query, params });
const plugin = (query: string, values: unknown[] = []) =>
  invoke('plugin:sql|execute', { db: 'sqlite:mobi_pos.db', query, values });
const pluginSelect = (query: string) => invoke('plugin:sql|select', { db: 'sqlite:mobi_pos.db', query, values: [] });

const percentile = (samples: number[], p: number): number => {
  const s = [...samples].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : -1;
};

describe('SEC-01 increment 2 — hardened read-only lane', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 120000, script: 120000 });
    await unlockIfNeeded(APP_PIN);
    await resetData();
    seedProducts([
      { id: 'SEC2-P', title: 'SEC2 Product', priceDa: 1000, stock: 20, barcode: '613000009201', costDa: 400 },
    ]);
    await clearWebMirrors();
    await browser.waitUntil(
      async () => (await $(tid('shift-pill'))).isDisplayed().catch(() => false),
      { timeout: 90000, interval: 500, timeoutMsg: 'dashboard did not re-mount' },
    );
    await unlockIfNeeded(APP_PIN);
    await ensureShiftOpen();
  });

  it('refuses every write/escape probe while the database stays writable', async () => {
    // 1. normal use
    const read = await ro('SELECT id, title FROM products WHERE id = ?1', ['SEC2-P']);
    const rows = read.ok && Array.isArray(read.value) ? (read.value as unknown[]).length : 0;

    // 2. escape probes: each must be refused, and must leave no trace
    const probes: Array<{ label: string; query: string }> = [
      { label: 'PRAGMA query_only=0 (same call, then write)', query: "PRAGMA query_only=0; INSERT INTO app_settings (key, value_json) VALUES ('p1','{}')" },
      { label: 'PRAGMA query_only=0 (alone)', query: 'PRAGMA query_only = 0' },
      { label: 'ATTACH', query: "ATTACH DATABASE 'C:/tmp/sec2-attach.db' AS evil" },
      { label: 'VACUUM INTO', query: "VACUUM INTO 'C:/tmp/sec2-vacuum.db'" },
      { label: 'PRAGMA writable_schema', query: 'PRAGMA writable_schema = 1' },
      { label: 'multi-statement smuggling', query: "SELECT 1; INSERT INTO app_settings (key, value_json) VALUES ('p2','{}')" },
      { label: 'INSERT RETURNING', query: "INSERT INTO transactions (id, total) VALUES ('SEC2-X', 1) RETURNING id" },
      { label: 'WITH ... INSERT', query: "WITH x AS (SELECT 1) INSERT INTO app_settings (key, value_json) SELECT 'p3','{}'" },
      { label: 'credential table', query: 'SELECT * FROM app_settings' },
      { label: 'sqlite_master', query: 'SELECT * FROM sqlite_master' },
      { label: 'pin hash by key', query: "SELECT value_json FROM app_settings WHERE key = 'manager_pin'" },
    ];
    const refused: Array<{ label: string; ok: boolean; error: string }> = [];
    for (const p of probes) {
      const r = await ro(p.query);
      refused.push({ label: p.label, ok: !r.ok, error: r.ok ? '<ACCEPTED>' : r.error.slice(0, 120) });
    }

    // 3. second call after the PRAGMA attempt: still read-only
    const writeAfter = await ro("INSERT INTO app_settings (key, value_json) VALUES ('p4','{}')");

    // 4. no probe may have landed
    const leftover = await pluginSelect(
      "SELECT (SELECT COUNT(*) FROM app_settings WHERE key IN ('p1','p2','p3','p4')) AS settings, (SELECT COUNT(*) FROM transactions WHERE id = 'SEC2-X') AS tx",
    );
    const effects = leftover.ok ? JSON.stringify(leftover.value) : 'probe-failed';
    const noEffect = leftover.ok && effects.includes('"settings":0') && effects.includes('"tx":0');

    // 5. control: the database itself is writable, so every refusal above is
    //    the lane, not a broken/locked file. The writable path is the NATIVE
    //    lane (the renderer pool is the thing under test): write through a
    //    role-bound command, then read it back through the pool.
    const controlId = `sec2-control-${Date.now()}`;
    const controlWrite = await invoke('upsert_store_expense', {
      request: {
        id: controlId,
        category: 'Test',
        title: 'sec2 control',
        amount: 1,
        paymentMethod: 'Espèces',
        paidTo: null,
        notes: null,
        recordedBy: 'e2e',
        createdAt: new Date().toISOString(),
        jsonPayload: JSON.stringify({ id: controlId }),
      },
    });
    const controlRead = await pluginSelect(
      `SELECT COUNT(*) AS n FROM store_expenses WHERE id = '${controlId}'`,
    );
    const controlRows =
      controlRead.ok && Array.isArray(controlRead.value)
        ? Number((controlRead.value as Array<{ n?: unknown }>)[0]?.n ?? 0)
        : -1;
    const controlOk = controlWrite.ok && controlRows === 1;

    // 6. row cap, exercised on an ALLOWLISTED table (products): seed 2 100
    //    catalogue rows through the normal lane, read them, then clean up.
    // Seed out-of-band (host better-sqlite3): the pool under test is read-only,
    // and row seeding is a harness concern, not an app write.
    seedBulkProducts(2100);
    const bulkSeed = { ok: true, error: '' };
    // The WebDriver wrapper erases the engine message, so assert the cap by
    // behaviour: a read of >cap rows must not return more than the cap (and the
    // lane must still work afterwards). The exact "row limit exceeded" wording is
    // pinned by the Rust unit test.
    const capped = await ro('SELECT * FROM products');
    const afterCap = await ro('SELECT COUNT(*) AS c FROM products');
    const returnedRows = capped.ok && Array.isArray(capped.value) ? (capped.value as unknown[]).length : -1;
    const capHeld = afterCap.ok && (!capped.ok || (returnedRows >= 0 && returnedRows <= 2000));
    if (!capHeld) console.log(`[SEC2B] row-cap probe unexpected: ok=${capped.ok} rows=${returnedRows} after=${afterCap.ok}`);
    deleteBulkProducts();

    // 7. latency (200 samples each) and a real checkout
    const bench = (cmd: string, args: Record<string, unknown>) =>
      browser.executeAsync((c: string, a: Record<string, unknown>, done: (v: number[]) => void) => {
        const inv = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, p: unknown) => Promise<unknown> } })
          .__TAURI_INTERNALS__.invoke;
        void (async () => {
          const out: number[] = [];
          for (let i = 0; i < 200; i += 1) {
            const t0 = performance.now();
            try {
              await inv(c, a);
              out.push(performance.now() - t0);
            } catch {
              out.push(-1);
            }
          }
          done(out);
        })();
      }, cmd, args);
    const roSamples = ((await bench('sql_select_ro', { query: 'SELECT COUNT(*) AS c FROM products', params: [] })) as number[]).filter((n) => n >= 0);
    const pluginSamples = ((await bench('plugin:sql|select', {
      db: 'sqlite:mobi_pos.db',
      query: 'SELECT COUNT(*) AS c FROM products',
      values: [],
    })) as number[]).filter((n) => n >= 0);
    const sales: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await addSku('SEC2 Product', { expectTitle: 'SEC2 Product' }).catch(() => undefined);
      const t0 = Date.now();
      await payExactFlow();
      sales.push(Date.now() - t0);
      await browser.pause(250);
    }

    const roStats = { p50: percentile(roSamples, 0.5), p95: percentile(roSamples, 0.95), n: roSamples.length };
    const pluginStats = { p50: percentile(pluginSamples, 0.5), p95: percentile(pluginSamples, 0.95), n: pluginSamples.length };
    const allRefused = refused.every((r) => r.ok);
    const ok = rows === 1 && allRefused && !writeAfter.ok && noEffect && controlOk && capHeld && roStats.n > 0;

    console.log(
      `[SEC2B] VERDICT=${ok ? 'PASS' : 'FAIL'} readRows=${rows} probes=${JSON.stringify(refused)} ` +
        `writeAfterPragmaRefused=${!writeAfter.ok} noEffect=${noEffect} effects=${effects} ` +
        `controlOk=${controlOk} rowCap=${capHeld} bulkErr=${bulkSeed.ok ? '-' : String(bulkSeed.error).slice(0, 200)} ` +
        `readLatencyMs={native_ro:${JSON.stringify(roStats)},plugin_select:${JSON.stringify(pluginStats)}} checkoutMs=${JSON.stringify(sales)}`,
    );

    expect(rows).toBe(1);
    for (const r of refused) expect(r.ok).toBe(true);
    expect(writeAfter.ok).toBe(false);
    expect(noEffect).toBe(true);
    expect(controlOk).toBe(true);
    expect(capHeld).toBe(true);
  });
});
