import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node tools/schema-dump.mjs <db>');
  process.exit(2);
}
const db = new BetterSqlite3(file, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log('TABLES(' + tables.length + '): ' + tables.join(', '));
for (const t of ['customers', 'products', 'transactions', 'transaction_items', 'inventory_ledger', 'customer_debts', 'audit_chain', 'sync_outbox', 'app_settings', 'repair_orders', 'stock_batches']) {
  if (!tables.includes(t)) { console.log('\n' + t + ': ABSENT'); continue; }
  const cols = db.prepare(`SELECT name, type, pk FROM pragma_table_info('${t}')`).all();
  console.log('\n' + t + ' (' + cols.length + ' cols): ' + cols.map((c) => `${c.name}:${c.type}${c.pk ? ' PK' : ''}`).join(', '));
}
console.log('\nINDEXES:');
for (const r of db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name").all()) {
  console.log(`  ${r.tbl_name}.${r.name} :: ${String(r.sql || '(auto)').replace(/\s+/g, ' ').slice(0, 140)}`);
}
console.log('\nPRAGMAS:');
for (const p of ['page_size', 'cache_size', 'mmap_size', 'temp_store', 'journal_mode', 'wal_autocheckpoint', 'journal_size_limit', 'synchronous', 'foreign_keys', 'busy_timeout', 'auto_vacuum', 'analysis_limit']) {
  try { console.log(`  ${p} = ${JSON.stringify(db.pragma(p))}`); } catch (e) { console.log(`  ${p} = ERR ${e.message}`); }
}
try {
  console.log('\nfts sql: ' + JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%fts%'").all()).slice(0, 600));
} catch { /* ignore */ }
db.close();
