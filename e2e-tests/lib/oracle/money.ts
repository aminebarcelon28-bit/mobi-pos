/**
 * BigInt reference oracle for POS money math.
 * All values are integers: money in minor units (DA, exponent 2),
 * quantities in milli-units. Uses BigInt throughout — no floats.
 */

// 1) Largest-remainder allocation of an invoice discount D over line bases b[].
//    Stored per line at sale time; a refund never recomputes it from current rules.
//    net_i = b[i] - share[i]
export function allocateDiscount(D: bigint, b: bigint[]): bigint[] {
  const B = b.reduce((x, y) => x + y, 0n);
  if (D === 0n || B === 0n) return b.map(() => 0n);
  const share = b.map((bi) => (D * bi) / B);
  const frac = b.map((bi) => (D * bi) % B);
  let r = D - share.reduce((x, y) => x + y, 0n);
  const order = b
    .map((_, i) => i)
    .sort((i, j) => (frac[j] > frac[i] ? 1 : frac[j] < frac[i] ? -1 : i - j));
  for (let k = 0; r > 0n; k++, r--) share[order[k]] += 1n;
  return share;
}

// 2) Partial refund by quantity. cum(0)=0 and cum(Q)=N, so the last step takes
//    the remainder automatically, in any order or chunking. Round half up.
export const cum = (N: bigint, R: bigint, Q: bigint): bigint =>
  (2n * N * R + Q) / (2n * Q);
export const refundStep = (N: bigint, Q: bigint, R: bigint, dq: bigint): bigint =>
  cum(N, R + dq, Q) - cum(N, R, Q);

// 3) Split a refund A across the original tenders in the configured order.
//    Each leg is capped by what is still refundable on that tender.
export function splitTenders(
  A: bigint,
  remaining: { tender: string; rem: bigint }[]
): { tender: string; amount: bigint }[] {
  const legs: { tender: string; amount: bigint }[] = [];
  let left = A;
  for (const t of remaining) {
    const x = left < t.rem ? left : t.rem;
    if (x > 0n) legs.push({ tender: t.tender, amount: x });
    left -= x;
  }
  if (left !== 0n) throw new Error('REFUND_EXCEEDS_REFUNDABLE');
  return legs;
}

// Round half-up helper for arbitrary denominators.
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('DIV_ZERO');
  const absNum = numerator < 0n ? -numerator : numerator;
  const sign = numerator < 0n ? -1n : 1n;
  const q = absNum / denominator;
  const r = absNum % denominator;
  const rounded = 2n * r >= denominator ? q + 1n : q;
  return sign * rounded;
}

// Parse a decimal string into minor units (exponent 2).
export function parseMoney(s: string): bigint {
  let str = String(s).trim();
  if (str === '' || str === '-' || str === '.') return 0n;
  let neg = false;
  if (str.startsWith('-')) { neg = true; str = str.slice(1); }
  if (str.startsWith('+')) str = str.slice(1);
  // Remove thousands separators and normalise comma to point.
  str = str.replace(/'/g, '').replace(/ /g, '').replace(/,/g, '.');
  if (str === '' || str === '.') return 0n;
  const parts = str.split('.');
  let intPart = parts[0].replace(/^0+/, '') || '0';
  let fracPart = parts[1] || '';
  fracPart = (fracPart + '00').slice(0, 2);
  const val = BigInt(intPart) * 100n + BigInt(fracPart);
  return neg ? -val : val;
}

// Format minor units back to a decimal string.
export function formatMoney(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const intPart = abs / 100n;
  const fracPart = abs % 100n;
  const s = `${intPart}.${fracPart.toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}