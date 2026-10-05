/**
 * Durable hold-consume guard (STATE-009) — tests for
 * src/store/consumedHolds.ts with a stubbed globalThis.localStorage.
 * No DOM, no store, no Tauri.
 *
 * Proves: prune TTL + cap + malformed tolerance; load round-trips and
 * rewrites when stale; record persists same-tick; merge dedupes and
 * tolerates hostile input; corrupt storage never throws.
 */
import {
  CONSUMED_HOLDS_STORAGE_KEY,
  loadConsumedHoldIds,
  MAX_CONSUMED_HOLDS,
  mergeConsumedHoldIds,
  pruneConsumedEntries,
  recordConsumedHoldId,
} from '../src/store/consumedHolds.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

function stubStorage(initial?: Record<string, string>, opts?: { throwOnWrite?: boolean }) {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  const writes: string[] = [];
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (data.has(k) ? data.get(k) as string : null),
    setItem: (k: string, v: string) => {
      if (opts?.throwOnWrite) throw new Error('QuotaExceededError');
      writes.push(k);
      data.set(k, String(v));
    },
    removeItem: (k: string) => { data.delete(k); },
  };
  return { data, writes };
}

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

// 1. Prune: TTL, cap, malformed tolerance.
check('fresh entries kept', pruneConsumedEntries([{ id: 'a', at: NOW }], NOW, 48 * HOUR).length === 1);
check('expired entries dropped',
  pruneConsumedEntries([{ id: 'a', at: NOW - 49 * HOUR }], NOW, 48 * HOUR).length === 0);
check('malformed entries dropped',
  pruneConsumedEntries([{ id: '' }, { at: NOW }, null, 42, 'x', { id: 'b', at: NOW }], NOW, 48 * HOUR).length === 1);
check('non-array → empty', pruneConsumedEntries(undefined, NOW, 48 * HOUR).length === 0);
{
  const many = Array.from({ length: MAX_CONSUMED_HOLDS + 50 }, (_, i) => ({ id: `h${i}`, at: NOW - i }));
  const pruned = pruneConsumedEntries(many, NOW, 48 * HOUR);
  check('capped newest-first', pruned.length === MAX_CONSUMED_HOLDS && pruned[0].id === 'h0');
}

// 2. Load round-trips; rewrites when stale; corrupt never throws.
{
  stubStorage({ [CONSUMED_HOLDS_STORAGE_KEY]: JSON.stringify([{ id: 'a', at: NOW }]) });
  const set = loadConsumedHoldIds(NOW);
  check('load hydrates', set.has('a'));
}
{
  const { data } = stubStorage({
    [CONSUMED_HOLDS_STORAGE_KEY]: JSON.stringify([{ id: 'a', at: NOW - 100 * HOUR }, { id: 'b', at: NOW }]),
  });
  const set = loadConsumedHoldIds(NOW);
  check('load prunes stale', set.has('b') && !set.has('a'));
  check('prune rewrites storage',
    JSON.parse(String(data.get(CONSUMED_HOLDS_STORAGE_KEY))).length === 1);
}
{
  stubStorage({ [CONSUMED_HOLDS_STORAGE_KEY]: '###corrupt###' });
  let threw = false;
  try {
    check('corrupt storage loads empty', loadConsumedHoldIds(NOW).size === 0);
  } catch { threw = true; }
  check('corrupt storage never throws', threw === false);
}
{
  stubStorage({}, { throwOnWrite: true });
  let threw = false;
  try {
    recordConsumedHoldId('q', NOW);
    loadConsumedHoldIds(NOW);
  } catch { threw = true; }
  check('quota failure never throws', threw === false);
}

// 3. Record persists same-tick with TTL metadata.
{
  const { data } = stubStorage();
  recordConsumedHoldId('h1', NOW);
  recordConsumedHoldId('h1', NOW + 1); // duplicate: single entry
  const stored = JSON.parse(String(data.get(CONSUMED_HOLDS_STORAGE_KEY)));
  check('record persists with timestamp', stored.length === 1 && stored[0].id === 'h1' && stored[0].at === NOW);
  check('recorded id reloads', loadConsumedHoldIds(NOW + 1).has('h1'));
}

// 4. Merge dedupes and tolerates hostile input (storage-event path).
{
  const target = new Set<string>(['a']);
  const added = mergeConsumedHoldIds(target, [{ id: 'b' }, { id: 'a' }]);
  check('merge adds new, returns added', JSON.stringify(added) === '["b"]' && target.has('b'));
  mergeConsumedHoldIds(target, ['c', null, 42, { nope: 1 }, { id: '' }]);
  check('hostile shapes skipped, valid string merged', target.has('c') && target.size === 3);
  check('non-array input tolerated', mergeConsumedHoldIds(target, 42 as unknown as string[]).length === 0);
}

delete (globalThis as Record<string, unknown>).localStorage;

console.log(`\nconsumed-holds: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
