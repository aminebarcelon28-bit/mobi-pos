/**
 * DIAGNOSTIC (batch 26 follow-up) — why did no receipt print call reach
 * `sqlite_print_raw_escpos`?
 *
 * Batch 26's first run reported `printCalls=0 bytes=0` for every sale, which
 * made the receipt verdicts unusable (and turned RCP-08/RCP-18 into false
 * passes). This spec asserts nothing about the app: it dumps the state needed
 * to decide whether the seam, the app path, or the environment is at fault.
 */
import { browser } from '@wdio/globals';
import { one } from '../lib/db';
import {
  APP_PIN,
  armConsoleTap,
  closeDialogs,
  ensureShiftOpen,
  installErrorTrap,
  readConsoleLines,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';

const P1 = 'PRB-P1';

type Row = Record<string, unknown>;

async function arm(mode: string): Promise<string> {
  return (await browser.execute((m: string) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke?: (...a: unknown[]) => unknown };
      __probe?: {
        mode: string;
        calls: Array<{ cmd: string; printer: string; len: number }>;
        wrapped: boolean;
        status: string;
        nonPrint: string[];
      };
    };
    if (!w.__probe) {
      w.__probe = { mode: m, calls: [], wrapped: false, status: 'init', nonPrint: [] };
    }
    const st = w.__probe;
    st.mode = m;
    st.calls = [];
    const internals = w.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      st.status = internals ? 'no-invoke-fn' : 'no-internals';
      return st.status;
    }
    if (st.wrapped) {
      st.status = 'already-wrapped';
      return st.status;
    }
    const orig = internals.invoke.bind(internals);
    st.wrapped = true;
    st.status = 'wrapped';
    internals.invoke = (...args: unknown[]) => {
      const cmd = String(args[0] ?? '');
      const a = (args[1] ?? {}) as { printerName?: unknown; data?: unknown };
      if (cmd === 'sqlite_print_raw_escpos' || cmd === 'sqlite_open_cash_drawer') {
        st.calls.push({
          cmd,
          printer: String(a.printerName ?? ''),
          len: Array.isArray(a.data) ? (a.data as number[]).length : -1,
        });
        if (st.mode === 'stub') return Promise.resolve(undefined);
        if (st.mode === 'fail') return Promise.reject(new Error('PROBE_OFFLINE'));
      } else if (st.nonPrint.length < 40) {
        st.nonPrint.push(cmd);
      }
      return orig(...args);
    };
    return st.status;
  }, mode)) as string;
}

async function probe(): Promise<{ calls: Row[]; nonPrint: string[] }> {
  return (await browser.execute(() => {
    const st = (window as unknown as { __probe?: { calls?: Row[]; nonPrint?: string[] } }).__probe;
    return { calls: st?.calls ?? [], nonPrint: st?.nonPrint ?? [] };
  })) as { calls: Row[]; nonPrint: string[] };
}

describe('batch26 diagnostic — print seam', () => {
  before(async () => {
    await installErrorTrap();
    await unlockIfNeeded(APP_PIN);
    resetData();
    seedProducts([
      { id: P1, title: 'Probe Phone', priceDa: 1000, stock: 100, barcode: 'PRBP1', category: 'Test' },
    ]);
    await browser.refresh();
    await installErrorTrap();
    await unlockIfNeeded(APP_PIN);
    await ensureShiftOpen(10000);
  });

  it('D1 environment + seam status', async () => {
    const env = (await browser.execute(() => {
      const w = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> };
      return {
        ua: navigator.userAgent,
        hasInternals: '__TAURI_INTERNALS__' in window,
        internalsKeys: w.__TAURI_INTERNALS__ ? Object.keys(w.__TAURI_INTERNALS__).slice(0, 25) : [],
        invokeType: typeof w.__TAURI_INTERNALS__?.invoke,
        hasStress: '__posStress' in window,
      };
    })) as Row;
    const status = await arm('stub');
    console.log(`[D1] status=${status} env=${JSON.stringify(env)}`);
  });

  it('D2 direct invoke of the print command through the wrapped seam', async () => {
    const res = (await browser.execute(async () => {
      const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (...a: unknown[]) => unknown } };
      try {
        const out = await w.__TAURI_INTERNALS__?.invoke?.('sqlite_print_raw_escpos', {
          printerName: 'PROBE-DIRECT',
          data: [27, 64, 10],
        });
        return { ok: true, out: String(out).slice(0, 120) };
      } catch (e) {
        return { ok: false, err: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    })) as Row;
    const p = await probe();
    console.log(`[D2] directInvoke=${JSON.stringify(res)} captured=${JSON.stringify(p.calls)}`);
  });

  it('D3 a real sale through the stress hook: which IPC commands run?', async () => {
    await armConsoleTap();
    await arm('stub');
    const sale = (await browser.execute(async () => {
      const w = window as unknown as {
        __posStress?: {
          runBatch: (
            b: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
          ) => Promise<Array<{ ok: boolean; ms: number; reason?: string }>>;
        };
      };
      if (!w.__posStress) return [{ ok: false, ms: 0, reason: 'NO_HOOK' }];
      return await w.__posStress.runBatch([{ lines: [{ id: 'PRB-P1', qty: 1 }], tenderedDa: 1000 }]);
    })) as Array<{ ok: boolean; ms: number; reason?: string }>;
    await closeDialogs(3);
    await browser.pause(2500);
    const p = await probe();
    const settings = one<{ value_json: string }>(
      "SELECT value_json FROM app_settings WHERE key = 'mobi_pos_receipt_settings'",
    );
    const tx = one<{ id: string; receipt_number: string; total: number }>(
      'SELECT id, receipt_number, total FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    const crashes = (await browser.execute(() => {
      const w = window as unknown as { __mobipos_getCrashReports?: () => unknown[] };
      try {
        return (w.__mobipos_getCrashReports?.() ?? []).slice(-5);
      } catch {
        return [];
      }
    })) as unknown[];
    const lines = await readConsoleLines();
    console.log(
      `[D3] sale=${JSON.stringify(sale)} tx=${JSON.stringify(tx)} printCalls=${JSON.stringify(p.calls)} ` +
        `otherIpc=${JSON.stringify(p.nonPrint.slice(0, 25))} settings=${JSON.stringify(settings?.value_json ?? null)}`,
    );
    console.log(`[D3] consoleTail=${JSON.stringify(lines.slice(-14))}`);
    console.log(`[D3] crashes=${JSON.stringify(crashes)}`);
  });

  it('D5 can the invoke property actually be replaced?', async () => {
    const res = (await browser.execute(async () => {
      const w = window as unknown as {
        __TAURI_INTERNALS__: Record<string, unknown> & { invoke: (...a: unknown[]) => unknown };
        __probeCalls?: number;
        __probeIdentity?: unknown;
      };
      const internals = w.__TAURI_INTERNALS__;
      const identitySame = w.__probeIdentity === internals;
      w.__probeIdentity = internals;
      const desc = Object.getOwnPropertyDescriptor(internals, 'invoke');
      const proto = Object.getPrototypeOf(internals) as object | null;
      const protoDesc = proto ? Object.getOwnPropertyDescriptor(proto, 'invoke') : undefined;
      const before = internals.invoke;
      let assignErr = '';
      try {
        internals.invoke = (...a: unknown[]) => {
          w.__probeCalls = (w.__probeCalls ?? 0) + 1;
          return before.apply(internals, a);
        };
      } catch (e) {
        assignErr = String(e);
      }
      const after = internals.invoke;
      let callOut = '';
      try {
        await after('sqlite_print_raw_escpos', { printerName: 'PROBE-D5', data: [27, 64] });
        callOut = 'resolved';
      } catch (e) {
        callOut = `rejected:${String((e as { code?: string })?.code ?? e).slice(0, 80)}`;
      }
      return {
        identitySame,
        frozen: Object.isFrozen(internals),
        sealed: Object.isSealed(internals),
        ownDesc: desc ? { writable: desc.writable, configurable: desc.configurable, get: Boolean(desc.get) } : null,
        protoDesc: protoDesc
          ? { writable: protoDesc.writable, configurable: protoDesc.configurable, get: Boolean(protoDesc.get) }
          : null,
        assignmentTook: before !== after,
        assignErr,
        beforeStr: String(before).slice(0, 90),
        afterStr: String(after).slice(0, 90),
        counter: w.__probeCalls ?? 0,
        callOut,
      };
    })) as Row;
    console.log(`[D5] ${JSON.stringify(res)}`);
  });

  it('D6 UI checkout path (not the stress hook)', async () => {
    await armConsoleTap();
    await arm('stub');
    const before = await probe();
    await browser.execute(() => {
      const tiles = [...document.querySelectorAll('[data-testid="product-tile"]')] as HTMLElement[];
      tiles[0]?.click();
    });
    await browser.pause(600);
    await browser.execute(() => {
      const btn = document.querySelector('[data-testid="checkout-button"]') as HTMLElement | null;
      btn?.click();
    });
    await browser.pause(1500);
    const payDialog = await browser.execute(() => {
      const d = document.querySelector('[data-testid="pay-dialog"]') as HTMLElement | null;
      return Boolean(d);
    });
    await closeDialogs(3);
    const p = await probe();
    const lines = await readConsoleLines();
    console.log(
      `[D4] payDialog=${String(payDialog)} newPrintCalls=${JSON.stringify(p.calls)} ` +
        `beforePrintCalls=${JSON.stringify(before.calls)} otherIpc=${JSON.stringify(p.nonPrint.slice(-10))}`,
    );
    console.log(`[D4] consoleTail=${JSON.stringify(lines.slice(-8))}`);
  });
});
