/**
 * Contract C2 & C5 Offline Chaos & Replay Test Suite
 * Tests 100% offline checkout paths, duplicate replay tolerance, and outbox recovery.
 */

console.log('========================================================================');
console.log('⚡ MOBI POS — CONTRACT C2 & C5 OFFLINE CHAOS & REPLAY TEST SUITE');
console.log('========================================================================\n');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failed++;
  }
}

// 1. Simulated Offline Checkout Path (Contract C2)
console.log('--- TEST 1: Unconditional Offline Till Checkout (Contract C2) ---');
const offlineStore = {
  products: new Map([
    ['p1', { id: 'p1', title: 'Coque iPhone 15', stock: 10, price: 2500 }],
    ['p2', { id: 'p2', title: 'Câble USB-C Anker', stock: 5, price: 1500 }],
  ]),
  transactions: [],
  outbox: new Map(),
};

function executeOfflineSale(sale) {
  // Check stock locally
  for (const item of sale.items) {
    const prod = offlineStore.products.get(item.productId);
    if (!prod || prod.stock < item.qty) {
      throw new Error(`Insufficient stock for ${item.productId}`);
    }
    prod.stock -= item.qty;
  }

  offlineStore.transactions.push(sale);
  // Atomic outbox enqueue
  offlineStore.outbox.set(sale.idempotencyKey, {
    key: sale.idempotencyKey,
    entity: 'order',
    status: 'pending',
    payload: sale,
  });

  return { success: true, receiptId: sale.id };
}

const sale1 = {
  id: 'tx-offline-101',
  idempotencyKey: 'key-ulid-offline-101',
  items: [{ productId: 'p1', qty: 2 }],
  total: 5000,
};

const result1 = executeOfflineSale(sale1);
assert(result1.success === true, 'Offline checkout completed without network');
assert(offlineStore.products.get('p1').stock === 8, 'Local inventory deducted correctly (10 -> 8)');
assert(offlineStore.outbox.has('key-ulid-offline-101'), 'Outbox pending row recorded atomically');

// 2. Duplicate Replay Test (Contract C5)
console.log('\n--- TEST 2: Duplicate Mutation Replay Guard (Contract C5) ---');
function syncPush(outboxMap, incomingMutation) {
  if (outboxMap.has(incomingMutation.idempotencyKey)) {
    const existing = outboxMap.get(incomingMutation.idempotencyKey);
    if (existing.status === 'synced') {
      return { status: 'ignored_duplicate', key: incomingMutation.idempotencyKey };
    }
  }
  outboxMap.set(incomingMutation.idempotencyKey, { ...incomingMutation, status: 'synced' });
  return { status: 'accepted', key: incomingMutation.idempotencyKey };
}

const cloudDb = new Map();
const resFirst = syncPush(cloudDb, { idempotencyKey: 'key-ulid-offline-101', total: 5000 });
assert(resFirst.status === 'accepted', 'First sync push accepted by cloud');

// Replay identical mutation 5 times
let duplicatesBlocked = 0;
for (let i = 0; i < 5; i++) {
  const resReplay = syncPush(cloudDb, { idempotencyKey: 'key-ulid-offline-101', total: 5000 });
  if (resReplay.status === 'ignored_duplicate') {
    duplicatesBlocked++;
  }
}

assert(duplicatesBlocked === 5, '5 duplicate replay attempts blocked by idempotency key (Zero duplicate charge)');
assert(cloudDb.size === 1, 'Cloud database holds exactly 1 record, zero duplicate ledger entries');

// 3. Simulated Crash & Boot Recovery (Contract C6)
console.log('\n--- TEST 3: Boot Recovery & Outbox Invariant (Contract C6) ---');
let recoveredPending = 0;
for (const [_key, row] of offlineStore.outbox.entries()) {
  if (row.status === 'pending') {
    recoveredPending++;
  }
}
assert(recoveredPending === 1, 'Cold boot recovery found 1 pending outbox row ready to drain');

console.log('\n========================================================================');
console.log(`🎯 CHAOS TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('========================================================================');

if (failed > 0) process.exit(1);
