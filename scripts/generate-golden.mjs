// Golden-vector generator — money correctness, HT-only, NO tax (R-01).
//
// Independent implementation: plain BigInt minor-unit arithmetic written
// against the BUSINESS RULE (R-02/R-10), never importing app code
// (`money.ts`, `receiptMath`, `cashTerms`) or `e2e/lib/oracle.ts`.
// Cross-checks: `e2e/lib/oracle.test.mts` (hand-computed vectors) and
// `scripts/verify_golden_sample.py` (Python Fraction re-computation).
// Rust ≡ TS ≡ Golden is asserted by `src-tauri/tests/golden_parity.rs`
// and `scripts/test_golden_parity.mts`.
//
// Units: ALL minor-unit integers are JSON STRINGS (BigInt-exact).
// Quantities are integers only (R-16); invoice values are non-negative
// (ENTRY rejects negatives — parity scope, see Q-01).
//
// Usage: node scripts/generate-golden.mjs  (writes e2e/golden/money-vectors.json)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outPath = path.join(root, 'e2e', 'golden', 'money-vectors.json');

const hUp = (n, d) => {
  const q = n / d;
  const r = n % d;
  return r * 2n >= d ? q + 1n : q;
};

const displayOf = (minor) => {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  const whole = a / 100n;
  const frac = (a % 100n).toString().padStart(2, '0');
  const digits = whole.toString();
  const head = digits.length % 3 || 3;
  const parts = [digits.slice(0, head)];
  for (let i = head; i < digits.length; i += 3) parts.push(digits.slice(i, i + 3));
  return `${neg ? '-' : ''}${parts.join(' ')}.${frac} DA`;
};

const display = [];
const addD = (id, minor, note) =>
  display.push({ id, minorMinor: minor.toString(), display: displayOf(minor), note });
// Boundaries + grouping + sign + zero (hand-verified against money.rs:format).
addD('D-001', 0n, 'zero');
addD('D-002', 1n, 'smallest minor 0.01 DA');
addD('D-003', 10n, '0.10 DA');
addD('D-004', 13050n, '130.50 DA (doc example)');
addD('D-005', 13005n, '130.05 DA zero-pad');
addD('D-006', 4500000n, '45 000.00 DA grouping');
addD('D-007', 1250050n, '12 500,50 input shape');
addD('D-008', -13550n, 'negative display');
addD('D-009', 99999999999n, '999 999 999.99 DA near-limit');
addD('D-010', 100n, '1.00 DA');
addD('D-011', 5n, '0.05 DA');

const parse = [];
const addP = (id, input, minor, note) =>
  parse.push({ id, input, minorMinor: minor.toString(), note });
// Valid in BOTH engines (Rust from_user_input + TS fromUserInput reject
// signs, >2 decimals and ambiguous separators on both sides).
addP('P-001', '130.50', 13050n, 'plain decimal');
addP('P-002', '130.5', 13050n, 'one decimal');
addP('P-003', '130', 13000n, 'integer');
addP('P-004', '0.01', 1n, 'smallest');
addP('P-005', '0', 0n, 'zero');
addP('P-006', '45 000.00', 4500000n, 'ASCII-space group');
addP('P-007', '12.500,50', 1250050n, 'strict FR grouped');
addP('P-008', '130,5', 13050n, 'comma decimal');
addP('P-009', '\u0661\u0663\u0665\u066b\u0665\u0660', 13550n, 'Arabic-Indic 135.50');
addP('P-010', '99999.99', 9999999n, 'edge price max');
addP('P-011', '0.05', 5n, 'edge nickel');
addP('P-012', '130.555', 13055500n, 'FR-grouped integer 130555 DA (both engines: ^\\d{1,3}(\\.\\d{3})+$)');
const parseError = [];
const addPE = (id, input, note) => parseError.push({ id, input, note });
addPE('PE-01', '-5', 'sign rejected both sides');
addPE('PE-02', '1.23.45', 'malformed groups rejected both sides');
addPE('PE-03', '', 'empty rejected');
addPE('PE-04', '12,500.50', 'US-grouped rejected (1000x guard)');

const invoice = [];
const addI = (id, lines, cartPctBp, expectedTotalMinor, note) =>
  invoice.push({
    id,
    lines: lines.map((l) => ({
      unitMinor: l[0].toString(),
      qty: l[1],
      ...(l[2] !== undefined ? { discountFixedMinor: l[2].toString() } : {}),
    })),
    cartPctBp,
    expectedTotalMinor: expectedTotalMinor.toString(),
    note,
  });
// Independent invoice math: gross=Σ unit*qty → line fixed discounts → base
// → cartDisc=hUp(base*bp,10000) iff base>0 → total=base-cartDisc.
const inv = (lines, bp) => {
  let base = 0n;
  for (const [u, q, f = 0n] of lines) {
    const gross = u * BigInt(q);
    if (f > gross) return { error: 'discount exceeds line' };
    base += gross - f;
  }
  const disc = base > 0n && bp > 0n ? hUp((base * BigInt(bp)) / 1n, 10000n) : 0n;
  return { total: base - disc };
};
const I = (id, lines, bp, note) => {
  const r = inv(lines, BigInt(bp));
  if ('error' in r) {
    invoice.push({ id, lines: lines.map((l) => ({ unitMinor: l[0].toString(), qty: l[1], ...(l[2] !== undefined ? { discountFixedMinor: l[2].toString() } : {}) })), cartPctBp: bp, expectedError: r.error, note });
  } else {
    addI(id, lines, bp, r.total, note);
  }
};
// Basics × qty matrix (integer qty 1/2/3/7).
I('I-001', [[10000n, 1]], 0, '100 DA x1');
I('I-002', [[1n, 1]], 0, '0.01 DA edge x1');
I('I-003', [[9999999n, 1]], 0, '99999.99 DA edge x1');
I('I-004', [[1999n, 3]], 0, '19.99 x3 no drift');
I('I-005', [[3333n, 3]], 0, '33.33 x3');
I('I-006', [[3333n, 7]], 0, '33.33 x7');
I('I-007', [[995n, 2]], 0, '9.95 x2');
I('I-008', [[123456n, 2]], 0, '1234.56 x2');
I('I-009', [[100n, 7]], 0, '1.00 x7');
// Percent tiers, single line (per-line == single-shot: exact).
I('I-010', [[100000n, 1]], 500, '5% of 1000');
I('I-011', [[100000n, 1]], 1000, '10% of 1000');
I('I-012', [[100000n, 1]], 3333, '33.33% of 1000');
I('I-013', [[100000n, 1]], 5000, '50% of 1000');
I('I-014', [[100000n, 1]], 10000, '100% zeroes the line');
// Half-up tie probes: base*bp/10000 lands exactly on .5 minor.
I('I-015', [[1n, 1]], 5000, 'tie: 0.01 x 50% -> 0.01 (0.5 rounds up)');
I('I-016', [[3n, 1]], 5000, 'tie: 0.03 x 50% -> 0.02 (1.5 rounds up)');
I('I-017', [[5n, 1]], 1000, 'tie: 0.05 x 10% -> 0.01 (0.5 rounds up)');
I('I-018', [[15n, 1]], 1000, '0.15 x 10% -> 0.02 (1.5 rounds up)');
// Fixed discounts.
I('I-019', [[100000n, 1, 1n]], 0, 'fixed 0.01 off 1000');
I('I-020', [[100000n, 1, 100000n]], 0, 'fixed == line zeroes it');
I('I-021', [[50000n, 2, 15000n]], 0, 'fixed off multi-qty line');
// Multi-line, no percent (order-independent by construction).
I('I-022', [[100000n, 1], [250000n, 2], [150000n, 3]], 0, 'mixed basket 10500');
I('I-023', [[250000n, 2], [150000n, 3], [100000n, 1]], 0, 'permuted basket (order-independence)');
I('I-024', [[100n, 3], [200n, 7]], 0, 'small lines');
// Zero / empty.
I('I-025', [], 0, 'empty basket zeroes');
I('I-026', [[100000n, 1]], 0, 'baseline re-pin');
// Invalid.
I('I-027', [[1000n, 1, 1001n]], 0, 'fixed exceeds line (must reject)');
// Scale (fits i64 and f64-safe integers).
I('I-028', [[9999999999n, 7]], 0, 'near-limit x7');

const doc = {
  version: 1,
  generated: new Date().toISOString(),
  generator: 'scripts/generate-golden.mjs (independent BigInt minor-unit math, no app imports)',
  currency: { code: 'DZD', label: 'DA', exponent: 2 },
  scope: 'HT-only, no tax; integer qty; non-negative invoice values',
  counts: {
    display: display.length,
    parse: parse.length,
    parseError: parseError.length,
    invoice: invoice.length,
  },
  vectors: { display, parse, parseError, invoice },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(
  `golden: display=${display.length} parse=${parse.length} parseError=${parseError.length} invoice=${invoice.length} -> ${outPath}`,
);
