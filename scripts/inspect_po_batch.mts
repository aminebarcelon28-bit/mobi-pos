import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const b1 = await db.execute({
      sql: `SELECT * FROM stock_batches WHERE batch_id LIKE '%3AT6%' OR batch_id LIKE '%NEL0%'`,
    });
    console.log('BATCH DETAILS:');
    for (const b of b1.rows) {
      console.log(JSON.stringify(b, null, 2));
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);
