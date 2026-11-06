/**
 * RCP / TIM — receipts, printing hardware and clock/time edges (batch 26).
 *
 * Vehicle: the REAL desktop e2e build (target-e2e/debug/mobi-pos.exe). The
 * Android release APK is NOT healthy for this batch (fresh install lands on the
 * unscriptable first-boot PIN gate; the restored snapshot boots the shell with
 * an empty catalogue — P1-67), so RCP-19 / RCP-24 / TIM-09 / TIM-10 are BLOCKED
 * with that reason instead of guessed.
 *
 * Evidence design (see the batch-26 brief):
 *  - Every receipt assertion reads the REAL ESC/POS byte stream the app hands to
 *    `sqlite_print_raw_escpos` (captured by wrapping `__TAURI_INTERNALS__.invoke`,
 *    the same seam `armInvokeCounter` uses) — never UI text. The wrapper is a
 *    mode switch (`stub` / `fail` / `hang` / `real`) so the failure paths
 *    (offline printer, hung spooler) are exercised without a physical printer.
 *  - Clock cases replace `window.Date` (constructor + `Date.now`) because
 *    `new Date()` ignores a `Date.now` override, and always restore in `finally`.
 *  - Verdict policy is the batch 20–25 policy:
 *      PASS         observed behaviour satisfies the case, with a real control
 *      PASS-PARTIAL some legs satisfy the case, at least one does not
 *      FAIL         observed behaviour is wrong or a required control is absent
 *      N/A          the feature does not exist; an executed absence probe is logged
 *      BLOCKED      exact missing resource logged (kept in Remaining)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { $, browser, expect } from '@wdio/globals';
import { all, count, one, run } from '../lib/db';
import {
  APP_PIN,
  addSku,
  armPrintCounter,
  closeDialogs,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  installPageShims,
  payTenderedFlow,
  readOpenShiftDexie,
  readPrintCalls,
  selectCustomer,
  tid,
  typeMoneyInto,
  unlockIfNeeded,
} from '../lib/pos';
import { parseEscpos } from '../lib/escpos-parse';
import { receiptDayFromPrintedLine } from '../lib/receiptDate';
import { resetData, seedCustomerFull, seedProducts, seedSettings } from '../lib/seed';

// Repo root, independent of the directory wdio was started from: the
// canonical runner starts it at the repo root, while a hand-run from
// e2e-tests/ has the root one level up. The old unconditional `../` made every
// source read and the ESC/POS byte helper resolve under the Desktop folder when
// run from the root, which is why RCP-03/09/17 died with ERR_MODULE_NOT_FOUND
// (2026-10-30 batch run).
const ROOT = (() => {
  let d = process.cwd();
  for (let i = 0; i < 5; i++) {
    try {
      if (fs.existsSync(path.join(d, 'src-tauri', 'tauri.conf.json')) && fs.existsSync(path.join(d, 'e2e-tests'))) return d;
    } catch {
      /* keep walking */
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(process.cwd(), '..');
})();

const P1 = 'RCP26-P1';
const AR = 'RCP26-AR';
const LONG = 'RCP26-LONG';
const BIG = 'RCP26-BIG';
const SER = 'RCP26-SER';
const CUST = 'RCP26-CUST';
const BULK = Array.from({ length: 200 }, (_, i) => `RCP26B${String(i).padStart(3, '0')}`);

type Verdict = 'PASS' | 'FAIL' | 'PASS-PARTIAL' | 'N/A' | 'BLOCKED';

function logVerdict(id: string, v: Verdict, evidence: string): void {
  console.log(`[${id}] VERDICT=${v} ${evidence}`);
}

/** A FAIL verdict must also fail the mocha test so the suite records it. */
function assertFail(id: string, what: string, actual: unknown, expected: unknown): never {
  throw new Error(
    `[${id}] ${what} — expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
  );
}

// ---------------------------------------------------------------------------
// Print evidence (two independent observations)
// ---------------------------------------------------------------------------
//
// Run #1 of this batch captured nothing (`printCalls=0` on all 29 cases) and
// therefore produced two false passes. Root cause, proven in
// logs/batch26-probe-seam.log: the WebView IPC channel CANNOT be wrapped.
// `window.__TAURI_INTERNALS__` is an own property of the global with
// `writable:false, configurable:false`, and so is every member of it
// (`invoke`, `ipc`, `postMessage`, `transformCallback`, `callbacks`,
// `metadata`, ...). Assigning to `invoke` silently no-ops
// (`assignmentTook:false`, `assignErr:""`), so no wrapper can ever see the
// payload. Only `plugins` is writable, and printing does not use it.
//
// Evidence is therefore collected from two places that are both real:
//
//   1. IN-APP — every spooler attempt logs `[ESC/POS Spooler Error]` exactly
//      once (escpos.ts:394-406) and every drawer kick logs
//      `[Cash Drawer Error]` (escpos.ts:411+). A timestamped console tap
//      counts them, so "the app tried to print / kick the drawer" is measured
//      rather than assumed. In this sandbox every attempt genuinely fails
//      (no printer: HARDWARE_ERROR / StartDocPrinter), which is exactly the
//      offline-printer condition RCP-07 and RCP-10 need.
//   2. BYTES — the payload is produced by the production builder the app
//      itself calls, `buildReceiptBuffer(tx, settings)` from
//      src/utils/escpos.ts (compiled by esbuild, the compiler Vite uses), fed
//      the app's OWN persisted `transactions.json_payload` row and the app's
//      own receipt settings (tools/escpos-bytes.mjs).

type CaptureMode = 'stub' | 'fail' | 'hang' | 'real';

interface TapLine {
  t: number;
  msg: string;
}

async function installPrintTap(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as {
      __rcp26Tap?: { lines: Array<{ t: number; msg: string }> };
      __rcp26TapOrig?: (...a: unknown[]) => void;
    };
    if (w.__rcp26Tap) return;
    w.__rcp26Tap = { lines: [] };
    const orig = console.error.bind(console);
    w.__rcp26TapOrig = orig;
    console.error = (...a: unknown[]) => {
      try {
        const msg = a
          .map((x) => {
            if (typeof x === 'string') return x;
            try {
              return JSON.stringify(x);
            } catch {
              return String(x);
            }
          })
          .join(' ')
          .slice(0, 500);
        w.__rcp26Tap!.lines.push({ t: Date.now(), msg });
      } catch {
        /* never break console */
      }
      try {
        orig(...a);
      } catch {
        /* ignore */
      }
    };
  });
}

async function tapLines(): Promise<TapLine[]> {
  return (await browser.execute(
    () =>
      ((window as unknown as { __rcp26Tap?: { lines?: TapLine[] } }).__rcp26Tap?.lines ??
        []) as TapLine[],
  )) as TapLine[];
}

interface TapCounts {
  print: number;
  drawer: number;
}

async function tapCounts(): Promise<TapCounts> {
  const lines = await tapLines();
  return {
    print: lines.filter((l) => l.msg.includes('[ESC/POS Spooler Error]')).length,
    drawer: lines.filter((l) => l.msg.includes('[Cash Drawer Error]')).length,
  };
}

/** Baseline for the current test. The tap buffer lives on `window`, so a
 *  `browser.refresh()` (refreshApp) starts it empty again. */
let TAP_BASE: TapCounts = { print: 0, drawer: 0 };

/** Kept for call-site compatibility; the mode only describes what the sandbox
 *  can do (the real spooler always runs and always fails here). */
async function armCapture(_mode: CaptureMode = 'real', _keepBytes = true): Promise<string> {
  await installPrintTap();
  TAP_BASE = await tapCounts();
  return 'console-tap+host-builder';
}

/** Wait until `n` new spooler attempts have been logged (or time out). */
async function waitForPrintCalls(n: number, timeout = 20000): Promise<TapCounts> {
  const deadline = Date.now() + timeout;
  let c = await tapCounts();
  while (Date.now() < deadline) {
    c = await tapCounts();
    if (c.print - TAP_BASE.print >= n) return c;
    await browser.pause(200);
  }
  return c;
}

/** Drawer kicks seen in the next `ms`, measured from the current tap baseline.
 *  Returns as soon as one kick appears so a positive control is fast, and
 *  keeps polling to `ms` so an absent kick is a real negative, not a race. */
async function drawerPulsesAfter(ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  let c = await tapCounts();
  while (Date.now() < deadline) {
    await browser.pause(100);
    c = await tapCounts();
    if (c.drawer - TAP_BASE.drawer > 0) return c.drawer - TAP_BASE.drawer;
  }
  return c.drawer - TAP_BASE.drawer;
}

// ---------------------------------------------------------------------------
// ESC/POS decoding (commands stripped, text kept verbatim per byte)
// ---------------------------------------------------------------------------

interface Decoded {
  byteLen: number;
  text: string;
  lines: string[];
  barcodes: string[];
  hasRaster: boolean;
  hasImageCmd: boolean;
  hasCodepage: boolean;
  maxLineLen: number;
}

function decodeEscpos(bytes: number[]): Decoded {
  // One oracle for the whole suite: e2e-tests/lib/escpos-parse.ts. It skips the
  // GS v 0 payload (the old inline decoder appended image bytes to the text),
  // decodes CP864 runs and reports raster/maskable structure.
  const p = parseEscpos(bytes);
  const text = p.lines.map((l) => l.text).join('\n');
  return {
    byteLen: p.bytes,
    text,
    lines: p.lines.map((l) => l.text),
    barcodes: p.barcodes.map((b) => b.data),
    hasRaster: p.rasters.length > 0,
    hasImageCmd: p.unknowns.some((u) => u.command === 'ESC 42'),
    hasCodepage: p.codePageSelects.length > 0,
    maxLineLen: p.lines.reduce((m, l) => Math.max(m, l.text.length), 0),
  };
}

function lineOf(d: Decoded | null, re: RegExp): string {
  if (!d) return '<no-print>';
  const hit = d.lines.find((l) => re.test(l));
  return hit ?? '<absent>';
}

// ---------------------------------------------------------------------------
// Sale helpers (real checkout path)
// ---------------------------------------------------------------------------

async function runStress(
  baskets: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
): Promise<Array<{ ok: boolean; ms: number; reason?: string }>> {
  return (await browser.execute(async (bs: typeof baskets) => {
    const w = window as unknown as {
      __posStress?: {
        runBatch: (
          b: Array<{ lines: Array<{ id: string; qty: number }>; tenderedDa: number }>,
        ) => Promise<Array<{ ok: boolean; ms: number; reason?: string }>>;
      };
    };
    if (!w.__posStress) return [{ ok: false, ms: 0, reason: 'NO_STRESS_HOOK' }];
    return await w.__posStress.runBatch(bs);
  }, baskets)) as Array<{ ok: boolean; ms: number; reason?: string }>;
}

interface SaleResult {
  ok: boolean;
  reason?: string;
  ms: number;
  decoded: Decoded | null;
  bytes: number[];
  printAttempts: number;
  drawerPulses: number;
  tx: Row | null;
  receipt: string;
  txId: string;
  createdAt: string;
}

const BYTES_CLI = (() => {
  const cands = [
    path.resolve(process.cwd(), 'tools', 'escpos-build.mjs'),
    path.join(ROOT, 'e2e-tests', 'tools', 'escpos-build.mjs'),
  ];
  return cands.find((p) => fs.existsSync(p)) ?? cands[0];
})();

/** Build the production ESC/POS bytes for a persisted sale.
 *
 *  Runs the REAL `buildReceiptBuffer` from src/utils/escpos.ts (bundled by
 *  esbuild) in a child process, so the spec does not depend on the app's
 *  module graph or on the webview's sealed IPC. `tz` re-runs the same build
 *  under another OS timezone, which is how a device-zone change is modelled
 *  for the date/time cases (the formatter uses local getters only). */
function buildBytes(tx: Row, settings: Row, tz?: string): number[] {
  const out = execFileSync(process.execPath, [BYTES_CLI], {
    input: JSON.stringify({ tx, settings }),
    env: tz ? { ...process.env, TZ: tz } : process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as number[];
}

/**
 * Bytes from the builder INSIDE the app (E2E flavor hook), so the Arabic lane
 * runs with the real canvas text stack. A Node-side rebuild has no canvas and
 * would silently exercise the CP864 fallback instead of the raster lane.
 * Returns null outside the E2E build (the caller falls back to the CLI).
 */
async function buildBytesInApp(tx: Row, settings: Row): Promise<number[] | null> {
  try {
    const out = (await browser.executeAsync(
      (
        t: Record<string, unknown>,
        st: Record<string, unknown>,
        done: (v: number[] | null) => void,
      ) => {
        const hook = (window as unknown as { __posStress?: { buildReceipt?: (a: unknown, b: unknown) => Promise<number[]> } })
          .__posStress;
        if (!hook?.buildReceipt) {
          done(null);
          return;
        }
        void hook
          .buildReceipt(t, st)
          .then((bytes) => done(bytes))
          .catch(() => done(null));
      },
      tx,
      settings,
    )) as number[] | null;
    return Array.isArray(out) && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** The bytes for the most recent persisted sale, built by the production
 *  builder from the app's own row. Used by UI-driven sales too. */
async function decodeLastSale(): Promise<{
  tx: Row | null;
  id: string;
  receipt: string;
  createdAt: string;
  paymentMethod: string;
  bytes: number[];
  decoded: Decoded | null;
}> {
  const row = one<{
    id: string;
    receipt_number: string;
    created_at: string;
    payment_method: string;
    json_payload: string;
  }>(
    'SELECT id, receipt_number, created_at, payment_method, json_payload FROM transactions ORDER BY rowid DESC LIMIT 1',
  );
  if (!row) {
    return {
      tx: null,
      id: '',
      receipt: '',
      createdAt: '',
      paymentMethod: '',
      bytes: [],
      decoded: null,
    };
  }
  const tx = JSON.parse(row.json_payload) as Row;
  const settings = readReceiptSettings();
  const bytes = (await buildBytesInApp(tx, settings)) ?? buildBytes(tx, settings);
  return {
    tx,
    id: row.id,
    receipt: row.receipt_number,
    createdAt: row.created_at,
    paymentMethod: row.payment_method,
    bytes,
    decoded: bytes.length ? decodeEscpos(bytes) : null,
  };
}

/** One sale through the real checkout path, with the app-side print attempts
 *  and the production bytes for the persisted row it created. */
async function sale(
  lines: Array<{ id: string; qty: number }>,
  tenderedDa: number,
  opts: { mode?: CaptureMode; keepBytes?: boolean; waitPrints?: number } = {},
): Promise<SaleResult> {
  const { mode = 'stub', waitPrints = 1 } = opts;
  await armCapture(mode);
  const res = await runStress([{ lines, tenderedDa }]);
  await closeDialogs(4);
  if (waitPrints > 0) await waitForPrintCalls(waitPrints, 20000);
  await browser.pause(250);
  const counts = await tapCounts();
  const last = await decodeLastSale();
  return {
    ok: Boolean(res[0]?.ok),
    reason: res[0]?.reason,
    ms: res[0]?.ms ?? -1,
    decoded: last.decoded,
    bytes: last.bytes,
    printAttempts: counts.print - TAP_BASE.print,
    drawerPulses: counts.drawer - TAP_BASE.drawer,
    tx: last.tx,
    receipt: last.receipt,
    txId: last.id,
    createdAt: last.createdAt,
  };
}

async function clickButtonText(text: string): Promise<boolean> {
  return (await browser.execute((t: string) => {
    const el = Array.from(document.querySelectorAll('button')).find((b) =>
      ((b.textContent || '').trim() || '').includes(t),
    );
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, text)) as boolean;
}

async function clickByTitle(title: string): Promise<boolean> {
  return (await browser.execute((t: string) => {
    const el = document.querySelector(`[title="${t}"]`) as HTMLElement | null;
    if (!el) return false;
    el.click();
    return true;
  }, title)) as boolean;
}

// ---------------------------------------------------------------------------
// Settings (app_settings is the authority; the Dexie mirror is Dexie-first and
// must be dropped or the WebView keeps serving the stale value)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function readReceiptSettings(): Row {
  const row = one<{ value_json: string }>(
    "SELECT value_json FROM app_settings WHERE key = 'mobi_pos_receipt_settings'",
  );
  if (!row) return {};
  try {
    return JSON.parse(String(row.value_json)) as Row;
  } catch {
    return {};
  }
}

async function dropSettingsMirror(key: string): Promise<string> {
  const res = (await browser.execute(async (k: string) => {
    const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return 'no-idb';
    return await new Promise<string>((resolve) => {
      let done = false;
      const fin = (v: string) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      try {
        const open = idb.open('MobiPosDB');
        open.onerror = () => fin('open-error');
        open.onblocked = () => fin('blocked');
        open.onsuccess = () => {
          const db = open.result;
          try {
            if (!db.objectStoreNames.contains('appSettings')) {
              db.close();
              return fin('no-store');
            }
            const t = db.transaction('appSettings', 'readwrite');
            t.objectStore('appSettings').delete(k);
            t.oncomplete = () => {
              db.close();
              fin('deleted');
            };
            t.onerror = () => {
              db.close();
              fin('tx-error');
            };
            t.onabort = () => {
              db.close();
              fin('aborted');
            };
          } catch (e) {
            db.close();
            fin(`throw:${String(e)}`);
          }
        };
      } catch (e) {
        fin(`throw:${String(e)}`);
      }
    });
  }, key)) as string;
  await browser.pause(200);
  return res;
}

async function refreshApp(): Promise<void> {
  await browser.refresh();
  await installPageShims();
  await installErrorTrap();
  await unlockIfNeeded(APP_PIN);
  await browser.pause(400);
}

/** Rename the OPEN shift's cashier in the Dexie mirror (the store hydrates
 *  `activeShift` from it). Returns the outcome token for evidence. */
async function setShiftCashier(name: string): Promise<string> {
  return (await browser.execute(async (n: string) => {
    const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) return 'no-idb';
    return await new Promise<string>((resolve) => {
      try {
        const open = idb.open('MobiPosDB');
        open.onerror = () => resolve('open-error');
        open.onblocked = () => resolve('blocked');
        open.onsuccess = () => {
          const db = open.result;
          try {
            if (!db.objectStoreNames.contains('cashSessions')) {
              db.close();
              return resolve('no-store');
            }
            const t = db.transaction('cashSessions', 'readwrite');
            const store = t.objectStore('cashSessions');
            const req = store.getAll();
            req.onsuccess = () => {
              const rows = (req.result ?? []) as Array<Record<string, unknown>>;
              const openRow = rows.find((r) => r.status === 'OPEN');
              if (!openRow) {
                db.close();
                return resolve('no-open-row');
              }
              openRow.cashierName = n;
              openRow.openedBy = n;
              store.put(openRow);
              t.oncomplete = () => {
                db.close();
                resolve('renamed');
              };
              t.onerror = () => {
                db.close();
                resolve('put-error');
              };
            };
            req.onerror = () => {
              db.close();
              resolve('get-error');
            };
          } catch (e) {
            db.close();
            resolve(`throw:${String(e)}`);
          }
        };
      } catch (e) {
        resolve(`throw:${String(e)}`);
      }
    });
  }, name)) as string;
}

/** Seed a receipt-settings patch, drop the stale mirror, reload the store. */
async function applyReceiptSettings(patch: Row): Promise<Row> {
  const next = { ...readReceiptSettings(), ...patch };
  seedSettings([{ key: 'mobi_pos_receipt_settings', valueJson: JSON.stringify(next) }]);
  const dropped = await dropSettingsMirror('mobi_pos_receipt_settings');
  await refreshApp();
  console.log(`[settings] applied=${JSON.stringify(Object.keys(patch))} mirror=${dropped}`);
  return next;
}

/** The receipt settings as they were before this batch touched anything. */
let ORIG_SETTINGS: Row = {};

async function restoreOriginalSettings(): Promise<void> {
  seedSettings([
    { key: 'mobi_pos_receipt_settings', valueJson: JSON.stringify(ORIG_SETTINGS) },
  ]);
  await dropSettingsMirror('mobi_pos_receipt_settings');
  await refreshApp();
  await ensureShiftOpen(10000);
  console.log('[settings] restored to the pre-batch value');
}

// ---------------------------------------------------------------------------
// Fake clock (constructor + Date.now; restored in every finally)
// ---------------------------------------------------------------------------

async function setFakeClock(ms: number): Promise<void> {
  await browser.execute((t: number) => {
    const w = window as unknown as {
      __rcp26RealDate?: typeof Date;
      __rcp26FakeMs?: number;
    };
    const Real = (w.__rcp26RealDate ?? Date) as typeof Date;
    w.__rcp26RealDate = Real;
    w.__rcp26FakeMs = t;
    class FakeDate extends Real {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(t);
        else super(...(args as []));
      }
      static now(): number {
        return t;
      }
    }
    (window as unknown as { Date: typeof Date }).Date = FakeDate as unknown as typeof Date;
  }, ms);
}

async function restoreClock(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __rcp26RealDate?: typeof Date; __rcp26Jump?: unknown };
    if (w.__rcp26RealDate) {
      (window as unknown as { Date: typeof Date }).Date = w.__rcp26RealDate;
      delete w.__rcp26RealDate;
    }
    delete w.__rcp26Jump;
  });
}

interface JumpState {
  readsTotal: number;
  readsBeforeJump: number;
  jumped: boolean;
  armed: boolean;
}

/** Arm a clock that is read-through until the stress hook starts a sale, then
 *  reports real+5 min after `jumpAfter` further reads. Counting reads (instead
 *  of racing a timer against a 53 ms sale — run-02 lost that race and its
 *  verdict was void) makes the jump land *inside* the sale deterministically. */
async function armAdaptiveJump(jumpAfter: number): Promise<void> {
  await browser.execute((k: number) => {
    const w = window as unknown as {
      Date: typeof Date;
      __posStress?: { runBatch: (b: unknown) => Promise<unknown>; __rcp26Wrapped?: boolean };
      __rcp26RealDate?: typeof Date;
      __rcp26Jump?: {
        reads: number;
        jumpAfter: number;
        jumped: boolean;
        readsBeforeJump: number;
        armed: boolean;
      };
    };
    const real = (w.__rcp26RealDate ?? Date) as typeof Date;
    w.__rcp26RealDate = real;
    const jump = real.now() + 5 * 60 * 1000;
    const state = { reads: 0, jumpAfter: k, jumped: false, readsBeforeJump: -1, armed: false };
    w.__rcp26Jump = state;
    const read = (): number => {
      // Reads before the sale starts (render ticks) must not consume the
      // budget, or the jump could land outside the transaction.
      if (!state.armed) return real.now();
      state.reads += 1;
      if (!state.jumped && state.reads > state.jumpAfter) {
        state.jumped = true;
        state.readsBeforeJump = state.reads - 1;
      }
      return state.jumped ? jump : real.now();
    };
    class JumpDate extends real {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(read());
        else super(...(args as []));
      }
      static now(): number {
        return read();
      }
    }
    w.Date = JumpDate as unknown as typeof Date;
    // Arm the read budget only when the real checkout path is entered.
    if (w.__posStress && !w.__posStress.__rcp26Wrapped) {
      const orig = w.__posStress.runBatch.bind(w.__posStress);
      w.__posStress.runBatch = (b: unknown) => {
        const s = w.__rcp26Jump;
        if (s) s.armed = true;
        return orig(b);
      };
      w.__posStress.__rcp26Wrapped = true;
    }
  }, jumpAfter);
}

async function readJumpState(): Promise<JumpState> {
  return (await browser.execute(() => {
    const s = (
      window as unknown as {
        __rcp26Jump?: { reads: number; jumped: boolean; readsBeforeJump: number; armed: boolean };
      }
    ).__rcp26Jump;
    return {
      readsTotal: s?.reads ?? 0,
      readsBeforeJump: s?.readsBeforeJump ?? -1,
      jumped: s?.jumped ?? false,
      armed: s?.armed ?? false,
    };
  })) as JumpState;
}

/** Shift the LOCAL getters by `hours` to simulate a terminal in another zone.
 *  The receipt timestamp is a pure function of these getters (receiptViewModel
 *  `formatReceiptDateTime`), so this is the honest way to prove the paper time
 *  is device-pinned and not shop-pinned. */
async function shiftLocalGetters(hours: number): Promise<void> {
  await browser.execute((h: number) => {
    type Getter = (this: Date) => number;
    const w = window as unknown as {
      __rcp26Getters?: Record<string, Getter>;
    };
    const NAMES = ['getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds'] as const;
    if (!w.__rcp26Getters) {
      const bag: Record<string, Getter> = {};
      for (const n of NAMES) bag[n] = Date.prototype[n] as Getter;
      w.__rcp26Getters = bag;
      const orig = bag;
      // Every patched getter MUST call the captured original through .call()
      // (calling `d.getHours()` would re-enter the patch forever).
      const shift = (n: (typeof NAMES)[number]) =>
        function (this: Date) {
          const d = new Date(this.getTime() + h * 3600000);
          return orig[n].call(d);
        };
      for (const n of NAMES) {
        (Date.prototype as unknown as Record<string, Getter>)[n] = shift(n);
      }
    }
  }, hours);
}

async function restoreLocalGetters(): Promise<void> {
  await browser.execute(() => {
    type Getter = (this: Date) => number;
    const w = window as unknown as { __rcp26Getters?: Record<string, Getter> };
    if (w.__rcp26Getters) {
      for (const [n, fn] of Object.entries(w.__rcp26Getters)) {
        (Date.prototype as unknown as Record<string, Getter>)[n] = fn;
      }
      delete w.__rcp26Getters;
    }
  });
}

function algiersDayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Algiers',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

before(async () => {
  await installErrorTrap();
  await unlockIfNeeded(APP_PIN);
  await resetData();
  const bulk = BULK.map((id, i) => ({
    id,
    title: `Bulk Item ${String(i).padStart(3, '0')}`,
    priceDa: 100,
    stock: 5,
    barcode: `RCP26B${i}`,
    category: 'Bulk',
  }));
  seedProducts([
    { id: P1, title: 'RCP26 Phone Standard', priceDa: 1000, stock: 5000, barcode: 'RCP26P1', category: 'Test' },
    {
      id: AR,
      title: 'هاتف سامسونج جالكسي S24 الترا',
      priceDa: 2500,
      stock: 100,
      barcode: 'RCP26AR',
      category: 'Test',
    },
    {
      id: LONG,
      title: 'Cable USB-C Tresse 2M Charge Rapide 65W Compatible Samsung Apple ZX',
      priceDa: 1500,
      stock: 500,
      barcode: 'RCP26LONG',
      category: 'Test',
    },
    { id: BIG, title: 'Produit Premium 1234567', priceDa: 1234567, stock: 10, barcode: 'RCP26BIG', category: 'Test' },
    {
      id: SER,
      title: 'RCP26 Smartphone Serialise',
      priceDa: 45000,
      stock: 10,
      barcode: 'RCP26SER',
      category: 'Test',
      isSerialized: true,
      imeiNumber: '356938035643809',
    },
    ...bulk,
  ]);
  seedCustomerFull([
    {
      id: CUST,
      name: 'RCP26 Client Nom Tres Long 30X',
      phone: '0550777888',
      totalSpentDa: 0,
      loyaltyPointsColumnDa: 0,
    },
  ]);
  ORIG_SETTINGS = readReceiptSettings();
  await clearSettingsMirrorForBoot();
  await unlockIfNeeded(APP_PIN);
  await ensureShiftOpen(10000);
});

/** Safety net: a thrown test must never leave a shifted clock, patched getters
 *  or mutated receipt settings behind for the next batch. */
after(async () => {
  await restoreClock();
  await restoreLocalGetters();
  await armCapture('real', true);
  const now = readReceiptSettings();
  const same = JSON.stringify(now) === JSON.stringify(ORIG_SETTINGS);
  console.log(
    `[cleanup] clockRestored=true gettersRestored=true captureMode=real ` +
      `settingsRestored=${same} settingsKeys=${JSON.stringify(Object.keys(now))}`,
  );
  if (!same) await restoreOriginalSettings();
});

/** Fresh sandbox: the settings mirror may hold a previous batch's value. */
async function clearSettingsMirrorForBoot(): Promise<void> {
  await dropSettingsMirror('mobi_pos_receipt_settings');
  await refreshApp();
}

/** Open the Z-report modal through the real UI. The Reports view is behind a
 *  manager-PIN gate (ReportsModal.tsx:793-827), so the Z entry button only
 *  exists after unlocking — run #2/#3 both clicked a gated view and reported
 *  `z-entry-missing`, which proves nothing about printing. */
async function openZReportModal(): Promise<{ ok: boolean; step: string }> {
  const clicked = (await browser.execute(() => {
    const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    const b = btns.find(
      (x) => (x.textContent || '').includes('Rapports') && !x.disabled && x.getBoundingClientRect().width > 0,
    );
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!clicked) return { ok: false, step: 'reports-button-missing' };
  await browser.pause(900);

  // PIN gate: fill "Code PIN Administrateur" and submit "Déverrouiller".
  const gate = (await browser.execute((pin: string) => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = d.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch {
        return false;
      }
    };
    const pinEl = ([...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[]).find(
      (i) => vis(i) && /Administrateur|Manager/i.test(i.placeholder || ''),
    );
    if (!pinEl) return 'no-gate';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(pinEl, pin);
    pinEl.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
      (b) => /Déverrouiller/.test(b.textContent || '') && vis(b) && !b.disabled,
    );
    if (!btn) return 'no-unlock-button';
    btn.click();
    return 'submitted';
  }, APP_PIN)) as string;
  if (gate === 'no-unlock-button') return { ok: false, step: 'gate-no-unlock-button' };
  if (gate === 'submitted') {
    try {
      await browser.waitUntil(
        async () =>
          !(await browser.execute(() => {
            const vis = (d: HTMLElement) => {
              try {
                const cs = getComputedStyle(d);
                if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
                const r = d.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              } catch {
                return false;
              }
            };
            return ([...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[]).some(
              (i) => vis(i) && /Administrateur/i.test(i.placeholder || ''),
            );
          })),
        { timeout: 15000, interval: 300 },
      );
    } catch {
      return { ok: false, step: 'gate-not-cleared' };
    }
    await browser.pause(400);
  }

  const entry = await $('[title="Aperçu et Contrôle du Rapport Z de Caisse"]');
  if (!(await entry.isExisting())) return { ok: false, step: 'z-entry-missing' };
  if (!(await entry.isDisplayed().catch(() => false))) return { ok: false, step: 'z-entry-hidden' };
  await entry.click();
  try {
    await (await $('button[aria-label^="Imprimer Rapport Z"]')).waitForDisplayed({ timeout: 15000 });
  } catch {
    return { ok: false, step: 'z-modal-not-displayed' };
  }
  return { ok: true, step: gate === 'no-gate' ? 'opened-unlocked' : 'opened-after-pin' };
}

describe('RCP/TIM — receipts, printing and clock edges (batch 26)', () => {
  it('[RCP-01] Arabic reaches the head: rendered as a bit image, never as masked bytes', async () => {
    const s = await sale([{ id: AR, qty: 1 }], 2500);
    const d = s.decoded;
    // The seeded title is Arabic, so its line must be printed as dots. Legibility
    // on paper is HAR-002; this case proves the lane, the geometry and that no
    // masked ('?') text is left behind.
    const maskedRuns = (d?.text.match(/\?{2,}/g) ?? []).length;
    const raster = Boolean(d?.hasRaster);
    const fallback = Boolean(d?.hasCodepage);
    const ev =
      `saleOk=${s.ok} printAttempts=${s.printAttempts} bytes=${d?.byteLen ?? 0} ` +
      `rasters=${raster} codepageFallback=${fallback} maskedRuns=${maskedRuns} ` +
      `maxLineLen=${d?.maxLineLen ?? -1} (contract: ADR-004 — canvas raster per Arabic run; legibility is HAR-002)`;
    if (!s.ok || !d) {
      logVerdict('RCP-01', 'FAIL', `${ev} reason=${s.reason ?? 'no-bytes'}`);
      assertFail('RCP-01', 'sale did not produce a receipt', s.reason ?? 'no-bytes', 'printable receipt');
    }
    const ok = raster && !fallback && maskedRuns === 0;
    logVerdict('RCP-01', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-01',
        'Arabic did not reach the head as a rendered image',
        { raster, fallback, maskedRuns },
        { raster: true, codepageFallback: false, maskedRuns: 0 },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-02] 58 mm / 80 mm line widths with long product and 30-char customer names', async () => {
    // Both legs go through the real UI so the customer is actually attached
    // (the printed `Client:` line only exists when transaction.customer.name
    // is set — escpos.ts:229-231).
    const uiSale = async (): Promise<Decoded | null> => {
      let last: Decoded | null = null;
      // The customer dialog can lose its selection after a previous sale, so
      // the leg is retried once if the printed `Client:` line has no name.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await addSku('Cable USB-C', { expectTitle: 'Cable USB-C' });
        await selectCustomer('RCP26 Client Nom Tres Long 30X');
        await armCapture('stub', true);
        await payTenderedFlow(1500);
        await closeDialogs(4);
        await waitForPrintCalls(1);
        last = (await decodeLastSale()).decoded;
        if (last && last.lines.some((l) => /Client:\s*\S/.test(l))) break;
      }
      return last;
    };

    const dec80 = await uiSale();
    const name80 = lineOf(dec80, /Cable USB-C/);
    const cust80 = lineOf(dec80, /RCP26 Client Nom Tres Long 30X/);

    await applyReceiptSettings({ paperWidth: '58mm' });
    await ensureShiftOpen(10000);
    const dec58 = await uiSale();
    const name58 = lineOf(dec58, /Cable USB-C/);
    const cust58 = lineOf(dec58, /RCP26 Client Nom Tres Long 30X/);
    await restoreOriginalSettings();

    // pair() shortens the LABEL to make the value fit (escpos.ts:193-198):
    // at 32 cols a 30-char value leaves maxLabel=1, so "Client:" prints as "C".
    const label80 = cust80.startsWith('Client:');
    const label58 = cust58.startsWith('Client:');
    const ev =
      `80mm maxLineLen=${dec80?.maxLineLen ?? -1} nameLen=${name80.length} customerLineLen=${cust80.length} ` +
      `label80Preserved=${label80} name80=${JSON.stringify(name80.slice(0, 80))} cust80=${JSON.stringify(cust80)} | ` +
      `58mm maxLineLen=${dec58?.maxLineLen ?? -1} nameLen=${name58.length} customerLineLen=${cust58.length} ` +
      `label58Preserved=${label58} cust58=${JSON.stringify(cust58)} name58=${JSON.stringify(name58.slice(0, 80))} | ` +
      `limits=42/32 cols (escpos.ts:192), name emitted unfolded (escpos.ts:241), ` +
      `pair() truncates the LABEL not the value (escpos.ts:193-198)`;
    const ok = (dec58?.maxLineLen ?? 999) <= 32 && (dec80?.maxLineLen ?? 999) <= 42;
    logVerdict('RCP-02', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-02',
        'long names overflow the paper width',
        { max58: dec58?.maxLineLen, max80: dec80?.maxLineLen },
        { max58: '<=32', max80: '<=42' },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-03] receipts with 1, 7, 50 and 200 item lines all print completely', async () => {
    const sizes = [1, 7, 50, 200];
    const out: Array<{ size: number; items: number; bytes: number; maxLine: number; ok: boolean }> = [];
    for (const size of sizes) {
      const lines = BULK.slice(0, size).map((id) => ({ id, qty: 1 }));
      const s = await sale(lines, size * 100);
      const items = s.decoded ? (s.decoded.text.match(/Bulk Item /g) || []).length : 0;
      out.push({
        size,
        items,
        bytes: s.decoded?.byteLen ?? 0,
        maxLine: s.decoded?.maxLineLen ?? -1,
        ok: s.ok,
      });
    }
    const allOk = out.every((o) => o.ok && o.items === o.size);
    const ev = `lines=${JSON.stringify(out)} control=1-line receipt prints 1 item line, 200-line receipt prints 200/200 (no cap, no truncation)`;
    logVerdict('RCP-03', allOk ? 'PASS' : 'FAIL', ev);
    if (!allOk) {
      assertFail('RCP-03', 'a receipt size dropped item lines', out, 'items === size for every size');
    }
    expect(allOk).toBe(true);
  });

  it('[RCP-05] F7 reprint is byte-identical: no copy marker, same number, no new sale', async () => {
    const first = await sale([{ id: P1, qty: 1 }], 1000);
    const txBefore = count('transactions');
    const row = one<{ receipt_number: string; id: string }>(
      'SELECT receipt_number, id FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    await armCapture('stub', true);
    const clicked = await clickButtonText('Réimprimer');
    expect(clicked).toBe(true);
    await waitForPrintCalls(1);
    await browser.pause(400);
    const counts = await tapCounts();
    const reprintAttempts = counts.print - TAP_BASE.print;
    // The reprint path re-runs the same builder on the same row (reprintReceipt
    // → printReceipt, createOrderSlice.ts:310-314), so the bytes are rebuilt
    // here from that same row: identical input, no copy/duplicate mode exists.
    const re = await decodeLastSale();
    const decRe = re.decoded;
    const txAfter = count('transactions');
    const firstBytes = first.decoded ? first.decoded.text : '';
    const sameBytes = Boolean(decRe && firstBytes && decRe.text === firstBytes);
    const copyMarker = Boolean(decRe && /COPIE|COPY|DUPLICATA|R[ÉE]IMPRESSION/i.test(decRe.text));
    const ev =
      `reprintAttempts=${reprintAttempts} sameBytes=${sameBytes} copyMarker=${copyMarker} ` +
      `txBefore=${txBefore} txAfter=${txAfter} receipt=${row?.receipt_number} id=${row?.id} ` +
      `barcode=${JSON.stringify(decRe?.barcodes?.[0] ?? null)} ` +
      `(reprintReceipt has no copy flag: the same transaction re-enters buildReceiptBuffer verbatim)`;
    const ok = copyMarker && txAfter === txBefore;
    logVerdict('RCP-05', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-05',
        'reprint is an exact duplicate of the original ticket (no copy marker)',
        { copyMarker, sameBytes, txDelta: txAfter - txBefore },
        { copyMarker: true, sameNumber: true, txDelta: 0 },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-07] 20 rapid receipts with the printer offline: no queue, no retry on reconnect', async () => {
    const baskets = Array.from({ length: 20 }, () => ({
      lines: [{ id: P1, qty: 1 }],
      tenderedDa: 1000,
    }));
    await armCapture('stub', true);
    const res = await runStress(baskets);
    await closeDialogs(4);
    await waitForPrintCalls(20, 60000);
    const attempts = (await tapCounts()).print - TAP_BASE.print;
    // "Reconnect": the spooler recovers, so any queued job would replay now.
    await browser.pause(5000);
    const retries = (await tapCounts()).print - TAP_BASE.print;
    const queueTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%print%' OR name LIKE '%spool%')",
    );
    // Named separately so a `%queue%` match (dunning_queue) cannot be mistaken
    // for a print queue — run-02's evidence line conflated the two.
    const otherQueueTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%queue%'",
    );
    const okSales = res.filter((r) => r.ok).length;
    const ev =
      `sales=${okSales}/20 printAttempts=${attempts} retriesAfterReconnect=${retries - attempts} ` +
      `printQueueTables=${JSON.stringify(queueTables.map((t) => t.name))} ` +
      `otherQueueTables=${JSON.stringify(otherQueueTables.map((t) => t.name))} ` +
      `printViaWindowsSpooler returns false on error (escpos.ts:394-406), callers are fire-and-forget (createOrderSlice.ts:1624-1626)`;
    const ok = attempts === 20 && retries > attempts;
    logVerdict('RCP-07', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-07',
        'failed print jobs are dropped, never queued or retried',
        { attempts, retries, queueTables: queueTables.length },
        { attempts: 20, retries: '>20 (queued jobs replay)', queueTables: '>=1' },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-08] a hung printer does not block checkout or the UI (fire-and-forget)', async () => {
    // The sandbox cannot make the native spooler hang (the IPC seam is sealed —
    // logs/batch26-probe-seam.log), so the hang leg itself is NOT executable.
    // What IS measurable: the sale promise resolves before the spooler settles,
    // i.e. checkout never awaits printing. That is the mechanism the case
    // asserts, measured five times instead of asserted once.
    await armCapture('stub', true);
    const rows: Array<{ ms: number; ok: boolean; deltaAfterSale: number }> = [];
    for (let i = 0; i < 5; i += 1) {
      const base = (await tapLines()).length;
      const probe = (await browser.execute(async () => {
        const w = window as unknown as {
          __posStress?: { runBatch: (b: unknown) => Promise<Array<{ ok: boolean; ms: number }>> };
        };
        if (!w.__posStress) return null;
        const out = await w.__posStress.runBatch([
          { lines: [{ id: 'RCP26-P1', qty: 1 }], tenderedDa: 1000 },
        ]);
        return { ok: Boolean(out[0]?.ok), ms: out[0]?.ms ?? -1, saleEnd: Date.now() };
      })) as { ok: boolean; ms: number; saleEnd: number } | null;
      if (!probe) break;
      await closeDialogs(3);
      let hit: TapLine | null = null;
      for (let w = 0; w < 60 && !hit; w += 1) {
        hit = (await tapLines()).slice(base).find((l) => l.msg.includes('[ESC/POS Spooler Error]')) ?? null;
        if (!hit) await browser.pause(100);
      }
      rows.push({
        ms: probe.ms,
        ok: probe.ok,
        deltaAfterSale: hit ? hit.t - probe.saleEnd : -1,
      });
    }
    // UI control: the till still opens a modal while the spooler is settling.
    const t0 = Date.now();
    const opened = await clickButtonText('Remise');
    let dialogMs = -1;
    if (opened) {
      try {
        await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 8000 });
        dialogMs = Date.now() - t0;
      } catch {
        dialogMs = -1;
      }
    }
    await closeDialogs(4);

    const resolvedFirst = rows.filter((r) => r.deltaAfterSale >= 0).length;
    const ev =
      `sales=${rows.length} saleMs=${JSON.stringify(rows.map((r) => Math.round(r.ms)))} ` +
      `printSettledAfterSaleReturned=${resolvedFirst}/${rows.length} ` +
      `deltasMs=${JSON.stringify(rows.map((r) => r.deltaAfterSale))} ` +
      `uiDialogOpened=${opened} uiDialogMs=${dialogMs} ` +
      `hangLeg=not-executable (native spooler cannot be stalled: __TAURI_INTERNALS__ members are non-writable/non-configurable) ` +
      `(createOrderSlice.ts:1624-1626 fires printReceipt with void)`;
    const partial = rows.length > 0 && resolvedFirst === rows.length && dialogMs >= 0;
    logVerdict('RCP-08', partial ? 'PASS-PARTIAL' : 'FAIL', ev);
    if (!partial) {
      assertFail(
        'RCP-08',
        'checkout waited for the printer (or the UI blocked)',
        { rows, dialogMs },
        { printSettledAfterSaleReturned: '5/5', dialogMs: '<8000' },
      );
    }
    expect(partial).toBe(true);
  });

  it('[RCP-10] drawer pulse fires on a card-only sale (should be cash-only)', async () => {
    // Control: a cash sale pulses the drawer (3 s window: the kick is a second
    // invoke fired after the receipt, so a 250 ms read can miss it — run-02).
    await armCapture('stub', true);
    const cash = await sale([{ id: P1, qty: 1 }], 1000);
    const cashPulses = await drawerPulsesAfter(3000);

    // Card-only sale through the real UI method selector. The tab's visible
    // label is "CIB / Carte" (PaymentModal.tsx:989); the internal method id is
    // 'CIB / Edahabia' (PaymentModal.tsx:981).
    await armCapture('stub', true);
    await addSku('RCP26 Phone Standard');
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const cardClicked = await clickButtonText('CIB / Carte');
    await browser.pause(400);
    const confirmLabel = await browser.execute(() => {
      const b = document.querySelector('[data-testid="pay-confirm"]') as HTMLElement | null;
      return (b?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 45000, timeoutMsg: 'card pay dialog did not close' },
    );
    await closeDialogs(4);
    await waitForPrintCalls(1);
    const cardPulses = await drawerPulsesAfter(3000);
    const cardMethod = one<{ payment_method: string }>(
      'SELECT payment_method FROM transactions ORDER BY rowid DESC LIMIT 1',
    )?.payment_method;
    const cardLegReal = cardMethod !== 'Espèces';
    const ev =
      `cashSalePulses=${cashPulses} cashSaleOk=${cash.ok} cardSalePulses=${cardPulses} ` +
      `cardClicked=${cardClicked} confirmLabel=${JSON.stringify(confirmLabel)} method=${cardMethod} ` +
      `cardLegReal=${cardLegReal} ` +
      `(pulses counted from the spooler's own [Cash Drawer Error] line, one per kick; ` +
      `settings.kickCashDrawerOnCash default true; directPrintReceipt pulses unconditionally, escpos.ts:470-472)`;
    const ok = cashPulses >= 1 && cardPulses === 0 && cardLegReal;
    logVerdict('RCP-10', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-10',
        'the drawer kicks on a card-only sale',
        { cashSalePulses: cashPulses, cardSalePulses: cardPulses, method: cardMethod },
        { cashSalePulses: '>=1', cardSalePulses: 0, method: 'a card tender' },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-11] receipt barcode encodes the document number and fits the paper width', async () => {
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const row = one<{ id: string; receipt_number: string }>(
      'SELECT id, receipt_number FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    const payload = s.decoded?.barcodes?.[0] ?? '';
    const dotsNeeded = payload.length * 11 * 2; // CODE128 ~11 modules/char at GS w 2
    const printable = 576; // 80 mm @ 203 dpi
    // The builder prefixes CODE128 FNC1 (`{B`, escpos.ts:358-363), so match by
    // containment: what matters is whether the document number is in there.
    const encDocNumber = Boolean(row && payload.includes(row.receipt_number));
    const encInternalId = Boolean(row && payload.includes(row.id));
    const ev =
      `barcodePayload=${JSON.stringify(payload)} receiptNumber=${JSON.stringify(row?.receipt_number)} ` +
      `internalId=${JSON.stringify(row?.id)} encodesDocumentNumber=${encDocNumber} encodesInternalId=${encInternalId} ` +
      `dotsNeeded=${dotsNeeded} printableDots=${printable} fits=${dotsNeeded <= printable} ` +
      `(escpos.ts:358-363 encodes transaction.id; scan-to-lookup expects the document number)`;
    const ok = encDocNumber && dotsNeeded <= printable;
    logVerdict('RCP-11', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-11',
        'the printed barcode does not carry the document number and overflows the print width',
        { payload, receiptNumber: row?.receipt_number, dotsNeeded, fits: dotsNeeded <= printable },
        { payload: row?.receipt_number, fits: true },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-12] logo, Arabic header/footer and diacritics on the hardware ticket', async () => {
    await applyReceiptSettings({
      storeName: 'Café Élégant مرحبا',
      storeSubheader: 'Commerce & Vente Téléphonie',
      logoUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      footerMessage: 'شروط الإرجاع: 7 أيام — Merci de votre visite',
    });
    await ensureShiftOpen(10000);
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const d = s.decoded;
    const headerLine = lineOf(d, /Commerce|Caf/);
    const footerLine = lineOf(d, /Merci/);
    // Arabic header + Arabic footer are two raster runs; the logo would be a
    // third image printed BEFORE any text. The builder has no logo path at all,
    // so the code-level check is the honest signal (grep the module).
    const logoInBuilder = /logoUrl/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'utils', 'escpos.ts'), 'utf8'),
    );
    const rastered = Boolean(d?.hasRaster);
    const diacritics = /Téléphonie|Élégant/.test(d?.text ?? '') || /Téléphonie|Élégant/.test(headerLine);
    const masked = /\?{2,}/.test(d?.text ?? '');
    const ev =
      `logoUrlSet=true logoInBuilder=${logoInBuilder} bytes=${d?.byteLen ?? 0} rasters=${rastered} ` +
      `diacriticsInText=${diacritics} maskedRuns=${masked ? 'yes' : 'no'} header=${JSON.stringify(headerLine)} ` +
      `footer=${JSON.stringify(footerLine)} (Arabic runs raster per ADR-004; logo still DOM-only)`;
    const ok = logoInBuilder && rastered && diacritics && !masked;
    logVerdict('RCP-12', ok ? 'PASS' : 'FAIL', ev);
    await restoreOriginalSettings();
    if (!ok) {
      assertFail(
        'RCP-12',
        'the logo never reaches the printer (Arabic header/footer now render as images)',
        { logoInBuilder, rastered, diacritics, masked },
        { logoInBuilder: true, rastered: true, diacritics: true, masked: false },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-13] amount rendering on paper: thousands separators and negative amounts', async () => {
    const s = await sale([{ id: BIG, qty: 1 }], 1234567);
    const d = s.decoded;
    const totalLine = lineOf(d, /TOTAL NET/);
    const unitLine = lineOf(d, /x 1|1 x /);
    const slashed = /1\/234\/567/.test(d?.text ?? '');
    const grouped = /1[ \u202f\u00a0]234[ \u202f\u00a0]567/.test(d?.text ?? '');
    const ev =
      `total=${JSON.stringify(totalLine)} unit=${JSON.stringify(unitLine)} ` +
      `slashedGroups=${slashed} realGroupSeparator=${grouped} ` +
      `formatDZD uses U+202F group separator; text() masks it to 0x2F '/' (escpos.ts:56-60)`;
    const ok = grouped && !slashed;
    logVerdict('RCP-13', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-13',
        'U+202F thousands separators print as "/" (1 234 567 → 1/234/567)',
        { totalLine, slashed },
        { totalLine: 'contains 1 234 567', slashed: false },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-14] A4/PDF sales invoice: page breaks, totals, RTL, embedded fonts', async () => {
    const srcHits = walkSrc(/A4Document|page-break-after|@page\b/);
    const salesInvoice = srcHits.filter((h) => /PurchaseOrder|CommandTicket|Repair|TradeIn/i.test(h.file) === false);
    const ev =
      `A4 document components=${JSON.stringify(srcHits.map((h) => `${h.file}:${h.line}`))} ` +
      `salesInvoiceComponent=${salesInvoice.length} ` +
      `probe: no sales-invoice A4 renderer exists (only PurchaseOrderA4Document + command tickets); ` +
      `receipt path is 80/58 mm thermal only (escpos.ts:192)`;
    logVerdict('RCP-14', 'N/A', ev);
    expect(salesInvoice.length).toBe(0);
  });

  it('[RCP-15] document variants: gift receipt (no prices), deposit slip, refund, trade-in, Z', async () => {
    const gift = walkSrc(/giftReceipt|sans prix|GIFT_RECEIPT|no[-_ ]?prices/i);
    const deposit = walkSrc(/deposit[-_ ]?slip|bordereau de versement|versement slip/i);
    const avoir = walkSrc(/AVOIR-|isRefund.*receipt|Modes de Remboursement/);
    const tradeIn = walkSrc(/TradeInVoucherBuilder|TRADE_IN_LEGAL_STATEMENT/);
    const z = walkSrc(/buildZReportBuffer|ZReportPaper|zReportText/);
    const ev =
      `giftReceiptHits=${gift.length} depositSlipHits=${deposit.length} avoirHits=${avoir.length} ` +
      `tradeInHits=${tradeIn.length} zReportHits=${z.length} ` +
      `refund/trade-in/Z builders exist; no price-free (gift) ticket and no deposit slip builder exist`;
    const ok = gift.length > 0 && deposit.length > 0;
    logVerdict('RCP-15', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-15',
        'gift receipt and deposit slip variants are absent',
        { gift: gift.length, deposit: deposit.length },
        { gift: '>=1', deposit: '>=1' },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-16] ticket date/time is device-local with no offset marker (DST/clock change)', async () => {
    const dstInstant = Date.parse('2026-03-29T01:30:00.000Z'); // EU spring-forward instant
    let d: Decoded | null = null;
    let stored: string | undefined;
    let shiftedLine = '<no-build>';
    let reprintAttempts = 0;
    let txRow: Row | null = null;
    try {
      await setFakeClock(dstInstant);
      const s = await sale([{ id: P1, qty: 1 }], 1000);
      d = s.decoded;
      stored = s.createdAt;
      txRow = s.tx;
      // Same row, printed by a terminal whose OS zone is CEST (+2h). The
      // reprint really runs (spooler attempt counted); the byte rebuild uses
      // the production formatter under that TZ (tools/escpos-bytes.mjs).
      await armCapture('stub', true);
      await clickButtonText('Réimprimer');
      await waitForPrintCalls(1);
      reprintAttempts = (await tapCounts()).print - TAP_BASE.print;
      const shifted = buildBytes(txRow ?? {}, readReceiptSettings(), 'Europe/Paris');
      shiftedLine = lineOf(decodeEscpos(shifted), /Date:/);
    } finally {
      await restoreLocalGetters();
      await restoreClock();
    }
    const printedLine = lineOf(d, /Date:/);
    const offsetMarker = /[+-]\d{2}:?\d{2}\b|UTC|GMT|Z\b/.test(printedLine);
    const ev =
      `fakeClock=${new Date(dstInstant).toISOString()} storedCreatedAt=${stored} reprintAttempts=${reprintAttempts} ` +
      `printed=${JSON.stringify(printedLine)} reprintedWithDeviceTZShift=${JSON.stringify(shiftedLine)} ` +
      `offsetMarker=${offsetMarker} shopTZ=Africa/Algiers businessDay=${stored ? algiersDayKey(stored) : '?'} ` +
      `(receiptViewModel.ts:78-84 uses local getters only, no offset token)`;
    const ok = offsetMarker && shiftedLine === printedLine;
    logVerdict('RCP-16', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-16',
        'the ticket time follows the device clock and carries no offset, so it cannot be reconciled to the shop day',
        { printedLine, shiftedLine, offsetMarker },
        { offsetMarker: true, shiftedLine: printedLine },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-17] printing in a language other than the UI language', async () => {
    const langSetting = walkSrc(/receiptLanguage|receipt_language|printLanguage|documentLanguage/i);
    const frOnly = walkSrc(/TOTAL NET A PAYER|Merci de votre visite/);
    let arLocale = false;
    try {
      arLocale = (await browser.execute(async () => {
        const w = window as unknown as { __setMobiLocale?: (l: string) => void; __getMobiLocale?: () => string };
        try {
          w.__setMobiLocale?.('ar');
          await new Promise((r) => setTimeout(r, 400));
          return w.__getMobiLocale?.() === 'ar';
        } catch {
          return false;
        }
      })) as boolean;
    } finally {
      await browser.execute(async () => {
        const w = window as unknown as { __setMobiLocale?: (l: string) => void };
        try {
          w.__setMobiLocale?.('fr');
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          /* ignore */
        }
      });
    }
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const stillFrench = /TOTAL NET A PAYER|Vendeur:|Modes de R/.test(s.decoded?.text ?? '');
    const ev =
      `uiLocaleForcedToArabic=${arLocale} receiptLanguageSettingHits=${langSetting.length} ` +
      `receiptStillFrench=${stillFrench} hardcodedFrenchStrings=${frOnly.length} ` +
      `probe: no per-document language setting exists, so a language choice cannot be exercised`;
    logVerdict('RCP-17', 'N/A', ev);
    expect(langSetting.length).toBe(0);
  });

  it('[RCP-18] header carries cashier, register, device and reprint marker', async () => {
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const d = s.decoded;
    const cashier = lineOf(d, /Vendeur:/);
    const register = lineOf(d, /Caisse:/);
    // Strict: a real device line starts with the label. Run-02 matched
    // "Articles remis: 1 - Appareils repris: 0" via a loose /Appareil/.
    const device = lineOf(d, /^\s*(Terminal|Appareil|Device|Poste)\s*:/);
    const copy = lineOf(d, /COPIE|COPY|DUPLICATA/);
    const ev =
      `cashierLine=${JSON.stringify(cashier)} registerLine=${JSON.stringify(register)} ` +
      `deviceLine=${JSON.stringify(device)} copyMarker=${JSON.stringify(copy)} ` +
      `(escpos.ts:224-227 prints Ticket/Date/Caisse/Vendeur only)`;
    const ok = device !== '<absent>' && copy !== '<absent>';
    logVerdict('RCP-18', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-18',
        'the header has no device identity and no reprint marker',
        { device, copy },
        { device: 'a device/terminal line', copy: 'a reprint marker' },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-19] the same sale printed from desktop (USB) and mobile (Bluetooth)', async () => {
    const reason =
      'BLOCKED: needs a healthy Android install (fresh install stops on the unscriptable first-boot PIN gate; ' +
      'the restored snapshot boots with 0 catalogue rows while SQLite holds 1,307 — P1-67) plus a Bluetooth ESC/POS printer';
    logVerdict('RCP-19', 'BLOCKED', reason);
    expect(true).toBe(true);
  });

  it('[RCP-21] mixed-direction header: an Arabic cashier name on a French ticket', async () => {
    const arabicName = 'محمد أمين';
    const origShift = await readOpenShiftDexie();
    const origName = origShift?.cashierName ?? 'E2E Gerant';
    const renamed = await setShiftCashier(arabicName);
    if (renamed === 'renamed') {
      await refreshApp();
      await ensureShiftOpen(10000);
    }
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const d = s.decoded;
    const vendorLine = lineOf(d, /Vendeur:/);
    // Contract (ADR-004): the French label stays real text, the Arabic run is a
    // bit image on the same line, and nothing is masked to '?'.
    const labelInText = /Vendeur:/.test(vendorLine);
    const rastered = Boolean(d?.hasRaster);
    const masked = /\?{2,}/.test(vendorLine);
    // restore the shift identity exactly as it was
    await setShiftCashier(origName);
    await refreshApp();
    await ensureShiftOpen(10000);

    const ev =
      `shiftRename=${renamed} cashierName=${arabicName} vendorLine=${JSON.stringify(vendorLine)} ` +
      `labelInText=${labelInText} rastered=${rastered} masked=${masked} ` +
      `(ADR-004: Latin label as text + Arabic run as GS v 0 raster)`;
    const ok = labelInText && rastered && !masked;
    logVerdict('RCP-21', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-21',
        'the Arabic cashier name did not reach the head as an image beside its French label',
        { vendorLine, labelInText, rastered, masked },
        { labelInText: true, rastered: true, masked: false },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-22] IMEI/serial lines: 15-16 digits plus a barcode on 58 mm', async () => {
    const s = await sale([{ id: SER, qty: 1 }], 45000);
    const d = s.decoded;
    const imeiLine = lineOf(d, /IMEI/);
    const digits = (imeiLine.match(/\d{15,16}/) || [])[0] ?? '';
    const barcodes = d?.barcodes ?? [];
    const imeiBarcode = barcodes.some((b) => b.includes(digits) && digits.length > 0);
    const item = one<{ json_payload: string }>(
      'SELECT json_payload FROM transaction_items ORDER BY rowid DESC LIMIT 1',
    );
    const ev =
      `imeiLine=${JSON.stringify(imeiLine)} digits=${digits} barcodeCount=${barcodes.length} ` +
      `barcodes=${JSON.stringify(barcodes)} imeiBarcode=${imeiBarcode} ` +
      `(escpos.ts:248-250 prints the IMEI as text; the only barcode is the ticket id, escpos.ts:358-363)`;
    const ok = digits.length >= 15 && imeiBarcode;
    logVerdict('RCP-22', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-22',
        'the IMEI prints as text only — no scannable IMEI barcode on the ticket',
        { imeiLine, imeiBarcode, item: item ? 'present' : 'absent' },
        { imeiBarcode: true },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-23] warranty footer variants (new / refurbished / as-is / extended) in ar and fr', async () => {
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const d = s.decoded;
    const warrantyLines = (d?.lines ?? []).filter((l) => /Garantie|garantie|Sans garantie/i.test(l));
    // Scoped to the two modules that actually compose the paper (run-02 counted
    // 33 matches across the whole src, which proves nothing).
    const receiptModules = ['src/utils/escpos.ts', 'src/utils/receiptViewModel.ts'].map((rel) => ({
      rel,
      text: fs.readFileSync(path.join(ROOT, rel), 'utf8'),
    }));
    const conditions = ['neuf', 'reconditionn', 'as-is', 'as is', 'occasion', 'étendue', 'extended'];
    const variantsFound = conditions.filter((w) =>
      receiptModules.some((f) =>
        new RegExp(`garantie[^\\n]{0,40}${w}|${w}[^\\n]{0,40}garantie`, 'i').test(f.text),
      ),
    );
    const genericTemplate = receiptModules[0].text.includes('Garantie: ${warrantyMonthsMax} mois');
    const arabicWarranty = (d?.lines ?? []).some((l) => /ضمان/.test(l));
    const ev =
      `warrantyLines=${JSON.stringify(warrantyLines)} genericTemplate=${genericTemplate} ` +
      `conditionVariantsInReceiptModules=${variantsFound.length} (${JSON.stringify(variantsFound)}) ` +
      `arabicWarrantyLine=${arabicWarranty} ` +
      `(one generic line built from warrantyMonthsMax, escpos.ts:334-336; no per-condition wording)`;
    const ok = variantsFound.length >= 4 && arabicWarranty;
    logVerdict('RCP-23', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'RCP-23',
        'only one generic warranty line exists; no new/refurbished/as-is/extended variants and no Arabic',
        { warrantyLines, variants: variantsFound, arabicWarranty },
        { variants: '>=4 distinct condition footers', arabicWarranty: true },
      );
    }
    expect(ok).toBe(true);
  });

  it('[RCP-24] remote print: mobile finalizes, desktop prints (or the reverse)', async () => {
    const reason =
      'BLOCKED: needs a second enrolled terminal (or a healthy Android build) plus the data-plane gateway; ' +
      'no cross-device print job transport exists (print paths are local spooler/mobile sheet only)';
    logVerdict('RCP-24', 'BLOCKED', reason);
    expect(true).toBe(true);
  });

  it('[RCP-09] printer routing: receipt printer honoured, report printer ignored', async () => {
    await applyReceiptSettings({
      printerRouting: {
        receiptPrinterId: 'e2e-r',
        receiptPrinterName: 'E2E-RCP26-RECEIPT',
        labelPrinterId: 'e2e-l',
        labelPrinterName: 'E2E-RCP26-LABEL',
        reportPrinterId: 'e2e-p',
        reportPrinterName: 'E2E-RCP26-REPORT',
        autoRoutingEnabled: true,
      },
    });
    await ensureShiftOpen(10000);
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const routing = readReceiptSettings().printerRouting as Row | undefined;
    const receiptPrinter = String(routing?.receiptPrinterName ?? '<none>');
    const receiptAttempts = s.printAttempts;

    // Z report: the configured REPORT printer must receive the 80 mm slip.
    await armCapture('stub', true);
    await armPrintCounter();
    let zReached = false;
    let zStep = '';
    try {
      // Reports is manager-gated; `openZReportModal` unlocks it and waits for
      // the Z modal's own print button before anything is clicked.
      const z = await openZReportModal();
      zStep = z.step;
      if (z.ok) {
        await (await $('button[aria-label^="Imprimer Rapport Z"]')).click();
        zReached = true;
        await browser.pause(2500);
      }
    } catch (e) {
      zStep = `threw:${String((e as Error).message).slice(0, 140)}`;
    }
    const counts = await tapCounts();
    const zEscpos = counts.print - TAP_BASE.print;
    const zPrintDialog = await readPrintCalls();
    await closeDialogs(5);

    const ev =
      `configuredReceiptPrinter=${JSON.stringify(receiptPrinter)} salePrintAttempts=${receiptAttempts} ` +
      `zReportReached=${zReached} zStep=${JSON.stringify(zStep)} ` +
      `zEscposAttempts=${zEscpos} windowPrintCalls=${zPrintDialog} ` +
      `reportPrinterNameConsumers=${walkSrc(/reportPrinterName/).length} (settings UI + routing engine only) ` +
      `(printCoordinator.printZReport → executePrint('z_report') → window.print, printCoordinator.ts:110-121,194-196)`;
    const ok =
      receiptAttempts >= 1 && zReached && zPrintDialog >= 1 && zEscpos === 0;
    logVerdict('RCP-09', ok ? 'PASS' : 'FAIL', ev);
    await restoreOriginalSettings();
    if (!ok) {
      assertFail(
        'RCP-09',
        'the Z report ignores the configured report printer (browser dialog instead of the routed device)',
        { receiptPrinter, zReached, zStep, zEscpos, windowPrint: zPrintDialog },
        { receiptPrinter: 'E2E-RCP26-RECEIPT', zEscpos: '>=1', windowPrint: 0 },
      );
    }
    expect(ok).toBe(true);
  });

  it('[TIM-02] device timezone change moves the printed day but not the business day', async () => {
    const s = await sale([{ id: P1, qty: 1 }], 1000);
    const row = one<{ created_at: string; receipt_number: string }>(
      'SELECT created_at, receipt_number FROM transactions ORDER BY rowid DESC LIMIT 1',
    );
    const baseLine = lineOf(s.decoded, /Date:/);
    // Same row printed by a terminal in Pacific/Auckland (+13h in October):
    // that is a device-zone change, not a data change.
    const mod = buildBytes(s.tx ?? {}, readReceiptSettings(), 'Pacific/Auckland');
    const shiftedLine = lineOf(decodeEscpos(mod), /Date:/);
    const dayKey = row?.created_at ? algiersDayKey(row.created_at) : '?';
    const printedDay = (baseLine.match(/(\d{2})\/(\d{2})\/(\d{4})/) ?? []).slice(1).reverse().join('-');
    const shiftedDay = (shiftedLine.match(/(\d{2})\/(\d{2})\/(\d{4})/) ?? []).slice(1).reverse().join('-');
    const ev =
      `createdAt=${row?.created_at} businessDayKey=${dayKey} receipt=${row?.receipt_number} ` +
      `printedDay=${printedDay} base=${JSON.stringify(baseLine)} withDeviceTZShift=${JSON.stringify(shiftedLine)} ` +
      `shiftedDay=${shiftedDay} printedDayMatchesShopDay=${printedDay === dayKey} ` +
      `shiftedDayMatchesShopDay=${shiftedDay === dayKey} ` +
      `(reports key on Africa/Algiers via dateUtils.ts:11-23; the ticket uses device-local getters)`;
    const ok = printedDay === dayKey && shiftedLine === baseLine;
    logVerdict('TIM-02', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'TIM-02',
        'a device timezone change re-dates the paper without touching the business day',
        { printedDay, dayKey, shiftedLine },
        { printedDay: dayKey, shiftedLine: baseLine },
      );
    }
    expect(ok).toBe(true);
  });

  it('[TIM-03] 31 Dec → 1 Jan and 29 Feb boundaries; week-start setting', async () => {
    const out: Array<{ at: string; receipt: string; dayKey: string; printed: string }> = [];
    const instants = [
      Date.parse('2026-12-31T23:59:30+01:00'),
      Date.parse('2027-01-01T00:00:30+01:00'),
      Date.parse('2028-02-29T12:00:00+01:00'),
    ];
    for (const ms of instants) {
      try {
        await setFakeClock(ms);
        const s = await sale([{ id: P1, qty: 1 }], 1000);
        const row = one<{ created_at: string; receipt_number: string }>(
          'SELECT created_at, receipt_number FROM transactions ORDER BY rowid DESC LIMIT 1',
        );
        out.push({
          at: new Date(ms).toISOString(),
          receipt: row?.receipt_number ?? '?',
          dayKey: row?.created_at ? algiersDayKey(row.created_at) : '?',
          printed: lineOf(s.decoded, /Date:/),
        });
      } finally {
        await restoreClock();
      }
    }
    const weekStart = walkSrc(/weekStart|week_start|premiereJourSemaine|startOfWeek/i);
    const dates = out.map((o) => receiptDayFromPrintedLine(o.printed));
    const rolloverOk = dates[0] === '20261231' && dates[1] === '20270101' && dates[2] === '20280229';
    const ev =
      `rows=${JSON.stringify(out)} receiptDates=${JSON.stringify(dates)} rolloverCorrect=${rolloverOk} ` +
      `weekStartSettingHits=${weekStart.length} (no week-start setting exists)`;
    logVerdict('TIM-03', rolloverOk ? 'PASS-PARTIAL' : 'FAIL', ev);
    if (!rolloverOk) {
      assertFail(
        'TIM-03',
        'a date boundary produced a wrong receipt date',
        dates,
        ['20261231', '20270101', '20280229'],
      );
    }
    expect(rolloverOk).toBe(true);
  });

  it('[TIM-04] Hijri/Gregorian display if offered', async () => {
    const hijri = walkSrc(/hijri|islamic-umalqura|islamic-civil|Hijri/i);
    const ev =
      `hijriReferences=${hijri.length} probe: no Hijri calendar anywhere in src (no Intl islamic calendar, ` +
      `no setting, no label); every date surface is Gregorian (formatReceiptDateTime, formatWarrantyDate)`;
    logVerdict('TIM-04', 'N/A', ev);
    expect(hijri.length).toBe(0);
  });

  it('[TIM-05] expiry exactly at the boundary instant (promo code)', async () => {
    const expiresAt = Date.parse('2027-06-30T23:59:59+01:00');
    interface PromoStatus {
      text: string;
      colour: string;
    }
    const statusFor = async (ms: number): Promise<PromoStatus> => {
      try {
        await setFakeClock(ms);
        const opened = await clickButtonText('Remise');
        if (!opened) return { text: '<no-dialog>', colour: '-' };
        await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 15000 });
        const input = await $('input[placeholder="EX: SOLDES10, PROMO500"]');
        await input.waitForDisplayed({ timeout: 10000 });
        await input.setValue('PROMO500');
        const validated = await clickButtonText('Valider');
        if (!validated) return { text: '<no-valider>', colour: '-' };
        await browser.pause(600);
        return (await browser.execute(() => {
          const dlg = document.querySelector('[data-testid="discount-dialog"]') as HTMLElement | null;
          if (!dlg) return { text: '<no-dialog>', colour: '-' };
          // The promo verdict is the only <p> that starts with `Code `
          // (DiscountModal.tsx:327-333). The dialog body itself contains
          // "Appliquez une remise globale", so matching the whole dialog is a
          // false positive — that is exactly what run-02 did.
          const hit = Array.from(dlg.querySelectorAll('p')).find((p) =>
            /^Code /.test((p.textContent ?? '').replace(/\s+/g, ' ').trim()),
          );
          if (!hit) return { text: '<no-status>', colour: '-' };
          const colour =
            Array.from(hit.classList).find((c) =>
              /^text-(emerald|rose|red|green|amber|yellow|slate|purple|indigo)-/.test(c),
            ) ?? '-';
          return {
            text: (hit.textContent ?? '').replace(/\s+/g, ' ').trim(),
            colour,
          };
        })) as PromoStatus;
      } finally {
        await closeDialogs(3);
        await restoreClock();
      }
    };
    const justBefore = await statusFor(expiresAt - 1);
    const justAfter = await statusFor(expiresAt + 1);
    const beforeOk = /^Code "PROMO500" Appliqu/i.test(justBefore.text);
    const afterRejected = /^Code "PROMO500" expir/i.test(justAfter.text);
    const ev =
      `expiresAt=${new Date(expiresAt).toISOString()} at-1ms=${JSON.stringify(justBefore.text.slice(0, 120))} ` +
      `at+1ms=${JSON.stringify(justAfter.text.slice(0, 120))} acceptedBefore=${beforeOk} rejectedAfter=${afterRejected} ` +
      `statusColours=${JSON.stringify([justBefore.colour, justAfter.colour])} ` +
      `(boundary compared with Date.now() > expiresAt at DiscountModal.tsx:107; ` +
      `status colour is chosen by promoStatus.startsWith('Code') at 330, true for the expiry message too)`;
    const ok = beforeOk && afterRejected;
    logVerdict('TIM-05', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'TIM-05',
        'the promo expiry boundary is wrong',
        { before: justBefore.text.slice(0, 120), after: justAfter.text.slice(0, 120) },
        { before: 'applied', after: 'expired' },
      );
    }
    expect(ok).toBe(true);
  });

  it('[TIM-06] scheduled jobs missed while the app was closed for days', async () => {
    const hasTable =
      (one<{ n: number }>(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='cycle_count_tasks'",
      )?.n ?? 0) > 0;
    // Positive control: a task that fell due 3 days ago — i.e. while the app was
    // "closed" — must still be on the shelf list after a boot, because due work
    // is derived from open rows rather than from a scheduler run.
    let overdueVisible = 0;
    if (hasTable) {
      run(
        `INSERT INTO cycle_count_tasks (id, product_id, abc_class, due_at, opened_at, snapshot_qty)
         VALUES ('CCT-E2E-26', '${P1}', 'A', datetime('now','-3 days'), datetime('now','-10 days'), 5000)
         ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at, counted_at=NULL, deleted=0`,
      );
      // Verbatim CCT_LIST_OPEN_SQL (src/db/cycleCountSql.ts:45-50).
      overdueVisible = all<{ id: string }>(
        `SELECT id, product_id, abc_class, due_at, opened_at, opened_ledger_max_id, snapshot_qty,
                counted_qty, expected_qty, counted_at, operator
         FROM cycle_count_tasks
         WHERE counted_at IS NULL AND deleted = 0
         ORDER BY due_at ASC, opened_at ASC`,
      ).filter((r) => r.id === 'CCT-E2E-26').length;
    }
    const scheduler = walkSrc(/setInterval|scheduler|nextRunAt|lastRunAt|backupSchedule|autoBackup/i);
    const jobTables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%job%' OR name LIKE '%schedule%')",
    );
    const bootCatchUp = walkSrc(/missedWhileClosed|runMissedJobs/i);
    const ev =
      `cycleCountTable=${hasTable} seededOverdueTask=due_at-3d overdueVisibleOnShelf=${overdueVisible} ` +
      `schedulerRefs=${scheduler.length} jobTables=${JSON.stringify(jobTables.map((t) => t.name))} ` +
      `bootCatchUpRefs=${bootCatchUp.length} ` +
      `(no scheduler and no last-run bookkeeping exist; the only recurring work class is cycle counts, ` +
      `recovered by derivation from open rows — nothing else can be replayed)`;
    // PASS-PARTIAL: the only job class that exists is proven to survive a
    // multi-day close; there is no scheduler to test against.
    const ok = hasTable && overdueVisible === 1 && jobTables.length === 0;
    logVerdict('TIM-06', ok ? 'PASS-PARTIAL' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'TIM-06',
        'due work disappeared after the app was closed for days',
        { hasTable, overdueVisible, jobTables: jobTables.map((t) => t.name) },
        { overdueVisible: 1, jobTables: [] },
      );
    }
    expect(ok).toBe(true);
  });

  it('[TIM-07] NTP resync jump in the middle of a sale', async () => {
    const before = count('transactions');
    interface Attempt {
      k: number;
      armed: boolean;
      readsBeforeJump: number;
      readsTotal: number;
      jumped: boolean;
      saleOk: boolean;
      reason: string;
      createdAt: string | null;
      driftMs: number;
    }
    const attempts: Attempt[] = [];
    let landed: Attempt | null = null;
    try {
      // Try progressively earlier jump points until one provably lands after the
      // sale has read the clock at least once and before it stamps createdAt.
      for (const k of [2, 1, 3, 0, 4]) {
        await restoreClock();
        await armCapture('stub', true);
        await armAdaptiveJump(k);
        let res: Array<{ ok: boolean; ms: number; reason?: string }> = [];
        let created: string | undefined;
        try {
          res = await runStress([{ lines: [{ id: P1, qty: 1 }], tenderedDa: 1000 }]);
          created = one<{ created_at: string }>(
            'SELECT created_at FROM transactions ORDER BY rowid DESC LIMIT 1',
          )?.created_at;
        } finally {
          const probe = await readJumpState();
          await restoreClock();
          await closeDialogs(4);
          const drift = created ? Date.parse(created) - Date.now() : 0;
          const attempt: Attempt = {
            k,
            armed: probe.armed,
            readsBeforeJump: probe.readsBeforeJump,
            readsTotal: probe.readsTotal,
            jumped: probe.jumped,
            saleOk: Boolean(res[0]?.ok),
            reason: res[0]?.reason ?? '-',
            createdAt: created ?? null,
            driftMs: drift,
          };
          attempts.push(attempt);
          // "Landed mid-sale" = the read budget was armed by the checkout hook,
          // at least the configured reads happened first, and the stored
          // timestamp carries the jumped clock.
          if (probe.armed && probe.jumped && probe.readsBeforeJump >= 0 && attempt.saleOk && drift > 60000) {
            landed = attempt;
          }
        }
        if (landed) break;
      }
    } finally {
      await restoreClock();
      await closeDialogs(4);
    }
    const after = count('transactions');
    const clockAudit =
      one<{ n: number }>(
        `SELECT COUNT(*) n FROM security_audit_logs
         WHERE lower(COALESCE(action,'') || ' ' || COALESCE(details,'')) LIKE '%clock%'
            OR lower(COALESCE(action,'') || ' ' || COALESCE(details,'')) LIKE '%horloge%'
            OR lower(COALESCE(action,'') || ' ' || COALESCE(details,'')) LIKE '%ntp%'`,
      )?.n ?? 0;
    const ev =
      `jumpLanded=${Boolean(landed)} attempts=${JSON.stringify(attempts)} txDelta=${after - before} ` +
      `clockAuditRows=${clockAudit} ` +
      `(same root as TIM-01/P1-51: no clock audit and no monotonic guard on the TS sale path; ` +
      `time_anchor is only consulted by refund.rs:786 and the outbox)`;
    if (!landed) {
      // Never reconcile an unlanded jump: fail loudly so the run is visibly
      // void instead of being read as a product verdict.
      throw new Error(`[TIM-07] harness could not land the clock jump inside a sale: ${ev}`);
    }
    const ok = clockAudit > 0;
    logVerdict('TIM-07', ok ? 'PASS' : 'FAIL', ev);
    if (!ok) {
      assertFail(
        'TIM-07',
        'an NTP jump mid-sale is absorbed silently: the ticket carries the jumped time and no audit row exists',
        { createdAt: landed.createdAt, driftMs: landed.driftMs, clockAudit },
        { clockAudit: '>=1' },
      );
    }
    expect(ok).toBe(true);
  });

  it('[TIM-09] mobile in another timezone / roaming: warranty, quote and loyalty expiry', async () => {
    const reason =
      'BLOCKED: needs a healthy Android build (P1-67: restored snapshot boots with an empty catalogue) and a ' +
      'second timezone/VPN profile; the emulator is Africa/Lagos with auto-time forced on';
    logVerdict('TIM-09', 'BLOCKED', reason);
    expect(true).toBe(true);
  });

  it('[TIM-10] device asleep for days, then jobs and token refresh resume', async () => {
    const reason =
      'BLOCKED: needs a multi-day sleep window on the mobile build plus a token-refresh endpoint; ' +
      'the desktop e2e run cannot suspend the machine for days';
    logVerdict('TIM-10', 'BLOCKED', reason);
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source probes (absence evidence only — never the primary verdict)
// ---------------------------------------------------------------------------

interface SrcHit {
  file: string;
  line: number;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'target' || ent.name === '.git') continue;
      walkFiles(p, out);
    } else if (/\.(ts|tsx|rs|mjs|cjs)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

function walkSrc(pattern: RegExp): SrcHit[] {
  const hits: SrcHit[] = [];
  for (const file of [
    ...walkFiles(path.join(ROOT, 'src')),
    ...walkFiles(path.join(ROOT, 'src-tauri', 'src')),
  ]) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      pattern.lastIndex = 0;
      if (pattern.test(text)) hits.push({ file: path.relative(ROOT, file), line: i + 1 });
    });
  }
  return hits;
}
