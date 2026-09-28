import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const batches = await db.execute({
      sql: `SELECT batch_id, product_id, quantity_remaining, unit_cost, received_at, purchase_order_id, shadow_sale_id, shadow_qty, shadow_resolved, created_at, deleted
            FROM stock_batches
            WHERE product_id = 'prod-1789591848585-909'
            ORDER BY received_at ASC, created_at ASC`,
    });
    console.log('ALL BATCHES FOR PRODUCT:');
    for (const b of batches.rows) {
      console.log(JSON.stringify(b));
    }

    const pos = await db.execute({
      sql: "SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT 10",
    });
    console.log('RECENT POs:');
    for (const p of pos.rows) {
      console.log(JSON.stringify(p));
    }

    const poItems = await db.execute({
      sql: "SELECT * FROM purchase_order_items WHERE product_id = 'prod-1789591848585-909'",
    });
    console.log('PO ITEMS FOR PRODUCT:');
    for (const pi of poItems.rows) {
      console.log(JSON.stringify(pi));
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);
