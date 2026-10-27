/** Compare the installed APK's schema against the desktop HEAD schema. */
import Database from 'better-sqlite3';
import * as adb from '../mobile/lib/adb.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'tmp', 'tim09-inspect', 'mobi_pos.db');
const DESKTOP_DB = `${process.env.TEMP}/opencode/pos-wdio-sandbox/home/AppData/Roaming/com.mobi.pos.e2e/mobi_pos.db`;

const m = new Database(MOBILE_DB, { readonly: true });
const d = new Database(DESKTOP_DB, { readonly: true });

const cols = (db, t) => {
  try {
    return db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name);
  } catch {
    return [];
  }
};
const tables = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

const uv = (db) => db.pragma('user_version', { simple: true });
console.log(`mobile_user_version=${uv(m)} desktop_user_version=${uv(d)}`);
const mt = tables(m);
const dt = tables(d);
console.log(`mobile_tables=${mt.length} desktop_tables=${dt.length}`);
console.log(`tables_only_in_desktop=${dt.filter((t) => !mt.includes(t)).join(',')}`);
console.log(`tables_only_in_mobile=${mt.filter((t) => !dt.includes(t)).join(',')}`);

for (const t of ['transactions', 'transaction_items', 'products', 'customers', 'app_settings']) {
  const mc = cols(m, t);
  const dc = cols(d, t);
  console.log(`COLUMNS ${t} mobile=${mc.length} desktop=${dc.length}`);
  console.log(`  missing_on_mobile=${dc.filter((c) => !mc.includes(c)).join(',') || '(none)'}`);
  console.log(`  missing_on_desktop=${mc.filter((c) => !dc.includes(c)).join(',') || '(none)'}`);
}
console.log(`mobile_counts products=${m.prepare('SELECT COUNT(*) c FROM products').get().c} customers=${m.prepare('SELECT COUNT(*) c FROM customers').get().c} transactions=${m.prepare('SELECT COUNT(*) c FROM transactions').get().c}`);
console.log(`desktop_counts products=${d.prepare('SELECT COUNT(*) c FROM products').get().c} customers=${d.prepare('SELECT COUNT(*) c FROM customers').get().c} transactions=${d.prepare('SELECT COUNT(*) c FROM transactions').get().c}`);
m.close();
d.close();
