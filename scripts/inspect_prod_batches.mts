import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const batches = await db.execute({
      sql: `SELECT batch_id, quantity_remaining, unit_cost, received_at, purchase_order_id, created_at
            FROM stock_batches
            WHERE product_id = 'prod-1789591848585-909'
            ORDER BY created_at DESC LIMIT 10`,
    });
    console.log('--- RECENT BATCHES ---');
    console.table(batches.rows);
  } finally {
    db.close();
  }
}

main().catch(console.error);
