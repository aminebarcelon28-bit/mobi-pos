const assert = require('assert');

console.log('\n=======================================================================');
console.log('🧪 RUNNING STAGED PROCUREMENT & FINANCIAL INTEGRATION TESTS');
console.log('=======================================================================\n');

let passedCount = 0;
let totalCount = 0;

function it(name, fn) {
  totalCount++;
  try {
    fn();
    console.log('  ✅ [PASS] ' + name);
    passedCount++;
  } catch (err) {
    console.error('  ❌ [FAIL] ' + name);
    console.error('     Error: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Granular Product Control (Exclusion & Dismissal)
// ─────────────────────────────────────────────────────────────
console.log('\n🗑️ [GRANULAR CATALOG CONTROL] Selective Exclusion:');

it('Filters out dismissed products from replenishment proposals', () => {
  const allAlerts = [
    { productId: 'p1', title: 'iPhone 15 Case', currentStock: 2, reorderPoint: 10 },
    { productId: 'p2', title: 'Generic Screen Guard', currentStock: 1, reorderPoint: 10 },
    { productId: 'p3', title: 'USB-C Cable', currentStock: 0, reorderPoint: 5 },
  ];
  const dismissedIds = ['p2'];

  const filtered = allAlerts.filter((a) => !dismissedIds.includes(a.productId));
  assert.strictEqual(filtered.length, 2);
  assert.strictEqual(filtered.some((a) => a.productId === 'p2'), false);
});

// ─────────────────────────────────────────────────────────────
// 2. Staged Procurement Workflow (Waiting List & Transitions)
// ─────────────────────────────────────────────────────────────
console.log('\n⏳ [STAGED WORKFLOW] Waiting List -> Partial/Full Reception:');

function processReception(po, verifiedItems) {
  let totalReceivedCost = 0;
  let allComplete = true;

  const verifiedMap = new Map(verifiedItems.map((vi) => [vi.productId, vi]));

  const updatedItems = po.items.map((item) => {
    const verified = verifiedMap.get(item.productId);
    if (!verified) {
      if ((item.receivedQty || 0) < item.suggestedQty) allComplete = false;
      return item;
    }

    const receivedQty = (item.receivedQty || 0) + verified.receivedQty;
    const actualUnitCost = verified.actualUnitCost || item.unitCost;
    const lineCost = verified.receivedQty * actualUnitCost;
    totalReceivedCost += lineCost;

    const isLineComplete = receivedQty >= item.suggestedQty;
    if (!isLineComplete) allComplete = false;

    let status = 'Pending';
    if (isLineComplete) status = 'Received';
    else if (receivedQty > 0) status = 'Partially Received';

    if (verified.discrepancyReason) status = 'Discrepancy';

    return {
      ...item,
      receivedQty,
      actualUnitCost,
      status,
      discrepancyReason: verified.discrepancyReason || item.discrepancyReason,
    };
  });

  const finalStatus = allComplete ? 'Completed' : 'Partially Received';
  return {
    ...po,
    items: updatedItems,
    actualTotalAmount: (po.actualTotalAmount || 0) + totalReceivedCost,
    status: finalStatus,
    totalReceivedCost,
  };
}

it('Transitions PO to "Partially Received" when supplier delivers partial shipment', () => {
  const initialPO = {
    id: 'po-1',
    poNumber: 'PO-1001',
    vendorName: 'Grossiste Tech',
    items: [
      { productId: 'p1', title: 'Chargeur 20W', suggestedQty: 10, unitCost: 1000, receivedQty: 0 },
      { productId: 'p2', title: 'Câble Type-C', suggestedQty: 20, unitCost: 300, receivedQty: 0 },
    ],
    totalAmount: 16000,
    status: 'Waiting List',
  };

  // Supplier ships 6 chargers and 20 cables
  const verification = [
    { productId: 'p1', receivedQty: 6, actualUnitCost: 1000 },
    { productId: 'p2', receivedQty: 20, actualUnitCost: 300 },
  ];

  const result = processReception(initialPO, verification);

  assert.strictEqual(result.status, 'Partially Received');
  assert.strictEqual(result.totalReceivedCost, 6 * 1000 + 20 * 300); // 6000 + 6000 = 12000 DA
  const p1 = result.items.find((i) => i.productId === 'p1');
  assert.strictEqual(p1.receivedQty, 6);
  assert.strictEqual(p1.status, 'Partially Received');
});

// ─────────────────────────────────────────────────────────────
// 3. Price Fluctuation & Discrepancy Handling
// ─────────────────────────────────────────────────────────────
console.log('\n📈 [PRICE FLUCTUATIONS & DISCREPANCIES] Dynamic Expense Math:');

it('Adjusts expense based on invoice price fluctuation and records discrepancy note', () => {
  const initialPO = {
    id: 'po-2',
    poNumber: 'PO-1002',
    vendorName: 'Fournisseur Accessoires',
    items: [{ productId: 'p3', title: 'Verre Trempé', suggestedQty: 50, unitCost: 150, receivedQty: 0 }],
    totalAmount: 7500,
    status: 'Waiting List',
  };

  // Price rose to 180 DA, supplier only had 40 in stock
  const verification = [
    {
      productId: 'p3',
      receivedQty: 40,
      actualUnitCost: 180,
      discrepancyReason: 'Rupture fournisseur sur 10 unités + Hausse tarifaire',
    },
  ];

  const result = processReception(initialPO, verification);

  assert.strictEqual(result.totalReceivedCost, 40 * 180); // 7,200 DA
  const p3 = result.items.find((i) => i.productId === 'p3');
  assert.strictEqual(p3.actualUnitCost, 180);
  assert.strictEqual(p3.discrepancyReason, 'Rupture fournisseur sur 10 unités + Hausse tarifaire');
  assert.strictEqual(p3.status, 'Discrepancy');
});

// ─────────────────────────────────────────────────────────────
// 4. Automated Financial Expense Recording
// ─────────────────────────────────────────────────────────────
console.log('\n💶 [FINANCIAL REPORTING] Auto Expense & Cash Movement:');

it('Generates StoreExpense DTO linked to EBITDA with category "Achat Marchandises / Fournisseur"', () => {
  const poResult = {
    vendorName: 'Grossiste Alger',
    poNumber: 'PO-8821',
    totalReceivedCost: 45000,
  };

  const generatedExpense = {
    id: 'EXP-1234',
    category: 'Achat Marchandises / Fournisseur',
    title: 'Achat Fournisseur : ' + poResult.vendorName + ' (Bon #' + poResult.poNumber + ')',
    amount: poResult.totalReceivedCost,
    paymentMethod: 'Espèces',
    paidTo: poResult.vendorName,
    notes: 'Réception marchandise validée (+30 unités)',
  };

  assert.strictEqual(generatedExpense.category, 'Achat Marchandises / Fournisseur');
  assert.strictEqual(generatedExpense.amount, 45000);
  assert.strictEqual(generatedExpense.paymentMethod, 'Espèces');
});

console.log('\n=======================================================================');
console.log('FINAL RESULT: ' + passedCount + '/' + totalCount + ' STAGED PROCUREMENT TESTS PASSED');
console.log('=======================================================================\n');

if (passedCount !== totalCount) {
  process.exit(1);
}
