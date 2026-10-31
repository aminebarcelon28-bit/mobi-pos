/**
 * DIAGNOSTIC — D4-A wallet leg at 32-bit boundaries.
 * No case id, not in the catalog: the executable proof the owner asked for
 * (2^31+1, 4e9, and a balance past 2^32), all customer-attached Avoir refunds,
 * each credited EXACTLY ONCE by the native transaction.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { all, count, one, run, waitForSchemaSettled } from '../lib/db';
import {
  addSku,
  APP_PIN,
  closeRefund,
  refundDialogVisible,
  tid,
  clearCart,
  clearWebMirrors,
  clickRefundSubmit,
  ensureShiftOpen,
  installErrorTrap,
  openRefund,
  refundSearch,
  selectCustomer,
  selectRefundMethod,
  selectRefundTicket,
  setRefundQty,
  typeRefundPin,
  unlockIfNeeded,
} from '../lib/pos';
import { resetData, seedCustomerFull, seedProducts, seedSettings } from '../lib/seed';

const CUST = 'REF4-C87';
const CUST_NAME = 'REF4 Extreme';
const P231 = 'REF4-P231';
const P4E9 = 'REF4-P4E9';

type Row = Record<string, unknown>;

const walletOf = (): number =>
  Number(one<{ c: number }>('SELECT COALESCE(store_credit,0) AS c FROM customers WHERE id = ?', CUST)?.c ?? -1);

function ledgerFor(refundId: string): Array<Record<string, unknown>> {
  const rows = all<Row>(
    `SELECT l.value AS v FROM customers c, json_each(c.json_payload,'$.ledger') l
      WHERE c.id = ? AND l.value->>'id' = 'LEDGER-REF-' || ?`,
    CUST,
    refundId,
  );
  return rows.map((r) => {
    const raw = r.v;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return (raw ?? {}) as Record<string, unknown>;
  });
}

async function settleRefund(ticketId: string, ms = 120000): Promise<Row | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const rows = all<Row>(
      'SELECT id, total, payment_method, status FROM transactions WHERE original_transaction_id = ? AND COALESCE(is_refund,0)=1',
      ticketId,
    );
    if (rows.length >= 1) return rows[rows.length - 1];
    await browser.pause(500);
  }
  return undefined;
}

async function payExactSlow(priceDa: number, ms = 180000): Promise<void> {
  const before = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')?.n ?? 0);
  await (await $(tid('checkout-button'))).click();
  await (await $(tid('pay-dialog'))).waitForDisplayed({ timeout: 30000 });
  await (await $(tid('pay-exact'))).click();
  await (await $(tid('pay-confirm'))).click();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = one<{ n: number }>('SELECT COUNT(*) AS n FROM transactions WHERE COALESCE(is_refund,0)=0 AND total = ?', priceDa);
    if (Number(hit?.n ?? 0) > 0) return;
    await browser.pause(500);
  }
  throw new Error('sale did not land within ' + ms + 'ms');
}

async function refundOneUnit(pid: string, title: string, priceDa: number, tag: string, seedWallet?: number) {
  if (await refundDialogVisible().catch(() => false)) await closeRefund().catch(() => {});
  await clearCart();
  await selectCustomer(CUST_NAME);
  await addSku(title, { times: 1 });
  await payExactSlow(priceDa);
  const ticket = one<Row>('SELECT id, receipt_number, total FROM transactions WHERE COALESCE(is_refund,0)=0 AND total = ? ORDER BY rowid DESC LIMIT 1', priceDa) as Row;
  expect(Number(ticket?.total)).toBe(priceDa);

  if (typeof seedWallet === 'number') {
    run(`UPDATE customers SET store_credit = ${seedWallet} WHERE id = 'REF4-C87'`);
  }
  const before = walletOf();
  await openRefund();
  await refundSearch(String(ticket.receipt_number));
  const picked = await selectRefundTicket(String(ticket.receipt_number), 30000);
  expect(picked).toBe('clicked');
  await setRefundQty(`${pid}_0`, 1);
  await selectRefundMethod('Avoir Client');
  await typeRefundPin(APP_PIN);
  const submitted = await clickRefundSubmit(1);
  expect(submitted).toBe(true);
  const refund = await settleRefund(String(ticket.id));
  expect(Boolean(refund)).toBe(true);
  const after = walletOf();
  console.log(`[D4A ${tag}] wallet ${before} -> ${after} (delta ${after - before}, refund ${String(refund?.total)})`);
  return { ticket, refund: refund as Row, before, after };
}

describe('D4-A — wallet leg at 32-bit boundaries', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), { timeout: 180000, interval: 1000, timeoutMsg: `no DB at ${DB_PATH}` });
    await waitForSchemaSettled();
    resetData();
    seedProducts([
      { id: P231, title: 'REF4 P231', priceDa: 2147483649, stock: 10, costDa: 1 },
      { id: P4E9, title: 'REF4 P4E9', priceDa: 4000000000, stock: 10, costDa: 1 },
    ]);
    seedCustomerFull([{ id: CUST, name: CUST_NAME, phone: '0551220087', currentDebtDa: 0, debtLimitDa: 100000 }]);
    // The wallet proof must not depend on the loyalty-tranche explosion: a 4e9
    // sale at the default earn rate materialises 200 000 milestone tranches
    // (139 MB payload, D6) which stalls the native merge. Earning is disabled
    // FOR THIS DIAG so the payload stays small and the wallet leg is measured.
    seedSettings([{ key: 'mobi_pos_receipt_settings', valueJson: JSON.stringify({ loyaltyConfig: { enabled: false } }) }]);
    await clearWebMirrors();
    await unlockIfNeeded();
    await ensureShiftOpen(10000);
  });

  it('2^31+1 DA Avoir refund credits the wallet exactly once', async () => {
    const { refund, before, after } = await refundOneUnit(P231, 'REF4 P231', 2147483649, '2^31+1');
    expect(Number(refund.total)).toBe(2147483649);
    expect(after - before).toBe(2147483649);
    const ledger = ledgerFor(String(refund.id));
    expect(ledger.length).toBe(1);
    expect(Number(ledger[0].creditDeltaDzd)).toBe(2147483649);
  });

  it('4e9 DA Avoir refund credits the wallet exactly once', async () => {
    const { refund, before, after } = await refundOneUnit(P4E9, 'REF4 P4E9', 4000000000, '4e9');
    expect(Number(refund.total)).toBe(4000000000);
    expect(after - before).toBe(4000000000);
    const ledger = ledgerFor(String(refund.id));
    expect(ledger.length).toBe(1);
    expect(Number(ledger[0].creditDeltaDzd)).toBe(4000000000);
  });

  it('the wallet goes past 2^32 and each credit is still applied once', async () => {
    // Start the wallet just under 2^32 so ONE credit carries it past the bound.
    const { refund, before, after } = await refundOneUnit(P231, 'REF4 P231', 2147483649, 'past-2^32', 4294967000);
    expect(before).toBeGreaterThanOrEqual(4294967000);
    expect(Number(refund.total)).toBe(2147483649);
    expect(after - before).toBe(2147483649);
    console.log(`[D4A past-2^32] wallet now ${after} (> 2^32 = ${Math.pow(2, 32)})`);
    expect(after).toBeGreaterThan(4294967296);
    const ledger = ledgerFor(String(refund.id));
    expect(ledger.length).toBe(1);
  });
});
