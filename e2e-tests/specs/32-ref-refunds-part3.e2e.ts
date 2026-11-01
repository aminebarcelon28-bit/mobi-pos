/**
 * REF — refunds / returns / avoirs, batch 6 (spec 32; cases REF-15, 32, 33,
 * 39, 49, 54, 57, 61, 62, 63, 64, 66, 79, 86, 91).
 *
 * Harness mirrors batch 4/5 (spec 31): same live-SQLite ground truth,
 * desktop POS under WebdriverIO + Tauri, mobile Kredy walk where required.
 *
 * Decisions under test (from the encyclopedia + app sources, read-only):
 *  - REF-32: the refund quantity control is a stepper (RefundModal.tsx) —
 *    bounded [1..remaining], no editable field ⇒ 0/negative/decimal/Arabic
 *    text-entry facets are not representable; over-remaining must be capped.
 *  - REF-33: bundle child refund oracle = child price − allocated discount
 *    (RB350: 350 − 81 = 269); P0-9 double-discount reproduction.
 *  - REF-39: refund must survive product rename / barcode reassign /
 *    soft-delete (products.deleted) with exact pricing + restock.
 *  - REF-49: trade-in (Reprise) sale refund must split by funding source:
 *    cash back ≤ cash tendered (200), remaining 300 as credit/voucher.
 *  - REF-54: zero-total sale refund must never mint money (no drawer move).
 *  - REF-57: receipt lookup robustness — typo must never offer a wrong
 *    ticket; Arabic digits / spaces / phone / name / amount / IMEI resolve.
 *  - REF-61: one IMEI sold→returned→resold→returned: single imei_record,
 *    availability restored each cycle, both refunds exact.
 *  - REF-62: refund staged but interrupted by reload/language switch must
 *    leave ZERO partial writes; the redo refunds exactly once.
 *  - REF-63: a 40-day-backdated sale must remain findable + refundable.
 *  - REF-64: refund slip/audit carries originalTransactionId, refund receipt,
 *    reason, cashier; a print attempt fires (ESC/POS channel, REF-18 pattern).
 *  - REF-66: refund inside an instalment plan — K1 (after 1 of 3) + K2
 *    (after the last): receivable/wallet conservation + plan must track the
 *    refund; UI credit-sale refund refusal recorded (REF-65/P1-3 class).
 *  - REF-79: return by a non-buyer must not touch either customer's wallet;
 *    no gift-receipt (anonymous) lane exists (codebase evidence).
 *  - REF-86: order-independence — same cart refunded in two different
 *    chunkings/orders must produce identical per-line + total refunds.
 *  - REF-91: serial returner — 4 sale+refund cycles for one customer all
 *    honored with exact money; no fraud engine exists to block silently.
 *
 * Global invariants: afterEach runs assertInvariants() (G-01…G-34 subset)
 * against the live DB — see lib/invariants.ts.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, run, scalar, waitForSchemaSettled } from '../lib/db';
import {
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

import {
  cartLineCount,
  clickRefundControl,
  installPageShims,
  refundListEmpty,
  refundTicketRowCount,
  scanCode,
  seedBundleMirror,
  typeMoneyInto,
} from '../lib/pos';

import { seedBundles } from '../lib/seed';
const P500 = 'REF3-P500';
const P700 = 'REF3-P700';
const P1000 = 'REF3-P1000';
const PSER = 'REF3-PSER';
const IMEI_SER = '356938035643809';
const RB100 = 'REF3-RB100';
const RB200 = 'REF3-RB200';
const RB350 = 'REF3-RB350';
const BUNDLE_BARCODE = '0195949038002';
const BUNDLE_SKUS = [RB100, RB200, RB350];
const CUST = 'REF3-CUST';
const CUST65 = 'REF3-C65';
const CUST_NAME = 'REF3 Cust';
const CUST65_NAME = 'REF3 Kredy';
const C15 = 'REF3-C15';
const C15_NAME = 'REF3 Quinze';
const C49 = 'REF3-C49';
const C49_NAME = 'REF3 Reprise';
const C57 = 'REF3-C57';
const C57_NAME = 'REF3 Chercheur';
const C66A = 'REF3-C66A';
const C66A_NAME = 'REF3 KredyA';
const C66B = 'REF3-C66B';
const C66B_NAME = 'REF3 KredyB';
const C79A = 'REF3-C79A';
const C79A_NAME = 'REF3 Offreur';
const C79B = 'REF3-C79B';
const C79B_NAME = 'REF3 Tiers';
const C91 = 'REF3-C91';
const C91_NAME = 'REF3 Retourneur';

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
  await (await $(tid('checkout-button'))).click();
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
async function stageRefund(
  receipt: string,
  opts: { method?: 'Espèces' | 'Avoir Client'; qtyByKey?: Record<string, number> } = {},
): Promise<void> {
  if (!(await refundDialogVisible())) await openRefund();
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
 *  needle matches is still captured in the returned surface.
 *
 *  `opts.maxMs` widens the window for tickets whose commit is legitimately
 *  heavy (REF-87: ~95 MB payload → the 16 s window expired while the refund
 *  was still in flight). `opts.tag` adds a post-submit probe + progress lines
 *  that distinguish the two disabled-submit causes: `submitForeignLocked`
 *  (title is set, RefundModal.tsx:1169) vs an in-flight `isSubmitting`. */
async function submitAndSettle(
  ticketId: string,
  want: number,
  opts: { maxMs?: number; tag?: string } = {},
): Promise<{ landed: boolean; surface: string }> {
  const maxMs = opts.maxMs ?? 16000;
  const tag = opts.tag ?? '';
  const preToast = await visibleToasts();
  const prePage = await bodyTail();
  await submitRefund();
  if (tag) {
    await browser.pause(150);
    const probe = await browser.execute(() => {
      const b = document.querySelector('[data-testid="refund-submit"]') as HTMLButtonElement | null;
      if (!b) return { submit: null };
      return {
        disabled: b.disabled,
        // Set ONLY by submitForeignLocked (RefundModal.tsx:1168-1169); an
        // empty title on a disabled button means the click is in flight.
        title: b.getAttribute('title') ?? '',
        text: (b.textContent || '').trim().slice(0, 80),
        ariaBusy: b.getAttribute('aria-busy') ?? '',
      };
    });
    console.log(`[submitAndSettle ${tag}] post-submit probe: ${JSON.stringify(probe)}`);
  }
  const t0 = Date.now();
  let lastToast = '';
  let lastRevalidateAt = 0;
  let revalidations = 0;
  let lastProgress = t0;
  // A suspected refusal is re-verified against the DB before it is accepted:
  // run 2 lost REF-35/REF-42 to a race where the parked dialog error from the
  // PREVIOUS attempt poisoned the surface check while the current attempt's
  // commit was still in flight (~0.3-1 s behind). The grace window polls the
  // row for 6 s; a landing during it is success, not a refusal.
  const graceLanded = async (): Promise<boolean> => {
    for (let i = 0; i < 12; i++) {
      if (refundsFor(ticketId).length >= want) return true;
      await browser.pause(500);
    }
    return refundsFor(ticketId).length >= want;
  };
  while (Date.now() - t0 < maxMs) {
    if (refundsFor(ticketId).length >= want) {
      if (tag) console.log(`[submitAndSettle ${tag}] landed at +${Math.round((Date.now() - t0) / 1000)}s`);
      return { landed: true, surface: '' };
    }
    if (tag && Date.now() - lastProgress >= 15000) {
      lastProgress = Date.now();
      console.log(`[submitAndSettle ${tag}] +${Math.round((Date.now() - t0) / 1000)}s rows=${refundsFor(ticketId).length}/${want}`);
    }
    const toast = await visibleToasts();
    if (toast) lastToast = toast;
    // Only text that appeared AFTER submission counts: toasts live ~3 s and
    // run 2 captured a sale toast ("Vente validée...") as a refund refusal.
    const fresh = preToast && toast.includes(preToast) ? toast.split(preToast).join("") : toast;
    // Offline cash cap: the app re-arms the refund as Avoir Client and asks
    // for one more validation. This toast is a prompt, never a refusal.
    if (fresh.includes('basculée en Avoir Client')) {
      // Re-validate on a 1.2 s cadence, up to 4 attempts: the prompt can
      // persist VERBATIM across a re-validation (run 7: REF-86 B chunk 3
      // waited out the whole 16 s window because the unchanged toast text
      // suppressed the second click while the app still held the dialog).
      if (revalidations < 4 && Date.now() - lastRevalidateAt > 1200) {
        lastRevalidateAt = Date.now();
        revalidations++;
        console.log(`[submitAndSettle] cash cap: switched to Avoir Client - revalidating #${revalidations}`);
        await submitRefund();
      }
      await browser.pause(300);
      continue;
    }
    for (const n of REFUSAL_NEEDLES) {
      if (fresh.includes(n)) {
        if (await graceLanded()) return { landed: true, surface: `grace: row landed within 6 s of refusal text "${n}" :: toast="${toast}"` };
        return { landed: false, surface: `${n} :: toast="${toast}"` };
      }
    }
    // Erreur lors du remboursement parks inside the refund dialog and
    // outlives its toast. Only count it when the PRE-SUBMIT page did not
    // already carry it: a parked error from a previous attempt is stale
    // (run 2 read it as this attempt's refusal ~0.3 s before its commit).
    const tail = await bodyTail();
    if (!prePage.includes('Erreur lors du remboursement') && tail.includes('Erreur lors du remboursement')) {
      if (await graceLanded()) return { landed: true, surface: `grace: row landed within 6 s of parked page error :: toast="${lastToast}"` };
      return { landed: false, surface: `Erreur lors du remboursement (page) :: toast="${lastToast}"` };
    }
    await browser.pause(300);
  }
  return {
    landed: false,
    surface: `timeout(${Math.round(maxMs / 1000)}s) :: toast="${lastToast}" :: ${await dumpRefundState(`no-land-${Math.round(maxMs / 1000)}s`)}`,
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
    itemKey: `${forgeId}-itemkey-${idx}`,
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
      id: `forge-delta-${forgeId}-${i}`,
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

describe('REF — refunds, returns & avoirs (batch 6 / part 3)', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    resetData();
    seedProducts([
      { id: P500, title: 'REF3 P500', priceDa: 500, stock: 500, costDa: 300 },
      { id: P700, title: 'REF3 P700', priceDa: 700, stock: 300, costDa: 400 },
      { id: P1000, title: 'REF3 P1000', priceDa: 1000, stock: 300, costDa: 500 },
      { id: PSER, title: 'REF3 PSER', priceDa: 800, stock: 5, costDa: 500, isSerialized: true, imeiNumber: IMEI_SER },
      { id: RB100, title: 'REF3 RB100', priceDa: 100, stock: 500, costDa: 40 },
      { id: RB200, title: 'REF3 RB200', priceDa: 200, stock: 500, costDa: 80 },
      { id: RB350, title: 'REF3 RB350', priceDa: 350, stock: 500, costDa: 140 },
    ]);
    seedBundles([
      { id: 'BND-REF33', title: 'Pack REF33', barcode: BUNDLE_BARCODE, bundlePriceDa: 500, childSkus: BUNDLE_SKUS },
    ]);
    seedImeiRecords([{ imei: IMEI_SER, productId: PSER, status: 'in_stock', warrantyMonths: 12 }]);
    seedCustomerFull([
      { id: CUST, name: CUST_NAME, phone: '0551200002', currentDebtDa: 0, debtLimitDa: 100000, storeCreditDa: 400 },
      { id: CUST65, name: CUST65_NAME, phone: '0551200065', currentDebtDa: 0, debtLimitDa: 500000 },
      {
        id: C15,
        name: C15_NAME,
        phone: '0551200015',
        currentDebtDa: 0,
        debtLimitDa: 100000,
        loyaltyPoints: 500,
        loyaltyPointsColumnDa: 500,
        // A balance must be BACKED by a bucket: a headline of 500 with no bucket
        // is legacy drift the G-07 oracle rightly rejects once the customer is
        // touched (REF-15 conversion refund). Seed one bucket of 500 points.
        pointBuckets: [
          {
            id: 'BUCKET-REF3-C15-SEED',
            customerId: C15,
            initialPoints: 500,
            remainingPoints: 500,
            isFullyConsumed: false,
            creditValueDzd: 5000,
            earnedOnNetSpendDzd: 5000,
            originTransactionId: 'SEED-C15',
            createdAt: '2026-01-01T00:00:00.000Z',
            expiresAt: null,
          },
        ],
      },
      { id: C49, name: C49_NAME, phone: '0551200049', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C57, name: C57_NAME, phone: '0551200057', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C66A, name: C66A_NAME, phone: '0551200066', currentDebtDa: 0, debtLimitDa: 500000 },
      { id: C66B, name: C66B_NAME, phone: '0551200067', currentDebtDa: 0, debtLimitDa: 500000 },
      { id: C79A, name: C79A_NAME, phone: '0551200079', currentDebtDa: 0, debtLimitDa: 100000, storeCreditDa: 400 },
      { id: C79B, name: C79B_NAME, phone: '0551200080', currentDebtDa: 0, debtLimitDa: 100000, storeCreditDa: 250 },
      { id: C91, name: C91_NAME, phone: '0551200091', currentDebtDa: 0, debtLimitDa: 100000 },
    ]);
    await clearWebMirrors();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
    // The pack must resolve from the app's Dexie mirror (spec 11 pattern):
    // seed the mirror after the shift flow created the store, reload once so
    // boot hydrates it, then re-arm the JS context.
    await seedBundleMirror([
      { id: 'BND-REF33', bundleTitle: 'Pack REF33', barcode: BUNDLE_BARCODE, bundlePrice: 500, childSkus: BUNDLE_SKUS },
    ]);
    await browser.refresh();
    await installPageShims();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    captureInvariantBaseline('REF3');
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
    assertInvariants(`REF3 :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('REF batch3 (spec 32)');
  });

  // ===========================================================================
  // Spec 32 — batch 6 local helpers (REF-15, 32, 33, 39, 49, 54, 57, 61, 62,
  // 63, 64, 66, 79, 86, 91)
  // ===========================================================================

  /** Poll a boolean condition without throwing. */
  async function pollUntil(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<boolean> {
    try {
      await browser.waitUntil(cond, { timeout: ms, interval: 300, timeoutMsg: what });
      return true;
    } catch {
      return false;
    }
  }

  /** Full page reload with a query string (language / shell switch). */
  async function reloadWithQ(query: string): Promise<boolean> {
    const ok = (await browser.execute((q: string) => {
      const base = window.location.href.split('?')[0];
      window.location.href = q ? `${base}${q}` : base;
      return true;
    }, query)) as boolean;
    await browser.pause(2500);
    await pollUntil(async () => (await browser.execute(() => document.readyState)) === 'complete', 60000, 'reload never completed');
    await installErrorTrap().catch(() => {});
    await unlockIfNeeded().catch((e) => console.log(`[reloadWithQ] unlock: ${String((e as Error)?.message ?? e)}`));
    return ok;
  }

  /** Return from the mobile demo shell to the desktop POS shell. */
  async function backToDesktop(): Promise<boolean> {
    for (const q of ['?lang=fr', '']) {
      await reloadWithQ(q);
      const desktop = await pollUntil(
        async () => (await $(tid('clients-button')).isDisplayed().catch(() => false)) === true,
        15000,
        `desktop chrome not visible after "${q}"`,
      );
      console.log(`[backToDesktop] after "${q}" desktop=${desktop}`);
      if (desktop) return true;
    }
    return false;
  }

  /** Visible text of the refund dialog (ticket rows; input values excluded). */
  async function refundDialogText(): Promise<string> {
    return (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return '';
      return (dlg as HTMLElement).innerText || dlg.textContent || '';
    })) as string;
  }

  /** Column names of a SQLite table (live DB). */
  function tableColumns(t: string): string[] {
    return all<Row>(`PRAGMA table_info(${t})`).map((r) => String(r.name));
  }

  /** Raw store-credit picture for a customer (column + payload). */
  function creditRaw(custId: string): { col: number | null; payload: number } {
    const row = one<Row>('SELECT store_credit, json_payload FROM customers WHERE id = ?', custId);
    const col = row?.store_credit === null || row?.store_credit === undefined ? null : Number(row.store_credit);
    let payload = NaN;
    try {
      payload = Number((JSON.parse(String(row?.json_payload ?? '{}')) as Row).storeCredit ?? NaN);
    } catch { /* NaN */ }
    return { col, payload };
  }
  /** Effective credit as the app maps it (customerAdapter.ts:246 — column wins). */
  function effCredit(custId: string): number {
    const r = creditRaw(custId);
    return r.col !== null ? r.col : r.payload;
  }
  /** Σ initial_amount of live vouchers (credit_vouchers is customer-name/phone keyed). */
  function voucherTotal(): number {
    try {
      return Number(one<{ s: number }>('SELECT COALESCE(SUM(initial_amount),0) AS s FROM credit_vouchers WHERE deleted = 0')?.s ?? 0);
    } catch {
      return 0;
    }
  }

  /** The three-lane debt picture (column / payload / ledger) — REF-65 pattern. */
  function chainOf(custId: string): { col: number; payload: number; ledger: number } {
    const col = Number(one<{ d: number }>('SELECT current_debt AS d FROM customers WHERE id = ?', custId)?.d ?? NaN);
    const payload = Number(jsonOf(one<Row>('SELECT * FROM customers WHERE id = ?', custId)).currentDebt ?? NaN);
    const ledger = Number(
      one<{ b: number }>(
        `SELECT COALESCE(SUM(CASE WHEN type='DEBT_ACQUIRED' THEN amount WHEN type='PAYMENT_SETTLED' THEN -amount ELSE 0 END),0) AS b
         FROM customer_debts WHERE customer_id = ?`,
        custId,
      )?.b ?? NaN,
    );
    return { col, payload, ledger };
  }
  function debtRowsOf(custId: string): Row[] {
    return all<Row>('SELECT type, amount, balance_after, receipt_number, notes, created_at, deleted FROM customer_debts WHERE customer_id = ? ORDER BY rowid', custId);
  }

  function planOf(custId: string): Row | undefined {
    return one<Row>('SELECT * FROM debt_plans WHERE customer_id = ? AND deleted = 0 ORDER BY rowid DESC LIMIT 1', custId);
  }
  function planEntries(planId: string): Row[] {
    return all<Row>('SELECT * FROM debt_plan_entries WHERE plan_id = ? AND deleted = 0 ORDER BY seq', planId);
  }
  function planRemaining(planId: string): number {
    return planEntries(planId).reduce(
      (s, e) => s + Math.round(Number(e.amount)) - Math.round(Number(e.paid_amount)),
      0,
    );
  }

  /** Wait for a sale row after `before` transaction count; return newest row. */
  async function landedSale(before: number): Promise<Row> {
    const ok = await pollUntil(() => txCount() > before, 30000, `sale did not land (txCount stayed ${before})`);
    if (!ok) throw new Error(`sale did not land (txCount stayed ${before})`);
    const tx = newestTxRow();
    if (!tx) throw new Error('no newest tx row after sale');
    return tx;
  }

  /** Cash sale attached to a customer (for phone/name/credit lookups). */
  async function makeCashSaleTo(title: string, qty: number, customerName: string): Promise<{ id: string; receipt: string; total: number }> {
    await selectCustomer(customerName);
    await addSku(title, { times: qty });
    const before = txCount();
    await payExactFlow();
    const tx = await landedSale(before);
    return { id: String(tx.id), receipt: String(tx.receipt_number), total: Number(tx.total) };
  }

  /** Open refund, filter, click the ticket row. */
  async function beginRefund(receipt: string, timeout = 9000): Promise<boolean> {
    await openRefund();
    await refundSearch(receipt);
    const sel = await selectRefundTicket(receipt, timeout);
    console.log(`[beginRefund] select("${receipt}") → ${sel}`);
    return sel === 'clicked';
  }

  function refundRowOf(ticketId: string): Row | undefined {
    return refundsFor(ticketId)[0];
  }
  /** Cash actually disbursed by a refund row: the json field when the app
   *  wrote one (UI refunds carry `cashDisbursed`), else the drawer movement
   *  the refund created (id derivation mirrors createOrderSlice.ts:2743 —
   *  `MOV-REF-` + the refund id minus its `REF-` prefix), else 0. Never
   *  `ref.total`: that faked a 500 DA disbursement for forged refunds in
   *  run 1 and masked the K1/K2 conservation checks. */
  function cashOf(ref: Row | undefined): number {
    if (!ref) return NaN;
    const j = jsonOf(ref) as Row;
    const direct = j?.cashDisbursed ?? j?.cashOut;
    if (direct !== undefined && direct !== null) return Number(direct);
    const id = String(ref.id ?? '');
    for (const cand of [`MOV-REF-${id}`, `MOV-REF-${id.replace(/^REF-/, '')}`]) {
      const mov = one<Row>('SELECT amount, substr(reason, 1, 200) AS reason FROM cash_movements WHERE id = ?', cand);
      if (mov) {
        const parsed = Number(String(mov.reason ?? '').match(/especes=(-?\d+)/)?.[1] ?? NaN);
        const out = Number.isFinite(parsed) ? parsed : Number(mov.amount ?? 0);
        console.log(`[cashOf] ${id}: no json cash field → ${cand} amount=${String(mov.amount)} especes=${String(parsed)} → cash=${out}`);
        return out;
      }
    }
    console.log(`[cashOf] ${id}: no json cash field and no MOV-REF row → cash=0 (json keys: ${Object.keys(j ?? {}).join(',')})`);
    return 0;
  }

  function typoReceipt(receipt: string): string {
    for (let i = receipt.length - 1; i >= 1; i--) {
      const a = receipt[i];
      const b = receipt[i - 1];
      if (/\d/.test(a) && /\d/.test(b) && a !== b) {
        return receipt.slice(0, i - 1) + a + b + receipt.slice(i + 1);
      }
    }
    return receipt + '9';
  }
  function arabicDigits(s: string): string {
    const map = '٠١٢٣٤٥٦٧٨٩';
    return s.replace(/[0-9]/g, (d) => map[Number(d)]);
  }
  function spacedReceipt(s: string): string {
    return s.replace(/-/g, ' ');
  }

  // ------------------------------ CRM (REF-15) ------------------------------

  async function openCustomersDialog(): Promise<boolean> {
    await (await $(tid('clients-button'))).click();
    const ok = await pollUntil(async () => (await $(tid('customers-dialog')).isDisplayed().catch(() => false)) === true, 20000, 'customers dialog did not open');
    await browser.pause(500);
    return ok;
  }

  async function customersSearchSet(text: string): Promise<boolean> {
    return (await browser.execute((t: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[data-testid="customers-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return false;
      const inputs = ([...dlg.querySelectorAll('input')] as HTMLInputElement[]).filter(vis);
      const el = inputs.find((i) => /recherch|chercher|search|بحث/i.test(i.placeholder || '')) ?? inputs[0];
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, t);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, text)) as boolean;
  }

  async function clickCustomerName(name: string): Promise<boolean> {
    return (await browser.execute((n: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[data-testid="customers-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return false;
      const els = ([...dlg.querySelectorAll('*')] as HTMLElement[]).filter(
        (el) => vis(el) && (el.textContent || '').trim() === n && el.tagName !== 'BUTTON' && !el.closest('button'),
      );
      const target = els[0];
      if (!target) return false;
      target.click();
      return true;
    }, name)) as boolean;
  }

  /** Open the customers profile view for a named customer. */
  async function openCustomerProfile(name: string): Promise<boolean> {
    if (!(await openCustomersDialog())) return false;
    await customersSearchSet(name);
    await browser.pause(700);
    const clicked = await clickCustomerName(name);
    console.log(`[openCustomerProfile] nameClick=${clicked}`);
    const profiled = await pollUntil(() => hasText('Retour à la Liste'), 10000, 'profile view did not open');
    return profiled;
  }

  /** Loyalty tab → Convertir Points → redeem `points` (10 DA/pt oracle). */
  async function redeemLoyaltyFlow(points: string): Promise<boolean> {
    const tab = await pollUntil(async () => (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const t = ([...document.querySelectorAll('[role="tab"]')] as HTMLElement[]).find((x) => vis(x) && /Fidélité/i.test(x.textContent || ''));
      if (!t) return false;
      t.click();
      return true;
    })) as boolean, 10000, 'loyalty tab not found');
    await browser.pause(600);
    if (!tab) return false;
    const btn = await pollUntil(async () => (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) => vis(x) && /Convertir Points/i.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean, 10000, 'Convertir Points button not found');
    await browser.pause(900);
    if (!btn) return false;
    const set = await pollUntil(async () => (await browser.execute((p: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const m = ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).find((x) => vis(x) && /Convertir des Points en Avoir/i.test(x.getAttribute('aria-label') || ''));
      if (!m) return false;
      const inp = ([...m.querySelectorAll('input')] as HTMLInputElement[]).find(vis);
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(inp, '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(inp, p);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return inp.value === p;
    }, points)) as boolean, 10000, 'redeem dialog/input not ready');
    await browser.pause(500);
    if (!set) return false;
    const submitted = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const m = ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).find((x) => vis(x) && /Convertir des Points en Avoir/i.test(x.getAttribute('aria-label') || ''));
      if (!m) return false;
      const b = ([...m.querySelectorAll('button')] as HTMLButtonElement[]).find((x) => vis(x) && /Convertir/i.test(x.textContent || '') && !/Annuler|Fermer/i.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    console.log(`[redeemLoyaltyFlow] submitted=${submitted}`);
    await browser.pause(1200);
    return submitted;
  }

  async function closeCustomersDialog(): Promise<void> {
    await (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[data-testid="customers-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return false;
      const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((x) => /Fermer/i.test(x.getAttribute('aria-label') || ''));
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    const gone = await pollUntil(async () => !(await $(tid('customers-dialog')).isDisplayed().catch(() => false)), 5000, 'customers dialog did not close');
    if (!gone) await closeDialogs(2).catch(() => {});
    await browser.pause(400);
  }

  /** Pay the open pay-dialog with store credit ("Appliquer Tout"). */
  async function payWithStoreCreditAll(): Promise<{ applied: boolean; confirmLabel: string; confirmed: boolean }> {
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const applied = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) => vis(x) && /Appliquer tout/i.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    await browser.pause(600);
    const confirmLabel = String(await (await $(tid('pay-confirm'))).getText().catch(() => ''));
    console.log(`[payWithStoreCreditAll] applied=${applied} confirm="${confirmLabel}"`);
    const confirmed = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll('[data-testid="pay-confirm"]')] as HTMLButtonElement[]).find((x) => vis(x) && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    await browser.waitUntil(async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)), { timeout: 45000, timeoutMsg: 'pay dialog did not close (store-credit payment)' });
    return { applied, confirmLabel, confirmed };
  }

  // Run-2 hardening (REF-49): the trade-in sheet's dismissal can leave a
  // scroller covering the checkout button (run 1: element click intercepted
  // at (194,645) by a `bg-pos-bg` div). Wait until elementFromPoint actually
  // reaches the button before paying.
  async function checkoutHittable(): Promise<{ ok: boolean; blockedBy: string }> {
    return (await browser.execute(() => {
      const btn = document.querySelector('[data-testid="checkout-button"]') as HTMLElement | null;
      if (!btn) return { ok: false, blockedBy: 'no-button' };
      const r = btn.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return { ok: false, blockedBy: 'zero-rect' };
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
      if (!el) return { ok: false, blockedBy: 'null-element' };
      const ok = btn === el || btn.contains(el) || el.contains(btn);
      return { ok, blockedBy: ok ? '' : `${el.tagName}.${String(el.className || '').slice(0, 96)}` };
    })) as { ok: boolean; blockedBy: string };
  }
  async function waitForCheckoutHittable(timeoutMs: number): Promise<boolean> {
    try {
      await browser.waitUntil(async () => (await checkoutHittable()).ok, { timeout: timeoutMs, interval: 300 });
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------- Trade-in (REF-49) ----------------------------

  async function stageTradeIn(imei: string, priceDa: number): Promise<boolean> {
    // Run-5 hardening #2: the success signal is the cart-total delta — staging
    // nets the checkout total by the buyback value immediately (App.tsx:126
    // feeds the staged reprise into the payable total). The chip is only
    // rendered inside the expanded cart header (CartPanel.tsx:944-983), so a
    // collapsed header made run 5 misread a successful staging as failed and
    // abort mid-test (the phantom staged credit then leaked into later sales).
    const totalBefore = await cartTotalMinor().catch(() => null);
    const opened = (await browser.execute(() => {
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      const b = btns.find((x) => /Échanger un appareil|Trade-In/.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (!opened) return false;
    await browser.pause(900);
    const filled = (await browser.execute((imeiV: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const setValue = (el: HTMLInputElement, v: string) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const inputs = ([...document.querySelectorAll('input')] as HTMLInputElement[]).filter(vis);
      const byPh = (frag: string) => inputs.find((i) => (i.placeholder || '').includes(frag));
      const model = byPh('iPhone');
      const imeiEl = byPh('358921');
      const byLabel = (re: RegExp) => {
        const lab = [...document.querySelectorAll('label')].find((l) => re.test(l.textContent || ''));
        const sib = lab?.nextElementSibling as HTMLElement | null;
        return sib && sib.tagName === 'INPUT' ? (sib as HTMLInputElement) : undefined;
      };
      const nameEl = byLabel(/Nom & Pr/);
      if (!model || !imeiEl || !nameEl) return false;
      setValue(model, 'iPhone E2E 14');
      setValue(imeiEl, imeiV);
      setValue(nameEl, 'E2E Vendeur');
      const priceEl = document.querySelector('[data-testid="buyback-price"]') as HTMLInputElement | null;
      return Boolean(priceEl);
    }, imei)) as boolean;
    if (!filled) {
      console.log(`[trade-in] form fields not found :: ${(await bodyTail()).slice(-220)}`);
      return false;
    }
    const priceEl = await $(tid('buyback-price'));
    await typeMoneyInto(priceEl, priceDa);
    await browser.pause(400);
    const submitted = (await browser.execute(() => {
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      const b = btns.find((x) => /Valider l.?Échange/.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (!submitted) {
      console.log(`[trade-in] confirm button not found/disabled :: ${(await bodyTail()).slice(-220)}`);
      return false;
    }
    // Run-5 hardening: the success signal must be the MODAL CLOSING (the
    // exchange path calls closeModal() once staged) plus the cart chip
    // `Reprise : <model>` — the old `hasText('Reprise')` matched the modal's
    // own static copy ("Reprise et trade-in occasion"), so it reported
    // staged=true even when the submit was rejected (e.g. a Luhn-invalid
    // IMEI) and the modal stayed open. That poisoned the sale (full cash
    // paid, refund correctly returned the full cash) and mis-drove REF-49.
    let closed = false;
    try {
      await browser.waitUntil(
        async () =>
          !(await browser.execute(() =>
            Boolean(document.querySelector('[aria-label="Reprise et trade-in occasion"]')),
          )),
        { timeout: 8000, interval: 250 },
      );
      closed = true;
    } catch {
      closed = false;
    }
    // Wait briefly for the staged chip (`Reprise : <model>`) — the React
    // re-render lands a beat after the modal unmounts (probe-run-01: the
    // toast was already up while the chip read still came back empty).
    let chip = '';
    for (let i = 0; i < 12; i++) {
      chip = (await browser.execute(() => {
        const t = document.body.innerText || '';
        const m = t.match(/Reprise\s*:\s*[^\n]{0,60}/);
        return m ? m[0] : '';
      })) as string;
      if (chip) break;
      await browser.pause(250);
    }
    // Primary signal: the cart total dropped by exactly the buyback value. The
    // chip is textually present only when the cart header is expanded
    // (CartPanel.tsx:944-983) — run 5 landed here with a collapsed header and an
    // expired toast (the 3 s chip poll), misread a successful staging as
    // failed and aborted, leaking a phantom staged credit into later cases.
    let totalAfter: bigint | null = null;
    let totalDropped = false;
    if (closed && totalBefore !== null) {
      const target = totalBefore - BigInt(Math.round(priceDa)) * 100n;
      for (let i = 0; i < 12; i++) {
        totalAfter = await cartTotalMinor().catch(() => null);
        if (totalAfter !== null && totalAfter === target) { totalDropped = true; break; }
        await browser.pause(250);
      }
    }
    let staged = closed && totalDropped;
    if (closed && !staged) {
      // Secondary surfaces — accept either so a detection hiccup can never
      // abort a genuinely staged exchange again: the chip (expanded header)
      // or the exchange toast ("… attachée au panier (−300 DA).").
      if (chip.length > 0) staged = true;
      if (!staged) {
        try {
          const toasts = await visibleToasts();
          staged = toasts.some((t) => /attachée au panier/i.test(t));
        } catch { /* not available */ }
      }
    }
    console.log(
      `[trade-in] staged=${staged} (imei ${imei}, price ${priceDa}) modalClosed=${closed} totalBefore=${String(totalBefore)} totalAfter=${String(totalAfter)} chip=${JSON.stringify(chip)}`,
    );
    if (!staged) {
      try { await browser.keys(['Escape']); await browser.pause(300); } catch { /* best effort */ }
    }
    return staged;
  }

  /**
   * Run-5 hardening: a staged reprise must never leak across cases. The staged
   * credit survives every cart clear — the app's own clearCart resets the cart
   * and the credit applications but NOT stagedTradeIn (createCartSlice.ts:392-403),
   * and the line-remove button only drops the line (CartPanel.tsx:1432) — so
   * the next checkout silently nets it against an unrelated sale (run-5 chain:
   * REF-49's aborted staging netted −300 on REF-61's sale, and REF-61's refund
   * minted it back as durable customer credit). The chip's "Retirer" button
   * (CartPanel.tsx:975-987) is the only UI removal; it lives in the expanded
   * cart header ("Afficher les détails", CartPanel.tsx:931-939). Best-effort:
   * a clean pass has no chip and this is a no-op.
   */
  async function purgeStagedTradeIn(): Promise<void> {
    try {
      await browser.execute(() => {
        const expand = ([...document.querySelectorAll('button')] as HTMLButtonElement[])
          .find((x) => (x.getAttribute('aria-label') || '') === 'Afficher les détails');
        if (expand) expand.click();
      });
      await browser.pause(250);
      await browser.execute(() => {
        const r = ([...document.querySelectorAll('button')] as HTMLButtonElement[])
          .find((x) => (x.getAttribute('title') || '') === 'Retirer la reprise');
        if (r) r.click();
      });
      await browser.pause(250);
    } catch { /* best effort — must never throw (afterEach) */ }
  }

  // Every case here runs against a shared terminal: purge leftovers before the
  // next checkout can silently consume them.
  afterEach(async () => {
    await purgeStagedTradeIn();
  });

  // --------------------------- Zero-total (REF-54) --------------------------

  async function commitZeroSale(): Promise<void> {
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const exact = await $(tid('pay-exact'));
    if ((await exact.isExisting().catch(() => false)) && (await exact.isDisplayed().catch(() => false))) {
      await exact.click().catch(() => {});
      await browser.pause(300);
    }
    const confirm = await $(tid('pay-confirm'));
    if ((await confirm.isExisting().catch(() => false)) && (await confirm.isDisplayed().catch(() => false))) {
      await confirm.click().catch(() => {});
    }
    await browser
      .waitUntil(async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)), {
        timeout: 30000,
        timeoutMsg: 'zero-total pay dialog did not close',
      })
      .catch(async (e) => {
        console.log(`[commitZeroSale] dialog stuck :: ${String((e as Error)?.message ?? e)} :: ${(await bodyTail()).slice(-260)}`);
        throw e;
      });
  }

  // ------------------------ Mobile Kredy (REF-66) ---------------------------

  async function mobileEnterDemoAndKredy(): Promise<boolean> {
    const demo = await pollUntil(async () => (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll('button, a')] as HTMLButtonElement[]).find((x) => vis(x) && /Mode Démo/i.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean, 20000, 'demo entry not found');
    if (!demo) console.log('[mobile] demo entry not found — continuing (may already be inside the demo shell)');
    await browser.pause(1800);
    const tab = await pollUntil(async () => (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll('button, [role="tab"], a')] as HTMLElement[]).find((x) => vis(x) && /Kredy|Crédit|تقسيط/i.test((x.textContent || '').trim()));
      if (!b) return false;
      b.click();
      return true;
    })) as boolean, 20000, 'kredy tab not found');
    await browser.pause(1200);
    console.log(`[mobile] demo=${demo} kredyTab=${tab}`);
    return tab;
  }

  async function kredySearch(name: string): Promise<boolean> {
    const ok = (await browser.execute((n: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const inp = ([...document.querySelectorAll('input')] as HTMLInputElement[]).find((i) => vis(i) && /chercher|recherche|search|بحث/i.test(i.placeholder || ''));
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(inp, n);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, name)) as boolean;
    await browser.pause(900);
    console.log(`[kredySearch] set=${ok} for "${name}"`);
    return ok;
  }

  async function kredyToggle(name: string, mode: 'expand' | 'collapse'): Promise<boolean> {
    const ok = (await browser.execute((n: string, m: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const btns = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).filter((x) => vis(x) && !x.disabled);
      const b = btns.find((x) => {
        const al = x.getAttribute('aria-label') || '';
        if (!al.includes(n)) return false;
        return m === 'expand' ? /Historique/.test(al) && !/Masquer/.test(al) : /Masquer/.test(al);
      });
      if (!b) return false;
      b.click();
      return true;
    }, name, mode)) as boolean;
    await browser.pause(1000);
    console.log(`[kredyToggle] ${mode} ${name} → ${ok}`);
    return ok;
  }

  async function kredyCreatePlan(amountDigits: string): Promise<{ moneySet: boolean; created: boolean }> {
    await pollUntil(() => hasText('Plan de paiement'), 10000, 'plan form did not render');
    const moneySet = (await browser.execute((d: string) => {
      const vis = (el: HTMLElement) => { try { const cs = getComputedStyle(el); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const spans = ([...document.querySelectorAll('span, p, div, label')] as HTMLElement[])
        .filter((s) => vis(s) && /Plan de paiement/i.test((s.textContent || '').trim()) && (s.textContent || '').length < 120);
      const span = spans[0];
      if (!span) return false;
      let scope: Element | null = span;
      for (let up = 0; up < 7 && scope; up++) {
        const inp = ([...scope.querySelectorAll('input')] as HTMLInputElement[]).find((i) => vis(i) && i.type !== 'checkbox' && i.type !== 'radio' && !i.readOnly);
        if (inp) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          setter?.call(inp, '');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          setter?.call(inp, d);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        scope = scope.parentElement;
      }
      return false;
    }, amountDigits)) as boolean;
    await browser.pause(600);
    const created = moneySet && ((await browser.execute(() => {
      const vis = (el: HTMLElement) => { try { const cs = getComputedStyle(el); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) => vis(x) && /Créer le plan/i.test(x.textContent || '') && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })) as boolean);
    await browser.pause(1500);
    console.log(`[kredyCreatePlan] money=${moneySet} created=${created}`);
    return { moneySet, created };
  }

  async function kredyOpenSettlement(name: string): Promise<boolean> {
    const opened = (await browser.execute((n: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const btns = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).filter((x) => vis(x) && !x.disabled);
      const b = btns.find((x) => {
        const al = x.getAttribute('aria-label') || '';
        return al.startsWith('Régler —') && al.includes(n);
      });
      if (!b) return false;
      b.click();
      return true;
    }, name)) as boolean;
    await browser.pause(900);
    console.log(`[kredySettle] open ${name} → ${opened}`);
    return opened;
  }

  async function kredySettlementState(): Promise<{ open: boolean; label: string }> {
    return (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const m = ([...document.querySelectorAll('[aria-labelledby="kredy-settlement-title"]')] as HTMLElement[]).find(vis);
      if (!m) return { open: false, label: '' };
      const submit = ([...m.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => vis(b) && /Solder la dette|Valider le versement|Régler/i.test(b.textContent || ''));
      return { open: true, label: (submit?.textContent || '').trim() };
    })) as { open: boolean; label: string };
  }

  async function kredySetSettlementAmount(digits: string): Promise<boolean> {
    const ok = (await browser.execute((d: string) => {
      const el = document.getElementById('kredy-payment-amount') as HTMLInputElement | null;
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(el, d);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, digits)) as boolean;
    await browser.pause(450);
    return ok;
  }

  async function kredySubmitSettlement(): Promise<boolean> {
    const ok = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const m = ([...document.querySelectorAll('[aria-labelledby="kredy-settlement-title"]')] as HTMLElement[]).find(vis);
      if (!m) return false;
      const submit = ([...m.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => vis(b) && /Solder la dette|Valider le versement/i.test(b.textContent || '') && !b.disabled);
      if (!submit) return false;
      submit.click();
      return true;
    })) as boolean;
    await browser.pause(1400);
    console.log(`[kredySettle] submit → ${ok}`);
    return ok;
  }

  /** Check every line whose product differs from targets; set targets. */
  async function refundOnly(targets: Array<{ pid: string; qty: number }>, opts: { uncheckAll?: boolean } = {}): Promise<void> {
    const keys = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      return ([...document.querySelectorAll('[data-testid^="refund-check-"]')] as HTMLElement[])
        .filter(vis)
        .map((el) => (el.getAttribute('data-testid') || '').replace('refund-check-', ''));
    })) as string[];
    const want = new Map<string, number>();
    for (const t of targets) {
      const k = keys.find((x) => x.startsWith(`${t.pid}_`));
      if (!k) throw new Error(`refund line for ${t.pid} not offered (visible keys: ${keys.join(', ')})`);
      want.set(k, t.qty);
    }
    for (const k of keys) {
      const st = await refundLineState(k);
      if (!st) continue;
      const target = want.get(k);
      if (target === undefined) {
        if (opts.uncheckAll !== false && st.checked) await clickRefundControl(`refund-check-${k}`);
      } else {
        await setRefundQty(k, target);
      }
    }
    console.log(`[refundOnly] keys=${keys.join('|')} → wanted=${JSON.stringify(targets)}`);
  }

  // ===========================================================================
  // Tests
  // ===========================================================================

  it('[REF-32] refund quantity stepper: bounded at 1..remaining, no free-text (0/negative/decimal/arabic entry impossible), over-remaining capped, held key', async () => {
    // (a) Sale of 3 units → refund line starts at remaining=3.
    const sale = await makeCashSale('REF3 P500', 3);
    const row = txRow(sale.id);
    expect(Number(row?.total)).toBe(1500);
    const baseStock = stockOf(P500);

    expect(await beginRefund(sale.receipt)).toBe(true);

    // (b) The quantity control is a stepper; there is NO editable qty field —
    //     text facets (0 / negative / decimal on an integer item / Arabic
    //     digits) are not representable. DOM evidence recorded.
    const fields = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return ['(no dialog)'];
      return ([...dlg.querySelectorAll('input, textarea')] as HTMLInputElement[])
        .filter(vis)
        .map((el) => `${el.getAttribute('data-testid') || el.tagName.toLowerCase()}:${el.type || ''}`);
    })) as string[];
    console.log(`[REF-32] refund dialog editable fields: ${JSON.stringify(fields)}`);
    expect(fields.some((f) => /qty/i.test(f) || f.endsWith(':number'))).toBe(false);

    const key = `${P500}_0`;
    await setRefundQty(key, 1);
    const st1 = await refundLineState(key);
    console.log(`[REF-32] qty@1: ${JSON.stringify(st1)}`);
    expect(st1?.checked).toBe(true);
    expect(st1?.qty).toBe(1);

    // (c) Lower bound: a decrement at the minimum must not produce qty 0 while
    //     checked or a negative value — it either refuses (disabled) or
    //     unchecks the line (checkbox semantics).
    const decClicked = await clickRefundControl(`refund-dec-${key}`);
    await browser.pause(250);
    const st2 = await refundLineState(key);
    console.log(`[REF-32] dec@1 clicked=${decClicked} → ${JSON.stringify(st2)}`);
    expect(st2 === null ? false : st2.qty === 1 || st2.checked === false).toBe(true);
    expect(st2 === null ? true : st2.qty >= 1 || st2.checked === false).toBe(true);
    await setRefundQty(key, 1);

    // (d) Upper bound + held key: spam the increment beyond remaining (3).
    let clicks = 0;
    for (let i = 0; i < 10; i++) {
      const ok = await clickRefundControl(`refund-inc-${key}`);
      if (!ok) break;
      clicks++;
      await browser.pause(120);
    }
    const stMax = await refundLineState(key);
    console.log(`[REF-32] inc spam clicks=${clicks} final=${JSON.stringify(stMax)}`);
    expect(stMax?.qty).toBe(3);
    expect(stMax?.incDisabled).toBe(true);

    // (e) Explicit over-remaining target (5 > 3) must be refused by the
    //     control layer (the stepper emits nothing above remaining).
    let overErr = '';
    try {
      await setRefundQty(key, 5);
    } catch (e) {
      overErr = String((e as Error).message);
    }
    console.log(`[REF-32] setRefundQty(5) → throw="${overErr}"`);
    expect(overErr).toContain('refund-inc disabled');

    // (f) Refund 1 of 3 → 500 exact.
    await setRefundQty(key, 1);
    const settled1 = await submitAndSettle(sale.id, 1);
    if (!settled1.landed) console.log(`[REF-32] refund1 refusal surface: ${settled1.surface}`);
    expect(settled1.landed).toBe(true);
    const ref1 = refundRowOf(sale.id);
    expect(Number(ref1?.total)).toBe(500);
    expect(cashOf(ref1)).toBe(500);

    // (g) After an earlier refund, remaining is 2 — over-remaining still capped,
    //     and a 2-unit refund commits exactly 1000.
    expect(await beginRefund(sale.receipt)).toBe(true);
    const stRem = await refundLineState(key);
    console.log(`[REF-32] after refund1 line state: ${JSON.stringify(stRem)}`);
    await setRefundQty(key, 2);
    let clicks2 = 0;
    for (let i = 0; i < 6; i++) {
      const ok = await clickRefundControl(`refund-inc-${key}`);
      if (!ok) break;
      clicks2++;
      await browser.pause(120);
    }
    const stMax2 = await refundLineState(key);
    console.log(`[REF-32] inc spam#2 clicks=${clicks2} final=${JSON.stringify(stMax2)}`);
    expect(stMax2?.qty).toBe(2);
    expect(stMax2?.incDisabled).toBe(true);
    const settled2 = await submitAndSettle(sale.id, 2);
    expect(settled2.landed).toBe(true);
    const totalRefunded = refundsFor(sale.id).reduce((s, r) => s + Number(r.total), 0);
    expect(totalRefunded).toBe(1500);
    expect(String(txRow(sale.id)?.status)).toBe('REFUNDED');
    expect(stockOf(P500)).toBe(baseStock + 3);
  });

  it('[REF-33] refund of one item from a bundle promotion: RB350 must recover 269 (350 − allocated 81), not double-discount', async () => {
    const base100 = stockOf(RB100);
    const base200 = stockOf(RB200);
    const base350 = stockOf(RB350);
    await clearCart();
    const scanned = await scanCode(BUNDLE_BARCODE);
    expect(scanned).toBe(true);
    const cartTotal = await cartTotalMinor();
    expect(cartTotal).toBe(50000n);
    const before = txCount();
    await payExactFlow();
    const tx = await landedSale(before);
    const saleId = String(tx.id);
    const receipt = String(tx.receipt_number);
    expect(Number(tx.total)).toBe(500);
    const items = all<Row>(
      'SELECT product_id, quantity, applied_price, discount, discount_amount, unit_price_charged FROM transaction_items WHERE transaction_id = ? ORDER BY rowid',
      saleId,
    );
    console.log(`[REF-33] sold bundle items: ${JSON.stringify(items)}`);

    expect(await beginRefund(receipt)).toBe(true);
    await refundOnly([{ pid: RB350, qty: 1 }]);
    const shown = await refundTotalMinor();
    console.log(`[REF-33] refund modal total for RB350: ${shown} (oracle 26900)`);
    expect(shown).toBe(26900n);
    const settled = await submitAndSettle(saleId, 1);
    if (!settled.landed) console.log(`[REF-33] refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    const ref = refundRowOf(saleId);
    console.log(`[REF-33] committed refund total=${String(ref?.total)} cash=${String(cashOf(ref))} (oracle 269)`);
    expect(Number(ref?.total)).toBe(269);
    expect(cashOf(ref)).toBe(269);
    expect(stockOf(RB350)).toBe(base350);
    expect(stockOf(RB100)).toBe(base100 - 1);
    expect(stockOf(RB200)).toBe(base200 - 1);
  });

  it('[REF-39] refund after product renamed / barcode reassigned / soft-deleted: still exact + restocked (merged: no schema lane)', async () => {
    const cols = tableColumns('products');
    console.log(`[REF-39] products columns: ${cols.join(',')}`);
    const origTitle = String(one<Row>('SELECT title FROM products WHERE id = ?', P700)?.title ?? '');
    const origBarcode = String(one<Row>('SELECT barcode FROM products WHERE id = ?', P700)?.barcode ?? '');
    try {
      // (a) Renamed AFTER the ticket was priced (catalog rename mid-life;
      //     refund is ticket-based and must survive it).
      const baseA = stockOf(P700);
      const saleA = await makeCashSale('REF3 P700', 1);
      expect(Number(txRow(saleA.id)?.total)).toBe(700);
      run("UPDATE products SET title = 'REF3 P700 Renamed' WHERE id = ?", P700);
      expect(await beginRefund(saleA.receipt)).toBe(true);
      await refundOnly([{ pid: P700, qty: 1 }]);
      const settledA = await submitAndSettle(saleA.id, 1);
      console.log(`[REF-39] renamed-product refund landed=${settledA.landed} surface=${settledA.surface}`);
      expect(settledA.landed).toBe(true);
      expect(Number(refundRowOf(saleA.id)?.total)).toBe(700);
      expect(stockOf(P700)).toBe(baseA);
      run('UPDATE products SET title = ? WHERE id = ?', origTitle, P700);

      // (b) Barcode reassigned after the sale.
      const baseB = stockOf(P700);
      const saleB = await makeCashSale('REF3 P700', 1);
      run("UPDATE products SET barcode = '3999999990019' WHERE id = ?", P700);
      expect(await beginRefund(saleB.receipt)).toBe(true);
      await refundOnly([{ pid: P700, qty: 1 }]);
      const settledB = await submitAndSettle(saleB.id, 1);
      console.log(`[REF-39] barcode-reassigned refund landed=${settledB.landed} surface=${settledB.surface}`);
      expect(settledB.landed).toBe(true);
      expect(Number(refundRowOf(saleB.id)?.total)).toBe(700);
      expect(stockOf(P700)).toBe(baseB);

      // (c) Soft-deleted (products.deleted) after the sale.
      const baseC = stockOf(P700);
      const saleC = await makeCashSale('REF3 P700', 1);
      run('UPDATE products SET deleted = 1 WHERE id = ?', P700);
      const found = await beginRefund(saleC.receipt);
      let landedC = false;
      let surfaceC = '';
      if (found) {
        await refundOnly([{ pid: P700, qty: 1 }]);
        const s = await submitAndSettle(saleC.id, 1);
        landedC = s.landed;
        surfaceC = s.surface;
      }
      console.log(`[REF-39] soft-deleted product: offered=${found} landed=${landedC} surface=${surfaceC}`);
      expect(found).toBe(true);
      expect(landedC).toBe(true);
      expect(Number(refundRowOf(saleC.id)?.total)).toBe(700);
      expect(stockOf(P700)).toBe(baseC);

      // (d) merged: the products table has no merged_into/parent column — the
      //     facet is not representable in this schema (evidence above).
      console.log(`[REF-39] merged facet: ${cols.some((c) => /merged/i.test(c)) ? 'column present' : 'no merged_into/parent column in products schema — not representable'}`);
    } finally {
      run('UPDATE products SET title = ?, barcode = ?, deleted = 0 WHERE id = ?', origTitle, origBarcode, P700);
    }
  });

  it('[REF-49] refund of a trade-in sale: cash back ≤ 200 collected, remaining 300 must return as credit/voucher (value conservation)', async () => {
    await selectCustomer(C49_NAME);
    await addSku('REF3 P500', { times: 1 });
    // Luhn-valid IMEI (the previous value failed the modal's checksum gate —
    // the submit was silently rejected while the harness's modal-text check
    // still reported "staged").
    const staged = await stageTradeIn('358921000000047', 300);
    expect(staged).toBe(true);
    // Run-2 hardening: the trade-in sheet's dismissal scroller covered the
    // checkout button in run 1 (element click intercepted at (194,645)).
    // Wait until elementFromPoint can actually reach the button before paying.
    let hit = await checkoutHittable();
    if (!hit.ok) {
      await waitForCheckoutHittable(10000);
      hit = await checkoutHittable();
    }
    if (!hit.ok) {
      console.log(`[REF-49] checkout blocked by ${hit.blockedBy} — Escape to dismiss the sheet`);
      await browser.keys(['Escape']);
      await browser.pause(400);
      await waitForCheckoutHittable(8000);
      hit = await checkoutHittable();
    }
    console.log(`[REF-49] checkout hittable=${hit.ok} blockedBy=${hit.blockedBy || '(none)'}`);
    expect(hit.ok).toBe(true);
    const before = txCount();
    await payExactFlow();
    const tx = await landedSale(before);
    const sale = { id: String(tx.id), receipt: String(tx.receipt_number) };
    const saleJson = jsonOf(tx);
    const saleTenders = (saleJson.tenders ?? []) as Array<{ amount?: number }>;
    const tendersSum = saleTenders.reduce((s, l) => s + Math.max(0, Number(l.amount) || 0), 0);
    const tradeInDeduction = Number(saleJson.tradeInDeduction ?? 0);
    // Genuine exchange shapes (probe-run-01 evidence): subtotal 500 → the
    // customer gives 200 Espèces + 300 Reprise; the row's `total` is net of
    // the credit (200) — the G-01/G-03 hooks flag that document model (P1-5);
    // this case checks the REFUND returns all 500 of value.
    expect(Number(tx.subtotal)).toBe(500);
    expect(tendersSum).toBe(500);
    expect(tradeInDeduction).toBe(300);
    expect(Number(tx.cash_tendered)).toBe(200);
    console.log(`[REF-49] trade-in sale total=${String(tx.total)} subtotal=${String(tx.subtotal)} cash_tendered=${String(tx.cash_tendered)} tenders=${JSON.stringify(saleTenders)} tradeInDeduction=${tradeInDeduction}`);

    const creditBefore = effCredit(C49);
    const vouchersBefore = voucherTotal();
    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-49] refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    const ref = refundRowOf(sale.id);
    const refJson = ref ? jsonOf(ref) : {};
    const cash = cashOf(ref);
    const tradeRestoreDeclared = Math.max(0, Number(refJson.tradeInRestored ?? 0));
    const creditDelta = effCredit(C49) - creditBefore;
    const voucherDelta = voucherTotal() - vouchersBefore;
    const valueBack = cash + Math.max(0, creditDelta) + Math.max(0, voucherDelta);
    const outboxCredit = (() => {
      try {
        const r = one<Row>(
          "SELECT payload_json FROM sync_outbox WHERE entity_type = 'customer' AND entity_id = ? ORDER BY rowid DESC LIMIT 1",
          C49,
        );
        return r ? Number((JSON.parse(String(r.payload_json)) as Row).storeCredit ?? NaN) : NaN;
      } catch { return NaN; }
    })();
    console.log(
      `[REF-49] refund total=${String(ref?.total)} cash=${cash} tradeRestoreDeclared=${tradeRestoreDeclared} creditΔ=${creditDelta} voucherΔ=${voucherDelta} valueBack=${valueBack} outboxStoreCredit=${outboxCredit}`,
    );
    // Cash never exceeds what the customer actually handed over in cash…
    expect(cash).toBeLessThanOrEqual(200);
    // …and ALL 500 of value must come back through durable lanes: the 200
    // cash leg plus the 300 reprise share as credit/voucher. The app declares
    // the restore ("reprise 300 DA restaurée en avoir" — audit), but the
    // durable customer row must actually move for the credit to be spendable
    // (probe-run-01: declared 300, durable Δ 0).
    expect(valueBack).toBe(500);
  });

  it('[REF-54] refund of a zero-total (100% discounted) sale: never mints money; explicit outcome only', async () => {
    await clearCart();
    await addSku('REF3 P500', { times: 1 });
    await applyCartDiscountPercent('100', { pin: APP_PIN });
    const cart = await cartTotalMinor();
    console.log(`[REF-54] cart total after 100% discount: ${cart}`);
    expect(cart).toBe(0n);
    const before = txCount();
    await commitZeroSale();
    const tx = await landedSale(before);
    const sale = { id: String(tx.id), receipt: String(tx.receipt_number) };
    console.log(`[REF-54] zero sale: id=${sale.id} total=${String(tx.total)} discount_total=${String(tx.discount_total)}`);
    expect(Number(tx.total)).toBe(0);

    const movesBefore = count('cash_movements');
    const baseStock = stockOf(P500);
    const outcome = await (async () => {
      const sel = await (async () => {
        await openRefund();
        await refundSearch(sale.receipt);
        const s = await selectRefundTicket(sale.receipt, 5000);
        console.log(`[REF-54] select → ${s}`);
        return s;
      })();
      if (sel !== 'clicked') return { sel, landed: false, surface: '(not offered)', total: NaN as number, cash: NaN as number };
      await refundOnly([{ pid: P500, qty: 1 }]);
      const shown = await refundTotalMinor();
      const settled = await submitAndSettle(sale.id, 1);
      console.log(`[REF-54] refund preview=${shown} landed=${settled.landed} surface=${settled.surface}`);
      const ref = settled.landed ? refundRowOf(sale.id) : undefined;
      return {
        sel,
        landed: settled.landed,
        surface: settled.surface,
        total: ref ? Number(ref.total) : NaN,
        cash: settled.landed ? cashOf(ref) : NaN,
      };
    })();
    console.log(`[REF-54] outcome: ${JSON.stringify(outcome)}`);
    expect(count('cash_movements')).toBe(movesBefore);
    if (outcome.landed) {
      expect(outcome.total).toBe(0);
      expect(outcome.cash).toBe(0);
    } else {
      expect(refundsFor(sale.id).length).toBe(0);
      // refusal must be explicit (not a silent hang): either not offered or a
      // refusal surface was observed by submitAndSettle
      expect(outcome.sel === 'clicked' ? outcome.surface.length > 0 : true).toBe(true);
      console.log(`[REF-54] zero-total refund not committed (clean): sel=${outcome.sel} surface=${outcome.surface}`);
    }
    expect(stockOf(P500)).toBe(outcome.landed ? baseStock + 1 : baseStock);
  });

  it('[REF-61] one IMEI sold → returned → resold → returned again: single imei_record, availability restored, both refunds exact', async () => {
    const baseStock = stockOf(PSER);
    const imeiRow = () => one<Row>('SELECT * FROM imei_records WHERE imei = ?', IMEI_SER);
    const imeiCount = () => count('imei_records', 'imei = ?', IMEI_SER);
    // Soldness = the sale link. CartPanel offers IMEIs when
    // `!saleTransactionId && !soldAt` (CartPanel.tsx:1455-1456); `status` is
    // only the physical state ('in_stock' | 'defective', types/pos.ts:1671).
    const available = (r: Row | undefined) => Boolean(r) && !r.sale_transaction_id && !r.sold_at;

    expect(imeiCount()).toBe(1);
    const before1 = imeiRow();
    console.log(`[REF-61] start: status=${String(before1?.status)} sale=${String(before1?.sale_transaction_id)} sold_at=${String(before1?.sold_at)}`);
    expect(available(before1)).toBe(true);

    // Cycle 1: sell, refund.
    const sale1 = await makeCashSale('REF3 PSER', 1);
    // Leak guard: a phantom staged reprise would net this 800 DA sale down to
    // 500 (run 5: REF-49's aborted staging did exactly that, and the refund
    // then minted the difference back as durable customer credit). Read the
    // durable row — SaleInfo carries {id, receipt} only.
    expect(Number(one<Row>('SELECT total FROM transactions WHERE id = ?', sale1.id)?.total)).toBe(800);
    const item1 = one<Row>('SELECT imei_number FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', sale1.id);
    expect(String(item1?.imei_number)).toBe(IMEI_SER);
    const afterSale1 = imeiRow();
    console.log(`[REF-61] after sale1: status=${String(afterSale1?.status)} sale=${String(afterSale1?.sale_transaction_id)}`);
    expect(available(afterSale1)).toBe(false);
    expect(String(afterSale1?.sale_transaction_id)).toBe(sale1.id);
    expect(imeiCount()).toBe(1);

    expect(await beginRefund(sale1.receipt)).toBe(true);
    await refundOnly([{ pid: PSER, qty: 1 }]);
    const settled1 = await submitAndSettle(sale1.id, 1);
    if (!settled1.landed) console.log(`[REF-61] refund1 refusal surface: ${settled1.surface}`);
    expect(settled1.landed).toBe(true);
    expect(Number(refundRowOf(sale1.id)?.total)).toBe(800);
    const afterRefund1 = imeiRow();
    console.log(`[REF-61] after refund1: status=${String(afterRefund1?.status)} sale=${String(afterRefund1?.sale_transaction_id)} sold_at=${String(afterRefund1?.sold_at)}`);
    expect(available(afterRefund1)).toBe(true);
    expect(String(afterRefund1?.status)).toBe('in_stock');
    expect(imeiCount()).toBe(1);
    expect(stockOf(PSER)).toBe(baseStock);

    // Cycle 2: resell the same unit, refund again.
    const sale2 = await makeCashSale('REF3 PSER', 1);
    expect(Number(one<Row>('SELECT total FROM transactions WHERE id = ?', sale2.id)?.total)).toBe(800);
    const item2 = one<Row>('SELECT imei_number FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', sale2.id);
    expect(String(item2?.imei_number)).toBe(IMEI_SER);
    const afterSale2 = imeiRow();
    console.log(`[REF-61] after sale2: status=${String(afterSale2?.status)} sale=${String(afterSale2?.sale_transaction_id)}`);
    expect(available(afterSale2)).toBe(false);
    expect(String(afterSale2?.sale_transaction_id)).toBe(sale2.id);
    expect(imeiCount()).toBe(1);

    expect(await beginRefund(sale2.receipt)).toBe(true);
    await refundOnly([{ pid: PSER, qty: 1 }]);
    const settled2 = await submitAndSettle(sale2.id, 1);
    if (!settled2.landed) console.log(`[REF-61] refund2 refusal surface: ${settled2.surface}`);
    expect(settled2.landed).toBe(true);
    expect(Number(refundRowOf(sale2.id)?.total)).toBe(800);
    const afterRefund2 = imeiRow();
    console.log(`[REF-61] after refund2: status=${String(afterRefund2?.status)} sale=${String(afterRefund2?.sale_transaction_id)} sold_at=${String(afterRefund2?.sold_at)}`);
    expect(available(afterRefund2)).toBe(true);
    expect(String(afterRefund2?.status)).toBe('in_stock');
    expect(imeiCount()).toBe(1);
    expect(stockOf(PSER)).toBe(baseStock);
  });

  it('[REF-57] finding the sale to refund: exact receipt resolves; typo never offers a wrong ticket; spaces/arabic/phone/name/amount/IMEI resolve; garbage finds nothing', async () => {
    const p500Sale = await makeCashSaleTo('REF3 P500', 1, C57_NAME);
    const pserSale = await makeCashSaleTo('REF3 PSER', 1, C57_NAME);
    expect(p500Sale.total).toBe(500);
    expect(pserSale.total).toBe(800);

    const facets: Array<{ name: string; ok: boolean; detail: string }> = [];
    const facet = (name: string, ok: boolean, detail: string): boolean => {
      facets.push({ name, ok, detail });
      console.log(`[REF-57] facet ${name}: ${ok ? 'OK' : 'MISS'} — ${detail}`);
      return ok;
    };
    const seesReceipt = async (receipt: string) => (await refundDialogText()).includes(receipt);
    const rows = async () => refundTicketRowCount();

    await openRefund();

    // (1) exact receipt resolves.
    await refundSearch(p500Sale.receipt);
    facet('exact', (await rows()) >= 1 && (await seesReceipt(p500Sale.receipt)), `rows=${await rows()} receiptVisible=${await seesReceipt(p500Sale.receipt)}`);

    // (2) typo/transposed digits: must NOT offer our ticket, never a wrong one.
    const typo = typoReceipt(p500Sale.receipt);
    console.log(`[REF-57] typo="${typo}"`);
    await refundSearch(typo);
    const typoSel = await selectRefundTicket(typo, 3000).catch(() => 'error');
    console.log(`[REF-57] typo select → ${typoSel}`);
    facet('typo', typoSel !== 'clicked' && typoSel !== 'error' && !(await seesReceipt(p500Sale.receipt)), `select=${typoSel} rows=${await rows()}`);
    // unconditional reset — a misfired typo click must never leak into the
    // following facets.
    await closeRefund().catch(() => {});
    await openRefund();

    // (3) spaces instead of dashes.
    await refundSearch(spacedReceipt(p500Sale.receipt));
    facet('spaces', await seesReceipt(p500Sale.receipt), `rows=${await rows()}`);

    // (4) Arabic-Indic digits.
    await refundSearch(arabicDigits(p500Sale.receipt));
    facet('arabic', await seesReceipt(p500Sale.receipt), `rows=${await rows()}`);

    // (5) QR/garbage from another shop: nothing, and never our ticket.
    await refundSearch('QR-AUTRE-BOUTIQUE-9991');
    facet('garbage', (await rows()) === 0 && !(await seesReceipt(p500Sale.receipt)), `rows=${await rows()}`);

    // (6) IMEI finds the serialized ticket.
    await refundSearch(IMEI_SER);
    facet('imei', await seesReceipt(pserSale.receipt), `rows=${await rows()}`);

    // (7) phone finds the customer's tickets.
    await refundSearch('0551200057');
    facet('phone', await seesReceipt(p500Sale.receipt), `rows=${await rows()}`);

    // (8) name finds the customer's tickets.
    await refundSearch(C57_NAME);
    facet('name', await seesReceipt(p500Sale.receipt), `rows=${await rows()}`);

    // (9) amount finds the 500 ticket.
    await refundSearch('500');
    facet('amount', await seesReceipt(p500Sale.receipt), `rows=${await rows()}`);

    // Close the loop: refund the found ticket fully — exact money, cash lane.
    await refundSearch(p500Sale.receipt);
    const sel = await selectRefundTicket(p500Sale.receipt, 5000);
    console.log(`[REF-57] final select → ${sel}`);
    expect(sel).toBe('clicked');
    await refundOnly([{ pid: P500, qty: 1 }]);
    const done = await submitAndSettle(p500Sale.id, 1);
    if (!done.landed) console.log(`[REF-57] refund refusal surface: ${done.surface}`);
    expect(done.landed).toBe(true);
    expect(Number(refundRowOf(p500Sale.id)?.total)).toBe(500);
    expect(cashOf(refundRowOf(p500Sale.id))).toBe(500);

    // Every lane the case demands, in ONE throw (complete evidence; the
    // refund above still runs first so the case closes its loop).
    const failed = facets.filter((f) => !f.ok);
    if (failed.length > 0) {
      throw new Error(
        `[REF-57] ${failed.length}/${facets.length} lookup facet(s) failed: ${failed.map((f) => `${f.name} [${f.detail}]`).join(' ; ')}`,
      );
    }
  });

  it('[REF-62] refund interrupted (language switch/reload while staged): zero partial writes; redo refunds exactly once', async () => {
    const sale = await makeCashSale('REF3 P1000', 1);
    const auditBefore = count('security_audit_logs');
    const movesBefore = count('cash_movements');
    const txBefore = txCount();
    const baseStock = stockOf(P1000);

    // Stage the refund fully (quantity + confirm armed) — then interrupt.
    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P1000, qty: 1 }]);
    const shown = await refundTotalMinor();
    console.log(`[REF-62] staged refund total before interrupt: ${shown}`);
    expect(shown).toBe(100000n);
    await reloadWithQ('?lang=ar');
    console.log(
      `[REF-62] after ?lang=ar: refunds=${refundsFor(sale.id).length} dedup=${count('refund_dedup', 'ticket_id = ?', sale.id)} tx=${txCount()} moves=${count('cash_movements')} audits=${count('security_audit_logs')} stock=${stockOf(P1000)}`,
    );
    expect(refundsFor(sale.id).length).toBe(0);
    expect(count('refund_dedup', 'ticket_id = ?', sale.id)).toBe(0);
    expect(txCount()).toBe(txBefore);
    expect(count('cash_movements')).toBe(movesBefore);
    expect(count('security_audit_logs')).toBe(auditBefore);
    expect(stockOf(P1000)).toBe(baseStock);

    await reloadWithQ('?lang=fr');
    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P1000, qty: 1 }]);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-62] redo refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    expect(refundsFor(sale.id).length).toBe(1);
    expect(Number(refundRowOf(sale.id)?.total)).toBe(1000);
    expect(cashOf(refundRowOf(sale.id))).toBe(1000);
    expect(stockOf(P1000)).toBe(baseStock + 1);
  });

  it('[REF-63] a 40-day-backdated sale stays findable and refundable; soft-deleted (archive lane) outcome recorded', async () => {
    const sale = await makeCashSale('REF3 P500', 1);
    const iso40 = new Date(Date.now() - 40 * 86400000).toISOString();
    run("UPDATE transactions SET created_at = datetime('now','-40 days'), updated_at = datetime('now','-40 days') WHERE id = ?", sale.id);
    const j = jsonOf(txRow(sale.id));
    j.createdAt = iso40;
    j.created_at = iso40;
    run('UPDATE transactions SET json_payload = ? WHERE id = ?', JSON.stringify(j), sale.id);
    const backdated = txRow(sale.id);
    console.log(`[REF-63] backdated sale created_at=${String(backdated?.created_at)}`);

    const baseStock = stockOf(P500);
    const found = await beginRefund(sale.receipt);
    console.log(`[REF-63] old ticket offered=${found}`);
    expect(found).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-63] refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    expect(Number(refundRowOf(sale.id)?.total)).toBe(500);
    expect(stockOf(P500)).toBe(baseStock + 1);

    // Archive lane: transactions.deleted exists (soft-delete). Record what the
    // refund lookup does for an archived ticket; the safety law enforced is
    // that it never offers a DIFFERENT (wrong) ticket.
    const sale2 = await makeCashSale('REF3 P500', 1);
    run('UPDATE transactions SET deleted = 1 WHERE id = ?', sale2.id);
    await openRefund();
    await refundSearch(sale2.receipt);
    const archiveSel = await selectRefundTicket(sale2.receipt, 5000);
    const wrongRow = (await refundDialogText()).includes(sale2.receipt) && archiveSel === 'clicked';
    console.log(`[REF-63] archived ticket select → ${archiveSel} (wrongTicketOffered=${!wrongRow && archiveSel === 'clicked'})`);
    expect(['clicked', 'no-row', 'disabled']).toContain(archiveSel);
    await closeRefund();
    run('UPDATE transactions SET deleted = 0 WHERE id = ?', sale2.id);
    console.log(`[REF-63] archive lane outcome recorded: ${archiveSel}`);
  });

  it('[REF-64] refund slip/audit content: originalTransactionId, receipt, reason, cashier; a print attempt fires', async () => {
    await armConsoleTap();
    const printsBase = await countConsoleMatching('ESC/POS|Spooler');
    const sale = await makeCashSale('REF3 P700', 1);
    const printsAfterSale = await countConsoleMatching('ESC/POS|Spooler');

    expect(await beginRefund(sale.receipt)).toBe(true);
    // reason: custom lane ("Autre") so the slip trace is unambiguous.
    let reasonErr = '';
    try {
      await setRefundReason('Autre');
    } catch (e) {
      reasonErr = String((e as Error).message);
      console.log(`[REF-64] setRefundReason('Autre') failed: ${reasonErr}`);
    }
    if (reasonErr) {
      await setRefundReason('Autre motif personnalisé...');
    }
    await typeRefundCustomReason('E2E REF-64 motif');
    await refundOnly([{ pid: P700, qty: 1 }]);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-64] refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    const printsAfterRefund = await countConsoleMatching('ESC/POS|Spooler');
    const ref = refundRowOf(sale.id);
    console.log(`[REF-64] print attempts: base=${printsBase} sale=${printsAfterSale} refund=${printsAfterRefund}`);
    expect(printsAfterRefund).toBeGreaterThanOrEqual(1);

    expect(Number(ref?.total)).toBe(700);
    const refJson = jsonOf(ref) as Row;
    expect(String(refJson?.originalTransactionId ?? '')).toBe(sale.id);
    const refReceipt = String(ref?.receipt_number ?? '');
    expect(refReceipt.length).toBeGreaterThan(0);
    expect(refReceipt.toUpperCase()).toContain('AVOIR');

    const audits = all<Row>(
      "SELECT * FROM security_audit_logs WHERE details LIKE ? OR details LIKE ? ORDER BY rowid DESC LIMIT 20",
      `%${refReceipt}%`,
      `%${sale.receipt}%`,
    );
    console.log(`[REF-64] audit rows(matching sale/refund): ${audits.length} :: ${audits
      .slice(0, 4)
      .map((a) => `${String(a.action)}/${String(a.user)}/${String(a.details).slice(0, 90)}`)
      .join(' || ')}`);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    let outbox = '';
    try {
      const rows = all<Row>("SELECT * FROM sync_outbox WHERE payload LIKE ? OR entity_id LIKE ? ORDER BY rowid DESC LIMIT 4", `%${refReceipt}%`, `%${sale.id}%`);
      outbox = JSON.stringify(rows);
    } catch (e) {
      outbox = `(outbox read failed: ${String((e as Error).message)})`;
    }
    const blob = `${JSON.stringify(refJson)} ${JSON.stringify(audits)} ${outbox}`;
    console.log(`[REF-64] blob check for reason+linkage (length ${blob.length})`);
    expect(blob).toContain('E2E REF-64 motif');
    expect(blob).toContain('E2E');
  });

  it('[REF-79] return by a non-buyer: refund pays the drawer only; neither wallet (buyer or current customer) is touched', async () => {
    const aBefore = { credit: effCredit(C79A), chain: chainOf(C79A) };
    const bBefore = { credit: effCredit(C79B), chain: chainOf(C79B) };
    console.log(`[REF-79] before: A=${JSON.stringify(aBefore)} B=${JSON.stringify(bBefore)}`);
    const sale = await makeCashSaleTo('REF3 P500', 1, C79A_NAME);
    // The person at the counter is not the buyer:
    await selectCustomer(C79B_NAME);
    const movesBefore = count('cash_movements');

    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-79] refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    const ref = refundRowOf(sale.id);
    expect(Number(ref?.total)).toBe(500);
    expect(cashOf(ref)).toBe(500);

    const aAfter = { credit: effCredit(C79A), chain: chainOf(C79A) };
    const bAfter = { credit: effCredit(C79B), chain: chainOf(C79B) };
    console.log(`[REF-79] after: A=${JSON.stringify(aAfter)} B=${JSON.stringify(bAfter)}`);
    expect(aAfter.credit).toBe(aBefore.credit);
    expect(bAfter.credit).toBe(bBefore.credit);
    expect(aAfter.chain.ledger).toBe(aBefore.chain.ledger);
    expect(bAfter.chain.ledger).toBe(bBefore.chain.ledger);
    expect(bAfter.chain.col).toBe(bBefore.chain.col);
    expect(bAfter.chain.payload).toBe(bBefore.chain.payload);
    expect(count('cash_movements')).toBeGreaterThanOrEqual(movesBefore + 1);
    // Gift-receipt lane: the refund flow is original-ticket-based only; no
    // anonymous/gift lookup exists (RefundModal.tsx has no such control) —
    // the non-buyer path above is the representable facet.
  });

  it('[REF-86] order independence: same cart refunded line-chunks asc (3 calls) vs unit-chunks desc (4 calls) → identical per-line + total', async () => {
    const build = async (): Promise<{ id: string; receipt: string; total: number }> => {
      await clearCart();
      await addSku('REF3 P500', { times: 2 });
      await addSku('REF3 P700', { times: 1 });
      await addSku('REF3 P1000', { times: 1 });
      await overrideLastLinePrice('999', { pin: APP_PIN });
      const before = txCount();
      await payExactFlow();
      const tx = await landedSale(before);
      expect(Number(tx.total)).toBe(2699);
      return { id: String(tx.id), receipt: String(tx.receipt_number), total: Number(tx.total) };
    };

    const saleA = await build();
    // (A) per-line chunks, ascending: P500×2 (1000), P700 (700), P1000@999 (999)
    const chunksA: Array<{ targets: Array<{ pid: string; qty: number }>; preview: bigint }> = [
      { targets: [{ pid: P500, qty: 2 }], preview: 100000n },
      { targets: [{ pid: P700, qty: 1 }], preview: 70000n },
      { targets: [{ pid: P1000, qty: 1 }], preview: 99900n },
    ];
    for (let i = 0; i < chunksA.length; i++) {
      expect(await beginRefund(saleA.receipt)).toBe(true);
      await refundOnly(chunksA[i].targets);
      const shown = await refundTotalMinor();
      console.log(`[REF-86] A chunk${i + 1} preview=${shown} (expect ${chunksA[i].preview})`);
      expect(shown).toBe(chunksA[i].preview);
      const settled = await submitAndSettle(saleA.id, i + 1);
      if (!settled.landed) console.log(`[REF-86] A chunk${i + 1} refusal: ${settled.surface}`);
      expect(settled.landed).toBe(true);
    }
    const refundsA = refundsFor(saleA.id);
    const sumA = refundsA.reduce((s, r) => s + Number(r.total), 0);
    console.log(`[REF-86] A: ${refundsA.length} refund(s) Σ=${sumA}`);
    expect(refundsA.length).toBe(3);
    expect(sumA).toBe(2699);
    expect(String(txRow(saleA.id)?.status)).toBe('REFUNDED');

    const saleB = await build();
    // (B) unit chunks, descending: P1000, P700, P500, P500
    const chunksB: Array<{ targets: Array<{ pid: string; qty: number }>; preview: bigint }> = [
      { targets: [{ pid: P1000, qty: 1 }], preview: 99900n },
      { targets: [{ pid: P700, qty: 1 }], preview: 70000n },
      { targets: [{ pid: P500, qty: 1 }], preview: 50000n },
      { targets: [{ pid: P500, qty: 1 }], preview: 50000n },
    ];
    for (let i = 0; i < chunksB.length; i++) {
      expect(await beginRefund(saleB.receipt)).toBe(true);
      await refundOnly(chunksB[i].targets);
      const shown = await refundTotalMinor();
      console.log(`[REF-86] B chunk${i + 1} preview=${shown} (expect ${chunksB[i].preview})`);
      expect(shown).toBe(chunksB[i].preview);
      const settled = await submitAndSettle(saleB.id, i + 1);
      if (!settled.landed) console.log(`[REF-86] B chunk${i + 1} refusal: ${settled.surface}`);
      expect(settled.landed).toBe(true);
    }
    const refundsB = refundsFor(saleB.id);
    const sumB = refundsB.reduce((s, r) => s + Number(r.total), 0);
    console.log(`[REF-86] B: ${refundsB.length} refund(s) Σ=${sumB}`);
    expect(refundsB.length).toBe(4);
    expect(sumB).toBe(2699);
    expect(String(txRow(saleB.id)?.status)).toBe('REFUNDED');

    // Per-line equality across both orders (from refund activities).
    const perLine = (saleId: string): Record<string, number> => {
      const out: Record<string, number> = {};
      const refs = all<Row>('SELECT id FROM transactions WHERE original_transaction_id = ? AND is_refund = 1', saleId);
      for (const r of refs) {
        const lines = all<Row>('SELECT product_id, quantity, unit_price_charged FROM transaction_items WHERE transaction_id = ?', String(r.id));
        for (const l of lines) {
          const pid = String(l.product_id);
          out[pid] = (out[pid] ?? 0) + Number(l.quantity) * Number(l.unit_price_charged);
        }
      }
      return out;
    };
    const plA = perLine(saleA.id);
    const plB = perLine(saleB.id);
    console.log(`[REF-86] per-line A=${JSON.stringify(plA)} B=${JSON.stringify(plB)}`);
    expect(plA[P500]).toBe(plB[P500]);
    expect(plA[P700]).toBe(plB[P700]);
    expect(plA[P1000]).toBe(plB[P1000]);
  });

  it('[REF-91] serial returner: 4 sale+refund cycles for one customer all honored with exact money; no silent block', async () => {
    let avoirCreditTotal = 0;
    for (let i = 1; i <= 4; i++) {
      const sale = await makeCashSaleTo('REF3 P500', 1, C91_NAME);
      expect(sale.total).toBe(500);
      expect(await beginRefund(sale.receipt)).toBe(true);
      await refundOnly([{ pid: P500, qty: 1 }]);
      const creditBefore = effCredit(C91);
      const vouchersBefore = voucherTotal();
      const settled = await submitAndSettle(sale.id, i);
      if (!settled.landed) console.log(`[REF-91] cycle ${i} refusal: ${settled.surface}`);
      expect(settled.landed).toBe(true);
      const ref = refundRowOf(sale.id);
      const cash = cashOf(ref);
      const creditDelta = effCredit(C91) - creditBefore;
      const voucherDelta = voucherTotal() - vouchersBefore;
      const valueBack = cash + Math.max(0, creditDelta) + Math.max(0, voucherDelta);
      avoirCreditTotal += Math.max(0, creditDelta);
      // Evidence: the app's own computed customer payload (sync_outbox row).
      // Shows whether an Avoir leg was BUILT/idempotently-enqueued even when
      // the durable customers row did not move (native lane persists Dexie +
      // outbox only — createOrderSlice.ts:2975-2994).
      const outboxCredit = (() => {
        try {
          const r = one<Row>(
            "SELECT payload_json FROM sync_outbox WHERE entity_type = 'customer' AND entity_id = ? ORDER BY rowid DESC LIMIT 1",
            C91,
          );
          return r ? Number((JSON.parse(String(r.payload_json)) as Row).storeCredit ?? NaN) : NaN;
        } catch { return NaN; }
      })();
      console.log(`[REF-91] cycle ${i}: refund id=${String(ref?.id)} cash=${cash} creditΔ=${creditDelta} voucherΔ=${voucherDelta} valueBack=${valueBack} outboxStoreCredit=${outboxCredit}`);
      expect(Number(ref?.total)).toBe(500);
      // Value conservation across lanes: exact cash OR an exact Avoir Client
      // leg (offline cash cap, see submitAndSettle) — always 500 in total.
      expect(valueBack).toBe(500);
    }
    const chain = chainOf(C91);
    console.log(`[REF-91] customer C91 after 4 cycles: chain=${JSON.stringify(chain)} credit=${JSON.stringify(creditRaw(C91))} avoirCreditTotal=${avoirCreditTotal}`);
    // Terminal conservation: any cycle routed to Avoir Client must leave the
    // customer's store credit equal to exactly that routed total — never more
    // (leak) and never less (silent loss).
    expect(effCredit(C91)).toBe(avoirCreditTotal);
    const auditDelta = all<Row>(
      "SELECT id FROM security_audit_logs WHERE details LIKE '%AVOIR-%' ORDER BY rowid DESC LIMIT 40",
    ).length;
    console.log(`[REF-91] audits referencing AVOIR receipts (last 40): ${auditDelta}`);
    // No fraud engine exists in the schema (no watchlist/fraud tables) — the
    // expected behavior is full honoring with exact records, which is what the
    // per-cycle assertions above enforce.
  });

  it('[REF-15] refund of a sale paid with converted loyalty points (avoir): conversion exact, credit-paid sale, refund restores store credit', async () => {
    // Points → avoir conversion happens in the CART lane (CartPanel preset
    // button, CartPanel.tsx:314-346): preset = minimumRedemptionPoints,
    // credit = preset × pointRedemptionRate, capped at 50% of the basket.
    const loyaltyBefore = one<Row>('SELECT loyalty_points, json_payload FROM customers WHERE id = ?', C15);
    const lpNow = () => Number((JSON.parse(String(one<Row>('SELECT json_payload FROM customers WHERE id = ?', C15)?.json_payload ?? '{}')) as Row).loyaltyPoints ?? NaN);
    expect(Number((JSON.parse(String(loyaltyBefore?.json_payload ?? '{}')) as Row).loyaltyPoints ?? NaN)).toBe(500);
    expect(effCredit(C15)).toBe(0);

    await clearCart();
    await selectCustomer(C15_NAME);
    let btnText = '';
    try {
      await browser.waitUntil(async () => {
        btnText = ((await browser.execute(() => {
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
            (x) => vis(x) && /Convertir\s+\d+\s+pts\s+\(\+[^)]*d.Avoir\)/i.test(x.textContent || ''),
          );
          return b ? String(b.textContent || '').trim() : '';
        })) as string) || '';
        return btnText.length > 0;
      }, { timeout: 10000, interval: 300, timeoutMsg: 'point-conversion preset button never appeared' });
    } catch {
      // falls through to the preset assert below
    }
    console.log(`[REF-15] convert button: "${btnText}"`);
    const pm = btnText.match(/Convertir\s+(\d+)\s+pts\s+\(\+([^)]+?)\s*d.Avoir\)/i);
    const preset = Number(pm?.[1] ?? 0);
    const creditPer = Number(String(pm?.[2] ?? '').replace(/[^\d]/g, '') || '0');
    console.log(`[REF-15] preset=${preset} pts → +${creditPer} DA (rate ${creditPer / preset} DA/pt)`);
    expect(preset).toBeGreaterThanOrEqual(10);
    expect(creditPer).toBe(preset * 10);

    // Basket sized so the 50%-of-sale cap admits each preset conversion
    // (cap needs sale ≥ preset × 20 DA); convert until the credit covers
    // the whole basket — every click must land exactly.
    const units = Math.max(1, Math.ceil((preset * 20) / 500));
    const saleTotalDa = units * 500;
    await addSku('REF3 P500', { times: units });
    const clicksNeeded = Math.ceil(saleTotalDa / creditPer);
    const lpPreSale = 500 - clicksNeeded * preset;
    console.log(`[REF-15] basket=${saleTotalDa} DA (${units}×P500), conversions needed=${clicksNeeded}`);
    // Hard evidence the cart really carries the basket (a silently-failed add
    // would make saleTotalForCap 0 and turn every conversion into a silent
    // cap refusal — run 3 symptom class).
    console.log(`[REF-15] cart lines=${await cartLineCount()} total=${await cartTotalMinor()} minor (expect ${saleTotalDa * 100})`);
    expect(await cartLineCount()).toBeGreaterThanOrEqual(1);
    expect(await cartTotalMinor()).toBe(BigInt(saleTotalDa) * 100n);
    // Which customer the app actually holds (the button only renders with
    // points >= 10, but the reason string matters if a conversion refuses).
    const cardInfo = (await browser.execute(() => {
      const t = document.body.innerText || '';
      const m = t.match(/REF3 Quinze[\s\S]{0,240}?(\d+)\s*pts/);
      return { quinzePts: m ? m[1] : null, hasQuinze: t.includes('REF3 Quinze') };
    })) as { quinzePts: string | null; hasQuinze: boolean };
    console.log(`[REF-15] customer card: ${JSON.stringify(cardInfo)}`);
    for (let c = 1; c <= clicksNeeded; c++) {
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
          (x) => vis(x) && /Convertir\s+\d+\s+pts\s+\(\+[^)]*d.Avoir\)/i.test(x.textContent || ''),
        );
        if (!b) return false;
        b.click();
        return true;
      })) as boolean;
      expect(clicked).toBe(true);
      await browser.pause(600);
      console.log(`[REF-15] conversion #${c} toast=${JSON.stringify(await visibleToasts())}`);
      const landed = await pollUntil(
        () => effCredit(C15) === c * creditPer && lpNow() === 500 - c * preset,
        10000,
        `conversion #${c} did not reach credit=${c * creditPer} / lp=${500 - c * preset}`,
      );
      console.log(`[REF-15] after conversion #${c}: ${JSON.stringify(creditRaw(C15))} lp=${lpNow()}`);
      expect(landed).toBe(true);
    }
    expect(effCredit(C15)).toBe(clicksNeeded * creditPer);
    expect(lpNow()).toBe(lpPreSale);

    // (2) Credit-paid sale: the converted avoir tenders the basket — capped by
    // the app's COGS margin-floor guardrail (loyaltyEngine.ts:557-582:
    // min(balance, 50 % of the gross, gross − COGS)). "Appliquer Tout" applies
    // that cap and pre-fills the cash remainder (PaymentModal.tsx:167-183,
    // :200-208) — the cap is disclosed on the button itself
    // («Appliquer Tout (400 DA)»), so the oracle pins it instead of a full
    // 1000 DA credit tender.
    await (await $(tid('checkout-button'))).click();
    const pay = await payWithStoreCreditAll();
    console.log(`[REF-15] pay: applied=${pay.applied} confirm="${pay.confirmLabel}"`);
    expect(pay.applied).toBe(true);
    const tx = newestTxRow();
    const sale = { id: String(tx?.id), receipt: String(tx?.receipt_number) };
    const lpAfterSale = lpNow();
    const saleTenders = (jsonOf(tx).tenders ?? []) as Array<{ method?: string; amount?: number }>;
    const unitCost15 = Math.round(Number(one<Row>('SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', sale.id)?.unit_cost_at_sale ?? 0));
    const guardrailCap = Math.min(Math.floor(saleTotalDa / 2), Math.max(0, saleTotalDa - units * unitCost15));
    console.log(`[REF-15] sale id=${sale.id} total=${String(tx?.total)} method=${String(tx?.payment_method)} tenders=${JSON.stringify(saleTenders)} guardrailCap=${guardrailCap} lpAfterSale=${lpAfterSale}`);
    expect(saleTenders.some((t) => /Avoir/i.test(String(t.method)) && Number(t.amount) === guardrailCap)).toBe(true);
    expect(Number(tx?.total)).toBe(saleTotalDa - guardrailCap);
    expect(effCredit(C15)).toBe(saleTotalDa - guardrailCap);
    // Points double-burn evidence (pinned by the final assert): spending the
    // converted credit must not claw points again — the credit was already
    // purchased with points at conversion time ('conversion' ledger entries).
    console.log(`[REF-15] points: post-conversions=${lpPreSale} post-sale=${lpAfterSale} (a drop below ${lpPreSale} = redeem double-burn, createOrderSlice.ts:804-805/:846-856)`);

    // (3) Refund: conservation oracle — the sale was funded by the capped
    // avoir + a cash remainder, so the refund must return all 1000 DA through
    // durable lanes combined (wallet credit restored + cash payout + voucher).
    // Durability note (P1-6, probe-run-01 + run 5): refund customer updates
    // are staged in the outbox + Dexie only (createOrderSlice.ts:2975-2994 —
    // enqueueGenericSync writes no durable row); the durable customers row
    // converges only on a LATER durable customer write (a checkout). A restore
    // visible only in the outbox is lost on reboot.
    const vouchersBeforeRefund = voucherTotal();
    const creditBeforeRefund = effCredit(C15);
    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: units }]);
    const shown = await refundTotalMinor();
    console.log(`[REF-15] refund preview=${shown} (expect ${saleTotalDa * 100})`);
    expect(shown).toBe(BigInt(saleTotalDa) * 100n);
    await selectRefundMethod('Avoir Client');
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) {
      throw new Error(`[REF-15] store-credit-paid sale refund refused (${settled.surface}) — REF-65/P1-3 class: the avoir leg cannot be returned through the UI`);
    }
    const ref = refundRowOf(sale.id);
    const lpFinal = lpNow();
    const creditAfter = effCredit(C15);
    const voucherBack = voucherTotal() - vouchersBeforeRefund;
    const returned = Math.max(0, creditAfter - creditBeforeRefund) + cashOf(ref) + voucherBack;
    console.log(`[REF-15] refund landed total=${String(ref?.total)} cash=${cashOf(ref)} credit ${creditBeforeRefund}→${creditAfter} voucher=${voucherBack} returned=${returned} lp ${lpPreSale}→${lpAfterSale}→${lpFinal}`);
    expect(Number(ref?.total)).toBeGreaterThan(0);
    expect(returned).toBe(saleTotalDa);
    // Points must never double-burn: spending already-converted credit may
    // earn (net cash) but must not drop the balance on the credit leg
    // (createOrderSlice.ts:804-805 deducts floor(credit/pointRedemptionRate)
    // points on every credit-paid sale — run 5 evidence: 400 DA credit →
    // −40 pts on top of the −100 pts conversions, C15 'redeem' ledger entry).
    expect(lpAfterSale).toBeGreaterThanOrEqual(lpPreSale);
    // Coherent terminal loyalty state: no-earn → unchanged through the
    // refund; earn + refund clawback → back to the pre-sale balance.
    expect([lpPreSale, lpAfterSale]).toContain(lpFinal);
  });

  it('[REF-66] refund inside an instalment plan (after 1 of N; after the last; overdue; no fee model): plan must track the refund', async () => {
    // Setup: two real credit sales (debt 2×500 each).
    const saleA = await makeCreditSale('REF3 P500', 2, C66A_NAME);
    const saleB = await makeCreditSale('REF3 P500', 2, C66B_NAME);
    const chainA0 = chainOf(C66A);
    const chainB0 = chainOf(C66B);
    console.log(`[REF-66] credit sales: A=${JSON.stringify(chainA0)} B=${JSON.stringify(chainB0)}`);
    expect(chainA0.ledger).toBe(1000);
    expect(chainB0.ledger).toBe(1000);

    // Mobile Kredy: plan A = 3× (334/333/333) + settle 334; plan B = full.
    await reloadWithQ('?mode=mobile&lang=fr');
    console.log('[REF-66] reloaded with ?mode=mobile — entering demo/Kredy');
    expect(await mobileEnterDemoAndKredy()).toBe(true);

    expect(await kredySearch(C66A_NAME)).toBe(true);
    expect(await kredyToggle(C66A_NAME, 'expand')).toBe(true);
    const planACreate = await kredyCreatePlan('1000');
    expect(planACreate.moneySet && planACreate.created).toBe(true);
    const planA = planOf(C66A);
    const planIdA = String(planA?.id ?? '');
    expect(planIdA.length).toBeGreaterThan(0);
    expect(Number(planA?.total_amount)).toBe(1000);
    const entriesA0 = planEntries(planIdA);
    console.log(`[REF-66] plan A created: ${JSON.stringify(entriesA0.map((e) => ({ seq: e.seq, amount: e.amount, due: String(e.due_date).slice(0, 10) })))}`);
    expect(entriesA0.reduce((s, e) => s + Number(e.amount), 0)).toBe(1000);

    expect(await kredyOpenSettlement(C66A_NAME)).toBe(true);
    const stA = await kredySettlementState();
    console.log(`[REF-66] settle modal A: ${JSON.stringify(stA)}`);
    expect(stA.open).toBe(true);
    expect(stA.label).toContain('Solder la dette');
    expect(await kredySetSettlementAmount('334')).toBe(true);
    const stA2 = await kredySettlementState();
    expect(stA2.label).toContain('versement');
    expect(await kredySubmitSettlement()).toBe(true);
    const settledA = await pollUntil(() => {
      const c = chainOf(C66A);
      return c.ledger === 666 && c.payload === 666;
    }, 20000, 'plan A settle did not reach 666');
    console.log(`[REF-66] plan A after settle 334: remaining=${planRemaining(planIdA)} chain=${JSON.stringify(chainOf(C66A))} settled=${settledA}`);
    expect(settledA).toBe(true);
    expect(planRemaining(planIdA)).toBe(666);
    expect(Number(planEntries(planIdA)[0]?.paid_amount)).toBe(334);
    await kredyToggle(C66A_NAME, 'collapse');

    expect(await kredySearch(C66B_NAME)).toBe(true);
    expect(await kredyToggle(C66B_NAME, 'expand')).toBe(true);
    const planBCreate = await kredyCreatePlan('1000');
    expect(planBCreate.moneySet && planBCreate.created).toBe(true);
    const planB = planOf(C66B);
    const planIdB = String(planB?.id ?? '');
    expect(planIdB.length).toBeGreaterThan(0);
    expect(await kredyOpenSettlement(C66B_NAME)).toBe(true);
    const stB = await kredySettlementState();
    console.log(`[REF-66] settle modal B: ${JSON.stringify(stB)}`);
    expect(stB.label).toContain('Solder la dette');
    expect(await kredySubmitSettlement()).toBe(true);
    const settledB = await pollUntil(() => {
      const c = chainOf(C66B);
      return c.ledger === 0 && c.payload === 0;
    }, 20000, 'plan B full settle did not reach 0');
    console.log(`[REF-66] plan B after full settle: status=${String(planOf(C66B)?.status)} remaining=${planRemaining(planIdB)} chain=${JSON.stringify(chainOf(C66B))} settled=${settledB}`);
    expect(settledB).toBe(true);
    expect(String(planOf(C66B)?.status)).toBe('SOLDE');
    expect(planRemaining(planIdB)).toBe(0);

    // Back to desktop.
    const shellD = await backToDesktop();
    console.log(`[REF-66] back on desktop=${shellD}`);
    expect(shellD).toBe(true);

    // Overdue facet: backdate plan A's unpaid instalments + no fee model check.
    run("UPDATE debt_plan_entries SET due_date = strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days') WHERE plan_id = ? AND paid_amount < amount", planIdA);
    const feeCols = [...tableColumns('debt_plans'), ...tableColumns('debt_plan_entries')].filter((c) => /fee|penalty|late|interest/i.test(c));
    console.log(`[REF-66] overdue backdated; fee-ish columns: ${JSON.stringify(feeCols)}`);
    expect(feeCols.length).toBe(0);

    const itemRowsA = all<Row>('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', saleA.id);
    const unitCostA = Math.round(Number(itemRowsA[0]?.unit_cost_at_sale ?? 0));
    const itemRowsB = all<Row>('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY rowid', saleB.id);
    const unitCostB = Math.round(Number(itemRowsB[0]?.unit_cost_at_sale ?? 0));

    const failures: string[] = [];

    // ---- K1: refund after 1 of N ----
    const beforeK1 = { chain: chainOf(C66A), credit: effCredit(C66A), vouchers: voucherTotal() };
    const uiA = await (async () => {
      const begun = await beginRefund(saleA.receipt);
      if (!begun) return { begun: false, landed: false, surface: 'ticket not offered' };
      await refundOnly([{ pid: P500, qty: 1 }]);
      return { begun: true, ...(await submitAndSettle(saleA.id, 1)) };
    })();
    console.log(`[REF-66] K1 UI refund attempt: begun=${uiA.begun} landed=${uiA.landed} surface=${uiA.surface}`);
    await closeRefund().catch(() => {});
    let probeA: { ok?: boolean; raw?: string } = {};
    if (!uiA.landed) {
      const debtLegA = {
        entryId: `PAYREL-REF66A-${Date.now()}`,
        customerId: C66A,
        customerName: C66A_NAME,
        amount: 500,
        receiptNumber: `VERS-REF66A-${Date.now()}`,
        paymentMethod: 'Crédit Client',
        notes: 'E2E REF-66 diagnostic debt leg',
        recordedBy: 'E2E',
      };
      probeA = (await invokeForgedRefund({
        ...buildForgedRefund(saleA.id, 1),
        subtotal: 500,
        totalNet: 500,
        cashTenderedNet: 500,
        costTotal: unitCostA,
        debt: debtLegA,
      })) as { ok?: boolean; raw?: string };
      console.log(`[REF-66] K1 forged avoir refund → ok=${probeA.ok} raw=${probeA.raw}`);
    }
    const refA = refundRowOf(saleA.id);
    const cashA = refA ? cashOf(refA) : 0;
    const afterK1 = { chain: chainOf(C66A), credit: effCredit(C66A), vouchers: voucherTotal() };
    const reliefA = Math.max(0, beforeK1.chain.ledger - afterK1.chain.ledger);
    const valueBackA = cashA + Math.max(0, afterK1.credit - beforeK1.credit) + Math.max(0, afterK1.vouchers - beforeK1.vouchers) + reliefA;
    const planRemA = planRemaining(planIdA);
    console.log(
      `[REF-66] K1 evidence: refunded=${refundRowOf(saleA.id) ? 'yes' : 'no'} cash=${cashA} relief=${reliefA} creditΔ=${afterK1.credit - beforeK1.credit} voucherΔ=${afterK1.vouchers - beforeK1.vouchers} valueBack=${valueBackA} planRemaining=${planRemA} chainAfter=${JSON.stringify(afterK1.chain)} planStatus=${String(planOf(C66A)?.status)} entries=${JSON.stringify(planEntries(planIdA).map((e) => ({ seq: e.seq, paid: e.paid_amount })))} debtRows=${JSON.stringify(debtRowsOf(C66A).slice(-4))}`,
    );
    if (!uiA.landed) failures.push(`K1 UI refund refused (${uiA.surface || 'no surface'}) — REF-65/P1-3 class; forged lane ok=${String(probeA.ok)} raw=${String(probeA.raw).slice(0, 200)}`);
    if (valueBackA !== 500) failures.push(`K1 value conservation: valueBack=${valueBackA} ≠ 500 (cash=${cashA} relief=${reliefA} creditΔ=${afterK1.credit - beforeK1.credit} voucherΔ=${afterK1.vouchers - beforeK1.vouchers})`);
    if (planRemA !== afterK1.chain.ledger) failures.push(`K1 plan×receivable overhang: planRemaining=${planRemA} ≠ receivable=${afterK1.chain.ledger} (refund not coupled to the instalment plan)`);
    expect(Number(planOf(C66A)?.total_amount)).toBe(1000); // no fee was conjured on the overdue plan

    // ---- K2: refund after the last instalment (plan SOLDE, receivable 0) ----
    const beforeK2 = { chain: chainOf(C66B), credit: effCredit(C66B), vouchers: voucherTotal() };
    // UI lane first (the real merchant flow — mirrors K1). If it lands,
    // conservation is scored on the real lanes; if it is refused, that refusal
    // IS the finding (REF-65/P1-3 class: credit-funded sales have no payable
    // leg through the UI — the receivable-first split leaves nothing to move).
    const uiB = await (async () => {
      const begun = await beginRefund(saleB.receipt);
      if (!begun) return { begun: false, landed: false, surface: 'ticket not offered' };
      await refundOnly([{ pid: P500, qty: 1 }]);
      return { begun: true, ...(await submitAndSettle(saleB.id, 1)) };
    })();
    console.log(`[REF-66] K2 UI refund attempt: begun=${uiB.begun} landed=${uiB.landed} surface=${uiB.surface}`);
    await closeRefund().catch(() => {});
    let probeB: { ok?: boolean; raw?: string } = {};
    let forgedB = false;
    if (!uiB.landed) {
      // Diagnostic forged lane: value routed ONLY through the debt-relief leg.
      // On a settled plan the live receivable is 0, so the native clamp MUST
      // apply 0 and disclose it — that clamp is the correct behavior this
      // diagnostic asserts. (Asserting 500 back through THIS leg was a harness
      // oracle error: the forged request carries no other value lane, and the
      // native refund schema has no wallet field to carry one.)
      const debtLegB = {
        entryId: `PAYREL-REF66B-${Date.now()}`,
        customerId: C66B,
        customerName: C66B_NAME,
        amount: 500,
        receiptNumber: `VERS-REF66B-${Date.now()}`,
        paymentMethod: 'Crédit Client',
        notes: 'E2E REF-66 diagnostic debt leg (post-completion)',
        recordedBy: 'E2E',
      };
      probeB = (await invokeForgedRefund({
        ...buildForgedRefund(saleB.id, 1),
        subtotal: 500,
        totalNet: 500,
        cashTenderedNet: 500,
        costTotal: unitCostB,
        debt: debtLegB,
      })) as { ok?: boolean; raw?: string };
      forgedB = true;
      console.log(`[REF-66] K2 forged avoir refund → ok=${probeB.ok} raw=${probeB.raw}`);
    }
    const refB = refundRowOf(saleB.id);
    const cashB = refB ? cashOf(refB) : 0;
    const afterK2 = { chain: chainOf(C66B), credit: effCredit(C66B), vouchers: voucherTotal() };
    const reliefB = Math.max(0, beforeK2.chain.ledger - afterK2.chain.ledger);
    const valueBackB = cashB + Math.max(0, afterK2.credit - beforeK2.credit) + Math.max(0, afterK2.vouchers - beforeK2.vouchers) + reliefB;
    console.log(
      `[REF-66] K2 evidence: refunded=${refundRowOf(saleB.id) ? 'yes' : 'no'} uiLanded=${uiB.landed} uiSurface=${uiB.surface} cash=${cashB} relief=${reliefB} creditΔ=${afterK2.credit - beforeK2.credit} voucherΔ=${afterK2.vouchers - beforeK2.vouchers} valueBack=${valueBackB} chainAfter=${JSON.stringify(afterK2.chain)} planStatus=${String(planOf(C66B)?.status)} planRemaining=${planRemaining(planIdB)}`,
    );
    if (!uiB.landed) {
      failures.push(`K2 UI refund refused on a settled-plan credit sale (${uiB.surface || 'no surface'}) — REF-65/P1-3 class: value cannot come back through the UI`);
      if (forgedB) {
        const wB = (() => {
          // invokeForgedRefund returns JSON.stringify(res).slice(0, 600) — the
          // long ticketPayload tail is cut, so the raw is not JSON-parseable.
          // Run 5 parsed to [] and raised a false «clamp not disclosed» while
          // the response HAD disclosed «Réduction de dette plafonnée … appliqué
          // 0 DA (solde réel 0 DA)». Extract the warnings array textually.
          const raw = String(probeB.raw ?? '');
          const m = raw.match(/"warnings"\s*:\s*\[([\s\S]*?)"\]/);
          return m ? [m[1]] : [];
        })();
        if (probeB.ok !== true) failures.push(`K2 forged diagnostic did not commit: ok=${String(probeB.ok)} raw=${String(probeB.raw).slice(0, 160)}`);
        if (reliefB !== 0) failures.push(`K2 settled-plan clamp: relief=${reliefB} ≠ 0 (live receivable is 0 — the forged relief must clamp)`);
        if (!wB.some((w) => /plafonn/i.test(String(w)))) {
          failures.push(`K2 clamp not disclosed: warnings=${JSON.stringify(wB).slice(0, 200)}`);
        }
      }
    } else if (valueBackB !== 500) {
      failures.push(`K2 value conservation after completed plan: valueBack=${valueBackB} ≠ 500 (cash=${cashB} relief=${reliefB} creditΔ=${afterK2.credit - beforeK2.credit} voucherΔ=${afterK2.vouchers - beforeK2.vouchers})`);
    }
    if (afterK2.chain.ledger < 0 || afterK2.chain.payload < 0 || afterK2.chain.col < 0) failures.push(`K2 negative debt lane: ${JSON.stringify(afterK2.chain)}`);
    if (String(planOf(C66B)?.status) !== 'SOLDE') failures.push(`K2 plan status changed: ${String(planOf(C66B)?.status)}`);
    if (planRemaining(planIdB) !== 0) failures.push(`K2 plan remaining ≠ 0 after full settle: ${planRemaining(planIdB)}`);

    if (failures.length > 0) {
      throw new Error(`[REF-66] ${failures.length} finding(s): ${failures.join(' || ')}`);
    }
  });
});
