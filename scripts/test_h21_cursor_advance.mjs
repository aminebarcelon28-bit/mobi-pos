// H21 regression test: the pull cursor must not advance past a row that
// FAILED to apply, even when a LATER row in the same page lands.
//
// `SyncManager.pullOnce` pulls each table with a keyset query
// (`updated_at ASC, id ASC`) and advances the cursor inside the row loop:
//
//     try {
//       await this.applyRemoteRow(db, table, r);   // returns void
//       totalPulled++; tablePulled++;
//       if (updated > maxSeenTime || (updated === maxSeenTime && rowId > maxSeenId)) {
//         maxSeenTime = updated; maxSeenId = rowId;   // <-- MAX watermark
//       }
//     } catch (e) { console.warn(...); }             // <-- loop CONTINUES
//
// The comment claims "advance the cursor ONLY past rows that applied cleanly"
// (contract C6), but a MAX watermark over landed rows cannot express that: if
// row B throws (transient SQLITE_BUSY / FK violation / disk I/O) and row C
// lands, the cursor jumps to C and B is skipped FOREVER — the next pull starts
// after B. Silent data loss.
//
// This is not theoretical: `transaction_items.product_id REFERENCES products(id)`,
// rows are ordered by `updated_at` (not by dependency), so an item can arrive
// one page before its product. The FK write throws, the product lands later in
// the same page, the cursor jumps past the item, and the item is never retried.
//
// The fix is a CONTIGUOUS watermark: once any row fails, the cursor stops
// advancing for the rest of the page, so the next pull re-fetches the failed
// row and everything after it. Guard-rejected rows (0 rows affected, correct
// LWW) still advance the cursor — they are deterministic and will never apply.

import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const DB_FILE = 'file:tmp-h21-cursor.db';
const TEMP_FILES = ['tmp-h21-cursor.db', 'tmp-h21-cursor.db-wal', 'tmp-h21-cursor.db-shm', 'tmp-h21-cursor.db-journal'];
for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may still be locked */ }
}

const db = createClient({ url: DB_FILE });
const remote = createClient({ url: DB_FILE }); // same file, stands in for Turso

await db.execute(`CREATE TABLE IF NOT EXISTS kv_store (
  id TEXT PRIMARY KEY, data_json TEXT NOT NULL, device_id TEXT,
  idempotency_key TEXT, sync_status TEXT, version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
)`);
await db.execute(`CREATE TABLE IF NOT EXISTS entity_keys (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (entity_type, entity_id)
)`);
await db.execute(`CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
)`);

const T = 'kv_store';
const ENTITY = 'customer';

// The REAL guarded generic upsert used on pull (SyncManager.applyRemoteRow,
// customers lane) — resolves OK and returns normally even when it matches 0.
const UPSERT = `INSERT INTO ${T} (id, data_json, device_id, idempotency_key, sync_status, version, updated_at, deleted)
  VALUES ($1,$2,$3,$4,'synced',$5,$6,0)
  ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, version=excluded.version,
    updated_at=excluded.updated_at, sync_status='synced', deleted=0
    WHERE excluded.version >= ${T}.version`;

// The REAL keyset pull query (SyncManager.pullOnce, non-backfill branch).
const PULL = `SELECT id, data_json, version, updated_at, deleted FROM ${T}
  WHERE (updated_at > $1) OR (updated_at = $1 AND id > $2)
  ORDER BY updated_at ASC, id ASC LIMIT 500`;

async function appliedGenericVersion(id) {
  const rows = await db.execute(
    'SELECT version FROM entity_keys WHERE entity_type = $1 AND entity_id = $2',
    [ENTITY, id],
  );
  return Number(rows.rows?.[0]?.version ?? 0);
}
async function advanceEntityClockOnPull(id, version) {
  const safeVersion = Number(version) || 1;
  await db.execute(
    `INSERT INTO entity_keys (entity_type, entity_id, idempotency_key, version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(entity_type, entity_id) DO UPDATE
     SET version = MAX(excluded.version, entity_keys.version)`,
    [ENTITY, id, `pull-${ENTITY}-${id}`, safeVersion],
  );
}
async function setCursor(time, id) {
  await db.execute(
    "INSERT OR REPLACE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
    [`sync.cursor.${T}`, JSON.stringify({ time, id }), '2026-01-01T00:00:00.000Z'],
  );
}
async function getCursor() {
  const rows = await db.execute(
    "SELECT value_json FROM app_settings WHERE key = ?",
    [`sync.cursor.${T}`],
  );
  try {
    return JSON.parse(rows.rows?.[0]?.value_json ?? '{"time":"1970-01-01T00:00:00.000Z","id":""}');
  } catch {
    return { time: '1970-01-01T00:00:00.000Z', id: '' };
  }
}

// The REAL apply path for a generic upsert row, verbatim in effect.
// Returns true when the row LANDED, false when the guard rejected it.
// `failOn` is the test hook that simulates a transient write failure.
let failOn = null;
async function applyRemoteRow(r) {
  const version = Number(r.version ?? 1);
  const id = String(r.id ?? '');
  if (!id) return false;
  if (failOn !== null && failOn.has(id)) throw new Error('simulated transient write failure');
  const applied = await appliedGenericVersion(id);
  if (applied > 0 && applied > version) return false; // guard rejected (LWW)
  await db.execute(UPSERT, [id, String(r.data_json), 'remote', `k-${id}`, version, String(r.updated_at)]);
  await advanceEntityClockOnPull(id, version);
  return true;
}

// The FIXED chunked cursor-advance loop: CONTIGUOUS watermark. Once a row
// fails, the cursor stops advancing for the rest of the page.
const APPLY_CHUNK = 100;
async function pullOnceFixed() {
  const cursor = await getCursor();
  const rs = await remote.execute(PULL, [cursor.time, cursor.id]);
  const rows = rs.rows ?? [];
  let maxSeenTime = cursor.time;
  let maxSeenId = cursor.id;
  let committedTime = cursor.time;
  let committedId = cursor.id;
  let applied = 0;
  let failed = false;
  for (let c = 0; c < rows.length; c += APPLY_CHUNK) {
    for (const row of rows.slice(c, c + APPLY_CHUNK)) {
      const updated = String(row.updated_at ?? '1970-01-01T00:00:00.000Z');
      const rowId = String(row.id ?? '');
      try {
        const landed = await applyRemoteRow(row);
        // A guard-REJECTED row is deterministic: it will never apply, so it
        // must still advance the cursor or it is re-fetched forever. Only a
        // THROWN row freezes the watermark.
        if (landed) applied++;
        if (!failed && (updated > maxSeenTime || (updated === maxSeenTime && rowId > maxSeenId))) {
          maxSeenTime = updated;
          maxSeenId = rowId;
        }
      } catch (e) {
        failed = true; // FIXED: freeze the cursor at the last contiguous landing
      }
    }
    if (maxSeenTime !== committedTime || maxSeenId !== committedId) {
      await setCursor(maxSeenTime, maxSeenId);
      committedTime = maxSeenTime;
      committedId = maxSeenId;
    }
  }
  return { applied, total: rows.length, failed };
}

// The OLD (buggy) loop: MAX watermark over landed rows, no notion of a gap.
async function pullOnceOld() {
  const cursor = await getCursor();
  const rs = await remote.execute(PULL, [cursor.time, cursor.id]);
  const rows = rs.rows ?? [];
  let maxSeenTime = cursor.time;
  let maxSeenId = cursor.id;
  let committedTime = cursor.time;
  let committedId = cursor.id;
  let applied = 0;
  for (let c = 0; c < rows.length; c += APPLY_CHUNK) {
    for (const row of rows.slice(c, c + APPLY_CHUNK)) {
      const updated = String(row.updated_at ?? '1970-01-01T00:00:00.000Z');
      const rowId = String(row.id ?? '');
      try {
        const landed = await applyRemoteRow(row);
        if (landed) {
          applied++;
          if (updated > maxSeenTime || (updated === maxSeenTime && rowId > maxSeenId)) {
            maxSeenTime = updated;
            maxSeenId = rowId;
          }
        }
      } catch (e) {
        // OLD: swallow and keep going; the watermark can jump the gap
      }
    }
    if (maxSeenTime !== committedTime || maxSeenId !== committedId) {
      await setCursor(maxSeenTime, maxSeenId);
      committedTime = maxSeenTime;
      committedId = maxSeenId;
    }
  }
  return { applied, total: rows.length };
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

const upsert = (id, version, at, data = {}) =>
  remote.execute(UPSERT, [id, JSON.stringify({ id, ...data }), 'remote', `k-${id}`, version, at]);
const clock = (id) => appliedGenericVersion(id);

console.log('\n=== H21: pull cursor must not jump a failed row ===\n');

// --- Setup: three rows on the "remote" in keyset order. -------------------
await upsert('cust-A', 1, '2026-01-01T00:00:01.000Z', { name: 'A' });
await upsert('cust-B', 1, '2026-01-01T00:00:02.000Z', { name: 'B' });
await upsert('cust-C', 1, '2026-01-01T00:00:03.000Z', { name: 'C' });

// --- Case 1: B fails, C lands. OLD jumps the cursor to C; FIXED stops at A.
{
  failOn = new Set(['cust-B']);
  const resOld = await pullOnceOld();
  const curOld = await getCursor();
  check('OLD: A and C landed, B did not', resOld.applied === 2, JSON.stringify(resOld));
  check('OLD: cursor jumped to C, PAST the failed B', curOld.id === 'cust-C', JSON.stringify(curOld));
  check('OLD: B never landed', (await clock('cust-B')) === 0);

  // Replay the same failure with the FIXED loop.
  await remote.execute('DELETE FROM kv_store');
  await remote.execute('DELETE FROM entity_keys');
  await setCursor('1970-01-01T00:00:00.000Z', '');
  await upsert('cust-A', 1, '2026-01-01T00:00:01.000Z', { name: 'A' });
  await upsert('cust-B', 1, '2026-01-01T00:00:02.000Z', { name: 'B' });
  await upsert('cust-C', 1, '2026-01-01T00:00:03.000Z', { name: 'C' });
  const resFix = await pullOnceFixed();
  const curFix = await getCursor();
  check('FIXED: A and C still landed', resFix.applied === 2, JSON.stringify(resFix));
  check('FIXED: cursor stopped at A (before the failed B)', curFix.id === 'cust-A', JSON.stringify(curFix));
  check('FIXED: the failure was recorded', resFix.failed === true);
}

// --- Case 2: after the failure clears, the FIXED pull re-fetches B and C. --
{
  failOn = null;
  const res = await pullOnceFixed();
  const cur = await getCursor();
  check('FIXED: the missed row B is re-fetched and lands', (await clock('cust-B')) === 1);
  check('FIXED: C is re-applied idempotently', (await clock('cust-C')) === 1);
  check('FIXED: cursor now reaches C', cur.id === 'cust-C', JSON.stringify(cur));
  check('FIXED: no rows are lost across the failure', res.applied === 2, JSON.stringify(res));
}

// --- Case 3: a guard-REJECTED row is deterministic — the cursor may pass. --
{
  // local clock 5; a stale v2 echo with a future updated_at.
  await db.execute('INSERT OR REPLACE INTO entity_keys (entity_type, entity_id, idempotency_key, version) VALUES ($1,$2,$3,$4)', [ENTITY, 'cust-A', 'k-a', 5]);
  await remote.execute('DELETE FROM kv_store WHERE id = $1', ['cust-A']);
  await upsert('cust-A', 2, '2026-01-02T00:00:01.000Z', { name: 'A-stale' });
  const res = await pullOnceFixed();
  const cur = await getCursor();
  check('stale echo resolved OK (no throw, no infinite loop)', res.failed === false, JSON.stringify(res));
  check('stale echo did not land (clock still 5)', (await clock('cust-A')) === 5);
  check('cursor advanced past the rejected echo', cur.time === '2026-01-02T00:00:01.000Z', JSON.stringify(cur));
  // A genuinely newer update on a LATER timestamp still arrives.
  await upsert('cust-A', 6, '2026-01-03T00:00:01.000Z', { name: 'A-fresh' });
  const res2 = await pullOnceFixed();
  check('a fresh update on a later timestamp lands', res2.applied === 1 && (await clock('cust-A')) === 6, JSON.stringify(res2));
}

// --- Case 4: the chunk boundary commits the cursor per chunk (C6). --------
{
  await remote.execute('DELETE FROM kv_store');
  await remote.execute('DELETE FROM entity_keys');
  await setCursor('1970-01-01T00:00:00.000Z', '');
  // 250 rows = 3 chunks (100 + 100 + 50). Row 150 fails.
  const ts = (i) => `2026-02-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
  for (let i = 0; i < 250; i++) await upsert(`cust-${String(i).padStart(3, '0')}`, 1, ts(i), { i });
  failOn = new Set(['cust-150']);
  const res = await pullOnceFixed();
  const cur = await getCursor();
  check('250 rows pulled over 3 chunks', res.total === 250, JSON.stringify(res));
  // The cursor freezes at the last contiguous row BEFORE the failure (149),
  // not at the chunk boundary (099): rows 100-149 landed and must not be
  // re-applied, but the cursor must not reach 150.
  check('cursor froze just before the failed row (row 149)', cur.id === 'cust-149', JSON.stringify(cur));
  check('rows 0-99 landed', (await clock('cust-099')) === 1);
  check('row 150 did not land', (await clock('cust-150')) === 0);
  check('row 249 landed but is behind the frozen cursor', (await clock('cust-249')) === 1);
  // Clearing the failure drains the rest.
  failOn = null;
  const res2 = await pullOnceFixed();
  // 150..249 = 100 rows; 100..149 are guard-rejected (already at v1) and do
  // not count as applied, but they do advance the cursor.
  check('after the failure clears, the rest drain', res2.applied === 100, JSON.stringify(res2));
  check('row 150 now lands', (await clock('cust-150')) === 1);
  const cur2 = await getCursor();
  check('cursor reaches the end (row 249)', cur2.id === 'cust-249', JSON.stringify(cur2));
}

try { await db.close(); } catch { /* fine */ }
for (const f of TEMP_FILES) {
  try { rmSync(f, { force: true }); } catch { /* may still be locked */ }
}

console.log(`\n=== SUMMARY: ${pass} PASSED, ${fail} FAILED ===`);
if (fail > 0) process.exit(1);
