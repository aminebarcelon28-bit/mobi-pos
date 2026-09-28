import { createClient } from '@libsql/client';

const dbPath = 'file:C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = createClient({ url: dbPath });

async function main() {
  try {
    const tx = await db.execute({
      sql: "SELECT id, receipt_number, total, cost_total, profit, profit_margin, ledger_cogs_total, status, created_at, json_payload FROM transactions WHERE receipt_number LIKE ? OR id LIKE ?",
      args: ['%1972IN%', '%1972IN%'],
    });
    console.log('TXN:', JSON.stringify(tx.rows, null, 2));

    if (tx.rows.length === 0) return;

    const txId = tx.rows[0].id;
    const items = await db.execute({
      sql: "SELECT id, transaction_id, product_id, quantity, applied_price, cost_price, unit_price_charged, unit_cost_at_sale, line_profit FROM transaction_items WHERE transaction_id = ?",
      args: [txId],
    });
    console.log('ITEMS:', JSON.stringify(items.rows, null, 2));

    const allocs = await db.execute({
      sql: "SELECT id, sale_id, batch_id, qty_consumed, unit_cost_at_sale, deleted FROM sale_batch_allocations WHERE sale_id = ?",
      args: [txId],
    });
    console.log('ALLOCS:', JSON.stringify(allocs.rows, null, 2));

  } finally {
    db.close();
  }
}

main().catch(console.error);
