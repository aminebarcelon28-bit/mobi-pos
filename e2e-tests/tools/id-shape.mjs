import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node tools/id-shape.mjs <db>');
  process.exit(2);
}
const db = new BetterSqlite3(file, { readonly: true });
console.log('transactions (ordered by created_at):');
try {
  for (const r of db
    .prepare('SELECT id, receipt_number, created_at, total FROM transactions ORDER BY created_at LIMIT 8')
    .all()) {
    console.log(`  ${r.id}  ${r.receipt_number}  ${r.created_at}  total=${r.total}`);
  }
} catch (e) {
  console.log('  ERR ' + e.message);
}
console.log('\ncustomers:');
for (const r of db.prepare('SELECT id, name, phone FROM customers LIMIT 5').all()) {
  console.log(`  ${r.id}  ${r.name}  ${r.phone}`);
}
console.log('\nproducts:');
for (const r of db.prepare('SELECT id, title, price, stock, reorder_point FROM products LIMIT 5').all()) {
  console.log(`  ${r.id}  ${r.title}  price=${r.price} stock=${r.stock} reorder=${r.reorder_point}`);
}
console.log('\nmoney typeof:');
for (const q of [
  "SELECT typeof(total) t, total FROM transactions LIMIT 1",
  "SELECT typeof(price) t, price FROM products LIMIT 1",
  "SELECT typeof(total_spent) t, total_spent FROM customers LIMIT 1",
]) {
  try { console.log('  ' + JSON.stringify(db.prepare(q).get())); } catch (e) { console.log('  ERR ' + e.message); }
}
db.close();
