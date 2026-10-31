/**
 * DIAGNOSTIC — P0 recipient rule (owner ruling: fail closed).
 * No case id, not in the catalog: this is the executable proof for the two
 * anonymous entry points that no catalog case covers any more (REF-87's fixture
 * now carries a customer by owner authorisation).
 *
 * Proves, per entry point, that a refused refund writes NOTHING:
 *   - manual "Avoir Client" on an anonymous ticket
 *   - the offline cash-cap path on an anonymous ticket (terminal, no switch)
 *   - replay (two submits)
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { count, one, waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  APP_PIN,
  clearCart,
  clearWebMirrors,
  clickRefundSubmit,
  ensureShiftOpen,
  installErrorTrap,
  openRefund,
  payExactFlow,
  refundSearch,
  selectRefundMethod,
  selectRefundTicket,
  setRefundQty,
  tid,
  typeRefundPin,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedProducts, seedSettings } from '../lib/seed';

const P = 'REF4-PMAX';

type Row = Record<string, unknown>;

const snapshot = (ticketId: string) => ({
  refunds: count('transactions', 'COALESCE(is_refund,0)=1'),
  dedup: count('refund_dedup', 'ticket_id = ?', ticketId),
  stock: Number(one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', P)?.stock ?? -1),
  vouchers: count('credit_vouchers'),
  cashMoves: count('cash_movements'),
  parked: count('sync_parked_movements'),
  refundsForTicket: count('transactions', 'original_transaction_id = ? AND COALESCE(is_refund,0)=1', ticketId),
});

async function saleOfTwo(): Promise<Row> {
  await clearCart();
  await addSku('REF4 PMAX', { times: 2 });
  await payExactFlow();
  return one<Row>('SELECT id, receipt_number, total FROM transactions ORDER BY rowid DESC LIMIT 1') as Row;
}

async function stageOneUnit(tx: Row): Promise<void> {
  await openRefund();
  await refundSearch(String(tx.receipt_number));
  const picked = await selectRefundTicket(String(tx.receipt_number), 20000);
  expect(picked).toBe('clicked');
  await setRefundQty(`${P}_0`, 1);
}

describe('P0 recipient rule — anonymous Avoir must not be written', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), { timeout: 180000, interval: 1000, timeoutMsg: `no DB at ${DB_PATH}` });
    await waitForSchemaSettled();
    resetData();
    seedProducts([{ id: P, title: 'REF4 PMAX', priceDa: 2000, stock: 10, costDa: 1000 }]);
    seedSettings([{ key: 'policy.offline_cash_refund_limit', valueJson: '2500' }]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
  });

  it('manual Avoir Client on an anonymous ticket is refused and writes nothing', async () => {
    const tx = await saleOfTwo();
    await stageOneUnit(tx);
    await selectRefundMethod('Avoir Client');
    await typeRefundPin(APP_PIN);
    const before = snapshot(String(tx.id));
    await clickRefundSubmit(1);
    await browser.pause(2500);
    const after = snapshot(String(tx.id));
    const body = await browser.execute(() => (document.body.innerText || '').slice(-600));

    expect(after).toEqual(before); // no refund row, no dedup, no stock change, no voucher/cash/parked
    expect(String(body)).toMatch(/Avoir|client|aucun|personne/i);
  });

  it('offline cash cap on an anonymous ticket is terminal (no Avoir switch) and writes nothing', async () => {
    await clearCart();
    await browser.execute(() => {
      const dlg = document.querySelector('[data-testid="refund-dialog"]') as HTMLElement | null;
      if (dlg) dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await browser.pause(300);
    const tx = await saleOfTwo();
    await stageOneUnit(tx);
    await selectRefundMethod('Espèces');
    await typeRefundPin(APP_PIN);
    const before = snapshot(String(tx.id));
    await clickRefundSubmit(1);
    await browser.pause(2500);
    const after = snapshot(String(tx.id));
    const methodStillCash = await browser.execute(() => {
      const dlg = document.querySelector('[data-testid="refund-dialog"]') as HTMLElement | null;
      return (dlg?.innerText || '').includes('Espèces');
    });
    const body = await browser.execute(() => (document.body.innerText || '').slice(-900));

    expect(after).toEqual(before);
    expect(methodStillCash).toBe(true); // no silent switch onto Avoir
    expect(String(body)).toMatch(/plafond|Avoir|reconnect/i);
  });

  it('a replayed anonymous Avoir submit is refused both times, still nothing written', async () => {
    await clearCart();
    const tx = await saleOfTwo();
    await stageOneUnit(tx);
    await selectRefundMethod('Avoir Client');
    await typeRefundPin(APP_PIN);
    const before = snapshot(String(tx.id));
    await clickRefundSubmit(2);
    await browser.pause(2500);
    const after = snapshot(String(tx.id));
    expect(after).toEqual(before);
  });
});
