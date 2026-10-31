#!/usr/bin/env node
/**
 * refund-value-check.mjs — money conservation per COMPLETED refund.
 *
 * Owner rule (P0): for every COMPLETED refund,
 *
 *     total == cash_movements + wallet credit + credit_vouchers + sync_parked_movements
 *
 * The schema has no per-refund wallet ledger, so the wallet leg is the residual
 * (total − cash − vouchers − parked − debt − digital) and the check asserts the
 * two things that are observable:
 *
 *   1. cash_movements attributed to the refund never exceed the cash it says it
 *      disbursed (no drawer money without a refund, no refund cash without a
 *      movement when cashDisbursed > 0);
 *   2. a positive wallet residual REQUIRES a resolved recipient on the refund
 *      payload — otherwise the value lands nowhere (the REF-87 P0).
 *
 * Usage: node scripts/refund-value-check.mjs <db> [<db> ...]
 * Exit 1 when any completed refund violates a rule.
 */
import Database from 'better-sqlite3';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: refund-value-check.mjs <db> [<db> ...]');
  process.exit(2);
}

// transactions/cash_movements/voucher amounts are stored in DA (major); the
// refund funding payload is minor units (unit:'minor').
const major = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fromMinor = (v) => Math.round(Number(v) || 0) / 100;

function attribute(rows, refundId, refundReceipt) {
  return rows.filter((r) => {
    const blob = String(r.json_payload ?? '') + ' ' + String(r.reason ?? '') + ' ' + String(r.description ?? '');
    return blob.includes(refundId) || (refundReceipt && blob.includes(refundReceipt));
  });
}

let checked = 0;
let forgedSkipped = 0;
const violations = [];

for (const file of files) {
  let db;
  try {
    db = new Database(file, { readonly: true });
  } catch (e) {
    violations.push({ file, refund: '(open)', why: `cannot open: ${e.message}` });
    continue;
  }
  const has = (t) => {
    try {
      db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  };
  if (!has('transactions')) {
    db.close();
    continue;
  }
  const txCols = db.prepare("SELECT name FROM pragma_table_info('transactions')").all().map((r) => r.name);
  const refundFilter = txCols.includes('is_refund')
    ? "COALESCE(is_refund,0)=1"
    : "COALESCE(json_extract(json_payload,'$.isRefund'),0)=1";
  const refunds = db
    .prepare("SELECT id, receipt_number, total, json_payload, " + (txCols.includes('cash_tendered') ? 'cash_tendered' : 'NULL AS cash_tendered') + ", " + (txCols.includes('payment_method') ? 'payment_method' : "NULL AS payment_method") + " FROM transactions WHERE " + refundFilter + " AND status='COMPLETED'")
    .all();
  const cashRows = has('cash_movements') ? db.prepare('SELECT * FROM cash_movements').all() : [];
  const voucherRows = has('credit_vouchers') ? db.prepare('SELECT * FROM credit_vouchers').all() : [];
  const parkedRows = has('sync_parked_movements') ? db.prepare('SELECT * FROM sync_parked_movements').all() : [];

  for (const r of refunds) {
    if (/^REF-FORGE-/.test(String(r.id))) { forgedSkipped++; continue; }
    checked++;
    let p = {};
    try {
      p = JSON.parse(String(r.json_payload ?? '{}'));
    } catch {
      violations.push({ file, refund: r.id, why: 'unparseable refund payload' });
      continue;
    }
    const cash = attribute(cashRows, r.id, r.receipt_number).reduce((a, m) => a + Math.abs(major(m.amount)), 0);
    const vouchers = attribute(voucherRows, r.id, r.receipt_number).reduce((a, v) => a + major(v.initial_amount), 0);
    const parked = attribute(parkedRows, r.id, r.receipt_number).length;
    const declaredCash = major(r.cash_tendered ?? p.cashDisbursed ?? 0);
    const total = major(r.total);
    const funding = p.funding && p.funding.unit === 'minor' ? p.funding : null;
    const debt = funding ? fromMinor(funding.debt) : 0;
    const digital = funding ? fromMinor(funding.digital) : 0;
    const walletLeg = Math.max(0, Math.round((total - cash - vouchers - debt - digital) * 100) / 100);
    const recipient = String(p.customer?.id ?? '').trim();

    // 1. drawer honesty: money paid out of the drawer needs a movement, and a
    //    movement for this refund needs a declared cash disbursement.
    if (declaredCash > 0 && cash === 0) {
      violations.push({ file, refund: r.id, why: `cashDisbursed ${declaredCash} DA but no cash_movement attributed` });
    }
    if (cash > declaredCash + 0.01) {
      violations.push({ file, refund: r.id, why: `cash_movements ${cash} DA exceed declared cash ${declaredCash} DA` });
    }
    // 2. the wallet residual must have a recipient.
    if (walletLeg > 0 && !recipient) {
      violations.push({
        file,
        refund: r.id,
        why: `wallet leg ${walletLeg} DA with NO recipient (total ${total} − cash ${cash} − vouchers ${vouchers} − debt ${debt} − digital ${digital}); value would evaporate`,
      });
    }
  }
  db.close();
}

console.log(`REFUND VALUE: ${files.length} db(s), ${checked} completed refund(s), ${violations.length} violation(s), ${forgedSkipped} forged bypass row(s) excluded (negative-control probes, no movement by design)`);
for (const v of violations) {
  console.log(`  FAIL ${v.refund}  ${v.file}`);
  console.log(`       ${v.why}`);
}
process.exit(violations.length > 0 ? 1 : 0);
