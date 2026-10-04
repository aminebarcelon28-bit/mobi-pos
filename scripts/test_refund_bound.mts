/**
 * Refund over-refund bound on the indexed linkage column (C2: DB-002).
 *
 * Proves against a disposable DB: the new indexed query returns exactly the
 * refund set the legacy full LIKE scan found (stamped rows + NULL-column
 * legacy rows + deleted exclusion + unparseable skip); EXPLAIN shows the
 * index serving the query; the backfill statement shapes are valid SQL and
 * idempotent. Also covers extractOriginalTransactionId().
 *
 * NOTE: backfillOriginalTransactionIds() itself lives in backfill.ts, which
 * cannot load in node (Dexie graph) — its SQL shapes below mirror that
 * function line-for-line; any edit there must update this mirror (comment
 * markers cite the source lines).
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import { extractOriginalTransactionId } from '../src/sync/causalVersion.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const DB_FILE = 'tmp-refund-bound.db';

// 1. extractOriginalTransactionId matrix.
check('valid key extracts', extractOriginalTransactionId('{"originalTransactionId":"TX-1"}') === 'TX-1');
check('missing key → null', extractOriginalTransactionId('{"total":5}') === null);
check('unparseable → null', extractOriginalTransactionId('not-json{{{') === null);
check('empty string key → null', extractOriginalTransactionId('{"originalTransactionId":""}') === null);
check('non-string input → null', extractOriginalTransactionId(null) === null && extractOriginalTransactionId(42) === null);
check('array root → null', extractOriginalTransactionId('[1,2]') === null);
check('numeric id coerced away → null (ids are strings)',
  extractOriginalTransactionId('{"originalTransactionId":123}') === null);

async function main() {
  try { rmSync(DB_FILE); } catch { /* fresh */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  const db = createClient({ url: `file:${DB_FILE}` });
  await db.execute(
    `CREATE TABLE transactions (id TEXT PRIMARY KEY, deleted INTEGER DEFAULT 0,
      json_payload TEXT, original_transaction_id TEXT)`,
  );
  await db.execute('CREATE INDEX IF NOT EXISTS idx_transactions_orig_txn ON transactions(original_transaction_id)');
  const put = (id: string, deleted: number, json: string, orig: string | null) =>
    db.execute({
      sql: 'INSERT INTO transactions (id, deleted, json_payload, original_transaction_id) VALUES (?, ?, ?, ?)',
      args: [id, deleted, json, orig],
    });
  const j = (orig: string) =>
    JSON.stringify({ id: 'R', originalTransactionId: orig, refundedItems: [{ productId: 'P', quantity: 2 }] });
  await put('R1', 0, j('ORIG-1'), 'ORIG-1'); // stamped current row
  await put('R2', 0, j('ORIG-1'), null); // legacy pre-backfill row
  await put('R3', 0, j('ORIG-2'), 'ORIG-2'); // different original
  await put('S1', 0, JSON.stringify({ id: 'S1', total: 9 }), null); // plain sale
  await put('R4', 0, '###unparseable###{"originalTransactionId":"ORIG-1"', null); // corrupt but LIKE-visible
  await put('R5', 1, j('ORIG-1'), 'ORIG-1'); // deleted: excluded everywhere
  await put('R6', 0, JSON.stringify({ id: 'R6', note: 'no linkage' }), null); // NULL col, no key

  // Legacy full scan + JS filter (old behavior, replicated).
  const legacy = await db.execute({
    sql: "SELECT id, json_payload FROM transactions WHERE deleted = 0 AND json_payload LIKE '%originalTransactionId%'",
    args: [],
  });
  const legacySet = new Set<string>();
  for (const row of legacy.rows as Array<{ id: string; json_payload: string }>) {
    try {
      const p = JSON.parse(row.json_payload) as { id?: string; originalTransactionId?: string };
      if (p.originalTransactionId === 'ORIG-1') legacySet.add(row.id);
    } catch { /* skipped, as production does */ }
  }

  // New indexed query (production shape, verbatim predicate).
  const fresh = await db.execute({
    sql: "SELECT id, json_payload FROM transactions WHERE deleted = 0 AND (original_transaction_id = ? OR (original_transaction_id IS NULL AND json_payload LIKE '%originalTransactionId%'))",
    args: ['ORIG-1'],
  });
  const freshSet = new Set<string>();
  for (const row of fresh.rows as Array<{ id: string; json_payload: string }>) {
    try {
      const p = JSON.parse(row.json_payload) as { id?: string; originalTransactionId?: string };
      if (p.originalTransactionId === 'ORIG-1') freshSet.add(row.id);
    } catch { /* skipped, as production does */ }
  }
  check('indexed query returns the legacy set exactly',
    freshSet.size === legacySet.size && [...freshSet].every((id) => legacySet.has(id)),
    `new=[${[...freshSet]}] old=[${[...legacySet]}]`);
  check('deleted rows excluded by both', !freshSet.has('R5') && !legacySet.has('R5'));
  check('other-original excluded', !freshSet.has('R3'));
  check('plain sales never match', !freshSet.has('S1') && !freshSet.has('R6'));

  // EXPLAIN: the index serves the stamped arm (not a table scan).
  const plan = await db.execute({
    sql: "EXPLAIN QUERY PLAN SELECT id FROM transactions WHERE deleted = 0 AND (original_transaction_id = ? OR (original_transaction_id IS NULL AND json_payload LIKE '%x%'))",
    args: ['ORIG-1'],
  });
  const details = (plan.rows as Array<{ detail: string }>).map((r) => String(r.detail)).join(' | ');
  check('planner uses the linkage index', /USING INDEX .*orig_txn|USING COVERING INDEX/i.test(details), details);

  // Backfill statement shapes (mirror of backfillOriginalTransactionIds).
  await db.execute({
    sql: 'UPDATE transactions SET original_transaction_id = ? WHERE id = ? AND original_transaction_id IS NULL',
    args: ['ORIG-1', 'R2'],
  });
  const after = await db.execute({ sql: 'SELECT original_transaction_id AS o FROM transactions WHERE id = ?', args: ['R2'] });
  check('backfill UPDATE stamps NULL rows', (after.rows[0] as { o: string }).o === 'ORIG-1');
  await db.execute({
    sql: 'UPDATE transactions SET original_transaction_id = ? WHERE id = ? AND original_transaction_id IS NULL',
    args: ['OTHER', 'R2'],
  });
  const after2 = await db.execute({ sql: 'SELECT original_transaction_id AS o FROM transactions WHERE id = ?', args: ['R2'] });
  check('backfill never overwrites stamped rows', (after2.rows[0] as { o: string }).o === 'ORIG-1');

  db.close();
  try { rmSync(DB_FILE); } catch { /* cleanup */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  console.log(`\nrefund-bound: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
