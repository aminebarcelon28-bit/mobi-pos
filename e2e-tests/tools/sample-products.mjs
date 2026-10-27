import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dir = process.argv[2] || 'mobile/tmp/disc';
const db = new Database(`${dir}/mobi_pos.db`, { readonly: true });
const rows = db.prepare('SELECT id, sku, barcode, title, stock, price FROM products WHERE deleted=0 AND stock>0 ORDER BY stock DESC LIMIT 5').all();
console.log(JSON.stringify(rows, null, 1));
db.close();
