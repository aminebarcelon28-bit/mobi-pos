import { DatabaseSync } from 'node:sqlite';

const dbPath = 'C:/Users/Click/AppData/Roaming/com.mobi.pos/mobi_pos.db';
const db = new DatabaseSync(dbPath);

const targetTxId = 'TXN-1790539512575-1-7EDW';
const targetReceipt = 'REC-20260927-1972IN-02-AU51H';
const now = new Date().toISOString();

console.log('--- Starting Patch for Ticket', targetReceipt, '---');

db.exec('BEGIN IMMEDIATE;');

try {
  // 1. Fetch current transaction
  const txn = db.prepare("SELECT * FROM transactions WHERE id = ?").get(targetTxId);
  if (!txn) {
    throw new Error(`Transaction ${targetTxId} not found!`);
  }
  console.log('Found transaction:', txn.id, 'current profit:', txn.profit, 'cost_total:', txn.cost_total);

  // 2. Parse and update transactions.json_payload
  let txnPayload = {};
  try {
    txnPayload = JSON.parse(txn.json_payload || '{}');
  } catch (e) {
    console.warn('Failed to parse txn json_payload:', e);
  }

  txnPayload.costTotal = 900;
  txnPayload.cost_total = 900;
  txnPayload.profit = 6100;
  txnPayload.profitMargin = 87.1;
  txnPayload.profit_margin = 87.1;
  txnPayload.ledgerCogsTotal = 900;
  txnPayload.ledger_cogs_total = 900;

  const fifoAllocations = [
    {
      batchId: 'batch-1790539492405-1-3AT6',
      quantity: 1,
      unitCost: 500,
    },
    {
      batchId: 'batch-po-po-1790539505468-1-NEL0-prod-1789591848585-909-1790539507197-734520',
      quantity: 1,
      unitCost: 400,
    }
  ];

  if (Array.isArray(txnPayload.items) && txnPayload.items[0]) {
    txnPayload.items[0].unitCostAtSale = 450;
    txnPayload.items[0].unit_cost_at_sale = 450;
    txnPayload.items[0].unitCostPrice = 450;
    txnPayload.items[0].lineProfit = 6100;
    txnPayload.items[0].line_profit = 6100;
    txnPayload.items[0].fifo_allocations = fifoAllocations;
  }

  const updatedTxnPayloadStr = JSON.stringify(txnPayload);
  const newTxnVersion = (Number(txn.version) || 1) + 1;

  db.prepare(`
    UPDATE transactions
    SET cost_total = 900,
        profit = 6100,
        profit_margin = 87.1,
        ledger_cogs_total = 900,
        json_payload = ?,
        version = ?,
        updated_at = ?,
        sync_status = 'pending'
    WHERE id = ?
  `).run(updatedTxnPayloadStr, newTxnVersion, now, targetTxId);
  console.log('Updated transactions row to cost_total = 900, profit = 6100, ledger_cogs_total = 900');

  // 3. Update transaction_items
  const items = db.prepare("SELECT * FROM transaction_items WHERE transaction_id = ?").all(targetTxId);
  for (const item of items) {
    let itemPayload = {};
    try {
      itemPayload = JSON.parse(item.json_payload || '{}');
    } catch {}
    itemPayload.unit_cost_at_sale = 450;
    itemPayload.unitCostAtSale = 450;
    itemPayload.unitCostPrice = 450;
    itemPayload.line_profit = 6100;
    itemPayload.lineProfit = 6100;
    itemPayload.fifo_allocations = fifoAllocations;

    const updatedItemPayloadStr = JSON.stringify(itemPayload);
    const newItemVersion = (Number(item.version) || 1) + 1;

    db.prepare(`
      UPDATE transaction_items
      SET unit_cost_at_sale = 450,
          line_profit = 6100,
          json_payload = ?,
          version = ?,
          updated_at = ?,
          sync_status = 'pending'
      WHERE id = ?
    `).run(updatedItemPayloadStr, newItemVersion, now, item.id);
    console.log('Updated transaction_items row', item.id, 'to unit_cost_at_sale = 450, line_profit = 6100');

    // sync_outbox for order_item
    const itemKey = item.idempotency_key || `repair-${item.id}`;
    db.prepare(`
      INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
      VALUES (?, 'order_item', ?, 'UPSERT', ?, 'pending')
      ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=?
    `).run(itemKey, item.id, updatedItemPayloadStr, now);
  }

  // 4. Update sync_outbox for order
  const orderKey = txn.idempotency_key || `order-${targetTxId}`;
  db.prepare(`
    INSERT INTO sync_outbox (idempotency_key, entity_type, entity_id, operation, payload_json, status)
    VALUES (?, 'order', ?, 'UPSERT', ?, 'pending')
    ON CONFLICT(idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, status='pending', updated_at=?
  `).run(orderKey, targetTxId, updatedTxnPayloadStr, now);

  // 5. Update sale_batch_allocations
  db.prepare("DELETE FROM sale_batch_allocations WHERE sale_id = ?").run(targetTxId);
  const alloc1Id = `alloc-${targetTxId}-0-batch-1790539492405-1-3AT6`;
  const alloc2Id = `alloc-${targetTxId}-0-batch-po-po-1790539505468-1-NEL0-prod-1789591848585-909-1790539507197-734520`;
  const itemId = `${targetTxId}-item-0`;
  const devId = txn.device_id || 'ec645423-3d41-4a07-83e7-1f88b817082f';

  const insertAlloc = db.prepare(`
    INSERT INTO sale_batch_allocations (
      id, sale_id, batch_id, qty_consumed, unit_cost_at_sale,
      created_at, product_id, sale_item_id, device_id,
      idempotency_key, sync_status, version, updated_at, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, 0)
  `);

  insertAlloc.run(alloc1Id, targetTxId, 'batch-1790539492405-1-3AT6', 1, 500, '2026-09-27T20:06:28.838Z', 'prod-1789591848585-909', itemId, devId, alloc1Id, now);
  insertAlloc.run(alloc2Id, targetTxId, 'batch-po-po-1790539505468-1-NEL0-prod-1789591848585-909-1790539507197-734520', 1, 400, '2026-09-27T20:06:28.838Z', 'prod-1789591848585-909', itemId, devId, alloc2Id, now);
  console.log('Inserted 2 sale_batch_allocations (1 @ 500 DA, 1 @ 400 DA)');

  // 6. Update stock_batches costs and tombstone shadow batch
  db.prepare(`
    UPDATE stock_batches
    SET unit_cost = 500, version = version + 1, updated_at = ?, sync_status = 'pending'
    WHERE batch_id = 'batch-1790539492405-1-3AT6'
  `).run(now);

  db.prepare(`
    UPDATE stock_batches
    SET unit_cost = 400, version = version + 1, updated_at = ?, sync_status = 'pending'
    WHERE batch_id = 'batch-po-po-1790539505468-1-NEL0-prod-1789591848585-909-1790539507197-734520'
  `).run(now);

  db.prepare(`
    UPDATE stock_batches
    SET deleted = 1, shadow_resolved = 1, version = version + 1, updated_at = ?, sync_status = 'pending'
    WHERE batch_id = 'shadow-TXN-1790539512575-1-7EDW-0'
  `).run(now);
  console.log('Restored unit_cost on stock_batches and resolved shadow batch');

  db.exec('COMMIT;');
  console.log('--- Successfully committed transaction for ticket', targetReceipt, '---');
} catch (e) {
  db.exec('ROLLBACK;');
  console.error('Failed to patch ticket, rolled back:', e);
  process.exit(1);
}
