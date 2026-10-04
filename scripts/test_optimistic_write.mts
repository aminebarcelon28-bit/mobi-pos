/**
 * Optimistic write loop (A3: DB-013 second half) — tests for
 * runOptimisticWriteLoop in src/sync/causalVersion.ts, plus a real-SQL
 * two-writer convergence proof on a disposable libsql file DB replicating
 * the guarded-upsert + content-verify pattern.
 *
 * Proves: clean writes converge in one attempt; a stale reader retries onto
 * the fresh clock with its own content (no silent same-version overwrite);
 * persistent contention exhausts into a loud forced write; errors propagate.
 */
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';
import {
  payloadFingerprint,
  runOptimisticWriteLoop,
} from '../src/sync/causalVersion.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

const fp = (v: number, tag: string) => payloadFingerprint({ v, tag });

// ---- Pure loop tests (scripted fake io) ----
{
  // 1. Clean write: one guarded attempt.
  const calls: Array<{ base: number; next: number; guarded: boolean }> = [];
  const out = await runOptimisticWriteLoop(
    {
      read: async () => 3,
      write: async (base, next, guarded) => { calls.push({ base, next, guarded }); },
      inspect: async () => ({ version: 4, fingerprint: fp(4, 'mine') }),
      fingerprintFor: (v) => fp(v, 'mine'),
    },
    0, 3,
  );
  check('clean write converges attempt 1', out.next === 4 && out.forced === false && out.attemptsUsed === 1);
  check('clean write is guarded on read value', calls.length === 1 && calls[0].base === 3 && calls[0].guarded === true);
}
{
  // 2. Stale reader shape: single writer converges immediately; the true
  // race (another writer's content under our version) is covered
  // deterministically in the SQL test below.
  const writes: Array<{ base: number; next: number; guarded: boolean }> = [];
  let state: { version: number; fingerprint: string } = { version: 3, fingerprint: fp(3, 'other') };
  const out = await runOptimisticWriteLoop(
    {
      read: async () => state.version,
      write: async (base, next, guarded) => {
        writes.push({ base, next, guarded });
        state = { version: next, fingerprint: fp(next, 'mine') };
      },
      inspect: async () => ({ ...state }),
      fingerprintFor: (v) => fp(v, 'mine'),
    },
    0, 3,
  );
  check('loop returns version + attempts', out.next === 4 && out.attemptsUsed === 1 && out.forced === false);
  check('writes recorded', writes.length === 1 && writes[0].guarded === true);
}
{
  // 3. Absent row: INSERT path lands visibly, old-code obliviousness kept.
  let present: { version: number; fingerprint: string } | null = null;
  const out = await runOptimisticWriteLoop(
    {
      read: async () => (present ? present.version : null),
      write: async (_b, next) => { present = { version: next, fingerprint: fp(next, 'x') }; },
      inspect: async () => (present ? { ...present } : { version: null, fingerprint: null }),
      fingerprintFor: (v) => fp(v, 'x'),
    },
    7, 3,
  );
  check('absent row writes fallback+1', out.next === 8 && out.forced === false);
}
{
  // 4. Persistent contention: 3 guarded misses, then one loud forced write.
  const writes: Array<{ guarded: boolean; next: number }> = [];
  const out = await runOptimisticWriteLoop(
    {
      read: async () => 99,
      write: async (_b, next, guarded) => { writes.push({ guarded, next }); },
      inspect: async () => ({ version: 99, fingerprint: 'OTHER' }),
      fingerprintFor: (v) => fp(v, 'mine'),
    },
    0, 3,
  );
  check('exhaustion forces once', out.forced === true && out.attemptsUsed === 3 && out.next === 100);
  check('first three guarded, last unguarded',
    writes.length === 4 && writes.slice(0, 3).every((w) => w.guarded) && !writes[3].guarded);
}
{
  // 5. Errors propagate untouched (BUSY/transport must not be retried blindly).
  const boom = new Error('SQLITE_BUSY');
  let caught: unknown = null;
  try {
    await runOptimisticWriteLoop(
      {
        read: async () => 3,
        write: async () => { throw boom; },
        inspect: async () => ({ version: null, fingerprint: null }),
        fingerprintFor: (v) => fp(v, 'x'),
      },
      0, 3,
    );
  } catch (e) { caught = e; }
  check('write errors propagate identical', caught === boom);
}
{
  // 6. attempts clamp: 0 behaves as default, attemptsUsed counted.
  const out = await runOptimisticWriteLoop(
    {
      read: async () => 1,
      write: async () => {},
      inspect: async () => ({ version: 2, fingerprint: fp(2, 'm') }),
      fingerprintFor: (v) => fp(v, 'm'),
    },
    0, 0,
  );
  check('attempts=0 defaults without hanging', out.next === 2 && out.forced === false);
}

// ---- Real-SQL two-writer convergence ----
const DB_FILE = 'tmp-optimistic-write.db';
{
  try { rmSync(DB_FILE); } catch { /* fresh */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
  const db = createClient({ url: `file:${DB_FILE}` });
  await db.execute('CREATE TABLE cust (id TEXT PRIMARY KEY, version INTEGER, payload TEXT)');

  // Mirror of the customerAdapter guarded upsert (INSERT path + predicate).
  async function guardedWrite(id: string, base: number, next: number, payload: string): Promise<boolean> {
    await db.execute({
      sql: `INSERT INTO cust (id, version, payload) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version, payload=excluded.payload
        WHERE cust.version = ?`,
      args: [id, next, payload, base],
    });
    const cur = await db.execute({ sql: 'SELECT version, payload FROM cust WHERE id = ?', args: [id] });
    const row = cur.rows[0] as unknown as { version: number; payload: string };
    return row.version === next && row.payload === payload;
  }

  // Seed v3.
  await db.execute({ sql: `INSERT INTO cust (id, version, payload) VALUES ('C', 3, 'seed')`, args: [] });
  // Writer A reads 3, writes v4 guarded. Writer B holds stale read 3.
  const aApplied = await guardedWrite('C', 3, 4, 'content-A');
  // B's guarded write on stale base misses (row is v4, predicate wants v3).
  const bFirstTry = await guardedWrite('C', 3, 4, 'content-B');
  const cur = await db.execute({ sql: 'SELECT version, payload FROM cust WHERE id = ?', args: ['C'] });
  const mid = cur.rows[0] as unknown as { version: number; payload: string };
  // B retries on the fresh clock: v5 with B's content.
  const bRetry = await guardedWrite('C', mid.version, mid.version + 1, 'content-B');
  const fin = await db.execute({ sql: 'SELECT version, payload FROM cust WHERE id = ?', args: ['C'] });
  const finRow = fin.rows[0] as unknown as { version: number; payload: string };
  check('A lands v4', aApplied === true);
  check('stale B write misses the guard (no silent v4 overwrite)', bFirstTry === false);
  check('B retries onto fresh clock and converges', bRetry === true);
  check('final state monotonic with winner content, 3->4->5',
    finRow.version === 5 && finRow.payload === 'content-B', JSON.stringify(finRow));
  check('no same-version double-write occurred', mid.version === 4 && mid.payload === 'content-A');

  db.close();
  try { rmSync(DB_FILE); } catch { /* cleanup */ }
  try { rmSync(`${DB_FILE}-wal`); } catch { /* noop */ }
}

console.log(`\noptimistic-write: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
