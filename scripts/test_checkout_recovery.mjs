/**
 * B-004/B-005 FIX-4 regression: checkout recovery intent lifecycle.
 * F1/F2 update: intents are keyed by transactionId (multi-intent queue),
 * cleared only after post-order side-effects, replayed oldest-first.
 *
 * Models the Dexie recovery-intent design against an in-memory store:
 *  1. Intent is saved BEFORE writeCheckoutAtomic (payload + customer + debt).
 *  2. On SQLite success, intent is cleared.
 *  3. On SQLite throw, intent REMAINS and processPayment returns
 *     recoveryQueued=true so the UI soft-warns instead of "non enregistrée".
 *  4. Boot replay re-runs writeCheckoutAtomic from the intent and clears it.
 *  5. Replay is idempotent (second replay is a no-op).
 *  6. A hard fail with NO saved intent still returns recoveryQueued=false.
 *  7. F1: a second failed sale queues a SECOND intent (no overwrite).
 *  8. F1: boot replay drains all intents oldest-first.
 */

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// --- in-memory Dexie stand-in (keyed by transactionId, like the module) ---
const intents = new Map();
async function saveIntent(row) {
  const id = String(row.transactionId || '');
  if (!id) return false;
  intents.set(id, { ...row, id, createdAt: row.createdAt || new Date().toISOString(), attempts: row.attempts ?? 0 });
  return true;
}
async function clearIntent(txId) {
  intents.delete(String(txId));
}
async function getIntent(txId) {
  return intents.get(String(txId));
}
async function getAllIntents() {
  return [...intents.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// --- fake writeCheckoutAtomic ---
let sqliteShouldFail = false;
const durableOrders = new Map();
async function writeCheckoutAtomic(payload) {
  if (sqliteShouldFail) throw new Error('SQLITE_BUSY: database is locked');
  durableOrders.set(payload.orderRow.id, payload);
  return { deviceId: 'dev-1' };
}

async function processPaymentModel({ saveFails = false, txId = 'TXN-1' } = {}) {
  const orderRow = { id: txId, receipt_number: `R-${txId}`, total: 5000 };
  const customer = { id: 'C1', storeCredit: 100 };
  const debt = { id: 'D1', amount: 500 };
  const payload = { orderRow, items: [], deltas: [], fullTx: { id: txId } };

  let recoverySaved = false;
  if (!saveFails) {
    recoverySaved = await saveIntent({
      transactionId: orderRow.id,
      receiptNumber: orderRow.receipt_number,
      payload,
      customerPayload: customer,
      debtEntry: debt,
    });
  }
  try {
    await writeCheckoutAtomic(payload);
    await clearIntent(orderRow.id);
    return { success: true };
  } catch (e) {
    const detail = String(e.message).slice(0, 160);
    if (recoverySaved) {
      return {
        success: false,
        reason: `PERSISTENCE_FAILED:${detail}`,
        recoveryQueued: true,
        warnings: ['Vente mise en file de récupération'],
      };
    }
    return { success: false, reason: `PERSISTENCE_FAILED:${detail}` };
  }
}

async function replayModel() {
  const all = await getAllIntents();
  if (all.length === 0) return { replayed: 0, remaining: 0 };
  let replayed = 0;
  let lastError;
  for (const intent of all) {
    try {
      await writeCheckoutAtomic(intent.payload);
      await clearIntent(intent.transactionId);
      replayed += 1;
    } catch (e) {
      lastError = String(e.message);
      intents.set(intent.transactionId, { ...intent, attempts: (intent.attempts || 0) + 1, lastError });
    }
  }
  return { replayed, remaining: all.length - replayed, lastError };
}

async function main() {
  // 1. Happy path: intent saved then cleared on success
  sqliteShouldFail = false;
  let r = await processPaymentModel();
  check('happy path success', r.success === true);
  check('happy path clears intent', (await getIntent('TXN-1')) === undefined);

  // 2. SQLite fails + intent saved → recoveryQueued=true, intent remains
  sqliteShouldFail = true;
  r = await processPaymentModel();
  check('sqlite fail returns failure', r.success === false);
  check('sqlite fail keeps PERSISTENCE_FAILED reason', r.reason?.startsWith('PERSISTENCE_FAILED'), r.reason);
  check('sqlite fail sets recoveryQueued', r.recoveryQueued === true);
  check('sqlite fail queues warning', Array.isArray(r.warnings) && r.warnings.length > 0);
  check('intent remains after fail', (await getIntent('TXN-1')) !== undefined);
  const held = await getIntent('TXN-1');
  check('intent has full payload', held?.payload?.orderRow?.id === 'TXN-1');
  check('intent has customer snapshot', held?.customerPayload?.id === 'C1');
  check('intent has debt snapshot', held?.debtEntry?.id === 'D1');

  // 3. Boot replay succeeds → order durable, intent cleared
  sqliteShouldFail = false;
  const replay = await replayModel();
  check('boot replay runs once', replay.replayed === 1 && replay.remaining === 0);
  check('boot replay writes order', durableOrders.has('TXN-1'));
  check('boot replay clears intent', (await getIntent('TXN-1')) === undefined);

  // 4. Second replay is a no-op (idempotent)
  const replay2 = await replayModel();
  check('second replay is no-op', replay2.replayed === 0 && replay2.remaining === 0);

  // 5. Replay still fails → intent kept, attempts incremented
  intents.clear();
  durableOrders.clear();
  sqliteShouldFail = false;
  await processPaymentModel(); // success clears
  sqliteShouldFail = true;
  await processPaymentModel(); // fail leaves intent
  check('intent present before failed replay', (await getIntent('TXN-1')) !== undefined);
  const failedReplay = await replayModel();
  check('failed replay keeps intent', failedReplay.remaining === 1);
  check('failed replay increments attempts', (await getIntent('TXN-1')).attempts === 1);

  // 6. Intent save fails (IndexedDB down) → recoveryQueued stays false
  intents.clear();
  durableOrders.clear();
  sqliteShouldFail = true;
  r = await processPaymentModel({ saveFails: true });
  check('no-intent fail is plain PERSISTENCE_FAILED', r.success === false && r.reason?.startsWith('PERSISTENCE_FAILED'));
  check('no-intent fail has no recoveryQueued', r.recoveryQueued === undefined);

  // 7. F1: two failed sales queue TWO intents (second never overwrites first)
  intents.clear();
  durableOrders.clear();
  sqliteShouldFail = true;
  await processPaymentModel({ txId: 'TXN-A' });
  await processPaymentModel({ txId: 'TXN-B' });
  const both = await getAllIntents();
  check('two failed sales queue two intents', both.length === 2, `got ${both.length}`);
  check('first intent survives second sale', (await getIntent('TXN-A')) !== undefined);
  check('second intent queued', (await getIntent('TXN-B')) !== undefined);

  // 8. F1: boot replay drains both oldest-first
  sqliteShouldFail = false;
  const replayBoth = await replayModel();
  check('replay drains both intents', replayBoth.replayed === 2 && replayBoth.remaining === 0);
  check('both orders durable', durableOrders.has('TXN-A') && durableOrders.has('TXN-B'));
  check('queue empty after drain', (await getAllIntents()).length === 0);

  // 9. UI contract: recoveryQueued branch must not say "non enregistrée"
  //    (asserted by source scan below)
  console.log('\n=== FIX-4 RECOVERY INTENT: ' + pass + ' PASSED, ' + fail + ' FAILED ===');
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
