import { createClient } from '@libsql/client';
const db = createClient({ url: 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db' });
const q = async (label, sql) => {
  try {
    const rs = await db.execute(sql);
    console.log(`--- ${label} ---`, JSON.stringify(rs.rows));
  } catch (e) { console.log(`--- ${label} ERROR:`, e.message); }
};
await q('outbox', 'SELECT entity_type, entity_id, status, retry_count FROM sync_outbox ORDER BY rowid');
await q('outbox_err', 'SELECT entity_type, last_error FROM sync_outbox WHERE last_error IS NOT NULL LIMIT 4');
await q('recent_orders', 'SELECT id, receipt_number, total, sync_status FROM transactions ORDER BY updated_at DESC LIMIT 3');
await q('ledger_recent', 'SELECT product_id, delta, reason, ref_id FROM inventory_ledger ORDER BY rowid DESC LIMIT 4');
