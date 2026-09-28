import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const pos = await db.execute({
      sql: "SELECT id, po_number, status, total_amount, json_payload FROM purchase_orders ORDER BY created_at DESC LIMIT 5",
    });
    console.log('RECENT POs:');
    for (const p of pos.rows) {
      console.log(p.id, p.po_number, p.status, p.total_amount);
      console.log('payload:', p.json_payload);
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);
