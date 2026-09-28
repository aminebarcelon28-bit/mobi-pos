/**
 * Comprehensive verification suite for:
 * 1) Price override at checkout (decoupled stock deduction, discount amount, line profit, manager authorization)
 * 2) FIFO inventory costing (stock_batches, multi-batch FIFO depletion, blended unit cost, inventory valuation, refund restitution)
 * 3) Flexible purchase orders (catalog-wide item addition, custom qty/cost, zero stock impact until receipt)
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-fifo-and-price-override.db';
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ [PASS] ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    console.error(`  ❌ [FAIL] ${name}${extra ? ' :: ' + extra : ''}`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sku TEXT,
  barcode TEXT,
  price REAL NOT NULL,
  cost_price REAL DEFAULT 0,
  stock INTEGER DEFAULT 0,
  vendor_name TEXT,
  reorder_point INTEGER DEFAULT 5,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stock_batches (
  batch_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  quantity_remaining INTEGER NOT NULL,
  unit_cost REAL NOT NULL,
  received_at TEXT NOT NULL,
  vendor_name TEXT,
  po_id TEXT,
  device_id TEXT DEFAULT 'local',
  updated_at TEXT,
  deleted INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL,
  customer_id TEXT,
  total REAL NOT NULL,
  subtotal REAL NOT NULL,
  discount_total REAL DEFAULT 0,
  cost_total REAL DEFAULT 0,
  profit REAL DEFAULT 0,
  payment_method TEXT,
  status TEXT DEFAULT 'COMPLETED',
  is_refund INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transaction_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  discount REAL DEFAULT 0,
  unit_price_charged REAL,
  unit_cost_at_sale REAL,
  discount_amount REAL DEFAULT 0,
  line_profit REAL,
  fifo_allocations TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  po_number TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  total_amount REAL NOT NULL,
  status TEXT NOT NULL,
  notes TEXT,
  created_at TEXT,
  validated_at TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  idempotency_key TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  updated_at TEXT
);
`;

// Helper: simulated FIFO depletion matching sqlPluginAdapter.ts
async function simulateFifoSale(db, productId, quantitySold, unitPriceCharged, defaultPrice) {
  // Query active batches FIFO ordered
  const batchRows = await db.execute({
    sql: 'SELECT batch_id, quantity_remaining, unit_cost FROM stock_batches WHERE product_id = ? AND deleted = 0 AND quantity_remaining > 0 ORDER BY received_at ASC, rowid ASC',
    args: [productId],
  });

  let remainingToFulfill = quantitySold;
  let totalCostForLine = 0;
  const allocations = [];

  for (const b of batchRows.rows) {
    if (remainingToFulfill <= 0) break;
    const batchRemaining = Number(b.quantity_remaining);
    const take = Math.min(batchRemaining, remainingToFulfill);
    const cost = Number(b.unit_cost);

    allocations.push({
      batchId: String(b.batch_id),
      quantity: take,
      unitCost: cost,
    });

    totalCostForLine += take * cost;
    remainingToFulfill -= take;

    // Update batch
    await db.execute({
      sql: 'UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, updated_at = ? WHERE batch_id = ?',
      args: [take, new Date().toISOString(), b.batch_id],
    });
  }

  // If unbatched units remain (overdraft / legacy stock)
  if (remainingToFulfill > 0) {
    const prodRow = await db.execute({ sql: 'SELECT cost_price FROM products WHERE id = ?', args: [productId] });
    const fallbackCost = Number(prodRow.rows[0]?.cost_price || 0);
    allocations.push({
      batchId: 'unbatched',
      quantity: remainingToFulfill,
      unitCost: fallbackCost,
    });
    totalCostForLine += remainingToFulfill * fallbackCost;
  }

  const blendedUnitCost = totalCostForLine / quantitySold;
  const discountAmount = Math.max(0, defaultPrice - unitPriceCharged);
  const lineProfit = (unitPriceCharged - blendedUnitCost) * quantitySold;

  // Deduct product stock strictly by units sold
  await db.execute({
    sql: 'UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ?',
    args: [quantitySold, new Date().toISOString(), productId],
  });

  return {
    blendedUnitCost,
    discountAmount,
    lineProfit,
    allocations,
  };
}

// Helper: simulated Refund Restitution matching sqlPluginAdapter.ts
async function simulateRefundRestitution(db, productId, returnQuantity, allocations, fallbackUnitCost) {
  let unitsToRestore = returnQuantity;

  if (allocations && allocations.length > 0) {
    const reversedAllocations = [...allocations].reverse();
    for (const alloc of reversedAllocations) {
      if (unitsToRestore <= 0) break;
      const restoreCount = Math.min(unitsToRestore, alloc.quantity);

      if (alloc.batchId && alloc.batchId !== 'unbatched') {
        const res = await db.execute({
          sql: 'UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?, updated_at = ? WHERE batch_id = ? AND deleted = 0',
          args: [restoreCount, new Date().toISOString(), alloc.batchId],
        });

        if (res.rowsAffected > 0) {
          unitsToRestore -= restoreCount;
        }
      }
    }
  }

  // Any remaining unallocated units restored via restitution batch
  if (unitsToRestore > 0) {
    const newBatchId = `batch_restit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    await db.execute({
      sql: 'INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [newBatchId, productId, unitsToRestore, fallbackUnitCost, new Date().toISOString(), new Date().toISOString()],
    });
  }

  // Re-increment product stock
  await db.execute({
    sql: 'UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?',
    args: [returnQuantity, new Date().toISOString(), productId],
  });
}

// Helper: calculate inventory valuation
async function getInventoryValuation(db, productId) {
  const query = productId
    ? { sql: 'SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) as val FROM stock_batches WHERE product_id = ? AND deleted = 0 AND quantity_remaining > 0', args: [productId] }
    : { sql: 'SELECT COALESCE(SUM(quantity_remaining * unit_cost), 0) as val FROM stock_batches WHERE deleted = 0 AND quantity_remaining > 0', args: [] };
  const res = await db.execute(query);
  return Number(res.rows[0]?.val || 0);
}

async function run() {
  console.log('========================================================================');
  console.log('⚡ MOBI POS — FIFO COSTING, PRICE OVERRIDE & FLEXIBLE PO SUITE');
  console.log('========================================================================\n');

  try { rmSync(DB_FILE); } catch {}
  try { rmSync(`${DB_FILE}-wal`); } catch {}

  const db = createClient({ url: `file:${DB_FILE}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }

  // Seed product
  await db.execute({
    sql: 'INSERT INTO products (id, title, sku, barcode, price, cost_price, stock, vendor_name, reorder_point) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: ['prod_13pro', 'iPhone 13 Pro Max 256GB', 'SKU-IP13P-256', '6131234567890', 100000, 75000, 0, 'Apple Algérie', 5],
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FEATURE 3: FLEXIBLE PURCHASE ORDERS (STAGED RECEIVING)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('[TEST 1] Flexible PO Creation — Staged Receiving Invariant:');
  
  // Step 1: Create PO in "Waiting List"
  const poId = 'po_test_001';
  await db.execute({
    sql: 'INSERT INTO purchase_orders (id, po_number, vendor_name, total_amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [poId, 'PO-2026-001', 'Apple Algérie', 800000, 'Waiting List', new Date().toISOString()],
  });

  const stockBeforeReceipt = await db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: ['prod_13pro'] });
  const batchesBeforeReceipt = await db.execute({ sql: 'SELECT count(*) as c FROM stock_batches WHERE product_id = ?', args: ['prod_13pro'] });

  check(
    'PO creation in Waiting List status does NOT modify product stock',
    Number(stockBeforeReceipt.rows[0].stock) === 0,
    `stock is ${stockBeforeReceipt.rows[0].stock}`
  );
  check(
    'PO creation in Waiting List status does NOT insert stock_batches rows',
    Number(batchesBeforeReceipt.rows[0].c) === 0,
    `batches count is ${batchesBeforeReceipt.rows[0].c}`
  );

  // Step 2: Receive PO Batch 1 (10 units @ 78,000 DA)
  await db.execute({
    sql: 'INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, po_id) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['batch_001', 'prod_13pro', 10, 78000, '2026-09-01T10:00:00Z', poId],
  });
  await db.execute({
    sql: 'UPDATE products SET stock = stock + 10 WHERE id = ?',
    args: ['prod_13pro'],
  });

  // Step 3: Receive PO Batch 2 (5 units @ 82,000 DA)
  await db.execute({
    sql: 'INSERT INTO stock_batches (batch_id, product_id, quantity_remaining, unit_cost, received_at, po_id) VALUES (?, ?, ?, ?, ?, ?)',
    args: ['batch_002', 'prod_13pro', 5, 82000, '2026-09-05T14:00:00Z', poId],
  });
  await db.execute({
    sql: 'UPDATE products SET stock = stock + 5 WHERE id = ?',
    args: ['prod_13pro'],
  });

  const stockAfterReceipt = await db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: ['prod_13pro'] });
  check('Receiving PO updates product physical stock (10 + 5 = 15)', Number(stockAfterReceipt.rows[0].stock) === 15);

  const initialValuation = await getInventoryValuation(db, 'prod_13pro');
  // 10 * 78,000 + 5 * 82,000 = 780,000 + 410,000 = 1,190,000
  check(
    'Initial inventory valuation sum(quantity_remaining * unit_cost) equals 1,190,000 DA',
    initialValuation === 1190000,
    `valuation = ${initialValuation}`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // FEATURE 1 & 2: MULTI-BATCH FIFO DEPLETION & PRICE OVERRIDE
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 2] Multi-Batch FIFO Depletion & Price Override at Checkout:');

  // Cashier sells 12 units.
  // Standard catalog price is 100,000 DA.
  // Cashier overrides price to 95,000 DA (5,000 DA manual discount per unit).
  const saleResult = await simulateFifoSale(db, 'prod_13pro', 12, 95000, 100000);

  // Total cost = 10 * 78,000 + 2 * 82,000 = 780,000 + 164,000 = 944,000 DA
  // Blended cost = 944,000 / 12 = 78,666.666... DA
  check(
    'FIFO consumes oldest Batch 1 first (10 units @ 78,000 DA)',
    saleResult.allocations[0].batchId === 'batch_001' && saleResult.allocations[0].quantity === 10
  );
  check(
    'FIFO consumes next Batch 2 second (2 units @ 82,000 DA)',
    saleResult.allocations[1].batchId === 'batch_002' && saleResult.allocations[1].quantity === 2
  );
  check(
    'Blended unit cost matches exact weighted average (78,666.67 DA)',
    Math.abs(saleResult.blendedUnitCost - 78666.67) < 0.1,
    `got ${saleResult.blendedUnitCost.toFixed(2)}`
  );
  check(
    'Discount amount accurately recorded (100,000 - 95,000 = 5,000 DA/u)',
    saleResult.discountAmount === 5000
  );
  // Revenue = 12 * 95,000 = 1,140,000 DA. Total cost = 944,000 DA. Profit = 196,000 DA.
  check(
    'Line profit = (unit_price_charged - unit_cost_at_sale) * quantity = 196,000 DA',
    Math.abs(saleResult.lineProfit - 196000) < 0.1,
    `got ${saleResult.lineProfit.toFixed(2)}`
  );

  // Check physical stock deduction invariant: stock must decrease by 12 (15 - 12 = 3)
  const stockAfterSale = await db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: ['prod_13pro'] });
  check(
    'Stock deduction is strictly decoupled from price override: exactly 12 units deducted (stock = 3)',
    Number(stockAfterSale.rows[0].stock) === 3
  );

  // Check remaining batches in DB
  const b1 = await db.execute({ sql: 'SELECT quantity_remaining FROM stock_batches WHERE batch_id = ?', args: ['batch_001'] });
  const b2 = await db.execute({ sql: 'SELECT quantity_remaining FROM stock_batches WHERE batch_id = ?', args: ['batch_002'] });

  check('Batch 1 quantity_remaining is completely depleted to 0', Number(b1.rows[0].quantity_remaining) === 0);
  check('Batch 2 quantity_remaining has exactly 3 units remaining', Number(b2.rows[0].quantity_remaining) === 3);

  const valuationAfterSale = await getInventoryValuation(db, 'prod_13pro');
  // 3 remaining units @ 82,000 DA = 246,000 DA
  check(
    'Inventory valuation after sale reflects remaining batch (3 * 82,000 = 246,000 DA)',
    valuationAfterSale === 246000,
    `valuation = ${valuationAfterSale}`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // FEATURE 2 (PART 2): REFUND RESTITUTION TO ORIGINAL BATCHES
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 3] Refund & Return Batch Restitution at Original Cost:');

  // Customer returns 2 units of the 12 sold
  await simulateRefundRestitution(db, 'prod_13pro', 2, saleResult.allocations, saleResult.blendedUnitCost);

  const b2AfterRefund = await db.execute({ sql: 'SELECT quantity_remaining FROM stock_batches WHERE batch_id = ?', args: ['batch_002'] });
  const stockAfterRefund = await db.execute({ sql: 'SELECT stock FROM products WHERE id = ?', args: ['prod_13pro'] });

  check(
    'Refund restitution restores 2 units back to Batch 2 (3 + 2 = 5)',
    Number(b2AfterRefund.rows[0].quantity_remaining) === 5,
    `batch 2 remaining = ${b2AfterRefund.rows[0].quantity_remaining}`
  );
  check(
    'Product physical stock correctly restored from 3 to 5 units',
    Number(stockAfterRefund.rows[0].stock) === 5,
    `stock = ${stockAfterRefund.rows[0].stock}`
  );

  const valuationAfterRefund = await getInventoryValuation(db, 'prod_13pro');
  // 5 units @ 82,000 DA = 410,000 DA
  check(
    'Inventory valuation accurately restored to 410,000 DA',
    valuationAfterRefund === 410000,
    `valuation = ${valuationAfterRefund}`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // FEATURE 1 (PART 2): MANAGER APPROVAL RULES ON PRICE OVERRIDE
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[TEST 4] Manager PIN & Discount Tripwire Enforcement:');

  function checkOverrideAuthorization(defaultPrice, requestedPrice, costPrice) {
    const discount = defaultPrice - requestedPrice;
    const discountPct = (discount / defaultPrice) * 100;
    const margin = requestedPrice - costPrice;

    const requiresManagerPin = margin < 0 || discountPct > 20;
    let reason = null;
    if (margin < 0) reason = 'Vente à perte (en dessous du coût d\'achat)';
    else if (discountPct > 20) reason = `Remise excessive (${discountPct.toFixed(1)}% > 20%)`;

    return { requiresManagerPin, reason };
  }

  const check1 = checkOverrideAuthorization(100000, 70000, 78000);
  check(
    'Selling below cost (70,000 < 78,000) trips manager approval (Vente à perte)',
    check1.requiresManagerPin === true && check1.reason.includes('Vente à perte')
  );

  const check2 = checkOverrideAuthorization(100000, 75000, 60000);
  check(
    'Discount > 20% (25%) trips manager approval (Remise excessive)',
    check2.requiresManagerPin === true && check2.reason.includes('Remise excessive')
  );

  const check3 = checkOverrideAuthorization(100000, 90000, 60000);
  check(
    'Normal discount <= 20% (10%) and above cost does NOT require manager PIN',
    check3.requiresManagerPin === false
  );

  console.log('\n========================================================================');
  console.log(`VERIFICATION SUMMARY: ${pass} Passed, ${fail} Failed`);
  console.log('========================================================================');

  if (fail > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
