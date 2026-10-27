/**
 * Invariant negative controls (pre-batch gate, 2026-10-23).
 *
 * Each test injects a known-bad row/value into the e2e sandbox DB and asserts
 * the corresponding global invariant flags it. These are deliberately NOT
 * app-behaviour tests: they prove the harness checks can fail and close the
 * blind spots found in MNY-01/02, LOY-04, INV-13, REP-06 and P2-7.
 *
 * The rows are unique (`NC-*`) and removed in `finally`; the spec never touches
 * the live user profile and never edits app sources.
 */
import fs from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { DB_PATH } from '../lib/env';
import { run, waitForSchemaSettled } from '../lib/db';
import {
  captureInvariantBaseline,
  finalizeInvariants,
  runInvariantChecks,
} from '../lib/invariants';
import { resetData, seedCustomerDebts, seedCustomers, seedProducts } from '../lib/seed';

function violations(id: string): string[] {
  return runInvariantChecks()
    .filter((c) => c.id === id)
    .flatMap((c) => c.violations);
}

function flagged(id: string, ...needles: string[]): boolean {
  const rows = violations(id);
  return rows.some((v) => needles.every((n) => v.includes(n)));
}

describe('INVARIANT-NC - negative controls for the global invariant harness', () => {
  before(async () => {
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    resetData();
    seedProducts([
      { id: 'NC-G04', title: 'NC G04', priceDa: 100, stock: 0 },
      { id: 'NC-G05', title: 'NC G05', priceDa: 100, stock: 2, isSerialized: true },
      { id: 'NC-G11', title: 'NC G11', priceDa: 100, stock: 1 },
    ]);
    seedCustomers([
      { id: 'NC-G07', name: 'NC G07', phone: '550000007' },
      { id: 'NC-G34', name: 'NC G34', phone: '550000034' },
    ]);
    captureInvariantBaseline('INVARIANT-NC');
  });

  after(async () => {
    finalizeInvariants('INVARIANT-NC negative controls');
  });

  it('[G-04-NC] persisted negative stock is flagged even when stock and ledger agree', () => {
    try {
      run("UPDATE products SET stock = -1 WHERE id = 'NC-G04'");
      run(
        `INSERT INTO inventory_ledger
          (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key,
           sync_status, created_at, updated_at, deleted, version)
         VALUES ('NC-G04-LEDGER', 'NC-G04', -1, 'ADJUST', 'nc', 'NC-G04', 'e2e-nc',
                 'e2e-nc-g04', 'pending', datetime('now','utc'), datetime('now','utc'), 0, 1)`,
      );
      const v = violations('G-04');
      console.log(`[G-04-NC] ${JSON.stringify(v)}`);
      expect(flagged('G-04', 'NC-G04', 'negative stock')).toBe(true);
    } finally {
      run("DELETE FROM inventory_ledger WHERE id = 'NC-G04-LEDGER'");
      run("UPDATE products SET stock = 0 WHERE id = 'NC-G04'");
    }
  });

  it('[G-05-NC] serialized stock with zero imei_records is flagged', () => {
    const v = violations('G-05');
    console.log(`[G-05-NC] ${JSON.stringify(v)}`);
    expect(flagged('G-05', 'NC-G05', 'serialized stock=2', 'imei_records=0')).toBe(true);
  });

  it('[G-07-NC] exhausted bucket with an unreduced headline is flagged', () => {
    run(
      `UPDATE customers
          SET loyalty_points = 20,
              json_payload = ?
        WHERE id = 'NC-G07'`,
      JSON.stringify({
        pointBuckets: [
          { id: 'NC-BUCKET', initialPoints: 20, remainingPoints: 0, originTransactionId: 'NC-SALE' },
        ],
      }),
    );
    try {
      const v = violations('G-07');
      console.log(`[G-07-NC] ${JSON.stringify(v)}`);
      expect(flagged('G-07', 'NC-G07', 'headline 20', 'exhausted bucket')).toBe(true);
    } finally {
      run("UPDATE customers SET loyalty_points = 0, json_payload = '{}' WHERE id = 'NC-G07'");
    }
  });

  it('[G-11-NC] applied price != charged price is flagged', () => {
    run(
      `INSERT INTO transactions
        (id, receipt_number, subtotal, discount_total, total, status, created_at, json_payload)
       VALUES ('NC-TX', 'NC-RCPT', 10, 0, 10, 'COMPLETED', datetime('now','utc'), '{}')`,
    );
    run(
      `INSERT INTO transaction_items
        (id, transaction_id, product_id, quantity, applied_price, discount, json_payload,
         unit_price_charged, discount_amount)
       VALUES ('NC-ITEM', 'NC-TX', 'NC-G11', 1, 10.5, 0, '{}', 10, 0)`,
    );
    try {
      const v = violations('G-11');
      console.log(`[G-11-NC] ${JSON.stringify(v)}`);
      expect(flagged('G-11', 'NC-ITEM', 'applied_price=10.5', 'unit_price_charged=10')).toBe(true);
    } finally {
      run("DELETE FROM transaction_items WHERE id = 'NC-ITEM'");
      run("DELETE FROM transactions WHERE id = 'NC-TX'");
    }
  });

  it('[G-14-NC] fractional applied price is flagged as non-integer DA', () => {
    run(
      `INSERT INTO transactions
        (id, receipt_number, subtotal, discount_total, total, status, created_at, json_payload)
       VALUES ('NC-TX14', 'NC-RCPT14', 10.5, 0, 10.5, 'COMPLETED', datetime('now','utc'), '{}')`,
    );
    run(
      `INSERT INTO transaction_items
        (id, transaction_id, product_id, quantity, applied_price, discount, json_payload,
         unit_price_charged, discount_amount)
       VALUES ('NC-ITEM14', 'NC-TX14', 'NC-G11', 1, 10.5, 0, '{}', 10.5, 0)`,
    );
    try {
      const v = violations('G-14');
      console.log(`[G-14-NC] ${JSON.stringify(v)}`);
      expect(flagged('G-14', 'NC-ITEM14', 'applied_price=10.5', 'not integer DA')).toBe(true);
    } finally {
      run("DELETE FROM transaction_items WHERE id = 'NC-ITEM14'");
      run("DELETE FROM transactions WHERE id = 'NC-TX14'");
    }
  });

  it('[G-33-NC] text in the INTEGER requires_pin audit column is flagged', () => {
    run(
      `INSERT INTO security_audit_logs
        (id, timestamp, user, action, details, requires_pin)
       VALUES ('NC-AUDIT', datetime('now','utc'), 'Tester', 'NC', 'bad type', 'yes')`,
    );
    try {
      const v = violations('G-33');
      console.log(`[G-33-NC] ${JSON.stringify(v)}`);
      expect(flagged('G-33', 'NC-AUDIT', "typeof(requires_pin)='string'")).toBe(true);
    } finally {
      run("DELETE FROM security_audit_logs WHERE id = 'NC-AUDIT'");
    }
  });

  it('[G-34-NC] current_debt column lagging payload/ledger is flagged', () => {
    seedCustomerDebts([
      {
        id: 'NC-DEBT',
        customerId: 'NC-G34',
        customerName: 'NC G34',
        type: 'DEBT_ACQUIRED',
        amountDa: 50,
        balanceAfterDa: 50,
      },
    ]);
    run(
      `UPDATE customers SET current_debt = 0, json_payload = ? WHERE id = 'NC-G34'`,
      JSON.stringify({ currentDebt: 50 }),
    );
    try {
      const v = violations('G-34');
      console.log(`[G-34-NC] ${JSON.stringify(v)}`);
      expect(flagged('G-34', 'NC-G34', 'current_debt', 'payload')).toBe(true);
    } finally {
      run("DELETE FROM customer_debts WHERE id = 'NC-DEBT'");
      run("UPDATE customers SET current_debt = 0, json_payload = '{}' WHERE id = 'NC-G34'");
    }
  });
});
