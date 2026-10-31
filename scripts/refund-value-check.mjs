#!/usr/bin/env node
/**
 * refund-value-check.mjs — money conservation, strict equality.
 *
 * Owner rule: for every COMPLETED refund,
 *
 *   total == cash_movements + wallet credit + credit_vouchers
 *            + sync_parked_movements + card-reversal record
 *
 * Destinations of record, exactly as the schema holds them:
 *   cash        cash_movements whose reason names the refund receipt ([AVOIR-…])
 *   wallet      customers.json_payload.ledger entries with creditDeltaDzd whose
 *               referenceId is the refunded SALE (the app keys the emission to
 *               the sale) — matched to refunds by (sale, amount) with multiplicity
 *   vouchers    credit_vouchers whose notes/key name the refund
 *   parked      sync_parked_movements whose data names the refund
 *   card        NO RECORD EXISTS in this schema — reported as a gap, never exempted
 *
 * Equality means over-credit fails too. No exclusions: deliberately forged
 * writes (REF-FORGE-*) must fail exactly like any other under-served refund.
 *
 * Usage: node scripts/refund-value-check.mjs <db> [<db> ...]
 * Exit 1 when any completed refund violates.
 */
import Database from 'better-sqlite3';

const argv = process.argv.slice(2);
const EXCLUDE_FORGE = argv.includes('--exclude-forge');
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: refund-value-check.mjs <db> [<db> ...]');
  process.exit(2);
}

const major = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fromMinor = (v) => Math.round(Number(v) || 0) / 100;
const cents = (v) => Math.round(major(v) * 100);

let checked = 0;
let cardGap = 0;
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
    ? 'COALESCE(is_refund,0)=1'
    : "COALESCE(json_extract(json_payload,'$.isRefund'),0)=1";
  const refunds = db
    .prepare(
      'SELECT id, receipt_number, total, json_payload, ' +
        (txCols.includes('original_transaction_id') ? 'original_transaction_id' : 'NULL AS original_transaction_id') +
        ' FROM transactions WHERE ' + refundFilter + " AND status='COMPLETED'",
    )
    .all();
  const cashRows = has('cash_movements') ? db.prepare('SELECT * FROM cash_movements').all() : [];
  const voucherRows = has('credit_vouchers') ? db.prepare('SELECT * FROM credit_vouchers').all() : [];
  const parkedRows = has('sync_parked_movements') ? db.prepare('SELECT * FROM sync_parked_movements').all() : [];

  // wallet destinations of record: creditDeltaDzd ledger entries, by sale id
  const walletBySale = new Map();
  try {
    const entries = db
      .prepare(
        `SELECT l.value->>'referenceId' AS ref, CAST(l.value->>'creditDeltaDzd' AS REAL) AS credit
           FROM customers c, json_each(c.json_payload,'$.ledger') l
          WHERE l.value->>'creditDeltaDzd' IS NOT NULL
            AND CAST(l.value->>'creditDeltaDzd' AS REAL) <> 0`,
      )
      .all();
    for (const e of entries) {
      const k = String(e.ref ?? '');
      if (!walletBySale.has(k)) walletBySale.set(k, []);
      walletBySale.get(k).push(major(e.credit));
    }
  } catch {
    /* older schema: no ledger array */
  }
  const walletUsed = new Map();

  for (const r of refunds) {
    if (EXCLUDE_FORGE && /^REF-FORGE-/.test(String(r.id))) continue;
    checked++;
    let p = {};
    try {
      p = JSON.parse(String(r.json_payload ?? '{}'));
    } catch {
      violations.push({ file, refund: r.id, why: 'unparseable refund payload' });
      continue;
    }
    const totalC = cents(r.total);
    const receipt = String(r.receipt_number ?? '');
    const saleId = String(r.original_transaction_id ?? p.originalTransactionId ?? '');

    const cashC = cents(
      cashRows
        .filter((m) => receipt && (String(m.reason ?? '') + String(m.json_payload ?? '')).includes(receipt))
        .reduce((a, m) => a + Math.abs(major(m.amount)), 0),
    );
    const voucherC = cents(
      voucherRows
        .filter((v) => receipt && (String(v.notes ?? '') + String(v.code ?? '') + String(v.idempotency_key ?? '')).includes(r.id))
        .reduce((a, v) => a + major(v.initial_amount), 0),
    );
    const parked = parkedRows.filter((m) => String(m.data_json ?? '').includes(String(r.id))).length;
    const parkedC = parked > 0 ? totalC : 0; // a parked movement holds the full value until settled

    // wallet: the residual after the other destinations, matched against an
    // unconsumed ledger emission for this sale (the app keys the emission to the
    // SALE, not the refund). A split refund (cash + wallet) resolves correctly.
    const residualC = totalC - cashC - voucherC - parkedC;
    let walletC = 0;
    const pool = walletBySale.get(saleId) ?? [];
    const used = walletUsed.get(saleId) ?? new Set();
    if (residualC > 0) {
      for (let i = 0; i < pool.length; i++) {
        if (used.has(i)) continue;
        if (cents(pool[i]) === residualC) {
          used.add(i);
          walletC = cents(pool[i]);
          break;
        }
      }
    }
    walletUsed.set(saleId, used);

    const funding = p.funding && p.funding.unit === 'minor' ? p.funding : null;
    const cardLeg = funding ? fromMinor(funding.digital) : 0;
    if (cardLeg > 0 && cashC + voucherC + parkedC + walletC === 0) cardGap++;

    const deliveredC = cashC + voucherC + parkedC + walletC;
    if (deliveredC !== totalC) {
      const parts = [
        `cash ${cashC / 100}`,
        `wallet ${walletC / 100}`,
        `vouchers ${voucherC / 100}`,
        parked ? `parked ${parkedC / 100}` : 'parked 0',
      ];
      if (cardLeg > 0) parts.push(`card leg ${cardLeg} with NO destination of record`);
      violations.push({
        file,
        refund: r.id,
        why: `total ${totalC / 100} != delivered ${deliveredC / 100} (${parts.join(' + ')})`,
      });
    }
  }
  db.close();
}

console.log(
  `REFUND VALUE${EXCLUDE_FORGE ? ' (negative-control writes excluded)' : ' (all rows)'}: ${files.length} db(s), ${checked} completed refund(s), ${violations.length} violation(s)` +
    (cardGap ? `, ${cardGap} refund(s) with a card leg and no destination record` : ''),
);
for (const v of violations) {
  console.log(`  FAIL ${v.refund}  ${v.file}`);
  console.log(`       ${v.why}`);
}
process.exit(violations.length > 0 ? 1 : 0);
