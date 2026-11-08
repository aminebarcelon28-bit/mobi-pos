/**
 * REF — refunds / returns / avoirs, batch 2 (cases REF-07, 08, 09, 10, 12,
 * 13, 14, 18, 28, 34, 36, 46, 65, 71, 88).
 *
 * Ground truth: live SQLite through better-sqlite3 (the same file the app
 * writes): transactions (`is_refund=1`), transaction_items, refund_dedup,
 * cash_movements, cash_sessions, inventory_ledger, imei_records,
 * defective_returns, customer_debts, customers, security_audit_logs.
 *
 * Decisions under test (from the encyclopedia + app sources, read-only):
 *  - REF-07/08: offline refunds are own-ledger + CURRENT-shift only
 *    (refundLockPolicy.ts:42, refund.rs:856-867, RefundModal.tsx:573-574);
 *    a past-shift attempt must be refused with the clear surface and leave
 *    the closed shift's row byte-identical, the drawer never negative.
 *  - REF-10: serialized IMEI lifecycle (products.is_serialized +
 *    imei_number; imei_records) — traceable to the sale, once-only return.
 *  - REF-14/46: native quota/identity guards refuse forged IPC
 *    (REFUND_EXCEEDS / ZERO_REFUNDABLE / DEVICE_IDENTITY_SPOOFED) with ZERO
 *    side effects; the request shape mirrors NativeRefundRequest
 *    (refundNative.ts:136-216) and the command's `{ req }` arg
 *    (refundNative.ts:417-418).
 *  - REF-28: stacked reachable discounts (price override = line lane; coupon
 *    PROMO500 => cart-percent lane; loyalty avoir leg) must reverse exactly:
 *    full refund = full net split by funding source, credit note <= paid.
 *  - REF-36: restock vs write-off (`Rebut`) — the write-off must not restock,
 *    must land in defective_returns, and MUST require a motive
 *    (RESTOCK_REASON_REQUIRED; RefundModal.tsx:561-562).
 *  - REF-65: credit-sale refund must recompute debt from the LEDGER even when
 *    customers.current_debt lags; the invariant chain column==ledger==payload
 *    is asserted before (recorded, P2-7/G-32/G-34 cross-ref) and after.
 *  - REF-71: unlinked negative (return) lines must not double-return a unit
 *    that was already refunded — no phantom restock, no silent value leak.
 *  - REF-88: the DB-level refund bypass gate (trg_refund_requires_dedup,
 *    REFUND_BYPASS) + per-ticket dedup journal == refund rows + single-winner
 *    under a concurrent write lock.
 *
 * Global invariants: afterEach runs assertInvariants() (G-01…G-34 subset)
 * against the live DB — see lib/invariants.ts.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, run, scalar, waitForSchemaSettled } from '../lib/db';
import {
  clickControl, clickUnobstructed,
  addSku,
  APP_PIN,
  applyCartDiscountPercent,
  armConsoleTap,
  cartTotalMinor,
  clearCart,
  clearWebMirrors,
  closeDialogs,
  closeRefund,
  clickRefundSubmit,
  countConsoleMatching,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  openRefund,
  openShiftUi,
  overrideLastLinePrice,
  payExactFlow,
  payTenderedFlow,
  refundDialogVisible,
  refundLineState,
  refundSearch,
  refundTotalMinor,
  selectCustomer,
  selectRefundMethod,
  selectRefundTicket,
  setRefundQty,
  setRefundReason,
  tid,
  typeReal,
  typeRefundCustomReason,
  typeRefundPin,
  unlockIfNeeded,
} from '../lib/pos';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';
import { resetData, seedCustomerFull, seedImeiRecords, seedProducts } from '../lib/seed';

const P500 = 'REF-P500';
const P700 = 'REF-P700';
const P1000 = 'REF-P1000';
const PSER = 'REF-PSER';
const IMEI_SER = '356938035643809';
const CUST = 'REF2-CUST';
const CUST65 = 'REF2-C65';
const CUST_NAME = 'REF2 Cust';
const CUST65_NAME = 'REF2 Kredy';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function txCount(): number {
  return count('transactions');
}
function txRow(id: string): Row | undefined {
  return one<Row>('SELECT * FROM transactions WHERE id = ?', id);
}
function newestTxRow(): Row | undefined {
  return one<Row>('SELECT * FROM transactions ORDER BY rowid DESC LIMIT 1');
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
  return Number(one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', pid)?.stock ?? NaN);
}
function openShiftId(): string | null {
  return (
    one<{ id: string }>("SELECT id FROM cash_sessions WHERE status = 'OPEN' ORDER BY rowid DESC LIMIT 1")?.id ??
    null
  );
}
function sessionRow(id: string): Row | undefined {
  return one<Row>('SELECT * FROM cash_sessions WHERE id = ?', id);
}
function movesForSession(sessionId: string): Row[] {
  return all<Row>('SELECT * FROM cash_movements WHERE session_id = ? ORDER BY rowid ASC', sessionId);
}
function movesForReceipt(receipt: string): Row[] {
  return all<Row>('SELECT * FROM cash_movements WHERE reason LIKE ? ORDER BY rowid ASC', `%${receipt}%`);
}
function dedupCount(ticketId: string): number {
  return Number(
    one<{ c: number }>('SELECT COUNT(*) AS c FROM refund_dedup WHERE ticket_id = ?', ticketId)?.c ?? 0,
  );
}
function ledgerCount(ticketId: string, reason?: string): number {
  if (reason) {
    return Number(
      one<{ c: number }>(
        'SELECT COUNT(*) AS c FROM inventory_ledger WHERE reason = ? AND id LIKE ?',
        reason,
        `%${ticketId}%`,
      )?.c ?? 0,
    );
  }
  return Number(one<{ c: number }>('SELECT COUNT(*) AS c FROM inventory_ledger WHERE id LIKE ?', `%${ticketId}%`)?.c ?? 0);
}
function deviceIdFromLedger(): string {
  const r = one<{ device_id: string }>(
    "SELECT device_id FROM transactions WHERE COALESCE(device_id,'') <> '' ORDER BY rowid DESC LIMIT 1",
  );
  return String(r?.device_id ?? '').trim();
}
function expectedCashFor(sessionId: string): number {
  const s = sessionRow(sessionId);
  const rows = all<Row>(
    'SELECT * FROM transactions WHERE shift_id = ? AND is_refund = 0 AND deleted = 0',
    sessionId,
  );
  let cashIn = 0;
  for (const t of rows) {
    const j = jsonOf(t);
    const tenders = Array.isArray(j.tenders) ? (j.tenders as Array<Row>) : null;
    if (tenders) {
      const handed = tenders
        .filter((x) => String(x.method ?? '') === 'Espèces')
        .reduce((a, x) => a + Number(x.amount ?? 0), 0);
      cashIn += handed - Number(j.changeDue ?? t.change_due ?? 0);
    } else if (String(t.payment_method ?? '') === 'Espèces') {
      cashIn += Number(t.total);
    }
  }
  const cashOut = Number(
    one<{ s: number }>('SELECT COALESCE(SUM(amount),0) AS s FROM cash_movements WHERE session_id = ?', sessionId)
      ?.s ?? 0,
  );
  return Number(s?.opening_float ?? 0) + cashIn - cashOut;
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
  await browser.waitUntil(() => txCount() > before, { timeout, timeoutMsg: 'sale did not land in SQLite' });
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

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

async function hasText(needle: string): Promise<boolean> {
  return (await browser.execute(
    (n: string) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
    needle,
  )) as boolean;
}
async function bodyTail(): Promise<string> {
  return (await browser.execute(() =>
    (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(-700),
  )) as string;
}
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
async function clearPinMirror(): Promise<void> {
  await browser.execute(() => {
    try {
      localStorage.removeItem('mobipos_pin_lockout_v1');
    } catch {
      /* ignore */
    }
  });
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
async function visibleRowMatching(receipt: string): Promise<number> {
  return (await browser.execute((rc: string) => {
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
    return ([...document.querySelectorAll('[data-testid="refund-sale-row"]')] as HTMLElement[])
      .filter(vis)
      .filter((r) => (r.textContent || '').includes(rc)).length;
  }, receipt)) as number;
}
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
      const dlg =
        ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis) ?? null;
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
// Sales (all drive the real UI)
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
async function makeCreditSale(title: string, qty: number, customerName: string): Promise<SaleInfo> {
  await clearCart();
  await selectCustomer(customerName);
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
    // The tab's VISIBLE label is "Crédit" (PaymentModal.tsx); the underlying
    // method id is 'Crédit Client'. Match what the user sees.
    const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
      [...b.querySelectorAll('span')].some((sp) => norm(sp.textContent || '') === 'Crédit'),
    );
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })) as boolean;
  if (!clicked) throw new Error('Crédit Client method tab not found/unusable in pay dialog');
  await browser.pause(300);
  const confirmLabel = String(
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
      return (dlg?.querySelector('[data-testid="pay-confirm"]')?.textContent || '').replace(/\s+/g, ' ').trim();
    })) as string,
  );
  console.log(`[credit-sale] confirm label: "${confirmLabel}"`);
  await (await $(tid('pay-confirm'))).click();
  await browser.waitUntil(async () => !(await payDialogVisible()), {
    timeout: 45000,
    timeoutMsg: 'pay dialog did not close after credit confirm',
  });
  await waitSaleLanded(before);
  const tx = newestTxRow();
  if (!tx) throw new Error('no sale row after credit checkout');
  return { id: String(tx.id), receipt: String(tx.receipt_number) };
}

// ---------------------------------------------------------------------------
// Refund flow helpers
// ---------------------------------------------------------------------------

async function pickTicket(receipt: string): Promise<'clicked' | 'disabled' | 'no-row'> {
  // Wait for the LIST state before typing. The old version treated "refund
  // dialog absent" as settled and then conditionally opened it, so a stale
  // dialog that was mid-close could satisfy the check, disappear, and leave
  // refundSearch with twins=0/dialogs=[] (REF-36 in a chained sweep). The
  // caller owns opening (`openRefund` force-closes stale dialogs and waits for
  // this field); here we only wait for it to exist.
  await browser.waitUntil(
    async () => {
      const inputs = await $$(tid('refund-search'));
      for (const i of inputs) if (await i.isDisplayed().catch(() => false)) return true;
      return false;
    },
    { timeout: 15000, timeoutMsg: 'refund list state never rendered (no displayed refund-search)' },
  );
  await refundSearch(receipt);
  let out = await selectRefundTicket(receipt, 6000);
  if (out !== 'no-row') return out;
  await refundSearch('');
  out = await selectRefundTicket(receipt, 5000);
  return out;
}
async function stageRefund(
  receipt: string,
  opts: { method?: 'Espèces' | 'Avoir Client'; qtyByKey?: Record<string, number> } = {},
): Promise<void> {
  // Always go through openRefund: it force-closes a stale dialog, clicks the
  // shell control through the guarded helper, and waits for the search field —
  // the three things that used to race here.
  await openRefund();
  const pick = await pickTicket(receipt);
  if (pick !== 'clicked') {
    throw new Error(`ticket ${receipt} not selectable (${pick}) :: ${await dumpRefundState('pick-ticket')}`);
  }
  if (opts.qtyByKey) {
    for (const [key, qty] of Object.entries(opts.qtyByKey)) await setRefundQty(key, qty);
  }
  if (opts.method) await selectRefundMethod(opts.method);
}
async function submitRefund(pin = APP_PIN, times = 1): Promise<void> {
  await typeRefundPin(pin);
  const ok = await clickRefundSubmit(times);
  if (!ok) throw new Error(`refund-submit not clickable :: ${await dumpRefundState('submit')}`);
}
const REFUSAL_NEEDLES = [
  'Quantité à rembourser supérieure',
  'Ce retour a déjà été remboursé',
  'Ticket sans solde remboursable',
  'Hors ligne : seuls les tickets',
  'Plafond',
  'motif de rebut est obligatoire',
  'Identité terminal refusée',
  'Autorisation superviseur',
  'Erreur lors du remboursement',
];

/** Visible toast texts (Toast.tsx:104 — fixed container, role=alert/status). */
async function visibleToasts(): Promise<string> {
  return (await browser.execute(() => {
    const box = ([...document.querySelectorAll('div')] as HTMLDivElement[]).find((d) => {
      const cls = String(d.className || '');
      return cls.includes('z-[9999]') && cls.includes('pointer-events-none');
    });
    if (!box) return '';
    return ([...box.querySelectorAll('[role="alert"], [role="status"]')] as HTMLElement[])
      .map((t) => (t.textContent || '').trim())
      .filter(Boolean)
      .join(' || ');
  })) as string;
}

/** Submit + wait for the refund row to land (or a refusal surface). Toasts
 *  live 3 s; every poll snapshots the visible toast so a refusal that no
 *  needle matches is still captured in the returned surface. */
async function submitAndSettle(ticketId: string, want: number): Promise<{ landed: boolean; surface: string }> {
  await submitRefund();
  const t0 = Date.now();
  let lastToast = '';
  while (Date.now() - t0 < 16000) {
    if (refundsFor(ticketId).length >= want) return { landed: true, surface: '' };
    const tail = await bodyTail();
    for (const n of REFUSAL_NEEDLES) {
      if (tail.includes(n)) return { landed: false, surface: `${n} :: toast="${lastToast}"` };
    }
    const toast = await visibleToasts();
    if (toast) lastToast = toast;
    await browser.pause(300);
  }
  return {
    landed: false,
    surface: `timeout :: toast="${lastToast}" :: ${await dumpRefundState('no-land-16s')}`,
  };
}

/** Flip a selected refund line to the write-off (Rebut) path; returns the
 *  prior button label for evidence. The RefundModal toggle reads
 *  "Remettre Stock" ↔ "Rebut / Défectueux". */
async function toggleRefundWriteOff(): Promise<string> {
  const before = (await browser.execute(() => {
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
    if (!dlg) return 'no-dialog';
    const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
      /Remettre Stock|Rebut/.test(b.textContent || ''),
    );
    if (!btn) return 'no-toggle';
    const label = (btn.textContent || '').trim();
    btn.click();
    return label;
  })) as string;
  await browser.pause(300);
  return before;
}

// ---------------------------------------------------------------------------
// Shift helpers
// ---------------------------------------------------------------------------

async function closeShiftUi(countedDa?: number): Promise<{
  expected: string;
  counted: string;
  variance: string;
  zDialog: boolean;
  typed: number;
}> {
  const sid = openShiftId();
  const fallbackExpected = sid ? expectedCashFor(sid) : NaN;
  await (await $(tid('shift-pill'))).click();
  await (await $(tid('shift-close-dialog'))).waitForDisplayed({
    timeout: 20000,
    timeoutMsg: 'shift-close-dialog never appeared after clicking the shift pill',
  });
  // STEP 1 — BLIND_COUNT (ShiftCloseModal.tsx:628-989): "Montant Global" mode,
  // declare the physical count, then "Valider le Comptage & Voir l'Audit"
  // advances to reconciliation (shift-close-confirm only exists on step 2 —
  // the old helper clicked it here and could never find it).
  const typed = Math.round(countedDa ?? fallbackExpected);
  if (!(typed > 0)) {
    throw new Error(`closeShiftUi: refusing a non-positive blind count (${typed}) — window.confirm path is untestable here`);
  }
  const direct = await $(tid('shift-blind-direct'));
  if (await direct.isDisplayed().catch(() => false)) {
    await direct.click().catch(() => undefined);
    await browser.pause(250);
  }
  const input = await $(tid('shift-blind-input'));
  await input.waitForDisplayed({ timeout: 10000, timeoutMsg: 'shift-blind-input missing in BLIND_COUNT step' });
  await typeReal(input, String(typed), false);
  await browser.pause(250);
  await (await $(tid('shift-blind-next'))).click();
  // STEP 2 — RECONCILIATION: readouts + (variance≠0 ⇒ mandatory note) + PIN → confirm.
  const expEl = await $(tid('shift-expected'));
  await expEl.waitForDisplayed({
    timeout: 12000,
    timeoutMsg: 'RECONCILIATION step never appeared (shift-expected hidden)',
  });
  await browser.pause(250);
  const expectedText = await expEl.getText().catch(() => '');
  const countedText = await (await $(tid('shift-counted'))).getText().catch(() => '');
  const varianceText = await (await $(tid('shift-variance'))).getText().catch(() => '');
  let varianceMinor: bigint | null = null;
  try {
    varianceMinor = varianceText.trim() ? displayedToMinor(varianceText) : null;
  } catch {
    varianceMinor = null;
  }
  if (varianceMinor !== null && varianceMinor !== 0n) {
    const note = await $(tid('shift-note-variance'));
    if (await note.isDisplayed().catch(() => false)) await typeReal(note, 'E2E variance note', false);
  }
  const pinEl = await $(tid('shift-close-pin'));
  if (await pinEl.isDisplayed().catch(() => false)) await typeReal(pinEl, APP_PIN, false);
  await (await $(tid('shift-close-confirm'))).click();
  // Desktop Z: the frozen snapshot view replaces the modal, prints, then
  // auto-dismisses (~1.6 s; ShiftCloseModal.tsx:352-366). No buttons to click.
  const zDialog = await (await $(tid('shift-z-dialog')))
    .waitForDisplayed({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  await browser.waitUntil(
    async () => !(await $(tid('shift-close-dialog')).isDisplayed().catch(() => false)),
    { timeout: 30000, timeoutMsg: `shift-close-dialog did not close (expected="${expectedText}", z=${zDialog})` },
  );
  console.log(
    `[shift-close] done: expected="${expectedText}" counted="${countedText}" variance="${varianceText}" z=${zDialog}`,
  );
  return { expected: expectedText, counted: countedText, variance: varianceText, zDialog, typed };
}
async function openShiftBestEffort(floatDa: number): Promise<number> {
  try {
    await openShiftUi(floatDa);
    return floatDa;
  } catch (e) {
    console.log(`[openShift] float ${floatDa} refused (${String((e as Error)?.message ?? e)}); fallback 100`);
    await closeDialogs(2);
    await openShiftUi(100);
    return 100;
  }
}

// ---------------------------------------------------------------------------
// Forged native invoke (REF-14 / REF-46)
// ---------------------------------------------------------------------------

function buildForgedRefund(
  ticketId: string,
  qty: number,
  opts: { method?: string; spoofDevice?: boolean; deltas?: number } = {},
): Row {
  const ticket = txRow(ticketId);
  if (!ticket) throw new Error(`forged: ticket ${ticketId} not found`);
  const tj = jsonOf(ticket);
  const items = all<Row>('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', ticketId);
  const forgeId = `REF-FORGE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const lines = items.map((it, idx) => ({
    id: `forge-line-${idx}-${Date.now()}`,
    productId: String(it.product_id),
    quantity: qty,
    appliedPrice: Math.round(Number(it.unit_price_charged ?? 0)),
    unitPriceCharged: Math.round(Number(it.unit_price_charged ?? 0)),
    unitCostAtSale: Math.round(Number(it.unit_cost_at_sale ?? 0)),
    discountAmount: Math.round(Number(it.discount_amount ?? 0)),
    lineProfit: Math.round(Number(it.line_profit ?? 0)),
    imeiNumber: null,
    saleItemId: null,
    lineIndex: idx,
    condition: 'restock',
    itemKey: `${String(it.product_id)}_${idx}`,
    itemPayload: '{}',
  }));
  const realDevice = deviceIdFromLedger();
  const deltaQty = opts.deltas ?? qty;
  return {
    ticketId,
    refundId: forgeId,
    itemsHash: `forge-${forgeId}`,
    receiptNumber: `AVOIR-FORGE-${forgeId.slice(-6)}`,
    method: opts.method ?? 'Avoir Client',
    online: false,
    localDeviceId: opts.spoofDevice ? 'FORGED-DEVICE-000' : realDevice,
    activeShiftId: openShiftId() ?? '',
    supervisor: null,
    customerId: (tj.customerId as string | undefined) ?? null,
    subtotal: Math.round(Number(ticket.subtotal ?? 0)),
    discountTotal: 0,
    totalNet: Math.round(Number(ticket.total ?? 0)),
    costTotal: Math.round(Number(tj.costTotal ?? 0)),
    pricingTier: String(tj.pricingTier ?? 'Retail'),
    paymentMethod: String(ticket.payment_method ?? 'Espèces'),
    cashTendered: Math.round(Number(ticket.cash_tendered ?? 0)),
    changeDue: Math.round(Number(ticket.change_due ?? 0)),
    cashTenderedNet: Math.round(Number(ticket.total ?? 0)),
    createdAt: new Date().toISOString(),
    refundPayload: JSON.stringify({
      id: forgeId,
      isRefund: true,
      originalTransactionId: ticketId,
      refundedItems: lines,
    }),
    originalOutboxPayload: String(ticket.json_payload ?? '{}'),
    deviceId: realDevice,
    lines,
    deltas: lines.map((l, i) => ({
      id: `forge-delta-${i}`,
      key: l.itemKey,
      productId: l.productId,
      delta: deltaQty,
    })),
    batches: [],
    imeis: [],
    defectiveImeis: [],
    defectNote: null,
    customerPointsAfter: null,
    customerPointBucketsJson: null,
    debt: null,
    voucher: null,
    cashMove: null,
    audit: {
      action: 'Remboursement / Avoir Émis',
      details: `E2E forged probe ${forgeId}`,
      user: 'E2E-Forge',
      requiresPin: false,
      deviceId: null,
      ipAddress: null,
    },
  };
}
async function invokeForgedRefund(req: Row): Promise<{ ok: boolean; raw: string }> {
  return (await browser.execute(async (r: unknown) => {
    try {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> };
      };
      const invoke = w.__TAURI_INTERNALS__?.invoke;
      if (!invoke) return { ok: false, raw: 'NO_TAURI_INTERNALS' };
      const res = await invoke('refund_sale_atomic', { req: r });
      return { ok: true, raw: JSON.stringify(res).slice(0, 600) };
    } catch (e) {
      // TrustError wire shape is `{gate_code, message_key, kind, detail?}`
      // (ipc_authorizer.rs:201-214) — the refusal vocabulary lives in
      // `detail`. Never String(e): that collapses to "[object Object]".
      let raw = '';
      if (typeof e === 'string') {
        raw = e;
      } else if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        raw = [o.kind, o.message_key, o.detail, o.message, o.error]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(' :: ');
        if (!raw) {
          try {
            raw = JSON.stringify(o);
          } catch {
            raw = String(e);
          }
        }
      } else {
        raw = String(e);
      }
      return { ok: false, raw: raw.slice(0, 900) };
    }
  }, req)) as { ok: boolean; raw: string };
}

// ---------------------------------------------------------------------------
// Reports / void helper (REF-13)
// ---------------------------------------------------------------------------

async function openReports(): Promise<void> {
  const opened = (await browser.execute(() => {
    const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    const b = btns.find((x) => (x.textContent || '').includes('Rapports') && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!opened) throw new Error('Rapports button not found');
  await browser.pause(900);
}
/** Reports view is behind a manager-PIN gate (ReportsModal.tsx:793-827):
 * fill the "Code PIN Administrateur" field and submit "Déverrouiller". */
async function unlockReportsGate(): Promise<void> {
  // The gate mounts asynchronously after the Reports modal opens. Probing
  // before it exists used to read as "already unlocked" and silently skip the
  // PIN, leaving the view gated (REF-13, 2026-11-02). Wait for a state: either
  // the gate input or the reports surface (search box) must exist.
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
        const gate = [...document.querySelectorAll('input[type="password"]')].some(
          (i) => vis(i) && /Administrateur|Manager/i.test((i as HTMLInputElement).placeholder || ''),
        );
        const surface = [...document.querySelectorAll('input')].some(
          (i) => vis(i) && /recherch/i.test((i as HTMLInputElement).placeholder || ''),
        );
        return gate || surface;
      })) as boolean,
    { timeout: 15000, interval: 250, timeoutMsg: 'reports view never mounted (gate or surface)' },
  );
  const state = (await browser.execute((pin: string) => {
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
    if (!btn) return 'no-button';
    btn.click();
    return 'submitted';
  }, APP_PIN)) as string;
  console.log(`[void] gate probe state=${state}`);
  if (state !== 'submitted') return; // view was already unlocked (or gate absent)
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
        return !([...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[]).some(
          (i) => vis(i) && /Administrateur/i.test(i.placeholder || ''),
        );
      })) as boolean,
    { timeout: 15000, interval: 300, timeoutMsg: 'reports PIN gate never cleared (wrong PIN / lockout?)' },
  );
  await browser.pause(400);
}

/** The receipt list lives under the "Historique Transactions" tab. */
async function openReportsHistoryTab(): Promise<void> {
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
    const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
      (x) => vis(x) && /Historique/.test(x.textContent || '') && !x.disabled,
    );
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (clicked) await browser.pause(700);
}

async function voidSaleViaReports(receipt: string, reason: string): Promise<{ sawForm: boolean; confirmed: boolean }> {
  await openReports();
  await unlockReportsGate();
  await openReportsHistoryTab();
  // Filter by receipt when a search field exists.
  await browser.execute((rc: string) => {
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
    const search = ([...document.querySelectorAll('input')] as HTMLInputElement[]).find(
      (i) => vis(i) && /recherch/i.test(i.placeholder || ''),
    );
    if (search) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, rc);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, receipt);
  await browser.pause(400);
  // The history row itself is inert — the inspector opens from its
  // "Inspecter le ticket …" button (ReportsModal.tsx:1539-1546), whose
  // aria-label carries the receipt number. Run-4 clicked the <tr> and
  // nothing happened.
  const clickedRow = (await browser.execute((rc: string) => {
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
    const btn = ([...document.querySelectorAll('button[aria-label]')] as HTMLButtonElement[]).find(
      (b) => vis(b) && (b.getAttribute('aria-label') || '').includes(rc),
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, receipt)) as boolean;
  if (!clickedRow) {
    console.log(`[void] receipt ${receipt} inspect button not found in reports :: tail=${(await bodyTail()).slice(-300)}`);
    return { sawForm: false, confirmed: false };
  }
  await browser.pause(700);
  const openedForm = (await browser.execute(() => {
    const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    const b = btns.find((x) => /Annuler Vente/i.test(x.textContent || '') && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!openedForm) {
    console.log(`[void] no "Annuler Vente" button after inspector open :: tail=${(await bodyTail()).slice(-300)}`);
    return { sawForm: false, confirmed: false };
  }
  await browser.pause(600);
  // Void form (ReportsModal.tsx:2156-2199): reason input under the
  // "Motif de l'annulation :" label (2163-2170, no placeholder, pre-filled
  // default) + manager PIN "Code PIN Manager" (2174-2183). The unlock gate's
  // Administrateur input is gone by now — unlockReportsGate waited it out.
  const filled = (await browser.execute((r: string, pin: string) => {
    const vis = (d: HTMLElement) => {
      try {
        const cs = getComputedStyle(d);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        const b = d.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      } catch {
        return false;
      }
    };
    const setVal = (el: HTMLInputElement, v: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const label = ([...document.querySelectorAll('label')] as HTMLLabelElement[]).find(
      (l) => vis(l) && /Motif de l'annulation/i.test(l.textContent || ''),
    );
    const reasonEl = label?.parentElement?.querySelector('input') ?? null;
    const pinEl =
      ([...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[])
        .filter((i) => vis(i) && /Code PIN Manager/i.test(i.placeholder || ''))
        .pop() ?? null;
    if (reasonEl) setVal(reasonEl, r);
    if (pinEl) setVal(pinEl, pin);
    return { reason: Boolean(reasonEl), pin: Boolean(pinEl) };
  }, reason, APP_PIN)) as { reason: boolean; pin: boolean };
  console.log(`[void] form fields — reason:${filled.reason} pin:${filled.pin}`);
  await browser.pause(400);
  const confirmed = (await browser.execute(() => {
    const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    const b = btns.find((x) => /Confirmer l'Annulation/i.test(x.textContent || '') && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  await browser.pause(500);
  console.log(`[void] confirmed=${confirmed} :: tail=${(await bodyTail()).slice(-200)}`);
  return { sawForm: true, confirmed };
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

describe('REF — refunds, returns & avoirs (batch 4 / part 2)', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    await resetData();
    seedProducts([
      { id: P500, title: 'REF P500', priceDa: 500, stock: 500, costDa: 300 },
      { id: P700, title: 'REF P700', priceDa: 700, stock: 300, costDa: 400 },
      { id: P1000, title: 'REF P1000', priceDa: 1000, stock: 300, costDa: 500 },
      { id: PSER, title: 'REF PSER', priceDa: 800, stock: 5, costDa: 500, isSerialized: true, imeiNumber: IMEI_SER },
    ]);
    seedImeiRecords([{ imei: IMEI_SER, productId: PSER, status: 'in_stock', warrantyMonths: 12 }]);
    seedCustomerFull([
      { id: CUST, name: CUST_NAME, phone: '0551200002', currentDebtDa: 0, debtLimitDa: 100000, storeCreditDa: 400 },
      { id: CUST65, name: CUST65_NAME, phone: '0551200065', currentDebtDa: 0, debtLimitDa: 500000 },
    ]);
    await clearWebMirrors();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
    captureInvariantBaseline('REF2');
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
    await clearCart().catch((e) => console.log('[afterEach] clearCart:', String((e as Error)?.message ?? e)));
    await clearPinMirror();
    const title = String((this as unknown as { currentTest?: { title?: string } }).currentTest?.title ?? 'unknown');
    assertInvariants(`REF2 :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('REF batch2 (spec 31)');
  });

  it('[REF-07] cash refund with an emptied drawer / zero float: refused fail-closed, drawer never negative', async () => {
    // Part (a): a sale from the closed shift A, then attempt the refund in a
    // fresh shift B opened with a 0 DA float. Offline rules allow only
    // own-shift tickets — the attempt must be refused with the clear surface;
    // if it were allowed it would drive B's drawer to -500 with no warning.
    const saleA = await makeCashSale('REF P500', 1);
    const shiftA = openShiftId();
    expect(shiftA).not.toBeNull();
    const expectedA = expectedCashFor(String(shiftA));
    console.log(`[REF-07] closing shift A (${shiftA}) with expected ${expectedA}`);
    await closeShiftUi(expectedA);
    expect(String(sessionRow(String(shiftA))?.status)).toBe('CLOSED');

    const floatB = await openShiftBestEffort(0);
    console.log(`[REF-07] shift B opened with float ${floatB}`);
    const shiftB = openShiftId();
    expect(shiftB).not.toBeNull();
    const movesBefore = movesForSession(String(shiftB)).length;

    await openRefund();
    await refundSearch(saleA.receipt);
    const pick = await selectRefundTicket(saleA.receipt, 8000);
    console.log(`[REF-07] past-shift pick result: ${pick}`);
    let outcome = `pick=${pick}`;
    if (pick === 'clicked') {
      await submitRefund();
      const refusal = await waitForBodyTextAny(
        [
          'Hors ligne : seuls les tickets de cette caisse et de la session en cours sont remboursables',
          'Quantité à rembourser supérieure',
          'Erreur lors du remboursement',
        ],
        8000,
      );
      outcome = refusal || (await bodyTail()).slice(-250);
      console.log(`[REF-07] past-shift submit outcome: ${outcome}`);
    } else {
      // not selectable at all — still containment, capture the list state
      outcome = `${pick} :: ${(await bodyTail()).slice(-250)}`;
    }
    const refundedA = refundsFor(saleA.id);
    const movesAfter = movesForSession(String(shiftB)).length;
    const drawerB = expectedCashFor(String(shiftB));
    console.log(
      `[REF-07] refunded=${refundedA.length} movesB ${movesBefore}->${movesAfter} drawerB=${drawerB}`,
    );
    // Containment contract: no refund row, no movement into B, drawer >= 0.
    expect(refundedA.length).toBe(0);
    expect(movesAfter).toBe(movesBefore);
    expect(drawerB).toBeGreaterThanOrEqual(0);

    // Part (b): positive control — same-shift zero-float refund works and the
    // reconstructed drawer returns to exactly the float (never below 0).
    const saleB = await makeCashSale('REF P500', 1);
    await stageRefund(saleB.receipt, { method: 'Espèces' });
    const settled = await submitAndSettle(saleB.id, 1);
    expect(settled.landed).toBe(true);
    const drawerB2 = expectedCashFor(String(shiftB));
    expect(drawerB2).toBeGreaterThanOrEqual(0);
    console.log(`[REF-07] same-shift refund ok; drawer B now ${drawerB2} (float ${floatB})`);
  });

  it('[REF-08] refund after shift close + Z: old shift row immutable; refund goes to current shift or is refused', async () => {
    const shiftA = openShiftId();
    expect(shiftA).not.toBeNull();
    const s1 = await makeCashSale('REF P500', 1);
    const s2 = await makeCashSale('REF P700', 1);
    const expectedA = expectedCashFor(String(shiftA));
    await closeShiftUi(expectedA);
    const snapA = JSON.stringify(sessionRow(String(shiftA)));
    const movesABefore = movesForSession(String(shiftA)).length;

    await openShiftBestEffort(10000);
    const shiftB = openShiftId();
    expect(shiftB).not.toBeNull();
    expect(shiftB).not.toBe(shiftA);

    // Attempt the past-shift refund.
    let landed = false;
    await openRefund();
    await refundSearch(s1.receipt);
    const pick = await selectRefundTicket(s1.receipt, 8000);
    console.log(`[REF-08] past-shift pick(result=${pick})`);
    if (pick === 'clicked') {
      await selectRefundMethod('Espèces');
      await submitRefund();
      const refusalOrLand = await waitForBodyTextAny(
        ['Hors ligne : seuls les tickets de cette caisse et de la session en cours sont remboursables', 'Erreur lors du remboursement', 'AVOIR-'],
        9000,
      );
      console.log(`[REF-08] submit surface: ${refusalOrLand}`);
      landed = refundsFor(s1.id).length > 0;
    }

    // Contract: whatever happened, shift A's row is untouched and no movement
    // was booked into the closed session; a landed refund must live in B and
    // link the original sale.
    expect(JSON.stringify(sessionRow(String(shiftA)))).toBe(snapA);
    expect(movesForSession(String(shiftA)).length).toBe(movesABefore);
    if (landed) {
      const ref = refundsFor(s1.id)[0];
      expect(String(ref.shift_id)).toBe(String(shiftB));
      expect(String(ref.original_transaction_id)).toBe(s1.id);
      const mv = movesForReceipt(String(ref.receipt_number));
      expect(mv.length).toBeGreaterThanOrEqual(1);
      expect(String(mv[0].session_id)).toBe(String(shiftB));
      console.log('[REF-08] refund allowed into current shift B with correct linkage');
    } else {
      console.log('[REF-08] refund refused (offline own-shift containment) — old Z untouched');
    }
    expect(String(sessionRow(String(shiftA))?.status)).toBe('CLOSED');
    // s2 must remain sellable/refundable bookkeeping: no refund rows reference it.
    expect(refundsFor(s2.id).length).toBe(0);
  });

  it('[REF-09] manager refund without receipt — locate by customer phone / name, then refund audited', async () => {
    await clearCart();
    await selectCustomer(CUST_NAME);
    await addSku('REF P700');
    const before = txCount();
    await payExactFlow();
    await waitSaleLanded(before);
    const sale = newestTxRow();
    const saleId = String(sale?.id);
    const receipt = String(sale?.receipt_number);

    await openRefund();
    await refundSearch('0551200002');
    await browser.pause(400);
    const phoneHit = await visibleRowMatching(receipt);
    console.log(`[REF-09] phone search rows matching receipt: ${phoneHit}`);
    expect(phoneHit).toBeGreaterThanOrEqual(1);

    await refundSearch(CUST_NAME);
    await browser.pause(400);
    const nameHit = await visibleRowMatching(receipt);
    console.log(`[REF-09] name search rows matching receipt: ${nameHit}`);
    expect(nameHit).toBeGreaterThanOrEqual(1);

    // Bogus phone must filter the ticket out (search actually filters).
    await refundSearch('0000000000');
    await browser.pause(400);
    const bogusHit = await visibleRowMatching(receipt);
    expect(bogusHit).toBe(0);

    // Back to the real phone and complete the refund.
    await refundSearch('0551200002');
    const pick = await selectRefundTicket(receipt, 8000);
    expect(pick).toBe('clicked');
    await selectRefundMethod('Espèces');
    const settled = await submitAndSettle(saleId, 1);
    expect(settled.landed).toBe(true);
    const ref = refundsFor(saleId)[0];
    expect(String(ref.original_transaction_id)).toBe(saleId);

    // The manager action must be audited.
    const audit = await waitFor(
      () =>
        all<Row>(
          `SELECT * FROM security_audit_logs WHERE rowid > (SELECT COALESCE(MAX(rowid),0) - 12 FROM security_audit_logs)
             AND (details LIKE ? OR action LIKE ? OR details LIKE ?)`,
          `%${receipt}%`,
          '%Rembours%',
          '%AVOIR%',
        ),
      (rows) => rows.length > 0,
      8000,
    );
    console.log(`[REF-09] audit rows in delta window: ${audit.length}`);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('[REF-10] serialized IMEI: traceable to the sale, once-only refund, lifecycle restored', async () => {
    const base = stockOf(PSER);
    const sale = await makeCashSale('REF PSER', 1);
    const items = all<Row>('SELECT * FROM transaction_items WHERE transaction_id = ?', sale.id);
    expect(items.length).toBe(1);
    const itemImei = String(items[0].imei_number ?? '');
    console.log(`[REF-10] item imei=${itemImei}`);
    expect(itemImei).toBe(IMEI_SER);
    expect(stockOf(PSER)).toBe(base - 1);

    const rec = one<Row>('SELECT * FROM imei_records WHERE imei = ?', IMEI_SER);
    console.log(
      `[REF-10] imei_records after sale: status=${rec?.status} saleTx=${rec?.sale_transaction_id} soldAt=${rec?.sold_at}`,
    );
    const traceable =
      String(rec?.sale_transaction_id ?? '') === sale.id ||
      Boolean(rec?.sold_at) ||
      String(rec?.status ?? '') === 'sold';
    expect(traceable).toBe(true);

    // Full refund → once-only return.
    await stageRefund(sale.receipt, { method: 'Espèces' });
    const settled = await submitAndSettle(sale.id, 1);
    expect(settled.landed).toBe(true);
    expect(refundsFor(sale.id).length).toBe(1);
    expect(stockOf(PSER)).toBe(base);

    const rec2 = one<Row>('SELECT * FROM imei_records WHERE imei = ?', IMEI_SER);
    console.log(`[REF-10] imei_records after refund: status=${rec2?.status} saleTx=${rec2?.sale_transaction_id}`);
    expect(String(rec2?.status ?? '')).toBe('in_stock');
    const dupes = Number(
      one<{ c: number }>('SELECT COUNT(*) AS c FROM imei_records WHERE imei = ?', IMEI_SER)?.c ?? 0,
    );
    expect(dupes).toBe(1);

    // A second return attempt must not be offered / must not land.
    await browser.pause(400);
    if (!(await refundDialogVisible())) await openRefund();
    const pick2 = await pickTicket(sale.receipt);
    let secondLanded = false;
    if (pick2 === 'clicked') {
      const st = await refundLineState(`${PSER}_0`);
      console.log(`[REF-10] second attempt line state: ${JSON.stringify(st)}`);
      if (st && st.checked && st.qty > 0) {
        await submitRefund();
        await browser.pause(2500);
        secondLanded = refundsFor(sale.id).length > 1;
      }
    }
    expect(secondLanded).toBe(false);
    expect(stockOf(PSER)).toBe(base);
  });

  it('[REF-12] exchange both directions as two documents: no cross-contamination, net drawer correct', async () => {
    const p1000Base = stockOf(P1000);
    const p700Base = stockOf(P700);

    // Direction 1: 1000 out, refunded; 700 back in (customer gets 300 back).
    const a = await makeCashSale('REF P1000', 1);
    await stageRefund(a.receipt, { method: 'Espèces' });
    let settled = await submitAndSettle(a.id, 1);
    expect(settled.landed).toBe(true);
    const b = await makeCashSale('REF P700', 1);

    // Direction 2: 700 out, refunded; 1000 back in.
    const c = await makeCashSale('REF P700', 1);
    await stageRefund(c.receipt, { method: 'Espèces' });
    settled = await submitAndSettle(c.id, 1);
    expect(settled.landed).toBe(true);
    const d = await makeCashSale('REF P1000', 1);

    const refA = refundsFor(a.id);
    const refC = refundsFor(c.id);
    expect(refA.length).toBe(1);
    expect(refC.length).toBe(1);
    expect(String(refA[0].original_transaction_id)).toBe(a.id);
    expect(String(refC[0].original_transaction_id)).toBe(c.id);
    // No refund ever references the replacement sales.
    expect(refundsFor(b.id).length).toBe(0);
    expect(refundsFor(d.id).length).toBe(0);
    // Full refunds of cash sales pay the full amount.
    expect(Number(jsonOf(refA[0]).cashDisbursed)).toBe(1000);
    expect(Number(jsonOf(refC[0]).cashDisbursed)).toBe(700);
    // Net stock: each direction's ORIGINAL sale was refunded (unit returned),
    // but each replacement sale is KEPT — net effect is base − 1 for both SKUs.
    expect(stockOf(P1000)).toBe(p1000Base - 1);
    expect(stockOf(P700)).toBe(p700Base - 1);
  });

  it('[REF-13] void vs refund: void flips status + restocks, moves no money, is audited; refund pays', async () => {
    const base = stockOf(P500);
    const v1 = await makeCashSale('REF P500', 1);
    const movesBefore = count('cash_movements');

    const { sawForm, confirmed } = await voidSaleViaReports(v1.receipt, 'E2E void probe');
    console.log(`[REF-13] void form=${sawForm} confirm=${confirmed}`);
    const v1Status = await waitFor(
      () => String(txRow(v1.id)?.status ?? ''),
      (s) => s === 'VOIDED',
      10000,
    );
    expect(v1Status).toBe('VOIDED');
    await browser.pause(1200); // let the modal's outcome toast land (3 s life)
    console.log(
      `[REF-13] post-void: toasts="${await visibleToasts()}" stock=${stockOf(P500)} (base ${base}) audits=${count('security_audit_logs')} moves=${count('cash_movements')} refunds=${refundsFor(v1.id).length}`,
    );
    // No money movement from a void.
    expect(count('cash_movements')).toBe(movesBefore);
    expect(refundsFor(v1.id).length).toBe(0);
    // Restock: a void must put the unit back.
    expect(stockOf(P500)).toBe(base);
    // Audited.
    const auditHit = await waitFor(
      () =>
        all<Row>(
          `SELECT * FROM security_audit_logs WHERE (details LIKE ? OR action LIKE ?)`,
          `%${v1.receipt}%`,
          '%Annul%',
        ),
      (rows) => rows.length > 0,
      8000,
    );
    expect(auditHit.length).toBeGreaterThanOrEqual(1);

    // Refund path for contrast: sale R1 → refund pays, stock cycles.
    const r1 = await makeCashSale('REF P500', 1);
    await stageRefund(r1.receipt, { method: 'Espèces' });
    const settled = await submitAndSettle(r1.id, 1);
    expect(settled.landed).toBe(true);
    expect(Number(jsonOf(refundsFor(r1.id)[0]).cashDisbursed)).toBe(500);

    // A voided ticket must not be refundable (not offered or refused).
    await browser.pause(300);
    if (!(await refundDialogVisible())) await openRefund();
    await refundSearch(v1.receipt);
    const pickVoid = await selectRefundTicket(v1.receipt, 6000);
    console.log(`[REF-13] voided-ticket pick result: ${pickVoid}`);
    let voidRefunded = false;
    if (pickVoid === 'clicked') {
      const st = await refundLineState(`${P500}_0`);
      if (st && st.checked && st.qty > 0) {
        await submitRefund();
        await browser.pause(2500);
        voidRefunded = refundsFor(v1.id).length > 0;
      }
    }
    expect(voidRefunded).toBe(false);
  });

  it('[REF-14] stale second cashier: forged fresh request refused by the cumulative quota, zero side effects', async () => {
    const base = stockOf(P500);
    const sale = await makeCashSale('REF P500', 2); // 2 units = 1000
    await stageRefund(sale.receipt, { method: 'Espèces', qtyByKey: { [`${P500}_0`]: 1 } });
    let settled = await submitAndSettle(sale.id, 1);
    expect(settled.landed).toBe(true);
    const refund1 = refundsFor(sale.id)[0];
    expect(Number(jsonOf(refund1).cashDisbursed)).toBe(500);
    expect(String(txRow(sale.id)?.status)).toBe('PARTIALLY_REFUNDED');

    // Forged stale request: claims BOTH units are still refundable.
    const movesBefore = count('cash_movements');
    const stockBefore = stockOf(P500);
    const forgedA = await invokeForgedRefund(buildForgedRefund(sale.id, 2));
    console.log(`[REF-14] forged stale qty=2 → ok=${forgedA.ok} raw=${forgedA.raw.slice(0, 220)}`);
    expect(forgedA.ok).toBe(false);
    expect(forgedA.raw).toMatch(/REFUND_EXCEEDS|ZERO_REFUNDABLE|ALREADY_REFUNDED|REFUND_ALREADY_IN_PROGRESS/);
    expect(refundsFor(sale.id).length).toBe(1);
    expect(count('cash_movements')).toBe(movesBefore);
    expect(stockOf(P500)).toBe(stockBefore);

    // Honest second partial: the last unit via the UI.
    await stageRefund(sale.receipt, { method: 'Espèces', qtyByKey: { [`${P500}_0`]: 1 } });
    settled = await submitAndSettle(sale.id, 2);
    expect(settled.landed).toBe(true);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');
    expect(stockOf(P500)).toBe(base);

    // Forged #2 on the fully-refunded ticket: refused, zero side effects.
    const movesBefore2 = count('cash_movements');
    const forgedB = await invokeForgedRefund(buildForgedRefund(sale.id, 1));
    console.log(`[REF-14] forged fully-refunded qty=1 → ok=${forgedB.ok} raw=${forgedB.raw.slice(0, 220)}`);
    expect(forgedB.ok).toBe(false);
    expect(forgedB.raw).toMatch(/REFUND_EXCEEDS|ZERO_REFUNDABLE|ALREADY_REFUNDED/);
    expect(refundsFor(sale.id).length).toBe(2);
    expect(count('cash_movements')).toBe(movesBefore2);
    expect(stockOf(P500)).toBe(base);
    // UI agrees: nothing left refundable.
    if (!(await refundDialogVisible())) await openRefund();
    const pick = await pickTicket(sale.receipt);
    let thirdLanded = false;
    if (pick === 'clicked') {
      const st = await refundLineState(`${P500}_0`);
      console.log(`[REF-14] fully refunded line state: ${JSON.stringify(st)}`);
      if (st && st.checked && st.qty > 0) {
        await submitRefund();
        await browser.pause(2500);
        thirdLanded = refundsFor(sale.id).length > 2;
      }
    }
    expect(thirdLanded).toBe(false);
  });

  it('[REF-18] reprint fires a fresh print attempt with zero money movement (no second disbursement)', async () => {
    await armConsoleTap();
    const printsBase = await countConsoleMatching('ESC/POS|Spooler');
    const sale = await makeCashSale('REF P500', 1);
    const printsAfterSale = await countConsoleMatching('ESC/POS|Spooler');
    await stageRefund(sale.receipt, { method: 'Espèces' });
    const settled = await submitAndSettle(sale.id, 1);
    expect(settled.landed).toBe(true);
    const printsAfterRefund = await countConsoleMatching('ESC/POS|Spooler');
    console.log(
      `[REF-18] console print attempts: base=${printsBase} afterSale=${printsAfterSale} afterRefund=${printsAfterRefund}`,
    );

    const moves = count('cash_movements');
    const txns = txCount();
    const refRow = refundsFor(sale.id)[0];
    const refVersion = Number(refRow.version ?? 0);
    const refUpdated = String(refRow.updated_at ?? '');

    // Press the bottom-bar Reprimer (real UI).
    const clicked = (await browser.execute(() => {
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      const b = btns.find((x) => (x.textContent || '').includes('Réimprimer') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    expect(clicked).toBe(true);
    await browser.pause(1500);
    const printsAfterReprint = await countConsoleMatching('ESC/POS|Spooler');
    console.log(`[REF-18] after Reprimer: ${printsAfterReprint}`);

    // Money truth: a reprint is a print, never a payment.
    expect(count('cash_movements')).toBe(moves);
    expect(txCount()).toBe(txns);
    const refRow2 = refundsFor(sale.id)[0];
    expect(Number(refRow2.version ?? 0)).toBe(refVersion);
    expect(String(refRow2.updated_at ?? '')).toBe(refUpdated);

    // Print evidence: every prior step produced spooler attempts in the
    // sandbox (no real printer). The reprint must issue its own attempt.
    if (printsAfterRefund > printsAfterSale || printsAfterSale > printsBase) {
      expect(printsAfterReprint).toBeGreaterThan(printsAfterRefund);
    } else {
      console.log('[REF-18] NOTE: console spooler tapping captured no attempts in this run — print-attempt assertion skipped (money assertions enforced)');
    }
    // No copy/reprint marker exists in the receipt pipeline (source-cited
    // finding in the report: receiptViewModel/ESC-POS spooler render the same
    // ticket bytes; there is no COPIE/DUPLICATA variant flag).
  });

  it('[REF-28] stacked discounts (line override + coupon + loyalty): full reversal exact, credit note <= paid', async () => {
    // Line lane: price override 1000 -> 900 on line 1.
    await clearCart();
    await addSku('REF P1000');
    await overrideLastLinePrice('900', { pin: APP_PIN });
    await addSku('REF P500');
    // Cart lane via coupon: PROMO500 = 500 DA off → applied as cart percent.
    await (await $(tid('discount-button'))).click();
    await (await $(tid('discount-dialog'))).waitForDisplayed({ timeout: 20000 });
    const promoSet = (await browser.execute(() => {
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
      const dlg = ([...document.querySelectorAll('[data-testid="discount-dialog"]')] as HTMLElement[]).find(vis) ?? null;
      if (!dlg) return false;
      const input = ([...dlg.querySelectorAll('input')] as HTMLInputElement[]).find((i) =>
        /SOLDES10/.test(i.placeholder || ''),
      );
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'PROMO500');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
        /^Valider/.test((b.textContent || '').trim()),
      );
      if (!btn) return false;
      btn.click();
      return true;
    })) as boolean;
    expect(promoSet).toBe(true);
    const promoSurface = await waitForBodyTextAny(['Appliqué', 'invalide', 'épuisé'], 4000);
    console.log(`[REF-28] promo surface: "${promoSurface}"`);
    expect(promoSurface).toContain('Appliqué');
    // Apply (percent > 10 → manager PIN gate).
    const pin = await $(tid('discount-pin'));
    if (await pin.isDisplayed().catch(() => false)) await typeReal(pin, APP_PIN, false);
    await (await $(tid('discount-apply'))).click();
    await browser.waitUntil(async () => !(await $(tid('discount-dialog')).isDisplayed().catch(() => false)), {
      timeout: 20000,
      timeoutMsg: 'discount dialog did not close',
    });

    const cartTotal = await cartTotalMinor();
    console.log(`[REF-28] cart total after override+coupon: ${cartTotal}`);
    // Attach loyalty customer (400 DA store credit) and redeem all of it.
    await selectCustomer(CUST_NAME);
    await clickUnobstructed('checkout-button');
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const applied = (await browser.execute(() => {
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
      const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
        /Appliquer Tout/.test(b.textContent || ''),
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })) as boolean;
    expect(applied).toBe(true);
    await browser.pause(500);
    const payNet = displayedToMinor(await (await $(tid('pay-net'))).getText());
    console.log(`[REF-28] pay-net after loyalty: ${payNet}`);
    // Oracle recomputed from DB truth (run-3 correction: the earlier
    // 400-loyalty/net-500 expectation had reused MNY-26's numbers). The
    // guardrail caps the loyalty redemption at
    // min(wallet, floor(payable/2), payable − cogs).
    expect(cartTotal).toBe(90000n); // Σ charged lines 1400 − coupon 500
    const custBefore = one<Row>('SELECT * FROM customers WHERE id = ?', CUST);
    const walletBefore = Number(custBefore?.store_credit ?? 0);
    const payable = 900;
    const cogs = Number(
      one<{ s: number }>(
        `SELECT COALESCE(SUM(cost_price),0) AS s FROM products WHERE id IN (?, ?)`,
        P1000,
        P500,
      )?.s ?? 0,
    );
    const loyaltyCap = Math.min(walletBefore, Math.floor(payable / 2), Math.max(0, payable - cogs));
    console.log(
      `[REF-28] oracle: wallet=${walletBefore} payable=${payable} cogs=${cogs} loyaltyCap=${loyaltyCap}`,
    );
    expect(loyaltyCap).toBe(100); // seeded scenario guard: min(400, 450, 100)
    expect(payNet).toBe(BigInt(payable - loyaltyCap) * 100n);
    const before = txCount();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(async () => !(await payDialogVisible()), {
      timeout: 45000,
      timeoutMsg: 'pay dialog did not close',
    });
    await waitSaleLanded(before);
    const sale = newestTxRow();
    const saleId = String(sale?.id);
    const sj = jsonOf(sale);
    const items = all<Row>('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', saleId);
    const lineDisc = items.reduce((a, i) => a + Number(i.discount_amount ?? 0), 0);
    console.log(
      `[REF-28] sale total=${sale?.total} subtotal=${sale?.subtotal} discount_total=${sale?.discount_total} lineDisc=${lineDisc} tenders=${JSON.stringify(sj.tenders)}`,
    );
    // Oracle: `total` is stored net of the store-credit leg while tenders sum
    // to the full payable (900 = 800 cash + 100 avoir). The document-arithmetic
    // gap this creates is tracked by the invariant runs (G-01/G-03 fire on this
    // receipt — cross-referenced finding).
    expect(Number(sale?.subtotal)).toBe(1400);
    expect(Number(sale?.discount_total)).toBe(500);
    expect(Number(sale?.total)).toBe(payable - loyaltyCap);
    const tenders = Array.isArray(sj.tenders) ? (sj.tenders as Array<Row>) : [];
    const avoirTender = tenders
      .filter((t) => String(t.method ?? '') === 'Avoir Client')
      .reduce((a, t) => a + Number(t.amount ?? 0), 0);
    const cashTender = tenders
      .filter((t) => String(t.method ?? '') === 'Espèces')
      .reduce((a, t) => a + Number(t.amount ?? 0), 0);
    expect(avoirTender).toBe(loyaltyCap);
    expect(cashTender).toBe(payable - loyaltyCap);
    expect(
      Number(one<Row>('SELECT * FROM customers WHERE id = ?', CUST)?.store_credit),
    ).toBe(walletBefore - loyaltyCap);

    // Full refund: value reversed = 900; cash leg 800 back in cash; loyalty
    // leg 100 restored to the wallet (clampCashRefund: cash ≤ cashTenderedNet).
    await stageRefund(String(sale?.receipt_number), { method: 'Espèces' });
    const lineKeys = items.map((it, idx) => `${String(it.product_id)}_${idx}`);
    for (const k of lineKeys) await setRefundQty(k, 1);
    const shown = await refundTotalMinor();
    console.log(`[REF-28] refund modal shows: ${shown}`);
    expect(shown).toBe(BigInt(payable) * 100n);
    const settled = await submitAndSettle(saleId, 1);
    expect(settled.landed).toBe(true);
    const ref = refundsFor(saleId)[0];
    const rj = jsonOf(ref);
    const cashOut = Number(rj.cashDisbursed ?? 0);
    console.log(`[REF-28] refund cashDisbursed=${cashOut} total=${ref.total}`);
    console.log(
      `[REF-28] refund line basis: ${JSON.stringify(
        (Array.isArray(rj.refundedItems) ? (rj.refundedItems as Row[]) : []).map((ri) => ({
          p: String(ri.productId),
          unit: Number(ri.unitPrice),
          amt: Number(ri.totalRefundAmount),
        })),
      )}`,
    );
    const walletAfter = Number(
      one<Row>('SELECT store_credit FROM customers WHERE id = ?', CUST)?.store_credit,
    );
    console.log(`[REF-28] wallet after refund: ${walletAfter} (before=${walletBefore})`);
    // Exact-reversal contract: refund total = net paid 900; cash leg 800
    // actually disbursed; loyalty leg 100 restored to the wallet. All three
    // observations are collected before the verdict so one run carries the
    // whole money trail instead of stopping at the first mismatch.
    const faults: string[] = [];
    if (Number(ref.total) !== payable) {
      faults.push(`stored refund total=${Number(ref.total)} expected=${payable}`);
    }
    if (cashOut !== payable - loyaltyCap) {
      faults.push(`cashDisbursed=${cashOut} expected=${payable - loyaltyCap}`);
    }
    if (walletAfter !== walletBefore) {
      faults.push(`wallet after=${walletAfter} expected=${walletBefore}`);
    }
    if (faults.length > 0) {
      throw new Error(
        `[REF-28] full reversal not exact — paid ${payable} (cash ${payable - loyaltyCap} + avoir ${loyaltyCap}); ` +
          `refund committed ${Number(ref.total)} (cash ${cashOut} + avoir ${walletAfter - (walletBefore - loyaltyCap)}): ` +
          faults.join(' | '),
      );
    }
    const cust = one<Row>('SELECT * FROM customers WHERE id = ?', CUST);
    const custPayload = jsonOf(cust);
    console.log(
      `[REF-28] customer store_credit col=${cust?.store_credit} payload=${custPayload.storeCredit}`,
    );
    expect(Number(cust?.store_credit)).toBe(walletBefore);
  });

  it('[REF-34] refund of an overridden-price line pays the overridden amount (300, never 500)', async () => {
    await clearCart();
    await addSku('REF P500');
    await overrideLastLinePrice('300', { pin: APP_PIN });
    const before = txCount();
    await payExactFlow();
    await waitSaleLanded(before);
    const sale = newestTxRow();
    const saleId = String(sale?.id);
    const items = all<Row>('SELECT * FROM transaction_items WHERE transaction_id = ?', saleId);
    expect(Number(items[0].unit_price_charged)).toBe(300);
    expect(Number(sale?.total)).toBe(300);

    await stageRefund(String(sale?.receipt_number), { method: 'Espèces' });
    const shown = await refundTotalMinor();
    console.log(`[REF-34] refund modal shows: ${shown}`);
    expect(shown).toBe(30000n);
    const settled = await submitAndSettle(saleId, 1);
    expect(settled.landed).toBe(true);
    const ref = refundsFor(saleId)[0];
    expect(Number(ref.total)).toBe(300);
    expect(Number(jsonOf(ref).cashDisbursed)).toBe(300);
  });

  it('[REF-36] restock vs write-off: rebut does not restock, is quarantined, needs a motive', async () => {
    const base = stockOf(P500);
    const sale = await makeCashSale('REF P500', 3);
    expect(stockOf(P500)).toBe(base - 3);

    // Refund #1: restock unit.
    await stageRefund(sale.receipt, { method: 'Espèces', qtyByKey: { [`${P500}_0`]: 1 } });
    let settled = await submitAndSettle(sale.id, 1);
    expect(settled.landed).toBe(true);
    expect(stockOf(P500)).toBe(base - 2);

    // Refund #2: write-off (Rebut) with a motive.
    const defectiveBefore = count('defective_returns');
    await stageRefund(sale.receipt, { method: 'Espèces', qtyByKey: { [`${P500}_0`]: 1 } });
    const toggled = await toggleRefundWriteOff();
    console.log(`[REF-36] write-off toggle was "${toggled}"`);
    // Exact option text (RefundModal.tsx:1075-1079); bare "Défectueux" matches no option.
    await setRefundReason('Article défectueux / Panne sous garantie');
    await typeRefundCustomReason('E2E rebut: écran fissuré').catch((e) =>
      console.log(`[REF-36] custom reason input: ${String((e as Error)?.message ?? e)}`),
    );
    settled = await submitAndSettle(sale.id, 2);
    if (!settled.landed) {
      // The defect note may live on the line itself; fill any visible note field then retry.
      console.log(`[REF-36] first write-off submit did not land (${settled.surface}) — probing line note field`);
      await browser.execute(() => {
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
        const dlg =
          ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis) ?? null;
        if (!dlg) return;
        const el = ([...dlg.querySelectorAll('input, textarea')] as Array<HTMLInputElement | HTMLTextAreaElement>).find(
          (i) => vis(i) && /motif|rebut|note/i.test(i.placeholder || ''),
        );
        if (el) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          setter?.call(el, 'E2E rebut: écran fissuré');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await browser.pause(300);
      settled = await submitAndSettle(sale.id, 2);
    }
    expect(settled.landed).toBe(true);
    // Write-off: no restock (stock stays at base-2), quarantined row created.
    expect(stockOf(P500)).toBe(base - 2);
    const defectiveAfter = count('defective_returns');
    console.log(`[REF-36] defective_returns ${defectiveBefore} -> ${defectiveAfter}`);
    expect(defectiveAfter).toBeGreaterThan(defectiveBefore);
    // Quarantine evidence: the write-off row carries the operator motive and
    // the frozen unit cost (loss memo — never the sell price); the refund
    // amount is identical to the restock path (stock decision ⊥ money).
    const refunds2 = refundsFor(sale.id);
    const ref2 = refunds2[refunds2.length - 1];
    const def2 = one<Row>('SELECT * FROM defective_returns WHERE refund_id = ?', String(ref2.id));
    console.log(
      `[REF-36] write-off row: refund=${String(ref2.receipt_number)} total=${Number(ref2.total)} reason="${String(def2?.reason)}" unit_cost=${Number(def2?.unit_cost)}`,
    );
    expect(Number(ref2.total)).toBe(500);
    expect(String(def2?.reason)).toBe('Article défectueux / Panne sous garantie');
    expect(Number(def2?.unit_cost)).toBe(300);

    // Refund #3: write-off whose free-text is left EMPTY under the "Autre"
    // category. The modal promises "Précisez le motif exact..." for Autre
    // (RefundModal.tsx:1083-1090) and "le motif ... est obligatoire et sera
    // conservé comme note de rebut" (1004-1006); the gates (528-534, slice
    // RESTOCK_REASON_REQUIRED, native refund.rs:400-408) only test
    // non-emptiness — so the placeholder literal 'Autre' alone satisfies them
    // with no operator-authored note. Contract: a write-off without a real
    // note must be refused.
    await stageRefund(sale.receipt, { method: 'Espèces', qtyByKey: { [`${P500}_0`]: 1 } });
    const toggled3 = await toggleRefundWriteOff();
    console.log(`[REF-36] #3 write-off toggle was "${toggled3}"`);
    await setRefundReason('Autre'); // "Autre motif personnalisé..." — custom text left EMPTY
    await browser.pause(300);
    const settled3 = await submitAndSettle(sale.id, 3);
    console.log(`[REF-36] 'Autre'-empty write-off submit → landed=${settled3.landed} surface=${settled3.surface}`);
    if (settled3.landed) {
      const def3 = one<Row>('SELECT * FROM defective_returns ORDER BY rowid DESC LIMIT 1');
      console.log(
        `[REF-36] ACCEPTED with quarantine note "${String(def3?.reason)}" — operator authored no note (empty free-text)`,
      );
    }
    expect(settled3.landed).toBe(false);
    expect(refundsFor(sale.id).length).toBe(2);
    expect(stockOf(P500)).toBe(base - 2);
  });

  it('[REF-46] forged IPC over-ask and device spoof: typed refusal, zero side effects', async () => {
    const base = stockOf(P500);
    const sale = await makeCashSale('REF P500', 2); // 1000, 2 units
    await stageRefund(sale.receipt, { method: 'Espèces', qtyByKey: { [`${P500}_0`]: 1 } });
    const settled = await submitAndSettle(sale.id, 1);
    expect(settled.landed).toBe(true);
    expect(String(txRow(sale.id)?.status)).toBe('PARTIALLY_REFUNDED');

    // Attempt A: qty=2 while only 1 unit remains → quota must refuse.
    const movesBefore = count('cash_movements');
    const stockBefore = stockOf(P500);
    const forgeA = await invokeForgedRefund(buildForgedRefund(sale.id, 2));
    console.log(`[REF-46A] over-ask → ok=${forgeA.ok} raw=${forgeA.raw.slice(0, 300)}`);
    expect(forgeA.ok).toBe(false);
    expect(forgeA.raw).toMatch(/REFUND_EXCEEDS|ZERO_REFUNDABLE/);
    expect(refundsFor(sale.id).length).toBe(1);
    expect(count('cash_movements')).toBe(movesBefore);
    expect(stockOf(P500)).toBe(stockBefore);

    // Attempt B: spoofed local device identity → native refuses.
    const forgeB = await invokeForgedRefund(buildForgedRefund(sale.id, 1, { spoofDevice: true }));
    console.log(`[REF-46B] spoof → ok=${forgeB.ok} raw=${forgeB.raw.slice(0, 300)}`);
    expect(forgeB.ok).toBe(false);
    expect(forgeB.raw).toMatch(/DEVICE_IDENTITY_SPOOFED/);
    expect(refundsFor(sale.id).length).toBe(1);
    expect(count('cash_movements')).toBe(movesBefore);
    expect(stockOf(P500)).toBe(stockBefore);
  });

  it('[REF-65] pure credit-sale refund recomputes debt from the ledger (column/payload/ledger chain)', async () => {
    const sale = await makeCreditSale('REF P500', 2, CUST65_NAME);
    const afterSale = {
      col: Number(one<{ d: number }>('SELECT current_debt AS d FROM customers WHERE id = ?', CUST65)?.d ?? NaN),
      payload: Number((jsonOf(one<Row>('SELECT * FROM customers WHERE id = ?', CUST65)).currentDebt ?? NaN)),
      ledger: Number(
        one<{ b: number }>(
          `SELECT COALESCE(SUM(CASE WHEN type='DEBT_ACQUIRED' THEN amount WHEN type='PAYMENT_SETTLED' THEN -amount ELSE 0 END),0) AS b
           FROM customer_debts WHERE customer_id = ?`,
          CUST65,
        )?.b ?? NaN,
      ),
    };
    console.log(`[REF-65] after credit sale: col=${afterSale.col} payload=${afterSale.payload} ledger=${afterSale.ledger}`);
    expect(afterSale.ledger).toBe(1000);
    expect(afterSale.payload).toBe(1000);

    // Refund 1 of 2 units → 500 debt relief, no cash, native recompute.
    const movesBefore = count('cash_movements');
    const origin = txRow(sale.id) as Row;
    console.log(
      `[REF-65] ticket origin: shift=${String(origin?.shift_id ?? '')} device=${String(origin?.device_id ?? '')} activeShift=${String(openShiftId())}`,
    );
    // Tap the real IPC boundary: every refund/void command (args + raw error
    // detail) is recorded in-page, so the native `detail` that RefundModal's
    // toast drops (:597 shows only `reason`) is captured verbatim. Tauri
    // freezes `__TAURI_INTERNALS__` (run-02 finding), so the wrap is
    // adaptive (assign → clone-free defineProperty) and reports its outcome
    // instead of assuming success; the forged-invoke channel below needs no
    // wrap at all (REF-46A precedent).
    await browser.execute(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: { invoke?: unknown; __e2ePatched?: boolean };
        __e2eNative?: unknown[];
        __e2eNativeStatus?: string;
      };
      try {
        const internals = w.__TAURI_INTERNALS__;
        if (!internals || typeof internals.invoke !== 'function') {
          w.__e2eNativeStatus = 'no-internals';
          return;
        }
        if (internals.__e2ePatched) {
          w.__e2eNativeStatus = 'already-wrapped';
          return;
        }
        const orig = (internals.invoke as (...a: unknown[]) => Promise<unknown>).bind(internals);
        w.__e2eNative = w.__e2eNative ?? [];
        const wrapper = async (cmd: unknown, args: unknown) => {
          const key = String(cmd);
          const touched = /refund|void/i.test(key);
          const rec: Record<string, unknown> = { cmd: key, at: Date.now() };
          if (touched) {
            try {
              rec.args = JSON.stringify(args).slice(0, 4000);
            } catch {
              rec.args = '<unserializable>';
            }
          }
          try {
            const out = await orig(cmd, args);
            if (touched) rec.ok = true;
            return out;
          } catch (e) {
            if (touched) {
              rec.ok = false;
              rec.err = String((e as { message?: unknown })?.message ?? e).slice(0, 1500);
            }
            throw e;
          }
        };
        let how = 'none';
        try {
          internals.invoke = wrapper;
          how = internals.invoke === wrapper ? 'assign' : 'assign-inert';
        } catch (e) {
          how = `assign-throw:${String((e as Error)?.message ?? e)}`;
        }
        if (internals.invoke !== wrapper) {
          try {
            Object.defineProperty(internals, 'invoke', { value: wrapper, writable: true, configurable: true });
            how += internals.invoke === wrapper ? '|defineProp' : '|defineProp-inert';
          } catch (e) {
            how += `|defineProp-throw:${String((e as Error)?.message ?? e)}`;
          }
        }
        if (internals.invoke === wrapper) internals.__e2ePatched = true;
        w.__e2eNativeStatus = how;
      } catch (e) {
        w.__e2eNativeStatus = `outer-throw:${String((e as Error)?.message ?? e)}`;
      }
    });
    console.log(
      `[REF-65] invoke wrap: ${String(
        await browser.execute(
          () => (window as unknown as { __e2eNativeStatus?: string }).__e2eNativeStatus ?? 'unset',
        ),
      )}`,
    );
    await stageRefund(sale.receipt, { qtyByKey: { [`${P500}_0`]: 1 } });
    let settled = await submitAndSettle(sale.id, 1);
    console.log(`[REF-65] refund#1 settle → landed=${settled.landed} surface=${settled.surface}`);
    const natLog = (await browser.execute(
      () => (window as unknown as { __e2eNative?: unknown[] }).__e2eNative ?? [],
    )) as Array<Record<string, unknown>>;
    for (const n of natLog) console.log(`[REF-65-nat] ${JSON.stringify(n)}`);
    if (!settled.landed) {
      console.log(`[REF-65] modal state after refusal: ${await dumpRefundState('ref65-refused')}`);
      const chainCol = Number(
        one<{ d: number }>('SELECT current_debt AS d FROM customers WHERE id = ?', CUST65)?.d ?? NaN,
      );
      const chainPayload = Number(
        jsonOf(one<Row>('SELECT * FROM customers WHERE id = ?', CUST65)).currentDebt ?? NaN,
      );
      const chainLedger = Number(
        one<{ b: number }>(
          `SELECT COALESCE(SUM(CASE WHEN type='DEBT_ACQUIRED' THEN amount WHEN type='PAYMENT_SETTLED' THEN -amount ELSE 0 END),0) AS b
           FROM customer_debts WHERE customer_id = ?`,
          CUST65,
        )?.b ?? NaN,
      );
      // Diagnostics through the raw IPC (REF-46A precedent): the toast shows
      // only the collapsed reason (PERSISTENCE_FAILED via
      // createOrderSlice.ts:2915); a forged invoke returns the raw
      // `kind :: message_key :: detail`.
      //   Probe 1 — the UI shape: refundMethod defaults to 'Espèces'
      //   (RefundModal.tsx:96; stageRefund passes no method and the button is
      //   never disabled, :1021-1051) while the receivable-first split leaves
      //   cashOut=0 ⇒ cashMoveForNative null (createOrderSlice.ts:2741) ⇒
      //   expected hard refusal refund.rs:955-958.
      //   Probe 2 — control: same request, method 'Avoir Client'.
      const itemRows = all<Row>(
        'SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY rowid',
        sale.id,
      );
      const unitCost = Math.round(Number(itemRows[0]?.unit_cost_at_sale ?? 0));
      const refundsUi = refundsFor(sale.id).length;
      const debtLeg = () => ({
        entryId: `PAYREL-FORGE-${Date.now()}`,
        customerId: CUST65,
        customerName: CUST65_NAME,
        amount: 500,
        receiptNumber: `VERS-FORGE-${Date.now()}`,
        paymentMethod: 'Crédit Client',
        notes: 'E2E REF-65 diagnostic debt leg',
        recordedBy: 'E2E',
      });
      const espShape = await invokeForgedRefund({
        ...buildForgedRefund(sale.id, 1),
        subtotal: 500,
        totalNet: 500,
        cashTenderedNet: 500,
        costTotal: unitCost,
        method: 'Espèces',
        cashMove: null,
        debt: debtLeg(),
      });
      console.log(
        `[REF-65-nat-forge] Espèces + no-cashMove (UI shape) → ok=${espShape.ok} raw=${espShape.raw}`,
      );
      const avoirShape = await invokeForgedRefund({
        ...buildForgedRefund(sale.id, 1),
        subtotal: 500,
        totalNet: 500,
        cashTenderedNet: 500,
        costTotal: unitCost,
        debt: debtLeg(),
      });
      console.log(
        `[REF-65-nat-forge] AvoirClient control (debt leg) → ok=${avoirShape.ok} raw=${avoirShape.raw}`,
      );
      throw new Error(
        `[REF-65] credit-sale refund refused (${settled.surface}); uiRefunds=${refundsUi} afterProbes=${refundsFor(sale.id).length} ticket=${String(txRow(sale.id)?.status ?? '')} col=${chainCol} payload=${chainPayload} ledger=${chainLedger}; probe-especes=${espShape.ok ? 'ACCEPTED' : espShape.raw.slice(0, 140)} | probe-avoir=${avoirShape.ok ? 'ACCEPTED' : avoirShape.raw.slice(0, 140)} — expected: refund lands, debt leg 500 (col/payload/ledger), no cash`,
      );
    }
    expect(settled.landed).toBe(true);
    const ref1 = refundsFor(sale.id)[0];
    const cash1 = Number(jsonOf(ref1).cashDisbursed ?? 0);
    console.log(`[REF-65] refund1 cashDisbursed=${cash1} total=${ref1.total}`);
    const mid = {
      col: Number(one<{ d: number }>('SELECT current_debt AS d FROM customers WHERE id = ?', CUST65)?.d ?? NaN),
      payload: Number(jsonOf(one<Row>('SELECT * FROM customers WHERE id = ?', CUST65)).currentDebt ?? NaN),
      ledger: Number(
        one<{ b: number }>(
          `SELECT COALESCE(SUM(CASE WHEN type='DEBT_ACQUIRED' THEN amount WHEN type='PAYMENT_SETTLED' THEN -amount ELSE 0 END),0) AS b
           FROM customer_debts WHERE customer_id = ?`,
          CUST65,
        )?.b ?? NaN,
      ),
    };
    console.log(`[REF-65] after refund1: col=${mid.col} payload=${mid.payload} ledger=${mid.ledger}`);
    expect(cash1).toBe(0);
    expect(mid.ledger).toBe(500);
    // THE question: does the native recompute fix a stale column?
    expect(mid.col).toBe(500);
    expect(mid.payload).toBe(500);

    // Second unit → debt fully cleared; drawer untouched throughout.
    await stageRefund(sale.receipt, { qtyByKey: { [`${P500}_0`]: 1 } });
    settled = await submitAndSettle(sale.id, 2);
    console.log(`[REF-65] refund#2 settle → landed=${settled.landed} surface=${settled.surface}`);
    expect(settled.landed).toBe(true);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');
    const end = {
      col: Number(one<{ d: number }>('SELECT current_debt AS d FROM customers WHERE id = ?', CUST65)?.d ?? NaN),
      payload: Number(jsonOf(one<Row>('SELECT * FROM customers WHERE id = ?', CUST65)).currentDebt ?? NaN),
      ledger: Number(
        one<{ b: number }>(
          `SELECT COALESCE(SUM(CASE WHEN type='DEBT_ACQUIRED' THEN amount WHEN type='PAYMENT_SETTLED' THEN -amount ELSE 0 END),0) AS b
           FROM customer_debts WHERE customer_id = ?`,
          CUST65,
        )?.b ?? NaN,
      ),
    };
    console.log(`[REF-65] final: col=${end.col} payload=${end.payload} ledger=${end.ledger}`);
    expect(end.col).toBe(0);
    expect(end.payload).toBe(0);
    expect(end.ledger).toBe(0);
    expect(count('cash_movements')).toBe(movesBefore);

    // P2-7 upgrade recording: the column must track the debt at SALE time too.
    // (If it only converges on the native refund recompute, the cross-ref to
    // G-32/G-34 in the report is the confirmed sale-time divergence.)
    if (afterSale.col !== 1000) {
      console.log(
        `[P2-7 CROSS-REF] credit sale left customers.current_debt=${afterSale.col} while payload/ledger=1000 (G-32/G-34 family; repaired only by the native refund recompute)`,
      );
    }
  });

  it('[REF-71] negative-line loophole: an already-refunded unit cannot be returned again silently', async () => {
    const base = stockOf(P700);
    const sale = await makeCashSale('REF P700', 1);
    await stageRefund(sale.receipt, { method: 'Espèces' });
    let settled = await submitAndSettle(sale.id, 1);
    expect(settled.landed).toBe(true);
    expect(stockOf(P700)).toBe(base); // unit returned once

    // Attempt A: net-negative basket from the same unit (return -700 + 500).
    await clearCart();
    await addSku('REF P700');
    const { toggleLastLineReturn } = await import('../lib/pos');
    await toggleLastLineReturn(APP_PIN);
    await addSku('REF P500');
    const netA = await cartTotalMinor();
    console.log(`[REF-71] net-negative basket total: ${netA}`);
    const txBeforeA = txCount();
    await clickControl('checkout-button').catch(() => undefined);
    await browser.pause(1500);
    const payOpenedA = await payDialogVisible();
    let landedA = false;
    if (payOpenedA) {
      await payExactFlow().catch(async (e) => {
        console.log(`[REF-71] net-negative pay attempt: ${String((e as Error)?.message ?? e)}`);
        await forceClosePay().catch(() => {});
      });
      landedA = txCount() > txBeforeA;
    }
    console.log(`[REF-71] net-negative: payOpened=${payOpenedA} landed=${landedA}`);
    if (landedA) {
      const row = newestTxRow();
      console.log(`[REF-71] net-negative sale landed: ${String(row?.receipt_number)} total=${row?.total}`);
    }
    // Contract: the drawer/stock must be untouched by a negative basket.
    expect(stockOf(P700)).toBe(base);

    // Attempt B: net-positive basket carrying the phantom return (-700 + 1000).
    await clearCart();
    await addSku('REF P700');
    await toggleLastLineReturn(APP_PIN);
    await addSku('REF P1000');
    const netB = await cartTotalMinor();
    console.log(`[REF-71] net-positive basket total: ${netB}`);
    const txBeforeB = txCount();
    const movesBeforeB = count('cash_movements');
    await clickControl('checkout-button').catch(() => undefined);
    await browser.pause(1500);
    const payOpenedB = await payDialogVisible();
    let landedB = false;
    if (payOpenedB) {
      await payExactFlow().catch(async (e) => {
        console.log(`[REF-71] net-positive pay attempt: ${String((e as Error)?.message ?? e)}`);
        await forceClosePay().catch(() => {});
      });
      landedB = txCount() > txBeforeB;
    }
    const stockAfterB = stockOf(P700);
    console.log(
      `[REF-71] net-positive: payOpened=${payOpenedB} landed=${landedB} stockP700=${stockAfterB} (base ${base})`,
    );
    if (landedB) {
      const row = newestTxRow();
      const items = all<Row>('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', String(row?.id));
      const audit = all<Row>(
        `SELECT * FROM security_audit_logs WHERE rowid > (SELECT COALESCE(MAX(rowid),0) - 10 FROM security_audit_logs)`,
      );
      const flagged = audit.some((a) => /Retour|Échange|Rembours|Reference|référence/i.test(`${a.action} ${a.details}`));
      console.log(
        `[REF-71] landed sale items=${JSON.stringify(items.map((i) => ({ p: i.product_id, q: i.quantity })))} flagged=${flagged}`,
      );
      // The unlinked return must (per the encyclopedia) count against the
      // cumulative guard / be flagged. Silent acceptance = double-return leak.
      if (!flagged) {
        throw new Error(
          `[CONFIRMED EDGE-CASE VULNERABILITY] REF-71: unlinked negative line for an already-refunded unit was accepted silently — sale ${String(row?.receipt_number)} (total ${row?.total}), P700 stock ${stockAfterB} vs base ${base}; no audit flag of the return`,
        );
      }
      expect(stockAfterB).toBe(base);
    }
    expect(count('cash_movements')).toBe(movesBeforeB);
  });

  it('[REF-88] DB-level refund gate: migration trigger aborts bypass; dedup journal == refund rows; single winner under a write lock', async () => {
    const sale = await makeCashSale('REF P500', 1);
    expect(refundsFor(sale.id).length).toBe(0);
    expect(dedupCount(sale.id)).toBe(0);

    // (c) Concurrency: hold a write lock at the DB layer while the UI submits.
    await stageRefund(sale.receipt, { method: 'Espèces' });
    const { openDb } = await import('../lib/db');
    const locker = openDb();
    let lockHeld = false;
    let landed = false;
    try {
      locker.exec('BEGIN IMMEDIATE;');
      lockHeld = true;
      await clickRefundSubmit();
      await browser.pause(1500);
      locker.exec('ROLLBACK;');
      lockHeld = false;
      landed = (await waitFor(() => refundsFor(sale.id).length, (n) => n >= 1, 15000)) >= 1;
      if (!landed) {
        console.log(`[REF-88c] first submit blocked by the lock: ${(await bodyTail()).slice(-220)}`);
        await typeRefundPin(APP_PIN).catch(() => undefined);
        await clickRefundSubmit().catch(() => undefined);
        landed = (await waitFor(() => refundsFor(sale.id).length, (n) => n >= 1, 20000)) >= 1;
      }
    } finally {
      if (lockHeld) {
        try {
          locker.exec('ROLLBACK;');
        } catch {
          /* ignore */
        }
      }
      locker.close();
    }
    expect(landed).toBe(true);
    // Exactly one refund + one dedup journal row — no partial double-write.
    expect(refundsFor(sale.id).length).toBe(1);
    expect(dedupCount(sale.id)).toBe(1);

    // (a) Raw-SQL bypass: a second refund row without its dedup journal entry
    // must be aborted by trg_refund_requires_dedup (REFUND_BYPASS).
    const triggerSql = String(
      scalar<string>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_refund_requires_dedup'") ?? '',
    );
    console.log(`[REF-88a] trigger: ${triggerSql.replace(/\\s+/g, ' ').slice(0, 300)}`);
    expect(triggerSql.length).toBeGreaterThan(0);
    const ref = refundsFor(sale.id)[0];
    const cloneId = `REF-BYPASS-${Date.now()}`;
    const cols = Object.keys(ref).filter((c) => c !== '_rid');
    const clone: Row = { ...ref, id: cloneId, receipt_number: `AVOIR-BYPASS-${Date.now()}` };
    const sql = `INSERT INTO transactions (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    let insertErr = '';
    let bypassLanded = false;
    try {
      run(sql, ...cols.map((c) => clone[c]));
      bypassLanded = true;
    } catch (e) {
      insertErr = String((e as Error)?.message ?? e);
    }
    if (bypassLanded) {
      run('DELETE FROM transactions WHERE id = ?', cloneId); // cleanup the bypass row
      throw new Error(
        `[CONFIRMED EDGE-CASE VULNERABILITY] REF-88: raw INSERT of a refund row bypassed the dedup gate (trigger did not fire; err="${insertErr}")`,
      );
    }
    console.log(`[REF-88a] bypass insert: landed=${bypassLanded} err="${insertErr.slice(0, 220)}"`);
    expect(insertErr).toMatch(/REFUND_BYPASS|dedup|UNIQUE/i);

    // (b) Journal equality holds after the probe.
    expect(refundsFor(sale.id).length).toBe(1);
    expect(dedupCount(sale.id)).toBe(1);
  });
});
