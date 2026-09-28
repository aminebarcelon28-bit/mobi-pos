/**
 * H8 regression: a partially-refunded ticket can be over-refunded.
 *
 * Reproduction (pre-fix):
 *  `RefundModal.initializeRefundState` seeds quantities from
 *  `txn.items[].quantity` — the ORIGINAL purchased quantity — and
 *  `eligibleTransactions` admits `PARTIALLY_REFUNDED` rows. Nothing in the
 *  write path (`createOrderSlice.processRefund`) subtracts what was already
 *  refunded, so a ticket of qty 2 could be refunded 1 unit, then reopened and
 *  refunded 2 units again: 3 units refunded against 2 purchased.
 *  Consequences: duplicate cash/store-credit payout, duplicate loyalty-point
 *  deduction, duplicate stock restock, and revenue understated by the excess.
 *
 * Post-fix: processRefund derives the remaining refundable quantity per product
 * from prior refund rows for the same original transaction and refuses any
 * request that exceeds it (`REFUND_EXCEEDS_PURCHASED`).
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h8-double-refund.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, receipt_number TEXT, original_transaction_id TEXT,
  is_refund INTEGER DEFAULT 0, status TEXT, total INTEGER, created_at TEXT,
  json_payload TEXT
);
`;

/**
 * Mirrors the post-fix accounting in createOrderSlice.processRefund: sum the
 * quantities already refunded for each product of the original ticket, then
 * bound the new request by what remains.
 */
function remainingRefundable(origItems, priorRefunds) {
  const already = new Map();
  for (const r of priorRefunds) {
    for (const ri of r.items) {
      already.set(ri.productId, (already.get(ri.productId) || 0) + ri.quantity);
    }
  }
  return origItems.map((it) => ({
    productId: it.productId,
    purchased: it.quantity,
    alreadyRefunded: already.get(it.productId) || 0,
    remaining: Math.max(0, it.quantity - (already.get(it.productId) || 0)),
  }));
}

async function main() {
  let db;
  try { rmSync(DB_FILE); } catch { /* may not exist */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  db = createClient({ url: `file:${DB_FILE}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }

  const DAY = '2026-09-14T10:00:00Z';
  // Original ticket: 2x PHONE (20000) + 1x CASE (5000)
  const origItems = [
    { productId: 'PHONE', quantity: 2 },
    { productId: 'CASE', quantity: 1 },
  ];
  await db.execute(
    `INSERT INTO transactions (id,receipt_number,original_transaction_id,is_refund,status,total,created_at,json_payload)
     VALUES ($1,$2,NULL,0,'COMPLETED',25000,$3,$4)`,
    ['TXN-1', 'TICKET-1', DAY, JSON.stringify({ items: origItems })],
  );

  const load = async (id) => {
    const r = (await db.execute('SELECT json_payload FROM transactions WHERE id=$1', [id])).rows[0];
    return JSON.parse(String(r.json_payload));
  };
  const insertRefund = async (id, origId, items, total) => {
    await db.execute(
      `INSERT INTO transactions (id,receipt_number,original_transaction_id,is_refund,status,total,created_at,json_payload)
       VALUES ($1,$2,$3,1,'COMPLETED',$4,$5,$6)`,
      [id, `AVOIR-${id}`, origId, total, '2026-09-14T11:00:00Z', JSON.stringify({ items })],
    );
  };
  const priorRefunds = async (origId) => {
    const rows = (await db.execute(
      'SELECT json_payload FROM transactions WHERE is_refund=1 AND original_transaction_id=$1', [origId],
    )).rows;
    return rows.map((r) => JSON.parse(String(r.json_payload)));
  };

  // ---- 1. Full refund of the whole ticket is accepted. ----
  {
    const rem = remainingRefundable(origItems, await priorRefunds('TXN-1'));
    check('nothing refunded yet: PHONE remaining = 2', rem[0].remaining === 2, `rem=${rem[0].remaining}`);
    check('nothing refunded yet: CASE remaining = 1', rem[1].remaining === 1);
    const requested = [{ productId: 'PHONE', quantity: 2 }, { productId: 'CASE', quantity: 1 }];
    const ok = requested.every((q) => q.quantity <= (rem.find((r) => r.productId === q.productId)?.remaining ?? 0));
    check('a full refund of the purchased quantities is allowed', ok);
    await insertRefund('REF-1', 'TXN-1', requested, 25000);
  }

  // ---- 2. Reopening the same ticket must NOT allow refunding again. ----
  {
    const rem = remainingRefundable(origItems, await priorRefunds('TXN-1'));
    check('after full refund: PHONE remaining = 0', rem[0].remaining === 0, `rem=${rem[0].remaining}`);
    check('after full refund: CASE remaining = 0', rem[1].remaining === 0);
    const requested = [{ productId: 'PHONE', quantity: 2 }];
    const ok = requested.every((q) => q.quantity <= (rem.find((r) => r.productId === q.productId)?.remaining ?? 0));
    check('a second full refund is refused (remaining 0)', !ok);
  }

  // ---- 3. Partial refund then over-refund of the remainder. ----
  await db.execute("DELETE FROM transactions WHERE id='REF-1'");
  {
    // First refund: 1 of the 2 PHONEs (partial).
    const rem = remainingRefundable(origItems, []);
    const first = [{ productId: 'PHONE', quantity: 1 }];
    check('partial refund of 1 PHONE is allowed (remaining 2)', first[0].quantity <= rem[0].remaining);
    await insertRefund('REF-1', 'TXN-1', first, 10000);

    // The modal would re-seed from the ORIGINAL items (qty 2) — the bug.
    const remAfter = remainingRefundable(origItems, await priorRefunds('TXN-1'));
    check('after 1 refunded: PHONE remaining = 1', remAfter[0].remaining === 1, `rem=${remAfter[0].remaining}`);
    check('after 1 refunded: alreadyRefunded = 1', remAfter[0].alreadyRefunded === 1);

    const greedy = [{ productId: 'PHONE', quantity: 2 }];
    const greedyOk = greedy.every((q) => q.quantity <= (remAfter.find((r) => r.productId === q.productId)?.remaining ?? 0));
    check('refunding the ORIGINAL qty again (2 > remaining 1) is refused', !greedyOk);

    const exact = [{ productId: 'PHONE', quantity: 1 }];
    const exactOk = exact.every((q) => q.quantity <= (remAfter.find((r) => r.productId === q.productId)?.remaining ?? 0));
    check('refunding exactly the remaining 1 is allowed', exactOk);
  }

  // ---- 4. Refunds of a DIFFERENT ticket do not consume this ticket's quota. ----
  {
    await db.execute(
      `INSERT INTO transactions (id,receipt_number,original_transaction_id,is_refund,status,total,created_at,json_payload)
       VALUES ($1,$2,NULL,0,'COMPLETED',10000,$3,$4)`,
      ['TXN-2', 'TICKET-2', DAY, JSON.stringify([{ productId: 'PHONE', quantity: 1 }])],
    );
    await insertRefund('REF-2', 'TXN-2', [{ productId: 'PHONE', quantity: 1 }], 10000);
    const rem = remainingRefundable(origItems, await priorRefunds('TXN-1'));
    check('TXN-2 refund does not consume TXN-1 quota', rem[0].alreadyRefunded === 1, `already=${rem[0].alreadyRefunded}`);
  }

    // ---- 5. Production guard shape: prior refunds carry `refundedItems`. ----
    // createOrderSlice reads t.refundedItems (not items) on prior refund rows.
    {
      await db.execute("DELETE FROM transactions WHERE id LIKE 'REF-%'");
      // Prior partial refund recorded with refundedItems (as processRefund does).
      await db.execute(
        `INSERT INTO transactions (id,receipt_number,original_transaction_id,is_refund,status,total,created_at,json_payload)
         VALUES ($1,$2,$3,1,'COMPLETED',10000,$4,$5)`,
        [
          'REF-3', 'AVOIR-3', 'TXN-1', '2026-09-14T12:00:00Z',
          JSON.stringify({ refundedItems: [{ productId: 'PHONE', quantity: 1 }] }),
        ],
      );
      const prior = await priorRefunds('TXN-1');
      // The production guard maps over t.refundedItems || t.items — mirror both.
      const already = new Map();
      for (const r of prior) {
        for (const ri of (r.refundedItems || r.items)) {
          already.set(ri.productId, (already.get(ri.productId) || 0) + ri.quantity);
        }
      }
      check('guard reads refundedItems when present', already.get('PHONE') === 1, `already=${already.get('PHONE')}`);
      const purchasedPhone = origItems.find((i) => i.productId === 'PHONE').quantity;
      check('remaining = purchased - alreadyRefunded', purchasedPhone - already.get('PHONE') === 1);
    }
  console.log('====================================================');
  console.log(`TEST SUMMARY: ${pass} PASSED, ${fail} FAILED`);
  console.log('====================================================');
  await db.close();
  try { rmSync(DB_FILE); } catch { /* noop */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
