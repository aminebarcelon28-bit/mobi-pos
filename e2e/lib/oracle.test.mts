/**
 * Oracle self-test (L0): the yardstick itself must be proven.
 * (a) Hand-computed vectors with the arithmetic in comments.
 * (b) Every divRoundHalfUp tie × sign case.
 * (c) Full re-computation of e2e/golden/money-vectors.json through
 *     e2e/lib/oracle.ts (oracle agrees with the independent generator).
 *
 * Run: node --import ./scripts/ts-resolve-hook.mjs --experimental-strip-types e2e/lib/oracle.test.mts
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { divRoundHalfUp, toMinor, fmt, computeInvoice, changeDue, refundableRemaining, toMinorFromDa } from './oracle';

let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  n++;
  assert.strictEqual(String(a), String(b), msg);
};

// (a) Hand-computed: 1000 DA x1 with 10% -> disc = 100000*1000/10000 = 10000; total 90000.
eq(computeInvoice([{ unit: 100000n, qty: 1 }], 1000n).total, 90000n, 'hand 10% of 1000');
// 0.01 x 50%: base=1, disc=hUp(1*5000/10000)=hUp(0.5)=1 -> total 0.
eq(computeInvoice([{ unit: 1n, qty: 1 }], 5000n).total, 0n, 'hand tie 0.01x50%');
// 0.03 x 50%: base=3, disc=hUp(15000/10000)=hUp(1.5)=2 -> total 1.
eq(computeInvoice([{ unit: 3n, qty: 1 }], 5000n).total, 1n, 'hand tie 0.03x50%');
// 3500 x 25%: disc=350000*2500/10000=87500 exact -> 262500.
eq(computeInvoice([{ unit: 350000n, qty: 1 }], 2500n).total, 262500n, 'hand 25% of 3500');
// Empty basket -> 0; 100% -> 0; tax always 0 (no-tax product).
eq(computeInvoice([], 0n).total, 0n, 'hand empty');
eq(computeInvoice([{ unit: 100000n, qty: 1 }], 10000n).total, 0n, 'hand 100%');
eq(computeInvoice([{ unit: 100000n, qty: 1 }], 0n).tax, 0n, 'hand tax zero');
// toMinor/fmt round-trip: "130.50" -> 13050 -> "130.50 DA".
eq(toMinor('130.50'), 13050n, 'hand toMinor');
eq(fmt(13050n), '130.50 DA', 'hand fmt');
// changeDue / refundableRemaining.
eq(changeDue(10000n, 2500n), 7500n, 'hand change');
eq(changeDue(1000n, 3000n), 0n, 'hand change floor');
eq(refundableRemaining(2500n, 1000n), 1500n, 'hand refundable');
eq(toMinorFromDa(1000), 100000n, 'hand stored conversion');

// (b) divRoundHalfUp: trunc-toward-zero half-up, matching both engines.
eq(divRoundHalfUp(3n, 2n), 2n, 'tie up');
eq(divRoundHalfUp(1n, 2n), 1n, 'tie 0.5 up');
eq(divRoundHalfUp(5n, 10n), 1n, 'tie 0.5 up');
eq(divRoundHalfUp(4n, 10n), 0n, 'below tie down');
eq(divRoundHalfUp(15n, 10n), 2n, 'above tie up');
eq(divRoundHalfUp(0n, 7n), 0n, 'zero');
eq(divRoundHalfUp(-3n, 2n), -1n, 'negative tie toward zero (engine parity)');

// (c) Golden-file agreement: every invoice vector recomputed via the oracle.
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(here, '..', 'golden', 'money-vectors.json'), 'utf8'));
for (const v of golden.vectors.invoice) {
  n++;
  const lines = v.lines.map((l: { unitMinor: string; qty: number; discountFixedMinor?: string }) => ({
    unit: BigInt(l.unitMinor),
    qty: l.qty,
    ...(l.discountFixedMinor !== undefined ? { discountFixed: BigInt(l.discountFixedMinor) } : {}),
  }));
  if (v.expectedError) {
    assert.throws(() => computeInvoice(lines, BigInt(v.cartPctBp)), /discount exceeds line/, `${v.id} must reject`);
  } else {
    const got = computeInvoice(lines, BigInt(v.cartPctBp)).total;
    assert.strictEqual(got.toString(), v.expectedTotalMinor, `${v.id} oracle!=golden`);
  }
}
// Display vectors agree with fmt().
for (const v of golden.vectors.display) {
  n++;
  assert.strictEqual(fmt(BigInt(v.minorMinor)), v.display, `${v.id} fmt!=golden`);
}

console.log(`oracle.test: ${n} assertions passed (hand + ties + ${golden.vectors.invoice.length} golden invoices + ${golden.vectors.display.length} displays)`);
