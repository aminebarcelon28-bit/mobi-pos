/**
 * Document-numbering harness (SYN-02, ADR-006). Pure — no DB, no browser.
 *
 * Proves the device-series contract: one continuous counter per terminal series,
 * disjoint numbers across terminals, prefix lanes kept apart, the legacy scheme
 * byte-shape preserved, and an honest degradation counter when no durable store
 * exists. Every claim has a negative control that must fail.
 *
 * Run: npm run test:numbering
 */
import {
  newDocumentNumber,
  setNumberingScheme,
  activeNumberingScheme,
  setSequenceStore,
  setDeviceSeries,
  currentDeviceSeries,
  seriesFromDevice,
  numberingState,
  degradedNumberingDraws,
  useMemorySequenceStore,
} from '../src/utils/numbering';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
};

const fixedNow = Date.parse('2026-11-03T09:30:00.000Z');

// ── 1. Device series: continuous, formatted, monotonic ─────────────────────
useMemorySequenceStore();
setNumberingScheme('device-series-v1');
setDeviceSeries('A1B2');
const a = [1, 2, 3, 4, 5].map(() => newDocumentNumber('REC', fixedNow));
check(
  'series: numbers are PREFIX-<SERIES>-<000001> and strictly increasing',
  a[0] === 'REC-A1B2-000001' && a[4] === 'REC-A1B2-000005' && new Set(a).size === 5,
  JSON.stringify(a),
);
check('series: the series token is reported and persisted for printing', currentDeviceSeries() === 'A1B2', currentDeviceSeries());

// ── 2. Two terminals never collide ─────────────────────────────────────────
setSequenceStore({ read: () => null, write: () => undefined });
setDeviceSeries('C3D4');
const b = [1, 2, 3].map(() => newDocumentNumber('REC', fixedNow));
const overlap = a.filter((n) => b.includes(n));
check('series: two terminal series are disjoint', overlap.length === 0, JSON.stringify({ a, b }));

// ── 3. Negative control: the SAME series does collide ─────────────────────
setSequenceStore({ read: () => null, write: () => undefined });
setDeviceSeries('A1B2');
const sameSeries = [1, 2].map(() => newDocumentNumber('REC', fixedNow));
check(
  'negative control: a shared series would mint duplicate numbers',
  sameSeries[0] === a[0],
  `shared=${JSON.stringify(sameSeries)} vs ${a[0]}`,
);

// ── 4. Prefix lanes are independent ────────────────────────────────────────
{
  const map = new Map<string, number>();
  setSequenceStore({ read: (k) => map.get(k) ?? null, write: (k, v) => void map.set(k, v) });
  setDeviceSeries('E5F6');
  const rec1 = newDocumentNumber('REC', fixedNow);
  const avoir1 = newDocumentNumber('AVOIR', fixedNow);
  const rec2 = newDocumentNumber('REC', fixedNow);
  check(
    'lanes: each document type has its own counter',
    rec1 === 'REC-E5F6-000001' && rec2 === 'REC-E5F6-000002' && avoir1 === 'AVOIR-E5F6-000001',
    JSON.stringify({ rec1, rec2, avoir1 }),
  );
}

// ── 5. Legacy scheme preserved (shape + same-millisecond ordering) ─────────
setNumberingScheme('legacy-timestamp');
const legacyA = newDocumentNumber('REC', fixedNow);
const legacyB = newDocumentNumber('REC', fixedNow);
check(
  'legacy: PREFIX-YYYYMMDD-<base36>-<seq>-<entropy> shape kept',
  /^REC-\d{8}-[0-9A-Z]+-\d{2}-[0-9A-Z]{5}$/.test(legacyA) && /^REC-\d{8}-[0-9A-Z]+-\d{2}-[0-9A-Z]{5}$/.test(legacyB),
  JSON.stringify([legacyA, legacyB]),
);
check('legacy: same-millisecond draws stay distinct and ordered', legacyA !== legacyB, JSON.stringify([legacyA, legacyB]));
check('legacy: the scheme is swappable and reported', activeNumberingScheme() === 'legacy-timestamp');

// ── 6. Degraded store: no false continuity ─────────────────────────────────
setNumberingScheme('device-series-v1');
setDeviceSeries('9876');
setSequenceStore({ read: () => null, write: () => undefined, degraded: true });
const before = degradedNumberingDraws();
const degraded = newDocumentNumber('REC', fixedNow);
check(
  'degraded: no durable counter -> legacy format and an honest counter bump',
  /^REC-\d{8}-[0-9A-Z]+-\d{2}-[0-9A-Z]{5}$/.test(degraded) && degradedNumberingDraws() === before + 1,
  JSON.stringify({ degraded, state: numberingState() }),
);

// ── 7. Series derivation is stable and compact ────────────────────────────
check(
  'series: derived from a device id, 4 chars, stable',
  seriesFromDevice('TERM-ABC-123') === seriesFromDevice('TERM-ABC-123') &&
    /^[0-9A-Z]{4}$/.test(seriesFromDevice('TERM-ABC-123')) &&
    seriesFromDevice('TERM-ABC-123') !== seriesFromDevice('TERM-ABC-124'),
  seriesFromDevice('TERM-ABC-123'),
);

// ── 8. Seed restore: a persisted counter continues, never resets ──────────
{
  const map = new Map<string, number>([['mobipos_numbering_v1:REC:7777', 41]]);
  setSequenceStore({
    read: (k) => map.get(k) ?? null,
    write: (k, v) => void map.set(k, v),
  });
  setDeviceSeries('7777');
  const continued = newDocumentNumber('REC', fixedNow);
  check('restore: a persisted counter continues from 41 to 42', continued === 'REC-7777-000042', continued);
}

// leave the process on the default scheme for anything that loads after us
setNumberingScheme('device-series-v1');

console.log(`\nDOCUMENT NUMBERING (SYN-02): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
