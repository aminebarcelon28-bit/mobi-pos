/**
 * REF — refunds / returns / avoirs, batch 7 (spec 33; cases REF-22, 23, 24,
 * 35, 38, 40, 41, 42, 48, 51, 52, 53, 56, 58, 60, 87, 90 + PAY-22).
 *
 * Harness mirrors batch 6 (spec 32): same live-SQLite ground truth, desktop
 * POS under WebdriverIO + Tauri. Head + helpers are copied verbatim from
 * spec 32 (cut at the first REF-32 it()); only seeds / labels / needles and
 * the batch-7 tests differ.
 *
 * Decisions under test (from the encyclopedia + app sources, read-only):
 *  - REF-22: serialized refunds have no returned-IMEI capture lane; the sold
 *    imei is restocked blindly (RefundModal.tsx:829-831 display-only).
 *  - REF-42: card-funded refunds have no returning rail; Espèces must be
 *    refused and Avoir must deliver — no value evaporation.
 *  - REF-52: clock regression refuses UI + forged refunds; supervisor
 *    freshness (stale/future) refuses both directions.
 *  - REF-87: 2 000 000 000-DA units — exact integer money, no i64 overflow.
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
  // REF-51 flake: the submit button is disabled while the modal recomputes the
  // preview right after staging (and during an offline cash-policy
  // re-evaluation). Racing that state produced "refund-submit not clickable" in
  // batch runs. Wait for readiness, then click; one retry covers a
  // re-evaluation that starts between the wait and the click. The assertion is
  // unchanged: the refund must be submitted and land.
  const ready = await browser
    .waitUntil(
      async () =>
        (await browser.execute(() => {
          const b = document.querySelector('[data-testid="refund-submit"]') as HTMLButtonElement | null;
          const p = document.querySelector('[data-testid="refund-pin"]') as HTMLInputElement | null;
          if (!b || !p) return false;
          const r = b.getBoundingClientRect();
          return !b.disabled && r.width > 0 && r.height > 0;
        })) as boolean,
      { timeout: 15000, interval: 200 },
    )
    .catch(() => undefined);
  if (!ready) {
    // A pre-check refusal (offline cash cap, foreign ticket, empty selection)
    // can close the modal before the PIN renders. That is a REFUSAL surface for
    // the caller to classify, not a hang on a field that will never appear.
    if (!(await refundDialogVisible().catch(() => false))) {
      throw new Error('refund-dialog-closed-before-submit');
    }
  }
  await typeRefundPin(pin);
  let ok = await clickRefundSubmit(times);
  if (!ok) {
    await browser.pause(700);
    ok = await clickRefundSubmit(times);
  }
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
  try {
    await submitRefund();
  } catch (e) {
    if ((e as Error)?.message === 'refund-dialog-closed-before-submit') {
          if (await graceLanded(closedDialogBudget)) return { landed: true, surface: 'grace: dialog closed after the row landed' };
      const surface = (await visibleToasts().catch(() => '')) || 'refund-dialog-closed';
      console.log(`[submitAndSettle ${tag}] dialog closed before submit: ${surface}`);
      return { landed: false, surface };
    }
    throw e;
  }
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
  const graceLanded = async (budgetMs = 6000): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (refundsFor(ticketId).length >= want) return true;
      await browser.pause(500);
    }
    return refundsFor(ticketId).length >= want;
  };
  // A huge ticket's native merge can take ~1 min; when the dialog closes mid-flight
  // the row it will write is still coming. Give that case a proportionate budget.
  const ticketTotal = Number(
    (one<{ t: number }>('SELECT total AS t FROM transactions WHERE id = ?', ticketId)?.t ?? 0),
  );
  const closedDialogBudget = ticketTotal > 100_000_000 ? 180000 : 6000;
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
        try {
          await submitRefund();
        } catch (e) {
          // The switch can close the dialog instead of keeping it open for the
          // confirmation click. That is the fail-closed shape the caller already
          // accepts (the s2 branch): report a refusal surface, never hang.
          if ((e as Error)?.message === 'refund-dialog-closed-before-submit') {
          if (await graceLanded(closedDialogBudget)) return { landed: true, surface: 'grace: dialog closed after the row landed' };
            const surface = (await visibleToasts().catch(() => '')) || 'refund-dialog-closed';
            console.log(`[submitAndSettle ${tag}] cap switch closed the dialog: ${surface}`);
            return { landed: false, surface };
          }
          throw e;
        }
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

describe('REF — refunds, returns & avoirs (batch 7 / part 4)', () => {
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
      { id: P001, title: 'REF4 P001', priceDa: 0.01, stock: 100, costDa: 0 },
      { id: PMAX, title: 'REF4 PMAX', priceDa: 2000000000, stock: 10, costDa: 1000000000 },
    ]);
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
    captureInvariantBaseline('REF4');
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
    assertInvariants(`REF4 :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('REF batch4 (spec 33)');
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
    // Post-refund the app is still settling (mirror write + outbox + Dexie), so
    // the reports dialog can appear a beat late. Wait for the body (or its PIN
    // gate) to render, and retry once if the line is not there yet. The
    // assertion stays the same: the returns line must exist and move by the
    // refunded amount.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await openReports();
      await browser
        .waitUntil(
          async () =>
            (await browser.execute(() => {
              const text = document.body.innerText || '';
              const gate = (
                [...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[]
              ).some((i) => /Administrateur|Manager/i.test(i.placeholder || ''));
              return /Retours\s*&\s*Remboursements\s*Clients/i.test(text) || gate;
            })) as boolean,
          { timeout: 15000, interval: 300, timeoutMsg: 'reports view never rendered' }
        )
        .catch(() => undefined);
      await unlockReportsGate();
      const ctx = await bodyContexts('Retours & Remboursements Clients', 90, 2);
      await closeReportsDialog();
      console.log(`[returnsLine] attempt=${attempt + 1} ctx=${JSON.stringify(ctx)}`);
      for (const c of ctx) {
        const m = c.match(/Retours\s*&\s*Remboursements\s*Clients\s*-?\s*([\d\s\u00A0\u202F.,]+?)\s*DA/i);
        if (m) {
          const digits = m[1].replace(/[^\d]/g, '');
          if (digits) return Number(digits);
        }
      }
      if (attempt === 0) await browser.pause(900);
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
    await (await $(tid('checkout-button'))).click();
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
    // OWNER RULING (REF-42 A, narrow): delivery is the destination of record -
    // the wallet BALANCE delta (the column the app reads), counted ONCE - plus
    // cash and voucher vault. The payload mirror is asserted separately
    // ('the wallet mirrors agree'), never added to the delivery.
    const colDelta = custId !== null ? Math.max(0, (creditRaw(custId).col ?? 0) - (before.col ?? 0)) : 0;
    const vaultDelta = Math.max(0, voucherTotal() - before.vault);
    return (Number.isFinite(cash) ? cash : 0) + colDelta + vaultDelta;
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

  it('[REF-22] serialized-device refund: no returned-IMEI capture lane — the sold imei is restocked blindly (swap undetectable)', async () => {
    const base = stockOf(PSER);
    const imeiCount0 = count('imei_records');
    const sale = await makeCashSale('REF3 PSER', 1);
    const afterSale = one<Row>('SELECT * FROM imei_records WHERE imei = ?', IMEI_SER);
    console.log(`[REF-22] after sale: status=${String(afterSale?.status)} sale_tx=${String(afterSale?.sale_transaction_id)} sold_at=${String(afterSale?.sold_at)} base=${base}`);
    // Soldness is the sale link, not `status` (REF-61 / refund.rs availability
    // predicate: !sale_transaction_id && !sold_at; the status column stays
    // 'in_stock' across the whole sold/refunded lifecycle).
    expect(String(afterSale?.sale_transaction_id ?? '')).toBe(sale.id);
    expect(stockOf(PSER)).toBe(base - 1);

    expect(await beginRefund(sale.receipt)).toBe(true);
    const fields = await refundDialogFields();
    console.log(`[REF-22] refund dialog editable fields: ${JSON.stringify(fields)}`);
    // The dialog shows the SOLD serial (display-only, RefundModal.tsx:829-831)
    // but must not offer any lane to capture/verify the RETURNED device.
    expect(fields.some((f) => /imei|s[ée]riel|serial/i.test(f))).toBe(false);
    const dlgText = await refundDialogText();
    expect(dlgText).toContain(IMEI_SER);

    await refundOnly([{ pid: PSER, qty: 1 }]);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-22] refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);

    const ref = refundRowOf(sale.id);
    console.log(`[REF-22] refund row total=${String(ref?.total)} method=${String((jsonOf(ref) as Row).refundMethod)}`);
    expect(Number(ref?.total)).toBe(800);
    const afterRefund = one<Row>('SELECT * FROM imei_records WHERE imei = ?', IMEI_SER);
    console.log(`[REF-22] after refund: status=${String(afterRefund?.status)} sale_tx=${String(afterRefund?.sale_transaction_id)} sold_at=${String(afterRefund?.sold_at)} count=${count('imei_records')} stock=${stockOf(PSER)}`);
    expect(String(afterRefund?.status ?? '')).toBe('in_stock');
    expect(afterRefund?.sale_transaction_id ?? null).toBeNull();
    expect(afterRefund?.sold_at ?? null).toBeNull();
    expect(count('imei_records')).toBe(imeiCount0);
    expect(stockOf(PSER)).toBe(base);
    console.log('[REF-22] CONFIRMED EDGE-CASE VULNERABILITY [P2]: no returned-IMEI capture/verification lane — RefundModal.tsx:829-831 shows the sold serial as text only; refund.rs:1427-1460 restocks the client-asserted imei list `req.imeis` (unlink + in_stock) with no re-verification, so a swapped device is undetectable and the sold unit blindly re-enters stock');
  });

  it('[REF-60] refund/exchange chain A→B→C (refund+resell model): every leg refunds exactly once; re-refund of A/B/C refused; no double recovery', async () => {
    const base500 = stockOf(P500);
    const base700 = stockOf(P700);
    const base1000 = stockOf(P1000);
    // App models exchanges as refund + resell (REF-12); the return-line lane
    // never lands (REF-71 evidence) — the chain is driven through real sales.
    const A = await makeCashSaleTo('REF3 P700', 1, C60_NAME);
    expect(Number(A.total)).toBe(700);
    expect(await beginRefund(A.receipt)).toBe(true);
    await refundOnly([{ pid: P700, qty: 1 }]);
    const settleA = await submitAndSettle(A.id, 1);
    if (!settleA.landed) console.log(`[REF-60] A refund surface: ${settleA.surface}`);
    expect(settleA.landed).toBe(true);
    const refA = refundRowOf(A.id);
    console.log(`[REF-60] A: sale 700 → refund total=${String(refA?.total)} cash=${cashOf(refA)}`);
    expect(Number(refA?.total)).toBe(700);
    expect(cashOf(refA)).toBe(700);
    expect(stockOf(P700)).toBe(base700);

    const B = await makeCashSaleTo('REF3 P1000', 1, C60_NAME);
    expect(await beginRefund(B.receipt)).toBe(true);
    await refundOnly([{ pid: P1000, qty: 1 }]);
    const settleB = await submitAndSettle(B.id, 1);
    if (!settleB.landed) console.log(`[REF-60] B refund surface: ${settleB.surface}`);
    expect(settleB.landed).toBe(true);
    const refB = refundRowOf(B.id);
    console.log(`[REF-60] B: sale 1000 → refund total=${String(refB?.total)} cash=${cashOf(refB)}`);
    expect(Number(refB?.total)).toBe(1000);
    expect(cashOf(refB)).toBe(1000);
    expect(stockOf(P1000)).toBe(base1000);

    const C = await makeCashSaleTo('REF3 P500', 1, C60_NAME);
    expect(stockOf(P500)).toBe(base500 - 1);

    // Forged re-refund of the refunded legs — quota gate must refuse.
    for (const [label, ticket] of [['A', A], ['B', B]] as Array<[string, { id: string }]>) {
      const probe = await invokeForgedRefund(buildForgedRefund(ticket.id, 1));
      console.log(`[REF-60] forged re-refund ${label}: ok=${probe.ok} raw=${probe.raw}`);
      expect(probe.ok).toBe(false);
      expect(probe.raw).toMatch(/REFUND_EXCEEDS|ALREADY_REFUNDED/);
    }
    const offeredA = await beginRefund(A.receipt, 5000);
    console.log(`[REF-60] UI re-refund A offered=${offeredA}`);
    expect(offeredA).toBe(false);
    await closeRefund().catch(() => {});

    // Leg C refunds exactly once (the chain's live end).
    expect(await beginRefund(C.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    const settleC = await submitAndSettle(C.id, 1);
    if (!settleC.landed) console.log(`[REF-60] C refund surface: ${settleC.surface}`);
    expect(settleC.landed).toBe(true);
    expect(cashOf(refundRowOf(C.id))).toBe(500);
    const probeC = await invokeForgedRefund(buildForgedRefund(C.id, 1));
    console.log(`[REF-60] forged re-refund C: ok=${probeC.ok} raw=${probeC.raw}`);
    expect(probeC.ok).toBe(false);
    expect(probeC.raw).toMatch(/REFUND_EXCEEDS|ALREADY_REFUNDED/);

    // Conservation: 2200 in, 2200 back, one row per leg, all stock restored.
    const paidIn = 700 + 1000 + 500;
    const refunded = (Number.isFinite(cashOf(refA)) ? cashOf(refA) : 0) + (Number.isFinite(cashOf(refB)) ? cashOf(refB) : 0) + (Number.isFinite(cashOf(refundRowOf(C.id))) ? cashOf(refundRowOf(C.id)) : 0);
    console.log(`[REF-60] conservation: paid=${paidIn} refunded=${refunded} rows=${refundsFor(A.id).length}/${refundsFor(B.id).length}/${refundsFor(C.id).length}`);
    expect(refunded).toBe(paidIn);
    expect(refundsFor(A.id).length).toBe(1);
    expect(refundsFor(B.id).length).toBe(1);
    expect(refundsFor(C.id).length).toBe(1);
    expect(stockOf(P500)).toBe(base500);
  });

  it('[REF-23] refund attempt with the shift closed: refused fail-closed (no row, no movement, no restock); reopening restores the lane', async () => {
    const base = stockOf(P500);
    const sale = await makeCashSale('REF3 P500', 1);
    expect(stockOf(P500)).toBe(base - 1);
    const closed = await closeShiftUi();
    console.log(`[REF-23] shift closed: expected="${closed.expected}" counted="${closed.counted}" variance="${closed.variance}" z=${closed.zDialog}`);
    expect(openShiftId()).toBeNull();

    const rowsBefore = refundsFor(sale.id).length;
    const movesBefore = count('cash_movements');
    const stockBefore = stockOf(P500);

    let opened = true;
    try {
      await openRefund();
    } catch (e) {
      opened = false;
      console.log(`[REF-23] openRefund refused by the gate: ${String((e as Error)?.message ?? e)}`);
    }
    if (opened) {
      // beginRefund logs the pick result; 'disabled' / 'no-row' are the
      // fail-closed shapes while no shift is open (RefundModal.tsx:480-483,
      // :594-595 NO_OPEN_SHIFT toast).
      const picked = await beginRefund(sale.receipt, 6000);
      console.log(`[REF-23] ticket pick with shift closed: offered=${picked}`);
      if (picked) {
        try {
          await refundOnly([{ pid: P500, qty: 1 }]);
        } catch (e) {
          console.log(`[REF-23] refundOnly refused: ${String((e as Error)?.message ?? e)}`);
        }
        if (await refundSubmitDisabled()) {
          console.log('[REF-23] submit disabled while shift closed');
        } else {
          const settled = await submitAndSettle(sale.id, 1);
          console.log(`[REF-23] submit with shift closed: landed=${settled.landed} surface=${settled.surface}`);
          expect(settled.landed).toBe(false);
        }
      }
    }
    await closeRefund().catch(() => {});
    expect(refundsFor(sale.id).length).toBe(rowsBefore);
    expect(count('cash_movements')).toBe(movesBefore);
    expect(stockOf(P500)).toBe(stockBefore);

    // Reopen: the lane comes back for CURRENT-period tickets, while the
    // ticket sold under the closed shift stays fenced. The fence here is the
    // offline own-shift rule (RefundModal.tsx:681-693 `offlineLocked` →
    // disabled row; refundLockPolicy.ts:31-39 isOwnShiftTicket — local device
    // + open shift id must match; onlineNow=false comes from the failed
    // remote probe :124-128 — the sandbox merchant gateway is unconfigured).
    const float = await openShiftBestEffort(10000);
    console.log(`[REF-23] shift reopened (float ${float})`);
    expect(openShiftId()).not.toBeNull();
    const oldOffered = await beginRefund(sale.receipt, 6000);
    console.log(`[REF-23] old-period ticket after reopen: offered=${oldOffered} (own-shift fence holds)`);
    expect(oldOffered).toBe(false);
    await closeRefund().catch(() => {});
    expect(refundsFor(sale.id).length).toBe(rowsBefore);
    expect(count('cash_movements')).toBe(movesBefore);
    expect(stockOf(P500)).toBe(stockBefore);

    // The lane itself is alive: a ticket sold in the NEW shift refunds exactly.
    const sale2 = await makeCashSale('REF3 P500', 1);
    expect(await beginRefund(sale2.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    const settled2 = await submitAndSettle(sale2.id, 1);
    if (!settled2.landed) console.log(`[REF-23] post-reopen refund surface: ${settled2.surface}`);
    expect(settled2.landed).toBe(true);
    expect(cashOf(refundRowOf(sale2.id))).toBe(500);
    expect(stockOf(P500)).toBe(stockBefore); // sale2 sold one; its refund restocked it
    console.log('[REF-23] foreign-cashier facet N/A: single-terminal sandbox — one session per device, no second-cashier session lane exists (evidence: RefundModal.tsx:480-483 shift gate + refundLockPolicy.ts:31-47 own-shift fence)');
  });

  it('[REF-38] cost change after the sale: refund must value at the frozen unit_cost_at_sale (never today\'s cost)', async () => {
    const base = stockOf(P1000);
    const sale = await makeCashSale('REF3 P1000', 1);
    const item = one<Row>('SELECT unit_cost_at_sale FROM transaction_items WHERE transaction_id = ? ORDER BY rowid LIMIT 1', sale.id);
    console.log(`[REF-38] frozen unit_cost_at_sale=${String(item?.unit_cost_at_sale)}`);
    expect(Math.round(Number(item?.unit_cost_at_sale))).toBe(500);
    run('UPDATE products SET cost_price = 900 WHERE id = ?', P1000);
    console.log(`[REF-38] cost_price changed 500→${String(one<Row>('SELECT cost_price FROM products WHERE id = ?', P1000)?.cost_price)}`);
    try {
      expect(await beginRefund(sale.receipt)).toBe(true);
      await refundOnly([{ pid: P1000, qty: 1 }]);
      const settled = await submitAndSettle(sale.id, 1);
      if (!settled.landed) console.log(`[REF-38] refusal surface: ${settled.surface}`);
      expect(settled.landed).toBe(true);
      const ref = refundRowOf(sale.id);
      const costTotal = Math.round(Number(ref?.cost_total ?? NaN));
      const profit = Math.round(Number(ref?.profit ?? NaN));
      console.log(`[REF-38] refund cost_total=${costTotal} profit=${profit} total=${String(ref?.total)} cash=${cashOf(ref)}`);
      expect(Number(ref?.total)).toBe(1000);
      expect(costTotal).toBe(500); // frozen at sale — NOT the new 900
      expect(cashOf(ref)).toBe(1000);
      expect(stockOf(P1000)).toBe(base);
    } finally {
      run('UPDATE products SET cost_price = 500 WHERE id = ?', P1000);
      console.log('[REF-38] cost restored to 500');
    }
  });

  it('[REF-41] refund to store credit then spend it: value flows back through the guardrail, wallet never negative, source cannot refund twice', async () => {
    const sale = await makeCashSaleTo('REF3 P1000', 1, C41_NAME);
    expect(Number(sale.total)).toBe(1000);
    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P1000, qty: 1 }]);
    await selectRefundMethod('Avoir Client');
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-41] avoir refund surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    const ref = refundRowOf(sale.id);
    console.log(`[REF-41] refund total=${String(ref?.total)} cash=${cashOf(ref)} method=${String((jsonOf(ref) as Row).refundMethod)} durableCredit=${effCredit(C41)} outboxCredit=${String(outboxCustomerCredit(C41))}`);
    expect(Number(ref?.total)).toBe(1000);
    expect(cashOf(ref)).toBe(0);

    const offered2 = await beginRefund(sale.receipt, 5000);
    console.log(`[REF-41] re-refund offered=${offered2}`);
    expect(offered2).toBe(false);
    await closeRefund().catch(() => {});
    const probe = await invokeForgedRefund(buildForgedRefund(sale.id, 1));
    console.log(`[REF-41] forged re-refund: ok=${probe.ok} raw=${probe.raw}`);
    expect(probe.ok).toBe(false);
    expect(probe.raw).toMatch(/REFUND_EXCEEDS|ALREADY_REFUNDED/);

    // Spend the wallet balance. Guardrail (loyaltyEngine.ts:557-582):
    // min(balance 1000, 50% gross 500, gross−COGS 500) = 500 on a fresh P1000.
    await clearCart();
    await selectCustomer(C41_NAME);
    await addSku('REF3 P1000');
    expect(await cartTotalMinor()).toBe(100000n);
    await (await $(tid('checkout-button'))).click();
    const pay = await payWithStoreCreditAll();
    console.log(`[REF-41] apply-all: applied=${pay.applied} confirm="${pay.confirmLabel}" confirmed=${pay.confirmed}`);
    expect(pay.applied).toBe(true);
    const tx = newestTxRow();
    const spend = { id: String(tx?.id), tenders: (jsonOf(tx).tenders ?? []) as Array<{ method?: string; amount?: number }> };
    console.log(`[REF-41] spend sale total=${String(tx?.total)} tenders=${JSON.stringify(spend.tenders)} durableCredit=${effCredit(C41)}`);
    expect(Number(tx?.total)).toBe(500);
    expect(spend.tenders.some((t) => /Avoir/i.test(String(t.method)) && Number(t.amount) === 500)).toBe(true);
    expect(spend.tenders.some((t) => /Espèces/i.test(String(t.method)) && Number(t.amount) === 500)).toBe(true);
    const creditAfter = await pollValue(() => effCredit(C41), 500);
    console.log(`[REF-41] durable credit after spend=${creditAfter}`);
    expect(creditAfter).toBe(500); // durable converges at the checkout write
    expect(effCredit(C41)).toBeGreaterThanOrEqual(0);
    expect(refundsFor(sale.id).length).toBe(1);
  });

  it('[REF-35] 0,01 DA gift line: gift-only refund previews 0 and mints nothing; the paid line refunds exactly 500', async () => {
    const base001 = stockOf(P001);
    const base500 = stockOf(P500);
    await clearCart();
    await addSku('REF4 P001');
    await addSku('REF3 P500');
    const before = txCount();
    await payExactFlow();
    const tx = await landedSale(before);
    const sale = { id: String(tx.id), receipt: String(tx.receipt_number) };
    // Authority order (docs/c01-ref35-minor-unit.md): ISO 4217 gives DZD 2 minor
    // units and MNY-01 requires a 0,01 cart to be CHARGED 0,01. The old
    // expectation (total 500 for a 500,01 basket) contradicted both and no
    // rounding rule satisfies MNY-01/02/03 and that expectation together, so
    // the corrected contract is the charged basket total.
    console.log(`[REF-35] basket sale total=${String(tx.total)} subtotal=${String(tx.subtotal)} (0,01 line charged as a minor unit)`);
    expect(Number(tx.total)).toBe(500.01);
    expect(stockOf(P001)).toBe(base001 - 1);

    expect(await beginRefund(sale.receipt)).toBe(true);
    const keys = await refundCheckKeys();
    console.log(`[REF-35] refund line keys: ${JSON.stringify(keys)}`);
    const giftKey = keys.find((k) => k.startsWith(`${P001}_`));
    const paidKey = keys.find((k) => k.startsWith(`${P500}_`));
    expect(paidKey).toBeTruthy();
    console.log(`[REF-35] gift line offered=${Boolean(giftKey)}`);

    let giftLanded = false;
    if (giftKey) {
      let giftPreview = -1n;
      let disabled: boolean | null = null;
      let staged = true;
      try {
        await refundOnly([{ pid: P001, qty: 1 }]);
        giftPreview = await refundTotalMinor();
        disabled = await refundSubmitDisabled();
      } catch (e) {
        staged = false;
        console.log(`[REF-35] gift-only staging refused: ${String((e as Error)?.message ?? e)}`);
      }
      if (staged) {
        console.log(`[REF-35] gift-only preview=${giftPreview} submitDisabled=${disabled} (line charged 0; the preview falls back to the product price — RefundModal.tsx:382-386 item.appliedPrice || item.product.price)`);
        expect(giftPreview <= 1n).toBe(true); // 0,01 DA at most — never a priced amount
        if (!disabled) {
          const moves0 = count('cash_movements');
          const vault0 = voucherTotal();
          const zero = await submitAndSettle(sale.id, 1);
          const giftRow = refundRowOf(sale.id);
          const giftCash = count('cash_movements') - moves0;
          const giftVault = voucherTotal() - vault0;
          giftLanded = Boolean(giftRow);
          console.log(`[REF-35] gift-only submit: landed=${zero.landed} surface=${zero.surface} rowTotal=${giftRow ? String(giftRow.total) : '(none)'} deliveredCash=${giftRow ? cashOf(giftRow) : 0} movesDelta=${giftCash} vaultDelta=${giftVault}`);
          if (giftRow) {
            // Value delivered for a line charged 0 must be 0.
            expect(cashOf(giftRow)).toBe(0);
            expect(giftCash).toBe(0);
            expect(giftVault).toBe(0);
            expect(Math.round(Number(giftRow.total))).toBeLessThanOrEqual(1);
          } else {
            expect(zero.landed).toBe(false);
            if (/PERSISTENCE_FAILED/.test(zero.surface)) {
              console.log('[REF-35] observed mislabeled refusal: the 0,01-only request is refused fail-closed (no row, no movement, no voucher) but the surface reads "Erreur lors du remboursement: PERSISTENCE_FAILED" — an unmapped-error label rather than the real refusal code (refundNative.ts:268-271 code list; createOrderSlice.ts:2901-2915 reason passthrough)');
            }
          }
        }
      }
    }
    if (giftLanded) {
      // The gift chunk consumed a quota pass — reopen for the paid line.
      expect(await beginRefund(sale.receipt)).toBe(true);
    }
    if (giftKey && !giftLanded) {
      // Observation only: ticket-level preview with every remaining line
      // selected (500 + the 0,01 line), then narrow to the paid line.
      await refundOnly([{ pid: P500, qty: 1 }, { pid: P001, qty: 1 }]);
      console.log(`[REF-35] ticket-level preview=${await refundTotalMinor()} (500 + the 0,01 line)`);
    }
    await refundOnly([{ pid: P500, qty: 1 }]);
    const preview = await refundTotalMinor();
    console.log(`[REF-35] paid-line-only preview=${preview} (expect 50000)`);
    expect(preview).toBe(50000n);
    const settled = await submitAndSettle(sale.id, giftLanded ? 2 : 1);
    if (!settled.landed) console.log(`[REF-35] refusal surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    const allRows = refundsFor(sale.id);
    const ref = allRows[allRows.length - 1];
    if (giftLanded) {
      console.log(`[REF-35] rows (ASC): ${JSON.stringify(allRows.map((r) => String(r.total)))}`);
      expect(allRows.length).toBe(2);
      expect(Math.round(Number(allRows[0].total))).toBeLessThanOrEqual(1);
    } else {
      expect(allRows.length).toBe(1);
    }
    console.log(`[REF-35] refund row total=${String(ref?.total)} cash=${cashOf(ref)}`);
    expect(Number(ref?.total)).toBe(500);
    expect(cashOf(ref)).toBe(500);
    expect(stockOf(P500)).toBe(base500);
    const stock001 = stockOf(P001);
    console.log(`[REF-35] gift stock after refund=${stock001} (base ${base001}; window ${base001 - 1}..${base001})`);
    expect(stock001).toBeGreaterThanOrEqual(base001 - 1);
    expect(stock001).toBeLessThanOrEqual(base001);
    const probe = await invokeForgedRefund(buildForgedRefund(sale.id, 1));
    console.log(`[REF-35] forged re-refund: ok=${probe.ok} raw=${probe.raw}`);
    expect(probe.ok).toBe(false);
    expect(probe.raw).toMatch(/REFUND_EXCEEDS|ALREADY_REFUNDED/);
  });

  it('[REF-53] zero-value sale (0,01 DA line): no refundable lane — forged probe refuses ZERO_REFUNDABLE, no mint', async () => {
    await clearCart();
    await addSku('REF4 P001');
    const display = await cartTotalMinor();
    console.log(`[REF-53] cart display=${display} minor (0,01 DA line)`);
    const before = txCount();
    let sale: { id: string; receipt: string } | null = null;
    try {
      await commitZeroSale();
      const landed = await pollUntil(() => txCount() > before, 20000, 'zero-value sale did not land');
      if (landed) {
        const tx = newestTxRow();
        sale = { id: String(tx?.id ?? ''), receipt: String(tx?.receipt_number ?? '') };
        console.log(`[REF-53] zero-value sale landed: id=${sale.id} total=${String(tx?.total)} subtotal=${String(tx?.subtotal)}`);
      } else {
        console.log('[REF-53] zero-value sale did not land (checkout refused) — no refund lane by construction');
      }
    } catch (e) {
      console.log(`[REF-53] zero-sale commit threw: ${String((e as Error)?.message ?? e)}`);
    }
    const movesBefore = count('cash_movements');
    const vouchersBefore = voucherTotal();
    if (sale) {
      let offered = false;
      try {
        offered = await beginRefund(sale.receipt, 6000);
      } catch (e) {
        console.log(`[REF-53] beginRefund threw: ${String((e as Error)?.message ?? e)}`);
      }
      console.log(`[REF-53] zero-total ticket offered=${offered}`);
      if (offered) {
        console.log(`[REF-53] submitDisabled with no selection: ${await refundSubmitDisabled()}`);
      }
      await closeRefund().catch(() => {});
      const probe = await invokeForgedRefund(buildForgedRefund(sale.id, 1));
      console.log(`[REF-53] forged zero refund: ok=${probe.ok} raw=${probe.raw}`);
      expect(probe.ok).toBe(false);
      expect(probe.raw).toContain('ZERO_REFUNDABLE');
      expect(refundsFor(sale.id).length).toBe(0);
    }
    expect(count('cash_movements')).toBe(movesBefore);
    expect(voucherTotal()).toBe(vouchersBefore);
    console.log('[REF-53] no mint lane: cash movements and vouchers unchanged; refusal refereed natively (refund.rs:930-931 ZERO_REFUNDABLE — zero-value tickets never reach the write path)');
  });

  it('[REF-40] deleted customer (tombstone): refund does not resurrect the profile; delivered value must reach a usable lane or be refused', async () => {
    const s1 = await makeCashSaleTo('REF3 P700', 1, C40_NAME);
    const s2 = await makeCashSaleTo('REF3 P1000', 1, C40_NAME);
    expect(await openCustomersDialog()).toBe(true);
    await customersSearchSet(C40_NAME);
    await browser.pause(700);
    await browser.execute(() => {
      (window as unknown as { confirm: () => boolean }).confirm = () => true;
    });
    const menu = (await browser.execute((name: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll(`button[aria-label="Plus d'actions pour ${name}"]`)] as HTMLElement[]).find(vis) as HTMLButtonElement | undefined;
      if (!b) return false;
      b.click();
      return true;
    }, C40_NAME)) as boolean;
    await browser.pause(500);
    const del = (await browser.execute((name: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const b = ([...document.querySelectorAll(`[role="menuitem"][aria-label="Supprimer ${name}"]`)] as HTMLElement[]).find(vis) as HTMLButtonElement | undefined;
      if (!b) return false;
      b.click();
      return true;
    }, C40_NAME)) as boolean;
    const deleted = await pollUntil(() => Number(one<Row>('SELECT deleted FROM customers WHERE id = ?', C40)?.deleted ?? 0) === 1, 15000, 'customer not soft-deleted');
    console.log(`[REF-40] delete: menu=${menu} item=${del} softDeleted=${deleted}`);
    expect(menu).toBe(true);
    expect(del).toBe(true);
    expect(deleted).toBe(true);
    await closeCustomersDialog().catch(() => {});

    // Sale 1 — refund to CASH: no profile needed, drawer exact.
    expect(await beginRefund(s1.receipt)).toBe(true);
    await refundOnly([{ pid: P700, qty: 1 }]);
    const settled1 = await submitAndSettle(s1.id, 1);
    if (!settled1.landed) console.log(`[REF-40] cash refund surface: ${settled1.surface}`);
    expect(settled1.landed).toBe(true);
    const ref1 = refundRowOf(s1.id);
    console.log(`[REF-40] cash refund: total=${String(ref1?.total)} cash=${cashOf(ref1)}`);
    expect(Number(ref1?.total)).toBe(700);
    expect(cashOf(ref1)).toBe(700);

    // Sale 2 — refund to AVOIR: value must land in a USABLE lane (cash /
    // durable credit / voucher) or the attempt must be refused. An outbox-only
    // credit keyed to a tombstoned profile is unredeemable and does not count.
    const before2 = { col: creditRaw(C40).col, payload: creditRaw(C40).payload, vault: voucherTotal(), outbox: outboxCustomerCredit(C40), moves: count('cash_movements') };
    let offered2 = false;
    try {
      offered2 = await beginRefund(s2.receipt);
    } catch (e) {
      console.log(`[REF-40] beginRefund s2 threw: ${String((e as Error)?.message ?? e)}`);
    }
    let landed2 = false;
    let surface2 = '';
    if (offered2) {
      await refundOnly([{ pid: P1000, qty: 1 }]);
      await selectRefundMethod('Avoir Client');
      const settled2 = await submitAndSettle(s2.id, 1);
      landed2 = settled2.landed;
      surface2 = settled2.surface;
      if (!landed2) console.log(`[REF-40] avoir refund refused: ${surface2}`);
    } else {
      console.log('[REF-40] s2 ticket not offered for refund while its customer is tombstoned');
    }
    const ref2 = refundRowOf(s2.id);
    // Bounded convergence window (outbox flusher cadence is 10 s): a
    // tombstoned profile must either converge within it or never.
    const usable = ref2 ? await pollValue(() => usableDelivery(ref2, C40, before2), 1000, 45000) : 0;
    const outboxDelta = Math.max(0, (outboxCustomerCredit(C40) ?? 0) - (before2.outbox ?? 0));
    const movesDelta = count('cash_movements') - before2.moves;
    console.log(`[REF-40] avoir leg: offered=${offered2} landed=${landed2} surface=${surface2} refTotal=${String(ref2?.total)} usable=${usable} outboxDelta=${outboxDelta} movesDelta=${movesDelta}`);
    expect(Number(one<Row>('SELECT deleted FROM customers WHERE id = ?', C40)?.deleted ?? 0)).toBe(1);
    if (landed2) {
      if (usable !== 1000) {
        console.log(`[REF-40] CONFIRMED EDGE-CASE VULNERABILITY [P1]: refund row #${String(ref2?.receipt_number)} committed ${String(ref2?.total)} DA for a tombstoned customer but delivered ${usable} DA through usable lanes (cash=${cashOf(ref2)}, outboxDelta=${outboxDelta}) — the avoir is parked on a profile the customer can no longer use and never converges durably: refund.rs writes no store_credit (0 hits), the durable customer row is never touched by the commit (dbq16: durable store_credit=0, deleted=1) and the only customer reflection is the outbox enqueue (createOrderSlice.ts:2975-2994, P1-6)`);
      }
      expect(usable).toBe(1000);
    } else {
      expect(usable).toBe(0);
    }
  });

  it('[REF-42] card-funded sale (CIB) refunded to a different method: Espèces refused fail-closed; Avoir must deliver — no value evaporation', async () => {
    await clearCart();
    await selectCustomer(C42_NAME);
    await addSku('REF3 P700');
    const before = txCount();
    await payByCib();
    const tx = await landedSale(before);
    const sale = { id: String(tx.id), receipt: String(tx.receipt_number) };
    console.log(`[REF-42] CIB sale: total=${String(tx.total)} method=${String(tx.payment_method)} cash_tendered=${String(tx.cash_tendered)} change_due=${String(tx.change_due)}`);
    expect(String(tx.payment_method)).toContain('CIB');
    // cash_tendered is the gross tender field (the CIB leg stores its amount
    // there); the refund funding split uses physicalCashTendered(), which sums
    // only 'Espèces' tender legs (cashTerms.ts:344-353) → cash share 0.
    const cibTenders = (jsonOf(tx).tenders ?? []) as Array<{ method?: string; amount?: number }>;
    const cashLegs = cibTenders.filter((t) => /Espèces/i.test(String(t.method))).reduce((s, t) => s + Number(t.amount ?? 0), 0);
    console.log(`[REF-42] funding probe: tenders=${JSON.stringify(cibTenders)} espècesLegs=${cashLegs} cash_tendered=${String(tx.cash_tendered)}`);
    expect(cashLegs).toBe(0);

    // Leg 1 — cashier picks "Espèces" on a card-funded ticket. No cash share
    // exists (clampCashRefund: want=cashShare=0 → cashOut=0, overflow=0), so
    // the request goes out method=Espèces with cashMove=null
    // (createOrderSlice.ts:2227, :2741) — native must refuse INVALID.
    const before1 = { col: creditRaw(C42).col, payload: creditRaw(C42).payload, vault: voucherTotal(), outbox: outboxCustomerCredit(C42) };
    const movesBefore1 = count('cash_movements');
    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P700, qty: 1 }]);
    await selectRefundMethod('Espèces');
    const settled1 = await submitAndSettle(sale.id, 1);
    const ref1 = refundRowOf(sale.id);
    const surface1 = settled1.surface;
    console.log(`[REF-42] Espèces attempt: landed=${settled1.landed} surface=${surface1} refRow=${ref1 ? `${String(ref1?.total)} DA / ${String((jsonOf(ref1) as Row).refundMethod)}` : '(none)'}`);
    expect(count('cash_movements')).toBe(movesBefore1); // drawer never moved for a card-funded ticket
    if (ref1) {
      // Committed anyway (silent switch): then the value MUST flow somewhere usable.
      const delivered1 = await pollValue(() => usableDelivery(ref1, C42, before1), 700);
      console.log(`[REF-42] Espèces leg committed: delivered=${delivered1}`);
      if (delivered1 !== 700) {
        console.log('[REF-42] CONFIRMED EDGE-CASE VULNERABILITY [P1]: Espèces-route refund committed for a card-funded ticket without delivering value to any usable lane (drawer untouched; walletAddBase collapses to 0 — createOrderSlice.ts:2243-2244, refund.rs:956-958 INVALID guard not reached because the client switched the method)');
      }
      expect(delivered1).toBe(700);
    }

    // Leg 2 — Avoir Client. Whatever commits must deliver 700 through a usable
    // lane; the app's own audit line (*"rail d'origine à reverser 700 DA
    // (jamais en espèces)"*, createOrderSlice.ts:2615-2618) admits the digital
    // rail has no return lane.
    let landed2 = false;
    let surface2 = '';
    if (!ref1) {
      await selectRefundMethod('Avoir Client');
      const settled2 = await submitAndSettle(sale.id, 1);
      landed2 = settled2.landed;
      surface2 = settled2.surface;
      console.log(`[REF-42] Avoir attempt: landed=${landed2} surface=${surface2}`);
    }
    let ref2 = refundRowOf(sale.id);
    if (!ref2) {
      // Late-landing guard: a partial-visibility race must not fall into the
      // vacuous no-row branch (run 2's ref2 read preceded the commit by a
      // hair and `expect(delivered).toBe(0)` passed without observing
      // anything).
      await pollValue(() => refundsFor(sale.id).length, 1, 8000, 500);
      ref2 = refundRowOf(sale.id);
    }
    // The Avoir must deliver through a usable lane; bounded 60 s convergence
    // window (10 s outbox flusher cadence) before calling it evaporated.
    const delivered = await pollValue(() => usableDelivery(ref2, C42, before1), 700, 60000);
    const outboxDelta = Math.max(0, (outboxCustomerCredit(C42) ?? 0) - (before1.outbox ?? 0));
    const movesDelta2 = count('cash_movements') - movesBefore1;
    console.log(`[REF-42] outcome: row=${ref2 ? `${String(ref2.total)} DA / ${String((jsonOf(ref2) as Row).refundMethod)}` : '(none)'} delivered=${delivered} outboxDelta=${outboxDelta} movesDelta=${movesDelta2} refunds=${refundsFor(sale.id).length}`);
    if (ref2) {
      if (delivered !== 700) {
        console.log(`[REF-42] CONFIRMED EDGE-CASE VULNERABILITY [P1]: committed refund #${String(ref2.receipt_number)} for ${String(ref2.total)} DA on a card-funded ticket delivers ${delivered} DA (cash=0) — funding.cashShare=0 for digital rails and walletAddBase collapses to 0 (createOrderSlice.ts:2243-2244), so a landed refund row evaporates the customer's value; the audit text itself expects "rail d'origine à reverser ${700} DA" with no lane implementing it (createOrderSlice.ts:2615-2618)`);
      }
      expect(delivered).toBe(700);
      // The wallet mirror must agree with the column it mirrors (no split-brain),
      // asserted SEPARATELY from delivery so a mirror drift can never be read as
      // a second payment.
      if (C42 && creditRaw(C42).col !== null) {
        expect(creditRaw(C42).payload).toBe(creditRaw(C42).col);
      }
    } else {
      expect(delivered).toBe(0);
    }
  });

  it('[REF-90] refund destination switch (Avoir → Espèces): final choice wins, exactly one payout, no card/account destination exists', async () => {
    const sale = await makeCashSaleTo('REF3 P500', 1, C90_NAME);
    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    const fields = await refundDialogFields();
    console.log(`[REF-90] refund dialog editable fields: ${JSON.stringify(fields)}`);
    expect(fields.some((f) => /compte|rib|iban|card|carte|destination/i.test(f))).toBe(false);

    await selectRefundMethod('Avoir Client');
    await selectRefundMethod('Espèces');
    const movesBefore = count('cash_movements');
    const outboxBefore = outboxCustomerCredit(C90);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-90] surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);
    const ref = refundRowOf(sale.id);
    const method = String((jsonOf(ref) as Row).refundMethod ?? '');
    const moves = count('cash_movements') - movesBefore;
    const outboxDelta = Math.max(0, (outboxCustomerCredit(C90) ?? 0) - (outboxBefore ?? 0));
    console.log(`[REF-90] committed: method=${method} total=${String(ref?.total)} cash=${cashOf(ref)} movements=+${moves} outboxCreditDelta=${outboxDelta}`);
    expect(Number(ref?.total)).toBe(500);
    expect(cashOf(ref)).toBe(500);
    expect(moves).toBe(1); // exactly one drawer movement — the last choice
    expect(refundsFor(sale.id).length).toBe(1);
    expect(method).toContain('Esp');
    expect(outboxDelta).toBe(0); // no phantom wallet credit on a cash payout
  });

  it('[REF-48] refund-then-void and void-then-refund: both directions refuse the second operation (no double restore, no double payout)', async () => {
    const base = stockOf(P500);
    // Direction 1 — refund first, void second.
    const s1 = await makeCashSaleTo('REF3 P500', 1, C48_NAME);
    expect(stockOf(P500)).toBe(base - 1);
    expect(await beginRefund(s1.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    const st1 = await submitAndSettle(s1.id, 1);
    if (!st1.landed) console.log(`[REF-48] refund surface: ${st1.surface}`);
    expect(st1.landed).toBe(true);
    expect(stockOf(P500)).toBe(base);
    expect(String(txRow(s1.id)?.status)).toBe('REFUNDED');

    const movesBeforeVoid = count('cash_movements');
    const vres = await voidSaleViaReports(s1.receipt, 'E2E REF-48 annulation après remboursement');
    await browser.pause(1200);
    const statusAfterVoid = String(txRow(s1.id)?.status);
    // Refusals surface as toasts (ReportsModal.tsx:558-575 routes every void
    // failure through showToast) or a dialog-parked error. Run 2 read the
    // body tail once, 1.2 s after the click, and missed it — poll all three
    // channels for up to 9 s before concluding the app stayed silent.
    let refusalSeen = false;
    let tail1 = '';
    let voidCtx = '';
    let voidToasts = '';
    const tRefusal = Date.now();
    while (Date.now() - tRefusal < 9000 && !refusalSeen) {
      tail1 = await bodyTail();
      voidCtx = (await bodyContexts('TICKET_REFUNDED', 80, 2)).join(' | ');
      voidToasts = await visibleToasts();
      refusalSeen = /TICKET_REFUNDED|déjà|Erreur lors de l'annulation/i.test(`${tail1} ${voidCtx} ${voidToasts}`);
      if (!refusalSeen) await browser.pause(700);
    }
    console.log(`[REF-48] void-after-refund: sawForm=${vres.sawForm} confirmed=${vres.confirmed} status=${statusAfterVoid} refusalSeen=${refusalSeen} toasts=${JSON.stringify(voidToasts)} tail=${JSON.stringify(tail1.slice(-240))} ctx=${JSON.stringify(voidCtx)}`);
    if (vres.sawForm && vres.confirmed) {
      console.log(`[REF-48] void-after-refund refusal surface seen=${refusalSeen}`);
      expect(refusalSeen).toBe(true);
    } else {
      console.log('[REF-48] void control not reachable for a refunded ticket (fail-closed UI lane)');
    }
    expect(String(txRow(s1.id)?.status)).toBe('REFUNDED'); // never flips (createOrderSlice.ts:1674-1676); re-read after the 9 s refusal window
    expect(refundsFor(s1.id).length).toBe(1);
    expect(stockOf(P500)).toBe(base); // no second restock
    expect(count('cash_movements')).toBe(movesBeforeVoid); // no second payout
    // the void flow leaves the Reports modal open; its overlay intercepted
    // d2's first real click in run 3 (clients-button under
    // "Rapports financiers") — close it before direction 2.
    await closeReportsDialog();

    // Direction 2 — void first, refund second.
    const s2 = await makeCashSaleTo('REF3 P500', 1, C48_NAME);
    expect(stockOf(P500)).toBe(base - 1);
    const vres2 = await voidSaleViaReports(s2.receipt, 'E2E REF-48 annulation immédiate');
    // Wait for the app's own success toast, not just the DB flip: the slice
    // commits the store (`transactions: updatedTransactions`,
    // createOrderSlice.ts:2042-2049) only AFTER the native adapter returns,
    // while the DB status flips at the START of that adapter. Run 4 polled the
    // DB, closed Reports immediately and opened Refund inside that window —
    // the modal saw a stale COMPLETED snapshot and offered the voided ticket.
    // The Reports modal is a full-screen overlay, so that window is not
    // cashier-reachable; wait for the toast (shown after the store commit)
    // before judging the refund list.
    const voidSettled = await pollUntil(
      async () => /annul[ée]e avec succ[èe]s/i.test(await visibleToasts()),
      15000,
      'void success toast not seen',
    ).catch(() => false);
    console.log(`[REF-48] void-first: sawForm=${vres2.sawForm} confirmed=${vres2.confirmed} uiSettled=${voidSettled}`);
    const voided = await pollUntil(() => String(txRow(s2.id)?.status) === 'VOIDED', 20000, 'void did not flip status');
    console.log(`[REF-48] void-first: voided=${voided}`);
    expect(voided).toBe(true);
    await closeReportsDialog(); // same overlay must not intercept beginRefund
    const stockAfterVoid = stockOf(P500);
    const voidOutbox = one<Row>("SELECT updated_at FROM sync_outbox WHERE entity_type='order' AND entity_id=?", s2.id);
    const voidLedgerRows = Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM inventory_ledger WHERE ref_id=? AND reason='VOID'", s2.id)?.n ?? 0);
    const voidAuditRows = Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM security_audit_logs WHERE details LIKE ?", `%${s2.receipt}%`)?.n ?? 0);
    console.log(`[REF-48] void side effects: saleCreatedAt=${String(txRow(s2.id)?.created_at)} outboxUpdatedAt=${String(voidOutbox?.updated_at)} voidLedgerRows=${voidLedgerRows} auditRows=${voidAuditRows}`);
    console.log(`[REF-48] stock after void=${stockAfterVoid} (P1-4 residual: void lane aborts its restock after the status flip)`);

    let offered = false;
    try {
      offered = await beginRefund(s2.receipt, 6000);
    } catch (e) {
      console.log(`[REF-48] beginRefund threw: ${String((e as Error)?.message ?? e)}`);
    }
    console.log(`[REF-48] refund of voided ticket offered=${offered}`);
    await closeRefund().catch(() => {});
    // Probe the native lane BEFORE the UI assertion so a UI fail-open still
    // records whether the backend refuses fail-closed (money safety).
    const probe = await invokeForgedRefund(buildForgedRefund(s2.id, 1));
    console.log(`[REF-48] forged refund of voided ticket: ok=${probe.ok} raw=${probe.raw}`);
    expect(probe.ok).toBe(false);
    expect(probe.raw).toContain('ORIGINAL_VOIDED');
    expect(offered).toBe(false); // UI must not offer a voided ticket
    expect(refundsFor(s2.id).length).toBe(0);
    expect(stockOf(P500)).toBe(stockAfterVoid); // the refused lane restocks nothing
  });

  it('[REF-56] previous-period sale refunded today: durable linkage + current-period reporting (summary line + AVOIR history filter)', async () => {
    const sale = await makeCashSaleTo('REF3 P500', 1, C56_NAME);
    const iso40 = new Date(Date.now() - 40 * 86400000).toISOString();
    run("UPDATE transactions SET created_at = datetime('now','-40 days'), updated_at = datetime('now','-40 days') WHERE id = ?", sale.id);
    const j = jsonOf(txRow(sale.id));
    j.createdAt = iso40;
    j.created_at = iso40;
    run('UPDATE transactions SET json_payload = ? WHERE id = ?', JSON.stringify(j), sale.id);
    console.log(`[REF-56] backdated sale created_at=${String(txRow(sale.id)?.created_at)}`);

    // Durable delta oracle (run 3 read only a presence substring — "500" sat
    // inside "-9 900"): the summary's returns line must move by exactly the
    // refunded 500 DA when the refund lands.
    const returnsBefore = await readReturnsLine();
    console.log(`[REF-56] returns line before refund: ${String(returnsBefore)}`);
    expect(returnsBefore).not.toBeNull();

    expect(await beginRefund(sale.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    await selectRefundMethod('Avoir Client');
    await setRefundReason('Autre');
    await typeRefundCustomReason('E2E REF-56 motif personnalisé');
    await browser.pause(250);
    const settled = await submitAndSettle(sale.id, 1);
    if (!settled.landed) console.log(`[REF-56] refund surface: ${settled.surface}`);
    expect(settled.landed).toBe(true);

    const ref = refundRowOf(sale.id);
    const rj = jsonOf(ref) as Row;
    const refCreated = String(ref?.created_at ?? '');
    // SQLite writes ISO-8601 with 'T' + 'Z' here; only space-separated stamps
    // need normalization (run 2 appended a second 'Z' → NaN → false fail).
    const refMs = Date.parse(refCreated.includes('T') ? refCreated : `${refCreated.replace(' ', 'T')}Z`);
    const fresh = /^\d{4}-\d{2}-\d{2}/.test(refCreated) && Number.isFinite(refMs) && refMs > Date.now() - 86400000;
    console.log(`[REF-56] refund row: receipt=${String(ref?.receipt_number)} created_at=${refCreated} today=${fresh} link=${String(rj.originalTransactionId)} method=${String(rj.refundMethod)} reason=${JSON.stringify(rj.refundReason)} items=${JSON.stringify(((rj.refundedItems as Row[] | undefined) ?? []).map((i) => ({ pid: i.productId, q: i.quantity })))}`);
    expect(String(ref?.original_transaction_id)).toBe(sale.id);
    expect(String(rj.originalTransactionId)).toBe(sale.id);
    expect(String(rj.refundReason ?? '')).toContain('REF-56');
    expect(fresh).toBe(true); // refund belongs to the CURRENT period

    const returnsAfter = await readReturnsLine();
    console.log(`[REF-56] returns line after refund: ${String(returnsAfter)} (before=${String(returnsBefore)}, delta=${returnsAfter !== null && returnsBefore !== null ? returnsAfter - returnsBefore : 'n/a'})`);
    expect(returnsAfter).toBe(Number(returnsBefore) + 500);

    // readReturnsLine() closes the Reports modal; reopen it before the history
    // leg (run 4 called openReportsHistoryTab on the POS screen, typed the
    // receipt into the catalog search and read found=false).
    await openReports();
    await unlockReportsGate();
    await openReportsHistoryTab();
    const filtered = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const sels = ([...document.querySelectorAll('select')] as HTMLSelectElement[]).filter(vis);
      const statusSel = sels.find((s) => [...s.options].some((o) => o.value === 'isRefund')) ?? null;
      const dateSel = sels.find((s) => [...s.options].some((o) => o.value === 'today')) ?? null;
      const setSel = (s: HTMLSelectElement | null, v: string) => {
        if (!s) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(s, v);
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      return { status: setSel(statusSel, 'isRefund'), date: setSel(dateSel, 'today') };
    })) as { status: boolean; date: boolean };
    console.log(`[REF-56] history filters set: ${JSON.stringify(filtered)}`);
    await browser.pause(700);
    const refReceipt = String(ref?.receipt_number ?? '');
    await browser.execute((rc: string) => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      // Scope to the Reports dialog: the POS catalog search sits behind the
      // overlay and is still "visible" by rect, so a document-wide first match
      // types the receipt into the catalog (run 5: filters set, but the list
      // never narrowed and the receipt row was never rendered).
      const dlg = ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).find(
        (d) => vis(d) && /Rapports financiers/.test(d.getAttribute('aria-label') || ''),
      );
      const inputs = (dlg ? [...dlg.querySelectorAll('input')] : [...document.querySelectorAll('input')]) as HTMLInputElement[];
      const search = inputs.find((i) => vis(i) && /recherch/i.test(i.placeholder || ''));
      if (search) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(search, rc);
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, refReceipt);
    await browser.pause(600);
    // Full rendered dialog text, not bodyTail(): the history list is long and
    // the newest row is at the top, outside a bottom slice. Scoped to the
    // dialog so a stray toast carrying the receipt cannot satisfy the oracle.
    const hist = (await browser.execute(() => {
      const vis = (d: HTMLElement) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } };
      const dlg = ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).find(
        (d) => vis(d) && /Rapports financiers/.test(d.getAttribute('aria-label') || ''),
      );
      return dlg ? dlg.innerText : document.body.innerText;
    })) as string;
    const foundRefund = hist.includes(refReceipt);
    console.log(`[REF-56] history (today + isRefund + search "${refReceipt}"): found=${foundRefund} hasAvoirBadge=${hist.includes('AVOIR')} tail=${JSON.stringify(hist.slice(-260))}`);
    expect(foundRefund).toBe(true);
  });

  it('[REF-58] double-submit race: UI double-click and concurrent forged pair — exactly one refund row, loser refused, one restock', async () => {
    // (a) UI double-click on the same submit button.
    const base = stockOf(P500);
    const s1 = await makeCashSale('REF3 P500', 1);
    expect(stockOf(P500)).toBe(base - 1);
    expect(await beginRefund(s1.receipt)).toBe(true);
    await refundOnly([{ pid: P500, qty: 1 }]);
    await submitRefund(APP_PIN, 2); // two synchronous clicks
    await waitRefundRows(s1.id, 1).catch((e) => console.log(`[REF-58] no refund row after double-click: ${String((e as Error)?.message ?? e)}`));
    await browser.pause(1800);
    const rows1 = refundsFor(s1.id);
    console.log(`[REF-58] UI double-click: rows=${rows1.length} totals=${JSON.stringify(rows1.map((r) => Number(r.total)))} stock=${stockOf(P500)}`);
    expect(rows1.length).toBe(1);
    // The restock of the refunded unit lands slightly after the refund row in a
    // busy batch; wait for convergence instead of reading one instant (the
    // assertion is unchanged: exactly one unit is back).
    await browser
      .waitUntil(async () => stockOf(P500) === base, { timeout: 15000, interval: 250 })
      .catch(() => undefined);
    expect(stockOf(P500)).toBe(base);

    // (b) Concurrent forged pair — one request object, two racing invokes in
    // the same page task. After the D4-A hardening a forged request cannot
    // produce a cash payout without a drawer movement, so BOTH legs are
    // refused before any write: the stronger contract replaces the old
    // "one of the pair lands" expectation (a forged payout that cannot be
    // traced must never land). Concurrency dedupe itself is covered by (a)
    // above and by the forged re-refund probes (REF-60/REF-41).
    const s2 = await makeCashSale('REF3 P500', 1);
    const req = buildForgedRefund(s2.id, 1);
    const pair = await invokeForgedRefundPair(req);
    const oks = pair.filter((p) => p.ok).length;
    console.log(`[REF-58] forged pair: ok=${oks} results=${JSON.stringify(pair.map((p) => ({ ok: p.ok, raw: p.raw.slice(0, 140) })))}`);
    expect(oks).toBe(0);
    for (const p of pair) {
      expect(p.raw).toMatch(/cash refund without drawer movement/);
    }
    const rows2 = refundsFor(s2.id);
    const dedup = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM refund_dedup WHERE ticket_id = ?', s2.id)?.n ?? -1);
    console.log(`[REF-58] forged pair outcome: rows=${rows2.length} dedupRows=${dedup} stock=${stockOf(P500)}`);
    expect(rows2.length).toBe(0);
    expect(dedup).toBe(0);
    expect(stockOf(P500)).toBe(base - 1);
  });

  it('[REF-52] clock integrity: high-water regression refuses UI+forged refunds (SYSTEM_CLOCK_REGRESSION); stale/future supervisor blocks refused; retry lands', async () => {
    const base700 = stockOf(P700);
    const saleA = await makeCashSale('REF3 P700', 1);
    const anchor = one<Row>('SELECT * FROM time_anchor ORDER BY rowid DESC LIMIT 1');
    if (!anchor) throw new Error('time_anchor row missing');
    const cols = Object.keys(anchor);
    console.log(`[REF-52] anchor before: ${JSON.stringify(anchor)}`);
    const baseHigh = Math.round(Number(anchor.high_water_ms ?? 0));
    run('UPDATE time_anchor SET high_water_ms = ? WHERE id = ?', baseHigh + 2 * 3600 * 1000, String(anchor.id));
    console.log(`[REF-52] high_water raised: ${String(one<Row>('SELECT high_water_ms FROM time_anchor WHERE id = ?', String(anchor.id))?.high_water_ms)}`);
    try {
      expect(await beginRefund(saleA.receipt)).toBe(true);
      await refundOnly([{ pid: P700, qty: 1 }]);
      const declined = await submitAndSettle(saleA.id, 1);
      console.log(`[REF-52] UI refund under bad clock: landed=${declined.landed} surface=${declined.surface}`);
      expect(declined.landed).toBe(false);
      const probe = await invokeForgedRefund({
        ...buildForgedRefund(saleA.id, 1),
        supervisor: { userId: 'usr-admin', verifiedAt: new Date().toISOString() },
      });
      console.log(`[REF-52] forged refund under bad clock: ok=${probe.ok} raw=${probe.raw}`);
      expect(probe.ok).toBe(false);
      expect(probe.raw).toContain('SYSTEM_CLOCK_REGRESSION');
      expect(refundsFor(saleA.id).length).toBe(0);
      expect(stockOf(P700)).toBe(base700 - 1);
    } finally {
      const restCols = cols.filter((c) => c !== 'id');
      run(`UPDATE time_anchor SET ${restCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...restCols.map((c) => anchor[c]), String(anchor.id));
      console.log(`[REF-52] anchor restored: high_water=${String(one<Row>('SELECT high_water_ms FROM time_anchor WHERE id = ?', String(anchor.id))?.high_water_ms)}`);
    }
    // Retry the same refund after restore — must land exactly once.
    if (!(await refundDialogVisible())) {
      expect(await beginRefund(saleA.receipt)).toBe(true);
    }
    await refundOnly([{ pid: P700, qty: 1 }]);
    const retry = await submitAndSettle(saleA.id, 1);
    console.log(`[REF-52] retry after restore: landed=${retry.landed} surface=${retry.surface}`);
    expect(retry.landed).toBe(true);
    expect(Number(refundRowOf(saleA.id)?.total)).toBe(700);
    expect(stockOf(P700)).toBe(base700);

    // Supervisor freshness (both future and stale) on a fresh sale.
    const saleB = await makeCashSale('REF3 P700', 1);
    const stale = await invokeForgedRefund({
      ...buildForgedRefund(saleB.id, 1),
      supervisor: { userId: 'usr-admin', verifiedAt: new Date(Date.now() - 130000).toISOString() },
    });
    const future = await invokeForgedRefund({
      ...buildForgedRefund(saleB.id, 1),
      supervisor: { userId: 'usr-admin', verifiedAt: new Date(Date.now() + 45000).toISOString() },
    });
    console.log(`[REF-52] supervisor probes: stale ok=${stale.ok} raw=${stale.raw} | future ok=${future.ok} raw=${future.raw}`);
    expect(stale.ok).toBe(false);
    expect(stale.raw).toContain('SUPERVISOR_AUTH_EXPIRED');
    expect(future.ok).toBe(false);
    expect(future.raw).toContain('SUPERVISOR_AUTH_FUTURE_DATED');
    expect(refundsFor(saleB.id).length).toBe(0);
    expect(stockOf(P700)).toBe(base700 - 1);
  });

  it('[PAY-22] trade-in (Reprise) sale: subtotal 1000, tenders 700 Espèces + 300 Reprise, net-of-credit totals, no refund leg', async () => {
    await purgeStagedTradeIn();
    await clearCart();
    await addSku('REF3 P1000');
    const staged = await stageTradeIn(TRADE_IMEI, 300);
    console.log(`[PAY-22] trade-in staged=${staged}`);
    expect(staged).toBe(true);
    await browser.pause(400);
    const stagedTotal = await cartTotalMinor().catch(() => null);
    console.log(`[PAY-22] cart total after staging=${stagedTotal} minor (expect 70000)`);
    let hit = await checkoutHittable();
    if (!hit.ok) {
      await waitForCheckoutHittable(10000);
      hit = await checkoutHittable();
    }
    if (!hit.ok) {
      console.log(`[PAY-22] checkout blocked by ${hit.blockedBy} — Escape`);
      await browser.keys(['Escape']).catch(() => {});
      await browser.pause(400);
      await waitForCheckoutHittable(8000);
      hit = await checkoutHittable();
    }
    expect(hit.ok).toBe(true);
    const before = txCount();
    await payExactFlow();
    const tx = await landedSale(before);
    const sale = { id: String(tx.id), receipt: String(tx.receipt_number) };
    const j = jsonOf(tx);
    const tenders = (j.tenders ?? []) as Array<{ method?: string; amount?: number }>;
    const tendersSum = tenders.reduce((s, t) => s + Math.max(0, Number(t.amount) || 0), 0);
    const tradeInDeduction = Math.max(0, Number(j.tradeInDeduction ?? 0));
    console.log(`[PAY-22] sale total=${String(tx.total)} subtotal=${String(tx.subtotal)} cash_tendered=${String(tx.cash_tendered)} tenders=${JSON.stringify(tenders)} sum=${tendersSum} tradeInDeduction=${tradeInDeduction} tradeInId=${String(j.tradeInId)}`);
    expect(Number(tx.subtotal)).toBe(1000);
    expect(tradeInDeduction).toBe(300);
    expect(tendersSum).toBe(1000);
    expect(tenders.some((t) => /Reprise/i.test(String(t.method)) && Math.round(Number(t.amount)) === 300)).toBe(true);
    expect(tenders.some((t) => /Espèces/i.test(String(t.method)) && Math.round(Number(t.amount)) === 700)).toBe(true);
    expect(Number(tx.cash_tendered)).toBe(700);
    expect(Number(tx.total)).toBe(700); // P1-5 model: row total nets the credit
    expect(refundsFor(sale.id).length).toBe(0);

    const tradeRows = count('trade_ins');
    const newestTrade = one<Row>('SELECT * FROM trade_ins ORDER BY rowid DESC LIMIT 1');
    console.log(`[PAY-22] trade_ins rows=${tradeRows} newest keys=${newestTrade ? Object.keys(newestTrade).join(',') : '(none)'} newest=${JSON.stringify(newestTrade ?? {})}`.slice(0, 400));
    expect(tradeRows).toBeGreaterThanOrEqual(1);
    await purgeStagedTradeIn();
    console.log('[PAY-22] RESIDUAL [P1-5 documented]: sale row `total` is net of the trade-in credit (700) while tenders sum 1000 — the credit leg is real money value (reprise) recorded only as tradeInDeduction; G-01/G-03 invariant hooks cover the ledger impact');
  });

  it('[REF-24] rapid-refund velocity: no velocity engine — forged under-threshold lands, over-threshold needs supervisor, UI small refunds all land exactly', async () => {
    await closeShiftUi();
    const float = await openShiftBestEffort(10000);
    console.log(`[REF-24] shift rotated (float ${float}) — bucket reset`);
    const base = stockOf(P500);

    // Forged under-threshold: 4500 cash, no supervisor → commits (4500 ≤ 5000).
    await clearCart();
    await addSku('REF3 P500', { times: 9 });
    const before1 = txCount();
    await payExactFlow();
    const tx1 = await landedSale(before1);
    const s4500 = { id: String(tx1.id) };
    const itemRows = all<Row>('SELECT quantity FROM transaction_items WHERE transaction_id = ?', s4500.id);
    const qty1 = itemRows.reduce((s, r) => s + Number(r.quantity), 0);
    console.log(`[REF-24] sale1=${s4500.id} total=${String(tx1.total)} itemRows=${itemRows.length} qty=${qty1}`);
    expect(itemRows.length).toBe(1);
    expect(qty1).toBe(9);
    const movId1 = `MOV-REF24-UNDER-${Date.now()}`;
    const probeUnder = await invokeForgedRefund({
      ...buildForgedRefund(s4500.id, qty1),
      method: 'Espèces',
      cashMove: { id: movId1, sessionId: openShiftId() ?? '', amount: 4500, reason: 'E2E REF-24 forged under-threshold', cashierName: 'E2E' },
    });
    console.log(`[REF-24] forged under-threshold 4500: ok=${probeUnder.ok} raw=${probeUnder.raw}`);
    expect(probeUnder.ok).toBe(true);
    const refUnder = refundRowOf(s4500.id);
    const movUnder = one<Row>('SELECT * FROM cash_movements WHERE id = ?', movId1);
    console.log(`[REF-24] under-threshold refund row: total=${String(refUnder?.total)} movement=${String(movUnder?.amount)}`);
    expect(Math.round(Number(refUnder?.total))).toBe(4500);
    expect(Math.round(Number(movUnder?.amount))).toBe(4500);
    expect(stockOf(P500)).toBe(base);

    // Forged over-threshold: 5500 cash, no supervisor → refused at Module C.
    // Bucket 4500 + 5500 = 10000 = cap, so the shift-cap check passes and the
    // supervisor threshold is the gate under test.
    await clearCart();
    await addSku('REF3 P500', { times: 11 });
    const before2 = txCount();
    await payExactFlow();
    const tx2 = await landedSale(before2);
    const s5500 = { id: String(tx2.id) };
    const qty2 = all<Row>('SELECT quantity FROM transaction_items WHERE transaction_id = ?', s5500.id).reduce((s, r) => s + Number(r.quantity), 0);
    expect(qty2).toBe(11);
    const probeOver = await invokeForgedRefund({
      ...buildForgedRefund(s5500.id, qty2),
      method: 'Espèces',
      cashMove: { id: `MOV-REF24-OVER-${Date.now()}`, sessionId: openShiftId() ?? '', amount: 5500, reason: 'E2E REF-24 forged over-threshold', cashierName: 'E2E' },
    });
    console.log(`[REF-24] forged over-threshold 5500: ok=${probeOver.ok} raw=${probeOver.raw}`);
    expect(probeOver.ok).toBe(false);
    expect(probeOver.raw).toContain('SUPERVISOR_PIN_REQUIRED');
    expect(refundsFor(s5500.id).length).toBe(0);

    // UI small refunds in rapid succession — each lands exactly once.
    const smalls: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const s = await makeCashSale('REF3 P500', 1);
      expect(await beginRefund(s.receipt)).toBe(true);
      await refundOnly([{ pid: P500, qty: 1 }]);
      const settled = await submitAndSettle(s.id, 1);
      if (!settled.landed) console.log(`[REF-24] small refund #${i} surface: ${settled.surface}`);
      expect(settled.landed).toBe(true);
      expect(cashOf(refundRowOf(s.id))).toBe(500);
      smalls.push(s.id);
      await browser.pause(350);
    }
    const uiCash = smalls.reduce((s, id) => s + (Number.isFinite(cashOf(refundRowOf(id))) ? cashOf(refundRowOf(id)) : 0), 0);
    console.log(`[REF-24] rapid small refunds: ${smalls.length} × 500 = ${uiCash}; forged 4500 landed; forged 5500 refused; shift cash out = ${4500 + uiCash} ≤ cap 10000`);
    expect(uiCash).toBe(1500);
    console.log('[REF-24] RESIDUAL [P2]: no velocity/pattern engine — the containment is per-ticket + per-shift cash caps + a manager PIN on every refund (native Module B/C); a determined cashier can drain up to the shift cap in one shift (documented, fail-closed at the cap)');
  });

  it('[REF-51] offline cash cap knob (2500→5000): TS pre-check switches to Avoir at the cap; raised policy lets more cash land; wallet never negative', async () => {
    await closeShiftUi();
    const float = await openShiftBestEffort(10000);
    console.log(`[REF-51] shift rotated (float ${float})`);
    seedSettings([{ key: 'policy.offline_cash_refund_limit', valueJson: '2500' }]);
    console.log(`[REF-51] policy.offline_cash_refund_limit=${String(one<Row>("SELECT value_json FROM app_settings WHERE key = 'policy.offline_cash_refund_limit'")?.value_json)}`);

    // S1 — 2000 cash refund lands under the 2500 cap.
    const s1 = await makeCashSaleTo('REF3 P1000', 2, C51_NAME);
    expect(Number(s1.total)).toBe(2000);
    expect(await beginRefund(s1.receipt)).toBe(true);
    await refundOnly([{ pid: P1000, qty: 2 }]);
    const settled1 = await submitAndSettle(s1.id, 1);
    if (!settled1.landed) console.log(`[REF-51] s1 surface: ${settled1.surface}`);
    expect(settled1.landed).toBe(true);
    const r1 = refundRowOf(s1.id);
    console.log(`[REF-51] s1 refund: total=${String(r1?.total)} cash=${cashOf(r1)} method=${String((jsonOf(r1) as Row).refundMethod)}`);
    expect(cashOf(r1)).toBe(2000);

    // S2 — next 1000 cash refund: shift bucket 2000+1000 > 2500 → pre-check
    // refuses, modal auto-switches to Avoir Client, revalidation lands it.
    const s2 = await makeCashSaleTo('REF3 P1000', 1, C51_NAME);
    expect(await beginRefund(s2.receipt)).toBe(true);
    await refundOnly([{ pid: P1000, qty: 1 }]);
    const settled2 = await submitAndSettle(s2.id, 1);
    const r2 = refundRowOf(s2.id);
    if (settled2.landed) {
      const m2 = String((jsonOf(r2) as Row).refundMethod ?? '');
      console.log(`[REF-51] s2 refund after cap: method=${m2} total=${String(r2?.total)} cash=${cashOf(r2)}`);
      expect(m2).toContain('Avoir');
      expect(cashOf(r2)).toBe(0);
    } else {
      // Fail-closed variant: the cap may surface as a refusal (toast) or as a
      // closed dialog after the Avoir switch. Either way no cash left the till
      // and no refund row may exist for s2.
      console.log(`[REF-51] s2 refused at the cap: ${settled2.surface}`);
      if (settled2.surface === 'refund-dialog-closed') {
        expect(refundsFor(s2.id).length).toBe(0);
        console.log('[REF-51] s2 dialog closed by the cap pre-check: no refund row, no cash');
      } else {
        expect(settled2.surface).toMatch(/Plafond|OFFLINE_CASH_CAP|cap/i);
      }
      await closeRefund().catch(() => {});
    }
    expect(cashOf(refundRowOf(s1.id))).toBe(2000); // s1 bucket unchanged either way

    // Raise the cap to 5000 — another 2000 refund must land in cash.
    seedSettings([{ key: 'policy.offline_cash_refund_limit', valueJson: '5000' }]);
    const s3 = await makeCashSaleTo('REF3 P1000', 2, C51_NAME);
    expect(await beginRefund(s3.receipt)).toBe(true);
    await refundOnly([{ pid: P1000, qty: 2 }]);
    const settled3 = await submitAndSettle(s3.id, 1);
    if (!settled3.landed) console.log(`[REF-51] s3 surface: ${settled3.surface}`);
    expect(settled3.landed).toBe(true);
    const r3 = refundRowOf(s3.id);
    console.log(`[REF-51] s3 refund after raise: method=${String((jsonOf(r3) as Row).refundMethod)} total=${String(r3?.total)} cash=${cashOf(r3)}`);
    expect(cashOf(r3)).toBe(2000);

    seedSettings([{ key: 'policy.offline_cash_refund_limit', valueJson: '10000' }]);
    const cashTotal = cashOf(r1) + cashOf(r3);
    console.log(`[REF-51] final: cash refunds 2000+2000=${cashTotal} ≤ raised cap 5000; wallet durable=${String(effCredit(C51))} ≥ 0`);
    expect(cashTotal).toBe(4000);
    expect(effCredit(C51) >= 0 || Number.isNaN(effCredit(C51))).toBe(true);
  });

  it('[REF-87] extreme values: 2 000 000 000 DA units — two 1-unit refunds exact at the full price (leg B owner-gated)', async () => {
    const base = stockOf(PMAX);
    // Leg A — no discount: 2 × 2e9 = 4e9 cash. The commit is watched directly
    // (DB + UI liveness): run 1 died inside this sale — the pay dialog stayed
    // mounted, session latency degraded over ~28 s, then the webview vanished
    // ("no such window") with zero sale rows, no panic text, no WER entry.
    // OWNER-AUTHORISED fixture change (P0 recipient ruling): the ticket carries
    // a customer, because an offline-cap Avoir refund with no recipient can no
    // longer commit (it would credit nobody) — the app must refuse it.
    await clearCart();
    await selectCustomer(C87_NAME);
    await addSku('REF4 PMAX');
    await addSku('REF4 PMAX');
    const beforeA = txCount();
    await (await $(tid('checkout-button'))).click();
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    let landedA = false;
    const t0A = Date.now();
    while (Date.now() - t0A < 90000 && !landedA) {
      await browser.pause(5000);
      landedA = txCount() > beforeA;
      let ui = 'n/a';
      try {
        ui = (await payDialogVisible()) ? 'pay-dialog-open' : 'pay-dialog-closed';
      } catch (e) {
        ui = `session-error:${String((e as Error)?.message ?? e).slice(0, 80)}`;
      }
      console.log(`[REF-87] A commit watch +${Math.round((Date.now() - t0A) / 1000)}s landed=${landedA} ui=${ui}`);
    }
    if (!landedA) {
      console.log('[REF-87] CONFIRMED EDGE-CASE VULNERABILITY [P0]: the 4 000 000 000 DA cash commit never lands — the pay dialog stays mounted and the session degrades then dies while the sale is in flight (the maximum-value allocation path locks the terminal mid-sale; run-1 forensics: pay-confirm → 28 s of stalled pay-dialog polling → "no such window", zero sale rows)');
    }
    expect(landedA).toBe(true);
    const txA = newestTxRow();
    const saleA = { id: String(txA?.id ?? ''), receipt: String(txA?.receipt_number ?? '') };
    console.log(`[REF-87] A sale total=${String(txA?.total)} subtotal=${String(txA?.subtotal)} discount=${String(txA?.discount_total)}`);
    expect(Number(txA?.subtotal)).toBe(4000000000);
    expect(Number(txA?.discount_total)).toBe(0);
    expect(stockOf(PMAX)).toBe(base - 2);
    let stagedA = await beginRefund(saleA.receipt);
    if (!stagedA) {
      const jlenA1 = Number(one<Row>('SELECT length(json_payload) AS n FROM transactions WHERE id = ?', saleA.id)?.n ?? 0);
      console.log(`[REF-87] A ticket not selectable on attempt 1 — DB row exists (json_payload=${jlenA1} bytes, status COMPLETED, items committed); retrying once with a 30 s window`);
      await closeRefund().catch(() => {});
      stagedA = await beginRefund(saleA.receipt, 30000);
    }
    if (!stagedA) {
      const jlenA = Number(one<Row>('SELECT length(json_payload) AS n FROM transactions WHERE id = ?', saleA.id)?.n ?? 0);
      console.log(`[REF-87] CONFIRMED EDGE-CASE VULNERABILITY [P0]: the 4 000 000 000 DA ticket is never selectable in the refund modal (no-row at 9 s + 30 s) although the row exists (json_payload=${jlenA} bytes) — the sale embeds 200 000 milestone-tranche awards plus the customer's 200 009-entry loyalty ledger (loyaltyEngine.ts:1232-1254 awards one record + ledger entry per crossed tranche, uncapped), bloating the ticket to ~95 MB and making its refund lane unreachable`);
    }
    expect(stagedA).toBe(true);
    await refundOnly([{ pid: PMAX, qty: 1 }]);
    console.log(`[REF-87] A chunk1 preview=${await refundTotalMinor()} (expect 200000000000)`);
    // Run 3 proved the disabled submit was `isSubmitting`, not the foreign
    // lock (getStableDeviceId() = the row's SQLite authorship id, so
    // submitForeignLocked is false; its title would be set). The 95 MB ticket
    // commit outlives the 16 s default: give it a 4-minute window and probe
    // the button + progress so a genuine hang is distinguishable from slow.
    const settleA1 = await submitAndSettle(saleA.id, 1, { maxMs: 240000, tag: 'REF-87-A1' });
    if (!settleA1.landed) console.log(`[REF-87] A chunk1 surface: ${settleA1.surface}`);
    expect(settleA1.landed).toBe(true);
    expect(await beginRefund(saleA.receipt)).toBe(true);
    await refundOnly([{ pid: PMAX, qty: 1 }]);
    const settleA2 = await submitAndSettle(saleA.id, 2, { maxMs: 240000, tag: 'REF-87-A2' });
    if (!settleA2.landed) console.log(`[REF-87] A chunk2 surface: ${settleA2.surface}`);
    expect(settleA2.landed).toBe(true);
    const aRows = refundsFor(saleA.id);
    const aSum = aRows.reduce((s, r) => s + Math.round(Number(r.total)), 0);
    console.log(`[REF-87] A chunks: totals=${JSON.stringify(aRows.map((r) => Math.round(Number(r.total))))} sum=${aSum} stock=${stockOf(PMAX)}`);
    expect(aRows.length).toBe(2);
    expect(aRows.every((r) => Math.round(Number(r.total)) === 2000000000)).toBe(true);
    expect(aSum).toBe(4000000000);
    expect(stockOf(PMAX)).toBe(base);

    // OWNER GATE — leg B (discounted mega-refund) must NEVER execute: a
    // second ~2e9 payout on a 95 MB ticket is a repeat mega-commit risk
    // (owner directive). Hard-disabled; enabling requires an explicit owner
    // decision, not an env toggle.
    const RUN_REF87_LEG_B = false;
    if (!RUN_REF87_LEG_B) {
      console.log('[REF-87] leg B (50% discounted full refund) owner-gated — NOT executed');
    } else {
      // Leg B — 50% discount: paid 2e9 on a 4e9 basket; a full refund must
      // return EXACTLY 2e9 (P0-9: the ratio math has under-refunded every
      // discounted ticket — 2e9 here would expose a halved payout).
      await clearCart();
      await addSku('REF4 PMAX', { times: 2 });
      await applyCartDiscountPercent('50', { pin: APP_PIN });
      await browser.pause(400);
      const discounted = await cartTotalMinor();
      console.log(`[REF-87] B cart after 50%: ${discounted} minor (expect 200000000000)`);
      const beforeB = txCount();
      await payExactFlow();
      const txB = await landedSale(beforeB);
      const saleB = { id: String(txB.id), receipt: String(txB.receipt_number) };
      console.log(`[REF-87] B sale total=${String(txB.total)} subtotal=${String(txB.subtotal)} discount=${String(txB.discount_total)}`);
      expect(Number(txB?.total)).toBe(2000000000);
      expect(Number(txB?.discount_total)).toBe(2000000000);
      expect(await beginRefund(saleB.receipt)).toBe(true);
      await refundOnly([{ pid: PMAX, qty: 2 }]);
      const previewB = await refundTotalMinor();
      console.log(`[REF-87] B preview=${previewB} (expect 200000000000 — full paid value back)`);
      const settleB = await submitAndSettle(saleB.id, 1, { maxMs: 240000, tag: 'REF-87-B' });
      if (!settleB.landed) console.log(`[REF-87] B surface: ${settleB.surface}`);
      expect(settleB.landed).toBe(true);
      const refB = refundRowOf(saleB.id);
      const bTotal = Math.round(Number(refB?.total));
      console.log(`[REF-87] B committed total=${bTotal}`);
      if (bTotal !== 2000000000) {
        console.log(`[REF-87] CONFIRMED EDGE-CASE VULNERABILITY [P0]: full refund of the 50%-discounted sale paid 2 000 000 000 DA committed ${bTotal} DA — the discount is applied twice (refund ratio math under-refunds discounted tickets; REF-28 precedent: refund.rs/receiptMath funding-split ratio)`);
      }
      expect(bTotal).toBe(2000000000);
      expect(stockOf(PMAX)).toBe(base);
    }
  });
});
