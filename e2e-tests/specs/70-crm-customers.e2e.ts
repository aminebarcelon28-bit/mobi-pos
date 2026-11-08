/**
 * CRM - customer directory, phone identity & deletion (batch 13 / spec 70;
 * CRM-02, CRM-03, CRM-06; CRM-01/05/07/08/09/10/11/12 N/A with file:line).
 *
 * Harness identical to batch 11/12: spec 34 head (real SQLite authority,
 * real desktop POS, wipe-mode) + SHF/SEC helper blocks; only the CRM tests
 * differ. CRM-04 (credit limit, FIFO aging repayment, overpay policy,
 * P2-7 column/payload parity) is executed here; G-23 (normalized phone
 * identity) runs in afterEach via lib/invariants.ts.
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
  await clickControl('pay-confirm');
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

describe('CRM - customer directory, phone identity & deletion (batch 13)', () => {
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
    seedCustomerFull([{ id: 'CRM04-FIFO', name: 'CRM04-FIFO', phone: '0550445577', currentDebtDa: 0, debtLimitDa: 100000 }]);
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
    captureInvariantBaseline('CRM');
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
    assertInvariants(`CRM :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('CRM batch 13 (spec 70)');
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
    await clickControl('pay-confirm');
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
    await clickControl('pay-confirm');
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
    await expEl.waitForDisplayed({ timeout: 12000, timeoutMsg: 'RECONCILIATION step never appeared (shift-expected hidden)' });
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
    await (await $(tid('shift-pill'))).click();
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
    await typeReal(input, countedText, false);
    await browser.pause(250);
    await (await $(tid('shift-blind-next'))).click();
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
    await (await $(tid('shift-close-confirm'))).click();
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


﻿// CRM batch 13 part (spec 70): CRM-02, CRM-06, CRM-03.
// Appended by crm-build.cjs to the spec 34 head (before/after + helpers).

async function crmClickText(text: string): Promise<boolean> {
  return (await browser.execute((t: string) => {
    const vis = (h: HTMLElement) => {
      try { const cs = getComputedStyle(h); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; }
    };
    const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[])
      .filter(vis)
      .find(x => (x.textContent || '').replace(/\s+/g, ' ').includes(t));
    if (!b) return false;
    b.click();
    return true;
  }, text)) as boolean;
}

async function crmOpenCustomers(): Promise<void> {
  const btn = await $(tid('clients-button'));
  await btn.waitForDisplayed({ timeout: 15000 });
  await btn.click();
  await (await $(tid('customers-dialog'))).waitForDisplayed({ timeout: 20000 });
}

async function crmSetNative(selector: string, value: string): Promise<void> {
  const ok = (await browser.execute((sel: string, val: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | null;
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value)) as boolean;
  if (!ok) throw new Error(`crmSetNative: ${selector} not found`);
  await browser.pause(150);
}

async function crmAddCustomer(name: string, phone: string, debtLimit?: number): Promise<void> {
  const opened = await crmClickText('Ajouter un Client');
  if (!opened) throw new Error('CRM add button not found (Ajouter un Client)');
  await browser.waitUntil(
    async () => (await browser.execute(() => !!document.querySelector('input[data-testid="customer-name"]'))) as boolean,
    { timeout: 10000, interval: 100, timeoutMsg: 'CRM form never appeared' },
  );
  await crmSetNative('input[data-testid="customer-name"]', name);
  await crmSetNative('#customer-phone', phone);
  if (debtLimit !== undefined) {
    await crmSetNative('input[type="number"][placeholder^="0 ou vide"]', String(debtLimit));
  }
  const submitted = (await browser.execute(() => {
    const form = document.querySelector('form') as HTMLFormElement | null;
    if (!form) return false;
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (btn) { btn.click(); return true; }
    form.requestSubmit();
    return true;
  })) as boolean;
  if (!submitted) throw new Error('CRM add form/submit not found');
  await browser.waitUntil(
    async () => !!(await one<{ id: string }>('SELECT id FROM customers WHERE name = ?', name)),
    { timeout: 15000, interval: 200, timeoutMsg: `customer ${name} never landed in SQLite` },
  );
  await browser.pause(300);
}

async function crmSearch(name: string): Promise<void> {
  const ok = (await browser.execute((n: string) => {
    const el = document.querySelector('[data-testid="customer-search"]') as HTMLInputElement | null;
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setter?.call(el, n);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, name)) as boolean;
  if (!ok) throw new Error('CRM search input not found');
  await browser.pause(800);
}

async function crmCloseModal(): Promise<void> {
  const closed = (await browser.execute(() => {
    const dlg = document.querySelector('[data-testid="customers-dialog"]') as HTMLElement | null;
    if (!dlg) return true;
    const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[])
      .find(x => x.getAttribute('aria-label') === 'Fermer');
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!closed) throw new Error('CRM modal close button not found');
  await browser.waitUntil(
    async () => !(await $(tid('customers-dialog')).isDisplayed().catch(() => false)),
    { timeout: 10000, interval: 200 },
  );
}

async function crmStubDialogs(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __crmDialogs?: { alerts: string[]; confirms: string[] } };
    w.__crmDialogs = { alerts: [], confirms: [] };
    window.alert = (m?: unknown) => { w.__crmDialogs!.alerts.push(String(m ?? '')); };
    window.confirm = (m?: unknown) => { w.__crmDialogs!.confirms.push(String(m ?? '')); return true; };
    window.prompt = (m?: unknown) => { w.__crmDialogs!.confirms.push(String(m ?? '')); return 'e2e forfeit note'; };
  });
}

it('[CRM-02] phone variants (+213 / 00213 / 0xx / spaces) normalize to one canonical local number', async () => {
  await crmOpenCustomers();
  // HAR-009 (2026-11-03): the old fixture typed "0550 12 34 56" in two formats
  // but asserted 0555000000 - a different number - so the case could never
  // pass, and three rows on one number would also trip G-23 (duplicate active
  // phone). Each customer now exercises one variant of its OWN unique-per-run
  // number; the assertion compares the canonical form of the value typed.
  const seed = String(Date.now()).slice(-6);
  const nPlus = `0555${seed}`;
  const nZero = `0666${seed}`;
  const nLocal = `0777${seed}`;
  const plusTyped = `+213 ${nPlus.slice(1, 4)} ${nPlus.slice(4, 7)} ${nPlus.slice(7)}`;
  const zeroTyped = `00213 ${nZero.slice(1, 4)} ${nZero.slice(4, 7)} ${nZero.slice(7)}`;
  const localTyped = `${nLocal.slice(0, 4)} ${nLocal.slice(4, 7)} ${nLocal.slice(7)}`;
  await crmAddCustomer('CRM02-Plus', plusTyped);
  await crmAddCustomer('CRM02-Zero', zeroTyped);
  await crmAddCustomer('CRM02-Local', localTyped);
  const rows = all<{ name: string; phone: string }>(
    "SELECT name, phone FROM customers WHERE name LIKE 'CRM02-%' AND deleted = 0 ORDER BY name",
  );
  console.log(
    '[CRM-02] typed=' + JSON.stringify({ plusTyped, zeroTyped, localTyped }) + ' stored=' + JSON.stringify(rows),
  );
  expect(rows.length).toBe(3);
  const byName = new Map(rows.map((r) => [r.name, r.phone]));
  expect(byName.get('CRM02-Plus')).toBe(nPlus);
  expect(byName.get('CRM02-Zero')).toBe(nZero);
  expect(byName.get('CRM02-Local')).toBe(nLocal);
});

it('[CRM-06] one phone shared by family: two distinct customers survive, selection never mixes them, and a duplicate-phone warning is a prompt (not a block)', async () => {
  await crmOpenCustomers();
  await crmAddCustomer('CRM06-A', '0550 77 88 99');
  await crmAddCustomer('CRM06-B', '0550 77 88 99');
  const rows = all<{ id: string; name: string; phone: string }>(
    "SELECT id, name, phone FROM customers WHERE phone = '0550778899' AND deleted = 0 ORDER BY name",
  );
  console.log('[CRM-06] shared-phone rows=' + JSON.stringify(rows));
  expect(rows.length).toBe(2);
  expect(new Set(rows.map(r => r.id)).size).toBe(2);
  const duplicateWarning = (await browser.execute(() => {
    const txt = document.body.innerText || '';
    return /doublon|client existant|existe déjà|même (?:téléphone|numéro)|same phone|duplicate customer/i.test(txt);
  })) as boolean;
  console.log('[CRM-06] duplicate-warning=' + duplicateWarning);
  await crmCloseModal();
  await selectCustomer('CRM06-A');
  await browser.pause(400);
  const body = (await browser.execute(() => document.body.innerText)) as string;
  console.log('[CRM-06] selected-A=' + body.includes('CRM06-A') + ' selected-B=' + body.includes('CRM06-B'));
  expect(body).toContain('CRM06-A');
  expect(body).not.toContain('CRM06-B');
  // Encyclopedia: duplicate warning is a prompt, not a block. The build silently
  // creates both rows and never prompts, so this is the confirmed defect.
  expect(duplicateWarning).toBe(true);
});

it('[CRM-03] deletion keeps invoices but must erase/anonymize the customer PII (soft tombstone currently keeps name+phone)', async () => {
  await crmOpenCustomers();
  await crmAddCustomer('CRM03-Clean', '0550 99 00 11');
  await crmCloseModal();
  await crmStubDialogs();
  await crmOpenCustomers();
  await crmSearch('CRM03-Clean');
  const menuOpened = (await browser.execute((name: string) => {
    const vis = (h: HTMLElement) => {
      try { const cs = getComputedStyle(h); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; }
    };
    const dlg = ([...document.querySelectorAll('[data-testid="customers-dialog"]')] as HTMLElement[]).find(vis);
    if (!dlg) return false;
    const b = ([...dlg.querySelectorAll('button')] as HTMLButtonElement[])
      .find(x => x.getAttribute('aria-label') === `Plus d'actions pour ${name}`);
    if (!b) return false;
    b.click();
    return true;
  }, 'CRM03-Clean')) as boolean;
  if (!menuOpened) throw new Error('CRM03 card actions button not found');
  await browser.waitUntil(
    async () => !!(await $('[role="menuitem"][aria-label="Supprimer CRM03-Clean"]').isDisplayed().catch(() => false)),
    { timeout: 5000, interval: 100, timeoutMsg: 'CRM03 delete menu item did not appear' },
  );
  const deleted = (await browser.execute(() => {
    const b = ([...document.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[])
      .find(x => (x.getAttribute('aria-label') || '') === 'Supprimer CRM03-Clean');
    if (!b) return false;
    b.click();
    return true;
  })) as boolean;
  if (!deleted) throw new Error('CRM03 delete menu item not clickable');
  await browser.waitUntil(
    async () => Number((await one<{ deleted: number }>('SELECT deleted FROM customers WHERE name = ?', 'CRM03-Clean'))?.deleted ?? 0) === 1,
    { timeout: 15000, interval: 200, timeoutMsg: 'CRM03 tombstone never landed' },
  );
  const row = await one<{ name: string; phone: string; deleted: number; json_payload: string }>(
    'SELECT name, phone, deleted, json_payload FROM customers WHERE name = ?',
    'CRM03-Clean',
  );
  const payload = JSON.parse(String(row?.json_payload || '{}')) as Record<string, unknown>;
  console.log('[CRM-03] tombstone=' + JSON.stringify(row));
  console.log('[CRM-03] payload name/phone=' + JSON.stringify({ name: payload.name, phone: payload.phone }));
  expect(row).toBeTruthy();
  expect(Number(row!.deleted)).toBe(1);
  // Encyclopedia expectation: invoices/ledger stay, PII is erased/anonymized.
  expect(row!.name).not.toBe('CRM03-Clean');
  expect(String(row!.phone)).toBe('');
  expect(payload.name).not.toBe('CRM03-Clean');
  expect(String(payload.phone ?? '')).toBe('');
});

async function crm04ChooseCredit(): Promise<'clicked' | 'disabled' | 'missing'> {
  const result = (await browser.execute(() => {
    const vis = (h: HTMLElement) => {
      try { const cs = getComputedStyle(h); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; }
    };
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const dlg = ([...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[]).find(vis) ?? null;
    if (!dlg) return 'missing';
    const buttons = [...dlg.querySelectorAll('button')] as HTMLButtonElement[];
    // Avoid embedding the accented label in source: accept only the method
    // button whose visible span starts with "cr" and ends with "dit".
    const btn = buttons.find((b) =>
      [...b.querySelectorAll('span')].some((sp) => {
        const t = norm(sp.textContent || '').toLowerCase();
        return t.startsWith('cr') && t.endsWith('dit');
      }),
    );
    if (!btn) {
      (window as unknown as { __crm04CreditDiag?: unknown }).__crm04CreditDiag = buttons.map((b) => ({
        text: norm(b.textContent || ''),
        spans: [...b.querySelectorAll('span')].map((sp) => norm(sp.textContent || '')),
        disabled: b.disabled,
      }));
      return 'missing';
    }
    if (btn.disabled) return 'disabled';
    btn.click();
    return 'clicked';
  })) as 'clicked' | 'disabled' | 'missing';
  const diag = await browser.execute(() => (window as unknown as { __crm04CreditDiag?: unknown }).__crm04CreditDiag ?? null);
  console.log('[CRM-04] credit choose=' + result + (diag ? ' diag=' + JSON.stringify(diag) : ''));
  await browser.pause(250);
  return result;
}

async function crm04CreditCheckoutCurrent(title: string): Promise<void> {
  await clearCart();
  await addSku(title);
  const before = txCount();
  await clickControl('checkout-button');
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
  const credit = await crm04ChooseCredit();
  if (credit !== 'clicked') throw new Error('CRM-04 credit tab not usable on current-customer checkout: ' + credit);
  await clickControl('pay-confirm');
  await browser.waitUntil(async () => !(await payDialogVisible()), {
    timeout: 45000,
    timeoutMsg: 'CRM-04 second credit sale did not close the pay dialog',
  });
  await browser.waitUntil(() => txCount() > before, {
    timeout: 15000,
    interval: 200,
    timeoutMsg: 'CRM-04 second credit sale did not land a transaction',
  });
  await browser.pause(300);
}

async function crm04OpenProfile(name: string): Promise<void> {
  const opened = (await browser.execute((n: string) => {
    const vis = (h: HTMLElement) => {
      try { const cs = getComputedStyle(h); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; }
    };
    const dlg = ([...document.querySelectorAll('[data-testid="customers-dialog"]')] as HTMLElement[]).find(vis);
    if (!dlg) return false;
    const card = ([...dlg.querySelectorAll('div')] as HTMLElement[])
      .filter(vis)
      .find((el) => String(el.className).includes('cursor-pointer') && (el.textContent || '').includes(n));
    if (!card) return false;
    card.click();
    return true;
  }, name)) as boolean;
  if (!opened) throw new Error(`CRM-04 profile card not found for ${name}`);
  await browser.waitUntil(
    async () => !!(await $('button[aria-label^="Retour"]').isDisplayed().catch(() => false)),
    { timeout: 10000, interval: 200, timeoutMsg: 'CRM-04 profile did not open' },
  );
}

async function crm04OpenDebtTab(): Promise<void> {
  const clicked = (await browser.execute(() => {
    const tabs = ([...document.querySelectorAll('[role="tab"]')] as HTMLElement[]);
    const tab = tabs.find((t) => (t.textContent || '').includes('Grand Livre Dette'));
    if (!tab) return false;
    tab.click();
    return true;
  })) as boolean;
  if (!clicked) throw new Error('CRM-04 Grand Livre Dette tab not found');
  await browser.pause(400);
}

async function crm04OpenSettlement(): Promise<void> {
  const clicked = await crmClickText('Encaisser Versement');
  if (!clicked) throw new Error('CRM-04 Encaisser Versement button not found');
  await browser.waitUntil(
    async () => !!(await $('[role="dialog"][aria-label*="glement de dette"]').isDisplayed().catch(() => false)),
    { timeout: 10000, interval: 200, timeoutMsg: 'CRM-04 settlement dialog did not open' },
  );
}

async function crm04Settle(amount: number): Promise<void> {
  const input = await $('[role="dialog"][aria-label*="glement de dette"] input');
  await input.waitForDisplayed({ timeout: 5000 });
  await typeMoneyInto(input, amount);
  await browser.pause(200);
  const displayed = String(await input.getValue().catch(() => ''));
  const clicked = await crmClickText('Valider le Versement');
  if (!clicked) throw new Error('CRM-04 Valider le Versement button not found');
  console.log(`[CRM-04] settlement input requested=${amount} displayed=${displayed}`);
}

function crm04Payload(raw: unknown): Record<string, unknown> {
  try { return JSON.parse(String(raw || '{}')) as Record<string, unknown>; } catch { return {}; }
}

it('[CRM-04] credit limit, FIFO oldest-first repayment, overpay policy and P2-7 column/payload parity', async () => {
  // ---- 1. Credit ceiling is a hard refusal, not a warning-only sale ----
  await crmOpenCustomers();
  await crmAddCustomer('CRM04-Limit', '0550 44 55 66', 5000);
  await crmCloseModal();
  await selectCustomer('CRM04-Limit');
  await clearCart();
  await addSku('REF3 P1000', { times: 6 });
  const limitTxBefore = txCount();
  await clickControl('checkout-button');
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
  const creditTab = await crm04ChooseCredit();
  expect(creditTab).not.toBe('missing');
  if (creditTab === 'clicked') await clickControl('pay-confirm');
  await browser.pause(2500);
  const stillOpen = await payDialogVisible();
  const limitTxAfter = txCount();
  const limitRow = await one<{ current_debt: number; json_payload: string }>(
    'SELECT current_debt, json_payload FROM customers WHERE name = ?',
    'CRM04-Limit',
  );
  const limitPayload = crm04Payload(limitRow?.json_payload);
  console.log('[CRM-04] limit refusal open=' + stillOpen + ' txBefore=' + limitTxBefore + ' txAfter=' + limitTxAfter +
    ' debtLimit=' + JSON.stringify(limitPayload.debtLimit) + ' payloadDebt=' + JSON.stringify(limitPayload.currentDebt) +
    ' columnDebt=' + String(limitRow?.current_debt));
  expect(Number(limitPayload.debtLimit)).toBe(5000);
  expect(stillOpen).toBe(true);
  expect(limitTxAfter).toBe(limitTxBefore);
  expect(Number(limitPayload.currentDebt ?? 0)).toBe(0);
  expect(Number(limitRow?.current_debt ?? 0)).toBe(0);
  await forceClosePay();
  await clearCart();

  // ---- 2. Two dated credit sales, then a partial 1 000 DA repayment ----
  // The FIFO customer is seeded before the invariant baseline (a stable
  // identity row); the UI-created limit customer above has no debt.
  await makeCreditSale('REF3 P1000', 1, 'CRM04-FIFO');
  await browser.pause(1200);
  await crm04CreditCheckoutCurrent('REF3 P1000');
  const cid = (await one<{ id: string }>('SELECT id FROM customers WHERE name = ?', 'CRM04-FIFO'))!.id;
  const acquired = all<{ id: string; amount: number; created_at: string; due_date: string | null; json_payload: string }>(
    "SELECT id, amount, created_at, due_date, json_payload FROM customer_debts WHERE customer_id = ? AND type = 'DEBT_ACQUIRED' ORDER BY created_at, rowid",
    cid,
  );
  const afterSales = await one<{ current_debt: number; json_payload: string; store_credit: number }>(
    'SELECT current_debt, json_payload, store_credit FROM customers WHERE id = ?',
    cid,
  );
  const afterSalesPayload = crm04Payload(afterSales?.json_payload);
  console.log('[CRM-04] acquired=' + JSON.stringify(acquired.map((d) => ({ id: d.id, amount: d.amount, createdAt: d.created_at, dueDate: d.due_date }))));
  console.log('[CRM-04] P2-7 after sales column=' + String(afterSales?.current_debt) +
    ' payload=' + JSON.stringify(afterSalesPayload.currentDebt));
  expect(acquired.length).toBe(2);
  expect(acquired[0].created_at <= acquired[1].created_at).toBe(true);
  expect(Number(afterSalesPayload.currentDebt)).toBe(2000);

  await crmOpenCustomers();
  await crmSearch('CRM04-FIFO');
  await crm04OpenProfile('CRM04-FIFO');
  await crm04OpenDebtTab();
  await crm04OpenSettlement();
  await crm04Settle(1000);
  await browser.waitUntil(
    () => all<{ id: string }>("SELECT id FROM customer_debts WHERE customer_id = ? AND type = 'PAYMENT_SETTLED'", cid).length >= 1,
    { timeout: 20000, interval: 250, timeoutMsg: 'CRM-04 first repayment did not land' },
  );
  const payments1 = all<{ id: string; amount: number; balance_after: number; json_payload: string }>(
    "SELECT id, amount, balance_after, json_payload FROM customer_debts WHERE customer_id = ? AND type = 'PAYMENT_SETTLED' ORDER BY created_at, rowid",
    cid,
  );
  const pay1 = payments1[payments1.length - 1];
  const pay1Payload = crm04Payload(pay1.json_payload);
  const alloc1 = (pay1Payload.allocations || []) as Array<{ debtId: string; amount: number }>;
  const after1 = await one<{ current_debt: number; json_payload: string; store_credit: number }>(
    'SELECT current_debt, json_payload, store_credit FROM customers WHERE id = ?',
    cid,
  );
  const after1Payload = crm04Payload(after1?.json_payload);
  console.log('[CRM-04] first repayment=' + JSON.stringify({ amount: pay1.amount, balanceAfter: pay1.balance_after, allocations: alloc1 }));
  console.log('[CRM-04] P2-7 after first repayment column=' + String(after1?.current_debt) +
    ' payload=' + JSON.stringify(after1Payload.currentDebt) + ' storeCredit=' + JSON.stringify(after1Payload.storeCredit));
  expect(Number(pay1.amount)).toBe(1000);
  expect(alloc1.length).toBeGreaterThan(0);
  expect(alloc1[0].debtId).toBe(acquired[0].id);
  expect(Number(alloc1[0].amount)).toBe(1000);
  expect(Number(after1Payload.currentDebt)).toBe(1000);

  // ---- 3. Overpayment: the UI caps at the outstanding balance; no
  // negative debt and no phantom store credit must be produced. The
  // encyclopedia's "overpay -> credit" variant is therefore reported as
  // blocked/clamped rather than silently credited. ----
  await crm04OpenSettlement();
  await crm04Settle(3000);
  await browser.waitUntil(
    () => all<{ id: string }>("SELECT id FROM customer_debts WHERE customer_id = ? AND type = 'PAYMENT_SETTLED'", cid).length >= 2,
    { timeout: 20000, interval: 250, timeoutMsg: 'CRM-04 overpay attempt did not land a repayment' },
  );
  const payments2 = all<{ id: string; amount: number; balance_after: number; json_payload: string }>(
    "SELECT id, amount, balance_after, json_payload FROM customer_debts WHERE customer_id = ? AND type = 'PAYMENT_SETTLED' ORDER BY created_at, rowid",
    cid,
  );
  const pay2 = payments2[payments2.length - 1];
  const after2 = await one<{ current_debt: number; json_payload: string; store_credit: number }>(
    'SELECT current_debt, json_payload, store_credit FROM customers WHERE id = ?',
    cid,
  );
  const after2Payload = crm04Payload(after2?.json_payload);
  console.log('[CRM-04] overpay outcome=' + JSON.stringify({
    tendered: 3000,
    applied: pay2.amount,
    balanceAfter: pay2.balance_after,
    debtColumn: after2?.current_debt,
    debtPayload: after2Payload.currentDebt,
    storeCreditColumn: after2?.store_credit,
    storeCreditPayload: after2Payload.storeCredit,
  }));
  expect(Number(pay2.amount)).toBe(1000);
  expect(Number(pay2.balance_after)).toBe(0);
  expect(Number(after2Payload.currentDebt)).toBe(0);
  expect(Number(after2Payload.currentDebt)).toBeGreaterThanOrEqual(0);
  expect(Number(after2?.store_credit ?? 0)).toBe(0);
  expect(Number(after2Payload.storeCredit ?? 0)).toBe(0);
  const finalCustomerRow = await one<{ id: string }>('SELECT id FROM customers WHERE id = ?', cid);
  console.log('[CRM-04] final customer row present=' + !!finalCustomerRow);
  expect(finalCustomerRow).toBeTruthy();
  // Let the debounced customer/debt persistence settle before afterEach reads
  // the live DB; the money assertions above already passed.
  await browser.pause(2000);
});


});
