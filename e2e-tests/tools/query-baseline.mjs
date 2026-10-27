import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'fixtures', 'mobile-baseline.db');
const db = new Database(DB, { readonly: true });
try {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log('TABLES:', tables.map(r => r.name).join(', '));
  console.log(JSON.stringify(tables.map(r => ({name: r.name, sql: (r.sql||'').slice(0,200)})), null, 2));
  const prodCount = db.prepare('SELECT COUNT(*) n FROM products').get();
  console.log('products:', prodCount?.n);
  const custCount = db.prepare('SELECT COUNT(*) n FROM customers').get();
  console.log('customers:', custCount?.n);
  const appSettings = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE '%manager%' OR key LIKE '%pin%' OR key LIKE '%owner%' OR key LIKE '%user%'").all();
  console.log('app_settings manager/pin/user:', JSON.stringify(appSettings, null, 2));
  const managers = db.prepare("SELECT id, name, pin_hash FROM managers LIMIT 5").all().catch(() => db.prepare("SELECT id, name FROM sqlite_master WHERE name LIKE '%manager%'").all());
  console.log('managers result:', JSON.stringify(managers));
} catch(e) {
  console.log('ERROR:', e.message);
} finally {
  db.close();
}
