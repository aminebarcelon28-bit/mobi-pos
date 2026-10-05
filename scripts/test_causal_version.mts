/**
 * Causal version ordering (A3: SYNC-005 / DB-013) — characterization tests
 * for src/sync/causalVersion.ts.
 *
 * Proves: version primacy, deterministic device tiebreak (both directions),
 * fingerprint third level, identical-only zero, legacy/missing resilience,
 * key-order-independent fingerprints, antisymmetry over random pairs, and
 * resolveIncoming outcome mapping.
 */
import {
  compareStamps,
  fnv1a32Hex,
  hashStringList,
  nextVersionForWrite,
  normalizeDeviceId,
  normalizeVersion,
  payloadFingerprint,
  reportConflict,
  resolveIncoming,
  setConflictReporter,
  stableStringify,
  type VersionConflict,
} from '../src/sync/causalVersion.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`[PASS] ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`[FAIL] ${name}${extra ? ' :: ' + extra : ''}`); }
}

// 1. Version primacy beats any device/fingerprint.
{
  const lo = { version: 5, deviceId: 'zzz', fingerprint: 'FFFFFFFF' };
  const hi = { version: 6, deviceId: 'aaa', fingerprint: '00000000' };
  check('higher version wins regardless of device', compareStamps(hi, lo) > 0);
  check('lower version loses regardless of device', compareStamps(lo, hi) < 0);
  const r = resolveIncoming(hi, lo);
  check('incoming older → skip stale-version', r.decision === 'skip' && r.reason === 'stale-version');
  const r2 = resolveIncoming(lo, hi);
  check('incoming newer → apply newer-version', r2.decision === 'apply' && r2.reason === 'newer-version');
}

// 2. Equal versions: greater device wins, both directions, antisymmetric.
{
  const a = { version: 6, deviceId: 'till-01', fingerprint: 'AAAA1111' };
  const b = { version: 6, deviceId: 'till-02', fingerprint: 'AAAA1111' };
  check('greater device wins ties', compareStamps(b, a) > 0);
  check('smaller device loses ties', compareStamps(a, b) < 0);
  check('antisymmetric', compareStamps(a, b) === -compareStamps(b, a));
  const r = resolveIncoming(a, b);
  check('incoming tiebreak winner applies', r.decision === 'apply' && r.reason === 'tiebreak-won');
  const r2 = resolveIncoming(b, a);
  check('incoming tiebreak loser skips', r2.decision === 'skip' && r2.reason === 'tiebreak-lost');
}

// 3. Third level: fingerprint decides same-device ties; full identity → 0.
{
  const a = { version: 6, deviceId: 'till-01', fingerprint: 'AAAA0001' };
  const b = { version: 6, deviceId: 'till-01', fingerprint: 'AAAA0002' };
  check('fingerprint breaks same-device ties', compareStamps(a, b) < 0 && compareStamps(b, a) > 0);
  const same = { version: 6, deviceId: 'till-01', fingerprint: 'AAAA0001' };
  check('fully identical stamps compare 0', compareStamps(a, same) === 0);
  const r = resolveIncoming(a, same);
  check('identical → apply identical (idempotent)', r.decision === 'apply' && r.reason === 'identical');
}

// 4. Legacy/missing resilience: no NaN, deterministic sinks.
{
  check('null version normalizes to 0', normalizeVersion(null) === 0);
  check('NaN version normalizes to 0', normalizeVersion(Number.NaN) === 0);
  check('garbage version normalizes to 0', normalizeVersion('abc') === 0);
  check('fractional versions floor', normalizeVersion(6.9) === 6);
  check('missing device ranks lowest', normalizeDeviceId(undefined) === '' && normalizeDeviceId(null) === '');
  const legacy = { version: undefined, deviceId: undefined, fingerprint: undefined };
  const valid = { version: 1, deviceId: '', fingerprint: '' };
  check('dateless legacy loses to v1', compareStamps(legacy, valid) < 0);
  check('missing stamps never NaN', Number.isFinite(compareStamps(undefined, undefined)));
  check('null vs null is 0', compareStamps(null, null) === 0);
}

// 5. stableStringify: key order irrelevant, nesting respected, unsafe→null.
{
  check('key order independent', stableStringify({ b: 2, a: 1 }) === stableStringify({ a: 1, b: 2 }));
  check('nested order independent',
    stableStringify({ x: { d: 4, c: 3 }, y: [3, 2] }) === stableStringify({ y: [3, 2], x: { c: 3, d: 4 } }));
  check('array order significant', stableStringify([1, 2]) !== stableStringify([2, 1]));
  check('NaN/Infinity → null', stableStringify({ v: Number.NaN }) === stableStringify({ v: null }));
  check('undefined root → null', stableStringify(undefined) === 'null');
}

// 6. Fingerprints: stable, sensitive, well-formed.
{
  const p1 = { total: 1500, device_id: 'till-01', items: [{ id: 'a', qty: 2 }] };
  const p2 = { items: [{ qty: 2, id: 'a' }], device_id: 'till-01', total: 1500 };
  check('same content (reordered) → same fingerprint', payloadFingerprint(p1) === payloadFingerprint(p2));
  check('8-char uppercase hex', /^[0-9A-F]{8}$/.test(payloadFingerprint(p1)));
  check('one field differs → different fingerprint',
    payloadFingerprint({ ...p1, total: 1501 }) !== payloadFingerprint(p1));
  check('FNV-1a known vector', fnv1a32Hex('') === '811C9DC5');
}

// 7. Antisymmetry + determinism over pseudo-random pairs (seeded, no Math.random).
{
  let seed = 0x12345678;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const devices = ['till-01', 'till-02', '', 'legacy', 'default'];
  let ok = true;
  for (let i = 0; i < 500; i++) {
    const mk = () => ({
      version: rnd() % 8,
      deviceId: devices[rnd() % devices.length],
      fingerprint: (rnd() % 0xffffffff).toString(16).toUpperCase().padStart(8, '0'),
    });
    const x = mk(); const y = mk();
    const ab = compareStamps(x, y); const ba = compareStamps(y, x);
    if (ab !== -ba) { ok = false; break; }
    if (ab === 0) {
      if (!(x.version === y.version && x.deviceId === y.deviceId && x.fingerprint === y.fingerprint)) { ok = false; break; }
    }
    // Transitivity spot-check via a third stamp.
    const z = mk();
    const xz = compareStamps(x, z); const yz = compareStamps(y, z);
    if (ab > 0 && yz > 0 && !(xz > 0)) { ok = false; break; }
    if (ab < 0 && yz < 0 && !(xz < 0)) { ok = false; break; }
  }
  check('500 seeded pairs: antisymmetric, zero-only-if-identical, transitive', ok);
}

// 8. Conflict reporting: hook receives the record; throwing reporter never throws.
{
  const seen: VersionConflict[] = [];
  setConflictReporter((c) => { seen.push(c); });
  reportConflict({
    table: 'transactions', id: 'TX-1',
    local: { version: 6, deviceId: 'till-01', fingerprint: 'AA' },
    incoming: { version: 6, deviceId: 'till-02', fingerprint: 'BB' },
    winner: 'incoming', at: '2026-01-01T00:00:00.000Z',
  });
  check('reporter hook receives conflict', seen.length === 1 && seen[0].id === 'TX-1' && seen[0].winner === 'incoming');
  setConflictReporter(() => { throw new Error('sink down'); });
  let threw = false;
  try {
    reportConflict({
      table: 't', id: 'i',
      local: { version: 1, deviceId: '', fingerprint: '' },
      incoming: { version: 1, deviceId: '', fingerprint: '' },
      winner: 'local', at: '',
    });
  } catch { threw = true; }
  check('throwing reporter never propagates', threw === false);
  setConflictReporter(() => {});
}

// 9. Optimistic bump helper.
{
  check('bump increments', nextVersionForWrite(6) === 7);
  check('bump coerces garbage to 1', nextVersionForWrite(undefined) === 1 && nextVersionForWrite('x') === 1);
}

// 10. Order-independent list hash (DB-005 scope keys).
{
  check('order independent', hashStringList(['b', 'a', 'c']) === hashStringList(['c', 'b', 'a']));
  check('content sensitive', hashStringList(['a', 'b']) !== hashStringList(['a', 'c']));
  check('separator-injected (no join collision)',
    hashStringList(['ab', 'c']) !== hashStringList(['a', 'bc']));
  check('empty/null/undefined → stable empty hash',
    hashStringList([]) === hashStringList(null) && hashStringList(null) === hashStringList(undefined));
  check('duplicates matter', hashStringList(['a', 'a']) !== hashStringList(['a']));
  check('8-char hex', /^[0-9A-F]{8}$/.test(hashStringList(['x'])));
}

console.log(`\ncausal-version: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
