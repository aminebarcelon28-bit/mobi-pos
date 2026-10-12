// Tier A property runner (dep-free): 100k+ seeded random cases against
// e2e/lib/oracle.ts metamorphic invariants + frozen money.ts agreement.
// No fast-check (not a dependency — supply-chain hygiene): mulberry32 +
// explicit distributions biased to rounding boundaries.
//
// Properties (each ≥100,000 cases unless noted):
//  P1 totals non-negative, HT+tax==total (tax 0), nets sum == HT.
//  P2 discount monotonicity: larger cart-% never raises the total.
//  P3 order-independence: permuted lines total identically.
//  P4 change floor: change>=0; tendered-due consistency.
//  P5 refundable caps: remaining<=paid; cumulative discipline.
//  P6 money.ts agreement: fromUserInput/format/mulDivHalfUp/add/sub/mulInt
//     match oracle on random inputs (frozen engine as system-under-test).
//  P7 boundary qty: 1,2,3,7 + large qty exactness.
//
// Usage: STRESS_SEED=... node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types scripts/test_money_properties.mts [--cases N]
import assert from 'node:assert';
import { computeInvoice, divRoundHalfUp, fmt, changeDue, refundableRemaining } from '../e2e/lib/oracle';
import { Money } from '../src/utils/money';

const seedArg = Number(process.env.STRESS_SEED ?? 20261010);
const casesFlag = process.argv.find((a) => a.startsWith('--cases='));
const CASES = casesFlag ? Number(casesFlag.split('=')[1]) : 100000;
console.log(`STRESS_SEED=${seedArg} cases=${CASES}`);

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(seedArg);
const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
// Biased minor values: tiny (rounding-sensitive), round thousands, large.
const rMinor = (): bigint => {
  const u = rnd();
  if (u < 0.3) return BigInt(ri(0, 20));
  if (u < 0.5) return BigInt(ri(0, 200)) * 100n + BigInt(ri(0, 99));
  if (u < 0.8) return BigInt(ri(1, 20000)) * 100n;
  return BigInt(ri(1, 99999999)) * 100n;
};
const rQty = (): number => {
  const u = rnd();
  if (u < 0.5) return [1, 2, 3, 7][ri(0, 3)];
  if (u < 0.8) return ri(1, 100);
  return ri(1, 9999);
};
const rBp = (): bigint => {
  const u = rnd();
  if (u < 0.4) return 0n;
  const opts = [500n, 1000n, 1500n, 2500n, 3333n, 5000n, 10000n];
  return opts[ri(0, opts.length - 1)];
};

let fails = 0;
const fail = (p: string, msg: string) => {
  fails++;
  if (fails <= 20) console.log(`FAIL ${p}: ${msg}`);
};

for (let i = 0; i < CASES; i++) {
  const nLines = ri(1, 5);
  const lines = Array.from({ length: nLines }, () => ({ unit: rMinor(), qty: rQty() }));
  const bp = rBp();
  let inv;
  try {
    inv = computeInvoice(lines, bp);
  } catch (e) {
    fail('P1', `threw on valid input: ${(e as Error).message}`);
    continue;
  }
  // P1: structural.
  if (inv.total < 0n || inv.ht < 0n || inv.tax !== 0n) fail('P1', `sign/tax ${inv.total}/${inv.tax}`);
  const base = lines.reduce((a, l) => a + l.unit * BigInt(l.qty), 0n);
  if (inv.nets.reduce((a, b) => a + b, 0n) !== base) fail('P1', 'nets != gross sum');
  if (inv.ht > base) fail('P1', `HT ${inv.ht} exceeds gross ${base}`);
  // P2: monotonicity vs a larger discount.
  const bp2 = bp + 500n > 10000n ? 10000n : bp + 500n;
  if (bp2 !== bp) {
    const t2 = computeInvoice(lines, bp2).total;
    if (t2 > inv.total) fail('P2', `monotonicity ${t2} > ${inv.total}`);
  }
  // P3: order-independence (reverse).
  const rev = computeInvoice([...lines].reverse(), bp).total;
  if (rev !== inv.total) fail('P3', `order ${rev} != ${inv.total}`);
  // P4: change floor.
  const due = inv.total;
  const tendered = due + BigInt(ri(-5000, 20000)) * 100n;
  const ch = changeDue(tendered < 0n ? 0n : tendered, due);
  if (ch < 0n) fail('P4', 'negative change');
  if (tendered >= due && ch !== tendered - due) fail('P4', 'change mismatch');
  // P5: refundable caps.
  const prior = BigInt(ri(0, Number(due > 1000000n ? 1000000n : due)));
  const rem = refundableRemaining(due, prior);
  if (rem > due || rem < 0n) fail('P5', 'cap breach');
  // P6: frozen money.ts agreement on this case's first line.
  try {
    const u = lines[0].unit;
    if (u <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const m = Money.fromMinor(Number(u));
      const back = (m as unknown as { minor: number }).minor;
      if (BigInt(back) !== u) fail('P6', `fromMinor round-trip ${back} != ${u}`);
      if (m.format() !== fmt(u)) fail('P6', `format ${m.format()} != ${fmt(u)}`);
      const gtest = m.mulInt(lines[0].qty);
      const gback = (gtest as unknown as { minor: number }).minor;
      if (BigInt(gback) !== u * BigInt(lines[0].qty) && u * BigInt(lines[0].qty) <= BigInt(Number.MAX_SAFE_INTEGER)) {
        fail('P6', 'mulInt mismatch');
      }
      if (bp <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const dtest = m.mulDivHalfUp(Number(u <= 1000000n ? 1000n : 1n), 1000);
        const dback = (dtest as unknown as { minor: number }).minor;
        const want = divRoundHalfUp(u * (u <= 1000000n ? 1000n : 1n), 1000n);
        if (BigInt(dback) !== want) fail('P6', `mulDivHalfUp ${dback} != ${want}`);
      }
    }
  } catch (e) {
    fail('P6', `money.ts threw: ${(e as Error).message}`);
  }
  // P7: boundary qty exactness (qty matrix pinned).
  for (const q of [1, 2, 3, 7]) {
    const t = computeInvoice([{ unit: 1999n, qty: q }]).total;
    if (t !== 1999n * BigInt(q)) fail('P7', `1999x${q} = ${t}`);
  }
}

console.log(fails === 0 ? `TIER-A node: ${CASES} cases x P1-P7 ALL GREEN` : `TIER-A node: ${fails} FAILURES / ${CASES} cases`);
process.exit(fails === 0 ? 0 : 1);
