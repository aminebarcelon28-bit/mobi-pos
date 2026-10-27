/** Inspect the live mobile DB (schema + counts) after pulling it. */
import * as adb from '../mobile/lib/adb.mjs';

const { db, dir } = adb.pullDb('tim09-inspect');
const rows = db
  .prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('transactions','transaction_items','products')",
  )
  .all();
for (const r of rows) {
  console.log(`TABLE ${r.name}`);
  console.log(r.sql);
}
for (const t of ['customers', 'products', 'transactions', 'transaction_items', 'app_settings']) {
  try {
    console.log(`${t}=${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`);
  } catch (e) {
    console.log(`${t}=ERR ${String(e.message).slice(0, 80)}`);
  }
}
console.log('DIR=' + dir);
db.close();
