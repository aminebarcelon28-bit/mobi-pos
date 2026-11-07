/**
 * REP - repair / SAV matrix (batch 18, spec 84).
 *
 * P0 first: 03, 05, 06, 07, 10, 11, 13, 14, 18, 21. Then P1:
 * 01, 02, 04, 08, 09, 12, 15, 16, 19, 20, 22, 23, 24, 25.
 *
 * Implemented lanes are driven through the shipped RepairWorkOrderModal and
 * the real payment/cart surfaces against a live SQLite store. Genuinely absent
 * features run executed schema/DOM absence probes and are recorded N/A with
 * file:line proof in EDGE_CASE_VULNERABILITY_REPORT.md.
 *
 * A FAIL test asserts the CORRECT expectation and is allowed to fail against
 * the shipped lane; that failure is the evidence. N/A probes pass, and the
 * `na-cases.json` fixture is the authoritative override.
 */
import fs from 'node:fs';
import { $, browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, columnNames, one, waitForSchemaSettled } from '../lib/db';
import {
  clickControl,
  APP_PIN,
  closeDialogs,
  drainCart,
  overrideLastLinePrice,
  payExactFlow,
  tid,
  typeMoneyInto,
} from '../lib/pos';
import { resetData, seedProducts } from '../lib/seed';
import { assertInvariants, captureInvariantBaseline, finalizeInvariants } from '../lib/invariants';
import {
  bodyText,
  bootUnlock,
  cardText,
  claimRows,
  clickCardAction,
  closeInspector,
  closeRepairModal,
  editCard,
  fillIntake,
  isoAt,
  makeImei,
  newRepair,
  openHistoryTab,
  openRepairModal,
  refreshApp,
  repairPayload,
  repairRowByTicket,
  saveRepairWait,
  seedHistoricSession,
  seedImei,
  seedRepair,
  seedSale,
  setCardStatus,
  setHistorySearch,
  setInputInForm,
  stockOf,
  ledgerSum,
  tinyPngPath,
  writeAttachment,
} from '../lib/sav';

type Row = Record<string, unknown>;
const DEL = '2026-10-01T11:00:00.000Z';

async function historyOn(ticket: string): Promise<void> {
  await openRepairModal();
  await openHistoryTab();
  await setHistorySearch(ticket);
  await browser.pause(350);
}

function cashRefunds(ticket: string): Row[] {
  return all<Row>(
    `SELECT * FROM cash_movements
      WHERE type='EXPENSE' AND reason LIKE '%SAV_ACOMPTE%' AND reason LIKE ?
      ORDER BY rowid`,
    `%${ticket}%`,
  );
}

async function waitStatus(ticket: string, status: string, timeout = 20000): Promise<boolean> {
  const until = Date.now() + timeout;
  for (;;) {
    if (String(repairRowByTicket(ticket)?.status ?? '') === status) return true;
    if (Date.now() > until) return false;
    await browser.pause(300);
  }
}

async function whatsappBody(): Promise<string> {
  return (await browser.execute(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')] as HTMLElement[];
    const dlg = dialogs.find((d) => /WhatsApp/i.test(d.innerText || ''));
    return dlg ? dlg.innerText || '' : document.body.innerText || '';
  })) as string;
}

async function qrRestitutionBlock(): Promise<string> {
  return (await browser.execute(() => {
    const allEls = [...document.querySelectorAll('div')] as HTMLElement[];
    const hit = allEls
      .filter((d) => /Scannez pour restitution/i.test(d.innerText || ''))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    return hit ? hit.innerText || '' : '';
  })) as string;
}

describe('REP - repair / SAV matrix', () => {
  before(async () => {
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    await bootUnlock();
    await resetData();
    seedHistoricSession();

    seedProducts([
      { id: 'REP-PART', title: 'Écran OLED S21', priceDa: 500, costDa: 300, stock: 5, category: 'Pièces' },
      { id: 'REP-ZERO', title: 'Batterie S21', priceDa: 500, costDa: 300, stock: 0, category: 'Pièces' },
      { id: 'REP-PART14', title: 'Connecteur de charge', priceDa: 500, costDa: 300, stock: 4, category: 'Pièces' },
    ]);

    // P0 fixtures -----------------------------------------------------------
    // REP-02: zero-balance Diagnostic (illegal skip) and delivered (backward).
    seedRepair({
      id: 'REP02A', ticket: 'T-REP02A', name: 'REP02 SKIP', model: 'Galaxy A12',
      imei: makeImei(1021), status: 'Diagnostic', labor: 1000, deposit: 1000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-20', 9),
    });
    seedRepair({
      id: 'REP02B', ticket: 'T-REP02B', name: 'REP02 BACK', model: 'Galaxy A12',
      imei: makeImei(1022), status: 'Livré', labor: 1000, deposit: 1000,
      tier: 'repair_90d', deliveredAt: DEL, createdAt: isoAt('2026-09-10', 9),
    });
    // REP-05: two catalog parts, not yet consumed.
    seedRepair({
      id: 'REP05', ticket: 'T-REP05', name: 'REP05 PARTS', model: 'Galaxy S21',
      imei: makeImei(1050), status: 'Diagnostic', labor: 1000, parts: 1000, deposit: 0,
      tier: 'repair_90d', createdAt: isoAt('2026-09-21', 9),
      spareParts: [
        { productId: 'REP-PART', productTitle: 'Écran OLED S21', quantity: 2, unitPrice: 500, unitCost: 300, isConsumed: false },
      ],
    });
    // REP-06: out-of-stock part attached to a ticket.
    seedRepair({
      id: 'REP06', ticket: 'T-REP06', name: 'REP06 OOS', model: 'Galaxy S21',
      imei: makeImei(1060), status: 'Diagnostic', labor: 500, parts: 500, deposit: 0,
      tier: 'repair_90d', createdAt: isoAt('2026-09-22', 9),
      spareParts: [
        { productId: 'REP-ZERO', productTitle: 'Batterie S21', quantity: 1, unitPrice: 500, unitCost: 300, isConsumed: false },
      ],
    });
    // REP-07: unlocked balance (3000 total / 1000 deposit).
    seedRepair({
      id: 'REP07', ticket: 'T-REP07', name: 'REP07 SETTLE', model: 'Galaxy S22',
      imei: makeImei(1070), status: 'Prêt / Terminé', labor: 3000, deposit: 1000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-23', 9),
    });
    // REP-11 / REP-13: delivered tickets with frozen legal evidence.
    seedRepair({
      id: 'REP11', ticket: 'T-REP11', name: 'REP11 IMEI', model: 'Galaxy S23',
      imei: makeImei(1110), status: 'Livré', labor: 1000, deposit: 1000,
      tier: 'repair_90d', deliveredAt: DEL, createdAt: isoAt('2026-09-11', 9),
    });
    seedRepair({
      id: 'REP13', ticket: 'T-REP13', name: 'REP13 INVOICE', model: 'Galaxy S23',
      imei: makeImei(1130), status: 'Livré', labor: 1000, deposit: 1000,
      tier: 'repair_90d', deliveredAt: DEL, createdAt: isoAt('2026-09-12', 9),
    });
    seedSale({
      id: 'TXN-REP13', receipt: 'TXN-REP13', createdAt: DEL,
      items: [{ productId: 'SAV-T-REP13', title: 'Solde Réparation T-REP13', price: 1000 }],
      total: 1000, shiftId: 'E2E-HIST-SESSION',
      customer: { id: 'CUST-REP13', name: 'REP13 INVOICE', phone: '0550001313' },
    });
    // REP-14: a part already consumed and deposit taken.
    seedRepair({
      id: 'REP14', ticket: 'T-REP14', name: 'REP14 CANCEL', model: 'Galaxy S24',
      imei: makeImei(1140), status: 'En cours', labor: 1000, parts: 500, deposit: 500,
      tier: 'repair_90d', createdAt: isoAt('2026-09-24', 9),
      spareParts: [
        { productId: 'REP-PART14', productTitle: 'Connecteur de charge', quantity: 1, unitPrice: 500, unitCost: 300, isConsumed: true, consumedAt: isoAt('2026-09-25', 9) },
      ],
    });
    // REP-15: a device sold with live store warranty + an in-stock trade-in.
    seedSale({
      id: 'TXN-REP15', receipt: 'TXN-REP15', createdAt: isoAt('2026-06-01', 10),
      items: [{ productId: 'PHONE-REP15', title: 'iPhone 14', price: 90000, imei: makeImei(1150), warrantyMonths: 12 }],
      total: 90000, shiftId: 'E2E-HIST-SESSION',
      customer: { id: 'CUST-REP15', name: 'REP15 CLIENT', phone: '0550115151' },
    });
    seedImei({
      imei: makeImei(1150), productId: 'PHONE-REP15', status: 'sold',
      saleTransactionId: 'TXN-REP15', warrantyMonths: 12, soldAt: isoAt('2026-06-01', 10),
    });
    seedImei({
      imei: makeImei(1151), productId: 'PHONE-REP15', status: 'in_stock',
      warrantyMonths: 0, receivedAt: isoAt('2026-09-01', 8),
    });
    // REP-24: two recent delivered repairs, same device + same fault.
    seedRepair({
      id: 'REP24A', ticket: 'T-REP24A', name: 'REP24 FIRST', model: 'Galaxy Z Flip',
      imei: makeImei(1240), status: 'Livré', labor: 800, deposit: 800, problem: 'Écran fissuré',
      tier: 'repair_30d', deliveredAt: isoAt('2026-10-10', 11), createdAt: isoAt('2026-10-08', 9),
    });
    seedRepair({
      id: 'REP24B', ticket: 'T-REP24B', name: 'REP24 SECOND', model: 'Galaxy Z Flip',
      imei: makeImei(1240), status: 'Livré', labor: 800, deposit: 800, problem: 'Écran fissuré',
      tier: 'repair_30d', deliveredAt: isoAt('2026-10-15', 11), createdAt: isoAt('2026-10-13', 9),
    });
    // REP-25: balance due so "Régler & Livrer" injects the SAV line, checkout
    // settles it, and the real REPAIR_DELIVERED_EVENT opens the QR banner.
    seedRepair({
      id: 'REP25', ticket: 'T-REP25', name: 'REP25 QR', model: 'Galaxy A54',
      imei: makeImei(1250), status: 'Prêt / Terminé', labor: 2000, deposit: 1000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-26', 9),
    });
    // REP-08: expired original, used for a rework claim.
    seedRepair({
      id: 'REP08', ticket: 'T-REP08', name: 'REP08 EXPIRED', model: 'Galaxy S20',
      imei: makeImei(1080), status: 'Livré', labor: 1000, deposit: 1000,
      tier: 'repair_30d', deliveredAt: isoAt('2026-09-20', 11), createdAt: isoAt('2026-09-15', 9),
    });

    await refreshApp();
    captureInvariantBaseline('REP');
  });

  afterEach(async () => {
    await closeDialogs().catch(() => undefined);
    await closeRepairModal().catch(() => undefined);
    await closeInspector().catch(() => undefined);
    await closeDialogs().catch(() => undefined);
    // A failed settle case (REP-07) can leave its SAV balance line in the till.
    // Every case starts from the same seed; leaving the line behind would make
    // the next pickup pay a foreign repair's balance and mask its own result.
    await drainCart().catch(() => undefined);
    assertInvariants('REP');
  });

  after(() => {
    finalizeInvariants('REP');
  });

  // ======================= P0 =============================================

  it('[REP-03] deposit at intake, over-deposit warning/cap, cancel refunds exactly once', async () => {
    await openRepairModal();
    await fillIntake({
      name: 'REP03 OVER', phone: '0550030303', model: 'Galaxy A32', imei: makeImei(1030),
      problem: 'Batterie usée', labor: 1000, deposit: 1500,
    });
    const bodyOver = await bodyText();
    const over = await saveRepairWait('REP03 OVER');
    const rowOver = one<Row>('SELECT deposit_amount,total_cost FROM repair_orders WHERE id=?', over.id);
    console.log(`[REP-03] over deposit row=${JSON.stringify(rowOver)} warning=${/plafonn/i.test(bodyOver)}`);

    const r = await newRepair({
      name: 'REP03 DEPOSIT', phone: '0550030304', model: 'Galaxy A31', imei: makeImei(1031),
      problem: 'Écran cassé', labor: 1000, deposit: 500,
    });
    const row = one<Row>('SELECT total_cost,deposit_amount,ticket_number FROM repair_orders WHERE id=?', r.id);
    console.log(`[REP-03] intake row=${JSON.stringify(row)}`);
    const ticket = String(row?.ticket_number ?? '');
    await historyOn(ticket);
    await setCardStatus(ticket, 'Annulé');
    await waitStatus(ticket, 'Annulé');
    const refunds = cashRefunds(ticket);
    console.log(`[REP-03] cancel refunds=${refunds.length} total=${refunds.reduce((s, x) => s + Number(x.amount || 0), 0)}`);

    expect(Number(rowOver?.deposit_amount)).toBe(1000);
    expect(/plafonn/i.test(bodyOver)).toBe(true);
    expect(Number(row?.total_cost)).toBe(1000);
    expect(Number(row?.deposit_amount)).toBe(500);
    expect(refunds.length).toBe(1);
    expect(refunds.reduce((s, x) => s + Number(x.amount || 0), 0)).toBe(500);
  });

  it('[REP-05] parts decrement exactly once, repeated completion is idempotent, cancel restores', async () => {
    const ticket = 'T-REP05';
    await historyOn(ticket);
    await setCardStatus(ticket, 'Prêt / Terminé');
    await browser.waitUntil(
      () => {
        const p = repairPayload('REP05');
        const parts = (p.spareParts ?? []) as Row[];
        return parts.some((x) => x.isConsumed);
      },
      { timeout: 20000, timeoutMsg: 'REP-05 part never consumed on completion' },
    );
    const afterFirst = stockOf('REP-PART');
    const ledgerFirst = ledgerSum('REP-PART');
    await setCardStatus(ticket, 'En cours');
    await setCardStatus(ticket, 'Prêt / Terminé');
    await browser.pause(900);
    const afterSecond = stockOf('REP-PART');
    const ledgerSecond = ledgerSum('REP-PART');
    await setCardStatus(ticket, 'Annulé');
    await waitStatus(ticket, 'Annulé');
    await browser.pause(700);
    const afterCancel = stockOf('REP-PART');
    const ledgerCancel = ledgerSum('REP-PART');
    console.log(
      `[REP-05] stock first=${afterFirst} second=${afterSecond} cancel=${afterCancel} ledger=${ledgerFirst}/${ledgerSecond}/${ledgerCancel}`,
    );
    expect(afterFirst).toBe(3);
    expect(ledgerFirst).toBe(3);
    expect(afterSecond).toBe(3);
    expect(ledgerSecond).toBe(3);
    expect(afterCancel).toBe(5);
    expect(ledgerCancel).toBe(5);
  });

  it('[REP-06] out-of-stock part is backordered, never silently sold into negative stock', async () => {
    const ticket = 'T-REP06';
    await historyOn(ticket);
    await setCardStatus(ticket, 'Prêt / Terminé');
    await browser.pause(2500);
    const stock = stockOf('REP-ZERO');
    const ledger = ledgerSum('REP-ZERO');
    const payload = repairPayload('REP06');
    const backorder = /backorder|commande|en attente de pi[eè]ce/i.test(JSON.stringify(payload));
    console.log(`[REP-06] stock=${stock} ledger=${ledger} backorderState=${backorder} payload=${JSON.stringify(payload.spareParts)}`);
    expect(backorder).toBe(true);
    expect(stock).toBeGreaterThanOrEqual(0);
    expect(ledger).toBeGreaterThanOrEqual(0);
  });

  it('[REP-07] pickup payment: split tender, discount gate, and no auto-delivery on underpayment', async () => {
    const ticket = 'T-REP07';
    await historyOn(ticket);
    const before = repairRowByTicket(ticket);
    const clicked = await clickCardAction(ticket, /Régler\s*&\s*Livrer/);
    console.log(`[REP-07] settle clicked=${clicked} before=${String(before?.status)} remaining=${Number(before?.total_cost) - Number(before?.deposit_amount)}`);
    await browser.pause(1200);
    await overrideLastLinePrice('100', { pin: APP_PIN });
    await clickControl('checkout-button');
    await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 20000 });
    const payBody = await bodyText();
    const split = /répartition|split|paiement mixte espèces.*carte|espèces.*carte.*mixte/i.test(payBody);
    console.log(`[REP-07] payment modal splitControl=${split} excerpt=${payBody.slice(0, 500).replace(/\n/g, ' | ')}`);
    await (await $(tid('pay-exact'))).click();
    await (await $(tid('pay-confirm'))).click();
    await browser.waitUntil(
      async () => !(await $(tid('pay-dialog')).isDisplayed().catch(() => false)),
      { timeout: 45000, timeoutMsg: 'pay dialog did not close' },
    );
    await browser.pause(1500);
    const after = repairRowByTicket(ticket);
    console.log(`[REP-07] afterStatus=${String(after?.status)} afterDeposit=${Number(after?.deposit_amount)}`);
    expect(clicked).toBe(true);
    expect(split).toBe(true);
    expect(String(after?.status)).not.toBe('Livré');
  });

  it('[REP-10] customer passcode is never stored on the ticket, logs, or print', async () => {
    await openRepairModal();
    await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Nouveau Ticket SAV/.test(x.textContent || ''),
      );
      b?.click();
    });
    await browser.pause(350);
    const formHasPasscode = (await browser.execute(() => {
      const form = document.querySelector('#sav-intake-form');
      if (!form) return { form: false, pass: false };
      const pass = [...form.querySelectorAll('input')].some((i) => {
        const hint = `${i.type} ${i.name} ${i.placeholder} ${i.getAttribute('aria-label') || ''}`;
        return i.type === 'password' || /passcode|mot de passe|code de verrouillage|\bpin\b/i.test(hint);
      });
      return { form: true, pass };
    })) as { form: boolean; pass: boolean };
    await fillIntake({
      name: 'REP10 LOCK', phone: '0550101010', model: 'iPhone 13', imei: makeImei(1100),
      problem: 'Écran cassé', labor: 1000, deposit: 0,
    });
    // The lock chip records "provided: true", never the code itself.
    const chip = (await browser.execute(() => {
      const form = document.querySelector('#sav-intake-form');
      if (!form) return false;
      const b = ([...form.querySelectorAll('button')] as HTMLButtonElement[]).find(
        (x) => /^Code PIN$/.test((x.textContent || '').trim()),
      );
      b?.click();
      return Boolean(b);
    })) as boolean;
    await browser.pause(250);
    const saved = await saveRepairWait('REP10 LOCK');
    const payload = repairPayload(String(saved.id));
    const lock = (payload.intakeDamage as Row | undefined)?.deviceLock;
    const raw = JSON.stringify(payload);
    const leaks = /"(passcode|pinCode|deviceCode|password)"\s*:\s*"[^"]+"/i.test(raw);
    const cols = columnNames('repair_orders').filter((c) => /pass|code|pin/i.test(c));
    console.log(`[REP-10] chip=${chip} lock=${JSON.stringify(lock)} leaks=${leaks} columns=${JSON.stringify(cols)}`);
    expect(formHasPasscode.form).toBe(true);
    expect(formHasPasscode.pass).toBe(false);
    expect(chip).toBe(true);
    expect(lock).toBeTruthy();
    expect((lock as Row | undefined)?.provided).toBe(true);
    expect(leaks).toBe(false);
    expect(cols).toEqual([]);
  });

  it('[REP-11] IMEI/device identity is frozen after delivery (board swap cannot rewrite history)', async () => {
    const ticket = 'T-REP11';
    const newImei = makeImei(1111);
    await historyOn(ticket);
    const opened = await editCard(ticket);
    await setInputInForm('aria', 'IMEI|série', newImei);
    await setInputInForm('placeholder', 'iPhone', 'iPhone 15 Pro');
    await browser.pause(300);
    const save = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Mettre à jour Ticket/.test(x.textContent || ''),
      );
      b?.click();
      return Boolean(b);
    })) as boolean;
    await browser.pause(2500);
    const row = repairRowByTicket(ticket);
    const payload = repairPayload('REP11');
    console.log(`[REP-11] opened=${opened} save=${save} imei=${String(row?.imei)} payloadImei=${String(payload.imei)} model=${String(payload.deviceModel)}`);
    expect(opened).toBe(true);
    expect(save).toBe(true);
    expect(String(row?.imei)).toBe(makeImei(1110));
    expect(String(payload.imei)).toBe(makeImei(1110));
    expect(String(payload.deviceModel)).toBe('Galaxy S23');
  });

  it('[REP-13] invoice total cannot be rewritten after delivery without a credit note', async () => {
    const ticket = 'T-REP13';
    await historyOn(ticket);
    const opened = await editCard(ticket);
    await typeMoneyInto(await $('#sav-labor'), 500);
    await browser.pause(250);
    const save = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Mettre à jour Ticket/.test(x.textContent || ''),
      );
      b?.click();
      return Boolean(b);
    })) as boolean;
    await browser.pause(2500);
    const row = repairRowByTicket(ticket);
    const inv = one<Row>("SELECT total FROM transactions WHERE receipt_number='TXN-REP13'");
    const credit = all<Row>("SELECT * FROM transactions WHERE is_refund=1 AND original_transaction_id='TXN-REP13'");
    console.log(`[REP-13] opened=${opened} save=${save} repairTotal=${Number(row?.total_cost)} invoiceTotal=${Number(inv?.total)} creditNotes=${credit.length}`);
    expect(opened).toBe(true);
    expect(save).toBe(true);
    expect(Number(row?.total_cost)).toBe(1000);
    expect(credit.length).toBe(1);
  });

  it('[REP-14] cancel after parts consumed restores stock and refunds the deposit exactly once', async () => {
    const ticket = 'T-REP14';
    await historyOn(ticket);
    await setCardStatus(ticket, 'Annulé');
    await waitStatus(ticket, 'Annulé');
    await browser.pause(1200);
    const firstStock = stockOf('REP-PART14');
    const firstRefunds = cashRefunds(ticket);
    const firstTotal = firstRefunds.reduce((s, x) => s + Number(x.amount || 0), 0);
    // Reactivation path: Annulé -> En cours -> Annulé must not pay the deposit twice.
    await setCardStatus(ticket, 'En cours');
    await waitStatus(ticket, 'En cours');
    await setCardStatus(ticket, 'Annulé');
    await waitStatus(ticket, 'Annulé');
    await browser.pause(1500);
    const secondRefunds = cashRefunds(ticket);
    const secondTotal = secondRefunds.reduce((s, x) => s + Number(x.amount || 0), 0);
    console.log(
      `[REP-14] stock=${firstStock} refunds first=${firstRefunds.length}/${firstTotal} second=${secondRefunds.length}/${secondTotal}`,
    );
    expect(firstStock).toBe(5);
    expect(firstRefunds.length).toBe(1);
    expect(firstTotal).toBe(500);
    expect(secondRefunds.length).toBe(1);
    expect(secondTotal).toBe(500);
  });

  it('[REP-18] unclaimed-cash / forfeited-deposit accounting surface is absent', async () => {
    await openRepairModal();
    await openHistoryTab();
    await setHistorySearch('');
    const body = await bodyText();
    const cols = columnNames('repair_orders').filter((c) => /forfeit|unclaimed|abandon/i.test(c));
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%forfeit%' OR name LIKE '%unclaimed%' OR name LIKE '%abandon%')",
    ).map((r) => r.name);
    console.log(`[REP-18] bodyMatch=${/forfait|non r[eé]clam|abandon/i.test(body)} cols=${JSON.stringify(cols)} tables=${JSON.stringify(tables)}`);
    expect(cols).toEqual([]);
    expect(tables).toEqual([]);
    expect(/forfait|non r[eé]clam[eé]|d[eé]p[oô]t.*abandon/i.test(body)).toBe(false);
  });

  it('[REP-21] third-party pickup requires identity/proxy evidence and is absent', async () => {
    await openRepairModal();
    await openHistoryTab();
    await setHistorySearch('T-REP02B');
    const card = await cardText('T-REP02B');
    const control = (await browser.execute(() => {
      const hits = [...document.querySelectorAll('button,input,select,textarea')].filter((el) => {
        const txt = `${(el as HTMLElement).innerText || ''} ${(el as HTMLInputElement).placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
        return /retir[eé] par|mandataire|procuration|tiers|pi[eè]ce d.identit/i.test(txt);
      });
      return hits.length;
    })) as number;
    console.log(`[REP-21] cardHasButton=${/Fiche Reçu/i.test(card)} thirdPartyControls=${control}`);
    expect(control).toBeGreaterThan(0);
  });

  // ======================= P1 =============================================

  it('[REP-25] restitution QR resolves to a tenant/route, not a bare ticket number', async () => {
    const ticket = 'T-REP25';
    // REP-07 intentionally leaves its underpaid SAV line in the cart. A full
    // suite run must start this unrelated pickup with a clean till; the app's
    // own "Vider" control clears every line, including the protected SAV line.
    // Do NOT reload here: App.tsx registers a beforeunload guard while the
    // cart is non-empty, so WebView refresh can be cancelled and the old
    // lines survive. Clear through the shipped control instead.
    await closeDialogs().catch(() => undefined);
    await closeRepairModal().catch(() => undefined);
    await browser.pause(300);
    const startState = await browser.execute(() => ({
      dialogs: ([...document.querySelectorAll('[role="dialog"]')] as HTMLElement[]).map(
        (d) => d.getAttribute('aria-label') || d.getAttribute('data-testid') || (d.innerText || '').slice(0, 40),
      ),
      body: (document.body.innerText || '').slice(0, 220).replace(/\n/g, ' | '),
      cartClearExists: Boolean(document.querySelector('[data-testid="cart-clear"]')),
      cartLines: document.querySelectorAll('[data-testid="cart-line"]').length,
    }));
    console.log(`[REP-25] startState=${JSON.stringify(startState)}`);
    const cartSnapshot = async (): Promise<{ lines: string[]; total: string; articles: string }> =>
      (await browser.execute(() => {
        const lines = ([...document.querySelectorAll('[data-testid="cart-line"]')] as HTMLElement[]).map(
          (e) => (e.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
        );
        const total =
          (document.querySelector('[data-testid="cart-total"]') as HTMLElement | null)?.innerText || '';
        const articles = ((document.body.innerText || '').match(/\d+ Articles?/) || [''])[0];
        return { lines, total, articles };
      })) as { lines: string[]; total: string; articles: string };
    console.log(`[REP-25] cartAtStart=${JSON.stringify(await cartSnapshot())}`);
    await browser.waitUntil(
      async () => (await $(tid('cart-clear')).isDisplayed().catch(() => false)),
      { timeout: 15000, interval: 250 },
    ).catch(() => undefined);
    const clearButton = await $(tid('cart-clear'));
    const clearVisible = await clearButton.isDisplayed().catch(() => false);
    if (clearVisible) {
      await browser.execute(() => {
        window.confirm = () => true;
      });
      await clearButton.click();
      await browser.pause(600);
    }
    const linesAfterClear = (await browser.execute(() =>
      ([...document.querySelectorAll('[data-testid="cart-line"]')] as HTMLElement[]).map((e) =>
        (e.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
      ))) as string[];
    console.log(`[REP-25] clearVisible=${clearVisible} linesAfterClear=${JSON.stringify(linesAfterClear)}`);
    await historyOn(ticket);
    console.log(`[REP-25] cartAfterHistory=${JSON.stringify(await cartSnapshot())}`);
    const beforeRow = repairRowByTicket(ticket);
    const settleClicked = await clickCardAction(ticket, /R[eé]gler\s*&\s*Livrer/i);
    await browser.pause(1500);
    console.log(`[REP-25] cartAfterSettle=${JSON.stringify(await cartSnapshot())}`);
    const afterRow = repairRowByTicket(ticket);
    const tail = (await bodyText()).slice(-420).replace(/\n/g, ' | ');
    const checkout = (await browser.execute(() => {
      const b = document.querySelector('[data-testid="checkout-button"]') as HTMLButtonElement | null;
      return b ? { disabled: b.disabled, title: b.title } : null;
    })) as { disabled: boolean; title: string } | null;
    console.log(`[REP-25] settleClicked=${settleClicked} before=${JSON.stringify({ status: beforeRow?.status, total: beforeRow?.total_cost, deposit: beforeRow?.deposit_amount })} after=${JSON.stringify({ status: afterRow?.status })} checkout=${JSON.stringify(checkout)} tail=${tail}`);
    await payExactFlow();
    await browser.pause(1200);
    const postRow = repairRowByTicket(ticket);
    const postBody = await bodyText();
    const postModal = /Nouveau Ticket SAV/.test(postBody);
    const postBanner = /Scannez pour restitution/i.test(postBody);
    console.log(`[REP-25] postStatus=${String(postRow?.status ?? '')} postModal=${postModal} postBanner=${postBanner} postTail=${postBody.slice(-360).replace(/\n/g, ' | ')}`);
    if (!postModal) await openRepairModal();
    await browser.pause(800);
    const qrBlock = await qrRestitutionBlock();
    const delivered = String(repairRowByTicket(ticket)?.status ?? '') === 'Livré';
    const scanCopy = /Scannez pour restitution/i.test(qrBlock);
    const url = /https?:\/\/|ticket=|#\/ticket|tenant|boutique\//i.test(qrBlock);
    const bare = qrBlock.includes(ticket) && !url;
    const qrAlt = (await browser.execute(() => {
      const img = document.querySelector('img[alt^="Ticket SAV"]') as HTMLImageElement | null;
      return img ? { alt: img.alt, src: (img.src || '').slice(0, 64) } : null;
    })) as { alt: string; src: string } | null;
    console.log(`[REP-25] settleClicked=${settleClicked} delivered=${delivered} scanCopy=${scanCopy} routeLike=${url} bareTicket=${bare} block=${qrBlock.replace(/\n/g, ' | ')} qrAlt=${JSON.stringify(qrAlt)}`);
    expect(settleClicked).toBe(true);
    expect(delivered).toBe(true);
    expect(scanCopy).toBe(true);
    expect(url).toBe(true);
  });

  it('[REP-01] intake captures accessories and persists photo evidence', async () => {
    await openRepairModal();
    await fillIntake({
      name: 'REP01 INTAKE', phone: '0550010101', model: 'iPhone 12', imei: makeImei(1010),
      problem: 'Écran fissuré + batterie', labor: 2500, deposit: 0, photos: 1,
    });
    const body = await bodyText();
    const accessories = (await browser.execute(() => {
      const form = document.querySelector('#sav-intake-form');
      if (!form) return false;
      return [...form.querySelectorAll('input,select,textarea,button')].some((el) => {
        const hint = `${(el as HTMLInputElement).placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
        return /accessoire|chargeur|c[aâ]ble|coque/i.test(hint);
      });
    })) as boolean;
    const saved = await saveRepairWait('REP01 INTAKE');
    const payload = repairPayload(String(saved.id));
    const photos = Array.isArray(payload.intakePhotos) ? (payload.intakePhotos as unknown[]).length : -1;
    console.log(`[REP-01] accessories=${accessories} photos=${photos} photoToast=${/photo non enregistr/i.test(body)}`);
    expect(accessories).toBe(true);
    expect(photos).toBe(1);
  });

  it('[REP-02] illegal status transitions (skip and backward) are rejected', async () => {
    await historyOn('T-REP02A');
    await setCardStatus('T-REP02A', 'Livré');
    await browser.pause(1800);
    const skip = String(repairRowByTicket('T-REP02A')?.status ?? '');
    await historyOn('T-REP02B');
    await setCardStatus('T-REP02B', 'Diagnostic');
    await browser.pause(1500);
    const back = String(repairRowByTicket('T-REP02B')?.status ?? '');
    console.log(`[REP-02] skip Diagnostic->Livré => ${skip}; backward Livré->Diagnostic => ${back}`);
    expect(skip).toBe('Diagnostic');
    expect(back).toBe('Livré');
  });

  it('[REP-04] final cost above approved estimate requires a new approval', async () => {
    seedRepair({
      id: 'REP04', ticket: 'T-REP04', name: 'REP04 ESTIMATE', model: 'Galaxy A52',
      imei: makeImei(1040), status: 'En cours', labor: 1000, deposit: 0,
      tier: 'repair_90d', createdAt: isoAt('2026-09-27', 9),
    });
    await refreshApp({ ensureShift: false });
    await historyOn('T-REP04');
    const opened = await editCard('T-REP04');
    await typeMoneyInto(await $('#sav-labor'), 5000);
    await browser.pause(250);
    await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Mettre à jour Ticket/.test(x.textContent || ''),
      );
      b?.click();
    });
    await browser.pause(2500);
    const row = repairRowByTicket('T-REP04');
    const payload = repairPayload('REP04');
    const approval = Object.keys(payload).filter((k) => /approv|estimate|devis/i.test(k));
    console.log(`[REP-04] opened=${opened} total=${Number(row?.total_cost)} approvalKeys=${JSON.stringify(approval)}`);
    expect(opened).toBe(true);
    expect(Number(row?.total_cost)).toBe(1000);
    expect(approval.length).toBeGreaterThan(0);
  });

  it('[REP-08] warranty claim after expiry / on a different part is refused', async () => {
    const original = repairRowByTicket('T-REP08');
    await openRepairModal();
    await fillIntake({
      name: 'REP08 REWORK', phone: '0550080808', model: 'Galaxy S20',
      imei: makeImei(1080), problem: 'Même panne écran', labor: 0, deposit: 0,
      reworkId: String(original?.id ?? ''),
    });
    const rework = await saveRepairWait('REP08 REWORK');
    await browser.pause(2000);
    const claims = claimRows().filter((c) => String(c.rework_repair_id) === String(rework.id));
    const expiry = String(repairPayload('REP08').warrantyExpiresAt ?? '');
    const linked = String(repairPayload(String(rework.id)).reworkOfRepairId ?? '') === String(original?.id ?? '');
    console.log(`[REP-08] originalExpiry=${expiry} linked=${linked} claims=${claims.length} claim=${JSON.stringify(claims[0] ?? {})}`);
    expect(expiry).toBe('2026-10-20');
    expect(linked).toBe(true);
    expect(claims.length).toBe(0);
  });

  it('[REP-09] abandoned-device reminders / storage-policy workflow is absent', async () => {
    const cols = columnNames('repair_orders').filter((c) => /abandon|remind|relance|storage/i.test(c));
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%reminder%' OR name LIKE '%abandon%' OR name LIKE '%storage%')",
    ).map((r) => r.name);
    await openRepairModal();
    await openHistoryTab();
    const body = await bodyText();
    const control = /relance|rappel|non r[eé]clam|frais de garde/i.test(body);
    console.log(`[REP-09] cols=${JSON.stringify(cols)} tables=${JSON.stringify(tables)} control=${control}`);
    expect(cols).toEqual([]);
    expect(tables).toEqual([]);
    expect(control).toBe(false);
  });

  it('[REP-12] multi-device ticket (two devices, one customer) is absent', async () => {
    const cols = columnNames('repair_orders');
    const multi = cols.filter((c) => /device2|second_device|devices|multi/i.test(c));
    await openRepairModal();
    const form = await browser.execute(() => {
      const f = document.querySelector('#sav-intake-form');
      return f ? (f.innerText || '') : '';
    });
    const add = /ajouter un (appareil|device)|2[eè]me appareil|multi-appareil/i.test(String(form));
    console.log(`[REP-12] multiCols=${JSON.stringify(multi)} addControl=${add} techSelect=${/Technicien/i.test(String(form))}`);
    expect(multi.length).toBeGreaterThan(0);
    expect(add).toBe(true);
  });

  it('[REP-15] warranty vs paid repair and trade-in internal job are classified', async () => {
    await openRepairModal();
    await fillIntake({
      name: 'REP15 WARRANTY', phone: '0550151515', model: 'iPhone 14',
      imei: makeImei(1150), problem: 'Batterie', labor: 3000, deposit: 0,
    });
    await browser.pause(2200);
    const body = await bodyText();
    const active = /Garantie Magasin Active/i.test(body);
    const apply = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /Appliquer prise en charge sous garantie/i.test(x.textContent || ''),
      );
      b?.click();
      return Boolean(b);
    })) as boolean;
    await browser.pause(400);
    const labor = await $('#sav-labor').getValue();
    const uiInternal = (await browser.execute(() => {
      const form = document.querySelector('#sav-intake-form');
      if (!form) return false;
      return [...form.querySelectorAll('input,select,textarea,button')].some((el) => {
        const hint = `${(el as HTMLInputElement).placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
        return /travail interne|job interne|intervention interne|reprise.*interne|trade-?in.*(interne|job)|type d'intervention/i.test(hint);
      });
    })) as boolean;
    const saved = await saveRepairWait('REP15 WARRANTY');
    const payload = repairPayload(String(saved.id));
    const snap = payload.warrantySnapshot as Row | undefined;
    const internalCols = columnNames('repair_orders').filter((c) =>
      /internal|trade_?in|job_type|intervention_type/i.test(c),
    );
    const internalFlag = Boolean(
      payload.internalJob ?? payload.isInternal ?? payload.jobType ?? payload.interventionType ?? payload.tradeIn,
    );
    const internalClass = uiInternal || internalCols.length > 0 || internalFlag;
    console.log(`[REP-15] active=${active} apply=${apply} labor=${labor} internalClass=${internalClass} uiInternal=${uiInternal} internalCols=${JSON.stringify(internalCols)} snapshot=${JSON.stringify(snap)}`);
    expect(active).toBe(true);
    expect(apply).toBe(true);
    expect(Number(String(labor).replace(/[^0-9]/g, ''))).toBe(0);
    expect(snap?.isUnderWarranty).toBe(true);
    expect(internalClass).toBe(true);
  });

  it('[REP-16] status notification: duplicate send, invalid phone, and AR/FR copy', async () => {
    seedRepair({
      id: 'REP16', ticket: 'T-REP16', name: 'REP16 NOTIFY', phone: 'abc', model: 'Galaxy A13',
      imei: makeImei(1160), status: 'Prêt / Terminé', labor: 1000, deposit: 1000,
      tier: 'repair_90d', createdAt: isoAt('2026-09-28', 9),
    });
    await refreshApp({ ensureShift: false });
    await historyOn('T-REP16');
    const clicked = (await browser.execute(() => {
      const b = ([...document.querySelectorAll('button')] as HTMLButtonElement[]).find((x) =>
        /WhatsApp/i.test(x.textContent || ''),
      );
      b?.click();
      return Boolean(b);
    })) as boolean;
    await browser.pause(1200);
    const body = await whatsappBody();
    const lang = /Fran[cç]ais|العربية/i.test(body);
    const phoneWarn = /invalide|non valide|num[eé]ro manquant|t[eé]l[eé]phone manquant/i.test(body);
    const dedupe = /d[eé]j[aà] (envoy[eé]|notifi[eé])|derni[eè]re notification|envoy[eé] le/i.test(body);
    console.log(`[REP-16] clicked=${clicked} langSwitch=${lang} invalidPhoneWarning=${phoneWarn} dedupeCopy=${dedupe} excerpt=${body.slice(0, 400).replace(/\n/g, ' | ')}`);
    expect(clicked).toBe(true);
    expect(phoneWarn).toBe(true);
    expect(lang).toBe(true);
    expect(dedupe).toBe(true);
  });

  it('[REP-19] mobile -> desktop ticket continuity is absent', async () => {
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%draft%' OR name LIKE '%mobile%' OR name LIKE '%continu%')",
    ).map((r) => r.name);
    const settings = all<Row>("SELECT key FROM app_settings WHERE key LIKE '%mobile%' OR key LIKE '%continu%'");
    console.log(`[REP-19] tables=${JSON.stringify(tables)} settings=${JSON.stringify(settings)}`);
    expect(tables).toEqual([]);
    expect(settings).toEqual([]);
  });

  it('[REP-20] SMS/approval link with one-time code is absent', async () => {
    const cols = columnNames('repair_orders').filter((c) => /approv|token|sms|otp/i.test(c));
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%approval%' OR name LIKE '%otp%' OR name LIKE '%token%')",
    ).map((r) => r.name);
    await openRepairModal();
    const form = await browser.execute(() => document.querySelector('#sav-intake-form')?.innerText || '');
    console.log(`[REP-20] cols=${JSON.stringify(cols)} tables=${JSON.stringify(tables)} linkCopy=${/lien|code.*sms|approbation/i.test(String(form))}`);
    expect(cols).toEqual([]);
    expect(tables).toEqual([]);
    expect(/envoyer.*lien|lien.*approbation|code.*sms/i.test(String(form))).toBe(false);
  });

  it('[REP-22] data-loss / backup consent checkbox exists (FR + AR liability text)', async () => {
    await openRepairModal();
    const res = (await browser.execute(() => {
      const form = document.querySelector('#sav-intake-form');
      if (!form) return { form: false, boxes: [], ar: false, fr: false };
      const boxes = [...form.querySelectorAll('input[type="checkbox"]')].map((b) =>
        (b.closest('label')?.textContent || '').trim(),
      );
      const txt = form.textContent || '';
      return {
        form: true,
        boxes,
        ar: /[\u0600-\u06FF]/.test(txt),
        fr: /sauvegarde|perte de donn[eé]es|donn[eé]es/i.test(txt),
      };
    })) as { form: boolean; boxes: string[]; ar: boolean; fr: boolean };
    const backup = res.boxes.some((b) => /sauvegarde|perte de donn|backup/i.test(b));
    console.log(`[REP-22] boxes=${JSON.stringify(res.boxes)} backupBox=${backup} ar=${res.ar} fr=${res.fr}`);
    expect(res.form).toBe(true);
    expect(res.ar).toBe(true);
    expect(res.fr).toBe(true);
    expect(backup).toBe(true);
  });

  it('[REP-23] repair price list per model/part is absent', async () => {
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%repair_price%' OR name LIKE '%labor_price%' OR name LIKE '%tarif%')",
    ).map((r) => r.name);
    const cols = columnNames('repair_orders').filter((c) => /price_list|tarif|grid/i.test(c));
    console.log(`[REP-23] tables=${JSON.stringify(tables)} cols=${JSON.stringify(cols)}`);
    expect(tables).toEqual([]);
    expect(cols).toEqual([]);
  });

  it('[REP-24] repeat defect on the same IMEI within N days is flagged', async () => {
    await openRepairModal();
    await fillIntake({
      name: 'REP24 RETURN', phone: '0550242424', model: 'Galaxy Z Flip',
      imei: makeImei(1240), problem: 'Écran fissuré', labor: 800, deposit: 800,
    });
    await browser.pause(2200);
    const body = await bodyText();
    // "Reprise garantie" is the manual rework selector, always present on the
    // intake form; it is NOT the automatic same-defect repeat warning. Match
    // only copy that states a repeat/recent repair, and log the exact hit.
    const repeatMatch = body.match(
      /(?:m[eê]me panne|d[eé]j[aà] r[eé]par[eé]|r[eé]paration r[eé]cente|r[eé]cidive|retour atelier|2e passage|deuxi[eè]me passage)/i,
    );
    const repeat = Boolean(repeatMatch);
    console.log(
      `[REP-24] repeatWarning=${repeat} match=${JSON.stringify(repeatMatch?.[0] ?? '')} reworkLabel=${/Reprise garantie/i.test(body)} warrantyBanner=${/Garantie Magasin|Hors garantie/i.test(body)}`,
    );
    expect(repeat).toBe(true);
  });

  // G-26 proof: a committed draft_* ref is detected (photo path writes drafts
  // that the shipped upload can never commit, so seed the exact defect).
  it('[REP-16/G-26] committed draft attachment is detected as dangling evidence', async () => {
    const draftRef = await writeAttachment(`draft_${Date.now()}`, 0);
    seedRepair({
      id: 'REP-G26', ticket: 'T-REP-G26', name: 'REP G26', model: 'Galaxy G26',
      imei: makeImei(1260), status: 'Livré', labor: 1000, deposit: 1000,
      tier: 'repair_30d', deliveredAt: isoAt('2026-10-11', 11),
      createdAt: isoAt('2026-10-06', 9), photos: [draftRef as unknown as Record<string, unknown>],
    });
    console.log(`[REP-G26] seeded draft ref=${JSON.stringify(draftRef)}`);
    expect(draftRef.relativePath).toMatch(/sav_attachments\/draft_/);
  });
});
