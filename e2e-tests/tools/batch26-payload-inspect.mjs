import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const p = path.join(
  process.env.TEMP || os.tmpdir(),
  'opencode',
  'pos-wdio-sandbox',
  'home',
  'AppData',
  'Roaming',
  'com.mobi.pos.e2e',
  'mobi_pos.db',
);
const db = new Database(p, { readonly: true });
const row = db
  .prepare('SELECT id, receipt_number, total, json_payload FROM transactions ORDER BY rowid DESC LIMIT 1')
  .get();
console.log('row', row ? { id: row.id, receipt: row.receipt_number, total: row.total } : null);
if (row) {
  const j = JSON.parse(row.json_payload);
  console.log('keys', Object.keys(j));
  console.log('items', Array.isArray(j.items) ? j.items.length : typeof j.items);
  console.log('sample', JSON.stringify(j).slice(0, 700));
}
db.close();
