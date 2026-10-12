// Tier D atomicity checker: verifies crash-consistency of a SQLite till file.
// Checks (each prints VIOLATION or contributes to CLEAN):
//  1. PRAGMA integrity_check == ok.
//  2. Every transaction has >= 1 line (no half-written sale header).
//  3. No orphan transaction_items (child without parent).
//  4. No negative product stock / sale totals.
//  5. Receipt numbers unique.
// Usage: node scripts/check-atomicity.mjs --db <path-to-mobi_pos.db>
// Exit: 0 CLEAN, 1 violations found, 2 usage/db error.
import { createClient } from '@libsql/client';

const dbArg = process.argv.find((a) => a.startsWith('--db='));
if (!dbArg) {
  console.error('usage: check-atomicity.mjs --db <path>');
  process.exit(2);
}
const dbPath = dbArg.split('=').slice(1).join('=');
const db = createClient({ url: `file:${dbPath}` });
const violations = [];
try {
  const integ = await db.execute('PRAGMA integrity_check');
  if (String(integ.rows[0]?.integrity_check ?? integ.rows[0]) !== 'ok') {
    violations.push(`integrity_check: ${JSON.stringify(integ.rows[0])}`);
  }
  const q = async (sql, ...args) => (await db.execute({ sql, args })).rows;
  const headless = await q('SELECT COUNT(*) AS c FROM transactions t LEFT JOIN transaction_items l ON l.transaction_id = t.id WHERE l.id IS NULL');
  if (Number(headless[0]?.c ?? 0) > 0) violations.push(`sales without lines: ${headless[0].c}`);
  const orphans = await q('SELECT COUNT(*) AS c FROM transaction_items WHERE transaction_id NOT IN (SELECT id FROM transactions)');
  if (Number(orphans[0]?.c ?? 0) > 0) violations.push(`orphan lines: ${orphans[0].c}`);
  const negStock = await q('SELECT COUNT(*) AS c FROM products WHERE stock < 0');
  if (Number(negStock[0]?.c ?? 0) > 0) violations.push(`negative stock rows: ${negStock[0].c}`);
  const negSales = await q("SELECT COUNT(*) AS c FROM transactions WHERE total < 0 AND COALESCE(is_refund, 0) = 0");
  if (Number(negSales[0]?.c ?? 0) > 0) violations.push(`negative non-refund totals: ${negSales[0].c}`);
  const dups = await q('SELECT COUNT(*) AS c FROM (SELECT receipt_number FROM transactions GROUP BY receipt_number HAVING COUNT(*) > 1)');
  if (Number(dups[0]?.c ?? 0) > 0) violations.push(`duplicate receipt groups: ${dups[0].c}`);
  const tx = await q('SELECT COUNT(*) AS c FROM transactions');
  console.log(`[atomicity] ${dbPath}: transactions=${tx[0]?.c ?? '?'} ${violations.length === 0 ? 'CLEAN' : `VIOLATIONS: ${violations.join('; ')}`}`);
  process.exit(violations.length === 0 ? 0 : 1);
} catch (e) {
  console.error(`[atomicity] DB error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  process.exit(2);
} finally {
  db.close();
}
