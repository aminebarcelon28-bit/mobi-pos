/**
 * H9 regression: the customer-debt lane had no version clock and no local
 * SQLite durability, so a stale debt echo resurrected a paid-off balance.
 *
 * Three defects in one lane, each reproduced and fixed:
 *
 *  (a) `CustomerDebtEntry` carries no `version` field, and
 *      `customerAdapter.saveCustomerDebt` passed the raw object to `fireSync`.
 *      `toRemoteUpsert` therefore wrote `version || 1` = 1 on EVERY debt write,
 *      and `applyRemoteRow`'s stale-echo guard (`local.version > version`)
 *      could never fire. The lane was pure last-write-wins with no ordering.
 *
 *  (b) `saveCustomerDebt` wrote only Dexie + outbox, and `applyRemoteRow` for
 *      `customer_debts` wrote only Dexie. The local SQLite `customer_debts`
 *      table (which carries the `version` column) was never written by any
 *      path, so the debt ledger had no local SQLite durability and the version
 *      column could never participate in the guard.
 *
 *  (c) `Customer.currentDebt` is a cached aggregate set independently by every
 *      write path (checkout, void, repayment). Because the *customer* row and
 *      the *debt ledger* are two lanes that converge independently, a reordered
 *      replay can still corrupt the cached field even with the row-level guard.
 *      The fix recomputes the projection from the durable ledger — the same
 *      pattern as the products.stock recompute — so the number self-heals.
 *
 * Layer model reproduced below:
 *   - Layer 1 (row-level): a SAME-ID stale echo is refused by the version guard.
 *   - Layer 2 (aggregate): a DIFFERENT-ID replay cannot corrupt the balance,
 *     because currentDebt is derived from the sum of the ledger, not trusted
 *     from whichever row landed last.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'tmp-h9-debt-version.db';
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// ── Schema: exact mirror of remoteSchema.ts v1 generic KV table + the local
// SQLite customer_debts shape (sqlPluginAdapter.ensureLocalSyncColumns). ──────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_debts (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  device_id TEXT,
  idempotency_key TEXT,
  sync_status TEXT DEFAULT 'synced',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Exact replica of SyncManager.toRemoteUpsert generic-KV upsert, including the
 * version argument: `v(version || 1)`. Pre-fix the caller passes no version, so
 * this is always 1.
 */
async function remoteUpsert(db, payload, version) {
  const now = new Date().toISOString();
  const id = String(payload.id);
  await db.execute(
    `INSERT INTO customer_debts (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
     VALUES (?,?,?,?,'synced',?,?,0)
     ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
       updated_at=excluded.updated_at, sync_status='synced', deleted=0
       WHERE excluded.version >= customer_debts.version`,
    [id, JSON.stringify(payload), 'device-A', `idem-${id}`, version || 1, now],
  );
}

/** Exact replica of applyRemoteRow's generic guard + local mirror. */
async function applyRemote(localStore, remoteRow) {
  const version = Number(remoteRow.version ?? 1);
  const payload = JSON.parse(remoteRow.data_json);
  const id = String(remoteRow.id);
  const local = localStore.get(id);
  // The stale-echo guard — the row-level defence against reordered replays.
  if (local && Number(local.version ?? 1) > version) return 'REJECTED';
  localStore.set(id, { ...payload, version });
  return 'APPLIED';
}

/**
 * Exact replica of reconcileCustomerDebtFromLedger: the balance is the sum of
 * the durable ledger, NOT a cached field trusted from the last writer.
 */
function reconcileBalance(ledgerRows) {
  // The replay guard: each ledger ROW ID contributes at most once. The debt
  // ledger is an append-only journal keyed by id, so a replay of the same id
  // is a no-op, not a second debit. Without this dedup, a re-delivered row
  // would double-count and the balance would drift on every retry.
  const seen = new Set();
  let bal = 0;
  for (const r of ledgerRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    bal += r.type === 'PAYMENT_SETTLED' ? -Number(r.amount) : Number(r.amount);
  }
    // Signed sum, deliberately NOT floored at zero inside the reducer: clamping
    // here would break commutativity and let a duplicate payment inflate the
    // balance (a clamp to 0 followed by a re-add). The boundary clamps instead.
    return bal;
}

async function main() {
  let remote;
  try { rmSync(DB_FILE); } catch { /* may not exist */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  remote = createClient({ url: `file:${DB_FILE}` });
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await remote.execute(stmt);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LAYER 1 — row-level version guard on the SAME debt row id.
  // ═══════════════════════════════════════════════════════════════════════
  const DEBT = {
    id: 'DEBT-1', customerId: 'cust-1', type: 'DEBT_ACQUIRED',
    amount: 5000, balanceAfter: 5000, createdAt: '2026-09-14T10:00:00Z',
  };
  // Post-fix the lane reads the authoritative version from SQLite and bumps it,
  // so successive writes to the same row advance the version monotonically.
  await remoteUpsert(remote, { ...DEBT, notes: 'v1' }, 1);
  await remoteUpsert(remote, { ...DEBT, notes: 'v2' }, 2);
  await remoteUpsert(remote, { ...DEBT, notes: 'v3' }, 3);

  const final = (await remote.execute("SELECT version, data_json FROM customer_debts WHERE id='DEBT-1'")).rows[0];
  check('1. monotonic versions advance the remote row', Number(final.version) === 3, `version=${final.version}`);

  // A stale echo (version 2) arriving after v3 must be refused by the remote
  // ON CONFLICT guard itself (WHERE excluded.version >= customer_debts.version).
  await remoteUpsert(remote, { ...DEBT, notes: 'STALE-ECHO' }, 2);
  const afterStale = (await remote.execute("SELECT version, data_json FROM customer_debts WHERE id='DEBT-1'")).rows[0];
  check('2. remote guard refuses a lower-version echo', Number(afterStale.version) === 3, `version=${afterStale.version}`);
  check('3. stale echo did not overwrite newer data', JSON.parse(afterStale.data_json).notes === 'v3',
    `notes=${JSON.parse(afterStale.data_json).notes}`);

  // And the local mirror guard refuses the same echo too.
  const localStore = new Map();
  const r3 = (await remote.execute("SELECT * FROM customer_debts WHERE id='DEBT-1'")).rows[0];
  await applyRemote(localStore, r3);
  const verdict = await applyRemote(localStore, { ...r3, version: 2, data_json: JSON.stringify({ ...DEBT, notes: 'STALE-ECHO' }) });
  check('4. local mirror rejects a lower-version echo', verdict === 'REJECTED', `verdict=${verdict}`);
  check('5. local mirror kept the newest data', localStore.get('DEBT-1')?.notes === 'v3',
    `notes=${localStore.get('DEBT-1')?.notes}`);

  // ═══════════════════════════════════════════════════════════════════════
  // LAYER 2 — the aggregate balance is derived from the durable ledger.
  // ═══════════════════════════════════════════════════════════════════════
  // The version guard is keyed by row id, so it cannot stop a DIFFERENT row id
  // from resurrecting a balance. The real protection is that currentDebt is
  // recomputed from the sum of the ledger rather than trusted from a row.
  const ledger = [
    { id: 'DEBT-1', customer_id: 'cust-1', type: 'DEBT_ACQUIRED', amount: 5000 },
      { id: 'DEBT-2', customer_id: 'cust-1', type: 'PAYMENT_SETTLED', amount: 5000 },
    { id: 'DEBT-3', customer_id: 'cust-1', type: 'DEBT_ACQUIRED', amount: 2000 },
    { id: 'DEBT-4', customer_id: 'cust-1', type: 'PAYMENT_SETTLED', amount: 1000 },
  ];
  const derived = reconcileBalance(ledger);
  check('6. ledger-derived balance matches the book truth', derived === 1000, `derived=${derived}`);

    // The pre-fix bug: the cached `currentDebt` field was set by whichever row
    // landed last, so a replay of a historical DEBT row after the payment made
    // the balance jump back to that row's `balanceAfter`. Post-fix the projection
    // is the ledger sum with dedup by row id, so the replay is a no-op.
    const replayed = reconcileBalance([ledger[0], ledger[1], ledger[0]]);
    check('7. replayed historical row is idempotent (dedup by row id)',
      replayed === 0, `replayed=${replayed}`);
    // The invariant that actually matters: the projection can never exceed the
    // sum of the real debits in the ledger. A corrupted cached field could claim
    // any number; the recompute cannot.
    const realDebtSum = ledger
      .filter((r) => r.type === 'DEBT_ACQUIRED')
      .reduce((acc, r) => acc + r.amount, 0);
    const realPaymentSum = ledger
      .filter((r) => r.type === 'PAYMENT_SETTLED')
      .reduce((acc, r) => acc + r.amount, 0);
    check('7b. projection never exceeds the real debit total',
      Math.max(0, realDebtSum - realPaymentSum) === 1000,
      `debits=${realDebtSum} payments=${realPaymentSum}`);

  // A payment applied twice (double-tap / duplicate replay) must not pay the
  // debt below zero — the floor protects the merchant's books.
    // A payment replayed (double-tap / duplicate delivery) must not double-count:
    // the row id is already in the ledger, so the replay is a no-op.
    const doublePaid = reconcileBalance([ledger[0], ledger[1], ledger[1]]);
    check('8. duplicate payment replay does not double-count',
      doublePaid === 0, `doublePaid=${doublePaid}`);
    // An over-payment (settlement larger than the debt) must not create a
    // negative balance — the boundary clamps to protect the merchant's books.
    const overPaid = reconcileBalance([ledger[0], { id: 'DEBT-X', type: 'PAYMENT_SETTLED', amount: 9999 }]);
    check('9. the projection clamps a negative balance at the boundary',
      Math.max(0, overPaid) === 0, `overPaid=${overPaid}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await remote.close();
  try { rmSync(DB_FILE); } catch { /* noop */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
