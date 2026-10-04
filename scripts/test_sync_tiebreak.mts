/**
 * Sync tiebreak determinism (A3: SYNC-005) — executes the REAL guarded-upsert
 * predicate from src/sync/causalVersion.ts (tiedVersionGuardSql) against a
 * disposable libsql file DB.
 *
 * Proves: equal versions converge to the same winner regardless of apply
 * order (new behavior), while the legacy `>=` guard is order-dependent
 * (characterization of the bug). Plus: version primacy, NULL-device
 * handling, same-device idempotent re-apply.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import { tiedVersionGuardSql } from '../src/sync/causalVersion.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const DB_FILE = 'tmp-sync-tiebreak.db';

function applyNew(
  db: ReturnType<typeof createClient>,
  id: string, version: number, device: string | null, payload: string,
) {
  return db.execute({
    sql: `INSERT INTO t (id, version, device_id, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,
        device_id=excluded.device_id, payload=excluded.payload
      WHERE ${tiedVersionGuardSql('t')}`,
    args: [id, version, device, payload],
  });
}

function applyOld(
  db: ReturnType<typeof createClient>,
  id: string, version: number, device: string | null, payload: string,
) {
  return db.execute({
    sql: `INSERT INTO t (id, version, device_id, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,
        device_id=excluded.device_id, payload=excluded.payload
      WHERE excluded.version >= t.version`,
    args: [id, version, device, payload],
  });
}

async function read(db: ReturnType<typeof createClient>, id: string) {
  const rs = await db.execute({ sql: 'SELECT version, device_id, payload FROM t WHERE id = ?', args: [id] });
  const row = rs.rows[0] as unknown as { version: number; device_id: string | null; payload: string };
  return row;
}

async function main() {
  try { rmSync(DB_FILE); } catch { /* fresh */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  const db = createClient({ url: `file:${DB_FILE}` });
  await db.execute(
    'CREATE TABLE t (id TEXT PRIMARY KEY, version INTEGER, device_id TEXT, payload TEXT)',
  );

  // 1. New guard: A-then-B and B-then-A converge on the same winner.
  await db.execute({ sql: `DELETE FROM t WHERE id = 'X'`, args: [] });
  await applyNew(db, 'X', 6, 'till-01', 'A');
  await applyNew(db, 'X', 6, 'till-02', 'B');
  const fwd = await read(db, 'X');
  await db.execute({ sql: `DELETE FROM t WHERE id = 'X'`, args: [] });
  await applyNew(db, 'X', 6, 'till-02', 'B');
  await applyNew(db, 'X', 6, 'till-01', 'A');
  const rev = await read(db, 'X');
  check('new guard converges forward', fwd.device_id === 'till-02' && fwd.payload === 'B', JSON.stringify(fwd));
  check('new guard converges reverse', rev.device_id === 'till-02' && rev.payload === 'B', JSON.stringify(rev));
  check('new guard order-independent', fwd.device_id === rev.device_id && fwd.payload === rev.payload);

  // 2. Old guard characterization: same inputs, order-dependent outcome.
  await db.execute({ sql: `DELETE FROM t WHERE id = 'Y'`, args: [] });
  await applyOld(db, 'Y', 6, 'till-01', 'A');
  await applyOld(db, 'Y', 6, 'till-02', 'B');
  const oldFwd = await read(db, 'Y');
  await db.execute({ sql: `DELETE FROM t WHERE id = 'Y'`, args: [] });
  await applyOld(db, 'Y', 6, 'till-02', 'B');
  await applyOld(db, 'Y', 6, 'till-01', 'A');
  const oldRev = await read(db, 'Y');
  check('old guard: arrival order wins (the bug)',
    oldFwd.device_id === 'till-02' && oldRev.device_id === 'till-01',
    `fwd=${oldFwd.device_id} rev=${oldRev.device_id}`);

  // 3. Version primacy beats any device, both directions.
  await db.execute({ sql: `DELETE FROM t WHERE id = 'Z'`, args: [] });
  await applyNew(db, 'Z', 5, 'till-99', 'old');
  await applyNew(db, 'Z', 6, 'aaa', 'new');
  const prim = await read(db, 'Z');
  check('higher version wins regardless of device', prim.version === 6 && prim.payload === 'new');
  await applyNew(db, 'Z', 5, 'zzz', 'stale');
  const prim2 = await read(db, 'Z');
  check('lower version never overwrites', prim2.version === 6 && prim2.payload === 'new');

  // 4. NULL devices: deterministic, NULL ranks lowest via COALESCE.
  await db.execute({ sql: `DELETE FROM t WHERE id = 'N'`, args: [] });
  await applyNew(db, 'N', 6, null, 'null-first');
  await applyNew(db, 'N', 6, 'till-01', 'dev');
  const n1 = await read(db, 'N');
  check('named device beats NULL device', n1.payload === 'dev', JSON.stringify(n1));
  await db.execute({ sql: `DELETE FROM t WHERE id = 'N'`, args: [] });
  await applyNew(db, 'N', 6, 'till-01', 'dev');
  await applyNew(db, 'N', 6, null, 'null-second');
  const n2 = await read(db, 'N');
  check('NULL device never displaces named', n2.payload === 'dev', JSON.stringify(n2));

  // 5. Same device + version: re-apply is idempotent.
  await db.execute({ sql: `DELETE FROM t WHERE id = 'S'`, args: [] });
  await applyNew(db, 'S', 6, 'till-01', 'same');
  await applyNew(db, 'S', 6, 'till-01', 'same');
  const s = await read(db, 'S');
  check('same-device re-apply idempotent', s.version === 6 && s.payload === 'same');

  db.close();
  try { rmSync(DB_FILE); } catch { /* cleanup */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  console.log(`\nsync-tiebreak: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); }
);
