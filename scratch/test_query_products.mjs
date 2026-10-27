import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA || '', 'com.mobi.pos', 'mobi_pos.db');
const db = new DatabaseSync(dbPath);

const rows = db.prepare('SELECT * FROM products WHERE deleted = 0').all();
console.log('Total products loaded from SQLite:', rows.length);

const targetIds = [
  'prod_batch_0c514277_1792601581432_0',
  'prod_batch_0c514277_1792601581432_1',
  'prod_batch_0c514277_1792601581432_2',
  'prod_batch_0c514277_1792601581432_3',
  'prod_batch_0c514277_1792601581432_4',
  'prod_batch_0c514277_1792601581432_5',
  'prod_batch_0c514277_1792601581432_6',
  'prod_batch_0c514277_1792601581432_7',
  'prod_batch_0c514277_1792601581432_8',
  'prod_batch_0c514277_1792601581432_9',
];

const found = rows.filter(r => targetIds.includes(r.id));
console.log(`Found ${found.length} of 10 target products:`);
for (const p of found) {
  console.log(p.id, '|', p.title, '| category:', p.category, '| stock:', p.stock, '| price:', p.price);
}

