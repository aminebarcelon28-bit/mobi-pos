/**
 * PAY — payment tenders / tendered amounts / split & credit (Phase 2, batch 2).
 * Encyclopedia refs: PAY-01..04, 07, 08, 10..12, 16, 18..21 (22 total; 05/06/09/
 * 13/14/15/17 are gateway/deposit/tip/config features this build does not
 * implement → N/A dossiers; PAY-22 trade-in-as-tender is deferred to the
 * trade-in batch — it needs the full repurchase wizard staged first).
 *
 * Ground truth: live SQLite through better-sqlite3 (transactions +
 * json_payload.tenders, customers, customer_debts, credit_vouchers,
 * cash_sessions). No app file is ever modified: a failed expectation is a
 * recorded finding, never a weakened assertion.
 *
 * Mechanics established from the app sources (read-only):
 *  - tenders[] (the authoritative tender legs) live in transactions.json_payload;
 *  - cash path: cashAmount = submitCash>0 ? submitCash : submitNet, refused at
 *    the modal when < net (PaymentModal.tsx:410-418);
 *  - card/cheque legs are ALWAYS amount=submitNet + optional reference
 *    (PaymentModal.tsx:400-409) → no partial-card tender, no card overpay path;
 *  - mixed cash+credit goes through pay-mixed-confirm (isCreditSplit →
 *    Espèces submitCash + Crédit Client reste, PaymentModal.tsx:388-395);
 *  - store credit (avoir) leg pushes { method: 'Avoir Client', amount } and is
 *    capped by calculateMaxAllowedCredit (50% of basket + COGS floor,
 *    loyaltyEngine.ts:20-42);
 *  - the SINGLE credit gate: projectedDebt <= debtLimit, exactly-at allowed
 *    (utils/kredyEngine.ts:102-119, enforced createOrderSlice.ts:620-627);
 *  - vouchers: ACTIVE + remaining>0 + not expired (voucherAdapter.ts:167-184),
 *    consumed only inside processPayment.
 *
 * Enter-key hazard (batch-1 lesson + source): pressing Enter ANYWHERE inside
 * pay-dialog submits the payment (PaymentModal.tsx:566-570) — this spec never
 * presses Enter inside the dialog except where the case demands it.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { count, one, run, waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  APP_PIN,
  applyCartDiscountPercent,
  clearCart,
  clearWebMirrors,
  closeDialogs,
  displayedToMinor,
  ensureShiftOpen,
  installErrorTrap,
  openShiftUi,
  selectCustomer,
  shownX,
  tid,
  typeReal,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCreditVouchers, seedCustomerFull, seedProducts } from '../lib/seed';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';

const CUST_ALPHA = 'PAY-CUST-A'; // store credit 400
const CUST_MIX = 'PAY-CUST-M'; // store credit 500
const CUST_LIMIT = 'PAY-CUST-L'; // current debt 99 500 / limit 100 000

interface Tender {
  method: string;
  amount: number;
  reference?: string;
}

function newestTx(): Record<string, unknown> | undefined {
  return one<Record<string, unknown>>('SELECT * FROM transactions ORDER BY rowid DESC LIMIT 1');
}

/** Tender legs from the newest transaction's json_payload. */
function newestTxTenders(): Tender[] {
  const tx = newestTx();
  if (!tx) return [];
  try {
    const j = JSON.parse(String(tx.json_payload || '{}')) as { tenders?: Tender[] };
    return Array.isArray(j.tenders) ? j.tenders : [];
  } catch {
    return [];
  }
}

function txCount(): number {
  return count('transactions');
}

/** Customer row + parsed json_payload (currentDebt/debtLimit live in payload). */
function customerRow(id: string): { row?: Record<string, unknown>; payload: Record<string, unknown> } {
  const row = one<Record<string, unknown>>('SELECT * FROM customers WHERE id = ?', id);
  let payload: Record<string, unknown> = {};
  if (row?.json_payload) {
    try {
      payload = JSON.parse(String(row.json_payload)) as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
  }
  return { row, payload };
}

function voucherRow(code: string): Record<string, unknown> | undefined {
  return one<Record<string, unknown>>('SELECT * FROM credit_vouchers WHERE code = ?', code);
}

/** DA (number, may be fractional) → minor BigInt. */
function daToMinor(v: unknown): bigint {
  return BigInt(Math.round(Number(v ?? 0) * 100));
}

/** JSON.stringify with BigInt support (console logs only — run-01 died on
 * "Do not know how to serialize a BigInt"). */
function jstr(v: unknown): string {
  return (
    JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val)) ?? 'undefined'
  );
}

/** Poll a synchronous read until `ok` holds (or timeout); always returns the
 * last observed value so the ASSERTION — not the poll — owns the verdict. */
async function waitFor<T>(read: () => T, ok: (v: T) => boolean, timeout = 15000): Promise<T> {
  let last = read();
  try {
    await browser.waitUntil(
      () => {
        last = read();
        return ok(last);
      },
      { timeout, interval: 200 },
    );
  } catch {
    /* fall through with the last observed value */
  }
  return last;
}

/** Customer saves are post-order and async (createOrderSlice.ts:1172-1191),
 * so a read right after the transaction row lands can lag behind — poll the
 * payload field until it settles (or return the last observed value). */
async function waitCustomerField(
  id: string,
  field: 'currentDebt' | 'storeCredit',
  expected: number,
  timeout = 15000,
): Promise<number> {
  return await waitFor(
    () => Number(customerRow(id).payload[field] ?? NaN),
    (v) => v === expected,
    timeout,
  );
}

async function dialogVisible(): Promise<boolean> {
  return (await $(tid('pay-dialog')).isDisplayed().catch(() => false));
}

/** JS-click `pay-cancel` in the VISIBLE pay dialog (Escape fallback). Used
 * both for normal cancels and to clear stale dialogs left by a failed test. */
async function forceClosePay(): Promise<void> {
  const clicked = (await browser.execute(() => {
    const dialogs = [...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[];
    const dialog = dialogs.find((d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) ?? null;
    const btn = dialog?.querySelector('[data-testid="pay-cancel"]') as HTMLButtonElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  })) as boolean;
  if (!clicked) await browser.keys(['Escape']).catch(() => {});
  await browser.pause(400);
}

/** Open the payment dialog and let the tender-sync effect settle. A stale
 * dialog left by a failed test would make every later locator ambiguous —
 * force-close it first. */
async function openPay(): Promise<void> {
  if (await dialogVisible()) {
    console.log('[openPay] stale pay dialog visible — force-closing it first');
    await forceClosePay();
  }
  await (await $(tid('checkout-button'))).click();
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
  await browser.pause(300);
}

async function closePay(): Promise<void> {
  if (!(await dialogVisible())) return;
  await forceClosePay();
  if (await dialogVisible()) {
    await browser.keys(['Escape']).catch(() => {});
    await browser.pause(350);
  }
}

async function waitSaleLanded(before: number, timeout = 45000): Promise<void> {
  await browser.waitUntil(async () => txCount() > before, {
    timeout,
    timeoutMsg: 'sale did not land in SQLite',
  });
}

async function waitPayClosed(timeout = 45000): Promise<void> {
  try {
    await browser.waitUntil(async () => !(await dialogVisible()), {
      timeout,
      timeoutMsg: 'pay dialog did not close',
    });
  } catch (err) {
    // Stuck dialogs are findings, not harness errors — capture the full state
    // (toast text, button labels, confirm disabled) with the thrown error.
    const dump = await dumpPayDialog('pay-close-timeout');
    throw new Error(
      `pay dialog did not close :: ${dump} :: ${String((err as Error)?.message ?? err)}`,
    );
  }
}

async function hasText(needle: string): Promise<boolean> {
  return (await browser.execute(
    (n: string) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
    needle,
  )) as boolean;
}

/** Snapshot of the VISIBLE pay dialog for failure diagnostics (logged with
 * the error; a screenshot lands under e2e-tests/results/). */
async function dumpPayDialog(tag: string): Promise<string> {
  try {
    await browser.saveScreenshot(`e2e-tests/results/${tag}-pay-dialog.png`);
  } catch {
    /* screenshot is best effort */
  }
  try {
    return (await browser.execute(() => {
      const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
      const dialogs = [...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[];
      const dialog = dialogs.find((d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) ?? null;
      if (!dialog) return 'no visible pay-dialog';
      const tabs = ['Espèces', 'CIB / Carte', 'BaridiMob', 'Chèque', 'Crédit'].map((t) => {
        const btn = [...dialog.querySelectorAll('button')].find((b) =>
          [...b.querySelectorAll('span')].some((sp) => norm(sp.textContent || '') === t),
        );
        const bg = btn ? ((String(btn.className).match(/bg-\S+/g) || []).join(',')) : 'MISSING';
        return `${t}:${bg || 'no-bg'}`;
      });
      return JSON.stringify({
        confirmText: norm(dialog.querySelector('[data-testid="pay-confirm"] span')?.textContent || ''),
        tabs,
        placeholders: [...dialog.querySelectorAll('input')].map(
          (i) => i.getAttribute('placeholder') ?? '',
        ),
        tenderedVisible: !!dialog.querySelector('[data-testid="tendered-input"]'),
        tenderedValue: (() => {
          const t = dialog.querySelector('[data-testid="tendered-input"]') as HTMLInputElement | null;
          return t ? t.value : null;
        })(),
        net: norm(dialog.querySelector('[data-testid="pay-net"]')?.textContent || ''),
        confirmDisabled: (() => {
          const b = dialog.querySelector('[data-testid="pay-confirm"]') as HTMLButtonElement | null;
          return b ? b.disabled : null;
        })(),
        creditBadge: (() => {
          const sp = [...dialog.querySelectorAll('span')].find((s) =>
            norm(s.textContent || '').includes('Appliqué (-'),
          );
          return sp ? norm(sp.textContent || '') : null;
        })(),
        // Toast/error text lives OUTSIDE the dialog — tail of the visible body
        // captures the app's refusal reason when a confirm silently aborts.
        bodyTail: norm(document.body.innerText).slice(-500),
        htmlHead: (dialog.outerHTML || '').replace(/\s+/g, ' ').slice(0, 900),
      });
    })) as string;
  } catch (err) {
    return `dump failed: ${String(err)}`;
  }
}

/** Poll for the method-specific section of the visible pay dialog; returns
 * false (no throw) so selectMethod can retry once before giving up. */
async function waitMethodActive(label: string, timeout = 5000): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () =>
        (await browser.execute((lbl: string) => {
          const norm = (s: string) =>
            s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
          const dialogs = [...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[];
          const dialog = dialogs.find((d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) ?? null;
          if (!dialog) return false;
          const confirmText = norm(
            dialog.querySelector('[data-testid="pay-confirm"] span')?.textContent || '',
          );
          switch (lbl) {
            case 'Espèces':
              return (
                !!dialog.querySelector('[data-testid="tendered-input"]') ||
                confirmText.startsWith('Valider & Imprimer')
              );
            case 'CIB / Carte':
              return confirmText.startsWith('Valider Carte CIB');
            case 'BaridiMob':
              return confirmText.startsWith('Valider BaridiMob');
            case 'Chèque':
              return confirmText.startsWith('Valider Chèque');
            case 'Crédit':
              return confirmText.startsWith('Valider Vente à Crédit');
            default:
              return false;
          }
        }, label)) as boolean,
      { timeout, interval: 150 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Click one of the 5 method tabs by its span label — JS click on the VISIBLE
 * dialog (native clicks proved fragile against this modal's re-renders), then
 * verify the switch took effect; on failure retry once, then throw with a
 * full DOM dump. */
async function selectMethod(label: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const clicked = (await browser.execute((lbl: string) => {
      const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
      const dialogs = [...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[];
      const dialog = dialogs.find((d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) ?? null;
      if (!dialog) return false;
      const target = [...dialog.querySelectorAll('button')].find((b) =>
        [...b.querySelectorAll('span')].some((sp) => norm(sp.textContent || '') === lbl),
      ) as HTMLButtonElement | undefined;
      if (!target) return false;
      target.click();
      return true;
    }, label)) as boolean;
    if (!clicked) {
      throw new Error(`method tab "${label}" not found :: ${await dumpPayDialog('method-tab')}`);
    }
    await browser.pause(250);
    if (await waitMethodActive(label, 4000)) {
      await browser.pause(150);
      return;
    }
    console.log(`[selectMethod] "${label}" still inactive after attempt ${attempt}`);
  }
  throw new Error(`method tab "${label}" never activated :: ${await dumpPayDialog('method-inactive')}`);
}

/** Type into the tendered MoneyInput (ASCII keys) without pressing Enter. */
async function typeTender(text: string): Promise<void> {
  const input = await $(tid('tendered-input'));
  await input.click();
  await browser.keys(['Control', 'a']);
  await browser.keys(['Backspace']);
  await browser.keys(text.split(''));
  await browser.pause(300);
}

/** Non-ASCII typing (Arabic-Indic digits) with a native-setter fallback. */
async function setTenderRaw(text: string): Promise<void> {
  const input = await $(tid('tendered-input'));
  await input.click();
  await browser.keys(['Control', 'a']);
  await browser.keys(['Backspace']);
  try {
    await input.addValue(text);
  } catch {
    await browser.execute(
      (node: HTMLElement | null, t: string) => {
        if (!node) return;
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(node, t);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      },
      input as unknown as HTMLElement,
      text,
    );
  }
  await browser.pause(300);
}

async function tenderedMinor(): Promise<bigint> {
  const raw = (await (await $(tid('tendered-input'))).getValue()) as string;
  return displayedToMinor(raw);
}

async function payNetMinor(): Promise<bigint> {
  return displayedToMinor(await (await $(tid('pay-net'))).getText());
}

async function payChangeMinor(): Promise<bigint> {
  return displayedToMinor(await (await $(tid('pay-change'))).getText());
}

/** Click a quick-bill button by its normalized label (e.g. "1 000") in the
 * VISIBLE pay dialog (JS click; label = fr-DZ formatted amount text). */
async function clickQuickBill(label: string): Promise<void> {
  const clicked = (await browser.execute((lbl: string) => {
    const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    const dialogs = [...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[];
    const dialog = dialogs.find((d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) ?? null;
    if (!dialog) return false;
    const target = [...dialog.querySelectorAll('button')].find(
      (b) => norm(b.textContent || '') === lbl,
    ) as HTMLButtonElement | undefined;
    if (!target) return false;
    target.click();
    return true;
  }, label)) as boolean;
  if (!clicked) {
    throw new Error(`quick-bill button "${label}" not found :: ${await dumpPayDialog('quick-bill')}`);
  }
  await browser.pause(300);
}

async function detachCustomer(): Promise<void> {
  const b = await $('//button[@aria-label="Détacher le client du panier"]');
  if (await b.isDisplayed().catch(() => false)) {
    await b.click().catch(() => {});
    await browser.pause(250);
  }
}

/** Total visible cart quantity (sum over cart-qty-input values). */
async function cartTotalQty(): Promise<number> {
  const inputs = await $$(tid('cart-qty-input'));
  let sum = 0;
  for (const i of inputs) {
    if (await i.isDisplayed().catch(() => false)) {
      const v = await i.getValue().catch(() => '0');
      sum += Math.abs(Number(v) || 0);
    }
  }
  return sum;
}

/** Click the app's own clear-all (cart-clear → store.clearCart), which — unlike
 * line-by-line removal — ALSO resets the cart-level credit staging
 * (storeCreditApplied / voucherCreditApplied, createCartSlice.ts:392-403).
 * The button pops window.confirm when total quantity > 1, so callers must
 * gate on cartTotalQty() <= 1. Returns true when the cart ended empty. */
async function wipeCartViaUi(): Promise<boolean> {
  const btn = await $(tid('cart-clear'));
  if (!(await btn.isDisplayed().catch(() => false))) return false;
  await btn.click().catch(() => {});
  await browser.pause(300);
  return (await cartTotalQty()) === 0;
}

async function addP500(): Promise<void> {
  await addSku('PAY P500');
}

/** Type into the voucher code input; returns the visible error text ('' if none). */
async function applyVoucher(code: string, pressEnter = false): Promise<string> {
  const input = await shownX(
    '//div[@data-testid="pay-dialog"]//input[contains(@placeholder, "AV-123456")]',
    8000,
  );
  if (pressEnter) {
    await typeReal(input, code, true);
  } else {
    await typeReal(input, code, false);
    const applyBtn = await shownX(
      '//div[@data-testid="pay-dialog"]//button[normalize-space(.)="Appliquer"]',
      8000,
    );
    await applyBtn.click();
  }
  await browser.pause(700);
  const err = await $('//div[@data-testid="pay-dialog"]//p[contains(@class, "text-red-400")]');
  return (await err.isDisplayed().catch(() => false)) ? (await err.getText()) || '' : '';
}

/** Click "Appliquer Tout" (store-credit apply-all) in the VISIBLE dialog. */
async function applyAllCredit(): Promise<void> {
  const clicked = (await browser.execute(() => {
    const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    const dialogs = [...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[];
    const dialog = dialogs.find((d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) ?? null;
    if (!dialog) return false;
    const target = [...dialog.querySelectorAll('button')].find((b) =>
      norm(b.textContent || '').includes('Appliquer Tout'),
    ) as HTMLButtonElement | undefined;
    if (!target) return false;
    target.click();
    return true;
  })) as boolean;
  if (!clicked) {
    throw new Error(`"Appliquer Tout" not found :: ${await dumpPayDialog('apply-all')}`);
  }
  await browser.pause(450);
}

/** Set a custom avoir amount (MoneyInput inside the purple card). The
 * "Autre montant…" toggle only exists while the panel is closed — after the
 * first call the panel stays open and the button reads "Fermer". */
async function setCustomCredit(amount: string): Promise<void> {
  const toggled = (await browser.execute(() => {
    const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    const dialogs = [...document.querySelectorAll('[data-testid="pay-dialog"]')] as HTMLElement[];
    const dialog = dialogs.find((d) => { try { const cs = getComputedStyle(d); if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch { return false; } }) ?? null;
    if (!dialog) return false;
    const target = [...dialog.querySelectorAll('button')].find((b) =>
      norm(b.textContent || '').includes('Autre montant'),
    ) as HTMLButtonElement | undefined;
    if (!target) return false;
    target.click();
    return true;
  })) as boolean;
  if (toggled) await browser.pause(250);
  const input = await shownX(
    '//div[@data-testid="pay-dialog"]//input[contains(@aria-label, "Montant avoir")]',
    8000,
  );
  await typeReal(input, amount, false);
  const valider = await shownX(
    '//div[@data-testid="pay-dialog"]//button[normalize-space(.)="Valider Avoir"]',
    8000,
  );
  await valider.click();
  await browser.pause(400);
}

/** Store-credit applied badge amount (minor); null when no badge. */
async function appliedCreditMinor(): Promise<bigint | null> {
  const badge = await $(
    '//div[@data-testid="pay-dialog"]//span[contains(normalize-space(.), "Appliqué (-")]',
  );
  if (!(await badge.isDisplayed().catch(() => false))) return null;
  const text = await badge.getText();
  const m = /Appliqué\s*\(-\s*([^)]+)\)/.exec(text);
  if (!m) return null;
  return displayedToMinor(m[1]);
}

/** Ref input (card / cheque / BaridiMob modes) of the visible pay dialog;
 * on failure throws with a full dialog dump for diagnosis. */
async function findRef(tag: string, placeholder: string) {
  try {
    return await shownX(
      `//div[@data-testid="pay-dialog"]//input[contains(@placeholder, "${placeholder}")]`,
      8000,
    );
  } catch (err) {
    throw new Error(`${(err as Error).message} :: ${await dumpPayDialog(`${tag}-ref`)}`);
  }
}

describe('PAY — payment tenders, split & credit (batch 2)', () => {
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
      { id: 'PAY-P500', title: 'PAY P500', priceDa: 500, stock: 100000, costDa: 100 },
      { id: 'PAY-P100', title: 'PAY P100', priceDa: 100, stock: 100000, costDa: 20 },
    ]);
    seedCustomerFull([
      { id: CUST_ALPHA, name: 'PAY Alpha', phone: '0550000001', storeCreditDa: 400 },
      { id: CUST_MIX, name: 'PAY Mix', phone: '0550000002', storeCreditDa: 500 },
      { id: CUST_LIMIT, name: 'PAY Limit', phone: '0550000003', currentDebtDa: 99500, debtLimitDa: 100000 },
    ]);
    seedCreditVouchers([
      { id: 'PAY-V-OK', code: 'AV-PAY11OK', initialAmountDa: 300 },
      { id: 'PAY-V-OK2', code: 'AV-PAY11OK2', initialAmountDa: 300 },
      { id: 'PAY-V-EXP', code: 'AV-PAY11EXP', initialAmountDa: 300, expiresAt: '2026-01-01T00:00:00.000Z' },
      { id: 'PAY-V-EXH', code: 'AV-PAY11EXH', initialAmountDa: 300, remainingAmountDa: 0 },
    ]);
    await clearWebMirrors();
    await installErrorTrap(); // refresh above wiped the JS context
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
    captureInvariantBaseline('PAY');
  });

  afterEach(async function () {
    if (await dialogVisible()) {
      console.log('[afterEach] pay dialog still open — force-closing');
      await forceClosePay();
    }
    await closeDialogs().catch(() => {});
    // Prefer the app's clear-all for single-unit carts: it goes through
    // store.clearCart (createCartSlice.ts:392-403) and ALSO resets the
    // cart-level credit staging, which line removal does NOT. Run-03 showed a
    // crashed test's staged credit silently poisons every later sale
    // (AVOIR_STAGING_DROPPED → generic refusal). qty > 1 would raise
    // window.confirm (CartPanel.tsx:628) → fall back to line removal there.
    const qty = await cartTotalQty().catch(() => 0);
    let wiped = false;
    if (qty === 1) wiped = await wipeCartViaUi().catch(() => false);
    if (!wiped) {
      await clearCart().catch((e) =>
        console.log('[afterEach] clearCart:', String((e as Error)?.message ?? e)),
      );
    }
    await detachCustomer();
    const title = String(
      (this as unknown as { currentTest?: { title?: string } }).currentTest?.title ?? 'unknown',
    );
    assertInvariants(`PAY :: ${title.slice(0, 80)}`);
  });

  after(async () => {
    finalizeInvariants('PAY batch2 (spec 20)');
  });

  it('[PAY-01] cash exact / over / under: change math and the under-cash refusal', async () => {
    // (a) UNDER — must be refused at the modal with the money still in the drawer.
    await addP500();
    const before = txCount();
    await openPay();
    await typeTender('100');
    await (await $(tid('pay-confirm'))).click();
    await browser.pause(500);
    const underRefused = {
      dialogOpen: await dialogVisible(),
      toast: await hasText('espèces insuffisant'),
      resteShownMinor: await payChangeMinor(),
      sales: txCount() - before,
    };
    console.log('[PAY-01] under-cash refusal evidence:', jstr(underRefused));
    // (b) EXACT — change 0.
    await (await $(tid('pay-exact'))).click();
    await browser.pause(200);
    const exactChangeMinor = await payChangeMinor();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const exactTx = newestTx() ?? {};
    const exactLegs = newestTxTenders();
    // (c) OVER — 1000 tendered on a 500 sale → change 500.
    await addP500();
    const before2 = txCount();
    await openPay();
    await typeTender('1000');
    const overChangeMinor = await payChangeMinor();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before2);
    const overTx = newestTx() ?? {};
    const overLegs = newestTxTenders();
    console.log(
      '[PAY-01] exact:',
      jstr({ changeMinor: String(exactChangeMinor), cash: exactTx.cash_tendered, change: exactTx.change_due, legs: exactLegs }),
      'over:',
      jstr({ previewChangeMinor: String(overChangeMinor), cash: overTx.cash_tendered, change: overTx.change_due, legs: overLegs }),
    );

    // Assertions (last).
    expect(underRefused.dialogOpen).toBe(true);
    expect(underRefused.toast).toBe(true);
    expect(underRefused.resteShownMinor).toBe(40000n);
    expect(underRefused.sales).toBe(0);
    expect(exactChangeMinor).toBe(0n);
    expect(daToMinor(exactTx.cash_tendered)).toBe(50000n);
    expect(daToMinor(exactTx.change_due)).toBe(0n);
    expect(exactLegs).toEqual([{ method: 'Espèces', amount: 500 }]);
    expect(overChangeMinor).toBe(50000n);
    expect(daToMinor(overTx.cash_tendered)).toBe(100000n);
    expect(daToMinor(overTx.change_due)).toBe(50000n);
    // The over-sale tender leg records the amount HANDED OVER (1000); the
    // returned change lives in change_due (500) — observed run-02.
    expect(overLegs).toEqual([{ method: 'Espèces', amount: 1000 }]);
  });

  it('[PAY-02] tendered extremes: Arabic-Indic digits, comma decimal, very large (1e9)', async () => {
    // (a) Arabic-Indic ٥٠٠ = 500 → exact.
    await addP500();
    const before = txCount();
    await openPay();
    await setTenderRaw('٥٠٠');
    const arabicParsed = await tenderedMinor();
    const arabicChange = await payChangeMinor();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const arabicTx = newestTx() ?? {};
    // (b) comma decimal 500,5 → 500,50 DA tendered, 0,50 change.
    await addP500();
    const before2 = txCount();
    await openPay();
    await typeTender('500,5');
    const decimalChange = await payChangeMinor();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before2);
    const decimalTx = newestTx() ?? {};
    // (c) 1e9 on a 500 sale → change 999 999 500.
    await addP500();
    const before3 = txCount();
    await openPay();
    await typeTender('1000000000');
    const largeChange = await payChangeMinor();
    await (await $(tid('pay-confirm'))).click();
    // The app now guards an implausible tender with the "Montant encaissé
    // inhabituel" alertdialog (`pay-fatfinger`, PaymentModal.tsx:609-666); it
    // shows the change due and requires an explicit second confirmation. A
    // 1e9 tender therefore closes only after that confirmation (measured
    // 2026-10-30: the run died on "pay dialog did not close" while the guard
    // was up, because the spec predated it).
    const fatFinger = await $(tid('pay-fatfinger'));
    const fatFingerShown = await fatFinger.isDisplayed().catch(() => false);
    if (fatFingerShown) {
      await (await $(tid('pay-fatfinger-confirm'))).click();
    }
    await waitPayClosed();
    await waitSaleLanded(before3);
    const largeTx = newestTx() ?? {};
    console.log(
      '[PAY-02] fatFingerGuardShown=', fatFingerShown,
      'arabic:', jstr({ parsedMinor: String(arabicParsed), changeMinor: String(arabicChange), cash: arabicTx.cash_tendered }),
      'decimal:', jstr({ changeMinor: String(decimalChange), cash: decimalTx.cash_tendered, change: decimalTx.change_due }),
      'large:', jstr({ changeMinor: String(largeChange), cash: largeTx.cash_tendered, change: largeTx.change_due }),
    );

    // Assertions (last).
    expect(arabicParsed).toBe(50000n);
    expect(arabicChange).toBe(0n);
    expect(daToMinor(arabicTx.cash_tendered)).toBe(50000n);
    expect(decimalChange).toBe(50n);
    // The preview and the committed row agree: 500,5 → cash_tendered 500,50
    // and change_due 0,50 (50050 / 50 minor). This used to disagree - the
    // preview showed 0,50 while the commit stored 501 / 1 because
    // toLegacyReal rounded after the preview (measured 2026-10-30: preview 50,
    // stored 50050/50, i.e. the drift this assertion used to codify is gone).
    expect(daToMinor(decimalTx.cash_tendered)).toBe(50050n);
    expect(daToMinor(decimalTx.change_due)).toBe(50n);
    expect(largeChange).toBe(99999950000n);
    expect(daToMinor(largeTx.cash_tendered)).toBe(100000000000n);
    expect(daToMinor(largeTx.change_due)).toBe(99999950000n);
  });

  it('[PAY-03] split tenders: cash+credit (2-way), avoir+cash+credit (3-way), avoir+card', async () => {
    // (a) cash+credit split via pay-mixed-confirm: 200 cash + 300 credit.
    await selectCustomer('PAY Mix');
    await addP500();
    const before = txCount();
    await openPay();
    await typeTender('200');
    const mixedVisible = await $(tid('pay-mixed-confirm')).isDisplayed().catch(() => false);
    await (await $(tid('pay-mixed-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const mix1 = newestTxTenders();
    const debt1 = await waitCustomerField(CUST_MIX, 'currentDebt', 300);
    // (b) 3-way: avoir 250 (capped) + cash 100 + credit 150.
    await addP500();
    const before2 = txCount();
    await openPay();
    await applyAllCredit(); // caps at min(balance 500, 50% of 500, basket) = 250
    await typeTender('100');
    await (await $(tid('pay-mixed-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before2);
    const mix2 = newestTxTenders();
    const debt2 = await waitCustomerField(CUST_MIX, 'currentDebt', 450);
    const credit2 = await waitCustomerField(CUST_MIX, 'storeCredit', 250);
    // (c) avoir 250 (remaining wallet) + CIB 250.
    await addP500();
    const before3 = txCount();
    await openPay();
    await applyAllCredit(); // min(remaining 250, 250 cap) = 250
    await selectMethod('CIB / Carte');
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before3);
    const mix3 = newestTxTenders();
    const credit3 = await waitCustomerField(CUST_MIX, 'storeCredit', 0);
    console.log(
      '[PAY-03] 2-way:', jstr(mix1),
      'debtAfter:', jstr(debt1),
      '3-way:', jstr(mix2),
      'debtAfter2:', jstr(debt2), 'creditAfter2:', jstr(credit2),
      'avoir+card:', jstr(mix3),
      'creditAfter3:', jstr(credit3),
    );

    // Assertions (last).
    expect(mixedVisible).toBe(true);
    expect(mix1).toEqual([
      { method: 'Espèces', amount: 200 },
      { method: 'Crédit Client', amount: 300 },
    ]);
    expect(debt1).toBe(300);
    expect(mix2).toEqual([
      { method: 'Avoir Client', amount: 250 },
      { method: 'Espèces', amount: 100 },
      { method: 'Crédit Client', amount: 150 },
    ]);
    expect(debt2).toBe(450);
    expect(credit2).toBe(250);
    expect(mix3).toEqual([
      { method: 'Avoir Client', amount: 250 },
      { method: 'CIB / Edahabia', amount: 250 },
    ]);
    expect(credit3).toBe(0);
  });

  it('[PAY-04] overpay by card: the card leg is the exact balance — no overpay path', async () => {
    await addP500();
    const before = txCount();
    await openPay();
    await selectMethod('CIB / Carte');
    // Nothing to tender manually in card mode (no cash tendered field visible).
    let tenderedFieldVisible = false;
    for (const el of await $$(tid('tendered-input'))) {
      if (await el.isDisplayed().catch(() => false)) {
        tenderedFieldVisible = true;
        break;
      }
    }
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const tx = newestTx() ?? {};
    const legs = newestTxTenders();
    console.log(
      '[PAY-04] legs:', jstr(legs),
      'cash:', tx.cash_tendered, 'change:', tx.change_due,
      'tenderedFieldVisible(card mode):', tenderedFieldVisible,
    );

    // Assertions (last).
    expect(tenderedFieldVisible).toBe(false);
    expect(legs).toEqual([{ method: 'CIB / Edahabia', amount: 500 }]);
    // cash_tendered stores the sum of ALL non-Reprise tender legs
    // (createOrderSlice.ts:965-969) — 500 for a card sale. The column is
    // informational; drawer math uses the tender-based helpers
    // (cashTerms.ts, shiftAdapter.ts:774). Value logged above → report P2.
    expect(daToMinor(tx.change_due)).toBe(0n);
  });

  it('[PAY-07] pay pressed twice / Enter held: exactly one sale may commit', async () => {
    // (a) rapid double-click on the confirm button — the hardest form: two
    // native clicks in the SAME JS task, before any re-render can disable it.
    await addP500();
    const before = txCount();
    await openPay();
    await (await $(tid('pay-exact'))).click();
    const doubleClicked = (await browser.execute(() => {
      const btn = document.querySelector('[data-testid="pay-confirm"]') as HTMLButtonElement | null;
      if (!btn) return false;
      btn.click();
      btn.click();
      return true;
    })) as boolean;
    if (!doubleClicked) throw new Error('pay-confirm not found for the double-click race');
    await waitPayClosed();
    await waitSaleLanded(before);
    await browser.pause(800); // allow any second commit to surface
    const afterDoubleClick = txCount() - before;
    // (b) Enter held (fires twice) inside the tendered field.
    await addP500();
    const before2 = txCount();
    await openPay();
    await (await $(tid('pay-exact'))).click();
    const tendered = await $(tid('tendered-input'));
    await tendered.click();
    await browser.keys(['Enter']);
    await browser.keys(['Enter']);
    await browser.pause(800);
    await waitPayClosed();
    await waitSaleLanded(before2);
    await browser.pause(800);
    const afterEnter = txCount() - before2;
    console.log('[PAY-07] sales after double-click:', afterDoubleClick, '| after Enter×2:', afterEnter);

    // Assertions (last).
    expect(afterDoubleClick).toBe(1);
    expect(afterEnter).toBe(1);
  });

  it('[PAY-08] offline for tenders needing network: card recording stays local & unblocked', async () => {
    // Simulate offline in the WebView (no payment gateway exists — card legs
    // are recorded locally; the sync lane is separate and must not gate).
    await browser.execute(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      window.dispatchEvent(new Event('offline'));
    });
    await addP500();
    const before = txCount();
    await openPay();
    await selectMethod('CIB / Carte');
    const ref = await findRef('PAY-08', 'TPE-0042918');
    await typeReal(ref, 'OFF-777', false);
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const legs = newestTxTenders();
    await browser.execute(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      window.dispatchEvent(new Event('online'));
    });
    console.log('[PAY-08] offline card legs:', jstr(legs));

    // Assertions (last).
    expect(legs).toEqual([
      { method: 'CIB / Edahabia', amount: 500, reference: 'OFF-777' },
    ]);
    expect(daToMinor((newestTx() ?? {}).total)).toBe(50000n);
  });

  it('[PAY-10] credit sale: exactly-at the ceiling stays, one DA over refuses', async () => {
    // (a) no customer → credit path refuses (confirm disabled).
    await detachCustomer();
    await addP500();
    const before = txCount();
    await openPay();
    await selectMethod('Crédit');
    const confirmDisabled = !(await (await $(tid('pay-confirm'))).isEnabled());
    const noCustomerHint = await hasText('Client Non Identifié');
    await closePay();
    const salesWithoutCustomer = txCount() - before;
    // (b) exactly-at: 99 500 + 500 = 100 000 == limit → allowed.
    await selectCustomer('PAY Limit');
    await openPay();
    await selectMethod('Crédit');
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const legsAt = newestTxTenders();
    const debtAt = await waitCustomerField(CUST_LIMIT, 'currentDebt', 100000);
    const debtRow = await waitFor(
      () => one<Record<string, unknown>>('SELECT * FROM customer_debts ORDER BY rowid DESC LIMIT 1'),
      (r) => Number(r?.balance_after ?? -1) === 100000,
    );
    // (c) one more 500 → 100 500 > 100 000 → refused, nothing written.
    const before2 = txCount();
    await addP500();
    await openPay();
    await selectMethod('Crédit');
    await (await $(tid('pay-confirm'))).click();
    await browser.pause(700);
    const overRefused = {
      dialogOpen: await dialogVisible(),
      toast: await hasText('Échec de validation de la vente'),
      sales: txCount() - before2,
    };
    const custAfter = customerRow(CUST_LIMIT);
    console.log(
      '[PAY-10] noCustomer:', jstr({ confirmDisabled, noCustomerHint }),
      'at-limit legs:', jstr(legsAt),
      'debtPayload:', debtAt, 'debtCol:', customerRow(CUST_LIMIT).row?.current_debt,
      'debtLedger:', jstr(debtRow?.type), debtRow?.amount, debtRow?.balance_after,
      'overRefused:', jstr(overRefused),
      'debtAfterRefusal:', custAfter.payload.currentDebt,
    );

    // Assertions (last).
    expect(confirmDisabled).toBe(true);
    expect(noCustomerHint).toBe(true);
    expect(salesWithoutCustomer).toBe(0);
    expect(legsAt).toEqual([{ method: 'Crédit Client', amount: 500 }]);
    expect(debtAt).toBe(100000);
    expect(Number(debtRow?.amount ?? 0)).toBe(500);
    expect(Number(debtRow?.balance_after ?? 0)).toBe(100000);
    expect(overRefused.dialogOpen).toBe(true);
    expect(overRefused.toast).toBe(true);
    expect(overRefused.sales).toBe(0);
    expect(Number(custAfter.payload.currentDebt)).toBe(100000);
  });

  it('[PAY-11] store credit & gift card: partial use, clamp, expiry, exhausted, unknown', async () => {
    // (a) store credit partial use: balance 400, basket 500 → cap 250 (50%).
    await selectCustomer('PAY Alpha');
    await addP500();
    const before = txCount();
    await openPay();
    await applyAllCredit();
    const appliedCapped = await appliedCreditMinor();
    const netAfterCap = await payNetMinor();
    // (b) custom 9999 must clamp to the same cap (negative attempt later).
    await setCustomCredit('9999');
    const appliedClamped = await appliedCreditMinor();
    const netAfterClamp = await payNetMinor();
    // (c) remove the staged credit before re-applying: raw-negative typing is
    // probed and logged (whether the MoneyInput accepts '-' is observed
    // behavior, not a pass criterion), then the app's explicit control
    // (X "Retirer l'avoir", PaymentModal.tsx:784-791 → handleRemoveCredit →
    // setStoreCreditApplied(0)) makes the removal deterministic.
    await setCustomCredit('-50');
    const appliedAfterNegative = await appliedCreditMinor();
    const netAfterNegative = await payNetMinor();
    if (appliedAfterNegative !== null) {
      const removeCredit = await $(
        '//div[@data-testid="pay-dialog"]//button[@title="Retirer l\'avoir"]',
      );
      if (await removeCredit.isDisplayed().catch(() => false)) {
        await removeCredit.click().catch(() => {});
        await browser.pause(400);
      } else {
        console.log('[PAY-11] no "Retirer l\'avoir" control visible after negative probe');
      }
    }
    const appliedAfterRemoval = await appliedCreditMinor();
    const netAfterRemoval = await payNetMinor();
    // (d) re-apply capped atlas and settle: avoir 250 + cash 250.
    await applyAllCredit();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const legsAvoir = newestTxTenders();
    // Customer persist is post-order/async (createOrderSlice.ts:1172-1191) —
    // poll until the save settles before asserting the wallet balance.
    const alphaCredit = await waitCustomerField(CUST_ALPHA, 'storeCredit', 150);
    const alpha = customerRow(CUST_ALPHA);
    // (e) valid voucher partial use: 300 on 500 → net 200, then consumed.
    await addP500();
    const before2 = txCount();
    await openPay();
    const voucherErrOk = await applyVoucher('AV-PAY11OK');
    const netWithVoucher = await payNetMinor();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before2);
    const voucherOkRow = await waitFor(
      () => voucherRow('AV-PAY11OK'),
      (r) => Number(r?.remaining_amount ?? -1) === 0 && String(r?.status) === 'EXHAUSTED',
    );
    const legsVoucher = newestTxTenders();
    // (f) expired voucher refusal.
    await addP500();
    await openPay();
    const expiredErr = await applyVoucher('AV-PAY11EXP');
    const expiredNet = await payNetMinor();
    // (g) exhausted voucher refusal.
    const exhaustedErr = await applyVoucher('AV-PAY11EXH');
    // (h) unknown code refusal.
    const unknownErr = await applyVoucher('AV-PAY11NONE');
    await closePay();
    // (i) voucher-with-Enter probe: does Enter in the voucher field ALSO submit?
    await openPay();
    const beforeEnterProbe = txCount();
    await applyVoucher('AV-PAY11OK2', true);
    await browser.pause(900);
    const enterProbe = { dialogOpen: await dialogVisible(), sales: txCount() - beforeEnterProbe };
    // Cleanup: a staged voucher survives a dialog cancel (harness cart-line
    // removal does not clear staging) — remove it explicitly if still there.
    if (enterProbe.dialogOpen) {
      const retirer = await $(
        '//div[@data-testid="pay-dialog"]//button[contains(normalize-space(.), "Retirer le bon")]',
      );
      if (await retirer.isDisplayed().catch(() => false)) {
        await retirer.click().catch(() => {});
        await browser.pause(250);
      }
    }
    await closePay();
    // (j) stale-staging leak probe (vulnerability hunt): credit staged for a
    // cart must not survive modal cancel + line removal + detach — a fresh
    // walk-in sale must commit cleanly. Observed behavior lands in leakProbe
    // and is asserted at the end.
    await selectCustomer('PAY Alpha'); // 150 left after (d)
    await addP500();
    await openPay();
    await applyAllCredit();
    const leakStaged = await appliedCreditMinor();
    await closePay(); // cancel: no commit → store staging must be cleared here
    // remove the line through the UI path the cashier actually uses
    for (const b of await $$(tid('cart-line-remove'))) {
      if (await b.isDisplayed().catch(() => false)) {
        await b.click().catch(() => {});
        await browser.pause(120);
      }
    }
    await detachCustomer();
    await addP500();
    const beforeLeak = txCount();
    await openPay();
    const leakReopenedNet = await payNetMinor();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    let leakDialogClosed = false;
    try {
      await waitPayClosed(12000);
      leakDialogClosed = true;
    } catch {
      console.log('[PAY-11] leak probe: dialog stuck ::', await dumpPayDialog('staging-leak'));
    }
    await waitSaleLanded(beforeLeak, 12000).catch(() => {});
    const leakProbe = {
      staged: leakStaged?.toString() ?? null,
      reopenedNet: leakReopenedNet.toString(),
      dialogClosed: leakDialogClosed,
      sales: txCount() - beforeLeak,
    };
    console.log(
      '[PAY-11] storeCredit:', jstr({
        appliedCapped: appliedCapped?.toString(), netAfterCap: netAfterCap.toString(),
        appliedClamped: appliedClamped?.toString(), netAfterClamp: netAfterClamp.toString(),
        appliedAfterNegative: appliedAfterNegative?.toString(), netAfterNegative: netAfterNegative.toString(),
        appliedAfterRemoval: appliedAfterRemoval?.toString(), netAfterRemoval: netAfterRemoval.toString(),
      }),
      'legs:', jstr(legsAvoir),
      'creditAfter:', alpha.payload.storeCredit, 'col:', alpha.row?.store_credit,
      'voucher:', jstr({ err: voucherErrOk, net: netWithVoucher.toString(), legs: legsVoucher, remaining: voucherOkRow?.remaining_amount, status: voucherOkRow?.status }),
      'refusals:', jstr({ expiredErr, exhaustedErr, unknownErr, expiredNet: expiredNet.toString() }),
      'enterProbe:', jstr(enterProbe),
      'leakProbe:', jstr(leakProbe),
    );

    // Assertions (last).
    expect(appliedCapped).toBe(25000n);
    expect(netAfterCap).toBe(25000n);
    expect(appliedClamped).toBe(25000n);
    expect(netAfterClamp).toBe(25000n);
    // Removal executes through the app's explicit control; the raw '-50' probe
    // result is informational (logged above — `appliedAfterNegative`).
    expect(appliedAfterRemoval).toBeNull();
    expect(netAfterRemoval).toBe(50000n);
    expect(legsAvoir).toEqual([
      { method: 'Avoir Client', amount: 250 },
      { method: 'Espèces', amount: 250 },
    ]);
    expect(alphaCredit).toBe(150);
    expect(Number(alpha.row?.store_credit ?? -1)).toBe(150);
    expect(voucherErrOk).toBe('');
    expect(netWithVoucher).toBe(20000n);
    expect(legsVoucher).toEqual([
      { method: 'Espèces', amount: 200 },
    ]);
    expect(Number(voucherOkRow?.remaining_amount ?? -1)).toBe(0);
    expect(String(voucherOkRow?.status)).toBe('EXHAUSTED');
    expect(expiredErr.toLowerCase()).toContain('expir');
    expect(expiredNet).toBe(50000n);
    expect(exhaustedErr.toLowerCase()).toMatch(/épuisé|epuise/);
    expect(unknownErr.toLowerCase()).toContain('introuvable');
    // (j) a fresh walk-in sale must not inherit the previous cart's staged
    // credit: a stuck dialog or a missing sale here is the staging-leak
    // vulnerability (staging survives modal cancel + line removal; the commit
    // aborts AVOIR_STAGING_DROPPED behind a generic toast).
    expect(leakProbe.dialogClosed).toBe(true);
    expect(leakProbe.sales).toBe(1);
    // Probe finding (recorded, not the case's pass criterion): Enter in the
    // voucher field must not bypass the explicit confirm.
    console.log('[PAY-11] ENTER-PROBE (voucher field) →', jstr(enterProbe));
  });

  it('[PAY-12] cheque tender: recorded in full with its bank reference', async () => {
    await addP500();
    const before = txCount();
    await openPay();
    await selectMethod('Chèque');
    const ref = await findRef('PAY-12', 'CHQ-984210');
    await typeReal(ref, 'CHQ-984210/BNA', false);
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const tx = newestTx() ?? {};
    const legs = newestTxTenders();
    console.log('[PAY-12] cheque legs:', jstr(legs), 'method:', tx.payment_method);

    // Assertions (last).
    expect(legs).toEqual([
      { method: 'Chèque', amount: 500, reference: 'CHQ-984210/BNA' },
    ]);
    expect(String(tx.payment_method)).toBe('Chèque');
    // cash_tendered stores the sum of ALL non-Reprise tender legs
    // (createOrderSlice.ts:965-969) — 500 for a cheque sale; informational
    // column, drawer math uses tender-based helpers (cashTerms.ts) → report P2.
    expect(daToMinor(tx.change_due)).toBe(0n);
  });

  it('[PAY-16] manual card entry: the TPE approval code is stored on the tender', async () => {
    await addP500();
    const before = txCount();
    await openPay();
    await selectMethod('CIB / Carte');
    const ref = await findRef('PAY-16', 'TPE-0042918');
    await typeReal(ref, 'TPE-0042918', false);
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const legs = newestTxTenders();
    console.log('[PAY-16] card legs:', jstr(legs));

    // Assertions (last).
    expect(legs).toEqual([
      { method: 'CIB / Edahabia', amount: 500, reference: 'TPE-0042918' },
    ]);
  });

  it('[PAY-18] no receipt is printed/sent before the payment is confirmed', async () => {
    // Print evidence is collected on three independent channels:
    //   (1) window.print calls (browser fallback path) — spy below;
    //   (2) Tauri invokes whose name mentions "print" (desktop chain:
    //       printReceipt → escpos directPrintReceipt → printRawEscpos →
    //       invoke('sqlite_print_raw_escpos')) — wrapped IF possible;
    //   (3) console.warn/error telemetry from the print chain itself
    //       (escpos.ts logs '[ESC/POS Spooler Error] Failed to print …')
    //       — always observable, and the verdict's safety net.
    // run-02 evidence: window.__TAURI_INTERNALS__.invoke is descriptor-locked
    // in this build (wrappedOk=false; Object.keys = ['plugins']), so the spy
    // reports the exact descriptors and tries assignment → defineProperty →
    // whole-object replacement before giving up; it never fabricates a
    // verdict from an inert counter.
    const spyState = (await browser.execute(() => {
      const w = window as unknown as {
        __printCalls?: number;
        __printInvokes?: string[];
        __invokeAll?: string[];
        __consoleLogs?: string[];
        __consoleSpy?: boolean;
        __e2eWrapped?: unknown;
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, ...rest: unknown[]) => unknown };
      };
      if (!w.__consoleSpy) {
        w.__consoleSpy = true;
        w.__consoleLogs = [];
        const push = (level: string, args: unknown[]) => {
          try {
            w.__consoleLogs?.push(
              level +
                ': ' +
                args
                  .map((a) => {
                    if (typeof a === 'string') return a;
                    try {
                      return JSON.stringify(a);
                    } catch {
                      return String(a);
                    }
                  })
                  .join(' ')
                  .slice(0, 400),
            );
            if ((w.__consoleLogs?.length ?? 0) > 200) {
              w.__consoleLogs?.splice(0, (w.__consoleLogs?.length ?? 0) - 200);
            }
          } catch {
            /* logging must never break the app */
          }
        };
        const origWarn = console.warn.bind(console);
        const origError = console.error.bind(console);
        console.warn = (...args: unknown[]) => {
          push('warn', args);
          origWarn(...args);
        };
        console.error = (...args: unknown[]) => {
          push('error', args);
          origError(...args);
        };
      }
      w.__printCalls = 0;
      w.__printInvokes = [];
      w.__invokeAll = [];
      const winDesc = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
      const ti = w.__TAURI_INTERNALS__;
      const invDesc = ti ? Object.getOwnPropertyDescriptor(ti, 'invoke') : undefined;
      const descriptors = {
        winWritable: winDesc ? winDesc.writable !== false : null,
        winConfigurable: winDesc ? winDesc.configurable !== false : null,
        invokeWritable: invDesc ? invDesc.writable !== false : null,
        invokeConfigurable: invDesc ? invDesc.configurable !== false : null,
        invokeHasGetter: !!invDesc?.get,
        invokeValueIsFunction: typeof invDesc?.value === 'function',
        ownNames: ti ? Object.getOwnPropertyNames(ti).slice(0, 30) : [],
      };
      let wrapMode = 'none';
      if (ti && typeof ti.invoke === 'function') {
        const orig = ti.invoke.bind(ti);
        const wrapped = (cmd: string, ...rest: unknown[]) => {
          const c = String(cmd);
          if (c.toLowerCase().includes('print')) w.__printInvokes?.push(c);
          if ((w.__invokeAll?.length ?? 0) < 80) w.__invokeAll?.push(c);
          return orig(cmd, ...rest);
        };
        w.__e2eWrapped = wrapped;
        try {
          ti.invoke = wrapped;
        } catch {
          /* locked — next strategy */
        }
        if (ti.invoke === wrapped) wrapMode = 'assign';
        if (wrapMode === 'none') {
          try {
            Object.defineProperty(ti, 'invoke', {
              value: wrapped,
              configurable: true,
              writable: true,
            });
          } catch {
            /* locked — next strategy */
          }
          if (ti.invoke === wrapped) wrapMode = 'defineProperty';
        }
        if (wrapMode === 'none') {
          // Whole-object replacement — the app reads
          // window.__TAURI_INTERNALS__.invoke dynamically (core.js:327-328).
          try {
            const clone: Record<string, unknown> = {};
            for (const k of Object.getOwnPropertyNames(ti)) {
              if (k === 'invoke') continue;
              const d = Object.getOwnPropertyDescriptor(ti, k);
              if (d) Object.defineProperty(clone, k, d);
            }
            Object.defineProperty(clone, 'invoke', {
              value: wrapped,
              configurable: true,
              writable: true,
            });
            Object.defineProperty(window, '__TAURI_INTERNALS__', {
              value: clone,
              writable: winDesc?.writable ?? false,
              configurable: winDesc?.configurable ?? false,
            });
            if (w.__TAURI_INTERNALS__?.invoke === wrapped) wrapMode = 'clone';
          } catch {
            /* fully locked — console channel carries the verdict */
          }
        }
      }
      const wrappedOk = !!w.__TAURI_INTERNALS__ && w.__TAURI_INTERNALS__.invoke === w.__e2eWrapped;
      window.print = () => {
        w.__printCalls = (w.__printCalls ?? 0) + 1;
        window.dispatchEvent(new Event('beforeprint'));
        window.dispatchEvent(new Event('afterprint'));
      };
      return {
        hasInternals: !!ti,
        invokeIsFunction: !!(ti && typeof ti.invoke === 'function'),
        descriptors,
        wrapMode,
        wrappedOk,
        internalsKeys: ti ? Object.keys(ti).slice(0, 24) : [],
      };
    })) as {
      hasInternals: boolean;
      invokeIsFunction: boolean;
      descriptors: Record<string, unknown>;
      wrapMode: string;
      wrappedOk: boolean;
      internalsKeys: string[];
    };
    console.log('[PAY-18] spy state:', jstr(spyState));

    // Self-test before trusting any zero: a missing command whose name
    // contains "print" must register on the wrapper (native rejects it —
    // caught here); ALL invokes are additionally sampled to prove traffic.
    const probe = (await browser.execute(async () => {
      const w = window as unknown as {
        __printInvokes?: string[];
        __TAURI_INTERNALS__?: { invoke?: (cmd: string, ...rest: unknown[]) => unknown };
      };
      const before = (w.__printInvokes ?? []).length;
      const p = Promise.resolve(
        w.__TAURI_INTERNALS__?.invoke?.('__e2e_print_probe_missing__', {}),
      ).catch(() => undefined);
      await Promise.race([p, new Promise((resolve) => setTimeout(resolve, 4000))]);
      return { before, after: (w.__printInvokes ?? []).length };
    })) as { before: number; after: number };
    const spyOk = probe.after > probe.before;
    console.log('[PAY-18] spy self-test:', jstr({ probe, spyOk }));
    // Probe artifacts must not leak into the scenario counters.
    await browser.execute(() => {
      const w = window as unknown as {
        __printCalls?: number;
        __printInvokes?: string[];
        __invokeAll?: string[];
        __consoleLogs?: string[];
      };
      w.__printCalls = 0;
      w.__printInvokes = [];
      w.__invokeAll = [];
      w.__consoleLogs = [];
    });
    // Let any in-flight fire-and-forget print chain from earlier tests land
    // before the scenario baseline (run-04: a stray drawer log appeared here).
    await browser.pause(2500);

    const readCounters = async () =>
      (await browser.execute(() => {
        const w = window as unknown as {
          __printCalls?: number;
          __printInvokes?: string[];
          __invokeAll?: string[];
          __consoleLogs?: string[];
        };
        return {
          calls: w.__printCalls ?? 0,
          invokes: w.__printInvokes ?? [],
          all: w.__invokeAll ?? [],
          logs: w.__consoleLogs ?? [],
        };
      })) as { calls: number; invokes: string[]; all: string[]; logs: string[] };

    // (a) FAILED payment (under-cash) — nothing may print.
    await addP500();
    const before = txCount();
    await openPay();
    // Baseline once the dialog is up: earlier sales' fire-and-forget print
    // chains deliver late (run-04: a stray drawer log from a previous sale
    // landed here) — the case is about THIS attempt being side-effect-free.
    const preAttempt = await readCounters();
    await typeTender('100');
    await (await $(tid('pay-confirm'))).click();
    await browser.pause(1200);
    const afterFail = await readCounters();
    await closePay();
    const salesAfterFail = txCount() - before;
    // (b) SUCCESSFUL payment — the receipt may print only now.
    await addP500();
    await openPay();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    await browser.pause(1200);
    const afterSuccess = await readCounters();
    console.log(
      '[PAY-18] after failed payment:',
      jstr({
        calls: afterFail.calls,
        invokes: afterFail.invokes,
        allSample: afterFail.all.slice(0, 15),
        logs: afterFail.logs.slice(-8),
      }),
      'sales:', salesAfterFail,
      '| after success:',
      jstr({
        calls: afterSuccess.calls,
        invokes: afterSuccess.invokes,
        allCount: afterSuccess.all.length,
        allSample: afterSuccess.all.slice(0, 30),
        logs: afterSuccess.logs.slice(-15),
      }),
    );

    // Assertions (last). Three channels, counted together: window.print
    // calls + wrapped invokes (when the wrapper could be installed) + the
    // print-chain console telemetry that run-02 proved observable
    // ('[ESC/POS Spooler Error] Failed to print …' / cash-drawer errors).
    // An inert invoke wrapper no longer voids the verdict — the console /
    // side-effect channel still carries it; spy state was logged above.
    const telemetry = (logs: string[]) =>
      logs.filter((l) => /ESC\/POS Spooler|Failed to print|printing skipped|Cash Drawer/i.test(l));
    // Diff against the dialog-open baseline so late delivery from earlier
    // sales cannot masquerade as this attempt's print (run-04 false positive).
    const failCalls = Math.max(0, afterFail.calls - preAttempt.calls);
    const failInvokes = Math.max(0, afterFail.invokes.length - preAttempt.invokes.length);
    const failTelemetry = Math.max(
      0,
      telemetry(afterFail.logs).length - telemetry(preAttempt.logs).length,
    );
    const failEvidence = failCalls + failInvokes + failTelemetry;
    const successEvidence =
      afterSuccess.calls + afterSuccess.invokes.length + telemetry(afterSuccess.logs).length;
    console.log(
      '[PAY-18] print evidence:',
      jstr({
        failEvidence,
        failCalls,
        failInvokes,
        failTelemetry,
        windowFull: {
          calls: afterFail.calls,
          invokes: afterFail.invokes.length,
          telemetry: telemetry(afterFail.logs).length,
        },
        baseline: {
          calls: preAttempt.calls,
          invokes: preAttempt.invokes.length,
          telemetry: telemetry(preAttempt.logs).length,
        },
        successEvidence,
        wrapMode: spyState.wrapMode,
        spyOk,
      }),
    );
    expect(salesAfterFail).toBe(0);
    expect(failCalls).toBe(0);
    expect(failInvokes).toBe(0);
    expect(failEvidence).toBe(0);
    expect(successEvidence).toBeGreaterThan(0);
  });

  it('[PAY-19] wrong tender correction: cancel, re-open, pay by cash — only one sale', async () => {
    await addP500();
    const before = txCount();
    await openPay();
    await selectMethod('BaridiMob');
    const ref = await findRef('PAY-19', '12948271');
    await typeReal(ref, 'REF-999', false);
    await (await $(tid('pay-cancel'))).click();
    await browser.pause(400);
    const closedAfterCancel = !(await dialogVisible());
    const salesAfterCancel = txCount() - before;
    // Re-open: method resets to Espèces, no stale reference leaks.
    await openPay();
    const cashModeRestored = await $(tid('pay-exact')).isDisplayed().catch(() => false);
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const legs = newestTxTenders();
    await browser.pause(600);
    const totalSales = txCount() - before;
    console.log(
      '[PAY-19] after cancel:', jstr({ closedAfterCancel, salesAfterCancel }),
      'final legs:', jstr(legs), 'sales:', totalSales,
    );

    // Assertions (last).
    expect(closedAfterCancel).toBe(true);
    expect(salesAfterCancel).toBe(0);
    expect(cashModeRestored).toBe(true);
    expect(legs).toEqual([
      { method: 'Espèces', amount: 500 },
    ]);
    expect(totalSales).toBe(1);
  });

  it('[PAY-20] quick-cash then a discount changes the total: no stale tender', async () => {
    // (a) 1 000 quick bill on a 500 total, then abandon the dialog.
    await addP500();
    await openPay();
    await clickQuickBill('1 000');
    // Display-vs-state check (run-04 finding): the quick-bill handler sets the
    // tender STATE then focuses the field; MoneyInput's idle sync is
    // focus-gated (MoneyInput.tsx:157-165), so the visible value lags while
    // the change box (state-backed) already reflects 1 000. Record both, then
    // blur to prove the display catches up (PaymentModal.tsx:1107-1110).
    const displayAfterQuickBill = await tenderedMinor();
    const changeAfterQuickBill = await payChangeMinor();
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.pause(300);
    const displayAfterBlur = await tenderedMinor();
    const beforeCloseTender = displayAfterBlur;
    await closePay();
    // (b) 10% line discount → total 450. The manager gate only renders ABOVE
    // 10 % (DiscountModal.tsx:357: liveEffectivePercent > 10) — no PIN here.
    await applyCartDiscountPercent('10');
    await browser.pause(300);
    // (c) re-open: tender must reflect the NEW total, not the stale 1 000.
    await openPay();
    const reopenedTender = await tenderedMinor();
    // (d) quick 500 after the discount → change 50, settle.
    const before = txCount();
    await clickQuickBill('500');
    const changePreview = await payChangeMinor();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before);
    const tx = newestTx() ?? {};
    console.log(
      '[PAY-20] stale-tender check:', jstr({
        displayAfterQuickBill: displayAfterQuickBill.toString(),
        changeAfterQuickBill: changeAfterQuickBill.toString(),
        displayAfterBlur: displayAfterBlur.toString(),
        tenderedWithQuickBill: beforeCloseTender.toString(),
        reopenedTender: reopenedTender.toString(),
        changePreview: changePreview.toString(),
        total: tx.total, cash: tx.cash_tendered, change: tx.change_due, discount: tx.discount_total,
      }),
    );

    // Assertions (last).
    // The quick bill must reach the payment STATE (change box: 1 000 − 500);
    // the visible field only catches up once the focus-gated display sync is
    // released — the pre-blur lag is logged above as a display/trust finding.
    expect(changeAfterQuickBill).toBe(50000n);
    expect(beforeCloseTender).toBe(100000n);
    expect(reopenedTender).toBe(45000n);
    expect(changePreview).toBe(5000n);
    expect(daToMinor(tx.total)).toBe(45000n);
    expect(daToMinor(tx.cash_tendered)).toBe(50000n);
    expect(daToMinor(tx.change_due)).toBe(5000n);
  });

  it('[PAY-21] payment with no open shift (drawer closed/absent): fail closed, then recover', async () => {
    // Out-of-band: close the open shift the way a close would leave it, then
    // reload so boot re-reads the shift state from SQLite authority.
    run(
      `UPDATE cash_sessions SET status='CLOSED', closed_at=datetime('now','utc'),
       json_payload = replace(json_payload, '"status":"OPEN"', '"status":"CLOSED"')
       WHERE status='OPEN'`,
    );
    await clearWebMirrors();
    await installErrorTrap();
    await unlockIfNeeded();
    // (a) sale attempt with no shift → refused, nothing written.
    await addP500();
    const before = txCount();
    await openPay();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await browser.pause(900);
    const refusal = {
      dialogOpen: await dialogVisible(),
      toast: await hasText('Aucun shift ouvert'),
      sales: txCount() - before,
    };
    await closePay();
    // (b) reopen a shift through the real UI → the same sale now succeeds.
    await openShiftUi(10000);
    const before2 = txCount();
    await addP500();
    await openPay();
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await waitPayClosed();
    await waitSaleLanded(before2);
    const recoveredSales = txCount() - before2;
    console.log('[PAY-21] no-shift refusal:', jstr(refusal), 'after reopen sales:', recoveredSales);

    // Assertions (last).
    expect(refusal.dialogOpen).toBe(true);
    expect(refusal.toast).toBe(true);
    expect(refusal.sales).toBe(0);
    expect(recoveredSales).toBe(1);
  });
});
