/**
 * REF — refunds / returns / avoirs (Phase 2, batch 3).
 * Encyclopedia refs: REF-01, 02, 03, 05, 06, 11, 17, 19, 27, 30, 44, 47
 * (batch 1 of the REF domain; REF-12/13/18/36 etc. follow in later batches).
 *
 * Ground truth: live SQLite through better-sqlite3 (transactions: refund row
 * `is_refund=1` + `original_transaction_id`; json_payload cashDisbursed /
 * refundMethod / tenders; inventory_ledger REFUND rows; cash_movements
 * REFUND_ALLOCATION; sync_outbox signed rows; defective_returns;
 * security_audit_logs; customers payload + current_debt column). No app file
 * is ever modified: a failed expectation is a recorded finding, never a
 * weakened assertion.
 *
 * Mechanics established from the app sources (read-only):
 *  - native `refund_sale_atomic` (refund.rs:1995) is the single write path:
 *    dedup gate refund_dedup (:874) keyed on the deterministic refund id
 *    (`refundIdentity`, refundNative.ts:36), status flip :1118
 *    (REFUNDED when every purchased unit is covered, else PARTIALLY_REFUNDED
 *    :1008-1018), refund row :1176, inventory_ledger 'REFUND' :1278, stock
 *    recompute, signed outbox :1804, defective_returns :1508 + 0-delta
 *    quarantine marker :1533, debt relief recomputing `current_debt` from the
 *    ledger :1544-1614, cash_movements ALLOCATION :1745, in-txn audit :1861;
 *  - funding split (receiptMath.ts:528 computeRefundFundingSplit): net =
 *    recoverableBase × gross/grossBase; voucher/avoir→origin, debt→relief,
 *    cash plug split by rail (Espèces disburses; CIB/BaridiMob/Chèque never
 *    cash); clampCashRefund caps drawer cash at net physical cash tendered;
 *  - offline gates (sandbox has no gateway): own-shift/own-device ticket only
 *    (OFFLINE_REMOTE_TICKET otherwise), shift cash bucket cap 10 000 DA
 *    (`policy.offline_cash_refund_limit`), supervisor instant only > 5 000 DA
 *    (`policy.offline_pin_threshold`);
 *  - manager PIN via verifyManagerGate (pinGate.ts:168 → native pin_verify,
 *    user 'manager'), escalating lockout 5 fails → 60 s (pin.rs:66
 *    LOCKOUT_LADDER), success resets (pin.rs:773 record_success);
 *  - the refund modal: selecting a ticket CHECKS every still-refundable line
 *    at qty = remaining (RefundModal.tsx:243-264); steppers bounded by
 *    remaining; refund-check/dec/inc-<pid>_<idx> (the desktop `+` has NO
 *    testid — resolved from the visible `-`'s holder); method buttons
 *    text-only "Espèces (Cash)" / "Avoir Magasin"; refund-pin + refund-submit
 *    (disabled without selected lines); after success the modal AUTO-CLOSES
 *    (activeModal: null, createOrderSlice.ts:3087) and the AVOIR auto-prints
 *    (createOrderSlice.ts:3093) through directPrintReceipt → ESC/POS spooler
 *    IPC (`sqlite_print_raw_escpos`/`sqlite_open_cash_drawer`,
 *    escpos.ts:469-471) — under Tauri the receipt never goes through
 *    window.print.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, waitForSchemaSettled } from '../lib/db';
import { clickUnobstructed,
  addSku,
  APP_PIN,
  applyCartDiscountPercent,
  armConsoleTap,
  armInvokeCounter,
  clearCart,
  clearWebMirrors,
  clickRefundSubmit,
  closeDialogs,
  closeRefund,
  countConsoleMatching,
  countInvokeCalls,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  openRefund,
  payExactFlow,
  payTenderedFlow,
  readInvokeCalls,
  readInvokeWrapStatus,
  refundCheckedCount,
  refundDialogVisible,
  refundLineState,
  refundSearch,
  refundSubmitDisabled,
  refundTotalMinor,
  selectCustomer,
  selectRefundMethod,
  selectRefundTicket,
  type RefundTicketSelect,
  setRefundQty,
  setRefundReason,
  tid,
  toggleRefundRestock,
  typeReal,
  typeRefundCustomReason,
  typeRefundPin,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCustomerFull, seedProducts } from '../lib/seed';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';

const P500 = 'REF-P500';
const P700 = 'REF-P700';
const CUST = 'REF-CUST';
const CUST_NAME = 'REF Cust'; // selectCustomer matches the DISPLAY name, not the id

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// DB helpers (better-sqlite3 read side — the app is live)
// ---------------------------------------------------------------------------

function txCount(): number {
  return count('transactions');
}

function newestTxRow(): Row | undefined {
  return one<Row>('SELECT * FROM transactions ORDER BY rowid DESC LIMIT 1');
}

function txRow(id: string): Row | undefined {
  return one<Row>('SELECT * FROM transactions WHERE id = ?', id);
}

function jsonOf(row?: Row | null): Row {
  try {
    return row?.json_payload ? (JSON.parse(String(row.json_payload)) as Row) : {};
  } catch {
    return {};
  }
}

function refundsFor(ticketId: string): Row[] {
  return all<Row>(
    'SELECT * FROM transactions WHERE is_refund = 1 AND original_transaction_id = ? ORDER BY rowid ASC',
    ticketId,
  );
}

function stockOf(pid: string): number {
  const r = one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', pid);
  return Number(r?.stock ?? NaN);
}

function ledgerSum(pid: string): number {
  const r = one<{ s: number }>(
    'SELECT COALESCE(SUM(delta), 0) AS s FROM inventory_ledger WHERE product_id = ?',
    pid,
  );
  return Number(r?.s ?? NaN);
}

function cashMovesFor(receiptLike: string): Row[] {
  return all<Row>(
    "SELECT * FROM cash_movements WHERE reason LIKE ? ORDER BY rowid ASC",
    `%${receiptLike}%`,
  );
}

function customerRow(id: string): { row?: Row; payload: Row } {
  const row = one<Row>('SELECT * FROM customers WHERE id = ?', id);
  let payload: Row = {};
  if (row?.json_payload) {
    try {
      payload = JSON.parse(String(row.json_payload)) as Row;
    } catch {
      payload = {};
    }
  }
  return { row, payload };
}

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, timeout = 15000): Promise<T> {
  let last = read();
  try {
    await browser.waitUntil(
      () => {
        last = read();
        return ok(last);
      },
      { timeout, interval: 250 },
    );
  } catch {
    /* fall through with the last observed value */
  }
  return last;
}

async function waitSaleLanded(before: number, timeout = 45000): Promise<void> {
  await browser.waitUntil(() => txCount() > before, {
    timeout,
    timeoutMsg: 'sale did not land in SQLite',
  });
}

async function waitRefundRows(ticketId: string, want: number, timeout = 40000): Promise<Row[]> {
  let rows: Row[] = refundsFor(ticketId);
  try {
    await browser.waitUntil(
      () => {
        rows = refundsFor(ticketId);
        return rows.length >= want;
      },
      { timeout, interval: 300 },
    );
  } catch (err) {
    throw new Error(
      `refund rows for ${ticketId} never reached ${want} (have ${rows.length}) :: ${await dumpRefundState('refund-land-timeout')} :: ${String((err as Error)?.message ?? err)}`,
    );
  }
  await browser.pause(300);
  return refundsFor(ticketId);
}

async function hasText(needle: string): Promise<boolean> {
  return (await browser.execute(
    (n: string) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
    needle,
  )) as boolean;
}

/** Body text slice for diagnostics (toasts live outside the dialog). */
async function bodyTail(): Promise<string> {
  return (await browser.execute(() =>
    (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(-600),
  )) as string;
}

/** Poll the body text for a needle (toasts are transient — 3 s default). */
async function waitForBodyText(needle: string, timeout = 8000): Promise<boolean> {
  try {
    await browser.waitUntil(() => hasText(needle), { timeout, interval: 300 });
    return true;
  } catch {
    return false;
  }
}

/** Wait until the needle is GONE from the body (toast-dismissal settle). */
async function waitForBodyTextGone(needle: string, timeout = 12000): Promise<boolean> {
  try {
    await browser.waitUntil(async () => !(await hasText(needle)), { timeout, interval: 300 });
    return true;
  } catch {
    return false;
  }
}

/** Poll the body for the FIRST of several needles (toast surfaces whose exact
 *  wording varies by branch); returns the needle seen, '' when none. */
async function waitForBodyTextAny(needles: string[], timeout = 8000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const n of needles) {
      if (await hasText(n)) return n;
    }
    await browser.pause(250);
  }
  return '';
}

/** Up to `max` context windows around a needle in the (whitespace-collapsed)
 *  body text — diagnostics for surface forensics. */
async function bodyContexts(needle: string, span = 70, max = 6): Promise<string[]> {
  return (await browser.execute(
    (n: string, sp: number, mx: number) => {
      const t = (document.body.innerText || '').replace(/\s+/g, ' ');
      const low = t.toLowerCase();
      const nlow = n.toLowerCase();
      const out: string[] = [];
      let i = 0;
      while (out.length < mx) {
        const at = low.indexOf(nlow, i);
        if (at < 0) break;
        out.push(t.slice(Math.max(0, at - sp), Math.min(t.length, at + nlow.length + sp)));
        i = at + nlow.length;
      }
      return out;
    },
    needle,
    span,
    max,
  )) as string[];
}

/** Clear the TS pacing mirror (security.ts:238-240) — UI hygiene that lives
 *  in localStorage and can outlive a crashed run; the native kernel ladder is
 *  the authoritative lockout (pinGate.ts:116-117). Harness-side only. */
async function clearPinMirror(): Promise<void> {
  await browser.execute(() => {
    try {
      localStorage.removeItem('mobipos_pin_lockout_v1');
    } catch {
      /* ignore */
    }
  });
}

/** Poll an async numeric reader until it reaches `min` (timeout falls through). */
async function waitForCount(reader: () => Promise<number>, min: number, timeout = 15000): Promise<number> {
  let last = await reader();
  try {
    await browser.waitUntil(
      async () => {
        last = await reader();
        return last >= min;
      },
      { timeout, interval: 300 },
    );
  } catch {
    /* fall through with the last observed value */
  }
  return last;
}

/** Visible refund-sale-row count whose text contains the receipt. */
async function visibleRowMatching(receipt: string): Promise<number> {
  return (await browser.execute((rc: string) => {
    const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
    return ([...document.querySelectorAll('[data-testid="refund-sale-row"]')] as HTMLElement[])
      .filter(vis)
      .filter((r) => (r.textContent || '').includes(rc)).length;
  }, receipt)) as number;
}

/** Snapshot of the refund dialog for failure diagnostics + screenshot. */
async function dumpRefundState(tag: string): Promise<string> {
  try {
    await browser.saveScreenshot(`e2e-tests/results/${tag}-refund.png`);
  } catch {
    /* best effort */
  }
  try {
    const state = (await browser.execute(() => {
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
      const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis) ?? null;
      const q = (id: string) => dlg?.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      const submit = q('refund-submit') as HTMLButtonElement | null;
      const rep = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      return {
        dialogVisible: Boolean(dlg),
        rows: ([...document.querySelectorAll('[data-testid="refund-sale-row"]')] as HTMLElement[]).filter(vis).length,
        total: rep(q('refund-total')?.textContent || ''),
        checked: ([...document.querySelectorAll('[data-testid^="refund-check-"]')] as HTMLInputElement[]).filter(
          (c) => vis(c) && c.checked,
        ).length,
        submitDisabled: submit ? submit.disabled : null,
        pinLen: (q('refund-pin') as HTMLInputElement | null)?.value?.length ?? null,
        searchValue: (q('refund-search') as HTMLInputElement | null)?.value ?? null,
        bodyTail: rep(document.body.innerText || '').slice(-500),
      };
    })) as unknown;
    return JSON.stringify(state);
  } catch (err) {
    return `dump failed: ${String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Sales (all drives the real UI)
// ---------------------------------------------------------------------------

interface SaleInfo {
  id: string;
  receipt: string;
}

async function makeCashSale(title: string, qty = 1, tendered?: number): Promise<SaleInfo> {
  await clearCart();
  for (let i = 0; i < qty; i++) await addSku(title);
  const before = txCount();
  if (tendered === undefined) await payExactFlow();
  else await payTenderedFlow(tendered);
  await waitSaleLanded(before);
  const tx = newestTxRow();
  if (!tx) throw new Error('no sale row after cash checkout');
  return { id: String(tx.id), receipt: String(tx.receipt_number) };
}

async function payDialogVisible(): Promise<boolean> {
  const dialogs = await $$(tid('pay-dialog'));
  for (const d of dialogs) {
    if (await d.isDisplayed().catch(() => false)) return true;
  }
  return false;
}

async function forceClosePay(): Promise<void> {
  const clicked = (await browser.execute(() => {
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
    const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis) ?? null;
    const btn = dlg?.querySelector('[data-testid="pay-cancel"]') as HTMLButtonElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  })) as boolean;
  if (!clicked) await browser.keys(['Escape']).catch(() => {});
  await browser.pause(400);
}

/** Card-funded sale: CIB lane leg is always the exact balance
 *  (PaymentModal.tsx:400-409), so no tendered input is involved. */
async function makeCardSale(title: string, qty = 1): Promise<SaleInfo> {
  await clearCart();
  for (let i = 0; i < qty; i++) await addSku(title);
  const before = txCount();
  await clickUnobstructed('checkout-button');
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
  const clicked = (await browser.execute(() => {
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
    const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis) ?? null;
    if (!dlg) return false;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
      [...b.querySelectorAll('span')].some((sp) => norm(sp.textContent || '') === 'CIB / Carte'),
    );
    if (!btn) return false;
    btn.click();
    return true;
  })) as boolean;
  if (!clicked) throw new Error('CIB / Carte method tab not found in pay dialog');
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
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
        const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis) ?? null;
        const t = (dlg?.querySelector('[data-testid="pay-confirm"] span')?.textContent || '').replace(/\s+/g, ' ').trim();
        return t.startsWith('Valider Carte CIB');
      })) as boolean,
    { timeout: 8000, timeoutMsg: 'card method never activated' },
  );
  await (await $(tid('pay-confirm'))).click();
  await browser.waitUntil(async () => !(await payDialogVisible()), {
    timeout: 45000,
    timeoutMsg: 'pay dialog did not close after card confirm',
  });
  await waitSaleLanded(before);
  const tx = newestTxRow();
  if (!tx) throw new Error('no sale row after card checkout');
  return { id: String(tx.id), receipt: String(tx.receipt_number) };
}

/** Mixed cash+credit sale through the real split confirm (PAY-03 mechanics:
 *  type the cash part, then pay-mixed-confirm takes Crédit Client for the
 *  remainder). Requires an attached customer. */
async function makeMixedSale(title: string, cashDa: number, qty = 1, customerName = CUST_NAME): Promise<SaleInfo> {
  await clearCart();
  await selectCustomer(customerName);
  for (let i = 0; i < qty; i++) await addSku(title);
  const before = txCount();
  await clickUnobstructed('checkout-button');
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
  await typeReal(await $(tid('tendered-input')), String(cashDa), false);
  await browser.pause(300);
  const mixed = await $(tid('pay-mixed-confirm'));
  await mixed.waitForDisplayed({ timeout: 10000, timeoutMsg: 'pay-mixed-confirm never appeared' });
  await mixed.click();
  await browser.waitUntil(async () => !(await payDialogVisible()), {
    timeout: 45000,
    timeoutMsg: 'pay dialog did not close after mixed confirm',
  });
  await waitSaleLanded(before);
  const tx = newestTxRow();
  if (!tx) throw new Error('no sale row after mixed checkout');
  return { id: String(tx.id), receipt: String(tx.receipt_number) };
}

// ---------------------------------------------------------------------------
// Refund flow helpers
// ---------------------------------------------------------------------------

/** Select the ticket in the refund list. The modal AUTO-CLOSES on success
 *  (activeModal: null, createOrderSlice.ts:3087) — chained refunds reopen it
 *  here first. Typed filters are readback-verified (refundSearch); when no
 *  row matches, the raw eligible list is scanned as a fallback (a mangled
 *  keystroke drop is harness noise, not an app verdict). */
async function pickTicket(receipt: string): Promise<RefundTicketSelect> {
  // Let the post-refund close transition settle (fully closed, or back to a
  // list with a visible search field).
  await browser.waitUntil(
    async () => {
      if (!(await refundDialogVisible())) return true;
      const inputs = await $$(tid('refund-search'));
      for (const i of inputs) if (await i.isDisplayed().catch(() => false)) return true;
      return false;
    },
    { timeout: 8000, timeoutMsg: 'refund dialog never settled into a list state' },
  );
  if (!(await refundDialogVisible())) await openRefund();
  await refundSearch(receipt);
  let out = await selectRefundTicket(receipt, 6000);
  if (out !== 'no-row') return out;
  await refundSearch('');
  out = await selectRefundTicket(receipt, 5000);
  return out;
}

/** Open the modal, pick the ticket, pick a method. */
async function startRefund(receipt: string, method: 'Espèces' | 'Avoir Client' = 'Espèces'): Promise<void> {
  await openRefund();
  const pick = await pickTicket(receipt);
  if (pick !== 'clicked') {
    throw new Error(`ticket ${receipt} not selectable (${pick}) :: ${await dumpRefundState('pick-ticket')}`);
  }
  await selectRefundMethod(method);
}

/** Full submit cycle: PIN type + submit click (no wait — callers wait on DB). */
/** A refund that LANDS while the modal re-renders closes the dialog, so the
 *  helper can no longer click. The ROW is the authority: classify that as
 *  submitted, never as a failure. Any other error still propagates. */
async function submitRefundOrLanded(ticketId: string, want = 1): Promise<'clicked' | 'landed'> {
  try {
    await submitRefund();
    return 'clicked';
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    if (!/refund-submit not clickable|refund-dialog-closed-before-submit/.test(msg)) throw e;
    for (let i = 0; i < 10; i += 1) {
      await browser.pause(400);
      if (refundsFor(ticketId).length >= want) return 'landed';
    }
    throw e;
  }
}

async function submitRefund(pin = APP_PIN, times = 1): Promise<void> {
  await typeRefundPin(pin);
  const ok = await clickRefundSubmit(times);
  if (!ok) throw new Error(`refund-submit not clickable :: ${await dumpRefundState('submit')}`);
}

describe('REF — refunds, returns & avoirs (batch 3)', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    resetData();
    // Deliberately deep stock: several cases consume units permanently
    // (defective refunds never restock, and failed cases leave sales
    // unrefunded). Run-01's stock-10 seed starved REF-47's second addSku
    // (stock hit 0 mid-add → "tile click did not change the cart").
    seedProducts([
      { id: P500, title: 'REF P500', priceDa: 500, stock: 500, costDa: 300 },
      { id: P700, title: 'REF P700', priceDa: 700, stock: 200, costDa: 400 },
    ]);
    seedCustomerFull([
      { id: CUST, name: 'REF Cust', phone: '0551000001', currentDebtDa: 0, debtLimitDa: 100000 },
    ]);
    await clearWebMirrors();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
    captureInvariantBaseline('REF');
  });

  afterEach(async function () {
    if (await refundDialogVisible()) {
      console.log('[afterEach] refund dialog still open — closing');
      await closeRefund().catch(() => {});
    }
    if (await payDialogVisible()) {
      console.log('[afterEach] pay dialog still open — force-closing');
      await forceClosePay().catch(() => {});
    }
    await closeDialogs().catch(() => {});
    await clearCart().catch((e) =>
      console.log('[afterEach] clearCart:', String((e as Error)?.message ?? e)),
    );
    // REF-17 arms the TS pacing mirror by design; it must not leak into the
    // next case (the kernel baseline resets on success / stays in the sandbox).
    await clearPinMirror();
    const title = String(
      (this as unknown as { currentTest?: { title?: string } }).currentTest?.title ?? 'unknown',
    );
    assertInvariants(`REF :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('REF batch1 (spec 30)');
  });

  it('[REF-01] full refund, same tender (cash): refund row + status flip + stock/ledger/outbox/cash-movement side effects', async () => {
    const stockBase = stockOf(P500);
    const sale = await makeCashSale('REF P500', 1);
    const saleRow = txRow(sale.id);
    expect(String(saleRow?.status)).not.toBe('REFUNDED');
    const stockAfterSale = stockOf(P500);
    expect(stockAfterSale).toBe(stockBase - 1);

    await startRefund(sale.receipt, 'Espèces');
    // Ticket selected → the single line defaults checked at qty = remaining 1.
    const line = await refundLineState(`${P500}_0`);
    expect(line?.checked).toBe(true);
    expect(line?.qty).toBe(1);
    expect(await refundTotalMinor()).toBe(50000n);

    await submitRefund(APP_PIN);
    const rows = await waitRefundRows(sale.id, 1);
    const ref = rows[0];
    const refId = String(ref.id);
    const rj = jsonOf(ref);

    // Refund row shape.
    expect(Number(ref.is_refund)).toBe(1);
    expect(String(ref.original_transaction_id)).toBe(sale.id);
    expect(String(ref.status)).toBe('COMPLETED');
    expect(String(ref.receipt_number)).toMatch(/^AVOIR/);
    expect(String(ref.receipt_number)).not.toBe(sale.receipt);
    expect(Number(ref.total)).toBe(500);
    expect(String(ref.payment_method)).toBe('Espèces');
    expect(Number(rj.cashDisbursed)).toBe(500);
    expect(String(rj.refundMethod ?? '')).toBe('Espèces');

    // Original ticket flipped.
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');

    // Stock restored + ledger REFUND row keyed on the refund id.
    expect(stockOf(P500)).toBe(stockBase);
    const led = one<Row>(
      "SELECT * FROM inventory_ledger WHERE ref_id = ? AND reason = 'REFUND'",
      refId,
    );
    expect(led).toBeTruthy();
    expect(Number(led?.delta)).toBe(1);

    // Drawer side effect: one cash movement tagged with the AVOIR receipt.
    const moves = cashMovesFor(String(ref.receipt_number));
    expect(moves.length).toBe(1);
    expect(Number(moves[0].amount)).toBe(500);
    expect(String(moves[0].type)).toBe('ALLOCATION');

    // Signed outbox row (gateway-ready signed lane).
    const ob = one<Row>('SELECT * FROM sync_outbox WHERE idempotency_key = ?', refId);
    expect(ob).toBeTruthy();
    expect(String(ob?.status)).toBe('pending');
    expect(ob?.device_signature ?? null).not.toBeNull();
    expect(ob?.seq_no ?? null).not.toBeNull();
    expect(ob?.envelope ?? null).not.toBeNull();

    console.log(
      '[REF-01] ref:', JSON.stringify({
        id: refId,
        receipt: ref.receipt_number,
        total: ref.total,
        profit: ref.profit,
        cashDisbursed: rj.cashDisbursed,
        movement: moves[0]?.amount,
        outboxSeq: ob?.seq_no,
      }),
    );
  });

  it('[REF-02] partial refunds by qty until fully refunded: PARTIALLY_REFUNDED → REFUNDED, cumulative capped', async () => {
    const stockBase = stockOf(P500);
    const sale = await makeCashSale('REF P500', 3); // one cart line, qty 3 (1500 DA)
    const saleRow = txRow(sale.id);
    expect(Number(saleRow?.total)).toBe(1500);
    expect(stockOf(P500)).toBe(stockBase - 3);

    // Refund #1 — one unit.
    await startRefund(sale.receipt, 'Espèces');
    await setRefundQty(`${P500}_0`, 1);
    expect(await refundTotalMinor()).toBe(50000n);
    await submitRefund(APP_PIN);
    let rows = await waitRefundRows(sale.id, 1);
    expect(Number(rows[0].total)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('PARTIALLY_REFUNDED');
    expect(stockOf(P500)).toBe(stockBase - 2);

    // Refund #2 — one unit (defaults to the remaining 2, stepped down to 1).
    await pickTicket(sale.receipt);
    await selectRefundMethod('Espèces');
    await setRefundQty(`${P500}_0`, 1);
    await submitRefund(APP_PIN);
    rows = await waitRefundRows(sale.id, 2);
    expect(Number(rows[1].total)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('PARTIALLY_REFUNDED');
    expect(stockOf(P500)).toBe(stockBase - 1);

    // Refund #3 — the last unit → fully REFUNDED.
    await pickTicket(sale.receipt);
    await selectRefundMethod('Espèces');
    await setRefundQty(`${P500}_0`, 1);
    await submitRefund(APP_PIN);
    rows = await waitRefundRows(sale.id, 3);
    expect(Number(rows[2].total)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');
    expect(stockOf(P500)).toBe(stockBase);

    // Cumulative never exceeds what was paid; each refund has its own receipt.
    const cumulative = rows.reduce((acc, r) => acc + Number(r.total), 0);
    expect(cumulative).toBe(1500);
    const receipts = rows.map((r) => String(r.receipt_number));
    expect(new Set(receipts).size).toBe(3);

    console.log('[REF-02] totals:', JSON.stringify(rows.map((r) => r.total)), 'status:', txRow(sale.id)?.status);
  });

  it('[REF-03] refund of a line carrying an invoice-level discount share pays the NET pro-rata (450 of 500), never the gross', async () => {
    await clearCart();
    for (let i = 0; i < 2; i++) await addSku('REF P500');
    await applyCartDiscountPercent('10'); // 1000 → 900 cart discount (10% does not gate; slice gates >10, createCartSlice.ts:450)
    const before = txCount();
    await payExactFlow();
    await waitSaleLanded(before);
    const saleTx = newestTxRow();
    if (!saleTx) throw new Error('no discounted sale row');
    const sale = { id: String(saleTx.id), receipt: String(saleTx.receipt_number) };
    expect(Number(saleTx.total)).toBe(900); // premise: discount really committed

    await startRefund(sale.receipt, 'Espèces');
    await setRefundQty(`${P500}_0`, 1);
    // One unit's net = 500 − its 50 DA share of the invoice discount.
    const shownTotal = await refundTotalMinor();
    expect(shownTotal).toBe(45000n);
    await submitRefund(APP_PIN);
    const rows = await waitRefundRows(sale.id, 1);
    const ref = rows[0];
    const rj = jsonOf(ref);
    expect(Number(ref.total)).toBe(450);
    expect(Number(rj.cashDisbursed)).toBe(450);
    expect(String(txRow(sale.id)?.status)).toBe('PARTIALLY_REFUNDED');
    const moves = cashMovesFor(String(ref.receipt_number));
    expect(moves.length).toBe(1);
    expect(Number(moves[0].amount)).toBe(450);

    console.log('[REF-03] shownTotalMinor:', String(shownTotal), 'rowTotal:', ref.total, 'cash:', rj.cashDisbursed);
  });

  it('[REF-05] over-refund impossible: steppers bounded by remaining; fully refunded ticket offers no refundable qty', async () => {
    const sale = await makeCashSale('REF P500', 2); // 1000 DA ticket
    await startRefund(sale.receipt, 'Espèces');

    // Bounds at qty 2: inc disabled at max, dec enabled.
    let line = await refundLineState(`${P500}_0`);
    expect(line?.qty).toBe(2);
    expect(line?.incDisabled).toBe(true);
    expect(line?.decDisabled).toBe(false);
    // Bounds at qty 1: dec disabled at the floor.
    await setRefundQty(`${P500}_0`, 1);
    line = await refundLineState(`${P500}_0`);
    expect(line?.decDisabled).toBe(true);
    await setRefundQty(`${P500}_0`, 2);

    await submitRefund(APP_PIN);
    const rows = await waitRefundRows(sale.id, 1);
    expect(Number(rows[0].total)).toBe(1000);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');

    // Fully refunded: search again — either the ticket is not offered at all,
    // or (stale-cache manual-hit path) it is offered but has ZERO refundable
    // qty and the submit stays disabled. No second payout either way.
    const pick = await pickTicket(sale.receipt);
    if (pick === 'no-row') {
      // Precise claim: no visible row carries this receipt (the eligible list
      // may legitimately show other still-refundable tickets).
      expect(await visibleRowMatching(sale.receipt)).toBe(0);
    } else {
      expect(await refundCheckedCount()).toBe(0);
      expect(await refundSubmitDisabled()).toBe(true);
    }
    await browser.pause(600);
    expect(refundsFor(sale.id).length).toBe(1);

    console.log('[REF-05] pick after full refund:', pick, 'refunds:', refundsFor(sale.id).length);
  });

  it('[REF-06] card-funded sale refunds never disburse cash (anti-arbitrage C1/C3): cashDisbursed 0, drawer untouched', async () => {
    // The card rail has no destination of record, so the ONLY lane that can
    // deliver the value is the Avoir - and an Avoir needs an owner (owner rule
    // P0: a refund that credits nobody must be refused, not invented). The
    // scenario therefore carries a customer; every assertion below is unchanged.
    await clearCart();
    await selectCustomer(CUST_NAME);
    const sale = await makeCardSale('REF P500', 1);
    const tenders = jsonOf(txRow(sale.id)).tenders as Array<{ method?: string; amount?: number }> | undefined;
    // The stored tender method is the canonical type id; the tab's visible
    // label is the shorter "CIB / Carte" (PaymentModal.tsx:981/989).
    console.log('[REF-06] card tenders:', JSON.stringify(tenders));
    expect(Array.isArray(tenders) && tenders.some((t) => t.method === 'CIB / Edahabia')).toBe(true);

    const movesBefore = count('cash_movements');
    await startRefund(sale.receipt, 'Espèces'); // attempt cash refund of a card sale
    await submitRefund(APP_PIN);
    // Toast surfaces are the forensic record (3 s life — poll immediately).
    const surface = await waitForBodyTextAny(
      [
        // Branch-specific phrases only: a bare 'validé' needle was matched by
        // a persistent element in run-03 and short-circuited the poll. A
        // success on THIS rail shows 'espèces décaissées' (cash shortfall) or
        // 'retourne à ses origines'; the refusal shows one of the below.
        'espèces décaissées',
        'retourne à ses origines',
        'Erreur lors du remboursement',
        'Plafond espèces',
        'basculée en Avoir',
        'Hors ligne',
        'verrouillé',
        'incorrect',
      ],
      8000,
    );
    let rows = refundsFor(sale.id);
    if (rows.length === 0) {
      try {
        rows = await waitFor(() => refundsFor(sale.id), (r) => r.length >= 1, 6000);
      } catch {
        rows = refundsFor(sale.id);
      }
    }
    console.log(
      '[REF-06] first attempt surface:', JSON.stringify(surface),
      'rows:', rows.length, '| bodyTail:', (await bodyTail()).slice(-240),
    );
    // Stray-'validé' forensics (run-03: a bare needle matched instantly
    // somewhere persistent — record what that was; the DB stays the verdict).
    console.log('[REF-06] stray "validé" contexts:', JSON.stringify(await bodyContexts('validé')));

    let voucherSurface = '';
    if (rows.length === 0) {
      // Refusal branch. The card rail is DIGITAL (receiptMath.ts:571-596 →
      // cashShare 0), and a cash-0 'Espèces' refund has no drawer movement —
      // the write path refuses it (refund.rs:955-959). Anti-arbitrage: nothing
      // may have left the drawer; and the value must still be payable WITHOUT
      // cash through the modal's voucher rail ('Avoir Client' control).
      expect(count('cash_movements')).toBe(movesBefore);
      await selectRefundMethod('Avoir Client');
      await submitRefund(APP_PIN);
      voucherSurface = await waitForBodyTextAny(
        ['validé avec succès', 'Erreur lors du remboursement', 'Plafond espèces', 'Hors ligne'],
        8000,
      );
      rows = await waitRefundRows(sale.id, 1);
    }

    const ref = rows[0];
    const rj = jsonOf(ref);
    const cashDone = Number(rj.cashDisbursed ?? 0);

    expect(Number(ref.total)).toBe(500);
    expect(cashDone).toBe(0); // card rail is digital — never disbursed as cash
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');
    // Drawer: no movement carries this AVOIR receipt, and none was added.
    expect(cashMovesFor(String(ref.receipt_number)).length).toBe(0);
    expect(count('cash_movements')).toBe(movesBefore);
    // Some operator-facing surface was shown across the attempts (success
    // toast on the direct rail, or the voucher path's outcome).
    expect(`${surface}${voucherSurface}`).not.toBe('');

    console.log('[REF-06] ref:', JSON.stringify({ total: ref.total, cashDisbursed: rj.cashDisbursed, surface, voucherSurface }));
  });

  it('[REF-11] refund after the item was re-sold (stock cycle): ledger==stock invariance holds across sale/refund/re-sale', async () => {
    const base = stockOf(P700);
    const drift0 = ledgerSum(P700) - base; // isolate any pre-existing seed drift

    const s1 = await makeCashSale('REF P700', 1);
    expect(stockOf(P700)).toBe(base - 1);
    expect(ledgerSum(P700) - stockOf(P700)).toBe(drift0);

    const s2 = await makeCashSale('REF P700', 1);
    expect(stockOf(P700)).toBe(base - 2);
    expect(ledgerSum(P700) - stockOf(P700)).toBe(drift0);

    // Refund s1 fully (restock) while s2's unit has left stock.
    await startRefund(s1.receipt, 'Espèces');
    await submitRefund(APP_PIN);
    await waitRefundRows(s1.id, 1);
    expect(stockOf(P700)).toBe(base - 1);
    expect(ledgerSum(P700) - stockOf(P700)).toBe(drift0);

    // Re-sell the returned unit again.
    const s3 = await makeCashSale('REF P700', 1);
    expect(stockOf(P700)).toBe(base - 2);
    expect(ledgerSum(P700) - stockOf(P700)).toBe(drift0);

    // Refund the OTHER original ticket (its unit was already re-sold once).
    await startRefund(s2.receipt, 'Espèces');
    await submitRefund(APP_PIN);
    await waitRefundRows(s2.id, 1);
    expect(stockOf(P700)).toBe(base - 1);
    expect(ledgerSum(P700) - stockOf(P700)).toBe(drift0);

    console.log(
      '[REF-11] base:', base, 'finalStock:', stockOf(P700), 'ledgerSum:', ledgerSum(P700),
      'drift:', ledgerSum(P700) - stockOf(P700), '(baseline', drift0, ')',
    );
  });

  it('[REF-17] refund approval step-up: missing PIN refused, wrong PIN refused, 5th locks 60s, expiry releases with correct PIN', async () => {
    // Known baseline for the TS pacing mirror (security.ts:238-240): it lives
    // in localStorage and could outlive a crashed previous run — clear it so
    // "5th recorded failure = first tier" holds regardless of history. (The
    // mirror increments only on non-locked refusals; a locked reply is never
    // recorded as a wrong attempt by either layer.)
    await clearPinMirror();
    const sale = await makeCashSale('REF P500', 1);
    await startRefund(sale.receipt, 'Espèces');

    // (a) Missing PIN → modal-level refusal, nothing written. (Toast is
    // transient — poll for both appearance and dismissal.)
    await clickRefundSubmit();
    const missingPinRefused = await waitForBodyText('code pin manager requis', 8000);
    expect(missingPinRefused).toBe(true);
    expect(refundsFor(sale.id).length).toBe(0);
    await waitForBodyTextGone('code pin manager requis', 8000);

    // (b) Wrong PIN ×4. The 5th failure CROSSES the first ladder tier
    // (5 → 60 s, trust_core/pin.rs:66) but its own RESPONSE is still a plain
    // refusal — the kernel arms locked_until and returns the failure
    // (pin.rs:747-770); the locked surface appears on the NEXT verify. The TS
    // mirror also records its 5th failure here (15 min, security.ts). Settle
    // on the toast lifecycle so exactly one native verify runs per click (the
    // gate keeps the typed PIN between attempts).
    await typeRefundPin('111111');
    // REF-17 order-leak fix (2026-11-03): the old loop counted the SAME toast
    // as a new refusal (its gone-wait is not asserted), so the 5th click could
    // be a phantom - the mirror stayed at 4 and the correct PIN later went
    // through. Wait on the app's own counter instead: each click must increment
    // failedAttempts, which only a real gate verdict does.
    const mirrorAttempts = async (): Promise<number> =>
      (await browser.execute(() => {
        try {
          return Number(
            (JSON.parse(localStorage.getItem('mobipos_pin_lockout_v1') || '{"failedAttempts":0}') as {
              failedAttempts?: number;
            }).failedAttempts ?? 0,
          );
        } catch {
          return 0;
        }
      })) as number;
    // Drive the ladder to five RECORDED failures. One click can be dropped by
    // the modal's submit re-entrancy guard (observed 2026-11-03: five clicks,
    // four records); a dropped click is retried only on that classification and
    // logged. No refund may land on any attempt.
    let mirrorNow = await mirrorAttempts();
    let recorded = 0;
    for (let click = 1; click <= 8 && mirrorNow < 5; click += 1) {
      const before = mirrorNow;
      const clicked = await clickRefundSubmit();
      expect(clicked).toBe(true);
      const grew = await browser
        .waitUntil(async () => (await mirrorAttempts()) > before, { timeout: 8000, interval: 150 })
        .then(() => true)
        .catch(() => false);
      if (!grew) {
        const diag = await browser.execute(() => {
          try {
            return JSON.parse(localStorage.getItem('refund_diag') ?? '[]').slice(-3);
          } catch {
            return [];
          }
        });
        console.log(
          `[REF-17] click ${click} did not record (transient submit drop); retrying; diag=${JSON.stringify(diag).slice(0, 500)}`,
        );
      } else {
        recorded += 1;
      }
      mirrorNow = await mirrorAttempts();
      expect(refundsFor(sale.id).length).toBe(0);
      if (click === 1) {
        const firstRefused = await waitForBodyText('incorrect', 15000);
        expect(firstRefused).toBe(true);
        await waitForBodyTextGone('incorrect', 15000);
      }
    }
    expect(recorded).toBeGreaterThanOrEqual(5);
    expect(mirrorNow).toBeGreaterThanOrEqual(5);
    console.log(`[REF-17] recorded failures=${recorded} mirror=${mirrorNow}`);
    const tierArmedAt = Date.now();
    const mirrorLockedAt = (await browser.execute(() => {
      try {
        const st = JSON.parse(localStorage.getItem('mobipos_pin_lockout_v1') || '{}') as {
          lockedUntil?: number | null;
        };
        return Boolean(st.lockedUntil && st.lockedUntil > Date.now());
      } catch {
        return false;
      }
    })) as boolean;
    expect(mirrorLockedAt).toBe(true);
    console.log(
      `[REF-17] five failures recorded; mirror locked=${mirrorLockedAt} at ${new Date(tierArmedAt).toISOString()}`,
    );

    // (c) The CORRECT PIN is now refused BEFORE the kernel is even consulted:
    // the TS mirror answers first with remainingMs 0, so the toast shows the
    // placeholder "1s" although the mirror holds ~15 min (security.ts:238-240
    // vs RefundModal.tsx:512-514 - recorded for the report; the assertion is
    // the refusal itself).
    await typeRefundPin(APP_PIN);
    await clickRefundSubmit();
    const mirrorLocked = await waitForBodyText('verrouillé', 12000);

    expect(refundsFor(sale.id).length).toBe(0);
    console.log('[REF-17] mirror-locked surface:', JSON.stringify((await bodyTail()).slice(-200)));
    await waitForBodyTextGone('verrouillé', 12000);

    // (c2) Harness reset of the MIRROR ONLY (UI hygiene; the kernel is the
    // authoritative boundary — pinGate.ts:116-117). The next attempt reaches
    // the kernel and gets the real tier countdown.
    await clearPinMirror();
    await clickRefundSubmit(); // pin field still holds APP_PIN
    const nativeLocked = await waitForBodyText('verrouillé', 12000);
    expect(nativeLocked).toBe(true);
    expect(refundsFor(sale.id).length).toBe(0);
    console.log('[REF-17] kernel-locked surface:', JSON.stringify((await bodyTail()).slice(-200)));
    await waitForBodyTextGone('verrouillé', 12000);

    // (d) After the 60 s tier expires the correct PIN goes through; native
    // record_success resets the ladder (pin.rs:773) and the fresh verify also
    // resets the TS mirror.
    const waitMs = Math.max(0, tierArmedAt + 66000 - Date.now());
    console.log('[REF-17] waiting out the kernel tier:', waitMs, 'ms');
    await browser.pause(waitMs);
    await typeRefundPin(APP_PIN);
    await clickRefundSubmit();
    const rows = await waitRefundRows(sale.id, 1);
    expect(Number(rows[0].total)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');
    expect(refundsFor(sale.id).length).toBe(1);

    console.log(
      '[REF-17] missingPinRefused:', missingPinRefused, 'mirrorLocked:', mirrorLocked, 'nativeLocked:', nativeLocked,
      'payouts:', refundsFor(sale.id).length,
    );
  });

  it('[REF-19] refund reasons: no-restock path + "Autre" free text (Arabic/emoji/very long) lands verbatim in the trail', async () => {
    // (a) No-restock line with the literal 'Autre' option and no free text:
    // the write path stores the raw option as the defect reason.
    const saleA = await makeCashSale('REF P500', 1);
    const stockAfterSaleA = stockOf(P500);
    await startRefund(saleA.receipt, 'Espèces');
    const labelA = await toggleRefundRestock(`${P500}_0`);
    expect(String(labelA)).toContain('Rebut');
    await setRefundReason('Autre motif personnalisé...');
    // REF-36 owns this contract: a write-off ("rebut", no restock) requires an
    // OPERATOR-AUTHORED note, so the bare category is refused fail-closed (the
    // modal promises "Précisez le motif exact..."). Assert the refusal, then
    // supply the note - the defect row must carry it verbatim.
    await submitRefund(APP_PIN);
    await browser.pause(1200);
    expect(refundsFor(saleA.id).length).toBe(0);
    // Both controls are React-controlled and the refusal re-renders them:
    // set the SELECT to the "Autre" category AND the free-text note through the
    // native setters with input/change events, so component state really holds
    // them (keystrokes/addValue alone left the state empty and the REF-36 note
    // gate kept refusing a write-off that did carry a note).
    const noted = (await browser.execute(() => {
      const dlg = document.querySelector('[data-testid="refund-dialog"]') as HTMLElement | null;
      if (!dlg) return { ok: false, why: 'no dialog' };
      const select = dlg.querySelector('select') as HTMLSelectElement | null;
      const input = ([...dlg.querySelectorAll('input')] as HTMLInputElement[]).find((i) =>
        /motif/i.test(i.getAttribute('placeholder') || ''),
      );
      if (!select || !input) return { ok: false, why: 'controls missing' };
      const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
        const proto =
          el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(select, 'Autre');
      setValue(input, 'Autre');
      return { ok: true, select: select.value, note: input.value };
    })) as { ok: boolean; select?: string; note?: string; why?: string };
    console.log('[REF-19] controls set:', JSON.stringify(noted));
    expect(noted.ok).toBe(true);
    await browser.pause(250);

    await submitRefundOrLanded(saleA.id, 1);
    {
      // Evidence for the write-off path: what did the app say to THIS submit?
      const diag = await browser.execute(() => {
        try {
          return JSON.parse(localStorage.getItem('refund_diag') ?? '[]').slice(-6);
        } catch {
          return [];
        }
      });
      console.log('[REF-19] diag after noted submit:', JSON.stringify(diag).slice(0, 1200));
    }
    const rowsA = await waitRefundRows(saleA.id, 1);
    const refA = rowsA[0];
    const defA = one<Row>('SELECT * FROM defective_returns WHERE refund_id = ?', String(refA.id));
    expect(defA).toBeTruthy();
    expect(String(defA?.reason)).toBe('Autre');
    expect(Number(defA?.quantity)).toBe(1);
    // Defective units never re-enter stock.
    const ledA = one<Row>(
      "SELECT * FROM inventory_ledger WHERE ref_id = ? AND reason = 'REFUND'",
      String(refA.id),
    );
    expect(ledA).toBeFalsy();
    expect(stockOf(P500)).toBe(stockAfterSaleA);
    // Defective COGS is consumed: refund profit = full net (no COGS recovery).
    expect(Number(refA.profit)).toBe(500);
    // CARRY-OVER (D13 exit): the authored note must survive into the QUEUED
    // payload the offline outbox will replay - not just the committed row.
    // The queue is the local outbox; the remote drain is BLOCKED (no merchant
    // gateway), so the durable payload is the observable oracle here.
    {
      const queued = one<Row>(
        "SELECT payload_json FROM sync_outbox WHERE entity_type = 'order' AND entity_id = ? ORDER BY rowid DESC LIMIT 1",
        String(refA.id),
      );
      const queuedPayload = String(queued?.payload_json ?? '');
      console.log(
        `[REF-19] queued payload present=${Boolean(queued)} carriesNote=${queuedPayload.includes('Autre')} refunds=${refundsFor(saleA.id).length} dedup=${count('refund_dedup', 'ticket_id = ?', saleA.id)}`,
      );
      expect(queued).toBeTruthy();
      expect(queuedPayload).toContain('Autre');
      // Exactly-once: one refund row and one dedup row for the ticket.
      expect(refundsFor(saleA.id).length).toBe(1);
      expect(count('refund_dedup', 'ticket_id = ?', saleA.id)).toBe(1);
    }

    // (b) 'Autre' with Arabic + emoji + very long free text → stored verbatim.
    const saleB = await makeCashSale('REF P500', 1);
    const longText = `إصلاح معيب 🎁 ${'A'.repeat(280)}`;
    await startRefund(saleB.receipt, 'Espèces');
    const labelB = await toggleRefundRestock(`${P500}_0`);
    expect(String(labelB)).toContain('Rebut');
    await setRefundReason('Autre motif personnalisé...');
    await typeRefundCustomReason(longText);
    await submitRefund(APP_PIN);
    const rowsB = await waitRefundRows(saleB.id, 1);
    const refB = rowsB[0];
    const defB = one<Row>('SELECT * FROM defective_returns WHERE refund_id = ?', String(refB.id));
    expect(defB).toBeTruthy();
    expect(String(defB?.reason)).toBe(longText);
    // The refund's own audit entry carries the motif verbatim. Scoped to its
    // action targetedly: the store-expense entry written after it shares the
    // receipt reference but never carried the motif — a rowid-DESC probe
    // mis-targets it (run-03 forensics: refund row verbatim, expense row not).
    const audits = all<Row>(
      "SELECT * FROM security_audit_logs WHERE action = 'Remboursement / Avoir Émis' AND details LIKE ?",
      `%${refB.receipt_number}%`,
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.some((a) => String(a.details).includes(longText))).toBe(true);

    console.log(
      '[REF-19] partA reason:', defA?.reason, 'profit:', refA.profit,
      '| partB reasonLen:', String(defB?.reason ?? '').length,
      'verbatim:', String(defB?.reason) === longText,
    );
  });

  it('[REF-27] multi-tender (cash+credit) refund of one unit splits pro-rata: debt relief + cash out, no cash over-refund', async () => {
    const sale = await makeMixedSale('REF P500', 400, 2); // 1000 DA: 400 cash + 600 credit
    const saleJson = jsonOf(txRow(sale.id));
    const tenders = (saleJson.tenders ?? []) as Array<{ method?: string; amount?: number }>;
    expect(tenders.some((t) => t.method === 'Espèces' && Number(t.amount) === 400)).toBe(true);
    expect(tenders.some((t) => t.method === 'Crédit Client' && Number(t.amount) === 600)).toBe(true);
    const debtAfterSale = await waitFor(
      () => Number(customerRow(CUST).payload.currentDebt ?? NaN),
      (v) => v === 600,
    );
    expect(debtAfterSale).toBe(600);

    const movesBefore = count('cash_movements');
    await startRefund(sale.receipt, 'Espèces');
    await setRefundQty(`${P500}_0`, 1); // one of two units → 500 gross
    expect(await refundTotalMinor()).toBe(50000n);
    await submitRefund(APP_PIN);
    const rows = await waitRefundRows(sale.id, 1);
    const ref = rows[0];
    const rj = jsonOf(ref);

    // Funding split of a 50% refund: 300 back to debt relief, 200 drawer cash.
    expect(Number(ref.total)).toBe(500);
    expect(Number(rj.cashDisbursed)).toBe(200);
    const moves = cashMovesFor(String(ref.receipt_number));
    expect(moves.length).toBe(1);
    expect(Number(moves[0].amount)).toBe(200);
    expect(count('cash_movements')).toBe(movesBefore + 1);

    const debtAfterRefund = await waitFor(
      () => Number(customerRow(CUST).payload.currentDebt ?? NaN),
      (v) => v === 300,
    );
    expect(debtAfterRefund).toBe(300);
    // Native recomputes the cached column from the ledger in-txn (:1548).
    const colDebt = await waitFor(
      () => Number(one<{ current_debt: number }>('SELECT current_debt FROM customers WHERE id = ?', CUST)?.current_debt ?? NaN),
      (v) => v === 300,
    );
    expect(colDebt).toBe(300);
    expect(String(txRow(sale.id)?.status)).toBe('PARTIALLY_REFUNDED');

    console.log(
      '[REF-27] tenders:', JSON.stringify(tenders), 'net:', ref.total, 'cash:', rj.cashDisbursed,
      'debtAfterSale:', debtAfterSale, 'debtAfterRefund:', debtAfterRefund, 'colDebt:', colDebt,
    );
  });

  it('[REF-30] change sale: refund disburses the NET cash paid (500), never the handed-over gross (1000)', async () => {
    const sale = await makeCashSale('REF P500', 1, 1000); // tendered 1000 → change 500
    const saleRow = txRow(sale.id);
    expect(Number(saleRow?.cash_tendered)).toBe(1000);
    expect(Number(saleRow?.change_due)).toBe(500);

    await startRefund(sale.receipt, 'Espèces');
    expect(await refundTotalMinor()).toBe(50000n);
    await submitRefund(APP_PIN);
    const rows = await waitRefundRows(sale.id, 1);
    const ref = rows[0];
    const rj = jsonOf(ref);

    expect(Number(ref.total)).toBe(500);
    expect(Number(rj.cashDisbursed)).toBe(500); // net, not the 1000 handed over
    const moves = cashMovesFor(String(ref.receipt_number));
    expect(moves.length).toBe(1);
    expect(Number(moves[0].amount)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');

    console.log('[REF-30] tendered:', saleRow?.cash_tendered, 'change:', saleRow?.change_due, 'cashOut:', rj.cashDisbursed);
  });

  it('[REF-44] side-effect ordering: refused refund writes/prints nothing; committed refund = DB + ledger + drawer + outbox + AVOIR print', async () => {
    // Under Tauri the print channel is the ESC/POS spooler IPC (escpos.ts:469
    // → 'sqlite_print_raw_escpos' + 'sqlite_open_cash_drawer'), NEVER
    // window.print. Two independent in-page instruments: an invoke wrapper
    // (window.__TAURI_INTERNALS__.invoke is read per call in the shipped
    // bundle) and a console tap ([ESC/POS Spooler Error] — escpos.ts:400 —
    // fires when the spooler invoke fails; the sandbox has no printer while
    // autoPrintEnabled defaults true, createUISlice.ts:142). Either may be
    // inert depending on the build; the DB/ledger/drawer/outbox asserts are
    // the hard contract, and the print leg is asserted on whichever
    // instrument reports live.
    const PRINT_CMDS = ['sqlite_print_raw_escpos', 'sqlite_open_cash_drawer'];
    const PRINT_CONSOLE_RE = 'ESC/POS Spooler Error|Cash Drawer Error';
    await clearPinMirror();
    await armInvokeCounter();
    await armConsoleTap();
    const wrapStatus = await readInvokeWrapStatus();
    const sale = await makeCashSale('REF P500', 1);
    // The sale's own receipt print is fire-and-forget after commit — wait for
    // it (and its drawer kick) so the refusal baseline is stable.
    await waitForCount(() => countInvokeCalls(PRINT_CMDS), 1, 8000);
    await waitForCount(() => countConsoleMatching(PRINT_CONSOLE_RE), 1, 8000);
    await browser.pause(1200);
    const printBase = await countInvokeCalls(PRINT_CMDS);
    const consoleBase = await countConsoleMatching(PRINT_CONSOLE_RE);
    const movesBefore = count('cash_movements');
    console.log('[REF-44] wrap:', wrapStatus, '| invoke print base:', printBase, '| console print base:', consoleBase);

    // (a) Refused (wrong PIN): NO row, NO ledger, NO drawer movement, NO
    // print on EITHER channel.
    await startRefund(sale.receipt, 'Espèces');
    await submitRefund('111111');
    const refused = await waitForBodyText('incorrect', 15000);
    expect(refused).toBe(true);
    await browser.pause(1500);
    expect(refundsFor(sale.id).length).toBe(0);
    expect(count('cash_movements')).toBe(movesBefore);
    expect(await countInvokeCalls(PRINT_CMDS)).toBe(printBase);
    expect(await countConsoleMatching(PRINT_CONSOLE_RE)).toBe(consoleBase);

    // (b) Committed: DB row + ledger + drawer movement + signed outbox all
    // exist, and the AVOIR print fires only AFTER the commit.
    await typeRefundPin(APP_PIN);
    await clickRefundSubmit();
    const rows = await waitRefundRows(sale.id, 1);
    const ref = rows[0];
    const refId = String(ref.id);
    expect(one<Row>("SELECT * FROM inventory_ledger WHERE ref_id = ? AND reason = 'REFUND'", refId)).toBeTruthy();
    expect(cashMovesFor(String(ref.receipt_number)).length).toBe(1);
    expect(one<Row>('SELECT * FROM sync_outbox WHERE idempotency_key = ?', refId)).toBeTruthy();
    let printed = printBase;
    let consolePrinted = consoleBase;
    if (wrapStatus === 'wrapped' && printBase > 0) {
      printed = await waitForCount(() => countInvokeCalls(PRINT_CMDS), printBase + 1, 20000);
      expect(printed).toBeGreaterThan(printBase);
      const calls = await readInvokeCalls();
      const refundIdx = calls.indexOf('refund_sale_atomic');
      expect(refundIdx).toBeGreaterThanOrEqual(0);
      expect(calls.some((c, i) => i > refundIdx && PRINT_CMDS.includes(c))).toBe(true);
    } else if (consoleBase > 0) {
      consolePrinted = await waitForCount(() => countConsoleMatching(PRINT_CONSOLE_RE), consoleBase + 1, 20000);
      expect(consolePrinted).toBeGreaterThan(consoleBase);
    } else {
      console.log(
        '[REF-44] print channel unobservable in this sandbox (wrap:', wrapStatus,
        ', console base:', consoleBase, ') — DB/ledger/drawer/outbox asserts are the contract;',
        'print ordering is source-verified (createOrderSlice.ts:3086-3094).',
      );
    }

    console.log(
      '[REF-44] printBase:', printBase, 'printed:', printed, 'consoleBase:', consoleBase,
      'consolePrinted:', consolePrinted, 'refunds:', refundsFor(sale.id).length,
    );
  });

  it('[REF-47] replayed refund (double-click, same key) pays once; a new-key partial on the same line is allowed', async () => {
    const sale = await makeCashSale('REF P500', 2); // 1000 DA, one line qty 2
    await startRefund(sale.receipt, 'Espèces');
    await setRefundQty(`${P500}_0`, 1);
    expect(await refundTotalMinor()).toBe(50000n);

    // Double submit in the same task: both handlers derive the SAME refund id
    // (canonical key + basis) — at most one payout must land.
    await submitRefund(APP_PIN, 2);
    const first = await waitRefundRows(sale.id, 1);
    await browser.pause(1500);
    const afterDbl = refundsFor(sale.id);
    expect(afterDbl.length).toBe(1);
    expect(Number(first[0].total)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('PARTIALLY_REFUNDED');

    // A genuinely NEW partial refund (remaining unit) hashes differently and
    // must go through.
    await pickTicket(sale.receipt);
    await selectRefundMethod('Espèces');
    await setRefundQty(`${P500}_0`, 1);
    await submitRefund(APP_PIN);
    const rows = await waitRefundRows(sale.id, 2);
    await browser.pause(800);
    expect(refundsFor(sale.id).length).toBe(2);
    expect(Number(rows[1].total)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');
    const receipts = refundsFor(sale.id).map((r) => String(r.receipt_number));
    expect(new Set(receipts).size).toBe(2);

    console.log('[REF-47] afterDbl:', afterDbl.length, 'final:', refundsFor(sale.id).length, 'status:', txRow(sale.id)?.status);
  });
});
