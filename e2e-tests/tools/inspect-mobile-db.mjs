import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dir = process.argv[2] || 'mobile/tmp/proof-session';
const db = new Database(`${dir}/mobi_pos.db`, { readonly: true });
try {
  const q = (sql) => { try { return db.prepare(sql).get(); } catch (e) { return { err: e.message }; } };
  console.log('products          =', JSON.stringify(q('SELECT COUNT(*) n FROM products')));
  console.log('products(deleted=0)=', JSON.stringify(q('SELECT COUNT(*) n FROM products WHERE deleted=0')));
  console.log('p_products        =', JSON.stringify(q('SELECT COUNT(*) n FROM p_products')));
  console.log('products_fts      =', JSON.stringify(q('SELECT COUNT(*) n FROM products_fts')));
  console.log('projection_cursor =', JSON.stringify(q('SELECT * FROM projection_cursor')));
  console.log('event_log         =', JSON.stringify(q('SELECT COUNT(*) n FROM event_log')));
  console.log('sample products   =', JSON.stringify(q('SELECT id,title,price,stock,deleted FROM products LIMIT 3')));
  console.log('sample p_products =', JSON.stringify(q('SELECT * FROM p_products LIMIT 3')));
  console.log('app_settings keys =', JSON.stringify(q("SELECT GROUP_CONCAT(key) k FROM app_settings")));
} finally { db.close(); }
