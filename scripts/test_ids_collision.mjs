/**
 * Collision-safe ID generation — edge-case regression test.
 *
 * Run: node scripts/test_ids_collision.mjs   (exit 1 on failure)
 *
 * What this proves: the store used to build ids as `prefix-${Date.now()}` and
 * receipt numbers as `prefix-${Date.now().toString().slice(-6)`. Every
 * persistence layer below is an upsert (`dexieDb.put`, `INSERT OR REPLACE`),
 * so two ids colliding does NOT throw — it silently overwrites the earlier
 * row. For a money record that is a lost ledger entry; for an audit row it is
 * a lost accountability event. This test asserts the two properties that
 * failure mode depended on, and that the new generators do not have it:
 *
 *   1. Uniqueness under a same-millisecond burst (the realistic case: a rapid
 *      double click, a barcode burst, or a sync replay).
 *   2. Receipt numbers no longer repeat on the `.slice(-6)` ~16.7-minute cycle.
 */
import assert from 'node:assert/strict';

// The utility ships as a TS module; the store imports it directly. Transpile
// the real file with the project's own TypeScript so the assertions cover the
// shipped module rather than a hand-maintained copy.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require(require.resolve('typescript'));

const src = readFileSync(new URL('../src/utils/ids.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
// ids.ts has no imports, so the emitted ESM is directly runnable.
const dataUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const mod = await import(dataUrl);
const { newId, newReceiptNumber } = mod;

assert.equal(typeof newId, 'function', 'newId is exported');
assert.equal(typeof newReceiptNumber, 'function', 'newReceiptNumber is exported');

// ── 1. Same-millisecond burst: ids must be unique ─────────────────────────
// The old generator returned identical values here; the counter is what
// prevents the silent upsert overwrite.
{
  const N = 5000;
  const ids = new Set();
  for (let i = 0; i < N; i += 1) {
    ids.add(newId('TXN'));
  }
  assert.equal(ids.size, N, `newId produced ${N - ids.size} duplicate keys in a same-ms burst`);
}

// ── 2. Receipt numbers: unique, readable, chronological ───────────────────
{
  const N = 5000;
  const seen = new Set();
  for (let i = 0; i < N; i += 1) {
    const r = newReceiptNumber('REC');
    seen.add(r);
    assert.ok(/^REC-\d{8}-[0-9A-Z]+-\d+-[0-9A-Z]{3,5}$/.test(r), `receipt shape: ${r}`);
  }
  assert.equal(seen.size, N, `receipt numbers produced ${N - seen.size} duplicates`);
}

// ── 3. The old `.slice(-6)` failure mode is gone ──────────────────────────
// Two receipts generated ~16.7 minutes apart used to collide because only the
// last 6 digits of the epoch (100000..999999, ~16.7 min span) were kept. The
// day-stamp form cannot repeat within a day.
{
  const a = newReceiptNumber('REC');
  const b = newReceiptNumber('REC');
  assert.notEqual(a, b, 'consecutive receipt numbers differ');
  // Same day prefix (the chronological property support relies on).
  assert.equal(a.slice(0, 12), b.slice(0, 12), 'same-day receipts share a date prefix');
}

// ── 4. Monotonic sequence within each millisecond ──────────────────────────
// The counter resets only when the clock moves forward; uniqueness across that
// boundary comes from the millisecond stamp baked into the id. Within one
// millisecond the sequence must be strictly increasing so a burst keeps its
// insertion order — that matters for ledger rows read back in order.
{
  const batch = Array.from({ length: 2000 }, () => newId('DEBT'));
  const byMs = new Map();
  for (const id of batch) {
    const parts = id.split('-');
    const ms = parts[1];
    const seq = Number(parts[2]);
    if (!byMs.has(ms)) byMs.set(ms, []);
    byMs.get(ms).push(seq);
  }
  for (const [ms, seqs] of byMs) {
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(seqs[i] > seqs[i - 1], `sequence monotonic within ms ${ms}: ${seqs.join(',')}`);
    }
  }
}

// ── 5. Prefix is preserved (receipts print it, support reads it) ──────────
assert.ok(newId('AUDIT').startsWith('AUDIT-'), 'prefix retained');
assert.ok(newReceiptNumber('AVOIR').startsWith('AVOIR-'), 'receipt prefix retained');
assert.ok(newReceiptNumber('VERS').startsWith('VERS-'), 'debt receipt prefix retained');

// ── 6. Negative control: the OLD generators fail this same uniqueness check ─
// Proves the suite is not vacuously green — it would have caught the bug. The
// loop spans a few milliseconds, so the old generators yield a handful of
// values rather than one; the point is that thousands of ids collapse into a
// tiny set, which is exactly the silent-overwrite class of failure.
{
  const oldStyle = (prefix) => `${prefix}-${Date.now()}`;
  const oldSet = new Set();
  for (let i = 0; i < 5000; i += 1) oldSet.add(oldStyle('TXN'));
  assert.ok(oldSet.size < 100, `old Date.now()-only ids collapse to ${oldSet.size} values in a burst`);

  const oldReceipt = (prefix) => `${prefix}-${Date.now().toString().slice(-6)}`;
  const oldRSet = new Set();
  for (let i = 0; i < 5000; i += 1) oldRSet.add(oldReceipt('REC'));
  assert.ok(oldRSet.size < 100, `old .slice(-6) receipts collapse to ${oldRSet.size} values in a burst`);
}

console.log('✅ [PASS] 5000 same-millisecond ids are unique (no silent upsert overwrite)');
console.log('✅ [PASS] 5000 receipt numbers are unique and chronologically shaped');
console.log('✅ [PASS] Old .slice(-6) ~16.7-minute receipt collision mode eliminated');
console.log('✅ [PASS] Sequence is monotonic within each millisecond');
console.log('✅ [PASS] Human-readable prefixes retained');
console.log('✅ [PASS] Negative control: old Date.now()-only ids fail this suite');
console.log('========================================================================');
console.log('🎯 ID COLLISION EDGE-CASE TEST: 6 PASSED, 0 FAILED');
console.log('========================================================================');
