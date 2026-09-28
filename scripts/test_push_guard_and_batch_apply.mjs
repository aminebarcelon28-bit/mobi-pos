// Regression: push guard-rejects + pull apply gaps (ad.md §§10/18, C6).
//   [1] SyncManager.GENERIC_PULL routes 'stock_batches' -> applyGenericRemoteRow
//       (before: pulled but never applied, cursor advanced past it = silent loss).
//   [2] transactions pull upsert propagates deleted (before: remote delete cleared
//       Dexie but left SQLite deleted=0, next push resurrected it).
//   [3] pushOnce inspects rowsAffected on guarded upserts (WHERE excluded.version):
//       0 rows = rejected stale edit -> stays pending with GUARD-STALE error,
//       never marked synced. DO NOTHING lanes (ledger/order_item replays)
//       legitimately affect 0 rows and must still mark synced.
//   [4] Functional: stock_batches pull SQL shape (GENERIC_PULL_COLUMNS) carries
//       the KV pair (id, data_json) that applyGenericRemoteRow reads.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const sm = readFileSync(join(ROOT, 'src', 'sync', 'SyncManager.ts'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

console.log('\n[1] stock_batches is routed to the shared generic apply path');
check('GENERIC_PULL has a stock_batches entry', /stock_batches:\s*\{\s*dexie:\s*'stockBatches'/.test(sm));

console.log('\n[2] remote transaction deletes land in local SQLite');
{
  // Anchor on the applyRemoteRow branch (const txId), not the row-loop
  // touch-marking `if` which shares the prefix.
  const idx = sm.indexOf('const txId = String(r.id');
  const seg = sm.slice(idx, idx + 4500);
  check('transactions DO UPDATE propagates deleted', /deleted=excluded\.deleted/.test(seg));
}

console.log('\n[3] guarded push rejects are never marked synced');
{
  const pushIdx = sm.indexOf('async pushOnce');
  const pushSeg = sm.slice(pushIdx, pushIdx + 22000);
  check('batch path reads rowsAffected', /rowsAffected/.test(pushSeg));
  check('guarded statements detected via WHERE excluded.version', /WHERE excluded\.version/.test(pushSeg));
  check('stale rejects stay pending with GUARD-STALE error', /GUARD-STALE/.test(pushSeg));
  check('a pull is triggered to converge after rejects', /void this\.pullOnce\(\)/.test(pushSeg));
  // DO NOTHING lanes must NOT be treated as rejects: only guarded statements checked.
  check('only guarded statements are reject-checked (DO NOTHING replays stay synced)',
    /stmt\.sql\.includes\('WHERE excluded\.version'\)/.test(pushSeg));
}

console.log('\n[4] stock_batches pull projection carries the KV pair');
check('pullColumns falls back to GENERIC_PULL_COLUMNS (id, data_json, version, updated_at, deleted)',
  /const GENERIC_PULL_COLUMNS = 'id, data_json, version, updated_at, deleted'/.test(sm));

console.log(failures === 0 ? '\nPUSH-GUARD: ALL PASS' : `\nPUSH-GUARD: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
