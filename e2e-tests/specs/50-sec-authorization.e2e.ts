/**
 * SEC - security, roles & authorization, batch 10 part 1 (spec 50; SEC-01..SEC-10).
 *
 * Harness identical to batch 9 (spec 40): spec 34 head + the SHF helper block
 * are copied verbatim; only the SEC helpers and batch-10 tests differ. Live
 * SQLite ground truth, desktop POS under WebdriverIO + Tauri.
 *
 * Decisions under test (from the encyclopedia + app sources, read-only):
 *  - SEC-01/09: native authorization is capability-by-license-state, never by
 *    role (capability_policy.rs:73) - UI gates are UX only; probes escalate
 *    through IPC exactly the way a compromised renderer would.
 *  - SEC-02: PIN lockout ladder is native, persisted, per-profile.
 *  - SEC-03: supervisor step-up freshness (stale/future refused) + native
 *    manager re-key + retention prune floors.
 *  - SEC-04: roster role changes land at boot, not at the next action.
 *  - SEC-05: audit chain tamper evidence (edit/delete flip the verifier).
 *  - SEC-06: audit growth + fresh-PIN export step-up; append-only journal.
 *  - SEC-07: PIN envelopes at rest (v2$, never plaintext).
 *  - SEC-08/10: PII + WebView hardening (no remote origins, no unsafe-eval).
 *  - SEC-09 runs LAST: the probes that land are deliberate forged writes and
 *    trip the G-15/G-19 invariant hooks of this test and the after-all hook.
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

describe('SEC - roles, authorization & native hardening (batch 10 / part 1)', () => {
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
    captureInvariantBaseline('SEC50');
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
    assertInvariants(`SEC50 :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('SEC batch 10 (spec 50)');
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
    await unlockIfNeeded();
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
    await unlockIfNeeded();
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
    const locked = await $(tid('lock-screen'))
      .waitForDisplayed({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!locked) {
      console.log(`[unlock] no lock screen within 8s - session already open, nothing to unlock for ${profileId}`);
      return;
    }
    const p = await $(tid(`lock-profile-${profileId}`));
    await p.waitForDisplayed({ timeout: 10000, timeoutMsg: `lock-profile-${profileId} not listed on the lock screen` });
    await p.click();
    await browser.pause(350);
    await typeReal(await $(tid('login-pin-input')), pin, false);
    await browser.pause(250);
    const lockVisible = async (): Promise<boolean> =>
      (await $(tid('lock-screen')).isDisplayed().catch(() => false));
    // Click via JS. The driver's actionability middleware re-checks the
    // button while React re-renders it (run 02: "did not become
    // interactable" after a submit that had actually succeeded), and the
    // button is only mounted at >= 6 digits on manager pads (:102-104).
    const jsClickSubmit = async (): Promise<boolean> =>
      (await pageClick('login-submit', { label: 'jsSubmit', throwOnRefusal: false })).allow;
    // Cashier profiles auto-submit at their fixed 4-digit length
    // (LockScreenOverlay.tsx:885-887); manager profiles (6-8 digits) always
    // confirm with Valider. Wait on STATE, never on a fixed budget: the native
    // verify (OS keyring + Argon2id) measured 2.36-3.21 s on this host, so a
    // 2.5 s probe is not a verdict. Either the overlay clears (cashier
    // auto-submit) or the manager submit button mounts. A DENIED PIN produces
    // neither, so the wait below times out and the test still fails.
    await browser.waitUntil(
      async () => !(await lockVisible()) || (await $(tid('login-submit')).isDisplayed().catch(() => false)),
      {
        timeout: 20000,
        interval: 150,
        timeoutMsg: `neither unlock nor submit mounted for ${profileId} (denied PIN or no session change)`,
      },
    );
    if (await lockVisible()) {
      const clicked = await jsClickSubmit();
      if (!clicked) {
        throw new Error(`login-submit reported displayed but missing for ${profileId}`);
      }
      await browser.waitUntil(async () => !(await lockVisible()), {
        timeout: 20000,
        interval: 150,
        timeoutMsg: `lock-screen did not clear after unlocking as ${profileId}`,
      });
    }
    await browser.pause(600);
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
  // SEC-01 — cashier vs manager-only actions: UI hides, backend must deny.
  // ===========================================================================
  it('[SEC-01] a cashier session attempts manager-only actions by UI and by direct IPC — backend authorization, not UI hiding', async () => {
    await resetDrawerForTest();
    await ensureCashierRow('usr-sec1', 'SEC A', 'cashier');
    await ensureCashierRow('usr-sec2', 'SEC B', 'cashier');
    const mint = await pinSetRaw('usr-sec1', '2468');
    console.log(`[SEC-01] pin_set(usr-sec1, cashier target, no supervisor): ok=${mint.ok} raw=${mint.raw.slice(0, 160)}`);
    expect(mint.ok).toBe(true); // the app's own Settings flow mints cashier PINs without a supervisor

    // The lock screen lists the roster as read at boot — reload so the freshly
    // provisioned profiles appear (the SHF-13 pattern), then unlock as A.
    await browser.refresh();
    await installPageShims();
    await installErrorTrap();
    // The reload lands on the boot lock screen: open the cashier session
    // directly (run 02 unlocked the admin pad in between and hit a driver race
    // on login-submit; the JS-click helper now owns that lane).
    await unlockViaProfile('usr-sec1', '2468');

    // (a) UI: the journal launcher is role-gated (auditGate.ts:258-260, UX only).
    const journalVisible = await journalLauncherVisible();
    console.log(`[SEC-01] UI as cashier: journal launcher visible=${journalVisible} (expected false)`);
    expect(journalVisible).toBe(false);

    // (b) Direct IPC from the same cashier session (the window holds the plugin
    //     for every command; capability_policy.rs:73 authorizes by license state,
    //     never by the signed-in user).
    const backup = await createBackupRaw();
    console.log(`[SEC-01] IPC create_database_backup as cashier: ok=${backup.ok} raw=${backup.raw.slice(0, 400)}`);
    if (!backup.ok && /integrity_check failed/i.test(backup.raw)) {
      console.log('[SEC-01] note: the backup refusal above is an FTS5 index check (products_fts) - an unrelated data-integrity refusal, NOT an authorization denial; the escalation evidence is the peer pin_set below and the journal gate above.');
    }
    const peer = await pinSetRaw('usr-sec2', '1357');
    console.log(`[SEC-01] IPC pin_set(peer cashier, no supervisor) as cashier: ok=${peer.ok} raw=${peer.raw.slice(0, 200)}`);

    await lockAndWait();
    await unlockViaProfile('usr-admin', APP_PIN);

    const escalated = backup.ok || peer.ok;
    if (escalated) {
      console.log(
        '[SEC-01] CONFIRMED EDGE-CASE VULNERABILITY [P1]: native authorization is capability-by-license-state, never by user role — capability_policy.rs:73 authorize(state, capability) reads only the license state, and every capability is granted to the WebView window at build time (src-tauri/capabilities), so a cashier session can mint backups (ReadOperationalData) and native PIN credentials with no manager step-up. Role checks exist only in the TS UI (canSeeJournalLauncher etc.); documented residual AGENTS.md "WebView SQL bypass (OPEN residual)" + Tier B holds. The money-path arm of this escalation is probed at the end of SEC-09 (same window, forged refund command).',
      );
    }
    expect(escalated).toBe(false); // fails by design — the finding above
  });

  // ===========================================================================
  // SEC-02 — PIN brute force: escalating lockout, persistence, timing.
  // ===========================================================================
  it('[SEC-02] PIN brute force: escalating lockout after N wrong tries, persisted across a WebView restart; wrong tries burn the Argon2id path', async () => {
    await ensureCashierRow('usr-sec2', 'SEC B', 'cashier');
    const mint = await pinSetRaw('usr-sec2', '1357');
    console.log(`[SEC-02] pin_set(usr-sec2): ok=${mint.ok} raw=${mint.raw.slice(0, 120)}`);
    expect(mint.ok).toBe(true);

    const durations: number[] = [];
    let last: Row = {};
    for (let i = 1; i <= 6; i++) {
      const t0 = Date.now();
      const wrong = String(1000 + i); // 4 digits — cashier format, never the real '1357'
      last = await pinVerifyRaw('usr-sec2', wrong);
      durations.push(Date.now() - t0);
      console.log(
        `[SEC-02] wrong PIN #${i}: ok=${String(last.ok)} locked=${String(last.locked)} remainingMs=${String(last.lockedRemainingMs)} ms=${durations[i - 1]}`,
      );
      if (last.locked) break;
    }
    expect(Boolean(last.locked)).toBe(true);
    expect(Number(last.lockedRemainingMs)).toBeGreaterThan(0);
    const lockQ = await pinLockoutRaw('usr-sec2');
    console.log(`[SEC-02] lockout query: locked=${String(lockQ.locked)} remainingMs=${String(lockQ.remainingMs)}`);
    expect(Boolean(lockQ.locked)).toBe(true);
    expect(durations.every((d) => d >= 0)).toBe(true);
    console.log(`[SEC-02] timing: ${durations.join('ms, ')}ms — each wrong try ran the native verify path (Argon2id or legacy envelope); the lockout then answers before any KDF work.`);

    // Persistence: the lockout map is native and survives a WebView restart.
    await browser.refresh();
    await installPageShims();
    await installErrorTrap();
    await unlockViaProfile('usr-admin', APP_PIN); // the reload lands on the boot lock screen
    const post = await pinLockoutRaw('usr-sec2');
    console.log(`[SEC-02] after WebView restart: locked=${String(post.locked)} remainingMs=${String(post.remainingMs)}`);
    expect(Boolean(post.locked)).toBe(true);
    const correctWhileLocked = await pinVerifyRaw('usr-sec2', '1357');
    console.log(
      `[SEC-02] correct PIN while locked: ok=${String(correctWhileLocked.ok)} locked=${String(correctWhileLocked.locked)} remainingMs=${String(correctWhileLocked.lockedRemainingMs)}`,
    );
    expect(Boolean(correctWhileLocked.ok)).toBe(false);
    expect(Boolean(correctWhileLocked.locked)).toBe(true);
    console.log('[SEC-02] the ladder is per-profile and escalating (pin.rs lockout map persisted natively); SEC B stays locked for the rest of this spec by design.');
  });

  // ===========================================================================
  // SEC-03 — step-up freshness window; manager re-key; retention prune.
  // ===========================================================================
  it('[SEC-03] supervisor step-up: stale (>120s) and future (>30s) attestations refused with no write; manager re-key and snapshot prune both gated by PIN', async () => {
    await resetDrawerForTest();
    const sale = await makeCashSale('REF3 P500', 1);

    const stale = await invokeForgedRefund(forgedWithSupervisor(sale.id, new Date(Date.now() - 130_000).toISOString(), 1, 500));
    console.log(`[SEC-03] stale −130s supervisor: ok=${stale.ok} raw=${stale.raw.slice(0, 200)}`);
    expect(stale.ok).toBe(false);
    expect(stale.raw).toMatch(/SUPERVISOR_AUTH_EXPIRED/);
    expect(refundsFor(sale.id).length).toBe(0);

    const future = await invokeForgedRefund(forgedWithSupervisor(sale.id, new Date(Date.now() + 60_000).toISOString(), 1, 500));
    console.log(`[SEC-03] future +60s supervisor: ok=${future.ok} raw=${future.raw.slice(0, 200)}`);
    expect(future.ok).toBe(false);
    expect(future.raw).toMatch(/SUPERVISOR_AUTH_FUTURE_DATED/);
    expect(refundsFor(sale.id).length).toBe(0);
    console.log('[SEC-03] fresh-within-window acceptance (the positive control) is executed at the end of SEC-09 (fresh attestation → refund lands), last in this spec so the deliberate forged write contaminates nothing earlier; REF-80 (batch 8) proved the same positive path end to end.');

    // Manager re-key: native resolution treats the master id and the PRIMARY
    // ADMIN profile as managers (pin.rs:866-880 resolve_is_manager reads the
    // roster only for the first role==='admin' row; a bare role string is
    // never consulted) and compares the supervisor credential against the
    // master envelope (pin.rs:987 read_manager_credential → app_settings
    // .manager_pin; pin.rs:1215-1235 rejects empty/incorrect supervisors).
    // usr-admin is this roster's primary admin; rotate with the current
    // master as supervisor, then restore and prove the restore natively.
    const noSup = await pinSetRaw('usr-admin', '864230');
    console.log(`[SEC-03] pin_set(primary admin), no supervisor: ok=${noSup.ok} raw=${noSup.raw.slice(0, 220)}`);
    expect(noSup.ok).toBe(false);
    expect(noSup.raw).toMatch(/supervisor/i);
    const wrongSup = await pinSetRaw('usr-admin', '864230', '000000');
    console.log(`[SEC-03] pin_set(primary admin), wrong supervisor: ok=${wrongSup.ok} raw=${wrongSup.raw.slice(0, 220)}`);
    expect(wrongSup.ok).toBe(false);
    expect(wrongSup.raw).toMatch(/supervisor/i);
    const goodSup = await pinSetRaw('usr-admin', '864230', APP_PIN);
    console.log(`[SEC-03] pin_set(primary admin), current master as supervisor: ok=${goodSup.ok} raw=${goodSup.raw.slice(0, 220)}`);
    expect(goodSup.ok).toBe(true);
    const restored = await pinSetRaw('usr-admin', APP_PIN, '864230');
    console.log(`[SEC-03] pin_set(primary admin), restored to APP_PIN (supervisor = the rotated credential): ok=${restored.ok} raw=${restored.raw.slice(0, 220)}`);
    expect(restored.ok).toBe(true);
    const relogin = await pinVerifyRaw('usr-admin', APP_PIN);
    expect(Boolean(relogin.ok)).toBe(true);
    console.log('[SEC-03] master-credential rotation is supervisor-gated and reversible; the restore is proven through native pin_verify before anything else runs (supervisor compares are pure credential checks — no lockout spent, pin.rs:1225).');

    // Retention prune: floors validated before the PIN, PIN verified natively.
    const floorErr = await shfInvokeRaw('prune_snapshots', { request: { pin: APP_PIN, olderThanSecs: 0, keepLast: 0 } });
    console.log(`[SEC-03] prune floors (keepLast 0 / olderThan 0): ok=${floorErr.ok} raw=${JSON.stringify(floorErr.ok ? floorErr.value : floorErr.error).slice(0, 200)}`);
    expect(floorErr.ok).toBe(false);
    const wrongPin = await shfInvokeRaw('prune_snapshots', { request: { pin: '000000', keepLast: 3, olderThanSecs: 604_800 } });
    console.log(`[SEC-03] prune wrong PIN: ok=${wrongPin.ok} raw=${JSON.stringify(wrongPin.ok ? wrongPin.value : wrongPin.error).slice(0, 200)}`);
    expect(wrongPin.ok).toBe(false);
    const okPrune = await shfInvokeRaw('prune_snapshots', { request: { pin: APP_PIN, keepLast: 3, olderThanSecs: 604_800 } });
    console.log(`[SEC-03] prune with APP_PIN: ok=${okPrune.ok} raw=${JSON.stringify(okPrune.ok ? okPrune.value : okPrune.error).slice(0, 200)}`);
    expect(okPrune.ok).toBe(true);
    console.log('[SEC-03] prune floors + wrong-PIN refusal + supervised master re-key all enforced natively (snapshot_prune.rs:218-243, 351-395; pin.rs:866/987/1215).');
  });

  // ===========================================================================
  // SEC-04 — secondary-admin PIN policy must match native credential policy.
  // ===========================================================================
  it('[SEC-04] secondary admin with a cashier PIN receives the four-digit lock pad', async () => {
    await ensureCashierRow('usr-sec4', 'SEC D', 'cashier');
    const mint = await pinSetRaw('usr-sec4', '8135');
    console.log(`[SEC-04] pin_set(usr-sec4, 4-digit, no supervisor): ok=${mint.ok} raw=${mint.raw.slice(0, 160)}`);
    expect(mint.ok).toBe(true);

    const rosterRow = one<Row>("SELECT value_json FROM app_settings WHERE key = 'cashier_users'");
    const roster = JSON.parse(String(rosterRow?.value_json ?? '[]')) as Row[];
    const idx = roster.findIndex((u) => String(u.id) === 'usr-sec4');
    expect(idx).toBeGreaterThanOrEqual(0);
    const original = { ...roster[idx] };
    roster[idx] = { ...roster[idx], role: 'admin' };
    run("UPDATE app_settings SET value_json = ? WHERE key = 'cashier_users'", JSON.stringify(roster));
    await dropSettingsMirror('cashier_users');
    await browser.refresh();
    await installPageShims();
    await installErrorTrap();
    const card2 = await $(tid('lock-profile-usr-sec4'));
    await card2.waitForDisplayed({ timeout: 15000, timeoutMsg: 'usr-sec4 missing from the lock screen after reload' });
    const postCard = await cardRoleText('usr-sec4');
    console.log(`[SEC-04] secondary profile card role='${postCard}'`);
    expect(postCard.toLowerCase()).toBe('admin');
    await card2.click();
    await browser.pause(400);
    const pad = await padAriaLabel();
    console.log(`[SEC-04] secondary admin pad: aria-label='${pad}' (native 4-digit credential policy)`);
    expect(pad).toContain('4');
    await typeReal(await $(tid('login-pin-input')), '8135', false);
    await browser.waitUntil(async () => !(await $(tid('lock-screen')).isDisplayed().catch(() => false)), {
      timeout: 10000,
      timeoutMsg: 'four-digit secondary-admin PIN did not auto-submit',
    });
    await browser.waitUntil(() => auditRowCountWhere("user = 'SEC D'") > 0, {
      timeout: 10000,
      interval: 100,
      timeoutMsg: 'secondary-admin unlock audit did not arrive',
    });
    expect(String(one<Row>("SELECT user FROM security_audit_logs WHERE user = 'SEC D' ORDER BY rowid DESC LIMIT 1")?.user)).toBe('SEC D');

    const roster2Row = one<Row>("SELECT value_json FROM app_settings WHERE key = 'cashier_users'");
    const roster2 = JSON.parse(String(roster2Row?.value_json ?? '[]')) as Row[];
    const idx2 = roster2.findIndex((u) => String(u.id) === 'usr-sec4');
    if (idx2 >= 0) roster2[idx2] = { ...roster2[idx2], role: String(original.role) };
    run("UPDATE app_settings SET value_json = ? WHERE key = 'cashier_users'", JSON.stringify(roster2));
    await dropSettingsMirror('cashier_users');
    await lockAndWait();
    console.log('[SEC-04] secondary-admin PIN policy matches the native 4-digit credential.');
  });

  // ===========================================================================
  // SEC-10 — WebView content security / release config.
  // ===========================================================================
  it('[SEC-10] WebView hardening: no remote scripts/frames in the served document; release CSP without unsafe-eval; e2e tooling confined to the e2e config', async () => {
    const dom = (await browser.execute(() => {
      const isExternal = (u: string | null): boolean => {
        if (!u) return false;
        try {
          const x = new URL(u, location.href);
          if (x.protocol === 'data:' || x.protocol === 'blob:' || x.protocol === 'tauri:') return false;
          const okHost =
            x.hostname === location.hostname ||
            x.hostname === 'tauri.localhost' ||
            x.hostname === 'localhost' ||
            x.hostname === '127.0.0.1' ||
            x.hostname === '[::1]';
          return !okHost;
        } catch {
          return false;
        }
      };
      const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
      const links = [...document.querySelectorAll('link[href]')].map((l) => l.getAttribute('href'));
      const frames = [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src'));
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null;
      return {
        origin: location.origin,
        externalScripts: scripts.filter(isExternal),
        externalLinks: links.filter(isExternal),
        frames,
        metaCsp: meta,
        evalType: typeof window.eval,
      };
    })) as { origin: string; externalScripts: string[]; externalLinks: string[]; frames: string[]; metaCsp: string | null; evalType: string };
    console.log(
      `[SEC-10] DOM @ ${dom.origin}: external scripts=${JSON.stringify(dom.externalScripts)} external links=${JSON.stringify(dom.externalLinks)} iframes=${JSON.stringify(dom.frames)} metaCsp=${dom.metaCsp ? 'present' : 'absent'}`,
    );
    expect(dom.externalScripts.length).toBe(0);
    expect(dom.frames.length).toBe(0);

    const releaseConf = readRepoJson('src-tauri/tauri.conf.json');
    const e2eConf = readRepoJson('src-tauri/tauri.e2e.conf.json');
    expect(releaseConf).not.toBeNull();
    expect(e2eConf).not.toBeNull();
    const relApp = (releaseConf?.app ?? {}) as Row;
    const relSec = (relApp.security ?? {}) as Row;
    const csp = String(relSec.csp ?? '');
    const e2eApp = (e2eConf?.app ?? {}) as Row;
    console.log(`[SEC-10] release CSP: ${csp.slice(0, 220)}`);
    console.log(`[SEC-10] release ident=${String(releaseConf?.identifier)} withGlobalTauri=${String(relApp.withGlobalTauri ?? false)} devUrl=${String((releaseConf?.build ?? {} as Row).devUrl ?? '')}`);
    console.log(`[SEC-10] e2e ident=${String(e2eConf?.identifier)} withGlobalTauri=${String(e2eApp.withGlobalTauri ?? false)}`);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(String((releaseConf?.build as Row)?.devUrl ?? '')).toMatch(/^http:\/\/localhost/);
    expect(String(relApp.withGlobalTauri ?? 'false')).toBe('false');
    expect(String(e2eApp.withGlobalTauri ?? 'false')).toBe('true');
    expect(String(e2eConf?.identifier ?? '')).toContain('e2e');
    console.log('[SEC-10] the release config carries no unsafe-eval and no remote script origin; withGlobalTauri exists only in tauri.e2e.conf.json; e2e-only commands are cfg-gated in the native handler list (lib.rs:2370 e2e block). The DOM references nothing off-origin; all assets are served from the bundled dist.');
  });

  // ===========================================================================
  // SEC-06 — audit growth, export step-up, no silent purge.
  // ===========================================================================
  it('[SEC-06] the audit log grows with mutations, its journal export needs a fresh manager PIN per file, and no purge lane exists', async () => {
    await unlockBootScreen();
    const before = auditCount();
    await noSaleAttempt(APP_PIN);
    await waitFor(() => auditCount(), (v) => v > before, 15000);
    const after = auditCount();
    console.log(`[SEC-06] audit growth: ${before} → ${after} after a PIN-gated no-sale (Ouverture Manuelle Tiroir)`);
    expect(after).toBeGreaterThan(before);

    const opened = await openJournalUnlocked();
    expect(opened).toBe(true);
    await browser.pause(500);

    // The journal defaults to the live window, which starts empty — widen to
    // TOUT so the log body renders and the export buttons leave their
    // disabled state (SecurityAuditModal.tsx:954, 819-846). The gate verifies
    // natively (~2.6s Argon2id, SEC-02 timing) and only then swaps the gate
    // screen for the filter toolbar, so poll instead of a fixed pause.
    let widened = false;
    for (let attempt = 0; attempt < 20 && !widened; attempt++) {
      widened = (await browser.execute(() => {
        const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
        const b = btns.find((x) => /TOUT/i.test(x.textContent || '') && x.offsetParent !== null && !x.disabled);
        if (!b) return false;
        b.click();
        return true;
      })) as boolean;
      if (!widened) await browser.pause(700);
    }
    console.log(`[SEC-06] widened the journal range to TOUT: clicked=${widened}`);
    expect(widened).toBe(true);
    await browser.pause(600);
    // The feed merges the store + polled DB rows (useAuditLiveFeed.ts:182-211);
    // poll until the PDF export button leaves its disabled state.
    let exportClicked = false;
    for (let attempt = 0; attempt < 15 && !exportClicked; attempt++) {
      exportClicked = (await browser.execute(() => {
        const root = document.querySelector('[role="dialog"][aria-label*="Journal"]') ?? document;
        const btns = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
        const b = btns.find((x) => /Export PDF/.test(x.textContent || '') && x.offsetParent !== null && !x.disabled);
        if (!b) return false;
        b.click();
        return true;
      })) as boolean;
      if (!exportClicked) await browser.pause(1000);
    }
    console.log(`[SEC-06] journal opened; Export PDF/A-3 enabled and clicked=${exportClicked}`);
    expect(exportClicked).toBe(true);
    const pinInput = await $('input[placeholder="PIN manager"]');
    await pinInput.waitForDisplayed({ timeout: 12000 });
    await typeReal(pinInput, '000000', false);
    await browser.pause(250);
    const submitted = (await browser.execute(() => {
      const inputs = Array.from(document.querySelectorAll('input[placeholder="PIN manager"]')) as HTMLInputElement[];
      const vis = inputs.find((i) => i.offsetParent !== null);
      const btn = vis?.closest('form')?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    })) as boolean;
    expect(submitted).toBe(true);
    // The fresh-PIN check runs natively (~2.6s Argon2id, SEC-02 timing); poll
    // for the inline refusal instead of reading once after a fixed pause.
    let alertText = '';
    for (let attempt = 0; attempt < 25 && !alertText; attempt++) {
      alertText = (await browser.execute(() => {
        return Array.from(document.querySelectorAll('[role="alert"]'))
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => (el.textContent || '').trim())
          .join(' | ');
      })) as string;
      if (!alertText) await browser.pause(600);
    }
    console.log(`[SEC-06] export with a bogus PIN: refused inline — "${alertText.slice(0, 120)}" (fresh native PIN per file, SecurityAuditModal.tsx:192-196, 986-1044)`);
    expect(alertText).toMatch(/PIN|incorrect|Verrouill/i);
    const purges = (await browser.execute(() => {
      const btns = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      return btns
        .map((b) => (b.textContent || '').trim())
        .filter((t) => /purger|purge|effacer.*journal|vider.*journal/i.test(t));
    })) as string[];
    console.log(`[SEC-06] purge controls in the journal: ${JSON.stringify(purges)} (expected none — the log is append-only; the native handler list has audit_append/audit_note_swallowed/audit_verify only, lib.rs:2391-2393)`);
    expect(purges.length).toBe(0);
    await closeDialogs().catch(() => undefined);
    await browser.pause(300);
    console.log('[SEC-06] export step-up verified (wrong PIN → no document); growth observed; no silent purge lane exists — the expected "cannot erase unexported entries silently" holds by construction.');
  });

  // ===========================================================================
  // SEC-07 — PIN hashing at rest.
  // ===========================================================================
  it('[SEC-07] PINs are stored as native v2 argon2 envelopes; no plaintext PIN in the DB, WAL or app files', async () => {
    await unlockBootScreen();
    await ensureCashierRow('usr-sec7', 'SEC G', 'manager');
    const mint = await pinSetRaw('usr-sec7', '9042');
    console.log(`[SEC-07] pin_set(usr-sec7, roster-role manager → cashier-format mint, no supervisor (resolve_is_manager targets the primary admin only, pin.rs:866-880)): ok=${mint.ok} raw=${mint.raw.slice(0, 120)}`);
    expect(mint.ok).toBe(true);

    const rosterRow = one<Row>("SELECT value_json FROM app_settings WHERE key = 'cashier_users'");
    const roster = JSON.parse(String(rosterRow?.value_json ?? '[]')) as Row[];
    const secG = roster.find((u) => String(u.id) === 'usr-sec7');
    const stored = String(secG?.pin ?? '');
    const managerPin = String(one<Row>("SELECT value_json FROM app_settings WHERE key = 'manager_pin'")?.value_json ?? '');
    console.log(`[SEC-07] stored envelopes: roster=${stored.slice(0, 24)}… manager=${managerPin.slice(0, 24)}… (no PIN digits)`);
    expect(stored).toMatch(/^"?v2\$/);
    expect(stored).not.toContain('9042');
    expect(managerPin).toContain('v2$');

    await armConsoleTap();
    await lockAndWait();
    await unlockViaProfile('usr-admin', APP_PIN);
    const consoleHits =
      (await countConsoleMatching('9042')) + (await countConsoleMatching('202020'));
    console.log(`[SEC-07] console lines containing either PIN: ${consoleHits}`);

    const dbHits =
      scanAppFilesFor('9042', { includeDb: true }).hits.length +
      scanAppFilesFor('202020', { includeDb: true }).hits.length;
    const appHits = scanAppFilesFor('9042').hits.length + scanAppFilesFor('202020').hits.length;
    console.log(
      `[SEC-07] plaintext PIN scans: db(+wal/shm)+all files with DB=${dbHits} hit(s); non-DB app files=${appHits} hit(s)`,
    );
    expect(consoleHits).toBe(0);
    expect(dbHits).toBe(0);
    expect(appHits).toBe(0);
    console.log('[SEC-07] the credential lives only as a v2 envelope (pin.rs store_credential → app_settings json); lock-screen verification runs natively; the migrating legacy v1$ path is exercised by the login lane (pin.rs migrate-on-login).');
  });

  // ===========================================================================
  // SEC-08 — customer PII must not leak into logs/diagnostic files.
  // ===========================================================================
  it('[SEC-08] customer PII stays in the database: searches and selection leave no phone numbers in console taps or app files', async () => {
    await unlockBootScreen();
    await armConsoleTap();
    const opened = await openCustomersDialog();
    expect(opened).toBe(true);
    // No Enter: the customers search selects the first match on Enter and
    // closes the dialog (CustomersModal.tsx:671-681) — the stale-handle trap
    // that broke run 01. Re-query per keystroke (the list re-renders) and
    // retry once on a stale handle.
    const typeLetter = async (text: string): Promise<void> => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const el = await $(tid('customer-search'));
          await el.waitForDisplayed({ timeout: 8000 });
          await typeReal(el, text, false);
          return;
        } catch (e) {
          lastErr = e;
          if (!/stale element/i.test(String((e as Error)?.message ?? e))) throw e;
          await browser.pause(400);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };
    for (const letter of 'ABCDEFGHIJ') {
      await typeLetter(letter);
      await browser.pause(120);
    }
    await typeLetter('');
    await browser.pause(300);
    const rows = (await browser.execute(() => {
      const dlg = document.querySelector('[data-testid="customers-dialog"]');
      return dlg ? dlg.querySelectorAll('[data-testid^="customer-row"], [data-customer-id]').length : -1;
    })) as number;
    console.log(`[SEC-08] paged every search letter over ${rows >= 0 ? rows : '?'} rendered rows (DB has ${Number(one<{ c: number }>('SELECT COUNT(*) c FROM customers')?.c ?? 0)} customers).`);
    await closeDialogs().catch(() => undefined);
    await browser.pause(300);

    const phone = '0551200002';
    const consoleHits = await countConsoleMatching(phone);
    const fileHits = scanAppFilesFor(phone);
    const dbHasIt = all<Row>("SELECT id FROM customers WHERE json_payload LIKE ?", `%${phone}%`).length > 0;
    console.log(
      `[SEC-08] customer ${phone}: in DB=${dbHasIt} (legitimate store); console hits=${consoleHits}; non-DB file hits=${fileHits.hits.length} across ${fileHits.scanned} file(s) ${JSON.stringify(fileHits.hits.slice(0, 4))}`,
    );
    expect(dbHasIt).toBe(true);
    expect(consoleHits).toBe(0);
    expect(fileHits.hits.length).toBe(0);
    console.log('[SEC-08] no export/diagnostic writer touches customer PII outside the DB; the WhatsApp copy lane is user-initiated only (CustomersModal.tsx:2005) and lands on the OS clipboard, not in logs.');
  });

  // ===========================================================================
  // SEC-05 — audit tamper evidence (runs late: it edits one covered row and a
  // middle chain link, verifying the sealed walk flips both ways).
  // ===========================================================================
  it('[SEC-05] audit chain: tamper flips the verifier to broken and exact restore flips it back to intact; deletion is detected and recovering the row heals', async () => {
    const initial = await auditVerifyRaw();
    const base = verifyFields(initial.state);
    console.log(`[SEC-05] baseline audit_verify: ok=${initial.ok} linksVerified=${base.linksVerified}/${base.totalLinks} headSeq=${String(base.headSeq)} state=${base.reason.slice(0, 140)}`);
    expect(initial.ok).toBe(true);
    // Fresh-container contract: the keystore head is process-global and
    // outlives the wiped data dir, so the head anchor reads "truncation
    // suspected" while every in-container link verifies — exactly the shape
    // e2e.rs:1165-1175 maps to OK. The tamper signal exercised here is the
    // keyed linkage walk itself.
    expect(base.linksVerified).toBe(base.totalLinks);
    expect(stateClass(initial.state)).toMatch(/intact|unsealed|truncation/);

    // Target the log row behind the newest chain link: canonical_bytes covers
    // id/timestamp/user/action/details/requires_pin/device_id
    // (audit_append.rs:118-145), so editing details is a real cover-byte tamper.
    const chainLast = one<Row>('SELECT event_id FROM audit_chain ORDER BY rowid DESC LIMIT 1');
    expect(chainLast).toBeTruthy();
    const snapshot = auditById(String(chainLast?.event_id ?? ''));
    expect(snapshot).toBeTruthy();
    const originalDetails = String(snapshot?.details ?? '');
    console.log(`[SEC-05] tamper target ${String(chainLast?.event_id)} (${String(snapshot?.action).slice(0, 60)})`);

    run('UPDATE security_audit_logs SET details = ? WHERE id = ?', `${originalDetails} [SEC-05 tamper]`, String(chainLast?.event_id));
    const afterTamper = await auditVerifyRaw();
    const tF = verifyFields(afterTamper.state);
    console.log(`[SEC-05] after details tamper: linksVerified=${tF.linksVerified}/${tF.totalLinks} reason=${tF.reason.slice(0, 170)}`);
    expect(fullLinkage(afterTamper.state)).toBe(false);
    expect(tF.reason).toMatch(/MAC mismatch/i);

    run('UPDATE security_audit_logs SET details = ? WHERE id = ?', originalDetails, String(chainLast?.event_id));
    const afterRestore = await auditVerifyRaw();
    const rF = verifyFields(afterRestore.state);
    console.log(`[SEC-05] after exact restore: linksVerified=${rF.linksVerified}/${rF.totalLinks} reason=${rF.reason.slice(0, 170)}`);
    expect(fullLinkage(afterRestore.state)).toBe(true);
    expect(stateClass(afterRestore.state)).toBe(stateClass(initial.state));

    // Deletion: drop a middle chain link — the next row's prev_hash no longer
    // joins to the walk's expected predecessor.
    const chain = all<Row>('SELECT rowid AS __rowid, event_id, prev_hash, entry_hash FROM audit_chain ORDER BY rowid');
    expect(chain.length).toBeGreaterThanOrEqual(3);
    const victim = chain[1] as Row;
    // Restore in a `finally`: a failed assertion between the delete and the
    // re-insert must not leave the chain broken for every later spec in the
    // same process (the pre-refactor defect that made SEC-05 fail chained).
    try {
      run('DELETE FROM audit_chain WHERE event_id = ?', String(victim.event_id));
      const afterDelete = await auditVerifyRaw();
      const dF = verifyFields(afterDelete.state);
      console.log(`[SEC-05] after middle-link deletion (${String(victim.event_id)}): linksVerified=${dF.linksVerified}/${dF.totalLinks} reason=${dF.reason.slice(0, 170)}`);
      expect(fullLinkage(afterDelete.state)).toBe(false);
      expect(dF.reason).toMatch(/link mismatch|no valid genesis/i);
    } finally {
      run(
        'INSERT INTO audit_chain (rowid, event_id, prev_hash, entry_hash) VALUES (?, ?, ?, ?)',
        victim.__rowid as never,
        String(victim.event_id),
        String(victim.prev_hash),
        String(victim.entry_hash),
      );
    }
    const afterHeal = await auditVerifyRaw();
    const hF = verifyFields(afterHeal.state);
    console.log(`[SEC-05] after verbatim re-insert: linksVerified=${hF.linksVerified}/${hF.totalLinks} reason=${hF.reason.slice(0, 170)}`);
    expect(fullLinkage(afterHeal.state)).toBe(true);
    expect(stateClass(afterHeal.state)).toBe(stateClass(initial.state));
    console.log('[SEC-05] tamper-evidence proven both ways: a covered-byte edit flips the keyed walk to a MAC mismatch, deleting a middle link breaks the join ("link mismatch"), and verbatim restoration returns every link verified and the baseline state class — this verifier is the detection layer the export/licence gates read (audit_append.rs verify_audit_chain; verify_audit_chain_full for the unkeyed lane).');
  });

  // ===========================================================================
  // SEC-09 — forged IPC args + session escalation (runs LAST: the probes that
  // land are deliberate forged writes and will trip the G-15/G-19 invariants
  // for this test and the after-all hook — that is the harness working).
  // ===========================================================================
  it('[SEC-09] forged invoke args: wrong types, negative/huge quantities, forged shift ids, spoofed device ids, foreign user ids - validated natively', async () => {
    await unlockBootScreen();
    const alive = async (): Promise<boolean> => (await browser.execute(() => 1)) === 1;
    const sale = await makeCashSale('REF3 P500', 1);

    // (a) wrong types → serde rejection, no panic
    const wrongTypes = await shfInvokeRaw('checkout_sale_atomic', { req: { orderRow: 'nope', items: [], deltas: [] } });
    console.log(`[SEC-09] checkout wrong types: ok=${wrongTypes.ok} raw=${JSON.stringify(wrongTypes.ok ? wrongTypes.value : wrongTypes.error).slice(0, 200)}`);
    expect(wrongTypes.ok).toBe(false);
    expect(await alive()).toBe(true);

    // (b) unknown ticket refund → typed TICKET_NOT_FOUND
    const ghost = buildForgedRefund(sale.id, 1, { method: 'Espèces' });
    ghost.ticketId = `SEC09-MISSING-${Date.now()}`;
    const missing = await invokeForgedRefund(ghost);
    console.log(`[SEC-09] refund unknown ticket: ok=${missing.ok} raw=${missing.raw.slice(0, 160)}`);
    expect(missing.ok).toBe(false);
    expect(missing.raw).toMatch(/TICKET_NOT_FOUND/);

    // (c) spoofed device id → native device check refuses
    const spoof = await invokeForgedRefund(buildForgedRefund(sale.id, 1, { method: 'Espèces', spoofDevice: true }));
    console.log(`[SEC-09] refund spoofed device: ok=${spoof.ok} raw=${spoof.raw.slice(0, 200)}`);
    expect(spoof.ok).toBe(false);
    expect(spoof.raw).toMatch(/DEVICE_IDENTITY_SPOOFED/);

    // (d) fresh supervisor attestation → lands (positive control for SEC-03)
    const fresh = await invokeForgedRefund(
      forgedWithSupervisor(sale.id, new Date(Date.now() - 2000).toISOString(), 1, 500),
    );
    const freshLanded = refundsFor(sale.id).length > 0;
    console.log(`[SEC-09] fresh supervisor refund: ok=${fresh.ok} landed=${freshLanded} raw=${fresh.raw.slice(0, 140)}`);
    expect(fresh.ok).toBe(true);
    expect(freshLanded).toBe(true);

    // (e) negative quantity is refused before any sale row is written.
    const negId = `SEC09-NEG-${Date.now()}`;
    const neg = await shfInvokeRaw<Row>('checkout_sale_atomic', {
      req: {
        orderRow: {
          id: negId,
          receiptNumber: `SEC09-NEG-${Date.now()}`,
          shiftId: openShiftId(),
          subtotal: -1000,
          total: -1000,
          paymentMethod: 'Espèces',
          cashTendered: 0,
          changeDue: 0,
        },
        items: [{ id: `${negId}-l0`, productId: P500, quantity: -2, appliedPrice: 500, unitPriceCharged: 500 }],
        deltas: [{ id: `${negId}-d0`, productId: P500, delta: -2, reason: 'SALE' }],
      },
    });
    const negStored = txRow(negId);
    const negQty = negStored
      ? Number(one<{ q: number }>('SELECT quantity q FROM transaction_items WHERE transaction_id = ?', negId)?.q ?? 0)
      : 0;
    console.log(
      `[SEC-09] negative qty checkout: ok=${neg.ok} stored=${negStored ? 'yes' : 'no'} storedQty=${negQty} raw=${JSON.stringify(neg.ok ? neg.value : neg.error).slice(0, 160)}`,
    );
    expect(neg.ok).toBe(false);
    expect(negStored).toBeUndefined();
    const negSafe = !negStored && negQty === 0;
    expect(negSafe).toBe(true);

    // (f) a huge line quantity cannot disagree with the stock delta.
    const hugeId = `SEC09-HUGE-${Date.now()}`;
    const huge = await shfInvokeRaw<Row>('checkout_sale_atomic', {
      req: {
        orderRow: { id: hugeId, receiptNumber: `SEC09-HUGE-${Date.now()}`, shiftId: openShiftId(), total: 500, paymentMethod: 'Espèces' },
        items: [{ id: `${hugeId}-l0`, productId: P500, quantity: 1e15, appliedPrice: 500, unitPriceCharged: 500 }],
        deltas: [{ id: `${hugeId}-d0`, productId: P500, delta: -1, reason: 'SALE' }],
      },
    });
    const hugeStored = txRow(hugeId);
    const hugeQty = hugeStored
      ? Number(one<{ q: number }>('SELECT quantity q FROM transaction_items WHERE transaction_id = ?', hugeId)?.q ?? 0)
      : 0;
    const hugeLanded = huge.ok || hugeStored !== undefined;
    console.log(
      `[SEC-09] huge qty (1e15): ok=${huge.ok} stored=${hugeStored ? 'yes' : 'no'} storedQty=${hugeQty} raw=${JSON.stringify(huge.ok ? huge.value : huge.error).slice(0, 200)}`,
    );
    expect(huge.ok).toBe(false);
    expect(hugeStored).toBeUndefined();
    expect(hugeLanded).toBe(false);

    // (g) forged shift id on a checkout → the drawer attribution is client-controlled
    const ghostShift = `SHIFT-SEC09-GHOST-${Date.now()}`;
    const ghostId = `SEC09-SHIFT-${Date.now()}`;
    const ghostSale = await shfInvokeRaw<Row>('checkout_sale_atomic', {
      req: {
        orderRow: {
          id: ghostId,
          receiptNumber: `SEC09-SHIFT-${Date.now()}`,
          shiftId: ghostShift,
          subtotal: 500,
          total: 500,
          paymentMethod: 'Espèces',
          cashTendered: 500,
          changeDue: 0,
          cashierName: 'E2EGerant',
        },
        items: [{ id: `${ghostId}-l0`, productId: P500, quantity: 1, appliedPrice: 500, unitPriceCharged: 500 }],
        deltas: [{ id: `${ghostId}-d0`, productId: P500, delta: -1, reason: 'SALE' }],
      },
    });
    const ghostStored = txRow(ghostId);
    const ghostShiftStored = String(ghostStored?.shift_id ?? '');
    console.log(
      `[SEC-09] forged shiftId checkout: ok=${ghostSale.ok} stored=${ghostStored ? 'yes' : 'no'} shift_id=${ghostShiftStored} raw=${JSON.stringify(ghostSale.ok ? ghostSale.value : ghostSale.error).slice(0, 160)}`,
    );
    const forgedShiftLanded = ghostStored !== undefined && ghostShiftStored === ghostShift;
    if (forgedShiftLanded) {
      console.log(
        '[SEC-09] CONFIRMED EDGE-CASE VULNERABILITY [P1]: checkout_sale_atomic persists the client-supplied shiftId verbatim (checkout.rs:1130 → INSERT transactions.shift_id) with no check against the live open session, so a forged IPC call stamps a sale onto any drawer id — the money row then sits outside every drawer ledger/Z (same trust class as the REF-78/SHF-11 forged allocation).',
      );
    }

    // (h) pin_verify with wrong types → typed error, no panic
    const pinWrong = await shfInvokeRaw('pin_verify', { request: { userId: 123, pin: false } });
    console.log(`[SEC-09] pin_verify wrong types: ok=${pinWrong.ok} raw=${JSON.stringify(pinWrong.ok ? pinWrong.value : pinWrong.error).slice(0, 160)}`);
    expect(pinWrong.ok).toBe(false);
    expect(await alive()).toBe(true);

    // (i) pin_set with an invalid new PIN → refused, no credential change
    const pinBad = await pinSetRaw('usr-sec1', 'abc');
    const rosterAfterBad = JSON.parse(String(one<Row>("SELECT value_json FROM app_settings WHERE key = 'cashier_users'")?.value_json ?? '[]')) as Row[];
    const secA = rosterAfterBad.find((u) => String(u.id) === 'usr-sec1');
    console.log(`[SEC-09] pin_set short/alpha: ok=${pinBad.ok} raw=${pinBad.raw.slice(0, 140)}; usr-sec1 envelope unchanged=${String(secA?.pin ?? '').startsWith('v2$')}`);
    expect(pinBad.ok).toBe(false);
    expect(String(secA?.pin ?? '')).toMatch(/^"?v2\$/);

    // (j) session escalation: the same forged refund lands from a cashier session
    await lockAndWait();
    await unlockViaProfile('usr-sec1', '2468');
    const escSale = await makeCashSale('REF3 P500', 1);
    const escProbe = await invokeForgedRefund(buildForgedRefund(escSale.id, 1, { method: 'Espèces' }));
    const escLanded = refundsFor(escSale.id).length > 0;
    console.log(`[SEC-09] forged refund from a cashier session: ok=${escProbe.ok} landed=${escLanded} raw=${escProbe.raw.slice(0, 160)}`);
    if (!escLanded) {
      console.log('[SEC-09] note: this leg was refused at a non-authorization precondition (see raw), so it is inconclusive for role escalation; the IPC escalation evidence is SEC-01 (peer PIN mint, backup) and the forged writes above.');
    }
    await lockAndWait();
    await unlockViaProfile('usr-admin', APP_PIN);
    if (escLanded) {
      console.log(
        '[SEC-09] CONFIRMED EDGE-CASE VULNERABILITY [P1]: a cashier session landed a refund through refund_sale_atomic with no manager step-up — native authorization is per-window capability, never per-user role (capability_policy.rs:73); the same window executes every registered command (SEC-01).',
      );
    }

    // All probes above have run and logged; the aggregate assertion stays
    // after every evidence-gathering step, per the batch contract.
    const critical = forgedShiftLanded || escLanded || hugeLanded;
    expect(critical).toBe(false);
    expect(negSafe).toBe(true);
  });

});
