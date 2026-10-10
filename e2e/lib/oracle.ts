/**
 * Independent money oracle — HT-only, NO tax (R-01), integer minor units.
 *
 * Written from the BUSINESS RULE (R-02, R-10, R-11), never by importing or
 * copying the app's calculation functions (`receiptMath`, `cashTerms`,
 * `Money`). Reusing app math would prove only the app agrees with itself.
 *
 * Units: BigInt minor units (1 DA = 100). Quantities are plain integers
 * (R-16). Live checkout is integer DA; the oracle works in minor units and
 * specs convert stored REAL dinars with `toMinorFromDa` (integer-valued
 * floats only — fractional stored values throw).
 *
 * BigInt does not cross the WebDriver JSON boundary: amounts travel as
 * strings; conversions assert `Number.isSafeInteger`.
 */

export type Minor = bigint;

/** Half-up division matching BOTH engines' `mul_div_half_up` exactly
 * (`money.rs:186-199`, `money.ts:215-228`): truncating quotient, round up
 * iff `2*rem >= d` in trunc-remainder arithmetic (so negative ties round
 * toward zero, like the engines — the suite only feeds non-negatives). */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divisor must be > 0');
  const q = n / d;
  const r = n % d;
  return r * 2n >= d ? q + 1n : q;
}

export interface OracleLine {
  /** Unit price, minor units. */
  unit: Minor;
  /** Integer quantity (R-16). */
  qty: number;
  /** Per-line fixed discount, minor units. */
  discountFixed?: Minor;
}

/** Parse a decimal DA string ("1234.56") to minor units. No float. */
export function toMinor(s: string): Minor {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`bad money string: ${s}`);
  const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -v : v;
}

/** Stored REAL dinars (integer-valued floats) → minor units. Throws on fractions. */
export function toMinorFromDa(v: number): Minor {
  if (!Number.isFinite(v)) throw new Error(`non-finite stored amount: ${v}`);
  const rounded = Math.round(v * 100);
  if (Math.abs(v * 100 - rounded) > 1e-6) {
    throw new Error(`fractional stored amount (not integer DA): ${v}`);
  }
  return BigInt(rounded);
}

/** Canonical display, byte-matching both engines (`money.rs:format`,
 * `money.ts:format`): ASCII-space grouping, always two decimals, `DA`. */
export function fmt(v: Minor): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const digits = (a / 100n).toString();
  const head = digits.length % 3 || 3;
  const parts = [digits.slice(0, head)];
  for (let i = head; i < digits.length; i += 3) parts.push(digits.slice(i, i + 3));
  return `${neg ? '-' : ''}${parts.join(' ')}.${(a % 100n).toString().padStart(2, '0')} DA`;
}

export interface InvoiceResult {
  /** Net per line after per-line discounts. */
  nets: Minor[];
  /** Σ nets (HT-only product: no tax block). */
  ht: Minor;
  /** Always 0n — no-tax product (R-01). */
  tax: Minor;
  /** ht − credits. */
  total: Minor;
}

/**
 * HT-only invoice: gross = Σ unit×qty → line discounts → base →
 * cartPct (basis points, half-up, only if base > 0) → subtotal → net.
 * Credits (Avoir) are payment, not discount (R-10).
 */
export function computeInvoice(
  lines: OracleLine[],
  cartPctBp = 0n,
  credits: Minor = 0n,
): InvoiceResult {
  const nets = lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty < 0) throw new Error(`bad qty: ${l.qty}`);
    const gross = l.unit * BigInt(l.qty);
    const disc = l.discountFixed ?? 0n;
    if (disc < 0n) throw new Error('negative discount');
    if (disc > gross) throw new Error('discount exceeds line (app must reject this)');
    return gross - disc;
  });
  const base = nets.reduce((a, b) => a + b, 0n);
  const cartDisc = base > 0n && cartPctBp > 0n ? divRoundHalfUp(base * cartPctBp, 10000n) : 0n;
  const subtotal = base - cartDisc;
  if (subtotal < 0n) throw new Error('subtotal went negative');
  if (credits < 0n) throw new Error('negative credits');
  if (credits > subtotal) throw new Error('credits exceed subtotal');
  return { nets, ht: subtotal, tax: 0n, total: subtotal - credits };
}

/** Cash change: max(0, tendered − due) (R-11). */
export function changeDue(tendered: Minor, due: Minor): Minor {
  return tendered > due ? tendered - due : 0n;
}

/** Remaining refundable on a tender leg: paid − priorRefunded (R-13). */
export function refundableRemaining(paid: Minor, priorRefunded: Minor): Minor {
  const r = paid - priorRefunded;
  return r > 0n ? r : 0n;
}
