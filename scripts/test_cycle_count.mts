/**
 * UPGRADE-10 — scheduled ABC micro-stocktakes + drawer-pulse audit suite.
 *
 * Part 1 — pure engine pins: ABC classification (serialized/high-value → A),
 *          cadence 30/90/365, due math on injected clocks, ADJUST-excluding
 *          movement sums, variance, booking selection.
 * Part 2 — THE OWNER ORACLE: a sale between task open and submit books
 *          ZERO phantom shrinkage (snapshot + post-open movements = expected;
 *          variance 0 → nothing reaches appendStocktakeAdjustments).
 * Part 3 — control: a genuine variance produces a booking item; concurrent
 *          ADJUST corrections never leak into another task's expectation;
 *          a VOID restock nets to zero.
 * Part 4 — single-claim submit + one-open-task-per-product (guard read +
 *          partial unique index backstop + reopen after completion) +
 *          last-counted cadence read.
 * Part 5 — EXPLAIN QUERY PLAN oracle on `node:sqlite` against the REAL DDL
 *          and the REAL SQL strings: every statement resolves via
 *          SEARCH … USING INDEX; any SCAN fails the build.
 * Part 6 — wiring + parity: lib.rs v125 ≡ schemaHeal constants ≡ adapter
 *          probe/spread; remote stays KV (no cycle_count_tasks there); the
 *          submit lane books only through appendStocktakeAdjustments; drawer
 *          test pulse rides the logSecurityAction funnel.
 * Part 7 — heal replay on a pre-v125 shape: probe fails → statements apply →
 *          probe passes → idempotent rerun → integrity_check ok, FK empty.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  ABC_A_MIN_PRICE_DZD,
  ABC_B_MIN_PRICE_DZD,
  ABC_CADENCE_DAYS,
  abcClassForProduct,
  addDaysIso,
  computeExpectedQty,
  computeVarianceQty,
  expectedQtyFromMovedTotal,
  isTaskDue,
  nextDueIso,
  normalizeAbcClass,
  selectBookingItems,
  selectDueProducts,
  sumMovementDeltas,
} from '../src/utils/cycleCount';
import {
  CYCLE_COUNT_TASKS_HEAL_PROBE_SQL,
  CYCLE_COUNT_TASKS_HEAL_SQL,
} from '../src/db/schemaHeal';
import {
  CCT_LIST_OPEN_SQL,
  CCT_MOVEMENTS_SUM_SQL,
  CCT_OPEN_TASK_INSERT_SQL,
  CCT_SNAPSHOT_READ_SQL,
  CCT_SUBMIT_UPDATE_SQL,
  CCT_TASK_BY_ID_SQL,
  buildLastCountedSql,
} from '../src/db/cycleCountSql';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`);
  } else {
    fail++;
    failures.push(`${name}${extra ? ' :: ' + extra : ''}`);
    console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`);
  }
}
const src = (p: string) => readFileSync(`${process.cwd()}/${p}`, 'utf8');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const LEDGER_DDL = `
  CREATE TABLE inventory_ledger (
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
    delta INTEGER NOT NULL, reason TEXT NOT NULL
      CHECK (reason IN ('SALE','VOID','REFUND','RECEIVE','ADJUST','SEED')),
    ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL DEFAULT 'd1',
    idempotency_key TEXT NOT NULL UNIQUE,
    sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','inflight','synced','failed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_ledger_updated ON inventory_ledger(updated_at, id);
  CREATE INDEX idx_ledger_product ON inventory_ledger(product_id, created_at);
`;

/** Real v125 DDL + real ledger shape — the exact objects the app runs. */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(LEDGER_DDL);
  for (const stmt of CYCLE_COUNT_TASKS_HEAL_SQL) db.exec(stmt);
  return db;
}

/** Insert one ledger movement; returns its rowid (the insert watermark). */
function ledgerRow(
  db: DatabaseSync,
  id: string,
  productId: string,
  delta: number,
  reason: string,
  at = '2026-10-01T10:00:00.000Z'
): number {
  const res = db
    .prepare(
      `INSERT INTO inventory_ledger (id, product_id, delta, reason, ref_type, ref_id, device_id, idempotency_key, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, 'test', ?, 'd1', ?, ?, ?, 0)`
    )
    .run(id, productId, delta, reason, id, id, at, at);
  return Number(res.lastInsertRowid);
}

const bind = (values: Array<string | number>): Record<string, string | number> => {
  const o: Record<string, string | number> = {};
  values.forEach((v, i) => {
    o[String(i + 1)] = v;
  });
  return o;
};

const NOW = '2026-10-17T09:00:00.000Z';

// ── Part 1: pure engine pins ───────────────────────────────────────────────
console.log('\n--- Part 1: engine (classification, cadence, arithmetic) ---');
{
  check('thresholds pinned', ABC_A_MIN_PRICE_DZD === 20000 && ABC_B_MIN_PRICE_DZD === 5000);
  check('cadence pinned (30/90/365)', ABC_CADENCE_DAYS.A === 30 && ABC_CADENCE_DAYS.B === 90 && ABC_CADENCE_DAYS.C === 365);
  check('serialized → A regardless of price', abcClassForProduct({ price: 100, isSerialized: true }) === 'A');
  check('high value → A at the floor', abcClassForProduct({ price: 20000 }) === 'A');
  check('just under the floor → B', abcClassForProduct({ price: 19999 }) === 'B');
  check('mid value → B at its floor', abcClassForProduct({ price: 5000 }) === 'B');
  check('low value → C', abcClassForProduct({ price: 4999 }) === 'C');
  check('missing price → C (never throws)', abcClassForProduct({}) === 'C');
  check('NaN price → C', abcClassForProduct({ price: Number.NaN }) === 'C');
  check('normalizeAbcClass pinned + fails to C', normalizeAbcClass('a') === 'A' && normalizeAbcClass('B') === 'B' && normalizeAbcClass('zzz') === 'C');
  check('nextDue: A = +30d on the injected clock', nextDueIso('2026-01-01T00:00:00.000Z', 'A') === '2026-01-31T00:00:00.000Z');
  check('nextDue: B = +90d', nextDueIso('2026-01-01T00:00:00.000Z', 'B') === '2026-04-01T00:00:00.000Z');
  check('nextDue: C = +365d (leap-safe date math)', nextDueIso('2026-01-01T00:00:00.000Z', 'C') === '2027-01-01T00:00:00.000Z');
  check('addDaysIso is exact on month boundaries', addDaysIso('2026-08-31T00:00:00.000Z', 1) === '2026-09-01T00:00:00.000Z');
  check('never counted → due', isTaskDue(null, 'C', NOW) === true);
  check('A: 29d ago → not yet due', isTaskDue('2026-09-18T09:00:00.000Z', 'A', NOW) === false);
  check('A: exactly 30d ago → due', isTaskDue('2026-09-17T09:00:00.000Z', 'A', NOW) === true);
  check('B: 89d ago → not yet due', isTaskDue('2026-07-20T09:00:00.000Z', 'B', NOW) === false);
  check('B: 90d ago → due', isTaskDue('2026-07-19T09:00:00.000Z', 'B', NOW) === true);
  check('unparseable last count → due (never silently skip)', isTaskDue('garbage', 'A', NOW) === true);

  check('movement sum counts SALE/VOID/REFUND/RECEIVE/SEED', sumMovementDeltas([
    { delta: -3, reason: 'SALE' },
    { delta: 3, reason: 'VOID' },
    { delta: 2, reason: 'RECEIVE' },
    { delta: -1, reason: 'REFUND' },
    { delta: 5, reason: 'SEED' },
  ]) === 6);
  check('movement sum EXCLUDES ADJUST corrections', sumMovementDeltas([
    { delta: -3, reason: 'SALE' },
    { delta: -99, reason: 'ADJUST' },
  ]) === -3);
  check('variance is EXACTLY 0 when the count follows the movements', computeVarianceQty(7, computeExpectedQty(10, [{ delta: -3, reason: 'SALE' }])) === 0);
  check('expected from moved total matches the movement form', expectedQtyFromMovedTotal(10, -3) === computeExpectedQty(10, [{ delta: -3, reason: 'SALE' }]));
  check('non-numeric noise is ignored by the sum', sumMovementDeltas([{ delta: Number.NaN, reason: 'SALE' }, { delta: 4, reason: 'SALE' }]) === 4);

  // Due selection (never counted → due; open tasks skipped; deterministic order).
  const products = [
    { id: 'p-serial', price: 100, isSerialized: true },
    { id: 'p-high', price: 25000, isSerialized: false },
    { id: 'p-b-fresh', price: 6000, isSerialized: false },
    { id: 'p-b-due', price: 6000, isSerialized: false },
    { id: 'p-c-fresh', price: 100, isSerialized: false },
    { id: 'p-open', price: 30000, isSerialized: false },
  ];
  const lastCounted = new Map<string, string>([
    ['p-b-fresh', '2026-07-20T09:00:00.000Z'],
    ['p-b-due', '2026-07-19T09:00:00.000Z'],
    ['p-c-fresh', '2025-10-18T09:00:00.000Z'],
    ['p-open', '2020-01-01T00:00:00.000Z'],
  ]);
  const openSet = new Set<string>(['p-open']);
  const due = selectDueProducts(products, lastCounted, openSet, NOW);
  const dueIds = due.map((d) => d.productId);
  check('due: never counted included', dueIds.includes('p-serial') && dueIds.includes('p-high'));
  check('due: B inside cadence excluded', !dueIds.includes('p-b-fresh'));
  check('due: B at cadence included', dueIds.includes('p-b-due'));
  check('due: C inside 365d excluded', !dueIds.includes('p-c-fresh'));
  check('due: product with an open task skipped', !dueIds.includes('p-open'));
  check('due: A sorted before B', dueIds.indexOf('p-serial') < dueIds.indexOf('p-b-due'));
  check('due: never-counted dueAt is "now"', due.find((d) => d.productId === 'p-serial')?.dueAt === NOW);
  check('due: overdue dueAt is last + cadence', due.find((d) => d.productId === 'p-b-due')?.dueAt === '2026-10-17T09:00:00.000Z');
}

// ── Part 2: THE OWNER ORACLE — sale between open and submit books 0 ───────
console.log('\n--- Part 2: owner oracle — mid-count sale books 0 phantom shrinkage ---');
{
  const db = makeDb();
  // SEED +10 → task opens with snapshot 10 and the rowid watermark.
  ledgerRow(db, 'seed-p1', 'p1', 10, 'SEED', '2026-10-01T08:00:00.000Z');
  const snap = db.prepare(CCT_SNAPSHOT_READ_SQL).all(bind(['p1']))[0] as Record<string, unknown>;
  check('open snapshot: ledger sum = 10', Number(snap.ledger_sum) === 10);
  check('open snapshot: watermark = seed rowid', Number(snap.ledger_max_id) === 1);
  db.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-p1-open', 'p1', 'A', '2026-11-16T09:00:00.000Z', NOW, 1, 10]));
  check('task opened with frozen expectation', db.prepare(CCT_LIST_OPEN_SQL).all().length === 1);

  // A sale happens BETWEEN open and submit: −3 (booked by the checkout lane).
  ledgerRow(db, 'sale-p1', 'p1', -3, 'SALE', '2026-10-17T09:30:00.000Z');

  // Submit lane: expected = snapshot + post-watermark movements (ADJUST excl.).
  const moved = db.prepare(CCT_MOVEMENTS_SUM_SQL).all(bind(['p1', 1]))[0] as Record<string, unknown>;
  check('post-open movements = −3 (the sale)', Number(moved.moved) === -3);
  const expected = expectedQtyFromMovedTotal(Number(snap.ledger_sum), Number(moved.moved));
  check('expected = 7 (sale carried by the snapshot arithmetic)', expected === 7);
  const counted = 7; // the operator counts the shelf AFTER the sale
  const variance = computeVarianceQty(counted, expected);
  check('variance is EXACTLY 0 — no phantom shrinkage', variance === 0);
  const bookingItems = selectBookingItems([
    { taskId: 'CCT-p1-open', productId: 'p1', countedQty: counted, expectedQty: expected, varianceQty: variance },
  ]);
  check('nothing is selected for booking (appendStocktakeAdjustments never called)', bookingItems.length === 0, JSON.stringify(bookingItems));

  // Claim the task; the ledger must not gain a single ADJUST row.
  const upd = db.prepare(CCT_SUBMIT_UPDATE_SQL).run(bind(['CCT-p1-open', counted, expected, NOW, 'Farida']));
  check('task claimed (rowsAffected 1)', Number(upd.changes) === 1);
  const adjustRows = db.prepare(`SELECT COUNT(*) AS n FROM inventory_ledger WHERE reason = 'ADJUST'`).all()[0] as Record<string, unknown>;
  check('ZERO ADJUST rows booked', Number(adjustRows.n) === 0, `rows=${adjustRows.n}`);
  const liveSum = db.prepare(`SELECT COALESCE(SUM(delta), 0) AS s FROM inventory_ledger WHERE product_id = 'p1' AND deleted = 0`).all()[0] as Record<string, unknown>;
  check('ledger truth stays 7 (sale only)', Number(liveSum.s) === 7, `sum=${liveSum.s}`);
  const task = db.prepare(CCT_TASK_BY_ID_SQL).all(bind(['CCT-p1-open']))[0] as Record<string, unknown>;
  check('task records counted + expected + operator', Number(task.counted_qty) === 7 && Number(task.expected_qty) === 7 && task.operator === 'Farida');
  db.close();
}

// ── Part 3: controls — genuine variance, ADJUST isolation, VOID restock ───
console.log('\n--- Part 3: controls (real variance books; corrections stay isolated) ---');
{
  // Genuine shrinkage: shelf missing 2 beyond every movement.
  const db = makeDb();
  ledgerRow(db, 'seed-p2', 'p2', 10, 'SEED');
  db.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-p2-open', 'p2', 'A', '2026-11-16T09:00:00.000Z', NOW, 1, 10]));
  ledgerRow(db, 'sale-p2', 'p2', -3, 'SALE', '2026-10-17T09:30:00.000Z');
  const moved = db.prepare(CCT_MOVEMENTS_SUM_SQL).all(bind(['p2', 1]))[0] as Record<string, unknown>;
  const expected = expectedQtyFromMovedTotal(10, Number(moved.moved));
  const variance = computeVarianceQty(5, expected);
  const items = selectBookingItems([{ taskId: 'CCT-p2-open', productId: 'p2', countedQty: 5, expectedQty: expected, varianceQty: variance }]);
  check('genuine shrinkage: variance −2', variance === -2 && expected === 7);
  check('genuine variance IS selected for booking (through the single writer)', items.length === 1 && items[0].productId === 'p2' && items[0].countedStock === 5, JSON.stringify(items));
  db.close();

  // A concurrent ADJUST (another corrector) must not leak into this expectation.
  const db2 = makeDb();
  ledgerRow(db2, 'seed-p3', 'p3', 10, 'SEED');
  db2.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-p3-open', 'p3', 'B', '2027-01-15T00:00:00.000Z', NOW, 1, 10]));
  ledgerRow(db2, 'sale-p3', 'p3', -3, 'SALE', '2026-10-17T09:30:00.000Z');
  ledgerRow(db2, 'other-adjust-p3', 'p3', -1, 'ADJUST', '2026-10-17T09:40:00.000Z');
  const moved3 = db2.prepare(CCT_MOVEMENTS_SUM_SQL).all(bind(['p3', 1]))[0] as Record<string, unknown>;
  check('concurrent ADJUST excluded from the movement sum', Number(moved3.moved) === -3);
  const expected3 = expectedQtyFromMovedTotal(10, Number(moved3.moved));
  check('expected ignores the other correction (7, not 6)', expected3 === 7);
  check('count agreeing with expected books nothing', computeVarianceQty(7, expected3) === 0);
  db2.close();

  // A VOID restock between open and submit is carried, not double-booked.
  const db3 = makeDb();
  ledgerRow(db3, 'seed-p4', 'p4', 10, 'SEED');
  db3.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-p4-open', 'p4', 'C', '2027-10-17T09:00:00.000Z', NOW, 1, 10]));
  ledgerRow(db3, 'void-p4', 'p4', 3, 'VOID', '2026-10-17T09:35:00.000Z');
  const moved4 = db3.prepare(CCT_MOVEMENTS_SUM_SQL).all(bind(['p4', 1]))[0] as Record<string, unknown>;
  check('VOID restock carried by the expectation (13)', expectedQtyFromMovedTotal(10, Number(moved4.moved)) === 13);
  check('count of 13 after the restock books nothing', computeVarianceQty(13, 13) === 0);
  db3.close();
}

// ── Part 4: single-claim, open guard, last-counted ────────────────────────
console.log('\n--- Part 4: single-claim submit + one-open-task-per-product ---');
{
  const db = makeDb();
  ledgerRow(db, 'seed-p5', 'p5', 10, 'SEED');
  const ins = db.prepare(CCT_OPEN_TASK_INSERT_SQL);
  ins.run(bind(['CCT-p5-open', 'p5', 'A', '2026-11-16T09:00:00.000Z', NOW, 1, 10]));

  // Open guard (repo lane): a second open for the same product is skipped…
  const openRows = db.prepare(CCT_LIST_OPEN_SQL).all() as Array<Record<string, unknown>>;
  const openSet = new Set(openRows.map((r) => String(r.product_id)));
  check('guard read sees the open task', openSet.has('p5'));
  // …and the partial unique index is the backstop if the guard is ever raced.
  let backstopThrew = false;
  try {
    ins.run(bind(['CCT-p5-open-2', 'p5', 'A', '2026-11-16T09:00:00.000Z', NOW, 1, 10]));
  } catch {
    backstopThrew = true;
  }
  check('partial unique index rejects a second open task', backstopThrew);
  check('idempotent retry of the SAME id stays a no-op', Number(ins.run(bind(['CCT-p5-open', 'p5', 'A', '2026-11-16T09:00:00.000Z', NOW, 1, 10])).changes) === 0);

  // Single-claim: the first submit wins, the second matches nothing.
  const first = db.prepare(CCT_SUBMIT_UPDATE_SQL).run(bind(['CCT-p5-open', 10, 10, NOW, 'Farida']));
  const second = db.prepare(CCT_SUBMIT_UPDATE_SQL).run(bind(['CCT-p5-open', 9, 9, NOW, 'Farida']));
  check('first submit claims (1 row)', Number(first.changes) === 1);
  check('double-tap submit is skipped (0 rows)', Number(second.changes) === 0);
  const after = db.prepare(CCT_TASK_BY_ID_SQL).all(bind(['CCT-p5-open']))[0] as Record<string, unknown>;
  check('claimed task keeps the first count', Number(after.counted_qty) === 10);

  // Reopen after completion: the partial index only constrains OPEN tasks.
  let reopened = false;
  try {
    db.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-p5-reopen', 'p5', 'A', '2026-12-01T09:00:00.000Z', '2026-11-01T09:00:00.000Z', 2, 10]));
    reopened = true;
  } catch {
    reopened = false;
  }
  check('next cadence can open a fresh task', reopened);

  // List open excludes claimed tasks.
  const openAfter = db.prepare(CCT_LIST_OPEN_SQL).all() as Array<Record<string, unknown>>;
  check('open list: only the fresh task', openAfter.length === 1 && openAfter[0].id === 'CCT-p5-reopen');

  // Last-counted cadence read (batched IN-list) returns the MAX counted_at.
  db.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-p6-open', 'p6', 'B', '2026-11-01T09:00:00.000Z', NOW, 0, 0]));
  db.prepare(CCT_SUBMIT_UPDATE_SQL).run(bind(['CCT-p6-open', 0, 0, '2026-10-05T09:00:00.000Z', 'Farida']));
  db.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-p6-open-2', 'p6', 'B', '2026-11-01T09:00:00.000Z', NOW, 0, 0]));
  db.prepare(CCT_SUBMIT_UPDATE_SQL).run(bind(['CCT-p6-open-2', 0, 0, '2026-10-12T09:00:00.000Z', 'Farida']));
  const lastSql = buildLastCountedSql(2);
  const lastRows = db.prepare(lastSql).all(bind(['p5', 'p6'])) as Array<Record<string, unknown>>;
  const lastByPid = new Map(lastRows.map((r) => [String(r.product_id), String(r.last_counted_at)]));
  check('last-counted: p6 max counted_at wins', lastByPid.get('p6') === '2026-10-12T09:00:00.000Z');
  check('last-counted: p5 first count recorded', lastByPid.get('p5') === NOW);
  db.close();
}

// ── Part 5: EXPLAIN QUERY PLAN — SEARCH … USING INDEX only ────────────────
console.log('\n--- Part 5: EXPLAIN QUERY PLAN (no SCAN) ---');
{
  const db = makeDb();
  // Populate lightly enough for the planner but with the real objects.
  ledgerRow(db, 'l1', 'p1', 1, 'SEED');
  ledgerRow(db, 'l2', 'p1', 1, 'SALE');
  const plan = (sql: string): string[] =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: string }>).map((r) => String(r.detail ?? ''));
  const noScan = (p: string[]) => p.every((d) => !d.includes('SCAN'));
  const uses = (p: string[], needle: string) => p.some((d) => d.includes(needle));

  const snapPlan = plan(CCT_SNAPSHOT_READ_SQL);
  check(
    'snapshot plan: SEARCH ledger via idx_ledger_product + rowid watermark, no SCAN',
    uses(snapPlan, 'SEARCH inventory_ledger USING INDEX idx_ledger_product') && noScan(snapPlan),
    snapPlan.join(' | ')
  );
  const movedPlan = plan(CCT_MOVEMENTS_SUM_SQL);
  check(
    'movements plan: SEARCH ledger via idx_ledger_product, no SCAN',
    uses(movedPlan, 'SEARCH inventory_ledger USING INDEX idx_ledger_product') && noScan(movedPlan),
    movedPlan.join(' | ')
  );
  const listPlan = plan(CCT_LIST_OPEN_SQL);
  check(
    'open-list plan: SEARCH tasks via idx_cct_due, no SCAN',
    uses(listPlan, 'SEARCH cycle_count_tasks USING INDEX idx_cct_due') && noScan(listPlan),
    listPlan.join(' | ')
  );
  const byIdPlan = plan(CCT_TASK_BY_ID_SQL);
  check(
    'task-by-id plan: SEARCH via the id autoindex, no SCAN',
    uses(byIdPlan, 'SEARCH cycle_count_tasks USING INDEX sqlite_autoindex_cycle_count_tasks_1') && noScan(byIdPlan),
    byIdPlan.join(' | ')
  );
  const updPlan = plan(CCT_SUBMIT_UPDATE_SQL);
  check(
    'submit-update plan: SEARCH via the id autoindex, no SCAN',
    uses(updPlan, 'SEARCH cycle_count_tasks USING INDEX sqlite_autoindex_cycle_count_tasks_1') && noScan(updPlan),
    updPlan.join(' | ')
  );
  const lastPlan = plan(buildLastCountedSql(2));
  check(
    'last-counted plan: SEARCH via idx_cct_product_counted, no SCAN',
    uses(lastPlan, 'SEARCH cycle_count_tasks USING INDEX idx_cct_product_counted') && noScan(lastPlan),
    lastPlan.join(' | ')
  );
  db.close();
}

// ── Part 6: wiring + parity ────────────────────────────────────────────────
console.log('\n--- Part 6: wiring + parity ---');
{
  const libRs = src('src-tauri/src/lib.rs');
  const heal = src('src/db/schemaHeal.ts');
  const adapter = src('src/db/sqlPluginAdapter.ts');
  const remote = src('src/sync/remoteSchema.ts');
  const slice = src('src/store/slices/createCatalogSlice.ts');
  const modal = src('src/components/modals/InventoryManagerModal.tsx');
  const hw = src('src/components/modals/settings/HardwareSettingsTab.tsx');
  const engine = src('src/utils/cycleCount.ts');

  check('lib.rs v125 migration present', norm(libRs).includes('version: 125, description: "UPGRADE-10: cycle_count_tasks (scheduled ABC micro-stocktakes)"'));
  check('lib.rs ceiling bumped to 127', /EXPECTED_MAX_DB_USER_VERSION: u32 = 127;/.test(libRs));
  check('lib.rs is append-only (v124 still present)', libRs.includes('version: 124,'));

  // 3-way DDL parity: every heal statement appears verbatim in Rust v125.
  const v125Block = libRs.split('version: 125,')[1]?.split('kind: MigrationKind::Up')[0] ?? '';
  const rustNorm = norm(v125Block);
  for (const stmt of CYCLE_COUNT_TASKS_HEAL_SQL) {
    const body = norm(stmt.replace(/;$/, ''));
    check(`heal parity: rust contains ${body.slice(0, 64)}…`, rustNorm.includes(body));
  }
  check('heal parity: TS probe exported', heal.includes('CYCLE_COUNT_TASKS_HEAL_PROBE_SQL'));
  check('heal parity: TS statements exported', heal.includes('CYCLE_COUNT_TASKS_HEAL_SQL: readonly string[]'));
  check('rust probe order: probe constant name pinned', typeof CYCLE_COUNT_TASKS_HEAL_PROBE_SQL === 'string' && CYCLE_COUNT_TASKS_HEAL_PROBE_SQL.includes('opened_ledger_max_id'));

  check('adapter probes the table at boot', adapter.includes('await db.select(CYCLE_COUNT_TASKS_HEAL_PROBE_SQL)'));
  check('adapter spreads the heal statements', adapter.includes('...CYCLE_COUNT_TASKS_HEAL_SQL'));
  const probeIdx = adapter.indexOf('await db.select(CYCLE_COUNT_TASKS_HEAL_PROBE_SQL)');
  const spreadIdx = adapter.indexOf('...CYCLE_COUNT_TASKS_HEAL_SQL');
  check('heal lane reads the probe BEFORE statements execute', probeIdx > 0 && spreadIdx > probeIdx);
  check('adapter imports single-source constants', adapter.includes('CYCLE_COUNT_TASKS_HEAL_SQL, CYCLE_COUNT_TASKS_HEAL_PROBE_SQL'));

  check('cycle_count_tasks is local-only (never in the remote schema)', !remote.includes('cycle_count_tasks'));
  check('cycle_count_tasks is never a sync/generic lane', !src('src/sync/genericApply.ts').includes('cycle_count_tasks'));

  // Booking law: the slice never INSERTs into the ledger, and books through
  // appendStocktakeAdjustments only when selectBookingItems says so.
  check('slice exposes submitCycleCounts', slice.includes('submitCycleCounts: async (counts'));
  check('slice selects booking items via the pure engine', slice.includes('selectBookingItems(res.results)'));
  check('slice books through appendStocktakeAdjustments', slice.includes('await appendStocktakeAdjustments('));
  check('slice never writes the ledger directly', !slice.includes('INSERT INTO inventory_ledger'));
  check('slice logs the cycle-count audit action', slice.includes("'Comptage Cycle ABC'"));

  // Engine purity: no wall clock anywhere in the arithmetic.
  check('engine has zero Date.now()', !/Date\.now\s*\(/.test(engine));

  // UI wiring.
  check('modal lists open tasks', modal.includes('listOpenCycleCountTasks()'));
  check('modal opens due tasks', modal.includes('listDueCycleCountProducts(products)') && modal.includes('openCycleCountTasks(due.map'));
  check('modal submits through the store action', modal.includes('submitCycleCounts(counts)'));
  check('modal renders the ABC strip', modal.includes('Comptages Cycliques ABC'));

  // Drawer pulse: the settings test rides the funnel (chain-verified).
  check('drawer pulse logged on success path through the funnel', hw.includes("logSecurityAction('Test Tiroir (Paramètres)'"));
  check('drawer pulse logged on the failure path too', (hw.match(/auditDrawerPulse\(/g) ?? []).length >= 2);
  check('drawer still opens via the hardware helper', hw.includes('await openCashDrawer(printer)'));
  check('U09 classifier reads the pulse as no_sale (cross-suite contract)', src('scripts/test_exception_intel.mts').includes("classifyExceptionAction('Test Tiroir (Paramètres)') === 'no_sale'"));
}

// ── Part 7: heal replay on a pre-v125 shape ───────────────────────────────
console.log('\n--- Part 7: heal replay (pre-v125 shape) ---');
{
  const db = new DatabaseSync(':memory:');
  db.exec(LEDGER_DDL);

  let probeFailed = false;
  try {
    db.prepare(CYCLE_COUNT_TASKS_HEAL_PROBE_SQL).all();
  } catch {
    probeFailed = true;
  }
  check('pre-v125: probe fails (heal required)', probeFailed);

  for (const stmt of CYCLE_COUNT_TASKS_HEAL_SQL) db.exec(stmt);
  let probePassed = true;
  try {
    db.prepare(CYCLE_COUNT_TASKS_HEAL_PROBE_SQL).all();
  } catch {
    probePassed = false;
  }
  check('post-heal: probe passes', probePassed);

  for (const stmt of CYCLE_COUNT_TASKS_HEAL_SQL) {
    try {
      db.exec(stmt);
    } catch {
      check('heal rerun idempotent (statement re-application tolerated)', false, stmt.slice(0, 60));
    }
  }
  const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cycle_count_tasks'`).all() as Array<Record<string, unknown>>).map((r) => String(r.name));
  check('heal creates all three indexes', ['idx_cct_open_product', 'idx_cct_due', 'idx_cct_product_counted'].every((n) => indexes.includes(n)), indexes.join(','));
  const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  check("integrity_check = 'ok'", integrity.length === 1 && integrity[0] === 'ok', integrity.join(','));
  const fk = db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
  check('foreign_key_check empty', fk.length === 0, String(fk.length));

  // The read lane works on the freshly healed shape.
  ledgerRow(db, 'seed-h1', 'ph', 4, 'SEED');
  db.prepare(CCT_OPEN_TASK_INSERT_SQL).run(bind(['CCT-ph-open', 'ph', 'C', '2027-10-17T09:00:00.000Z', NOW, 1, 4]));
  const list = db.prepare(CCT_LIST_OPEN_SQL).all() as Array<Record<string, unknown>>;
  check('healed shape answers the open list', list.length === 1 && Number(list[0].snapshot_qty) === 4);
  db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
