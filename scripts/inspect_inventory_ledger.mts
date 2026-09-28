import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const ledger = await db.execute({
      sql: `SELECT id, product_id, delta, reason, ref_type, ref_id, created_at
            FROM inventory_ledger
            WHERE product_id = 'prod-1789591848585-909'
            ORDER BY created_at DESC LIMIT 15`,
    });
    console.log('--- RECENT INVENTORY LEDGER ---');
    console.table(ledger.rows);

    const allocs = await db.execute({
      sql: `SELECT id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, created_at
            FROM sale_batch_allocations
            WHERE product_id = 'prod-1789591848585-909'
            ORDER BY created_at DESC LIMIT 10`,
    });
    console.log('--- RECENT ALLOCS ---');
    console.table(allocs.rows);
  } finally {
    db.close();
  }
}

main().catch(console.error);
