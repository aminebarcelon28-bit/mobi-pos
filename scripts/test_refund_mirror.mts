/**
 * Regression test for cold-review finding N2 (docs/reviews/D4A-third-review.md).
 *
 * The refund commits the wallet leg natively, then mirrors loyalty state from
 * TypeScript. The old mirror saved the whole customer object, so a wallet debit
 * that landed between the native commit and the mirror was overwritten with the
 * stale pre-debit snapshot — the debit vanished (free credit).
 *
 * These tests execute the REAL mirror statements (`src/db/refundMirrorSql.ts`)
 * against a real SQLite database (better-sqlite3) and assert that:
 *   1. a concurrent wallet debit (column + ledger row) survives the mirror;
 *   2. the stale `storeCredit` carried by the caller is never written;
 *   3. re-running the mirror (retry/replay) does not duplicate ledger rows;
 *   4. loyalty state is still mirrored correctly.
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_refund_mirror.mts
 */
import Database from 'better-sqlite3';
import { buildRefundMirrorStatements } from '../src/db/refundMirrorSql.ts';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

interface Row {
  store_credit: number;
  loyalty_points: number;
  total_spent: number;
  version: number;
  json_payload: string;
}

const DEBIT_ID = 'LEDGER-DEBIT-CONCURRENT';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      store_credit REAL NOT NULL DEFAULT 0,
      loyalty_points INTEGER NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      json_payload TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT,
      version INTEGER NOT NULL DEFAULT 1
    );
  `);
  // The row as it looked when the refund read it back: wallet 150, no debit.
  db.prepare(
    `INSERT INTO customers (id, store_credit, loyalty_points, total_spent, json_payload, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'C1',
    150,
    10,
    500,
    JSON.stringify({ id: 'C1', storeCredit: 150, loyaltyPoints: 10, totalSpent: 500, ledger: [] }),
    '2026-10-31T10:00:00Z',
    3,
  );
  return db;
}

/** A wallet debit committed by another terminal AFTER the refund's read-back. */
function concurrentDebit(db: Database.Database): void {
  db.prepare('UPDATE customers SET store_credit = ?, version = version + 1 WHERE id = ?').run(60, 'C1');
  const row = db.prepare('SELECT json_payload FROM customers WHERE id = ?').get('C1') as {
    json_payload: string;
  };
  const payload = JSON.parse(row.json_payload) as Record<string, unknown>;
  const ledger = (payload.ledger ?? []) as Array<Record<string, unknown>>;
  ledger.unshift({
    id: DEBIT_ID,
    customerId: 'C1',
    type: 'adjustment',
    points: 0,
    balanceAfter: 60,
    description: 'Achat à crédit Avoir (débit concurrent)',
    creditDeltaDzd: -90,
    referenceId: 'TKT-OTHER',
  });
  payload.storeCredit = 60;
  payload.ledger = ledger;
  db.prepare('UPDATE customers SET json_payload = ? WHERE id = ?').run(JSON.stringify(payload), 'C1');
}

/** The refund's composed loyalty state — note the STALE storeCredit (150). */
function refundCustomer(): unknown {
  return {
    id: 'C1',
    name: 'Salma',
    phone: '0551000000',
    loyaltyPoints: 70,
    loyaltyTier: 'Or',
    totalSpent: 400,
    // Deliberately stale: taken before the concurrent debit.
    storeCredit: 150,
    currentDebt: 0,
    pointBuckets: [{ id: 'B1', points: 70, earnedAt: '2026-10-31T10:05:00Z' }],
  };
}

function newLedgerEntry(): unknown {
  return {
    id: 'LEDGER-POINTS-REFUND',
    customerId: 'C1',
    timestamp: '2026-10-31T10:05:00Z',
    type: 'adjustment',
    points: -2,
    balanceAfter: 70,
    description: 'Déduction points fidélité remboursement',
    referenceId: 'TKT-1',
  };
}

function bindArgs(args: unknown[]): Record<string, unknown> {
  // The mirror uses numbered parameters ($1..$n), which better-sqlite3 treats as
  // named; map them by index so the REAL statements are executed unmodified.
  return Object.fromEntries(args.map((value, i) => [String(i + 1), value]));
}

function applyMirror(db: Database.Database, now = '2026-10-31T10:05:01Z', withLedger = true): void {
  const statements = buildRefundMirrorStatements(
    refundCustomer() as never,
    now,
    (withLedger ? [newLedgerEntry()] : []) as never,
  );
  for (const s of statements) db.prepare(s.sql).run(bindArgs(s.args));
}

function readRow(db: Database.Database): Row {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get('C1') as Row;
}

function readPayload(db: Database.Database): Record<string, unknown> {
  return JSON.parse(readRow(db).json_payload) as Record<string, unknown>;
}

console.log('refund mirror — N2 regression');

check('a concurrent wallet debit survives the mirror', () => {
  const db = makeDb();
  concurrentDebit(db);
  applyMirror(db);
  assertEqual(readRow(db).store_credit, 60, 'store_credit column');
  assertEqual(readPayload(db).storeCredit, 60, 'storeCredit in payload');
});

check('the stale storeCredit carried by the caller is never written', () => {
  const db = makeDb();
  concurrentDebit(db);
  applyMirror(db);
  const payload = readPayload(db);
  assertTrue(payload.storeCredit !== 150, 'stale 150 leaked into the payload');
  assertTrue(readRow(db).store_credit !== 150, 'stale 150 leaked into the column');
});

check('the concurrent debit ledger row is preserved, not dropped', () => {
  const db = makeDb();
  concurrentDebit(db);
  applyMirror(db);
  const ledger = (readPayload(db).ledger ?? []) as Array<Record<string, unknown>>;
  const debit = ledger.find((e) => e.id === DEBIT_ID);
  assertTrue(Boolean(debit), 'concurrent debit row disappeared');
  assertEqual(Number(debit?.creditDeltaDzd), -90, 'debit amount');
});

check("this refund's ledger row is appended exactly once", () => {
  const db = makeDb();
  concurrentDebit(db);
  applyMirror(db);
  const ledger = (readPayload(db).ledger ?? []) as Array<Record<string, unknown>>;
  assertEqual(ledger.filter((e) => e.id === 'LEDGER-POINTS-REFUND').length, 1, 'points ledger rows');
});

check('replaying the mirror (retry) does not duplicate ledger rows', () => {
  const db = makeDb();
  concurrentDebit(db);
  applyMirror(db);
  const before = readRow(db).version;
  applyMirror(db, '2026-10-31T10:05:02Z');
  const ledger = (readPayload(db).ledger ?? []) as Array<Record<string, unknown>>;
  assertEqual(
    ledger.filter((e) => e.id === 'LEDGER-POINTS-REFUND').length,
    1,
    'duplicated points row',
  );
  assertEqual(ledger.filter((e) => e.id === DEBIT_ID).length, 1, 'duplicated debit row');
  assertTrue(readRow(db).version > before, 'version must advance on a replay write');
});

check('loyalty state is mirrored (points, tier, buckets, spend)', () => {
  const db = makeDb();
  concurrentDebit(db);
  applyMirror(db);
  const row = readRow(db);
  const payload = readPayload(db);
  assertEqual(row.loyalty_points, 70, 'loyalty_points column');
  assertEqual(row.total_spent, 400, 'total_spent column');
  assertEqual(payload.loyaltyPoints, 70, 'loyaltyPoints payload');
  assertEqual(payload.loyaltyTier, 'Or', 'loyaltyTier payload');
  assertEqual((payload.pointBuckets as unknown[]).length, 1, 'pointBuckets payload');
});

check("the wallet column is absent from the mirror's SET list", () => {
  const statements = buildRefundMirrorStatements(
    refundCustomer() as never,
    '2026-10-31T10:05:01Z',
    [newLedgerEntry()] as never,
  );
  for (const s of statements) {
    assertTrue(
      !/\bstore_credit\s*=/.test(s.sql),
      `statement writes store_credit: ${s.sql.replace(/\s+/g, ' ').slice(0, 80)}`,
    );
    assertTrue(
      !/\bcurrent_debt\s*=/.test(s.sql),
      `statement writes current_debt: ${s.sql.replace(/\s+/g, ' ').slice(0, 80)}`,
    );
  }
});

check('no TS ledger entry means no ledger write at all', () => {
  const db = makeDb();
  concurrentDebit(db);
  const before = (readPayload(db).ledger as unknown[]).length;
  applyMirror(db, '2026-10-31T10:05:01Z', false);
  assertEqual((readPayload(db).ledger as unknown[]).length, before, 'ledger length');
  assertEqual(readRow(db).store_credit, 60, 'store_credit column');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
