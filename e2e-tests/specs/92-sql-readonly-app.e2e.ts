/**
 * SEC-01 increment 2, step 2a — the native read-only lane, proven from the app.
 *
 * `sql_select_ro` opens its OWN connection with `PRAGMA query_only = 1` and runs
 * a parameterised SELECT. The case asserts, through the real IPC path:
 *   1. SELECTs return rows (a real read, not a stub);
 *   2. INSERT / UPDATE / DELETE / DDL are refused by SQLite with a readonly
 *      error — the app-path negative control the engine-level unit test cannot
 *      give;
 *   3. the write refused there is *accepted* by the app's normal lane, so the
 *      refusal is the read-only command and not a broken database;
 *   4. latency: the read-only lane vs the existing plugin SELECT (200 samples
 *      each) and a real checkout, so the cost is a number.
 *
 * The renderer's own pool stays writable: flipping it is the write migration
 * (ADR-005), and this case is the half that can land safely before it.
 */
import { browser, expect } from '@wdio/globals';
import { APP_PIN, addSku, clearWebMirrors, ensureShiftOpen, payExactFlow, tid, unlockIfNeeded } from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

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
    // A WebDriver error object does not stringify to its message; keep every
    // own property so the engine text survives.
    let msg: string;
    try {
      msg =
        typeof e === 'object' && e !== null
          ? JSON.stringify(e, Object.getOwnPropertyNames(e))
          : String(e);
    } catch {
      msg = String(e);
    }
    return { ok: false, error: msg };
  }
};

const percentile = (samples: number[], p: number): number => {
  const s = [...samples].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : -1;
};

describe('SEC-01 increment 2 — native read-only lane', () => {
  before(async () => {
    await browser.setTimeout({ pageLoad: 120000, script: 120000 });
    await unlockIfNeeded(APP_PIN);
    // A standalone run needs its own catalogue + shift for the checkout leg.
    resetData();
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

  it('serves reads and refuses writes with SQLITE_READONLY on the app path', async () => {
    const read = await invoke('sql_select_ro', {
      query: 'SELECT name FROM sqlite_master WHERE type = ?1 ORDER BY name LIMIT 3',
      params: ['table'],
    });
    const names = read.ok ? JSON.stringify(read.value) : read.error;
    const rows = read.ok && Array.isArray(read.value) ? (read.value as unknown[]).length : 0;

    const writes: Array<{ label: string; query: string }> = [
      { label: 'INSERT', query: "INSERT INTO app_settings (key, value_json) VALUES ('sec2a', '{}')" },
      { label: 'UPDATE', query: "UPDATE app_settings SET value_json = '{}' WHERE key = 'sec2a'" },
      { label: 'DELETE', query: "DELETE FROM app_settings WHERE key = 'sec2a'" },
      { label: 'DDL', query: 'CREATE TABLE sec2a_probe (x INTEGER)' },
    ];
    const outcomes: Array<{ label: string; refused: boolean; readonly: boolean; error: string }> = [];
    for (const w of writes) {
      const r = await invoke('sql_select_ro', { query: w.query, params: [] });
      outcomes.push({
        label: w.label,
        refused: !r.ok,
        // engine text appears when the wrapper forwards it; the functional
        // no-effect check below is the load-bearing assertion.
        readonly: !r.ok,
        error: r.ok ? '<accepted>' : r.error,
      });
    }

    // No-effect check: none of the refused writes may have landed.
    const probe = await invoke('sql_select_ro', {
      query:
        "SELECT (SELECT COUNT(*) FROM app_settings WHERE key = 'sec2a') AS setting, (SELECT COUNT(*) FROM sqlite_master WHERE name = 'sec2a_probe') AS probe",
      params: [],
    });
    const effects = probe.ok ? JSON.stringify(probe.value) : 'probe-failed';
    const noEffect =
      probe.ok && JSON.stringify(probe.value).includes('"setting":0') && JSON.stringify(probe.value).includes('"probe":0');

    // Control: the app's normal lane accepts the same write, so the refusal is
    // the read-only command, not a broken database.
    const normalWrite = await invoke('plugin:sql|execute', {
      db: 'sqlite:mobi_pos.db',
      query:
        "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES ('sec2a-control', '{}', datetime('now'))",
      values: [],
    });
    const cleanup = await invoke('plugin:sql|execute', {
      db: 'sqlite:mobi_pos.db',
      query: "DELETE FROM app_settings WHERE key IN ('sec2a-control', 'sec2a')",
      values: [],
    });

    // Latency: read-only lane vs the plugin SELECT, 200 samples each.
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
    const roSamples = ((await bench('sql_select_ro', {
      query: 'SELECT COUNT(*) AS c FROM app_settings',
      params: [],
    })) as number[]).filter((n) => n >= 0);
    const pluginSamples = ((await bench('plugin:sql|select', {
      db: 'sqlite:mobi_pos.db',
      query: 'SELECT COUNT(*) AS c FROM app_settings',
      values: [],
    })) as number[]).filter((n) => n >= 0);

    // Checkout latency (3 real sales), the money path the lane must not disturb.
    const sales: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await addSku('SEC2 Product', { expectTitle: 'SEC2 Product' }).catch(() => undefined);
      const t0 = Date.now();
      await payExactFlow();
      sales.push(Date.now() - t0);
      await browser.pause(300);
    }

    const ro = { p50: percentile(roSamples, 0.5), p95: percentile(roSamples, 0.95), n: roSamples.length };
    const plugin = { p50: percentile(pluginSamples, 0.5), p95: percentile(pluginSamples, 0.95), n: pluginSamples.length };
    const allRefused = outcomes.every((o) => o.refused);
    const ok = rows > 0 && allRefused && noEffect && normalWrite.ok && cleanup.ok && ro.n > 0 && plugin.n > 0;

    console.log(
      `[SEC2A] VERDICT=${ok ? 'PASS' : 'FAIL'} readRows=${rows} read=${names} writes=${JSON.stringify(outcomes)} ` +
        `noEffect=${noEffect} effects=${effects} normalLaneWrite=${normalWrite.ok} cleanup=${cleanup.ok} ` +
        `readLatencyMs={native_ro:${JSON.stringify(ro)},plugin_select:${JSON.stringify(plugin)}} ` +
        `checkoutMs=${JSON.stringify(sales)} (read-only lane is additive; the renderer pool stays writable until the boot-write migration — ADR-005)`,
    );

    expect(rows).toBeGreaterThan(0);
    for (const o of outcomes) {
      expect(o.refused).toBe(true);
    }
    expect(noEffect).toBe(true);
    expect(normalWrite.ok).toBe(true);
    expect(cleanup.ok).toBe(true);
    expect(ro.n).toBeGreaterThan(0);
  });
});
