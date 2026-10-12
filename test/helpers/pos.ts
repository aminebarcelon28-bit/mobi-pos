import { browser, $, $$, expect } from '@wdio/globals';
import { APP_PIN } from './common';

export { APP_PIN };

/** data-testid locator (brief rule 9: testids only, never text/class). */
export const tid = (id: string) => `[data-testid="${id}"]`;

/** First DISPLAYED match (mobile/desktop twins share testids). */
export async function shown(id: string) {
  const els = await $$(tid(id));
  for (const el of els) {
    if (await el.isDisplayed().catch(() => false)) return el;
  }
  throw new Error(`no displayed element for [data-testid="${id}"]`);
}

/** Independent money oracle: integer minor DA (BigInt), from the rule. */
export type Minor = bigint;
export const DA = (n: number | bigint): Minor => BigInt(n) * 100n;

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
/** Parse any fr-DZ/DA display text to integer minor units. */
export function displayedToMinor(raw: string): Minor {
  let s = [...raw]
    .map((ch) => {
      const i = ARABIC_INDIC.indexOf(ch);
      return i >= 0 ? String(i) : ch;
    })
    .join('');
  s = s.replace(/٬/g, '').replace(/٫/g, '.');
  s = s.replace(/[^\d.,\-]/g, '');
  const m = /^(-?)([\d.,]*?)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Cannot parse money text: "${raw}"`);
  const [, sign, intPart, frac = ''] = m;
  const digits = intPart.replace(/[.,]/g, '') || '0';
  const v = BigInt(digits) * 100n + BigInt(frac.padEnd(2, '0'));
  return sign ? -v : v;
}

/** Invoke a Tauri command through the e2e overlay global (no extra deps). */
export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const r = await invokeRaw<T>(cmd, args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Non-throwing invoke: preserves the native error text (WDIO wraps
 * in-page throws into WebDriverError, destroying the CODE:detail shape
 * the kernel returns). */
export async function invokeRaw<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  await browser.waitUntil(
    async () => {
      try {
        return (await browser.execute(() => typeof (window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke === 'function'));
      } catch {
        return false;
      }
    },
    { timeout: 15000, interval: 200, timeoutMsg: '__TAURI__ global initialization timed out' },
  ).catch(() => {});
  return (await browser.execute(
    async (c: string, a: Record<string, unknown>) => {
      const w = window as unknown as {
        __TAURI__?: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      };
      if (!w.__TAURI__) return { ok: false as const, error: '__TAURI__ global missing' };
      try {
        const value = (await w.__TAURI__.core.invoke(c, a)) as T;
        return { ok: true as const, value };
      } catch (e: unknown) {
        const flat =
          typeof e === 'string'
            ? e
            : (e as { message?: unknown })?.message ??
              (() => {
                try {
                  return JSON.stringify(e);
                } catch {
                  return String(e);
                }
              })();
        return { ok: false as const, error: String(flat ?? e) };
      }
    },
    cmd,
    args,
  )) as { ok: true; value: T } | { ok: false; error: string };
}

export async function stubPrint(): Promise<void> {
  await browser.execute(() => {
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'));
      window.dispatchEvent(new Event('afterprint'));
    };
  }).catch(() => {});
}

export async function installErrorTrap(): Promise<void> {
  await browser.execute(() => {
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'));
      window.dispatchEvent(new Event('afterprint'));
    };
    const w = window as unknown as { __posErrors?: string[]; __posWrapped?: boolean };
    if (w.__posWrapped) {
      w.__posErrors = [];
      return;
    }
    w.__posErrors = [];
    w.__posWrapped = true;
    window.addEventListener('error', (e) => w.__posErrors?.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) =>
      w.__posErrors?.push(String((e as PromiseRejectionEvent).reason)),
    );
  });
}

export async function readErrors(): Promise<string[]> {
  return (await browser.execute(
    () => (window as unknown as { __posErrors?: string[] }).__posErrors ?? [],
  )) as string[];
}

/** Setup (fresh boot) or lock screen -> dashboard with PIN 202020. */
export async function unlockIfNeeded(pin = APP_PIN): Promise<void> {
  await stubPrint();
  const setupRoot = await $(tid('setup-pin-root'));
  const lockScreen = await $(tid('lock-screen'));
  const header = await $('header');
  await browser.waitUntil(
    async () =>
      (await setupRoot.isDisplayed().catch(() => false)) ||
      (await lockScreen.isDisplayed().catch(() => false)) ||
      (await header.isDisplayed().catch(() => false)),
    { timeout: 60000, timeoutMsg: 'no boot screen mounted' },
  );
  if (await setupRoot.isDisplayed().catch(() => false)) {
    await (await $(tid('setup-manager-name'))).setValue('E2E Gerant');
    await (await $(tid('setup-manager-new'))).setValue(pin);
    await (await $(tid('setup-manager-confirm'))).setValue(pin);
    await (await $(tid('setup-save'))).click();
    await browser.waitUntil(
      async () =>
        (await $(tid('lock-screen')).isDisplayed().catch(() => false)) ||
        (await $('header').isDisplayed().catch(() => false)),
      { timeout: 120000, timeoutMsg: 'setup did not yield lock/dashboard' },
    );
  }
  if (await lockScreen.isDisplayed().catch(() => false)) {
    const pad = await $(tid('login-pin-pad'));
    await pad.waitForDisplayed({ timeout: 15000 });
    await pad.click();
    await browser.keys(pin.split(''));
    const submit = await $(tid('login-submit'));
    if (await submit.isDisplayed().catch(() => false)) {
      await submit.click();
    }
    await header.waitForDisplayed({ timeout: 90000 });
  }
}

/** Select a customer by unique search (auto-selects first match + closes). */
export async function selectCustomer(query: string): Promise<void> {
  await (await $(tid('clients-button'))).click();
  await (await $(tid('customers-dialog'))).waitForDisplayed({ timeout: 15000 });
  const search = await $(tid('customer-search'));
  await search.setValue(query);
  await browser.keys(['Enter']);
  await browser.waitUntil(
    async () => !(await $(tid('customers-dialog')).isDisplayed().catch(() => false)),
    { timeout: 15000, timeoutMsg: `customer dialog did not select for "${query}"` },
  );
}

export interface DebtLedger {
  customerId: string;
  foundCustomer: boolean;
  entries: { amountDa: number; balanceAfterDa: number; receiptNumber: string }[];
}

export const debtOf = (customerId: string) =>
  invoke<DebtLedger>('e2e_get_customer_ledger', { customerId });

export interface DbState {
  dbPath: string;
  dbFilename: string;
  migratedVersion: number;
  integrityCheck: string;
  tables: { name: string; rows: number }[];
  settingsKeys: string[];
  settingsValues: { key: string; valueJson: string }[];
  recentSales: { id: string; receiptNumber: string; totalDa: number; status: string }[];
  shiftSummary: {
    openShiftId: string | null;
    openingFloatDa: number;
    cashSalesDa: number;
    cashRefundsDa: number;
  };
}

export const ledger = () => invoke<DbState>('e2e_get_db_state');

export interface SaleOut {
  found: boolean;
  id: string;
  receiptNumber: string;
  subtotalDa: number;
  discountTotalDa: number;
  totalDa: number;
  paymentMethod: string;
  cashTenderedDa: number;
  changeDueDa: number;
  status: string;
  lines: { productId: string; quantity: number; appliedPriceDa: number }[];
  tenders: { method: string; amountDa: number }[];
}

export const getSale = (id: string) => invoke<SaleOut>('e2e_get_sale', { id });

/** Stock oracle pair: cached display value + durable ledger sum.
 * Assert money on `ledger`; `cached` drift is UI-mirror staleness. */
export async function stockOf(id: string): Promise<{ cached: number; ledger: number | null }> {
  const s = await invoke<{ found: boolean; cachedStock: number; ledgerSum: number | null }>(
    'e2e_get_product_stock',
    { id },
  );
  return { cached: s.cachedStock, ledger: s.ledgerSum };
}

/** Open shift from the DEXIE mirror — the UI/processPayment lane reads
 * shift authority from Dexie (`getActiveShift`), not SQLite. The native
 * oracle (SQLite) only sees sessions the sync/close lanes wrote there. */
export interface DexieShift {
  id: string;
  status: string;
  openingFloat: number;
  cashierName: string;
}

export async function readOpenShiftDexie(): Promise<DexieShift | null> {
  return (await browser.execute(async () => {
    const idb = (window as unknown as { indexedDB?: unknown }).indexedDB as
      | {
          open(name: string): {
            onsuccess: (() => void) | null;
            onerror: (() => void) | null;
            result: {
              objectStoreNames: { contains(n: string): boolean };
              transaction(
                n: string,
                m: string,
              ): {
                objectStore(n: string): {
                  getAll(): {
                    onsuccess: (() => void) | null;
                    onerror: (() => void) | null;
                    result?: unknown;
                  };
                };
              };
            };
          };
        }
      | undefined;
    if (!idb) return null;
    return await new Promise<DexieShift | null>((resolve) => {
      try {
        const open = idb.open('MobiPosDB');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          try {
            const db = open.result;
            if (!db.objectStoreNames.contains('cashSessions')) {
              resolve(null);
              return;
            }
            const req = db
              .transaction('cashSessions', 'readonly')
              .objectStore('cashSessions')
              .getAll();
            req.onerror = () => resolve(null);
            req.onsuccess = () => {
              const rows = (req.result ?? []) as DexieShift[];
              resolve(rows.find((r) => r.status === 'OPEN') ?? null);
            };
          } catch {
            resolve(null);
          }
        };
      } catch {
        resolve(null);
      }
    });
  })) as DexieShift | null;
}

/** Any Dexie shift row by id (close verification reads the CLOSED row —
 * closeShift writes Dexie-only in the UI lane). */
export async function readDexieShift(
  id: string,
): Promise<(DexieShift & { status: string; closedAt?: string }) | null> {
  return (await browser.execute(async (sid: string) => {
    const idb = (window as unknown as { indexedDB?: unknown }).indexedDB as {
      open(n: string): {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        result: {
          transaction(
            n: string,
            m: string,
          ): {
            objectStore(n: string): {
              get(k: string): {
                onsuccess: (() => void) | null;
                onerror: (() => void) | null;
                result?: unknown;
              };
            };
          };
        };
      };
    };
    return await new Promise<unknown>((resolve) => {
      try {
        const open = idb.open('MobiPosDB');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          try {
            const req = open.result
              .transaction('cashSessions', 'readonly')
              .objectStore('cashSessions')
              .get(sid);
            req.onerror = () => resolve(null);
            req.onsuccess = () => resolve((req.result ?? null) as unknown);
          } catch {
            resolve(null);
          }
        };
      } catch {
        resolve(null);
      }
    });
  }, id)) as (DexieShift & { status: string; closedAt?: string }) | null;
}

export interface RefundInvoke {
  ok: boolean;
  code: string;
  receiptNumber?: string;
}

/** Direct kernel refund (online lane — same atomic commit as connected
 * production; offline containment is Rust-suite covered). Throws nothing;
 * returns the native code. cashMove.sessionId must be an OPEN SQLite row;
 * tenderedNet is the ORIGINAL ticket's net (cap basis), not the slice. */
export async function refundDirect(args: {
  deviceId: string;
  shiftId: string;
  sqlShiftId: string;
  ticketId: string;
  tag: string;
  receipt: string;
  totalNet: number;
  cashOut: number;
  tenderedNet?: number;
  lines: { productId: string; quantity: number; appliedPriceDa: number }[];
}): Promise<RefundInvoke> {
  const now = new Date().toISOString();
  const req = {
    ticketId: args.ticketId,
    refundId: args.tag,
    itemsHash: args.tag,
    receiptNumber: args.receipt,
    method: 'Espèces',
    online: true,
    localDeviceId: args.deviceId,
    activeShiftId: args.shiftId,
    supervisor: null,
    customerId: null,
    subtotal: args.totalNet,
    discountTotal: 0,
    totalNet: args.totalNet,
    costTotal: 0,
    pricingTier: 'Retail',
    paymentMethod: 'Espèces',
    cashTendered: args.totalNet,
    changeDue: 0,
    cashTenderedNet: args.tenderedNet ?? args.totalNet,
    createdAt: now,
    // Production-faithful payload shape (mirrors createOrderSlice's
    // refundTransaction): payload-first readers (close modal, cashTerms)
    // key on isRefund/paymentMethod/total/status — a bare
    // {refundMethod,cashDisbursed,total} string makes the stored row
    // invisible as a refund (observed: close understates refunds by exactly
    // the kernel-direct amount). The native columns are authoritative, but
    // every reader below them parses this JSON.
    refundPayload: JSON.stringify({
      id: args.tag,
      receiptNumber: args.receipt,
      status: 'COMPLETED',
      isRefund: true,
      refundMethod: 'Espèces',
      paymentMethod: 'Espèces',
      cashDisbursed: args.cashOut,
      total: args.totalNet,
      subtotal: args.totalNet,
      discountTotal: 0,
      createdAt: now,
    }),
    originalOutboxPayload: '{}',
    deviceId: args.deviceId,
    lines: args.lines.map((l, i) => ({
      id: `${args.tag}-L${i}`,
      productId: l.productId,
      quantity: l.quantity,
      appliedPrice: Math.round(l.appliedPriceDa),
      unitPriceCharged: Math.round(l.appliedPriceDa),
      unitCostAtSale: 0,
      discountAmount: 0,
      lineProfit: 0,
      imeiNumber: null,
      itemKey: `${args.tag}-L${i}`,
      itemPayload: '{}',
    })),
    deltas: args.lines.map((l, i) => ({
      id: `${args.tag}-D${i}`,
      key: `${args.tag}-D${i}`,
      productId: l.productId,
      delta: l.quantity,
    })),
    batches: args.lines.map((l) => ({
      batchId: null,
      productId: l.productId,
      quantity: l.quantity,
      unitCost: 0,
      fallbackBatchId: `E2E-FB-${args.tag}-${l.productId}`,
      fallbackKey: `e2e-fb-${args.tag}-${l.productId}`,
    })),
    imeis: [],
    debt: null,
    voucher: null,
    cashMove: {
      id: `${args.tag}-CM`,
      sessionId: args.sqlShiftId,
      amount: args.cashOut,
      reason: 'E2E test refund',
      cashierName: 'E2E',
    },
    audit: {
      action: 'E2E test refund',
      details: 'e2e',
      user: 'E2E',
      requiresPin: true,
    },
  };
  try {
    const r = await invokeRaw<{ receiptNumber?: string }>('refund_sale_atomic', {
      req,
    });
    if (!r.ok) return { ok: false, code: nativeCodeOf(r.error) };
    return { ok: true, code: 'OK', receiptNumber: r.value.receiptNumber };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, code: nativeCodeOf(msg) };
  }
}

/** First CODE:token segment of a native OperationFailed detail JSON. */
export function nativeCodeOf(raw: string): string {
  const m = /"detail"\s*:\s*"([^"]+)"/.exec(raw);
  if (m) return m[1].slice(0, 160);
  return raw.split('\n')[0].slice(0, 160);
}

/** Remove every cart line (for test teardown between scenarios).
 * Best-effort and defensive: first Escape dismisses any open modal, then
 * lines are removed one by one. Never throws — teardown must not mask the
 * test's own verdict. */
export async function clearCart(): Promise<void> {
  try {
    await browser.keys(['Escape']);
  } catch {
    // ignore
  }
  for (let i = 0; i < 50; i++) {
    try {
      const btns = await $$(tid('cart-line-remove'));
      if (btns.length === 0) break;
      await btns[0].click();
    } catch {
      break;
    }
  }
}

/** Smoke catalog: 8 integer-DA products (deterministic, non-serialized). */
export const SMOKE_PRICES = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];
export const SMOKE_SHIFT_OPENING = 100000;

export async function seedSmoke() {
  // NOTE: no open_shift seed — shift authority for the UI/processPayment
  // lane is the Dexie mirror, and a SQLite-only seeded shift is invisible
  // to it (proven: pill stayed closed, payments refused). Shifts open
  // through the real UI (openShiftUi) so both stores agree.
  await invoke('e2e_reset_db');
  const products = SMOKE_PRICES.map((priceDa, i) => ({
    id: `E2E-K${i + 1}`,
    title: `E2E Smoke ${i + 1}`,
    priceDa,
    stock: 100,
    barcode: `EK${i + 1}000`,
  }));
  const report = await invoke<{ products: number }>('e2e_seed_state', {
    payload: { products },
  });
  return report;
}

/** Open a shift through the real UI (both stores agree afterwards). */
export async function openShiftUi(openingDa: number): Promise<void> {
  await (await $(tid('shift-pill'))).click();
  await (await $(tid('shift-open-dialog'))).waitForDisplayed({ timeout: 15000 });
  await (await $(tid('shift-open-direct'))).click();
  const float = await $(tid('shift-open-float'));
  await float.waitForDisplayed({ timeout: 15000 });
  await float.setValue(String(openingDa));
  await browser.waitUntil(
    async () =>
      displayedToMinor(await (await $(tid('shift-open-total'))).getText()) ===
      BigInt(openingDa) * 100n,
    { timeout: 15000, timeoutMsg: 'shift float did not settle' },
  );
  await (await $(tid('shift-open-confirm'))).click();
  await browser.waitUntil(
    async () => !(await $(tid('shift-open-dialog')).isDisplayed().catch(() => false)),
    { timeout: 30000, timeoutMsg: 'shift dialog did not close' },
  );
}

/** Clear web mirrors (Dexie + storages). Does NOT refresh (caller reboots
 * when the boot-time reads must rerun). */
export async function wipeWebMirrors(): Promise<void> {
  await browser.execute(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
    try {
      sessionStorage.clear();
    } catch {
      // ignore
    }
  });
  await browser.execute(
    () =>
      new Promise<boolean>((resolve) => {
        try {
          const req = indexedDB.deleteDatabase('MobiPosDB');
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
          req.onblocked = () => resolve(false);
        } catch {
          resolve(false);
        }
      }),
  );
}

/** Clear web mirrors so the UI re-reads SQLite authority, then reboot state. */
export async function clearWebMirrors(): Promise<void> {
  await wipeWebMirrors();
  await browser.refresh();
}

/** Write an appSettings mirror row into Dexie (what setSetting does on
 * every production write). Needed after wipes for reads that are
 * Dexie-first (e.g. the lock-screen roster). */
export async function projectSettingToDexie(key: string, value: unknown): Promise<void> {
  const ok = await browser.execute((k, v) => {
    const w = window as unknown as {
      indexedDB: {
        open(n: string): {
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          result: {
            transaction(
              n: string,
              m: string,
            ): {
              objectStore(n: string): { put(v: unknown): void };
              oncomplete: (() => void) | null;
            };
          };
        };
      };
    };
    return new Promise<boolean>((resolve) => {
      try {
        const open = w.indexedDB.open('MobiPosDB');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          try {
            const tx = open.result.transaction('appSettings', 'readwrite');
            tx.objectStore('appSettings').put({ key: k, value: v });
            tx.oncomplete = () => resolve(true);
          } catch {
            resolve(false);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }, key, value as never);
  expect(ok).toBe(true);
}
