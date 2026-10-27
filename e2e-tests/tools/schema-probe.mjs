import BetterSqlite3 from 'better-sqlite3';
import { DB_PATH } from '../lib/env.ts';

const db = new BetterSqlite3(DB_PATH, { readonly: true });
for (const t of ['loyalty_ledger', 'held_orders', 'stock_batches', 'sync_state', 'cash_sessions', 'customer_debts']) {
  const cols = db.prepare('SELECT name, type FROM pragma_table_info(?)').all(t);
  console.log(t + ': ' + cols.map((c) => `${c.name}:${c.type}`).join(', '));
}
const idx = db
  .prepare("SELECT tbl_name, name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('products','customers')")
  .all();
console.log('\nindexes:');
for (const i of idx) console.log(`  ${i.tbl_name}.${i.name} :: ${String(i.sql ?? '(auto)').replace(/\s+/g, ' ')}`);
db.close();
