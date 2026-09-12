import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db' });
for (const [label, sql] of [
  ['tables', "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"],
  ['outbox', 'SELECT entity_type, entity_id, status, retry_count, substr(last_error,1,120) AS err FROM sync_outbox ORDER BY rowid LIMIT 20'],
  ['outbox_counts', "SELECT status, COUNT(*) as n FROM sync_outbox GROUP BY status"],
  ['ledger', 'SELECT product_id, delta, reason, ref_id, sync_status FROM inventory_ledger ORDER BY rowid DESC LIMIT 10'],
  ['orders', 'SELECT id, receipt_number, total, status, sync_status FROM transactions ORDER BY updated_at DESC LIMIT 5'],
  ['settings', "SELECT key, substr(value_json,1,60) AS v FROM app_settings WHERE key LIKE 'sync.%'"],
]) {
  try {
    const rs = await db.execute(sql);
    console.log(`--- ${label} ---`, JSON.stringify(rs.rows));
  } catch (e) {
    console.log(`--- ${label} ERROR:`, e.message);
  }
}
