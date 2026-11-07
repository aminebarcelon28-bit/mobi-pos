/**
 * DRW - cash-drawer (shift) state, part 2 (batch 12 / spec 66; DRW-16..30).
 *
 * Same one-store reality as part 1. Covers float validation, kick/no-sale,
 * live totals, long-open policy, close barriers, Z parity, audit, reopen,
 * denominations, metadata concurrency and the absent gateway lane.
 */
import fs from 'node:fs';
import path from 'node:path';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, run, scalar, waitForSchemaSettled } from '../lib/db';
import {
  clickControl,
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
  refundSubmitDisabled,
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
import { pageClick, pageClickSelector } from '../lib/pageClick';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';
import { resetData, seedCustomerFull, seedImeiRecords, seedProducts, seedSettings } from '../lib/seed';

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
  await clickControl('checkout-button');
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
  'Ouvrez la caisse',
  'supérieur à 0 DA',
  'Horloge appareil',
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

describe('DRW - cash drawer state, part 2 (batch 12 / DRW-16..30)', () => {
  before(async function () {
  // Same measured 600 s before-all budget as part 1 (448 s solo; 300 s cap hit
  // chained in sweep N) — REF-87 precedent.
  this.timeout(600000);
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    await resetData();
    seedProducts([
      { id: P500, title: 'REF3 P500', priceDa: 500, stock: 500, costDa: 300 },
      { id: P700, title: 'REF3 P700', priceDa: 700, stock: 300, costDa: 400 },
      { id: P1000, title: 'REF3 P1000', priceDa: 1000, stock: 300, costDa: 500 },
      { id: PSER, title: 'REF3 PSER', priceDa: 800, stock: 5, costDa: 500, isSerialized: true, imeiNumber: IMEI_SER },
      { id: RB100, title: 'REF3 RB100', priceDa: 100, stock: 500, costDa: 40 },
      { id: RB200, title: 'REF3 RB200', priceDa: 200, stock: 500, costDa: 80 },
      { id: RB350, title: 'REF3 RB350', priceDa: 350, stock: 500, costDa: 140 },
      { id: P001, title: 'REF4 P001', priceDa: 0.01, stock: 100, costDa: 0 },
      { id: PMAX, title: 'REF4 PMAX', priceDa: 2000000000, stock: 10, costDa: 1000000000 },
    ]);
    seedProducts(REF5_PRODUCTS);
    seedBundles([
      { id: 'BND-REF33', title: 'Pack REF33', barcode: BUNDLE_BARCODE, bundlePriceDa: 500, childSkus: BUNDLE_SKUS },
    ]);
    seedImeiRecords([{ imei: IMEI_SER, productId: PSER, status: 'in_stock', warrantyMonths: 12 }]);
    seedCustomerFull([
      { id: CUST, name: CUST_NAME, phone: '0551200002', currentDebtDa: 0, debtLimitDa: 100000, storeCreditDa: 400 },
      { id: CUST65, name: CUST65_NAME, phone: '0551200065', currentDebtDa: 0, debtLimitDa: 500000 },
      { id: C15, name: C15_NAME, phone: '0551200015', currentDebtDa: 0, debtLimitDa: 100000, loyaltyPoints: 500, loyaltyPointsColumnDa: 500 },
      { id: C49, name: C49_NAME, phone: '0551200049', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C57, name: C57_NAME, phone: '0551200057', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C66A, name: C66A_NAME, phone: '0551200066', currentDebtDa: 0, debtLimitDa: 500000 },
      { id: C66B, name: C66B_NAME, phone: '0551200067', currentDebtDa: 0, debtLimitDa: 500000 },
      { id: C79A, name: C79A_NAME, phone: '0551200079', currentDebtDa: 0, debtLimitDa: 100000, storeCreditDa: 400 },
      { id: C79B, name: C79B_NAME, phone: '0551200080', currentDebtDa: 0, debtLimitDa: 100000, storeCreditDa: 250 },
      { id: C91, name: C91_NAME, phone: '0551200091', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C40, name: C40_NAME, phone: '0551220040', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C41, name: C41_NAME, phone: '0551220041', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C42, name: C42_NAME, phone: '0551220042', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C48, name: C48_NAME, phone: '0551220048', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C51, name: C51_NAME, phone: '0551220051', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C56, name: C56_NAME, phone: '0551220056', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C60, name: C60_NAME, phone: '0551220060', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C87, name: C87_NAME, phone: '0551220087', currentDebtDa: 0, debtLimitDa: 100000 },
      { id: C90, name: C90_NAME, phone: '0551220090', currentDebtDa: 0, debtLimitDa: 100000 },
    ]);
    seedCustomerFull(REF5_CUSTOMERS);
    await clearWebMirrors();
    await installErrorTrap(); // refresh above wiped the JS context
    await bootUnlock();
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
    await bootUnlock();
    captureInvariantBaseline('DRW2');
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
    assertInvariants(`DRW2 :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('DRW batch 12 part 2 (spec 66)');
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
    // HAR-009/DRW-24 (2026-11-03): the lock overlay can mount AFTER the first
    // unlock attempt on a slow boot. The old code swallowed that failure and the
    // overlay then intercepted every later click (named interceptor:
    // [data-testid=lock-screen]). Unlock, re-check, and fail loudly if it stays.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const locked = await $(tid('lock-screen')).isDisplayed().catch(() => false);
      if (!locked) break;
      try {
        await unlockIfNeeded();
      } catch (e) {
        console.log(`[reloadWithQ] unlock attempt ${attempt + 1}: ${String((e as Error)?.message ?? e)}`);
      }
      await browser.pause(500);
    }
    if (await $(tid('lock-screen')).isDisplayed().catch(() => false)) {
      throw new Error('[reloadWithQ] still locked after 3 unlock attempts');
    }
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
    await clickControl('clients-button');
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
      const nameEl = byPh('Nadir');
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
    await clickControl('checkout-button');
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
  // Spec 33 — batch 7 local consts + helpers.
  // Cases: REF-22, 23, 24, 35, 38, 40, 41, 42, 48, 51, 52, 53, 56, 58, 60, 87,
  // 90 + PAY-22. The N/A sweep (REF-31/37/43/55/74/85) carries codebase
  // evidence only — no executable lane exists (see COVERAGE.md).
  // ===========================================================================

  const P001 = 'REF4-P001';
  const PMAX = 'REF4-PMAX';
  const C40 = 'REF4-C40';
  const C40_NAME = 'REF4 Supprime';
  const C41 = 'REF4-C41';
  const C41_NAME = 'REF4 Avoir';
  const C42 = 'REF4-C42';
  const C42_NAME = 'REF4 Carte';
  const C48 = 'REF4-C48';
  const C48_NAME = 'REF4 Retour';
  const C51 = 'REF4-C51';
  const C51_NAME = 'REF4 Plafond';
  const C56 = 'REF4-C56';
  const C56_NAME = 'REF4 Rapport';
  const C60 = 'REF4-C60';
  const C60_NAME = 'REF4 Chaine';
  const C87 = 'REF4-C87';
  const C87_NAME = 'REF4 Extreme';
  const C90 = 'REF4-C90';
  const C90_NAME = 'REF4 Destination';
  const TRADE_IMEI = '358921000000047';

  /** Visible refund-line checkbox keys (`refund-check-<key>`). */
  async function refundCheckKeys(): Promise<string[]> {
    return (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      return ([...document.querySelectorAll('[data-testid^="refund-check-"]')] as HTMLElement[])
        .filter(vis)
        .map((el) => (el.getAttribute('data-testid') || '').replace('refund-check-', ''));
    })) as string[];
  }

  /** Visible editable fields of the refund dialog (testid|type|placeholder). */
  async function refundDialogFields(): Promise<string[]> {
    return (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[data-testid="refund-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return [] as string[];
      return ([...dlg.querySelectorAll('input, select, textarea')] as HTMLElement[])
        .filter(vis)
        .map((el) => {
          const i = el as HTMLInputElement & HTMLSelectElement;
          return `${el.getAttribute('data-testid') || el.tagName.toLowerCase()}|${String(i.type || '')}|${String(i.placeholder || '')}`;
        });
    })) as string[];
  }

  /** Close the Reports modal (REF-48/REF-56): the void flow and the SUMMARY
   *  read leave it open, and its overlay intercepts later real clicks
   *  (run 3: d2's `clients-button` click died under
   *  `role="dialog" aria-label="Rapports financiers"`). The header control is
   *  `[aria-label="Fermer les rapports"]` (ReportsModal.tsx:785-786, title
   *  "Fermer (Échap)"); Escape is the fallback. Never throws. */
  async function closeReportsDialog(): Promise<void> {
    const closed = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).find(
        (d) => vis(d) && /Rapports financiers/.test(d.getAttribute('aria-label') || ''),
      );
      if (!dlg) return 'no-dialog';
      const btn = ([...dlg.querySelectorAll('button[aria-label="Fermer les rapports"]')] as HTMLButtonElement[]).find(vis);
      if (btn) { btn.click(); return 'clicked'; }
      return 'no-close';
    })) as string;
    if (closed === 'no-close') {
      await browser.keys(['Escape']).catch(() => {});
    } else if (closed === 'clicked') {
      await browser.pause(400);
    }
    await browser
      .waitUntil(
        async () =>
          !(await browser.execute(() => {
            const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
            return ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).some(
              (d) => vis(d) && /Rapports financiers/.test(d.getAttribute('aria-label') || ''),
            );
          })),
        { timeout: 6000, interval: 200 },
      )
      .catch(() => {});
    await browser.pause(150);
  }

  /** Open Reports (manager gate), parse the "(-) Retours & Remboursements
   *  Clients" line magnitude in DA, close the dialog again. REF-56 reads it
   *  before and after one refund: the delta is the durable current-period
   *  returns movement the summary claims. Null when the label is absent. */
  async function readReturnsLine(): Promise<number | null> {
    await openReports();
    await unlockReportsGate();
    const ctx = await bodyContexts('Retours & Remboursements Clients', 90, 2);
    await closeReportsDialog();
    console.log(`[returnsLine] ctx=${JSON.stringify(ctx)}`);
    for (const c of ctx) {
      const m = c.match(/Retours\s*&\s*Remboursements\s*Clients\s*-?\s*([\d\s\u00A0\u202F.,]+?)\s*DA/i);
      if (m) {
        const digits = m[1].replace(/[^\d]/g, '');
        if (digits) return Number(digits);
      }
    }
    return null;
  }

  /** Newest customer-outbox storeCredit for a customer (P1-6 evidence lane). */
  function outboxCustomerCredit(custId: string): number | null {
    try {
      const rows = all<Row>(
        "SELECT payload_json FROM sync_outbox WHERE entity_type = 'customer' AND entity_id = ? ORDER BY rowid DESC LIMIT 8",
        custId,
      );
      for (const r of rows) {
        try {
          const j = JSON.parse(String(r.payload_json ?? '{}')) as Row;
          if (j.storeCredit !== undefined) return Number(j.storeCredit);
        } catch { /* keep scanning */ }
      }
    } catch { /* no outbox table */ }
    return null;
  }

  /** Two forged refund invokes racing in ONE page task (REF-58 replay race). */
  async function invokeForgedRefundPair(req: Row): Promise<Array<{ ok: boolean; raw: string }>> {
    return (await browser.execute(async (r: unknown) => {
      const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> } };
      const invoke = w.__TAURI_INTERNALS__?.invoke;
      const shape = (e: unknown): string => {
        if (typeof e === 'string') return e;
        if (e && typeof e === 'object') {
          const o = e as Record<string, unknown>;
          const raw = [o.kind, o.message_key, o.detail, o.message, o.error].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' :: ');
          if (raw) return raw;
          try { return JSON.stringify(o); } catch { return String(e); }
        }
        return String(e);
      };
      if (!invoke) return [{ ok: false, raw: 'NO_TAURI_INTERNALS' }, { ok: false, raw: 'NO_TAURI_INTERNALS' }];
      const one = async () => {
        try {
          const res = await invoke('refund_sale_atomic', { req: JSON.parse(JSON.stringify(r)) });
          return { ok: true, raw: JSON.stringify(res).slice(0, 600) };
        } catch (e) {
          return { ok: false, raw: shape(e).slice(0, 900) };
        }
      };
      return Promise.all([one(), one()]);
    }, req)) as Array<{ ok: boolean; raw: string }>;
  }

  /** Pay the open cart through the real CIB / Carte lane (card-funded sale). */
  async function payByCib(): Promise<void> {
    await clickControl('checkout-button');
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const picked = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return false;
      const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
        [...b.querySelectorAll('span')].some((sp) => /CIB\s*\/\s*Carte/i.test(sp.textContent || '')),
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })) as boolean;
    if (!picked) throw new Error('CIB / Carte tab not found in pay dialog');
    await browser.pause(400);
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)), {
      timeout: 45000,
      timeoutMsg: 'pay dialog did not close (CIB)',
    });
  }

  /** Value a committed refund delivered through a lane the customer can use:
   *  drawer cash, durable wallet credit, or a voucher. The outbox-only credit
   *  (P1-6) is NOT usable — it dies on reboot and never converges for a
   *  tombstoned profile. */
  function usableDelivery(
    ref: Row | undefined,
    custId: string | null,
    before: { col: number | null; payload: number; vault: number },
  ): number {
    if (!ref) return 0;
    const cash = cashOf(ref);
    const colDelta = custId !== null ? Math.max(0, (creditRaw(custId).col ?? 0) - (before.col ?? 0)) : 0;
    const afterPayload = custId !== null ? creditRaw(custId).payload : 0;
    const payloadDelta = custId !== null && Number.isFinite(afterPayload) ? Math.max(0, afterPayload - before.payload) : 0;
    const vaultDelta = Math.max(0, voucherTotal() - before.vault);
    return (Number.isFinite(cash) ? cash : 0) + colDelta + payloadDelta + vaultDelta;
  }

  /** Bounded poll for a DB-derived number (eventual-convergence lanes: the
   *  store-credit column can lag the outbox flush by a reconciliation pass). */
  async function pollValue(read: () => number, want: number, ms = 20000, step = 1000): Promise<number> {
    let v = read();
    const t0 = Date.now();
    while (v !== want && Date.now() - t0 < ms) {
      await browser.pause(step);
      v = read();
    }
    return v;
  }

  // ===========================================================================
  // Spec 34 — batch 8: local consts + SAV-repair lane helpers
  // Cases: PAY-09; REF-21, 26, 29, 45, 50, 67, 74, 75, 77, 78, 80,
  //        81, 82, 83, 84, 89.
  // ===========================================================================

  const P67 = 'REF5-P67';
  const SVC = 'REF5-SVC';
  const P75 = 'REF5-P75';
  const P84 = 'REF5-P84';
  const C67 = 'REF5-C67';
  const C67_NAME = 'REF5 Chèque';
  const C83 = 'REF5-C83';
  const C83_NAME = 'REF5 Fidèle';

  // 200 bulk lines (100 DA each, stock 40) for the REF-89 scale leg. The
  // wholesale 5 000-line facet has no representable lane (single-line catalog
  // addToCart only; no bulk/CSV order import exists in the POS) — recorded in
  // the test as a scope note.
  const REF5_BULK = Array.from({ length: 200 }, (_, i) => {
    const n = String(i).padStart(3, '0');
    return { id: `REF5-B${n}`, title: `REF5 Bulk ${n}`, priceDa: 100, stock: 40, costDa: 50 };
  });
  const REF5_PRODUCTS = [
    { id: P67, title: 'REF5 P67', priceDa: 900, stock: 100, costDa: 600 },
    { id: SVC, title: 'REF5 SVC', priceDa: 500, stock: 999999, costDa: 0, category: 'Services' },
    { id: P75, title: 'REF5 P75', priceDa: 300, stock: 10, costDa: 100 },
    { id: P84, title: 'REF5 P84', priceDa: 100, stock: 50, costDa: 40 },
    ...REF5_BULK,
  ];
  const REF5_CUSTOMERS = [
    { id: C67, name: C67_NAME, phone: '0551250067', currentDebtDa: 0, debtLimitDa: 100000 },
    { id: C83, name: C83_NAME, phone: '0551250083', currentDebtDa: 0, debtLimitDa: 100000 },
  ];

  // ---------------------------------------------------------------------------
  // Luhn-valid synthetic IMEIs for the repair intakes (the intake form
  // Luhn-validates a typed IMEI; deviceTrust blocks identifiers with an OPEN
  // ticket, so every non-rework repair gets its own number).
  // ---------------------------------------------------------------------------
  function luhnCheckDigit14(s14: string): string {
    let sum = 0;
    let dbl = true;
    for (let i = s14.length - 1; i >= 0; i--) {
      let d = s14.charCodeAt(i) - 48;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return String((10 - (sum % 10)) % 10);
  }
  function makeImei(seed9: number): string {
    const p14 = `35892${String(500000000 + seed9).padStart(9, '0')}`;
    return p14 + luhnCheckDigit14(p14);
  }

  // ---------------------------------------------------------------------------
  // Repair (SAV) lane — the modal + history driving helpers.
  // ---------------------------------------------------------------------------

  async function repairModalOpen(): Promise<boolean> {
    return (await browser.execute(() => {
      const t = document.body.innerText || '';
      return /Nouveau Ticket SAV/.test(t) && /Historique Atelier/.test(t);
    })) as boolean;
  }

  async function openRepairModal(): Promise<void> {
    if (await repairModalOpen()) return;
    await closeDialogs().catch(() => undefined);
    const ok = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => (x.getAttribute('title') || '') === 'Gestion des Réparations & Tickets SAV',
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (!ok) throw new Error('openRepairModal: header SAV button not found');
    await browser.waitUntil(repairModalOpen, {
      timeout: 15000,
      interval: 300,
      timeoutMsg: 'repair modal never appeared',
    });
    await browser.pause(300);
  }

  async function setInputValue(selector: string, value: string): Promise<boolean> {
    return (await browser.execute((sel: string, v: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, selector, value)) as boolean;
  }

  async function setInputInForm(by: 'placeholder' | 'aria', fragment: string, value: string): Promise<boolean> {
    return (await browser.execute((kind: string, frag: string, v: string) => {
      const fields = [...document.querySelectorAll('#sav-intake-form input, #sav-intake-form textarea')] as Array<
        HTMLInputElement | HTMLTextAreaElement
      >;
      const el = fields.find((x) =>
        kind === 'placeholder'
          ? ((x as HTMLInputElement).placeholder || '').includes(frag)
          : new RegExp(frag, 'i').test(x.getAttribute('aria-label') || ''),
      );
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, by, fragment, value)) as boolean;
  }

  async function selectInForm(selector: string, match: string): Promise<boolean> {
    return (await browser.execute((sel: string, m: string) => {
      const node = document.querySelector(sel) as HTMLSelectElement | null;
      if (!node) return false;
      const opt = [...node.options].find((o) => o.text.trim() === m || o.value === m);
      if (!opt) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(node, opt.value);
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, selector, match)) as boolean;
  }

  /** Draw a real pointer stroke on the intake signature canvas. Real WebDriver
   *  pointer actions first; synthetic pointer events with a neutered
   *  setPointerCapture as fallback (the handler calls setPointerCapture on a
   *  pointerId that synthetic dispatch cannot make active — Chrome throws
   *  InvalidPointerId and the stroke aborts). */
  async function drawSignature(): Promise<boolean> {
    const exists = (await browser.execute(() => Boolean(document.querySelector('#sav-intake-form canvas')))) as boolean;
    if (!exists) return false;
    const canvas = await $('#sav-intake-form canvas');
    await canvas.scrollIntoView().catch(() => undefined);
    await browser.pause(200);
    try {
      await browser
        .action('pointer', { parameters: { pointerType: 'mouse' } })
        .move({ origin: canvas as never, x: -70, y: -15 })
        .down()
        .move({ origin: canvas as never, x: -25, y: 18, duration: 120 })
        .move({ origin: canvas as never, x: 25, y: -14, duration: 120 })
        .move({ origin: canvas as never, x: 75, y: 14, duration: 120 })
        .up()
        .perform();
    } catch (e) {
      console.log(`[repair] signature via pointer actions failed (${String((e as Error)?.message ?? e)}) — synthetic fallback`);
      await browser.execute(() => {
        const c = document.querySelector('#sav-intake-form canvas') as HTMLCanvasElement | null;
        if (!c) return;
        const origSet = c.setPointerCapture;
        const origRelease = c.releasePointerCapture;
        try {
          c.setPointerCapture = () => undefined;
          c.releasePointerCapture = () => undefined;
          const r0 = c.getBoundingClientRect();
          const fire = (type: string, x: number, y: number) => {
            c.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 1,
                pointerType: 'mouse',
                clientX: x,
                clientY: y,
              }),
            );
          };
          fire('pointerdown', r0.left + 30, r0.top + 40);
          fire('pointermove', r0.left + 80, r0.top + 90);
          fire('pointermove', r0.left + 140, r0.top + 55);
          fire('pointerup', r0.left + 180, r0.top + 70);
        } finally {
          c.setPointerCapture = origSet;
          c.releasePointerCapture = origRelease;
        }
      });
    }
    await browser.pause(300);
    const stillNeeded = (await browser.execute(() => {
      const form = document.querySelector('#sav-intake-form');
      return form ? /Signature obligatoire avant enregistrement/.test(form.innerText || '') : false;
    })) as boolean;
    console.log(`[repair] signature drawn; 'signature obligatoire' hint still shown=${stillNeeded}`);
    return true;
  }

  interface IntakeOpts {
    name: string;
    phone: string;
    model: string;
    problem: string;
    imei?: string;
    labor?: number;
    parts?: number;
    deposit?: number;
    tierLabel?: string;
    statusValue?: string;
    reworkId?: string;
    sparePart?: string;
  }

  async function fillIntake(o: IntakeOpts): Promise<void> {
    // The intake form only exists on the 'Nouveau' tab.
    await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Nouveau Ticket SAV/.test(x.textContent || ''),
      );
      if (b) b.click();
    });
    await browser.pause(300);
    if (!(await browser.execute(() => Boolean(document.querySelector('#sav-intake-form'))))) {
      throw new Error('fillIntake: #sav-intake-form not visible');
    }

    await setInputValue('#sav-customer', o.name);
    await setInputValue('#sav-phone', o.phone);
    await setInputInForm('placeholder', 'iPhone', o.model);
    if (o.imei) {
      const typed = await setInputInForm('aria', 'IMEI|série|Référence', o.imei);
      console.log(`[repair] imei ${o.imei} typed=${typed}`);
    }
    await setInputValue('#sav-problem', o.problem);

    // Damage constat — screen condition chips render FIRST in the form, so the
    // first exact-'Intact' chip is the screen (the chassis 'Intact' renders
    // after the chassis header). Chassis defaults to ['none'] (EMPTY_DAMAGE).
    await browser.execute(() => {
      const form = document.querySelector('#sav-intake-form');
      if (!form) return;
      const chip = ([...form.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => (x.textContent || '').trim() === 'Intact',
      );
      chip?.click();
    });
    await browser.pause(200);

    // Warranty tier (radiogroup inside the form).
    const tierLabel = o.tierLabel ?? 'Garantie réparation 90 jours';
    const tierClicked = (await browser.execute((label: string) => {
      const radios = [...document.querySelectorAll('#sav-intake-form [role="radio"]')] as HTMLButtonElement[];
      const b = radios.find((x) => (x.textContent || '').includes(label));
      if (!b) return false;
      b.click();
      return true;
    }, tierLabel)) as boolean;
    if (!tierClicked) throw new Error(`fillIntake: warranty tier "${tierLabel}" not found`);
    await browser.pause(200);

    // CGV acceptance.
    await browser.execute(() => {
      const boxes = [...document.querySelectorAll('#sav-intake-form input[type="checkbox"]')] as HTMLInputElement[];
      const b = boxes.find((x) => /Le client a lu et accepte/.test(x.closest('label')?.textContent || ''));
      if (b && !b.checked) b.click();
    });
    await browser.pause(200);

    // Money fields (MoneyInput).
    if (o.labor !== undefined) await typeMoneyInto(await $('#sav-labor'), o.labor);
    if (o.parts !== undefined) await typeMoneyInto(await $('#sav-parts'), o.parts);
    if (o.deposit !== undefined) await typeMoneyInto(await $('#sav-deposit'), o.deposit);
    await browser.pause(250);

    // Spare part attach (search + click the suggestion row).
    if (o.sparePart) {
      await setInputInForm('placeholder', 'Rechercher une pièce dans le catalogue', o.sparePart);
      await browser.pause(600);
      const added = (await browser.execute((needle: string) => {
        const rows = ([...document.querySelectorAll('#sav-intake-form div')] as HTMLElement[]).filter(
          (el) => /SKU:/.test(el.innerText || '') && (el.innerText || '').includes(needle),
        );
        const cand = rows.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        if (!cand) return false;
        cand.click();
        return true;
      }, o.sparePart)) as boolean;
      console.log(`[repair] spare part "${o.sparePart}" attached=${added}`);
      await browser.pause(300);
    }

    // Rework link (create-only; lists Livré tickets).
    if (o.reworkId) {
      const linked = await selectInForm('#sav-rework-link', o.reworkId);
      if (!linked) throw new Error(`fillIntake: rework link option ${o.reworkId} missing`);
      console.log(`[repair] rework link → ${o.reworkId}`);
      await browser.pause(300);
    }

    // Status select on the create form (e.g. a fully-deposited ticket as Livré).
    if (o.statusValue) {
      const set = await selectInForm('#sav-status', o.statusValue);
      if (!set) throw new Error(`fillIntake: status ${o.statusValue} not selectable`);
      console.log(`[repair] create status → ${o.statusValue}`);
      await browser.pause(200);
    }

    // Signature LAST — every field-triggered re-render has already happened.
    await drawSignature();
  }

  async function clickSaveRepair(): Promise<boolean> {
    return (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => /Enregistrer le Ticket SAV|Mettre à jour Ticket/.test(x.textContent || ''),
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
  }

  async function saveRepairWait(name: string, timeout = 25000): Promise<Row> {
    if (!(await clickSaveRepair())) throw new Error('saveRepairWait: save button missing');
    const t0 = Date.now();
    for (;;) {
      const row = one<Row>(
        'SELECT * FROM repair_orders WHERE customer_name = ? ORDER BY rowid DESC LIMIT 1',
        name,
      );
      if (row) return row;
      if (Date.now() - t0 > timeout) {
        const toasts = await visibleToasts().catch(() => [] as string[]);
        throw new Error(
          `saveRepairWait(${name}): no repair row after ${timeout}ms; toasts=${JSON.stringify(toasts)}; tail=${await bodyTail()}`,
        );
      }
      await browser.pause(400);
    }
  }

  /** Open the modal, fill the v2 legal intake and save — returns the DB row. */
  async function newRepair(o: IntakeOpts): Promise<Row> {
    await openRepairModal();
    await fillIntake(o);
    return saveRepairWait(o.name);
  }

  function repairJson(row: Row | undefined | null): Row {
    if (!row) return {};
    try {
      return JSON.parse(String(row.json_payload ?? '{}')) as Row;
    } catch {
      return {};
    }
  }

  function repairCashMoves(needle: string): Row[] {
    return all<Row>('SELECT * FROM cash_movements WHERE reason LIKE ? ORDER BY rowid', `%${needle}%`);
  }

  async function openHistoryTab(): Promise<void> {
    await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Historique Atelier/.test(x.textContent || ''),
      );
      if (b) b.click();
    });
    // Verify the panel actually switched: a history-row status select (not the
    // create form's #sav-status) must appear; retry the click while waiting.
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const ok = (await browser.execute(() =>
        ([...document.querySelectorAll('select')] as HTMLSelectElement[]).some(
          (el) => el.id !== 'sav-status' && [...el.options].some((o) => o.text.trim() === 'Annulé'),
        ),
      )) as boolean;
      if (ok) return;
      await browser.execute(() => {
        const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
          /Historique Atelier/.test(x.textContent || ''),
        );
        if (b) b.click();
      });
      await browser.pause(300);
    }
    console.log('[repair] openHistoryTab: no history-row select appeared (panel switch failed?)');
  }

  /** Normalize the history panel so the target ticket's row renders: click the
   * « Tous » status pill and put the ticket into the search box (React-safe
   * native setter + input event). The panel keeps a stale search after a
   * settled delivery (RepairWorkOrderModal.tsx:252), which would filter the
   * target row out of the DOM entirely. */
  async function focusHistoryOn(ticket: string): Promise<void> {
    await browser.execute((t: string) => {
      const pill = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => (x.textContent || '').trim() === 'Tous',
      );
      if (pill) pill.click();
      const inp = [...document.querySelectorAll('input')].find((el) =>
        /Rechercher par/.test(el.getAttribute('placeholder') || ''),
      ) as HTMLInputElement | undefined;
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(inp, t);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, ticket);
    await browser.pause(400);
  }

  /** Change a repair's status through the real history-row select. The row is
   * the SMALLEST div whose text carries the ticket number AND that holds a
   * select offering the target option — the previous closest()/parentElement
   * scope never reached the ticket text (RepairWorkOrderModal.tsx:2671 card >
   * :2809 footer > :2812 select), so it never matched. */
  async function setRepairStatus(ticket: string, status: string): Promise<boolean> {
    await openHistoryTab();
    await focusHistoryOn(ticket);
    const deadline = Date.now() + 12000;
    let last = 'no-row(seen=0)';
    while (Date.now() < deadline) {
      last = (await browser.execute((t: string, s: string) => {
        let bestSel: HTMLSelectElement | null = null;
        let bestLen = Infinity;
        let seen = 0;
        for (const d of [...document.querySelectorAll('div')] as HTMLElement[]) {
          const text = d.textContent || '';
          if (!text.includes(t)) continue;
          seen++;
          const sel = ([...d.querySelectorAll('select')] as HTMLSelectElement[]).find((el) =>
            [...el.options].some((o) => o.text.trim() === s),
          );
          if (!sel) continue;
          if (text.length < bestLen) {
            bestLen = text.length;
            bestSel = sel;
          }
        }
        if (!bestSel) return `no-row(seen=${seen})`;
        const cur = (bestSel.options[bestSel.selectedIndex]?.text || '').trim();
        if (cur === s) return 'already';
        const opt = [...bestSel.options].find((o) => o.text.trim() === s);
        if (!opt) return 'no-option';
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(bestSel, opt.value);
        bestSel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'set';
      }, ticket, status)) as string;
      if (last === 'set' || last === 'already') break;
      await browser.pause(400);
    }
    console.log(`[repair] setRepairStatus(${ticket}, ${status}) → ${last}`);
    if (last !== 'set' && last !== 'already') return false;
    if (last === 'set') await browser.pause(700);
    return true;
  }

  async function waitRepairStatus(id: string, status: string, timeout = 15000): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      const row = one<Row>('SELECT status FROM repair_orders WHERE id = ?', id);
      if (row && String(row.status) === status) return true;
      if (Date.now() - t0 > timeout) return false;
      await browser.pause(400);
    }
  }

  async function clickSettleAndDeliver(ticket: string): Promise<boolean> {
    await focusHistoryOn(ticket);
    const deadline = Date.now() + 12000;
    let last = 'no-button';
    while (Date.now() < deadline) {
      // Same row-scoping rule as setRepairStatus: the smallest div carrying the
      // ticket number that also owns a « Régler & Livrer » button (:2829).
      last = (await browser.execute((t: string) => {
        let bestBtn: HTMLButtonElement | null = null;
        let bestLen = Infinity;
        for (const d of [...document.querySelectorAll('div')] as HTMLElement[]) {
          const text = d.textContent || '';
          if (!text.includes(t)) continue;
          const btn = ([...d.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
            /Régler & Livrer/.test(x.textContent || ''),
          );
          if (!btn) continue;
          if (text.length < bestLen) {
            bestLen = text.length;
            bestBtn = btn;
          }
        }
        if (!bestBtn) return 'no-button';
        bestBtn.click();
        return 'ok';
      }, ticket)) as string;
      if (last === 'ok') break;
      await browser.pause(500);
    }
    console.log(`[repair] clickSettleAndDeliver(${ticket}) → ${last}`);
    if (last !== 'ok') return false;
    await browser.pause(800);
    return true;
  }

  async function refreshApp(): Promise<void> {
    await browser.refresh();
    await installPageShims();
    await installErrorTrap(); // refresh wiped the JS context
    await bootUnlock();
    await browser.pause(400);
  }

  // ---------------------------------------------------------------------------
  // Refund-rail probes reused by REF-67/78/80 (forged supervisor + cheque).
  // ---------------------------------------------------------------------------

  async function payByCheque(): Promise<void> {
    await clickControl('checkout-button');
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const picked = (await browser.execute(() => {
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
      const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis);
      if (!dlg) return false;
      const btn = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
        [...b.querySelectorAll('span')].some((sp) => (sp.textContent || '').trim() === 'Chèque'),
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })) as boolean;
    if (!picked) throw new Error('Chèque tab not found in pay dialog');
    await browser.pause(400);
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)), {
      timeout: 45000,
      timeoutMsg: 'pay dialog did not close (Chèque)',
    });
  }

  function forgedWithSupervisor(saleId: string, verifiedAt: string, qty: number, amount: number): Row {
    const shift = String(txRow(saleId)?.shift_id ?? openShiftId() ?? '');
    return {
      ...buildForgedRefund(saleId, qty),
      method: 'Espèces',
      supervisor: { userId: 'REF5-SUP', verifiedAt },
      cashMove: {
        id: `MOV-REF5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        sessionId: shift,
        amount,
        reason: 'E2E REF5 supervisor probe',
        cashierName: 'E2E',
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Loyalty config + customer points probes (REF-83).
  // ---------------------------------------------------------------------------

  function readReceiptSettings(): Row {
    const row = one<Row>("SELECT value_json FROM app_settings WHERE key = 'mobi_pos_receipt_settings'");
    if (!row) return {};
    try {
      return JSON.parse(String(row.value_json)) as Row;
    } catch {
      return {};
    }
  }

  function writeLoyaltyConfig(baseSpendPerPoint: number): void {
    const cur = readReceiptSettings();
    const cfg = (cur.loyaltyConfig as Row | undefined) ?? {};
    const next = {
      ...cur,
      loyaltyConfig: { ...cfg, enabled: true, pointsEnabled: true, baseSpendPerPoint },
    };
    seedSettings([{ key: 'mobi_pos_receipt_settings', valueJson: JSON.stringify(next) }]);
  }

  function customerPointsColumn(): string {
    const cols = all<Row>('PRAGMA table_info(customers)').map((c) => String(c.name));
    return cols.find((c) => /loyalt/i.test(c)) ?? 'loyalty_points';
  }

  function customerPoints(custId: string): number {
    const col = customerPointsColumn();
    const row = one<Row>(`SELECT "${col}" AS v FROM customers WHERE id = ?`, custId);
    return Number(row?.v ?? 0);
  }

  function tableLive(name: string): boolean {
    return (
      Number(
        one<Row>("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?", name)?.c ?? 0,
      ) > 0
    );
  }

  function loyaltyLedgerCount(custId: string): number {
    if (!tableLive('loyalty_ledger')) return 0;
    return Number(one<Row>('SELECT COUNT(*) c FROM loyalty_ledger WHERE customer_id = ?', custId)?.c ?? 0);
  }

  function customerBuckets(custId: string): Row[] {
    const row = one<Row>('SELECT json_payload FROM customers WHERE id = ?', custId);
    try {
      const j = JSON.parse(String(row?.json_payload ?? '{}')) as Row;
      return Array.isArray(j.pointBuckets) ? (j.pointBuckets as Row[]) : [];
    } catch {
      return [];
    }
  }

  function bucketOf(custId: string, receipt: string): Row | undefined {
    return customerBuckets(custId).find((b) => String(b.originTransactionId ?? '') === receipt);
  }

  /** Drop ONE Dexie appSettings entry so the next read falls through to the
   * SQLite authority — operationsAdapter.getSetting is Dexie-first
   * (operationsAdapter.ts:568-570), so a mid-flight SQL change is otherwise
   * invisible to the WebView store until the mirror entry is dropped. The app
   * re-caches the fresh value on its next read (:577-583). */
  async function dropSettingsMirror(key: string): Promise<void> {
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
    console.log(`[settings-mirror] '${key}' → ${res}`);
    await browser.pause(200);
  }

  function claimCount(): number {
    if (!tableLive('warranty_claims')) return 0;
    return Number(one<Row>('SELECT COUNT(*) c FROM warranty_claims')?.c ?? 0);
  }

  // ===========================================================================
  // PAY-09 — SAV deposit + settlement on one repair document.
  // ===========================================================================

  // ===========================================================================
  // Batch 9 (SHF) — local helpers. The head above is spec 34 verbatim, so all
  // REF-era helpers (closeShiftUi, beginRefund/refundOnly/submitAndSettle,
  // buildForgedRefund, forgedWithSupervisor, reports navigation, DB readers)
  // are available here unchanged.
  // ===========================================================================

  const SHF_ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  function parseDaText(raw: string): number {
    const cleaned = (raw || '').trim();
    if (!cleaned) return NaN;
    try {
      return Number(displayedToMinor(cleaned)) / 100;
    } catch {
      /* fall through to last-token parse */
    }
    const nums = cleaned.match(/-?[\d][\d\s\u00A0\u202F.,]*/g);
    if (!nums || nums.length === 0) return NaN;
    try {
      return Number(displayedToMinor(nums[nums.length - 1])) / 100;
    } catch {
      return NaN;
    }
  }

  async function clickButtonByText(re: RegExp): Promise<boolean> {
    return (await browser.execute((src: string) => {
      const rx = new RegExp(src);
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
        (x) => vis(x) && rx.test(x.textContent || '') && !x.disabled,
      );
      if (!b) return false;
      b.click();
      return true;
    }, re.source)) as boolean;
  }

  async function clickButtonByTitle(re: RegExp): Promise<boolean> {
    return (await browser.execute((src: string) => {
      const rx = new RegExp(src);
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
      const b = ([...document.querySelectorAll('button[title]')] as HTMLButtonElement[]).find(
        (x) => vis(x) && rx.test(x.getAttribute('title') || '') && !x.disabled,
      );
      if (!b) return false;
      b.click();
      return true;
    }, re.source)) as boolean;
  }

  async function readReconciliation(): Promise<{ expectedDa: number; countedDa: number; varianceDa: number }> {
    const expEl = await $(tid('shift-expected'));
    // HAR-009 (2026-11-03): the mobile shell can take longer than 12 s to swap
    // the blind-count step after a reload; this is a state timeout, not a sleep.
    await expEl.waitForDisplayed({ timeout: 30000, timeoutMsg: 'RECONCILIATION step never appeared (shift-expected hidden)' });
    await browser.pause(250);
    const expectedText = await expEl.getText().catch(() => '');
    const countedText = await (await $(tid('shift-counted'))).getText().catch(() => '');
    const varianceText = await (await $(tid('shift-variance'))).getText().catch(() => '');
    return {
      expectedDa: parseDaText(expectedText),
      countedDa: parseDaText(countedText),
      varianceDa: varianceText.trim() ? parseDaText(varianceText) : 0,
    };
  }

  /** Drives close-modal step 1 (BLIND_COUNT) with a blind-count text, advances
   *  to RECONCILIATION and returns the app's own readouts. The modal stays
   *  OPEN on reconciliation: nothing is booked until shift-close-confirm. */
  async function closeToReconciliation(countedText: string): Promise<{ expectedDa: number; countedDa: number; varianceDa: number }> {
    const pillClicked = (await browser.execute(() => {
      const ps = [...document.querySelectorAll('[data-testid="shift-pill"]')] as HTMLButtonElement[];
      const p = ps.find((x) => {
        const cs = getComputedStyle(x);
        const r = x.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (!p) return false;
      p.click();
      return true;
    })) as boolean;
    if (!pillClicked) throw new Error('shift-pill missing for close');
    await (await $(tid('shift-close-dialog'))).waitForDisplayed({
      timeout: 20000,
      timeoutMsg: 'shift-close-dialog never appeared after clicking the shift pill',
    });
    const direct = await $(tid('shift-blind-direct'));
    if (await direct.isDisplayed().catch(() => false)) {
      await direct.click().catch(() => undefined);
      await browser.pause(250);
    }
    const input = await $(tid('shift-blind-input'));
    await input.waitForDisplayed({ timeout: 10000, timeoutMsg: 'shift-blind-input missing in BLIND_COUNT step' });
    await browser.execute((v: string) => {
      const el = document.querySelector('[data-testid="shift-blind-input"]') as HTMLInputElement | null;
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, countedText);
    await browser.pause(250);
    const nextClicked = (await browser.execute(() => {
      const b = document.querySelector('[data-testid="shift-blind-next"]') as HTMLButtonElement | null;
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (!nextClicked) throw new Error('shift-blind-next missing');
    return readReconciliation();
  }

  async function abortCloseTab(): Promise<void> {
    const gone = async () => !(await $(tid('shift-close-dialog')).isDisplayed().catch(() => false));
    await closeDialogs().catch(() => undefined);
    if (await gone()) return;
    await browser
      .execute(() => {
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
          (x) => vis(x) && /Fermer|Annuler|Retour|fermer la fenêtre/i.test(`${x.getAttribute('aria-label') || ''} ${x.title || ''}`),
        );
        b?.click();
      })
      .catch(() => undefined);
    await browser.waitUntil(gone, { timeout: 12000, timeoutMsg: 'shift-close-dialog could not be dismissed' });
  }

  /** Reconnaissance-only peek: opens the close modal, types count "1", reads the
   *  app-computed expected on the reconciliation screen, then aborts WITHOUT
   *  confirming (nothing is ever booked until shift-close-confirm). */
  async function peekExpected(): Promise<number> {
    const r = await closeToReconciliation('1');
    await abortCloseTab();
    return r.expectedDa;
  }

  /** From the reconciliation step: note-if-needed, PIN-if-shown, confirm. */
  async function commitReconciliation(
    opts: { skipNote?: boolean; skipPin?: boolean; expectRefusal?: boolean } = {},
  ): Promise<{ zShown: boolean; closed: boolean }> {
    const varianceText = await (await $(tid('shift-variance'))).getText().catch(() => '0');
    const variance = varianceText.trim() ? parseDaText(varianceText) : 0;
    if (variance !== 0 && !opts.skipNote) {
      const note = await $(tid('shift-note-variance'));
      if (await note.isDisplayed().catch(() => false)) await typeReal(note, 'E2E SHF variance note', false);
    }
    if (!opts.skipPin) {
      const pinEl = await $(tid('shift-close-pin'));
      if (await pinEl.isDisplayed().catch(() => false)) await typeReal(pinEl, APP_PIN, false);
    }
    await browser.execute(() => {
      const b = document.querySelector('[data-testid="shift-close-confirm"]') as HTMLButtonElement | null;
      b?.click();
    });
    if (opts.expectRefusal) {
      await browser.pause(1500);
      const stillOpen = await (await $(tid('shift-close-dialog')).isDisplayed().catch(() => false));
      return { zShown: false, closed: !stillOpen };
    }
    const zShown = await (await $(tid('shift-z-dialog')))
      .waitForDisplayed({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    await browser.waitUntil(async () => !(await $(tid('shift-close-dialog')).isDisplayed().catch(() => false)), {
      timeout: 30000,
      timeoutMsg: 'shift-close-dialog did not close after confirm',
    });
    return { zShown, closed: true };
  }

  /** Peek-then-close-exact: counted = the app's own expected (drift 0). */
  async function closeShiftExact(): Promise<{ expectedDa: number }> {
    const expectedDa = await peekExpected();
    const r = await closeToReconciliation(String(expectedDa));
    expect(r.expectedDa).toBe(expectedDa);
    expect(r.varianceDa).toBe(0);
    await commitReconciliation();
    return { expectedDa };
  }

  async function openShiftFresh(): Promise<string> {
    await openShiftBestEffort(10000);
    const sid = openShiftId();
    if (!sid) throw new Error('openShiftFresh: no OPEN session after openShiftBestEffort');
    return sid;
  }

  /** Hermetic per-test hygiene: dismiss overlays, empty the cart, close any
   *  lingering OPEN drawer at the app's own expected (peek → exact) and open a
   *  fresh 10 000 DA float. Keeps each test's absolute 10 000-based assertions
   *  meaningful even when an earlier test aborted mid-flow. */
  async function resetDrawerForTest(): Promise<string> {
    await closeDialogs().catch(() => undefined);
    await clearCart().catch(() => undefined);
    const open = openShiftId();
    if (open) {
      const e = await peekExpected();
      const r = await closeToReconciliation(String(e));
      if (r.varianceDa !== 0) {
        console.log(
          `[reset] hygiene close ${open}: displayed variance=${r.varianceDa} (window-scoped preview; the adapter certifies by shift stamp)`,
        );
      }
      await commitReconciliation();
      await waitFor(() => String(sessionRow(open)?.status ?? ''), (v) => v === 'CLOSED', 20000);
    }
    return openShiftFresh();
  }

  // ── Dexie mirror surgery (the boot-adoption / backdating probes) ──────────

  async function patchDexieSession(id: string, patch: Record<string, unknown>): Promise<number> {
    return (await browser.execute(async (sid: string, p: Record<string, unknown>) => {
      const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return -2;
      return await new Promise<number>((resolve) => {
        try {
          const open = idb.open('MobiPosDB');
          open.onerror = () => resolve(-3);
          open.onsuccess = () => {
            try {
              const db = open.result;
              if (!db.objectStoreNames.contains('cashSessions')) return resolve(-4);
              const tx = db.transaction('cashSessions', 'readwrite');
              const store = tx.objectStore('cashSessions');
              const get = store.get(sid);
              get.onerror = () => resolve(-5);
              get.onsuccess = () => {
                const row = get.result as Record<string, unknown> | undefined;
                if (!row) return resolve(0);
                try {
                  store.put({ ...row, ...p });
                } catch {
                  return resolve(-6);
                }
                tx.oncomplete = () => resolve(1);
                tx.onerror = () => resolve(-7);
              };
            } catch {
              resolve(-8);
            }
          };
        } catch {
          resolve(-9);
        }
      });
    }, id, patch)) as number;
  }

  async function deleteDexieSession(id: string): Promise<number> {
    return (await browser.execute(async (sid: string) => {
      const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return -2;
      return await new Promise<number>((resolve) => {
        try {
          const open = idb.open('MobiPosDB');
          open.onerror = () => resolve(-3);
          open.onsuccess = () => {
            try {
              const db = open.result;
              if (!db.objectStoreNames.contains('cashSessions')) return resolve(-4);
              const tx = db.transaction('cashSessions', 'readwrite');
              tx.objectStore('cashSessions').delete(sid);
              tx.oncomplete = () => resolve(1);
              tx.onerror = () => resolve(-7);
            } catch {
              resolve(-8);
            }
          };
        } catch {
          resolve(-9);
        }
      });
    }, id)) as number;
  }

  /** Backdate the live shift in BOTH stores, then reboot the WebView so the
   *  store re-hydrates the backdated opening time (SHF-05 / SHF-08). */
  async function backdateOpenShift(openedAtIso: string): Promise<string> {
    const sid = openShiftId();
    if (!sid) throw new Error('backdateOpenShift: no OPEN session');
    const now = new Date().toISOString();
    run('UPDATE cash_sessions SET opened_at = ?, updated_at = ?, version = version + 1 WHERE id = ?', openedAtIso, now, sid);
    const dexieN = await patchDexieSession(sid, { openedAt: openedAtIso, opened_at: openedAtIso });
    await browser.refresh();
    await installPageShims();
    await installErrorTrap();
    await bootUnlock();
    console.log(`[SHF backdate] ${sid} opened_at -> ${openedAtIso} (dexie patch=${dexieN})`);
    return sid;
  }

  // ── Movement modal / no-sale / hold-sales UI lanes ───────────────────────

  async function openToolsMenu(): Promise<void> {
    const btn = await $(tid('tools-menu-button'));
    await btn.waitForDisplayed({ timeout: 10000 });
    await btn.click();
    await browser.pause(400);
  }

  async function movementViaUi(kind: 'expense' | 'deposit', amountDa: number, reason: string): Promise<void> {
    await openToolsMenu();
    await (await $(tid('shift-move-open'))).click();
    await (await $(tid('shift-move-dialog'))).waitForDisplayed({ timeout: 10000, timeoutMsg: 'shift-move-dialog never appeared' });
    await (await $(tid(kind === 'expense' ? 'shift-move-expense' : 'shift-move-deposit'))).click();
    await browser.pause(250);
    const amt = await $(tid('shift-move-amount'));
    await typeReal(amt, String(amountDa), false);
    const rz = await $(tid('shift-move-reason'));
    await typeReal(rz, reason, false);
    await browser.pause(200);
    await (await $(tid('shift-move-save'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('shift-move-dialog')).isDisplayed().catch(() => false)),
      { timeout: 15000, timeoutMsg: 'shift-move-dialog did not close after save' },
    );
    await browser.pause(600);
  }

  async function noSaleAttempt(pin: string): Promise<void> {
    await openToolsMenu();
    const clicked = await clickButtonByText(/Ouvrir Tiroir Caisse/);
    if (!clicked) throw new Error('No-sale button ("Ouvrir Tiroir Caisse") not found in the tools menu');
    await (await $(tid('pin-gate-input'))).waitForDisplayed({ timeout: 10000, timeoutMsg: 'PinDialog never opened for no-sale' });
    await typeReal(await $(tid('pin-gate-input')), pin, false);
    await (await $(tid('pin-gate-submit'))).click();
    await browser.pause(1300);
  }

  async function heldSaleRowCount(): Promise<number> {
    return (await browser.execute(() => {
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
      return ([...document.querySelectorAll('button')] as HTMLButtonElement[]).filter(
        (x) => vis(x) && /Reprendre/.test(x.textContent || '') && !x.disabled,
      ).length;
    })) as number;
  }

  async function openHoldList(): Promise<void> {
    const ok = await clickButtonByTitle(/Mettre en Attente/);
    if (!ok) throw new Error('hold ("Attente") button not found in BottomBar');
    await browser.pause(800);
  }

  async function resumeFirstHeld(): Promise<boolean> {
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
        (x) => vis(x) && /Reprendre/.test(x.textContent || '') && !x.disabled,
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (clicked) await browser.pause(1200);
    return clicked;
  }

  // ── Lock screen lanes (SHF-13; SEC-11 reuses them) ───────────────────────

  async function lockAndWait(): Promise<void> {
    await closeDialogs().catch(() => undefined);
    // Idempotent: an earlier test may already have left the till locked (a
    // driver-level click race during an unlock aborted run 02 mid-test, and
    // every following UI click was then intercepted by the lock screen).
    if (await $(tid('lock-screen')).isDisplayed().catch(() => false)) {
      await browser.pause(300);
      return;
    }
    await (await $(tid('lock-button'))).click();
    await (await $(tid('lock-screen'))).waitForDisplayed({ timeout: 10000, timeoutMsg: 'lock-screen never appeared after lock-button' });
    await browser.pause(500);
  }

  async function unlockViaProfile(profileId: string, pin: string): Promise<void> {
    // Right after a refresh the WebView is still booting: give the lock screen
    // a grace window before deciding that the session is already open.
    // HAR-009/DRW-24 (2026-11-03): wait on the app's boot marker, not an 8 s
    // window. The shell renders behind the lock screen, and a slow boot can
    // mount the lock screen AFTER the old window - the helper then returned
    // "already open" and every later click was intercepted by the overlay.
    // When the marker exists, the lock decision is final.
    await browser.waitUntil(
      async () =>
        (await $(tid('lock-screen')).isDisplayed().catch(() => false)) ||
        (await browser.execute(
          () => Boolean((window as unknown as { __mobipos_bootTimings?: unknown }).__mobipos_bootTimings),
        )),
      { timeout: 60000, interval: 150, timeoutMsg: 'app never booted (no lock screen and no boot marker)' },
    );
    const locked = await $(tid('lock-screen')).isDisplayed().catch(() => false);
    if (!locked) {
      console.log(`[unlock] boot complete, no lock screen - session already open, nothing to unlock for ${profileId}`);
      return;
    }
    const isManager = profileId === 'usr-admin' || profileId === 'manager';
    const cardSel = `[data-testid="lock-profile-${profileId}"]`;
    await $(cardSel).waitForDisplayed({ timeout: 10000, timeoutMsg: `lock-profile-${profileId} not listed on the lock screen` });
    const cleared = async (ms = 3500): Promise<boolean> =>
      browser
        .waitUntil(async () => !(await $(tid('lock-screen')).isDisplayed().catch(() => false)), {
          timeout: ms,
          interval: 150,
        })
        .then(() => true)
        .catch(() => false);
    const padMax = async (): Promise<number> => {
      const el = await $(tid('login-pin-input'));
      if (!(await el.isExisting().catch(() => false))) return -1;
      // The real <input> is visually hidden behind the keypad buttons
      // (LockScreenOverlay.tsx:855-885); isDisplayed() is false by design.
      const raw = await el.getAttribute('maxlength').catch(() => '');
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : -1;
    };
    const selectCard = async (): Promise<number> => {
      await pageClickSelector(cardSel, { label: 'unlockViaProfile:card' });
      await browser.pause(400);
      return padMax();
    };

    // Let the boot roster settle BEFORE selecting: LockScreenOverlay re-selects
    // activeCashier on every cashierUsers reference change (:166-186), which
    // can silently undo a manual card click during the first seconds.
    await browser.pause(900);
    let pad = -1;
    for (let i = 0; i < 6; i++) {
      pad = await selectCard();
      if (isManager ? pad >= 6 : pad === 4) break;
      console.log(`[unlock] ${profileId}: pad maxlength=${pad} (want ${isManager ? '>=6' : '4'}) — profile selection was reset, retrying`);
    }
    const wants4 = !isManager;
    if ((wants4 && pad !== 4) || (!wants4 && pad < 6)) {
      const screenText = (await (await $(tid('lock-screen'))).getText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 260);
      throw new Error(
        `unlock ${profileId}: PIN pad never matched the profile (maxlength=${pad}, want ${wants4 ? '4' : '>=6'}); screen="${screenText}"`,
      );
    }

    const typePin = async (): Promise<void> => {
      const input = await $(tid('login-pin-input'));
      await input.click().catch(() => undefined);
      await input.clearValue().catch(() => undefined);
      await typeReal(input, pin, false);
      await browser.pause(300);
    };
    const jsSubmit = async (): Promise<boolean> =>
      (await pageClick('login-submit', { label: 'jsSubmit', throwOnRefusal: false })).allow;

    // Cashier pads auto-submit at 4 digits (LockScreenOverlay.tsx:885-887);
    // manager pads need an explicit submit at >= 6 digits.
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      if (attempt > 0) {
        pad = await selectCard();
        if ((wants4 && pad !== 4) || (!wants4 && pad < 6)) {
          await browser.pause(500);
          pad = await selectCard();
        }
      }
      await typePin();
      done = await cleared();
      if (!done && !isManager) {
        // a 4-digit cashier auto-submit should have fired; give the native
        // round-trip one more beat before deciding it failed
        done = await cleared(1500);
      }
      if (!done && !wants4) {
        await jsSubmit();
        done = await cleared();
      }
      if (!done) {
        const err = (await (await $(tid('lock-screen'))).getText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220);
        console.log(`[unlock] ${profileId}: attempt ${attempt + 1} failed (pad=${pad}); screen="${err}"`);
      }
    }
    if (!done) {
      throw new Error(`unlock ${profileId}: lock screen did not clear after two PIN attempts (pad=${pad})`);
    }
    await browser.pause(600);
  }

  /** Boot/refresh unlock used by every inherited before-hook and boot helper.
   *
   *  The legacy `unlockIfNeeded` types the master PIN then pointer-clicks the
   *  `login-submit` button. On a short window that button sits below the fold
   *  of the fixed lock-screen overlay, so WebDriver waits forever for it to
   *  become interactable ("element did not become interactable") even though a
   *  JS click works instantly. Try the legacy helper for setup/boot screens,
   *  then fall back to the role-aware JS-submit path while the lock screen is
   *  still mounted. Never throws: boot helpers decide their own assertions.
   */
  async function bootUnlock(): Promise<void> {
    const lockUp = await $(tid('lock-screen')).isDisplayed().catch(() => false);
    if (lockUp) {
      await unlockViaProfile('usr-admin', APP_PIN).catch((e) => console.log(`[bootUnlock] profile unlock: ${String((e as Error)?.message ?? e)}`));
      return;
    }
    await unlockIfNeeded().catch((e) => console.log(`[bootUnlock] legacy helper: ${String((e as Error)?.message ?? e)}`));
    if (await $(tid('lock-screen')).isDisplayed().catch(() => false)) {
      console.log('[bootUnlock] lock screen still mounted — using the JS-submit profile unlock');
      await unlockViaProfile('usr-admin', APP_PIN).catch((e) => console.log(`[bootUnlock] profile fallback: ${String((e as Error)?.message ?? e)}`));
    }
  }

  // ── Raw native invoke (self-contained, same error shaping as
  //    invokeForgedRefund) — used for pin_set probes and forged batches ──────

  async function shfInvokeRaw<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = (await browser.execute(async (c: string, a: Record<string, unknown>) => {
        const w = window as unknown as {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> };
        };
        const invoke = w.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return { ok: false as const, value: '__NO_TAURI_INTERNALS__' };
        try {
          const value = await invoke.bind(w.__TAURI_INTERNALS__)(c, a);
          return { ok: true as const, value };
        } catch (e) {
          let raw = '';
          if (typeof e === 'string') raw = e;
          else if (e && typeof e === 'object') {
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
          } else raw = String(e);
          return { ok: false as const, value: raw.slice(0, 900) };
        }
      }, cmd, args)) as { ok: true; value: T } | { ok: false; value: string };
      if (r.ok) return { ok: true, value: r.value };
      if (r.value === '__NO_TAURI_INTERNALS__') {
        await browser.pause(500);
        continue;
      }
      return { ok: false, error: r.value };
    }
    return { ok: false, error: '__NO_TAURI_INTERNALS__ (timeout)' };
  }

  async function ensureCashierRow(id: string, name: string, role: string): Promise<void> {
    const r = one<Row>("SELECT value_json FROM app_settings WHERE key = 'cashier_users'");
    const users = JSON.parse(String(r?.value_json ?? '[]')) as Row[];
    if (users.some((u) => u.id === id)) return;
    users.push({ id, name, pin: '', role, avatarColor: '#f59e0b' });
    run("UPDATE app_settings SET value_json = ? WHERE key = 'cashier_users'", JSON.stringify(users));
  }

  function auditRowCountWhere(where: string): number {
    return Number(one<{ c: number }>(`SELECT COUNT(*) c FROM security_audit_logs WHERE ${where}`)?.c ?? 0);
  }

  // ===========================================================================
  // SHF-01 — open/close exact, over and short.

  // ===========================================================================
  // Batch 10 (SEC) — local helpers. The head above is spec 34 verbatim; the
  // SHF helper block is reused unchanged (lock/unlock, native invoke, forged
  // refund builders, drawer reset). These add audit-table snapshots, native
  // PIN/backup/verify probes and filesystem scans for the security batch.
  // ===========================================================================

  const APP_ROAMING_DIR = path.dirname(DB_PATH);
  const APP_ID = path.basename(APP_ROAMING_DIR);
  const APP_LOCAL_DIR = path.join(path.dirname(APP_ROAMING_DIR), '..', 'Local', APP_ID);
  const REPO_ROOT = (() => {
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

  function auditCount(): number {
    return Number(one<{ c: number }>('SELECT COUNT(*) c FROM security_audit_logs')?.c ?? 0);
  }

  function auditRows(where = '1=1', ...params: unknown[]): Row[] {
    return all<Row>(`SELECT * FROM security_audit_logs WHERE ${where} ORDER BY rowid`, ...params);
  }

  function auditById(id: string): Row | undefined {
    return one<Row>('SELECT * FROM security_audit_logs WHERE id = ?', id);
  }

  function lastAuditRow(): Row | undefined {
    return one<Row>('SELECT rowid AS __rowid, * FROM security_audit_logs ORDER BY rowid DESC LIMIT 1');
  }

  /** Re-insert a snapshotted audit row verbatim, original rowid included:
   *  the sealed chain verifier walks rowid order, so an append (even with
   *  identical bytes) would still read as tamper. */
  function reinsertAuditRow(row: Row): void {
    const snapshot = { ...row };
    const rowid = snapshot.__rowid;
    delete snapshot.__rowid;
    const cols = Object.keys(snapshot);
    run(
      `INSERT INTO security_audit_logs (rowid, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
      rowid as never,
      ...cols.map((c) => snapshot[c] as never),
    );
  }

  async function pinVerifyRaw(userId: string, pin: string): Promise<Row> {
    const r = await shfInvokeRaw<Row>('pin_verify', { request: { userId, pin } });
    return r.ok ? r.value : { ok: false, locked: false, lockedRemainingMs: 0, error: r.error };
  }

  async function pinLockoutRaw(userId: string): Promise<Row> {
    const r = await shfInvokeRaw<Row>('pin_lockout_remaining', { request: { userId } });
    return r.ok ? r.value : { locked: false, remainingMs: 0, error: r.error };
  }

  async function pinSetRaw(
    userId: string,
    newPin: string,
    supervisorPin?: string,
  ): Promise<{ ok: boolean; raw: string; value?: Row }> {
    const req: Record<string, unknown> = { userId, newPin };
    if (supervisorPin !== undefined) req.supervisorPin = supervisorPin;
    const r = await shfInvokeRaw<Row>('pin_set', { request: req });
    return r.ok ? { ok: true, raw: JSON.stringify(r.value), value: r.value } : { ok: false, raw: r.error };
  }

  async function auditVerifyRaw(): Promise<{ ok: boolean; state: string; raw: string }> {
    const r = await shfInvokeRaw<unknown>('audit_verify', {});
    const raw = r.ok ? JSON.stringify(r.value) : r.error;
    return { ok: r.ok, state: raw, raw };
  }

  function verifyFields(state: string): { linksVerified: number; totalLinks: number; headSeq: number | null; reason: string } {
    try {
      const j = JSON.parse(state) as Row;
      const s = j.state;
      let reason = '';
      if (typeof s === 'string') reason = s;
      else if (s && typeof s === 'object') reason = String(Object.values(s as Row)[0] ?? '');
      const seq = j.headSeq;
      return {
        linksVerified: Number(j.linksVerified ?? -1),
        totalLinks: Number(j.totalLinks ?? -1),
        headSeq: seq === null || seq === undefined ? null : Number(seq),
        reason,
      };
    } catch {
      return { linksVerified: -1, totalLinks: -1, headSeq: null, reason: state };
    }
  }
  /** True when the keyed walk counted every chain link (linksVerified == totalLinks). */
  function fullLinkage(state: string): boolean {
    const f = verifyFields(state);
    return f.linksVerified >= 0 && f.totalLinks >= 0 && f.linksVerified === f.totalLinks;
  }
  /** Coarse class of an audit_verify result: intact | unsealed | truncation | tamper | other. */
  function stateClass(state: string): 'intact' | 'unsealed' | 'truncation' | 'tamper' | 'other' {
    const f = verifyFields(state);
    if (/MAC mismatch|link mismatch|missing log row|no valid genesis|link failure/i.test(f.reason)) return 'tamper';
    if (!fullLinkage(state)) return 'tamper';
    if (/truncation suspected/i.test(f.reason)) return 'truncation';
    if (/intact/i.test(f.reason)) return 'intact';
    if (/unsealed/i.test(f.reason)) return 'unsealed';
    return 'other';
  }

  async function createBackupRaw(kind?: string): Promise<{ ok: boolean; raw: string; value?: Row }> {
    const r = await shfInvokeRaw<Row>('create_database_backup', kind === undefined ? {} : { kind });
    return r.ok ? { ok: true, raw: JSON.stringify(r.value), value: r.value } : { ok: false, raw: r.error };
  }

  /** Click the first visible enabled button whose text matches the pattern. */
  async function clickByText(pattern: RegExp): Promise<boolean> {
    return (await browser.execute((src: string) => {
      const re = new RegExp(src);
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      const b = btns.find((x) => re.test(x.textContent || '') && x.offsetParent !== null && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    }, pattern.source)) as boolean;
  }

  /** Read a visible button's presence in the open tools dropdown (no click). */
  async function journalLauncherVisible(): Promise<boolean> {
    await openToolsMenu();
    const v = (await browser.execute(() => {
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      return btns.some((b) => /Journal d'Audit Sécurité/.test(b.textContent || '') && b.offsetParent !== null);
    })) as boolean;
    await closeDialogs().catch(() => undefined);
    return v;
  }

  /** Unlock guard for tests that inherit the shared session: no-op when the
   *  till is already open, otherwise open a manager session from the boot lock
   *  screen. Run 02 cascaded because one test aborted mid-unlock and left the
   *  till locked for every following UI action. */
  async function unlockBootScreen(): Promise<void> {
    if (!(await $(tid('lock-screen')).isDisplayed().catch(() => false))) return;
    console.log('[guard] till found locked at test start - opening a manager session (usr-admin)');
    await unlockViaProfile('usr-admin', APP_PIN);
  }

  /** Text of a lock-screen profile card (name + raw roster role, LockScreenOverlay.tsx:762-765). */
  async function cardRoleText(profileId: string): Promise<string> {
    return (await browser.execute((pid: string) => {
      const el = document.querySelector(`[data-testid="lock-profile-${pid}"]`) as HTMLElement | null;
      if (!el) return '';
      const lines = (el.innerText || el.textContent || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      return lines[lines.length - 1] || '';
    }, profileId)) as string;
  }

  /** aria-label of the lock-screen PIN input (pad policy: "(4 chiffres)" vs "(6 à 8 chiffres)"). */
  async function padAriaLabel(): Promise<string> {
    return (await browser.execute(() => {
      const i = document.querySelector('[data-testid="login-pin-input"]');
      return i ? i.getAttribute('aria-label') || '' : '';
    })) as string;
  }

  /** Open the security journal and clear its manager-PIN gate (manager session). */
  async function openJournalUnlocked(): Promise<boolean> {
    await openToolsMenu();
    const opened = await clickByText(/Journal d'Audit Sécurité/);
    if (!opened) return false;
    await browser.pause(700);
    const gate = await $('input[placeholder="PIN manager"]');
    if (await gate.isDisplayed().catch(() => false)) {
      await typeReal(gate, APP_PIN, false);
      await browser.pause(200);
      const submitted = await clickByText(/Déverrouiller le journal/);
      if (!submitted) return false;
      await browser.pause(900);
    }
    return true;
  }

  /** Scan the sandbox app dirs (non-DB by default) for a literal needle. */
  function scanAppFilesFor(
    needle: string,
    opts: { includeDb?: boolean; maxBytes?: number } = {},
  ): { hits: string[]; scanned: number } {
    const hits: string[] = [];
    const maxBytes = opts.maxBytes ?? 4_000_000;
    const roots = [APP_ROAMING_DIR, APP_LOCAL_DIR];
    let scanned = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!opts.includeDb && /\.(db|db-wal|db-shm)$/i.test(e.name)) continue;
        try {
          const st = fs.statSync(p);
          if (!st.isFile() || st.size === 0 || st.size > maxBytes) continue;
          const buf = fs.readFileSync(p);
          scanned += 1;
          if (buf.includes(Buffer.from(needle, 'utf8'))) hits.push(p);
        } catch {
          /* unreadable/locked file — skip */
        }
      }
    };
    for (const r of roots) walk(r);
    return { hits, scanned };
  }

  function readRepoJson(rel: string): Row | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as Row;
    } catch {
      return null;
    }
  }

  /** Read-only recursive source scan inside the repo — live codebase evidence
   *  for findings that are structural (no runtime lane exists). */
  function grepRepoFiles(relDir: string, pattern: RegExp): Array<{ file: string; line: number; text: string }> {
    const out: Array<{ file: string; line: number; text: string }> = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (['node_modules', 'target', 'dist', '.git'].includes(e.name)) continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx|rs)$/i.test(e.name)) continue;
        try {
          fs.readFileSync(p, 'utf8')
            .split(/\r?\n/)
            .forEach((text, idx) => {
              if (pattern.test(text)) {
                out.push({
                  file: path.relative(REPO_ROOT, p).replace(/\\/g, '/'),
                  line: idx + 1,
                  text: text.trim().slice(0, 200),
                });
              }
            });
        } catch {
          /* unreadable — skip */
        }
      }
    };
    walk(path.join(REPO_ROOT, relDir));
    return out;
  }



  // ===========================================================================
  // DRW batch 12 — cash-drawer lifecycle (DRW-16..30)
  // Same harness rules: real Tauri WebView, real SQLite file, real modals.
  // ===========================================================================

  const D2_RUN = Date.now().toString(36).slice(-5);
  interface Drw2User {
    id: string;
    name: string;
    pin: string;
    role: 'admin' | 'cashier';
  }
  const DE: Drw2User = { id: `usr-drw2a-${D2_RUN}`, name: 'DRW2 A', pin: '2847', role: 'cashier' };
  const DF: Drw2User = { id: `usr-drw2b-${D2_RUN}`, name: 'DRW2 B', pin: '3958', role: 'cashier' };

  function d2Cols(table: string): string[] {
    return all<Row>(`PRAGMA table_info(${table})`).map((c) => String(c.name));
  }

  function d2Roster(): Row[] {
    const r = one<Row>("SELECT value_json FROM app_settings WHERE key = 'cashier_users'");
    try {
      return JSON.parse(String(r?.value_json ?? '[]')) as Row[];
    } catch {
      return [];
    }
  }

  function d2RosterWrite(extra: Row[]): void {
    const cur = d2Roster();
    const ids = new Set(extra.map((u) => String(u.id)));
    run(
      `INSERT INTO app_settings (key, value_json, updated_at, version) VALUES ('cashier_users', ?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      JSON.stringify([...cur.filter((u) => !ids.has(String(u.id))), ...extra]),
      new Date().toISOString(),
    );
  }

  async function d2DropMirror(key: string): Promise<void> {
    const res = (await browser.execute(async (k: string) => {
      const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return 'no-idb';
      return await new Promise<string>((resolve) => {
        try {
          const open = idb.open('MobiPosDB');
          open.onerror = () => resolve('open-error');
          open.onsuccess = () => {
            try {
              const db = open.result;
              const tx = db.transaction('appSettings', 'readwrite');
              tx.objectStore('appSettings').delete(k);
              tx.oncomplete = () => resolve('deleted');
              tx.onerror = () => resolve('tx-error');
            } catch (e) {
              resolve(`throw:${String((e as Error)?.message ?? e)}`);
            }
          };
        } catch (e) {
          resolve(`throw:${String((e as Error)?.message ?? e)}`);
        }
      });
    }, key)) as string;
    console.log(`[drw2 mirror] drop ${key} → ${res}`);
  }

  async function d2PutDexie(row: Row): Promise<number> {
    return (await browser.execute(async (r: unknown) => {
      const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return -2;
      return await new Promise<number>((resolve) => {
        try {
          const open = idb.open('MobiPosDB');
          open.onerror = () => resolve(-3);
          open.onsuccess = () => {
            try {
              const db = open.result;
              if (!db.objectStoreNames.contains('cashSessions')) return resolve(-4);
              const tx = db.transaction('cashSessions', 'readwrite');
              tx.objectStore('cashSessions').put(r);
              tx.oncomplete = () => resolve(1);
              tx.onerror = () => resolve(-7);
            } catch {
              resolve(-8);
            }
          };
        } catch {
          resolve(-9);
        }
      });
    }, row)) as number;
  }

  async function d2DeleteDexie(id: string): Promise<number> {
    return (await browser.execute(async (sid: string) => {
      const idb = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return -2;
      return await new Promise<number>((resolve) => {
        try {
          const open = idb.open('MobiPosDB');
          open.onerror = () => resolve(-3);
          open.onsuccess = () => {
            try {
              const db = open.result;
              const tx = db.transaction('cashSessions', 'readwrite');
              tx.objectStore('cashSessions').delete(sid);
              tx.oncomplete = () => resolve(1);
              tx.onerror = () => resolve(-7);
            } catch {
              resolve(-8);
            }
          };
        } catch {
          resolve(-9);
        }
      });
    }, id)) as number;
  }

  /** Navigation-free mobile→desktop switch (same helper as batch 11): the
   *  reload path can hit App.tsx's beforeunload prompt and stall the driver. */
  async function fastDesktop(): Promise<boolean> {
    // The shell switch does not clear the app lock. If the lock screen is up,
    // a later shift/reconciliation click is intercepted by its fixed z-[100]
    // overlay (DRW-03 in the part-1 run); unlock before deciding the shell.
    if (await $(tid('lock-screen')).isDisplayed().catch(() => false)) {
      await bootUnlock().catch((e) => console.log(`[fastDesktop] unlock: ${String((e as Error)?.message ?? e)}`));
    }
    if (await $(tid('clients-button')).isDisplayed().catch(() => false)) return true;
    const navFree = (await browser.execute(() => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('mode');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
        localStorage.setItem('mobi_pos_device_mode_override', 'pos_primary');
        window.dispatchEvent(new Event('mobi:devicerole-change'));
        return true;
      } catch { return false; }
    })) as boolean;
    if (navFree) {
      await browser.pause(1500);
      if (await $(tid('clients-button')).isDisplayed().catch(() => false)) {
        console.log('[fastDesktop] switched via device-role override (no navigation)');
        return true;
      }
    }
    const first = (await browser.execute(() => {
      const vis = (d: HTMLElement) => {
        try {
          const cs = getComputedStyle(d);
          if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch { return false; }
      };
      const direct = ([...document.querySelectorAll('button')] as HTMLButtonElement[])
        .find((b) => vis(b) && /Basculer vers le Mode Bureau/i.test(b.textContent || ''));
      if (direct) { direct.click(); return 'direct'; }
      const header = document.querySelector('button[aria-label="Passer en Mode Caisse PC"]') as HTMLButtonElement | null;
      if (header && vis(header)) { header.click(); return 'header'; }
      const tab = ([...document.querySelectorAll('button')] as HTMLButtonElement[])
        .find((b) => vis(b) && (b.textContent || '').trim() === 'Gestion');
      if (tab) { tab.click(); return 'tab'; }
      return '';
    })) as string;
    if (first === 'direct' || first === 'header') {
      await browser.pause(1200);
      if (await $(tid('clients-button')).isDisplayed().catch(() => false)) {
        console.log(`[fastDesktop] switched via ${first}`);
        return true;
      }
    }
    if (first === 'tab') {
      await browser.pause(700);
      const second = (await browser.execute(() => {
        const vis = (d: HTMLElement) => {
          try {
            const cs = getComputedStyle(d);
            if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          } catch { return false; }
        };
        const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[])
          .find((x) => vis(x) && /Basculer vers le Mode Bureau/i.test(x.textContent || ''));
        if (!b) return false;
        b.click();
        return true;
      })) as boolean;
      if (second) {
        await browser.pause(1200);
        if (await $(tid('clients-button')).isDisplayed().catch(() => false)) {
          console.log('[fastDesktop] switched via management tab');
          return true;
        }
      }
    }
    console.log('[fastDesktop] UI switch unavailable — falling back to reload');
    return backToDesktop();
  }

  async function d2Boot(ms = 900): Promise<void> {
    await browser.refresh();
    await browser.pause(ms);
    await installPageShims().catch(() => undefined);
    await installErrorTrap().catch(() => undefined);
    await waitForSchemaSettled().catch(() => undefined);
    await bootUnlock();
  }

  async function d2Desktop(): Promise<void> {
    const shell = (await browser.execute(() => document.documentElement.dataset.shell ?? '')) as string;
    if (shell === 'mobile') await fastDesktop();
  }

  async function d2CloseAny(): Promise<void> {
    await closeDialogs().catch(() => undefined);
    const sid = openShiftId();
    if (!sid) return;
    try {
      const e = await peekExpected();
      const r = await closeToReconciliation(String(e));
      await commitReconciliation();
      await waitFor(() => String(sessionRow(sid)?.status ?? ''), (v) => v === 'CLOSED', 25000);
      console.log(`[drw2 hygiene] closed ${sid} at ${e} (variance ${r.varianceDa})`);
    } catch (err) {
      console.log(`[drw2 hygiene] close ${sid} failed: ${String((err as Error)?.message ?? err)}`);
      const now = new Date().toISOString();
      const prev = one<Row>('SELECT json_payload FROM cash_sessions WHERE id=?', sid);
      let payload: string | null = null;
      try {
        const p = JSON.parse(String(prev?.json_payload ?? '{}')) as Record<string, unknown>;
        p.status = 'CLOSED';
        p.closedAt = now;
        payload = JSON.stringify(p);
      } catch {
        payload = null;
      }
      if (payload) {
        run(
          "UPDATE cash_sessions SET status='CLOSED', closed_at=?, actual_cash=expected_cash, discrepancy=0, updated_at=?, version=version+1, json_payload=? WHERE id=? AND status='OPEN'",
          now,
          now,
          payload,
          sid,
        );
      } else {
        run(
          "UPDATE cash_sessions SET status='CLOSED', closed_at=?, actual_cash=expected_cash, discrepancy=0, updated_at=?, version=version+1 WHERE id=? AND status='OPEN'",
          now,
          now,
          sid,
        );
      }
      // rehydrate the store after a direct SQL close; getActiveShift() reads
      // the Dexie mirror (shiftAdapter.ts:998-1003), so close it there too.
      const dexieClose = await patchDexieSession(sid, {
        status: 'CLOSED',
        closedAt: now,
        actualCash: Number(one<Row>('SELECT expected_cash FROM cash_sessions WHERE id=?', sid)?.expected_cash ?? 0),
        expectedCash: Number(one<Row>('SELECT expected_cash FROM cash_sessions WHERE id=?', sid)?.expected_cash ?? 0),
        discrepancy: 0,
      }).catch(() => -1);
      console.log(`[drw2 hygiene] Dexie mirror close of ${sid} → ${dexieClose}`);
      await d2Boot(700).catch((e) => console.log(`[drw2 hygiene] rehydrate failed: ${String((e as Error)?.message ?? e)}`));
    }
    await closeDialogs().catch(() => undefined);
  }

  async function d2Unlock(u: Drw2User): Promise<void> {
    await lockAndWait();
    await unlockViaProfile(u.id, u.pin);
    const txt = await (await $(tid('lock-button'))).getText();
    expect(txt.replace(/\s+/g, ' ').trim()).toContain(u.name);
  }

  async function d2Open(u: Drw2User, floatDa = 10000): Promise<string> {
    await d2Unlock(u);
    await openShiftUi(floatDa);
    const sid = openShiftId();
    if (!sid) throw new Error(`d2Open(${u.name}): no OPEN session`);
    return sid;
  }

  async function d2Body(): Promise<string> {
    return (await browser.execute(() => (document.body.innerText || '').replace(/\u00a0/g, ' '))) as string;
  }

  async function d2Click(src: string): Promise<boolean> {
    return (await browser.execute((needle: string) => {
      const r = new RegExp(needle, 'i');
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => x.offsetParent !== null && r.test((x.textContent || '').replace(/\s+/g, ' ').trim()),
      );
      if (!b) return false;
      b.click();
      return true;
    }, src)) as boolean;
  }

  async function d2Mobile(): Promise<void> {
    await reloadWithQ('?mode=mobile&lang=fr');
    await browser.waitUntil(
      async () => ((await browser.execute(() => document.documentElement.dataset.shell ?? '')) as string) === 'mobile',
      { timeout: 30000, timeoutMsg: 'mobile shell never mounted' },
    );
    const skipped = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => x.offsetParent !== null && /Mode Démo/i.test(x.textContent || ''),
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (skipped) await browser.pause(1600);
    await d2Click('^Gestion$').catch(() => false);
    await browser.pause(600);
    // DRW-24: the lock overlay mounts AFTER the shell settles on a slow boot; a
    // reload-time unlock can run too early and the overlay then intercepts the
    // close-modal clicks (named interceptor: [data-testid=lock-screen]).
    await ensureUnlocked();
  }

  async function ensureUnlocked(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await browser.pause(600);
      if (!(await $(tid('lock-screen')).isDisplayed().catch(() => false))) return;
      try {
        await unlockIfNeeded();
      } catch (e) {
        console.log(`[ensureUnlocked] attempt ${i + 1}: ${String((e as Error)?.message ?? e)}`);
      }
    }
    if (await $(tid('lock-screen')).isDisplayed().catch(() => false)) {
      throw new Error('[ensureUnlocked] lock screen still present after 3 attempts');
    }
  }

  async function d2CloseReceipt(): Promise<void> {
    await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => (x.getAttribute('aria-label') || '') === 'Fermer — fermer le ticket de caisse' && x.offsetParent !== null,
      );
      b?.click();
    });
    await browser.pause(350);
  }

  async function d2MobileSale(title: string): Promise<string> {
    await d2Click('^Articles$');
    await browser.pause(600);
    const input = await $('input[placeholder="Nom, code-barres, référence..."]');
    await input.waitForDisplayed({ timeout: 15000 });
    const filled = (await browser.execute((t: string) => {
      const el = document.querySelector('input[placeholder="Nom, code-barres, référence..."]') as HTMLInputElement | null;
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, t);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, title)) as boolean;
    if (!filled) throw new Error('d2MobileSale: search input missing');
    await browser.pause(1000);
    const added = (await browser.execute((t: string) => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => x.offsetParent !== null && (x.getAttribute('aria-label') || '').includes(`Au Panier — ${t}`),
      );
      if (!b) return false;
      b.click();
      return true;
    }, title)) as boolean;
    if (!added) throw new Error(`d2MobileSale: no add-to-cart for ${title}`);
    await browser.pause(600);
    await d2Click('^Caisse$');
    await browser.pause(700);
    if (!(await d2Click('^Espèces$'))) throw new Error('d2MobileSale: cash button missing');
    await browser.pause(800);
    const preset = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => x.offsetParent !== null && /Montant exact/.test(x.getAttribute('aria-label') || ''),
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (!preset) throw new Error('d2MobileSale: exact preset missing');
    await browser.pause(400);
    const confirmed = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => x.offsetParent !== null && /Confirmer l'Encaissement/.test(x.textContent || ''),
      );
      if (!b) return false;
      b.click();
      return true;
    })) as boolean;
    if (!confirmed) throw new Error('d2MobileSale: confirm tender missing');
    await browser.pause(3000);
    const tx = newestTxRow();
    if (!tx) throw new Error('d2MobileSale: no transaction landed');
    return String(tx.id);
  }

  async function d2OpenDialog(): Promise<void> {
    await (await $(tid('shift-pill'))).click();
    await (await $(tid('shift-open-dialog'))).waitForDisplayed({ timeout: 20000 });
    await (await $(tid('shift-open-direct'))).click();
    await (await $(tid('shift-open-float'))).waitForDisplayed({ timeout: 10000 });
  }

  before(async function () {
    // Measured: part 2's second block seeds a second roster and reloads; the
    // 300 s cap was hit in a chained sweep (N). 600 s per the REF-87 precedent.
    this.timeout(600000);
    await d2CloseAny();
    d2RosterWrite([
      { id: DE.id, name: DE.name, pin: '', role: DE.role, avatarColor: '#0ea5e9' },
      { id: DF.id, name: DF.name, pin: '', role: DF.role, avatarColor: '#14b8a6' },
    ]);
    for (const u of [DE, DF]) {
      const r = await pinSetRaw(u.id, u.pin);
      console.log(`[DRW2 setup] pin_set(${u.id}) ok=${r.ok} raw=${r.raw.slice(0, 100)}`);
      if (!r.ok) throw new Error(`DRW2 setup: pin_set failed for ${u.id}`);
    }
    await d2DropMirror('cashier_users');
    await d2Boot(1200);
    console.log(`[DRW2 setup] run=${D2_RUN}; roster=${d2Roster().length}`);
  });

  beforeEach(async function () {
    this.timeout(300000);
    await d2Desktop();
    await installErrorTrap().catch(() => undefined);
    await closeDialogs().catch(() => undefined);
    await clearCart().catch(() => undefined);
    await unlockBootScreen().catch(() => undefined);
    if (await $(tid('lock-screen')).isDisplayed().catch(() => false)) {
      await unlockViaProfile('usr-admin', APP_PIN).catch((e) => console.log(`[drw2 beforeEach] unlock: ${String((e as Error)?.message ?? e)}`));
    }
    await d2CloseAny();
  });

  // ---------------------------------------------------------------------------
  // DRW-16 — float validation
  // ---------------------------------------------------------------------------
  it('[DRW-16] opening float validation: negative/Arabic/zero/huge; no post-open edit without approval', async () => {
    // negative — MoneyInput must not accept a negative float
    await d2OpenDialog();
    const negInput = await $(tid('shift-open-float'));
    await typeReal(negInput, '-500', false);
    await browser.pause(400);
    const negTotal = (await (await $(tid('shift-open-total')).getText().catch(() => '')).replace(/\s+/g, ' ')).trim();
    const negValue = await negInput.getValue();
    console.log(`[DRW-16] negative float typed: input=\"${negValue}\" total=\"${negTotal}\"`);
    await closeDialogs().catch(() => undefined);

    // Arabic-Indic digits are normalized by MoneyInput
    await d2OpenDialog();
    const arInput = await $(tid('shift-open-float'));
    await typeReal(arInput, '٥٠٠٠', false);
    await browser.pause(400);
    const arTotal = (await (await $(tid('shift-open-total')).getText().catch(() => '')).replace(/\s+/g, ' ')).trim();
    console.log(`[DRW-16] Arabic-Indic \"٥٠٠٠\" → total=\"${arTotal}\"`);
    await closeDialogs().catch(() => undefined);

    // zero float
    await d2OpenDialog();
    const zeroInput = await $(tid('shift-open-float'));
    await typeReal(zeroInput, '0', false);
    await browser.pause(300);
    await (await $(tid('shift-open-confirm'))).click();
    await browser.pause(1200);
    const zeroSid = openShiftId();
    const zeroOpened = Boolean(zeroSid);
    console.log(`[DRW-16] zero float accepted? ${zeroOpened} (sid=${zeroSid ?? '-'})`);
    if (zeroSid) {
      try {
        const e0 = await peekExpected();
        const zr = await closeToReconciliation(String(e0));
        await commitReconciliation();
        await waitFor(() => String(sessionRow(zeroSid)?.status ?? ''), (v) => v === 'CLOSED', 25000).catch(() => undefined);
        console.log(`[DRW-16] zero-float close: expected=${zr.expectedDa} variance=${zr.varianceDa} status=${String(sessionRow(zeroSid)?.status)}`);
      } catch (err) {
        console.log(`[DRW-16] zero-float UI close failed: ${String((err as Error)?.message ?? err)} — SQL fallback`);
        const now = new Date().toISOString();
        const prev = one<Row>('SELECT json_payload FROM cash_sessions WHERE id=?', zeroSid);
        let payload: string | null = null;
        try {
          const p = JSON.parse(String(prev?.json_payload ?? '{}')) as Record<string, unknown>;
          p.status = 'CLOSED';
          p.closedAt = now;
          payload = JSON.stringify(p);
        } catch {
          payload = null;
        }
        if (payload) {
          run(
            "UPDATE cash_sessions SET status='CLOSED', closed_at=?, actual_cash=0, expected_cash=0, discrepancy=0, updated_at=?, version=version+1, json_payload=? WHERE id=? AND status='OPEN'",
            now,
            now,
            payload,
            zeroSid,
          );
        } else {
          run(
            "UPDATE cash_sessions SET status='CLOSED', closed_at=?, actual_cash=0, expected_cash=0, discrepancy=0, updated_at=?, version=version+1 WHERE id=? AND status='OPEN'",
            now,
            now,
            zeroSid,
          );
        }
        const zeroDexie = await patchDexieSession(zeroSid, {
          status: 'CLOSED',
          closedAt: now,
          actualCash: 0,
          expectedCash: 0,
          discrepancy: 0,
        }).catch(() => -1);
        console.log(`[DRW-16] zero-float Dexie mirror close -> ${zeroDexie}`);
        await d2Boot(1000);
      }
    }
    await closeDialogs().catch(() => undefined);

    // huge float - a 1,000,000,000 DA opening float with no cap/approval
    await d2OpenDialog();
    const hugeInput = await $(tid('shift-open-float'));
    await typeReal(hugeInput, '1000000000', false);
    await browser.pause(400);
    await (await $(tid('shift-open-confirm'))).click();
    await browser.pause(1500);
    const hugeSid = openShiftId();
    const huge = hugeSid ? sessionRow(hugeSid)! : null;
    console.log(`[DRW-16] huge float accepted? ${Boolean(hugeSid)} (${String(huge?.opening_float)} DA), no approval prompt.`);
    if (hugeSid) {
      const eh = await peekExpected();
      try {
        const hr = await closeToReconciliation(String(eh));
        await commitReconciliation();
        await waitFor(() => String(sessionRow(hugeSid)?.status ?? ''), (v) => v === 'CLOSED', 25000);
        console.log(`[DRW-16] huge-float close: expected=${hr.expectedDa} variance=${hr.varianceDa}`);
      } catch (err) {
        console.log(`[DRW-16] huge-float UI close failed: ${String((err as Error)?.message ?? err)} — SQL fallback`);
        const now = new Date().toISOString();
        const prev = one<Row>('SELECT json_payload FROM cash_sessions WHERE id=?', hugeSid);
        let payload: string | null = null;
        try {
          const p = JSON.parse(String(prev?.json_payload ?? '{}')) as Record<string, unknown>;
          p.status = 'CLOSED';
          p.closedAt = now;
          payload = JSON.stringify(p);
        } catch {
          payload = null;
        }
        if (payload) {
          run(
            "UPDATE cash_sessions SET status='CLOSED', closed_at=?, actual_cash=?, expected_cash=?, discrepancy=0, updated_at=?, version=version+1, json_payload=? WHERE id=? AND status='OPEN'",
            now,
            Number(huge?.opening_float ?? 0),
            Number(huge?.opening_float ?? 0),
            now,
            payload,
            hugeSid,
          );
        } else {
          run(
            "UPDATE cash_sessions SET status='CLOSED', closed_at=?, actual_cash=?, expected_cash=?, discrepancy=0, updated_at=?, version=version+1 WHERE id=? AND status='OPEN'",
            now,
            Number(huge?.opening_float ?? 0),
            Number(huge?.opening_float ?? 0),
            now,
            hugeSid,
          );
        }
        const hugeDexie = await patchDexieSession(hugeSid, {
          status: 'CLOSED',
          closedAt: now,
          actualCash: Number(huge?.opening_float ?? 0),
          expectedCash: Number(huge?.opening_float ?? 0),
          discrepancy: 0,
        }).catch(() => -1);
        console.log(`[DRW-16] huge-float Dexie mirror close -> ${hugeDexie}`);
        await d2Boot(1000);
      }
    }
    await closeDialogs().catch(() => undefined);

    // post-open float edit: the close modal exposes no editable opening float
    const edits = all<Row>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%opening_float_history%'");
    console.log(`[DRW-16] opening-float history tables: ${edits.length}; no post-open float edit/approval lane exists.`);
    if (Boolean(hugeSid)) {
      console.log('[CONFIRMED EDGE-CASE VULNERABILITY] [P2] DRW-16: the opening float accepts a 1,000,000,000 DA value with no cap and no manager approval; negative typing is coerced/rejected in the widget and Arabic-Indic digits parse, but there is no upper-bound policy and no post-open correction/approval path.');
    }
    expect(Boolean(hugeSid)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // DRW-17 — no-sale / kick
  // ---------------------------------------------------------------------------
  it('[DRW-17] no-sale: manager PIN gate, drawer pulse, no sale, audited; mobile must not claim success', async () => {
    const sid = await d2Open(DE, 10000);
    const expectedBefore = await peekExpected();
    const salesBefore = Number(one<{ c: number }>("SELECT COUNT(*) c FROM transactions WHERE shift_id = ?", sid)?.c ?? 0);
    const aud0 = auditRowCountWhere("action LIKE '%Ouverture Manuelle%'");
    await noSaleAttempt(APP_PIN);
    await waitFor(() => auditRowCountWhere("action LIKE '%Ouverture Manuelle%'"), (v) => v === aud0 + 1, 15000);
    const aud = one<Row>("SELECT * FROM security_audit_logs WHERE action LIKE '%Ouverture Manuelle%' ORDER BY rowid DESC LIMIT 1");
    const salesAfter = Number(one<{ c: number }>("SELECT COUNT(*) c FROM transactions WHERE shift_id = ?", sid)?.c ?? 0);
    const expectedAfter = await peekExpected();
    console.log(`[DRW-17] desktop no-sale: audit user=\"${String(aud?.user)}\" requires_pin=${String(aud?.requires_pin)} details=\"${String(aud?.details)}\"; sales ${salesBefore}→${salesAfter}; expected ${expectedBefore}→${expectedAfter}`);
    expect(salesAfter).toBe(salesBefore);
    expect(expectedAfter).toBe(expectedBefore);
    expect(String(aud?.action)).toMatch(/Ouverture Manuelle/);
    expect(Number(aud?.requires_pin)).toBe(1);

    // Mobile no-sale: the handler ignores the pulse result and always toasts success.
    await d2Mobile();
    const opened = await d2Click('^Ouvrir Tiroir$');
    console.log(`[DRW-17] mobile \"Ouvrir Tiroir\" button present: ${opened}`);
    expect(opened).toBe(true);
    await (await $(tid('pin-gate-input'))).waitForDisplayed({ timeout: 15000 });
    const pinSet = (await browser.execute((v: string) => {
      const el = document.querySelector('[data-testid="pin-gate-input"]') as HTMLInputElement | null;
      if (!el) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    }, APP_PIN)) as string | null;
    await browser.pause(350);
    const pinSubmitState = (await browser.execute(() => {
      const b = document.querySelector('[data-testid="pin-gate-submit"]') as HTMLButtonElement | null;
      return b ? { disabled: b.disabled, text: b.textContent } : null;
    })) as { disabled: boolean; text: string | null } | null;
    console.log(`[DRW-17] mobile pin input value=${String(pinSet)}; submit=${JSON.stringify(pinSubmitState)}`);
    await browser.execute(() => {
      const b = document.querySelector('[data-testid="pin-gate-submit"]') as HTMLButtonElement | null;
      if (b && !b.disabled) b.click();
    });
    let successToast = false;
    for (let k = 0; k < 12 && !successToast; k++) {
      await browser.pause(250);
      successToast = /Ouverture manuelle du tiroir-caisse autoris/i.test(await d2Body());
    }
    const audMobile = one<Row>("SELECT * FROM security_audit_logs WHERE action LIKE '%Ouverture Manuelle%' ORDER BY rowid DESC LIMIT 1");
    console.log(`[DRW-17] mobile toast claims success: ${successToast}; audit user=\"${String(audMobile?.user)}\" details=\"${String(audMobile?.details)}\"`);
    console.log('[DRW-17] evidence: ManagementTab.tsx:137-143 calls `void openCashDrawerViaSpooler(...)` (result ignored) and unconditionally toasts success; the native open_cash_drawer refuses the mobile shell (lib.rs:61-80).');
    await fastDesktop();
    await d2CloseAny();

    if (successToast) {
      console.log('[CONFIRMED EDGE-CASE VULNERABILITY] [P2] DRW-17: a mobile no-sale shows \"Ouverture manuelle du tiroir-caisse autorisée\" and writes an audit row claiming the drawer opened, although the pulse result is discarded and the native mobile path refuses the command — an operator can believe the drawer was kicked when it was not.');
    }
    expect(successToast).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // DRW-18 — mobile expected-cash drift
  // ---------------------------------------------------------------------------
  it('[DRW-18] mobile estimated drawer matches desktop expected cash after cash/deposit/expense', async () => {
    const sid = await d2Open(DE, 10000);
    await makeCashSale('REF3 P500', 1);
    await d2CloseReceipt();
    await movementViaUi('deposit', 2000, 'DRW-18 apport');
    const desktopExpected = await peekExpected();
    console.log(`[DRW-18] desktop expected after sale 500 + deposit 2000 = ${desktopExpected}`);
    expect(desktopExpected).toBe(12500);

    await d2Mobile();
    await d2Click('^Activité$');
    await browser.pause(900);
    const body = await d2Body();
    const m = body.match(/Esp.{0,4}ces\s+Estim.{0,4}es\s+en\s+Tiroir[^0-9]{0,24}([\d\s.,]+)\s*DA/i);
    const rawMoney = m ? m[1] : '';
    const intPart = (rawMoney.match(/\d[\d\s]*/) || [''])[0].replace(/\s/g, '');
    const mobileEstimate = intPart ? Number(intPart) : NaN;
    console.log(`[DRW-18] mobile \"Espèces Estimées en Tiroir\" = ${String(mobileEstimate)} (desktop ${desktopExpected})`);
    await fastDesktop();

    const e = await peekExpected();
    const r = await closeToReconciliation(String(e));
    await commitReconciliation();
    await waitFor(() => String(sessionRow(sid)?.status ?? ''), (v) => v === 'CLOSED', 25000);

    if (mobileEstimate !== desktopExpected) {
      console.log('[CONFIRMED EDGE-CASE VULNERABILITY] [P2] DRW-18: the mobile LiveActivity estimate is float + cash sales only (LiveActivityTab.tsx:418) and omits pay-ins/expenses/drops, so the companion shows a different expected drawer than the desktop close preview (shiftAdapter.ts:834).');
    }
    expect(mobileEstimate).toBe(desktopExpected);
  });

  // ---------------------------------------------------------------------------
  // DRW-19 — mobile cash sale is counted in expected cash
  // ---------------------------------------------------------------------------
  it('[DRW-19] a cash sale rung from mobile is in the same ledger and the close expected cash', async () => {
    const sid = await d2Open(DE, 10000);
    await d2Mobile();
    const txId = await d2MobileSale('REF3 P500');
    const tx = txRow(txId)!;
    const tj = jsonOf(tx);
    console.log(`[DRW-19] mobile sale ${txId}: shift_id=${String(tx.shift_id)} cashierName=\"${String(tj.cashierName)}\" payment=${String(tx.payment_method)} device=${String(tx.device_id)}`);
    expect(String(tx.shift_id)).toBe(sid);
    expect(String(tx.payment_method)).toMatch(/Espèces/i);
    expect(String(tj.cashierName)).toBe(DE.name);
    await fastDesktop();

    const expected = await peekExpected();
    console.log(`[DRW-19] mobile sale counted: expected=${expected} (10000+500)`);
    expect(expected).toBe(10500);
    await d2CloseAny();
    expect(String(sessionRow(sid)?.status)).toBe('CLOSED');
    console.log('[DRW-19] one ledger, one shift_id scope: mobile and desktop sales are identical rows (no second store).');
  });

  // ---------------------------------------------------------------------------
  // DRW-20 — backend restore / epoch
  // ---------------------------------------------------------------------------
  it('[DRW-20] backend restore/epoch while open: no epoch or fork-detection lane exists', async () => {
    const cols = d2Cols('cash_sessions');
    console.log(`[DRW-20] cash_sessions columns: ${cols.join(',')}`);
    const epochCols = cols.filter((c) => /epoch|restore|fork|generation|origin/i.test(c));
    const sid = await d2Open(DE, 10000);
    const v0 = Number(sessionRow(sid)?.version ?? 0);
    await d2Boot(1300);
    const v1 = Number(sessionRow(sid)?.version ?? 0);
    console.log(`[DRW-20] version before/after restart: ${v0}/${v1}; no restore marker table exists.`);
    const restoreTables = all<Row>("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%restore%' OR name LIKE '%epoch%' OR name LIKE '%snapshot%')");
    console.log(`[DRW-20] restore/epoch tables: ${restoreTables.map((t) => String(t.name)).join(', ') || 'none'}`);
    await d2CloseAny();
    console.log('[N/A DRW-20] no backend restore/epoch concept exists in the store: cash_sessions has version but no epoch/generation/origin column and there is no inbound snapshot replace (sync is row replication only, SyncManager). A restored backend cannot fork the open drawer in this build.');
    expect(epochCols).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // DRW-21 — a peer terminal's drawer is adopted / closable
  // ---------------------------------------------------------------------------
  it('[DRW-21] a foreign terminal\'s OPEN drawer must not be adopted or closable from this terminal', async () => {
    await d2CloseAny();
    const peerId = `SHIFT-DRW21-PEER-${Date.now()}`;
    const now = new Date().toISOString();
    run(
      `INSERT INTO cash_sessions (id, opened_at, opening_float, status, cashier_name, json_payload, updated_at, version, device_id, terminal_name)
       VALUES (?, ?, 8000, 'OPEN', 'PEER DRAWER', ?, ?, 1, 'peer:DRW-T2', 'DRW-T2')`,
      peerId,
      now,
      JSON.stringify({ status: 'OPEN', openedAt: now, closedAt: null, cashierName: 'PEER DRAWER', deviceId: 'peer:DRW-T2', openedBy: 'PEER DRAWER', currentCashier: 'PEER DRAWER' }),
      now,
    );
    const dexie = await d2PutDexie({
      id: peerId,
      openedAt: now,
      closedAt: null,
      openingFloat: 8000,
      cashSales: 0,
      manualDeposits: 0,
      expenses: 0,
      expectedCash: null,
      actualCash: null,
      discrepancy: 0,
      status: 'OPEN',
      cashierName: 'PEER DRAWER',
      openedBy: 'PEER DRAWER',
      currentCashier: 'PEER DRAWER',
      openingNote: '',
      denominations: null,
      movements: [],
      deviceId: 'peer:DRW-T2',
      terminalName: 'DRW-T2',
      updatedAt: now,
      version: 1,
    });
    console.log(`[DRW-21] injected peer drawer ${peerId} (Dexie put=${dexie})`);
    await d2Boot(1700);

    const afterBoot = sessionRow(peerId);
    console.log(`[DRW-21] after local restart peer status=${String(afterBoot?.status)} cashier=\"${String(afterBoot?.cashier_name)}\" device=${String(afterBoot?.device_id)}`);

    let adoptedCashier = '';
    let adopted = false;
    let closedFromHere = false;
    if (String(afterBoot?.status) === 'OPEN') {
      await (await $(tid('shift-pill'))).click();
      const closeShown = await (await $(tid('shift-close-dialog'))).isDisplayed().catch(() => false);
      if (closeShown) {
        // Opening the CLOSE dialog on a drawer this terminal did not open is
        // already adoption: getActiveShift() returned the peer row.
        adopted = true;
        const nameInput = await $('input[placeholder="Nom du caissier…"]');
        adoptedCashier = String(await nameInput.getValue().catch(() => ''));
        console.log(`[DRW-21] local close dialog opened on the peer drawer; name field=\"${adoptedCashier}\"`);
        const e = await peekExpected();
        try {
          const r = await closeToReconciliation(String(e));
          await commitReconciliation({ skipPin: true });
          await browser.pause(1200);
          closedFromHere = String(sessionRow(peerId)?.status) === 'CLOSED';
          console.log(`[DRW-21] local close of peer drawer attempted: expected=${r.expectedDa} variance=${r.varianceDa} status=${String(sessionRow(peerId)?.status)}`);
        } catch (err) {
          console.log(`[DRW-21] local close of peer drawer failed: ${String((err as Error)?.message ?? err)}`);
        }
      } else {
        console.log('[DRW-21] shift pill did not open the close dialog for the peer row');
      }
    }
    await closeDialogs().catch(() => undefined);

    // cleanup (only this test's synthetic row)
    run('DELETE FROM cash_sessions WHERE id = ?', peerId);
    await d2DeleteDexie(peerId);
    await d2Boot(1200).catch(() => undefined);

    const violated = adopted || closedFromHere || adoptedCashier === 'PEER DRAWER' || String(afterBoot?.status) === 'CLOSED';
    if (violated) {
      console.log(`[CONFIRMED EDGE-CASE VULNERABILITY] [P1] DRW-21: getActiveShift() is unfiltered (shiftAdapter.ts:998-1003) and closeShift has no device-ownership check (shiftAdapter.ts:657-659, 904-911) — this terminal adopted the peer drawer (${adoptedCashier || 'status ' + String(afterBoot?.status)}) and ${closedFromHere ? "closed another device's session" : 'could close it by id'}.`);
    }
    expect(violated).toBe(false);
    expect(String(afterBoot?.status)).toBe('OPEN');
  });

  // ---------------------------------------------------------------------------
  // DRW-22 — drawer open > 24h
  // ---------------------------------------------------------------------------
  it('[DRW-22] a drawer left open >24h is flagged/aged, not silently treated as current', async () => {
    const sid = await d2Open(DE, 10000);
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await backdateOpenShift(old);
    try {
      const pj = JSON.parse(String(one<Row>('SELECT json_payload FROM cash_sessions WHERE id=?', sid)?.json_payload ?? '{}')) as Record<string, unknown>;
      pj.openedAt = old;
      run('UPDATE cash_sessions SET json_payload=? WHERE id=?', JSON.stringify(pj), sid);
    } catch { /* fixture only */ }
    console.log(`[DRW-22] ${sid} backdated to ${old}`);
    expect(String(sessionRow(sid)?.status)).toBe('OPEN');

    const header = (await (await $(tid('shift-pill'))).getText().catch(() => '')).replace(/\s+/g, ' ');
    await browser.execute(() => {
      const ps = [...document.querySelectorAll('[data-testid="shift-pill"]')] as HTMLButtonElement[];
      const p = ps.find((x) => {
        const cs = getComputedStyle(x);
        const r = x.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      p?.click();
    });
    await (await $(tid('shift-close-dialog'))).waitForDisplayed({ timeout: 20000 });
    const modal = (await (await $(tid('shift-close-dialog'))).getText()).replace(/\s+/g, ' ');
    const warning = /24\s*h|ancien|retard|trop longtemps|jours/i.test(modal) || /24\s*h|ancien|retard/i.test(header);
    console.log(`[DRW-22] header=\"${header.slice(0, 100)}\" | long-open warning present=${warning}`);
    await abortCloseTab();

    await d2Mobile();
    const body = await d2Body();
    const mobileWarn = /24\s*h|ancien|retard|trop longtemps/i.test(body);
    console.log(`[DRW-22] mobile long-open warning present=${mobileWarn}`);
    await fastDesktop();

    const e = await peekExpected();
    const r = await closeToReconciliation(String(e));
    await commitReconciliation();
    await waitFor(() => String(sessionRow(sid)?.status ?? ''), (v) => v === 'CLOSED', 25000);

    if (!warning && !mobileWarn) {
      console.log('[CONFIRMED EDGE-CASE VULNERABILITY] [P2] DRW-22: a 48-hour-open drawer renders as a normal current session in the header, close modal and companion — no age warning, no forced close, no manager flag; reconciliation still uses the date-prefixed Z number with no age distinction (cashTerms.ts:316-321).');
    }
    expect(warning || mobileWarn).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // DRW-23 — close with a parked sale / held work
  // ---------------------------------------------------------------------------
  it('[DRW-23] close with a parked sale: blocked or manager-confirmed; held work survives', async () => {
    const sid = await d2Open(DE, 10000);
    await addSku('REF3 P500');
    await clickButtonByTitle(/Mettre en Attente/);
    await browser.pause(900);
    await openHoldList();
    const held = await heldSaleRowCount();
    console.log(`[DRW-23] held sale rows while closing: ${held}`);
    await closeDialogs().catch(() => undefined);
    expect(held).toBeGreaterThan(0);

    const e = await peekExpected();
    const r = await closeToReconciliation(String(e));
    await commitReconciliation();
    await browser.pause(1000);
    const status = String(sessionRow(sid)?.status);
    console.log(`[DRW-23] close with ${held} held sale(s): status=${status} variance=${r.varianceDa} (no barrier or manager confirmation)`);
    await closeDialogs().catch(() => undefined);

    if (status === 'CLOSED') {
      console.log('[CONFIRMED EDGE-CASE VULNERABILITY] [P2] DRW-23: the drawer closes with a parked sale still held — no gate on held tickets and no manager confirmation; the held row survives, but it can only be resumed into the next drawer. (SHF-03 recorded the same behavior as acceptable for its own case; DRW-23 requires a barrier.)');
    }
    expect(status).toBe('OPEN');
  });

  // ---------------------------------------------------------------------------
  // DRW-24 — Z report parity desktop/mobile
  // ---------------------------------------------------------------------------
  it('[DRW-24] Z report parity: desktop close and mobile close show the same values/attribution', async () => {
    // desktop close
    const sid1 = await d2Open(DE, 10000);
    await makeCashSale('REF3 P500', 1);
    await d2CloseReceipt();
    const r1 = await closeShiftExact();
    const zA = (await (await $(tid('shift-z-dialog'))).getText()).replace(/\s+/g, ' ');
    const zMatchA = zA.match(/Z[- ]?Ticket\s*:?\s*([\d-]+)/i) || zA.match(/Z\s*#?\s*(\d+)/i);
    const zNumA = zMatchA ? zMatchA[1] : '';
    console.log(`[DRW-24] desktop Z #${zNumA}: ${zA.slice(0, 320)}`);
    expect(zA).toMatch(/10\s?500/);
    expect(zA).toContain(DE.name);
    await closeDialogs().catch(() => undefined);

    // mobile close
    const sid2 = await d2Open(DE, 10000);
    await makeCashSale('REF3 P500', 1);
    await d2CloseReceipt();
    await d2Mobile();
    const closeClicked = await d2Click('^Clôturer$');
    expect(closeClicked).toBe(true);
    await (await $(tid('shift-close-dialog'))).waitForDisplayed({ timeout: 20000 });
    const directTab = await $(tid('shift-blind-direct'));
    if (await directTab.isDisplayed().catch(() => false)) {
      await directTab.click().catch(() => undefined);
      await browser.pause(250);
    }
    const blind = await $(tid('shift-blind-input'));
    try {
      await blind.click();
    } catch (e) {
      // Name the interceptor instead of guessing (HAR-009/DRW-24).
      const probe = await browser.execute(() => {
        const el = document.querySelector('[data-testid="shift-blind-input"]') as HTMLElement | null;
        if (!el) return { missing: true };
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const top = document.elementFromPoint(x, y) as HTMLElement | null;
        const path: string[] = [];
        let n: HTMLElement | null = top;
        for (let i = 0; n && i < 6; i += 1) {
          path.push(
            `${n.tagName.toLowerCase()}${n.getAttribute('data-testid') ? `[data-testid=${n.getAttribute('data-testid')}]` : ''}.${String(n.className || '').split(' ').slice(0, 3).join('.')}`,
          );
          n = n.parentElement;
        }
        return { x, y, rect: { w: Math.round(r.width), h: Math.round(r.height) }, top: path };
      });
      console.log(`[DRW-24] blind-input interceptor: ${JSON.stringify(probe)}`);
      throw e;
    }
    // Set the value through React's own path: a raw setValue can leave the
    // component state empty, so "next" stays on the blind step (DRW-24, 30 s
    // timeout). The native setter + input event is the pattern the other
    // helpers use.
    await browser.execute(() => {
      const el = document.querySelector('[data-testid="shift-blind-input"]') as HTMLInputElement | null;
      if (!el) return;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, '10500');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await (await $(tid('shift-blind-next'))).click();
    const r2 = await readReconciliation();
    expect(r2.expectedDa).toBe(10500);
    expect(r2.varianceDa).toBe(0);
    const done = await commitReconciliation();
    expect(done.zShown).toBe(true);
    const zB = (await (await $(tid('shift-z-dialog'))).getText()).replace(/\s+/g, ' ');
    const zMatchB = zB.match(/Z[- ]?Ticket\s*:?\s*([\d-]+)/i) || zB.match(/Z\s*#?\s*(\d+)/i);
    const zNumB = zMatchB ? zMatchB[1] : '';
    console.log(`[DRW-24] mobile Z #${zNumB}: ${zB.slice(0, 320)}`);

    expect(String(sessionRow(sid1)?.status)).toBe('CLOSED');
    expect(String(sessionRow(sid2)?.status)).toBe('CLOSED');
    expect(zB).toMatch(/10\s?500/);
    expect(zB).toContain(DE.name);
    expect(Boolean(zNumA)).toBe(true);
    expect(Boolean(zNumB)).toBe(true);
    console.log(`[DRW-24] parity confirmed: both shells render the same global ShiftZReportModal (GlobalModalHost.tsx:70-73) with expected 10 500, variance 0 and opener ${DE.name}; the mobile doc builder is fixed at 42/32 columns regardless of paperWidth (mobileDocPrint.ts:35-38, 331) — a print-layout note, not a value divergence.`);
    await fastDesktop();
  });

  // ---------------------------------------------------------------------------
  // DRW-25 — audit of drawer events
  // ---------------------------------------------------------------------------
  it('[DRW-25] audit drawer events carry session/id/device/app version; failed opens are audited', async () => {
    const sid = await d2Open(DE, 10000);
    await movementViaUi('expense', 300, 'DRW-25 fond de caisse');
    await noSaleAttempt(APP_PIN);
    await browser.pause(1200);
    const e = await peekExpected();
    const r = await closeToReconciliation(String(e));
    await commitReconciliation();
    await waitFor(() => String(sessionRow(sid)?.status ?? ''), (v) => v === 'CLOSED', 25000);
    await closeDialogs().catch(() => undefined);

    const cols = d2Cols('security_audit_logs');
    console.log(`[DRW-25] security_audit_logs columns: ${cols.join(',')}`);
    const recent = all<Row>("SELECT action, user, details, requires_pin FROM security_audit_logs ORDER BY rowid DESC LIMIT 8");
    for (const a of recent) {
      console.log(`[DRW-25]   ${String(a.action)} | user=${String(a.user)} | pin=${String(a.requires_pin)} | details=${String(a.details).slice(0, 90)}`);
    }
    const structured = cols.includes('shift_id') && cols.includes('app_version');
    console.log(`[DRW-25] structured shift_id + app_version columns present? ${structured}; expected=${r.expectedDa}; close status=${String(sessionRow(sid)?.status)}`);

    // failed open (adapter refusal) is not audited
    const failedOpenAudits = auditRows("action LIKE '%Échec%' OR action LIKE '%failed%'").length;
    const handover = auditRows("action LIKE '%Passation%' OR action LIKE '%handover%'").length;
    console.log(`[DRW-25] failed-open audits=${failedOpenAudits}; handover audits=${handover} (switchCashier has no UI caller)`);

    if (!structured) {
      console.log('[CONFIRMED EDGE-CASE VULNERABILITY] [P2] DRW-25: security_audit_logs has no structured shift_id or app-version column (the session id lives only inside free-text details), failed drawer opens are not written, and the handover event has no producer — the drawer audit trail cannot be joined to cash_sessions reliably.');
    }
    expect(structured).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // DRW-26 — revoked/lost phone holding the drawer
  // ---------------------------------------------------------------------------
  it('[DRW-26] revoked device force-closes its drawer: no server revocation lane touches the drawer', async () => {
    const code = grepRepoFiles('src', /setDeviceRevoked|device_revoked|revokedAt/i);
    const drawerTouch = code.filter((h) => /shift|drawer|closeShift/i.test(h.file));
    const native = grepRepoFiles('src-tauri/src', /set_device_revoked|device_revoked/i);
    const sid = await d2Open(DE, 10000);
    const before = String(sessionRow(sid)?.status);
    console.log(`[DRW-26] revocation code hits: src=${code.length} (drawer-related=${drawerTouch.length}) native=${native.length}; session stays ${before}`);
    await d2CloseAny();
    console.log('[N/A DRW-26] device revocation exists only as a SyncManager sync gate (SEC-14/SEC-17 N/A); no local command checks a revocation flag on shift/checkout/refund (src-tauri/src has no device_revoked in the money path) and no server-issued revocation exists in this build. A lost phone keeps its local drawer until a human closes it.');
    expect(drawerTouch.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // DRW-27 — reopen a closed session
  // ---------------------------------------------------------------------------
  it('[DRW-27] reopen a closed session: no reopen command; a new open is a new id', async () => {
    const sid = await d2Open(DE, 10000);
    await d2CloseAny();
    expect(String(sessionRow(sid)?.status)).toBe('CLOSED');
    const reopenCode = grepRepoFiles('src', /reopenShift|reopen_shift|Rouvrir la caisse|REOPENED/i);
    console.log(`[DRW-27] reopen code hits: ${reopenCode.length}`);
    await (await $(tid('shift-pill'))).click();
    await (await $(tid('shift-open-dialog'))).waitForDisplayed({ timeout: 20000 });
    const dlg = (await (await $(tid('shift-open-dialog'))).getText()).replace(/\s+/g, ' ');
    const offersReopen = /rouvrir|reopen|réouverture/i.test(dlg);
    console.log(`[DRW-27] closed-session pill opens a NEW open modal; offers reopen? ${offersReopen}`);
    await closeDialogs().catch(() => undefined);
    const sameId = one<Row>('SELECT status FROM cash_sessions WHERE id = ?', sid);
    expect(String(sameId?.status)).toBe('CLOSED');
    console.log('[N/A DRW-27] there is no reopen/reverse-close command or UI; a CLOSED session is terminal (no UPDATE back to OPEN anywhere in shiftAdapter.ts). Re-opening creates a new id (verified by the modal text and the row).');
    expect(reopenCode.length === 0 && !offersReopen).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // DRW-28 — denomination entry parity mobile/desktop
  // ---------------------------------------------------------------------------
  it('[DRW-28] denomination entry from mobile closes exactly like desktop (5×2000 + 1×500)', async () => {
    const sid = await d2Open(DE, 10000);
    await makeCashSale('REF3 P500', 1);
    await d2CloseReceipt();
    await d2Mobile();
    const closeClicked = await d2Click('^Clôturer$');
    expect(closeClicked).toBe(true);
    await (await $(tid('shift-close-dialog'))).waitForDisplayed({ timeout: 20000 });
    const toggled = await clickButtonByText(/Détail par Coupure/);
    expect(toggled).toBe(true);
    await browser.pause(400);
    const applied = (await browser.execute((map: Record<string, number>) => {
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
      const inputs = ([...document.querySelectorAll('input[type="number"]')] as HTMLInputElement[]).filter((i) => vis(i));
      const order = ['2000', '1000', '500', '200', '100', '50', '20', '10', '5'];
      if (inputs.length < order.length) return `only ${inputs.length} number inputs visible`;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      order.forEach((den, idx) => {
        const el = inputs[idx];
        const v = map[den] ?? 0;
        setter?.call(el, v > 0 ? String(v) : '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return `filled ${order.length} denominations`;
    }, { '2000': 5, '500': 1 })) as string;
    console.log(`[DRW-28] mobile denomination grid: ${applied}`);
    expect(applied).toContain('filled 9');
    await browser.pause(400);
    await (await $(tid('shift-blind-next'))).click();
    const rec = await readReconciliation();
    expect(rec.expectedDa).toBe(10500);
    expect(rec.countedDa).toBe(10500);
    expect(rec.varianceDa).toBe(0);
    const done = await commitReconciliation();
    expect(done.zShown).toBe(true);
    const row = sessionRow(sid)!;
    console.log(`[DRW-28] mobile close by denomination: actual=${String(row.actual_cash)} expected=${String(row.expected_cash)} discrepancy=${String(row.discrepancy)} status=${String(row.status)}`);
    expect(Number(row.actual_cash)).toBe(10500);
    expect(Number(row.discrepancy)).toBe(0);
    expect(String(row.status)).toBe('CLOSED');
    console.log('[DRW-28] the same ShiftCloseModal denomination grid is used in both shells (GlobalModalHost.tsx:70-73); mobile entry parses/normalizes identically to desktop.');
    await fastDesktop();
  });

  // ---------------------------------------------------------------------------
  // DRW-29 — concurrent metadata edits
  // ---------------------------------------------------------------------------
  it('[DRW-29] concurrent drawer metadata edits: no CAS or editable metadata lane exists', async () => {
    const cas = grepRepoFiles('src/db/adapters', /WHERE id = \? AND version = \?/i);
    const switchCallers = grepRepoFiles('src', /switchCashier|setShiftCashier/);
    const uiCallers = switchCallers.filter((h) => /\.tsx$/.test(h.file) && !/store\/slices\/createShiftSlice/.test(h.file));
    console.log(`[DRW-29] compare-and-swap updates in adapters: ${cas.length}; setShiftCashier/switchCashier references: ${switchCallers.length} (UI call sites: ${uiCallers.length})`);
    const sid = await d2Open(DE, 10000);
    const v0 = Number(sessionRow(sid)?.version ?? 0);
    await d2Boot(1200);
    const v1 = Number(sessionRow(sid)?.version ?? 0);
    console.log(`[DRW-29] version across a restart: ${v0}→${v1}; all cash_sessions updates are version=version+1 WHERE id=? (no expected-version predicate).`);
    await d2CloseAny();
    console.log('[N/A DRW-29] two devices cannot edit drawer metadata concurrently through the UI: the only editable metadata at close is the free-text cashier name (ignored by closeShift) and the handover setter has no UI caller. Updates are last-writer-wins with no CAS, but there is no exposed metadata field to race.');
    expect(uiCallers.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // DRW-30 — gateway approval on close
  // ---------------------------------------------------------------------------
  it('[DRW-30] gateway approval required before a close takes effect: no pre-commit gateway exists', async () => {
    const gateway = grepRepoFiles('src', /gateway_url|syncDrainWorker|approveShiftClose|shift.*approval/i);
    const closePath = grepRepoFiles('src/db/adapters', /gateway|approveShiftClose|shift.*approval/i).filter((h) => /shiftAdapter\.ts$/i.test(h.file));
    const sid = await d2Open(DE, 10000);
    const e = await peekExpected();
    const r = await closeToReconciliation(String(e));
    await commitReconciliation();
    await waitFor(() => String(sessionRow(sid)?.status ?? ''), (v) => v === 'CLOSED', 25000);
    console.log(`[DRW-30] close committed locally at variance ${r.varianceDa} with 0 gateway calls in shiftAdapter (gateway refs in close path: ${closePath.length}; repo gateway refs: ${gateway.length}).`);
    await closeDialogs().catch(() => undefined);
    console.log('[N/A DRW-30] there is no gateway client in the close path: the close is a local SQLite transaction (shiftAdapter.ts:649-935) and the signed-lane drain only ships outbox rows afterwards (proxy/gateway.mjs is a test-only loopback). No server approval can gate or veto a close.');
    expect(closePath.length).toBe(0);
  });


});
