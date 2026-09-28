import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const out = await db.execute({
      sql: `SELECT * FROM sync_outbox WHERE payload_json LIKE '%1790539%' OR payload_json LIKE '%AU51H%' ORDER BY rowid DESC LIMIT 10`,
    });
    console.log('SYNC OUTBOX:');
    for (const r of out.rows) {
      console.log(r.idempotency_key, r.entity_type, r.operation, r.payload_json);
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);
