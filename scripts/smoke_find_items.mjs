import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const DB = path.join(process.env.APPDATA || '', 'com.mobi.pos', 'mobi_pos.db');
const db = new DatabaseSync(DB, { readOnly: true });
const q = (sql, p = []) => db.prepare(sql).all(...p);
for (const px of [2000, 3000, 5000, 8000, 10000, 12685]) {
  console.log(`--- price = ${px} ---`);
  console.table(q(`SELECT title, price, stock, sku FROM products WHERE price = ? AND stock > 0 LIMIT 6`, [px]));
}
