/** Which table does the mobile catalogue actually read? */
import Database from 'better-sqlite3';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'tmp', 'tim09', 'mobi_pos.db');
const db = new Database(DB, { readonly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log('mobile_tables=' + tables.join(','));
for (const t of tables) {
  if (!/^(p_|products|transactions|transaction_items|customers|sync_state|projection_cursor|app_settings)/.test(t)) continue;
  try {
    console.log(`${t}=${db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c}`);
  } catch (e) {
    console.log(`${t}=ERR ${String(e.message).slice(0, 60)}`);
  }
}
console.log(
  'products_row=' +
    JSON.stringify(db.prepare("SELECT id, title, sync_status, device_id FROM products WHERE id='T9-PROD-1'").get() ?? null),
);
console.log(
  'p_products_schema=' +
    JSON.stringify(db.prepare("SELECT name FROM pragma_table_info('p_products')").all().map((r) => r.name)),
);
db.close();
