#!/usr/bin/env node
/**
 * Two-client sync fault suite (PASS-SIM) — SYN queue item 2.
 *
 * Hermetic: two disposable libsql file DBs, no ports, no credentials. Models the
 * two terminals as independent writers and applies their batches through the
 * REAL guarded-upsert predicate (`src/sync/causalVersion.ts`), then injects the
 * faults the 24-syn matrix asks for: partition/heal, duplicate delivery,
 * reorder, clock skew, concurrent same-entity edits, tombstone vs edit, and a
 * crash mid-batch with idempotent replay.
 *
 * This proves the convergence primitives (SYN-19/22/23/27/28 classes). It is a
 * SIMULATION of the transport, never headline PASS: the real two-instance +
 * merchant-gateway run is the owner's HAR-003 exit.
 *
 * Usage: node scripts/test_syn_faults.mjs
 * Exit: 0 all scenarios converge, 1 otherwise.
 */
import { createClient } from '@libsql/client';
import { rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ISO = () => new Date().toISOString();
const DDL = `CREATE TABLE t (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, device_id TEXT NOT NULL,
  payload TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);`;

const { tiedVersionGuardSql } = await import(
  new URL('../src/sync/causalVersion.ts', import.meta.url).href
);

const UPSERT = `INSERT INTO t (id, version, device_id, payload, deleted, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET version=excluded.version, device_id=excluded.device_id,
payload=excluded.payload, deleted=excluded.deleted, updated_at=excluded.updated_at
WHERE ${tiedVersionGuardSql('t')}`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

function fresh(name) {
  const file = join(ROOT, `tmp-syn-faults-${name}.db`);
  if (existsSync(file)) rmSync(file);
  const db = createClient({ url: `file:${file}` });
  return {
    db,
    file,
    cleanup: async () => {
      await db.close();
      try {
        rmSync(file, { force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* Windows may keep the handle for a beat; the file is a tmp artifact */
      }
    },
  };
}

async function init(db) {
  await db.execute(DDL);
}

const upsert = (db, row) =>
  db.execute({ sql: UPSERT, args: [row.id, row.version, row.device_id, row.payload, row.deleted ? 1 : 0, row.updated_at ?? ISO()] });

const row = async (db, id) => {
  const r = await db.execute({ sql: 'SELECT * FROM t WHERE id=?', args: [id] });
  return r.rows[0] ?? null;
};

const both = async (A, B, id) => ({ a: await row(A, id), b: await row(B, id) });

const converged = async (A, B, id) => {
  const { a, b } = await both(A, B, id);
  return Boolean(a && b && a.version === b.version && a.device_id === b.device_id && a.payload === b.payload);
};

const A = fresh('A');
const B = fresh('B');
await init(A.db);
await init(B.db);

// ── 1. partition/heal: both write the same entity offline at the same version
{
  const v = { id: 'cust-1', version: 2, payload: 'offline', updated_at: '2026-01-01T00:00:00Z' };
  await upsert(A.db, { ...v, device_id: 'dev-A', payload: 'from-A' });
  await upsert(B.db, { ...v, device_id: 'dev-B', payload: 'from-B' });
  // heal: exchange the batches (A applies B's row, B applies A's)
  const a = await row(A.db, 'cust-1');
  const b = await row(B.db, 'cust-1');
  await upsert(A.db, b);
  await upsert(B.db, a);
  check('partition/heal converges to one winner (equal versions tiebreak)', await converged(A.db, B.db, 'cust-1'));
}

// ── 2. duplicate delivery: the same batch applied twice is one effect
{
  const r = { id: 'prod-1', version: 3, device_id: 'dev-A', payload: 'v3' };
  await upsert(A.db, r);
  await upsert(A.db, r);
  const rows = await A.db.execute("SELECT COUNT(*) c FROM t WHERE id='prod-1'");
  check('duplicate delivery yields one row', Number(rows.rows[0].c) === 1);
}

// ── 3. reorder: v3 arrives first, then a late v2 must not overwrite it
{
  await upsert(B.db, { id: 'prod-1', version: 3, device_id: 'dev-A', payload: 'v3' });
  await upsert(B.db, { id: 'prod-1', version: 2, device_id: 'dev-B', payload: 'stale-v2' });
  const b = await row(B.db, 'prod-1');
  check('reordered stale version is rejected (v3 kept)', Number(b.version) === 3 && b.payload === 'v3');
}

// ── 4. clock skew: wall clocks disagree, the version decides
{
  await upsert(A.db, { id: 'prod-2', version: 5, device_id: 'dev-A', payload: 'v5', updated_at: '2030-01-01T00:00:00Z' });
  await upsert(B.db, { id: 'prod-2', version: 5, device_id: 'dev-A', payload: 'v5', updated_at: '2030-01-01T00:00:00Z' });
  await upsert(B.db, { id: 'prod-2', version: 4, device_id: 'dev-B', payload: 'v4', updated_at: '2031-01-01T00:00:00Z' });
  const b = await row(B.db, 'prod-2');
  check('future wall clock on v4 does not beat v5', Number(b.version) === 5 && b.payload === 'v5');
}

// ── 5. concurrent same-entity edit: deterministic winner regardless of order
{
  const a = { id: 'cust-2', version: 7, device_id: 'dev-A', payload: 'A-edit' };
  const b = { id: 'cust-2', version: 7, device_id: 'dev-B', payload: 'B-edit' };
  const C = fresh('C');
  const D = fresh('D');
  await init(C.db);
  await init(D.db);
  await upsert(C.db, a);
  await upsert(C.db, b);
  await upsert(D.db, b);
  await upsert(D.db, a);
  const c = await row(C.db, 'cust-2');
  const d = await row(D.db, 'cust-2');
  check(
    'concurrent same-version edits converge order-independently',
    c.device_id === d.device_id && c.payload === d.payload,
    `${c.device_id}/${c.payload} vs ${d.device_id}/${d.payload}`,
  );
  await C.cleanup();
  await D.cleanup();
}

// ── 6. tombstone vs edit: the delete wins, no resurrection
{
  await upsert(A.db, { id: 'cust-3', version: 3, device_id: 'dev-A', payload: '{}', deleted: 1 });
  await upsert(A.db, { id: 'cust-3', version: 2, device_id: 'dev-B', payload: 'late-edit' });
  const a = await row(A.db, 'cust-3');
  check('tombstone survives a later-delivered stale edit', Number(a.deleted) === 1 && Number(a.version) === 3);
}

// ── 7. crash mid-batch + replay: half applied, resume is idempotent
{
  const batch = [
    { id: 'item-1', version: 2, device_id: 'dev-A', payload: '1' },
    { id: 'item-2', version: 2, device_id: 'dev-A', payload: '2' },
    { id: 'item-3', version: 2, device_id: 'dev-A', payload: '3' },
  ];
  await upsert(B.db, batch[0]);
  // crash: batch[1..2] never applied
  const afterCrash = await B.db.execute("SELECT COUNT(*) c FROM t WHERE id LIKE 'item-%'");
  // resume from the saved cursor (last applied), then replay the whole batch
  for (const r of batch) await upsert(B.db, r);
  for (const r of batch) await upsert(B.db, r);
  const afterResume = await B.db.execute("SELECT COUNT(*) c FROM t WHERE id LIKE 'item-%'");
  check(
    'crash mid-batch resumes without duplicates',
    Number(afterCrash.rows[0].c) === 1 && Number(afterResume.rows[0].c) === 3,
  );
}

// ── 8. money-row idempotency: the same refund key applied twice is one effect
{
  const refund = { id: 'REF-1', version: 1, device_id: 'dev-A', payload: 'refund-500' };
  await upsert(A.db, refund);
  await upsert(A.db, refund);
  const r = await A.db.execute("SELECT COUNT(*) c FROM t WHERE id='REF-1'");
  check('refund replay by id yields one row', Number(r.rows[0].c) === 1 && (await row(A.db, 'REF-1')).payload === 'refund-500');
}

await A.cleanup();
await B.cleanup();

const outDir = join(ROOT, 'tests', 'results');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'syn-faults.json'),
  JSON.stringify({ at: ISO(), pass, fail, scenarios: 8, kind: 'PASS-SIM' }, null, 2),
);
console.log(`\nSYN FAULT SUITE (PASS-SIM): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
