/**
 * Tombstone version predicates (A2: SYNC-007) — executes the REAL predicate
 * from tombstoneVersionPredicate() against a disposable libsql file DB.
 *
 * Proves: stale tombstones cannot delete newer rows (or rewind their
 * clocks); fresh tombstones land with the incoming version; equal versions
 * apply deterministically (delete-wins-ties); NULL-version legacy rows stay
 * tombstonable; repeat tombstones are idempotent.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import { tombstoneVersionPredicate } from '../src/sync/causalVersion.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const DB_FILE = 'tmp-tombstone-guard.db';

async function main() {
  try { rmSync(DB_FILE); } catch { /* fresh */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  const db = createClient({ url: `file:${DB_FILE}` });
  // version nullable on purpose: legacy rows predate the clock columns.
  await db.execute(
    'CREATE TABLE t (id TEXT PRIMARY KEY, version INTEGER, deleted INTEGER DEFAULT 0)',
  );
  const whereTomb = tombstoneVersionPredicate('t', 'id', '?', '?');

  async function tombstone(id: string, version: number) {
    return db.execute({
      sql: `UPDATE t SET deleted = 1, version = ? WHERE ${whereTomb}`,
      args: [version, id, version],
    });
  }
  async function read(id: string) {
    const rs = await db.execute({ sql: 'SELECT version, deleted FROM t WHERE id = ?', args: [id] });
    return rs.rows[0] as unknown as { version: number | null; deleted: number };
  }

  // 1. Stale tombstone (v5) vs newer row (v7): row survives, clock intact.
  await db.execute({ sql: `INSERT INTO t (id, version, deleted) VALUES ('A', 7, 0)`, args: [] });
  await tombstone('A', 5);
  const a = await read('A');
  check('stale tombstone cannot delete newer row', a.deleted === 0, JSON.stringify(a));
  check('stale tombstone cannot rewind clock', a.version === 7, JSON.stringify(a));

  // 2. Fresh tombstone (v7) vs older row (v5): lands with incoming version.
  await db.execute({ sql: `INSERT INTO t (id, version, deleted) VALUES ('B', 5, 0)`, args: [] });
  await tombstone('B', 7);
  const b = await read('B');
  check('fresh tombstone deletes', b.deleted === 1, JSON.stringify(b));
  check('fresh tombstone carries incoming version', b.version === 7, JSON.stringify(b));

  // 3. Equal versions: delete wins ties, deterministically both orders.
  await db.execute({ sql: `INSERT INTO t (id, version, deleted) VALUES ('C', 6, 0)`, args: [] });
  await tombstone('C', 6);
  const c = await read('C');
  check('equal-version tombstone applies (delete-wins-ties)', c.deleted === 1 && c.version === 6);

  // 4. NULL-version legacy row + v1 tombstone: COALESCE keeps it tombstonable.
  await db.execute({ sql: `INSERT INTO t (id, version, deleted) VALUES ('D', NULL, 0)`, args: [] });
  await tombstone('D', 1);
  const d = await read('D');
  check('legacy NULL-version row tombstonable', d.deleted === 1 && d.version === 1, JSON.stringify(d));

  // 5. Repeat tombstone: idempotent, no clock movement.
  await tombstone('B', 7);
  const b2 = await read('B');
  check('repeat tombstone idempotent', b2.deleted === 1 && b2.version === 7);

  // 6. Old unpredicated shape loses (characterization of the bug).
  await db.execute({ sql: `INSERT INTO t (id, version, deleted) VALUES ('E', 7, 0)`, args: [] });
  await db.execute({ sql: `UPDATE t SET deleted = 1 WHERE id = ?`, args: ['E'] });
  const e = await read('E');
  check('unpredicated tombstone deletes newer row (the bug)', e.deleted === 1, JSON.stringify(e));

  db.close();
  try { rmSync(DB_FILE); } catch { /* cleanup */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  console.log(`\ntombstone-guard: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
