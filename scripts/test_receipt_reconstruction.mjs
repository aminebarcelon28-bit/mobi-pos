/**
 * Verification test for receiptNumber and items reconstruction from SQLite relational tables.
 */
import { createClient } from '@libsql/client';
import assert from 'node:assert';

console.log('Testing transaction items & receiptNumber reconstruction logic...');

const client = createClient({ url: ':memory:' });

// Setup local SQLite schema matching sqliteAdapter
await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    cost_price REAL NOT NULL DEFAULT 0,
    category TEXT,
    stock INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    balance REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    receipt_number TEXT,
    date TEXT NOT NULL,
    total REAL NOT NULL,
    discount REAL DEFAULT 0,
    payment_method TEXT NOT NULL,
    cash_tendered REAL DEFAULT 0,
    cash_change REAL DEFAULT 0,
    customer_id TEXT,
    notes TEXT,
    shift_id TEXT,
    cashier_name TEXT,
    status TEXT DEFAULT 'completed',
    json_payload TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transaction_items (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    purchase_price REAL DEFAULT 0,
    subtotal REAL NOT NULL,
    discount REAL DEFAULT 0
  );
`);

// Insert test data
await client.execute(`
  INSERT INTO products (id, name, price, cost_price, category, stock)
  VALUES 
    ('p1', 'iPhone 13 128GB', 95000, 80000, 'Smartphones', 5)
`);
await client.execute(`
  INSERT INTO products (id, name, price, cost_price, category, stock)
  VALUES 
    ('p2', 'Chargeur 20W Apple', 3500, 2000, 'Accessoires', 12)
`);

await client.execute(`
  INSERT INTO customers (id, name, phone, balance)
  VALUES ('c1', 'Karim Benali', '0550123456', 0)
`);

// Insert transaction as it comes from Turso / SQLite restore:
// notice json_payload is minimal/empty or missing items/receiptNumber
await client.execute(`
  INSERT INTO transactions (id, receipt_number, date, total, discount, payment_method, cash_tendered, cash_change, customer_id, cashier_name, status, json_payload)
  VALUES ('tx-001', 'REC-2026-0042', '2026-09-10T14:30:00.000Z', 98500, 0, 'cash', 100000, 1500, 'c1', 'Amine', 'completed', '{}')
`);

await client.execute(`
  INSERT INTO transaction_items (id, transaction_id, product_id, quantity, unit_price, purchase_price, subtotal, discount)
  VALUES 
    ('ti-1', 'tx-001', 'p1', 1, 95000, 80000, 95000, 0)
`);
await client.execute(`
  INSERT INTO transaction_items (id, transaction_id, product_id, quantity, unit_price, purchase_price, subtotal, discount)
  VALUES 
    ('ti-2', 'tx-001', 'p2', 1, 3500, 2000, 3500, 0)
`);

// Now simulate the reconstruction query from src/db/backfill.ts
const txRes = await client.execute(`SELECT * FROM transactions`);
const txRows = txRes.rows;

const itemRes = await client.execute(`
  SELECT ti.*, p.name as product_name, p.category as product_category 
  FROM transaction_items ti
  LEFT JOIN products p ON ti.product_id = p.id
`);
const itemRows = itemRes.rows;

const custRes = await client.execute(`SELECT id, name FROM customers`);
const custRows = custRes.rows;

const custMap = new Map(custRows.map(c => [c.id, c.name]));
const itemsByTx = new Map();
for (const item of itemRows) {
  if (!itemsByTx.has(item.transaction_id)) {
    itemsByTx.set(item.transaction_id, []);
  }
  itemsByTx.get(item.transaction_id).push({
    productId: item.product_id,
    name: item.product_name || 'Article inconnu',
    price: item.unit_price,
    costPrice: item.purchase_price,
    quantity: item.quantity,
    subtotal: item.subtotal,
    discount: item.discount || 0,
    category: item.product_category || 'Général'
  });
}

const reconstructedDexieTransactions = [];
for (const row of txRows) {
  let txDoc = {};
  if (row.json_payload) {
    try {
      txDoc = JSON.parse(row.json_payload);
    } catch {
      txDoc = {};
    }
  }

  const txItems = itemsByTx.get(row.id) || [];
  
  const reconstructed = {
    ...txDoc,
    id: row.id,
    receiptNumber: row.receipt_number || txDoc.receiptNumber || row.id,
    date: row.date || txDoc.date || new Date().toISOString(),
    total: row.total ?? txDoc.total ?? 0,
    discount: row.discount ?? txDoc.discount ?? 0,
    paymentMethod: row.payment_method || txDoc.paymentMethod || 'cash',
    cashTendered: row.cash_tendered ?? txDoc.cashTendered,
    cashChange: row.cash_change ?? txDoc.cashChange,
    customerId: row.customer_id || txDoc.customerId,
    customerName: (row.customer_id ? custMap.get(row.customer_id) : undefined) || txDoc.customerName,
    cashierName: row.cashier_name || txDoc.cashierName || 'Caisse',
    status: row.status || txDoc.status || 'completed',
    items: txItems.length > 0 ? txItems : (txDoc.items || [])
  };

  reconstructedDexieTransactions.push(reconstructed);
}

// Assertions matching ReportsModal UI expectations
const sampleTx = reconstructedDexieTransactions[0];
console.log('Reconstructed Tx:', JSON.stringify(sampleTx, null, 2));

assert.strictEqual(sampleTx.receiptNumber, 'REC-2026-0042', 'Receipt number must match receipt_number from SQLite/Turso');
assert.strictEqual(sampleTx.items.length, 2, 'Must have 2 reconstructed cart items');
assert.strictEqual(sampleTx.customerName, 'Karim Benali', 'Customer name must be populated');

// In ReportsModal.tsx line 1146:
// (t.items || []).reduce((acc, i) => acc + i.quantity, 0)
const articlesCount = (sampleTx.items || []).reduce((acc, i) => acc + i.quantity, 0);
assert.strictEqual(articlesCount, 2, 'Articles count must be 2 (not 0)');

console.log(`\n✅ ALL ASSERTIONS PASSED!`);
console.log(`- Receipt number properly populated: "${sampleTx.receiptNumber}"`);
console.log(`- Articles count: ${articlesCount} articles (was 0 previously)`);
console.log(`- Line items:`);
for (const item of sampleTx.items) {
  console.log(`  * ${item.quantity}x ${item.name} @ ${item.price} DA = ${item.subtotal} DA`);
}
